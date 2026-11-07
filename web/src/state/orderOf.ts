import type { BidDetail } from '@holdmyspot/shared';
import type { OrderStatus, UserOrder } from './market';

/** Names for the sentences of a closed request. */
export interface OrderNames {
  shopName: string;
  itemShort: string;
}

/**
 * The order card of one of my requests (server driver), from the bid, its hold and its jobs.
 * - bought: the receipt passed but the hold is not closed. A shipped errand's receipt is
 *   captured and the rest stays held until tracking; a local errand waits for the handover
 *   code, which triggers its only capture (D-115).
 * - filled: only once a job shipped or was handed over, so the last capture is in.
 * - A request closed by a sell-out is released with its own sentence, not the in-browser
 *   market's "fully booked while PayPal was approving" (D-116).
 */
export function orderOf(d: BidDetail, names?: OrderNames): UserOrder {
  const { bid, hold } = d;
  const job = d.jobs.find((j) => j.status !== 'failed') ?? d.jobs.at(-1) ?? null;
  const done = d.jobs.some((j) => j.status === 'shipped' || j.status === 'delivered');
  const bought = d.jobs.some((j) => j.status === 'verified');
  const settling = d.jobs.some((j) => j.status === 'proof_submitted') || d.ledger.some((e) => e.status === 'pending');
  const soldOut = bid.closeReason === 'sold_out';
  // The sheet above already says what sold out, so the request's own line names only the shop.
  const where = names ? `${names.shopName} sold out` : 'It sold out';
  let status: OrderStatus;
  let message: string | undefined;
  if (bid.status === 'awaiting_approval') status = 'approving';
  else if (bid.status === 'failed') {
    status = 'error';
    if (soldOut) message = `${where} while PayPal was approving. Nothing was held or charged.`;
  } else if (bid.status === 'cancelled' || bid.status === 'expired') {
    status = 'released';
    if (soldOut) message = `${where} before ${job?.queuerName ?? 'a queuer'} could buy yours. Nothing was charged.`;
    else if (bid.closeReason === 'deadline') message = 'No offer reached your max fee before the deadline. Nothing was charged.';
    else if (bid.closeReason === 'hold_lapsed') message = 'The PayPal hold lapsed before a queuer bought it. Nothing was charged.';
  } else if (done && (bid.status === 'settled' || bid.status === 'matched' || bid.status === 'closing')) status = 'filled';
  else if (settling) status = 'settling';
  else if (bought) status = 'bought';
  else if (job && !['failed', 'refunded'].includes(job.status)) status = 'booked';
  else status = 'resting';
  return {
    pointId: bid.itemId,
    kind: 'max',
    status,
    mode: bid.destination.mode,
    maxFeeCents: bid.maxFeeCents,
    holdId: hold?.id,
    holdCents: hold?.amount.cents ?? bid.limitCents,
    bidId: bid.id,
    fillFeeCents: job?.feeCents,
    queuerName: job?.queuerName,
    chargedCents: hold?.capturedCents,
    releasedCents: hold?.releasedCents,
    ...(message ? { message } : {}),
  };
}
