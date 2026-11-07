import type { Cents, FeeClock, MarketMs } from './contract.ts';

/**
 * Step-down pricing: the price opens at a ceiling and drops by a fixed step
 * at a fixed interval until it reaches a floor, never below it.
 *
 * Same functions and results as web/src/domain/auction.ts, so the web app can
 * switch its import to this module without any behaviour change. In
 * HoldMySpot the step-down price is an ask's queue fee per unit (see
 * `askFeeAt`), and its clock only starts when the queuer checks in.
 *
 * Times are epoch milliseconds on the market clock.
 */
export interface StepDownSchedule {
  /** Opening price. Also the ceiling: the clock never asks more. */
  openCents: Cents;
  /** How much the price drops at each step. */
  stepCents: Cents;
  /** Time between drops, in milliseconds. */
  intervalMs: number;
  /** The lowest price. Reached after `maxSteps` drops and held from then on. */
  floorCents: Cents;
  /** When the clock opened at `openCents`. */
  startsAt: MarketMs;
}

export interface PriceStep {
  index: number;
  at: MarketMs;
  priceCents: Cents;
}

export function maxSteps(s: StepDownSchedule): number {
  if (s.stepCents <= 0) return 0;
  return Math.ceil((s.openCents - s.floorCents) / s.stepCents);
}

/** Number of drops that have happened by time `t` (not capped at the floor). */
export function dropsElapsed(s: StepDownSchedule, t: MarketMs): number {
  if (t < s.startsAt || s.intervalMs <= 0) return 0;
  return Math.floor((t - s.startsAt) / s.intervalMs);
}

export function priceAt(s: StepDownSchedule, t: MarketMs): Cents {
  const dropped = s.openCents - s.stepCents * Math.min(dropsElapsed(s, t), maxSteps(s));
  return Math.max(s.floorCents, dropped);
}

export function isAtFloor(s: StepDownSchedule, t: MarketMs): boolean {
  return priceAt(s, t) <= s.floorCents;
}

/** When the next drop happens, or null once the floor is reached. */
export function nextDropAt(s: StepDownSchedule, t: MarketMs): MarketMs | null {
  if (isAtFloor(s, t)) return null;
  return s.startsAt + (dropsElapsed(s, t) + 1) * s.intervalMs;
}

/** The price after the next drop, or null at the floor. */
export function nextPriceAfter(s: StepDownSchedule, t: MarketMs): Cents | null {
  const next = nextDropAt(s, t);
  return next === null ? null : priceAt(s, next);
}

/**
 * When the price first falls to `maxCents` or below. Returns `startsAt` if the
 * opening price is already within the max, and null if the max is below the
 * floor (the order could never fill).
 */
export function reachesAt(s: StepDownSchedule, maxCents: Cents): MarketMs | null {
  if (maxCents >= s.openCents) return s.startsAt;
  if (maxCents < s.floorCents) return null;
  const drops = Math.ceil((s.openCents - maxCents) / s.stepCents);
  return s.startsAt + Math.min(drops, maxSteps(s)) * s.intervalMs;
}

/**
 * The price a resting "my max" order pays: the first step price at or below
 * the max. A max of $12.50 on a $1 ladder pays $12, and the rest of the hold
 * is released.
 */
export function fillPriceForMax(s: StepDownSchedule, maxCents: Cents): Cents | null {
  const at = reachesAt(s, maxCents);
  return at === null ? null : priceAt(s, at);
}

/** The whole ladder from the opening price down to the floor. */
export function ladder(s: StepDownSchedule): PriceStep[] {
  const steps: PriceStep[] = [];
  const n = maxSteps(s);
  for (let i = 0; i <= n; i++) {
    const at = s.startsAt + i * s.intervalMs;
    steps.push({ index: i, at, priceCents: priceAt(s, at) });
  }
  return steps;
}

/** The schedule of an ask's fee clock, or null while the clock has not started. */
export function askSchedule(ask: { feeCents: Cents; clock: FeeClock | null }): StepDownSchedule | null {
  if (!ask.clock || ask.clock.startsAt === null) return null;
  return {
    openCents: ask.feeCents,
    stepCents: ask.clock.stepCents,
    intervalMs: ask.clock.intervalMs,
    floorCents: ask.clock.floorCents,
    startsAt: ask.clock.startsAt,
  };
}

/**
 * An ask's fee per unit at time `t`: the fixed fee, the opening fee while the
 * clock has not started (before check-in), or the clock price after.
 */
export function askFeeAt(ask: { feeCents: Cents; clock: FeeClock | null }, t: MarketMs): Cents {
  const s = askSchedule(ask);
  return s === null ? ask.feeCents : priceAt(s, t);
}

/** When this ask's fee next changes, or null (fixed fee, clock not started, or at the floor). */
export function askNextDropAt(ask: { feeCents: Cents; clock: FeeClock | null }, t: MarketMs): MarketMs | null {
  const s = askSchedule(ask);
  return s === null ? null : nextDropAt(s, t);
}

/** Checks a clock a queuer wants to post. Returns a problem in plain words, or null when it is valid. */
export function clockProblem(feeCents: Cents, clock: { stepCents: Cents; intervalMs: number; floorCents: Cents }): string | null {
  if (!Number.isInteger(clock.stepCents) || clock.stepCents <= 0) return 'The step must be a positive whole number of cents.';
  if (!Number.isInteger(clock.intervalMs) || clock.intervalMs < 60_000) return 'The interval must be at least one minute.';
  if (!Number.isInteger(clock.floorCents) || clock.floorCents <= 0) return 'The floor must be a positive whole number of cents.';
  if (clock.floorCents > feeCents) return 'The floor cannot be above the opening fee.';
  return null;
}
