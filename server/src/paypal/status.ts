import type { DisputeStatus, HoldStatus, LedgerStatus, PayoutStatus } from '@holdmyspot/shared';
import type { AuthorizationStatus, CaptureResult, DisputeResult, PayoutItemStatus } from '@holdmyspot/shared/ports';
import { INVOICE_PREFIX } from './constants.ts';

/**
 * PayPal statuses mapped to ours (docs/PAYPAL-MAPPING.md section 6). The
 * poller and the webhook handler both use these, so either path gives the
 * same result.
 */

export interface HoldFromAuthorization {
  status: HoldStatus;
  /** False while PayPal reviews the authorization (PENDING): the bid must not match yet. */
  matchable: boolean;
  /** True for EXPIRED: if the bid is still open, set renewalRequired. */
  expired: boolean;
}

export function holdFromAuthorization(status: AuthorizationStatus): HoldFromAuthorization {
  switch (status) {
    case 'CREATED':
      return { status: 'held', matchable: true, expired: false };
    case 'PENDING':
      return { status: 'held', matchable: false, expired: false };
    case 'PARTIALLY_CAPTURED':
      return { status: 'partially_captured', matchable: true, expired: false };
    case 'CAPTURED':
      return { status: 'captured', matchable: false, expired: false };
    case 'VOIDED':
      return { status: 'released', matchable: false, expired: false };
    case 'EXPIRED':
      return { status: 'released', matchable: false, expired: true };
    case 'DENIED':
      return { status: 'failed', matchable: false, expired: false };
  }
}

/** Ledger status of a capture: COMPLETED succeeded (payouts may start), PENDING waits, DECLINED or FAILED failed. */
export function ledgerFromCapture(status: CaptureResult['status']): LedgerStatus {
  switch (status) {
    case 'COMPLETED':
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
      return 'succeeded';
    case 'PENDING':
      return 'pending';
    case 'DECLINED':
    case 'FAILED':
      return 'failed';
  }
}

export function payoutFromItem(status: PayoutItemStatus): PayoutStatus {
  switch (status) {
    case 'SUCCESS':
      return 'succeeded';
    case 'UNCLAIMED':
      return 'unclaimed';
    case 'PENDING':
    case 'NEW':
    case 'ONHOLD':
      return 'pending';
    case 'FAILED':
    case 'BLOCKED':
    case 'DENIED':
      return 'failed';
    case 'RETURNED':
    case 'REFUNDED':
    case 'REVERSED':
      return 'returned';
    case 'CANCELED':
      return 'cancelled';
  }
}

/** The poller stops asking about an item once it is final. UNCLAIMED is not final: it can still be claimed or returned. */
export function isFinalPayoutItem(status: PayoutItemStatus): boolean {
  return !['PENDING', 'NEW', 'ONHOLD', 'UNCLAIMED'].includes(status);
}

export function disputeFromPayPal(d: Pick<DisputeResult, 'status' | 'outcome'>): { status: DisputeStatus; outcome: 'buyer_favor' | 'seller_favor' | 'other' | null } {
  const status: DisputeStatus =
    d.status === 'RESOLVED' ? 'resolved' : d.status === 'UNDER_REVIEW' ? 'under_review' : d.status === 'WAITING_FOR_SELLER_RESPONSE' ? 'waiting_for_seller' : 'open';
  let outcome: 'buyer_favor' | 'seller_favor' | 'other' | null = null;
  switch (d.outcome) {
    case 'RESOLVED_BUYER_FAVOUR':
    case 'ACCEPTED':
      outcome = 'buyer_favor';
      break;
    case 'RESOLVED_SELLER_FAVOUR':
    case 'DENIED':
      outcome = 'seller_favor';
      break;
    case 'RESOLVED_WITH_PAYOUT':
    case 'CANCELED_BY_BUYER':
      outcome = 'other';
      break;
    case null:
      outcome = null;
      break;
  }
  return { status, outcome };
}

/** What one of our invoice ids points at (keys in docs/PAYPAL-MAPPING.md section 2). `run` is the sandbox market run, when present. */
export type HmsReference =
  | { kind: 'bid'; bidId: string; run?: string }
  | { kind: 'job'; jobId: string; part: 'receipt' | 'shipping' | 'handover' | 'refund'; n: number | null; run?: string }
  | { kind: 'other'; rest: string };

/**
 * Parses `HMS-<bidId>`, `HMS-<jobId>-R|S|H` and `HMS-<jobId>-F<n>`, also with a
 * market run segment (`HMS-<run>-<bidId>`, server/src/ports/runscope.ts).
 * Null when the id is not ours.
 */
export function parseInvoiceId(invoiceId: string | null | undefined, prefix: string = INVOICE_PREFIX): HmsReference | null {
  if (!invoiceId || !invoiceId.startsWith(prefix)) return null;
  let rest = invoiceId.slice(prefix.length);
  const run = /^([a-z0-9]+)-(?=(?:bid|job)_)/.exec(rest)?.[1];
  if (run) rest = rest.slice(run.length + 1);
  const m = /^(.+)-(R|S|H|F(\d+))$/.exec(rest);
  if (m?.[1] && m[2]) {
    const part = m[2] === 'R' ? 'receipt' : m[2] === 'S' ? 'shipping' : m[2] === 'H' ? 'handover' : 'refund';
    return { kind: 'job', jobId: m[1], part, n: m[3] ? Number(m[3]) : null, ...(run ? { run } : {}) };
  }
  if (/^bid[_-]/.test(rest)) return { kind: 'bid', bidId: rest, ...(run ? { run } : {}) };
  return { kind: 'other', rest };
}
