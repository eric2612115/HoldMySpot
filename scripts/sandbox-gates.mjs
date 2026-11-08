#!/usr/bin/env node
// HoldMySpot day-1 PayPal sandbox gates (docs/PAYPAL-MAPPING.md section 7), as a runnable script.
//
//   node scripts/sandbox-gates.mjs plan          List the gates and the owner's steps; refresh docs/SANDBOX-GATES.md. No network.
//   node scripts/sandbox-gates.mjs run           Run what can run now against the PayPal sandbox. Prints PayPal approval
//                                                links for the owner (sandbox buyer) and waits for them; with
//                                                --auto-approve a headless browser approves them as the sandbox buyer.
//   node scripts/sandbox-gates.mjs reauthorize   G10 part 2: reauthorize the dated holds, from day 4 (film it on 11-11/11-12).
//   node scripts/sandbox-gates.mjs disputes      G7 part 2: find the buyer's dispute, escalate it, settle it with adjudicate
//                                                (--open-as-buyer first opens one in the buyer's Resolution Center).
//   node scripts/sandbox-gates.mjs status        Re-read the payout, dated holds and disputes; refresh the page.
//   node scripts/sandbox-gates.mjs probe         Record PayPal's answers to the edge cases the emulator copies (one $10 hold).
//   node scripts/sandbox-gates.mjs lifecycle     One full job through the server's HTTP API on the sandbox (own server on
//                                                port 8798), then GET the authorization, captures and payouts from PayPal
//                                                and compare them with the server's ledger (scripts/lib/sandbox-lifecycle.mjs).
//                                                --by-hand: you approve PayPal's link yourself; no stored password.
//   node scripts/sandbox-gates.mjs record G4 pass --note "..."   Record a gate checked by hand (Venmo, Pay Later).
//
// Add --fake to run against the in-process fake PayPal (no network, no credentials); its page goes to a
// temporary file unless --out is given, never to docs/.
//
// Credentials come only from sandbox.env in the secrets folder: --dir, else HMS_SECRETS_DIR, else the repo's
// .secrets/ written by npm run keys (D-131).
// The script never prints secrets. Without --auto-approve every approval is the owner's, on PayPal's own
// pages. With --auto-approve (owner's permission, 11-07) scripts/lib/sandbox-buyer.mjs signs in on
// www.sandbox.paypal.com as the sandbox buyer (PAYPAL_BUYER_EMAIL, password from sandbox-buyers.json, read at
// run time, never printed) and stops at any CAPTCHA or security check. The results page holds ids and
// statuses only.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { sanitizePayPal } from './lib/sanitize.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(REPO, 'docs', 'SANDBOX-GATES.md');
const RECORD_DIR = path.join(REPO, 'server', 'test', 'paypal', 'fixtures', 'recorded');
const STATE_FILE = 'holdmyspot-sandbox-gates.json';
const DAY = 86_400_000;
const ORDER_LIFETIME_MS = 3 * 60 * 60 * 1000;

const GATES = [
  ['G0', 'OAuth token from sandbox.env', 'none'],
  ['G11', 'Token scopes include payouts, disputes and tracking', 'none (tick missing features on the app page)'],
  ['G1', 'Capture below the held amount with final_capture=true; nothing left to capture', 'approve order B (or --auto-approve)'],
  ['G2', 'Partial capture (final_capture=false), then a final capture; a third is refused', 'approve order A (or --auto-approve)'],
  ['G3', 'Void after a partial capture', 'approve order C (or --auto-approve)'],
  ['G4', 'Venmo AUTHORIZE with testBuyerCountry US', 'manual: approve a Venmo hold in the web app, then `record G4`'],
  ['G5', 'Pay Later with intent AUTHORIZE (bonus)', 'manual: approve a Pay Later hold in the web app, then `record G5`'],
  ['G6', 'Payout by email to the payout receiver sandbox account', 'only if UNCLAIMED: accept it on sandbox.paypal.com as that account'],
  ['G7', 'Refund; then a buyer-opened dispute settled with adjudicate', 'open a dispute as the buyer (or `disputes --open-as-buyer`), then run `disputes`'],
  ['G8', 'Tracking with carrier OTHER on a capture of an authorized order', 'approve order A (or --auto-approve)'],
  ['G9', 'Order with payment_source approved; local PICKUP_FROM_PERSON accepted', 'approve order B (the JS SDK v6 session check is manual)'],
  ['G10', 'Dated holds reauthorized on day 4 or later', 'approve D1 and D2 (or --auto-approve); run `reauthorize` from day 4, before the deadline (film it)'],
];
const GATE_IDS = GATES.map((g) => g[0]);

const USAGE = `HoldMySpot PayPal sandbox gates

  node scripts/sandbox-gates.mjs [plan|run|reauthorize|disputes|status|lifecycle|record] [options]

Options:
  --fake               Use the in-process fake PayPal (no network, no credentials).
  --out <file>         Results page (default docs/SANDBOX-GATES.md; with --fake a temporary file).
  --only G1,G2         run: only these gates.
  --wait <minutes>     run, lifecycle --by-hand: how long to wait for approvals (default 15).
  --open               run: open the approval links in the browser (macOS). lifecycle: implies --by-hand.
  --by-hand            lifecycle: print PayPal's approval link and wait while you approve it in your own
                       browser as your sandbox buyer, instead of signing in with a saved password.
  --auto-approve       run: approve every order in a headless browser as the sandbox buyer (stops at any challenge).
  --headed             With --auto-approve or --open-as-buyer: show the browser window.
  --shots <dir>        Where the buyer browser saves screenshots of a challenge (default: a temporary folder).
  --payout-to <label>  Payout receiver from sandbox-buyers.json (for example person-1) when sandbox.env has no
                       PAYPAL_PAYOUT_EMAIL. Never the buyer. The email is never printed.
  --yes                run: do not ask before creating sandbox orders.
  --no-record          run: do not save sanitized responses as test fixtures.
  --force-early        reauthorize: try before day 4 too (records PayPal's answer).
  --probe-second       reauthorize: after D2's renewal, try a second reauthorization of D2's original (records whether
                       PayPal allows more than one; D-52 depends on it).
  --open-as-buyer      disputes: first open an "item not received" dispute on the gate's capture as the buyer.
  --settle <id>        disputes: which dispute to settle.
  --outcome <seller|buyer>  disputes: adjudicate outcome (default seller).
  --note <text>        record: what was seen.
  --port <n>           lifecycle: the port of the server it starts (default 8798).
  --keep               lifecycle: keep the temporary database, uploads and server log.
  --verbose            Print one line per PayPal call (with debug ids).
  --dir <dir>          Secrets folder (default $HMS_SECRETS_DIR, else .secrets/ in this repo).
`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const taipei = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const pacific = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmt = (ms) => (ms ? `${taipei.format(new Date(ms)).replace(', ', ' ')} Taipei` : '-');
const fmtPt = (ms) => (ms ? `${pacific.format(new Date(ms)).replace(', ', ' ')} PT` : '-');
/** Both clocks: the owner works in Taipei, the hackathon deadline is in PT. */
const fmtBoth = (ms) => (ms ? `${fmtPt(ms)} (${fmt(ms)})` : '-');
/** The first whole minute at or after `ms`, so "from 00:16" is never a few seconds too early. */
const minuteUp = (ms) => Math.ceil(ms / 60_000) * 60_000;
/** When a dated hold may be reauthorized: its authorization time plus PayPal's 3-day honor period. */
const reauthFrom = (h) => minuteUp(h.createdAt + 3 * DAY);
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

/** --dir, else HMS_SECRETS_DIR, else the repo's .secrets/ written by npm run keys (D-131). */
function secretsDirFrom(args) {
  const d = args.dir || process.env.HMS_SECRETS_DIR || path.join(REPO, '.secrets');
  return d.startsWith('~/') ? path.join(os.homedir(), d.slice(2)) : d;
}

function emptyState() {
  return { version: 1, app: null, gates: {}, orders: {}, datedHolds: [], payout: null, disputeTarget: null, lifecycle: null, runs: [] };
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
    if (state.disputeTarget.openedAt) {
      out.push(
        state.disputeTarget.adjudicated
          ? `G7: dispute ${state.disputeTarget.caseId ?? '-'} (opened by the sandbox buyer ${fmtBoth(state.disputeTarget.openedAt)}): PayPal accepted adjudicate ${state.disputeTarget.adjudicated.outcome} on ${fmtBoth(state.disputeTarget.adjudicated.at)} and resolves it later; run \`node scripts/sandbox-gates.mjs disputes\` again to record RESOLVED.`
          : `G7: the sandbox buyer opened dispute ${state.disputeTarget.caseId ?? '(case id not read)'} on ${fmtBoth(state.disputeTarget.openedAt)}; run \`node scripts/sandbox-gates.mjs disputes\` again later (PayPal offers adjudicate only some minutes after the claim opens${state.disputeTarget.adjudicateRefused ? `; refused last at ${fmtBoth(state.disputeTarget.adjudicateRefused.at)}` : ''}).`,
      );
    } else {
      out.push(
        `G7: run \`node scripts/sandbox-gates.mjs disputes --open-as-buyer\`, or log in at https://www.sandbox.paypal.com as the sandbox buyer, open the ${state.disputeTarget.amount} HoldMySpot payment (invoice ${state.disputeTarget.invoiceId}) and report a problem (item not received); then run \`node scripts/sandbox-gates.mjs disputes\`.`,
      );
    }
  }
  if (state.payout && state.payout.status === 'UNCLAIMED') out.push(`G6: log in at https://www.sandbox.paypal.com as the payout receiver sandbox account and accept the ${usd(state.payout.amountCents)} payment, then run \`node scripts/sandbox-gates.mjs status\`.`);
  for (const h of state.datedHolds) {
    if (h.renewals.some((r) => r.ok)) continue;
    out.push(`G10: on or after ${fmtBoth(reauthFrom(h))} (the hackathon deadline is 2026-11-12 12:00 PT), screen-record \`node scripts/sandbox-gates.mjs reauthorize\` for dated hold ${h.label}.`);
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
      const second = h.secondReauthorization ? `; second reauthorization of the original: ${h.secondReauthorization.ok ? `accepted ${h.secondReauthorization.authorizationId}` : `refused ${h.secondReauthorization.error}`}` : '';
      const renewals = (h.renewals.map((r) => (r.ok ? `${fmt(r.at)}: new authorization ${r.authorizationId} ${r.status}` : `${fmt(r.at)}: ${r.error}`)).join('; ') || '-') + second;
      lines.push(`| ${h.label} | ${h.orderId} | ${h.authorizationId} | ${usd(h.amountCents)} | ${fmtBoth(h.createdAt)} | ${fmtBoth(reauthFrom(h))} | ${fmtBoth(h.expiresAt)} | ${cell(renewals)} |`);
    }
  }
  lines.push('');
  lines.push('## Full job through the server (sandbox)');
  lines.push('');
  const lc = state.lifecycle;
  if (!lc) lines.push('Not run yet: `node scripts/sandbox-gates.mjs lifecycle --payout-to <label>`.');
  else {
    lines.push(`${fmtBoth(lc.at)}: ${lc.ok ? 'passed' : 'FAILED'}. Server on HTTP only (bid, authorize, claim, check-in, bought, proof, shipment), AI ${lc.ai ?? '-'}; PayPal read back afterwards.`);
    lines.push('');
    lines.push('| Check | Result | PayPal and server |');
    lines.push('|---|---|---|');
    for (const c of lc.checks ?? []) lines.push(`| ${cell(c.name)} | ${c.ok ? 'match' : 'MISMATCH'} | ${cell(c.detail)} |`);
    lines.push('');
    const ids = lc.ids ?? {};
    lines.push(`Ids: bid ${ids.bid ?? '-'}, order ${ids.order ?? '-'}, authorization ${ids.authorization ?? '-'}, job ${ids.job ?? '-'}, tracking ${ids.tracking ?? '-'}.`);
    if (lc.ledger) lines.push(`Server ledger: ${lc.ledger.map((e) => `${e.kind} ${usd(e.cents)} ${e.status}`).join(', ')}.`);
    if (lc.error) lines.push(`Stopped: ${cell(lc.error)}`);
  }
  lines.push('');
  lines.push('## Edge cases: what PayPal answered (`probe`)');
  lines.push('');
  const pr = state.probe;
  if (!pr) lines.push('Not run yet: `node scripts/sandbox-gates.mjs probe` (one $10.00 hold, auto-approved).');
  else {
    lines.push(`${fmtBoth(pr.at)}, run ${pr.runId}. The emulator (server/src/paypal/emulator.ts) copies these answers.`);
    lines.push('');
    lines.push('| Call | PayPal |');
    lines.push('|---|---|');
    for (const a of pr.answers) lines.push(`| ${cell(a.what)} | ${cell(a.ok ? `OK ${a.answer}` : `refused: ${a.answer}`)} |`);
  }
  lines.push('');
  lines.push('## Venmo and Pay Later (G4, G5)');
  lines.push('');
  lines.push('These need PayPal\'s JS SDK v6 in a browser, so they run from the web app, not from this script:');
  lines.push('');
  lines.push("- Load `https://www.sandbox.paypal.com/web-sdk/v6/core`, then `paypal.createInstance({ clientId, components: ['paypal-payments', 'venmo-payments'], pageType: 'checkout', testBuyerCountry: 'US' })`.");
  lines.push("- `findEligibleMethods({ currencyCode: 'USD' })`, then `isEligible('venmo')` and `isEligible('paylater')`. Show a button only when it is eligible.");
  lines.push('- Venmo is for US buyers paying in USD to a single US payee (the platform app); in the sandbox it needs `testBuyerCountry: \'US\'`. Venmo payouts are for US recipients only and are production only (PayPal\'s Venmo payouts page, read 2026-11-08).');
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

/**
 * Saves each PayPal response once, sanitized (scripts/lib/sanitize.mjs), as a fixture for
 * server/test/paypal/recorded.test.ts. Polls that only repeat an earlier answer (same call, HTTP
 * status, object and status) are skipped. Paths keep ids only: no query strings.
 */
function recorder(runId) {
  let n = 0;
  const seen = new Set();
  const dir = path.join(RECORD_DIR, runId);
  return (r) => {
    const b = r.body && typeof r.body === 'object' ? r.body : {};
    const head = b.batch_header && typeof b.batch_header === 'object' ? b.batch_header : {};
    const itemStates = Array.isArray(b.items) ? b.items.map((i) => (i && typeof i === 'object' ? `${i.transaction_status ?? ''}${i.status ?? ''}` : '')).join(',') : '';
    const key = `${r.op}|${r.status}|${r.path.split('?')[0]}|${b.status ?? ''}|${head.batch_status ?? ''}|${itemStates}`;
    if (r.method === 'GET' && seen.has(key)) return;
    seen.add(key);
    n += 1;
    fs.mkdirSync(dir, { recursive: true });
    const name = `${String(n).padStart(3, '0')}-${r.op.replace(/[^a-z0-9.]/gi, '_')}-${r.status}.json`;
    const body = { op: r.op, method: r.method, path: r.path.split('?')[0], status: r.status, debugId: r.debugId, body: sanitizePayPal(r.body) };
    fs.writeFileSync(path.join(dir, name), `${JSON.stringify(body, null, 2)}\n`);
  };
}

/** Uses a sandbox-buyers.json account as the payout receiver when sandbox.env names none (--payout-to). */
async function payoutReceiverFrom(args, settings) {
  if (settings.twPayoutEmail || !args['payout-to']) return null;
  const { loadPayoutReceiver } = await import('./lib/sandbox-buyer.mjs');
  const receiver = loadPayoutReceiver(secretsDirFrom(args), args['payout-to']);
  Object.defineProperty(settings, 'twPayoutEmail', { value: receiver.email, enumerable: false, configurable: true });
  return receiver.label;
}

/** Returns { port, settings, mode, stateFile, clock } for --fake or the sandbox. */
async function connect(args, runId, record) {
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
    console.error('Save the sandbox keys with `npm run keys` first (or use --fake to try the script offline).');
    process.exit(2);
  }
  for (const w of loaded.warnings) console.log(`  Warning: ${w}`);
  const receiverLabel = await payoutReceiverFrom(args, loaded.settings);
  if (receiverLabel) console.log(`  Payouts go to sandbox account ${receiverLabel} (--payout-to).`);
  const missing = loaded.missingRecommended.filter((k) => !(k === 'PAYPAL_PAYOUT_EMAIL' && receiverLabel));
  if (missing.length > 0) console.log(`  Not set (some gates will wait): ${missing.join(', ')}`);
  const port = pp.createSandboxPayPal({
    settings: loaded.settings,
    baseUrl: pp.SANDBOX_BASE_URL,
    timeoutMs: 30_000,
    log,
    onResponse: record ? recorder(record) : undefined,
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
  // `probe` only: PayPal's own answers to the edge cases the emulator copies (no gate depends on it).
  E: { gates: [], what: 'probe hold $10.00', items: [['Lucky Cat plush (shop price, up to)', 1, 700, 'PHYSICAL_GOODS'], ['Queue fee (up to)', 1, 300, null]], shippingCents: 0 },
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
    state.disputeTarget = { captureId: c1.captureId, amount: '$76.01', amountCents: 7_601, invoiceId: `HMS-GATE-${o.runId}-A-R`, orderId: o.orderId, refundOk: r.status === 'COMPLETED' || r.status === 'PENDING' };
    setGate(state, 'G7', 'partial', `Refund ${r.status}; the dispute part waits for the owner`, [`refund ${r.refundId} $5.00 of capture ${c2.captureId}`]);
  } catch (e) {
    state.disputeTarget = { captureId: c1.captureId, amount: '$76.01', amountCents: 7_601, invoiceId: `HMS-GATE-${o.runId}-A-R`, orderId: o.orderId, refundOk: false };
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
  const last = Math.max(...state.datedHolds.map((h) => reauthFrom(h)));
  setGate(state, 'G10', 'waiting', `${state.datedHolds.length} dated hold(s) authorized; reauthorize all on or after ${fmtBoth(last)}`, state.datedHolds.map((h) => `${h.label}: ${h.authorizationId} ${usd(h.amountCents)}, from ${fmtBoth(reauthFrom(h))}`));
}

const STEPS = { A: stepsA, B: stepsB, C: stepsC, D1: stepsD, D2: stepsD };

async function payoutGate(ctx, runId) {
  const { port, state, settings } = ctx;
  if (!settings.twPayoutEmail) {
    setGate(state, 'G6', 'waiting', 'No payout receiver: set PAYPAL_PAYOUT_EMAIL (npm run keys) or pass --payout-to <label from sandbox-buyers.json>');
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
    state.payout = { batchId: created.batchId, senderBatchId: `HMS-GATE-${runId}-G6`, itemId: item?.itemId ?? null, status, amountCents: 100 };
    const evidence = [`batch ${created.batchId}`, `item ${item?.itemId ?? '-'} ${status}`];
    if (status === 'SUCCESS') setGate(state, 'G6', 'pass', 'Payout by email to the payout receiver sandbox account: SUCCESS', evidence);
    else if (status === 'UNCLAIMED') setGate(state, 'G6', 'partial', 'UNCLAIMED: the receiver account must accept it (or the email has no sandbox account)', evidence);
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
      console.log(`  ${h.label}: day ${day}, too early. Reauthorize on or after ${fmtBoth(reauthFrom(h))}.`);
      continue;
    }
    try {
      const r = await port.reauthorize(h.authorizationId, { requestId: `gate:${h.runId}:${h.label}:reauth${h.renewals.length + 1}`, amountCents: h.amountCents });
      h.renewals.push({ ok: true, at: now, day, authorizationId: r.authorizationId, status: r.status, expiresAt: r.expiresAt, debugId: r.debugId });
      console.log(`  ${h.label}: day ${day}, new authorization ${r.authorizationId} ${r.status}, valid until ${fmt(r.expiresAt)}.`);
      // --probe-second (D2 only): may the original be reauthorized again? PayPal's REAUTHORIZATION_TOO_SOON text
      // says "only allowed once from Day 4 to Day 29"; D-52 renews from the original every time.
      if (args['probe-second'] && h.label === 'D2') {
        try {
          const r2 = await port.reauthorize(h.authorizationId, { requestId: `gate:${h.runId}:${h.label}:reauth-second`, amountCents: h.amountCents });
          h.secondReauthorization = { ok: true, at: Date.now(), authorizationId: r2.authorizationId, status: r2.status };
          console.log(`  ${h.label}: a second reauthorization of the original was accepted: ${r2.authorizationId} ${r2.status}.`);
        } catch (e2) {
          h.secondReauthorization = { ok: false, at: Date.now(), error: errText(e2) };
          console.log(`  ${h.label}: a second reauthorization of the original was refused: ${errText(e2)}`);
        }
      }
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

/** disputes --open-as-buyer: the sandbox buyer reports "item not received" on the gate's capture. */
async function openDisputeAsBuyer(ctx, args) {
  const { state } = ctx;
  const t = state.disputeTarget;
  if (!t) {
    console.log('  No dispute target yet: `run` makes one (order A).');
    return;
  }
  if (t.openedAt) {
    console.log(`  The buyer already reported the ${t.amount} payment on ${fmt(t.openedAt)}.`);
    return;
  }
  const amountCents = t.amountCents ?? Math.round(Number(String(t.amount).replace(/[^0-9.]/g, '')) * 100);
  const { openSandboxBuyer, ApprovalBlocked } = await import('./lib/sandbox-buyer.mjs');
  const shotDir = args.shots ? path.resolve(args.shots) : path.join(os.tmpdir(), 'holdmyspot-sandbox-shots');
  console.log(`  Opening an "item not received" dispute on the ${t.amount} payment as the sandbox buyer (${args.headed ? 'visible' : 'headless'} browser)`);
  const buyer = await openSandboxBuyer({ secretsDir: secretsDirFrom(args), headless: !args.headed, shotDir, log: (line) => console.log(`    ${line}`) });
  try {
    const r = await buyer.openDispute({ amountCents, note: `The parcel never arrived. HoldMySpot sandbox gate G7 (invoice ${t.invoiceId}).` });
    t.openedAt = Date.now();
    t.buyerTransactionId = r.transactionId;
    t.caseId = r.caseId;
    console.log(`  ${r.submitted ? 'Submitted' : 'Already open'}: buyer transaction ${r.transactionId ?? '-'}${r.caseId ? `, case ${r.caseId}` : ''}.`);
  } catch (e) {
    if (e instanceof ApprovalBlocked) state.blocked = { at: Date.now(), reason: e.reason, order: 'dispute' };
    console.log(`  ${e instanceof ApprovalBlocked ? '[BLOCKED] ' : ''}The buyer could not open the dispute: ${e.message}`);
  } finally {
    await buyer.close();
  }
}

async function disputeGate(ctx, args) {
  const { port, state } = ctx;
  if (args['open-as-buyer'] && ctx.mode === 'sandbox') await openDisputeAsBuyer(ctx, args);
  const since = Math.min(ctx.clock.now() - 30 * DAY, ...state.runs.map((r) => r.at - 60 * 60 * 1000));
  const disputes = await port.listDisputes(since);
  if (disputes.length === 0) {
    console.log('  No dispute on an HMS- payment yet. PayPal can take a few minutes to list a new dispute.');
    const t = state.disputeTarget;
    if (t?.openedAt) {
      setGate(state, 'G7', 'waiting', `Refund COMPLETED; the buyer opened a dispute on ${fmtBoth(t.openedAt)}; PayPal's dispute API does not list it yet (run \`disputes\` again)`, [
        `capture ${t.captureId}`,
        `buyer transaction ${t.buyerTransactionId ?? '-'}`,
      ]);
    }
    return;
  }
  for (const d of disputes) console.log(`  ${d.disputeId}: ${d.status}${d.outcome ? ` (${d.outcome})` : ''}, ${d.reason}, ${usd(d.amountCents)}, invoices ${d.invoiceIds.join(', ')}`);
  const open = disputes.filter((d) => d.status !== 'RESOLVED');
  const target = args.settle ? disputes.find((d) => d.disputeId === args.settle) : open.length === 1 ? open[0] : null;
  if (!target) {
    if (open.length > 1) console.log('  More than one open dispute: pick one with --settle <id>.');
    const resolved = disputes.find((d) => d.status === 'RESOLVED');
    if (resolved && state.disputeTarget?.refundOk) {
      const t = state.disputeTarget;
      const how = [
        t.openedAt ? `opened by the sandbox buyer in the Resolution Center ${fmtBoth(t.openedAt)}` : null,
        t.adjudicated ? `adjudicate ${t.adjudicated.outcome} accepted ${fmtBoth(t.adjudicated.at)}` : null,
      ].filter(Boolean);
      setGate(state, 'G7', 'pass', `Refund COMPLETED earlier; dispute ${resolved.disputeId} RESOLVED (${resolved.outcome ?? 'no outcome'})${how.length ? `: ${how.join(', ')}` : ''}`, [
        resolved.disputeId,
        ...resolved.captureIds.map((c) => `capture ${c}`),
        ...resolved.invoiceIds.map((i) => `invoice ${i}`),
      ]);
    }
    else if (state.disputeTarget?.openedAt) setGate(state, 'G7', 'waiting', `Refund COMPLETED; the buyer opened a dispute on ${fmtBoth(state.disputeTarget.openedAt)}; PayPal's API does not list it yet`, [`capture ${state.disputeTarget.captureId}`, `buyer transaction ${state.disputeTarget.buyerTransactionId ?? '-'}`]);
    return;
  }
  let d = target;
  let refused = null;
  if (d.status !== 'UNDER_REVIEW' && d.status !== 'RESOLVED') {
    try {
      d = await port.escalateDispute(d.disputeId, 'HoldMySpot sandbox gate: escalating to a claim so it can be settled.');
      console.log(`  Escalated ${d.disputeId}: now ${d.status}.`);
    } catch (e) {
      console.log(`  Escalate refused: ${errText(e)}`);
    }
  }
  const t = state.disputeTarget && state.disputeTarget.captureId && d.captureIds.includes(state.disputeTarget.captureId) ? state.disputeTarget : null;
  if (d.status === 'UNDER_REVIEW' && t?.adjudicated && !args.again) {
    // PayPal accepts adjudicate with 200 and resolves the dispute later (11-07): never send it twice.
    console.log(`  ${d.disputeId}: adjudicate (${t.adjudicated.outcome}) was accepted on ${fmtBoth(t.adjudicated.at)}; PayPal has not resolved it yet.`);
  } else if (d.status === 'UNDER_REVIEW') {
    const outcome = args.outcome === 'buyer' ? 'BUYER_FAVOR' : 'SELLER_FAVOR';
    try {
      d = await port.adjudicate(d.disputeId, outcome);
      if (t) t.adjudicated = { at: ctx.clock.now(), outcome };
      console.log(`  Adjudicated ${d.disputeId} ${outcome}: accepted; now ${d.status}${d.outcome ? ` (${d.outcome})` : ''}.`);
    } catch (e) {
      refused = errText(e);
      console.log(`  Adjudicate refused: ${refused}`);
      if (state.disputeTarget) state.disputeTarget.adjudicateRefused = { at: ctx.clock.now(), error: refused };
    }
  } else if (d.status !== 'RESOLVED') {
    console.log(`  ${d.disputeId} is ${d.status}; PayPal has not moved it to UNDER_REVIEW yet. Run this again in a few minutes.`);
  }
  const refund = state.disputeTarget?.refundOk ? 'Refund COMPLETED earlier; ' : '';
  const opened = state.disputeTarget?.openedAt ? `opened by the sandbox buyer in the Resolution Center ${fmtBoth(state.disputeTarget.openedAt)}, ` : '';
  if (d.status === 'RESOLVED') setGate(state, 'G7', state.disputeTarget?.refundOk ? 'pass' : 'partial', `${refund}dispute ${d.disputeId} RESOLVED (${d.outcome ?? 'no outcome'}) with the sandbox adjudicate call`, [d.disputeId, ...d.captureIds.map((c) => `capture ${c}`)]);
  else {
    const adjudicated = t?.adjudicated ? `; adjudicate ${t.adjudicated.outcome} accepted ${fmtBoth(t.adjudicated.at)}, PayPal resolves it later (run \`disputes\` again)` : '';
    setGate(state, 'G7', 'partial', `${refund}dispute ${d.disputeId} ${opened}listed by the API, ${d.status} ${d.reason}${adjudicated}${refused ? `; adjudicate refused (${refused.replace(/ \(HTTP.*$/, '')})` : ''}`, [
      d.disputeId,
      ...d.captureIds.map((c) => `capture ${c}`),
      ...d.invoiceIds.map((i) => `invoice ${i}`),
    ]);
  }
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

/**
 * --auto-approve: approves each waiting order in a browser as the sandbox buyer
 * (scripts/lib/sandbox-buyer.mjs). Stops at the first challenge; the rest wait for the owner.
 */
async function autoApprove(ctx, args, pending, hinted) {
  const { openSandboxBuyer, ApprovalBlocked } = await import('./lib/sandbox-buyer.mjs');
  const shotDir = args.shots ? path.resolve(args.shots) : path.join(os.tmpdir(), 'holdmyspot-sandbox-shots');
  console.log(`\nApproving ${pending.length} order(s) as the sandbox buyer in a ${args.headed ? 'visible' : 'headless'} browser`);
  let buyer;
  try {
    buyer = await openSandboxBuyer({ secretsDir: secretsDirFrom(args), headless: !args.headed, shotDir, log: (line) => console.log(`    ${line}`) });
  } catch (e) {
    console.log(`  The buyer browser did not start (${e.message}). Approve the links by hand.`);
    return;
  }
  try {
    for (const o of pending) {
      if (!o.approveUrl || !o.returnUrl) {
        console.log(`  ${o.label}: no approval link or return URL saved; approve it by hand.`);
        continue;
      }
      try {
        await buyer.approve(o.approveUrl, { returnUrl: o.returnUrl, cancelUrl: o.cancelUrl, label: `order ${o.label}` });
        hinted.add(o.label);
      } catch (e) {
        if (e instanceof ApprovalBlocked) {
          ctx.state.blocked = { at: Date.now(), reason: e.reason, order: o.label };
          console.log(`  [BLOCKED] order ${o.label}: ${e.message}`);
          console.log('  Stopped the automated approvals; the remaining links wait for the owner.');
          return;
        }
        console.log(`  ${o.label}: automated approval failed: ${e.message}`);
      }
    }
  } finally {
    await buyer.close();
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
      `\nThis creates up to ${labels.length} sandbox order(s) for the owner to approve${wanted('G6') ? ' and one $1.00 sandbox payout' : ''} on app ${mask(ctx.settings.clientId)}. Continue? [y/N] `,
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
      const o = {
        label,
        runId,
        orderId: created.orderId,
        approveUrl: created.approveUrl,
        returnUrl: `${returnBase}/return?label=${label}`,
        cancelUrl: `${returnBase}/cancel?label=${label}`,
        createdAt: Date.now(),
        status: 'awaiting_approval',
        what: plan.what,
        pickup,
        pickupError,
      };
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
      if (args['auto-approve']) await autoApprove(ctx, args, pending, hinted);
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
      // Timed like the sandbox on 11-07: adjudicate is offered about 20 minutes after the claim opens and
      // PayPal resolves the dispute about 3 minutes after accepting it.
      console.log('\nFake buyer opens a dispute; 21 minutes later adjudicate, 4 minutes later read it back (G7)');
      ctx.port.openDispute(state.disputeTarget.captureId);
      state.disputeTarget.openedAt = ctx.clock.now();
      ctx.clock.advance(21 * 60_000);
      await disputeGate(ctx, args);
      ctx.clock.advance(4 * 60_000);
      await disputeGate(ctx, args);
    }
  }
}

/**
 * `probe`: records PayPal's real answers to the edge cases server/src/paypal/emulator.ts copies
 * (over-capture limit, early reauthorization, idempotent replays, duplicate invoice ids, calls on
 * closed holds, refund limits, duplicate trackers, cancelling a paid payout item). Needs gate run A
 * to have run (it reuses its closed holds) and one new $10.00 hold E (auto-approved).
 */
async function cmdProbe(ctx, args, runId) {
  const { port, state } = ctx;
  const answers = [];
  const note = async (what, fn) => {
    try {
      const v = await fn();
      answers.push({ what, ok: true, answer: v });
      console.log(`  ${what}: OK ${v}`);
    } catch (e) {
      const answer = e && e.code ? `${e.code} ${[e.paypalName, e.issue].filter(Boolean).join('/')} (HTTP ${e.httpStatus ?? '-'})` : String(e?.message ?? e);
      answers.push({ what, ok: false, answer });
      console.log(`  ${what}: refused ${answer}`);
    }
  };
  const A = state.orders.A;
  const B = state.orders.B;
  const C = state.orders.C;
  if (!A?.authorizationId || !B?.authorizationId || !C?.authorizationId) {
    console.log('  Run `run` first: the probe reuses the closed holds of orders A, B and C.');
    return;
  }
  // Calls on closed or finished objects (no money moves).
  await note('void a CAPTURED authorization (B)', async () => (await port.voidAuthorization(B.authorizationId, `probe:${runId}:void-captured`)).status);
  await note('capture on a VOIDED authorization (C)', async () => (await port.captureAuthorization(C.authorizationId, captureInput({ runId, label: 'C' }, `probe-${runId}-cap-voided`, 100, true, 'PV'))).status);
  await note('authorize an order a second time (A, new request id; PayPal answers 422 ORDER_ALREADY_AUTHORIZED and the client reads the order)', async () => `the existing authorization ${(await port.authorizeOrder(A.orderId, `probe:${runId}:A:auth-again`)).authorizationId}`);
  const orderA = await port.getOrder(A.orderId);
  const capA = orderA.captures[0]?.captureId;
  const capB = (await port.getOrder(B.orderId)).captures[0]?.captureId;
  if (capA && capB) {
    await note('refund more than is left on a capture (B, $12.01 of $12.00)', async () => (await port.refundCapture(capB, { requestId: `probe:${runId}:refund-over`, amountCents: 1_201, invoiceId: `HMS-GATE-${runId}-B-F9`, noteToPayer: 'probe' })).status);
    const tracked = orderA.trackers[0];
    if (tracked) {
      await note('add the same tracker again (A, new request id)', async () => {
        await port.addTracking(A.orderId, { requestId: `probe:${runId}:A:track-again`, captureId: tracked.captureId ?? capA, trackingNumber: tracked.trackingNumber, carrierName: 'Harbor Air Parcel', notifyPayer: false });
        return 'accepted again with HTTP 200 (no second tracker)';
      });
    }
    await note("tracking with another order's capture (A with B's capture)", async () => {
      await port.addTracking(A.orderId, { requestId: `probe:${runId}:A:track-foreign`, captureId: capB, trackingNumber: `HMSPROBE${runId.replace('-', '')}`, carrierName: 'Harbor Air Parcel', notifyPayer: false });
      return 'accepted';
    });
  }
  if (state.payout?.itemId) await note('cancel a payout item that is SUCCESS (G6)', async () => (await port.cancelUnclaimedPayoutItem(state.payout.itemId)).status);
  if (state.payout?.batchId && state.payout.senderBatchId) {
    // The client sends sender_batch_id as the PayPal-Request-Id too (D-53): a resend must come back as the first batch.
    await note('send the G6 payout again (same sender_batch_id, same request id)', async () => {
      const again = await port.createPayout({
        senderBatchId: state.payout.senderBatchId,
        emailSubject: 'HoldMySpot sandbox gate payout',
        emailMessage: 'A repeat of the G6 batch id; PayPal should refuse it.',
        items: [{ receiverEmail: ctx.settings.twPayoutEmail, amountCents: 100, note: 'HoldMySpot sandbox gate G6 repeat', senderItemId: `G6-${runId}-again` }],
      });
      return again.batchId === state.payout.batchId ? `the first batch ${again.batchId} (no second payout)` : `A NEW BATCH ${again.batchId}`;
    });
  }

  // A new $10.00 hold for the money edge cases.
  let server = null;
  try {
    server = await startReturnServer(() => {});
    const returnBase = `http://127.0.0.1:${server.address().port}`;
    const created = await port.createOrder(orderInput('E', runId, returnBase, false));
    const o = { label: 'E', runId, orderId: created.orderId, approveUrl: created.approveUrl, returnUrl: `${returnBase}/return?label=E`, cancelUrl: `${returnBase}/cancel?label=E` };
    console.log(`  E: order ${o.orderId}; approving as the sandbox buyer`);
    const hinted = new Set();
    await autoApprove(ctx, args, [o], hinted);
    if (!hinted.has('E')) throw new Error('order E was not approved');
    const auth = await port.authorizeOrder(o.orderId, `gate:${runId}:E:auth`);
    state.orders.E = { ...o, status: 'authorized', authorizationId: auth.authorizationId, createdAt: Date.now(), what: ORDER_PLANS.E.what };
    console.log(`  E: authorization ${auth.authorizationId} ${usd(auth.amountCents)}`);
    const cap = (step, cents, final, suffix) => port.captureAuthorization(auth.authorizationId, captureInput(o, step, cents, final, suffix));
    await note('reauthorize on day 1 (inside the honor period)', async () => {
      const r = await port.reauthorize(auth.authorizationId, { requestId: `probe:${runId}:E:reauth-early`, amountCents: 1_000 });
      return `new authorization ${r.authorizationId} ${r.status}`;
    });
    await note('capture $11.51 of $10.00 (115.1%)', async () => (await cap('cap-over', 1_151, false, 'X1')).status);
    let first = null;
    await note('capture $5.00 (not final)', async () => {
      first = await cap('cap1', 500, false, 'R');
      return `${first.captureId} ${first.status}`;
    });
    await note('same PayPal-Request-Id again', async () => {
      const again = await cap('cap1', 500, false, 'R');
      return `${again.captureId}${first && again.captureId === first.captureId ? ' (the first capture)' : ' (A NEW CAPTURE)'}`;
    });
    await note('reuse the captured invoice id under a new request id ($1.00)', async () => {
      const r = await port.captureAuthorization(auth.authorizationId, { ...captureInput(o, 'cap-dup-invoice', 100, false, 'R'), invoiceId: `HMS-GATE-${runId}-E-R` });
      return `${r.captureId} ${r.status}`;
    });
    await note('capture $6.51 more (total over 115%)', async () => (await cap('cap-over2', 651, false, 'X2')).status);
    await note('final capture up to exactly 115% ($11.50 in all)', async () => {
      const a = await port.getAuthorization(auth.authorizationId);
      const o2 = await port.getOrder(o.orderId);
      const taken = o2.captures.filter((c) => c.status === 'COMPLETED').reduce((sum, c) => sum + c.amountCents, 0);
      const r = await cap('cap-final', 1_150 - taken, true, 'S');
      return `${r.captureId} ${usd(r.amountCents)} ${r.status}; authorization was ${a.status}`;
    });
    await note('authorization after the final capture', async () => (await port.getAuthorization(auth.authorizationId)).status);
    await note('void after the final capture', async () => (await port.voidAuthorization(auth.authorizationId, `probe:${runId}:E:void`)).status);
  } catch (e) {
    console.log(`  E: stopped: ${errText(e)}`);
  } finally {
    if (server) server.close();
  }
  state.probe = { at: Date.now(), runId, answers };
}

async function cmdLifecycle(ctx, args) {
  const { runLifecycle } = await import('./lib/sandbox-lifecycle.mjs');
  const secretsDir = secretsDirFrom(args);
  let payoutEmail = null;
  let payoutLabel = null;
  if (!ctx.settings.twPayoutEmail && args['payout-to']) {
    const { loadPayoutReceiver } = await import('./lib/sandbox-buyer.mjs');
    const r = loadPayoutReceiver(secretsDir, args['payout-to']);
    payoutEmail = r.email;
    payoutLabel = r.label;
  }
  const shotDir = args.shots ? path.resolve(args.shots) : path.join(os.tmpdir(), 'holdmyspot-sandbox-shots');
  console.log('\nFull job through the server on the PayPal sandbox');
  const started = Date.now();
  try {
    const r = await runLifecycle({
      pp,
      port: ctx.port,
      settings: ctx.settings,
      secretsDir,
      payoutLabel,
      payoutEmail,
      headless: !args.headed,
      shotDir,
      keep: Boolean(args.keep),
      serverPort: Number(args.port ?? 8798),
      // --by-hand (or --open): print PayPal's link and wait while the person approves it; no stored password (D-129).
      byHand: Boolean(args['by-hand'] || args.open),
      openLink: args.open ? openInBrowser : null,
      waitMinutes: Number(args.wait),
      log: (line) => console.log(line),
    });
    ctx.state.lifecycle = { at: started, ok: r.ok, ai: r.ai ? `${r.ai.provider}/${r.ai.model} ${r.ai.mode}` : null, ids: r.ids, checks: r.checks, ledger: r.server.ledger.map((e) => ({ kind: e.kind, cents: e.cents, status: e.status })), paypal: r.paypal, payouts: r.server.payouts.map((p) => ({ purpose: p.purpose, cents: p.cents, status: p.status, batchId: p.batchId, itemId: p.itemId })) };
    console.log(`\nLifecycle ${r.ok ? 'PASSED: PayPal matches the ledger' : 'FAILED: see the mismatches above'}.${r.ok ? '' : ` Temporary files kept in ${r.tmp}.`}`);
  } catch (e) {
    ctx.state.lifecycle = { at: started, ok: false, error: errText(e), ids: {}, checks: [] };
    console.log(`\nLifecycle stopped: ${errText(e)}`);
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
      if (state.payout.status === 'SUCCESS') setGate(state, 'G6', 'pass', 'Payout by email to the payout receiver sandbox account: SUCCESS', [`batch ${b.batchId}`, `item ${item?.itemId ?? '-'}`]);
    } catch (e) {
      console.log(`  Payout: ${errText(e)}`);
    }
  }
  for (const h of state.datedHolds) {
    try {
      const a = await port.getAuthorization(h.authorizationId);
      console.log(`  Dated hold ${h.label} ${h.authorizationId}: ${a.status}, day ${Math.floor((Date.now() - h.createdAt) / DAY) + 1}, reauthorize from ${fmtBoth(reauthFrom(h))}`);
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
        'auto-approve': { type: 'boolean' },
        headed: { type: 'boolean' },
        shots: { type: 'string' },
        'payout-to': { type: 'string' },
        'open-as-buyer': { type: 'boolean' },
        yes: { type: 'boolean' },
        'no-record': { type: 'boolean' },
        'force-early': { type: 'boolean' },
        'probe-second': { type: 'boolean' },
        again: { type: 'boolean' },
        settle: { type: 'string' },
        outcome: { type: 'string' },
        note: { type: 'string' },
        verbose: { type: 'boolean' },
        dir: { type: 'string' },
        port: { type: 'string' },
        keep: { type: 'boolean' },
        'by-hand': { type: 'boolean' },
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
  if (!['plan', 'run', 'reauthorize', 'disputes', 'status', 'lifecycle', 'probe', 'record'].includes(command)) {
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

  const record = ['run', 'lifecycle', 'probe', 'disputes', 'reauthorize', 'status'].includes(command) && !args['no-record'] && !args.fake ? (command === 'run' ? runId : `${runId}-${command}`) : null;
  if ((command === 'lifecycle' || command === 'probe') && args.fake) {
    console.error(`${command} runs on the real sandbox only (the offline tests cover fake mode).`);
    return 1;
  }
  const conn = await connect(args, runId, record);
  const state = conn.stateFile ? loadState(conn.stateFile) : emptyState();
  // Masked client ID only: no account emails in the state file or on the page.
  state.app = { clientId: mask(conn.settings.clientId) };
  const ctx = { ...conn, state };
  console.log(`\nHoldMySpot sandbox gates: ${command} (${conn.mode}, run ${runId}, app ${mask(conn.settings.clientId)})`);

  try {
    if (command === 'run') await cmdRun(args, ctx, runId);
    else if (command === 'reauthorize') await reauthorizeHolds(ctx, args);
    else if (command === 'disputes') await disputeGate(ctx, args);
    else if (command === 'status') await cmdStatus(ctx);
    else if (command === 'lifecycle') await cmdLifecycle(ctx, args);
    else if (command === 'probe') await cmdProbe(ctx, args, runId);
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
  if (record && fs.existsSync(path.join(RECORD_DIR, record))) console.log(`Sanitized responses: ${path.join(RECORD_DIR, record)} (checked by server/test/paypal/recorded.test.ts)`);
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
