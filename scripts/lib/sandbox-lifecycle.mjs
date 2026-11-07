// HoldMySpot: one full job through the server's HTTP API on the REAL PayPal sandbox, then a
// check on PayPal itself that the money moved exactly as the server's ledger says.
//
//   node scripts/sandbox-gates.mjs lifecycle --payout-to person-1 [--headed] [--keep]
//
// It starts its own server (HMS_MODE=sandbox, port 8798 by default, a temporary database and
// upload folder, demo staging so the rendered hero photos carry the right codes, recorded AI
// answers), plays Mia (requester) and Wei (queuer) at Paper Moon Toys over HTTP only, approves
// the PayPal order in a browser as the sandbox buyer (scripts/lib/sandbox-buyer.mjs), and stops
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

function client(base) {
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

async function waitFor(what, fn, { timeoutMs = 60_000, everyMs = 1_000 } = {}) {
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
  if (payoutEmail) env.PAYPAL_TW_PAYOUT_EMAIL = payoutEmail;
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

/** Runs the lifecycle. `pp` is server/src/paypal, `port` an HmsPayPal on the sandbox (for the checks on PayPal). */
export async function runLifecycle({ pp, port: paypal, settings, secretsDir, payoutLabel, payoutEmail, headless = true, shotDir, keep = false, serverPort = 8798, log = console.log }) {
  const shared = await import(pathToFileURL(path.join(REPO, 'shared', 'src', 'index.ts')).href);
  const { HERO, PAYPAL_PRICING, SEED_USERS, findShop, jobSettlement, paypalCaptureFeeCents, platformFeeCents, travelMinutes, zonedLocalToEpoch } = shared;
  const sf = (hhmm) => zonedLocalToEpoch(`2026-11-12 ${hhmm}`, 'America/Los_Angeles');
  const shop = findShop(HERO.shopId);
  const wei = SEED_USERS.find((u) => u.id === HERO.queuerId);
  const NY = { mode: 'ship', country: 'US', region: 'NY', city: 'New York', postalCode: '10012' };
  const fixture = (rel) => fs.readFileSync(path.join(PROOFS, rel));
  if (!settings.twPayoutEmail && !payoutEmail) throw new Error('No payout receiver: set PAYPAL_TW_PAYOUT_EMAIL in sandbox.env or pass --payout-to <label>.');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hms-lifecycle-'));
  const steps = [];
  const step = (name, detail) => {
    steps.push({ name, detail, at: Date.now() });
    log(`  ${name}${detail ? `: ${detail}` : ''}`);
  };
  // The server reads PAYPAL_TW_PAYOUT_EMAIL from sandbox.env or its environment; a --payout-to receiver goes in the environment.
  const server = await startServer({ port: serverPort, tmp, secretsDir, payoutEmail: payoutEmail ?? settings.twPayoutEmail ?? null, log: (l) => log(`  ${l}`) });
  const { api } = server;
  const clock = (hhmm) => api('POST', '/api/demo/clock', { body: { jumpTo: sf(hhmm), paused: true } });
  let buyer = null;
  const result = { ok: false, steps, ids: {}, server: {}, paypal: {}, checks: [], tmp };
  try {
    const health = await api('GET', '/api/health');
    if (health.mode !== 'sandbox') throw new Error(`The server runs in ${health.mode} mode, not sandbox (credentials incomplete?).`);
    const cfg = await api('GET', '/api/config');
    step('server', `mode ${cfg.mode}, AI ${cfg.ai.provider}/${cfg.ai.model} ${cfg.ai.mode}`);
    result.ai = cfg.ai;

    // 1. Mia's hold.
    await clock('10:31');
    const quote = await api('POST', '/api/bids/quote', { as: 'mia', body: { shopId: HERO.shopId, itemId: HERO.itemId, qty: 1, destination: NY } });
    const created = await api('POST', '/api/bids', {
      as: 'mia',
      idem: `lifecycle-${Date.now()}`,
      body: {
        shopId: HERO.shopId,
        itemId: HERO.itemId,
        qty: 1,
        retailCapCents: quote.suggested.retailCapCents,
        maxFeeCents: quote.suggested.maxFeeCents,
        shippingBudgetCents: quote.suggested.shippingBudgetCents,
        destination: NY,
        deadlineAt: sf('10:31') + 2 * 86_400_000,
        funding: 'paypal',
        agent: null,
      },
    });
    const bidId = created.bid.id;
    const orderId = created.checkout.orderId;
    result.ids.bid = bidId;
    result.ids.order = orderId;
    step('bid', `${bidId}, hold ${usd(created.hold.amount.cents)}, PayPal order ${orderId} (${created.checkout.mode}, next ${created.checkout.next})`);
    if (created.checkout.mode !== 'sandbox') throw new Error('The bid did not go to the PayPal sandbox.');

    // 2. The sandbox buyer approves on PayPal's page.
    const order = await paypal.getOrder(orderId);
    if (!order.approveUrl) throw new Error('PayPal returned no approval link for the order.');
    const { openSandboxBuyer } = await import('./sandbox-buyer.mjs');
    buyer = await openSandboxBuyer({ secretsDir, headless, shotDir, log: (l) => log(`    ${l}`) });
    await buyer.approve(order.approveUrl, { returnUrl: `http://127.0.0.1:${serverPort}/api/paypal/return`, cancelUrl: `http://127.0.0.1:${serverPort}/api/paypal/cancel`, label: 'lifecycle order' });
    await buyer.close();
    buyer = null;
    step('approved', `order ${orderId} approved by the sandbox buyer`);

    // 3. Authorize through the server.
    const auth = await api('POST', `/api/bids/${bidId}/authorize`, { as: 'mia', body: { orderId } });
    result.ids.authorization = auth.hold.authorizationId;
    result.ids.hold = auth.hold.id;
    step('authorized', `${auth.hold.authorizationId}, hold ${auth.hold.status} ${usd(auth.hold.amount.cents)}, bid ${auth.bid.status}`);

    // 4. Wei claims the request at its max fee and checks in at the shop with his line photo.
    await clock('10:40');
    const travel = travelMinutes(wei.home, shop.lngLat);
    const eta = Math.max(sf('10:50'), sf('10:40') + (travel + 1) * 60_000);
    const claim = await api('POST', `/api/bids/${bidId}/claim`, { as: 'wei', body: { qty: 1, etaAt: eta, modes: ['ship'], from: { lngLat: wei.home, accuracyM: 10 } } });
    result.ids.claim = claim.claim.id;
    result.ids.job = claim.job.id;
    const jobId = claim.job.id;
    step('claimed', `${claim.claim.id}, job ${jobId}, fee ${usd(claim.match.feeCents)}`);
    await clock('10:50');
    const line = (await api('POST', '/api/files?purpose=line_photo', { as: 'wei', bytes: fixture('checkin-paper-moon-wei/line.png') })).file;
    await api('POST', `/api/claims/${claim.claim.id}/check-in`, { as: 'wei', body: { lngLat: shop.lngLat, accuracyM: 8, photoFileId: line.id } });
    const checkedIn = await waitFor('the check-in photo check', async () => {
      const c = (await api('GET', `/api/claims/${claim.claim.id}`, { as: 'wei' })).claim;
      if (c.status === 'checked_in') return c;
      if (['lapsed', 'failed', 'cancelled'].includes(c.status)) throw new Error(`The claim ended as ${c.status}.`);
      return null;
    });
    step('checked in', `claim ${checkedIn.id} ${checkedIn.status}`);

    // 5. Bought, then the proof with the rendered receipt and item photos.
    await clock('11:38');
    await api('POST', `/api/jobs/${jobId}/bought`, { as: 'wei' });
    await clock('11:42');
    const receipt = (await api('POST', '/api/files?purpose=receipt', { as: 'wei', bytes: fixture('paper-moon-mia-genuine/receipt.png') })).file;
    const item = (await api('POST', '/api/files?purpose=item_photo', { as: 'wei', bytes: fixture('paper-moon-mia-genuine/item.png') })).file;
    await api('POST', `/api/jobs/${jobId}/proof`, { as: 'wei', body: { receiptFileId: receipt.id, itemFileId: item.id } });
    const verified = await waitFor('the receipt check and the receipt capture', async () => {
      const d = await api('GET', `/api/jobs/${jobId}`, { as: 'mia' });
      if (d.job.status === 'verified' || d.job.status === 'shipped') return d;
      if (['failed', 'payment_failed', 'disputed'].includes(d.job.status)) throw new Error(`The job ended as ${d.job.status}: ${JSON.stringify(d.job.failure ?? null)}`);
      return null;
    }, { timeoutMs: 120_000, everyMs: 1_500 });
    const proof = verified.proofs.find((p) => p.kind === 'purchase');
    step('proof', `${proof.status} (${proof.stamp?.provider ?? '-'} ${proof.stamp?.mode ?? '-'}), retail ${usd(proof.amounts.retailCents)}, capture ${usd(proof.amounts.captureCents)}`);
    const payoutStatus = async (purpose) => {
      const list = (await api('GET', '/api/payouts?mine=1', { as: 'wei' })).payouts;
      return list.find((p) => p.reference === jobId && p.purpose === purpose) ?? null;
    };
    const fee = await waitFor('the fee payout to succeed at PayPal', async () => {
      const p = await payoutStatus('fee');
      if (p && ['failed', 'returned', 'cancelled'].includes(p.status)) throw new Error(`The fee payout ended as ${p.status}.`);
      return p && p.status === 'succeeded' ? p : null;
    }, { timeoutMs: 240_000, everyMs: 3_000 });
    step('fee payout', `${fee.id} ${usd(fee.amount.cents)} ${fee.status}`);

    // 6. Shipment: tracking to PayPal, final shipping capture, the rest released, reimbursement.
    await clock('14:00');
    const label = (await api('POST', '/api/files?purpose=label', { as: 'wei', bytes: LABEL_PNG })).file;
    const trackingNumber = `HPG-2611-${String(Date.now()).slice(-8)}`;
    const shipped = await api('POST', `/api/jobs/${jobId}/shipment`, {
      as: 'wei',
      body: { carrierName: 'Harbor Parcel Ground', trackingNumber, shippingCostCents: 875, dutyPaidCents: 0, labelFileId: label.id },
    });
    result.ids.tracking = trackingNumber;
    step('shipped', `job ${shipped.job.status}, tracking ${trackingNumber}`);
    const reimb = await waitFor('the reimbursement payout to succeed at PayPal', async () => {
      const p = await payoutStatus('reimbursement');
      if (p && ['failed', 'returned', 'cancelled'].includes(p.status)) throw new Error(`The reimbursement payout ended as ${p.status}.`);
      return p && p.status === 'succeeded' ? p : null;
    }, { timeoutMs: 240_000, everyMs: 3_000 });
    step('reimbursement payout', `${reimb.id} ${usd(reimb.amount.cents)} ${reimb.status}`);

    // 7. What the server says.
    const bid = await api('GET', `/api/bids/${bidId}`, { as: 'mia' });
    const ledger = (await api('GET', '/api/ledger?mine=1', { as: 'mia' })).entries.slice().reverse();
    const opsPayouts = (await api('GET', '/api/payouts', { as: 'ops' })).payouts.filter((p) => p.reference === jobId);
    const job = (await api('GET', `/api/jobs/${jobId}`, { as: 'ops' })).job;
    result.server = {
      hold: { status: bid.hold.status, amountCents: bid.hold.amount.cents, capturedCents: bid.hold.capturedCents, releasedCents: bid.hold.releasedCents },
      ledger: ledger.map((e) => ({ kind: e.kind, cents: e.amount.cents, status: e.status, mode: e.mode, captureId: e.paypal?.captureId ?? null, authorizationId: e.paypal?.authorizationId ?? null, feeCents: e.paypal?.feeCents ?? null })),
      payouts: opsPayouts.map((p) => ({ id: p.id, purpose: p.purpose, cents: p.amount.cents, status: p.status, batchId: p.paypalBatchId, itemId: p.paypalItemId, feeCents: p.paypalFeeCents ?? null })),
      job: { feeCents: job.feeCents, qty: job.qty, amounts: job.amounts },
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
      order: { id: po.orderId, status: po.status, trackers: po.trackers.map((t) => ({ trackingNumber: t.trackingNumber, captureId: t.captureId, status: t.status })) },
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
    check('tracking on the order', result.paypal.order.trackers.some((t) => t.trackingNumber === trackingNumber), result.paypal.order.trackers.map((t) => `${t.trackingNumber} ${t.status ?? ''}`).join(', ') || 'none');
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
