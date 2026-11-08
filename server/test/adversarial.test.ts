import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ContractError, findShop } from '@holdmyspot/shared';
import type { CreateBidRequest } from '@holdmyspot/shared';
import { APPROVAL_TIMEOUT_MS, amendBid, authorizeBid, cancelBid, claimBid, createBid } from '../src/app/bids.ts';
import { addShipment, handover, markBought, submitProof } from '../src/app/jobs.ts';
import { authorizeHold, payoutsAfterCapture, recoverPending, refundJob } from '../src/app/money.ts';
import { syncPayPal } from '../src/app/sync.ts';
import { toPayPalError, unexpectedResponse } from '../src/paypal/errors.ts';
import { PayPalCallError } from '../src/ports/payments.ts';
import { ITEM, DAY, SHOP, MIN, NY_SHIP, checkInAt, persona, placeBid, postAsk, sum, testServer, upload, type TestServer } from './helpers.ts';

/**
 * Adversarial review of money safety (2026-11-07). Each test drives one way
 * to lose, double or strand money: PayPal outages and lost answers, retries
 * with different numbers, requests that close while PayPal calls are in
 * flight, quantity changes after a fill, and guessing the handover code.
 */

const code = (err: unknown) => (err instanceof ContractError ? err.code : String(err));

const outage = () =>
  new PayPalCallError('PayPal outage (test)', { code: 'PAYPAL_UNAVAILABLE', paypalName: 'SERVICE_UNAVAILABLE', issue: null, httpStatus: 503, debugId: null, retryable: true });

type Real = (...args: unknown[]) => Promise<unknown>;
type Step = 'outage' | 'lost' | ((real: Real, args: unknown[]) => Promise<unknown>);
type Tripped = 'authorizeOrder' | 'captureAuthorization' | 'voidAuthorization' | 'reauthorize' | 'refundCapture' | 'createPayout';

/**
 * Scripts the next calls of one PayPal method on the fake: `outage` fails
 * before PayPal sees the call; `lost` lets PayPal do it and then loses the
 * answer (the server sees an outage); a function decides by itself. Later
 * calls go through untouched.
 */
function trip(s: TestServer, method: Tripped, ...plan: Step[]): void {
  const fake = s.app.fakePayPal as unknown as Record<string, unknown>;
  const real = (fake[method] as Real).bind(s.app.fakePayPal);
  const queue = [...plan];
  fake[method] = async (...args: unknown[]) => {
    const step = queue.shift();
    if (step === undefined) return real(...args);
    if (step === 'outage') throw outage();
    if (step === 'lost') {
      await real(...args);
      throw outage();
    }
    return step(real, args);
  };
}

const ship = { carrierName: 'Harbor Parcel Ground', trackingNumber: 'HAP-ADV-1', shippingCostCents: 2440, dutyPaidCents: 200, labelFileId: null };

/** Mia's 2 x Lucky Cat plush (ship mode) filled by Wei, checked in, bought, receipt verified: $76.00 captured, $21.60 fee paid. */
async function throughProof(s: TestServer) {
  const placed = await placeBid(s.app, 'mia', { qty: 2, maxFeeCents: 1200 });
  const ask = await postAsk(s.app, 'wei', { capacity: 2, feeCents: 1200, etaInMin: 10 });
  await checkInAt(s.app, 'wei', ask.claim.id, SHOP.lngLat);
  const job = s.app.store.jobs.where('ask_id = ? AND bid_id = ?', ask.ask.id, placed.bid.id)[0]!;
  await s.app.exec(() => markBought(s.app, persona(s.app, 'wei'), job.id));
  await s.at(s.app.now() + 40 * MIN);
  const r = await upload(s.app, 'wei', 'receipt', 'genuine');
  const p = await upload(s.app, 'wei', 'item_photo', 'genuine');
  await s.app.exec(() => submitProof(s.app, persona(s.app, 'wei'), job.id, { receiptFileId: r.id, itemFileId: p.id }));
  await s.app.idle();
  return { bid: s.app.store.bids.must(placed.bid.id), job: s.app.store.jobs.must(job.id) };
}

const LOCAL_START = Date.parse('2026-11-12T09:30:00-05:00');

/** Jun's local errand (one shortcake) claimed by Dana, bought and verified; the handover capture is next. */
async function localVerified(s: TestServer) {
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
  const dana = persona(s.app, 'dana');
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
  return { placed, dana, job };
}

function bidRequest(s: TestServer): CreateBidRequest {
  return {
    shopId: SHOP.id,
    itemId: ITEM,
    qty: 1,
    retailCapCents: 2800,
    maxFeeCents: 1200,
    shippingBudgetCents: 3500,
    destination: NY_SHIP,
    deadlineAt: s.app.now() + 2 * DAY,
    funding: 'paypal',
    agent: null,
  };
}

describe('adversarial: requests that are closing take no new work', () => {
  it('refuses a direct claim on a request whose cancel is still voiding at PayPal, and closes it once the void lands', async () => {
    const s = await testServer();
    try {
      const placed = await placeBid(s.app, 'mia', { qty: 1, maxFeeCents: 1200 });
      trip(s, 'voidAuthorization', 'outage');
      await s.app.exec(() => cancelBid(s.app, { userId: 'mia', ops: false }, placed.bid.id));
      const bid = s.app.store.bids.must(placed.bid.id);
      assert.equal(bid.closeReason, 'requester_cancelled');
      assert.equal(s.app.store.holds.must(bid.holdId!).status, 'held', 'the void is still pending at PayPal');

      const wei = persona(s.app, 'wei');
      const err = await s.app
        .exec(() => claimBid(s.app, wei, bid.id, { qty: 1, etaAt: s.app.now() + 15 * MIN, modes: ['ship'], from: { lngLat: wei.home!, accuracyM: 10 } }))
        .catch((e: unknown) => e);
      assert.ok(err instanceof ContractError, `a cancelled request must not be claimable (got ${String(err)})`);
      assert.equal(s.app.store.jobs.where('bid_id = ?', bid.id).length, 0, 'no queuer buys for a cancelled request');

      await s.app.exec(() => recoverPending(s.app));
      assert.equal(s.app.store.holds.must(bid.holdId!).status, 'released');
      assert.equal(s.app.store.bids.must(bid.id).status, 'cancelled', 'the request closes when the void lands');
    } finally {
      await s.done();
    }
  });
});

describe('adversarial: payouts never exceed captures', () => {
  it('pays out the shipping that was captured when a shipment is retried with a different number', async () => {
    const s = await testServer();
    try {
      const { bid, job } = await throughProof(s);
      const wei = persona(s.app, 'wei');
      trip(s, 'captureAuthorization', 'outage');
      const first = await s.app.exec(() => addShipment(s.app, wei, job.id, { ...ship, shippingCostCents: 500, dutyPaidCents: 0 })).catch((e: unknown) => e);
      assert.equal(code(first), 'PAYPAL_UNAVAILABLE');
      // The retry asks for $26.40, but the capture already in flight is for $5.00 (plus its $0.69 processing).
      await s.app.exec(() => addShipment(s.app, wei, job.id, { ...ship, shippingCostCents: 2440, dutyPaidCents: 200 }));

      const captured = sum(s.app.store.ledger.where("job_id = ? AND kind = 'captured' AND status = 'succeeded'", job.id).map((e) => e.amount.cents));
      assert.equal(captured, 7977 + 569);
      assert.equal(s.app.store.holds.must(bid.holdId!).capturedCents, 8546);
      const payouts = s.app.store.payouts.where('job_id = ?', job.id);
      assert.deepEqual(
        payouts.map((p) => [p.purpose, p.amount.cents]),
        [
          ['fee', 2160],
          ['reimbursement', 5200 + 500],
        ],
      );
      assert.ok(sum(payouts.map((p) => p.amount.cents)) <= captured, 'never pay out more than was captured');
      assert.equal(s.app.store.jobs.must(job.id).amounts.shippingCents, 500);
    } finally {
      await s.done();
    }
  });
});

describe('adversarial: every job fits inside the hold', () => {
  it('refuses a quantity raise that would create jobs the hold cannot back', async () => {
    const s = await testServer();
    try {
      // One unit, up to $60 for the queue: $28 + $60 + $10 shipping + $5.08 processing reserve = $103.08 held.
      const placed = await placeBid(s.app, 'mia', { qty: 1, retailCapCents: 2800, maxFeeCents: 6000, shippingBudgetCents: 1000 });
      const hold = s.app.store.holds.must(placed.bid.holdId!);
      assert.equal(hold.amount.cents, 10_308);
      await postAsk(s.app, 'wei', { capacity: 1, feeCents: 6000, etaInMin: 10 });
      assert.equal(s.app.store.jobs.where('bid_id = ?', placed.bid.id).length, 1, "Wei's job uses the whole $103.08");

      // 2 x ($28 + $5) + $10 + processing = $81.82 fits the formula, but Wei's job already committed all of the hold.
      const amended = await s.app
        .exec(() => amendBid(s.app, { userId: 'mia', ops: false }, placed.bid.id, { qty: 2, maxFeeCents: 500 }))
        .catch((e: unknown) => e);
      await postAsk(s.app, 'lin', { capacity: 1, feeCents: 500, etaInMin: 10 });

      const live = s.app.store.jobs.where('bid_id = ?', placed.bid.id).filter((j) => j.status !== 'failed');
      const committed = sum(live.map((j) => j.caps.retailCents + j.caps.feeCents + j.caps.shippingCents + (j.caps.processingCents ?? 0)));
      assert.ok(committed <= hold.amount.cents, `jobs may capture $${committed / 100} but PayPal holds $${hold.amount.cents / 100}`);
      assert.equal(code(amended), 'OVER_LIMIT');
    } finally {
      await s.done();
    }
  });
});

describe('adversarial: refunds are idempotent and recovered', () => {
  it('resends a refund whose answer was lost with the same key instead of refunding again', async () => {
    const s = await testServer();
    try {
      const { job } = await throughProof(s);
      const capId = s.app.store.ledger.first("job_id = ? AND kind = 'captured'", job.id)!.paypal!.captureId!;
      trip(s, 'refundCapture', 'lost');
      const first = await s.call('POST', `/api/ops/jobs/${job.id}/refund`, { body: { amountCents: 1000, reason: 'Box arrived dented' } });
      assert.equal(first.json.error?.code, 'PAYPAL_UNAVAILABLE');
      const again = await s.call('POST', `/api/ops/jobs/${job.id}/refund`, { body: { amountCents: 1000, reason: 'Box arrived dented' } });
      assert.equal(again.status, 200, JSON.stringify(again.json));

      assert.equal(s.app.fakePayPal.inspectCapture(capId)?.refundedCents, 1000, 'PayPal refunded $10.00 once');
      const refunds = s.app.store.ledger.where("job_id = ? AND kind = 'refunded'", job.id);
      assert.deepEqual(
        refunds.map((e) => [e.amount.cents, e.status]),
        [[1000, 'succeeded']],
      );
      assert.equal(s.app.store.jobs.must(job.id).amounts.refundedCents, 1000);
    } finally {
      await s.done();
    }
  });

  it('completes a refund left pending by an outage on the next recovery sweep', async () => {
    const s = await testServer();
    try {
      const { job } = await throughProof(s);
      const capId = s.app.store.ledger.first("job_id = ? AND kind = 'captured'", job.id)!.paypal!.captureId!;
      trip(s, 'refundCapture', 'outage');
      const err = await s.app.exec(() => refundJob(s.app, job.id, 7600, 'not shipped in time')).catch((e: unknown) => e);
      assert.equal(code(err), 'PAYPAL_UNAVAILABLE');
      const pending = s.app.store.ledger.first("job_id = ? AND kind = 'refunded'", job.id)!;
      assert.equal(pending.status, 'pending');

      await s.app.exec(() => recoverPending(s.app));
      assert.equal(s.app.store.ledger.must(pending.id).status, 'succeeded', 'the sweep resends the refund with its key');
      assert.equal(s.app.store.ledger.must(pending.id).idempotencyKey, `refund:${job.id}:1`);
      assert.equal(s.app.fakePayPal.inspectCapture(capId)?.refundedCents, 7600);
      assert.equal(s.app.store.jobs.must(job.id).amounts.refundedCents, 7600);
    } finally {
      await s.done();
    }
  });
});

describe('adversarial: payouts are never sent twice', () => {
  it('keeps a payout pending, never failed or resent, when PayPal says its batch already exists', async () => {
    const s = await testServer();
    try {
      const duplicate = () =>
        toPayPalError({
          op: 'payouts.create',
          method: 'POST',
          path: '/v1/payments/payouts',
          requestId: 'payout:test',
          status: 400,
          body: { name: 'USER_BUSINESS_ERROR', details: [{ issue: 'Batch with given sender_batch_id already exists' }] },
          debugIdHeader: 'debug-duplicate',
        });
      // The fee payout reaches PayPal but the answer is lost; PayPal then refuses the resend as a duplicate batch.
      trip(s, 'createPayout', 'lost', async () => {
        throw duplicate();
      });
      const { job } = await throughProof(s);
      const entry = s.app.store.ledger.first("job_id = ? AND kind = 'paid_out'", job.id)!;
      assert.equal(entry.status, 'pending');

      await s.app.exec(() => recoverPending(s.app));
      const payout = s.app.store.payouts.first('job_id = ?', job.id)!;
      assert.notEqual(payout.status, 'failed', 'the money went out; the payout must not read as failed');
      assert.notEqual(s.app.store.ledger.must(entry.id).status, 'failed');

      // Anything that asks for the fee payout again must not send a second batch.
      await s.app.exec(() => payoutsAfterCapture(s.app, job.id, 'receipt', { retailCents: 5200, feeCents: 2400, shippingCents: 0 }));
      await s.app.exec(() => recoverPending(s.app));
      assert.equal(s.app.fakePayPal.payoutItems().length, 1, 'PayPal sent one payout');
      assert.equal(s.app.store.payouts.where('job_id = ?', job.id).length, 1);
    } finally {
      await s.done();
    }
  });
});

describe('adversarial: no hold is left at PayPal without a live request', () => {
  it('opens a request whose authorization the recovery sweep completed, so the approval timeout cannot strand the hold', async () => {
    const s = await testServer();
    try {
      const created = await s.app.exec(() => createBid(s.app, persona(s.app, 'mia'), bidRequest(s)));
      await s.app.fakePayPal.approveOrder(created.checkout.orderId, 'paypal', 'approve');
      trip(s, 'authorizeOrder', 'outage');
      const err = await s.app
        .exec(() => authorizeBid(s.app, { userId: 'mia', ops: false }, created.bid.id, created.checkout.orderId))
        .catch((e: unknown) => e);
      assert.equal(code(err), 'PAYPAL_UNAVAILABLE');

      await s.app.exec(() => recoverPending(s.app));
      const hold = s.app.store.holds.must(created.bid.holdId!);
      assert.equal(hold.status, 'held');
      assert.equal(s.app.store.bids.must(created.bid.id).status, 'open', 'the buyer approved and PayPal authorized: the request joins the book');

      await s.at(created.bid.createdAt + APPROVAL_TIMEOUT_MS + MIN);
      const bid = s.app.store.bids.must(created.bid.id);
      const auth = s.app.fakePayPal.inspectAuthorization(s.app.store.holds.must(hold.id).authorizationId!);
      assert.ok(bid.status === 'open' || auth?.status === 'VOIDED', `request ${bid.status} while PayPal holds ${auth?.status}`);
    } finally {
      await s.done();
    }
  });

  it('voids an authorization that lands after the request was cancelled', async () => {
    const s = await testServer();
    try {
      const created = await s.app.exec(() => createBid(s.app, persona(s.app, 'mia'), bidRequest(s)));
      await s.app.fakePayPal.approveOrder(created.checkout.orderId, 'paypal', 'approve');
      trip(s, 'authorizeOrder', 'outage');
      await s.app.exec(() => authorizeBid(s.app, { userId: 'mia', ops: false }, created.bid.id, created.checkout.orderId)).catch(() => undefined);
      const out = await s.app.exec(() => cancelBid(s.app, { userId: 'mia', ops: false }, created.bid.id));
      assert.equal(out.bid.status, 'failed');

      await s.app.exec(() => recoverPending(s.app));
      const order = s.app.fakePayPal.inspectOrder(created.checkout.orderId)!;
      for (const id of order.authorizationIds) {
        assert.equal(s.app.fakePayPal.inspectAuthorization(id)?.status, 'VOIDED', 'PayPal holds nothing for a cancelled request');
      }
      assert.equal(s.app.store.ledger.count("bid_id = ? AND status = 'pending'", created.bid.id), 0, 'nothing left in flight');
    } finally {
      await s.done();
    }
  });

  it('opens, at the approval timeout, a request whose hold PayPal already authorized', async () => {
    const s = await testServer();
    try {
      const created = await s.app.exec(() => createBid(s.app, persona(s.app, 'mia'), bidRequest(s)));
      await s.app.fakePayPal.approveOrder(created.checkout.orderId, 'paypal', 'approve');
      // The authorization lands, but the server stops before the request opens (a crash between the two steps).
      await s.app.exec(() => authorizeHold(s.app, created.bid.id, created.checkout.orderId));
      assert.equal(s.app.store.bids.must(created.bid.id).status, 'awaiting_approval');
      const hold = s.app.store.holds.must(created.bid.holdId!);
      assert.equal(hold.status, 'held');

      await s.at(created.bid.createdAt + APPROVAL_TIMEOUT_MS + MIN);
      const bid = s.app.store.bids.must(created.bid.id);
      const auth = s.app.fakePayPal.inspectAuthorization(hold.authorizationId!);
      assert.ok(bid.status === 'open' || auth?.status === 'VOIDED', `request ${bid.status} while PayPal holds ${auth?.status}`);
    } finally {
      await s.done();
    }
  });

  it('never leaves a second authorization at PayPal when the answer to a renewal was lost', async () => {
    const s = await testServer();
    try {
      const placed = await placeBid(s.app, 'leo', { qty: 1, maxFeeCents: 1200, deadlineAt: s.app.now() + 9 * DAY });
      const h0 = s.app.store.holds.must(placed.bid.holdId!);
      trip(s, 'reauthorize', 'lost');
      await s.at(h0.honorEndsAt! + MIN);
      await s.app.exec(() => recoverPending(s.app));

      const child = s.app.fakePayPal.inspectAuthorization(h0.authorizationId!)?.supersededBy ?? null;
      assert.ok(child, 'PayPal created the renewed authorization');
      const h1 = s.app.store.holds.must(h0.id);
      const childStatus = s.app.fakePayPal.inspectAuthorization(child)?.status;
      assert.ok(h1.authorizationId === child || childStatus === 'VOIDED', `the hold uses ${h1.authorizationId}; the renewed authorization ${child} is ${childStatus}`);
      assert.equal(s.app.store.ledger.count("hold_id = ? AND status = 'pending'", h0.id), 0, 'nothing left in flight');
    } finally {
      await s.done();
    }
  });
});

describe('adversarial: an unreadable PayPal answer never leads to a second charge', () => {
  it('keeps a capture with an unreadable answer pending and resends it with the same key', async () => {
    const s = await testServer({ start: LOCAL_START });
    try {
      const { placed, dana, job } = await localVerified(s);
      trip(s, 'captureAuthorization', async (real, args) => {
        await real(...args);
        throw unexpectedResponse('authorizations.capture', 'no capture id', 'debug-odd');
      });
      const first = await s.app.exec(() => handover(s.app, dana, job.id, job.handoverCode!)).catch((e: unknown) => e);
      assert.ok(first instanceof ContractError);
      const entry = s.app.store.ledger.first("job_id = ? AND kind = 'captured'", job.id)!;
      assert.equal(entry.status, 'pending', 'PayPal may have charged: the outcome is unknown, so the entry stays pending');

      const res = await s.app.exec(() => handover(s.app, dana, job.id, job.handoverCode!));
      assert.equal(res.job.status, 'delivered');
      const hold = s.app.store.holds.must(placed.bid.holdId!);
      assert.equal(s.app.fakePayPal.captureCount(hold.authorizationId!), 1, 'charged once');
      assert.equal(hold.capturedCents, 4947);
      assert.deepEqual(s.app.store.payouts.all().map((x) => x.amount.cents), [4610]);
    } finally {
      await s.done();
    }
  });
});

describe('adversarial: the handover code is the requester consent', () => {
  it('locks the handover after five wrong codes, so the four-digit code cannot be guessed', async () => {
    const s = await testServer({ start: LOCAL_START });
    try {
      const { placed, dana, job } = await localVerified(s);
      const wrong = ['0000', '1111', '2222', '3333', '4444', '5555'].filter((c) => c !== job.handoverCode).slice(0, 5);
      for (const guess of wrong) {
        assert.equal(code(await s.app.exec(() => handover(s.app, dana, job.id, guess)).catch((e: unknown) => e)), 'WRONG_CODE');
      }
      const locked = await s.app.exec(() => handover(s.app, dana, job.id, job.handoverCode!)).catch((e: unknown) => e);
      assert.equal(code(locked), 'RATE_LIMITED', 'after five misses even the right code waits');
      assert.equal(s.app.store.holds.must(placed.bid.holdId!).capturedCents, 0, 'nothing captured while locked');

      await s.at(s.app.now() + 61 * MIN);
      const res = await s.app.exec(() => handover(s.app, dana, job.id, job.handoverCode!));
      assert.equal(res.job.status, 'delivered');
    } finally {
      await s.done();
    }
  });

  it('locks the code for good after ten wrong codes over any number of hours, so at most 10 of the 10,000 codes are ever tried (D-148)', async () => {
    const s = await testServer({ start: LOCAL_START });
    try {
      const { placed, dana, job } = await localVerified(s);
      const wrong = ['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234'].filter((c) => c !== job.handoverCode).slice(0, 10);
      for (const [i, guess] of wrong.entries()) {
        // Five per hour, as the hourly window allows; then the next hour.
        if (i === 5) await s.at(s.app.now() + 61 * MIN);
        assert.equal(code(await s.app.exec(() => handover(s.app, dana, job.id, guess)).catch((e: unknown) => e)), 'WRONG_CODE', `guess ${i + 1}`);
      }
      for (const wait of [61 * MIN, DAY, 10 * DAY]) {
        await s.at(s.app.now() + wait);
        const locked = await s.app.exec(() => handover(s.app, dana, job.id, job.handoverCode!)).catch((e: unknown) => e);
        assert.equal(code(locked), 'RATE_LIMITED', 'the right code no longer works');
        assert.equal((locked as ContractError).details?.locked, true);
      }
      assert.equal(s.app.store.holds.must(placed.bid.holdId!).capturedCents, 0, 'nothing captured');
      assert.equal(s.app.store.jobs.must(job.id).status, 'verified', 'the job waits for a person');
    } finally {
      await s.done();
    }
  });
});

describe('adversarial: payouts wait for a COMPLETED capture', () => {
  it('sends no payout while PayPal holds the receipt capture PENDING, and pays the fee once the status sync reads it COMPLETED', async () => {
    const s = await testServer({ env: { HMS_FAKE_FAIL: 'capture:pending' } });
    try {
      const { job } = await throughProof(s);
      const capture = s.app.store.ledger.first("job_id = ? AND kind = 'captured'", job.id)!;
      assert.equal(capture.status, 'pending', 'PayPal answered PENDING: the capture is not money yet');
      assert.ok(capture.paypal?.captureId);
      assert.equal(s.app.store.payouts.count(), 0, 'no payout on a PENDING capture');
      assert.equal(s.app.store.ledger.where("kind = 'paid_out'").length, 0);

      // The poller reads it again while PayPal still says PENDING: still nothing paid.
      await syncPayPal(s.app);
      assert.equal(s.app.store.payouts.count(), 0, 'still no payout while PENDING');

      s.app.fakePayPal.completePendingCapture(capture.paypal!.captureId!);
      await syncPayPal(s.app);
      await s.app.idle();
      assert.equal(s.app.store.ledger.must(capture.id).status, 'succeeded');
      const payouts = s.app.store.payouts.all();
      assert.equal(payouts.length, 1, 'the fee payout follows the COMPLETED capture');
      assert.equal(payouts[0]!.purpose, 'fee');
    } finally {
      await s.done();
    }
  });
});

describe('adversarial: a declined charge never completes the work', () => {
  it('fails a ship job whose receipt capture PayPal declined instead of leaving it verified', async () => {
    const s = await testServer({ env: { HMS_FAKE_FAIL: 'capture:decline' } });
    try {
      const { job } = await throughProof(s);
      const j = s.app.store.jobs.must(job.id);
      assert.equal(j.status, 'failed');
      assert.equal(j.failure?.reason, 'payment_failed');
      assert.equal(s.app.store.payouts.count(), 0);
    } finally {
      await s.done();
    }
  });

  it('never marks a local job delivered when PayPal declines the handover capture (the queuer keeps the item)', async () => {
    const s = await testServer({ start: LOCAL_START, env: { HMS_FAKE_FAIL: 'capture:decline' } });
    try {
      const { placed, dana, job } = await localVerified(s);
      const err = await s.app.exec(() => handover(s.app, dana, job.id, job.handoverCode!)).catch((e: unknown) => e);
      assert.equal(code(err), 'PAYPAL_DECLINED');
      const j = s.app.store.jobs.must(job.id);
      assert.notEqual(j.status, 'delivered', 'nothing was charged, so nothing is handed over');
      assert.equal(j.status, 'failed');
      assert.equal(j.failure?.reason, 'payment_failed');
      assert.equal(s.app.store.payouts.count(), 0);
      assert.equal(s.app.store.holds.must(placed.bid.holdId!).status, 'released', 'the rest of the hold is voided');
    } finally {
      await s.done();
    }
  });
});
