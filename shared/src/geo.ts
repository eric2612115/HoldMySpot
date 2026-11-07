import { DEFAULT_RULES } from './contract.ts';
import type { LngLat, MarketRules } from './contract.ts';

/** Location rules: asks are bound to where the queuer actually is (docs/DOMAIN.md). */

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres between two [lng, lat] points. */
export function distanceMeters(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Estimated travel time in whole minutes (rounded up) at the rules' mixed walking and transit speed. */
export function travelMinutes(from: LngLat, to: LngLat, rules: Pick<MarketRules, 'travelMetersPerMinute'> = DEFAULT_RULES): number {
  return Math.ceil(distanceMeters(from, to) / rules.travelMetersPerMinute);
}

export type RangeProblem = 'OUT_OF_RANGE' | 'GPS_TOO_COARSE' | null;

/** May a queuer at `from` post an ask or claim a bid for a shop at `shop`? */
export function rangeProblem(
  from: { lngLat: LngLat; accuracyM: number },
  shop: LngLat,
  rules: Pick<MarketRules, 'maxTravelMinutes' | 'travelMetersPerMinute' | 'maxGpsAccuracyMeters'> = DEFAULT_RULES,
): RangeProblem {
  if (from.accuracyM > rules.maxGpsAccuracyMeters * 10) return 'GPS_TOO_COARSE';
  return travelMinutes(from.lngLat, shop, rules) > rules.maxTravelMinutes ? 'OUT_OF_RANGE' : null;
}

/** The earliest ETA a queuer at `from` can honestly promise. */
export function earliestEta(from: LngLat, shop: LngLat, now: number, rules: Pick<MarketRules, 'travelMetersPerMinute'> = DEFAULT_RULES): number {
  return now + travelMinutes(from, shop, rules) * 60_000;
}

export type GeofenceProblem = 'OUTSIDE_GEOFENCE' | 'GPS_TOO_COARSE' | null;

/** Check-in geofence: inside the shop's radius with a usable GPS fix. */
export function geofenceProblem(
  at: { lngLat: LngLat; accuracyM: number },
  shop: { lngLat: LngLat; geofenceMeters: number },
  rules: Pick<MarketRules, 'maxGpsAccuracyMeters'> = DEFAULT_RULES,
): { problem: GeofenceProblem; distanceM: number } {
  const distanceM = Math.round(distanceMeters(at.lngLat, shop.lngLat));
  if (at.accuracyM > rules.maxGpsAccuracyMeters) return { problem: 'GPS_TOO_COARSE', distanceM };
  return { problem: distanceM > shop.geofenceMeters ? 'OUTSIDE_GEOFENCE' : null, distanceM };
}
