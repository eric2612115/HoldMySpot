import type { BidResult } from '@holdmyspot/shared';
import type { CheckoutError, CheckoutFunding, CheckoutService } from './types';

/**
 * One request approved with PayPal's own buttons (server in sandbox mode):
 *
 *   click -> createBid (POST /api/bids: the server creates the PayPal order, intent AUTHORIZE)
 *         -> PayPal's window (the buyer approves the order)
 *         -> authorize (POST /api/bids/:bidId/authorize: the hold exists, matching runs)
 *
 * Every path ends with exactly one outcome the screen can show, as soon as it
 * is known: a closed window or an error never waits for the server. The bid is
 * still ended on the server right away (POST /api/bids/:bidId/approval-failed,
 * in the background once its id is known) instead of waiting for the
 * three-hour approval timeout; if the server cannot confirm that, `recheck`
 * shows the request as the server has it.
 */

export interface BidApprovalSteps {
  /** Create the request; resolves to its id and the PayPal order the server created. */
  createBid(funding: CheckoutFunding): Promise<{ bidId: string; orderId: string }>;
  /** The buyer approved: authorize the order on our server. */
  authorize(bidId: string, orderId: string): Promise<BidResult>;
  /** The approval ended without a hold. */
  approvalFailed(bidId: string, reason: 'cancelled' | 'error', detail: string | null): Promise<void>;
  /** The server did not confirm the end of an approval: show the request as the server has it. */
  recheck(bidId: string): void;
}

export type BidApprovalOutcome =
  /** PayPal holds the money; the request is open (and may have matched at once). */
  | { kind: 'held'; bidId: string; funding: CheckoutFunding; result: BidResult }
  /** The buyer closed PayPal's window (or the app stopped waiting). Nothing is held. */
  | { kind: 'cancelled'; bidId: string | null; message: string }
  /** Something refused it. Nothing is held. */
  | { kind: 'failed'; bidId: string | null; code: string; message: string }
  /** The server could not confirm how it ended: show the request as the server has it. */
  | { kind: 'check'; bidId: string; message: string };

export const APPROVAL_TEXT = {
  cancelled: 'You closed PayPal before approving. Nothing was held.',
  declined: 'PayPal declined that way to pay. Nothing was held. Try again and pick another one.',
  unavailable: 'PayPal did not answer in time, so the request stopped and nothing stays held. Try again in a moment.',
  refused: (code: string) => `PayPal did not accept the hold (${code}). Nothing was held. Try again.`,
  paypal: (code: string) => `PayPal stopped before the approval (${code}). Nothing was held. Try again.`,
  offline: 'The server did not answer. Nothing was charged; check the request before trying again.',
  check: 'PayPal answered, but the hold could not be confirmed here. Showing the request as the server has it.',
} as const;

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : 'NETWORK';
}

function messageOf(err: unknown): string {
  const m = (err as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m.trim() !== '' ? m.trim() : 'Something went wrong.';
}

/** What the buyer reads when our server could not authorize an approved order. */
export function authorizeFailureText(err: unknown): string {
  const code = codeOf(err);
  if (code === 'PAYPAL_DECLINED') return APPROVAL_TEXT.declined;
  if (code === 'PAYPAL_UNAVAILABLE') return APPROVAL_TEXT.unavailable;
  if (code.startsWith('PAYPAL') || code.startsWith('HOLD_')) return APPROVAL_TEXT.refused(code);
  if (code === 'NETWORK') return APPROVAL_TEXT.offline;
  return `${messageOf(err)} Nothing was held.`;
}

/** What the buyer reads when the approval stopped before PayPal's go-ahead. */
export function checkoutFailureText(err: CheckoutError): string {
  // Our server's refusals (fee too low, over the limit, ...) are already plain English.
  if (err.source === 'order') return err.message;
  if (err.code === 'BUSY' || err.code === 'NOT_READY') return err.message;
  return APPROVAL_TEXT.paypal(err.code);
}

const detailOf = (code: string, message: string) => `${code}: ${message}`.slice(0, 500);

/**
 * Starts the approval. Call it straight from the click on PayPal's button: the
 * order is created in the background and PayPal's window opens inside the click.
 */
export function startBidApproval(checkout: CheckoutService, funding: CheckoutFunding, steps: BidApprovalSteps, onEnd: (outcome: BidApprovalOutcome) => void): void {
  let ended = false;
  let knownBidId: string | null = null;
  const finish = (outcome: BidApprovalOutcome) => {
    if (ended) return;
    ended = true;
    onEnd(outcome);
  };

  const created = steps.createBid(funding).then((ids) => {
    knownBidId = ids.bidId;
    return ids;
  });
  /** The bid id once the server has created it; null when it refused. */
  const bidIdOf = () => created.then((ids) => ids.bidId, () => null);

  /** Ends the bid on the server. True when the server agreed that nothing is held. */
  const tell = async (bidId: string, reason: 'cancelled' | 'error', detail: string | null): Promise<boolean> => {
    try {
      await steps.approvalFailed(bidId, reason, detail);
      return true;
    } catch {
      return false;
    }
  };

  /** After a cancel or an error on screen: end the bid on the server as soon as it exists. */
  const cleanUp = (reason: 'cancelled' | 'error', detail: string | null) => {
    void bidIdOf().then(async (bidId) => {
      if (bidId && !(await tell(bidId, reason, detail))) steps.recheck(bidId);
    });
  };

  checkout.start(
    funding,
    created.then((ids) => ({ orderId: ids.orderId })),
    {
      async onApprove({ orderId }) {
        const bidId = await bidIdOf();
        if (!bidId) {
          finish({ kind: 'failed', bidId: null, code: 'NO_BID', message: APPROVAL_TEXT.paypal('NO_BID') });
          return;
        }
        try {
          const result = await steps.authorize(bidId, orderId);
          finish({ kind: 'held', bidId, funding, result });
        } catch (err) {
          const stopped = await tell(bidId, 'error', detailOf(codeOf(err), messageOf(err)));
          finish(stopped ? { kind: 'failed', bidId, code: codeOf(err), message: authorizeFailureText(err) } : { kind: 'check', bidId, message: APPROVAL_TEXT.check });
        }
      },
      onCancel() {
        finish({ kind: 'cancelled', bidId: knownBidId, message: APPROVAL_TEXT.cancelled });
        cleanUp('cancelled', null);
      },
      onError(error) {
        finish({ kind: 'failed', bidId: knownBidId, code: error.code, message: checkoutFailureText(error) });
        cleanUp('error', detailOf(error.code, error.message));
      },
    },
  );
}
