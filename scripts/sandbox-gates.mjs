#!/usr/bin/env node
// HoldMySpot day-1 PayPal sandbox gates (docs/PAYPAL-MAPPING.md section 7), as a runnable script.
//
//   node scripts/sandbox-gates.mjs plan          List the gates and the owner's steps; refresh docs/SANDBOX-GATES.md. No network.
//   node scripts/sandbox-gates.mjs run           Run what can run now against the PayPal sandbox. Prints PayPal approval
//                                                links for the owner (sandbox buyer) and waits for them.
//   node scripts/sandbox-gates.mjs reauthorize   G10 part 2: reauthorize the dated holds, from day 4 (film it on 11-11/11-12).
//   node scripts/sandbox-gates.mjs disputes      G7 part 2: find the buyer's dispute, escalate it, settle it with adjudicate.
//   node scripts/sandbox-gates.mjs status        Re-read the payout, dated holds and disputes; refresh the page.
//   node scripts/sandbox-gates.mjs record G4 pass --note "..."   Record a gate checked by hand (Venmo, Pay Later).
//
// Add --fake to run against the in-process fake PayPal (no network, no credentials); its page goes to a
// temporary file unless --out is given, never to docs/.
//
// Credentials come only from ~/.config/paypal-hackathon/sandbox.env (scripts/setup-sandbox-secrets.mjs).
// The script never prints secrets and never signs in to PayPal: every approval is the owner's, on PayPal's
// own pages. The results page holds ids and statuses only.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(REPO, 'docs', 'SANDBOX-GATES.md');
const RECORD_DIR = path.join(REPO, 'server', 'test', 'paypal', 'fixtures', 'recorded');
const STATE_FILE = 'holdmyspot-sandbox-gates.json';
const DAY = 86_400_000;
const ORDER_LIFETIME_MS = 3 * 60 * 60 * 1000;

const GATES = [
  ['G0', 'OAuth token from sandbox.env', 'none'],
  ['G11', 'Token scopes include payouts, disputes and tracking', 'none (tick missing features on the app page)'],
  ['G1', 'Capture below the held amount with final_capture=true; nothing left to capture', 'approve order B'],
  ['G2', 'Partial capture (final_capture=false), then a final capture; a third is refused', 'approve order A'],
  ['G3', 'Void after a partial capture', 'approve order C'],
  ['G4', 'Venmo AUTHORIZE with testBuyerCountry US', 'manual: approve a Venmo hold in the web app, then `record G4`'],
  ['G5', 'Pay Later with intent AUTHORIZE (bonus)', 'manual: approve a Pay Later hold in the web app, then `record G5`'],
  ['G6', 'Payout by email to the Taiwan sandbox account', 'only if UNCLAIMED: accept it on sandbox.paypal.com as that account'],
  ['G7', 'Refund; then a buyer-opened dispute settled with adjudicate', 'open a dispute as the buyer, then run `disputes`'],
  ['G8', 'Tracking with carrier OTHER on a capture of an authorized order', 'approve order A'],
  ['G9', 'Order with payment_source approved; local PICKUP_FROM_PERSON accepted', 'approve order B (the JS SDK v6 session check is manual)'],
  ['G10', 'Dated holds reauthorized on day 4 or later', 'approve D1 and D2 now; run `reauthorize` on 11-11 or 11-12 (film it)'],
];
const GATE_IDS = GATES.map((g) => g[0]);

const USAGE = `HoldMySpot PayPal sandbox gates

  node scripts/sandbox-gates.mjs [plan|run|reauthorize|disputes|status|record] [options]

Options:
  --fake               Use the in-process fake PayPal (no network, no credentials).
  --out <file>         Results page (default docs/SANDBOX-GATES.md; with --fake a temporary file).
  --only G1,G2         run: only these gates.
  --wait <minutes>     run: how long to wait for approvals (default 15).
  --open               run: open the approval links in the browser (macOS).
  --yes                run: do not ask before creating sandbox orders.
  --no-record          run: do not save sanitized responses as test fixtures.
  --force-early        reauthorize: try before day 4 too (records PayPal's answer).
  --settle <id>        disputes: which dispute to settle.
  --outcome <seller|buyer>  disputes: adjudicate outcome (default seller).
  --note <text>        record: what was seen.
  --verbose            Print one line per PayPal call (with debug ids).
  --dir <dir>          Secrets folder (default $HMS_SECRETS_DIR or ~/.config/paypal-hackathon).
`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const taipei = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmt = (ms) => (ms ? `${taipei.format(new Date(ms)).replace(', ', ' ')} Taipei` : '-');
const stamp = (ms) => taipei.format(new Date(ms)).replace(/[-:]/g, '').replace(', ', '-');
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (id) => (id && id.length > 12 ? `${id.slice(0, 6)}...${id.slice(-4)}` : id || '-');
const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');

let pp; // server/src/paypal, loaded at start

function errText(e) {
  if (pp && e instanceof pp.PayPalError) {
    const what = [e.paypalName, e.issue].filter(Boolean).join('/') || 'no detail';
    return `${e.code}: ${what} (HTTP ${e.httpStatus ?? '-'}, debug id ${e.debugId ?? '-'})`;
  }
  return e && e.message ? e.message : String(e);
}

function secretsDirFrom(args) {
  const d = args.dir || process.env.HMS_SECRETS_DIR || path.join(os.homedir(), '.config', 'paypal-hackathon');
  return d.startsWith('~/') ? path.join(os.homedir(), d.slice(2)) : d;
}

function emptyState() {
  return { version: 1, app: null, gates: {}, orders: {}, datedHolds: [], payout: null, disputeTarget: null, runs: [] };
}

function loadState(file) {
  try {
    return { ...emptyState(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return emptyState();
  }
}

function saveState(file, state) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function setGate(state, id, status, summary, evidence = []) {
  state.gates[id] = { status, summary, evidence, at: Date.now() };
  const tag = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : status.toUpperCase();
  console.log(`  [${tag}] ${id}: ${summary}`);
}

// ---------------------------------------------------------------------------
// Results page
// ---------------------------------------------------------------------------

function ownerActions(state) {
  const out = [];
  const waiting = Object.entries(state.orders).filter(([, o]) => o.status === 'awaiting_approval');
  for (const [label, o] of waiting) out.push(`Approve order ${label} (${o.what}) as the sandbox buyer: ${o.approveUrl}, then run \`node scripts/sandbox-gates.mjs run\` again.`);
  const g7 = state.gates.G7;
  if (state.disputeTarget && g7?.status !== 'pass') {
    out.push(
      `G7: log in at https://www.sandbox.paypal.com as the sandbox buyer, open the ${state.disputeTarget.amount} HoldMySpot payment (invoice ${state.disputeTarget.invoiceId}) and report a problem (item not received). Wait a few minutes, then run \`node scripts/sandbox-gates.mjs disputes\`.`,
    );
  }
  if (state.payout && state.payout.status === 'UNCLAIMED') out.push(`G6: log in at https://www.sandbox.paypal.com as the Taiwan sandbox account and accept the ${usd(state.payout.amountCents)} payment, then run \`node scripts/sandbox-gates.mjs status\`.`);
  for (const h of state.datedHolds) {
    if (h.renewals.some((r) => r.ok)) continue;
    out.push(`G10: on or after ${fmt(h.createdAt + 3 * DAY)} (and before ${fmt(h.expiresAt ?? h.createdAt + 29 * DAY)}), screen-record \`node scripts/sandbox-gates.mjs reauthorize\` for dated hold ${h.label}.`);
  }
  for (const id of ['G4', 'G5']) {
    const g = state.gates[id];
    if (!g || g.status === 'manual' || g.status === 'not_run') out.push(`${id}: approve a ${id === 'G4' ? 'Venmo' : 'Pay Later'} hold in the web app's sandbox mode, then \`node scripts/sandbox-gates.mjs record ${id} pass --note "<authorization id>, funding ${id === 'G4' ? 'venmo' : 'paylater'}"\` (or fail).`);
  }
  return out;
}

function renderDoc(state, meta) {
  const lines = [];
  lines.push('# PayPal sandbox gates');
  lines.push('');
  lines.push(
    'Generated by `scripts/sandbox-gates.mjs`; do not edit by hand. Gate definitions: [PAYPAL-MAPPING.md](PAYPAL-MAPPING.md) section 7. Ids and statuses only, never credentials. Manual results are added with `node scripts/sandbox-gates.mjs record <gate> pass|fail --note "..."`.',
  );
  lines.push('');
  // The page lives in the repo: masked client ID only, no account emails.
  lines.push(`Last update: ${fmt(Date.now())}. Mode: ${meta.mode}.${state.app ? ` App: client ID ${state.app.clientId}.` : ''}`);
  lines.push('');
  lines.push('| Gate | What it proves | Status | Evidence | Owner step |');
  lines.push('|---|---|---|---|---|');
  for (const [id, what, owner] of GATES) {
    const g = state.gates[id];
    const status = g ? g.status : 'not run';
    const evidence = g ? [g.summary, ...(g.evidence ?? [])].filter(Boolean).join('; ') : '';
    lines.push(`| ${id} | ${cell(what)} | ${cell(status)} | ${cell(evidence)} | ${cell(owner)} |`);
  }
  lines.push('');
  lines.push('## Waiting on the owner');
  lines.push('');
  const actions = ownerActions(state);
  if (actions.length === 0) lines.push('Nothing right now.');
  for (const a of actions) lines.push(`- ${a}`);
  lines.push('');
  lines.push('## Dated holds (G10)');
  lines.push('');
  if (state.datedHolds.length === 0) lines.push('None yet. `run` creates two (D1 and D2) once the owner approves them.');
  else {
    lines.push('| Hold | Order | Authorization | Amount | Authorized | Reauthorize from | Valid until | Renewals |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const h of state.datedHolds) {
      const renewals = h.renewals.map((r) => (r.ok ? `${fmt(r.at)}: new authorization ${r.authorizationId} ${r.status}` : `${fmt(r.at)}: ${r.error}`)).join('; ') || '-';
      lines.push(`| ${h.label} | ${h.orderId} | ${h.authorizationId} | ${usd(h.amountCents)} | ${fmt(h.createdAt)} | ${fmt(h.createdAt + 3 * DAY)} | ${fmt(h.expiresAt)} | ${cell(renewals)} |`);
    }
  }
  lines.push('');
  lines.push('## Venmo and Pay Later (G4, G5)');
  lines.push('');
  lines.push('These need PayPal\'s JS SDK v6 in a browser, so they run from the web app, not from this script:');
  lines.push('');
  lines.push("- Load `https://www.sandbox.paypal.com/web-sdk/v6/core`, then `paypal.createInstance({ clientId, components: ['paypal-payments', 'venmo-payments'], pageType: 'checkout', testBuyerCountry: 'US' })`.");
  lines.push("- `findEligibleMethods({ currencyCode: 'USD' })`, then `isEligible('venmo')` and `isEligible('paylater')`. Show a button only when it is eligible.");
  lines.push('- Venmo is for US buyers paying in USD to a single US payee (the platform app); in the sandbox it needs `testBuyerCountry: \'US\'`. Venmo payouts need a US phone number and are production only.');
  lines.push('- Pay Later with intent AUTHORIZE is undocumented: keep it off (`HMS_PAYPAL_FUNDING=paypal,venmo`) unless G5 passes.');
  lines.push('- Whether a Venmo-funded hold can be reauthorized is unknown; until proven, the server marks such holds `renewalRequired` instead.');
  lines.push('');
  lines.push('## Runs');
  lines.push('');
  if (state.runs.length === 0) lines.push('Not run against the sandbox yet. Owner first runs `node scripts/setup-sandbox-secrets.mjs`, then `node scripts/sandbox-gates.mjs run`.');
  else {
    lines.push('| Run | When | Mode | Command | Note |');
    lines.push('|---|---|---|---|---|');
    for (const r of [...state.runs].reverse().slice(0, 20)) lines.push(`| ${r.runId} | ${fmt(r.at)} | ${r.mode} | ${r.command} | ${cell(r.note ?? '')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function writeDoc(file, state, meta) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderDoc(state, meta));
  console.log(`\nResults page: ${file}`);
}

// ---------------------------------------------------------------------------
// PayPal setup
// ---------------------------------------------------------------------------

async function loadPayPalModule() {
  try {
    pp = await import(pathToFileURL(path.join(REPO, 'server', 'src', 'paypal', 'index.ts')).href);
  } catch (err) {
    console.error('Could not load server/src/paypal. It needs Node 22.18 or newer and `npm install` in server/.');
    console.error(String(err && err.message ? err.message : err));
    process.exit(1);
  }
}

function sanitize(value, parentKey = '') {
  if (Array.isArray(value)) return value.map((v) => sanitize(v, parentKey));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(email_address|email|receiver)$/.test(k) && typeof v === 'string') out[k] = 'redacted@example.com';
      else if (/^(payer_id|account_id|merchant_id)$/.test(k) && typeof v === 'string') out[k] = 'REDACTEDID';
      else if (k === 'name' && v && typeof v === 'object') out[k] = { full_name: 'Test Buyer' };
      else if (k === 'name' && typeof v === 'string' && (parentKey === 'buyer' || parentKey === 'seller')) out[k] = 'Redacted';
      else if (k === 'address' && v && typeof v === 'object') out[k] = { country_code: v.country_code ?? 'US' };
      else if (/phone/.test(k)) out[k] = 'redacted';
      else out[k] = sanitize(v, k);
    }
    return out;
  }
  if (typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'redacted@example.com';
  return value;
}

function recorder(runId) {
  let n = 0;
  const dir = path.join(RECORD_DIR, runId);
  return (r) => {
    n += 1;
    fs.mkdirSync(dir, { recursive: true });
    const name = `${String(n).padStart(3, '0')}-${r.op.replace(/[^a-z0-9.]/gi, '_')}-${r.status}.json`;
    const body = { op: r.op, method: r.method, path: r.path, status: r.status, debugId: r.debugId, body: sanitize(r.body) };
    fs.writeFileSync(path.join(dir, name), `${JSON.stringify(body, null, 2)}\n`);
  };
}

/** Returns { port, settings, mode, stateFile, clock } for --fake or the sandbox. */
function connect(args, runId, record) {
  const log = args.verbose ? (line) => console.log(`    ${line}`) : () => {};
  if (args.fake) {
    let t = Date.now();
    const clock = { now: () => t, advance: (ms) => void (t += ms) };
    const port = pp.createFakePayPal({ now: clock.now, log });
    const settings = { clientId: pp.FAKE_CLIENT_ID, merchantEmail: 'merchant@holdmyspot.test', buyerEmail: 'buyer@holdmyspot.test', twPayoutEmail: 'queuer-payouts@holdmyspot.test' };
    return { port, settings, mode: 'fake', stateFile: null, clock };
  }
  const dir = secretsDirFrom(args);
  const loaded = pp.loadSandboxEnvFile({ dir });
  if (!loaded.ok) {
    console.error(`\nNo usable sandbox credentials: ${loaded.reason}.`);
    if (loaded.missing.length > 0) console.error(`Missing: ${loaded.missing.join(', ')}.`);
    console.error('The owner runs `node scripts/setup-sandbox-secrets.mjs` first (or use --fake to try the script offline).');
    process.exit(2);
  }
  for (const w of loaded.warnings) console.log(`  Warning: ${w}`);
  if (loaded.missingRecommended.length > 0) console.log(`  Not set (some gates will wait): ${loaded.missingRecommended.join(', ')}`);
  const port = pp.createSandboxPayPal({
    settings: loaded.settings,
    baseUrl: pp.SANDBOX_BASE_URL,
    timeoutMs: 30_000,
    log,
    onResponse: record ? recorder(runId) : undefined,
  });
  return { port, settings: loaded.settings, mode: 'sandbox', stateFile: path.join(dir, STATE_FILE), clock: { now: Date.now, advance: () => {} } };
}

// ---------------------------------------------------------------------------
// Orders for the gates
// ---------------------------------------------------------------------------

const ORDER_PLANS = {
  A: {
    gates: ['G2', 'G8', 'G7'],
    what: 'two-unit hold $115.00: 2 plush plus shipping',
    items: [
      ['Lucky Cat plush, launch-day drop (shop price, up to)', 2, 2_800, 'PHYSICAL_GOODS'],
      ['Queue fee (up to)', 2, 1_200, null],
    ],
    shippingCents: 3_500,
  },
  B: {
    gates: ['G1', 'G9'],
    what: 'local pickup hold $20.00',
    items: [
      ['Strawberry shortcake (shop price, up to)', 1, 1_500, 'PHYSICAL_GOODS'],
      ['Queue fee (up to)', 1, 500, null],
    ],
    shippingCents: 0,
    pickup: true,
  },
  C: {
    gates: ['G3'],
    what: 'hold $30.00, captured in part, then voided',
    items: [
      ['Lucky Cat plush (shop price, up to)', 2, 1_000, 'PHYSICAL_GOODS'],
      ['Queue fee (up to)', 2, 500, null],
    ],
    shippingCents: 0,
  },
  D1: { gates: ['G10'], what: 'dated hold $10.00', items: [['Lucky Cat plush (shop price, up to)', 1, 700, 'PHYSICAL_GOODS'], ['Queue fee (up to)', 1, 300, null]], shippingCents: 0 },
  D2: { gates: ['G10'], what: 'dated hold $12.00', items: [['Lucky Cat plush (shop price, up to)', 1, 800, 'PHYSICAL_GOODS'], ['Queue fee (up to)', 1, 400, null]], shippingCents: 0 },
};

function orderInput(label, runId, returnBase, pickup) {
  const plan = ORDER_PLANS[label];
  const items = plan.items.map(([name, quantity, unitAmountCents, category]) => ({ name, quantity, unitAmountCents, category }));
  const itemTotalCents = items.reduce((s, i) => s + i.quantity * i.unitAmountCents, 0);
  const amountCents = itemTotalCents + plan.shippingCents;
  return {
    requestId: `gate:${runId}:${label}:order${pickup === false && plan.pickup ? ':plain' : ''}`,
    invoiceId: `HMS-GATE-${runId}-${label}`,
    customId: `gate_${runId}_${label}`,
    description: `HoldMySpot sandbox gate ${label}: hold up to ${usd(amountCents)}`,
    softDescriptor: 'HOLDMYSPOT',
    amountCents,
    breakdown: { itemTotalCents, shippingCents: plan.shippingCents },
    items,
    shipping: pickup ? { type: 'PICKUP_FROM_PERSON', preference: 'NO_SHIPPING' } : { type: 'SHIPPING', preference: plan.shippingCents > 0 ? 'GET_FROM_FILE' : 'NO_SHIPPING' },
    funding: 'paypal',
    returnUrl: `${returnBase}/return?label=${label}`,
    cancelUrl: `${returnBase}/cancel?label=${label}`,
  };
}

function startReturnServer(onReturn) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      const label = u.searchParams.get('label');
      if (u.pathname === '/return' && label) onReturn(label);
      const text =
        u.pathname === '/return'
          ? `Approved${label ? ` (order ${label.replace(/[^A-Z0-9]/gi, '')})` : ''}. You can close this tab and go back to the terminal.`
          : u.pathname === '/cancel'
            ? 'Cancelled. Go back to the terminal.'
            : 'HoldMySpot sandbox gates.';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>HoldMySpot sandbox gates</title><body style="font:18px system-ui;margin:3rem">${text}</body>`);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function openInBrowser(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'www.sandbox.paypal.com') return;
    if (process.platform === 'darwin') execFile('open', [url], () => {});
  } catch {
    // Printing the link is enough.
  }
}

// ---------------------------------------------------------------------------
// Gate steps
// ---------------------------------------------------------------------------

function captureInput(o, step, amountCents, finalCapture, suffix) {
  return {
    requestId: `gate:${o.runId}:${o.label}:${step}`,
    amountCents,
    finalCapture,
    invoiceId: `HMS-GATE-${o.runId}-${o.label}-${suffix}`,
    noteToPayer: `HoldMySpot sandbox gate ${o.label}`,
    softDescriptor: 'HOLDMYSPOT',
  };
}

async function stepsA(ctx, o, auth) {
  const { port, state } = ctx;
  const c1 = await port.captureAuthorization(auth.authorizationId, captureInput(o, 'cap1', 7_601, false, 'R'));
  const a1 = await port.getAuthorization(auth.authorizationId);
  try {
    await port.addTracking(o.orderId, {
      requestId: `gate:${o.runId}:A:track`,
      captureId: c1.captureId,
      trackingNumber: `HMS${o.runId.replace('-', '')}A`,
      carrierName: 'Harbor Air Parcel',
      notifyPayer: false,
    });
    const d = await port.getOrder(o.orderId);
    if (d.trackers.length > 0) setGate(state, 'G8', 'pass', 'Tracker added with carrier OTHER and shown on the order', [`order ${o.orderId}`, `capture ${c1.captureId}`, `tracker ${d.trackers[0].trackingNumber} ${d.trackers[0].status ?? ''}`]);
    else setGate(state, 'G8', 'partial', 'The track call returned 2xx, but GET order shows no tracker', [`order ${o.orderId}`]);
  } catch (e) {
    setGate(state, 'G8', 'fail', errText(e), [`order ${o.orderId}`, `capture ${c1.captureId}`]);
  }
  const c2 = await port.captureAuthorization(auth.authorizationId, captureInput(o, 'cap2', 2_640, true, 'S'));
  const a2 = await port.getAuthorization(auth.authorizationId);
  let third = 'not refused';
  try {
    await port.captureAuthorization(auth.authorizationId, captureInput(o, 'cap3', 100, true, 'X'));
  } catch (e) {
    third = e && e.code ? `refused: ${e.code} ${e.issue ?? ''}`.trim() : 'refused';
  }
  const ok = c1.status === 'COMPLETED' && c2.status === 'COMPLETED' && a1.status === 'PARTIALLY_CAPTURED' && a2.status === 'CAPTURED' && third.startsWith('refused');
  setGate(state, 'G2', ok ? 'pass' : 'fail', ok ? 'Two captures completed; the final one closed the hold; a third was refused' : 'Statuses differ from the plan (see evidence)', [
    `order ${o.orderId}`,
    `authorization ${auth.authorizationId} ${usd(auth.amountCents)}`,
    `capture ${c1.captureId} $76.01 ${c1.status}, authorization then ${a1.status}`,
    `capture ${c2.captureId} $26.40 final ${c2.status}, authorization then ${a2.status}`,
    `third capture ${third}`,
  ]);
  try {
    const r = await port.refundCapture(c2.captureId, { requestId: `gate:${o.runId}:A:refund1`, amountCents: 500, invoiceId: `HMS-GATE-${o.runId}-A-F1`, noteToPayer: 'HoldMySpot sandbox gate refund' });
    state.disputeTarget = { captureId: c1.captureId, amount: '$76.01', invoiceId: `HMS-GATE-${o.runId}-A-R`, orderId: o.orderId, refundOk: r.status === 'COMPLETED' || r.status === 'PENDING' };
    setGate(state, 'G7', 'partial', `Refund ${r.status}; the dispute part waits for the owner`, [`refund ${r.refundId} $5.00 of capture ${c2.captureId}`]);
  } catch (e) {
    state.disputeTarget = { captureId: c1.captureId, amount: '$76.01', invoiceId: `HMS-GATE-${o.runId}-A-R`, orderId: o.orderId, refundOk: false };
    setGate(state, 'G7', 'fail', `Refund failed: ${errText(e)}`, []);
  }
}

async function stepsB(ctx, o, auth) {
  const { port, state } = ctx;
  const where = ctx.mode === 'fake' ? 'approved by the simulated buyer' : "approved on PayPal's page";
  setGate(
    state,
    'G9',
    o.pickup ? 'pass' : 'partial',
    o.pickup
      ? `Orders with payment_source.paypal.experience_context were ${where}; a PICKUP_FROM_PERSON order was accepted (JS SDK v6 session check: manual)`
      : `Orders with payment_source were approved; PICKUP_FROM_PERSON was refused (${o.pickupError ?? 'see run log'})`,
    [`order ${o.orderId}`, `authorization ${auth.authorizationId}`, `ship-to ${auth.shipTo ? auth.shipTo.country : 'none'}`],
  );
  const c = await port.captureAuthorization(auth.authorizationId, captureInput(o, 'cap1', 1_200, true, 'H'));
  const a = await port.getAuthorization(auth.authorizationId);
  const ok = c.status === 'COMPLETED' && a.status === 'CAPTURED';
  setGate(state, 'G1', ok ? 'pass' : 'fail', ok ? `Captured $12.00 of $20.00 with final_capture=true; the authorization is ${a.status}` : `Capture ${c.status}, authorization ${a.status}`, [
    `order ${o.orderId}`,
    `capture ${c.captureId}`,
    `authorization ${auth.authorizationId} ${a.status}`,
  ]);
}

async function stepsC(ctx, o, auth) {
  const { port, state } = ctx;
  const c = await port.captureAuthorization(auth.authorizationId, captureInput(o, 'cap1', 1_000, false, 'R'));
  try {
    const v = await port.voidAuthorization(auth.authorizationId, `gate:${o.runId}:C:void`);
    const a = await port.getAuthorization(auth.authorizationId);
    setGate(state, 'G3', a.status === 'VOIDED' ? 'pass' : 'partial', `Void after a $10.00 partial capture accepted; the authorization is ${a.status}`, [
      `order ${o.orderId}`,
      `capture ${c.captureId} ${c.status}`,
      `void answered ${v.status}`,
    ]);
  } catch (e) {
    setGate(state, 'G3', 'fail', `Void after a partial capture refused: ${errText(e)}`, [`order ${o.orderId}`, `capture ${c.captureId}`]);
  }
}

function stepsD(ctx, o, auth) {
  const { state } = ctx;
  state.datedHolds = state.datedHolds.filter((h) => h.label !== o.label);
  state.datedHolds.push({ label: o.label, runId: o.runId, orderId: o.orderId, authorizationId: auth.authorizationId, amountCents: auth.amountCents, createdAt: auth.createdAt, expiresAt: auth.expiresAt, funding: auth.fundingSource, renewals: [] });
  const first = Math.min(...state.datedHolds.map((h) => h.createdAt));
  setGate(state, 'G10', 'waiting', `${state.datedHolds.length} dated hold(s) authorized; reauthorize on or after ${fmt(first + 3 * DAY)}`, state.datedHolds.map((h) => `${h.label}: ${h.authorizationId} ${usd(h.amountCents)}`));
}

const STEPS = { A: stepsA, B: stepsB, C: stepsC, D1: stepsD, D2: stepsD };

async function payoutGate(ctx, runId) {
  const { port, state, settings } = ctx;
  if (!settings.twPayoutEmail) {
    setGate(state, 'G6', 'waiting', 'PAYPAL_TW_PAYOUT_EMAIL is not set: run scripts/setup-sandbox-secrets.mjs --payout-email <Taiwan sandbox email>');
    return;
  }
  try {
    const created = await port.createPayout({
      senderBatchId: `HMS-GATE-${runId}-G6`,
      emailSubject: 'HoldMySpot sandbox gate payout',
      emailMessage: 'A $1.00 test payout from the HoldMySpot sandbox gates.',
      items: [{ receiverEmail: settings.twPayoutEmail, amountCents: 100, note: 'HoldMySpot sandbox gate G6', senderItemId: `G6-${runId}` }],
    });
    let item = created.items[0];
    for (let i = 0; i < 18 && (!item || ['PENDING', 'NEW', 'ONHOLD'].includes(item.status)); i += 1) {
      if (ctx.mode === 'sandbox') await sleep(5_000);
      item = (await port.getPayoutBatch(created.batchId)).items[0];
    }
    const status = item ? item.status : 'unknown';
    state.payout = { batchId: created.batchId, itemId: item?.itemId ?? null, status, amountCents: 100 };
    const evidence = [`batch ${created.batchId}`, `item ${item?.itemId ?? '-'} ${status}`];
    if (status === 'SUCCESS') setGate(state, 'G6', 'pass', 'Payout by email to the Taiwan sandbox account: SUCCESS', evidence);
    else if (status === 'UNCLAIMED') setGate(state, 'G6', 'partial', 'UNCLAIMED: the Taiwan account must accept it (or the email has no sandbox account)', evidence);
    else setGate(state, 'G6', ['PENDING', 'NEW', 'ONHOLD'].includes(status) ? 'waiting' : 'fail', `Payout item ${status}`, evidence);
  } catch (e) {
    setGate(state, 'G6', 'fail', errText(e));
  }
}

async function scopeGates(ctx) {
  const { port, state } = ctx;
  try {
    const scopes = await port.tokenScopes();
    setGate(state, 'G0', 'pass', `OAuth token issued for app ${mask(ctx.settings.clientId)}`, [`${scopes.length} scopes`]);
    const missing = pp.SCOPE_CHECKS.filter((c) => !scopes.some((s) => c.pattern.test(s)));
    if (missing.length === 0) setGate(state, 'G11', 'pass', 'Scopes include authorize and capture, refunds, payouts, disputes and shipment tracking');
    else setGate(state, 'G11', 'fail', `Missing: ${missing.map((m) => `${m.feature} (tick "${m.dashboard}" on the app page)`).join(', ')}`);
    return true;
  } catch (e) {
    setGate(state, 'G0', 'fail', errText(e));
    return false;
  }
}

async function reauthorizeHolds(ctx, args) {
  const { port, state } = ctx;
  if (state.datedHolds.length === 0) {
    console.log('  No dated holds yet: `run` creates them (orders D1 and D2).');
    return;
  }
  const now = ctx.clock.now();
  for (const h of state.datedHolds) {
    if (h.renewals.some((r) => r.ok) && !args.again) {
      console.log(`  ${h.label}: already reauthorized.`);
      continue;
    }
    const day = Math.floor((now - h.createdAt) / DAY) + 1;
    if (now < h.createdAt + 3 * DAY && !args['force-early']) {
      console.log(`  ${h.label}: day ${day}, too early. Reauthorize on or after ${fmt(h.createdAt + 3 * DAY)}.`);
      continue;
    }
    try {
      const r = await port.reauthorize(h.authorizationId, { requestId: `gate:${h.runId}:${h.label}:reauth${h.renewals.length + 1}`, amountCents: h.amountCents });
      h.renewals.push({ ok: true, at: now, day, authorizationId: r.authorizationId, status: r.status, expiresAt: r.expiresAt, debugId: r.debugId });
      console.log(`  ${h.label}: day ${day}, new authorization ${r.authorizationId} ${r.status}, valid until ${fmt(r.expiresAt)}.`);
    } catch (e) {
      h.renewals.push({ ok: false, at: now, day, error: errText(e) });
      console.log(`  ${h.label}: day ${day}, refused: ${errText(e)}`);
    }
  }
  const done = state.datedHolds.filter((h) => h.renewals.some((r) => r.ok));
  const early = state.datedHolds.flatMap((h) => h.renewals.filter((r) => !r.ok && r.day <= 3).map((r) => `${h.label} day ${r.day}: ${r.error}`));
  if (done.length > 0) {
    setGate(state, 'G10', 'pass', `Reauthorized ${done.length} dated hold(s): new authorization ids`, [
      ...done.map((h) => {
        const r = h.renewals.find((x) => x.ok);
        return `${h.label}: ${h.authorizationId} -> ${r.authorizationId} on day ${r.day}`;
      }),
      ...early.map((e) => `early try ${e}`),
    ]);
  } else if (state.datedHolds.some((h) => h.renewals.some((r) => !r.ok && r.day > 3))) {
    setGate(state, 'G10', 'fail', 'Reauthorization refused on day 4 or later', state.datedHolds.flatMap((h) => h.renewals.map((r) => `${h.label} day ${r.day}: ${r.ok ? r.authorizationId : r.error}`)));
  } else if (early.length > 0) {
    setGate(state, 'G10', 'waiting', 'Early reauthorization tried before day 4 (recorded); try again from day 4', early);
  }
}

async function disputeGate(ctx, args) {
  const { port, state } = ctx;
  const since = Math.min(ctx.clock.now() - 30 * DAY, ...state.runs.map((r) => r.at - 60 * 60 * 1000));
  const disputes = await port.listDisputes(since);
  if (disputes.length === 0) {
    console.log('  No dispute on an HMS- payment yet. PayPal can take a few minutes to list a new dispute.');
    return;
  }
  for (const d of disputes) console.log(`  ${d.disputeId}: ${d.status}${d.outcome ? ` (${d.outcome})` : ''}, ${d.reason}, ${usd(d.amountCents)}, invoices ${d.invoiceIds.join(', ')}`);
  const open = disputes.filter((d) => d.status !== 'RESOLVED');
  const target = args.settle ? disputes.find((d) => d.disputeId === args.settle) : open.length === 1 ? open[0] : null;
  if (!target) {
    if (open.length > 1) console.log('  More than one open dispute: pick one with --settle <id>.');
    const resolved = disputes.find((d) => d.status === 'RESOLVED');
    if (resolved && state.disputeTarget?.refundOk) setGate(state, 'G7', 'pass', `Refund COMPLETED earlier; dispute ${resolved.disputeId} RESOLVED (${resolved.outcome ?? 'no outcome'})`, [resolved.disputeId]);
    return;
  }
  let d = target;
  if (d.status !== 'UNDER_REVIEW' && d.status !== 'RESOLVED') {
    try {
      d = await port.escalateDispute(d.disputeId, 'HoldMySpot sandbox gate: escalating to a claim so it can be settled.');
      console.log(`  Escalated ${d.disputeId}: now ${d.status}.`);
    } catch (e) {
      console.log(`  Escalate refused: ${errText(e)}`);
    }
  }
  if (d.status === 'UNDER_REVIEW') {
    const outcome = args.outcome === 'buyer' ? 'BUYER_FAVOR' : 'SELLER_FAVOR';
    try {
      d = await port.adjudicate(d.disputeId, outcome);
      console.log(`  Adjudicated ${d.disputeId} ${outcome}: now ${d.status}${d.outcome ? ` (${d.outcome})` : ''}.`);
    } catch (e) {
      console.log(`  Adjudicate refused: ${errText(e)}`);
    }
  } else if (d.status !== 'RESOLVED') {
    console.log(`  ${d.disputeId} is ${d.status}; PayPal has not moved it to UNDER_REVIEW yet. Run this again in a few minutes.`);
  }
  const refund = state.disputeTarget?.refundOk ? 'Refund COMPLETED earlier; ' : '';
  if (d.status === 'RESOLVED') setGate(state, 'G7', state.disputeTarget?.refundOk ? 'pass' : 'partial', `${refund}dispute ${d.disputeId} RESOLVED (${d.outcome ?? 'no outcome'}) with the sandbox adjudicate call`, [d.disputeId, ...d.captureIds.map((c) => `capture ${c}`)]);
  else setGate(state, 'G7', 'partial', `${refund}dispute ${d.disputeId} is ${d.status}`, [d.disputeId]);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function printPlan(state) {
  console.log('\nHoldMySpot PayPal sandbox gates\n');
  for (const [id, what, owner] of GATES) {
    const g = state.gates[id];
    console.log(`  ${id.padEnd(4)} ${(g ? g.status : 'not run').padEnd(9)} ${what}`);
    console.log(`  ${''.padEnd(14)}owner: ${owner}`);
  }
  console.log('\nOwner approvals during `run` (as the US sandbox buyer, on PayPal\'s own page; agents never sign in):');
  for (const [label, plan] of Object.entries(ORDER_PLANS)) console.log(`  order ${label.padEnd(3)} ${plan.what}  (${plan.gates.join(', ')})`);
  const actions = ownerActions(state);
  if (actions.length > 0) {
    console.log('\nWaiting on the owner:');
    for (const a of actions) console.log(`  - ${a}`);
  }
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

async function cmdRun(args, ctx, runId) {
  const { port, state, mode } = ctx;
  const only = args.only ? new Set(args.only.split(',').map((s) => s.trim().toUpperCase())) : null;
  const wanted = (gate) => !only || only.has(gate);
  // An order is created again only while one of its own gates is still open; A also
  // feeds G7 (refund and the dispute target) until that refund has been made.
  const own = { A: ['G2', 'G8'], B: ['G1', 'G9'], C: ['G3'] };
  const labels = Object.keys(ORDER_PLANS).filter((label) => {
    const plan = ORDER_PLANS[label];
    if (!plan.gates.some(wanted)) return false;
    if (label.startsWith('D')) return !state.datedHolds.some((h) => h.label === label);
    if (args.again) return true;
    const open = own[label].some((g) => wanted(g) && state.gates[g]?.status !== 'pass');
    const needsDisputeTarget = label === 'A' && wanted('G7') && state.gates.G7?.status !== 'pass' && !state.disputeTarget?.refundOk;
    return open || needsDisputeTarget;
  });

  if (mode === 'sandbox' && !args.yes) {
    const ok = await confirm(
      `\nThis creates up to ${labels.length} sandbox order(s) for the owner to approve${wanted('G6') ? ' and one $1.00 sandbox payout' : ''} on app ${mask(ctx.settings.clientId)}${ctx.settings.merchantEmail ? ` (${ctx.settings.merchantEmail})` : ''}. Continue? [y/N] `,
    );
    if (!ok) {
      console.log('Stopped. Nothing was created.');
      return;
    }
  }

  console.log('\nOAuth and scopes');
  if (!(await scopeGates(ctx))) return;

  let server = null;
  const hinted = new Set();
  let returnBase = 'http://127.0.0.1:8796/api/paypal';
  if (mode === 'sandbox' && labels.length > 0) {
    server = await startReturnServer((label) => hinted.add(label));
    returnBase = `http://127.0.0.1:${server.address().port}`;
  }

  try {
    console.log('\nOrders');
    const pending = [];
    for (const label of labels) {
      const prior = state.orders[label];
      if (mode === 'sandbox' && prior && prior.status === 'awaiting_approval' && Date.now() - prior.createdAt < ORDER_LIFETIME_MS) {
        pending.push({ label, ...prior, nextPoll: 0 });
        console.log(`  ${label}: still waiting for approval (order ${prior.orderId}).`);
        continue;
      }
      const plan = ORDER_PLANS[label];
      let pickup = Boolean(plan.pickup);
      let pickupError = null;
      let created;
      try {
        created = await port.createOrder(orderInput(label, runId, returnBase, pickup));
      } catch (e) {
        if (!pickup) {
          console.log(`  ${label}: create failed: ${errText(e)}`);
          for (const g of plan.gates) setGate(state, g, 'fail', `Order ${label} could not be created: ${errText(e)}`);
          continue;
        }
        pickupError = errText(e);
        console.log(`  ${label}: PICKUP_FROM_PERSON refused (${pickupError}); trying a plain order.`);
        pickup = false;
        created = await port.createOrder(orderInput(label, runId, returnBase, false));
      }
      const o = { label, runId, orderId: created.orderId, approveUrl: created.approveUrl, createdAt: Date.now(), status: 'awaiting_approval', what: plan.what, pickup, pickupError };
      state.orders[label] = { ...o };
      pending.push({ ...o, nextPoll: 0 });
      console.log(`  ${label}: order ${o.orderId} (${plan.what}).`);
    }

    if (wanted('G6')) {
      console.log('\nPayout (G6)');
      await payoutGate(ctx, runId);
    }
    for (const id of ['G4', 'G5']) if (wanted(id) && !state.gates[id]) setGate(state, id, 'manual', 'Needs the JS SDK v6 in a browser; run it from the web app and record the result');

    if (pending.length > 0 && mode === 'sandbox') {
      console.log('\nApprovals needed. Open each link, log in as the US sandbox buyer on PayPal\'s page, and press Continue:');
      for (const o of pending) {
        console.log(`  [${o.label}] ${o.what}\n       ${o.approveUrl ?? '(no approval link returned)'}`);
        if (args.open && o.approveUrl) openInBrowser(o.approveUrl);
      }
      console.log(`Waiting up to ${args.wait} minutes; each order continues as soon as it is approved.`);
    }

    const deadline = Date.now() + Number(args.wait) * 60_000;
    while (pending.length > 0) {
      for (const o of [...pending]) {
        let approved = false;
        if (mode === 'fake') {
          await port.approveOrder(o.orderId, 'paypal', 'approve');
          approved = true;
        } else if (hinted.has(o.label) || Date.now() >= o.nextPoll) {
          o.nextPoll = Date.now() + 15_000;
          try {
            const d = await port.getOrder(o.orderId);
            approved = d.status === 'APPROVED';
            if (d.status === 'COMPLETED') {
              console.log(`  ${o.label}: order already completed earlier; creating a new one next run.`);
              state.orders[o.label].status = 'abandoned';
              pending.splice(pending.indexOf(o), 1);
              continue;
            }
          } catch (e) {
            console.log(`  ${o.label}: could not read the order: ${errText(e)}`);
          }
        }
        if (!approved) continue;
        pending.splice(pending.indexOf(o), 1);
        state.orders[o.label].status = 'approved';
        console.log(`\nOrder ${o.label} approved`);
        try {
          const auth = await port.authorizeOrder(o.orderId, `gate:${o.runId}:${o.label}:auth`);
          state.orders[o.label].status = 'authorized';
          state.orders[o.label].authorizationId = auth.authorizationId;
          console.log(`  Authorization ${auth.authorizationId} ${auth.status} ${usd(auth.amountCents)}, funding ${auth.fundingSource}, valid until ${fmt(auth.expiresAt)}`);
          await STEPS[o.label](ctx, o, auth);
        } catch (e) {
          state.orders[o.label].status = 'failed';
          for (const g of ORDER_PLANS[o.label].gates) if (state.gates[g]?.status !== 'pass') setGate(state, g, 'fail', `Order ${o.label}: ${errText(e)}`, [`order ${o.orderId}`]);
        }
        if (ctx.stateFile) saveState(ctx.stateFile, state);
      }
      if (pending.length === 0 || mode === 'fake') break;
      if (Date.now() > deadline) {
        console.log(`\nStopped waiting. Still waiting for approval: ${pending.map((o) => o.label).join(', ')}. Approve them and run this again within 3 hours.`);
        break;
      }
      await sleep(1_000);
    }
  } finally {
    if (server) server.close();
  }

  if (mode === 'fake') {
    if (state.datedHolds.length > 0 && wanted('G10')) {
      console.log('\nFake clock: jump to day 4, then reauthorize (G10)');
      ctx.clock.advance(3 * DAY + 5 * 60_000);
      await reauthorizeHolds(ctx, args);
    }
    if (state.disputeTarget && wanted('G7')) {
      console.log('\nFake buyer opens a dispute, then settle it (G7)');
      ctx.port.openDispute(state.disputeTarget.captureId);
      await disputeGate(ctx, args);
    }
  }
}

async function cmdStatus(ctx) {
  const { port, state } = ctx;
  if (state.payout?.batchId) {
    try {
      const b = await port.getPayoutBatch(state.payout.batchId);
      const item = b.items[0];
      state.payout.status = item?.status ?? state.payout.status;
      console.log(`  Payout ${state.payout.batchId}: ${state.payout.status}`);
      if (state.payout.status === 'SUCCESS') setGate(state, 'G6', 'pass', 'Payout by email to the Taiwan sandbox account: SUCCESS', [`batch ${b.batchId}`, `item ${item?.itemId ?? '-'}`]);
    } catch (e) {
      console.log(`  Payout: ${errText(e)}`);
    }
  }
  for (const h of state.datedHolds) {
    try {
      const a = await port.getAuthorization(h.authorizationId);
      console.log(`  Dated hold ${h.label} ${h.authorizationId}: ${a.status}, day ${Math.floor((Date.now() - h.createdAt) / DAY) + 1}, reauthorize from ${fmt(h.createdAt + 3 * DAY)}`);
    } catch (e) {
      console.log(`  Dated hold ${h.label}: ${errText(e)}`);
    }
  }
  try {
    const disputes = await port.listDisputes(Date.now() - 30 * DAY);
    console.log(`  Disputes on HMS- payments: ${disputes.length === 0 ? 'none' : disputes.map((d) => `${d.disputeId} ${d.status}`).join(', ')}`);
  } catch (e) {
    console.log(`  Disputes: ${errText(e)}`);
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        fake: { type: 'boolean' },
        out: { type: 'string' },
        only: { type: 'string' },
        wait: { type: 'string', default: '15' },
        open: { type: 'boolean' },
        yes: { type: 'boolean' },
        'no-record': { type: 'boolean' },
        'force-early': { type: 'boolean' },
        again: { type: 'boolean' },
        settle: { type: 'string' },
        outcome: { type: 'string' },
        note: { type: 'string' },
        verbose: { type: 'boolean' },
        dir: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    console.error(String(err.message ?? err));
    return 1;
  }
  const args = parsed.values;
  const [command = 'plan', ...rest] = parsed.positionals;
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!['plan', 'run', 'reauthorize', 'disputes', 'status', 'record'].includes(command)) {
    console.error(`Unknown command ${command}.\n`);
    console.log(USAGE);
    return 1;
  }
  if (!(Number(args.wait) > 0)) {
    console.error('--wait takes a number of minutes.');
    return 1;
  }
  await loadPayPalModule();

  const now = Date.now();
  const runId = stamp(now);
  const outFile = args.out ? path.resolve(args.out) : args.fake ? path.join(os.tmpdir(), 'holdmyspot-sandbox-gates-fake.md') : DOC;
  const sandboxStateFile = path.join(secretsDirFrom(args), STATE_FILE);

  if (command === 'plan') {
    const state = args.fake ? emptyState() : loadState(sandboxStateFile);
    printPlan(state);
    writeDoc(outFile, state, { mode: args.fake ? 'fake' : 'sandbox' });
    return 0;
  }

  if (command === 'record') {
    const [gate, result] = rest;
    const id = String(gate ?? '').toUpperCase();
    if (!GATE_IDS.includes(id) || !['pass', 'fail', 'partial', 'skip'].includes(result ?? '')) {
      console.error('Usage: record <G0..G11> <pass|fail|partial|skip> [--note "..."]');
      return 1;
    }
    const state = args.fake ? emptyState() : loadState(sandboxStateFile);
    setGate(state, id, result === 'skip' ? 'skipped' : result, args.note ? `Recorded by hand: ${args.note}` : 'Recorded by hand');
    state.runs.push({ runId, at: now, mode: args.fake ? 'fake' : 'sandbox', command: `record ${id} ${result}`, note: args.note ?? '' });
    if (!args.fake) saveState(sandboxStateFile, state);
    writeDoc(outFile, state, { mode: args.fake ? 'fake' : 'sandbox' });
    return 0;
  }

  const record = command === 'run' && !args['no-record'] && !args.fake;
  const conn = connect(args, runId, record);
  const state = conn.stateFile ? loadState(conn.stateFile) : emptyState();
  state.app = { clientId: mask(conn.settings.clientId), merchantEmail: conn.settings.merchantEmail || null };
  const ctx = { ...conn, state };
  console.log(`\nHoldMySpot sandbox gates: ${command} (${conn.mode}, run ${runId}, app ${mask(conn.settings.clientId)})`);

  try {
    if (command === 'run') await cmdRun(args, ctx, runId);
    else if (command === 'reauthorize') await reauthorizeHolds(ctx, args);
    else if (command === 'disputes') await disputeGate(ctx, args);
    else if (command === 'status') await cmdStatus(ctx);
  } catch (e) {
    console.error(`\nStopped: ${errText(e)}`);
    state.runs.push({ runId, at: now, mode: conn.mode, command, note: `stopped: ${errText(e)}` });
    saveState(conn.stateFile, state);
    writeDoc(outFile, state, { mode: conn.mode });
    return 1;
  }
  const summary = Object.entries(state.gates)
    .map(([id, g]) => `${id} ${g.status}`)
    .join(', ');
  state.runs.push({ runId, at: now, mode: conn.mode, command, note: summary });
  saveState(conn.stateFile, state);
  writeDoc(outFile, state, { mode: conn.mode });
  if (record) console.log(`Sanitized responses: ${path.join(RECORD_DIR, runId)} (checked by server/test/paypal/recorded.test.ts)`);
  const actions = ownerActions(state);
  if (actions.length > 0) {
    console.log('\nWaiting on the owner:');
    for (const a of actions) console.log(`  - ${a}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  },
);
