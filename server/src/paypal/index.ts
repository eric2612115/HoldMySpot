/**
 * PayPal for HoldMySpot (docs/PAYPAL-MAPPING.md).
 *
 * Sandbox (loaded by server/src/ports/load.ts):
 *   const port = createSandboxPayPal({ settings: config.paypal, baseUrl: 'https://api-m.sandbox.paypal.com',
 *                                       timeoutMs: config.paypalTimeoutMs, log: (line) => app.log.info(line) });
 *
 * Fake (offline tests, the probe script's --fake mode, optionally the server's fake mode):
 *   const fake = createFakePayPal({ now: () => clock.now(), failures: config.fakeFail });
 *   await fake.approveOrder(orderId, 'paypal', 'approve');
 *
 * Both implement PayPalPort (plus getOrder, getPayoutItem, escalateDispute,
 * tokenScopes). Failures throw PayPalError: a ContractError whose `code` is
 * one of PAYPAL_DECLINED, PAYPAL_ERROR, PAYPAL_UNAVAILABLE, HOLD_EXPIRED,
 * HOLD_CLOSED, OVER_CAPTURE, with `failure` (PayPalFailure), PayPal's
 * debug id, `retryable` and `restartCheckout` (the buyer must approve again).
 */

export { PayPalRestClient, OPS } from './client.ts';
export { BRAND_NAME, INVOICE_PREFIX, SANDBOX_BASE_URL, SANDBOX_SDK_URL, SANDBOX_WEB_URL, SCOPE_CHECKS } from './constants.ts';
export { loadSandboxEnvFile, maskId, parseDotenv, secretsDir, type SandboxEnvLoad } from './credentials.ts';
export {
  captureFeeCents,
  DEFAULT_SHIP_TO,
  FAKE_CLIENT_ID,
  FAKE_SCOPES,
  PayPalEmulator,
  paypalTime,
  parseFailures,
  PAYOUT_ITEM_FEE_CENTS,
  SANDBOX_LINK_HOST,
  type EmShipTo,
  type EmulatorOptions,
  type EmulatorState,
  type FailRule,
} from './emulator.ts';
export { isDuplicatePayout, needsNewApproval, parsePayPalErrorBody, PayPalError, RESTART_CHECKOUT_ISSUES, toPayPalError } from './errors.ts';
export { createFakePayPal, FakePayPal, type FakePayPalOptions } from './fake.ts';
export { DEFAULT_RETRY, PayPalHttp, type HttpRetryPolicy, type PayPalHttpOptions } from './http.ts';
export { assertSandboxBaseUrl, createSandboxPayPal, SandboxPayPal, sandboxPayPalFactory, type CreateSandboxOptions, type SandboxExtras } from './sandbox.ts';
export { disputeFromPayPal, holdFromAuthorization, isFinalPayoutItem, ledgerFromCapture, parseInvoiceId, payoutFromItem, type HmsReference } from './status.ts';
export type { EvidenceInput, HmsPayPal, OrderDetails, OrderSummary, PayoutItemResult, RecordedResponse, SandboxSettings } from './types.ts';
export { summarizeWebhookEvent, verifyWebhookEvent, type WebhookEventSummary } from './webhook.ts';
