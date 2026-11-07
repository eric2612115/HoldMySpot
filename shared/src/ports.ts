import type {
  AiMode,
  AiProviderId,
  AiStamp,
  ApiErrorCode,
  Cents,
  CheckoutFunding,
  FundingSource,
  RuntimeMode,
} from './contract.ts';

/**
 * Server-side ports: the boundaries the server talks through. The web and
 * ops apps never import this file. Each port has a fake implementation (no
 * network, same rules) and a real one. docs/PAYPAL-MAPPING.md and
 * docs/AI-SERVICES.md describe what each call maps to.
 */

// ---------------------------------------------------------------------------
// PayPal
// ---------------------------------------------------------------------------

/** Every money call carries one of these; it becomes PayPal-Request-Id (or sender_batch_id). */
export interface Idempotent {
  requestId: string;
}

export interface CreateOrderInput extends Idempotent {
  /** "HMS-<bidId>". Every PayPal object we create carries the HMS- prefix. */
  invoiceId: string;
  /** Our bid id. */
  customId: string;
  description: string;
  /** Up to 22 characters, shown on the buyer's statement. */
  softDescriptor: string;
  amountCents: Cents;
  breakdown: { itemTotalCents: Cents; shippingCents: Cents };
  /** The item line uses PHYSICAL_GOODS; the queue-fee line leaves the category out (it is a service). */
  items: { name: string; quantity: number; unitAmountCents: Cents; category: 'PHYSICAL_GOODS' | null }[];
  /** ship: SHIPPING with the buyer's PayPal address. local: PICKUP_FROM_PERSON. */
  shipping: { type: 'SHIPPING' | 'PICKUP_FROM_PERSON'; preference: 'GET_FROM_FILE' | 'NO_SHIPPING' };
  funding: CheckoutFunding;
  /** Where PayPal returns a redirect flow (unused by the v6 popup flow, required by some sources). */
  returnUrl: string;
  cancelUrl: string;
}

export interface OrderResult {
  orderId: string;
  status: 'CREATED' | 'APPROVED' | 'COMPLETED' | 'VOIDED' | 'PAYER_ACTION_REQUIRED' | 'SAVED';
  debugId: string | null;
}

export type AuthorizationStatus = 'CREATED' | 'CAPTURED' | 'PARTIALLY_CAPTURED' | 'VOIDED' | 'DENIED' | 'PENDING' | 'EXPIRED';

export interface AuthorizationResult {
  authorizationId: string;
  orderId: string;
  status: AuthorizationStatus;
  amountCents: Cents;
  /** Epoch ms (real time in sandbox, market time in the fake). */
  createdAt: number;
  expiresAt: number | null;
  fundingSource: FundingSource;
  /** From the order's shipping address, when one was provided (ship mode). */
  shipTo: { country: string; region: string | null; city: string | null; postalCode: string | null } | null;
  debugId: string | null;
}

export interface CaptureInput extends Idempotent {
  amountCents: Cents;
  finalCapture: boolean;
  /** "HMS-<jobId>-R" (receipt), "HMS-<jobId>-S" (shipping) or "HMS-<jobId>-H" (handover). */
  invoiceId: string;
  noteToPayer: string;
  softDescriptor: string;
}

export interface CaptureResult {
  captureId: string;
  authorizationId: string;
  status: 'COMPLETED' | 'PENDING' | 'DECLINED' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';
  amountCents: Cents;
  finalCapture: boolean;
  /** PayPal's processing fee from seller_receivable_breakdown, when reported. Recorded on the ledger and checked against PAYPAL_PRICING (D-105). */
  paypalFeeCents: Cents | null;
  createdAt: number;
  debugId: string | null;
}

export interface RefundInput extends Idempotent {
  amountCents: Cents;
  invoiceId: string;
  noteToPayer: string;
}

export interface RefundResult {
  refundId: string;
  captureId: string;
  status: 'COMPLETED' | 'PENDING' | 'CANCELLED' | 'FAILED';
  amountCents: Cents;
  debugId: string | null;
}

export interface TrackingInput extends Idempotent {
  captureId: string;
  trackingNumber: string;
  /** Fictional carrier: sent as carrier OTHER with carrier_name_other. */
  carrierName: string;
  notifyPayer: boolean;
}

export interface PayoutItemInput {
  receiverEmail: string;
  amountCents: Cents;
  note: string;
  /** Our payout id. */
  senderItemId: string;
}

export interface PayoutInput {
  /** Our idempotency key; PayPal rejects a repeated sender_batch_id. */
  senderBatchId: string;
  emailSubject: string;
  emailMessage: string;
  items: PayoutItemInput[];
}

export type PayoutItemStatus =
  | 'SUCCESS'
  | 'UNCLAIMED'
  | 'PENDING'
  | 'FAILED'
  | 'RETURNED'
  | 'ONHOLD'
  | 'BLOCKED'
  | 'REFUNDED'
  | 'REVERSED'
  | 'DENIED'
  | 'CANCELED'
  | 'NEW';

export interface PayoutBatchResult {
  batchId: string;
  batchStatus: 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'DENIED' | 'CANCELED';
  /** `feeCents`: PayPal's payout_item_fee, once PayPal reports it (after the item is processed). */
  items: { itemId: string | null; senderItemId: string; status: PayoutItemStatus; amountCents: Cents; feeCents?: Cents | null }[];
  debugId: string | null;
}

export interface DisputeResult {
  disputeId: string;
  /** Capture ids found in disputed_transactions; we only keep disputes on our HMS- invoices. */
  captureIds: string[];
  invoiceIds: string[];
  reason: string;
  status: 'OPEN' | 'WAITING_FOR_BUYER_RESPONSE' | 'WAITING_FOR_SELLER_RESPONSE' | 'UNDER_REVIEW' | 'RESOLVED' | 'OTHER';
  outcome: 'RESOLVED_BUYER_FAVOUR' | 'RESOLVED_SELLER_FAVOUR' | 'RESOLVED_WITH_PAYOUT' | 'CANCELED_BY_BUYER' | 'ACCEPTED' | 'DENIED' | null;
  amountCents: Cents;
  createdAt: number;
  updatedAt: number;
}

/** A failed PayPal call, mapped to our error codes. Never contains credentials. */
export interface PayPalFailure {
  code: Extract<ApiErrorCode, 'PAYPAL_DECLINED' | 'PAYPAL_ERROR' | 'PAYPAL_UNAVAILABLE' | 'HOLD_EXPIRED' | 'HOLD_CLOSED' | 'OVER_CAPTURE'>;
  /** PayPal's error `name`, for example UNPROCESSABLE_ENTITY. */
  paypalName: string | null;
  /** First `details[].issue`, for example AUTHORIZATION_EXPIRED or MAX_CAPTURE_AMOUNT_EXCEEDED. */
  issue: string | null;
  httpStatus: number | null;
  debugId: string | null;
  /** Safe to retry with the same request id. */
  retryable: boolean;
}

export interface PayPalPort {
  readonly mode: RuntimeMode;
  createOrder(input: CreateOrderInput): Promise<OrderResult>;
  /** POST /v2/checkout/orders/{id}/authorize after the buyer approved. */
  authorizeOrder(orderId: string, requestId: string): Promise<AuthorizationResult>;
  getAuthorization(authorizationId: string): Promise<AuthorizationResult>;
  captureAuthorization(authorizationId: string, input: CaptureInput): Promise<CaptureResult>;
  /** Releases what is left, also after partial captures. */
  voidAuthorization(authorizationId: string, requestId: string): Promise<AuthorizationResult>;
  /** Day 4 to 29 only. Returns the NEW authorization. Never asks for more than the original. */
  reauthorize(authorizationId: string, input: Idempotent & { amountCents: Cents }): Promise<AuthorizationResult>;
  getCapture(captureId: string): Promise<CaptureResult>;
  refundCapture(captureId: string, input: RefundInput): Promise<RefundResult>;
  /** POST /v2/checkout/orders/{id}/track. */
  addTracking(orderId: string, input: TrackingInput): Promise<void>;
  createPayout(input: PayoutInput): Promise<PayoutBatchResult>;
  getPayoutBatch(batchId: string): Promise<PayoutBatchResult>;
  cancelUnclaimedPayoutItem(itemId: string): Promise<PayoutBatchResult['items'][number]>;
  listDisputes(sinceMs: number): Promise<DisputeResult[]>;
  getDispute(disputeId: string): Promise<DisputeResult>;
  provideEvidence(disputeId: string, input: { note: string; files: { name: string; contentType: string; bytes: Uint8Array }[] }): Promise<DisputeResult>;
  acceptClaim(disputeId: string, note: string): Promise<DisputeResult>;
  /** Sandbox only. */
  adjudicate(disputeId: string, outcome: 'BUYER_FAVOR' | 'SELLER_FAVOR'): Promise<DisputeResult>;
  /** POST /v1/notifications/verify-webhook-signature. False when no webhook id is configured. */
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export type AiTask =
  | 'check_in_photo'
  | 'purchase_proof'
  | 'fee_estimate'
  | 'shipping_estimate'
  | 'bidding_agent'
  | 'reassign_note'
  // Ops console agents (D-100): live turns only, never recorded or replayed.
  | 'ops_agent';

export interface AiImage {
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  base64: string;
}

export interface AiJsonRequest {
  task: AiTask;
  system: string;
  prompt: string;
  images: AiImage[];
  /** JSON Schema of the output; providers must return data valid against it. */
  schemaName: string;
  schema: Record<string, unknown>;
  effort: 'low' | 'medium' | 'high';
  /** Key for record/replay fixtures: a hash of the task, prompt, image hashes and schema. */
  fixtureKey: string;
}

export interface AiJsonResult<T> {
  data: T;
  stamp: AiStamp;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface AiTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Runs inside our server with the agent's mandate checks; returns JSON-serialisable output. */
  run(input: unknown): Promise<unknown>;
}

export interface AiAgentRequest {
  task: 'bidding_agent';
  system: string;
  prompt: string;
  tools: AiTool[];
  /** Hard stop on tool-use rounds. */
  maxSteps: number;
  fixtureKey: string;
}

export interface AiAgentResult {
  /** The agent's final one-sentence explanation. */
  summary: string;
  toolCalls: { name: string; input: unknown; output: unknown }[];
  stamp: AiStamp;
}

export interface AiProvider {
  readonly id: AiProviderId;
  readonly model: string;
  readonly mode: AiMode;
  readonly vision: boolean;
  json<T>(req: AiJsonRequest): Promise<AiJsonResult<T>>;
  agent(req: AiAgentRequest): Promise<AiAgentResult>;
}

/** What the server logs at boot: names and presence only, never values. */
export interface AiKeyReport {
  anthropicKeyPresent: boolean;
  museKeyPresent: boolean;
  /** Where the keys were looked for (file paths and "process env"). */
  searched: string[];
  chosen: AiProviderId;
  reason: string;
}
