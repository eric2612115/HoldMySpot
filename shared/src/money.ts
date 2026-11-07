import { ContractError, DEFAULT_RULES } from './contract.ts';
import type { Cents, FulfilmentMode, HoldStatus, LocalMoney, MarketRules, Money } from './contract.ts';

/**
 * Money rules shared by the server (which enforces them) and the apps (which
 * show them). Every amount is integer US cents. docs/DOMAIN.md explains each
 * rule with a worked example; money.test.ts checks that example.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** PayPal lets captures reach 115% of an authorization by default. We never use that headroom. */
export const PAYPAL_DEFAULT_OVERAGE_BPS = 11_500;

export const usd = (dollars: number): Cents => Math.round(dollars * 100);

export const money = (cents: Cents): Money => ({ currency: 'USD', cents });

export function isWholeCents(n: number): boolean {
  return Number.isInteger(n) && Number.isFinite(n);
}

export function assertWholeCents(n: number, what: string, opts: { allowZero?: boolean } = {}): void {
  if (!isWholeCents(n) || n < 0 || (!opts.allowZero && n === 0)) {
    throw new ContractError('INVALID_AMOUNT', `${what} must be a ${opts.allowZero ? 'non-negative' : 'positive'} whole number of cents.`, {
      value: n,
    });
  }
}

const exact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });

/** Same as web/src/domain/money.ts: "$245" for whole dollars on the map, `exact` for money screens. */
export function formatUsd(cents: Cents, opts: { exact?: boolean } = {}): string {
  if (!opts.exact && cents % 100 === 0) return whole.format(cents / 100);
  return exact.format(cents / 100);
}

/** PayPal REST takes amounts as decimal strings, for example "245.00". */
export function toPayPalValue(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Parses a PayPal USD amount string ("12.3", "12.30", "12") into cents without floating point. */
export function fromPayPalValue(value: string): Cents {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) throw new ContractError('INVALID_AMOUNT', `Not a USD amount: ${value}`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] === '-' ? -cents : cents;
}

/** Converts a receipt amount to USD cents at the job's locked rate (round half up). */
export function localToUsdCents(amount: LocalMoney, twdPerUsd: number): Cents {
  if (amount.currency === 'USD') return amount.minor;
  if (!(twdPerUsd > 0)) throw new ContractError('BAD_REQUEST', 'The TWD rate must be positive.');
  return Math.round((amount.minor * 100) / twdPerUsd);
}

export interface BidMoney {
  qty: number;
  retailCapCents: Cents;
  maxFeeCents: Cents;
  shippingBudgetCents: Cents;
}

/** The user's own limit and the hold amount: qty * (retail cap + max fee) + shipping budget. */
export function bidLimitCents(b: BidMoney): Cents {
  return b.qty * (b.retailCapCents + b.maxFeeCents) + b.shippingBudgetCents;
}

/** Throws unless every bid amount is whole cents and the shipping budget fits the mode. */
export function assertBidMoney(b: BidMoney, mode: FulfilmentMode): void {
  if (!Number.isInteger(b.qty) || b.qty <= 0) throw new ContractError('BAD_REQUEST', 'Quantity must be a positive whole number.');
  assertWholeCents(b.retailCapCents, 'The retail cap');
  assertWholeCents(b.maxFeeCents, 'The max fee');
  assertWholeCents(b.shippingBudgetCents, 'The shipping budget', { allowZero: true });
  if (mode === 'local' && b.shippingBudgetCents !== 0) {
    throw new ContractError('MODE_NOT_ALLOWED', 'Local errands have no shipping budget.');
  }
  if (mode === 'ship' && b.shippingBudgetCents === 0) {
    throw new ContractError('BAD_REQUEST', 'Shipped bids need a shipping and duty budget.');
  }
}

export interface JobCaps {
  retailCents: Cents;
  feeCents: Cents;
  shippingCents: Cents;
}

/**
 * The most one job may capture for each part. A job carries `qty` of the
 * bid's units; the shipping budget is shared in proportion to quantity
 * (rounded down, so the parts never add up to more than the bid's budget).
 */
export function jobCaps(bid: Pick<BidMoney, 'qty' | 'retailCapCents' | 'shippingBudgetCents'>, job: { qty: number; feeCents: Cents }): JobCaps {
  return {
    retailCents: job.qty * bid.retailCapCents,
    feeCents: job.qty * job.feeCents,
    shippingCents: Math.floor((bid.shippingBudgetCents * job.qty) / bid.qty),
  };
}

export interface ReceiptCapture {
  /** Receipt retail after the cap. */
  retailCents: Cents;
  feeCents: Cents;
  /** retailCents + feeCents. */
  amountCents: Cents;
  /** True when the receipt was above the cap and was clamped (the queuer saw the cap before buying). */
  clamped: boolean;
}

/** Capture at a verified receipt: retail at cost up to the cap, plus the matched fee. */
export function receiptCapture(caps: JobCaps, receiptRetailCents: Cents): ReceiptCapture {
  assertWholeCents(receiptRetailCents, 'The receipt retail', { allowZero: true });
  const retailCents = Math.min(receiptRetailCents, caps.retailCents);
  return { retailCents, feeCents: caps.feeCents, amountCents: retailCents + caps.feeCents, clamped: receiptRetailCents > caps.retailCents };
}

export interface ShippingCapture {
  shippingCents: Cents;
  clamped: boolean;
}

/** Capture after tracking: shipping and prepaid duty at cost, up to the job's shipping cap. */
export function shippingCapture(caps: JobCaps, shippingCostCents: Cents, dutyPaidCents: Cents): ShippingCapture {
  assertWholeCents(shippingCostCents, 'The shipping cost', { allowZero: true });
  assertWholeCents(dutyPaidCents, 'The duty paid', { allowZero: true });
  const actual = shippingCostCents + dutyPaidCents;
  return { shippingCents: Math.min(actual, caps.shippingCents), clamped: actual > caps.shippingCents };
}

export interface HoldMoney {
  limitCents: Cents;
  capturedCents: Cents;
  status: HoldStatus;
}

/** What is still capturable under the user's own limit. */
export function remainingLimitCents(h: Pick<HoldMoney, 'limitCents' | 'capturedCents'>): Cents {
  return Math.max(0, h.limitCents - h.capturedCents);
}

/**
 * The rule that matters most: the sum of captures never exceeds the user's
 * own limit, even though PayPal would accept up to 115% of the hold.
 * Throws OVER_LIMIT; returns the limit left after this capture.
 */
export function assertCaptureWithinLimit(h: HoldMoney, amountCents: Cents): Cents {
  assertWholeCents(amountCents, 'A capture');
  if (h.status !== 'held' && h.status !== 'partially_captured') {
    throw new ContractError('HOLD_CLOSED', 'This hold can no longer be captured.', { status: h.status });
  }
  const left = remainingLimitCents(h);
  if (amountCents > left) {
    throw new ContractError('OVER_LIMIT', `Capture of ${formatUsd(amountCents, { exact: true })} is above what is left of the requester's limit (${formatUsd(left, { exact: true })}).`, {
      amountCents,
      leftCents: left,
    });
  }
  return left - amountCents;
}

/**
 * Whether a capture should be sent with final_capture=true. Only the last
 * possible capture on the hold is final; anything else stays open and the
 * remainder is released later by a void.
 */
export function isFinalCapture(s: {
  /** This job will capture again later (ship mode: the receipt capture comes before the shipping capture). */
  moreCapturesForThisJob: boolean;
  /** Other jobs of the same bid that are not finished. */
  otherActiveJobs: number;
  /** Units of the bid that could still be matched. */
  bidRemainingQty: number;
  /** The bid can still match (not cancelled, deadline not passed, not sold out). */
  bidCanStillMatch: boolean;
}): boolean {
  if (s.moreCapturesForThisJob) return false;
  if (s.otherActiveJobs > 0) return false;
  return !(s.bidCanStillMatch && s.bidRemainingQty > 0);
}

/** The platform's share of a fee, rounded down in the queuer's favour. */
export function platformFeeCents(feeCents: Cents, bps: number = DEFAULT_RULES.platformFeeBps): Cents {
  return Math.floor((feeCents * bps) / 10_000);
}

export interface PayoutPart {
  purpose: 'fee' | 'reimbursement' | 'fee_and_reimbursement';
  amountCents: Cents;
  platformFeeCents: Cents;
}

/**
 * Payouts that follow a capture.
 * - ship mode, receipt capture: the fee minus the platform fee (the labour is done).
 * - ship mode, shipping capture: retail plus shipping (the item is on its way).
 * - local mode, handover capture: everything at once.
 * Retail and shipping are pass-through at cost; the platform fee applies to the fee only.
 */
export function payoutsForCapture(
  mode: FulfilmentMode,
  capture: 'receipt' | 'shipping' | 'handover',
  parts: { retailCents: Cents; feeCents: Cents; shippingCents: Cents },
  rules: Pick<MarketRules, 'platformFeeBps'> = DEFAULT_RULES,
): PayoutPart[] {
  const cut = platformFeeCents(parts.feeCents, rules.platformFeeBps);
  if (mode === 'ship' && capture === 'receipt') {
    return [{ purpose: 'fee', amountCents: parts.feeCents - cut, platformFeeCents: cut }];
  }
  if (mode === 'ship' && capture === 'shipping') {
    return [{ purpose: 'reimbursement', amountCents: parts.retailCents + parts.shippingCents, platformFeeCents: 0 }];
  }
  if (mode === 'local' && capture === 'handover') {
    return [{ purpose: 'fee_and_reimbursement', amountCents: parts.retailCents + parts.feeCents - cut, platformFeeCents: cut }];
  }
  throw new ContractError('BAD_REQUEST', `No payout rule for a ${capture} capture in ${mode} mode.`);
}

export interface HoldTiming {
  honorEndsAt: number;
  expiresAt: number;
}

/** The current honor period ends 3 days after the latest (re)authorization; validity is 29 days from the original. */
export function holdTiming(
  h: { authorizedAt: number; originalAuthorizedAt: number },
  rules: Pick<MarketRules, 'honorPeriodDays' | 'authValidityDays'> = DEFAULT_RULES,
): HoldTiming {
  return {
    honorEndsAt: h.authorizedAt + rules.honorPeriodDays * DAY_MS,
    expiresAt: h.originalAuthorizedAt + rules.authValidityDays * DAY_MS,
  };
}

export type RenewalVerdict =
  /** Nothing to do: still inside the honor period, already captured, or no longer needed. */
  | 'not_needed'
  /** Reauthorize now for the same amount. */
  | 'reauthorize'
  /** Too late or not allowed: the requester must approve a new hold. */
  | 'renewal_required';

/**
 * Hold renewal rule. Only an untouched hold (no captures) of a bid that is
 * still open is reauthorized, from the end of the honor period (day 4) until
 * one day before the 29-day validity ends. Holds with captures are not
 * reauthorized: their later captures still work until the validity ends.
 */
export function renewalVerdict(
  h: {
    status: HoldStatus;
    capturedCents: Cents;
    authorizedAt: number;
    originalAuthorizedAt: number;
    renewalRequired: boolean;
  },
  now: number,
  opts: { bidStillOpen: boolean; reauthorizeSupported: boolean },
  rules: Pick<MarketRules, 'honorPeriodDays' | 'authValidityDays'> = DEFAULT_RULES,
): RenewalVerdict {
  if (!opts.bidStillOpen || h.status !== 'held' || h.capturedCents > 0 || h.renewalRequired) return 'not_needed';
  const t = holdTiming(h, rules);
  if (now < t.honorEndsAt) return 'not_needed';
  if (!opts.reauthorizeSupported || now >= t.expiresAt - DAY_MS) return 'renewal_required';
  return 'reauthorize';
}
