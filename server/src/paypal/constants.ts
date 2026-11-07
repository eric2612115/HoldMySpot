/**
 * Fixed values for the PayPal adapters. HoldMySpot only ever talks to the
 * PayPal sandbox; the adapters refuse any other REST host.
 */

/** PayPal's sandbox REST host. */
export const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';

/** PayPal's sandbox website (buyer approval pages and dispute pages). */
export const SANDBOX_WEB_URL = 'https://www.sandbox.paypal.com';

/** JS SDK v6 core script for the sandbox (GET /api/config hands it to the web app). */
export const SANDBOX_SDK_URL = 'https://www.sandbox.paypal.com/web-sdk/v6/core';

/** Every PayPal object HoldMySpot creates carries this invoice-id prefix; sync ignores anything without it. */
export const INVOICE_PREFIX = 'HMS-';

/** Shown on PayPal's approval page. */
export const BRAND_NAME = 'HoldMySpot';

export const DEFAULT_TIMEOUT_MS = 10_000;

/** PayPal field limits checked before a call, so a bad value fails here with a clear message. */
export const LIMITS = {
  softDescriptor: 22,
  description: 127,
  itemName: 127,
  invoiceId: 127,
  customId: 127,
  referenceId: 256,
  noteToPayer: 255,
  requestId: 108,
  senderBatchId: 256,
  senderItemId: 63,
  emailSubject: 255,
  emailMessage: 1000,
  payoutNote: 4000,
  trackingNumber: 64,
  carrierName: 64,
  disputeNote: 2000,
} as const;

/** Evidence files PayPal accepts for disputes, and its size limit per file. */
export const EVIDENCE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'];
export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Token scopes the hold life cycle needs (gate G11). Matched as substrings of
 * the scope URLs in PayPal's OAuth response.
 */
export const SCOPE_CHECKS: readonly { feature: string; pattern: RegExp; dashboard: string }[] = [
  { feature: 'authorize and capture', pattern: /payments\/payment\/authcapture/, dashboard: 'Accept payments' },
  { feature: 'refunds', pattern: /payments\/refund/, dashboard: 'Accept payments' },
  { feature: 'payouts', pattern: /payments\/payouts/, dashboard: 'Payouts' },
  { feature: 'disputes', pattern: /disputes\/(read|update)-seller/, dashboard: 'Customer disputes' },
  { feature: 'shipment tracking', pattern: /shipping\/trackers/, dashboard: 'Shipment tracking (if listed)' },
];
