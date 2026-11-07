import { ContractError } from '@holdmyspot/shared';
import type { ApiErrorBody, ApiErrorCode } from '@holdmyspot/shared';

/** HTTP status per error code (docs/API.md section 2). */
export const STATUS: Readonly<Record<ApiErrorCode, number>> = {
  BAD_REQUEST: 400,
  INVALID_AMOUNT: 400,
  OVER_STORE_LIMIT: 400,
  FEE_BELOW_MINIMUM: 400,
  RETAIL_CAP_TOO_LOW: 400,
  DEADLINE_OUT_OF_RANGE: 400,
  MODE_NOT_ALLOWED: 400,
  GPS_TOO_COARSE: 400,
  WRONG_CODE: 400,
  UNAUTHORIZED: 401,
  PAYPAL_DECLINED: 402,
  FORBIDDEN: 403,
  RELIABILITY_TOO_LOW: 403,
  DEMO_ONLY: 403,
  FAKE_ONLY: 403,
  SANDBOX_ONLY: 403,
  NOT_FOUND: 404,
  HOLD_NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_TRANSITION: 409,
  IDEMPOTENCY_CONFLICT: 409,
  HOLD_CLOSED: 409,
  HOLD_EXPIRED: 409,
  RENEWAL_REQUIRED: 409,
  SELF_MATCH: 409,
  SOLD_OUT: 409,
  WINDOW_CLOSED: 409,
  OVER_CAPTURE: 422,
  OVER_LIMIT: 422,
  OUT_OF_RANGE: 422,
  OUTSIDE_GEOFENCE: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  NOT_BUILT: 501,
  PAYPAL_ERROR: 502,
  PAYPAL_UNAVAILABLE: 503,
  AI_UNAVAILABLE: 503,
};

export function toErrorBody(err: unknown): { status: number; body: ApiErrorBody } {
  if (err instanceof ContractError) {
    const debugId = (err as ContractError & { paypalDebugId?: string }).paypalDebugId;
    return {
      status: STATUS[err.code] ?? 400,
      body: { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}), ...(debugId ? { paypalDebugId: debugId } : {}) } },
    };
  }
  const fastifyErr = err as { statusCode?: number; code?: string; message?: string };
  if (typeof fastifyErr.statusCode === 'number' && fastifyErr.statusCode >= 400 && fastifyErr.statusCode < 500) {
    const code: ApiErrorCode = fastifyErr.statusCode === 413 ? 'BAD_REQUEST' : fastifyErr.statusCode === 404 ? 'NOT_FOUND' : 'BAD_REQUEST';
    return { status: fastifyErr.statusCode === 413 ? 400 : fastifyErr.statusCode, body: { error: { code, message: fastifyErr.message ?? 'Bad request.' } } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'Something went wrong on the server.' } } };
}
