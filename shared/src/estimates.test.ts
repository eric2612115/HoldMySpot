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
  it('suggests a $36 retail cap for a $34.00 plush and discloses a $60.00 hold', () => {
    const cap = suggestedRetailCapCents(plush.retailCents);
    assert.equal(cap, 3600);
    const b = { qty: 1, retailCapCents: cap, maxFeeCents: 1200, shippingBudgetCents: 1200, mode: 'ship' as const };
    assert.equal(bidLimitCents(b), 6000);
    const [hold, fee] = bidDisclosures(b);
    assert.match(hold!, /PayPal holds up to \$60\.00\./);
    assert.match(fee!, /keeps 10% of the queue fee/);
    assert.deepEqual(platformFeeLine(1200), { bps: 1000, perUnitCents: 120 });
  });
});
