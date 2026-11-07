import type { Cents, FundingSource, RuntimeMode } from '@holdmyspot/shared';
import type {
  AuthorizationResult,
  CaptureInput,
  CaptureResult,
  CreateOrderInput,
  DisputeResult,
  Idempotent,
  PayoutBatchResult,
  PayoutInput,
  RefundInput,
  RefundResult,
  TrackingInput,
} from '@holdmyspot/shared/ports';
import { BRAND_NAME, INVOICE_PREFIX } from './constants.ts';
import { PayPalError, unexpectedResponse } from './errors.ts';
import type { PayPalHttp } from './http.ts';
import type { EvidenceInput, HmsPayPal, OrderDetails, OrderSummary, PayoutItemResult } from './types.ts';
import {
  arr,
  buildCaptureBody,
  buildEvidenceForm,
  buildOrderBody,
  buildPayoutBody,
  buildReauthorizeBody,
  buildRefundBody,
  buildTrackingBody,
  buildWebhookVerifyBody,
  fundingFrom,
  mapAuthorization,
  mapCapture,
  mapDispute,
  mapOrderDetails,
  mapOrderSummary,
  mapPayoutBatch,
  mapPayoutCreate,
  mapPayoutItem,
  mapRefund,
  obj,
  orderIdOfAuthorization,
  requestId,
  shipToFrom,
  str,
} from './wire.ts';

/**
 * PayPal REST client implementing PayPalPort (plus the reads in HmsPayPal).
 * Both adapters use it: sandbox.ts with the real network, fake.ts with the
 * in-process emulator. Our own narrow wrappers, because PayPal's Agent
 * Toolkit has no authorize, capture-of-authorization, void, reauthorize or
 * payouts tools (docs/PAYPAL-MAPPING.md section 9).
 */

export interface RestClientOptions {
  mode: RuntimeMode;
  http: PayPalHttp;
  /** PAYPAL_WEBHOOK_ID; without it verifyWebhook always answers false. */
  webhookId: string | null;
  invoicePrefix?: string;
  brandName?: string;
  /** send (default): orders carry payment_source.experience_context. omit: after probe G9, if v6 sessions refuse it. */
  paymentSource?: 'send' | 'omit';
  /** Clock for fields PayPal leaves out and for the dispute search window (market clock in fake mode). */
  now?: () => number;
}

interface OrderFacts {
  fundingSource: FundingSource | null;
  shipTo: AuthorizationResult['shipTo'];
}

const DAY = 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 5000;
const enc = encodeURIComponent;

/** True when a dispute list item's transactions name an invoice (else the dispute must be read in full). */
function summaryHasInvoices(summary: Record<string, unknown>): boolean {
  const txns = arr(summary.disputed_transactions);
  return txns.length > 0 && txns.every((t) => str(obj(t).invoice_number) !== null);
}

/** Our name for each PayPal call, used in logs and errors. */
export const OPS = {
  createOrder: 'orders.create',
  getOrder: 'orders.get',
  authorizeOrder: 'orders.authorize',
  track: 'orders.track',
  getAuthorization: 'authorizations.get',
  capture: 'authorizations.capture',
  void: 'authorizations.void',
  reauthorize: 'authorizations.reauthorize',
  getCapture: 'captures.get',
  refund: 'captures.refund',
  createPayout: 'payouts.create',
  getPayout: 'payouts.get',
  getPayoutItem: 'payouts.item',
  cancelPayoutItem: 'payouts.item.cancel',
  listDisputes: 'disputes.list',
  getDispute: 'disputes.get',
  evidence: 'disputes.evidence',
  acceptClaim: 'disputes.accept_claim',
  adjudicate: 'disputes.adjudicate',
  escalate: 'disputes.escalate',
  verifyWebhook: 'webhooks.verify',
} as const;

export class PayPalRestClient implements HmsPayPal {
  readonly mode: RuntimeMode;
  readonly #http: PayPalHttp;
  readonly #webhookId: string | null;
  readonly #prefix: string;
  readonly #brand: string;
  readonly #paymentSource: 'send' | 'omit';
  readonly #now: () => number;
  /** order id -> funding and ship-to seen at authorize time (GET authorization does not carry them). */
  readonly #facts = new Map<string, OrderFacts>();
  /** authorization id -> order id */
  readonly #authOrder = new Map<string, string>();

  constructor(o: RestClientOptions) {
    this.mode = o.mode;
    this.#http = o.http;
    this.#webhookId = o.webhookId && o.webhookId.trim() !== '' ? o.webhookId : null;
    this.#prefix = o.invoicePrefix ?? INVOICE_PREFIX;
    this.#brand = o.brandName ?? BRAND_NAME;
    this.#paymentSource = o.paymentSource ?? 'send';
    this.#now = o.now ?? Date.now;
  }

  // -------------------------------------------------------------------------
  // Orders v2
  // -------------------------------------------------------------------------

  async createOrder(input: CreateOrderInput): Promise<OrderSummary> {
    const json = buildOrderBody(input, { brandName: this.#brand, invoicePrefix: this.#prefix, paymentSource: this.#paymentSource });
    const res = await this.#http.request({ op: OPS.createOrder, method: 'POST', path: '/v2/checkout/orders', json, requestId: requestId(input.requestId) });
    return mapOrderSummary(res.data, res.debugId, OPS.createOrder);
  }

  async getOrder(orderId: string): Promise<OrderDetails> {
    const res = await this.#http.request({ op: OPS.getOrder, method: 'GET', path: `/v2/checkout/orders/${enc(orderId)}` });
    const details = mapOrderDetails(res.data, res.debugId, OPS.getOrder);
    if (details.fundingSource !== null) this.#remember(orderId, { fundingSource: details.fundingSource, shipTo: details.shipTo });
    for (const a of details.authorizations) this.#linkAuth(a.authorizationId, orderId);
    return details;
  }

  /**
   * POST /v2/checkout/orders/{id}/authorize after the buyer approved.
   * INSTRUMENT_DECLINED and ORDER_NOT_APPROVED throw PAYPAL_DECLINED with
   * `restartCheckout` set. If PayPal says the order is already authorized
   * (a retry under a new request id), the existing authorization is returned.
   */
  async authorizeOrder(orderId: string, reqId: string): Promise<AuthorizationResult> {
    try {
      const res = await this.#http.request({
        op: OPS.authorizeOrder,
        method: 'POST',
        path: `/v2/checkout/orders/${enc(orderId)}/authorize`,
        requestId: requestId(reqId),
      });
      return this.#authorizationFromOrder(res.data, res.debugId, orderId);
    } catch (err) {
      if (err instanceof PayPalError && err.issue === 'ORDER_ALREADY_AUTHORIZED') {
        const res = await this.#http.request({ op: OPS.getOrder, method: 'GET', path: `/v2/checkout/orders/${enc(orderId)}` });
        return this.#authorizationFromOrder(res.data, res.debugId, orderId);
      }
      throw err;
    }
  }

  /** POST /v2/checkout/orders/{id}/track with carrier OTHER. A tracker PayPal already has counts as done. */
  async addTracking(orderId: string, input: TrackingInput): Promise<void> {
    try {
      await this.#http.request({
        op: OPS.track,
        method: 'POST',
        path: `/v2/checkout/orders/${enc(orderId)}/track`,
        json: buildTrackingBody(input),
        requestId: requestId(input.requestId),
      });
    } catch (err) {
      if (err instanceof PayPalError && err.httpStatus === 422 && err.issue !== null && /DUPLICATE|ALREADY/.test(err.issue)) return;
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Payments v2: authorizations and captures
  // -------------------------------------------------------------------------

  async getAuthorization(authorizationId: string): Promise<AuthorizationResult> {
    const res = await this.#http.request({ op: OPS.getAuthorization, method: 'GET', path: `/v2/payments/authorizations/${enc(authorizationId)}` });
    return this.#mapAuth(res.data, res.debugId, OPS.getAuthorization, null);
  }

  async captureAuthorization(authorizationId: string, input: CaptureInput): Promise<CaptureResult> {
    const res = await this.#http.request({
      op: OPS.capture,
      method: 'POST',
      path: `/v2/payments/authorizations/${enc(authorizationId)}/capture`,
      json: buildCaptureBody(input, this.#prefix),
      requestId: requestId(input.requestId),
    });
    return mapCapture(res.data, res.debugId, this.#now(), OPS.capture, { authorizationId, amountCents: input.amountCents, finalCapture: input.finalCapture });
  }

  /** Releases what is left, also after partial captures. PayPal answers 200 with the authorization, or 204. */
  async voidAuthorization(authorizationId: string, reqId: string): Promise<AuthorizationResult> {
    const res = await this.#http.request({
      op: OPS.void,
      method: 'POST',
      path: `/v2/payments/authorizations/${enc(authorizationId)}/void`,
      requestId: requestId(reqId),
    });
    if (res.status === 204 || str(obj(res.data).id) === null) return this.getAuthorization(authorizationId);
    return this.#mapAuth(res.data, res.debugId, OPS.void, null);
  }

  /**
   * Day 4 to 29. Returns the NEW authorization. PayPal's docs say a
   * reauthorized payment cannot itself be reauthorized, so renewals pass the
   * original authorization id (probe G10 confirms on the sandbox).
   */
  async reauthorize(authorizationId: string, input: Idempotent & { amountCents: Cents }): Promise<AuthorizationResult> {
    const res = await this.#http.request({
      op: OPS.reauthorize,
      method: 'POST',
      path: `/v2/payments/authorizations/${enc(authorizationId)}/reauthorize`,
      json: buildReauthorizeBody(input.amountCents),
      requestId: requestId(input.requestId),
    });
    let parentOrder = this.#authOrder.get(authorizationId) ?? orderIdOfAuthorization(res.data);
    if (!parentOrder) {
      // The new authorization exists at PayPal now; find its order without ever failing the call.
      try {
        const parent = await this.#http.request({ op: OPS.getAuthorization, method: 'GET', path: `/v2/payments/authorizations/${enc(authorizationId)}` });
        parentOrder = orderIdOfAuthorization(parent.data);
      } catch {
        parentOrder = null;
      }
    }
    return this.#mapAuth(res.data, res.debugId, OPS.reauthorize, parentOrder, input.amountCents);
  }

  async getCapture(captureId: string): Promise<CaptureResult> {
    const res = await this.#http.request({ op: OPS.getCapture, method: 'GET', path: `/v2/payments/captures/${enc(captureId)}` });
    return mapCapture(res.data, res.debugId, this.#now(), OPS.getCapture);
  }

  async refundCapture(captureId: string, input: RefundInput): Promise<RefundResult> {
    const res = await this.#http.request({
      op: OPS.refund,
      method: 'POST',
      path: `/v2/payments/captures/${enc(captureId)}/refund`,
      json: buildRefundBody(input, this.#prefix),
      requestId: requestId(input.requestId),
    });
    return mapRefund(res.data, res.debugId, captureId, OPS.refund, input.amountCents);
  }

  // -------------------------------------------------------------------------
  // Payouts v1
  // -------------------------------------------------------------------------

  /** One batch per call; sender_batch_id is our idempotency key and is also sent as PayPal-Request-Id. */
  async createPayout(input: PayoutInput): Promise<PayoutBatchResult> {
    const res = await this.#http.request({
      op: OPS.createPayout,
      method: 'POST',
      path: '/v1/payments/payouts',
      json: buildPayoutBody(input),
      requestId: requestId(input.senderBatchId),
    });
    return mapPayoutCreate(res.data, input, res.debugId, OPS.createPayout);
  }

  async getPayoutBatch(batchId: string): Promise<PayoutBatchResult> {
    const res = await this.#http.request({ op: OPS.getPayout, method: 'GET', path: `/v1/payments/payouts/${enc(batchId)}` });
    return mapPayoutBatch(res.data, res.debugId, OPS.getPayout);
  }

  async getPayoutItem(itemId: string): Promise<PayoutItemResult> {
    const res = await this.#http.request({ op: OPS.getPayoutItem, method: 'GET', path: `/v1/payments/payouts-item/${enc(itemId)}` });
    return mapPayoutItem(res.data, res.debugId, OPS.getPayoutItem);
  }

  /** Only while UNCLAIMED; PayPal returns the money to the platform account. */
  async cancelUnclaimedPayoutItem(itemId: string): Promise<PayoutBatchResult['items'][number]> {
    const res = await this.#http.request({ op: OPS.cancelPayoutItem, method: 'POST', path: `/v1/payments/payouts-item/${enc(itemId)}/cancel` });
    const item = mapPayoutItem(res.data, res.debugId, OPS.cancelPayoutItem);
    return { itemId: item.itemId, senderItemId: item.senderItemId, status: item.status, amountCents: item.amountCents };
  }

  // -------------------------------------------------------------------------
  // Disputes v1
  // -------------------------------------------------------------------------

  /** Disputes created since `sinceMs` (PayPal searches at most 180 days back) on our HMS- invoices only. */
  async listDisputes(sinceMs: number): Promise<DisputeResult[]> {
    const start = Math.max(sinceMs, this.#now() - 179 * DAY);
    let path: string | null = `/v1/customer/disputes?start_time=${enc(new Date(start).toISOString())}&page_size=50`;
    const out: DisputeResult[] = [];
    for (let page = 0; path !== null && page < 5; page += 1) {
      const res = await this.#http.request({ op: OPS.listDisputes, method: 'GET', path });
      const data = obj(res.data);
      for (const item of arr(data.items)) {
        const summary = obj(item);
        const id = str(summary.dispute_id);
        if (!id) continue;
        // The sandbox's list items carry only buyer_transaction_id and the parties' ids in
        // disputed_transactions (seen 11-07): no invoice_number, no seller_transaction_id. Only a
        // summary that names our invoice can be used as is; anything else is read in full.
        const dispute = summaryHasInvoices(summary) ? mapDispute(summary, this.#now(), OPS.listDisputes) : await this.getDispute(id);
        if (dispute.invoiceIds.some((inv) => inv.startsWith(this.#prefix))) out.push(dispute);
      }
      path = this.#nextPage(data.links);
    }
    return out;
  }

  async getDispute(disputeId: string): Promise<DisputeResult> {
    const res = await this.#http.request({ op: OPS.getDispute, method: 'GET', path: `/v1/customer/disputes/${enc(disputeId)}` });
    return mapDispute(res.data, this.#now(), OPS.getDispute);
  }

  /** multipart/form-data: `input` (JSON) plus files named file1, file2... (PayPal's documented example; probe G7). */
  async provideEvidence(disputeId: string, input: EvidenceInput): Promise<DisputeResult> {
    await this.#http.request({ op: OPS.evidence, method: 'POST', path: `/v1/customer/disputes/${enc(disputeId)}/provide-evidence`, form: buildEvidenceForm(input) });
    return this.getDispute(disputeId);
  }

  async acceptClaim(disputeId: string, note: string): Promise<DisputeResult> {
    await this.#http.request({ op: OPS.acceptClaim, method: 'POST', path: `/v1/customer/disputes/${enc(disputeId)}/accept-claim`, json: { note } });
    return this.getDispute(disputeId);
  }

  /** Sandbox only: settles a dispute that is UNDER_REVIEW. */
  async adjudicate(disputeId: string, outcome: 'BUYER_FAVOR' | 'SELLER_FAVOR'): Promise<DisputeResult> {
    await this.#http.request({
      op: OPS.adjudicate,
      method: 'POST',
      path: `/v1/customer/disputes/${enc(disputeId)}/adjudicate`,
      json: { adjudication_outcome: outcome },
    });
    return this.getDispute(disputeId);
  }

  async escalateDispute(disputeId: string, note: string): Promise<DisputeResult> {
    await this.#http.request({ op: OPS.escalate, method: 'POST', path: `/v1/customer/disputes/${enc(disputeId)}/escalate`, json: { note } });
    return this.getDispute(disputeId);
  }

  // -------------------------------------------------------------------------
  // Webhooks and token
  // -------------------------------------------------------------------------

  /** POST /v1/notifications/verify-webhook-signature. False without PAYPAL_WEBHOOK_ID or with missing headers. */
  async verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<boolean> {
    if (!this.#webhookId) return false;
    const body = buildWebhookVerifyBody(headers, rawBody, this.#webhookId);
    if (body === null) return false;
    const res = await this.#http.request({ op: OPS.verifyWebhook, method: 'POST', path: '/v1/notifications/verify-webhook-signature', rawJson: body });
    return obj(res.data).verification_status === 'SUCCESS';
  }

  async tokenScopes(): Promise<string[]> {
    return this.#http.scopes();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #authorizationFromOrder(data: unknown, debugId: string | null, orderId: string): AuthorizationResult {
    const order = obj(data);
    const pu = obj(arr(order.purchase_units)[0]);
    const auths = arr(obj(pu.payments).authorizations);
    const first = auths[0];
    if (first === undefined) throw unexpectedResponse(OPS.authorizeOrder, 'no authorization in the order', debugId);
    const facts: OrderFacts = { fundingSource: fundingFrom(order.payment_source), shipTo: shipToFrom(pu) };
    this.#remember(orderId, facts);
    const result = mapAuthorization(first, { orderId, fundingSource: facts.fundingSource, shipTo: facts.shipTo, debugId, now: this.#now(), op: OPS.authorizeOrder });
    this.#linkAuth(result.authorizationId, orderId);
    return result;
  }

  /** Maps an authorization; funding and ship-to come from what this client saw at authorize time, else from the order. */
  async #mapAuth(data: unknown, debugId: string | null, op: string, orderHint: string | null, amountFallback?: Cents): Promise<AuthorizationResult> {
    const orderId = orderHint ?? orderIdOfAuthorization(data);
    let facts = orderId ? this.#facts.get(orderId) : undefined;
    if (orderId && !facts) {
      try {
        await this.getOrder(orderId);
        facts = this.#facts.get(orderId);
      } catch {
        facts = undefined; // Funding and ship-to are nice to have; the authorization itself is what matters.
      }
    }
    const result = mapAuthorization(data, {
      orderId,
      fundingSource: facts?.fundingSource ?? null,
      shipTo: facts?.shipTo ?? null,
      debugId,
      now: this.#now(),
      op,
      amountFallback,
    });
    if (result.orderId) this.#linkAuth(result.authorizationId, result.orderId);
    return result;
  }

  #remember(orderId: string, facts: OrderFacts): void {
    if (this.#facts.size >= CACHE_LIMIT) this.#facts.delete(this.#facts.keys().next().value as string);
    this.#facts.set(orderId, facts);
  }

  #linkAuth(authorizationId: string, orderId: string): void {
    if (this.#authOrder.size >= CACHE_LIMIT) this.#authOrder.delete(this.#authOrder.keys().next().value as string);
    this.#authOrder.set(authorizationId, orderId);
  }

  /** The next page of a list, as a path on the same host (PayPal returns absolute links). */
  #nextPage(links: unknown): string | null {
    for (const l of arr(links)) {
      const link = obj(l);
      if (link.rel !== 'next') continue;
      const href = str(link.href);
      if (!href) return null;
      try {
        const u = new URL(href);
        return u.pathname.startsWith('/v1/customer/disputes') ? `${u.pathname}${u.search}` : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}
