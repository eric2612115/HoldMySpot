import { describe, expect, it } from 'vitest';
import { bestOffer, depthOf, holdFor, matchPoint, noOfferNote, offerFeeAt, retailCapFor, supplyLabel, units, withBookSummary } from './book';
import { buildCatalog } from './catalog';
import { usd } from './money';
import type { Bid, FeeOffer, TaskPoint } from './types';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 12, 18, 30);

const bid = (id: string, dollars: number, placedAt: number, extra: Partial<Bid> = {}): Bid => ({
  id,
  bidder: id,
  feeCents: usd(dollars),
  qty: 1,
  placedAt,
  deadlineAt: T0 + 24 * 60 * MIN,
  mode: 'local',
  ...extra,
});

const offer = (fee: number, extra: Partial<FeeOffer> = {}): FeeOffer => ({
  askId: 'ask-wei',
  queuerName: 'Wei',
  capacity: 1,
  supply: 1,
  feeCents: usd(fee),
  clock: null,
  checkedIn: true,
  etaAt: T0 - 10 * MIN,
  modes: ['local', 'ship'],
  note: '',
  ...extra,
});

function plushPoint(): TaskPoint {
  return buildCatalog('sf', T0).find((p) => p.id === 'plush-paper-moon')!;
}

describe('the fee clock lives on the offer and starts at check-in', () => {
  const clock = { stepCents: 100, intervalMs: 5 * MIN, floorCents: 800 };

  it('keeps the opening fee while the queuer is on the way', () => {
    const o = offer(15, { clock: { ...clock, startsAt: null }, checkedIn: false });
    expect(offerFeeAt(o, T0)).toBe(usd(15));
    expect(offerFeeAt(o, T0 + 60 * MIN)).toBe(usd(15));
  });

  it('steps $15 down by $1 every 5 minutes to the $8 floor after check-in', () => {
    const o = offer(15, { clock: { ...clock, startsAt: T0 } });
    expect(offerFeeAt(o, T0 + 4 * MIN)).toBe(usd(15));
    expect(offerFeeAt(o, T0 + 15 * MIN)).toBe(usd(12));
    expect(offerFeeAt(o, T0 + 120 * MIN)).toBe(usd(8));
  });

  it('picks the cheapest offer that still has room', () => {
    const p = { offers: [offer(12, { askId: 'a' }), offer(9, { askId: 'b', supply: 0 }), offer(10, { askId: 'c' })] };
    expect(bestOffer(p, T0)?.askId).toBe('c');
  });
});

describe('matching with the shared engine', () => {
  it('fills the highest max fee first at the offer fee, one per customer', () => {
    const p = withBookSummary({ ...plushPoint(), bids: [bid('late11', 11, T0 - 5 * MIN), bid('early11', 11, T0 - 50 * MIN), bid('low9', 9, T0)], offers: [offer(10)] });
    const fills = matchPoint(p, T0);
    expect(fills.map((f) => [f.bidId, f.qty, f.feeCents])).toEqual([['early11', 1, usd(10)]]);
  });

  it('fills a resting request when the clock steps to it', () => {
    const p = withBookSummary({ ...plushPoint(), bids: [bid('mine', 12, T0, { mine: true })], offers: [offer(15, { clock: { stepCents: 100, intervalMs: 5 * MIN, floorCents: 800, startsAt: T0 } })] });
    expect(matchPoint(p, T0 + 14 * MIN)).toEqual([]);
    expect(matchPoint(p, T0 + 15 * MIN).map((f) => f.feeCents)).toEqual([usd(12)]);
  });

  it('every demo book starts uncrossed', () => {
    for (const city of ['sf', 'nyc', 'taipei'] as const) {
      for (const p of buildCatalog(city, T0)) expect(matchPoint(p, T0), p.id).toEqual([]);
    }
  });
});

describe('book summary and holds', () => {
  it('groups requests by fee, best first', () => {
    const levels = depthOf([bid('a', 10, 1), bid('b', 12, 2), bid('c', 10, 3, { qty: 2 })]);
    expect(levels).toEqual([
      { feeCents: usd(12), qty: 1, count: 1 },
      { feeCents: usd(10), qty: 3, count: 2 },
    ]);
  });

  it('holds the shop price cap plus the max fee and processing at cost, like the server quote', () => {
    const p = plushPoint();
    expect(retailCapFor(p.retailCents)).toBe(usd(36));
    // Local: $48.00 plus $2.50 processing (one capture, one payout); shipped: $60.00 plus $3.70 (D-105).
    expect(holdFor(p, usd(12))).toBe(5050);
    expect(holdFor(p, usd(12), 1, usd(12))).toBe(6370);
  });

  it('counts spots and units', () => {
    expect(supplyLabel(1)).toBe('1 spot left');
    expect(supplyLabel(3)).toBe('3 spots left');
    expect(supplyLabel(0)).toBe('Fully booked');
    expect(units('plush', 1)).toBe('1 plush');
    expect(units('cake', 2)).toBe('2 cakes');
    expect(units('ramen', 2)).toBe('2 bowls');
  });
});

describe('catalog', () => {
  it('uses the server seed for San Francisco: cakes, plush and ramen, no other kinds', () => {
    const sf = buildCatalog('sf', T0);
    expect(sf.length).toBe(13);
    expect(new Set(sf.map((p) => p.kind))).toEqual(new Set(['cake', 'plush', 'ramen']));
    expect(sf[0].id).toBe('plush-paper-moon');
    expect(sf[0].perPersonLimit).toBe(1);
  });
});

describe('the offer card with no open offer', () => {
  const point = { status: 'open' as const, shop: { name: 'Paper Moon Toys' }, itemShort: 'plush', queue: { queuers: [] as string[] }, offers: [] };
  it('asks for a max fee until the viewer has one, then says the request rests there', () => {
    expect(noOfferNote(point as never, undefined)).toBe('No queuer has offered yet. Set your max fee: the first offer that reaches it takes your request.');
    expect(noOfferNote(point as never, { status: 'resting' })).toBe('No queuer has offered yet. Your request rests at your max fee: the first offer that reaches it takes it.');
    expect(noOfferNote({ ...point, queue: { queuers: ['Wei'] } } as never, { status: 'resting' })).toBe('Wei is fully booked. Your request rests at your max fee: the next offer that reaches it takes it.');
  });
  it('names the queuer who took the request, and a sell-out', () => {
    expect(noOfferNote(point as never, { status: 'bought', queuerName: 'Wei' })).toBe('Wei took your request. No other offer is open right now.');
    expect(noOfferNote({ ...point, status: 'sold_out' } as never, { status: 'resting' })).toBe('Paper Moon Toys has sold out of the plush.');
  });
});
