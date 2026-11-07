import type { PaymentsPort } from './payments.ts';

/**
 * Sandbox only (docs/DECISIONS.md D-50). PayPal remembers what we send:
 * PayPal-Request-Id keys (a repeat returns the first result), payout
 * `sender_batch_id` values (a repeat is refused) and captured invoice ids
 * (a repeat can be refused as DUPLICATE_INVOICE_ID). Our ids and ledger keys
 * are sequential per market (bid_0001, `order:bid_0001`), and a demo reset
 * starts them again, so a second sandbox take would collide with the first.
 *
 * Every market run therefore has a short run id, added on the way to PayPal:
 * keys become `<key>@<run>` and invoice ids `HMS-<run>-<rest>`. Retries inside
 * one run send the same values, so idempotency holds; a reset starts a new
 * run. The ledger keeps the plain keys. Fake mode does not need this (its
 * emulator is reset with the market) and runs unscoped.
 */
export function runScoped(port: PaymentsPort, run: () => string): PaymentsPort {
  const key = (k: string) => `${k}@${run()}`;
  const invoice = (id: string) => (id.startsWith('HMS-') ? `HMS-${run()}-${id.slice('HMS-'.length)}` : id);
  return {
    get mode() {
      return port.mode;
    },
    createOrder: (i) => port.createOrder({ ...i, requestId: key(i.requestId), invoiceId: invoice(i.invoiceId) }),
    authorizeOrder: (orderId, requestId) => port.authorizeOrder(orderId, key(requestId)),
    getAuthorization: (id) => port.getAuthorization(id),
    captureAuthorization: (id, i) => port.captureAuthorization(id, { ...i, requestId: key(i.requestId), invoiceId: invoice(i.invoiceId) }),
    voidAuthorization: (id, requestId) => port.voidAuthorization(id, key(requestId)),
    reauthorize: (id, i) => port.reauthorize(id, { ...i, requestId: key(i.requestId) }),
    getCapture: (id) => port.getCapture(id),
    refundCapture: (id, i) => port.refundCapture(id, { ...i, requestId: key(i.requestId), invoiceId: invoice(i.invoiceId) }),
    addTracking: (orderId, i) => port.addTracking(orderId, { ...i, requestId: key(i.requestId) }),
    createPayout: (i) => port.createPayout({ ...i, senderBatchId: key(i.senderBatchId) }),
    getPayoutBatch: (id) => port.getPayoutBatch(id),
    cancelUnclaimedPayoutItem: (id) => port.cancelUnclaimedPayoutItem(id),
    listDisputes: (since) => port.listDisputes(since),
    getDispute: (id) => port.getDispute(id),
    provideEvidence: (id, i) => port.provideEvidence(id, i),
    acceptClaim: (id, note) => port.acceptClaim(id, note),
    adjudicate: (id, outcome) => port.adjudicate(id, outcome),
    verifyWebhook: (headers, rawBody) => port.verifyWebhook(headers, rawBody),
  };
}
