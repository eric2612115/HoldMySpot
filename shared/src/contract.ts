/**
 * HoldMySpot REST + SSE contract.
 *
 * The one file the server, the player map app (web/) and the operator
 * console (ops/) all build against. It fixes:
 * - the records the API returns (bids, asks, claims, jobs, holds, ledger...),
 * - every REST endpoint: method, path, params, query, body and response,
 * - every server-sent event on GET /api/events,
 * - the error format, error codes and default market rules.
 *
 * Conventions:
 * - Money is integer US cents (`Cents`). Amounts as printed on a receipt use
 *   `LocalMoney` in PayPal's minor units (every seeded shop is in the US, so USD;
 *   the TWD conversion stays for receipts in other currencies).
 * - Market time is epoch milliseconds on the server's market clock
 *   (`MarketMs`). It runs faster than real time in demo mode. PayPal's own
 *   timestamps in sandbox mode are real time (`RealMs`).
 * - Coordinates are [lng, lat], the MapLibre order.
 * - Status values are snake_case strings.
 * - Only erasable TypeScript syntax (no enums, no namespaces), so Node can
 *   run this file directly with type stripping and Vite can bundle it.
 *
 * Human-readable reference: docs/API.md. Rules behind the fields:
 * docs/DOMAIN.md and docs/PAYPAL-MAPPING.md.
 */

export const CONTRACT_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Integer US cents. Never floating-point dollars. */
export type Cents = number;
/** Epoch milliseconds on the market clock (may run faster than real time in demo mode). */
export type MarketMs = number;
/** Epoch milliseconds in real time. */
export type RealMs = number;
/** [longitude, latitude], the MapLibre order. */
export type LngLat = [number, number];

/** Same shape as web/src/domain/money.ts `Money`. */
export interface Money {
  currency: 'USD';
  cents: Cents;
}

export const LOCAL_CURRENCIES = ['USD', 'TWD'] as const;
export type LocalCurrency = (typeof LOCAL_CURRENCIES)[number];

/** Minor-unit exponent per currency as PayPal counts it (PayPal treats TWD as having no decimals). */
export const CURRENCY_EXPONENT: Readonly<Record<LocalCurrency, number>> = { USD: 2, TWD: 0 };

/** An amount in a shop's own currency, in minor units: USD cents, TWD whole dollars. */
export interface LocalMoney {
  currency: LocalCurrency;
  minor: number;
}

export type UserId = string;
export type ShopId = string;
/** Item ids equal the web app's map point ids, for example "plush-paper-moon". */
export type ItemId = string;
export type BidId = string;
export type AskId = string;
export type ClaimId = string;
export type MatchId = string;
export type JobId = string;
export type HoldId = string;
export type LedgerId = string;
export type PayoutId = string;
export type ProofId = string;
export type FileId = string;
export type DisputeId = string;
export type AgentActionId = string;

/** Cities with seeded shops and personas. San Francisco is the default; New York is the alternative. */
export const CITY_IDS = ['sf', 'nyc'] as const;
export type CityId = (typeof CITY_IDS)[number];

export const COUNTRY_CODES = ['US', 'TW'] as const;
export type CountryCode = (typeof COUNTRY_CODES)[number];

export const RUNTIME_MODES = ['fake', 'sandbox'] as const;
/** fake: no network, in-process PayPal fake. sandbox: real PayPal sandbox REST. */
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

// ---------------------------------------------------------------------------
// Market rules (defaults; the server may override some through env vars)
// ---------------------------------------------------------------------------

export interface MarketRules {
  /** Platform fee in basis points of the matched queue fee, taken from the queuer's payout. */
  platformFeeBps: number;
  /** Pinned demo exchange rate for TWD receipts, locked on each job at match time. */
  fxTwdPerUsd: number;
  /** A queuer may post an ask or claim a bid only within this estimated travel time of the shop. */
  maxTravelMinutes: number;
  /** Travel speed used for the estimate, in metres per minute (mixed walking and transit). */
  travelMetersPerMinute: number;
  /** The arrival window ends this long after the ask's ETA. */
  arrivalGraceMinutes: number;
  /** Default geofence radius when a shop does not set its own. */
  geofenceMeters: number;
  /** Check-in is refused when the reported GPS accuracy is worse than this. */
  maxGpsAccuracyMeters: number;
  /** PayPal's honor period for an authorization. Reauthorize after it, never before. */
  honorPeriodDays: number;
  /** PayPal's authorization validity, counted from the original authorization. */
  authValidityDays: number;
  /** Latest bid deadline, counted from creation. */
  maxBidDays: number;
  /** Queuers below this reliability score cannot post asks or claim bids. */
  reliabilityFloor: number;
  /** A shipped job must get tracking within this many days of verification, or it fails and is refunded. */
  shipWithinDays: number;
}

export const DEFAULT_RULES: MarketRules = {
  platformFeeBps: 1000,
  fxTwdPerUsd: 32.3,
  maxTravelMinutes: 30,
  travelMetersPerMinute: 250,
  arrivalGraceMinutes: 10,
  geofenceMeters: 80,
  maxGpsAccuracyMeters: 50,
  honorPeriodDays: 3,
  authValidityDays: 29,
  maxBidDays: 10,
  reliabilityFloor: 60,
  shipWithinDays: 5,
};

// ---------------------------------------------------------------------------
// Catalog and people
// ---------------------------------------------------------------------------

export interface City {
  id: CityId;
  name: string;
  country: CountryCode;
  timezone: string;
  /** Map camera centre. */
  center: LngLat;
  zoom: number;
  localCurrency: LocalCurrency;
  /** Requesters must be in the US (US sandbox buyer). Queuers are local to the shops (all in the US in the seed). */
  hasRequesters: boolean;
  hasShops: boolean;
}

/** Same values as web/src/domain/types.ts `ItemKind`. */
export const ITEM_KINDS = ['cake', 'plush', 'ramen'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const FULFILMENT_MODES = ['local', 'ship'] as const;
/** local: requester and queuer meet in one US city. ship: the queuer posts the item to the requester. */
export type FulfilmentMode = (typeof FULFILMENT_MODES)[number];

export interface Item {
  id: ItemId;
  shopId: ShopId;
  kind: ItemKind;
  name: string;
  /** Short name for map labels. */
  shortName: string;
  /** Shop price in the shop's currency. Paid at cost from the receipt. */
  retail: LocalMoney;
  /** `retail` in USD cents at the pinned demo rate, for display and caps. */
  retailCents: Cents;
  /** The shop's own per-person limit. Caps bid qty and ask capacity. */
  perPersonLimit: number;
  modes: FulfilmentMode[];
  shippable: boolean;
  /** Perishable items are errands only: bought for one named requester, never sold on. */
  perishable: boolean;
  /** Packed weight per unit, for the shipping estimate. */
  weightGrams: number;
  /** Category key for the duty estimate table (illustrative values, not tax advice). */
  dutyCategory: string;
  /** Baseline expected wait in the line. */
  expectedWaitMinutes: number;
  /** Lowest queue fee per unit an ask or bid may name for this item. */
  minFeeCents: Cents;
  /** Plain-language facts shown as tags, like web TaskPoint.tags. */
  tags: string[];
  /** Names that may appear on a genuine receipt line for this item. */
  receiptAliases: string[];
}

export interface Shop {
  id: ShopId;
  cityId: CityId;
  /** Fictional name. */
  name: string;
  street: string;
  lngLat: LngLat;
  geofenceMeters: number;
  timezone: string;
  /** Local opening hours, "HH:MM". */
  hours: { opens: string; closes: string };
  /**
   * What a genuine receipt from this fictional shop shows: the printed name, and
   * the store ID printed on it and in its receipt QR (digits only), or null when
   * the shop prints no QR. All IDs are made up.
   */
  receipt: { printedName: string; sellerTaxId: string | null };
  items: Item[];
  /** Optional UI accent colour (web uses `hue`). Presentation only. */
  accent: string | null;
}

export const USER_ROLES = ['requester', 'queuer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface Reliability {
  /** 0-100: completed claims over all claims that ended. */
  score: number;
  claimsCompleted: number;
  claimsLapsed: number;
  proofsRejected: number;
}

/** A demo persona. There is no real sign-in in v1 (see docs/DECISIONS.md). */
export interface User {
  id: UserId;
  /** First name plus initial, for example "Mia R.". */
  displayName: string;
  roles: UserRole[];
  cityId: CityId;
  country: CountryCode;
  /** Character preset id used by the 3D map. Presentation only. */
  avatar: string | null;
  /** Queuers only. */
  reliability: Reliability | null;
  /** Demo start position of a queuer. Returned only to that user and ops; never on the public map. */
  home: LngLat | null;
}

// ---------------------------------------------------------------------------
// Market records
// ---------------------------------------------------------------------------

export type Destination =
  | { mode: 'local'; cityId: CityId }
  | { mode: 'ship'; country: 'US'; region: string; city: string; postalCode: string | null };

export const BID_STATUSES = [
  'awaiting_approval', // order created at PayPal, waiting for the buyer's approval
  'open', // held, nothing matched yet
  'partially_matched', // some quantity matched, the rest still rests in the book
  'matched', // all quantity matched, jobs in progress
  'closing', // no more fills possible, waiting for active jobs to finish
  'settled', // all jobs done, something was captured, the rest released
  'cancelled', // the requester cancelled before anything was captured; hold voided
  'expired', // deadline, sold out or hold lapsed before anything was captured; hold voided
  'failed', // approval or authorization failed; no hold
] as const;
export type BidStatus = (typeof BID_STATUSES)[number];

export const BID_CLOSE_REASONS = [
  'filled',
  'requester_cancelled',
  'deadline',
  'sold_out',
  'hold_lapsed',
  'approval_failed',
] as const;
export type BidCloseReason = (typeof BID_CLOSE_REASONS)[number];

export interface BidAgent {
  enabled: boolean;
  /** The requester's goal in their own words, for example "1 plush by Friday, as cheap as possible". */
  goal: string;
  status: 'active' | 'paused' | 'done';
  lastRunAt: MarketMs | null;
  nextRunAt: MarketMs | null;
}

/** A requester's resting order on the queue fee, backed by one PayPal hold. */
export interface BidTask {
  id: BidId;
  requesterId: UserId;
  requesterName: string;
  shopId: ShopId;
  itemId: ItemId;
  /** Units wanted, at most the item's per-person limit. */
  qty: number;
  /** Units not yet matched. */
  remainingQty: number;
  /** Per unit: the most the requester will pay at the shop, in USD. Retail is charged at cost up to this. */
  retailCapCents: Cents;
  /** Per unit: the most the requester will pay a queuer. */
  maxFeeCents: Cents;
  /** Whole bid: shipping and duty budget, charged at cost up to this. 0 for local errands. */
  shippingBudgetCents: Cents;
  /**
   * The user's own limit and the hold amount: qty * (retailCap + maxFee) +
   * shippingBudget + the processing reserve (`bidLimitCents`, D-105).
   */
  limitCents: Cents;
  destination: Destination;
  /** Latest purchase time. */
  deadlineAt: MarketMs;
  status: BidStatus;
  closeReason: BidCloseReason | null;
  holdId: HoldId | null;
  paypalOrderId: string | null;
  /** Current authorization (changes when the hold is reauthorized). */
  paypalAuthorizationId: string | null;
  agent: BidAgent | null;
  createdAt: MarketMs;
  /** Time priority. Resets when the max fee changes. */
  pricedAt: MarketMs;
  updatedAt: MarketMs;
}

/**
 * The fee clock of an ask: the fee steps down from the ask's `feeCents`
 * by `stepCents` every `intervalMs` until `floorCents`. Same rule as
 * web/src/domain/auction.ts `StepDownSchedule` with `openCents = feeCents`.
 */
export interface FeeClock {
  stepCents: Cents;
  /** Market-clock milliseconds between steps. */
  intervalMs: number;
  floorCents: Cents;
  /** Set when the claim checks in. Null until then, and the fee stays at the opening fee. */
  startsAt: MarketMs | null;
}

export const ASK_STATUSES = [
  'open', // capacity left and matchable
  'filled', // no capacity left; jobs in progress
  'withdrawn', // the queuer withdrew the remaining capacity
  'lapsed', // the claim lapsed without check-in
  'closed', // the visit ended (queuer done, shop closed or sold out)
] as const;
export type AskStatus = (typeof ASK_STATUSES)[number];

/** A queuer's offer to stand in one shop's line. Location-bound. */
export interface AskTask {
  id: AskId;
  queuerId: UserId;
  queuerName: string;
  shopId: ShopId;
  itemId: ItemId;
  claimId: ClaimId;
  /** post: a resting offer. claim: the queuer took one bid directly at that bid's max fee. */
  origin: 'post' | 'claim';
  targetBidId: BidId | null;
  /** Units the queuer will buy, at most the item's per-person limit. */
  capacity: number;
  remainingCapacity: number;
  modes: FulfilmentMode[];
  /** Per unit. The fixed fee, or the opening fee when `clock` is set. */
  feeCents: Cents;
  clock: FeeClock | null;
  /** When the queuer expects to be at the shop. */
  etaAt: MarketMs;
  status: AskStatus;
  createdAt: MarketMs;
  pricedAt: MarketMs;
  updatedAt: MarketMs;
}

export const CLAIM_STATUSES = [
  'awaiting_arrival', // the queuer is on the way; must check in before the window ends
  'arrived', // geofence passed; line photo pending or being checked
  'checked_in', // line photo with the one-time code verified; fee clock running
  'done', // the visit is over
  'lapsed', // no check-in before the window ended; matched quantity re-offered
  'cancelled', // withdrawn before anything was matched
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** A queuer's visit commitment: one per ask, with an arrival window and a check-in. */
export interface Claim {
  id: ClaimId;
  askId: AskId;
  queuerId: UserId;
  queuerName: string;
  shopId: ShopId;
  windowStartsAt: MarketMs;
  /** ETA plus the arrival grace. */
  windowEndsAt: MarketMs;
  status: ClaimStatus;
  /** One-time code to show in the line photo. Only returned to the queuer. */
  checkInCode: string | null;
  arrival: { at: MarketMs; lngLat: LngLat; accuracyM: number; distanceM: number } | null;
  linePhotoProofId: ProofId | null;
  checkedInAt: MarketMs | null;
  createdAt: MarketMs;
  updatedAt: MarketMs;
}

export const MATCH_TRIGGERS = ['new_bid', 'new_ask', 'clock_step', 'claim', 'requeue', 'amend'] as const;
export type MatchTrigger = (typeof MATCH_TRIGGERS)[number];

/** An immutable fill record. Each match creates exactly one job. */
export interface Match {
  id: MatchId;
  shopId: ShopId;
  itemId: ItemId;
  bidId: BidId;
  askId: AskId;
  jobId: JobId;
  qty: number;
  /** Per unit: always the ask's fee at the moment of the match. */
  feeCents: Cents;
  at: MarketMs;
  trigger: MatchTrigger;
}

export const JOB_STATUSES = [
  'claimed', // matched; waiting for the queuer to arrive
  'checked_in', // queuer arrived inside the geofence
  'queueing', // line photo verified; in the line
  'bought', // queuer says the purchase is done
  'proof_submitted', // receipt and item photos uploaded; verification running
  'verified', // proof passed; receipt capture done (ship) or waiting for handover (local)
  'shipped', // tracking added; shipping capture done
  'delivered', // handed over (local) or delivered (ship)
  'failed', // see `failure`
  'refunded', // fully refunded after capture
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_FAILURE_REASONS = [
  'no_show',
  'sold_out',
  'proof_rejected',
  'requester_cancelled',
  'queuer_withdrew',
  'hold_unavailable',
  'not_shipped',
  'payment_failed',
  'shop_closed',
] as const;
export type JobFailureReason = (typeof JOB_FAILURE_REASONS)[number];

/** Fulfilment of one match for one named requester. One receipt per job. */
export interface Job {
  id: JobId;
  matchId: MatchId;
  bidId: BidId;
  askId: AskId;
  claimId: ClaimId;
  requesterId: UserId;
  requesterName: string;
  queuerId: UserId;
  queuerName: string;
  shopId: ShopId;
  itemId: ItemId;
  qty: number;
  /** Per unit, from the match. */
  feeCents: Cents;
  mode: FulfilmentMode;
  status: JobStatus;
  failure: { reason: JobFailureReason; at: MarketMs; detail: string } | null;
  /** One-time code to show next to the item in the purchase photo. Only returned to the queuer. */
  proofCode: string | null;
  /** Local mode: shown by the requester at handover. Only returned to the requester. */
  handoverCode: string | null;
  /** Rate locked at match time for receipts in TWD. */
  fx: { twdPerUsd: number; lockedAt: MarketMs } | null;
  /** The most this job may capture for each part. */
  /** `processingCents`: the most processing the job's captures can carry (D-105; absent on older records). */
  caps: { retailCents: Cents; feeCents: Cents; shippingCents: Cents; processingCents?: Cents };
  amounts: {
    /** Retail from the verified receipt, in USD, after the cap. */
    retailCents: Cents | null;
    shippingCents: Cents | null;
    /** Everything captured, processing included. */
    capturedCents: Cents;
    refundedCents: Cents;
    paidOutCents: Cents;
    /** The requester's processing and payouts line so far, part of capturedCents (D-105). */
    processingCents?: Cents;
    /** PayPal's fees on this job's captures and payout items, as PayPal reported them (D-105). */
    paypalFeesCents?: Cents;
  };
  shipment: { carrierName: string; trackingNumber: string; addedAt: MarketMs } | null;
  /** When each status was entered. */
  history: { status: JobStatus; at: MarketMs }[];
  disputed: boolean;
  createdAt: MarketMs;
  updatedAt: MarketMs;
}

// ---------------------------------------------------------------------------
// Money records
// ---------------------------------------------------------------------------

export const HOLD_STATUSES = [
  'pending_approval',
  'held',
  'partially_captured',
  'captured', // a final capture happened; anything left was released by it
  'released', // voided (or expired) with the remainder returned
  'failed',
] as const;
/** Superset of web/src/services/payments/types.ts `HoldStatus`. */
export type HoldStatus = (typeof HOLD_STATUSES)[number];

export const FUNDING_SOURCES = ['paypal', 'venmo', 'paylater', 'card', 'fake'] as const;
export type FundingSource = (typeof FUNDING_SOURCES)[number];

/** Which button the buyer used. */
export type CheckoutFunding = 'paypal' | 'venmo' | 'paylater';

/**
 * One PayPal authorization backing one bid. Superset of the web prototype's
 * `Hold` (id, reference, description, amount, capturedCents, releasedCents,
 * status, createdAt).
 */
export interface Hold {
  id: HoldId;
  /** Our own reference: the bid id. */
  reference: string;
  description: string;
  /** The user's own limit. Captures never exceed it, although PayPal would allow 115%. */
  amount: Money;
  capturedCents: Cents;
  releasedCents: Cents;
  refundedCents: Cents;
  status: HoldStatus;
  fundingSource: FundingSource | null;
  paypalOrderId: string | null;
  authorizationId: string | null;
  originalAuthorizationId: string | null;
  /** Start of the current honor period (the latest authorization or reauthorization). */
  authorizedAt: number | null;
  /** Validity is counted from the original authorization. */
  originalAuthorizedAt: number | null;
  honorEndsAt: number | null;
  expiresAt: number | null;
  /** real: PayPal sandbox timestamps. market: the fake adapter runs PayPal time on the market clock. */
  clockBasis: 'real' | 'market';
  renewals: number;
  /** Reauthorization failed or is not possible: the requester must approve a new hold. */
  renewalRequired: boolean;
  createdAt: MarketMs;
  updatedAt: MarketMs;
}

export const LEDGER_KINDS = ['held', 'renewed', 'captured', 'released', 'paid_out', 'refunded'] as const;
/** Superset of web `ActivityKind` ('held' | 'captured' | 'released' | 'paid_out'). */
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const LEDGER_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

/** One money event. Superset of the web prototype's `Activity`. Append-only. */
export interface LedgerEntry {
  id: LedgerId;
  kind: LedgerKind;
  amount: Money;
  /** What happened, in one plain sentence. */
  text: string;
  at: MarketMs;
  holdId: HoldId | null;
  payoutId: PayoutId | null;
  bidId: BidId | null;
  jobId: JobId | null;
  /** Whose money: the requester for held/renewed/captured/released/refunded, the queuer for paid_out. */
  userId: UserId;
  /** Unique. Also sent to PayPal as PayPal-Request-Id (or sender_batch_id for payouts). */
  idempotencyKey: string;
  status: LedgerStatus;
  mode: RuntimeMode;
  paypal: {
    orderId?: string;
    authorizationId?: string;
    captureId?: string;
    refundId?: string;
    payoutBatchId?: string;
    payoutItemId?: string;
    debugId?: string;
    /** PayPal's fee on this capture (seller_receivable_breakdown.paypal_fee) or payout item (payout_item_fee), as PayPal reported it (D-105). */
    feeCents?: number;
  } | null;
}

export const PAYOUT_STATUSES = ['pending', 'succeeded', 'unclaimed', 'failed', 'returned', 'cancelled'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/** Superset of the web prototype's `Payout`. */
export interface Payout {
  id: PayoutId;
  /** Display name of the queuer. */
  recipient: string;
  recipientUserId: UserId;
  /** Sandbox receiver email. Returned to ops only. */
  receiverEmail: string | null;
  amount: Money;
  note: string;
  /** Our own reference: the job id. */
  reference: string;
  purpose: 'fee' | 'reimbursement' | 'fee_and_reimbursement';
  platformFeeCents: Cents;
  status: PayoutStatus;
  paypalBatchId: string | null;
  paypalItemId: string | null;
  /** PayPal's Payouts fee for this item (payout_item_fee), once PayPal reports it; paid by the requester's processing line (D-105). */
  paypalFeeCents?: Cents | null;
  createdAt: MarketMs;
  updatedAt: MarketMs;
}

export const DISPUTE_STATUSES = ['open', 'waiting_for_seller', 'under_review', 'resolved'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export interface Dispute {
  id: DisputeId;
  jobId: JobId | null;
  captureId: string;
  reason: string;
  status: DisputeStatus;
  outcome: 'buyer_favor' | 'seller_favor' | 'other' | null;
  amount: Money;
  evidenceSubmitted: boolean;
  createdAt: MarketMs;
  updatedAt: MarketMs;
}

// ---------------------------------------------------------------------------
// Files, proofs and AI
// ---------------------------------------------------------------------------

export const FILE_PURPOSES = ['line_photo', 'receipt', 'item_photo', 'label', 'sold_out_photo'] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

export interface FileRef {
  id: FileId;
  purpose: FilePurpose;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  bytes: number;
  sha256: string;
  /** 64-bit difference hash as 16 hex characters, for duplicate-photo checks. */
  dHash: string | null;
  width: number | null;
  height: number | null;
  /** Relative URL: /api/files/:fileId */
  url: string;
  createdAt: MarketMs;
}

export const AI_PROVIDERS = ['anthropic', 'muse', 'openai', 'fake'] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

export const AI_MODES = ['live', 'record', 'replay', 'fake'] as const;
/** live: call the model. record: call and save a fixture. replay: use a saved fixture. fake: rules only. */
export type AiMode = (typeof AI_MODES)[number];

/** Attached to every AI-derived result so screens can say where it came from. */
export interface AiStamp {
  provider: AiProviderId;
  model: string;
  mode: AiMode;
  latencyMs: number;
  /**
   * Set only when no model and no recording read the photo: the simulated reading the rules got
   * instead (a scenario such as `genuine`, `fake_receipt` or `line_ok`), so screens never say a
   * model checked it (D-128).
   */
  simulated?: string | null;
}

export const PROOF_STATUSES = ['verifying', 'passed', 'failed', 'needs_review'] as const;
export type ProofStatus = (typeof PROOF_STATUSES)[number];

export const PROOF_CHECK_CODES = [
  'geofence',
  'line_visible',
  'code_visible',
  'shop_match',
  'time_window',
  'item_match',
  'qty_within_limit',
  'totals_add_up',
  'qr_matches_print',
  'within_retail_cap',
  'duplicate_photo',
  'generator_metadata',
] as const;
export type ProofCheckCode = (typeof PROOF_CHECK_CODES)[number];

export interface ProofCheck {
  code: ProofCheckCode;
  ok: boolean;
  /** hard: a failure fails the proof. soft: a failure sends it to review. */
  weight: 'hard' | 'soft';
  detail: string;
}

export interface ReceiptLine {
  name: string;
  qty: number;
  unit: LocalMoney;
  total: LocalMoney;
}

/** Fields a model read from the receipt photo, plus the decoded QR (if any). */
export interface ReceiptFields {
  printedName: string | null;
  sellerTaxId: string | null;
  invoiceNumber: string | null;
  /** As printed, with the shop's UTC offset added, ISO 8601. */
  issuedAt: string | null;
  currency: LocalCurrency | null;
  lines: ReceiptLine[];
  total: LocalMoney | null;
  /** Decoded receipt QR fields (store ID, receipt number, date, total), when a QR was found. */
  qr: { invoiceNumber: string | null; issuedDate: string | null; sellerTaxId: string | null; total: number | null } | null;
  /** The one-time code read from the item photo. */
  codeSeen: string | null;
}

export interface Proof {
  id: ProofId;
  kind: 'check_in' | 'purchase';
  claimId: ClaimId | null;
  jobId: JobId | null;
  /** check_in: [linePhoto]. purchase: [receipt, itemPhoto]. */
  fileIds: FileId[];
  status: ProofStatus;
  checks: ProofCheck[];
  receipt: ReceiptFields | null;
  amounts: {
    receiptTotal: LocalMoney | null;
    fxTwdPerUsd: number | null;
    /** Receipt retail in USD before the cap. */
    retailCents: Cents | null;
    /** What the receipt (or handover) capture will take: retail after cap, the matched fee and processing. */
    captureCents: Cents | null;
    /** The processing and payouts part of captureCents (D-105). */
    processingCents?: Cents | null;
  } | null;
  /** People ahead counted from a line photo, when the model could tell. */
  peopleAhead: number | null;
  /** One plain sentence for screens, for example "Receipt matches Paper Moon Toys at 11:41." */
  summary: string;
  ai: AiStamp;
  decidedBy: 'ai_rules' | 'ops' | null;
  createdAt: MarketMs;
  decidedAt: MarketMs | null;
}

export interface FeeEstimate {
  expectedWaitMinutes: number;
  peopleAhead: number | null;
  suggestedFeeCents: Cents;
  minFeeCents: Cents;
  /** A suggested clock for queuers. */
  clock: { feeCents: Cents; stepCents: Cents; intervalMs: number; floorCents: Cents };
  /** Short reasons, for example "Line photo at 10:52 shows about 40 people". */
  basis: string[];
  ai: AiStamp;
}

export interface ShippingEstimate {
  parcelGrams: number;
  shippingCents: Cents;
  dutyCents: Cents;
  /** Suggested shipping and duty budget (estimate plus a margin). */
  budgetCents: Cents;
  /** Fictional service name, for example "Harbor Parcel Ground, tracked". */
  service: string;
  days: { min: number; max: number };
  notes: string[];
  ai: AiStamp;
}

export interface BidQuote {
  retailCents: Cents;
  suggested: { retailCapCents: Cents; maxFeeCents: Cents; shippingBudgetCents: Cents };
  /** Hold amount for the suggested values, the processing reserve included. */
  limitCents: Cents;
  /** The most processing and payouts the suggested bid can be charged, part of limitCents (D-105). */
  processingReserveCents: Cents;
  fee: FeeEstimate;
  shipping: ShippingEstimate | null;
  platformFee: { bps: number; perUnitCents: Cents };
  /** Plain sentences the bid form must show, for example the platform fee and "charged at cost". */
  disclosures: string[];
}

export const AGENT_ACTION_KINDS = ['raise_fee', 'lower_fee', 'keep', 'reduce_qty', 'cancel', 'reassign', 'note'] as const;
export type AgentActionKind = (typeof AGENT_ACTION_KINDS)[number];

export interface AgentAction {
  id: AgentActionId;
  bidId: BidId;
  at: MarketMs;
  kind: AgentActionKind;
  fromFeeCents: Cents | null;
  toFeeCents: Cents | null;
  /** One plain sentence. */
  reason: string;
  ai: AiStamp;
}

// ---------------------------------------------------------------------------
// Book, clock, config
// ---------------------------------------------------------------------------

export interface DepthLevel {
  feeCents: Cents;
  qty: number;
  count: number;
  /** What PayPal still holds for the requests at this fee (each hold less its captures and releases; D-111). Book snapshots only. */
  heldCents?: Cents;
}

/** Same field names as web/src/domain/types.ts `QueueInfo`. */
export interface QueueInfo {
  /** Estimated wait in the line, in minutes. */
  minutes: number;
  peopleAhead: number | null;
  /** Display names of HoldMySpot queuers checked in at this shop now. */
  queuers: string[];
}

/** An ask as the public map shows it. No positions. */
export interface AskQuote {
  askId: AskId;
  queuerId: UserId;
  queuerName: string;
  avatar: string | null;
  claimStatus: ClaimStatus;
  feeCents: Cents;
  clock: FeeClock | null;
  remainingCapacity: number;
  modes: FulfilmentMode[];
  etaAt: MarketMs;
}

/** One shop-item book: what lights up a point on the map. */
export interface BookSnapshot {
  shopId: ShopId;
  itemId: ItemId;
  cityId: CityId;
  asOf: MarketMs;
  status: 'open' | 'sold_out' | 'closed';
  retailCents: Cents;
  /**
   * Resting requests: how many, how many units, the best max fee, depth by fee,
   * and the latest deadline among them (a queuer who cannot arrive before it
   * can take none of them).
   */
  bids: { count: number; qty: number; bestFeeCents: Cents | null; levels: DepthLevel[]; latestDeadlineAt: MarketMs | null };
  /** Ask fees move with their clocks: compute live prices from `quotes` with the shared stepdown helpers. */
  asks: { count: number; capacity: number; quotes: AskQuote[] };
  lastFill: { feeCents: Cents; qty: number; at: MarketMs } | null;
  queue: QueueInfo;
}

export interface ClockState {
  /** 1 = real time. Demo mode runs 1 to 600. */
  speed: number;
  paused: boolean;
  /** Market time at `realNow`. Clients compute: marketNow + (Date.now() - realNow) * speed, unless paused. */
  marketNow: MarketMs;
  realNow: RealMs;
}

export interface AppConfig {
  contractVersion: string;
  mode: RuntimeMode;
  /** Why the server is in this mode, for example "sandbox.env not found: running fake". */
  modeReason: string;
  paypal: {
    /** Public client id of the platform app. Null in fake mode. */
    clientId: string | null;
    /** JS SDK v6 core script URL. Null in fake mode. */
    sdkUrl: string | null;
    components: string[];
    currency: 'USD';
    /** Sandbox only: forces the buyer country so Venmo and Pay Later can show. */
    testBuyerCountry: 'US' | null;
    /** Buttons this server allows (Pay Later only after its day-1 probe passes). */
    funding: CheckoutFunding[];
  };
  ai: { provider: AiProviderId; model: string; mode: AiMode };
  clock: ClockState;
  demo: { enabled: boolean; scriptId: string | null };
  rules: MarketRules;
}

// ---------------------------------------------------------------------------
// Ops console data
// ---------------------------------------------------------------------------

/** Queuer rows on the Bryntum board. */
export interface BoardResource {
  id: UserId;
  name: string;
  cityId: CityId;
  reliability: number | null;
  avatar: string | null;
}

/** Board bars. Colours are chosen by ops/ from `kind` and `status`. */
export interface BoardEvent {
  id: string;
  resourceId: UserId;
  kind: 'claim_window' | 'queueing' | 'job' | 'fee_clock' | 'hold_honor';
  name: string;
  startDate: MarketMs;
  endDate: MarketMs;
  status: string;
  refs: { claimId?: ClaimId; jobId?: JobId; bidId?: BidId; askId?: AskId; holdId?: HoldId };
}

export interface BoardTimeRange {
  id: string;
  name: string;
  kind: 'shop_hours' | 'demo_marker';
  startDate: MarketMs;
  endDate: MarketMs;
}

export interface BoardData {
  from: MarketMs;
  to: MarketMs;
  resources: BoardResource[];
  events: BoardEvent[];
  timeRanges: BoardTimeRange[];
  generatedAt: MarketMs;
}

export const OPS_DATASETS = ['fills', 'bids', 'asks', 'jobs', 'holds', 'ledger', 'payouts', 'books'] as const;
export type OpsDatasetName = (typeof OPS_DATASETS)[number];

/** Flat rows for the AG Studio market dashboard (built by opsDatasets in opsviews.ts). */
export interface OpsDataset {
  name: OpsDatasetName;
  fields: { name: string; type: 'string' | 'number' | 'boolean' | 'date'; label: string }[];
  rows: Record<string, string | number | boolean | null>[];
  generatedAt: MarketMs;
}

/**
 * Every market record the operator console draws, in one read (admin only):
 * the board's bars and side panels, the map and the dashboard datasets are
 * computed from these with the same functions the console's replay uses.
 */
export interface OpsRecords {
  at: MarketMs;
  /** Personas (crowd requesters excluded). Ops sees home positions. */
  users: User[];
  /** Seeded crowd requesters, by name only. */
  crowd: { id: UserId; displayName: string; cityId: CityId }[];
  bids: BidTask[];
  holds: Hold[];
  asks: AskTask[];
  claims: Claim[];
  matches: Match[];
  jobs: Job[];
  proofs: Proof[];
  ledger: LedgerEntry[];
  payouts: Payout[];
  agentActions: AgentAction[];
}

// ---------------------------------------------------------------------------
// Ops agents (D-100 to D-102): one model turn, and the moves an operator approves
// ---------------------------------------------------------------------------

/** One tool call in an ops agent's turn. `arguments` is a JSON object, encoded. */
export interface OpsAgentToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** One line of an ops agent's conversation; `tool` lines answer the call named by `callId`. */
export interface OpsAgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  text: string;
  calls?: OpsAgentToolCall[];
  callId?: string;
}

export interface OpsAgentToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

/**
 * POST /api/ops/agents/turn: the next turn of an ops console agent (the
 * market desk, an AG Studio built-in agent it delegates to, or the
 * rescheduler), answered by the server's AI port. Tools run in the console.
 */
export interface OpsAgentTurnRequest {
  /** Who is asking, for example "market-desk", "rescheduler", or a Studio agent id ("data", "page", "widget"). */
  agent: string;
  instructions: string;
  messages: OpsAgentMessage[];
  tools: OpsAgentToolSpec[];
  toolChoice: 'auto' | 'none' | 'required' | { name: string };
}

export interface OpsAgentTurnResponse {
  /** Text for the operator; may be empty when the turn only calls tools. */
  say: string;
  calls: OpsAgentToolCall[];
  ai: AiStamp;
}

/**
 * A rescheduling move. `reassign` moves a job not yet bought to another
 * queuer's open offer at that offer's fee now; `extend` shifts a late
 * queuer's arrival window (and ETA) later; `release` lets a late queuer go,
 * so the jobs go back to the line-up and the rules re-offer them;
 * `release_job` frees a queuer's units from a request whose PayPal hold
 * cannot pay, for the next requests.
 */
export type OpsMove =
  | { kind: 'reassign'; jobId: JobId; toAskId: AskId }
  | { kind: 'extend'; claimId: ClaimId; minutes: number }
  | { kind: 'release'; claimId: ClaimId }
  | { kind: 'release_job'; jobId: JobId };

export interface OpsMovesRequest {
  moves: OpsMove[];
  /** Why, in one plain sentence (the rescheduler's reason or "Dragged by ops"). */
  reason: string;
  proposalId: string | null;
  /** Who chose the moves; null for a person (a drag on the board). */
  ai: AiStamp | null;
}

/** Moves run in order; one the rules refuse is skipped with the reason (none applied answers 409 CONFLICT). */
export interface OpsMovesResult {
  applied: { move: OpsMove; note: string; jobIds: JobId[] }[];
  skipped: { move: OpsMove; problem: string }[];
  actions: AgentAction[];
}

// ---------------------------------------------------------------------------
// Demo mode
// ---------------------------------------------------------------------------

export interface DemoScriptSummary {
  id: string;
  title: string;
  description: string;
  /** Market start, ISO 8601 with offset, for example "2026-11-12T10:30:00-08:00". */
  startsAt: string;
  speed: number;
  steps: number;
  durationMs: number;
}

export interface DemoState {
  enabled: boolean;
  scriptId: string | null;
  status: 'idle' | 'running' | 'paused' | 'finished';
  stepIndex: number;
  nextStepAt: MarketMs | null;
  seed: number;
}

/** Camera and caption hints for filming. The web app may follow or ignore them. */
export interface DemoCue {
  name: 'focus_shop' | 'focus_user' | 'show_receipt' | 'show_ledger' | 'show_board' | 'caption' | 'pause_point';
  target: string | null;
  text: string | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const API_ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_TRANSITION',
  'IDEMPOTENCY_CONFLICT',
  'RATE_LIMITED',
  'NOT_BUILT',
  'DEMO_ONLY',
  'FAKE_ONLY',
  'SANDBOX_ONLY',
  // money (the first four are the web prototype's PaymentError codes)
  'INVALID_AMOUNT',
  'HOLD_NOT_FOUND',
  'HOLD_CLOSED',
  'OVER_CAPTURE',
  'OVER_LIMIT',
  'HOLD_EXPIRED',
  'RENEWAL_REQUIRED',
  // market rules
  'OVER_STORE_LIMIT',
  'FEE_BELOW_MINIMUM',
  'RETAIL_CAP_TOO_LOW',
  'DEADLINE_OUT_OF_RANGE',
  'MODE_NOT_ALLOWED',
  'SELF_MATCH',
  'OUT_OF_RANGE',
  'OUTSIDE_GEOFENCE',
  'GPS_TOO_COARSE',
  'WINDOW_CLOSED',
  'RELIABILITY_TOO_LOW',
  'SOLD_OUT',
  'WRONG_CODE',
  // integrations
  'PAYPAL_DECLINED',
  'PAYPAL_ERROR',
  'PAYPAL_UNAVAILABLE',
  'AI_UNAVAILABLE',
  // anything unexpected (HTTP 500)
  'INTERNAL',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
    /** PayPal's debug_id when a PayPal call failed. */
    paypalDebugId?: string;
  };
}

/** Thrown by shared helpers; the server maps it to ApiErrorBody. */
export class ContractError extends Error {
  readonly code: ApiErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

export interface HealthResponse {
  ok: true;
  mode: RuntimeMode;
  contractVersion: string;
  uptimeMs: number;
}

export interface PositionReport {
  lngLat: LngLat;
  accuracyM: number;
}

export interface QuoteRequest {
  shopId: ShopId;
  itemId: ItemId;
  qty: number;
  destination: Destination;
}

export interface CreateBidRequest {
  shopId: ShopId;
  itemId: ItemId;
  qty: number;
  retailCapCents: Cents;
  maxFeeCents: Cents;
  shippingBudgetCents: Cents;
  destination: Destination;
  deadlineAt: MarketMs;
  funding: CheckoutFunding;
  /** Turn on the bidding agent for this bid. */
  agent: { goal: string } | null;
}

export interface CreateBidResponse {
  bid: BidTask;
  hold: Hold;
  checkout: {
    orderId: string;
    mode: RuntimeMode;
    /**
     * sandbox: start a JS SDK v6 one-time payment session with this order id.
     * fake: call POST /api/fake/paypal/orders/:orderId/approve, then authorize.
     */
    next: 'js_sdk' | 'fake_approve';
  };
}

export interface AuthorizeBidRequest {
  orderId: string;
}

export interface BidResult {
  bid: BidTask;
  hold: Hold;
  matches: Match[];
}

export interface ApprovalFailedRequest {
  reason: 'cancelled' | 'error';
  detail: string | null;
}

export interface AmendBidRequest {
  maxFeeCents?: Cents;
  qty?: number;
  deadlineAt?: MarketMs;
}

export interface CancelBidRequest {
  reason: string | null;
}

export interface BidDetail {
  bid: BidTask;
  hold: Hold | null;
  matches: Match[];
  jobs: Job[];
  ledger: LedgerEntry[];
  agentActions: AgentAction[];
}

export interface ClaimBidRequest {
  qty: number;
  etaAt: MarketMs;
  modes: FulfilmentMode[];
  from: PositionReport;
}

export interface ClaimBidResponse {
  ask: AskTask;
  claim: Claim;
  match: Match;
  job: Job;
}

export interface CreateAskRequest {
  shopId: ShopId;
  itemId: ItemId;
  capacity: number;
  modes: FulfilmentMode[];
  feeCents: Cents;
  clock: { stepCents: Cents; intervalMs: number; floorCents: Cents } | null;
  etaAt: MarketMs;
  from: PositionReport;
}

export interface AskResult {
  ask: AskTask;
  claim: Claim;
  matches: Match[];
}

export interface WithdrawAskResponse {
  ask: AskTask;
  claim: Claim;
  jobs: Job[];
}

export interface ClaimDetail {
  claim: Claim;
  ask: AskTask;
  jobs: Job[];
}

export interface CheckInRequest extends PositionReport {
  photoFileId: FileId;
}

export interface CheckInResponse {
  claim: Claim;
  /** The line-photo proof, verifying asynchronously (watch proof.updated). Null if the geofence failed. */
  proof: Proof | null;
  jobs: Job[];
}

export interface JobDetail {
  job: Job;
  /** Requester and ops only. */
  bid: BidTask | null;
  ask: AskTask;
  claim: Claim;
  proofs: Proof[];
  ledger: LedgerEntry[];
  payouts: Payout[];
  dispute: Dispute | null;
}

export interface SoldOutRequest {
  photoFileId: FileId | null;
}

export interface SubmitProofRequest {
  receiptFileId: FileId;
  itemFileId: FileId;
}

export interface AddShipmentRequest {
  /** Fictional carrier name; sent to PayPal as carrier OTHER with this name. */
  carrierName: string;
  trackingNumber: string;
  /** Actual label cost. Charged at cost up to the job's shipping cap. */
  shippingCostCents: Cents;
  /** Duty prepaid by the queuer, if any. Counts toward the same cap. */
  dutyPaidCents: Cents;
  labelFileId: FileId | null;
}

export interface HandoverRequest {
  code: string;
}

export interface JobMoneyResult {
  job: Job;
  ledger: LedgerEntry[];
}

export interface RefundRequest {
  amountCents: Cents;
  reason: string;
}

export interface ReviewProofRequest {
  decision: 'pass' | 'fail';
  note: string;
}

export interface FeeEstimateRequest {
  shopId: ShopId;
  itemId: ItemId;
  at: MarketMs | null;
}

export interface ShippingEstimateRequest {
  itemId: ItemId;
  qty: number;
  destination: Destination;
}

export interface SweepResult {
  renewed: HoldId[];
  renewalRequired: HoldId[];
  lapsedClaims: ClaimId[];
  expiredBids: BidId[];
  voided: HoldId[];
}

export interface DisputeEvidenceRequest {
  note: string;
  /** Proof photos and receipt fields are attached by the server from the job. */
  includeTracking: boolean;
}

export interface FakeApproveRequest {
  funding: CheckoutFunding;
  outcome: 'approve' | 'cancel' | 'decline';
}

export interface DemoResetRequest {
  seed: number | null;
  scriptId: string | null;
}

export interface DemoStartRequest {
  scriptId: string;
  speed: number | null;
}

export interface DemoClockRequest {
  speed?: number;
  paused?: boolean;
  /** Jump the market clock forward to this time (never backward). */
  jumpTo?: MarketMs;
}

/** Marker for endpoints whose body or response is raw bytes. */
export interface BinaryBody {
  readonly binary: true;
}

// ---------------------------------------------------------------------------
// Server-sent events (GET /api/events)
// ---------------------------------------------------------------------------

export interface HelloEvent {
  contractVersion: string;
  mode: RuntimeMode;
  /** Changes when the server restarts or the demo resets: refetch snapshots. */
  bootId: string;
  /** The latest sequence number at connect time. */
  seq: number;
  clock: ClockState;
  as: UserId | null;
}

export interface QueuerMovedEvent {
  userId: UserId;
  lngLat: LngLat;
  heading: number;
  /** Always true: positions come from the demo director, never from GPS. */
  synthetic: true;
}

/** Event type to payload. Audience rules are in docs/API.md. */
export interface ServerEventData {
  hello: HelloEvent;
  resync: { reason: string };
  'clock.updated': ClockState;
  'book.updated': BookSnapshot;
  'bid.updated': BidTask;
  'ask.updated': AskTask;
  'claim.updated': Claim;
  'match.created': Match;
  'job.updated': Job;
  'proof.updated': Proof;
  'hold.updated': Hold;
  'ledger.appended': LedgerEntry;
  'payout.updated': Payout;
  'dispute.updated': Dispute;
  'agent.action': AgentAction;
  'queuer.moved': QueuerMovedEvent;
  'demo.state': DemoState;
  'demo.cue': DemoCue;
}

export type ServerEventType = keyof ServerEventData;

/** Wire format: `id: <seq>`, `event: <type>`, `data: <JSON of the envelope>`. */
export interface EventEnvelope<T extends ServerEventType = ServerEventType> {
  seq: number;
  type: T;
  /** Market time of the change. */
  at: MarketMs;
  data: ServerEventData[T];
}

export type ServerEvent = { [K in ServerEventType]: EventEnvelope<K> }[ServerEventType];

export const SERVER_EVENT_TYPES: readonly ServerEventType[] = [
  'hello',
  'resync',
  'clock.updated',
  'book.updated',
  'bid.updated',
  'ask.updated',
  'claim.updated',
  'match.created',
  'job.updated',
  'proof.updated',
  'hold.updated',
  'ledger.appended',
  'payout.updated',
  'dispute.updated',
  'agent.action',
  'queuer.moved',
  'demo.state',
  'demo.cue',
];

// ---------------------------------------------------------------------------
// Endpoint table
// ---------------------------------------------------------------------------

export type NoParams = Record<string, never>;
export type NoQuery = Record<string, never>;
export type NoBody = null;

export interface Endpoint<P, Q, B, R> {
  params: P;
  query: Q;
  body: B;
  response: R;
}

/** Keys are "METHOD /path" with :params, exactly as the server registers them. */
export interface ApiSpec {
  // system
  'GET /api/health': Endpoint<NoParams, NoQuery, NoBody, HealthResponse>;
  'GET /api/config': Endpoint<NoParams, NoQuery, NoBody, AppConfig>;
  'GET /api/clock': Endpoint<NoParams, NoQuery, NoBody, ClockState>;
  'GET /api/events': Endpoint<NoParams, { as?: UserId; since?: string }, NoBody, ServerEvent>;
  // catalog and people
  'GET /api/cities': Endpoint<NoParams, NoQuery, NoBody, { cities: City[] }>;
  'GET /api/shops': Endpoint<NoParams, { cityId?: CityId }, NoBody, { shops: Shop[] }>;
  'GET /api/shops/:shopId': Endpoint<{ shopId: ShopId }, NoQuery, NoBody, { shop: Shop; books: BookSnapshot[] }>;
  'GET /api/users': Endpoint<NoParams, { role?: UserRole }, NoBody, { users: User[] }>;
  'GET /api/me': Endpoint<NoParams, NoQuery, NoBody, { user: User }>;
  // market
  'GET /api/books': Endpoint<NoParams, { cityId?: CityId }, NoBody, { books: BookSnapshot[]; asOf: MarketMs }>;
  'GET /api/books/:shopId/:itemId': Endpoint<
    { shopId: ShopId; itemId: ItemId },
    NoQuery,
    NoBody,
    { book: BookSnapshot; asks: AskTask[]; recentMatches: Match[] }
  >;
  // files
  /** `fixture` (fake mode only) names a simulated reading for the in-process fake AI, for example "genuine" or "fake_receipt". */
  'POST /api/files': Endpoint<NoParams, { purpose: FilePurpose; fixture?: string }, BinaryBody, { file: FileRef }>;
  'GET /api/files/:fileId': Endpoint<{ fileId: FileId }, NoQuery, NoBody, BinaryBody>;
  // bids
  'POST /api/bids/quote': Endpoint<NoParams, NoQuery, QuoteRequest, BidQuote>;
  'POST /api/bids': Endpoint<NoParams, NoQuery, CreateBidRequest, CreateBidResponse>;
  'POST /api/bids/:bidId/authorize': Endpoint<{ bidId: BidId }, NoQuery, AuthorizeBidRequest, BidResult>;
  'POST /api/bids/:bidId/approval-failed': Endpoint<{ bidId: BidId }, NoQuery, ApprovalFailedRequest, { bid: BidTask; hold: Hold }>;
  'GET /api/bids': Endpoint<NoParams, { mine?: '1'; status?: BidStatus; shopId?: ShopId }, NoBody, { bids: BidTask[] }>;
  'GET /api/bids/:bidId': Endpoint<{ bidId: BidId }, NoQuery, NoBody, BidDetail>;
  'PATCH /api/bids/:bidId': Endpoint<{ bidId: BidId }, NoQuery, AmendBidRequest, { bid: BidTask; matches: Match[] }>;
  'POST /api/bids/:bidId/cancel': Endpoint<{ bidId: BidId }, NoQuery, CancelBidRequest, { bid: BidTask; hold: Hold }>;
  'POST /api/bids/:bidId/claim': Endpoint<{ bidId: BidId }, NoQuery, ClaimBidRequest, ClaimBidResponse>;
  'GET /api/bids/:bidId/agent-actions': Endpoint<{ bidId: BidId }, NoQuery, NoBody, { actions: AgentAction[] }>;
  'POST /api/bids/:bidId/agent': Endpoint<{ bidId: BidId }, NoQuery, { enabled: boolean }, { bid: BidTask }>;
  // asks and claims
  'POST /api/asks': Endpoint<NoParams, NoQuery, CreateAskRequest, AskResult>;
  'GET /api/asks': Endpoint<NoParams, { mine?: '1'; shopId?: ShopId; status?: AskStatus }, NoBody, { asks: AskTask[] }>;
  'POST /api/asks/:askId/withdraw': Endpoint<{ askId: AskId }, NoQuery, NoBody, WithdrawAskResponse>;
  'GET /api/claims/:claimId': Endpoint<{ claimId: ClaimId }, NoQuery, NoBody, ClaimDetail>;
  'POST /api/claims/:claimId/check-in': Endpoint<{ claimId: ClaimId }, NoQuery, CheckInRequest, CheckInResponse>;
  'POST /api/claims/:claimId/done': Endpoint<{ claimId: ClaimId }, NoQuery, NoBody, ClaimDetail>;
  // jobs
  'GET /api/jobs': Endpoint<NoParams, { mine?: '1'; role?: UserRole; status?: JobStatus }, NoBody, { jobs: Job[] }>;
  'GET /api/jobs/:jobId': Endpoint<{ jobId: JobId }, NoQuery, NoBody, JobDetail>;
  'POST /api/jobs/:jobId/bought': Endpoint<{ jobId: JobId }, NoQuery, NoBody, { job: Job }>;
  'POST /api/jobs/:jobId/sold-out': Endpoint<{ jobId: JobId }, NoQuery, SoldOutRequest, { job: Job; book: BookSnapshot }>;
  'POST /api/jobs/:jobId/proof': Endpoint<{ jobId: JobId }, NoQuery, SubmitProofRequest, { job: Job; proof: Proof }>;
  'POST /api/jobs/:jobId/shipment': Endpoint<{ jobId: JobId }, NoQuery, AddShipmentRequest, JobMoneyResult>;
  'POST /api/jobs/:jobId/handover': Endpoint<{ jobId: JobId }, NoQuery, HandoverRequest, JobMoneyResult>;
  'POST /api/jobs/:jobId/delivered': Endpoint<{ jobId: JobId }, NoQuery, NoBody, { job: Job }>;
  // money
  'GET /api/holds/:holdId': Endpoint<{ holdId: HoldId }, NoQuery, NoBody, { hold: Hold }>;
  'GET /api/ledger': Endpoint<NoParams, { mine?: '1'; bidId?: BidId; jobId?: JobId }, NoBody, { entries: LedgerEntry[] }>;
  'GET /api/payouts': Endpoint<NoParams, { mine?: '1' }, NoBody, { payouts: Payout[] }>;
  'POST /api/paypal/webhook': Endpoint<NoParams, NoQuery, Record<string, unknown>, { ok: true }>;
  // AI estimates
  'POST /api/estimates/fee': Endpoint<NoParams, NoQuery, FeeEstimateRequest, FeeEstimate>;
  'POST /api/estimates/shipping': Endpoint<NoParams, NoQuery, ShippingEstimateRequest, ShippingEstimate>;
  // ops (admin)
  'GET /api/ops/board': Endpoint<NoParams, { from?: string; to?: string; cityId?: CityId }, NoBody, BoardData>;
  'GET /api/ops/datasets/:name': Endpoint<{ name: OpsDatasetName }, NoQuery, NoBody, OpsDataset>;
  'GET /api/ops/records': Endpoint<NoParams, NoQuery, NoBody, OpsRecords>;
  'POST /api/ops/proofs/:proofId/review': Endpoint<{ proofId: ProofId }, NoQuery, ReviewProofRequest, { proof: Proof; job: Job | null }>;
  'POST /api/ops/jobs/:jobId/refund': Endpoint<{ jobId: JobId }, NoQuery, RefundRequest, JobMoneyResult>;
  'POST /api/ops/holds/:holdId/reauthorize': Endpoint<{ holdId: HoldId }, NoQuery, NoBody, { hold: Hold; ledger: LedgerEntry[] }>;
  'POST /api/ops/sweep': Endpoint<NoParams, NoQuery, NoBody, SweepResult>;
  'GET /api/ops/disputes': Endpoint<NoParams, NoQuery, NoBody, { disputes: Dispute[] }>;
  'POST /api/ops/disputes/:disputeId/evidence': Endpoint<{ disputeId: DisputeId }, NoQuery, DisputeEvidenceRequest, { dispute: Dispute }>;
  'POST /api/ops/disputes/:disputeId/accept': Endpoint<{ disputeId: DisputeId }, NoQuery, { note: string }, { dispute: Dispute }>;
  'POST /api/ops/disputes/:disputeId/adjudicate': Endpoint<
    { disputeId: DisputeId },
    NoQuery,
    { outcome: 'buyer_favor' | 'seller_favor' },
    { dispute: Dispute }
  >;
  'POST /api/ops/agents/turn': Endpoint<NoParams, NoQuery, OpsAgentTurnRequest, OpsAgentTurnResponse>;
  'POST /api/ops/moves': Endpoint<NoParams, NoQuery, OpsMovesRequest, OpsMovesResult>;
  // fake PayPal (fake mode only)
  'POST /api/fake/paypal/orders/:orderId/approve': Endpoint<{ orderId: string }, NoQuery, FakeApproveRequest, { orderId: string; status: string }>;
  // demo (demo mode only)
  'GET /api/demo/scripts': Endpoint<NoParams, NoQuery, NoBody, { scripts: DemoScriptSummary[] }>;
  'GET /api/demo/state': Endpoint<NoParams, NoQuery, NoBody, DemoState>;
  'POST /api/demo/reset': Endpoint<NoParams, NoQuery, DemoResetRequest, DemoState>;
  'POST /api/demo/start': Endpoint<NoParams, NoQuery, DemoStartRequest, DemoState>;
  'POST /api/demo/pause': Endpoint<NoParams, NoQuery, NoBody, DemoState>;
  'POST /api/demo/resume': Endpoint<NoParams, NoQuery, NoBody, DemoState>;
  'POST /api/demo/step': Endpoint<NoParams, NoQuery, NoBody, DemoState>;
  'POST /api/demo/clock': Endpoint<NoParams, NoQuery, DemoClockRequest, ClockState>;
}

export type ApiKey = keyof ApiSpec;

/**
 * P0: the hero loop (bid, ask, check-in, proof, captures, payouts) in fake and sandbox modes.
 * P1: agent, ops board and datasets, reviews, refunds, sweeps, estimates.
 * P2: disputes and other extras.
 */
export type Phase = 'P0' | 'P1' | 'P2';

/**
 * public: anyone. persona: acts as the user in the X-HMS-User header (SSE: ?as=).
 * admin: ops console; open on a loopback host, X-HMS-Admin-Key otherwise.
 * paypal: called by PayPal. fake: fake mode only. demo: demo mode only.
 */
export type EndpointAuth = 'public' | 'persona' | 'admin' | 'paypal' | 'fake' | 'demo';

export interface EndpointMeta {
  phase: Phase;
  auth: EndpointAuth;
  summary: string;
  /** Accepts an Idempotency-Key header and replays the first response for the same key. */
  idempotent: boolean;
  sse?: true;
}

export const ENDPOINTS: Readonly<Record<ApiKey, EndpointMeta>> = {
  'GET /api/health': { phase: 'P0', auth: 'public', idempotent: false, summary: 'Liveness and mode.' },
  'GET /api/config': { phase: 'P0', auth: 'public', idempotent: false, summary: 'Mode, PayPal SDK settings, AI provider, clock and rules.' },
  'GET /api/clock': { phase: 'P0', auth: 'public', idempotent: false, summary: 'Market clock state.' },
  'GET /api/events': { phase: 'P0', auth: 'persona', idempotent: false, sse: true, summary: 'Server-sent events; resume with Last-Event-ID or ?since=.' },
  'GET /api/cities': { phase: 'P0', auth: 'public', idempotent: false, summary: 'Cities.' },
  'GET /api/shops': { phase: 'P0', auth: 'public', idempotent: false, summary: 'Shops with their items.' },
  'GET /api/shops/:shopId': { phase: 'P0', auth: 'public', idempotent: false, summary: 'One shop with its books.' },
  'GET /api/users': { phase: 'P0', auth: 'public', idempotent: false, summary: 'Demo personas (home positions omitted).' },
  'GET /api/me': { phase: 'P0', auth: 'persona', idempotent: false, summary: 'The acting persona.' },
  'GET /api/books': { phase: 'P0', auth: 'public', idempotent: false, summary: 'Book snapshots for the map.' },
  'GET /api/books/:shopId/:itemId': { phase: 'P0', auth: 'public', idempotent: false, summary: 'One book with public asks and recent matches.' },
  'POST /api/files': { phase: 'P0', auth: 'persona', idempotent: true, summary: 'Upload one photo as raw bytes.' },
  'GET /api/files/:fileId': { phase: 'P0', auth: 'persona', idempotent: false, summary: 'Download a photo (participants and ops).' },
  'POST /api/bids/quote': { phase: 'P0', auth: 'persona', idempotent: false, summary: 'Suggested caps, fee, shipping budget and hold amount.' },
  'POST /api/bids': { phase: 'P0', auth: 'persona', idempotent: true, summary: 'Create a bid and its PayPal order (intent AUTHORIZE).' },
  'POST /api/bids/:bidId/authorize': { phase: 'P0', auth: 'persona', idempotent: true, summary: 'Authorize the approved order; the bid joins the book.' },
  'POST /api/bids/:bidId/approval-failed': { phase: 'P0', auth: 'persona', idempotent: true, summary: 'The buyer closed or failed the PayPal approval.' },
  'GET /api/bids': { phase: 'P0', auth: 'persona', idempotent: false, summary: 'My bids.' },
  'GET /api/bids/:bidId': { phase: 'P0', auth: 'persona', idempotent: false, summary: 'Bid with hold, matches, jobs and ledger.' },
  'PATCH /api/bids/:bidId': { phase: 'P1', auth: 'persona', idempotent: true, summary: 'Change max fee, qty or deadline within the limit.' },
  'POST /api/bids/:bidId/cancel': { phase: 'P0', auth: 'persona', idempotent: true, summary: 'Cancel the unmatched remainder.' },
  'POST /api/bids/:bidId/claim': { phase: 'P0', auth: 'persona', idempotent: true, summary: 'A queuer takes this bid at its max fee.' },
  'GET /api/bids/:bidId/agent-actions': { phase: 'P1', auth: 'persona', idempotent: false, summary: 'Bidding agent log.' },
  'POST /api/bids/:bidId/agent': { phase: 'P1', auth: 'persona', idempotent: true, summary: 'Pause or resume the bidding agent.' },
  'POST /api/asks': { phase: 'P0', auth: 'persona', idempotent: true, summary: 'Post an ask (creates its claim).' },
  'GET /api/asks': { phase: 'P0', auth: 'persona', idempotent: false, summary: 'Asks (mine, or public by shop).' },
  'POST /api/asks/:askId/withdraw': { phase: 'P0', auth: 'persona', idempotent: true, summary: 'Withdraw the remaining capacity.' },
  'GET /api/claims/:claimId': { phase: 'P0', auth: 'persona', idempotent: false, summary: 'Claim with its ask and jobs.' },
  'POST /api/claims/:claimId/check-in': { phase: 'P0', auth: 'persona', idempotent: true, summary: 'Geofence plus line photo with the one-time code.' },
  'POST /api/claims/:claimId/done': { phase: 'P1', auth: 'persona', idempotent: true, summary: 'End the visit; close remaining capacity.' },
  'GET /api/jobs': { phase: 'P0', auth: 'persona', idempotent: false, summary: 'My jobs as requester or queuer.' },
  'GET /api/jobs/:jobId': { phase: 'P0', auth: 'persona', idempotent: false, summary: 'Job with proofs, ledger and payouts.' },
  'POST /api/jobs/:jobId/bought': { phase: 'P0', auth: 'persona', idempotent: true, summary: 'Queuer marks the purchase done.' },
  'POST /api/jobs/:jobId/sold-out': { phase: 'P1', auth: 'persona', idempotent: true, summary: 'Queuer reports the item sold out.' },
  'POST /api/jobs/:jobId/proof': { phase: 'P0', auth: 'persona', idempotent: true, summary: 'Submit receipt and item photos for verification.' },
  'POST /api/jobs/:jobId/shipment': { phase: 'P0', auth: 'persona', idempotent: true, summary: 'Add tracking; final shipping capture.' },
  'POST /api/jobs/:jobId/handover': { phase: 'P0', auth: 'persona', idempotent: true, summary: 'Local handover with the requester code; capture.' },
  'POST /api/jobs/:jobId/delivered': { phase: 'P1', auth: 'admin', idempotent: true, summary: 'Mark a shipped job delivered (carrier stand-in).' },
  'GET /api/holds/:holdId': { phase: 'P0', auth: 'persona', idempotent: false, summary: 'One hold.' },
  'GET /api/ledger': { phase: 'P0', auth: 'persona', idempotent: false, summary: 'Ledger entries, newest first.' },
  'GET /api/payouts': { phase: 'P0', auth: 'persona', idempotent: false, summary: 'Payouts, newest first.' },
  'POST /api/paypal/webhook': { phase: 'P1', auth: 'paypal', idempotent: true, summary: 'PayPal webhook; signature verified.' },
  'POST /api/estimates/fee': { phase: 'P1', auth: 'persona', idempotent: false, summary: 'Wait and fee estimate for a shop item.' },
  'POST /api/estimates/shipping': { phase: 'P1', auth: 'persona', idempotent: false, summary: 'Parcel, shipping and duty estimate.' },
  'GET /api/ops/board': { phase: 'P1', auth: 'admin', idempotent: false, summary: 'Bryntum queuer board data.' },
  'GET /api/ops/datasets/:name': { phase: 'P1', auth: 'admin', idempotent: false, summary: 'Flat rows for the AG Studio dashboard.' },
  'GET /api/ops/records': { phase: 'P1', auth: 'admin', idempotent: false, summary: 'Every market record for the operator console in one read.' },
  'POST /api/ops/proofs/:proofId/review': { phase: 'P1', auth: 'admin', idempotent: true, summary: 'Decide a proof that needs review.' },
  'POST /api/ops/jobs/:jobId/refund': { phase: 'P1', auth: 'admin', idempotent: true, summary: 'Refund part or all of a job.' },
  'POST /api/ops/holds/:holdId/reauthorize': { phase: 'P1', auth: 'admin', idempotent: true, summary: 'Reauthorize now (day 4 to 29 only).' },
  'POST /api/ops/sweep': { phase: 'P1', auth: 'admin', idempotent: false, summary: 'Run renewal, lapse and expiry sweeps now.' },
  'GET /api/ops/disputes': { phase: 'P2', auth: 'admin', idempotent: false, summary: 'Disputes on our captures.' },
  'POST /api/ops/disputes/:disputeId/evidence': { phase: 'P2', auth: 'admin', idempotent: true, summary: 'Send proof photos, receipt fields and tracking.' },
  'POST /api/ops/disputes/:disputeId/accept': { phase: 'P2', auth: 'admin', idempotent: true, summary: 'Accept the claim.' },
  'POST /api/ops/disputes/:disputeId/adjudicate': { phase: 'P2', auth: 'admin', idempotent: true, summary: 'Sandbox only: settle a dispute.' },
  'POST /api/ops/agents/turn': { phase: 'P1', auth: 'admin', idempotent: false, summary: "One model turn for an ops console agent; 503 AI_UNAVAILABLE without a live model." },
  'POST /api/ops/moves': { phase: 'P1', auth: 'admin', idempotent: true, summary: 'Apply rescheduling moves (reassign, shift a window, release), each checked with the market rules.' },
  'POST /api/fake/paypal/orders/:orderId/approve': { phase: 'P0', auth: 'fake', idempotent: true, summary: 'Fake mode: simulate the buyer approving.' },
  'GET /api/demo/scripts': { phase: 'P1', auth: 'demo', idempotent: false, summary: 'Demo scripts.' },
  'GET /api/demo/state': { phase: 'P1', auth: 'demo', idempotent: false, summary: 'Demo director state.' },
  'POST /api/demo/reset': { phase: 'P1', auth: 'demo', idempotent: false, summary: 'Reseed the database.' },
  'POST /api/demo/start': { phase: 'P1', auth: 'demo', idempotent: false, summary: 'Start a script.' },
  'POST /api/demo/pause': { phase: 'P1', auth: 'demo', idempotent: false, summary: 'Pause the script and the clock.' },
  'POST /api/demo/resume': { phase: 'P1', auth: 'demo', idempotent: false, summary: 'Resume.' },
  'POST /api/demo/step': { phase: 'P1', auth: 'demo', idempotent: false, summary: 'Run the next step now.' },
  'POST /api/demo/clock': { phase: 'P1', auth: 'demo', idempotent: false, summary: 'Set speed, pause, or jump forward.' },
};

/** Headers the API uses. */
export const HEADERS = {
  persona: 'X-HMS-User',
  admin: 'X-HMS-Admin-Key',
  idempotency: 'Idempotency-Key',
  lastEventId: 'Last-Event-ID',
} as const;

/** Splits an endpoint key into its method and path template. */
export function endpointParts(key: ApiKey): { method: 'GET' | 'POST' | 'PATCH'; path: string } {
  const space = key.indexOf(' ');
  return { method: key.slice(0, space) as 'GET' | 'POST' | 'PATCH', path: key.slice(space + 1) };
}

/** Fills the :params of an endpoint path, URL-encoding each value. */
export function apiPath<K extends ApiKey>(key: K, params: ApiSpec[K]['params']): string {
  const { path } = endpointParts(key);
  const values = params as Record<string, string>;
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new ContractError('BAD_REQUEST', `Missing path parameter ${name} for ${key}.`);
    return encodeURIComponent(value);
  });
}
