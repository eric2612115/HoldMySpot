/**
 * Wall-clock helpers: reading printed receipt times and showing market times
 * in a shop's time zone (agent reasons, estimate sentences, ops notes).
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

export function localParts(ms: number, timeZone: string): LocalParts {
  const out: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: out.weekday ?? '',
  };
}

export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Reads a printed date and time: "2026-11-12 09:41", "2026/11/12 09:41:07",
 * "2026-11-12T09:41". Returns null when it is not a real date and time.
 */
export function parseLocalDateTime(text: string | null | undefined): LocalDateTime | null {
  if (!text) return null;
  const m = /^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(text);
  if (!m) return null;
  const v = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6] ?? 0),
  };
  const check = new Date(Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second));
  if (
    check.getUTCFullYear() !== v.year ||
    check.getUTCMonth() !== v.month - 1 ||
    check.getUTCDate() !== v.day ||
    v.hour > 23 ||
    v.minute > 59 ||
    v.second > 59
  ) {
    return null;
  }
  return v;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** "09:41" in the zone. */
export function hhmm(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** "Thu 12:00" in the zone. */
export function dayTime(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone);
  return `${p.weekday} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** "2h 05m" or "35m" for a duration in ms. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${pad(m)}m` : `${m}m`;
}
