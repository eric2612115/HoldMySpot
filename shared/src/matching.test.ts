import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bidDepth, matchBook, nextClockStepAt, sortBids, type BookAsk, type BookBid, type BookContext } from './matching.ts';
import { usd } from './money.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 12, 18, 30); // 10:30 in San Francisco
const ctx: BookContext = { shopCityId: 'sf', now: T0 };
const ship = { mode: 'ship' as const, country: 'US' as const, region: 'NY', city: 'New York', postalCode: null };

const bid = (id: string, maxFee: number, qty: number, pricedAt = T0 - 60 * MIN, extra: Partial<BookBid> = {}): BookBid => ({
  id,
  requesterId: `r-${id}`,
  maxFeeCents: usd(maxFee),
  remainingQty: qty,
  destination: ship,
  deadlineAt: T0 + 6 * 60 * MIN,
  pricedAt,
  matchable: true,
  ...extra,
});

const ask = (id: string, fee: number, capacity: number, extra: Partial<BookAsk> = {}): BookAsk => ({
  id,
  queuerId: `q-${id}`,
  feeCents: usd(fee),
  clock: null,
  remainingCapacity: capacity,
  modes: ['ship'],
  etaAt: T0 + 20 * MIN,
  windowEndsAt: T0 + 30 * MIN,
  pricedAt: T0 - 10 * MIN,
  matchable: true,
  targetBidId: null,
  ...extra,
});

describe('price-time priority', () => {
  it('serves the highest bid first, then the earliest at the same price', () => {
    const fills = matchBook([bid('late-10', 10, 1, T0 - 5 * MIN), bid('early-10', 10, 1, T0 - 50 * MIN), bid('top-12', 12, 1, T0)], [ask('a', 9, 2)], ctx);
    assert.deepEqual(
      fills.map((f) => f.bidId),
      ['top-12', 'early-10'],
    );
  });

  it('gives the best bid the cheapest ask, earliest first at the same fee', () => {
    const fills = matchBook([bid('b', 12, 1)], [ask('dear', 11, 1), ask('cheap-late', 9, 1, { pricedAt: T0 - 1 * MIN }), ask('cheap-early', 9, 1, { pricedAt: T0 - 9 * MIN })], ctx);
    assert.deepEqual(fills, [{ bidId: 'b', askId: 'cheap-early', qty: 1, feeCents: usd(9), at: T0 }]);
  });

  it('always executes at the ask fee, never the bid max', () => {
    const [fill] = matchBook([bid('b', 14, 1)], [ask('a', 9, 1)], ctx);
    assert.equal(fill?.feeCents, usd(9));
  });

  it('does not trade when the best ask is above every max', () => {
    assert.deepEqual(matchBook([bid('b', 8, 1)], [ask('a', 9, 1)], ctx), []);
  });

  it('sorts deterministically by id on full ties', () => {
    const sorted = sortBids([bid('b2', 10, 1, T0), bid('b1', 10, 1, T0)]);
    assert.deepEqual(
      sorted.map((b) => b.id),
      ['b1', 'b2'],
    );
  });
});

describe('partial fills', () => {
  it('lets one queuer fill several bids, and one bid take several queuers', () => {
    const fills = matchBook([bid('mia', 12, 2, T0 - 30 * MIN), bid('sam', 11, 2, T0 - 20 * MIN)], [ask('wei', 10, 3), ask('lin', 10.5, 2, { pricedAt: T0 - 5 * MIN })], ctx);
    assert.deepEqual(
      fills.map((f) => [f.bidId, f.askId, f.qty]),
      [
        ['mia', 'wei', 2],
        ['sam', 'wei', 1],
        ['sam', 'lin', 1],
      ],
    );
  });

  it('does not change its inputs', () => {
    const bids = [bid('b', 12, 2)];
    const asks = [ask('a', 9, 1)];
    matchBook(bids, asks, ctx);
    assert.equal(bids[0]?.remainingQty, 2);
    assert.equal(asks[0]?.remainingCapacity, 1);
  });
});

describe('fee clock fills', () => {
  const clocked = ask('wei', 15, 6, {
    clock: { stepCents: usd(1), intervalMs: 5 * MIN, floorCents: usd(8), startsAt: T0 },
    etaAt: T0,
    windowEndsAt: null,
  });

  it('fills a resting bid at the first clock step at or below its max', () => {
    const bids = [bid('mia', 12.5, 2)];
    assert.deepEqual(matchBook(bids, [clocked], { ...ctx, now: T0 + 10 * MIN }), []); // $13
    const fills = matchBook(bids, [clocked], { ...ctx, now: T0 + 15 * MIN }); // $12
    assert.deepEqual(fills, [{ bidId: 'mia', askId: 'wei', qty: 2, feeCents: usd(12), at: T0 + 15 * MIN }]);
  });

  it('does not run the clock before check-in', () => {
    const notStarted = { ...clocked, clock: { stepCents: usd(1), intervalMs: 5 * MIN, floorCents: usd(8), startsAt: null } };
    assert.deepEqual(matchBook([bid('mia', 12, 1)], [notStarted], { ...ctx, now: T0 + 60 * MIN }), []);
  });

  it('tells the server when to run matching again', () => {
    assert.equal(nextClockStepAt([clocked], T0 + 1 * MIN), T0 + 5 * MIN);
    assert.equal(nextClockStepAt([clocked], T0 + 40 * MIN), null); // at the floor
    assert.equal(nextClockStepAt([ask('fixed', 9, 1)], T0), null);
  });
});

describe('compatibility', () => {
  it('keeps local errands in the shop city and ship bids with shipping queuers', () => {
    const local = bid('local', 20, 1, T0, { destination: { mode: 'local', cityId: 'nyc' } });
    assert.deepEqual(matchBook([local], [ask('a', 9, 1, { modes: ['local', 'ship'] })], ctx), []);
    assert.equal(matchBook([local], [ask('a', 9, 1, { modes: ['local'] })], { ...ctx, shopCityId: 'nyc' }).length, 1);
    assert.deepEqual(matchBook([bid('s', 20, 1)], [ask('a', 9, 1, { modes: ['local'] })], ctx), []);
  });

  it('skips self-matches and lets a claim fill only its target bid', () => {
    assert.deepEqual(matchBook([bid('b', 20, 1, T0, { requesterId: 'same' })], [ask('a', 9, 1, { queuerId: 'same' })], ctx), []);
    const fills = matchBook([bid('higher', 20, 1), bid('target', 12, 1)], [ask('claim', 12, 1, { targetBidId: 'target' })], ctx);
    assert.deepEqual(
      fills.map((f) => f.bidId),
      ['target'],
    );
  });

  it('respects deadlines, arrival windows and matchability', () => {
    assert.deepEqual(matchBook([bid('b', 20, 1, T0, { deadlineAt: T0 + 10 * MIN })], [ask('a', 9, 1)], ctx), []); // ETA after deadline
    assert.deepEqual(matchBook([bid('b', 20, 1)], [ask('a', 9, 1)], { ...ctx, now: T0 + 31 * MIN }), []); // window closed
    assert.deepEqual(matchBook([bid('b', 20, 1, T0, { matchable: false })], [ask('a', 9, 1)], ctx), []);
    assert.deepEqual(matchBook([bid('b', 20, 1)], [ask('a', 9, 1, { matchable: false })], ctx), []);
  });
});

describe('depth', () => {
  it('groups resting bids by max fee, best first', () => {
    const rows = bidDepth([bid('a', 12, 2), bid('b', 12, 1), bid('c', 10, 3), bid('d', 14, 1, T0, { matchable: false })]);
    assert.deepEqual(rows, [
      { feeCents: usd(12), qty: 3, count: 2 },
      { feeCents: usd(10), qty: 3, count: 1 },
    ]);
  });
});
