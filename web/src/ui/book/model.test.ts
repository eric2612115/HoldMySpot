import { describe, expect, it } from 'vitest';
import { usd } from '../../domain/money';
import type { Bid, FeeOffer } from '../../domain/types';
import { askRows, bidLevels, demoClockOffer, derivedFills, ladderPrices, meetingOf, mergeTape, nextStepAt, noOfferWords, rowOf, spreadOf, type TapeRow } from './model';

const MIN = 60_000;
/** 10:30 on the demo day in San Francisco. */
const T0 = Date.parse('2026-11-12T10:30:00-08:00');
const at = (hhmm: string) => Date.parse(`2026-11-12T${hhmm}:00-08:00`);

/** Wei's hero offer: $15, down $1 every 5 minutes to $8 once he checks in at 10:50. */
const wei = (extra: Partial<FeeOffer> = {}): FeeOffer => ({
  askId: 'ask-wei',
  queuerName: 'Wei',
  capacity: 1,
  supply: 1,
  feeCents: usd(15),
  clock: { stepCents: 100, intervalMs: 5 * MIN, floorCents: 800, startsAt: at('10:50') },
  checkedIn: true,
  etaAt: at('10:50'),
  modes: ['local', 'ship'],
  note: '',
  ...extra,
});

const lin: FeeOffer = { ...wei(), askId: 'ask-lin', queuerName: 'Lin', feeCents: usd(10), clock: null, etaAt: at('11:20') };

const bid = (id: string, dollars: number, extra: Partial<Bid> = {}): Bid => ({
  id,
  bidder: id,
  feeCents: usd(dollars),
  qty: 1,
  placedAt: T0 - 30 * MIN,
  deadlineAt: T0 + 48 * 60 * MIN,
  mode: 'local',
  ...extra,
});

/** The hero book as the server sends it at 10:52: depth only, with what PayPal holds at each level. */
const serverBook = {
  bids: [] as Bid[],
  retailCents: 3400,
  depth: [
    { feeCents: 1200, qty: 1, count: 1, heldCents: 6000 },
    { feeCents: 1050, qty: 1, count: 1, heldCents: 5850 },
    { feeCents: 1000, qty: 2, count: 2, heldCents: 9200 },
    { feeCents: 950, qty: 1, count: 1, heldCents: 4550 },
    { feeCents: 900, qty: 2, count: 2, heldCents: 9000 },
  ],
};

describe('requests (bids) by fee level', () => {
  it('reads the server depth with the money held at each level and marks the best and my own', () => {
    const levels = bidLevels(serverBook, 1200);
    expect(levels.map((l) => [l.feeCents, l.count, l.heldCents, l.best, l.mine])).toEqual([
      [1200, 1, 6000, true, true],
      [1050, 1, 5850, false, false],
      [1000, 2, 9200, false, false],
      [950, 1, 4550, false, false],
      [900, 2, 9000, false, false],
    ]);
  });

  it('says nothing about held money when the server does not send it', () => {
    const levels = bidLevels({ ...serverBook, depth: [{ feeCents: 1100, qty: 1, count: 1 }] });
    expect(levels[0]?.heldCents).toBeNull();
  });

  it('groups single requests with the shared depth and the hold rule (in-browser market)', () => {
    // Plush at $34: the hold per unit is the $36 shop price cap plus the max fee, plus processing at cost (D-105).
    const point = { retailCents: 3400, depth: [], bids: [bid('a', 10), bid('b', 12, { mine: true }), bid('c', 10, { qty: 2 }), bid('d', 9)] };
    const levels = bidLevels(point);
    expect(levels.map((l) => [l.feeCents, l.count, l.qty, l.heldCents, l.mine])).toEqual([
      [1200, 1, 1, 5050, true],
      [1000, 2, 3, 14529, false],
      [900, 1, 1, 4739, false],
    ]);
  });
});

describe('offers (asks) with their step-down clocks', () => {
  it("walks Wei's fee down from $15 after check-in, with the next drop and how far the interval has run", () => {
    const [a] = askRows({ offers: [wei()] }, at('10:52'));
    expect(a).toMatchObject({ feeNowCents: 1500, running: true, nextAt: at('10:55'), nextFeeCents: 1400, atFloor: false, best: true });
    expect(a!.progress).toBeCloseTo(0.4);
    expect(a!.steps?.map((s) => s.priceCents)).toEqual([1500, 1400, 1300, 1200, 1100, 1000, 900, 800]);
    expect(askRows({ offers: [wei()] }, at('11:05'))[0]!.feeNowCents).toBe(1200);
    const floor = askRows({ offers: [wei()] }, at('12:30'))[0]!;
    expect([floor.feeNowCents, floor.nextAt, floor.atFloor, floor.progress]).toEqual([800, null, true, null]);
  });

  it('keeps the opening fee before check-in and previews the clock from the ETA', () => {
    const onTheWay = wei({ checkedIn: false, clock: { stepCents: 100, intervalMs: 5 * MIN, floorCents: 800, startsAt: null } });
    const [a] = askRows({ offers: [onTheWay] }, at('11:30'));
    expect(a).toMatchObject({ feeNowCents: 1500, running: false, nextAt: null, nextFeeCents: null, progress: null });
    expect(a!.schedule?.startsAt).toBe(at('10:50'));
  });

  it('sorts by the fee now (shared price-time priority) and drops offers with no room', () => {
    const rows = askRows({ offers: [wei(), lin, { ...lin, askId: 'ask-full', supply: 0, feeCents: usd(5) }] }, at('10:52'));
    expect(rows.map((r) => [r.queuerName, r.feeNowCents, r.best])).toEqual([
      ['Lin', 1000, true],
      ['Wei', 1500, false],
    ]);
  });
});

describe('the spread and when the clock meets a request', () => {
  it('measures the best offer against the best request', () => {
    const levels = bidLevels(serverBook);
    expect(spreadOf(levels, askRows({ offers: [wei()] }, at('10:52')))).toEqual({ bidCents: 1200, askCents: 1500, spreadCents: 300, crossed: false });
    expect(spreadOf(levels, askRows({ offers: [wei()] }, at('11:05'))).crossed).toBe(true);
    expect(spreadOf(levels, []).spreadCents).toBeNull();
  });

  it("finds 11:05 at $12 for Mia's request, the first step under $10.50, and never below the floor", () => {
    const [a] = askRows({ offers: [wei()] }, at('10:52'));
    expect(meetingOf(a, 1200)).toEqual({ feeCents: 1200, at: at('11:05'), afterStartMs: 15 * MIN });
    expect(meetingOf(a, 1050)).toEqual({ feeCents: 1000, at: at('11:15'), afterStartMs: 25 * MIN });
    expect(meetingOf(a, 700)).toBeNull();
    expect(meetingOf(askRows({ offers: [lin] }, at('10:52'))[0], 900)).toBeNull();
  });

  it('counts the time after check-in while the queuer is on the way', () => {
    const onTheWay = wei({ checkedIn: false, clock: { stepCents: 100, intervalMs: 5 * MIN, floorCents: 800, startsAt: null } });
    expect(meetingOf(askRows({ offers: [onTheWay] }, at('10:40'))[0], 1200)).toEqual({ feeCents: 1200, at: null, afterStartMs: 15 * MIN });
  });

  it('takes the earliest clock step of the book', () => {
    expect(nextStepAt(askRows({ offers: [wei(), lin] }, at('10:56')))).toBe(at('11:00'));
    expect(nextStepAt(askRows({ offers: [lin] }, at('10:56')))).toBeNull();
  });
});

describe('the ladder rows', () => {
  it("joins the request levels with Wei's whole ladder, highest first", () => {
    const rows = ladderPrices(bidLevels(serverBook), askRows({ offers: [wei()] }, at('10:52')));
    expect(rows).toEqual([1500, 1400, 1300, 1200, 1100, 1050, 1000, 950, 900, 800]);
    expect(rowOf(rows, 1200)).toBe(3);
    expect(rowOf(rows, 1025)).toBe(6);
    expect(rowOf(rows, 100)).toBe(9);
  });

  it('keeps the levels, the fee now, the next step, the opening fee and the floor when rows run short', () => {
    const rows = ladderPrices(bidLevels(serverBook), askRows({ offers: [wei()] }, at('10:57')), [1150], 8);
    for (const must of [1500, 1400, 1300, 1200, 1150, 1050, 1000, 950, 900, 800]) expect(rows).toContain(must);
    expect(rows).not.toContain(1100);
  });
});

describe('the tape of recent matches', () => {
  const row = (id: string, t: number, extra: Partial<TapeRow> = {}): TapeRow => ({
    id,
    feeCents: 1200,
    qty: 1,
    at: t,
    queuerName: null,
    trigger: 'clock_step',
    bidId: null,
    askId: null,
    ...extra,
  });

  it('keeps one line per match, newest first, and fills in a name it learns later', () => {
    const tape = mergeTape([row('m1', at('10:33'))], [row('m2', at('11:05')), row('m1', at('10:33'), { queuerName: 'Rex' })]);
    expect(tape.map((r) => [r.id, r.queuerName])).toEqual([
      ['m2', null],
      ['m1', 'Rex'],
    ]);
  });

  it('sees a fill in the in-browser market as an offer whose room went down, at its fee then', () => {
    const fills = derivedFills({ offers: [wei(), lin] }, { offers: [wei({ supply: 0 }), lin] }, at('11:05'));
    expect(fills.map((f) => [f.askId, f.feeCents, f.qty, f.queuerName])).toEqual([['ask-wei', 1200, 1, 'Wei']]);
    expect(derivedFills({ offers: [wei()] }, { offers: [] }, at('11:05'))).toHaveLength(1);
    expect(derivedFills({ offers: [wei()] }, { offers: [wei()] }, at('11:05'))).toEqual([]);
  });
});

describe('the demo clock in the book', () => {
  it('offers the scripted day only on a simulated-PayPal server that has not started it; a sandbox server gets Run and Next step', () => {
    expect(demoClockOffer('idle', 'fake')).toBe('start');
    expect(demoClockOffer('idle', null)).toBe('start');
    expect(demoClockOffer('idle', 'sandbox')).toBe('clock');
    for (const status of ['running', 'paused', 'finished'] as const) {
      expect(demoClockOffer(status, 'fake')).toBe('clock');
      expect(demoClockOffer(status, 'sandbox')).toBe('clock');
    }
  });
});

describe('the book with no open offer', () => {
  it('says "None yet" before anyone offered and "None open" once offers were taken, never "No queuer offered" beside a match', () => {
    expect(noOfferWords(false)).toMatchObject({ cell: 'None yet', sub: 'No queuer offered' });
    const after = noOfferWords(true);
    expect([after.cell, after.sub]).toEqual(['None open', 'every offer taken']);
    expect(after.note).toMatch(/^No open offer: every offer here was taken\./);
    expect(after.note).not.toMatch(/queuer offered|offer yet/);
  });
});
