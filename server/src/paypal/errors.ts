import { ContractError } from '@holdmyspot/shared';
import type { PayPalFailure } from '@holdmyspot/shared/ports';

/**
 * PayPal failures, mapped to our error codes (docs/PAYPAL-MAPPING.md section 8).
 *
 * PayPalError extends ContractError, so the server's error handler can map
 * `code` to an HTTP status, and carries `failure` (a PayPalFailure), which is
 * what server/src/ports/payments.ts `toPayPalFailure` reads. Messages contain
 * PayPal's error name, issue, HTTP status and debug id; never credentials,
 * tokens or request bodies.
 */

export type PayPalFailureCode = PayPalFailure['code'];

/** The buyer must approve again (restart the JS SDK session so they can pick another way to pay). */
export const RESTART_CHECKOUT_ISSUES: ReadonlySet<string> = new Set([
  'INSTRUMENT_DECLINED',
  'PAYER_ACTION_REQUIRED',
  'REDIRECT_PAYER_FOR_ALTERNATE_FUNDING',
  'ORDER_NOT_APPROVED',
]);

const DECLINED_ISSUES: ReadonlySet<string> = new Set([
  ...RESTART_CHECKOUT_ISSUES,
  'TRANSACTION_REFUSED',
  'PAYER_CANNOT_PAY',
  'PAYER_ACCOUNT_RESTRICTED',
  'PAYER_ACCOUNT_LOCKED_OR_CLOSED',
  'MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED',
  'COMPLIANCE_VIOLATION',
  'CARD_EXPIRED',
  'CARD_CLOSED',
]);

const EXPIRED_ISSUES: ReadonlySet<string> = new Set(['AUTHORIZATION_EXPIRED', 'ORDER_EXPIRED']);

const CLOSED_ISSUES: ReadonlySet<string> = new Set([
  'AUTHORIZATION_VOIDED',
  'AUTHORIZATION_ALREADY_CAPTURED',
  'PREVIOUSLY_CAPTURED',
  'PREVIOUSLY_VOIDED',
  'ORDER_ALREADY_CAPTURED',
  'ORDER_ALREADY_COMPLETED',
  'ORDER_COMPLETED_OR_VOIDED',
  'CANNOT_BE_VOIDED',
]);

const OVER_ISSUES: ReadonlySet<string> = new Set(['MAX_CAPTURE_AMOUNT_EXCEEDED']);

export interface PayPalErrorInit {
  code: PayPalFailureCode;
  op: string;
  message: string;
  paypalName: string | null;
  issue: string | null;
  description: string | null;
  httpStatus: number | null;
  debugId: string | null;
  retryable: boolean;
  restartCheckout: boolean;
}

export class PayPalError extends ContractError {
  /** Read by server/src/ports/payments.ts `toPayPalFailure`. */
  readonly failure: PayPalFailure;
  /** Our name for the call, for example `authorizations.capture`. */
  readonly op: string;
  readonly paypalName: string | null;
  readonly issue: string | null;
  readonly description: string | null;
  readonly httpStatus: number | null;
  readonly debugId: string | null;
  /** Safe to retry with the same PayPal-Request-Id. */
  readonly retryable: boolean;
  /** The buyer has to approve again (INSTRUMENT_DECLINED and friends on an order call). */
  readonly restartCheckout: boolean;

  constructor(init: PayPalErrorInit) {
    super(init.code, init.message, {
      op: init.op,
      paypalName: init.paypalName,
      issue: init.issue,
      httpStatus: init.httpStatus,
      debugId: init.debugId,
      retryable: init.retryable,
      restartCheckout: init.restartCheckout,
    });
    this.name = 'PayPalError';
    this.op = init.op;
    this.paypalName = init.paypalName;
    this.issue = init.issue;
    this.description = init.description;
    this.httpStatus = init.httpStatus;
    this.debugId = init.debugId;
    this.retryable = init.retryable;
    this.restartCheckout = init.restartCheckout;
    this.failure = {
      code: init.code,
      paypalName: init.paypalName,
      issue: init.issue,
      httpStatus: init.httpStatus,
      debugId: init.debugId,
      retryable: init.retryable,
    };
  }
}

export interface ParsedErrorBody {
  name: string | null;
  message: string | null;
  issue: string | null;
  description: string | null;
  debugId: string | null;
}

const asText = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Reads PayPal's error body (REST `{name, details[], debug_id}` or OAuth `{error, error_description}`). */
export function parsePayPalErrorBody(body: unknown): ParsedErrorBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { name: null, message: null, issue: null, description: null, debugId: null };
  }
  const b = body as Record<string, unknown>;
  const details = Array.isArray(b.details) ? b.details : [];
  const first = details.find((d): d is Record<string, unknown> => typeof d === 'object' && d !== null);
  return {
    name: asText(b.name) ?? asText(b.error),
    message: asText(b.message) ?? asText(b.error_description),
    issue: first ? asText(first.issue) : null,
    description: first ? asText(first.description) : null,
    debugId: asText(b.debug_id),
  };
}

export interface ErrorContext {
  op: string;
  method: string;
  path: string;
  requestId: string | null;
  /** Null when no HTTP response arrived (timeout or network error). */
  status: number | null;
  body: unknown;
  debugIdHeader: string | null;
  transport?: 'TIMEOUT' | 'NETWORK_ERROR';
}

/** Maps one failed PayPal call to a PayPalError. */
export function toPayPalError(ctx: ErrorContext): PayPalError {
  const p = parsePayPalErrorBody(ctx.body);
  const debugId = ctx.debugIdHeader ?? p.debugId;
  const replayable = ctx.method === 'GET' || ctx.requestId !== null;
  const orderCall = ctx.op.startsWith('orders.');
  const issue = p.issue;
  let code: PayPalFailureCode = 'PAYPAL_ERROR';
  let retryable = false;
  let restartCheckout = false;

  if (ctx.status === null) {
    code = 'PAYPAL_UNAVAILABLE';
    retryable = replayable;
  } else if (ctx.status === 429) {
    code = 'PAYPAL_UNAVAILABLE';
    retryable = true;
  } else if (ctx.status >= 500) {
    code = 'PAYPAL_UNAVAILABLE';
    retryable = replayable;
  } else if (issue !== null && EXPIRED_ISSUES.has(issue)) {
    code = 'HOLD_EXPIRED';
  } else if (issue !== null && CLOSED_ISSUES.has(issue)) {
    code = 'HOLD_CLOSED';
  } else if (issue !== null && OVER_ISSUES.has(issue)) {
    code = 'OVER_CAPTURE';
  } else if (issue !== null && DECLINED_ISSUES.has(issue)) {
    code = 'PAYPAL_DECLINED';
    restartCheckout = orderCall && RESTART_CHECKOUT_ISSUES.has(issue);
  }

  const name = p.name ?? ctx.transport ?? (ctx.status === 429 ? 'RATE_LIMIT_REACHED' : null);
  const what = [name, issue].filter((s): s is string => s !== null).join('/') || 'no detail';
  const status = ctx.status !== null ? ` (HTTP ${ctx.status})` : '';
  const debug = debugId ? `, debug id ${debugId}` : '';
  return new PayPalError({
    code,
    op: ctx.op,
    message: `PayPal ${ctx.op} failed: ${what}${status}${debug}.`,
    paypalName: name,
    issue,
    description: p.description ?? p.message,
    httpStatus: ctx.status,
    debugId,
    retryable,
    restartCheckout,
  });
}

/** A 2xx response we could not read. Not retryable: the call may have worked, so the caller must reload. */
export function unexpectedResponse(op: string, what: string, debugId: string | null): PayPalError {
  return new PayPalError({
    code: 'PAYPAL_ERROR',
    op,
    message: `PayPal ${op} returned an unexpected response: ${what}${debugId ? `, debug id ${debugId}` : ''}.`,
    paypalName: 'UNEXPECTED_RESPONSE',
    issue: null,
    description: what,
    httpStatus: null,
    debugId,
    retryable: false,
    restartCheckout: false,
  });
}

/**
 * True when PayPal refused a payout because its sender_batch_id was already
 * used: the batch was sent before (for example a lost response). The server
 * reconciles it instead of sending again; it is never a new failure.
 */
export function isDuplicatePayout(err: unknown): boolean {
  return err instanceof PayPalError && err.op === 'payouts.create' && err.issue !== null && /already exists|DUPLICATE/i.test(err.issue);
}

/** True when the buyer has to approve again, for example after INSTRUMENT_DECLINED on authorize. */
export function needsNewApproval(err: unknown): boolean {
  return err instanceof PayPalError && err.restartCheckout;
}
