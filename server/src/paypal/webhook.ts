import type { PayPalPort } from '@holdmyspot/shared/ports';
import { INVOICE_PREFIX } from './constants.ts';
import { arr, obj, str, time } from './wire.ts';

/**
 * Webhook helpers for POST /api/paypal/webhook. Polling is the default
 * (HMS_PAYPAL_SYNC=poll); webhooks need PAYPAL_WEBHOOK_ID and a public URL.
 * Every event is verified with PayPal's verify-webhook-signature call;
 * unverified events are dropped by the caller.
 */

export type WebhookResourceKind = 'order' | 'authorization' | 'capture' | 'refund' | 'payout_batch' | 'payout_item' | 'dispute' | 'other';

export interface WebhookEventSummary {
  eventId: string;
  eventType: string;
  kind: WebhookResourceKind;
  resourceId: string | null;
  status: string | null;
  invoiceId: string | null;
  senderBatchId: string | null;
  /**
   * A hint from the invoice id or sender_batch_id. The platform app is shared
   * with other entries, so the server should also check its own paypal_sync rows.
   */
  ours: boolean;
  createdAt: number | null;
}

function kindOf(eventType: string): WebhookResourceKind {
  if (eventType.startsWith('CHECKOUT.ORDER.')) return 'order';
  if (eventType.startsWith('PAYMENT.AUTHORIZATION.')) return 'authorization';
  if (eventType === 'PAYMENT.CAPTURE.REFUNDED') return 'refund';
  if (eventType.startsWith('PAYMENT.CAPTURE.')) return 'capture';
  if (eventType.startsWith('PAYMENT.PAYOUTSBATCH.')) return 'payout_batch';
  if (eventType.startsWith('PAYMENT.PAYOUTS-ITEM.')) return 'payout_item';
  if (eventType.startsWith('CUSTOMER.DISPUTE.')) return 'dispute';
  return 'other';
}

/** Reads the fields the sync handler needs from a PayPal webhook event. Null if it is not an event. */
export function summarizeWebhookEvent(event: unknown, invoicePrefix: string = INVOICE_PREFIX): WebhookEventSummary | null {
  const e = obj(event);
  const eventId = str(e.id);
  const eventType = str(e.event_type);
  if (!eventId || !eventType) return null;
  const r = obj(e.resource);
  const kind = kindOf(eventType);
  const batchHeader = obj(r.batch_header);
  const firstTxn = obj(arr(r.disputed_transactions)[0]);
  const firstUnit = obj(arr(r.purchase_units)[0]);
  const resourceId =
    kind === 'payout_batch'
      ? str(batchHeader.payout_batch_id)
      : kind === 'payout_item'
        ? str(r.payout_item_id)
        : kind === 'dispute'
          ? str(r.dispute_id)
          : str(r.id);
  const status = str(r.status) ?? str(r.transaction_status) ?? str(batchHeader.batch_status);
  const invoiceId = str(r.invoice_id) ?? str(firstUnit.invoice_id) ?? str(firstTxn.invoice_number);
  const senderBatchId = str(obj(batchHeader.sender_batch_header).sender_batch_id) ?? str(r.sender_batch_id);
  const ours =
    (invoiceId !== null && invoiceId.startsWith(invoicePrefix)) ||
    (senderBatchId !== null && (senderBatchId.startsWith('payout:') || senderBatchId.startsWith(invoicePrefix)));
  return { eventId, eventType, kind, resourceId, status, invoiceId, senderBatchId, ours, createdAt: time(e.create_time) };
}

/** Verifies the signature with PayPal, then summarizes the event. `event` is null when the body is not a PayPal event. */
export async function verifyWebhookEvent(
  port: Pick<PayPalPort, 'verifyWebhook'>,
  headers: Record<string, string | undefined>,
  rawBody: string,
  invoicePrefix: string = INVOICE_PREFIX,
): Promise<{ verified: boolean; event: WebhookEventSummary | null }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { verified: false, event: null };
  }
  const event = summarizeWebhookEvent(parsed, invoicePrefix);
  if (!event) return { verified: false, event: null };
  const verified = await port.verifyWebhook(headers, rawBody);
  return { verified, event };
}
