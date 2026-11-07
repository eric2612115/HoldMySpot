import { MockPaymentsService } from './mock';
import type { PaymentsService } from './types';

export type { Activity, ActivityKind, Hold, PaymentsService, Payout } from './types';

/**
 * Picks the payments implementation. Today only the in-browser mock exists.
 * The PayPal sandbox version will call our own server (which holds the
 * client secret) and implement the same PaymentsService interface, selected
 * with VITE_PAYMENTS=paypal-sandbox. Nothing else in the app changes.
 */
export function createPayments(): PaymentsService {
  return new MockPaymentsService();
}
