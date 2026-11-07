import { DEMO_TIME_ZONE } from '@holdmyspot/shared';
import type { MarketMs } from '@holdmyspot/shared';

/** The hero day in San Francisco, where the hero shops and queuers are. */
export const HERO_DAY = '2026-11-12';
export const HERO_TZ = DEMO_TIME_ZONE;
export const MINUTE = 60_000;

/** Minutes the hero time zone is ahead of UTC at `ms` (negative in San Francisco; follows daylight saving). */
export function heroOffsetMin(ms: MarketMs): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: HERO_TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return Math.round((asUtc - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

/** "11:21" on the hero day (or `day`), San Francisco time, as market epoch ms. */
export function sf(hhmm: string, day: string = HERO_DAY): MarketMs {
  const guess = Date.parse(`${day}T${hhmm}:00Z`);
  const first = guess - heroOffsetMin(guess) * MINUTE;
  return guess - heroOffsetMin(first) * MINUTE;
}

const hm = new Intl.DateTimeFormat('en-GB', { timeZone: HERO_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: HERO_TZ, weekday: 'short', day: 'numeric', month: 'short' });

/** "11:21" in San Francisco time. */
export function clockText(t: MarketMs): string {
  return hm.format(t);
}

/** "Thu, Nov 12" in San Francisco time. */
export function dayText(t: MarketMs): string {
  return dayFmt.format(t);
}

/** Parses "11:21" (hero day) or an epoch number from a URL parameter. */
export function parseMarketTime(value: string | null): MarketMs | null {
  if (!value) return null;
  if (/^\d{1,2}:\d{2}$/.test(value)) return sf(value.padStart(5, '0'));
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "in 4 min", "4 min ago", "now". */
export function relativeText(t: MarketMs, now: MarketMs): string {
  const minutes = Math.round((t - now) / MINUTE);
  if (minutes === 0) return 'now';
  if (minutes > 0) return minutes >= 90 ? `in ${Math.round(minutes / 60)} h` : `in ${minutes} min`;
  const ago = -minutes;
  return ago >= 90 ? `${Math.round(ago / 60)} h ago` : `${ago} min ago`;
}
