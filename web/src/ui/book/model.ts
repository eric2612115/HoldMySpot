import { askNextDropAt, askSchedule, bidDepth, fillPriceForMax, ladder, nextPriceAfter, reachesAt, sortAsks } from '@holdmyspot/shared';
import type { MatchTrigger, PriceStep, StepDownSchedule } from '@holdmyspot/shared';
import { holdFor, offerFeeAt } from '../../domain/book';
import type { Cents } from '../../domain/money';
import type { FeeOffer, TaskPoint } from '../../domain/types';

/**
 * The order book of one shop item as plain data for the book view: requests
 * (bids) by fee level with the money PayPal holds behind them, offers (asks)
 * with their step-down clocks, the spread, the price rows of the ladder and
 * the recent matches. Every number comes from the shared rules
 * (shared/src/stepdown.ts, shared/src/matching.ts) or web/src/domain/book.ts;
 * nothing here prices anything on its own.
 */

export interface BidLevel {
  feeCents: Cents;
  /** Requests resting at this max fee. */
  count: number;
  /** Units they ask for. */
  qty: number;
  /** What PayPal holds for these requests, or null when the book does not say. */
  heldCents: Cents | null;
  /** The highest max fee: the request an offer meets first. */
  best: boolean;
  /** The viewer's own resting request is at this fee. */
  mine: boolean;
}

export interface AskRow {
  askId: string;
  queuerName: string;
  /** The fee per unit now: fixed, the opening fee before check-in, or the clock price after. */
  feeNowCents: Cents;
  /** The fixed fee, or the opening fee of the clock. */
  openCents: Cents;
  clock: { stepCents: Cents; intervalMs: number; floorCents: Cents } | null;
  /** The fee clock runs (the queuer checked in). */
  running: boolean;
  checkedIn: boolean;
  etaAt: number;
  /** The next drop, or null (fixed fee, clock not started, or at the floor). */
  nextAt: number | null;
  nextFeeCents: Cents | null;
  /** How much of the current interval has passed, 0 to 1, while the clock runs above the floor. */
  progress: number | null;
  /** The clock's schedule: running, or a preview from the ETA before check-in. Null for a fixed fee. */
  schedule: StepDownSchedule | null;
  /** The whole ladder from the opening fee to the floor. Null for a fixed fee. */
  steps: PriceStep[] | null;
  atFloor: boolean;
  supply: number;
  /** The lowest fee now: the offer a request meets first. */
  best: boolean;
}

export interface Spread {
  bidCents: Cents | null;
  askCents: Cents | null;
  /** Best offer minus best request, or null when a side is empty. */
  spreadCents: Cents | null;
  /** The best offer is at or below the best request (a match is due, or they cannot trade). */
  crossed: boolean;
}

export interface Meeting {
  /** The fee it fills at: the first clock step at or below the request. */
  feeCents: Cents;
  /** When, on the market clock, while the clock runs; null before check-in. */
  at: number | null;
  /** How long after the clock starts. */
  afterStartMs: number;
}

/** One line of the tape: a match on this book. */
export interface TapeRow {
  id: string;
  feeCents: Cents;
  qty: number;
  at: number;
  queuerName: string | null;
  trigger: MatchTrigger | null;
  bidId: string | null;
  askId: string | null;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Requests by max fee, best first. The in-browser market knows every request
 * (depth from the shared engine, holds from the hold rule); the server sends
 * depth only, with what PayPal holds at each level.
 */
export function bidLevels(point: Pick<TaskPoint, 'bids' | 'depth' | 'retailCents'>, mineFeeCents: Cents | null = null, levels = 5): BidLevel[] {
  let rows: Omit<BidLevel, 'best' | 'mine'>[];
  if (point.bids.length > 0) {
    const depth = bidDepth(
      point.bids.map((b) => ({ maxFeeCents: b.feeCents, remainingQty: b.qty, matchable: true })),
      levels,
    );
    rows = depth.map((d) => ({
      feeCents: d.feeCents,
      count: d.count,
      qty: d.qty,
      heldCents: point.bids.filter((b) => b.feeCents === d.feeCents).reduce((sum, b) => sum + holdFor(point, b.feeCents, b.qty), 0),
    }));
  } else {
    rows = point.depth.slice(0, levels).map((d) => ({ feeCents: d.feeCents, count: d.count, qty: d.qty, heldCents: d.heldCents ?? null }));
  }
  const mine = new Set(point.bids.filter((b) => b.mine).map((b) => b.feeCents));
  if (mineFeeCents !== null) mine.add(mineFeeCents);
  return rows.map((r, i) => ({ ...r, best: i === 0, mine: mine.has(r.feeCents) }));
}

/** The clock to draw for an offer: the running one, or a preview that starts at the ETA. */
export function scheduleOf(offer: Pick<FeeOffer, 'feeCents' | 'clock' | 'etaAt'>): { schedule: StepDownSchedule; preview: boolean } | null {
  if (!offer.clock) return null;
  const running = askSchedule(offer);
  if (running) return { schedule: running, preview: false };
  const { stepCents, intervalMs, floorCents } = offer.clock;
  return { schedule: { openCents: offer.feeCents, stepCents, intervalMs, floorCents, startsAt: offer.etaAt }, preview: true };
}

/** Offers with room left, in price-time priority at `now` (the shared engine's order). */
export function askRows(point: Pick<TaskPoint, 'offers'>, now: number): AskRow[] {
  const open = point.offers.filter((o) => o.supply > 0).map((o) => ({ ...o, id: o.askId, pricedAt: o.etaAt }));
  return sortAsks(open, now).map((o, i) => {
    const s = scheduleOf(o);
    const running = s !== null && !s.preview;
    const nextAt = askNextDropAt(o, now);
    const interval = o.clock?.intervalMs ?? 0;
    return {
      askId: o.askId,
      queuerName: o.queuerName,
      feeNowCents: offerFeeAt(o, now),
      openCents: o.feeCents,
      clock: o.clock ? { stepCents: o.clock.stepCents, intervalMs: o.clock.intervalMs, floorCents: o.clock.floorCents } : null,
      running,
      checkedIn: o.checkedIn,
      etaAt: o.etaAt,
      nextAt,
      nextFeeCents: running && s ? nextPriceAfter(s.schedule, now) : null,
      progress: running && nextAt !== null && interval > 0 ? clamp01(1 - (nextAt - now) / interval) : null,
      schedule: s?.schedule ?? null,
      steps: s ? ladder(s.schedule) : null,
      atFloor: running && nextAt === null,
      supply: o.supply,
      best: i === 0,
    };
  });
}

export function spreadOf(levels: readonly BidLevel[], asks: readonly AskRow[]): Spread {
  const bid = levels[0]?.feeCents ?? null;
  const ask = asks[0]?.feeNowCents ?? null;
  const spread = bid !== null && ask !== null ? ask - bid : null;
  return { bidCents: bid, askCents: ask, spreadCents: spread, crossed: spread !== null && spread <= 0 };
}

/**
 * When the offer's clock reaches a request's max fee, and the fee it fills at.
 * Null for a fixed fee above the request, or when the floor stays above it.
 */
export function meetingOf(ask: AskRow | undefined, bidCents: Cents | null): Meeting | null {
  if (!ask || bidCents === null || !ask.schedule || ask.feeNowCents <= bidCents) return null;
  const fee = fillPriceForMax(ask.schedule, bidCents);
  const at = reachesAt(ask.schedule, bidCents);
  if (fee === null || at === null) return null;
  return { feeCents: fee, at: ask.running ? at : null, afterStartMs: at - ask.schedule.startsAt };
}

/**
 * The price rows of the ladder, highest first: every request level, each
 * offer's fee now, next step, opening fee and floor, the rows in `keep` (a
 * match being shown), then more of the offers' clock steps nearest the best
 * offer, up to `maxRows`. Rows stay put while a clock walks down its own
 * steps, so an offer's chip can slide from row to row.
 */
export function ladderPrices(levels: readonly BidLevel[], asks: readonly AskRow[], keep: readonly Cents[] = [], maxRows = 12): Cents[] {
  const must = new Set<Cents>([...levels.map((l) => l.feeCents), ...keep]);
  for (const a of asks) {
    must.add(a.feeNowCents);
    must.add(a.openCents);
    if (a.nextFeeCents !== null) must.add(a.nextFeeCents);
    if (a.clock) must.add(a.clock.floorCents);
  }
  const rows = [...must];
  const focus = asks[0]?.feeNowCents ?? levels[0]?.feeCents ?? 0;
  const extra = new Set<Cents>();
  for (const a of asks) for (const s of a.steps ?? []) if (!must.has(s.priceCents)) extra.add(s.priceCents);
  const room = Math.max(0, maxRows - rows.length);
  rows.push(...[...extra].sort((x, y) => Math.abs(x - focus) - Math.abs(y - focus) || y - x).slice(0, room));
  return rows.sort((a, b) => b - a);
}

/** The ladder row of a price: the row itself, else the nearest row at or below it (or the last row). */
export function rowOf(prices: readonly Cents[], cents: Cents): number {
  const exact = prices.indexOf(cents);
  if (exact >= 0) return exact;
  const below = prices.findIndex((p) => p < cents);
  return below >= 0 ? below : Math.max(0, prices.length - 1);
}

/** The next moment this book's prices change on their own: the earliest clock step of its offers. */
export function nextStepAt(asks: readonly AskRow[]): number | null {
  let next: number | null = null;
  for (const a of asks) if (a.nextAt !== null && (next === null || a.nextAt < next)) next = a.nextAt;
  return next;
}

/**
 * What the book's demo clock offers (D-114, D-123): "Start the demo day" while a simulated-PayPal
 * server's scripted day has not started, else Run, Pause and Next step on the market clock. A sandbox
 * server never offers the scripted day: its first request waits for a PayPal approval no screen offers,
 * while the market clock still moves (POST /api/demo/clock) for requests people place themselves.
 */
export function demoClockOffer(status: 'idle' | 'running' | 'paused' | 'finished', serverMode: 'fake' | 'sandbox' | null): 'start' | 'clock' {
  return status === 'idle' && serverMode !== 'sandbox' ? 'start' : 'clock';
}

/**
 * The best-offer cell and the note when no offer is open: "None yet" before anyone offered, "None open"
 * once the book has matched (the offers were taken), so the summary never contradicts the match it shows.
 */
export function noOfferWords(matched: boolean): { cell: string; sub: string; note: string } {
  return matched
    ? { cell: 'None open', sub: 'every offer taken', note: 'No open offer: every offer here was taken. Requests rest here, each held by PayPal, until a queuer’s fee reaches them.' }
    : { cell: 'None yet', sub: 'No queuer offered', note: 'No offer yet. Requests rest here, each held by PayPal, until a queuer’s fee reaches them.' };
}

/** Adds matches to the tape: one line per match id, newest first. */
export function mergeTape(tape: readonly TapeRow[], add: readonly TapeRow[], limit = 6): TapeRow[] {
  const byId = new Map<string, TapeRow>();
  for (const r of [...tape, ...add]) {
    const prev = byId.get(r.id);
    byId.set(r.id, prev ? { ...prev, ...r, queuerName: r.queuerName ?? prev.queuerName } : r);
  }
  return [...byId.values()].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1)).slice(0, limit);
}

/**
 * The in-browser market has no match records: a fill shows as an offer whose
 * room went down. Each such drop is a line at the fee that offer had at `now`
 * (fills pay the offer's current fee).
 */
export function derivedFills(before: Pick<TaskPoint, 'offers'>, after: Pick<TaskPoint, 'offers'>, now: number): TapeRow[] {
  const out: TapeRow[] = [];
  for (const o of before.offers) {
    const later = after.offers.find((x) => x.askId === o.askId);
    const used = o.supply - (later ? later.supply : 0);
    if (used <= 0 || o.supply <= 0) continue;
    out.push({ id: `${o.askId}@${now}`, feeCents: offerFeeAt(o, now), qty: used, at: now, queuerName: o.queuerName, trigger: null, bidId: null, askId: o.askId });
  }
  return out;
}

/** Plain words for how a match happened, after the queuer's name ("Wei · stepped down to a request"). */
export const TRIGGER_TEXT: Record<MatchTrigger, string> = {
  clock_step: 'stepped down to a request',
  new_bid: 'met by a new request',
  new_ask: 'offered at or under a request',
  claim: 'took a request at its fee',
  requeue: 'took a re-offered request',
  amend: 'met a changed request',
};
