import type { CheckoutFunding } from '@holdmyspot/shared';
import type { Cents, Money } from '../../domain/money';

export type { CheckoutFunding };

/**
 * The in-browser market's payments boundary (state/mockMarket.ts): the mock
 * below holds, captures and pays out in the browser. With the HoldMySpot
 * server those steps run on the server, which holds the client secret; the
 * browser keeps only the buyer's approval (CheckoutService, further down).
 *
 * How each call maps to PayPal:
 * - placeHold: Orders v2 with intent AUTHORIZE, approved by the buyer, then authorized.
 * - capture:   Payments v2 capture of that authorization (partial captures allowed;
 *              `final: true` sets final_capture, which releases whatever is left).
 * - release:   Payments v2 void of the authorization.
 * - payout:    Payouts v1 to the queuer or seller.
 */
export type HoldStatus = 'held' | 'partially_captured' | 'captured' | 'released';

export interface Hold {
  id: string;
  /** Our own reference, for example the sale or bid id. */
  reference: string;
  description: string;
  amount: Money;
  capturedCents: Cents;
  releasedCents: Cents;
  status: HoldStatus;
  createdAt: number;
}

export interface Payout {
  id: string;
  recipient: string;
  amount: Money;
  note: string;
  reference: string;
  createdAt: number;
}

/** The four money states people see, in plain words. */
export type ActivityKind = 'held' | 'captured' | 'released' | 'paid_out';

export interface Activity {
  id: string;
  kind: ActivityKind;
  amount: Money;
  /** What happened, in one plain sentence. */
  text: string;
  at: number;
  holdId?: string;
  payoutId?: string;
}

export interface PlaceHoldInput {
  amountCents: Cents;
  reference: string;
  description: string;
}

export interface PayoutInput {
  recipient: string;
  amountCents: Cents;
  note: string;
  reference: string;
}

export class PaymentError extends Error {
  readonly code: 'INVALID_AMOUNT' | 'HOLD_NOT_FOUND' | 'HOLD_CLOSED' | 'OVER_CAPTURE';

  constructor(code: PaymentError['code'], message: string) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
  }
}

export interface PaymentsService {
  readonly mode: 'mock' | 'paypal-sandbox';
  placeHold(input: PlaceHoldInput): Promise<Hold>;
  capture(holdId: string, amountCents: Cents, opts: { description: string; final: boolean }): Promise<Hold>;
  release(holdId: string, opts: { description: string }): Promise<Hold>;
  payout(input: PayoutInput): Promise<Payout>;
  /** Newest first. */
  activity(): Activity[];
  holds(): Hold[];
  /** Called after every change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

// ---------------------------------------------------------------------------
// Checkout: the buyer's approval of one PayPal order (server mode)
// ---------------------------------------------------------------------------
//
// With the HoldMySpot server the browser never holds, captures or pays out:
// the server creates the PayPal order (intent AUTHORIZE) on POST /api/bids and
// authorizes it once the buyer has approved. The only money step left in the
// browser is that approval, behind CheckoutService. Fake mode keeps its plainly
// labelled "Simulated PayPal" sheet; the sandbox uses PayPal's JS SDK v6
// (paypalV6.ts) with PayPal's own buttons (docs/DECISIONS.md D-70).

/** One of PayPal's own buttons, eligible for this buyer and allowed by the server. */
export interface CheckoutButton {
  funding: CheckoutFunding;
  /** Pay Later only: the values PayPal's eligibility answer gives for its button. */
  productCode?: string;
  countryCode?: string;
}

/** Why an approval stopped without PayPal's go-ahead. */
export class CheckoutError extends Error {
  /** A PayPal SDK code, or ours: ORDER_FAILED, NOT_READY, BUSY, SDK_MISSING, SCRIPT_FAILED, NO_ORDER. */
  readonly code: string;
  /** order: our server refused or failed to create the order (the message is the server's). paypal: PayPal's SDK. */
  readonly source: 'order' | 'paypal';

  constructor(code: string, message: string, source: CheckoutError['source']) {
    super(message);
    this.name = 'CheckoutError';
    this.code = code;
    this.source = source;
  }
}

export interface ApprovalCallbacks {
  /** The buyer approved in PayPal's window: authorize the order on our server. Never rejects back into PayPal. */
  onApprove(data: { orderId: string; funding: CheckoutFunding }): Promise<void>;
  /** The buyer closed PayPal's window, or the app stopped waiting. */
  onCancel(): void;
  onError(error: CheckoutError): void;
}

/** The approval step of a hold. Exactly one callback ends each start(). */
export interface CheckoutService {
  readonly mode: 'paypal-v6';
  /** Loads what it needs once and resolves to the buttons to show, in order. A failed load can be retried. */
  prepare(): Promise<CheckoutButton[]>;
  /**
   * Starts one approval for an order our server is creating. Call it straight from the click on
   * PayPal's button, before any await: PayPal's window may only open inside that click.
   */
  start(funding: CheckoutFunding, order: Promise<{ orderId: string }>, callbacks: ApprovalCallbacks): void;
  /** True while an approval waits for PayPal. */
  busy(): boolean;
  /** Stops the approval in progress, if any, as cancelled, and asks PayPal to close its window. */
  cancel(): void;
}
