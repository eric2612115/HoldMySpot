import type { CheckoutFunding } from '@holdmyspot/shared';
import type {
  AuthorizationResult,
  AuthorizationStatus,
  CaptureInput,
  CaptureResult,
  CreateOrderInput,
  DisputeResult,
  Idempotent,
  OrderResult,
  PayoutBatchResult,
  PayoutInput,
  RefundInput,
  RefundResult,
  TrackingInput,
} from '@holdmyspot/shared/ports';
import type { Database } from '../db/database.ts';
import type { EmulatorState } from '../paypal/emulator.ts';
import { createFakePayPal, type FakePayPal as EmulatedPayPal } from '../paypal/fake.ts';
import type { FakePaymentsControls, PaymentsPort } from '../ports/payments.ts';

/**
 * Fake mode's PayPal (docs/PAYPAL-MAPPING.md section 10, decision D-47).
 *
 * This is the sandbox REST client (server/src/paypal/client.ts) wired to the
 * in-process PayPal emulator (server/src/paypal/emulator.ts), so fake mode
 * runs exactly the request building, response mapping, retries, idempotency
 * and error mapping the sandbox uses. No network is touched: the emulator
 * answers through its own `fetch`.
 *
 * What this wrapper adds for the server:
 * - the emulator runs on the market clock (honor period, validity, renewals);
 * - its state is saved to SQLite (table fake_paypal, one JSON document) after
 *   every call and loaded at boot, so a restart keeps every authorization;
 * - `reset()` empties it with the market (POST /api/demo/reset);
 * - persona payout emails (`<userId>@queuers.example`) are known receivers,
 *   anyone else stays UNCLAIMED, like PayPal;
 * - failure injection with HMS_FAKE_FAIL, `<op>:<effect>[:<count>|:*]`
 *   (see parseFailures in emulator.ts). The client retries 5xx answers twice,
 *   exactly like the sandbox adapter, so `capture:once` is absorbed by the
 *   retry; an outage the server sees needs `capture:unavailable:3`;
 * - read-only helpers for tests (inspectAuthorization, captureCount).
 */

/** Emails the fake treats as existing PayPal accounts (personas). */
export const FAKE_RECEIVER_DOMAIN = '@queuers.example';

const STATE_KIND = 'emulator';
const STATE_ID = 'state';

/** Persona emails, plus the emulator's own test receivers. */
export function knownFakeReceiver(email: string): boolean {
  return email.toLowerCase().endsWith(FAKE_RECEIVER_DOMAIN) || /@holdmyspot\.test$/i.test(email) || /@(business|personal)\.example\.com$/i.test(email);
}

export class FakePayPal implements PaymentsPort, FakePaymentsControls {
  readonly mode = 'fake' as const;
  readonly #db: Database;
  readonly #inner: EmulatedPayPal;

  constructor(db: Database, now: () => number, failures: readonly string[] = []) {
    this.#db = db;
    this.#inner = createFakePayPal({ now, failures, knownReceivers: knownFakeReceiver, state: this.#load() ?? undefined });
  }

  // ---- persistence -----------------------------------------------------------

  #load(): EmulatorState | null {
    const row = this.#db.prepare('SELECT doc FROM fake_paypal WHERE kind = ? AND id = ?').get(STATE_KIND, STATE_ID) as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as EmulatorState) : null;
  }

  #save(): void {
    this.#db
      .prepare('INSERT INTO fake_paypal (kind, id, doc) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET doc = excluded.doc')
      .run(STATE_KIND, STATE_ID, JSON.stringify(this.#inner.exportState()));
  }

  async #call<T>(fn: (p: EmulatedPayPal) => Promise<T>): Promise<T> {
    try {
      return await fn(this.#inner);
    } finally {
      this.#save();
    }
  }

  /** Forgets everything (the market was reset; the table was emptied with it). */
  reset(): void {
    this.#inner.emulator.reset();
  }

  // ---- simulated buyer and receivers (fake mode only) -------------------------

  async approveOrder(orderId: string, funding: CheckoutFunding, outcome: 'approve' | 'cancel' | 'decline'): Promise<{ orderId: string; status: string }> {
    try {
      return await this.#inner.approveOrder(orderId, funding, outcome);
    } finally {
      this.#save();
    }
  }

  /** Simulates the receiver claiming an UNCLAIMED payout item on PayPal's site. True when it was unclaimed. */
  claimPayoutItem(itemId: string): boolean {
    const item = this.#inner.exportState().payoutItems[itemId];
    if (!item || item.status !== 'UNCLAIMED') return false;
    this.#inner.claimPayoutItem(itemId);
    this.#save();
    return true;
  }

  /** Simulates PayPal finishing its review of a PENDING authorization (HMS_FAKE_FAIL authorize:pending). True when it was pending. */
  settlePendingAuthorization(authorizationId: string, to: 'CREATED' | 'DENIED'): boolean {
    const a = this.#inner.exportState().authorizations[authorizationId];
    if (!a || a.status !== 'PENDING') return false;
    this.#inner.settlePendingAuthorization(authorizationId, to);
    this.#save();
    return true;
  }

  /** Simulates PayPal finishing a PENDING capture (HMS_FAKE_FAIL capture:pending). True when it was pending. */
  completePendingCapture(captureId: string): boolean {
    const capture = this.#inner.exportState().captures[captureId];
    if (!capture || capture.status !== 'PENDING') return false;
    this.#inner.completePendingCapture(captureId);
    this.#save();
    return true;
  }

  /** Simulates the buyer opening a dispute on a capture. Returns the dispute id. */
  openDispute(captureId: string, opts?: { reason?: string; amountCents?: number; stage?: 'INQUIRY' | 'CHARGEBACK' }): string {
    const id = this.#inner.openDispute(captureId, opts);
    this.#save();
    return id;
  }

  // ---- test helpers ------------------------------------------------------------

  /** What PayPal holds for one authorization (null when unknown). */
  inspectAuthorization(id: string): { status: AuthorizationStatus; capturedCents: number; amountCents: number; supersededBy: string | null } | null {
    const s = this.#inner.exportState();
    const a = s.authorizations[id];
    if (!a) return null;
    const capturedCents = a.captureIds
      .map((c) => s.captures[c])
      .filter((c) => c !== undefined && c.status !== 'DECLINED' && c.status !== 'FAILED')
      .reduce((sum, c) => sum + (c?.amountCents ?? 0), 0);
    const child = Object.values(s.authorizations).find((x) => x.parentId === id);
    return { status: a.status, capturedCents, amountCents: a.amountCents, supersededBy: child?.id ?? null };
  }

  /** Number of captures PayPal accepted for one authorization. */
  captureCount(id: string): number {
    return this.#inner.exportState().authorizations[id]?.captureIds.length ?? 0;
  }

  /** What PayPal holds for one order: status, invoice id, its authorizations and the tracking numbers added to it. */
  inspectOrder(id: string): {
    status: string;
    invoiceId: string | null;
    authorizationIds: string[];
    trackers: { captureId: string; trackingNumber: string; carrierNameOther: string | null }[];
  } | null {
    const o = this.#inner.exportState().orders[id];
    if (!o) return null;
    return {
      status: o.status,
      invoiceId: o.invoiceId,
      authorizationIds: [...o.authorizationIds],
      trackers: o.trackers.map((t) => ({ captureId: t.captureId, trackingNumber: t.trackingNumber, carrierNameOther: t.carrierNameOther })),
    };
  }

  /** What PayPal holds for one capture: status, amount and how much of it was refunded (null when unknown). */
  inspectCapture(id: string): { status: string; amountCents: number; refundedCents: number } | null {
    const c = this.#inner.exportState().captures[id];
    return c ? { status: c.status, amountCents: c.amountCents, refundedCents: c.refundedCents } : null;
  }

  /** Every payout item PayPal created, oldest first. */
  payoutItems(): { itemId: string; senderItemId: string; receiver: string; amountCents: number; status: string }[] {
    const s = this.#inner.exportState();
    return Object.values(s.payoutItems).map((it) => ({ itemId: it.id, senderItemId: it.senderItemId, receiver: it.receiver, amountCents: it.amountCents, status: it.status }));
  }

  /** What PayPal holds for one payout item (null when unknown). */
  inspectPayoutItem(id: string): { status: string; receiver: string; amountCents: number } | null {
    const it = this.#inner.exportState().payoutItems[id];
    return it ? { status: it.status, receiver: it.receiver, amountCents: it.amountCents } : null;
  }

  // ---- PayPalPort ----------------------------------------------------------------

  createOrder(input: CreateOrderInput): Promise<OrderResult> {
    return this.#call((p) => p.createOrder(input));
  }

  authorizeOrder(orderId: string, requestId: string): Promise<AuthorizationResult> {
    return this.#call((p) => p.authorizeOrder(orderId, requestId));
  }

  getAuthorization(authorizationId: string): Promise<AuthorizationResult> {
    return this.#call((p) => p.getAuthorization(authorizationId));
  }

  captureAuthorization(authorizationId: string, input: CaptureInput): Promise<CaptureResult> {
    return this.#call((p) => p.captureAuthorization(authorizationId, input));
  }

  voidAuthorization(authorizationId: string, requestId: string): Promise<AuthorizationResult> {
    return this.#call((p) => p.voidAuthorization(authorizationId, requestId));
  }

  reauthorize(authorizationId: string, input: Idempotent & { amountCents: number }): Promise<AuthorizationResult> {
    return this.#call((p) => p.reauthorize(authorizationId, input));
  }

  getCapture(captureId: string): Promise<CaptureResult> {
    return this.#call((p) => p.getCapture(captureId));
  }

  refundCapture(captureId: string, input: RefundInput): Promise<RefundResult> {
    return this.#call((p) => p.refundCapture(captureId, input));
  }

  addTracking(orderId: string, input: TrackingInput): Promise<void> {
    return this.#call((p) => p.addTracking(orderId, input));
  }

  createPayout(input: PayoutInput): Promise<PayoutBatchResult> {
    return this.#call((p) => p.createPayout(input));
  }

  getPayoutBatch(batchId: string): Promise<PayoutBatchResult> {
    return this.#call((p) => p.getPayoutBatch(batchId));
  }

  cancelUnclaimedPayoutItem(itemId: string): Promise<PayoutBatchResult['items'][number]> {
    return this.#call((p) => p.cancelUnclaimedPayoutItem(itemId));
  }

  listDisputes(sinceMs: number): Promise<DisputeResult[]> {
    return this.#call((p) => p.listDisputes(sinceMs));
  }

  getDispute(disputeId: string): Promise<DisputeResult> {
    return this.#call((p) => p.getDispute(disputeId));
  }

  provideEvidence(disputeId: string, input: { note: string; files: { name: string; contentType: string; bytes: Uint8Array }[] }): Promise<DisputeResult> {
    return this.#call((p) => p.provideEvidence(disputeId, input));
  }

  acceptClaim(disputeId: string, note: string): Promise<DisputeResult> {
    return this.#call((p) => p.acceptClaim(disputeId, note));
  }

  adjudicate(disputeId: string, outcome: 'BUYER_FAVOR' | 'SELLER_FAVOR'): Promise<DisputeResult> {
    return this.#call((p) => p.adjudicate(disputeId, outcome));
  }

  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<boolean> {
    return this.#call((p) => p.verifyWebhook(headers, rawBody));
  }
}
