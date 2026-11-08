import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bidDisclosures,
  expectedWaitMinutes,
  platformFeeLine,
  shippingNumbers,
  suggestedClock,
  suggestedFeeCents,
  suggestedRetailCapCents,
} from './estimates.ts';
import { bidLimitCents } from './money.ts';
import { HERO, findItem } from './seed.ts';

const plush = findItem(HERO.itemId)!;

describe('fee estimate (docs/AI-SERVICES.md 4.3)', () => {
  it('suggests $12 and a $15 to $8 clock for the Paper Moon plush at 50 minutes', () => {
    const wait = expectedWaitMinutes(plush, null);
    assert.equal(wait, 50);
    const fee = suggestedFeeCents(plush, wait);
    assert.equal(fee, 1200);
    assert.deepEqual(suggestedClock(plush, fee), { feeCents: 1500, stepCents: 100, intervalMs: 300_000, floorCents: 800 });
  });

  it('uses a line photo count when there is one and never goes below the item minimum', () => {
    assert.equal(expectedWaitMinutes(plush, 40), 50); // 40 people x 75 s
    assert.equal(suggestedFeeCents(plush, 5), 500);
  });
});

describe('shipping estimate (docs/AI-SERVICES.md 4.4)', () => {
  it('gives 650 g, $9.00 domestic shipping, no duty and a $12 budget for one plush', () => {
    const s = shippingNumbers(plush, 1);
    assert.equal(s.parcelGrams, 650);
    assert.equal(s.shippingCents, 900);
    assert.equal(s.dutyCents, 0);
    assert.equal(s.budgetCents, 1200);
  });
});

describe('bid quote helpers', () => {
  it('suggests a $36 retail cap for a $34.00 plush and discloses a $63.70 hold with processing at cost', () => {
    const cap = suggestedRetailCapCents(plush.retailCents);
    assert.equal(cap, 3600);
    const b = { qty: 1, retailCapCents: cap, maxFeeCents: 1200, shippingBudgetCents: 1200, mode: 'ship' as const };
    assert.equal(bidLimitCents(b), 6370);
    const [hold, fee, processing] = bidDisclosures(b);
    assert.match(hold!, /PayPal holds up to \$63\.70\. You pay the receipt price, the matched fee, the shipping the queuer declares \(up to your budget\) and processing at cost/);
    assert.match(fee!, /keeps 10% of the queue fee\. The shop price from the receipt, the shipping the queuer declares and processing are passed through with no markup\./);
    assert.equal(processing, 'Processing and payouts: up to $3.70, what taking your payment and paying the queuer costs (3.49% + $0.49 per charge, $0.25 per payout). HoldMySpot makes nothing on it.');
    assert.deepEqual(platformFeeLine(1200), { bps: 1000, perUnitCents: 120 });
  });

  it('discloses a local errand without shipping', () => {
    const [hold, fee] = bidDisclosures({ qty: 1, retailCapCents: 4000, maxFeeCents: 900, shippingBudgetCents: 0, mode: 'local' });
    assert.match(hold!, /PayPal holds up to \$51\.54\. You pay the receipt price, the matched fee and processing at cost/);
    assert.match(fee!, /The shop price from the receipt and processing are passed through with no markup\./);
  });
});
