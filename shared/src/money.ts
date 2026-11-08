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

// ---------------------------------------------------------------------------
// Processing and payouts, passed through at cost (docs/DECISIONS.md D-105)
// ---------------------------------------------------------------------------

/**
 * What PayPal charges HoldMySpot for this flow, as the sandbox charged it on
 * 11-07 (US merchant, USD; docs/PAYPAL-MAPPING.md section 12): 3.49% of each
 * capture, half a cent rounding up, plus $0.49; $0.25 per Payouts item. The
 * emulator charges the same, and the server reads PayPal's own fee from every
 * capture (`seller_receivable_breakdown.paypal_fee`) and payout item
 * (`payout_item_fee`) to check it.
 */
export interface PayPalPricing {
  captureBps: number;
  captureFixedCents: Cents;
  payoutItemCents: Cents;
}

export const PAYPAL_PRICING: Readonly<PayPalPricing> = { captureBps: 349, captureFixedCents: 49, payoutItemCents: 25 };

/** The requester's line for these costs. One constant, so the wording can change in one place (D-105). */
export const PROCESSING_LABEL = 'Processing and payouts';

/** PayPal's fee on one capture: 3.49% of the whole capture (half a cent up) + $0.49. Nothing for no capture. */
export function paypalCaptureFeeCents(amountCents: Cents, pricing: PayPalPricing = PAYPAL_PRICING): Cents {
  if (amountCents <= 0) return 0;
  return Math.floor((amountCents * pricing.captureBps + 5_000) / 10_000) + pricing.captureFixedCents;
}

export type CaptureKind = 'receipt' | 'shipping' | 'handover';

/** The bid's mode from its shipping budget: shipped bids need one, local errands have none (assertBidMoney). */
export const modeForBudget = (shippingBudgetCents: Cents): FulfilmentMode => (shippingBudgetCents > 0 ? 'ship' : 'local');

/**
 * Payouts items whose PayPal fee a capture carries. A job's first capture
 * carries all of them (ship: the fee payout now and the reimbursement after
 * tracking; local: the one payout), so a job without a shipping capture (a
 * free label, or PayPal declined it) still covers its payouts. The shipping
 * capture carries none.
 */
export function payoutItemsCovered(mode: FulfilmentMode, capture: CaptureKind): number {
  if (capture === 'shipping') return 0;
  return mode === 'ship' ? 2 : 1;
}

export interface Processing {
  /** PayPal's fee on this capture: 3.49% + $0.49 of the whole capture, processing included. */
  captureFeeCents: Cents;
  /** PayPal's Payouts fees this capture carries ($0.25 per item). */
  payoutFeesCents: Cents;
  /** captureFeeCents + payoutFeesCents: the requester's "Processing and payouts" line for this capture. */
  processingCents: Cents;
}

export interface GrossCapture extends Processing {
  /** What the capture pays for before processing: shop price and fee, or shipping. */
  baseCents: Cents;
  /** baseCents + processingCents: what PayPal captures. */
  amountCents: Cents;
}

/**
 * The capture that pays `baseCents` and also covers its own PayPal fee and
 * `payoutItems` Payouts fees: the smallest amount whose net after PayPal's
 * fee is at least base + payout fees. One more cent of capture adds 0 or 1
 * cent of net, so that smallest amount nets exactly base + payout fees:
 * HoldMySpot makes nothing on processing, and the requester pays no cent more.
 */
export function grossUpCapture(baseCents: Cents, payoutItems: number, pricing: PayPalPricing = PAYPAL_PRICING): GrossCapture {
  assertWholeCents(baseCents, 'A capture base', { allowZero: true });
  if (!Number.isInteger(payoutItems) || payoutItems < 0) throw new ContractError('BAD_REQUEST', 'Payout items must be a whole number.');
  const payoutFeesCents = payoutItems * pricing.payoutItemCents;
  const need = baseCents + payoutFeesCents;
  if (need === 0) return { baseCents: 0, amountCents: 0, captureFeeCents: 0, payoutFeesCents: 0, processingCents: 0 };
  const net = (c: Cents) => c - paypalCaptureFeeCents(c, pricing);
  let amount = Math.ceil(((need + pricing.captureFixedCents) * 10_000) / (10_000 - pricing.captureBps));
  while (net(amount) < need) amount++;
  while (amount > 1 && net(amount - 1) >= need) amount--;
  return { baseCents, amountCents: amount, captureFeeCents: paypalCaptureFeeCents(amount, pricing), payoutFeesCents, processingCents: amount - baseCents };
}

export interface BidMoney {
  qty: number;
  retailCapCents: Cents;
  maxFeeCents: Cents;
  shippingBudgetCents: Cents;
}

/**
 * The most processing a bid can ever be charged: every way the matcher can
 * split its units into jobs, each job's captures at their caps, and the worst
 * of them (in practice one job per unit, since every capture adds $0.49).
 */
export function processingReserveCents(b: BidMoney, mode: FulfilmentMode = modeForBudget(b.shippingBudgetCents)): Cents {
  const best: Cents[] = [0];
  for (let n = 1; n <= b.qty; n++) {
    let top = 0;
    for (let k = 1; k <= n; k++) top = Math.max(top, jobCaps(b, { qty: k, feeCents: b.maxFeeCents }, mode).processingCents + (best[n - k] ?? 0));
    best.push(top);
  }
  return best[b.qty] ?? 0;
}

/**
 * The user's own limit and the hold amount: qty * (retail cap + max fee) +
 * shipping budget + the processing reserve. Everything a bid's jobs can
 * capture fits inside it, processing included (D-105).
 */
export function bidLimitCents(b: BidMoney, mode: FulfilmentMode = modeForBudget(b.shippingBudgetCents)): Cents {
  return b.qty * (b.retailCapCents + b.maxFeeCents) + b.shippingBudgetCents + processingReserveCents(b, mode);
}

/**
 * The highest max fee per unit whose worst case still fits in `limitCents`
 * (the bidding agent's ceiling, and what an amended bid may use), or null
 * when not even a $0 fee fits.
 */
export function maxFeeWithinLimitCents(
  b: Omit<BidMoney, 'maxFeeCents'>,
  limitCents: Cents,
  mode: FulfilmentMode = modeForBudget(b.shippingBudgetCents),
): Cents | null {
  const fits = (fee: Cents) => bidLimitCents({ ...b, maxFeeCents: fee }, mode) <= limitCents;
  if (b.qty <= 0 || !fits(0)) return null;
  let lo = 0;
  let hi = Math.max(0, Math.floor(limitCents / b.qty));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
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
  /** The most processing this job's captures can carry (each capture at its cap). */
  processingCents: Cents;
}

/**
 * The most one job may capture for each part. A job carries `qty` of the
 * bid's units; the shipping budget is shared in proportion to quantity
 * (rounded down, so the parts never add up to more than the bid's budget).
 */
export function jobCaps(
  bid: Pick<BidMoney, 'qty' | 'retailCapCents' | 'shippingBudgetCents'>,
  job: { qty: number; feeCents: Cents },
  mode: FulfilmentMode = modeForBudget(bid.shippingBudgetCents),
): JobCaps {
  const retailCents = job.qty * bid.retailCapCents;
  const feeCents = job.qty * job.feeCents;
  const shippingCents = Math.floor((bid.shippingBudgetCents * job.qty) / bid.qty);
  const first = grossUpCapture(retailCents + feeCents, payoutItemsCovered(mode, mode === 'ship' ? 'receipt' : 'handover'));
  const second = mode === 'ship' ? grossUpCapture(shippingCents, payoutItemsCovered(mode, 'shipping')) : null;
  return { retailCents, feeCents, shippingCents, processingCents: first.processingCents + (second?.processingCents ?? 0) };
}

/** The most one capture of a job may take, processing included (the server checks every capture against it). */
export function captureCapCents(caps: Pick<JobCaps, 'retailCents' | 'feeCents' | 'shippingCents'>, mode: FulfilmentMode, capture: CaptureKind): Cents {
  const base = capture === 'shipping' ? caps.shippingCents : caps.retailCents + caps.feeCents;
  return grossUpCapture(base, payoutItemsCovered(mode, capture)).amountCents;
}

export interface ReceiptCapture extends Processing {
  /** Receipt retail after the cap. */
  retailCents: Cents;
  feeCents: Cents;
  /** retailCents + feeCents + processingCents: what PayPal captures. */
  amountCents: Cents;
  /** True when the receipt was above the cap and was clamped (the queuer saw the cap before buying). */
  clamped: boolean;
}

/**
 * Capture at a verified receipt (ship) or the handover (local): retail at
 * cost up to the cap, plus the matched fee, plus processing and payouts at
 * cost (this capture's own PayPal fee and every payout of the job).
 */
export function receiptCapture(
  caps: Pick<JobCaps, 'retailCents' | 'feeCents' | 'shippingCents'>,
  receiptRetailCents: Cents,
  mode: FulfilmentMode = modeForBudget(caps.shippingCents),
): ReceiptCapture {
  assertWholeCents(receiptRetailCents, 'The receipt retail', { allowZero: true });
  const retailCents = Math.min(receiptRetailCents, caps.retailCents);
  const gross = grossUpCapture(retailCents + caps.feeCents, payoutItemsCovered(mode, mode === 'ship' ? 'receipt' : 'handover'));
  return {
    retailCents,
    feeCents: caps.feeCents,
    captureFeeCents: gross.captureFeeCents,
    payoutFeesCents: gross.payoutFeesCents,
    processingCents: gross.processingCents,
    amountCents: gross.amountCents,
    clamped: receiptRetailCents > caps.retailCents,
  };
}

export interface ShippingCapture extends Processing {
  shippingCents: Cents;
  /** shippingCents + processingCents (this capture's own PayPal fee); 0 when there is nothing to charge. */
  amountCents: Cents;
  clamped: boolean;
}

/** Capture after tracking: shipping and prepaid duty as the queuer declares them, up to the job's shipping cap, plus its own PayPal fee at cost. */
export function shippingCapture(caps: Pick<JobCaps, 'shippingCents'>, shippingCostCents: Cents, dutyPaidCents: Cents): ShippingCapture {
  assertWholeCents(shippingCostCents, 'The shipping cost', { allowZero: true });
  assertWholeCents(dutyPaidCents, 'The duty paid', { allowZero: true });
  const actual = shippingCostCents + dutyPaidCents;
  const shippingCents = Math.min(actual, caps.shippingCents);
  const gross = grossUpCapture(shippingCents, payoutItemsCovered('ship', 'shipping'));
  return {
    shippingCents,
    captureFeeCents: gross.captureFeeCents,
    payoutFeesCents: gross.payoutFeesCents,
    processingCents: gross.processingCents,
    amountCents: gross.amountCents,
    clamped: actual > caps.shippingCents,
  };
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
 * Retail (from the receipt) and shipping (as declared) pass through with no markup; the platform fee applies to the fee only.
 * Processing is never paid out: it stays to pay PayPal's capture and Payouts fees.
 */
export function payoutsForCapture(
  mode: FulfilmentMode,
  capture: CaptureKind,
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

export interface JobSettlement {
  /** Charged to the requester, net of refunds. */
  chargedCents: Cents;
  /** The requester's processing and payouts line, part of chargedCents. */
  processingCents: Cents;
  /** Sent to the queuer by PayPal Payouts. */
  paidOutCents: Cents;
  /** PayPal's fees on the job's captures and payout items, as PayPal reported them. */
  paypalFeesCents: Cents;
  /** Left with HoldMySpot: charged - paid out - PayPal's fees. Final once nothing more moves. */
  platformCents: Cents;
  /** processingCents - paypalFeesCents: 0 when PayPal charged exactly the published rate. */
  processingVarianceCents: Cents;
}

/** Where a job's money went, to the cent (records written before D-105 read as no processing). */
export function jobSettlement(amounts: {
  capturedCents: Cents;
  refundedCents: Cents;
  paidOutCents: Cents;
  processingCents?: Cents;
  paypalFeesCents?: Cents;
}): JobSettlement {
  const chargedCents = amounts.capturedCents - amounts.refundedCents;
  const processingCents = amounts.processingCents ?? 0;
  const paypalFeesCents = amounts.paypalFeesCents ?? 0;
  return {
    chargedCents,
    processingCents,
    paidOutCents: amounts.paidOutCents,
    paypalFeesCents,
    platformCents: chargedCents - amounts.paidOutCents - paypalFeesCents,
    processingVarianceCents: processingCents - paypalFeesCents,
  };
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
