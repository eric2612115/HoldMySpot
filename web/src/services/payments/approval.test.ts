import type { BidResult } from '@holdmyspot/shared';
import { describe, expect, it, vi } from 'vitest';
import { APPROVAL_TEXT, authorizeFailureText, startBidApproval, type BidApprovalOutcome, type BidApprovalSteps } from './approval';
import { CheckoutError, type ApprovalCallbacks, type CheckoutFunding, type CheckoutService } from './types';

/** A checkout that records the order it was given and lets the test play PayPal's window. */
function fakeCheckout() {
  let callbacks: ApprovalCallbacks | null = null;
  let order: Promise<{ orderId: string }> | null = null;
  const service: CheckoutService = {
    mode: 'paypal-v6',
    prepare: async () => [{ funding: 'paypal' }],
    start(_funding: CheckoutFunding, o, cb) {
      order = o;
      order.catch(() => {});
      callbacks = cb;
    },
    busy: () => callbacks !== null,
    cancel: () => callbacks?.onCancel(),
  };
  return {
    service,
    order: () => order!,
    window: () => callbacks!,
  };
}

const RESULT = { bid: { id: 'bid_1' }, hold: { id: 'hold_1', amount: { cents: 4800, currency: 'USD' } }, matches: [] } as unknown as BidResult;

function steps(over: Partial<BidApprovalSteps> = {}) {
  const calls: string[] = [];
  const s: BidApprovalSteps = {
    createBid: vi.fn(async () => {
      calls.push('createBid');
      return { bidId: 'bid_1', orderId: 'ORDER-1' };
    }),
    authorize: vi.fn(async (bidId: string, orderId: string) => {
      calls.push(`authorize:${bidId}:${orderId}`);
      return RESULT;
    }),
    approvalFailed: vi.fn(async (bidId: string, reason: string, detail: string | null) => {
      calls.push(`approvalFailed:${bidId}:${reason}:${detail ?? ''}`);
    }),
    recheck: vi.fn((bidId: string) => {
      calls.push(`recheck:${bidId}`);
    }),
    ...over,
  };
  return { s, calls };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('a request approved with PayPal’s buttons', () => {
  it('creates the bid, hands PayPal its order id and authorizes after the approval', async () => {
    const c = fakeCheckout();
    const { s, calls } = steps();
    const ends: BidApprovalOutcome[] = [];
    startBidApproval(c.service, 'paypal', s, (o) => ends.push(o));
    await expect(c.order()).resolves.toEqual({ orderId: 'ORDER-1' });
    await c.window().onApprove({ orderId: 'ORDER-1', funding: 'paypal' });
    expect(calls).toEqual(['createBid', 'authorize:bid_1:ORDER-1']);
    expect(ends).toEqual([{ kind: 'held', bidId: 'bid_1', funding: 'paypal', result: RESULT }]);
  });

  it('a closed window ends at once and the bid is ended on the server', async () => {
    const c = fakeCheckout();
    const { s, calls } = steps();
    const ends: BidApprovalOutcome[] = [];
    startBidApproval(c.service, 'venmo', s, (o) => ends.push(o));
    await c.order();
    c.window().onCancel();
    expect(ends).toEqual([{ kind: 'cancelled', bidId: 'bid_1', message: APPROVAL_TEXT.cancelled }]);
    await flush();
    expect(calls).toEqual(['createBid', 'approvalFailed:bid_1:cancelled:']);
  });

  it('a window closed before the server answered ends at once; the bid is ended once it exists', async () => {
    const c = fakeCheckout();
    let answer: (v: { bidId: string; orderId: string }) => void = () => {};
    const { s, calls } = steps({ createBid: () => new Promise((r) => (answer = r)) });
    const ends: BidApprovalOutcome[] = [];
    startBidApproval(c.service, 'paypal', s, (o) => ends.push(o));
    c.window().onCancel();
    expect(ends).toEqual([{ kind: 'cancelled', bidId: null, message: APPROVAL_TEXT.cancelled }]);
    expect(calls).toEqual([]);
    answer({ bidId: 'bid_9', orderId: 'ORDER-9' });
    await flush();
    expect(calls).toEqual(['approvalFailed:bid_9:cancelled:']);
  });

  it('an order the server refused shows the server’s words and ends nothing else', async () => {
    const c = fakeCheckout();
    const refusal = Object.assign(new Error('The queue fee must be at least $8.00 per unit.'), { code: 'FEE_BELOW_MINIMUM' });
    const { s, calls } = steps({ createBid: () => Promise.reject(refusal) });
    const ends: BidApprovalOutcome[] = [];
    startBidApproval(c.service, 'paypal', s, (o) => ends.push(o));
    await c.order().catch(() => {});
    c.window().onError(new CheckoutError('ORDER_FAILED', refusal.message, 'order'));
    await flush();
    expect(ends).toEqual([{ kind: 'failed', bidId: null, code: 'ORDER_FAILED', message: 'The queue fee must be at least $8.00 per unit.' }]);
    expect(calls).toEqual([]);
  });

  it('a PayPal error ends the bid with the reason and says nothing was held', async () => {
    const c = fakeCheckout();
    const { s, calls } = steps();
    const ends: BidApprovalOutcome[] = [];
    startBidApproval(c.service, 'paypal', s, (o) => ends.push(o));
    await c.order();
    c.window().onError(new CheckoutError('ERR_POPUP', 'Popup closed unexpectedly', 'paypal'));
    await flush();
    expect(ends).toEqual([{ kind: 'failed', bidId: 'bid_1', code: 'ERR_POPUP', message: APPROVAL_TEXT.paypal('ERR_POPUP') }]);
    expect(calls).toEqual(['createBid', 'approvalFailed:bid_1:error:ERR_POPUP: Popup closed unexpectedly']);
  });

  it('a declined authorization ends the bid and asks for another way to pay', async () => {
    const c = fakeCheckout();
    const declined = Object.assign(new Error('PayPal call failed (PAYPAL_DECLINED: INSTRUMENT_DECLINED).'), { code: 'PAYPAL_DECLINED' });
    const { s, calls } = steps({ authorize: () => Promise.reject(declined) });
    const ends: BidApprovalOutcome[] = [];
    startBidApproval(c.service, 'paypal', s, (o) => ends.push(o));
    await c.order();
    await c.window().onApprove({ orderId: 'ORDER-1', funding: 'paypal' });
    expect(ends).toEqual([{ kind: 'failed', bidId: 'bid_1', code: 'PAYPAL_DECLINED', message: APPROVAL_TEXT.declined }]);
    expect(calls[1]).toMatch(/^approvalFailed:bid_1:error:PAYPAL_DECLINED: /);
  });

  it('when the server cannot confirm the end, the screen rechecks the request instead of guessing', async () => {
    const c = fakeCheckout();
    const { s } = steps({
      authorize: () => Promise.reject(new TypeError('Failed to fetch')),
      approvalFailed: () => Promise.reject(Object.assign(new Error('PayPal already holds the money for this request.'), { code: 'INVALID_TRANSITION' })),
    });
    const ends: BidApprovalOutcome[] = [];
    startBidApproval(c.service, 'paypal', s, (o) => ends.push(o));
    await c.order();
    await c.window().onApprove({ orderId: 'ORDER-1', funding: 'paypal' });
    expect(ends).toEqual([{ kind: 'check', bidId: 'bid_1', message: APPROVAL_TEXT.check }]);

    const c2 = fakeCheckout();
    const second = steps({ approvalFailed: () => Promise.reject(new Error('offline')) });
    startBidApproval(c2.service, 'paypal', second.s, () => {});
    await c2.order();
    c2.window().onCancel();
    await flush();
    expect(second.s.recheck).toHaveBeenCalledWith('bid_1');
  });

  it('ends exactly once whatever PayPal reports after the first outcome', async () => {
    const c = fakeCheckout();
    const { s } = steps();
    const ends: BidApprovalOutcome[] = [];
    startBidApproval(c.service, 'paypal', s, (o) => ends.push(o));
    await c.order();
    c.window().onCancel();
    c.window().onError(new CheckoutError('LATE', 'late', 'paypal'));
    await c.window().onApprove({ orderId: 'ORDER-1', funding: 'paypal' });
    await flush();
    expect(ends.map((e) => e.kind)).toEqual(['cancelled']);
  });

  it('words for failed authorizations', () => {
    expect(authorizeFailureText({ code: 'PAYPAL_UNAVAILABLE' })).toBe(APPROVAL_TEXT.unavailable);
    expect(authorizeFailureText({ code: 'HOLD_EXPIRED' })).toBe(APPROVAL_TEXT.refused('HOLD_EXPIRED'));
    expect(authorizeFailureText(new TypeError('Failed to fetch'))).toBe(APPROVAL_TEXT.offline);
    expect(authorizeFailureText({ code: 'INVALID_TRANSITION', message: 'This request already failed; create a new one.' })).toBe('This request already failed; create a new one. Nothing was held.');
  });
});
