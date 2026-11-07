import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  askClockStopsAt,
  askFeeAt,
  askNextDropAt,
  clockProblem,
  fillPriceForMax,
  isAtFloor,
  ladder,
  maxSteps,
  nextDropAt,
  nextPriceAfter,
  priceAt,
  reachesAt,
  type StepDownSchedule,
} from './stepdown.ts';
import { usd } from './money.ts';

const MIN = 60_000;
const sale: StepDownSchedule = {
  openCents: usd(250),
  stepCents: usd(5),
  intervalMs: 5 * MIN,
  floorCents: usd(200),
  startsAt: 1_000_000,
};
const at = (minutes: number) => sale.startsAt + minutes * MIN;

// Same cases as web/src/domain/auction.test.ts: the shared module must behave identically.
describe('step-down schedule (parity with the web prototype)', () => {
  it('opens at the ceiling', () => {
    assert.equal(priceAt(sale, at(0)), usd(250));
    assert.equal(priceAt(sale, at(4.99)), usd(250));
    assert.equal(priceAt(sale, at(-10)), usd(250));
  });

  it('drops $5 every 5 minutes', () => {
    assert.equal(priceAt(sale, at(5)), usd(245));
    assert.equal(priceAt(sale, at(10)), usd(240));
    assert.equal(priceAt(sale, at(27)), usd(225));
  });

  it('reaches the floor after 50 minutes and never goes below it', () => {
    assert.equal(maxSteps(sale), 10);
    assert.equal(priceAt(sale, at(49.9)), usd(205));
    assert.equal(priceAt(sale, at(50)), usd(200));
    assert.equal(priceAt(sale, at(500)), usd(200));
    assert.equal(isAtFloor(sale, at(50)), true);
  });

  it('reports the next drop', () => {
    assert.equal(nextDropAt(sale, at(5.01)), at(10));
    assert.equal(nextPriceAfter(sale, at(5.01)), usd(240));
    assert.equal(nextDropAt(sale, at(50)), null);
    assert.equal(nextPriceAfter(sale, at(55)), null);
  });

  it('fills a resting max at the first step at or below it', () => {
    assert.equal(reachesAt(sale, usd(222)), at(30));
    assert.equal(fillPriceForMax(sale, usd(222)), usd(220));
    assert.equal(fillPriceForMax(sale, usd(240)), usd(240));
    assert.equal(fillPriceForMax(sale, usd(260)), usd(250));
    assert.equal(fillPriceForMax(sale, usd(199)), null);
    assert.equal(fillPriceForMax(sale, usd(200)), usd(200));
  });

  it('handles a ladder whose step does not divide the range', () => {
    const odd: StepDownSchedule = { ...sale, openCents: usd(15), stepCents: usd(1), floorCents: usd(8) };
    assert.equal(maxSteps(odd), 7);
    const uneven: StepDownSchedule = { ...sale, openCents: usd(250), stepCents: usd(15), floorCents: usd(200) };
    assert.equal(maxSteps(uneven), 4);
    assert.equal(priceAt(uneven, at(60)), usd(200));
    assert.deepEqual(
      ladder(uneven).map((s) => s.priceCents),
      [usd(250), usd(235), usd(220), usd(205), usd(200)],
    );
  });

  it('builds the whole ladder', () => {
    const steps = ladder(sale);
    assert.equal(steps.length, 11);
    assert.equal(steps[0]?.priceCents, usd(250));
    assert.equal(steps[10]?.priceCents, usd(200));
  });
});

describe('ask fee clock', () => {
  const clock = { stepCents: usd(1), intervalMs: 5 * MIN, floorCents: usd(8) };

  it('stays at the opening fee until check-in starts the clock', () => {
    const ask = { feeCents: usd(15), clock: { ...clock, startsAt: null } };
    assert.equal(askFeeAt(ask, at(0)), usd(15));
    assert.equal(askFeeAt(ask, at(500)), usd(15));
    assert.equal(askNextDropAt(ask, at(0)), null);
  });

  it('steps $15 down by $1 every 5 minutes to an $8 floor once started', () => {
    const ask = { feeCents: usd(15), clock: { ...clock, startsAt: at(0) } };
    assert.equal(askFeeAt(ask, at(4)), usd(15));
    assert.equal(askFeeAt(ask, at(15)), usd(12));
    assert.equal(askFeeAt(ask, at(35)), usd(8));
    assert.equal(askFeeAt(ask, at(90)), usd(8));
    assert.equal(askNextDropAt(ask, at(16)), at(20));
  });

  it('keeps a fixed fee without a clock', () => {
    assert.equal(askFeeAt({ feeCents: usd(9), clock: null }, at(100)), usd(9));
  });

  it('rejects clocks that cannot work', () => {
    assert.equal(clockProblem(usd(15), clock), null);
    assert.match(clockProblem(usd(7), clock) ?? '', /floor/);
    assert.match(clockProblem(usd(15), { ...clock, stepCents: 0 }) ?? '', /step/);
    assert.match(clockProblem(usd(15), { ...clock, intervalMs: 1_000 }) ?? '', /interval/);
  });
});

describe('askClockStopsAt (D-132)', () => {
  const T = Date.UTC(2026, 10, 12, 18, 50);
  const wei = { feeCents: 1500, clock: { stepCents: 100, intervalMs: 5 * MIN, floorCents: 800, startsAt: T }, remainingCapacity: 1, updatedAt: T };
  it('runs to the floor while the offer is open', () => {
    assert.equal(askClockStopsAt({ ...wei, status: 'open' }, null), T + 35 * MIN);
  });
  it('stops at the match that took the last unit, even after the ask closes later', () => {
    const matchedAt = T + 15 * MIN;
    assert.equal(askClockStopsAt({ ...wei, status: 'filled', remainingCapacity: 0, updatedAt: matchedAt }, matchedAt), matchedAt);
    // The visit ends at 11:40 (ask closed): the clock still stopped at the 11:05 match, at $12.
    const closed = { ...wei, status: 'closed', remainingCapacity: 0, updatedAt: T + 50 * MIN };
    assert.equal(askClockStopsAt(closed, matchedAt), matchedAt);
    assert.equal(askFeeAt(closed, askClockStopsAt(closed, matchedAt)!), 1200);
  });
  it('stops when an unfilled offer stopped selling, never past the floor', () => {
    assert.equal(askClockStopsAt({ ...wei, status: 'withdrawn', updatedAt: T + 7 * MIN }, null), T + 7 * MIN);
    assert.equal(askClockStopsAt({ ...wei, status: 'closed', updatedAt: T + 90 * MIN }, null), T + 35 * MIN);
  });
  it('is null before the clock starts', () => {
    assert.equal(askClockStopsAt({ ...wei, clock: { ...wei.clock, startsAt: null }, status: 'open' }, null), null);
  });
});
