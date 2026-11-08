// HoldMySpot: one full job through the server's HTTP API on the REAL PayPal sandbox, then a
// check on PayPal itself that the money moved exactly as the server's ledger says.
//
//   node scripts/sandbox-gates.mjs lifecycle --payout-to person-1 [--headed] [--keep]
//   node scripts/sandbox-gates.mjs lifecycle --by-hand [--open] [--wait 15]   you approve in your own browser
//   node scripts/sandbox-gates.mjs lifecycle --local                          the local pickup errand (below)
//
// It starts its own server (HMS_MODE=sandbox, port 8798 by default, a temporary database and
// upload folder, demo staging so the rendered hero photos carry the right codes, recorded AI
// answers), plays Mia (requester) and Wei (queuer) at Paper Moon Toys over HTTP only, approves
// the PayPal order in a browser as the sandbox buyer (scripts/lib/sandbox-buyer.mjs; with --by-hand
// it prints PayPal's link and waits while you approve it yourself, so no password is stored), and stops
// the server it started (by its own PID) at the end. Nothing else is touched.
//
// Steps: quote, bid ($63.70 hold, processing and payouts at cost included, D-105), buyer approval,
// authorize, direct claim at the $12 max fee, check-in with the line photo, bought, proof with the
// receipt and item photos, receipt capture ($48.69, not final) and the fee payout, shipment with
// tracking, the final shipping capture ($9.57 = $8.75 + $0.82) and the release of the rest ($5.44),
// the reimbursement payout. Then GET authorization, order, captures and payout batches from PayPal
// and compare. The script takes every amount from the server, so only this comment names them.
// PayPal's own fees are compared too (D-120): each capture's seller_receivable_breakdown.paypal_fee
// and each payout item's payout_item_fee against the fee the server recorded and the D-105 schedule
// ($2.19 + $0.82 + 2 x $0.25 = $3.51 on this errand), and the job's processing line against their sum.
//
// With `local` (D-156) it plays the local pickup errand instead, the pair `npm run attack` uses for its
// handover row (ATTACK_HANDOVER in server/src/demo/attack.ts, whose receipt code the demo market pins):
// Sam in San Francisco holds for the same plush on a PICKUP_FROM_PERSON order (no shipping budget),
// Wei claims it for local delivery, checks in, buys it and sends the same receipt and item photos;
// nothing is captured at the receipt. At the handover Wei enters the code Sam's phone shows, and the
// server makes the job's one capture (shop price, fee and processing at cost, final, so PayPal releases
// the rest) and one payout of the shop price and the fee minus 10%. The same GET calls and checks follow,
// with "no shipping on the order" and "one capture at the handover" in place of the tracking check.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(REPO, 'server');
const PROOFS = path.join(SERVER, 'fixtures', 'proofs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

/** A 1x1 PNG for the shipping label (any image is accepted as a label). */
const LABEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function portInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

class ApiError extends Error {
  constructor(method, route, status, body) {
    const code = body && typeof body === 'object' ? (body.error?.code ?? body.code ?? '') : '';
    const message = body && typeof body === 'object' ? (body.error?.message ?? body.message ?? '') : String(body ?? '');
    super(`${method} ${route} answered ${status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`);
    this.status = status;
    this.code = code;
  }
}

/** A tiny HTTP client for the server's API: JSON in and out, raw bytes for photos, persona and idempotency headers. */
export function client(base) {
  return async function api(method, route, { as, body, bytes, contentType = 'image/png', idem } = {}) {
    const headers = {};
    if (as) headers['x-hms-user'] = as;
    if (idem) headers['idempotency-key'] = idem;
    let payload;
    if (bytes) {
      headers['content-type'] = contentType;
      payload = bytes;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}${route}`, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok) throw new ApiError(method, route, res.status, json);
    return json;
  };
}

export async function waitFor(what, fn, { timeoutMs = 60_000, everyMs = 1_000 } = {}) {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}.`);
    await sleep(everyMs);
  }
}

/**
 * Starts the server in sandbox mode on its own port, database and upload folder.
 * `payoutEmail` (from --payout-to) goes to the child's environment only; it is never printed.
 */
async function startServer({ port, tmp, secretsDir, payoutEmail, log }) {
  if (await portInUse(port)) throw new Error(`Port ${port} is already in use; the lifecycle only uses a server it starts itself.`);
  const logFile = path.join(tmp, 'server.log');
  const out = fs.openSync(logFile, 'a');
  const env = {
    ...process.env,
    HMS_MODE: 'sandbox',
    HMS_HOST: '127.0.0.1',
    HMS_PORT: String(port),
    HMS_DB_PATH: path.join(tmp, 'holdmyspot.sqlite'),
    HMS_UPLOAD_DIR: path.join(tmp, 'uploads'),
    HMS_SECRETS_DIR: secretsDir,
    // Demo staging: a deterministic market whose hero codes match the rendered photos (D-48); idle until driven.
    HMS_DEMO: '1',
    HMS_CROWD: '0',
    // Recorded model answers (server/fixtures/ai), so the run is quick and repeatable.
    HMS_AI_MODE: 'replay',
    HMS_PAYPAL_POLL_SECONDS: '5',
    HMS_LOG_LEVEL: 'warn',
  };
  delete env.HMS_DEMO_RESET;
  if (payoutEmail) env.PAYPAL_PAYOUT_EMAIL = payoutEmail;
  const child = spawn(process.execPath, ['src/main.ts'], { cwd: SERVER, env, stdio: ['ignore', out, out] });
  log(`server pid ${child.pid} on 127.0.0.1:${port} (log ${logFile})`);
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const api = client(`http://127.0.0.1:${port}`);
  try {
    await waitFor('the server to answer', async () => {
      if (child.exitCode !== null) throw new Error(`The server exited (code ${child.exitCode}); see ${logFile}.`);
      try {
        return await api('GET', '/api/health');
      } catch {
        return null;
      }
    }, { timeoutMs: 60_000, everyMs: 500 });
  } catch (e) {
    child.kill('SIGTERM');
    throw e;
  }
  return {
    child,
    api,
    logFile,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const r = await Promise.race([exited, sleep(15_000).then(() => null)]);
      if (r === null && child.exitCode === null) child.kill('SIGKILL');
      log(`server pid ${child.pid} stopped`);
    },
  };
}


/** The market times of the hero errand's rendered photos (server/fixtures/proofs): the clock must be at or before the first. */
export const ERRAND_TIMES = Object.freeze({ claim: '10:40', checkIn: '10:50', bought: '11:38', proof: '11:42', ship: '14:00' });
/** A local errand's handover, after the proof (the time `npm run attack` hands over on its local errand). */
export const HANDOVER_AT = '11:50';

/**
 * Wei's side of Mia's Mochi Bunny plush errand at Paper Moon Toys, over the server's HTTP API only: a
 * direct claim at the request's max fee, the check-in with the rendered line photo, "bought", the proof
 * with the rendered receipt and item photos, both PayPal payouts and the shipment with tracking. The
 * photos carry the one-time codes a demo market pins on Wei's first visit there (D-48), so the server
 * must be a fresh demo market whose clock is at or before 10:40. `clock(hhmm)` moves the market clock.
 * Used by the sandbox lifecycle and by `npm run errand` (a hold approved by hand, D-129).
 *
 * `mode: 'local'` plays a local errand instead (D-156): the claim is for local delivery, nothing is
 * captured at the receipt, and at HANDOVER_AT Wei enters the handover code the requester's phone shows
 * (read as the requester), which makes the job's one capture and its one payout.
 */
export async function playQueuerErrand({ api, shared, bidId, clock, step, requesterId = 'mia', mode = 'ship' }) {
  const { HERO, SEED_USERS, findShop, travelMinutes, zonedLocalToEpoch } = shared;
  const sf = (hhmm) => zonedLocalToEpoch(`2026-11-12 ${hhmm}`, 'America/Los_Angeles');
  const shop = findShop(HERO.shopId);
  const wei = SEED_USERS.find((u) => u.id === HERO.queuerId);
  const fixture = (rel) => fs.readFileSync(path.join(PROOFS, rel));
  const T = ERRAND_TIMES;

  if (mode !== 'ship' && mode !== 'local') throw new Error(`Unknown errand mode ${mode}.`);
  // 4. Wei claims the request at its max fee and checks in at the shop with his line photo.
  await clock(T.claim);
  const travel = travelMinutes(wei.home, shop.lngLat);
  const eta = Math.max(sf(T.checkIn), sf(T.claim) + (travel + 1) * 60_000);
  const claim = await api('POST', `/api/bids/${bidId}/claim`, { as: 'wei', body: { qty: 1, etaAt: eta, modes: [mode], from: { lngLat: wei.home, accuracyM: 10 } } });
  const jobId = claim.job.id;
  step('claimed', `${claim.claim.id}, job ${jobId}, fee ${usd(claim.match.feeCents)}`);
  await clock(T.checkIn);
  const line = (await api('POST', '/api/files?purpose=line_photo', { as: 'wei', bytes: fixture('checkin-paper-moon-wei/line.png') })).file;
  await api('POST', `/api/claims/${claim.claim.id}/check-in`, { as: 'wei', body: { lngLat: shop.lngLat, accuracyM: 8, photoFileId: line.id } });
  const checkedIn = await waitFor('the check-in photo check', async () => {
    const c = (await api('GET', `/api/claims/${claim.claim.id}`, { as: 'wei' })).claim;
    if (c.status === 'checked_in') return c;
    if (['lapsed', 'failed', 'cancelled'].includes(c.status)) throw new Error(`The claim ended as ${c.status}.`);
    const records = await api('GET', '/api/ops/records', { as: 'ops' }).catch(() => null);
    const lineProof = records?.proofs?.filter((p) => p.claimId === claim.claim.id && p.kind === 'check_in').at(-1);
    if (lineProof && (lineProof.status === 'failed' || lineProof.status === 'needs_review')) throw new Error(`The line photo check ended as ${lineProof.status}: ${lineProof.summary}`);
    return null;
  }, { timeoutMs: 120_000, everyMs: 1_000 });
  step('checked in', `claim ${checkedIn.id} ${checkedIn.status}`);

  // 5. Bought, then the proof with the rendered receipt and item photos.
  await clock(T.bought);
  await api('POST', `/api/jobs/${jobId}/bought`, { as: 'wei' });
  await clock(T.proof);
  const receipt = (await api('POST', '/api/files?purpose=receipt', { as: 'wei', bytes: fixture('paper-moon-mia-genuine/receipt.png') })).file;
  const item = (await api('POST', '/api/files?purpose=item_photo', { as: 'wei', bytes: fixture('paper-moon-mia-genuine/item.png') })).file;
  await api('POST', `/api/jobs/${jobId}/proof`, { as: 'wei', body: { receiptFileId: receipt.id, itemFileId: item.id } });
  const verified = await waitFor(mode === 'ship' ? 'the receipt check and the receipt capture' : 'the receipt check', async () => {
    const d = await api('GET', `/api/jobs/${jobId}`, { as: requesterId });
    if (d.job.status === 'verified' || d.job.status === 'shipped') return d;
    if (['failed', 'payment_failed', 'disputed'].includes(d.job.status)) throw new Error(`The job ended as ${d.job.status}: ${JSON.stringify(d.job.failure ?? null)}`);
    const p = d.proofs.find((x) => x.kind === 'purchase');
    if (p && p.status === 'needs_review') throw new Error(`The receipt check sent the proof to review: ${p.summary}`);
    return null;
  }, { timeoutMs: 180_000, everyMs: 1_500 });
  const proof = verified.proofs.find((p) => p.kind === 'purchase');
  step('proof', `${proof.status} (${proof.ai?.provider ?? '-'} ${proof.ai?.mode ?? '-'}), retail ${usd(proof.amounts.retailCents)}, capture ${usd(proof.amounts.captureCents)}${mode === 'local' ? ' at the handover' : ''}`);
  const payoutStatus = async (purpose) => {
    const list = (await api('GET', '/api/payouts?mine=1', { as: 'wei' })).payouts;
    return list.find((p) => p.reference === jobId && p.purpose === purpose) ?? null;
  };

  if (mode === 'local') {
    // 5b. Nothing is charged at the receipt: the ledger has no capture for this job yet.
    const before = await api('GET', `/api/bids/${bidId}`, { as: 'ops' });
    const early = before.ledger.filter((e) => e.kind === 'captured' && e.jobId === jobId);
    if (early.length > 0) throw new Error(`A local errand captured at the receipt: ${early.map((e) => `${usd(e.amount.cents)} ${e.status}`).join(', ')}.`);
    step('nothing captured at the receipt', `hold ${before.hold.status} ${usd(before.hold.amount.cents)}, captured ${usd(before.hold.capturedCents)}`);

    // 6. The handover: the requester's phone shows the code, Wei enters it, and the server captures once and pays out.
    await clock(HANDOVER_AT);
    const code = (await api('GET', `/api/jobs/${jobId}`, { as: requesterId })).job.handoverCode;
    if (!code) throw new Error("The requester's phone shows no handover code.");
    const handed = await api('POST', `/api/jobs/${jobId}/handover`, { as: 'wei', body: { code } });
    step('handover', `the requester's code accepted, job ${handed.job.status}`);
    const paid = await waitFor('the payout to succeed at PayPal', async () => {
      const p = await payoutStatus('fee_and_reimbursement');
      if (p && ['failed', 'returned', 'cancelled'].includes(p.status)) throw new Error(`The payout ended as ${p.status}.`);
      return p && p.status === 'succeeded' ? p : null;
    }, { timeoutMs: 240_000, everyMs: 3_000 });
    step('payout', `${paid.id} ${usd(paid.amount.cents)} ${paid.status}`);
    return { claimId: claim.claim.id, jobId, trackingNumber: null, proof, capturedAtReceiptCents: 0, payouts: [paid] };
  }

  const fee = await waitFor('the fee payout to succeed at PayPal', async () => {
    const p = await payoutStatus('fee');
    if (p && ['failed', 'returned', 'cancelled'].includes(p.status)) throw new Error(`The fee payout ended as ${p.status}.`);
    return p && p.status === 'succeeded' ? p : null;
  }, { timeoutMs: 240_000, everyMs: 3_000 });
  step('fee payout', `${fee.id} ${usd(fee.amount.cents)} ${fee.status}`);

  // 6. Shipment: tracking to PayPal, final shipping capture, the rest released, reimbursement.
  await clock(T.ship);
  const label = (await api('POST', '/api/files?purpose=label', { as: 'wei', bytes: LABEL_PNG })).file;
  const trackingNumber = `HPG-2611-${String(Date.now()).slice(-8)}`;
  const shipped = await api('POST', `/api/jobs/${jobId}/shipment`, {
    as: 'wei',
    body: { carrierName: 'Harbor Parcel Ground', trackingNumber, shippingCostCents: 875, dutyPaidCents: 0, labelFileId: label.id },
  });
  step('shipped', `job ${shipped.job.status}, tracking ${trackingNumber}`);
  const reimb = await waitFor('the reimbursement payout to succeed at PayPal', async () => {
    const p = await payoutStatus('reimbursement');
    if (p && ['failed', 'returned', 'cancelled'].includes(p.status)) throw new Error(`The reimbursement payout ended as ${p.status}.`);
    return p && p.status === 'succeeded' ? p : null;
  }, { timeoutMs: 240_000, everyMs: 3_000 });
  step('reimbursement payout', `${reimb.id} ${usd(reimb.amount.cents)} ${reimb.status}`);
  return { claimId: claim.claim.id, jobId, trackingNumber, proof, fee, reimb };
}

/**
 * Runs the lifecycle. `pp` is server/src/paypal, `port` an HmsPayPal on the sandbox (for the checks on PayPal).
 * `local`: the local pickup errand (D-156) instead of the shipped one.
 */
export async function runLifecycle({
  pp,
  port: paypal,
  settings,
  secretsDir,
  payoutLabel,
  payoutEmail,
  headless = true,
  shotDir,
  keep = false,
  serverPort = 8798,
  byHand = false,
  openLink = null,
  waitMinutes = 15,
  local = false,
  log = console.log,
}) {
  const shared = await import(pathToFileURL(path.join(REPO, 'shared', 'src', 'index.ts')).href);
  const { HERO, PAYPAL_PRICING, SEED_USERS, jobSettlement, paypalCaptureFeeCents, platformFeeCents, zonedLocalToEpoch } = shared;
  // The local errand's pair is the attack's handover pair: the demo market pins the receipt's code on it.
  const { ATTACK_HANDOVER } = await import(pathToFileURL(path.join(REPO, 'server', 'src', 'demo', 'attack.ts')).href);
  const sf = (hhmm) => zonedLocalToEpoch(`2026-11-12 ${hhmm}`, 'America/Los_Angeles');
  const NY = { mode: 'ship', country: 'US', region: 'NY', city: 'New York', postalCode: '10012' };
  const mode = local ? 'local' : 'ship';
  const requesterId = local ? ATTACK_HANDOVER.requesterId : HERO.requesterId;
  if (local && ATTACK_HANDOVER.queuerId !== HERO.queuerId) throw new Error(`The local errand's queuer is ${ATTACK_HANDOVER.queuerId}; the rendered line photo is ${HERO.queuerId}'s.`);
  const requester = SEED_USERS.find((u) => u.id === requesterId);
  const destination = local ? { mode: 'local', cityId: requester.cityId } : NY;
  const who = requester.displayName;
  if (!settings.payoutReceiverEmail && !payoutEmail) throw new Error('No payout receiver: set PAYPAL_PAYOUT_EMAIL in sandbox.env (npm run keys) or pass --payout-to <label>.');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hms-lifecycle-'));
  const steps = [];
  const step = (name, detail) => {
    steps.push({ name, detail, at: Date.now() });
    log(`  ${name}${detail ? `: ${detail}` : ''}`);
  };
  // The server reads PAYPAL_PAYOUT_EMAIL from sandbox.env or its environment; a --payout-to receiver goes in the environment.
  const server = await startServer({ port: serverPort, tmp, secretsDir, payoutEmail: payoutEmail ?? settings.payoutReceiverEmail ?? null, log: (l) => log(`  ${l}`) });
  const { api } = server;
  const clock = (hhmm) => api('POST', '/api/demo/clock', { body: { jumpTo: sf(hhmm), paused: true } });
  let buyer = null;
  const result = { ok: false, mode, steps, ids: {}, server: {}, paypal: {}, checks: [], tmp };
  try {
    const health = await api('GET', '/api/health');
    if (health.mode !== 'sandbox') throw new Error(`The server runs in ${health.mode} mode, not sandbox (credentials incomplete?).`);
    const cfg = await api('GET', '/api/config');
    step('server', `mode ${cfg.mode}, AI ${cfg.ai.provider}/${cfg.ai.model} ${cfg.ai.mode}`);
    result.ai = cfg.ai;

    // 1. The requester's hold: Mia's, shipped to New York, or Sam's, a local pickup in San Francisco.
    await clock('10:31');
    const quote = await api('POST', '/api/bids/quote', { as: requesterId, body: { shopId: HERO.shopId, itemId: HERO.itemId, qty: 1, destination } });
    const created = await api('POST', '/api/bids', {
      as: requesterId,
      idem: `lifecycle-${Date.now()}`,
      body: {
        shopId: HERO.shopId,
        itemId: HERO.itemId,
        qty: 1,
        retailCapCents: quote.suggested.retailCapCents,
        maxFeeCents: quote.suggested.maxFeeCents,
        shippingBudgetCents: quote.suggested.shippingBudgetCents,
        destination,
        deadlineAt: sf('10:31') + 2 * 86_400_000,
        funding: 'paypal',
        agent: null,
      },
    });
    const bidId = created.bid.id;
    const orderId = created.checkout.orderId;
    result.ids.bid = bidId;
    result.ids.order = orderId;
    result.request = { requester: requesterId, mode, retailCapCents: created.bid.retailCapCents, maxFeeCents: created.bid.maxFeeCents, shippingBudgetCents: created.bid.shippingBudgetCents };
    step('bid', `${bidId} (${who}, ${mode === 'local' ? 'local pickup' : 'shipped'}), hold ${usd(created.hold.amount.cents)}, PayPal order ${orderId} (${created.checkout.mode}, next ${created.checkout.next})`);
    if (created.checkout.mode !== 'sandbox') throw new Error('The bid did not go to the PayPal sandbox.');

    // 2. The sandbox buyer approves on PayPal's page: in a headless browser with the saved login, or by hand (D-129).
    const order = await paypal.getOrder(orderId);
    if (!order.approveUrl) throw new Error('PayPal returned no approval link for the order.');
    if (byHand) {
      log(`  Approve the ${usd(created.hold.amount.cents)} hold as your sandbox buyer on PayPal's page (no password is stored):`);
      log(`    ${order.approveUrl}`);
      if (openLink) openLink(order.approveUrl);
      log(`  Waiting up to ${waitMinutes} minutes for PayPal to report the order approved...`);
      await waitFor('your approval on PayPal', async () => (await paypal.getOrder(orderId)).status === 'APPROVED', { timeoutMs: waitMinutes * 60_000, everyMs: 5_000 });
      step('approved', `order ${orderId} approved by hand`);
    } else {
      const { openSandboxBuyer } = await import('./sandbox-buyer.mjs');
      buyer = await openSandboxBuyer({ secretsDir, headless, shotDir, log: (l) => log(`    ${l}`) });
      await buyer.approve(order.approveUrl, { returnUrl: `http://127.0.0.1:${serverPort}/api/paypal/return`, cancelUrl: `http://127.0.0.1:${serverPort}/api/paypal/cancel`, label: 'lifecycle order' });
      await buyer.close();
      buyer = null;
      step('approved', `order ${orderId} approved by the sandbox buyer`);
    }

    // 3. Authorize through the server.
    const auth = await api('POST', `/api/bids/${bidId}/authorize`, { as: requesterId, body: { orderId } });
    result.ids.authorization = auth.hold.authorizationId;
    result.ids.hold = auth.hold.id;
    step('authorized', `${auth.hold.authorizationId}, hold ${auth.hold.status} ${usd(auth.hold.amount.cents)}, bid ${auth.bid.status}`);

    // 4 to 6. Wei's side of the errand: claim, check-in, purchase, proof, then payouts and the shipment, or
    // the handover with the requester's code (shared with npm run errand).
    const errand = await playQueuerErrand({ api, shared, bidId, clock, step, requesterId, mode });
    const { jobId, trackingNumber } = errand;
    Object.assign(result.ids, { claim: errand.claimId, job: jobId, tracking: trackingNumber });

    // 7. What the server says.
    const bid = await api('GET', `/api/bids/${bidId}`, { as: requesterId });
    const ledger = (await api('GET', `/api/ledger?mine=1&bidId=${encodeURIComponent(bidId)}`, { as: requesterId })).entries.slice().reverse();
    const opsPayouts = (await api('GET', '/api/payouts', { as: 'ops' })).payouts.filter((p) => p.reference === jobId);
    const job = (await api('GET', `/api/jobs/${jobId}`, { as: 'ops' })).job;
    result.server = {
      hold: { status: bid.hold.status, amountCents: bid.hold.amount.cents, capturedCents: bid.hold.capturedCents, releasedCents: bid.hold.releasedCents },
      ledger: ledger.map((e) => ({
        kind: e.kind,
        cents: e.amount.cents,
        status: e.status,
        mode: e.mode,
        // Which part of the job a capture paid for (its idempotency key, cap:<job>:<part>), never sent anywhere.
        part: e.kind === 'captured' ? (/^cap:[^:]+:([a-z]+)/.exec(e.idempotencyKey)?.[1] ?? null) : null,
        captureId: e.paypal?.captureId ?? null,
        authorizationId: e.paypal?.authorizationId ?? null,
        feeCents: e.paypal?.feeCents ?? null,
      })),
      payouts: opsPayouts.map((p) => ({ id: p.id, purpose: p.purpose, cents: p.amount.cents, status: p.status, batchId: p.paypalBatchId, itemId: p.paypalItemId, feeCents: p.paypalFeeCents ?? null })),
      job: { status: job.status, mode: job.mode, feeCents: job.feeCents, qty: job.qty, amounts: job.amounts },
    };

    // 8. What PayPal says.
    const pa = await paypal.getAuthorization(result.ids.authorization);
    const po = await paypal.getOrder(orderId);
    const captureIds = result.server.ledger.filter((e) => e.kind === 'captured').map((e) => e.captureId).filter(Boolean);
    const captures = [];
    for (const id of captureIds) captures.push(await paypal.getCapture(id));
    const batches = [];
    for (const p of result.server.payouts) if (p.batchId) batches.push({ purpose: p.purpose, batch: await paypal.getPayoutBatch(p.batchId) });
    result.paypal = {
      authorization: { id: pa.authorizationId, status: pa.status, amountCents: pa.amountCents },
      order: { id: po.orderId, status: po.status, shipTo: po.shipTo ? po.shipTo.country : null, trackers: po.trackers.map((t) => ({ trackingNumber: t.trackingNumber, captureId: t.captureId, status: t.status })) },
      captures: captures.map((c) => ({ id: c.captureId, status: c.status, amountCents: c.amountCents, finalCapture: c.finalCapture, paypalFeeCents: c.paypalFeeCents })),
      payouts: batches.map(({ purpose, batch }) => ({ purpose, batchId: batch.batchId, batchStatus: batch.batchStatus, items: batch.items.map((i) => ({ itemId: i.itemId, status: i.status, amountCents: i.amountCents, feeCents: i.feeCents ?? null })) })),
    };

    // 9. Compare.
    const check = (name, ok, detail) => {
      result.checks.push({ name, ok, detail });
      log(`  [${ok ? 'OK' : 'MISMATCH'}] ${name}: ${detail}`);
    };
    const serverCaptured = result.server.ledger.filter((e) => e.kind === 'captured' && e.status === 'succeeded').reduce((s, e) => s + e.cents, 0);
    const serverReleased = result.server.ledger.filter((e) => e.kind === 'released' && e.status === 'succeeded').reduce((s, e) => s + e.cents, 0);
    const paypalCaptured = result.paypal.captures.filter((c) => c.status === 'COMPLETED').reduce((s, c) => s + c.amountCents, 0);
    check('authorization amount', pa.amountCents === result.server.hold.amountCents, `PayPal ${usd(pa.amountCents)}, server hold ${usd(result.server.hold.amountCents)}`);
    check('authorization closed', pa.status === 'CAPTURED' && result.server.hold.status === 'captured', `PayPal ${pa.status}, server ${result.server.hold.status}`);
    check('captured total', paypalCaptured === serverCaptured && serverCaptured === result.server.hold.capturedCents, `PayPal ${usd(paypalCaptured)} in ${result.paypal.captures.length} captures, ledger ${usd(serverCaptured)}`);
    check('released rest', serverReleased === pa.amountCents - paypalCaptured && serverReleased === result.server.hold.releasedCents, `ledger ${usd(serverReleased)}, PayPal remainder ${usd(pa.amountCents - paypalCaptured)}`);
    check(
      'capture by capture',
      captureIds.length === result.paypal.captures.length && result.server.ledger.filter((e) => e.kind === 'captured').every((e) => result.paypal.captures.some((c) => c.id === e.captureId && c.amountCents === e.cents && c.status === 'COMPLETED')),
      result.paypal.captures.map((c) => `${c.id} ${usd(c.amountCents)} ${c.status}${c.finalCapture ? ' final' : ''}`).join(', '),
    );
    if (mode === 'ship') {
      check('tracking on the order', result.paypal.order.trackers.some((t) => t.trackingNumber === trackingNumber), result.paypal.order.trackers.map((t) => `${t.trackingNumber} ${t.status ?? ''}`).join(', ') || 'none');
    } else {
      // A PICKUP_FROM_PERSON order: PayPal keeps no ship-to address and the job adds no tracker.
      check(
        'no shipping on the order',
        result.paypal.order.shipTo === null && result.paypal.order.trackers.length === 0 && result.server.job.mode === 'local',
        `PayPal ship-to ${result.paypal.order.shipTo ?? 'none'}, trackers ${result.paypal.order.trackers.length === 0 ? 'none' : result.paypal.order.trackers.map((t) => t.trackingNumber).join(', ')}; server job ${result.server.job.mode}, ${result.server.job.status}`,
      );
      const serverCaptures = result.server.ledger.filter((e) => e.kind === 'captured');
      const only = result.paypal.captures[0] ?? null;
      check(
        'one capture at the handover',
        errand.capturedAtReceiptCents === 0 &&
          serverCaptures.length === 1 &&
          serverCaptures[0].part === 'handover' &&
          result.paypal.captures.length === 1 &&
          only.status === 'COMPLETED' &&
          only.finalCapture === true &&
          result.server.job.status === 'delivered',
        `nothing captured at the receipt; ${only ? `${only.id} ${usd(only.amountCents)} ${only.status}${only.finalCapture ? ' final' : ''}` : 'no capture'} (ledger part ${serverCaptures.map((e) => e.part ?? '-').join(', ') || 'none'}) after the requester's code; job ${result.server.job.status}`,
      );
    }
    check(
      'payouts',
      result.server.payouts.length === result.paypal.payouts.length &&
        result.server.payouts.every((p) => result.paypal.payouts.some((b) => b.batchId === p.batchId && b.items.some((i) => i.itemId === p.itemId && i.amountCents === p.cents && i.status === 'SUCCESS'))),
      result.paypal.payouts.map((b) => `${b.purpose} ${b.batchId}: ${b.items.map((i) => `${usd(i.amountCents)} ${i.status}`).join(', ')} (batch ${b.batchStatus})`).join('; '),
    );
    // PayPal's own fees (D-105, D-120): what PayPal charged, what the server recorded, and the schedule.
    const captureFees = result.server.ledger
      .filter((e) => e.kind === 'captured')
      .map((e) => ({ e, c: result.paypal.captures.find((c) => c.id === e.captureId) ?? null, schedule: paypalCaptureFeeCents(e.cents) }));
    check(
      'PayPal fee on each capture',
      captureFees.length > 0 && captureFees.every(({ e, c, schedule }) => c !== null && c.paypalFeeCents !== null && c.paypalFeeCents === e.feeCents && c.paypalFeeCents === schedule),
      captureFees.map(({ e, c, schedule }) => `${usd(e.cents)} capture: PayPal ${c?.paypalFeeCents == null ? 'none' : usd(c.paypalFeeCents)}, ledger ${e.feeCents == null ? 'none' : usd(e.feeCents)}, schedule ${usd(schedule)}`).join('; '),
    );
    const itemFees = result.server.payouts.map((p) => ({ p, item: result.paypal.payouts.find((b) => b.batchId === p.batchId)?.items.find((i) => i.itemId === p.itemId) ?? null }));
    check(
      'PayPal fee on each payout item',
      itemFees.length > 0 && itemFees.every(({ p, item }) => item !== null && item.feeCents !== null && item.feeCents === p.feeCents && item.feeCents === PAYPAL_PRICING.payoutItemCents),
      itemFees.map(({ p, item }) => `${p.purpose} ${usd(p.cents)}: PayPal ${item?.feeCents == null ? 'none' : usd(item.feeCents)}, server ${p.feeCents == null ? 'none' : usd(p.feeCents)}, schedule ${usd(PAYPAL_PRICING.payoutItemCents)}`).join('; '),
    );
    const paypalFees = captureFees.reduce((s, { c }) => s + (c?.paypalFeeCents ?? 0), 0) + itemFees.reduce((s, { item }) => s + (item?.feeCents ?? 0), 0);
    const amounts = result.server.job.amounts;
    const settled = jobSettlement(amounts);
    const keep = platformFeeCents(result.server.job.feeCents) * result.server.job.qty;
    check(
      'processing at cost',
      amounts.processingCents === paypalFees && amounts.paypalFeesCents === paypalFees && settled.platformCents === keep && settled.processingVarianceCents === 0,
      `processing line ${usd(amounts.processingCents ?? 0)}, PayPal's fees ${usd(paypalFees)} (server ${usd(amounts.paypalFeesCents ?? 0)}); charged ${usd(settled.chargedCents)} - paid out ${usd(settled.paidOutCents)} - PayPal ${usd(paypalFees)} = HoldMySpot ${usd(settled.platformCents)}, 10% of the ${usd(result.server.job.feeCents)} fee is ${usd(keep)}`,
    );
    result.ok = result.checks.every((c) => c.ok);
    return result;
  } finally {
    if (buyer) await buyer.close().catch(() => {});
    await server.stop();
    result.serverLog = server.logFile;
    if (!keep && result.ok) fs.rmSync(tmp, { recursive: true, force: true });
  }
}
