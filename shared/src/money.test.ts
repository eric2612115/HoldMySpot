import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from './contract.ts';
import {
  DAY_MS,
  assertBidMoney,
  assertCaptureWithinLimit,
  bidLimitCents,
  formatUsd,
  fromPayPalValue,
  holdTiming,
  isFinalCapture,
  jobCaps,
  localToUsdCents,
  payoutsForCapture,
  platformFeeCents,
  receiptCapture,
  renewalVerdict,
  shippingCapture,
  toPayPalValue,
  usd,
} from './money.ts';

const code = (err: unknown) => (err instanceof ContractError ? err.code : 'not a ContractError');

/**
 * The worked example in docs/DOMAIN.md: Mia in New York asks for the Mochi
 * Bunny plush from Paper Moon Toys in San Francisco, shipped to her; Wei's fee
 * clock fills her at $12.
 */
describe('hero example (docs/DOMAIN.md)', () => {
  const bid = { qty: 1, retailCapCents: usd(36), maxFeeCents: usd(12), shippingBudgetCents: usd(12) };
  const job = { qty: 1, feeCents: usd(12) };
  const caps = jobCaps(bid, job);

  it('holds the requester limit', () => {
    assert.equal(bidLimitCents(bid), usd(60));
    assert.deepEqual(caps, { retailCents: usd(36), feeCents: usd(12), shippingCents: usd(12) });
  });

  it('captures retail at cost plus the matched fee at the verified receipt', () => {
    const retail = 3400; // the receipt: one plush at $34.00, tax included
    const cap1 = receiptCapture(caps, retail);
    assert.deepEqual(cap1, { retailCents: 3400, feeCents: 1200, amountCents: 4600, clamped: false });
    const left = assertCaptureWithinLimit({ limitCents: usd(60), capturedCents: 0, status: 'held' }, cap1.amountCents);
    assert.equal(left, 1400);
  });

  it('captures shipping at cost after tracking and releases the rest', () => {
    const cap2 = shippingCapture(caps, 875, 0);
    assert.deepEqual(cap2, { shippingCents: 875, clamped: false });
    const left = assertCaptureWithinLimit({ limitCents: usd(60), capturedCents: 4600, status: 'partially_captured' }, cap2.shippingCents);
    assert.equal(left, 525); // released by the final capture
  });

  it('pays the queuer the fee first, then retail and shipping', () => {
    const first = payoutsForCapture('ship', 'receipt', { retailCents: 3400, feeCents: 1200, shippingCents: 0 });
    assert.deepEqual(first, [{ purpose: 'fee', amountCents: 1080, platformFeeCents: 120 }]);
    const second = payoutsForCapture('ship', 'shipping', { retailCents: 3400, feeCents: 0, shippingCents: 875 });
    assert.deepEqual(second, [{ purpose: 'reimbursement', amountCents: 4275, platformFeeCents: 0 }]);
    // Charged 4600 + 875 = 5475 = paid out 1080 + 4275 + platform 120.
    assert.equal(4600 + 875, 1080 + 4275 + 120);
  });

  it('still converts a receipt in another currency at a locked rate', () => {
    assert.equal(localToUsdCents({ currency: 'TWD', minor: 1680 }, 32.3), 5201);
  });
});

describe('limits', () => {
  it('never captures a cent above the user limit, although PayPal would allow 115%', () => {
    const hold = { limitCents: usd(115), capturedCents: usd(100), status: 'partially_captured' as const };
    assert.equal(assertCaptureWithinLimit(hold, usd(15)), 0);
    assert.throws(() => assertCaptureWithinLimit(hold, usd(15) + 1), (e) => code(e) === 'OVER_LIMIT');
  });

  it('refuses captures on closed holds and invalid amounts', () => {
    assert.throws(() => assertCaptureWithinLimit({ limitCents: 1000, capturedCents: 0, status: 'released' }, 100), (e) => code(e) === 'HOLD_CLOSED');
    assert.throws(() => assertCaptureWithinLimit({ limitCents: 1000, capturedCents: 0, status: 'held' }, 10.5), (e) => code(e) === 'INVALID_AMOUNT');
    assert.throws(() => assertCaptureWithinLimit({ limitCents: 1000, capturedCents: 0, status: 'held' }, 0), (e) => code(e) === 'INVALID_AMOUNT');
  });

  it('clamps a receipt above the retail cap', () => {
    const caps = jobCaps({ qty: 1, retailCapCents: usd(36), shippingBudgetCents: 0 }, { qty: 1, feeCents: usd(10) });
    assert.deepEqual(receiptCapture(caps, usd(38)), { retailCents: usd(36), feeCents: usd(10), amountCents: usd(46), clamped: true });
  });

  it('shares the shipping budget by quantity, rounding down', () => {
    const bid = { qty: 3, retailCapCents: usd(27), shippingBudgetCents: 1000 };
    const a = jobCaps(bid, { qty: 1, feeCents: 500 });
    const b = jobCaps(bid, { qty: 2, feeCents: 500 });
    assert.equal(a.shippingCents, 333);
    assert.equal(b.shippingCents, 666);
    assert.ok(a.shippingCents + b.shippingCents <= 1000);
  });

  it('validates bid amounts against the mode', () => {
    assert.doesNotThrow(() => assertBidMoney({ qty: 1, retailCapCents: 3800, maxFeeCents: 800, shippingBudgetCents: 0 }, 'local'));
    assert.throws(() => assertBidMoney({ qty: 1, retailCapCents: 3800, maxFeeCents: 800, shippingBudgetCents: 500 }, 'local'), (e) => code(e) === 'MODE_NOT_ALLOWED');
    assert.throws(() => assertBidMoney({ qty: 1, retailCapCents: 3800, maxFeeCents: 800, shippingBudgetCents: 0 }, 'ship'), (e) => code(e) === 'BAD_REQUEST');
    assert.throws(() => assertBidMoney({ qty: 0, retailCapCents: 3800, maxFeeCents: 800, shippingBudgetCents: 0 }, 'local'), (e) => code(e) === 'BAD_REQUEST');
  });
});

describe('final capture flag', () => {
  it('is final only for the last possible capture on the hold', () => {
    const base = { moreCapturesForThisJob: false, otherActiveJobs: 0, bidRemainingQty: 0, bidCanStillMatch: false };
    assert.equal(isFinalCapture(base), true);
    assert.equal(isFinalCapture({ ...base, moreCapturesForThisJob: true }), false); // ship mode receipt capture
    assert.equal(isFinalCapture({ ...base, otherActiveJobs: 1 }), false);
    assert.equal(isFinalCapture({ ...base, bidRemainingQty: 1, bidCanStillMatch: true }), false);
    assert.equal(isFinalCapture({ ...base, bidRemainingQty: 1, bidCanStillMatch: false }), true);
  });
});

describe('platform fee and payouts', () => {
  it('takes 10% of the fee, rounded down in the queuer favour', () => {
    assert.equal(platformFeeCents(2400), 240);
    assert.equal(platformFeeCents(1299), 129);
  });

  it('pays everything at once after a local handover', () => {
    assert.deepEqual(payoutsForCapture('local', 'handover', { retailCents: 3800, feeCents: 900, shippingCents: 0 }), [
      { purpose: 'fee_and_reimbursement', amountCents: 4610, platformFeeCents: 90 },
    ]);
  });

  it('has no rule for impossible combinations', () => {
    assert.throws(() => payoutsForCapture('local', 'shipping', { retailCents: 0, feeCents: 0, shippingCents: 1 }), (e) => code(e) === 'BAD_REQUEST');
  });
});

describe('hold renewal', () => {
  const authorizedAt = Date.UTC(2026, 10, 8, 1, 0);
  const hold = { status: 'held' as const, capturedCents: 0, authorizedAt, originalAuthorizedAt: authorizedAt, renewalRequired: false };
  const open = { bidStillOpen: true, reauthorizeSupported: true };

  it('waits out the 3-day honor period', () => {
    assert.equal(renewalVerdict(hold, authorizedAt + 2 * DAY_MS, open), 'not_needed');
    assert.equal(renewalVerdict(hold, authorizedAt + 3 * DAY_MS, open), 'reauthorize');
  });

  it('asks for a new approval when reauthorization is too late or unsupported', () => {
    assert.equal(renewalVerdict(hold, authorizedAt + 28 * DAY_MS, open), 'renewal_required');
    assert.equal(renewalVerdict(hold, authorizedAt + 4 * DAY_MS, { ...open, reauthorizeSupported: false }), 'renewal_required');
  });

  it('never reauthorizes captured holds or closed bids', () => {
    assert.equal(renewalVerdict({ ...hold, capturedCents: 100, status: 'held' }, authorizedAt + 4 * DAY_MS, open), 'not_needed');
    assert.equal(renewalVerdict(hold, authorizedAt + 4 * DAY_MS, { ...open, bidStillOpen: false }), 'not_needed');
  });

  it('restarts the honor period but keeps the original validity', () => {
    const reauthorizedAt = authorizedAt + 4 * DAY_MS;
    const t = holdTiming({ authorizedAt: reauthorizedAt, originalAuthorizedAt: authorizedAt });
    assert.equal(t.honorEndsAt, reauthorizedAt + 3 * DAY_MS);
    assert.equal(t.expiresAt, authorizedAt + 29 * DAY_MS);
  });
});

describe('PayPal amounts', () => {
  it('round-trips cents and decimal strings', () => {
    assert.equal(toPayPalValue(11500), '115.00');
    assert.equal(toPayPalValue(5), '0.05');
    assert.equal(fromPayPalValue('115.00'), 11500);
    assert.equal(fromPayPalValue('12.3'), 1230);
    assert.equal(fromPayPalValue('7'), 700);
    assert.throws(() => fromPayPalValue('1.234'), (e) => code(e) === 'INVALID_AMOUNT');
  });

  it('formats like the web prototype', () => {
    assert.equal(formatUsd(24500), '$245');
    assert.equal(formatUsd(24500, { exact: true }), '$245.00');
    assert.equal(formatUsd(525), '$5.25');
  });
});
