import type { Cents, FeeClock, Item, MarketRules } from './contract.ts';
import { DEFAULT_RULES } from './contract.ts';
import { PAYPAL_PRICING, PROCESSING_LABEL, bidLimitCents, formatUsd, platformFeeCents, processingReserveCents } from './money.ts';

/**
 * Estimate formulas from docs/AI-SERVICES.md sections 4.3 and 4.4. Every
 * number here comes from code and the catalog; a model only writes the
 * explanation sentences around them. All values are demo values, not
 * quotes and not tax advice.
 */

/** Seconds per person ahead in a line, used when a line photo gives a people count (demo value). */
export const SECONDS_PER_PERSON = 75;
/** Suggested fee: this many cents per minute of expected wait. */
export const FEE_CENTS_PER_WAIT_MINUTE = 24;
/** Suggested fees are rounded to this step. */
export const FEE_ROUNDING_CENTS = 50;

/** Fictional carrier used by the shipping estimate and the demo labels (domestic US ground, tracked). */
export const SHIPPING_SERVICE = 'Harbor Parcel Ground, tracked';
/** Packing added to every parcel. */
export const PACKING_GRAMS = 200;
/** Harbor Parcel Ground demo rates: a base price plus a price per started 100 g. */
export const SHIPPING_BASE_CENTS = 550;
export const SHIPPING_PER_100G_CENTS = 50;
export const SHIPPING_DAYS = { min: 2, max: 5 } as const;
/**
 * Duty rates by catalog duty category, in basis points. Every seeded shop ships
 * within the US, so no import duty applies; the table stays so a parcel that
 * crosses a border could carry one (demo values, not tax advice).
 */
export const DUTY_RATE_BPS: Readonly<Record<string, number>> = {
  toys: 0,
  baked_goods: 0,
  prepared_food: 0,
};
/** The shipping and duty budget is the estimate times 1.3, rounded up to whole dollars. */
export const SHIPPING_MARGIN_PERCENT = 130;

export const SHIPPING_NOTES = ['Estimate, charged at cost up to your budget.', 'Ships within the US, so no import duty applies.'] as const;

const roundTo = (cents: number, step: number): number => Math.round(cents / step) * step;

/** Expected wait: from a line photo's people count when there is one, else the item's baseline. */
export function expectedWaitMinutes(item: Pick<Item, 'expectedWaitMinutes'>, peopleAhead: number | null): number {
  if (peopleAhead === null || !Number.isFinite(peopleAhead) || peopleAhead < 0) return item.expectedWaitMinutes;
  return Math.max(1, Math.round((peopleAhead * SECONDS_PER_PERSON) / 60));
}

/** Suggested queue fee per unit: max(item minimum, wait minutes x 24 cents, rounded to 50 cents). */
export function suggestedFeeCents(item: Pick<Item, 'minFeeCents'>, waitMinutes: number): Cents {
  return Math.max(item.minFeeCents, roundTo(waitMinutes * FEE_CENTS_PER_WAIT_MINUTE, FEE_ROUNDING_CENTS));
}

/** Suggested ask clock: open = suggested + $3, $1 every 5 minutes, floor = max(item minimum, suggested - $4). */
export function suggestedClock(
  item: Pick<Item, 'minFeeCents'>,
  suggestedFee: Cents,
): { feeCents: Cents; stepCents: Cents; intervalMs: number; floorCents: Cents } {
  return {
    feeCents: suggestedFee + 300,
    stepCents: 100,
    intervalMs: 5 * 60_000,
    floorCents: Math.max(item.minFeeCents, suggestedFee - 400),
  };
}

/** A FeeClock (not started) from a suggested clock. */
export function toFeeClock(c: { stepCents: Cents; intervalMs: number; floorCents: Cents }): FeeClock {
  return { stepCents: c.stepCents, intervalMs: c.intervalMs, floorCents: c.floorCents, startsAt: null };
}

/** Suggested retail cap per unit: shop price plus 5%, rounded up to a whole dollar. */
export function suggestedRetailCapCents(retailCents: Cents): Cents {
  return Math.ceil((retailCents * 105) / 10_000) * 100;
}

export interface ShippingNumbers {
  parcelGrams: number;
  shippingCents: Cents;
  dutyCents: Cents;
  budgetCents: Cents;
  service: string;
  days: { min: number; max: number };
}

/** Parcel weight, demo shipping rate, illustrative duty and the suggested budget for qty units of one item. */
export function shippingNumbers(item: Pick<Item, 'weightGrams' | 'retailCents' | 'dutyCategory'>, qty: number): ShippingNumbers {
  const parcelGrams = qty * item.weightGrams + PACKING_GRAMS;
  const shippingCents = SHIPPING_BASE_CENTS + SHIPPING_PER_100G_CENTS * Math.ceil(parcelGrams / 100);
  const rate = DUTY_RATE_BPS[item.dutyCategory] ?? 0;
  const dutyCents = Math.round((item.retailCents * qty * rate) / 10_000);
  const budgetCents = Math.ceil(((shippingCents + dutyCents) * SHIPPING_MARGIN_PERCENT) / 10_000) * 100;
  return { parcelGrams, shippingCents, dutyCents, budgetCents, service: SHIPPING_SERVICE, days: { ...SHIPPING_DAYS } };
}

/** "3.49% + $0.49 per charge, $0.25 per payout": the processing schedule in words (D-105). */
export function processingScheduleText(): string {
  const p = PAYPAL_PRICING;
  return `${p.captureBps / 100}% + ${formatUsd(p.captureFixedCents, { exact: true })} per charge, ${formatUsd(p.payoutItemCents, { exact: true })} per payout`;
}

/** The sentences the bid form must show (docs/DOMAIN.md section 9), with the numbers filled in. */
export function bidDisclosures(
  b: { qty: number; retailCapCents: Cents; maxFeeCents: Cents; shippingBudgetCents: Cents; mode: 'local' | 'ship' },
  rules: Pick<MarketRules, 'platformFeeBps'> = DEFAULT_RULES,
): string[] {
  const limit = formatUsd(bidLimitCents(b, b.mode), { exact: true });
  const reserve = formatUsd(processingReserveCents(b, b.mode), { exact: true });
  const pct = `${rules.platformFeeBps / 100}%`;
  const first =
    b.mode === 'ship'
      ? `PayPal holds up to ${limit}. You pay the receipt price, the matched fee, the actual shipping and processing at cost, never more than this. The rest is released.`
      : `PayPal holds up to ${limit}. You pay the receipt price, the matched fee and processing at cost, never more than this. The rest is released.`;
  return [
    first,
    `HoldMySpot keeps ${pct} of the queue fee. Shop price${b.mode === 'ship' ? ', shipping' : ''} and processing are passed through at cost.`,
    `${PROCESSING_LABEL}: up to ${reserve}, what taking your payment and paying the queuer costs (${processingScheduleText()}). HoldMySpot makes nothing on it.`,
  ];
}

/** The platform fee line of a quote. */
export function platformFeeLine(maxFeeCents: Cents, rules: Pick<MarketRules, 'platformFeeBps'> = DEFAULT_RULES): { bps: number; perUnitCents: Cents } {
  return { bps: rules.platformFeeBps, perUnitCents: platformFeeCents(maxFeeCents, rules.platformFeeBps) };
}
