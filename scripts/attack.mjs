#!/usr/bin/env node
// npm run attack: tries to cheat HoldMySpot the way a judge would, with no keys, and prints one table:
// each attempt, the layer that stopped it (the rules, the AI's reading checked by the rules, a person,
// the server's state machine, or PayPal's own limits on the emulator) and the money it moved
// (docs/DECISIONS.md D-137 to D-139, D-147 to D-149). The layer follows from the answer: a receipt's
// failed checks (server/src/ai/basis.ts, as in the ablation), or the refusal code (LAYER_OF_CODE in
// server/src/demo/attack.ts). Two rows are known limits that no layer stops; they run so the table
// shows what they move.
//
//   npm run attack                        starts its own zero-key server (simulated PayPal, recorded AI
//                                         answers, an empty secrets folder), attacks it and stops it
//   npm run attack -- --reuse             attacks the demo already running (npm run demo) instead; its
//                                         market is reset before each part, and the last part stays
//   npm run attack -- --json report.json  also writes the report as JSON
//   npm run attack -- --ci                plain output (no colour, no progress); server/test/attack.test.ts
//
// Exit 0 when every attempt moved exactly what the shared money rules say: $0.00 when refused, the
// genuine receipt's amount for the control, shipping capped at the requester's budget, and for the two
// known limits the amount the rules compute from what they were shown (a reprinted price, capped at the
// requester's cap; a check-in moves nothing). Exit 1 when any attempt moved anything else, or an attempt
// that must be refused was not.
//
// The fake receipts are the rendered photos in server/fixtures/proofs, read by the recorded answers of a
// real model, each on a fresh demo market (D-138). The last three rows go straight to the PayPal emulator
// in this process, skipping HoldMySpot, to show PayPal's own limits (D-139). Nothing secret is read or
// printed: the server this starts gets an empty secrets folder, and --reuse refuses a server that runs
// the real PayPal sandbox or a live AI model.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { AI_KEY_NAMES, DEFAULT_PORTS, REPO, gitState, packageStatus, requireNode, resolvePorts, serverDemoEnv } from './common.mjs';

const USAGE = `Try to cheat HoldMySpot: fake receipts and money tricks against a zero-key server, one table.

  npm run attack [-- options]

Options:
  --reuse                 attack the demo already running (npm run demo) instead of starting a server;
                          its market is reset before each part and the last part stays to look at
  --port-offset <n>       with --reuse: the same flag as npm run demo (server port ${DEFAULT_PORTS.server} + n);
                          otherwise the port of the server this starts (default: any free port)
  --server-port <p>       the server's port, instead of --port-offset
  --only <parts>          receipts, money, limits and/or paypal (comma-separated); default all four
  --json <file>           also write the report as JSON
  --ci                    plain output: no colour, no progress lines
  --verbose               print the server's or PayPal's full answer under the table
  -h, --help

Exit 0 when every attempt moved exactly what the shared money rules say ($0.00 when refused); 1 when
any attempt moved anything else, an attempt that must be refused was not, or the run could not finish.
`;

let useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');

const MARKET_DAY = '2026-11-12';
const ZONE = 'America/Los_Angeles';
const DAY_MS = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const MONEY_KEYS = ['captured', 'refunded', 'paidOut', 'held'];
const ZERO = Object.freeze({ captured: 0, refunded: 0, paidOut: 0, held: 0 });

class SetupError extends Error {}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** JSON in and out; never throws on an HTTP error, so refusals can be read. */
function httpClient(base) {
  return async function api(method, route, { as, body, bytes, idem } = {}) {
    const headers = {};
    if (as) headers['x-hms-user'] = as;
    if (idem) headers['idempotency-key'] = idem;
    let payload;
    if (bytes) {
      headers['content-type'] = 'image/png';
      payload = bytes;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}${route}`, { method, headers, body: payload, signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return {
      ok: res.ok,
      status: res.status,
      json,
      replayed: res.headers.get('idempotent-replay') === 'true',
      code: res.ok ? null : (json?.error?.code ?? `HTTP_${res.status}`),
      message: res.ok ? null : (json?.error?.message ?? String(text).slice(0, 200)),
    };
  };
}

/** A setup step must succeed; its failure stops the run (it is not an attempt). */
function must(r, what) {
  if (!r.ok) throw new SetupError(`${what} answered ${r.status} ${r.code}: ${r.message}`);
  return r.json;
}

async function waitFor(what, fn, timeoutMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new SetupError(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}`);
    await sleep(80);
  }
}

// ---------------------------------------------------------------------------
// The server: started here (zero keys) or the running demo (--reuse)
// ---------------------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function portTaken(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(700, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** The environment of `npm run demo`'s server, without a single key: no HMS_*, PAYPAL_* or AI key from the shell. */
function zeroKeyEnv(port, tmp) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('HMS_') || k.startsWith('PAYPAL_') || AI_KEY_NAMES.includes(k)) continue;
    env[k] = v;
  }
  const noKeys = path.join(tmp, 'no-keys');
  fs.mkdirSync(noKeys, { recursive: true, mode: 0o700 });
  return {
    ...env,
    ...serverDemoEnv(),
    HMS_MODE: 'fake',
    HMS_AI_MODE: 'replay',
    HMS_HOST: '127.0.0.1',
    HMS_PORT: String(port),
    HMS_DB_PATH: path.join(tmp, 'market.sqlite'),
    HMS_UPLOAD_DIR: path.join(tmp, 'uploads'),
    // An empty secrets folder, and no key files from server/.env.local: the run cannot find a key.
    HMS_SECRETS_DIR: noKeys,
    HMS_AI_KEY_FILES: '',
    HMS_LOG_LEVEL: 'warn',
  };
}

async function startServer(port) {
  if (await portTaken(port)) throw new SetupError(`port ${port} is taken. Pick another (--port-offset or --server-port), or attack that server with --reuse.`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hms-attack-'));
  const logFile = path.join(tmp, 'server.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, ['src/main.ts'], { cwd: path.join(REPO, 'server'), env: zeroKeyEnv(port, tmp), stdio: ['ignore', out, out] });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const server = {
    child,
    tmp,
    logFile,
    base: `http://127.0.0.1:${port}`,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const r = await Promise.race([exited, sleep(8000).then(() => null)]);
        if (r === null) child.kill('SIGKILL');
      }
      try {
        fs.closeSync(out);
      } catch {
        // already closed
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
    tail() {
      try {
        return fs.readFileSync(logFile, 'utf8').trimEnd().split('\n').slice(-20).map((l) => `    ${l}`).join('\n');
      } catch {
        return '    (no log)';
      }
    },
  };
  const api = httpClient(server.base);
  try {
    await waitFor('the server to answer', async () => {
      if (child.exitCode !== null) throw new SetupError(`the server exited (code ${child.exitCode}):\n${server.tail()}`);
      try {
        return (await api('GET', '/api/health')).json?.ok === true;
      } catch {
        return false;
      }
    });
  } catch (err) {
    await server.stop();
    throw err;
  }
  return server;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function sumMoney(ledger, filter = () => true) {
  const sum = (kind) => ledger.filter((e) => e.kind === kind && e.status === 'succeeded' && filter(e)).reduce((s, e) => s + e.amount.cents, 0);
  return { captured: sum('captured'), refunded: sum('refunded'), paidOut: sum('paid_out'), held: sum('held') };
}

function diffMoney(after, before) {
  return Object.fromEntries(MONEY_KEYS.map((k) => [k, after[k] - before[k]]));
}

/** What an attempt is meant to do: be refused, move the control's money, be capped, or show a known limit. */
const OUTCOME_NOTE = { intended: 'intended', capped: 'capped', known_limit: 'known limit' };

function movedText(m, note) {
  const parts = [];
  if (m.held) parts.push(`${usd(m.held)} held`);
  if (m.captured) parts.push(`${usd(m.captured)} charged`);
  if (m.refunded) parts.push(`${usd(m.refunded)} refunded`);
  if (m.paidOut) parts.push(`${usd(m.paidOut)} paid out`);
  const text = parts.length === 0 ? '$0.00' : parts.join(', ');
  return note ? `${text} (${note})` : text;
}

/**
 * Checks a finished attempt. `ok` (the exit code) is about money and refusal: the attempt moved
 * exactly what it should, and an attempt that must be refused was. `asExpected` also checks the
 * layer and the code that stopped it, which the CI test asserts.
 */
function judge(spec, out) {
  const moneyOk = MONEY_KEYS.every((k) => out.moved[k] === (spec.expect[k] ?? 0)) && !out.newPending;
  const refusalOk = spec.mustRefuse ? out.refused : !out.refused;
  const ok = moneyOk && refusalOk;
  const notes = [];
  if (!moneyOk) notes.push(`moved ${movedText(out.moved, null)}${out.newPending ? ' (and left money in flight)' : ''}, expected ${movedText({ ...ZERO, ...spec.expect }, null)}`);
  if (!refusalOk) notes.push(spec.mustRefuse ? 'NOT STOPPED' : 'refused, but it should have gone through');
  const codeOk = spec.expectCode === undefined || out.code === spec.expectCode;
  const layerOk = out.layer === spec.expectLayer;
  if (!codeOk) notes.push(`answered ${out.code}, expected ${spec.expectCode}`);
  if (!layerOk) notes.push(`stopped by ${out.layer}, expected ${spec.expectLayer}`);
  return { ok, asExpected: ok && codeOk && layerOk, notes };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parse() {
  try {
    const { values } = parseArgs({
      options: {
        reuse: { type: 'boolean' },
        'port-offset': { type: 'string' },
        'server-port': { type: 'string' },
        'web-port': { type: 'string' },
        'ops-port': { type: 'string' },
        only: { type: 'string' },
        json: { type: 'string' },
        ci: { type: 'boolean' },
        verbose: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    });
    return values;
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
}


async function main() {
  const args = parse();
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.ci) useColor = false;
  const PARTS = ['receipts', 'money', 'limits', 'paypal'];
  const parts = new Set((args.only ?? PARTS.join(',')).split(',').map((s) => s.trim()).filter(Boolean));
  if (parts.size === 0 || [...parts].some((p) => !PARTS.includes(p))) {
    console.error(`--only takes ${PARTS.join(', ')} (comma-separated).\n\n${USAGE}`);
    return 2;
  }
  requireNode();
  const progress = (line) => {
    if (!args.ci) console.log(dim(line));
  };

  const missing = ['shared', 'server'].filter((p) => !packageStatus(p).installed);
  if (missing.length > 0) {
    console.log(yellow(`Packages not installed yet (${missing.join(', ')}): running npm run setup for them first.`));
    const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'setup.mjs'), '--only', missing.join(',')], { stdio: 'inherit' });
    if (r.status !== 0) throw new SetupError('npm run setup failed (see above).');
  }

  const load = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);
  const shared = await load('shared/src/index.ts');
  const { ATTACK_HANDOVER, ATTACK_LIMITS, ATTACK_RECEIPTS, LAYER_OF_CODE } = await load('server/src/demo/attack.ts');
  const { checkBasis } = await load('server/src/ai/basis.ts');
  const { placeholderPng } = await load('server/src/util/images.ts');
  const { createFakePayPal } = await load('server/src/paypal/fake.ts');
  const { HERO, SEED_USERS, askFeeAt, bidLimitCents, distanceMeters, epochToZonedLocal, findShop, jobCaps, travelMinutes, zonedLocalToEpoch, receiptCapture, shippingCapture, payoutsForCapture } = shared;
  const shop = findShop(HERO.shopId);
  const user = (id) => SEED_USERS.find((u) => u.id === id);
  const sf = (hhmm) => zonedLocalToEpoch(`${MARKET_DAY} ${hhmm}`, ZONE);
  const PROOFS = path.join(REPO, 'server', 'fixtures', 'proofs');
  const fixture = (rel) => fs.readFileSync(path.join(PROOFS, rel));
  const caseOf = (id) => JSON.parse(fs.readFileSync(path.join(PROOFS, id, 'case.json'), 'utf8'));
  const run = Date.now().toString(36);

  // ---- the server --------------------------------------------------------------------------
  let server = null;
  let base;
  let ports;
  try {
    ports = resolvePorts(args);
  } catch (err) {
    throw new SetupError(err.message);
  }
  const portGiven = args['port-offset'] !== undefined || args['server-port'] !== undefined;
  const startedAt = new Date();
  // The PayPal part alone needs no server.
  const needServer = parts.has('receipts') || parts.has('money') || parts.has('limits');
  if (args.reuse || !needServer) {
    base = needServer ? `http://127.0.0.1:${ports.server}` : null;
  } else {
    const port = portGiven ? ports.server : await freePort();
    progress(`Starting a zero-key server on port ${port}...`);
    server = await startServer(port);
    base = server.base;
  }
  const stopServer = async () => {
    if (server) await server.stop();
    server = null;
  };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      void stopServer().finally(() => process.exit(130));
    });
  }

  const api = httpClient(base);
  try {
    let config = null;
    if (base) {
      const health = await api('GET', '/api/health').catch(() => null);
      if (!health?.json?.ok) throw new SetupError(`no HoldMySpot server answers on ${base}. Start one with npm run demo (same port flags), or run npm run attack without --reuse.`);
      config = must(await api('GET', '/api/config'), 'GET /api/config');
      if (config.mode !== 'fake') throw new SetupError(`the server on ${base} runs the real PayPal sandbox; the attack needs the zero-key demo (npm run demo), or run it without --reuse.`);
      if (!config.demo?.enabled) throw new SetupError(`the server on ${base} is not a demo market (HMS_DEMO=1), so its market cannot be reset for the attack.`);
      if (config.ai.mode === 'live' || config.ai.mode === 'record') {
        throw new SetupError(`the server on ${base} reads photos with a live AI model (each receipt would be a paid model call). Start it with npm run demo (recorded answers), or run npm run attack without --reuse.`);
      }
      if (args.reuse) progress(`Attacking the demo on ${base}: its market is reset before each part, and the last part stays.`);
    }

    const records = async () => must(await api('GET', '/api/ops/records', { as: 'ops' }), 'GET /api/ops/records');
    const pendingOf = (rec) => rec.ledger.filter((e) => e.status === 'pending' && e.kind !== 'released').length;
    /** Waits until no photo is being checked and no money call is in flight, then returns the records. */
    const settled = () =>
      waitFor('the market to settle', async () => {
        const rec = await records();
        const busy = rec.proofs.some((p) => p.status === 'verifying') || rec.ledger.some((e) => e.status === 'pending');
        return busy ? null : rec;
      });
    const clock = async (hhmm) => must(await api('POST', '/api/demo/clock', { body: { jumpTo: sf(hhmm), paused: true } }), `move the clock to ${hhmm}`);
    const reset = async () => {
      must(await api('POST', '/api/demo/reset', { body: { scriptId: 'hero', seed: null } }), 'POST /api/demo/reset');
      await settled();
    };

    const rows = [];
    const invariantRuns = [];
    /** Runs one attempt between two money snapshots of the whole market and records its row. */
    const attempt = async (spec, fn) => {
      const before = await settled();
      const out = await fn();
      const after = await settled();
      const moved = diffMoney(sumMoney(after.ledger), sumMoney(before.ledger));
      const row = { ...spec, ...out, moved, newPending: pendingOf(after) > pendingOf(before) };
      Object.assign(row, judge(spec, row));
      rows.push(row);
      progress(`  ${row.ok ? 'ok  ' : 'FAIL'} ${spec.attempt}: ${row.answer}; moved ${movedText(moved, null)}`);
      return row;
    };
    const checkInvariants = async (label) => {
      const rec = await settled();
      const bad = [];
      for (const h of rec.holds) {
        const captured = sumMoney(rec.ledger, (e) => e.holdId === h.id).captured;
        if (captured > h.amount.cents || h.capturedCents > h.amount.cents) bad.push(`hold ${h.id}: captured ${usd(Math.max(captured, h.capturedCents))} of ${usd(h.amount.cents)}`);
      }
      for (const j of rec.jobs) {
        const m = sumMoney(rec.ledger, (e) => e.jobId === j.id);
        if (m.paidOut > m.captured - m.refunded) bad.push(`job ${j.id}: paid out ${usd(m.paidOut)}, charged ${usd(m.captured - m.refunded)}`);
      }
      // The holds a capture was tried on: the seeded crowd's other holds are counted apart, since nothing touched them.
      const tried = rec.holds.filter((h) => rec.ledger.some((e) => e.holdId === h.id && e.kind === 'captured')).length;
      invariantRuns.push({ market: label, holds: tried, holdsInMarket: rec.holds.length, jobs: rec.jobs.length, violations: bad });
    };

    // ---- people and errands ---------------------------------------------------------------------
    const NY = { mode: 'ship', country: 'US', region: 'NY', city: 'New York', postalCode: '10012' };
    const SF = { mode: 'ship', country: 'US', region: 'CA', city: 'San Francisco', postalCode: '94115' };
    const destinationOf = (id) => (user(id).cityId === 'nyc' ? NY : SF);
    let requestSeq = 0;
    const upload = async (as, purpose, bytes, what) => must(await api('POST', `/api/files?purpose=${purpose}`, { as, bytes }), `${as} uploads ${what}`).file;

    /** A Mochi Bunny plush request held by PayPal (quote, create, approve in the simulated sheet, authorize). */
    const placeRequest = async (requesterId, { approve = true, destination = destinationOf(requesterId) } = {}) => {
      const quote = must(await api('POST', '/api/bids/quote', { as: requesterId, body: { shopId: HERO.shopId, itemId: HERO.itemId, qty: 1, destination } }), `${requesterId}'s quote`);
      const created = must(
        await api('POST', '/api/bids', {
          as: requesterId,
          idem: `attack-${run}-${requesterId}-${++requestSeq}`,
          body: {
            shopId: HERO.shopId,
            itemId: HERO.itemId,
            qty: 1,
            retailCapCents: quote.suggested.retailCapCents,
            maxFeeCents: quote.suggested.maxFeeCents,
            shippingBudgetCents: quote.suggested.shippingBudgetCents,
            destination,
            deadlineAt: sf('10:31') + 2 * DAY_MS,
            funding: 'paypal',
            agent: null,
          },
        }),
        `${requesterId}'s request`,
      );
      if (!approve) return { bid: created.bid, hold: created.hold, orderId: created.checkout.orderId };
      must(await api('POST', `/api/fake/paypal/orders/${created.checkout.orderId}/approve`, { as: requesterId, body: { funding: 'paypal', outcome: 'approve' } }), `${requesterId} approves`);
      const auth = must(await api('POST', `/api/bids/${created.bid.id}/authorize`, { as: requesterId, body: { orderId: created.checkout.orderId } }), `${requesterId}'s authorization`);
      return { bid: auth.bid, hold: auth.hold, orderId: created.checkout.orderId };
    };
    /** The requester's open plush request: Priya's seeded one in a demo market with its crowd, else a new one. */
    const openRequest = async (requesterId) => {
      const mine = must(await api('GET', '/api/bids?mine=1', { as: requesterId }), `${requesterId}'s requests`).bids;
      const open = mine.find((b) => b.itemId === HERO.itemId && b.status === 'open');
      return open ? { bid: open } : placeRequest(requesterId);
    };
    const marketNow = async () => must(await api('GET', '/api/clock'), 'GET /api/clock').marketNow;
    const claim = async (queuerId, bidId, checkInAt, mode = 'ship') => {
      const q = user(queuerId);
      const now = await marketNow();
      const travel = travelMinutes(q.home, shop.lngLat);
      const etaAt = Math.max(sf(checkInAt), now + (travel + 1) * 60_000);
      const out = must(
        await api('POST', `/api/bids/${bidId}/claim`, { as: queuerId, body: { qty: 1, etaAt, modes: [mode], from: { lngLat: q.home, accuracyM: 10 } } }),
        `${queuerId} takes ${bidId}`,
      );
      return { claimId: out.claim.id, jobId: out.job.id };
    };
    const lineOf = (queuerId) => fixture(`checkin-paper-moon-${queuerId}/line.png`);
    /** Check-in at the shop with the queuer's rendered line photo, read by the recorded model answer. */
    const checkIn = async (queuerId, claimId, photo) => {
      const file = photo ?? (await upload(queuerId, 'line_photo', lineOf(queuerId), 'a line photo'));
      must(await api('POST', `/api/claims/${claimId}/check-in`, { as: queuerId, body: { lngLat: shop.lngLat, accuracyM: 8, photoFileId: file.id } }), `${queuerId} checks in`);
      await waitFor(`${queuerId}'s line photo check`, async () => {
        const c = must(await api('GET', `/api/claims/${claimId}`, { as: queuerId }), `${queuerId}'s visit`).claim;
        if (c.status === 'checked_in') return true;
        const rec = await records();
        const p = rec.proofs.filter((x) => x.claimId === claimId && x.kind === 'check_in').at(-1);
        if (p && (p.status === 'failed' || p.status === 'needs_review')) throw new SetupError(`${queuerId}'s line photo check ended ${p.status}: ${p.summary}`);
        return false;
      });
    };
    const bought = async (queuerId, jobId) => must(await api('POST', `/api/jobs/${jobId}/bought`, { as: queuerId }), `${queuerId} marks bought`);
    const jobOf = async (jobId) => must(await api('GET', `/api/jobs/${jobId}`, { as: 'ops' }), `job ${jobId}`);
    /**
     * Sends a receipt and an item photo, waits for the verdict, and reads it as an attempt result. The layer
     * follows from the checks that failed, labelled as the ablation labels them (server/src/ai/basis.ts):
     * a failed hard check that uses no reading (photo hash, file metadata, the receipt QR's store ID) is
     * "rules", one that compares what the model read is "AI + rules", and a receipt left for review is
     * "sent to a person". A pass is "-" for the control and "not stopped" for a known limit.
     */
    const sendProof = async (queuerId, jobId, caseId, { passLayer = '-' } = {}) => {
      const receipt = await upload(queuerId, 'receipt', fixture(`${caseId}/receipt.png`), 'a receipt');
      const item = await upload(queuerId, 'item_photo', fixture(`${caseId}/item.png`), 'an item photo');
      const sent = await api('POST', `/api/jobs/${jobId}/proof`, { as: queuerId, body: { receiptFileId: receipt.id, itemFileId: item.id } });
      if (!sent.ok) return { refused: true, code: sent.code, layer: layerOf(sent.code), answer: sent.code, detail: sent.message };
      const proofId = sent.json.proof.id;
      const proof = await waitFor('the receipt check', async () => {
        const p = (await records()).proofs.find((x) => x.id === proofId);
        return p && p.status !== 'verifying' ? p : null;
      });
      const failed = proof.checks.filter((c) => !c.ok);
      const qrStoreId = Boolean(proof.receipt?.qr?.sellerTaxId);
      const hard = failed.filter((c) => c.weight === 'hard');
      const layer =
        proof.status === 'passed'
          ? passLayer
          : proof.status === 'needs_review'
            ? 'sent to a person'
            : hard.some((c) => checkBasis(c.code, qrStoreId).basis === 'code')
              ? 'rules'
              : 'AI + rules';
      const codes = failed.map((c) => c.code);
      return {
        refused: proof.status !== 'passed',
        code: proof.status === 'passed' ? 'passed' : [...codes].sort().join(', '),
        layer,
        answer: proof.status === 'passed' ? 'passed' : `${codes.join(', ')}${proof.status === 'needs_review' ? ' (to a person)' : ''}`,
        detail: proof.status === 'passed' ? proof.summary : `${proof.summary} ${failed.map((c) => c.detail).join(' ')}`.trim(),
        ai: proof.ai,
        proofStatus: proof.status,
      };
    };
    /** The layer that gave a refusal code (LAYER_OF_CODE, server/src/demo/attack.ts). */
    const layerOf = (code) => LAYER_OF_CODE[code] ?? `unknown (${code})`;
    const refusal = (r) => (r.ok ? { refused: false, code: 'accepted', layer: 'nothing', answer: 'ACCEPTED', detail: 'The server accepted it.' } : { refused: true, code: r.code, layer: layerOf(r.code), answer: r.code, detail: r.message });

    // ---- part 1: six fake receipts, one fresh market each (D-138) ---------------------------------
    const RECEIPTS = {
      'paper-moon-recycled-photo': { order: 2, attempt: "Item photo recycled from Lin's job on 11-11", expectLayer: 'rules' },
      'paper-moon-qr-wrong-store': { order: 3, attempt: "Receipt whose QR carries another store's ID", expectLayer: 'rules' },
      'paper-moon-time-before-checkin': { order: 4, attempt: 'Receipt printed at 10:31, before the check-in', expectLayer: 'AI + rules' },
      'paper-moon-totals-off': { order: 5, attempt: 'Receipt whose line does not add up to its total', expectLayer: 'AI + rules' },
      'paper-moon-wrong-code': { order: 6, attempt: "Item photo showing another job's code", expectLayer: 'AI + rules' },
      'paper-moon-generator-metadata': { order: 7, attempt: 'Receipt file made by an image generator', expectLayer: 'sent to a person' },
    };
    let market = 0;
    const markets = (parts.has('receipts') ? ATTACK_RECEIPTS.length : 0) + (parts.has('money') ? 2 : 0) + (parts.has('limits') ? 1 : 0);
    for (const c of parts.has('receipts') ? ATTACK_RECEIPTS : []) {
      const words = RECEIPTS[c.caseId];
      if (!words) throw new SetupError(`no wording for the attack case ${c.caseId}`);
      const kase = caseOf(c.caseId);
      market++;
      progress(`Market ${market} of ${markets} (fresh, 10:30): ${user(c.queuerId).displayName} takes ${user(c.requesterId).displayName}'s request and sends ${c.caseId}.`);
      await reset();
      await clock('10:31');
      const { bid } = await openRequest(c.requesterId);
      await clock('10:40');
      const { claimId, jobId } = await claim(c.queuerId, bid.id, '10:57');
      await clock('10:57');
      await checkIn(c.queuerId, claimId);
      const uploadAt = kase.uploadedAt.slice(11, 16);
      await clock(epochToZonedLocal(sf(uploadAt) - 2 * 60_000, ZONE).slice(11, 16));
      await bought(c.queuerId, jobId);
      await clock(uploadAt);
      const expectedCodes = [...kase.expect.hard, ...kase.expect.soft].sort().join(', ');
      await attempt(
        { order: words.order, id: c.caseId, attempt: words.attempt, expectLayer: words.expectLayer, mustRefuse: true, expect: ZERO, expectCode: expectedCodes, fixture: c.caseId },
        () => sendProof(c.queuerId, jobId, c.caseId),
      );
      await checkInvariants(`fake receipt ${c.caseId}`);
    }

    // ---- part 2: the money tricks, on a local errand and then on a market with a genuine errand ------
    if (parts.has('money')) {
      // The handover code is the requester's consent to the local capture: guessing it must lock.
      market++;
      const { requesterId: local, queuerId: runner } = ATTACK_HANDOVER;
      progress(`Market ${market} of ${markets} (fresh, 10:30): ${user(runner).displayName} does ${user(local).displayName}'s local errand, then guesses the handover code.`);
      await reset();
      await clock('10:31');
      const errandBid = await placeRequest(local, { destination: { mode: 'local', cityId: user(local).cityId } });
      await clock('10:40');
      const errand = await claim(runner, errandBid.bid.id, '10:50', 'local');
      await clock('10:50');
      await checkIn(runner, errand.claimId);
      await clock('11:38');
      await bought(runner, errand.jobId);
      await clock('11:42');
      const verdict = await sendProof(runner, errand.jobId, ATTACK_HANDOVER.caseId);
      if (verdict.proofStatus !== 'passed') throw new SetupError(`the genuine receipt for ${local}'s local errand ended ${verdict.proofStatus}: ${verdict.detail}`);
      await clock('11:50');
      const rightCode = must(await api('GET', `/api/jobs/${errand.jobId}`, { as: local }), `${local}'s job`).job.handoverCode;
      await attempt(
        {
          order: 17,
          id: 'guess-handover-code',
          attempt: 'Guess the 4-digit handover code for two hours, then right',
          expectLayer: 'rules',
          mustRefuse: true,
          expect: ZERO,
          expectCode: 'RATE_LIMITED',
        },
        async () => {
          // Five wrong codes fill the hourly window; an hour later five more reach the lock for good (D-148).
          const guesses = ['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234'].filter((g) => g !== rightCode).slice(0, 10);
          const tries = [];
          for (const [i, code] of guesses.entries()) {
            if (i === 5) {
              const waited = await api('POST', `/api/jobs/${errand.jobId}/handover`, { as: runner, body: { code: rightCode } });
              tries.push({ code: 'right code', r: waited });
              await clock('12:52');
            }
            tries.push({ code, r: await api('POST', `/api/jobs/${errand.jobId}/handover`, { as: runner, body: { code } }) });
          }
          await clock('13:30');
          const last = await api('POST', `/api/jobs/${errand.jobId}/handover`, { as: runner, body: { code: rightCode } });
          if (tries.some((t) => t.r.ok) || last.ok) return refusal({ ok: true });
          const wrong = tries.filter((t) => t.r.code === 'WRONG_CODE').length;
          return {
            refused: true,
            code: last.code,
            layer: layerOf(last.code),
            answer: `locked after ${wrong} wrong codes`,
            detail: `11:50: five wrong codes, then the right one answered ${tries[5].r.code}; 12:52: five more wrong codes; 13:30: the right code answered ${last.code}: ${last.message}`,
          };
        },
      );
      await checkInvariants('handover code');

      market++;
      progress(`Market ${market} of ${markets} (fresh, 10:30): Wei does Mia's errand honestly; Rex and the others try the money tricks.`);
      await reset();
      await clock('10:31');
      const mia = await placeRequest('mia');
      const leo = await placeRequest('leo');
      const priya = await openRequest('priya');

      await clock('10:33');
      const raisedFee = 4000;
      await attempt(
        { order: 8, id: 'raise-max-fee', attempt: `Raise the max fee to ${usd(raisedFee)} after PayPal held ${usd(mia.hold.amount.cents)}`, expectLayer: 'rules', mustRefuse: true, expect: ZERO, expectCode: 'OVER_LIMIT' },
        async () => refusal(await api('PATCH', `/api/bids/${mia.bid.id}`, { as: 'mia', idem: `attack-${run}-patch`, body: { maxFeeCents: raisedFee } })),
      );

      await clock('10:34');
      must(await api('POST', `/api/bids/${leo.bid.id}/cancel`, { as: 'leo', body: { reason: 'changed my mind' } }), "Leo's cancel");
      await attempt(
        { order: 11, id: 'claim-released', attempt: 'Take a request whose hold was released', expectLayer: 'state machine', mustRefuse: true, expect: ZERO, expectCode: 'CONFLICT' },
        async () => {
          const rex = user('rex');
          const etaAt = (await marketNow()) + (travelMinutes(rex.home, shop.lngLat) + 2) * 60_000;
          return refusal(await api('POST', `/api/bids/${leo.bid.id}/claim`, { as: 'rex', body: { qty: 1, etaAt, modes: ['ship'], from: { lngLat: rex.home, accuracyM: 10 } } }));
        },
      );
      // Leo asks again; his approval in PayPal's window comes only after the sell-out below.
      const leoAgain = await placeRequest('leo', { approve: false });

      await clock('10:40');
      const wei = await claim('wei', mia.bid.id, '10:50');
      const rex = await claim('rex', priya.bid.id, '10:57');
      await clock('10:41');
      await attempt(
        { order: 9, id: 'no-check-in', attempt: 'Buy and send a receipt without checking in', expectLayer: 'state machine', mustRefuse: true, expect: ZERO, expectCode: 'INVALID_TRANSITION' },
        async () => {
          const buy = await api('POST', `/api/jobs/${rex.jobId}/bought`, { as: 'rex' });
          const receipt = await upload('rex', 'receipt', fixture('paper-moon-rex-fake/receipt.png'), 'a receipt');
          const item = await upload('rex', 'item_photo', fixture('paper-moon-rex-fake/item.png'), 'an item photo');
          const proof = await api('POST', `/api/jobs/${rex.jobId}/proof`, { as: 'rex', body: { receiptFileId: receipt.id, itemFileId: item.id } });
          if (buy.ok || proof.ok) return refusal({ ok: true });
          return { refused: true, code: buy.code === proof.code ? buy.code : `${buy.code}, ${proof.code}`, layer: layerOf(buy.code), answer: buy.code, detail: `Bought: ${buy.message} Receipt: ${proof.message}` };
        },
      );
      await clock('10:42');
      const rexLine = await upload('rex', 'line_photo', lineOf('rex'), 'a line photo');
      const rexHome = user('rex').home;
      await attempt(
        { order: 10, id: 'check-in-from-home', attempt: `Check in from home, ${(distanceMeters(rexHome, shop.lngLat) / 1000).toFixed(1)} km from the shop`, expectLayer: 'rules', mustRefuse: true, expect: ZERO, expectCode: 'OUTSIDE_GEOFENCE' },
        async () => refusal(await api('POST', `/api/claims/${rex.claimId}/check-in`, { as: 'rex', body: { lngLat: rexHome, accuracyM: 10, photoFileId: rexLine.id } })),
      );

      await clock('10:50');
      await checkIn('wei', wei.claimId);
      await clock('10:57');
      await checkIn('rex', rex.claimId, rexLine);
      await clock('11:38');
      await bought('wei', wei.jobId);
      await clock('11:42');
      const genuine = caseOf('paper-moon-mia-genuine');
      const weiJob = (await jobOf(wei.jobId)).job;
      const receiptCap = receiptCapture(weiJob.caps, genuine.expect.retailCents, 'ship');
      const feePayout = payoutsForCapture('ship', 'receipt', { retailCents: receiptCap.retailCents, feeCents: receiptCap.feeCents, shippingCents: 0 })[0].amountCents;
      await attempt(
        { order: 1, id: 'genuine', attempt: 'Genuine receipt and item photo (control: should pass)', expectLayer: '-', mustRefuse: false, outcome: 'intended', expect: { captured: receiptCap.amountCents, paidOut: feePayout }, expectCode: 'passed', fixture: 'paper-moon-mia-genuine' },
        () => sendProof('wei', wei.jobId, 'paper-moon-mia-genuine'),
      );

      await clock('11:45');
      const label = await upload('wei', 'label', placeholderPng(`attack-${run}-label`), 'a shipping label');
      const claimed = 50_000;
      const shipBody = { carrierName: 'Harbor Parcel Ground', trackingNumber: `HPG-ATTACK-${run.toUpperCase()}`, shippingCostCents: claimed, dutyPaidCents: 0, labelFileId: label.id };
      const shipKey = `attack-${run}-ship`;
      const shipCap = shippingCapture(weiJob.caps, claimed, 0);
      const reimbursement = payoutsForCapture('ship', 'shipping', { retailCents: receiptCap.retailCents, feeCents: 0, shippingCents: shipCap.shippingCents })[0].amountCents;
      await attempt(
        {
          order: 12,
          id: 'inflate-shipping',
          attempt: `Claim ${usd(claimed)} shipping on a ${usd(weiJob.caps.shippingCents)} budget`,
          expectLayer: 'rules',
          mustRefuse: false,
          outcome: 'capped',
          expect: { captured: shipCap.amountCents, paidOut: reimbursement },
          expectCode: 'capped',
        },
        async () => {
          const r = await api('POST', `/api/jobs/${wei.jobId}/shipment`, { as: 'wei', idem: shipKey, body: shipBody });
          if (!r.ok) return { refused: true, code: r.code, layer: layerOf(r.code), answer: r.code, detail: r.message };
          const charged = r.json.job.amounts.shippingCents;
          // shippingCapture in shared/src/money.ts caps what the queuer reports at the budget; no label is read.
          return {
            refused: false,
            code: charged === weiJob.caps.shippingCents ? 'capped' : 'not capped',
            layer: 'rules',
            answer: 'capped: over-claims up to the budget are paid',
            detail: `Shipping charged at ${usd(charged)} of the ${usd(claimed)} claimed, plus PayPal's fee on it at cost; the payout repays the ${usd(receiptCap.retailCents)} shop price and that ${usd(charged)}. Nothing checks the postage itself, so a claim up to the budget is paid as reported.`,
          };
        },
      );
      await clock('11:46');
      await attempt(
        { order: 13, id: 'replay-tracking', attempt: 'Replay that tracking call (same Idempotency-Key)', expectLayer: 'state machine', mustRefuse: true, expect: ZERO, expectCode: 'REPLAYED' },
        async () => {
          const r = await api('POST', `/api/jobs/${wei.jobId}/shipment`, { as: 'wei', idem: shipKey, body: shipBody });
          if (r.ok && r.replayed) return { refused: true, code: 'REPLAYED', layer: layerOf('REPLAYED'), answer: 'first answer replayed', detail: 'The server answered with its first response (Idempotent-Replay: true) and called PayPal for nothing.' };
          return refusal(r);
        },
      );
      await clock('11:47');
      await attempt(
        { order: 14, id: 'capture-after-final', attempt: 'Add tracking again to capture after the final one', expectLayer: 'state machine', mustRefuse: true, expect: ZERO, expectCode: 'INVALID_TRANSITION' },
        async () => refusal(await api('POST', `/api/jobs/${wei.jobId}/shipment`, { as: 'wei', idem: `attack-${run}-ship-2`, body: { ...shipBody, trackingNumber: `${shipBody.trackingNumber}-2`, shippingCostCents: 2000 } })),
      );
      await clock('11:48');
      await attempt(
        { order: 15, id: 'second-fee-payout', attempt: 'Send the receipt again for a second fee payout', expectLayer: 'state machine', mustRefuse: true, expect: ZERO, expectCode: 'INVALID_TRANSITION' },
        async () => {
          const receipt = await upload('wei', 'receipt', fixture('paper-moon-mia-genuine/receipt.png'), 'a receipt');
          const item = await upload('wei', 'item_photo', fixture('paper-moon-mia-genuine/item.png'), 'an item photo');
          return refusal(await api('POST', `/api/jobs/${wei.jobId}/proof`, { as: 'wei', body: { receiptFileId: receipt.id, itemFileId: item.id } }));
        },
      );

      await clock('11:50');
      must(await api('POST', `/api/jobs/${rex.jobId}/sold-out`, { as: 'rex', body: { photoFileId: null } }), 'Rex reports the plush sold out');
      await clock('11:51');
      must(await api('POST', `/api/fake/paypal/orders/${leoAgain.orderId}/approve`, { as: 'leo', body: { funding: 'paypal', outcome: 'approve' } }), 'Leo approves in the simulated PayPal sheet');
      await attempt(
        { order: 16, id: 'approve-after-sell-out', attempt: 'Approve a hold after the item sold out', expectLayer: 'state machine', mustRefuse: true, expect: ZERO, expectCode: 'SOLD_OUT' },
        async () => refusal(await api('POST', `/api/bids/${leoAgain.bid.id}/authorize`, { as: 'leo', body: { orderId: leoAgain.orderId } })),
      );
      await checkInvariants('money tricks');
    }

    // ---- part 3: two known limits, run to show what they move (D-147) ------------------------------
    if (parts.has('limits')) {
      market++;
      const { requesterId, queuerId, spooferId, reprintCaseId, reprintOf } = ATTACK_LIMITS;
      const spoofer = user(spooferId);
      progress(`Market ${market} of ${markets} (fresh, 10:30): two known limits. ${spoofer.displayName} runs a fee clock from home; ${user(queuerId).displayName} reprints ${user(requesterId).displayName}'s receipt at her cap.`);
      await reset();
      await clock('10:31');
      const request = await placeRequest(requesterId);
      await clock('10:35');
      // An offer like Wei's in the story: $15, down $1 every 5 minutes to $8, posted from home.
      const offer = must(
        await api('POST', '/api/asks', {
          as: spooferId,
          idem: `attack-${run}-offer`,
          body: {
            shopId: HERO.shopId,
            itemId: HERO.itemId,
            capacity: 1,
            modes: ['ship', 'local'],
            feeCents: 1500,
            clock: { stepCents: 100, intervalMs: 5 * 60_000, floorCents: 800 },
            etaAt: (await marketNow()) + (travelMinutes(spoofer.home, shop.lngLat) + 1) * 60_000,
            from: { lngLat: spoofer.home, accuracyM: 10 },
          },
        }),
        `${spoofer.displayName}'s offer`,
      );
      await clock('10:40');
      const errand = await claim(queuerId, request.bid.id, '10:50');
      await clock('10:42');
      const staged = await upload(spooferId, 'line_photo', lineOf(spooferId), 'a line photo');
      const km = (distanceMeters(spoofer.home, shop.lngLat) / 1000).toFixed(1);
      const spoof = await attempt(
        {
          order: 22,
          id: 'spoofed-check-in',
          attempt: "Check in from home, the phone reporting the shop's position",
          expectLayer: 'not stopped',
          mustRefuse: false,
          outcome: 'known_limit',
          expect: ZERO,
          expectCode: 'checked_in',
        },
        async () => {
          const r = await api('POST', `/api/claims/${offer.claim.id}/check-in`, { as: spooferId, body: { lngLat: shop.lngLat, accuracyM: 8, photoFileId: staged.id } });
          if (!r.ok) return refusal(r);
          const proof = await waitFor('the line photo check', async () => {
            const p = (await records()).proofs.filter((x) => x.claimId === offer.claim.id && x.kind === 'check_in').at(-1);
            return p && p.status !== 'verifying' ? p : null;
          });
          if (proof.status !== 'passed') return { refused: true, code: proof.status, layer: proof.status === 'needs_review' ? 'sent to a person' : 'AI + rules', answer: proof.status, detail: proof.summary };
          return {
            refused: false,
            code: 'checked_in',
            layer: 'not stopped',
            answer: 'checked in; fee clock started',
            detail: `The server takes the position the phone reports, and the line photo shows the visit's code, so the check-in passed at 10:42 and the fee clock started, ${km} km from the shop.`,
          };
        },
      );
      // Wei checks in at the shop for real at 10:50; then the clock runs to 11:05 to see Rex's fee.
      await clock('10:50');
      await checkIn(queuerId, errand.claimId);
      await clock('11:05');
      // The server's scheduler runs the fee clock's steps after the jump, in the background: wait until the
      // step that reaches a request has filled it (at $11.00 Priya's request does), so the row does not
      // depend on how fast the machine is. Without a fill in 60 s the row reports the fee instead.
      const seen = await waitFor(`${spoofer.displayName}'s fee clock to reach a request`, async () => {
        const rec = await records();
        return rec.matches.some((x) => x.askId === offer.ask.id) ? rec : null;
      }).catch(async (err) => {
        if (err instanceof SetupError) return records();
        throw err;
      });
      const fill = seen.matches.filter((x) => x.askId === offer.ask.id).sort((a, b) => a.at - b.at)[0];
      const ask = seen.asks.find((a) => a.id === offer.ask.id);
      if (fill) {
        const bid = seen.bids.find((b) => b.id === fill.bidId);
        spoof.answer = `checked in; fee fell to ${usd(fill.feeCents)} and filled`;
        spoof.detail += ` From home, his fee fell from ${usd(ask.feeCents)} and matched ${bid?.requesterName ?? 'a request'} at ${usd(fill.feeCents)} at ${epochToZonedLocal(fill.at, ZONE).slice(11, 16)}. No money moves until a receipt passes.`;
      } else if (ask) {
        spoof.answer = `checked in; fee down to ${usd(askFeeAt(ask, sf('11:05')))}`;
        spoof.detail += ` By 11:05 his fee had fallen from ${usd(ask.feeCents)} to ${usd(askFeeAt(ask, sf('11:05')))}.`;
      }

      await clock('11:38');
      await bought(queuerId, errand.jobId);
      await clock('11:42');
      const job = (await jobOf(errand.jobId)).job;
      const real = caseOf(reprintOf).expect.retailCents;
      const forged = receiptCapture(job.caps, caseOf(reprintCaseId).expect.retailCents, 'ship');
      const honest = receiptCapture(job.caps, real, 'ship');
      const feePayout = payoutsForCapture('ship', 'receipt', { retailCents: forged.retailCents, feeCents: forged.feeCents, shippingCents: 0 })[0].amountCents;
      await attempt(
        {
          order: 21,
          id: 'reprint-at-cap',
          attempt: `Reprint the ${usd(real)} receipt at the ${usd(job.caps.retailCents)} cap, QR to match`,
          expectLayer: 'not stopped',
          mustRefuse: false,
          outcome: 'known_limit',
          expect: { captured: forged.amountCents, paidOut: feePayout },
          expectCode: 'passed',
          fixture: reprintCaseId,
        },
        async () => {
          const out = await sendProof(queuerId, errand.jobId, reprintCaseId, { passLayer: 'not stopped' });
          if (out.proofStatus !== 'passed') return out;
          return {
            ...out,
            answer: `passed: shop price read as ${usd(forged.retailCents)}`,
            detail: `${out.detail} The reprint matches itself (lines, total and QR) and stays under the cap, so every check passes: ${usd(forged.amountCents - honest.amountCents)} more is captured than the real receipt would (${usd(forged.retailCents - honest.retailCents)} of shop price and PayPal's fee on it), and never more than the cap.`,
          };
        },
      );
      await checkInvariants('known limits');
    }

    // ---- part 4: straight at PayPal, skipping HoldMySpot (D-139) ----------------------------------
    if (parts.has('paypal')) {
      // The worked example's hold (docs/DOMAIN.md section 7): shop price up to $36, fee $12, shipping up to $12.
      const exampleBid = { qty: 1, retailCapCents: 3600, maxFeeCents: 1200, shippingBudgetCents: 1200 };
      const exampleCaps = jobCaps(exampleBid, { qty: 1, feeCents: exampleBid.maxFeeCents });
      const example = {
        receipt: receiptCapture(exampleCaps, 3400),
        shipping: shippingCapture(exampleCaps, 875, 0),
        feePayoutCents: payoutsForCapture('ship', 'receipt', { retailCents: 3400, feeCents: exampleBid.maxFeeCents, shippingCents: 0 })[0].amountCents,
      };
      const limit = bidLimitCents(exampleBid);
      progress('PayPal emulator in this process (the answers the real sandbox gave, docs/SANDBOX-GATES.md): HoldMySpot is skipped.');
      const pp = createFakePayPal({ knownReceivers: () => true });
      const ppMoney = () => {
        const s = pp.exportState();
        const captured = Object.values(s.captures).filter((c) => c.status === 'COMPLETED' || c.status === 'PENDING').reduce((n, c) => n + c.amountCents, 0);
        const paidOut = Object.values(s.payoutItems).filter((i) => !['FAILED', 'RETURNED', 'REFUNDED', 'REVERSED', 'CANCELED', 'BLOCKED', 'DENIED'].includes(i.status)).reduce((n, i) => n + i.amountCents, 0);
        return { captured, refunded: 0, paidOut, held: 0 };
      };
      let seq = 0;
      const ppHold = async () => {
        const n = ++seq;
        const order = await pp.createOrder({
          requestId: `attack-${run}-order-${n}`,
          invoiceId: `HMS-ATTACK-${run}-${n}`,
          customId: `attack-${n}`,
          description: `A hold like Mia's: up to ${usd(limit)}`,
          softDescriptor: 'HOLDMYSPOT',
          amountCents: limit,
          breakdown: { itemTotalCents: limit, shippingCents: 0 },
          items: [{ name: 'Mochi Bunny plush errand (up to)', quantity: 1, unitAmountCents: limit, category: null }],
          shipping: { type: 'SHIPPING', preference: 'GET_FROM_FILE' },
          funding: 'paypal',
          returnUrl: 'http://127.0.0.1/return',
          cancelUrl: 'http://127.0.0.1/cancel',
        });
        await pp.approveOrder(order.orderId, 'paypal', 'approve');
        return (await pp.authorizeOrder(order.orderId, `attack-${run}-auth-${n}`)).authorizationId;
      };
      const ppAttempt = async (spec, fn) => {
        const before = ppMoney();
        let out;
        try {
          await fn();
          out = { refused: false, code: 'accepted', layer: 'nothing', answer: 'ACCEPTED', detail: 'PayPal accepted it.' };
        } catch (err) {
          const f = err?.failure;
          if (!f) throw err;
          const issue = f.issue ?? f.paypalName ?? f.code;
          const code = /already exists/i.test(issue) ? f.paypalName : issue;
          out = { refused: true, code, layer: 'PayPal emulator', answer: code, detail: `HTTP ${f.httpStatus}: ${f.paypalName}${f.issue ? `/${f.issue}` : ''} (the answer the real sandbox gave, copied by the emulator)` };
        }
        const moved = diffMoney(ppMoney(), before);
        const row = { ...spec, ...out, moved, newPending: false };
        Object.assign(row, judge(spec, row));
        rows.push(row);
        progress(`  ${row.ok ? 'ok  ' : 'FAIL'} ${spec.attempt}: ${row.answer}; moved ${movedText(moved, null)}`);
      };
      const over = Math.floor((limit * 11_500) / 10_000) + 1;
      const a1 = await ppHold();
      await ppAttempt(
        { order: 18, id: 'paypal-over-115', attempt: `Capture ${usd(over)} of a ${usd(limit)} hold, straight at PayPal`, expectLayer: 'PayPal emulator', mustRefuse: true, expect: ZERO, expectCode: 'MAX_CAPTURE_AMOUNT_EXCEEDED' },
        () => pp.captureAuthorization(a1, { requestId: `attack-${run}-cap-over`, amountCents: over, finalCapture: false, invoiceId: `HMS-ATTACK-${run}-OVER`, noteToPayer: 'attack', softDescriptor: 'HOLDMYSPOT' }),
      );
      const a2 = await ppHold();
      await pp.captureAuthorization(a2, { requestId: `attack-${run}-cap-final`, amountCents: example.receipt.amountCents, finalCapture: true, invoiceId: `HMS-ATTACK-${run}-R`, noteToPayer: 'attack', softDescriptor: 'HOLDMYSPOT' });
      await ppAttempt(
        { order: 19, id: 'paypal-after-final', attempt: 'Capture again after the final capture, straight at PayPal', expectLayer: 'PayPal emulator', mustRefuse: true, expect: ZERO, expectCode: 'AUTHORIZATION_ALREADY_CAPTURED' },
        () => pp.captureAuthorization(a2, { requestId: `attack-${run}-cap-again`, amountCents: example.shipping.amountCents, finalCapture: true, invoiceId: `HMS-ATTACK-${run}-S`, noteToPayer: 'attack', softDescriptor: 'HOLDMYSPOT' }),
      );
      const batch = {
        senderBatchId: `payout:attack-${run}:fee`,
        emailSubject: 'You have a payout from HoldMySpot',
        emailMessage: 'Queue fee.',
        items: [{ receiverEmail: 'wei@queuers.example', amountCents: example.feePayoutCents, note: 'Queue fee (Wei)', senderItemId: `po_attack_${run}` }],
      };
      await pp.createPayout(batch);
      await ppAttempt(
        { order: 20, id: 'paypal-payout-again', attempt: 'Send the same payout batch again, straight at PayPal', expectLayer: 'PayPal emulator', mustRefuse: true, expect: ZERO, expectCode: 'USER_BUSINESS_ERROR' },
        () => pp.createPayout(batch),
      );
    }

    // ---- the table ------------------------------------------------------------------------------
    rows.sort((a, b) => a.order - b.order);
    const head = ['#', 'Attempt', 'Stopped by', 'Answer', 'Moved'];
    const cells = rows.map((r) => [String(r.order), r.attempt, r.layer, r.answer, movedText(r.moved, r.ok ? (OUTCOME_NOTE[r.outcome] ?? null) : null)]);
    const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
    const line = (c) => c.map((v, i) => (i === 0 ? v.padStart(widths[i]) : i === c.length - 1 ? v : v.padEnd(widths[i]))).join('  ').trimEnd();
    const table = [line(head), ...cells.map(line)];
    const failed = rows.filter((r) => !r.ok);
    const unexpected = rows.filter((r) => r.ok && !r.asExpected);
    const violations = invariantRuns.flatMap((m) => m.violations.map((v) => `${m.market}: ${v}`));
    const kind = (o) => rows.filter((r) => r.ok && r.outcome === o);
    const refused = rows.filter((r) => r.ok && r.outcome === undefined && r.layer !== 'sent to a person');
    const toPerson = rows.filter((r) => r.ok && r.layer === 'sent to a person');
    const listed = (xs) => (xs.length === 0 ? '' : ` (${xs.length === 1 ? 'row' : 'rows'} ${xs.map((r) => r.order).join(' and ')})`);
    // Which reader read the photos: the recorded model answers, or the rules-only reader for a photo with no recording.
    const readers = new Map();
    for (const r of rows.filter((x) => x.ai)) {
      const who = r.ai.simulated
        ? `a simulated reading (${r.ai.simulated})`
        : r.ai.provider === 'fake'
          ? "the rules-only reader (the photo's truth.json; no model reading is recorded for it)"
          : `${r.ai.provider}/${r.ai.model} (${r.ai.mode}${r.ai.mode === 'replay' ? ': recorded answers, no model was called' : ''})`;
      readers.set(who, [...(readers.get(who) ?? []), r.order]);
    }
    const photoAi = rows.find((r) => r.ai && r.ai.provider !== 'fake')?.ai ?? rows.find((r) => r.ai)?.ai ?? null;
    const git = gitState();
    const ok = failed.length === 0 && violations.length === 0;

    console.log('');
    console.log(bold('HoldMySpot: try to break it'));
    if (base) console.log(dim(`  ${server ? `Server: started for this run on ${base} (simulated PayPal, recorded AI answers, no keys); stopped at the end.` : `Server: the running demo on ${base}; its market was reset before each part.`}`));
    if (readers.size > 0) {
      const many = readers.size > 1;
      const parts2 = [...readers].map(([who, orders]) => (many ? `${who} for ${orders.length === 1 ? 'row' : 'rows'} ${orders.join(', ')}` : who));
      console.log(dim(`  Photos: the rendered demo photos in server/fixtures/proofs, read by ${parts2.join('; ')}.`));
    }
    console.log(dim(`  Commit ${git.commit ?? 'unknown'}${git.dirty ? ' with uncommitted changes' : ''}, Node ${process.versions.node}, ${process.platform} ${process.arch}, ${startedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`));
    console.log('');
    for (const [i, l] of table.entries()) {
      const r = i === 0 ? null : rows[i - 1];
      console.log(i === 0 ? bold(l) : r.ok ? l : red(l));
    }
    console.log('');
    if (args.verbose) {
      for (const r of rows) console.log(dim(`  ${String(r.order).padStart(2)}. ${r.detail}`));
      console.log('');
    }
    for (const r of failed) console.log(red(`  Row ${r.order} (${r.attempt}): ${r.notes.join('; ')}.`));
    for (const r of unexpected) console.log(yellow(`  Row ${r.order} (${r.attempt}): ${r.notes.join('; ')}; no money moved.`));
    for (const v of violations) console.log(red(`  Invariant broken: ${v}.`));
    const holds = invariantRuns.reduce((n, m) => n + m.holds, 0);
    const jobs = invariantRuns.reduce((n, m) => n + m.jobs, 0);
    const summary = [
      `${refused.length} refused, $0.00 moved`,
      ...(toPerson.length ? [`${toPerson.length} sent to a person, $0.00 moved so far${listed(toPerson)}`] : []),
      ...(kind('intended').length ? [`${kind('intended').length} moved exactly the intended amount${listed(kind('intended'))}`] : []),
      ...(kind('capped').length ? [`${kind('capped').length} paid as claimed up to the requester's budget${listed(kind('capped'))}`] : []),
      ...(kind('known_limit').length ? [`${kind('known_limit').length} not stopped, the known limits README lists${listed(kind('known_limit'))}`] : []),
    ];
    console.log(`${rows.length} attempts: ${summary.join('; ')}.`);
    if (invariantRuns.length > 0) {
      const after = invariantRuns.length === 1 ? 'the market' : `each of the ${invariantRuns.length} markets`;
      console.log(`Checked after ${after}: no hold captured more than PayPal held, and no job paid out more than it charged (${holds} holds a capture was tried on, ${jobs} jobs).`);
    }
    console.log(
      ok
        ? green(bold('Every attempt moved exactly what the shared money rules say.'))
        : red(bold(`${failed.length + violations.length === 1 ? 'One problem' : `${failed.length + violations.length} problems`}: money moved where the rules say it should not, or an attempt was not stopped.`)),
    );

    if (args.json) {
      const report = {
        tool: 'npm run attack',
        format: 1,
        ok,
        startedAt: startedAt.toISOString(),
        commit: git.commit,
        uncommittedChanges: git.dirty,
        codeTrees: git.trees,
        node: process.versions.node,
        platform: `${process.platform} ${process.arch}`,
        server: base ? { url: base, startedHere: Boolean(server), mode: config.mode, ai: config.ai } : null,
        parts: [...parts],
        photos: photoAi,
        rows: rows.map((r) => ({
          n: r.order,
          id: r.id,
          attempt: r.attempt,
          stoppedBy: r.layer,
          answer: r.answer,
          code: r.code,
          detail: r.detail,
          refused: r.refused,
          moved: r.moved,
          expected: { ...ZERO, ...r.expect },
          outcome: r.outcome ?? (r.layer === 'sent to a person' ? 'to_a_person' : 'refused'),
          intended: r.outcome === 'intended',
          ok: r.ok,
          asExpected: r.asExpected,
          notes: r.notes,
        })),
        markets: invariantRuns,
        table,
      };
      fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
      fs.writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
    }
    return ok ? 0 : 1;
  } catch (err) {
    if (server) console.error(`\nLast lines of the server's log:\n${server.tail()}`);
    throw err;
  } finally {
    await stopServer();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\n${red('Stopped:')} ${err instanceof SetupError ? err.message : (err?.stack ?? String(err))}`);
    process.exit(1);
  });
