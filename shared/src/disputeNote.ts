import { formatUsd } from './money.ts';
import type { Cents } from './contract.ts';

/**
 * The facts of a dispute note and its plain template (D-159). Code gathers the
 * facts; a model may word them; a number the facts do not hold sends the note
 * back to this template. Nothing here decides money or an outcome.
 */

export interface DisputeNoteFacts {
  disputeId: string;
  /** PayPal's reason code, for example MERCHANDISE_OR_SERVICE_NOT_RECEIVED. */
  reason: string;
  amountCents: Cents;
  itemName: string | null;
  qty: number | null;
  shopName: string | null;
  /** As printed on the receipt the AI read and the rules checked. */
  receiptTotal: string | null;
  receiptNumber: string | null;
  receiptDate: string | null;
  tracking: { carrierName: string; trackingNumber: string } | null;
  /** True when the buyer's one-time code confirmed a hand-to-hand delivery. */
  handedOver: boolean;
  capturedCents: Cents;
  refundedCents: Cents;
  attachments: readonly string[];
}

const REASONS: Readonly<Record<string, string>> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'the buyer says the item did not arrive',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'the buyer says the item was not as described',
  UNAUTHORISED: 'the buyer says the payment was not theirs',
  CREDIT_NOT_PROCESSED: 'the buyer says a refund was not processed',
  DUPLICATE_TRANSACTION: 'the buyer says the payment was taken twice',
  INCORRECT_AMOUNT: 'the buyer says the amount was wrong',
  PAYMENT_BY_OTHER_MEANS: 'the buyer says the item was paid for another way',
  CANCELED_RECURRING_BILLING: 'the buyer says a cancelled payment was taken',
  PROBLEM_WITH_REMITTANCE: 'the buyer reports a problem with the payment',
  OTHER: 'the buyer opened a case',
};

/** Plain words for PayPal's reason code. */
export function disputeReasonText(reason: string): string {
  return REASONS[reason] ?? 'the buyer opened a case';
}

export function disputeNoteTemplate(f: DisputeNoteFacts): string {
  const usd = (c: Cents) => formatUsd(c, { exact: true });
  const parts: string[] = [`PayPal case ${f.disputeId}: ${disputeReasonText(f.reason)}, for ${usd(f.amountCents)}.`];
  if (f.itemName) {
    const receipt = [f.receiptTotal, f.receiptNumber && `receipt ${f.receiptNumber}`, f.receiptDate].filter(Boolean).join(', ');
    parts.push(`${f.qty ?? 1} x ${f.itemName}${f.shopName ? ` bought at ${f.shopName}` : ''}${receipt ? ` (${receipt})` : ''}.`);
  }
  if (f.tracking) parts.push(`Shipped with ${f.tracking.carrierName}, tracking ${f.tracking.trackingNumber}.`);
  else if (f.handedOver) parts.push("Handed over in person; the buyer's one-time code confirmed it.");
  parts.push(`Captured ${usd(f.capturedCents)}; refunded ${usd(f.refundedCents)}.`);
  if (f.attachments.length > 0) parts.push(`Attached: ${f.attachments.join(', ')}.`);
  return parts.join(' ');
}

const NUMBER = /\d+(?:[.,]\d+)*/g;

/** True when every number in `text` appears in the facts: a model may word them, never add one. */
export function noteUsesOnlyFacts(text: string, f: DisputeNoteFacts): boolean {
  const known = new Set([...disputeNoteTemplate(f).matchAll(NUMBER)].map((m) => m[0]));
  return [...text.matchAll(NUMBER)].every((m) => known.has(m[0]));
}
