import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERO, SEED_USERS, findShop, travelMinutes, zonedLocalToEpoch } from '@holdmyspot/shared';
import type { LngLat } from '@holdmyspot/shared';
import { SERVER_ROOT } from '../src/config.ts';
import { pinFixtureCode } from '../src/demo/fixtures.ts';
import { placeholderPng } from '../src/util/images.ts';
import { DAY, MIN, testServer, type TestServer } from './helpers.ts';

/**
 * End to end in fake mode, over HTTP only (the contract), with both real
 * services behind their ports and no network:
 * - PayPal: the sandbox REST client (server/src/paypal) answering from the
 *   in-process emulator, so every money call is a real Orders, Payments,
 *   Tracking or Payouts request body and response;
 * - AI: the AI services (server/src/ai) without a key, so photos are read
 *   from the rendered fixtures' truth sidecars (rules only), with the receipt
 *   QR decoded from the pixels, perceptual hashes and the shared rules.
 *
 * Story, at Paper Moon Toys in San Francisco (the Mochi Bunny plush, one per
 * customer): two US requesters hold money (PayPal and Venmo); Wei's fee clock
 * steps down and meets Mia's request; Rex claims Sam's request and never
 * checks in (his claim lapses and the request goes back to the book), and
 * Lin's offer takes it; the receipts pass; partial captures, payouts,
 * tracking, final captures and releases follow. A second market covers a
 * sell-out: the queuer reports it and the hold is voided.
 */

const sf = (hhmm: string) => zonedLocalToEpoch(`2026-11-12 ${hhmm}`, 'America/Los_Angeles')!;
const FIXTURES = join(SERVER_ROOT, 'fixtures', 'proofs');
const fixture = (rel: string) => readFileSync(join(FIXTURES, rel));
const home = (id: string): LngLat => SEED_USERS.find((u) => u.id === id)!.home!;
const SHOP = findShop(HERO.shopId)!;
const BAKERY = findShop('sugar-cloud-bakery')!;
const NY = { mode: 'ship', country: 'US', region: 'NY', city: 'New York', postalCode: '10012' } as const;
const SF = { mode: 'ship', country: 'US', region: 'CA', city: 'San Francisco', postalCode: '94110' } as const;

/** Every call must succeed; returns the JSON body. */
async function ok(s: TestServer, method: 'GET' | 'POST' | 'PATCH', url: string, opts: Parameters<TestServer['call']>[2] = {}) {
  const res = await s.call(method, url, opts);
  assert.ok(res.status >= 200 && res.status < 300, `${method} ${url} answered ${res.status}: ${JSON.stringify(res.json)}`);
  return res.json;
}

async function upload(s: TestServer, as: string, purpose: string, bytes: Uint8Array, scenario?: string) {
  const q = scenario ? `&fixture=${scenario}` : '';
  return (await ok(s, 'POST', `/api/files?purpose=${purpose}${q}`, { as, body: bytes })).file;
}

/** Quote, create, approve in the simulated PayPal sheet, authorize: the hold is in place. */
async function holdBid(s: TestServer, as: string, req: { shopId: string; itemId: string; qty: number; destination: object; maxFeeCents?: number; funding: 'paypal' | 'venmo' }) {
  const quote = await ok(s, 'POST', '/api/bids/quote', { as, body: { shopId: req.shopId, itemId: req.itemId, qty: req.qty, destination: req.destination } });
  const created = await ok(s, 'POST', '/api/bids', {
    as,
    idem: `create-${as}-${req.itemId}`,
    body: {
      shopId: req.shopId,
      itemId: req.itemId,
      qty: req.qty,
      retailCapCents: quote.suggested.retailCapCents,
      maxFeeCents: req.maxFeeCents ?? quote.suggested.maxFeeCents,
      shippingBudgetCents: quote.suggested.shippingBudgetCents,
      destination: req.destination,
      deadlineAt: s.app.now() + 2 * DAY,
      funding: req.funding,
      agent: null,
    },
  });
  assert.equal(created.bid.status, 'awaiting_approval');
  assert.equal(created.checkout.next, 'fake_approve');
  const approved = await ok(s, 'POST', `/api/fake/paypal/orders/${created.checkout.orderId}/approve`, { body: { funding: req.funding, outcome: 'approve' } });
  assert.equal(approved.status, 'APPROVED');
  const authorized = await ok(s, 'POST', `/api/bids/${created.bid.id}/authorize`, { as, body: { orderId: created.checkout.orderId } });
  return { quote, created, authorized };
}

describe('end to end over HTTP: holds, a stepping fee clock, a no-show, AI-read receipts, captures, tracking, payouts', () => {
  let s: TestServer;
  type Ref = 'miaBid' | 'miaOrder' | 'miaAuth' | 'samBid' | 'samAuth' | 'weiAsk' | 'weiClaim' | 'linAsk' | 'linClaim' | 'rexClaim' | 'rexJob' | 'miaJob' | 'samJob';
  const ids = {} as Record<Ref, string>;

  before(async () => {
    s = await testServer({ ai: 'real' });
    // The rendered photos show fixed codes; a deterministic market pins them on the records (demo staging).
    assert.ok(pinFixtureCode(s.app, 'checkin', `wei@${HERO.shopId}`, 'checkin-paper-moon-wei'));
    assert.ok(pinFixtureCode(s.app, 'proof', `mia>wei@${HERO.shopId}`, 'paper-moon-mia-genuine'));
    assert.ok(pinFixtureCode(s.app, 'proof', `sam>lin@${HERO.shopId}`, 'paper-moon-priya-genuine'));
  });
  after(() => s.done());

  it('runs fake mode on the sandbox REST client and the real AI services, with no keys', async () => {
    const config = await ok(s, 'GET', '/api/config');
    assert.equal(config.mode, 'fake');
    assert.deepEqual(config.ai, { provider: 'fake', model: 'rules-v1', mode: 'replay' });
    assert.equal(s.app.fakePayPal.mode, 'fake');
    assert.equal(typeof s.app.ai.dHash, 'function', 'the AI services hash uploads');
  });

  it('Mia in New York holds $63.70 for one plush, shipped to her (the processing reserve included)', async () => {
    await s.at(sf('10:31'));
    const { quote, created, authorized } = await holdBid(s, 'mia', { shopId: HERO.shopId, itemId: HERO.itemId, qty: 1, destination: NY, funding: 'paypal' });
    assert.deepEqual(quote.suggested, { retailCapCents: 3600, maxFeeCents: 1200, shippingBudgetCents: 1200 });
    assert.equal(quote.limitCents, 6370);
    assert.equal(quote.processingReserveCents, 370);
    ids.miaBid = created.bid.id;
    ids.miaOrder = created.checkout.orderId;
    assert.equal(authorized.bid.status, 'open');
    assert.equal(authorized.hold.status, 'held');
    assert.equal(authorized.hold.amount.cents, 6370);
    assert.match(authorized.hold.authorizationId, /^FAKE-AUTH-\d{4}$/);
    ids.miaAuth = authorized.hold.authorizationId;
    // What PayPal itself holds: an authorized order carrying our invoice id.
    assert.deepEqual(s.app.fakePayPal.inspectAuthorization(ids.miaAuth)?.status, 'CREATED');
    assert.equal(s.app.fakePayPal.inspectOrder(ids.miaOrder)?.invoiceId, `HMS-${ids.miaBid}`);
    const ledger = await ok(s, 'GET', '/api/ledger?mine=1', { as: 'mia' });
    assert.deepEqual(ledger.entries.map((e: any) => [e.kind, e.amount.cents, e.status, e.mode]), [['held', 6370, 'succeeded', 'fake']]);
  });

  it('Sam in San Francisco holds one plush with Venmo, max fee $10', async () => {
    await s.at(sf('10:32'));
    const { created, authorized } = await holdBid(s, 'sam', { shopId: HERO.shopId, itemId: HERO.itemId, qty: 1, destination: SF, maxFeeCents: 1000, funding: 'venmo' });
    ids.samBid = created.bid.id;
    ids.samAuth = authorized.hold.authorizationId;
    assert.equal(authorized.hold.status, 'held');
    assert.equal(authorized.hold.fundingSource, 'venmo');
    const book = await ok(s, 'GET', `/api/books/${HERO.shopId}/${HERO.itemId}`);
    assert.equal(book.book.bids.count, 2, 'two requests light up the shop before anyone queues');
    assert.equal(book.book.bids.bestFeeCents, 1200);
    assert.equal(book.book.bids.latestDeadlineAt, sf('10:32') + 2 * DAY);
  });

  it('Wei posts an offer bound to the shop: $15, down $1 every 5 minutes to $8, clock starting at check-in', async () => {
    await s.at(sf('10:35'));
    const out = await ok(s, 'POST', '/api/asks', {
      as: 'wei',
      body: {
        shopId: HERO.shopId,
        itemId: HERO.itemId,
        capacity: 1,
        modes: ['ship'],
        feeCents: 1500,
        clock: { stepCents: 100, intervalMs: 5 * MIN, floorCents: 800 },
        etaAt: sf('10:50'),
        from: { lngLat: home('wei'), accuracyM: 10 },
      },
    });
    ids.weiAsk = out.ask.id;
    ids.weiClaim = out.claim.id;
    assert.equal(out.ask.status, 'open');
    assert.equal(out.claim.status, 'awaiting_arrival');
    assert.equal(out.matches.length, 0, 'the clock has not started, $15 is above every request');
    const detail = await ok(s, 'GET', `/api/claims/${ids.weiClaim}`, { as: 'wei' });
    assert.equal(detail.claim.checkInCode, 'M4RT7', 'the code his line photo shows');
  });

  it("Rex claims Sam's request at its $10 max fee, with a short arrival window", async () => {
    await s.at(sf('10:40'));
    const eta = sf('10:40') + (travelMinutes(home('rex'), SHOP.lngLat) + 1) * MIN;
    const out = await ok(s, 'POST', `/api/bids/${ids.samBid}/claim`, { as: 'rex', body: { qty: 1, etaAt: eta, modes: ['ship'], from: { lngLat: home('rex'), accuracyM: 12 } } });
    ids.rexClaim = out.claim.id;
    ids.rexJob = out.job.id;
    assert.equal(out.job.status, 'claimed');
    assert.equal(out.match.feeCents, 1000);
    assert.ok(out.claim.windowEndsAt <= sf('11:05'), "the window ends before Wei's clock meets Mia");
    const sam = await ok(s, 'GET', `/api/bids/${ids.samBid}`, { as: 'sam' });
    assert.equal(sam.bid.status, 'matched');
  });

  it('Wei checks in with a photo of the line; the AI reads his code from the photo and the clock starts', async () => {
    await s.at(sf('10:50'));
    const line = await upload(s, 'wei', 'line_photo', fixture('checkin-paper-moon-wei/line.png'));
    assert.match(line.dHash, /^[0-9a-f]{16}$/, 'the AI services hashed the upload');
    const out = await ok(s, 'POST', `/api/claims/${ids.weiClaim}/check-in`, { as: 'wei', body: { lngLat: SHOP.lngLat, accuracyM: 8, photoFileId: line.id } });
    assert.equal(out.claim.status, 'arrived');
    assert.equal(out.proof.status, 'verifying');
    await s.app.idle();
    const detail = await ok(s, 'GET', `/api/claims/${ids.weiClaim}`, { as: 'wei' });
    assert.equal(detail.claim.status, 'checked_in');
    assert.equal(detail.ask.clock.startsAt, sf('10:50'));
    const proof = s.app.store.proofs.must(out.proof.id);
    assert.equal(proof.status, 'passed');
    assert.equal(proof.peopleAhead, 40, 'counted from the rendered photo, not simulated');
  });

  it("Rex misses his window: the claim lapses, his job fails with no money moved, and Sam's request goes back to the book", async () => {
    const before = s.app.store.users.must('rex').user.reliability!;
    await s.at(sf('11:05'));
    const claim = await ok(s, 'GET', `/api/claims/${ids.rexClaim}`, { as: 'rex' });
    assert.equal(claim.claim.status, 'lapsed');
    const job = await ok(s, 'GET', `/api/jobs/${ids.rexJob}`, { as: 'rex' });
    assert.equal(job.job.status, 'failed');
    assert.equal(job.job.failure.reason, 'no_show');
    assert.equal(job.job.amounts.capturedCents, 0);
    assert.deepEqual(job.ledger, []);
    const sam = await ok(s, 'GET', `/api/bids/${ids.samBid}`, { as: 'sam' });
    assert.equal(sam.bid.status, 'open');
    assert.equal(sam.bid.remainingQty, 1);
    assert.equal(sam.hold.status, 'held', 'the hold stays: the request can still be filled');
    const after = s.app.store.users.must('rex').user.reliability!;
    assert.equal(after.claimsLapsed, before.claimsLapsed + 1);
  });

  it("the clock reaches $12 at 11:05 and fills Mia; Wei's one plush is taken, so Lin's $10 offer fills Sam", async () => {
    const mia = await ok(s, 'GET', `/api/bids/${ids.miaBid}`, { as: 'mia' });
    assert.equal(mia.bid.status, 'matched');
    assert.deepEqual(mia.matches.map((m: any) => [m.qty, m.feeCents, m.at, m.trigger]), [[1, 1200, sf('11:05'), 'clock_step']]);
    ids.miaJob = mia.jobs[0].id;
    const ask = (await ok(s, 'GET', `/api/claims/${ids.weiClaim}`, { as: 'wei' })).ask;
    assert.equal(ask.status, 'filled');
    assert.equal(ask.remainingCapacity, 0);

    await s.at(sf('11:20'));
    const lin = await ok(s, 'POST', '/api/asks', {
      as: 'lin',
      body: { shopId: HERO.shopId, itemId: HERO.itemId, capacity: 1, modes: ['ship'], feeCents: 1000, clock: null, etaAt: sf('11:30'), from: { lngLat: home('lin'), accuracyM: 10 } },
    });
    ids.linAsk = lin.ask.id;
    ids.linClaim = lin.claim.id;
    assert.deepEqual(lin.matches.map((m: any) => [m.bidId, m.qty, m.feeCents, m.trigger]), [[ids.samBid, 1, 1000, 'new_ask']]);
    const sam = await ok(s, 'GET', `/api/bids/${ids.samBid}`, { as: 'sam' });
    assert.equal(sam.bid.status, 'matched');
    ids.samJob = sam.jobs.find((j: any) => j.queuerId === 'lin').id;
  });

  it('Wei and Lin buy, upload each receipt, and the AI checks them from the photos (QR, code, time, totals)', async () => {
    await s.at(sf('11:30'));
    const line = await upload(s, 'lin', 'line_photo', placeholderPng('e2e-lin-line'), 'line_ok');
    await ok(s, 'POST', `/api/claims/${ids.linClaim}/check-in`, { as: 'lin', body: { lngLat: SHOP.lngLat, accuracyM: 7, photoFileId: line.id } });
    await s.app.idle();

    await s.at(sf('11:38'));
    assert.equal((await ok(s, 'POST', `/api/jobs/${ids.miaJob}/bought`, { as: 'wei' })).job.status, 'bought');
    await s.at(sf('11:42'));
    let receipt = await upload(s, 'wei', 'receipt', fixture('paper-moon-mia-genuine/receipt.png'));
    let item = await upload(s, 'wei', 'item_photo', fixture('paper-moon-mia-genuine/item.png'));
    const out = await ok(s, 'POST', `/api/jobs/${ids.miaJob}/proof`, { as: 'wei', body: { receiptFileId: receipt.id, itemFileId: item.id } });
    assert.equal(out.proof.status, 'verifying');
    await s.app.idle();
    let detail = await ok(s, 'GET', `/api/jobs/${ids.miaJob}`, { as: 'mia' });
    const miaProof = detail.proofs.find((p: any) => p.kind === 'purchase');
    assert.equal(miaProof.status, 'passed', miaProof.summary);
    assert.match(miaProof.receipt.invoiceNumber, /PM11120412/, 'the receipt number printed on the rendered receipt');
    assert.deepEqual([miaProof.amounts.retailCents, miaProof.amounts.captureCents, miaProof.amounts.processingCents], [3400, 4869, 269]);
    assert.equal(detail.job.status, 'verified');

    await s.at(sf('11:50'));
    assert.equal((await ok(s, 'POST', `/api/jobs/${ids.samJob}/bought`, { as: 'lin' })).job.status, 'bought');
    await s.at(sf('11:52'));
    receipt = await upload(s, 'lin', 'receipt', fixture('paper-moon-priya-genuine/receipt.png'));
    item = await upload(s, 'lin', 'item_photo', fixture('paper-moon-priya-genuine/item.png'));
    await ok(s, 'POST', `/api/jobs/${ids.samJob}/proof`, { as: 'lin', body: { receiptFileId: receipt.id, itemFileId: item.id } });
    await s.app.idle();
    detail = await ok(s, 'GET', `/api/jobs/${ids.samJob}`, { as: 'sam' });
    const samProof = detail.proofs.find((p: any) => p.kind === 'purchase');
    assert.equal(samProof.status, 'passed', samProof.summary);
    assert.deepEqual([samProof.amounts.retailCents, samProof.amounts.captureCents], [3400, 4662]);
  });

  it("captures $48.69 of Mia's hold (not final) and pays Wei $10.80 through Payouts", async () => {
    const ledger = (await ok(s, 'GET', '/api/ledger?mine=1', { as: 'mia' })).entries.reverse();
    assert.deepEqual(ledger.map((e: any) => [e.kind, e.amount.cents, e.status]), [
      ['held', 6370, 'succeeded'],
      ['captured', 4869, 'succeeded'],
    ]);
    // PayPal's own fee on the capture, read from its seller_receivable_breakdown, is on the ledger line.
    assert.equal(ledger[1].paypal.feeCents, 219);
    const pp = s.app.fakePayPal.inspectAuthorization(ids.miaAuth)!;
    assert.deepEqual([pp.status, pp.capturedCents], ['PARTIALLY_CAPTURED', 4869]);
    const payouts = (await ok(s, 'GET', '/api/payouts?mine=1', { as: 'wei' })).payouts.reverse();
    assert.deepEqual(payouts.map((p: any) => [p.reference, p.purpose, p.amount.cents, p.status]), [[ids.miaJob, 'fee', 1080, 'succeeded']]);
    assert.equal(payouts[0].receiverEmail, null, 'the queuer never sees the payout email');
    const linPayouts = (await ok(s, 'GET', '/api/payouts?mine=1', { as: 'lin' })).payouts;
    assert.deepEqual(linPayouts.map((p: any) => [p.reference, p.purpose, p.amount.cents, p.status]), [[ids.samJob, 'fee', 900, 'succeeded']]);
    const ops = (await ok(s, 'GET', '/api/payouts', { as: 'ops' })).payouts.find((p: any) => p.reference === ids.miaJob);
    assert.deepEqual(s.app.fakePayPal.inspectPayoutItem(ops.paypalItemId), { status: 'SUCCESS', receiver: 'wei@queuers.example', amountCents: 1080 });
  });

  it('Wei ships Mia\'s parcel: tracking goes to PayPal, the final capture is $9.57 ($8.75 shipping, $0.82 processing) and $5.44 is released', async () => {
    await s.at(sf('14:00'));
    const label = await upload(s, 'wei', 'label', placeholderPng('e2e-label-mia'));
    const out = await ok(s, 'POST', `/api/jobs/${ids.miaJob}/shipment`, {
      as: 'wei',
      body: { carrierName: 'Harbor Parcel Ground', trackingNumber: 'HPG-2611-1200-0042', shippingCostCents: 875, dutyPaidCents: 0, labelFileId: label.id },
    });
    assert.equal(out.job.status, 'shipped');
    const ledger = (await ok(s, 'GET', '/api/ledger?mine=1', { as: 'mia' })).entries.reverse();
    assert.deepEqual(ledger.map((e: any) => [e.kind, e.amount.cents, e.status]), [
      ['held', 6370, 'succeeded'],
      ['captured', 4869, 'succeeded'],
      ['captured', 957, 'succeeded'],
      ['released', 544, 'succeeded'],
    ]);
    const order = s.app.fakePayPal.inspectOrder(ids.miaOrder)!;
    assert.deepEqual(order.trackers.map((t) => [t.trackingNumber, t.carrierNameOther]), [['HPG-2611-1200-0042', 'Harbor Parcel Ground']]);
    const pp = s.app.fakePayPal.inspectAuthorization(ids.miaAuth)!;
    assert.deepEqual([pp.status, pp.capturedCents], ['CAPTURED', 5826], 'final_capture closed the authorization');
    const hold = (await ok(s, 'GET', `/api/bids/${ids.miaBid}`, { as: 'mia' })).hold;
    assert.deepEqual([hold.capturedCents, hold.releasedCents, hold.amount.cents], [5826, 544, 6370]);
    const payouts = (await ok(s, 'GET', '/api/payouts?mine=1', { as: 'wei' })).payouts;
    assert.deepEqual(payouts.filter((p: any) => p.reference === ids.miaJob).map((p: any) => [p.purpose, p.amount.cents, p.status]).reverse(), [
      ['fee', 1080, 'succeeded'],
      ['reimbursement', 4275, 'succeeded'],
    ]);
  });

  it("Sam's parcel: the shipping capture is final and the unused budget goes back to Sam's Venmo hold", async () => {
    await s.at(sf('14:05'));
    const label = await upload(s, 'lin', 'label', placeholderPng('e2e-label-sam'));
    await ok(s, 'POST', `/api/jobs/${ids.samJob}/shipment`, {
      as: 'lin',
      body: { carrierName: 'Harbor Parcel Ground', trackingNumber: 'HPG-2611-1200-0043', shippingCostCents: 700, dutyPaidCents: 0, labelFileId: label.id },
    });
    const bid = await ok(s, 'GET', `/api/bids/${ids.samBid}`, { as: 'sam' });
    assert.equal(bid.hold.capturedCents, 4662 + 776, '$34.00 + $10.00 + $2.62 processing, then $7.00 + $0.76 processing');
    assert.equal(bid.hold.capturedCents + bid.hold.releasedCents, bid.hold.amount.cents, 'everything not charged is released');
    assert.equal(s.app.fakePayPal.inspectAuthorization(ids.samAuth)?.status, 'CAPTURED');
    const reimbursement = (await ok(s, 'GET', '/api/payouts?mine=1', { as: 'lin' })).payouts.find((p: any) => p.reference === ids.samJob && p.purpose === 'reimbursement');
    assert.deepEqual([reimbursement.amount.cents, reimbursement.status], [3400 + 700, 'succeeded']);
  });

  it('moved money only through the ledger, once per idempotency key, and nothing for Rex', async () => {
    const all = (await ok(s, 'GET', '/api/ledger', { as: 'ops' })).entries;
    const keys = all.map((e: any) => e.idempotencyKey);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(all.every((e: any) => e.status === 'succeeded' && e.mode === 'fake'));
    assert.equal(all.filter((e: any) => e.jobId === ids.rexJob).length, 0);
    assert.equal(s.app.fakePayPal.captureCount(ids.miaAuth), 2);
    assert.equal(s.app.fakePayPal.captureCount(ids.samAuth), 2);
    const rex = (await ok(s, 'GET', '/api/payouts?mine=1', { as: 'rex' })).payouts;
    assert.deepEqual(rex, []);
  });

  it('gives the operator console the same story: every record in one read, and dashboard rows in dollars per shop', async () => {
    const records = await ok(s, 'GET', '/api/ops/records');
    assert.equal(records.at, s.app.now());
    assert.deepEqual([records.bids.length, records.holds.length, records.jobs.length, records.claims.length], [2, 2, 3, 3]);
    assert.ok(records.users.find((u: any) => u.id === 'wei').home, 'ops sees home positions');
    assert.equal(records.proofs.filter((p: any) => p.kind === 'purchase' && p.status === 'passed').length, 2);
    const holds = await ok(s, 'GET', '/api/ops/datasets/holds');
    const mia = holds.rows.find((r: any) => r.bidId === ids.miaBid);
    assert.deepEqual([mia.shopId, mia.heldUsd, mia.capturedUsd, mia.releasedUsd, mia.openUsd, mia.funding], [HERO.shopId, 63.7, 58.26, 5.44, 0, 'PayPal']);
    const books = await ok(s, 'GET', '/api/ops/datasets/books');
    assert.ok(books.fields.some((f: any) => f.name === 'bestAskUsd') && books.fields.some((f: any) => f.name === 'spreadUsd'));
    const jobs = await ok(s, 'GET', '/api/ops/datasets/jobs');
    assert.deepEqual(jobs.rows.find((r: any) => r.jobId === ids.rexJob).payState, 'Nothing (job failed)');
    const miaJob = jobs.rows.find((r: any) => r.jobId === ids.miaJob);
    assert.deepEqual([miaJob.capturedUsd, miaJob.paidOutUsd, miaJob.processingUsd, miaJob.paypalFeesUsd, miaJob.platformUsd], [58.26, 53.55, 3.51, 3.51, 1.2]);
    assert.equal(jobs.rows.find((r: any) => r.jobId === ids.rexJob).platformUsd, 0);
  });
});

describe('end to end over HTTP: a sell-out voids the hold', () => {
  let s: TestServer;
  before(async () => {
    s = await testServer({ ai: 'real', start: sf('12:00') });
  });
  after(() => s.done());

  it("Lin reports the cloud cakes sold out from inside the line: the job fails and Noor's whole hold is released", async () => {
    const item = BAKERY.items[0]!;
    const { created, authorized } = await holdBid(s, 'noor', { shopId: BAKERY.id, itemId: item.id, qty: 1, destination: { mode: 'local', cityId: 'sf' }, maxFeeCents: 600, funding: 'paypal' });
    const held = authorized.hold.amount.cents;
    const eta = s.app.now() + (travelMinutes(home('lin'), BAKERY.lngLat) + 2) * MIN;
    const ask = await ok(s, 'POST', '/api/asks', {
      as: 'lin',
      body: { shopId: BAKERY.id, itemId: item.id, capacity: 1, modes: ['local'], feeCents: 500, clock: null, etaAt: eta, from: { lngLat: home('lin'), accuracyM: 10 } },
    });
    assert.equal(ask.matches.length, 1, 'a fixed fee at or under the request fills at once');
    const jobId = ask.matches[0].jobId;
    await s.at(eta - MIN);
    // No rendered line photo for this shop: the upload names a simulated reading, which the AI services hand to the rules-only fake.
    const line = await upload(s, 'lin', 'line_photo', placeholderPng('e2e-lin-line'), 'line_ok');
    await ok(s, 'POST', `/api/claims/${ask.claim.id}/check-in`, { as: 'lin', body: { lngLat: BAKERY.lngLat, accuracyM: 8, photoFileId: line.id } });
    await s.app.idle();
    assert.equal((await ok(s, 'GET', `/api/claims/${ask.claim.id}`, { as: 'lin' })).claim.status, 'checked_in');

    await s.at(eta + 10 * MIN);
    const shelf = await upload(s, 'lin', 'sold_out_photo', placeholderPng('e2e-empty-shelf'));
    const out = await ok(s, 'POST', `/api/jobs/${jobId}/sold-out`, { as: 'lin', body: { photoFileId: shelf.id } });
    assert.equal(out.job.status, 'failed');
    assert.equal(out.job.failure.reason, 'sold_out');
    assert.equal(out.book.status, 'sold_out');
    await s.app.idle();

    const bid = await ok(s, 'GET', `/api/bids/${created.bid.id}`, { as: 'noor' });
    assert.equal(bid.hold.status, 'released');
    assert.deepEqual([bid.hold.capturedCents, bid.hold.releasedCents], [0, held]);
    assert.deepEqual(bid.ledger.map((e: any) => [e.kind, e.amount.cents, e.status]).reverse(), [
      ['held', held, 'succeeded'],
      ['released', held, 'succeeded'],
    ]);
    assert.equal(s.app.fakePayPal.inspectAuthorization(authorized.hold.authorizationId)?.status, 'VOIDED', 'PayPal voided the authorization');
    assert.deepEqual((await ok(s, 'GET', '/api/payouts?mine=1', { as: 'lin' })).payouts, []);
  });
});

describe('the scripted hero demo with both real services', () => {
  let s: TestServer;
  before(async () => {
    s = await testServer({ demo: true, crowd: true, ai: 'real' });
    await s.director!.start('hero', null);
    s.app.clock.pause();
    await s.at(sf('14:05'));
  });
  after(() => s.done());

  it('finishes and reproduces the hero ledger: held $63.70, charged $58.26, released $5.44', () => {
    assert.equal(s.director!.state().status, 'finished');
    const bid = s.app.store.bids.first("requester_id = 'mia'")!;
    const hold = s.app.store.holds.must(bid.holdId!);
    assert.deepEqual([hold.amount.cents, hold.capturedCents, hold.releasedCents], [6370, 5826, 544]);
    const wei = s.app.store.payouts.where("recipient_user_id = 'wei'").filter((p) => s.app.store.jobs.must(p.reference).requesterId === 'mia');
    assert.deepEqual(wei.map((p) => [p.amount.cents, p.status]), [[1080, 'succeeded'], [4275, 'succeeded']]);
  });

  it("reads Mia's receipt and Wei's line photo from the rendered photos", () => {
    const job = s.app.store.jobs.first("queuer_id = 'wei' AND requester_id = 'mia'")!;
    const proof = s.app.store.proofs.first("job_id = ? AND kind = 'purchase'", job.id)!;
    assert.equal(proof.status, 'passed');
    assert.match(proof.receipt?.invoiceNumber ?? '', /PM11120412/);
    const claim = s.app.store.claims.first("queuer_id = 'wei'")!;
    assert.equal(claim.checkInCode, 'M4RT7');
    assert.equal(s.app.store.proofs.first("claim_id = ? AND kind = 'check_in'", claim.id)?.peopleAhead, 40);
  });

  it("fails Rex's fake receipt on four checks from the photos, and moves $0", () => {
    const job = s.app.store.jobs.first("queuer_id = 'rex'")!;
    assert.equal(job.status, 'failed');
    assert.equal(job.amounts.capturedCents, 0);
    const proof = s.app.store.proofs.first("job_id = ? AND kind = 'purchase'", job.id)!;
    assert.deepEqual(proof.checks.filter((c) => !c.ok).map((c) => c.code), ['shop_match', 'time_window', 'totals_add_up', 'duplicate_photo']);
    assert.match(proof.receipt?.invoiceNumber ?? '', /PM11120384/, 'read from the fake receipt itself');
  });
});
