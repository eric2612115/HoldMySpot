import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from './contract.ts';
import {
  DAY_MS,
  PAYPAL_PRICING,
  assertBidMoney,
  assertCaptureWithinLimit,
  bidLimitCents,
  captureCapCents,
  formatUsd,
  fromPayPalValue,
  grossUpCapture,
  holdTiming,
  isFinalCapture,
  jobCaps,
  jobSettlement,
  localToUsdCents,
  maxFeeWithinLimitCents,
  paypalCaptureFeeCents,
  payoutItemsCovered,
  payoutsForCapture,
  platformFeeCents,
  processingReserveCents,
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
 * clock fills her at $12. Processing and payouts pass through at cost (D-105).
 */
describe('hero example (docs/DOMAIN.md)', () => {
  const bid = { qty: 1, retailCapCents: usd(36), maxFeeCents: usd(12), shippingBudgetCents: usd(12) };
  const job = { qty: 1, feeCents: usd(12) };
  const caps = jobCaps(bid, job, 'ship');

  it('holds the requester limit, the worst-case processing included', () => {
    // Capture #1 at its caps: $48.00 + $2.76 ($2.26 PayPal fee on $50.76, two $0.25 payouts); capture #2: $12.00 + $0.94.
    assert.equal(processingReserveCents(bid), 370);
    assert.equal(bidLimitCents(bid), 6370);
    assert.deepEqual(caps, { retailCents: usd(36), feeCents: usd(12), shippingCents: usd(12), processingCents: 370 });
    assert.equal(captureCapCents(caps, 'ship', 'receipt') + captureCapCents(caps, 'ship', 'shipping'), 6370);
  });

  it('captures retail at cost, the matched fee and processing at cost at the verified receipt', () => {
    const retail = 3400; // the receipt: one plush at $34.00, tax included
    const cap1 = receiptCapture(caps, retail, 'ship');
    assert.deepEqual(cap1, { retailCents: 3400, feeCents: 1200, captureFeeCents: 219, payoutFeesCents: 50, processingCents: 269, amountCents: 4869, clamped: false });
    assert.equal(paypalCaptureFeeCents(4869), 219, "PayPal's fee on $48.69: 3.49% is $1.70, plus $0.49");
    const left = assertCaptureWithinLimit({ limitCents: 6370, capturedCents: 0, status: 'held' }, cap1.amountCents);
    assert.equal(left, 1501);
  });

  it('captures shipping and its own processing at cost after tracking and releases the rest', () => {
    const cap2 = shippingCapture(caps, 875, 0);
    assert.deepEqual(cap2, { shippingCents: 875, captureFeeCents: 82, payoutFeesCents: 0, processingCents: 82, amountCents: 957, clamped: false });
    const left = assertCaptureWithinLimit({ limitCents: 6370, capturedCents: 4869, status: 'partially_captured' }, cap2.amountCents);
    assert.equal(left, 544); // released by the final capture
  });

  it('pays the queuer the fee first, then retail and shipping; processing pays PayPal to the cent', () => {
    const first = payoutsForCapture('ship', 'receipt', { retailCents: 3400, feeCents: 1200, shippingCents: 0 });
    assert.deepEqual(first, [{ purpose: 'fee', amountCents: 1080, platformFeeCents: 120 }]);
    const second = payoutsForCapture('ship', 'shipping', { retailCents: 3400, feeCents: 0, shippingCents: 875 });
    assert.deepEqual(second, [{ purpose: 'reimbursement', amountCents: 4275, platformFeeCents: 0 }]);
    // Charged 4869 + 957 = 5826 = shop 3400 + fee 1200 + shipping 875 + processing 351.
    assert.equal(4869 + 957, 3400 + 1200 + 875 + 269 + 82);
    // PayPal keeps 219 + 82 on the captures and 2 x 25 on the payouts = 351, the processing line exactly.
    const settlement = jobSettlement({ capturedCents: 5826, refundedCents: 0, paidOutCents: 1080 + 4275, processingCents: 351, paypalFeesCents: 219 + 82 + 50 });
    assert.deepEqual(settlement, { chargedCents: 5826, processingCents: 351, paidOutCents: 5355, paypalFeesCents: 351, platformCents: 120, processingVarianceCents: 0 });
  });

  it('still converts a receipt in another currency at a locked rate', () => {
    assert.equal(localToUsdCents({ currency: 'TWD', minor: 1680 }, 32.3), 5201);
  });
});

describe('processing and payouts at cost (D-105)', () => {
  it("prices captures like the recorded sandbox: 3.49% (half a cent up) + $0.49, and $0.25 per payout", () => {
    for (const [gross, fee] of [
      [7601, 314],
      [2640, 141],
      [1200, 91],
      [875, 80],
      [4600, 210],
    ]) {
      assert.equal(paypalCaptureFeeCents(gross!), fee, `fee on ${gross}`);
    }
    assert.equal(paypalCaptureFeeCents(0), 0, 'no capture, no fee');
    assert.deepEqual({ ...PAYPAL_PRICING }, { captureBps: 349, captureFixedCents: 49, payoutItemCents: 25 });
  });

  it('grosses every capture up to the cent: the net pays the base and the payout fees, and one cent less would not', () => {
    for (let base = 1; base < 40_000; base += 37) {
      for (const items of [0, 1, 2]) {
        const g = grossUpCapture(base, items);
        const net = g.amountCents - paypalCaptureFeeCents(g.amountCents);
        assert.equal(net, base + 25 * items, `net of ${g.amountCents}`);
        assert.ok(g.amountCents - 1 - paypalCaptureFeeCents(g.amountCents - 1) < base + 25 * items, `smallest capture for ${base}`);
        assert.equal(g.processingCents, g.captureFeeCents + g.payoutFeesCents);
        assert.equal(g.amountCents, base + g.processingCents);
      }
    }
    assert.deepEqual(grossUpCapture(0, 0), { baseCents: 0, amountCents: 0, captureFeeCents: 0, payoutFeesCents: 0, processingCents: 0 });
  });

  it('puts every payout fee on the first capture of a job, none on the shipping capture', () => {
    assert.equal(payoutItemsCovered('ship', 'receipt'), 2);
    assert.equal(payoutItemsCovered('ship', 'shipping'), 0);
    assert.equal(payoutItemsCovered('local', 'handover'), 1);
  });

  it('a local errand: one capture at the handover, one payout, HoldMySpot keeps exactly 10% of the fee', () => {
    // The New York shortcake errand (server/src/demo/scripts/others.ts): cap $40, fee $9, receipt $38.00.
    const bid = { qty: 1, retailCapCents: 4000, maxFeeCents: 900, shippingBudgetCents: 0 };
    assert.equal(bidLimitCents(bid, 'local'), 5154);
    const caps = jobCaps(bid, { qty: 1, feeCents: 900 }, 'local');
    const cap = receiptCapture(caps, 3800, 'local');
    assert.deepEqual(cap, { retailCents: 3800, feeCents: 900, captureFeeCents: 222, payoutFeesCents: 25, processingCents: 247, amountCents: 4947, clamped: false });
    const [payout] = payoutsForCapture('local', 'handover', { retailCents: 3800, feeCents: 900, shippingCents: 0 });
    assert.equal(payout?.amountCents, 4610);
    const s = jobSettlement({ capturedCents: 4947, refundedCents: 0, paidOutCents: 4610, processingCents: 247, paypalFeesCents: 222 + 25 });
    assert.equal(s.platformCents, 90);
    assert.equal(s.processingVarianceCents, 0);
    assert.equal(5154 - 4947, 207, 'released by the final capture');
  });

  it('a sold-out line, a rejected receipt or a no-show captures nothing: $0 for everyone, PayPal charges nothing', () => {
    const s = jobSettlement({ capturedCents: 0, refundedCents: 0, paidOutCents: 0, processingCents: 0, paypalFeesCents: 0 });
    assert.deepEqual(s, { chargedCents: 0, processingCents: 0, paidOutCents: 0, paypalFeesCents: 0, platformCents: 0, processingVarianceCents: 0 });
  });

  it('a shipped job whose label is free still covers both payouts from the receipt capture', () => {
    const caps = jobCaps({ qty: 1, retailCapCents: 3600, shippingBudgetCents: 1200 }, { qty: 1, feeCents: 1200 }, 'ship');
    const cap1 = receiptCapture(caps, 3400, 'ship');
    const cap2 = shippingCapture(caps, 0, 0);
    assert.equal(cap2.amountCents, 0, 'nothing to charge, no capture, no PayPal fee');
    const paid = 1080 + 3400;
    const s = jobSettlement({ capturedCents: cap1.amountCents, refundedCents: 0, paidOutCents: paid, processingCents: cap1.processingCents, paypalFeesCents: cap1.captureFeeCents + 50 });
    assert.equal(s.platformCents, 120);
  });

  it('keeps HoldMySpot at or above zero on every completed job, for any receipt, fee and label', () => {
    for (let retail = 100; retail <= 9000; retail += 433) {
      for (const fee of [300, 800, 1200, 2500]) {
        for (const label of [0, 450, 875, 2000]) {
          const ship = jobCaps({ qty: 1, retailCapCents: 9000, shippingBudgetCents: 2000 }, { qty: 1, feeCents: fee }, 'ship');
          const c1 = receiptCapture(ship, retail, 'ship');
          const c2 = shippingCapture(ship, label, 0);
          const paid = payoutsForCapture('ship', 'receipt', { retailCents: retail, feeCents: fee, shippingCents: 0 })[0]!.amountCents + retail + label;
          const fees = paypalCaptureFeeCents(c1.amountCents) + paypalCaptureFeeCents(c2.amountCents) + 50;
          const s = jobSettlement({ capturedCents: c1.amountCents + c2.amountCents, refundedCents: 0, paidOutCents: paid, processingCents: c1.processingCents + c2.processingCents, paypalFeesCents: fees });
          assert.equal(s.platformCents, platformFeeCents(fee), `ship ${retail}/${fee}/${label}`);
          const local = receiptCapture(jobCaps({ qty: 1, retailCapCents: 9000, shippingBudgetCents: 0 }, { qty: 1, feeCents: fee }, 'local'), retail, 'local');
          const lp = payoutsForCapture('local', 'handover', { retailCents: retail, feeCents: fee, shippingCents: 0 })[0]!.amountCents;
          assert.equal(local.amountCents - lp - paypalCaptureFeeCents(local.amountCents) - 25, platformFeeCents(fee), `local ${retail}/${fee}`);
        }
      }
    }
  });

  it('sizes a multi-unit hold for the worst split: one job per unit, each capture at its cap', () => {
    const bid = { qty: 6, retailCapCents: 2800, maxFeeCents: 1200, shippingBudgetCents: 3500 };
    const perUnit = jobCaps(bid, { qty: 1, feeCents: 1200 }, 'ship').processingCents;
    assert.equal(processingReserveCents(bid), 6 * perUnit);
    assert.equal(bidLimitCents(bid), 6 * (2800 + 1200) + 3500 + 6 * perUnit);
    // Any split's captures at their caps fit in the hold.
    for (const split of [[6], [3, 3], [2, 2, 2], [1, 2, 3], [1, 1, 1, 1, 1, 1], [4, 1, 1]]) {
      const total = split.reduce((sum, q) => {
        const c = jobCaps(bid, { qty: q, feeCents: 1200 }, 'ship');
        return sum + captureCapCents(c, 'ship', 'receipt') + captureCapCents(c, 'ship', 'shipping');
      }, 0);
      assert.ok(total <= bidLimitCents(bid), `split ${split.join('+')}: ${total} within ${bidLimitCents(bid)}`);
    }
  });

  it('finds the highest max fee a hold still covers (the bidding agent ceiling)', () => {
    const b = { qty: 2, retailCapCents: 2800, shippingBudgetCents: 3500 };
    const hold = bidLimitCents({ ...b, maxFeeCents: 1500 });
    const ceiling = maxFeeWithinLimitCents(b, hold)!;
    assert.ok(ceiling >= 1500);
    assert.ok(bidLimitCents({ ...b, maxFeeCents: ceiling }) <= hold);
    assert.ok(bidLimitCents({ ...b, maxFeeCents: ceiling + 1 }) > hold);
    assert.equal(maxFeeWithinLimitCents({ qty: 1, retailCapCents: 3600, shippingBudgetCents: 1200 }, 6370), 1200, "Mia's $63.70 hold covers exactly her $12 fee");
    assert.equal(maxFeeWithinLimitCents(b, 100), null);
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
    const cap = receiptCapture(caps, usd(38), 'local');
    assert.equal(cap.retailCents, usd(36));
    assert.equal(cap.clamped, true);
    assert.equal(cap.amountCents, usd(46) + cap.processingCents);
    assert.equal(cap.amountCents, captureCapCents(caps, 'local', 'handover'), 'a clamped receipt captures exactly the cap');
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
