import { useEffect, useState } from 'react';
import { clock } from '../state/services';

/** Market-clock time, refreshed every `ms` real milliseconds. */
export function useNow(ms = 250): number {
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(clock.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** "4:59" style countdown from milliseconds. */
export function mmss(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function ago(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return `${h} h ago`;
}

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}
