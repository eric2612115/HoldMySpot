import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ContractError, captureCapCents, findShop, jobSettlement } from '@holdmyspot/shared';
import { cancelBid } from '../src/app/bids.ts';
import { addShipment, handover, markBought, submitProof } from '../src/app/jobs.ts';
import { bookSnapshot } from '../src/app/market.ts';
import { captureForJob, recoverPending, renewHold } from '../src/app/money.ts';
import { syncPayPal } from '../src/app/sync.ts';
import { ITEM, DAY, SHOP, MIN, checkInAt, ledgerOf, persona, placeBid, postAsk, sum, testServer, upload, type TestServer } from './helpers.ts';

const code = (err: unknown) => (err instanceof ContractError ? err.code : String(err));

/** A requester's bid filled by one queuer, checked in, bought, receipt submitted (scenario decides the verdict). */
async function throughProof(s: TestServer, o: { requester?: string; queuer?: string; qty?: number; fee?: number; scenario?: string; bid?: Parameters<typeof placeBid>[2] } = {}) {
  const requester = o.requester ?? 'mia';
  const queuer = o.queuer ?? 'wei';
  const placed = await placeBid(s.app, requester, { qty: o.qty ?? 2, maxFeeCents: 1200, ...o.bid });
  const ask = await postAsk(s.app, queuer, { capacity: o.qty ?? 2, feeCents: o.fee ?? 1200, etaInMin: 10 });
  await checkInAt(s.app, queuer, ask.claim.id, SHOP.lngLat);
  const job = s.app.store.jobs.where('ask_id = ? AND bid_id = ?', ask.ask.id, placed.bid.id)[0]!;
  await s.app.exec(() => markBought(s.app, persona(s.app, queuer), job.id));
  await s.at(s.app.now() + 40 * MIN);
  const r = await upload(s.app, queuer, 'receipt', o.scenario ?? 'genuine');
  const p = await upload(s.app, queuer, 'item_photo', o.scenario ?? 'genuine');
  await s.app.exec(() => submitProof(s.app, persona(s.app, queuer), job.id, { receiptFileId: r.id, itemFileId: p.id }));
  await s.app.idle();
  return { bid: s.app.store.bids.must(placed.bid.id), job: s.app.store.jobs.must(job.id), ask };
}

const ship = { carrierName: 'Harbor Parcel Ground', trackingNumber: 'HAP-TEST-1', shippingCostCents: 2440, dutyPaidCents: 200, labelFileId: null };

describe('never capture above the user limit', () => {
  it('captures a shipped two-plush request: $79.77, then $27.86 final, $14.59 released (processing at cost included)', async () => {
    const s = await testServer();
    try {
      const { bid, job } = await throughProof(s);
      assert.equal(job.status, 'verified');
      assert.equal(job.amounts.retailCents, 5200); // 2 x $26.00 from the receipt
      const hold1 = s.app.store.holds.must(bid.holdId!);
      assert.equal(hold1.status, 'partially_captured');
      // $52.00 shop price + $24.00 fees + $3.77 processing ($3.27 PayPal fee on $79.77, two $0.25 payouts).
      assert.equal(hold1.capturedCents, 7977);
      const cap1 = s.app.store.ledger.first("job_id = ? AND kind = 'captured'", job.id)!;
      assert.equal(cap1.idempotencyKey, `cap:${job.id}:receipt`);
      assert.ok(cap1.paypal?.captureId?.startsWith('FAKE-CAP-'));

      await s.app.exec(() => addShipment(s.app, persona(s.app, 'wei'), job.id, ship));
      const hold = s.app.store.holds.must(bid.holdId!);
      assert.equal(hold.status, 'captured');
      assert.equal(hold.capturedCents, 7977 + 2786);
      assert.equal(hold.releasedCents, 1459);
      assert.equal(s.app.fakePayPal.inspectAuthorization(hold.authorizationId!)?.status, 'CAPTURED');
      const entries = ledgerOf(s.app, bid.id).filter((e) => e.userId === 'mia');
      assert.deepEqual(
        entries.map((e) => [e.kind, e.amount.cents, e.status]),
        [
          ['held', 12_222, 'succeeded'],
          ['captured', 7977, 'succeeded'],
          ['captured', 2786, 'succeeded'],
          ['released', 1459, 'succeeded'],
        ],
      );
      const payouts = s.app.store.payouts.where('job_id = ?', job.id);
      assert.deepEqual(
        payouts.map((p) => [p.purpose, p.amount.cents, p.platformFeeCents, p.status]),
        [
          ['fee', 2160, 240, 'succeeded'],
          ['reimbursement', 7840, 0, 'succeeded'],
        ],
      );
      const done = s.app.store.jobs.must(job.id);
      assert.equal(done.status, 'shipped');
      assert.equal(done.amounts.paidOutCents, 10_000);
      // Where the $107.63 went: $100.00 to the queuer, $5.23 to PayPal (fees on both captures and both payouts), $2.40 kept.
      assert.deepEqual(jobSettlement(done.amounts), { chargedCents: 10_763, processingCents: 523, paidOutCents: 10_000, paypalFeesCents: 523, platformCents: 240, processingVarianceCents: 0 });
    } finally {
      await s.done();
    }
  });

  it('refuses a capture past the remaining limit before calling PayPal, although PayPal would allow 115%', async () => {
    const s = await testServer();
    try {
      const { bid, job } = await throughProof(s);
      const hold = s.app.store.holds.must(bid.holdId!);
      assert.equal(hold.amount.cents - hold.capturedCents, 4245);
      // Simulate a bug that inflated this job's shipping cap: the hold limit still stops the capture.
      s.app.tx(() => {
        const j = s.app.store.jobs.must(job.id);
        j.caps = { ...j.caps, shippingCents: 9_999 };
        s.app.store.jobs.update(j);
      });
      const err = await s.app.exec(() => captureForJob(s.app, job.id, 'shipping', 4246, { retailCents: 5200, feeCents: 0, shippingCents: 4100, processingCents: 146 })).catch((e) => e);
      assert.equal(code(err), 'OVER_LIMIT');
      assert.equal(s.app.fakePayPal.captureCount(hold.authorizationId!), 1, 'no second capture reached PayPal');
      assert.equal(s.app.store.ledger.count("job_id = ? AND kind = 'captured'", job.id), 1);
      // PayPal itself would have taken it: 7977 + 4246 = 12223 is within 115% of 12222.
      const direct = await s.app.fakePayPal.captureAuthorization(hold.authorizationId!, {
        requestId: 'test-direct-overage',
        amountCents: 4246,
        finalCapture: false,
        invoiceId: 'HMS-test',
        noteToPayer: 'test',
        softDescriptor: 'TEST',
      });
      assert.equal(direct.status, 'COMPLETED');
    } finally {
      await s.done();
    }
  });

  it('refuses a capture above the job cap (shipping cap plus its processing at cost)', async () => {
    const s = await testServer();
    try {
      const { job } = await throughProof(s);
      const cap = captureCapCents(job.caps, 'ship', 'shipping');
      assert.equal(cap, 3677, '$35.00 shipping cap plus $1.77 processing');
      const err = await s.app.exec(() => captureForJob(s.app, job.id, 'shipping', cap + 1, { retailCents: 0, feeCents: 0, shippingCents: 3501 })).catch((e) => e);
      assert.equal(code(err), 'OVER_LIMIT');
    } finally {
      await s.done();
    }
  });

  it('clamps a receipt above the retail cap to the cap after a person approves it', async () => {
    const s = await testServer();
    try {
      const { job, bid } = await throughProof(s, { scenario: 'over_cap' });
      assert.equal(job.status, 'proof_submitted');
      const proof = s.app.store.proofs.first('job_id = ?', job.id)!;
      assert.equal(proof.status, 'needs_review');
      assert.equal(proof.amounts?.retailCents, 6240); // $31.20 x 2: the shop charged 20% more
      const res = await s.call('POST', `/api/ops/proofs/${proof.id}/review`, { body: { decision: 'pass', note: 'Price rise posted at the counter.' } });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      const cap = s.app.store.ledger.first("job_id = ? AND kind = 'captured'", job.id)!;
      assert.equal(cap.amount.cents, 5600 + 2400 + 392, 'retail capped at 2 x $28.00 plus the fee plus processing at cost');
      assert.equal(s.app.store.holds.must(bid.holdId!).capturedCents, 8392);
    } finally {
      await s.done();
    }
  });
});

describe('final capture flag', () => {
  it('is false while another job of the bid can still capture, true for the last one', async () => {
    const s = await testServer();
    try {
      const placed = await placeBid(s.app, 'mia', { qty: 2, maxFeeCents: 1200 });
      const lin = await postAsk(s.app, 'lin', { capacity: 1, feeCents: 1000, etaInMin: 10 });
      const rin = await postAsk(s.app, 'rin', { capacity: 1, feeCents: 1100, etaInMin: 10 });
      for (const [q, a] of [['lin', lin], ['rin', rin]] as const) {
        await checkInAt(s.app, q, a.claim.id, SHOP.lngLat);
      }
      await s.at(s.app.now() + 40 * MIN);
      const jobs = s.app.store.jobs.where('bid_id = ?', placed.bid.id);
      for (const j of jobs) {
        await s.app.exec(() => markBought(s.app, persona(s.app, j.queuerId), j.id));
        const r = await upload(s.app, j.queuerId, 'receipt', 'genuine');
        const p = await upload(s.app, j.queuerId, 'item_photo', 'genuine');
        await s.app.exec(() => submitProof(s.app, persona(s.app, j.queuerId), j.id, { receiptFileId: r.id, itemFileId: p.id }));
        await s.app.idle();
      }
      const [a, b] = jobs;
      await s.app.exec(() => addShipment(s.app, persona(s.app, a!.queuerId), a!.id, { ...ship, shippingCostCents: 1500, dutyPaidCents: 0 }));
      const holdMid = s.app.store.holds.must(placed.bid.holdId!);
      assert.equal(holdMid.status, 'partially_captured', 'first shipping capture is not final');
      await s.app.exec(() => addShipment(s.app, persona(s.app, b!.queuerId), b!.id, { ...ship, trackingNumber: 'HAP-TEST-2', shippingCostCents: 1500, dutyPaidCents: 0 }));
      const hold = s.app.store.holds.must(placed.bid.holdId!);
      assert.equal(hold.status, 'captured');
      // Receipts: 2600 + 1000 and 2600 + 1100; shipping 1500 + 1500 (each job's cap is 1750); each capture
      // with its processing at cost: $38.33, $39.36, $16.05 and $16.05.
      assert.equal(hold.capturedCents, 3833 + 3936 + 1605 + 1605);
      assert.equal(hold.releasedCents, 12_222 - hold.capturedCents);
    } finally {
      await s.done();
    }
  });
});

describe('void on failure', () => {
  it('voids the whole hold when the only job fails and the deadline passes', async () => {
    const s = await testServer();
    try {
      const deadline = s.app.now() + 3 * 60 * MIN;
      const { bid, job } = await throughProof(s, { qty: 1, scenario: 'fake_receipt', bid: { deadlineAt: deadline } });
      assert.equal(s.app.store.jobs.must(job.id).status, 'failed');
      assert.equal(s.app.store.bids.must(bid.id).status, 'open', 'quantity re-offered until the deadline');
      await s.at(deadline + 1);
      const b = s.app.store.bids.must(bid.id);
      assert.equal(b.status, 'expired');
      const hold = s.app.store.holds.must(b.holdId!);
      assert.equal(hold.status, 'released');
      assert.equal(hold.capturedCents, 0);
      const rel = s.app.store.ledger.where("bid_id = ? AND kind = 'released'", bid.id);
      assert.deepEqual(rel.map((e) => e.amount.cents), [b.limitCents]);
      assert.equal(s.app.fakePayPal.inspectAuthorization(hold.authorizationId!)?.status, 'VOIDED');
    } finally {
      await s.done();
    }
  });

  it('voids the remainder after a partial capture when nothing more can be charged', async () => {
    const s = await testServer();
    try {
      const deadline = s.app.now() + 4 * 60 * MIN;
      const placed = await placeBid(s.app, 'mia', { qty: 2, maxFeeCents: 1200, deadlineAt: deadline });
      const lin = await postAsk(s.app, 'lin', { capacity: 1, feeCents: 1000, etaInMin: 10 });
      const rin = await postAsk(s.app, 'rin', { capacity: 1, feeCents: 1100, etaInMin: 10 });
      await checkInAt(s.app, 'lin', lin.claim.id, SHOP.lngLat);
      await checkInAt(s.app, 'rin', rin.claim.id, SHOP.lngLat);
      await s.at(s.app.now() + 40 * MIN);
      const jobs = s.app.store.jobs.where('bid_id = ?', placed.bid.id);
      const good = jobs.find((j) => j.queuerId === 'lin')!;
      const bad = jobs.find((j) => j.queuerId === 'rin')!;
      for (const [j, scenario] of [[good, 'genuine'], [bad, 'fake_receipt']] as const) {
        await s.app.exec(() => markBought(s.app, persona(s.app, j.queuerId), j.id));
        const r = await upload(s.app, j.queuerId, 'receipt', scenario);
        const p = await upload(s.app, j.queuerId, 'item_photo', scenario);
        await s.app.exec(() => submitProof(s.app, persona(s.app, j.queuerId), j.id, { receiptFileId: r.id, itemFileId: p.id }));
        await s.app.idle();
      }
      await s.app.exec(() => addShipment(s.app, persona(s.app, 'lin'), good.id, { ...ship, shippingCostCents: 1200, dutyPaidCents: 0 }));
      // Rin's unit is back in the book, so Lin's shipping capture was not final.
      assert.equal(s.app.store.holds.must(placed.bid.holdId!).status, 'partially_captured');
      await s.at(deadline + 1);
      const hold = s.app.store.holds.must(placed.bid.holdId!);
      assert.equal(hold.status, 'released');
      assert.equal(hold.capturedCents, 3833 + 1294);
      assert.equal(hold.releasedCents, 12_222 - 5127);
      assert.equal(s.app.store.bids.must(placed.bid.id).status, 'closing', 'deadline passed while the shipped job is on its way');
      await s.call('POST', `/api/jobs/${good.id}/delivered`, {});
      const b = s.app.store.bids.must(placed.bid.id);
      assert.equal(b.status, 'settled');
      assert.equal(s.app.fakePayPal.inspectAuthorization(hold.authorizationId!)?.status, 'VOIDED');
    } finally {
      await s.done();
    }
  });

  it('keeps an outage pending and retries it with the same key; a closed authorization fails the job and syncs the hold', async () => {
    // Three 503s in a row outlast the REST client's own two retries, so the server sees the outage.
    const s = await testServer({ env: { HMS_FAKE_FAIL: 'capture:unavailable:3' } });
    try {
      const { bid, job } = await throughProof(s);
      const entry = s.app.store.ledger.first("job_id = ? AND kind = 'captured'", job.id)!;
      assert.equal(entry.status, 'pending');
      assert.equal(s.app.store.jobs.must(job.id).status, 'verified');
      assert.equal(s.app.store.payouts.count(), 0, 'no payout before a completed capture');
      await s.app.exec(() => recoverPending(s.app));
      const done = s.app.store.ledger.must(entry.id);
      assert.equal(done.status, 'succeeded');
      assert.equal(done.idempotencyKey, `cap:${job.id}:receipt`);
      assert.equal(s.app.store.holds.must(bid.holdId!).capturedCents, 7977);
      assert.deepEqual(s.app.store.payouts.all().map((p) => p.amount.cents), [2160]);
    } finally {
      await s.done();
    }
    const s2 = await testServer();
    try {
      const placed = await placeBid(s2.app, 'mia', { qty: 1, maxFeeCents: 1200 });
      const hold0 = s2.app.store.holds.must(placed.bid.holdId!);
      // Someone voids the authorization at PayPal behind our back.
      await s2.app.fakePayPal.voidAuthorization(hold0.authorizationId!, 'test-external-void');
      const ask = await postAsk(s2.app, 'wei', { capacity: 1, feeCents: 1200, etaInMin: 10 });
      await checkInAt(s2.app, 'wei', ask.claim.id, SHOP.lngLat);
      const job = s2.app.store.jobs.where('bid_id = ?', placed.bid.id)[0]!;
      await s2.app.exec(() => markBought(s2.app, persona(s2.app, 'wei'), job.id));
      await s2.at(s2.app.now() + 40 * MIN);
      const r = await upload(s2.app, 'wei', 'receipt');
      const p = await upload(s2.app, 'wei', 'item_photo');
      await s2.app.exec(() => submitProof(s2.app, persona(s2.app, 'wei'), job.id, { receiptFileId: r.id, itemFileId: p.id }));
      await s2.app.idle();
      const j = s2.app.store.jobs.must(job.id);
      assert.equal(j.status, 'failed');
      assert.equal(j.failure?.reason, 'payment_failed');
      assert.equal(s2.app.store.ledger.first("job_id = ? AND kind = 'captured'", job.id)?.status, 'failed');
      assert.equal(s2.app.store.holds.must(placed.bid.holdId!).status, 'released');
      assert.equal(s2.app.store.payouts.count(), 0);
    } finally {
      await s2.done();
    }
  });
});

describe('hold renewal (reauthorize from day 4 to day 29)', () => {
  it('reauthorizes an untouched hold of an open request on day 4, not before', async () => {
    const s = await testServer();
    try {
      const placed = await placeBid(s.app, 'leo', { qty: 1, maxFeeCents: 1200, deadlineAt: s.app.now() + 9 * DAY });
      const h0 = s.app.store.holds.must(placed.bid.holdId!);
      await s.at(h0.honorEndsAt! - MIN);
      assert.equal(s.app.store.holds.must(h0.id).renewals, 0);
      const early = await s.call('POST', `/api/ops/holds/${h0.id}/reauthorize`);
      assert.equal(early.status, 409);
      assert.equal(early.json.error.code, 'CONFLICT');

      await s.at(h0.honorEndsAt! + MIN);
      const h1 = s.app.store.holds.must(h0.id);
      assert.equal(h1.renewals, 1);
      assert.notEqual(h1.authorizationId, h0.authorizationId);
      assert.equal(h1.originalAuthorizationId, h0.authorizationId);
      assert.equal(h1.status, 'held');
      assert.equal(h1.expiresAt, h0.expiresAt, 'validity still counts from the original authorization');
      assert.equal(h1.honorEndsAt, h1.authorizedAt! + 3 * DAY);
      assert.equal(s.app.store.bids.must(placed.bid.id).paypalAuthorizationId, h1.authorizationId);
      const renewed = s.app.store.ledger.where("hold_id = ? AND kind = 'renewed'", h0.id);
      assert.deepEqual(renewed.map((e) => [e.amount.cents, e.status, e.idempotencyKey]), [[h0.amount.cents, 'succeeded', `reauth:${h0.id}:1`]]);
      assert.equal(s.app.fakePayPal.inspectAuthorization(h0.authorizationId!)?.supersededBy, h1.authorizationId);
      // The renewed hold still backs fills.
      const { matches } = await postAsk(s.app, 'wei', { capacity: 1, feeCents: 1000, etaInMin: 10 });
      assert.equal(matches.length, 1);
    } finally {
      await s.done();
    }
  });

  it('marks Venmo holds renewal-required instead (unproven), and the request stops matching', async () => {
    const s = await testServer();
    try {
      const placed = await placeBid(s.app, 'leo', { qty: 1, maxFeeCents: 1200, funding: 'venmo', deadlineAt: s.app.now() + 9 * DAY });
      const h0 = s.app.store.holds.must(placed.bid.holdId!);
      assert.equal(h0.fundingSource, 'venmo');
      await s.at(h0.honorEndsAt! + MIN);
      const h1 = s.app.store.holds.must(h0.id);
      assert.equal(h1.renewalRequired, true);
      assert.equal(h1.renewals, 0);
      assert.equal(s.app.store.ledger.count("hold_id = ? AND kind = 'renewed'", h0.id), 0);
      assert.equal(bookSnapshot(s.app, ITEM).bids.count, 0);
      const { matches } = await postAsk(s.app, 'wei', { capacity: 1, feeCents: 1000, etaInMin: 10 });
      assert.equal(matches.length, 0);
    } finally {
      await s.done();
    }
  });

  it('never reauthorizes a hold with captures, and a failed reauthorization requires a new approval', async () => {
    const s = await testServer({ env: { HMS_FAKE_FAIL: 'reauthorize:decline' } });
    try {
      const deadline = s.app.now() + 9 * DAY;
      const { bid } = await throughProof(s, { qty: 1, bid: { deadlineAt: deadline } });
      const captured = s.app.store.holds.must(bid.holdId!);
      assert.equal(captured.status, 'partially_captured');
      const other = await placeBid(s.app, 'jun', { qty: 1, maxFeeCents: 900, deadlineAt: deadline });
      const h0 = s.app.store.holds.must(other.bid.holdId!);
      const out = await s.app.exec(() => renewHold(s.app, captured.id));
      assert.equal(out.verdict, 'not_needed');
      await s.at(h0.honorEndsAt! + MIN);
      assert.equal(s.app.store.holds.must(captured.id).renewals, 0, 'captured holds are left alone');
      const h1 = s.app.store.holds.must(h0.id);
      assert.equal(h1.renewalRequired, true, 'reauthorization failed');
      assert.equal(s.app.store.ledger.first("hold_id = ? AND kind = 'renewed'", h0.id)?.status, 'failed');
    } finally {
      await s.done();
    }
  });
});

describe('local errand: one capture at the handover', () => {
  it('captures $49.47 with the requester code ($47.00 plus $2.47 processing), pays $46.10, keeps $0.90 and releases $2.07', async () => {
    const s = await testServer({ start: Date.parse('2026-11-12T09:30:00-05:00') });
    try {
      const placed = await placeBid(s.app, 'jun', {
        shopId: 'petal-crumb-bakery',
        itemId: 'cake-petal-crumb',
        qty: 1,
        retailCapCents: 4000,
        maxFeeCents: 900,
        shippingBudgetCents: 0,
        destination: { mode: 'local', cityId: 'nyc' },
        funding: 'venmo',
      });
      assert.equal(placed.hold.amount.cents, 5154);
      const dana = persona(s.app, 'dana');
      const { claimBid } = await import('../src/app/bids.ts');
      const out = await s.app.exec(() =>
        claimBid(s.app, dana, placed.bid.id, { qty: 1, etaAt: s.app.now() + 12 * MIN, modes: ['local'], from: { lngLat: dana.home!, accuracyM: 10 } }),
      );
      await checkInAt(s.app, 'dana', out.claim.id, findShop('petal-crumb-bakery')!.lngLat);
      await s.at(s.app.now() + 30 * MIN);
      await s.app.exec(() => markBought(s.app, dana, out.job.id));
      const r = await upload(s.app, 'dana', 'receipt');
      const p = await upload(s.app, 'dana', 'item_photo');
      await s.app.exec(() => submitProof(s.app, dana, out.job.id, { receiptFileId: r.id, itemFileId: p.id }));
      await s.app.idle();
      const job = s.app.store.jobs.must(out.job.id);
      assert.equal(job.status, 'verified');
      assert.equal(s.app.store.ledger.count("job_id = ? AND kind = 'captured'", job.id), 0, 'local mode captures at the handover');
      assert.equal(code(await s.app.exec(() => handover(s.app, dana, job.id, '0000')).catch((e) => e)), job.handoverCode === '0000' ? 'none' : 'WRONG_CODE');
      const res = await s.app.exec(() => handover(s.app, dana, job.id, job.handoverCode!));
      assert.equal(res.job.status, 'delivered');
      const hold = s.app.store.holds.must(placed.bid.holdId!);
      assert.equal(hold.capturedCents, 4947);
      assert.equal(hold.status, 'captured');
      assert.equal(hold.releasedCents, 207);
      assert.deepEqual(s.app.store.payouts.all().map((x) => [x.purpose, x.amount.cents, x.platformFeeCents, x.paypalFeeCents]), [['fee_and_reimbursement', 4610, 90, 25]]);
      const settled = jobSettlement(s.app.store.jobs.must(job.id).amounts);
      assert.deepEqual([settled.processingCents, settled.paypalFeesCents, settled.platformCents], [247, 222 + 25, 90]);
      assert.equal(s.app.store.bids.must(placed.bid.id).status, 'settled');
    } finally {
      await s.done();
    }
  });
});

describe('refunds and idempotency', () => {
  it('fails a job not shipped within 5 days and refunds capture #1 in full', async () => {
    const s = await testServer();
    try {
      const { bid, job } = await throughProof(s, { bid: { deadlineAt: s.app.now() + 2 * DAY } });
      const verifiedAt = job.history.at(-1)!.at;
      await s.at(verifiedAt + 5 * DAY + 1);
      const j = s.app.store.jobs.must(job.id);
      assert.equal(j.status, 'failed');
      assert.equal(j.failure?.reason, 'not_shipped');
      assert.equal(j.amounts.refundedCents, 7977, 'everything the requester paid, processing included');
      const refund = s.app.store.ledger.where("job_id = ? AND kind = 'refunded'", job.id);
      assert.deepEqual(refund.map((e) => [e.amount.cents, e.status, e.idempotencyKey]), [[7977, 'succeeded', `refund:${job.id}:1`]]);
      const hold = s.app.store.holds.must(bid.holdId!);
      assert.equal(hold.refundedCents, 7977);
      // The queuer who never shipped kept the fee payout, and PayPal keeps its capture fee: HoldMySpot absorbs both.
      assert.equal(jobSettlement(j.amounts).platformCents, -(2160 + 327 + 25));
      assert.equal(hold.status, 'released', 'the rest was voided');
    } finally {
      await s.done();
    }
  });

  it('a repeated capture call for the same part does not charge twice', async () => {
    const s = await testServer();
    try {
      const { bid, job } = await throughProof(s);
      const hold = s.app.store.holds.must(bid.holdId!);
      const again = await s.app.exec(() => captureForJob(s.app, job.id, 'receipt', 7977, { retailCents: 5200, feeCents: 2400, shippingCents: 0, processingCents: 377 }));
      assert.equal(again.completed, true);
      assert.equal(s.app.fakePayPal.captureCount(hold.authorizationId!), 1);
      assert.equal(s.app.store.holds.must(hold.id).capturedCents, 7977);
      const keys = s.app.store.ledger.all().map((e) => e.idempotencyKey);
      assert.equal(new Set(keys).size, keys.length, 'idempotency keys are unique');
      assert.equal(sum(s.app.store.ledger.where("kind = 'captured' AND status = 'succeeded'").map((e) => e.amount.cents)), 7977);
    } finally {
      await s.done();
    }
  });

  it('an unclaimed payout stays pending until the receiver claims it, then the status sync completes it', async () => {
    const s = await testServer({ env: { HMS_FAKE_FAIL: 'payout:unclaimed' } });
    try {
      const { job } = await throughProof(s);
      const payout = s.app.store.payouts.first('job_id = ?', job.id)!;
      assert.equal(payout.status, 'unclaimed');
      const entry = s.app.store.ledger.first("payout_id = ? AND kind = 'paid_out'", payout.id)!;
      assert.equal(entry.status, 'pending');
      assert.equal(s.app.store.jobs.must(job.id).amounts.paidOutCents, 0);
      assert.equal(s.app.fakePayPal.claimPayoutItem(payout.paypalItemId!), true);
      await syncPayPal(s.app);
      assert.equal(s.app.store.payouts.must(payout.id).status, 'succeeded');
      assert.equal(s.app.store.ledger.must(entry.id).status, 'succeeded');
      assert.equal(s.app.store.jobs.must(job.id).amounts.paidOutCents, 2160);
    } finally {
      await s.done();
    }
  });

  it('cancel with nothing matched voids the full hold', async () => {
    const s = await testServer();
    try {
      const placed = await placeBid(s.app, 'sam', { qty: 1, maxFeeCents: 900, destination: { mode: 'ship', country: 'US', region: 'CA', city: 'San Francisco', postalCode: '94110' } });
      const out = await s.app.exec(() => cancelBid(s.app, { userId: 'sam', ops: false }, placed.bid.id));
      assert.equal(out.bid.status, 'cancelled');
      assert.equal(out.bid.closeReason, 'requester_cancelled');
      assert.equal(out.hold.status, 'released');
      assert.equal(out.hold.releasedCents, out.hold.amount.cents);
    } finally {
      await s.done();
    }
  });
});
