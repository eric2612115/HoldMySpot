/**
 * Settings of the hosted judge server (docs/HOSTING.md, D-163): one process, one port, one in-memory
 * market per visitor. Everything has a default, so `npm run hosted` and Render need no settings
 * beyond the optional keys. Caps come from the measurement in docs/HOSTING.md.
 */

export interface HostedSettings {
  host: string;
  port: number;
  /** Idle markets are removed after this long (no API call other than the event stream). */
  idleMs: number;
  /** A market is removed this long after it was created, even when a forgotten tab keeps polling. */
  maxAgeMs: number;
  /** Markets alive at once; the longest idle one goes first when a new visitor arrives at the cap. */
  cap: number;
  /** A market idle for less than this is never evicted to make room: the new visitor is told to retry. */
  minIdleToEvictMs: number;
  /** New markets per client address per hour, and for the whole service per minute. */
  createsPerIpPerHour: number;
  createsPerMinute: number;
  /** Markets on the real PayPal sandbox per day (UTC). */
  sandboxPerDay: number;
  /** Live AI: per market and per day for the service. Past a cap the simulated behaviour returns and says so. */
  aiReadsPerMarket: number;
  aiTurnsPerMarket: number;
  aiReadsPerDay: number;
  aiTurnsPerDay: number;
  /** The speed "Run the whole errand" plays the hero day at. */
  errandSpeed: number;
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number of 0 or more.`);
  return n;
}

const MINUTE = 60_000;

export function hostedSettings(env: Env = process.env): HostedSettings {
  return {
    // Render sets PORT and expects 0.0.0.0; `npm run hosted` sets HMS_PORT and stays on the loopback address.
    host: env.HMS_HOST ?? (env.PORT ? '0.0.0.0' : '127.0.0.1'),
    port: int(env, 'PORT', int(env, 'HMS_PORT', 8796)),
    idleMs: int(env, 'HMS_HOSTED_IDLE_MINUTES', 60) * MINUTE,
    maxAgeMs: int(env, 'HMS_HOSTED_MAX_AGE_MINUTES', 240) * MINUTE,
    cap: int(env, 'HMS_HOSTED_MARKET_CAP', 40),
    minIdleToEvictMs: int(env, 'HMS_HOSTED_MIN_IDLE_SECONDS', 120) * 1000,
    createsPerIpPerHour: int(env, 'HMS_HOSTED_CREATES_PER_IP_HOUR', 30),
    createsPerMinute: int(env, 'HMS_HOSTED_CREATES_PER_MINUTE', 30),
    sandboxPerDay: int(env, 'HMS_HOSTED_SANDBOX_PER_DAY', 20),
    aiReadsPerMarket: int(env, 'HMS_HOSTED_AI_READS_PER_MARKET', 6),
    aiTurnsPerMarket: int(env, 'HMS_HOSTED_AI_TURNS_PER_MARKET', 40),
    aiReadsPerDay: int(env, 'HMS_HOSTED_AI_READS_PER_DAY', 200),
    aiTurnsPerDay: int(env, 'HMS_HOSTED_AI_TURNS_PER_DAY', 1200),
    errandSpeed: int(env, 'HMS_HOSTED_ERRAND_SPEED', 60),
  };
}
