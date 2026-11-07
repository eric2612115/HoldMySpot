import { MockPaymentsService } from './mock';
import { PayPalV6Checkout, type PayPalSettings } from './paypalV6';
import type { CheckoutService, PaymentsService } from './types';

export type { Activity, ActivityKind, ApprovalCallbacks, CheckoutButton, CheckoutFunding, CheckoutService, Hold, PaymentsService, Payout } from './types';
export { CheckoutError } from './types';
export { APPROVAL_TEXT, startBidApproval, type BidApprovalOutcome, type BidApprovalSteps } from './approval';

/**
 * The in-browser market's payments: the mock, which holds, captures and pays
 * out in the browser. With the HoldMySpot server those steps run on the server
 * (docs/WEB-INTEGRATION.md section 5) and the browser only approves.
 */
export function createPayments(): PaymentsService {
  return new MockPaymentsService();
}

/**
 * The approval step for a server in sandbox mode: PayPal's own buttons through
 * the JS SDK v6, with the client id from GET /api/config. Null in fake mode,
 * which keeps its "Simulated PayPal" sheet, and when the server sends no client id.
 */
export function createCheckout(mode: 'fake' | 'sandbox', paypal: PayPalSettings): CheckoutService | null {
  if (mode !== 'sandbox' || !paypal.clientId || !paypal.sdkUrl) return null;
  return new PayPalV6Checkout(paypal);
}
