import { assertWholeCents, ContractError, fromPayPalValue, toPayPalValue } from '@holdmyspot/shared';
import type { Cents, FundingSource } from '@holdmyspot/shared';
import type {
  AuthorizationResult,
  AuthorizationStatus,
  CaptureInput,
  CaptureResult,
  CreateOrderInput,
  DisputeResult,
  OrderResult,
  PayoutBatchResult,
  PayoutInput,
  PayoutItemStatus,
  RefundInput,
  RefundResult,
  TrackingInput,
} from '@holdmyspot/shared/ports';
import { EVIDENCE_MAX_BYTES, EVIDENCE_TYPES, LIMITS } from './constants.ts';
import { unexpectedResponse } from './errors.ts';
import type { EvidenceInput, OrderDetails, OrderSummary, PayoutItemResult } from './types.ts';

/**
 * PayPal's wire format: request bodies built from PayPalPort inputs (checked
 * locally first, so a bad amount fails here instead of at PayPal) and PayPal
 * responses mapped back to PayPalPort results. Pure functions; tested with
 * fixtures in server/test/paypal/fixtures.
 */

export type Json = Record<string, unknown>;

export const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
export const obj = (v: unknown): Json => (isObj(v) ? v : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

export function time(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export const usd = (cents: Cents): Json => ({ currency_code: 'USD', value: toPayPalValue(cents) });

/** Cents from a PayPal money object ({value} with currency_code or currency). */
export function cents(money: unknown, op: string, what: string, debugId: string | null): Cents {
  const value = str(obj(money).value);
  if (value === null) throw unexpectedResponse(op, `missing ${what}`, debugId);
  try {
    return fromPayPalValue(value);
  } catch {
    throw unexpectedResponse(op, `unreadable ${what}`, debugId);
  }
}

function centsOrNull(money: unknown): Cents | null {
  const value = str(obj(money).value);
  if (value === null) return null;
  try {
    return fromPayPalValue(value);
  } catch {
    return null;
  }
}

function linkHref(links: unknown, rel: string): string | null {
  for (const l of arr(links)) {
    const o = obj(l);
    if (o.rel === rel) return str(o.href);
  }
  return null;
}

/** The id after `/<segment>/` in a link, for example the order id in an authorization's `up` link. */
function idFromLink(links: unknown, rel: string, segment: string): string | null {
  const href = linkHref(links, rel);
  if (!href) return null;
  const m = new RegExp(`/${segment}/([^/?#]+)`).exec(href);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function relatedId(raw: Json, key: string): string | null {
  return str(obj(obj(obj(raw.supplementary_data).related_ids))[key]);
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

function text(value: string, max: number, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ContractError('BAD_REQUEST', `${what} is required.`);
  if (value.length > max) throw new ContractError('BAD_REQUEST', `${what} is longer than PayPal allows (${max} characters).`, { length: value.length });
  return value;
}

function optionalText(value: string | null | undefined, max: number, what: string): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  return text(value, max, what);
}

function invoiceId(value: string, prefix: string): string {
  text(value, LIMITS.invoiceId, 'invoice_id');
  if (!value.startsWith(prefix)) throw new ContractError('BAD_REQUEST', `invoice_id must start with ${prefix}.`);
  return value;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function email(value: string, what: string): string {
  if (typeof value !== 'string' || !EMAIL.test(value)) throw new ContractError('BAD_REQUEST', `${what} must be an email address.`);
  return value;
}

/** Checks a PayPal-Request-Id (our ledger idempotency key). */
export function requestId(value: string): string {
  return text(value, LIMITS.requestId, 'PayPal-Request-Id');
}

export interface OrderBodyOptions {
  brandName: string;
  invoicePrefix: string;
  /** send: payment_source with experience_context (redirect and JS SDK). omit: let the JS SDK session decide (probe G9). */
  paymentSource: 'send' | 'omit';
}

/** POST /v2/checkout/orders, intent AUTHORIZE (docs/PAYPAL-MAPPING.md section 4). */
export function buildOrderBody(input: CreateOrderInput, o: OrderBodyOptions): Json {
  assertWholeCents(input.amountCents, 'Order amount');
  assertWholeCents(input.breakdown.itemTotalCents, 'Item total');
  assertWholeCents(input.breakdown.shippingCents, 'Shipping', { allowZero: true });
  if (input.breakdown.itemTotalCents + input.breakdown.shippingCents !== input.amountCents) {
    throw new ContractError('INVALID_AMOUNT', 'The order amount must equal the item total plus shipping.', {
      amountCents: input.amountCents,
      itemTotalCents: input.breakdown.itemTotalCents,
      shippingCents: input.breakdown.shippingCents,
    });
  }
  if (input.items.length === 0) throw new ContractError('BAD_REQUEST', 'An order needs at least one item line.');
  let lineTotal = 0;
  const items = input.items.map((it, i) => {
    if (!Number.isInteger(it.quantity) || it.quantity < 1) throw new ContractError('BAD_REQUEST', `Item ${i + 1} quantity must be a positive whole number.`);
    assertWholeCents(it.unitAmountCents, `Item ${i + 1} unit amount`);
    lineTotal += it.quantity * it.unitAmountCents;
    const item: Json = { name: text(it.name, LIMITS.itemName, `Item ${i + 1} name`), quantity: String(it.quantity), unit_amount: usd(it.unitAmountCents) };
    if (it.category) item.category = it.category;
    return item;
  });
  if (lineTotal !== input.breakdown.itemTotalCents) {
    throw new ContractError('INVALID_AMOUNT', 'The item lines must add up to the item total.', { lineTotal, itemTotalCents: input.breakdown.itemTotalCents });
  }
  const breakdown: Json = { item_total: usd(input.breakdown.itemTotalCents) };
  if (input.breakdown.shippingCents > 0) breakdown.shipping = usd(input.breakdown.shippingCents);

  const unit: Json = {
    reference_id: text(input.customId, LIMITS.referenceId, 'reference_id'),
    custom_id: text(input.customId, LIMITS.customId, 'custom_id'),
    invoice_id: invoiceId(input.invoiceId, o.invoicePrefix),
    description: text(input.description, LIMITS.description, 'description'),
    soft_descriptor: text(input.softDescriptor, LIMITS.softDescriptor, 'soft_descriptor'),
    amount: { ...usd(input.amountCents), breakdown },
    items,
  };
  // Ship mode leaves `shipping` out: PayPal uses the buyer's address on file (GET_FROM_FILE).
  if (input.shipping.type !== 'SHIPPING') unit.shipping = { type: input.shipping.type };

  const body: Json = { intent: 'AUTHORIZE', purchase_units: [unit] };
  if (o.paymentSource === 'send') {
    const shipping_preference = input.shipping.preference;
    if (input.funding === 'venmo') {
      body.payment_source = { venmo: { experience_context: { brand_name: o.brandName, shipping_preference } } };
    } else {
      // Pay Later rides on the paypal key.
      body.payment_source = {
        paypal: {
          experience_context: {
            brand_name: o.brandName,
            shipping_preference,
            user_action: 'CONTINUE',
            return_url: text(input.returnUrl, 2048, 'return_url'),
            cancel_url: text(input.cancelUrl, 2048, 'cancel_url'),
          },
        },
      };
    }
  }
  return body;
}

/** POST /v2/payments/authorizations/{id}/capture. */
export function buildCaptureBody(input: CaptureInput, invoicePrefix: string): Json {
  assertWholeCents(input.amountCents, 'Capture amount');
  const body: Json = {
    amount: usd(input.amountCents),
    invoice_id: invoiceId(input.invoiceId, invoicePrefix),
    final_capture: input.finalCapture,
  };
  const note = optionalText(input.noteToPayer, LIMITS.noteToPayer, 'note_to_payer');
  if (note) body.note_to_payer = note;
  const descriptor = optionalText(input.softDescriptor, LIMITS.softDescriptor, 'soft_descriptor');
  if (descriptor) body.soft_descriptor = descriptor;
  return body;
}

/** POST /v2/payments/authorizations/{id}/reauthorize. */
export function buildReauthorizeBody(amountCents: Cents): Json {
  assertWholeCents(amountCents, 'Reauthorization amount');
  return { amount: usd(amountCents) };
}

/** POST /v2/payments/captures/{id}/refund. */
export function buildRefundBody(input: RefundInput, invoicePrefix: string): Json {
  assertWholeCents(input.amountCents, 'Refund amount');
  const body: Json = { amount: usd(input.amountCents), invoice_id: invoiceId(input.invoiceId, invoicePrefix) };
  const note = optionalText(input.noteToPayer, LIMITS.noteToPayer, 'note_to_payer');
  if (note) body.note_to_payer = note;
  return body;
}

/** POST /v2/checkout/orders/{id}/track. Fictional carriers go as OTHER with carrier_name_other. */
export function buildTrackingBody(input: TrackingInput): Json {
  return {
    capture_id: text(input.captureId, 64, 'capture_id'),
    tracking_number: text(input.trackingNumber, LIMITS.trackingNumber, 'tracking_number'),
    carrier: 'OTHER',
    carrier_name_other: text(input.carrierName, LIMITS.carrierName, 'carrier name'),
    notify_payer: input.notifyPayer,
  };
}

/** POST /v1/payments/payouts (docs/PAYPAL-MAPPING.md section 5). */
export function buildPayoutBody(input: PayoutInput): Json {
  if (input.items.length === 0) throw new ContractError('BAD_REQUEST', 'A payout needs at least one item.');
  return {
    sender_batch_header: {
      sender_batch_id: text(input.senderBatchId, LIMITS.senderBatchId, 'sender_batch_id'),
      email_subject: text(input.emailSubject, LIMITS.emailSubject, 'email_subject'),
      email_message: text(input.emailMessage, LIMITS.emailMessage, 'email_message'),
      recipient_type: 'EMAIL',
    },
    items: input.items.map((it, i) => {
      assertWholeCents(it.amountCents, `Payout item ${i + 1} amount`);
      return {
        recipient_type: 'EMAIL',
        amount: { value: toPayPalValue(it.amountCents), currency: 'USD' },
        note: text(it.note, LIMITS.payoutNote, 'payout note'),
        sender_item_id: text(it.senderItemId, LIMITS.senderItemId, 'sender_item_id'),
        receiver: email(it.receiverEmail, 'Payout receiver'),
        notification_language: 'en-US',
      };
    }),
  };
}

/** multipart/form-data for POST /v1/customer/disputes/{id}/provide-evidence: an `input` JSON part plus files. */
export function buildEvidenceForm(input: EvidenceInput): FormData {
  const evidence: Json = {
    evidence_type: input.evidenceType ?? (input.tracking ? 'PROOF_OF_FULFILLMENT' : 'OTHER'),
    notes: text(input.note, LIMITS.disputeNote, 'evidence note'),
  };
  if (input.tracking) {
    evidence.evidence_info = {
      tracking_info: [
        {
          carrier_name: 'OTHER',
          carrier_name_other: text(input.tracking.carrierName, LIMITS.carrierName, 'carrier name'),
          tracking_number: text(input.tracking.trackingNumber, LIMITS.trackingNumber, 'tracking number'),
        },
      ],
    };
  }
  if (input.files.length > 0) evidence.documents = input.files.map((f) => ({ name: f.name }));
  const form = new FormData();
  form.append('input', new Blob([JSON.stringify({ evidences: [evidence] })], { type: 'application/json' }));
  input.files.forEach((f, i) => {
    if (!EVIDENCE_TYPES.includes(f.contentType)) {
      throw new ContractError('BAD_REQUEST', `PayPal evidence accepts JPEG, PNG, GIF or PDF files, not ${f.contentType}.`);
    }
    if (f.bytes.byteLength > EVIDENCE_MAX_BYTES) throw new ContractError('BAD_REQUEST', `Evidence file ${f.name} is larger than 10 MB.`);
    form.append(`file${i + 1}`, new Blob([f.bytes], { type: f.contentType }), f.name);
  });
  return form;
}

export const WEBHOOK_HEADERS = {
  authAlgo: 'paypal-auth-algo',
  certUrl: 'paypal-cert-url',
  transmissionId: 'paypal-transmission-id',
  transmissionSig: 'paypal-transmission-sig',
  transmissionTime: 'paypal-transmission-time',
} as const;

/**
 * Body for POST /v1/notifications/verify-webhook-signature. The raw event is
 * embedded byte for byte (re-serialising it can change the CRC32 PayPal checks).
 * Null when a header is missing, the certificate is not on a PayPal host, or
 * the body is not a JSON object.
 */
export function buildWebhookVerifyBody(headers: Record<string, string | undefined>, rawBody: string, webhookId: string): string | null {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (typeof v === 'string') h[k.toLowerCase()] = v;
  const authAlgo = h[WEBHOOK_HEADERS.authAlgo];
  const certUrl = h[WEBHOOK_HEADERS.certUrl];
  const transmissionId = h[WEBHOOK_HEADERS.transmissionId];
  const transmissionSig = h[WEBHOOK_HEADERS.transmissionSig];
  const transmissionTime = h[WEBHOOK_HEADERS.transmissionTime];
  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) return null;
  let host: string;
  try {
    const u = new URL(certUrl);
    if (u.protocol !== 'https:') return null;
    host = u.hostname;
  } catch {
    return null;
  }
  if (host !== 'paypal.com' && !host.endsWith('.paypal.com')) return null;
  const raw = rawBody.trim();
  try {
    if (!isObj(JSON.parse(raw))) return null;
  } catch {
    return null;
  }
  const q = JSON.stringify;
  return `{"auth_algo":${q(authAlgo)},"cert_url":${q(certUrl)},"transmission_id":${q(transmissionId)},"transmission_sig":${q(transmissionSig)},"transmission_time":${q(transmissionTime)},"webhook_id":${q(webhookId)},"webhook_event":${raw}}`;
}

// ---------------------------------------------------------------------------
// Response mappers
// ---------------------------------------------------------------------------

const ORDER_STATUSES: readonly OrderResult['status'][] = ['CREATED', 'APPROVED', 'COMPLETED', 'VOIDED', 'PAYER_ACTION_REQUIRED', 'SAVED'];
const AUTH_STATUSES: readonly AuthorizationStatus[] = ['CREATED', 'CAPTURED', 'PARTIALLY_CAPTURED', 'VOIDED', 'DENIED', 'PENDING', 'EXPIRED'];
const CAPTURE_STATUSES: readonly CaptureResult['status'][] = ['COMPLETED', 'PENDING', 'DECLINED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED'];
const REFUND_STATUSES: readonly RefundResult['status'][] = ['COMPLETED', 'PENDING', 'CANCELLED', 'FAILED'];
const BATCH_STATUSES: readonly PayoutBatchResult['batchStatus'][] = ['PENDING', 'PROCESSING', 'SUCCESS', 'DENIED', 'CANCELED'];
const ITEM_STATUSES: readonly PayoutItemStatus[] = [
  'SUCCESS',
  'UNCLAIMED',
  'PENDING',
  'FAILED',
  'RETURNED',
  'ONHOLD',
  'BLOCKED',
  'REFUNDED',
  'REVERSED',
  'DENIED',
  'CANCELED',
  'NEW',
];
const DISPUTE_STATUSES: readonly DisputeResult['status'][] = ['OPEN', 'WAITING_FOR_BUYER_RESPONSE', 'WAITING_FOR_SELLER_RESPONSE', 'UNDER_REVIEW', 'RESOLVED', 'OTHER'];
const DISPUTE_OUTCOMES: readonly NonNullable<DisputeResult['outcome']>[] = [
  'RESOLVED_BUYER_FAVOUR',
  'RESOLVED_SELLER_FAVOUR',
  'RESOLVED_WITH_PAYOUT',
  'CANCELED_BY_BUYER',
  'ACCEPTED',
  'DENIED',
];

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Which button paid: the key of `payment_source`. Pay Later shows up as `paypal`; the server knows the button. */
export function fundingFrom(paymentSource: unknown): FundingSource | null {
  const ps = obj(paymentSource);
  if ('venmo' in ps) return 'venmo';
  if ('paypal' in ps) return 'paypal';
  if ('card' in ps || 'apple_pay' in ps || 'google_pay' in ps) return 'card';
  return null;
}

/** The ship-to address of a purchase unit (ship mode), or null. */
export function shipToFrom(purchaseUnit: unknown): AuthorizationResult['shipTo'] {
  const address = obj(obj(obj(purchaseUnit).shipping).address);
  const country = str(address.country_code);
  if (!country) return null;
  return { country, region: str(address.admin_area_1), city: str(address.admin_area_2), postalCode: str(address.postal_code) };
}

export function approveUrlFrom(links: unknown): string | null {
  return linkHref(links, 'payer-action') ?? linkHref(links, 'approve');
}

export function mapOrderSummary(data: unknown, debugId: string | null, op = 'orders.create'): OrderSummary {
  const o = obj(data);
  const orderId = str(o.id);
  if (!orderId) throw unexpectedResponse(op, 'no order id', debugId);
  const status = str(o.status);
  if (!status || !(ORDER_STATUSES as readonly string[]).includes(status)) throw unexpectedResponse(op, `order status ${status ?? 'missing'}`, debugId);
  return { orderId, status: status as OrderResult['status'], debugId, approveUrl: approveUrlFrom(o.links) };
}

export interface AuthorizationContext {
  orderId: string | null;
  fundingSource: FundingSource | null;
  shipTo: AuthorizationResult['shipTo'];
  debugId: string | null;
  /** Used when PayPal leaves out create_time. */
  now: number;
  op: string;
}

/**
 * After a successful money call only the new object's own id is required;
 * other missing fields fall back to what we sent (or '' for an unknown order
 * id, which the server already has on the hold), so money that moved is never
 * reported as a failure because of a thin response.
 */
export function mapAuthorization(raw: unknown, ctx: AuthorizationContext & { amountFallback?: Cents }): AuthorizationResult {
  const a = obj(raw);
  const authorizationId = str(a.id);
  if (!authorizationId) throw unexpectedResponse(ctx.op, 'no authorization id', ctx.debugId);
  const orderId = ctx.orderId ?? relatedId(a, 'order_id') ?? idFromLink(a.links, 'up', 'orders') ?? '';
  const amount = centsOrNull(a.amount) ?? ctx.amountFallback ?? null;
  if (amount === null) throw unexpectedResponse(ctx.op, 'no authorization amount', ctx.debugId);
  return {
    authorizationId,
    orderId,
    status: pick(a.status, AUTH_STATUSES, 'PENDING'),
    amountCents: amount,
    createdAt: time(a.create_time) ?? time(a.update_time) ?? ctx.now,
    expiresAt: time(a.expiration_time),
    fundingSource: ctx.fundingSource ?? 'paypal',
    shipTo: ctx.shipTo,
    debugId: ctx.debugId,
  };
}

/** The order id an authorization belongs to, from supplementary_data or its `up` link. */
export function orderIdOfAuthorization(raw: unknown): string | null {
  const a = obj(raw);
  return relatedId(a, 'order_id') ?? idFromLink(a.links, 'up', 'orders');
}

export function mapCapture(
  raw: unknown,
  debugId: string | null,
  now: number,
  op = 'captures.get',
  sent: { authorizationId?: string; amountCents?: Cents; finalCapture?: boolean } = {},
): CaptureResult {
  const c = obj(raw);
  const captureId = str(c.id);
  if (!captureId) throw unexpectedResponse(op, 'no capture id', debugId);
  const authorizationId = relatedId(c, 'authorization_id') ?? idFromLink(c.links, 'up', 'authorizations') ?? sent.authorizationId ?? '';
  const amount = centsOrNull(c.amount) ?? sent.amountCents ?? null;
  if (amount === null) throw unexpectedResponse(op, 'no capture amount', debugId);
  return {
    captureId,
    authorizationId,
    status: pick(c.status, CAPTURE_STATUSES, 'PENDING'),
    amountCents: amount,
    finalCapture: bool(c.final_capture) ?? sent.finalCapture ?? false,
    paypalFeeCents: centsOrNull(obj(c.seller_receivable_breakdown).paypal_fee),
    createdAt: time(c.create_time) ?? time(c.update_time) ?? now,
    debugId,
  };
}

export function mapRefund(raw: unknown, debugId: string | null, captureIdFallback: string, op = 'captures.refund', amountFallback?: Cents): RefundResult {
  const r = obj(raw);
  const refundId = str(r.id);
  if (!refundId) throw unexpectedResponse(op, 'no refund id', debugId);
  const amount = centsOrNull(r.amount) ?? amountFallback ?? null;
  if (amount === null) throw unexpectedResponse(op, 'no refund amount', debugId);
  return {
    refundId,
    captureId: idFromLink(r.links, 'up', 'captures') ?? captureIdFallback,
    status: pick(r.status, REFUND_STATUSES, 'PENDING'),
    amountCents: amount,
    debugId,
  };
}

/**
 * PayPal tracker ids are "<captureId>-<trackingNumber>", and either part may
 * contain dashes. Prefer a capture id known from the same order; else PayPal's
 * 17-character capture id format; else the first dash.
 */
export function splitTrackerId(id: string | null, captureIds: readonly string[]): { captureId: string; trackingNumber: string } | null {
  if (!id) return null;
  const known = captureIds.find((c) => id.startsWith(`${c}-`) && id.length > c.length + 1);
  if (known) return { captureId: known, trackingNumber: id.slice(known.length + 1) };
  const m = /^([A-Z0-9]{17})-(.+)$/.exec(id);
  if (m?.[1] && m[2]) return { captureId: m[1], trackingNumber: m[2] };
  const dash = id.indexOf('-');
  return dash > 0 && dash < id.length - 1 ? { captureId: id.slice(0, dash), trackingNumber: id.slice(dash + 1) } : null;
}

export function mapOrderDetails(data: unknown, debugId: string | null, op = 'orders.get'): OrderDetails {
  const o = obj(data);
  const summary = mapOrderSummary(o, debugId, op);
  const pu = obj(arr(o.purchase_units)[0]);
  const payments = obj(pu.payments);
  const authorizations = arr(payments.authorizations).flatMap((x) => {
    const a = obj(x);
    const authorizationId = str(a.id);
    if (!authorizationId) return [];
    return [
      {
        authorizationId,
        status: pick(a.status, AUTH_STATUSES, 'PENDING'),
        amountCents: centsOrNull(a.amount) ?? 0,
        createdAt: time(a.create_time),
        expiresAt: time(a.expiration_time),
      },
    ];
  });
  const captures = arr(payments.captures).flatMap((x) => {
    const c = obj(x);
    const captureId = str(c.id);
    if (!captureId) return [];
    return [{ captureId, status: pick(c.status, CAPTURE_STATUSES, 'PENDING'), amountCents: centsOrNull(c.amount) ?? 0, finalCapture: bool(c.final_capture) }];
  });
  const trackers = arr(obj(pu.shipping).trackers).flatMap((x) => {
    const t = obj(x);
    const split = splitTrackerId(str(t.id), captures.map((c) => c.captureId));
    const trackingNumber = str(t.tracking_number) ?? split?.trackingNumber ?? null;
    if (!trackingNumber) return [];
    return [{ trackingNumber, carrierName: str(t.carrier_name_other) ?? str(t.carrier), captureId: str(t.capture_id) ?? split?.captureId ?? null, status: str(t.status) }];
  });
  return {
    orderId: summary.orderId,
    status: summary.status,
    intent: str(o.intent),
    invoiceId: str(pu.invoice_id),
    customId: str(pu.custom_id),
    amountCents: centsOrNull(pu.amount),
    approveUrl: summary.approveUrl,
    fundingSource: fundingFrom(o.payment_source),
    shipTo: shipToFrom(pu),
    authorizations,
    captures,
    trackers,
    debugId,
  };
}

/** The payout create response has no items yet: they start PENDING with no PayPal item id. */
export function mapPayoutCreate(data: unknown, input: PayoutInput, debugId: string | null, op = 'payouts.create'): PayoutBatchResult {
  const header = obj(obj(data).batch_header);
  const batchId = str(header.payout_batch_id);
  if (!batchId) throw unexpectedResponse(op, 'no payout batch id', debugId);
  return {
    batchId,
    batchStatus: pick(header.batch_status, BATCH_STATUSES, 'PENDING'),
    items: input.items.map((it) => ({ itemId: null, senderItemId: it.senderItemId, status: 'PENDING' as const, amountCents: it.amountCents })),
    debugId,
  };
}

export function mapPayoutBatch(data: unknown, debugId: string | null, op = 'payouts.get'): PayoutBatchResult {
  const d = obj(data);
  const header = obj(d.batch_header);
  const batchId = str(header.payout_batch_id);
  if (!batchId) throw unexpectedResponse(op, 'no payout batch id', debugId);
  return {
    batchId,
    batchStatus: pick(header.batch_status, BATCH_STATUSES, 'PENDING'),
    items: arr(d.items).map((x) => {
      const it = obj(x);
      const inner = obj(it.payout_item);
      return {
        itemId: str(it.payout_item_id),
        senderItemId: str(inner.sender_item_id) ?? '',
        status: pick(it.transaction_status, ITEM_STATUSES, 'PENDING'),
        amountCents: centsOrNull(inner.amount) ?? 0,
        feeCents: centsOrNull(it.payout_item_fee),
      };
    }),
    debugId,
  };
}

export function mapPayoutItem(data: unknown, debugId: string | null, op = 'payouts.item'): PayoutItemResult {
  const it = obj(data);
  const itemId = str(it.payout_item_id);
  if (!itemId) throw unexpectedResponse(op, 'no payout item id', debugId);
  const inner = obj(it.payout_item);
  return {
    itemId,
    batchId: str(it.payout_batch_id),
    senderItemId: str(inner.sender_item_id) ?? '',
    status: pick(it.transaction_status, ITEM_STATUSES, 'PENDING'),
    amountCents: centsOrNull(inner.amount) ?? 0,
    receiver: str(inner.receiver),
    transactionId: str(it.transaction_id),
    errorName: str(obj(it.errors).name),
    debugId,
  };
}

export function mapDispute(data: unknown, now: number, op = 'disputes.get'): DisputeResult {
  const d = obj(data);
  const disputeId = str(d.dispute_id);
  if (!disputeId) throw unexpectedResponse(op, 'no dispute id', null);
  const txns = arr(d.disputed_transactions).map(obj);
  const outcomeCode = str(obj(d.dispute_outcome).outcome_code);
  const createdAt = time(d.create_time) ?? now;
  return {
    disputeId,
    captureIds: txns.map((t) => str(t.seller_transaction_id)).filter((s): s is string => s !== null),
    invoiceIds: txns.map((t) => str(t.invoice_number)).filter((s): s is string => s !== null),
    reason: str(d.reason) ?? 'UNKNOWN',
    status: pick(d.status, DISPUTE_STATUSES, 'OTHER'),
    outcome: outcomeCode && (DISPUTE_OUTCOMES as readonly string[]).includes(outcomeCode) ? (outcomeCode as NonNullable<DisputeResult['outcome']>) : null,
    amountCents: centsOrNull(d.dispute_amount) ?? 0,
    createdAt,
    updatedAt: time(d.update_time) ?? createdAt,
  };
}
