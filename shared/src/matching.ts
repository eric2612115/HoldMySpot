import type { Cents, CityId, Destination, FeeClock, FulfilmentMode, MarketMs } from './contract.ts';
import { askFeeAt, askNextDropAt } from './stepdown.ts';

/**
 * The matching engine for one book (one shop item), as a pure function.
 * The server runs it after every change to the book and at every fee-clock
 * step; the web app may run it in its offline mock. Rules (docs/DOMAIN.md):
 *
 * - Price-time priority. Bids: highest max fee first, then earliest
 *   `pricedAt`. Asks: lowest current fee first, then earliest `pricedAt`.
 *   Ties break on id so the result is deterministic.
 * - The engine walks bids in priority order; each bid takes the best
 *   compatible asks until its max fee is below the next ask's fee.
 * - Execution price is always the ask's current fee (its clock price at
 *   `now`), so a resting bid fills at the first clock step at or below its
 *   max and the rest of its hold is released later.
 * - Partial fills: each fill takes min(bid remaining, ask remaining).
 * - Compatibility: same fulfilment mode, local errands only in the shop's own
 *   city, the ask's ETA no later than the bid's deadline, an en-route ask's
 *   arrival window still open, no self-match, and a claim-ask only fills the
 *   bid it targets.
 */

export interface BookBid {
  id: string;
  requesterId: string;
  maxFeeCents: Cents;
  remainingQty: number;
  destination: Destination;
  deadlineAt: MarketMs;
  pricedAt: MarketMs;
  /** False while the hold is not usable (awaiting approval, renewal required) or the bid is closing. */
  matchable: boolean;
}

export interface BookAsk {
  id: string;
  queuerId: string;
  feeCents: Cents;
  clock: FeeClock | null;
  remainingCapacity: number;
  modes: FulfilmentMode[];
  etaAt: MarketMs;
  /** End of the arrival window while the queuer has not checked in; null once checked in. */
  windowEndsAt: MarketMs | null;
  pricedAt: MarketMs;
  /** False once the ask is withdrawn, lapsed or closed. */
  matchable: boolean;
  /** Claim-asks only fill this bid. */
  targetBidId: string | null;
}

export interface Fill {
  bidId: string;
  askId: string;
  qty: number;
  /** Per unit: the ask's fee at `at`. */
  feeCents: Cents;
  at: MarketMs;
}

export interface BookContext {
  /** City of the shop: local errands only match requesters in this city. */
  shopCityId: CityId;
  now: MarketMs;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Bids in price-time priority: highest max fee first, earliest first at the same price. */
export function sortBids<T extends Pick<BookBid, 'id' | 'maxFeeCents' | 'pricedAt'>>(bids: readonly T[]): T[] {
  return [...bids].sort((a, b) => b.maxFeeCents - a.maxFeeCents || a.pricedAt - b.pricedAt || byId(a, b));
}

/** Asks in price-time priority at `now`: lowest current fee first, earliest first at the same fee. */
export function sortAsks<T extends Pick<BookAsk, 'id' | 'feeCents' | 'clock' | 'pricedAt'>>(asks: readonly T[], now: MarketMs): T[] {
  return [...asks].sort((a, b) => askFeeAt(a, now) - askFeeAt(b, now) || a.pricedAt - b.pricedAt || byId(a, b));
}

/** Whether this bid and ask may trade at all (price aside). */
export function compatible(bid: BookBid, ask: BookAsk, ctx: BookContext): boolean {
  if (bid.requesterId === ask.queuerId) return false;
  if (ask.targetBidId !== null && ask.targetBidId !== bid.id) return false;
  if (!ask.modes.includes(bid.destination.mode)) return false;
  if (bid.destination.mode === 'local' && bid.destination.cityId !== ctx.shopCityId) return false;
  if (ask.etaAt > bid.deadlineAt) return false;
  if (ctx.now > bid.deadlineAt) return false;
  if (ask.windowEndsAt !== null && ctx.now > ask.windowEndsAt) return false;
  return true;
}

/** Runs one matching pass. Returns the fills in the order they happened; inputs are not changed. */
export function matchBook(bids: readonly BookBid[], asks: readonly BookAsk[], ctx: BookContext): Fill[] {
  const bidLeft = new Map<string, number>();
  const askLeft = new Map<string, number>();
  const liveBids = sortBids(bids.filter((b) => b.matchable && b.remainingQty > 0));
  const liveAsks = sortAsks(
    asks.filter((a) => a.matchable && a.remainingCapacity > 0),
    ctx.now,
  );
  for (const b of liveBids) bidLeft.set(b.id, b.remainingQty);
  for (const a of liveAsks) askLeft.set(a.id, a.remainingCapacity);

  const fills: Fill[] = [];
  for (const bid of liveBids) {
    for (const ask of liveAsks) {
      const wanted = bidLeft.get(bid.id) ?? 0;
      if (wanted === 0) break;
      const fee = askFeeAt(ask, ctx.now);
      // Asks are sorted by fee: once one is above this bid's max, so are the rest.
      if (fee > bid.maxFeeCents) break;
      const free = askLeft.get(ask.id) ?? 0;
      if (free === 0 || !compatible(bid, ask, ctx)) continue;
      const qty = Math.min(wanted, free);
      fills.push({ bidId: bid.id, askId: ask.id, qty, feeCents: fee, at: ctx.now });
      bidLeft.set(bid.id, wanted - qty);
      askLeft.set(ask.id, free - qty);
    }
  }
  return fills;
}

/** The next time any ask's clock steps (when the server should run matching again), or null. */
export function nextClockStepAt(asks: readonly BookAsk[], now: MarketMs): MarketMs | null {
  let next: MarketMs | null = null;
  for (const a of asks) {
    if (!a.matchable || a.remainingCapacity <= 0) continue;
    const t = askNextDropAt(a, now);
    if (t !== null && (next === null || t < next)) next = t;
  }
  return next;
}

export interface DepthRow {
  feeCents: Cents;
  qty: number;
  count: number;
}

/** Resting bids grouped by max fee, best first (the map's depth). */
export function bidDepth(bids: readonly Pick<BookBid, 'maxFeeCents' | 'remainingQty' | 'matchable'>[], levels = 5): DepthRow[] {
  const rows = new Map<Cents, DepthRow>();
  for (const b of bids) {
    if (!b.matchable || b.remainingQty <= 0) continue;
    const row = rows.get(b.maxFeeCents) ?? { feeCents: b.maxFeeCents, qty: 0, count: 0 };
    row.qty += b.remainingQty;
    row.count += 1;
    rows.set(b.maxFeeCents, row);
  }
  return [...rows.values()].sort((a, b) => b.feeCents - a.feeCents).slice(0, levels);
}
