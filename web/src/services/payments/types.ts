import type { Cents, Money } from '../../domain/money';

/**
 * The payments boundary. The app only talks to this interface; the mock
 * below runs in the browser, and the PayPal sandbox implementation will run
 * behind our own API so no secret ever reaches the client.
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
