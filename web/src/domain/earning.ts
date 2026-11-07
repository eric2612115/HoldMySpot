import { DEFAULT_RULES, distanceMeters, platformFeeCents, travelMinutes, zonedLocalToEpoch, epochToZonedLocal } from '@holdmyspot/shared';
import type { LngLat, MarketRules } from '@holdmyspot/shared';
import type { Cents } from './money';
import type { TaskPoint } from './types';

/**
 * What a task is worth to a queuer standing at `from`: how far it is, how
 * long the trip and the line take, what it pays per hour, and whether they
 * can take it at all. One travel estimate drives everything the app shows
 * and sends: the minutes on every dot and row, the $/hour, the travel-time
 * filters, the "30 minutes from you" ring, greying, and the ETA of an offer.
 *
 * - Walking: streets add about a quarter to the straight line; 80 m a minute.
 *   Up to a 20-minute walk the queuer walks.
 * - Farther, transit: 10 minutes to reach a stop and wait, then 300 m a minute
 *   along the route, never fewer minutes than the 20-minute walk, so a farther
 *   shop never shows less travel than a nearer one.
 * - Never faster than the market's own travel rule (250 m a minute in a straight
 *   line), which the server checks an offer's ETA against.
 * - Earning rate: what the queuer keeps of the top fee (after HoldMySpot's 10%)
 *   divided by travel plus queue minutes.
 * - Not claimable: more than 30 minutes away, or the requests end (or the shop
 *   closes) before the queuer could get there, or nobody is asking.
 */

export const WALK_METERS_PER_MINUTE = 80;
export const ROUTE_FACTOR = 1.25;
export const MAX_WALK_MINUTES = 20;
export const TRANSIT_OVERHEAD_MINUTES = 10;
export const TRANSIT_METERS_PER_MINUTE = 300;
/** A minute to find the end of the line; it also covers the trip to the server at demo speed. */
export const ARRIVAL_SLACK_MINUTES = 1;

export type BlockReason = 'too_far' | 'ends_before' | 'closes_before' | 'no_requests' | 'sold_out';

export interface Reach {
  /** Straight-line metres. */
  distanceM: number;
  /** Estimated route, metres. */
  walkM: number;
  walkMin: number;
  /** Travel minutes for everything shown and sent: the walk, or transit beyond a 20-minute walk. */
  travelMin: number;
  travelMode: 'walk' | 'transit';
  /** Minutes at the market's travel rule (the earliest ETA the server accepts). */
  ruleMin: number;
  queueMin: number;
  /** The top fee on offer per unit, or null. */
  feeCents: Cents | null;
  /** What the queuer keeps of that fee after the platform fee, or null. */
  keepCents: Cents | null;
  bids: number;
  /** Cents per hour of travel plus queueing, from what the queuer keeps, or null when nobody is asking. */
  centsPerHour: number | null;
  /** When the queuer would be at the shop: now plus the travel minutes and a minute to find the line. */
  arriveAt: number;
  claimable: boolean;
  reason: BlockReason | null;
}

/** Travel minutes and mode for a straight-line distance (see the notes above). */
export function travelFor(distanceM: number, ruleMin: number): Pick<Reach, 'walkM' | 'walkMin' | 'travelMin' | 'travelMode'> {
  const walkM = distanceM * ROUTE_FACTOR;
  const walkMin = Math.max(1, Math.ceil(walkM / WALK_METERS_PER_MINUTE));
  if (walkMin <= MAX_WALK_MINUTES) return { walkM, walkMin, travelMin: Math.max(walkMin, ruleMin), travelMode: 'walk' };
  const transit = TRANSIT_OVERHEAD_MINUTES + Math.ceil(walkM / TRANSIT_METERS_PER_MINUTE);
  return { walkM, walkMin, travelMin: Math.max(MAX_WALK_MINUTES, transit, ruleMin), travelMode: 'transit' };
}

/** The straight-line radius that `minutes` of travel reaches (the "30 minutes from you" ring). */
export function reachRadiusMeters(minutes: number, rules: Pick<MarketRules, 'travelMetersPerMinute'> = DEFAULT_RULES): number {
  const byRule = minutes * rules.travelMetersPerMinute;
  if (minutes <= MAX_WALK_MINUTES) return Math.min(byRule, (minutes * WALK_METERS_PER_MINUTE) / ROUTE_FACTOR);
  return Math.min(byRule, ((minutes - TRANSIT_OVERHEAD_MINUTES) * TRANSIT_METERS_PER_MINUTE) / ROUTE_FACTOR);
}

export function reachOf(
  point: Pick<TaskPoint, 'lngLat' | 'queue' | 'bestFeeCents' | 'bidCount' | 'latestDeadlineAt' | 'shop' | 'status'>,
  from: LngLat,
  now: number,
  rules: Pick<MarketRules, 'maxTravelMinutes' | 'travelMetersPerMinute' | 'platformFeeBps'> = DEFAULT_RULES,
): Reach {
  const distanceM = distanceMeters(from, point.lngLat);
  const ruleMin = Math.max(1, travelMinutes(from, point.lngLat, rules));
  const { walkM, walkMin, travelMin, travelMode } = travelFor(distanceM, ruleMin);
  const queueMin = point.queue.minutes;
  const feeCents = point.bestFeeCents;
  const keepCents = feeCents === null ? null : feeCents - platformFeeCents(feeCents, rules.platformFeeBps);
  const centsPerHour = keepCents === null ? null : Math.round((keepCents * 60) / (travelMin + queueMin));
  const arriveAt = now + (travelMin + ARRIVAL_SLACK_MINUTES) * 60_000;
  let reason: BlockReason | null = null;
  if (point.status === 'sold_out') reason = 'sold_out';
  else if (travelMin > rules.maxTravelMinutes) reason = 'too_far';
  else if (point.bidCount === 0 || feeCents === null) reason = 'no_requests';
  else if (point.latestDeadlineAt !== null && point.latestDeadlineAt < arriveAt) reason = 'ends_before';
  else if (closesAt(point.shop, now) < arriveAt) reason = 'closes_before';
  return { distanceM, walkM, walkMin, travelMin, travelMode, ruleMin, queueMin, feeCents, keepCents, bids: point.bidCount, centsPerHour, arriveAt, claimable: reason === null, reason };
}

/** Today's closing time of a shop (in its own time zone), as epoch ms. */
export function closesAt(shop: Pick<TaskPoint['shop'], 'hours' | 'timezone'>, now: number): number {
  const day = epochToZonedLocal(now, shop.timezone).slice(0, 10);
  return zonedLocalToEpoch(`${day} ${shop.hours.closes}`, shop.timezone) ?? Number.POSITIVE_INFINITY;
}

export const REASON_TEXT: Record<BlockReason, string> = {
  too_far: 'Too far to take: more than 30 minutes away',
  ends_before: 'The requests end before you could get there',
  closes_before: 'The shop closes before you could get there',
  no_requests: 'No requests yet',
  sold_out: 'Sold out today',
};

/** "350 m" or "2.4 km". */
export function distanceText(m: number): string {
  return m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`;
}

/** "6 min walk" or "18 min by transit". */
export function travelText(r: Pick<Reach, 'travelMin' | 'travelMode'>): string {
  return r.travelMode === 'walk' ? `${r.travelMin} min walk` : `${r.travelMin} min by transit`;
}

/** "$13/h". */
export function rateText(centsPerHour: number | null): string {
  if (centsPerHour === null) return '–';
  return `$${Math.round(centsPerHour / 100)}/h`;
}
