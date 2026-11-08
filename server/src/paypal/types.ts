import type { Cents, FundingSource } from '@holdmyspot/shared';
import type {
  AuthorizationResult,
  AuthorizationStatus,
  CaptureResult,
  CreateOrderInput,
  DisputeResult,
  OrderResult,
  PayPalPort,
  PayoutItemStatus,
} from '@holdmyspot/shared/ports';

/**
 * Types the PayPal module adds on top of PayPalPort (shared/src/ports.ts).
 * Both adapters in this folder implement HmsPayPal, which is PayPalPort plus
 * the reads the probe script and the status poller need.
 */

/**
 * Sandbox credentials and accounts. Same shape as the server's PayPalSettings
 * (server/src/config.ts). `clientSecret` stays in memory and is never logged.
 */
export interface SandboxSettings {
  env: 'sandbox';
  clientId: string;
  clientSecret: string;
  merchantEmail: string;
  merchantId: string;
  buyerEmail: string;
  payoutReceiverEmail: string;
  webhookId: string | null;
}

/** createOrder result plus the approval link (used by the probe script's redirect flow). */
export interface OrderSummary extends OrderResult {
  /** PayPal's `payer-action` or `approve` link. The JS SDK flow does not need it. */
  approveUrl: string | null;
}

export interface OrderAuthorizationLine {
  authorizationId: string;
  status: AuthorizationStatus;
  amountCents: Cents;
  createdAt: number | null;
  expiresAt: number | null;
}

export interface OrderCaptureLine {
  captureId: string;
  status: CaptureResult['status'];
  amountCents: Cents;
  finalCapture: boolean | null;
}

export interface OrderTracker {
  trackingNumber: string;
  carrierName: string | null;
  captureId: string | null;
  status: string | null;
}

/** GET /v2/checkout/orders/{id}, mapped. */
export interface OrderDetails {
  orderId: string;
  status: OrderResult['status'];
  intent: string | null;
  invoiceId: string | null;
  customId: string | null;
  amountCents: Cents | null;
  approveUrl: string | null;
  fundingSource: FundingSource | null;
  shipTo: AuthorizationResult['shipTo'];
  authorizations: OrderAuthorizationLine[];
  captures: OrderCaptureLine[];
  trackers: OrderTracker[];
  debugId: string | null;
}

/** GET /v1/payments/payouts-item/{id}, mapped. */
export interface PayoutItemResult {
  itemId: string;
  batchId: string | null;
  senderItemId: string;
  status: PayoutItemStatus;
  amountCents: Cents;
  receiver: string | null;
  transactionId: string | null;
  /** PayPal's error name for an item that did not go through, for example RECEIVER_UNREGISTERED. */
  errorName: string | null;
  debugId: string | null;
}

/** provideEvidence input: PayPalPort's shape plus an optional evidence type and tracking. */
export interface EvidenceInput {
  note: string;
  files: { name: string; contentType: string; bytes: Uint8Array }[];
  /** PayPal evidence_type. Default: PROOF_OF_FULFILLMENT with tracking, else OTHER. */
  evidenceType?: string;
  tracking?: { carrierName: string; trackingNumber: string } | null;
}

/** PayPalPort plus reads used by the probe script and the poller. */
export interface HmsPayPal extends PayPalPort {
  createOrder(input: CreateOrderInput): Promise<OrderSummary>;
  getOrder(orderId: string): Promise<OrderDetails>;
  getPayoutItem(itemId: string): Promise<PayoutItemResult>;
  provideEvidence(disputeId: string, input: EvidenceInput): Promise<DisputeResult>;
  /** Moves a dispute in the inquiry stage to a claim (needed before the sandbox-only adjudicate). */
  escalateDispute(disputeId: string, note: string): Promise<DisputeResult>;
  /** Scope URLs of the current OAuth token. Never the token itself. */
  tokenScopes(): Promise<string[]>;
}

/** One PayPal response, handed to an optional recorder (the probe script saves sanitized copies as fixtures). */
export interface RecordedResponse {
  op: string;
  method: string;
  path: string;
  status: number;
  debugId: string | null;
  body: unknown;
}
