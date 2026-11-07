import { askFeeAt, matchBook, type BookAsk, type BookBid, type Fill } from '@holdmyspot/shared';
import { formatUsd, type Cents } from './money';
import type { Bid, DepthLevel, FeeOffer, ItemKind, TaskPoint } from './types';

/**
 * The queue-fee book of one task point, as plain functions: an offer's fee
 * now (fixed, or stepping down once the queuer checks in), the best offer,
 * depth, holds, and the in-browser market's matching (the shared engine).
 */

/** An offer's fee per unit at `t`: fixed, the opening fee before check-in, or the clock price after. */
export function offerFeeAt(offer: Pick<FeeOffer, 'feeCents' | 'clock'>, t: number): Cents {
  return askFeeAt(offer, t);
}

/** The cheapest open offer at `t`, or null. */
export function bestOffer(point: Pick<TaskPoint, 'offers'>, t: number): FeeOffer | null {
  let best: FeeOffer | null = null;
  for (const o of point.offers) {
    if (o.supply <= 0) continue;
    if (!best || offerFeeAt(o, t) < offerFeeAt(best, t)) best = o;
  }
  return best;
}

/** Requests in price-time priority: highest max fee first, earliest first at the same fee. */
export function sortBids(bids: readonly Bid[]): Bid[] {
  return [...bids].sort((a, b) => b.feeCents - a.feeCents || a.placedAt - b.placedAt);
}

/** Requests grouped by max fee, best first. */
export function depthOf(bids: readonly Bid[], levels = 5): DepthLevel[] {
  const by = new Map<Cents, DepthLevel>();
  for (const b of bids) {
    const l = by.get(b.feeCents) ?? { feeCents: b.feeCents, qty: 0, count: 0 };
    l.qty += b.qty;
    l.count += 1;
    by.set(b.feeCents, l);
  }
  return [...by.values()].sort((a, b) => b.feeCents - a.feeCents).slice(0, levels);
}

/** Refreshes the book summary fields of a point from its single requests (in-browser market). */
export function withBookSummary(p: TaskPoint): TaskPoint {
  const depth = depthOf(p.bids, 6);
  return {
    ...p,
    depth,
    bidCount: p.bids.length,
    bidQty: p.bids.reduce((s, b) => s + b.qty, 0),
    bestFeeCents: depth[0]?.feeCents ?? null,
    latestDeadlineAt: p.bids.length ? Math.max(...p.bids.map((b) => b.deadlineAt)) : null,
  };
}

const UNITS: Record<ItemKind, [string, string]> = {
  cake: ['cake', 'cakes'],
  plush: ['plush', 'plush toys'],
  ramen: ['bowl', 'bowls'],
};

/** "1 plush", "2 cakes", "1 bowl". */
export function units(kind: ItemKind, n: number): string {
  const [one, many] = UNITS[kind];
  return `${n} ${n === 1 ? one : many}`;
}

/** The supply badge of an offer: "1 spot left", "Fully booked". */
export function supplyLabel(n: number): string {
  if (n <= 0) return 'Fully booked';
  return `${n} ${n === 1 ? 'spot' : 'spots'} left`;
}

/**
 * What PayPal holds for a request: per unit the shop price cap (the shop price
 * plus 5%, rounded up to a dollar) plus the max fee, plus a shipping budget
 * for a shipped request.
 */
export function holdFor(point: Pick<TaskPoint, 'retailCents'>, maxFeeCents: Cents, qty = 1, shippingBudgetCents = 0): Cents {
  return qty * (retailCapFor(point.retailCents) + maxFeeCents) + shippingBudgetCents;
}

/** The suggested retail cap per unit: shop price plus 5%, rounded up to a whole dollar (same rule as the server's quote). */
export function retailCapFor(retailCents: Cents): Cents {
  return Math.ceil((retailCents * 105) / 10_000) * 100;
}

export function feeText(cents: Cents | null): string {
  return cents === null ? '–' : formatUsd(cents);
}

/**
 * The in-browser market's matching: the shared engine over this point's
 * requests and offers. Local errands match only in the shop's city; every
 * fill pays the offer's current fee.
 */
export function matchPoint(point: TaskPoint, now: number): Fill[] {
  const bids: BookBid[] = point.bids.map((b) => ({
    id: b.id,
    requesterId: b.mine ? 'viewer' : b.bidder,
    maxFeeCents: b.feeCents,
    remainingQty: b.qty,
    destination: b.mode === 'local' ? { mode: 'local', cityId: point.cityId === 'taipei' ? 'sf' : point.cityId } : { mode: 'ship', country: 'US', region: 'NY', city: 'New York', postalCode: null },
    deadlineAt: b.deadlineAt,
    pricedAt: b.placedAt,
    matchable: true,
  }));
  const asks: BookAsk[] = point.offers.map((o) => ({
    id: o.askId,
    queuerId: o.queuerName,
    feeCents: o.feeCents,
    clock: o.clock,
    remainingCapacity: o.supply,
    modes: o.modes,
    etaAt: Math.min(o.etaAt, now),
    windowEndsAt: null,
    pricedAt: o.etaAt,
    matchable: o.supply > 0,
    targetBidId: null,
  }));
  return matchBook(bids, asks, { shopCityId: point.cityId === 'taipei' ? 'sf' : point.cityId, now });
}
