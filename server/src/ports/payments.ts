import type { ApiErrorCode, CheckoutFunding } from '@holdmyspot/shared';
import type { PayPalFailure, PayPalPort } from '@holdmyspot/shared/ports';
import type { PayPalSettings } from '../config.ts';

/**
 * PaymentsPort: the boundary every money call goes through. It is exactly
 * PayPalPort from shared/src/ports.ts (Orders v2 AUTHORIZE, captures, voids,
 * reauthorize, refunds, tracking, Payouts, disputes). Two adapters plug in:
 *
 * - fake: server/src/fakes/paypal.ts, in process, PayPal's rules on the
 *   market clock (used in fake mode, by tests, and for seeded crowd bids);
 * - sandbox: server/src/paypal/sandbox.ts (built separately), loaded by
 *   server/src/ports/load.ts. It must export
 *   `createSandboxPayPal(options: SandboxPayPalOptions): PayPalPort`
 *   and throw `PayPalCallError` (or any error with a `failure: PayPalFailure`).
 *
 * The server never calls PayPal outside this port, and every call carries a
 * deterministic request id from the ledger (the ledger is the outbox).
 */
export type PaymentsPort = PayPalPort;

/** Fake mode only: the simulated buyer approval behind POST /api/fake/paypal/orders/:orderId/approve. */
export interface FakePaymentsControls {
  approveOrder(orderId: string, funding: CheckoutFunding, outcome: 'approve' | 'cancel' | 'decline'): Promise<{ orderId: string; status: string }>;
}

export interface SandboxPayPalOptions {
  settings: PayPalSettings;
  /** Always https://api-m.sandbox.paypal.com; the adapter must refuse anything else. */
  baseUrl: 'https://api-m.sandbox.paypal.com';
  timeoutMs: number;
  /** Logs one line; never pass credentials or tokens. */
  log: (line: string) => void;
}

export type SandboxPayPalFactory = (options: SandboxPayPalOptions) => PaymentsPort;

/** The error adapters throw. Carries PayPal's debug id, never credentials. */
export class PayPalCallError extends Error {
  readonly failure: PayPalFailure;

  constructor(message: string, failure: PayPalFailure) {
    super(message);
    this.name = 'PayPalCallError';
    this.failure = failure;
  }
}

const FAILURE_CODES: readonly PayPalFailure['code'][] = ['PAYPAL_DECLINED', 'PAYPAL_ERROR', 'PAYPAL_UNAVAILABLE', 'HOLD_EXPIRED', 'HOLD_CLOSED', 'OVER_CAPTURE'];

function isFailure(x: unknown): x is PayPalFailure {
  return typeof x === 'object' && x !== null && FAILURE_CODES.includes((x as { code?: unknown }).code as PayPalFailure['code']);
}

/** Maps anything an adapter throws to a PayPalFailure. */
export function toPayPalFailure(err: unknown): PayPalFailure {
  if (typeof err === 'object' && err !== null) {
    const f = (err as { failure?: unknown }).failure;
    if (isFailure(f)) return f;
    if (isFailure(err)) return err;
  }
  return { code: 'PAYPAL_UNAVAILABLE', paypalName: null, issue: null, httpStatus: null, debugId: null, retryable: true };
}

/** A plain sentence for a failure, safe to show and log. */
export function describeFailure(f: PayPalFailure): string {
  const what = f.issue ?? f.paypalName ?? 'no detail';
  return `PayPal call failed (${f.code}: ${what}${f.debugId ? `, debug id ${f.debugId}` : ''}).`;
}

export function failureCode(f: PayPalFailure): ApiErrorCode {
  return f.code;
}
