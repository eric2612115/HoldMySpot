import { createHmac } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { ContractError, DAY_MS, fromPayPalValue, toPayPalValue } from '@holdmyspot/shared';
import type { CheckoutFunding } from '@holdmyspot/shared';
import type { PayoutItemStatus } from '@holdmyspot/shared/ports';
import { SANDBOX_BASE_URL } from './constants.ts';

/**
 * An in-process stand-in for the PayPal sandbox REST API, served through a
 * `fetch` function. The fake adapter (fake.ts) runs the real REST client
 * against it, so fake mode and offline tests exercise the same request
 * building, response mapping, retries and error mapping as the sandbox.
 *
 * It copies PayPal's rules (docs/PAYPAL-MAPPING.md section 10):
 * - orders must be approved (approveOrder) before authorize;
 * - the 3-day honor period and 29-day validity run on the injected clock
 *   (the market clock), so a renewal can be demoed;
 * - captures are accepted up to 115% of the authorization, like PayPal, so
 *   our own 100% limit is what stops over-capture in the server's tests;
 * - a final capture releases the rest; voids work after partial captures;
 *   reauthorize only from day 4 to 29, at most 115% and +$75, new id, and a
 *   reauthorized payment cannot itself be reauthorized;
 * - payouts succeed for known receivers and stay UNCLAIMED for unknown ones;
 * - a repeated PayPal-Request-Id returns the first result;
 * - failures can be injected (HMS_FAKE_FAIL, see parseFailures).
 *
 * Ids are deterministic: FAKE-ORDER-0001, FAKE-AUTH-0001, FAKE-CAP-0001,
 * FAKE-BATCH-0001, FAKE-ITEM-0001, FAKE-REFUND-0001, FAKE-DISPUTE-0001.
 * Issue names starting with FAKE_ are this emulator's own; PayPal's real
 * answer for those cases is recorded by the sandbox gates.
 */

/** The emulator's built-in client credentials. Not secrets: they only open this in-process fake. */
export const FAKE_CLIENT_ID = 'FAKE-CLIENT-ID';
export const FAKE_CLIENT_SECRET = 'FAKE-CLIENT-SECRET';

export const FAKE_SCOPES: readonly string[] = [
  'https://uri.paypal.com/services/payments/payment/authcapture',
  'https://uri.paypal.com/services/payments/refund',
  'https://uri.paypal.com/payments/payouts',
  'https://uri.paypal.com/services/disputes/read-seller',
  'https://uri.paypal.com/services/disputes/update-seller',
  'https://uri.paypal.com/services/shipping/trackers/readwrite',
  'https://uri.paypal.com/services/applications/webhooks',
  'openid',
];

const FAKE_WEBHOOK_KEY = 'holdmyspot-fake-webhook-signing-key';
const FAKE_CERT_URL = 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-FAKE-0001';
const FAKE_APPROVE_URL = 'https://fake-paypal.invalid/checkoutnow';
const HONOR_DAYS = 3;
const VALIDITY_DAYS = 29;
const OVERAGE_BPS = 11_500;
const REAUTH_MAX_INCREASE_CENTS = 7_500;
/** PayPal does not publish its capture count limit; the emulator uses 10. */
const MAX_CAPTURES = 10;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown): Json => (isObj(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const usd = (cents: number): Json => ({ currency_code: 'USD', value: toPayPalValue(cents) });
const payoutUsd = (cents: number): Json => ({ currency: 'USD', value: toPayPalValue(cents) });
const link = (path: string, rel: string, method = 'GET'): Json => ({ href: `${SANDBOX_BASE_URL}${path}`, rel, method });

/** PayPal-style timestamp: ISO 8601 in UTC without milliseconds. */
export function paypalTime(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// State (plain JSON, so the server can persist it and reload it)
// ---------------------------------------------------------------------------

type OrderStatus = 'CREATED' | 'PAYER_ACTION_REQUIRED' | 'APPROVED' | 'COMPLETED' | 'VOIDED';
type AuthStatus = 'CREATED' | 'PARTIALLY_CAPTURED' | 'CAPTURED' | 'VOIDED' | 'DENIED' | 'PENDING' | 'EXPIRED';
type CaptureStatus = 'COMPLETED' | 'PENDING' | 'DECLINED' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED';

export interface EmShipTo {
  fullName: string;
  line1: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
}

/** A fictional US address used when an approved ship-mode order needs one. */
export const DEFAULT_SHIP_TO: EmShipTo = {
  fullName: 'Test Buyer',
  line1: '1 Example Street',
  city: 'New York',
  region: 'NY',
  postalCode: '10001',
  countryCode: 'US',
};

interface EmOrder {
  id: string;
  status: OrderStatus;
  createdAt: number;
  updatedAt: number;
  referenceId: string | null;
  customId: string | null;
  invoiceId: string | null;
  description: string | null;
  softDescriptor: string | null;
  amountCents: number;
  itemTotalCents: number | null;
  shippingCents: number | null;
  items: Json[];
  shippingType: string | null;
  shippingPreference: string;
  sourceKey: 'paypal' | 'venmo' | null;
  approval: { funding: CheckoutFunding; decline: boolean; shipTo: EmShipTo | null; payerId: string } | null;
  authorizationIds: string[];
  trackers: { id: string; captureId: string; trackingNumber: string; carrier: string; carrierNameOther: string | null; notifyPayer: boolean; createdAt: number }[];
}

interface EmAuthorization {
  id: string;
  orderId: string;
  /** Set on a reauthorization: the authorization it renewed. */
  parentId: string | null;
  amountCents: number;
  status: AuthStatus;
  createdAt: number;
  updatedAt: number;
  /** Validity end, counted from the original authorization. */
  expiresAt: number;
  invoiceId: string | null;
  customId: string | null;
  captureIds: string[];
}

interface EmCapture {
  id: string;
  authorizationId: string;
  orderId: string;
  amountCents: number;
  refundedCents: number;
  status: CaptureStatus;
  finalCapture: boolean;
  invoiceId: string | null;
  noteToPayer: string | null;
  createdAt: number;
  updatedAt: number;
}

interface EmRefund {
  id: string;
  captureId: string;
  amountCents: number;
  invoiceId: string | null;
  noteToPayer: string | null;
  createdAt: number;
}

interface EmBatch {
  id: string;
  senderBatchId: string;
  emailSubject: string | null;
  emailMessage: string | null;
  createdAt: number;
  itemIds: string[];
}

interface EmPayoutItem {
  id: string;
  batchId: string;
  senderItemId: string;
  receiver: string;
  amountCents: number;
  note: string | null;
  status: PayoutItemStatus;
  transactionId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface EmDispute {
  id: string;
  captureId: string;
  invoiceId: string | null;
  customId: string | null;
  reason: string;
  status: 'OPEN' | 'WAITING_FOR_BUYER_RESPONSE' | 'WAITING_FOR_SELLER_RESPONSE' | 'UNDER_REVIEW' | 'RESOLVED';
  stage: 'INQUIRY' | 'CHARGEBACK';
  outcome: string | null;
  amountCents: number;
  evidenceCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface EmulatorState {
  version: 1;
  counters: Record<string, number>;
  orders: Record<string, EmOrder>;
  authorizations: Record<string, EmAuthorization>;
  captures: Record<string, EmCapture>;
  refunds: Record<string, EmRefund>;
  batches: Record<string, EmBatch>;
  payoutItems: Record<string, EmPayoutItem>;
  disputes: Record<string, EmDispute>;
  /** PayPal-Request-Id replays: "<path>#<request id>" -> first 2xx response. */
  replays: Record<string, { status: number; body: unknown }>;
}

function emptyState(): EmulatorState {
  return { version: 1, counters: {}, orders: {}, authorizations: {}, captures: {}, refunds: {}, batches: {}, payoutItems: {}, disputes: {}, replays: {} };
}

// ---------------------------------------------------------------------------
// Failure injection (HMS_FAKE_FAIL)
// ---------------------------------------------------------------------------

export type FailOp = 'oauth' | 'create' | 'get' | 'authorize' | 'capture' | 'void' | 'reauthorize' | 'refund' | 'track' | 'payout' | 'dispute' | 'verify' | 'any';
export type FailEffect = 'unavailable' | 'ratelimit' | 'lost' | 'decline' | 'pending' | 'unclaimed' | 'failed' | 'expired';

export interface FailRule {
  op: FailOp;
  effect: FailEffect;
  /** Infinity for every call. */
  remaining: number;
}

const FAIL_OPS: readonly FailOp[] = ['oauth', 'create', 'get', 'authorize', 'capture', 'void', 'reauthorize', 'refund', 'track', 'payout', 'dispute', 'verify', 'any'];
const FAIL_EFFECTS: readonly FailEffect[] = ['unavailable', 'ratelimit', 'lost', 'decline', 'pending', 'unclaimed', 'failed', 'expired'];

/**
 * Parses HMS_FAKE_FAIL rules, comma-separated `<op>:<effect>[:<count>|:*]`.
 * `once` is `unavailable` one time, `always` is `unavailable` every time.
 * Examples: `capture:once`, `payout:unclaimed`, `payout:unclaimed:*`,
 * `capture:lost` (PayPal applies it, the response is lost; the retry with the
 * same request id gets the first result), `authorize:decline`, `any:ratelimit:2`.
 */
export function parseFailures(spec: string | readonly string[] | null | undefined): FailRule[] {
  const tokens = (typeof spec === 'string' ? spec.split(',') : [...(spec ?? [])]).map((t) => t.trim()).filter(Boolean);
  return tokens.map((token) => {
    const [opRaw, effectRaw, countRaw] = token.split(':');
    const op = opRaw as FailOp;
    if (!FAIL_OPS.includes(op)) throw new Error(`HMS_FAKE_FAIL: unknown call "${opRaw}" in "${token}".`);
    let effect: FailEffect;
    let remaining = 1;
    if (effectRaw === 'once') effect = 'unavailable';
    else if (effectRaw === 'always') {
      effect = 'unavailable';
      remaining = Number.POSITIVE_INFINITY;
    } else if (FAIL_EFFECTS.includes(effectRaw as FailEffect)) effect = effectRaw as FailEffect;
    else throw new Error(`HMS_FAKE_FAIL: unknown effect "${effectRaw ?? ''}" in "${token}".`);
    if (countRaw === '*') remaining = Number.POSITIVE_INFINITY;
    else if (countRaw !== undefined) {
      const n = Number(countRaw);
      if (!Number.isInteger(n) || n < 1) throw new Error(`HMS_FAKE_FAIL: bad count in "${token}".`);
      remaining = n;
    }
    return { op, effect, remaining };
  });
}

// ---------------------------------------------------------------------------
// Emulator
// ---------------------------------------------------------------------------

class EmError extends Error {
  readonly status: number;
  readonly paypalName: string;
  readonly issue: string | null;
  readonly field: string | null;
  constructor(status: number, paypalName: string, issue: string | null, description: string, field: string | null = null) {
    super(description);
    this.status = status;
    this.paypalName = paypalName;
    this.issue = issue;
    this.field = field;
  }
}

const unprocessable = (issue: string, description: string) => new EmError(422, 'UNPROCESSABLE_ENTITY', issue, description);
const invalid = (issue: string, description: string, field: string | null = null) => new EmError(400, 'INVALID_REQUEST', issue, description, field);
const notFound = () => new EmError(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'Specified resource ID does not exist. Please check the resource ID and try again.');

interface EmResult {
  status: number;
  body: unknown;
}

interface Route {
  method: 'GET' | 'POST';
  re: RegExp;
  op: FailOp;
  name: string;
}

const ROUTES: readonly Route[] = [
  { method: 'POST', re: /^\/v2\/checkout\/orders$/, op: 'create', name: 'createOrder' },
  { method: 'GET', re: /^\/v2\/checkout\/orders\/([^/]+)$/, op: 'get', name: 'getOrder' },
  { method: 'POST', re: /^\/v2\/checkout\/orders\/([^/]+)\/authorize$/, op: 'authorize', name: 'authorizeOrder' },
  { method: 'POST', re: /^\/v2\/checkout\/orders\/([^/]+)\/track$/, op: 'track', name: 'track' },
  { method: 'GET', re: /^\/v2\/payments\/authorizations\/([^/]+)$/, op: 'get', name: 'getAuthorization' },
  { method: 'POST', re: /^\/v2\/payments\/authorizations\/([^/]+)\/capture$/, op: 'capture', name: 'capture' },
  { method: 'POST', re: /^\/v2\/payments\/authorizations\/([^/]+)\/void$/, op: 'void', name: 'void' },
  { method: 'POST', re: /^\/v2\/payments\/authorizations\/([^/]+)\/reauthorize$/, op: 'reauthorize', name: 'reauthorize' },
  { method: 'GET', re: /^\/v2\/payments\/captures\/([^/]+)$/, op: 'get', name: 'getCapture' },
  { method: 'POST', re: /^\/v2\/payments\/captures\/([^/]+)\/refund$/, op: 'refund', name: 'refund' },
  { method: 'GET', re: /^\/v2\/payments\/refunds\/([^/]+)$/, op: 'get', name: 'getRefund' },
  { method: 'POST', re: /^\/v1\/payments\/payouts$/, op: 'payout', name: 'createPayout' },
  { method: 'GET', re: /^\/v1\/payments\/payouts\/([^/]+)$/, op: 'get', name: 'getPayout' },
  { method: 'GET', re: /^\/v1\/payments\/payouts-item\/([^/]+)$/, op: 'get', name: 'getPayoutItem' },
  { method: 'POST', re: /^\/v1\/payments\/payouts-item\/([^/]+)\/cancel$/, op: 'payout', name: 'cancelPayoutItem' },
  { method: 'GET', re: /^\/v1\/customer\/disputes$/, op: 'get', name: 'listDisputes' },
  { method: 'GET', re: /^\/v1\/customer\/disputes\/([^/]+)$/, op: 'get', name: 'getDispute' },
  { method: 'POST', re: /^\/v1\/customer\/disputes\/([^/]+)\/provide-evidence$/, op: 'dispute', name: 'evidence' },
  { method: 'POST', re: /^\/v1\/customer\/disputes\/([^/]+)\/accept-claim$/, op: 'dispute', name: 'acceptClaim' },
  { method: 'POST', re: /^\/v1\/customer\/disputes\/([^/]+)\/adjudicate$/, op: 'dispute', name: 'adjudicate' },
  { method: 'POST', re: /^\/v1\/customer\/disputes\/([^/]+)\/escalate$/, op: 'dispute', name: 'escalate' },
  { method: 'POST', re: /^\/v1\/notifications\/verify-webhook-signature$/, op: 'verify', name: 'verifyWebhook' },
];

export interface EmulatorOptions {
  /** PayPal's clock: the market clock in fake mode. Default: real time. */
  now?: () => number;
  /** HMS_FAKE_FAIL rules (string or the server's comma-split list). */
  failures?: string | readonly string[];
  /** Payout receivers that succeed; anyone else stays UNCLAIMED. Default: *@holdmyspot.test and sandbox *.example.com. */
  knownReceivers?: readonly string[] | ((email: string) => boolean);
  /** Enables webhook verification (must match the client's webhook id). */
  webhookId?: string | null;
  state?: EmulatorState;
  merchantEmail?: string;
  merchantId?: string;
  buyerEmail?: string;
}

const DEFAULT_KNOWN = (email: string) => /@holdmyspot\.test$/i.test(email) || /@(business|personal)\.example\.com$/i.test(email);

export class PayPalEmulator {
  #state: EmulatorState;
  readonly #now: () => number;
  readonly #rules: FailRule[];
  readonly #known: (email: string) => boolean;
  readonly #webhookId: string | null;
  readonly #merchantEmail: string;
  readonly #merchantId: string;
  readonly #buyerEmail: string;
  readonly #tokens = new Set<string>();
  #tokenCount = 0;

  constructor(o: EmulatorOptions = {}) {
    this.#state = o.state ? structuredClone(o.state) : emptyState();
    this.#now = o.now ?? Date.now;
    this.#rules = parseFailures(o.failures);
    const known = o.knownReceivers;
    this.#known = typeof known === 'function' ? known : known ? (e: string) => known.some((k) => k.toLowerCase() === e.toLowerCase()) : DEFAULT_KNOWN;
    this.#webhookId = o.webhookId && o.webhookId.trim() !== '' ? o.webhookId : null;
    this.#merchantEmail = o.merchantEmail ?? 'merchant@holdmyspot.test';
    this.#merchantId = o.merchantId ?? 'FAKEMERCHANT01';
    this.#buyerEmail = o.buyerEmail ?? 'buyer@holdmyspot.test';
  }

  /** A fetch that answers PayPal sandbox REST calls in process. Never touches the network. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== SANDBOX_BASE_URL) throw new TypeError(`fake PayPal: refusing ${url.origin}`);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body ?? null;
    try {
      return await this.#handle(method, url, headers, body);
    } catch (err) {
      if (err instanceof EmError) return this.#error(err);
      throw err;
    }
  };

  // -------------------------------------------------------------------------
  // Controls (fake mode only)
  // -------------------------------------------------------------------------

  /** The simulated buyer approval behind POST /api/fake/paypal/orders/:orderId/approve. */
  approveOrder(orderId: string, funding: CheckoutFunding, outcome: 'approve' | 'cancel' | 'decline', shipTo?: EmShipTo | null): { orderId: string; status: string } {
    const o = this.#state.orders[orderId];
    if (!o) throw new ContractError('NOT_FOUND', `No fake PayPal order ${orderId}.`);
    if (outcome === 'cancel' || (o.status !== 'CREATED' && o.status !== 'PAYER_ACTION_REQUIRED')) return { orderId, status: o.status };
    const ships = o.shippingPreference !== 'NO_SHIPPING' && (o.shippingType === null || o.shippingType === 'SHIPPING');
    o.approval = { funding, decline: outcome === 'decline', shipTo: ships ? (shipTo ?? DEFAULT_SHIP_TO) : null, payerId: this.#id('PAYER') };
    o.status = 'APPROVED';
    o.updatedAt = this.#now();
    return { orderId, status: o.status };
  }

  /** Simulates the buyer opening a dispute on a capture (what the owner does on sandbox.paypal.com). */
  openDispute(captureId: string, opts: { reason?: string; amountCents?: number } = {}): string {
    const c = this.#state.captures[captureId];
    if (!c) throw new ContractError('NOT_FOUND', `No fake PayPal capture ${captureId}.`);
    const order = this.#state.orders[c.orderId];
    const id = this.#id('DISPUTE');
    const now = this.#now();
    this.#state.disputes[id] = {
      id,
      captureId,
      invoiceId: c.invoiceId,
      customId: order?.customId ?? null,
      reason: opts.reason ?? 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      status: 'WAITING_FOR_SELLER_RESPONSE',
      stage: 'INQUIRY',
      outcome: null,
      amountCents: opts.amountCents ?? c.amountCents - c.refundedCents,
      evidenceCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    return id;
  }

  /** Simulates the receiver accepting an UNCLAIMED payout. */
  claimPayoutItem(itemId: string): void {
    const it = this.#state.payoutItems[itemId];
    if (!it) throw new ContractError('NOT_FOUND', `No fake PayPal payout item ${itemId}.`);
    if (it.status === 'UNCLAIMED') {
      it.status = 'SUCCESS';
      it.updatedAt = this.#now();
    }
  }

  /** Moves a PENDING capture (HMS_FAKE_FAIL capture:pending) to COMPLETED. */
  completePendingCapture(captureId: string): void {
    const c = this.#state.captures[captureId];
    if (!c) throw new ContractError('NOT_FOUND', `No fake PayPal capture ${captureId}.`);
    if (c.status === 'PENDING') {
      c.status = 'COMPLETED';
      c.updatedAt = this.#now();
    }
  }

  /** A PayPal-shaped webhook event envelope. */
  makeWebhookEvent(eventType: string, resource: Json, resourceType = 'checkout-order'): Json {
    const now = this.#now();
    return {
      id: `WH-${this.#id('EVENT')}`,
      event_version: '1.0',
      create_time: paypalTime(now),
      resource_type: resourceType,
      resource_version: '2.0',
      event_type: eventType,
      summary: eventType,
      resource,
    };
  }

  /** Signs an event the way the emulator's verify-webhook-signature checks it. Needs a webhook id. */
  signWebhook(event: Json): { headers: Record<string, string>; rawBody: string } {
    if (!this.#webhookId) throw new Error('fake PayPal: set webhookId to sign webhook events.');
    const rawBody = JSON.stringify(event);
    const transmissionId = this.#id('TX');
    const transmissionTime = paypalTime(this.#now());
    return {
      rawBody,
      headers: {
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': FAKE_CERT_URL,
        'paypal-transmission-id': transmissionId,
        'paypal-transmission-sig': this.#signature(transmissionId, transmissionTime, this.#webhookId, rawBody),
        'paypal-transmission-time': transmissionTime,
      },
    };
  }

  /** A deep copy of everything, for persisting fake mode across restarts. */
  exportState(): EmulatorState {
    return structuredClone(this.#state);
  }

  reset(state?: EmulatorState): void {
    this.#state = state ? structuredClone(state) : emptyState();
  }

  // -------------------------------------------------------------------------
  // Request handling
  // -------------------------------------------------------------------------

  async #handle(method: string, url: URL, headers: Headers, rawBody: unknown): Promise<Response> {
    const path = url.pathname;
    if (method === 'POST' && path === '/v1/oauth2/token') return this.#oauth(headers, rawBody);

    const auth = headers.get('authorization') ?? '';
    if (!auth.startsWith('Bearer ') || !this.#tokens.has(auth.slice('Bearer '.length))) {
      throw new EmError(401, 'AUTHENTICATION_FAILURE', null, 'Authentication failed due to missing authorization header, or invalid authentication credentials.');
    }
    let route: Route | null = null;
    let id = '';
    for (const r of ROUTES) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (m) {
        route = r;
        id = decodeURIComponent(m[1] ?? '');
        break;
      }
    }
    if (!route) throw new EmError(404, 'RESOURCE_NOT_FOUND', null, `No such PayPal endpoint: ${method} ${path}.`);

    const transport = this.#take(route.op, ['unavailable', 'ratelimit']);
    if (transport === 'unavailable') return this.#error(new EmError(503, 'SERVICE_UNAVAILABLE', null, 'Service Unavailable.'));
    if (transport === 'ratelimit') {
      return this.#error(new EmError(429, 'RATE_LIMIT_REACHED', null, 'Too many requests. Blocked due to rate limiting.'), { 'retry-after': '0' });
    }

    const requestId = method === 'POST' ? headers.get('paypal-request-id') : null;
    const replayKey = requestId ? `${path}#${requestId}` : null;
    if (replayKey) {
      const prior = this.#state.replays[replayKey];
      if (prior) return this.#json(prior.status, prior.body);
    }

    const prefer = (headers.get('prefer') ?? '').includes('return=representation');
    const body = await readBody(rawBody);
    const result = this.#dispatch(route.name, id, body, url, prefer);
    if (replayKey && result.status >= 200 && result.status < 300) this.#state.replays[replayKey] = { status: result.status, body: result.body };
    if (this.#take(route.op, ['lost'])) return this.#error(new EmError(503, 'SERVICE_UNAVAILABLE', null, 'Service Unavailable.'));
    return this.#json(result.status, result.body);
  }

  #dispatch(name: string, id: string, body: ParsedBody, url: URL, prefer: boolean): EmResult {
    switch (name) {
      case 'createOrder':
        return this.#createOrder(body.json);
      case 'getOrder':
        return { status: 200, body: this.#orderJson(this.#order(id)) };
      case 'authorizeOrder':
        return this.#authorizeOrder(id);
      case 'track':
        return this.#track(id, body.json);
      case 'getAuthorization': {
        const a = this.#auth(id);
        this.#refresh(a);
        return { status: 200, body: this.#authJson(a) };
      }
      case 'capture':
        return this.#capture(id, body.json);
      case 'void':
        return this.#void(id, prefer);
      case 'reauthorize':
        return this.#reauthorize(id, body.json);
      case 'getCapture':
        return { status: 200, body: this.#captureJson(this.#captureById(id)) };
      case 'refund':
        return this.#refund(id, body.json);
      case 'getRefund': {
        const r = this.#state.refunds[id];
        if (!r) throw notFound();
        return { status: 200, body: this.#refundJson(r) };
      }
      case 'createPayout':
        return this.#createPayout(body.json);
      case 'getPayout':
        return { status: 200, body: this.#batchJson(this.#batch(id)) };
      case 'getPayoutItem':
        return { status: 200, body: this.#itemJson(this.#item(id)) };
      case 'cancelPayoutItem':
        return this.#cancelItem(id);
      case 'listDisputes':
        return this.#listDisputes(url);
      case 'getDispute':
        return { status: 200, body: this.#disputeJson(this.#dispute(id)) };
      case 'evidence':
        return this.#evidence(id, body);
      case 'acceptClaim':
        return this.#acceptClaim(id);
      case 'adjudicate':
        return this.#adjudicate(id, body.json);
      case 'escalate':
        return this.#escalate(id);
      case 'verifyWebhook':
        return this.#verifyWebhook(body.json);
      default:
        throw new EmError(404, 'RESOURCE_NOT_FOUND', null, `No such PayPal endpoint: ${name}.`);
    }
  }

  #oauth(headers: Headers, rawBody: unknown): Response {
    const expected = `Basic ${Buffer.from(`${FAKE_CLIENT_ID}:${FAKE_CLIENT_SECRET}`).toString('base64')}`;
    if (headers.get('authorization') !== expected) {
      return this.#json(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
    }
    if (typeof rawBody !== 'string' || !rawBody.includes('grant_type=client_credentials')) {
      return this.#json(400, { error: 'unsupported_grant_type', error_description: 'Grant Type is NULL' });
    }
    if (this.#take('oauth', ['unavailable'])) return this.#error(new EmError(503, 'SERVICE_UNAVAILABLE', null, 'Service Unavailable.'));
    this.#tokenCount += 1;
    const token = `FAKE-TOKEN-${String(this.#tokenCount).padStart(4, '0')}`;
    this.#tokens.add(token);
    return this.#json(200, { scope: FAKE_SCOPES.join(' '), access_token: token, token_type: 'Bearer', app_id: 'APP-FAKE', expires_in: 32_400, nonce: 'fake' });
  }

  // ---------------------------------------------------------------- orders

  #createOrder(json: unknown): EmResult {
    const b = obj(json);
    if (b.intent !== 'AUTHORIZE') throw unprocessable('FAKE_INTENT_NOT_SUPPORTED', 'The fake supports intent AUTHORIZE only.');
    const units = arr(b.purchase_units);
    if (units.length !== 1) throw invalid('INVALID_ARRAY_MAX_ITEMS', 'Exactly one purchase unit is supported.', 'purchase_units');
    const pu = obj(units[0]);
    const amount = obj(pu.amount);
    const amountCents = this.#money(amount, 'purchase_units[0].amount');
    const breakdown = obj(amount.breakdown);
    const itemTotal = isObj(breakdown.item_total) ? this.#money(breakdown.item_total, 'item_total') : null;
    const shipping = isObj(breakdown.shipping) ? this.#money(breakdown.shipping, 'shipping') : 0;
    const items = arr(pu.items).map(obj);
    if (itemTotal !== null && itemTotal + shipping !== amountCents) throw unprocessable('AMOUNT_MISMATCH', 'Should equal item_total + tax_total + shipping + handling + insurance - shipping_discount - discount.');
    if (items.length > 0) {
      if (itemTotal === null) throw unprocessable('ITEM_TOTAL_REQUIRED', 'If item details are specified, items.unit_amount and items.quantity must also be specified.');
      let sum = 0;
      for (const it of items) {
        const q = Number(it.quantity);
        if (!Number.isInteger(q) || q < 1) throw invalid('INVALID_PARAMETER_VALUE', 'Item quantity must be a positive whole number.', 'quantity');
        sum += q * this.#money(it.unit_amount, 'unit_amount');
      }
      if (sum !== itemTotal) throw unprocessable('ITEM_TOTAL_MISMATCH', 'Should equal sum of (unit_amount * quantity) across all items for a given purchase_unit.');
    }
    const softDescriptor = str(pu.soft_descriptor);
    if (softDescriptor && softDescriptor.length > 22) throw invalid('INVALID_STRING_LENGTH', 'soft_descriptor is longer than 22 characters.', 'soft_descriptor');
    const invoiceId = str(pu.invoice_id);
    if (invoiceId && Object.values(this.#state.orders).some((o) => o.invoiceId === invoiceId && o.authorizationIds.length > 0)) {
      throw unprocessable('DUPLICATE_INVOICE_ID', 'Duplicate Invoice ID detected. To avoid a potential duplicate transaction your account setting requires that Invoice Id be unique for each transaction.');
    }
    const ps = obj(b.payment_source);
    const sourceKey = 'venmo' in ps ? 'venmo' : 'paypal' in ps ? 'paypal' : null;
    const experience = sourceKey ? obj(obj(ps[sourceKey]).experience_context) : {};
    const now = this.#now();
    const order: EmOrder = {
      id: this.#id('ORDER'),
      status: sourceKey ? 'PAYER_ACTION_REQUIRED' : 'CREATED',
      createdAt: now,
      updatedAt: now,
      referenceId: str(pu.reference_id),
      customId: str(pu.custom_id),
      invoiceId,
      description: str(pu.description),
      softDescriptor,
      amountCents,
      itemTotalCents: itemTotal,
      shippingCents: isObj(breakdown.shipping) ? shipping : null,
      items,
      shippingType: str(obj(pu.shipping).type),
      shippingPreference: str(experience.shipping_preference) ?? 'GET_FROM_FILE',
      sourceKey,
      approval: null,
      authorizationIds: [],
      trackers: [],
    };
    this.#state.orders[order.id] = order;
    return { status: 201, body: this.#orderJson(order) };
  }

  #authorizeOrder(id: string): EmResult {
    const o = this.#order(id);
    if (o.status === 'COMPLETED') throw unprocessable('ORDER_ALREADY_AUTHORIZED', "Order already authorized. If 'intent=AUTHORIZE' only one authorization per order is allowed.");
    if (o.status === 'VOIDED') throw unprocessable('ORDER_COMPLETED_OR_VOIDED', 'Order is voided.');
    if (o.status !== 'APPROVED' || !o.approval) {
      throw unprocessable('ORDER_NOT_APPROVED', "Payer has not yet approved the Order for payment. Please redirect the payer to the 'rel':'approve' url returned as part of the HATEOAS links within the Create Order call or provide a valid payment_source in the request.");
    }
    if (o.approval.decline || this.#take('authorize', ['decline'])) {
      o.status = o.sourceKey ? 'PAYER_ACTION_REQUIRED' : 'CREATED';
      o.approval = null;
      o.updatedAt = this.#now();
      throw unprocessable('INSTRUMENT_DECLINED', "The instrument presented was either declined by the processor or bank, or it can't be used for this payment.");
    }
    const now = this.#now();
    const a: EmAuthorization = {
      id: this.#id('AUTH'),
      orderId: o.id,
      parentId: null,
      amountCents: o.amountCents,
      status: 'CREATED',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + VALIDITY_DAYS * DAY_MS,
      invoiceId: o.invoiceId,
      customId: o.customId,
      captureIds: [],
    };
    this.#state.authorizations[a.id] = a;
    o.authorizationIds.push(a.id);
    o.status = 'COMPLETED';
    o.updatedAt = now;
    return { status: 201, body: this.#orderJson(o) };
  }

  #track(id: string, json: unknown): EmResult {
    const o = this.#order(id);
    const b = obj(json);
    const captureId = str(b.capture_id);
    const trackingNumber = str(b.tracking_number);
    const carrier = str(b.carrier);
    if (!captureId) throw invalid('MISSING_REQUIRED_PARAMETER', 'A required field is missing.', 'capture_id');
    if (!trackingNumber) throw invalid('MISSING_REQUIRED_PARAMETER', 'A required field is missing.', 'tracking_number');
    if (!carrier) throw invalid('MISSING_REQUIRED_PARAMETER', 'A required field is missing.', 'carrier');
    const c = this.#state.captures[captureId];
    if (!c || c.orderId !== o.id) throw unprocessable('FAKE_CAPTURE_NOT_IN_ORDER', 'The capture does not belong to this order.');
    const carrierNameOther = str(b.carrier_name_other);
    if (carrier === 'OTHER' && !carrierNameOther) throw unprocessable('FAKE_CARRIER_NAME_REQUIRED', 'carrier_name_other is required when carrier is OTHER.');
    if (o.trackers.some((t) => t.captureId === captureId && t.trackingNumber === trackingNumber)) {
      throw unprocessable('FAKE_DUPLICATE_TRACKER', 'This tracking number is already on the capture.');
    }
    o.trackers.push({
      id: `${captureId}-${trackingNumber}`,
      captureId,
      trackingNumber,
      carrier,
      carrierNameOther,
      notifyPayer: b.notify_payer === true,
      createdAt: this.#now(),
    });
    o.updatedAt = this.#now();
    return { status: 201, body: this.#orderJson(o) };
  }

  // ---------------------------------------------------------------- authorizations and captures

  #capture(id: string, json: unknown): EmResult {
    const a = this.#auth(id);
    this.#refresh(a);
    this.#assertOpen(a, 'capture');
    if (this.#take('capture', ['expired'])) {
      a.status = 'EXPIRED';
      throw unprocessable('AUTHORIZATION_EXPIRED', 'An expired authorization cannot be captured.');
    }
    const b = obj(json);
    const captured = this.#capturedOn(a);
    const amount = b.amount === undefined ? a.amountCents - captured : this.#money(b.amount, 'amount');
    if (amount <= 0) throw unprocessable('CANNOT_BE_ZERO_OR_NEGATIVE', 'Must be greater than zero.');
    if (captured + amount > Math.floor((a.amountCents * OVERAGE_BPS) / 10_000)) {
      throw unprocessable(
        'MAX_CAPTURE_AMOUNT_EXCEEDED',
        'Capture amount exceeds allowable limit. Please contact customer service or your account manager to request the change to your overage limit. The default overage limit is 115%, which allows the sum of all captures to be up to 115% of the order amount.',
      );
    }
    if (a.captureIds.length >= MAX_CAPTURES) throw unprocessable('MAX_CAPTURE_COUNT_EXCEEDED', 'Maximum number of allowable captures has been reached. No additional captures are possible for this authorization.');
    const invoiceId = str(b.invoice_id);
    if (invoiceId && Object.values(this.#state.captures).some((c) => c.invoiceId === invoiceId)) {
      throw unprocessable('DUPLICATE_INVOICE_ID', 'Requested invoice number has been previously captured. Possible duplicate transaction.');
    }
    const finalCapture = b.final_capture === true;
    const effect = this.#take('capture', ['decline', 'pending']);
    const now = this.#now();
    const c: EmCapture = {
      id: this.#id('CAP'),
      authorizationId: a.id,
      orderId: a.orderId,
      amountCents: amount,
      refundedCents: 0,
      status: effect === 'decline' ? 'DECLINED' : effect === 'pending' ? 'PENDING' : 'COMPLETED',
      finalCapture,
      invoiceId,
      noteToPayer: str(b.note_to_payer),
      createdAt: now,
      updatedAt: now,
    };
    this.#state.captures[c.id] = c;
    a.captureIds.push(c.id);
    if (c.status !== 'DECLINED') a.status = finalCapture ? 'CAPTURED' : 'PARTIALLY_CAPTURED';
    a.updatedAt = now;
    return { status: 201, body: this.#captureJson(c) };
  }

  #void(id: string, prefer: boolean): EmResult {
    const a = this.#auth(id);
    this.#refresh(a);
    this.#assertOpen(a, 'void');
    a.status = 'VOIDED';
    a.updatedAt = this.#now();
    return prefer ? { status: 200, body: this.#authJson(a) } : { status: 204, body: null };
  }

  #reauthorize(id: string, json: unknown): EmResult {
    const a = this.#auth(id);
    if (a.parentId) throw unprocessable('FAKE_REAUTHORIZED_PAYMENT', 'A reauthorized payment cannot itself be reauthorized; reauthorize the original authorization.');
    this.#refresh(a);
    if (a.status === 'PARTIALLY_CAPTURED') throw unprocessable('AUTHORIZATION_ALREADY_CAPTURED', 'Authorization has already been captured.');
    this.#assertOpen(a, 'reauthorize');
    if (this.#take('reauthorize', ['expired'])) throw unprocessable('AUTHORIZATION_EXPIRED', 'An expired authorization cannot be reauthorized.');
    const now = this.#now();
    if (now < a.createdAt + HONOR_DAYS * DAY_MS) throw unprocessable('FAKE_HONOR_PERIOD_NOT_OVER', 'Reauthorize after the 3-day honor period.');
    const b = obj(json);
    const amount = b.amount === undefined ? a.amountCents : this.#money(b.amount, 'amount');
    const max = Math.min(Math.floor((a.amountCents * OVERAGE_BPS) / 10_000), a.amountCents + REAUTH_MAX_INCREASE_CENTS);
    if (amount <= 0) throw unprocessable('CANNOT_BE_ZERO_OR_NEGATIVE', 'Must be greater than zero.');
    if (amount > max) throw unprocessable('FAKE_REAUTHORIZE_LIMIT_EXCEEDED', 'A reauthorization may ask for at most 115% of the original, and at most $75 more.');
    if (this.#take('reauthorize', ['decline'])) throw unprocessable('TRANSACTION_REFUSED', 'The request was refused.');
    const child: EmAuthorization = {
      id: this.#id('AUTH'),
      orderId: a.orderId,
      parentId: a.id,
      amountCents: amount,
      status: 'CREATED',
      createdAt: now,
      updatedAt: now,
      expiresAt: a.expiresAt,
      invoiceId: a.invoiceId,
      customId: a.customId,
      captureIds: [],
    };
    this.#state.authorizations[child.id] = child;
    this.#state.orders[a.orderId]?.authorizationIds.push(child.id);
    return { status: 201, body: this.#authJson(child) };
  }

  #refund(id: string, json: unknown): EmResult {
    const c = this.#captureById(id);
    if (c.status === 'REFUNDED') throw unprocessable('CAPTURE_FULLY_REFUNDED', 'The capture has already been fully refunded.');
    if (c.status !== 'COMPLETED' && c.status !== 'PARTIALLY_REFUNDED') throw unprocessable('CAPTURE_STATUS_NOT_VALID', 'Invalid capture status. Tried to refund a capture that is not completed.');
    const b = obj(json);
    const left = c.amountCents - c.refundedCents;
    const amount = b.amount === undefined ? left : this.#money(b.amount, 'amount');
    if (amount <= 0) throw unprocessable('CANNOT_BE_ZERO_OR_NEGATIVE', 'Must be greater than zero.');
    if (amount > left) throw unprocessable('REFUND_AMOUNT_EXCEEDED', 'The refund amount must be less than or equal to the capture amount that has not yet been refunded.');
    const r: EmRefund = { id: this.#id('REFUND'), captureId: c.id, amountCents: amount, invoiceId: str(b.invoice_id), noteToPayer: str(b.note_to_payer), createdAt: this.#now() };
    this.#state.refunds[r.id] = r;
    this.#applyRefund(c, amount);
    return { status: 201, body: this.#refundJson(r) };
  }

  // ---------------------------------------------------------------- payouts

  #createPayout(json: unknown): EmResult {
    const b = obj(json);
    const header = obj(b.sender_batch_header);
    const senderBatchId = str(header.sender_batch_id);
    if (!senderBatchId) throw new EmError(400, 'VALIDATION_ERROR', 'MISSING_REQUIRED_PARAMETER', 'Invalid request - see details.', 'sender_batch_header.sender_batch_id');
    if (Object.values(this.#state.batches).some((x) => x.senderBatchId === senderBatchId)) {
      throw new EmError(400, 'USER_BUSINESS_ERROR', 'Batch with given sender_batch_id already exists', 'User business error.', 'SENDER_BATCH_ID');
    }
    const items = arr(b.items).map(obj);
    if (items.length === 0) throw new EmError(400, 'VALIDATION_ERROR', 'MISSING_REQUIRED_PARAMETER', 'Invalid request - see details.', 'items');
    const effect = this.#take('payout', ['unclaimed', 'failed']);
    const now = this.#now();
    const batch: EmBatch = { id: this.#id('BATCH'), senderBatchId, emailSubject: str(header.email_subject), emailMessage: str(header.email_message), createdAt: now, itemIds: [] };
    for (const it of items) {
      const receiver = str(it.receiver);
      if (!receiver || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(receiver)) throw new EmError(400, 'VALIDATION_ERROR', 'INVALID_EMAIL', 'Invalid request - see details.', 'items[0].receiver');
      const senderItemId = str(it.sender_item_id) ?? '';
      if (senderItemId.length > 63) throw new EmError(400, 'VALIDATION_ERROR', 'INVALID_STRING_LENGTH', 'Invalid request - see details.', 'items[0].sender_item_id');
      const amountCents = this.#money(it.amount, 'items[0].amount');
      const status: PayoutItemStatus = effect === 'failed' ? 'FAILED' : effect === 'unclaimed' || !this.#known(receiver) ? 'UNCLAIMED' : 'SUCCESS';
      const item: EmPayoutItem = {
        id: this.#id('ITEM'),
        batchId: batch.id,
        senderItemId,
        receiver,
        amountCents,
        note: str(it.note),
        status,
        transactionId: status === 'FAILED' ? null : this.#id('TXN'),
        createdAt: now,
        updatedAt: now,
      };
      this.#state.payoutItems[item.id] = item;
      batch.itemIds.push(item.id);
    }
    this.#state.batches[batch.id] = batch;
    return {
      status: 201,
      body: {
        batch_header: {
          payout_batch_id: batch.id,
          batch_status: 'PENDING',
          sender_batch_header: { sender_batch_id: senderBatchId, email_subject: batch.emailSubject, email_message: batch.emailMessage, recipient_type: 'EMAIL' },
        },
        links: [link(`/v1/payments/payouts/${batch.id}`, 'self')],
      },
    };
  }

  #cancelItem(id: string): EmResult {
    const it = this.#item(id);
    if (it.status !== 'UNCLAIMED') throw new EmError(400, 'USER_BUSINESS_ERROR', 'FAKE_ITEM_NOT_UNCLAIMED', 'Only an UNCLAIMED payout item can be cancelled.');
    it.status = 'RETURNED';
    it.updatedAt = this.#now();
    return { status: 200, body: this.#itemJson(it) };
  }

  // ---------------------------------------------------------------- disputes

  #listDisputes(url: URL): EmResult {
    const start = Date.parse(url.searchParams.get('start_time') ?? '');
    const items = Object.values(this.#state.disputes)
      .filter((d) => !Number.isFinite(start) || d.createdAt >= start)
      .map((d) => ({
        dispute_id: d.id,
        create_time: paypalTime(d.createdAt),
        update_time: paypalTime(d.updatedAt),
        status: d.status,
        reason: d.reason,
        dispute_amount: usd(d.amountCents),
        links: [link(`/v1/customer/disputes/${d.id}`, 'self')],
      }));
    return { status: 200, body: { items, links: [] } };
  }

  #evidence(id: string, body: ParsedBody): EmResult {
    const d = this.#dispute(id);
    if (d.status === 'RESOLVED') throw unprocessable('FAKE_DISPUTE_RESOLVED', 'The dispute is already resolved.');
    if (!body.form) throw invalid('INVALID_CONTENT_TYPE', 'provide-evidence takes multipart/form-data.');
    const input = body.formInput;
    if (!isObj(input) || arr(input.evidences).length === 0) throw invalid('MISSING_REQUIRED_PARAMETER', 'The input part needs evidences.', 'input');
    d.evidenceCount += body.formFiles;
    d.status = 'UNDER_REVIEW';
    d.updatedAt = this.#now();
    return { status: 200, body: { links: [link(`/v1/customer/disputes/${d.id}`, 'self')] } };
  }

  #acceptClaim(id: string): EmResult {
    const d = this.#dispute(id);
    if (d.status === 'RESOLVED') throw unprocessable('FAKE_DISPUTE_RESOLVED', 'The dispute is already resolved.');
    this.#resolve(d, 'ACCEPTED', true);
    return { status: 200, body: { links: [link(`/v1/customer/disputes/${d.id}`, 'self')] } };
  }

  #adjudicate(id: string, json: unknown): EmResult {
    const d = this.#dispute(id);
    if (d.status !== 'UNDER_REVIEW') throw unprocessable('FAKE_DISPUTE_NOT_UNDER_REVIEW', 'adjudicate needs a dispute that is UNDER_REVIEW (escalate it or provide evidence first).');
    const outcome = obj(json).adjudication_outcome;
    if (outcome !== 'BUYER_FAVOR' && outcome !== 'SELLER_FAVOR') throw invalid('INVALID_PARAMETER_VALUE', 'adjudication_outcome must be BUYER_FAVOR or SELLER_FAVOR.', 'adjudication_outcome');
    if (outcome === 'BUYER_FAVOR') this.#resolve(d, 'RESOLVED_BUYER_FAVOUR', true);
    else this.#resolve(d, 'RESOLVED_SELLER_FAVOUR', false);
    return { status: 200, body: { links: [link(`/v1/customer/disputes/${d.id}`, 'self')] } };
  }

  #escalate(id: string): EmResult {
    const d = this.#dispute(id);
    if (d.stage !== 'INQUIRY' || d.status === 'RESOLVED') throw unprocessable('FAKE_DISPUTE_NOT_IN_INQUIRY', 'Only a dispute in the inquiry stage can be escalated.');
    d.stage = 'CHARGEBACK';
    d.status = 'UNDER_REVIEW';
    d.updatedAt = this.#now();
    return { status: 200, body: { links: [link(`/v1/customer/disputes/${d.id}`, 'self')] } };
  }

  #resolve(d: EmDispute, outcome: string, refundBuyer: boolean): void {
    d.status = 'RESOLVED';
    d.outcome = outcome;
    d.updatedAt = this.#now();
    if (!refundBuyer) return;
    const c = this.#state.captures[d.captureId];
    if (!c) return;
    const amount = Math.min(d.amountCents, c.amountCents - c.refundedCents);
    if (amount <= 0) return;
    const r: EmRefund = { id: this.#id('REFUND'), captureId: c.id, amountCents: amount, invoiceId: null, noteToPayer: `Dispute ${d.id}`, createdAt: this.#now() };
    this.#state.refunds[r.id] = r;
    this.#applyRefund(c, amount);
  }

  // ---------------------------------------------------------------- webhooks

  #verifyWebhook(json: unknown): EmResult {
    const b = obj(json);
    const id = str(b.transmission_id);
    const t = str(b.transmission_time);
    const webhookId = str(b.webhook_id);
    const ok =
      this.#webhookId !== null &&
      webhookId === this.#webhookId &&
      b.auth_algo === 'SHA256withRSA' &&
      id !== null &&
      t !== null &&
      isObj(b.webhook_event) &&
      b.transmission_sig === this.#signature(id, t, webhookId, JSON.stringify(b.webhook_event));
    return { status: 200, body: { verification_status: ok ? 'SUCCESS' : 'FAILURE' } };
  }

  #signature(transmissionId: string, transmissionTime: string, webhookId: string, rawBody: string): string {
    const message = `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(rawBody)}`;
    return createHmac('sha256', FAKE_WEBHOOK_KEY).update(message).digest('base64');
  }

  // ---------------------------------------------------------------- helpers

  #take(op: FailOp, effects: readonly FailEffect[]): FailEffect | null {
    for (const rule of this.#rules) {
      if (rule.remaining <= 0 || !effects.includes(rule.effect)) continue;
      if (rule.op !== op && rule.op !== 'any') continue;
      rule.remaining -= 1;
      return rule.effect;
    }
    return null;
  }

  #id(kind: string): string {
    const n = (this.#state.counters[kind] ?? 0) + 1;
    this.#state.counters[kind] = n;
    return `FAKE-${kind}-${String(n).padStart(4, '0')}`;
  }

  #money(v: unknown, field: string): number {
    const m = obj(v);
    const currency = m.currency_code ?? m.currency;
    if (currency !== 'USD') throw invalid('INVALID_CURRENCY_CODE', 'Currency code is invalid or is not currently supported.', field);
    const value = str(m.value);
    if (!value) throw invalid('MISSING_REQUIRED_PARAMETER', 'A required field is missing.', field);
    if (!/^\d+(\.\d{1,2})?$/.test(value)) throw unprocessable('DECIMAL_PRECISION', 'If the currency supports decimals, only two decimal place precision is supported.');
    return fromPayPalValue(value);
  }

  #order(id: string): EmOrder {
    const o = this.#state.orders[id];
    if (!o) throw notFound();
    return o;
  }

  #auth(id: string): EmAuthorization {
    const a = this.#state.authorizations[id];
    if (!a) throw notFound();
    return a;
  }

  #captureById(id: string): EmCapture {
    const c = this.#state.captures[id];
    if (!c) throw notFound();
    return c;
  }

  #batch(id: string): EmBatch {
    const b = this.#state.batches[id];
    if (!b) throw notFound();
    return b;
  }

  #item(id: string): EmPayoutItem {
    const it = this.#state.payoutItems[id];
    if (!it) throw notFound();
    return it;
  }

  #dispute(id: string): EmDispute {
    const d = this.#state.disputes[id];
    if (!d) throw notFound();
    return d;
  }

  /** Authorizations expire on the injected clock (29 days from the original). */
  #refresh(a: EmAuthorization): void {
    if ((a.status === 'CREATED' || a.status === 'PARTIALLY_CAPTURED') && this.#now() >= a.expiresAt) {
      a.status = 'EXPIRED';
      a.updatedAt = this.#now();
    }
  }

  #assertOpen(a: EmAuthorization, what: string): void {
    if (a.status === 'VOIDED') throw unprocessable('AUTHORIZATION_VOIDED', `A voided authorization cannot be ${what === 'capture' ? 'captured' : what === 'void' ? 'voided' : 'reauthorized'}.`);
    if (a.status === 'CAPTURED') throw unprocessable('AUTHORIZATION_ALREADY_CAPTURED', 'Authorization has already been captured. If final_capture is set to to true, additional captures are not possible against the authorization.');
    if (a.status === 'EXPIRED') throw unprocessable('AUTHORIZATION_EXPIRED', 'An expired authorization cannot be captured.');
    if (a.status === 'DENIED' || a.status === 'PENDING') throw unprocessable('FAKE_AUTHORIZATION_NOT_OPEN', `The authorization is ${a.status}.`);
  }

  #capturedOn(a: EmAuthorization): number {
    let sum = 0;
    for (const id of a.captureIds) {
      const c = this.#state.captures[id];
      if (c && c.status !== 'DECLINED' && c.status !== 'FAILED') sum += c.amountCents;
    }
    return sum;
  }

  #applyRefund(c: EmCapture, amount: number): void {
    c.refundedCents += amount;
    c.status = c.refundedCents >= c.amountCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    c.updatedAt = this.#now();
  }

  #json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
    const headers = { 'content-type': 'application/json', 'paypal-debug-id': this.#debugId(), ...extra };
    if (status === 204 || body === null) return new Response(null, { status, headers });
    return new Response(JSON.stringify(body), { status, headers });
  }

  #error(e: EmError, extra: Record<string, string> = {}): Response {
    const debugId = this.#debugId();
    const details = e.issue ? [{ ...(e.field ? { field: e.field } : {}), issue: e.issue, description: e.message }] : [];
    const message =
      e.status === 422
        ? 'The requested action could not be performed, semantically incorrect, or failed business validation.'
        : e.status === 404
          ? 'The specified resource does not exist.'
          : e.message;
    const body = { name: e.paypalName, message, debug_id: debugId, details, links: [{ href: 'https://developer.paypal.com/api/rest/reference/orders/v2/errors/', rel: 'information_link', method: 'GET' }] };
    return new Response(JSON.stringify(body), { status: e.status, headers: { 'content-type': 'application/json', 'paypal-debug-id': debugId, ...extra } });
  }

  #debugId(): string {
    const n = (this.#state.counters.DEBUG ?? 0) + 1;
    this.#state.counters.DEBUG = n;
    return `fakedebug${String(n).padStart(6, '0')}`;
  }

  // ---------------------------------------------------------------- JSON views

  #orderJson(o: EmOrder): Json {
    for (const id of o.authorizationIds) {
      const a = this.#state.authorizations[id];
      if (a) this.#refresh(a);
    }
    const breakdown: Json = {};
    if (o.itemTotalCents !== null) breakdown.item_total = usd(o.itemTotalCents);
    if (o.shippingCents !== null) breakdown.shipping = usd(o.shippingCents);
    const unit: Json = {
      reference_id: o.referenceId,
      custom_id: o.customId,
      invoice_id: o.invoiceId,
      description: o.description,
      soft_descriptor: o.softDescriptor,
      amount: { ...usd(o.amountCents), ...(Object.keys(breakdown).length > 0 ? { breakdown } : {}) },
      payee: { email_address: this.#merchantEmail, merchant_id: this.#merchantId },
      items: o.items,
    };
    const shipping: Json = {};
    if (o.shippingType) shipping.type = o.shippingType;
    const shipTo = o.approval?.shipTo ?? null;
    if (shipTo && o.status !== 'CREATED' && o.status !== 'PAYER_ACTION_REQUIRED') {
      shipping.name = { full_name: shipTo.fullName };
      shipping.address = { address_line_1: shipTo.line1, admin_area_2: shipTo.city, admin_area_1: shipTo.region, postal_code: shipTo.postalCode, country_code: shipTo.countryCode };
    }
    if (o.trackers.length > 0) {
      shipping.trackers = o.trackers.map((t) => ({
        id: t.id,
        status: 'SHIPPED',
        items: [],
        links: [link(`/v2/checkout/orders/${o.id}/trackers/${t.id}`, 'self')],
        create_time: paypalTime(t.createdAt),
        update_time: paypalTime(t.createdAt),
      }));
    }
    if (Object.keys(shipping).length > 0) unit.shipping = shipping;
    if (o.authorizationIds.length > 0) {
      const auths = o.authorizationIds.map((id) => this.#state.authorizations[id]).filter((a): a is EmAuthorization => a !== undefined);
      const captures = auths.flatMap((a) => a.captureIds.map((id) => this.#state.captures[id]).filter((c): c is EmCapture => c !== undefined));
      unit.payments = { authorizations: auths.map((a) => this.#authJson(a)), ...(captures.length > 0 ? { captures: captures.map((c) => this.#captureJson(c)) } : {}) };
    }
    const links: Json[] = [link(`/v2/checkout/orders/${o.id}`, 'self')];
    if (o.status === 'CREATED') links.push({ href: `${FAKE_APPROVE_URL}?token=${o.id}`, rel: 'approve', method: 'GET' });
    if (o.status === 'PAYER_ACTION_REQUIRED') links.push({ href: `${FAKE_APPROVE_URL}?token=${o.id}`, rel: 'payer-action', method: 'GET' });
    if (o.status === 'APPROVED') links.push(link(`/v2/checkout/orders/${o.id}/authorize`, 'authorize', 'POST'));
    const body: Json = {
      id: o.id,
      intent: 'AUTHORIZE',
      status: o.status,
      purchase_units: [unit],
      create_time: paypalTime(o.createdAt),
      update_time: paypalTime(o.updatedAt),
      links,
    };
    if (o.approval && o.status !== 'CREATED' && o.status !== 'PAYER_ACTION_REQUIRED') {
      const key = o.approval.funding === 'venmo' ? 'venmo' : 'paypal';
      const name = { given_name: 'Test', surname: 'Buyer' };
      body.payment_source =
        key === 'venmo'
          ? { venmo: { email_address: this.#buyerEmail, account_id: o.approval.payerId, user_name: 'test-buyer', name } }
          : { paypal: { email_address: this.#buyerEmail, account_id: o.approval.payerId, account_status: 'VERIFIED', name, address: { country_code: 'US' } } };
      body.payer = { name, email_address: this.#buyerEmail, payer_id: o.approval.payerId, address: { country_code: 'US' } };
    }
    return body;
  }

  #authJson(a: EmAuthorization): Json {
    const body: Json = {
      id: a.id,
      status: a.status,
      amount: usd(a.amountCents),
      invoice_id: a.invoiceId,
      custom_id: a.customId,
      seller_protection: { status: 'ELIGIBLE', dispute_categories: ['ITEM_NOT_RECEIVED', 'UNAUTHORIZED_TRANSACTION'] },
      expiration_time: paypalTime(a.expiresAt),
      create_time: paypalTime(a.createdAt),
      update_time: paypalTime(a.updatedAt),
      supplementary_data: { related_ids: { order_id: a.orderId } },
      links: [
        link(`/v2/payments/authorizations/${a.id}`, 'self'),
        link(`/v2/payments/authorizations/${a.id}/capture`, 'capture', 'POST'),
        link(`/v2/payments/authorizations/${a.id}/void`, 'void', 'POST'),
        link(`/v2/payments/authorizations/${a.id}/reauthorize`, 'reauthorize', 'POST'),
        link(`/v2/checkout/orders/${a.orderId}`, 'up'),
      ],
    };
    if (a.status === 'PENDING') body.status_details = { reason: 'PENDING_REVIEW' };
    return body;
  }

  #captureJson(c: EmCapture): Json {
    const body: Json = {
      id: c.id,
      status: c.status,
      amount: usd(c.amountCents),
      final_capture: c.finalCapture,
      invoice_id: c.invoiceId,
      seller_protection: { status: 'ELIGIBLE', dispute_categories: ['ITEM_NOT_RECEIVED', 'UNAUTHORIZED_TRANSACTION'] },
      seller_receivable_breakdown: { gross_amount: usd(c.amountCents), net_amount: usd(c.amountCents) },
      create_time: paypalTime(c.createdAt),
      update_time: paypalTime(c.updatedAt),
      supplementary_data: { related_ids: { order_id: c.orderId, authorization_id: c.authorizationId } },
      links: [
        link(`/v2/payments/captures/${c.id}`, 'self'),
        link(`/v2/payments/captures/${c.id}/refund`, 'refund', 'POST'),
        link(`/v2/payments/authorizations/${c.authorizationId}`, 'up'),
      ],
    };
    if (c.noteToPayer) body.note_to_payer = c.noteToPayer;
    if (c.status === 'PENDING') body.status_details = { reason: 'PENDING_REVIEW' };
    if (c.status === 'DECLINED') body.status_details = { reason: 'DECLINED_BY_RISK_FRAUD_FILTERS' };
    return body;
  }

  #refundJson(r: EmRefund): Json {
    const body: Json = {
      id: r.id,
      status: 'COMPLETED',
      amount: usd(r.amountCents),
      seller_payable_breakdown: { gross_amount: usd(r.amountCents), net_amount: usd(r.amountCents), total_refunded_amount: usd(r.amountCents) },
      create_time: paypalTime(r.createdAt),
      update_time: paypalTime(r.createdAt),
      links: [link(`/v2/payments/refunds/${r.id}`, 'self'), link(`/v2/payments/captures/${r.captureId}`, 'up')],
    };
    if (r.invoiceId) body.invoice_id = r.invoiceId;
    if (r.noteToPayer) body.note_to_payer = r.noteToPayer;
    return body;
  }

  #batchJson(b: EmBatch): Json {
    const items = b.itemIds.map((id) => this.#state.payoutItems[id]).filter((i): i is EmPayoutItem => i !== undefined);
    const total = items.reduce((s, i) => s + i.amountCents, 0);
    return {
      batch_header: {
        payout_batch_id: b.id,
        batch_status: 'SUCCESS',
        time_created: paypalTime(b.createdAt),
        time_completed: paypalTime(b.createdAt),
        sender_batch_header: { sender_batch_id: b.senderBatchId, email_subject: b.emailSubject, email_message: b.emailMessage, recipient_type: 'EMAIL' },
        amount: payoutUsd(total),
        fees: payoutUsd(0),
      },
      items: items.map((i) => this.#itemJson(i)),
      links: [link(`/v1/payments/payouts/${b.id}`, 'self')],
    };
  }

  #itemJson(i: EmPayoutItem): Json {
    const body: Json = {
      payout_item_id: i.id,
      transaction_id: i.transactionId,
      transaction_status: i.status,
      payout_item_fee: payoutUsd(0),
      payout_batch_id: i.batchId,
      payout_item: { recipient_type: 'EMAIL', amount: payoutUsd(i.amountCents), note: i.note, receiver: i.receiver, sender_item_id: i.senderItemId, recipient_wallet: 'PAYPAL' },
      time_processed: paypalTime(i.updatedAt),
      links: [link(`/v1/payments/payouts-item/${i.id}`, 'item')],
    };
    if (i.status === 'UNCLAIMED') body.errors = { name: 'RECEIVER_UNREGISTERED', message: 'Receiver is unregistered' };
    if (i.status === 'FAILED') body.errors = { name: 'RECEIVER_UNCONFIRMED', message: 'Receiver is unconfirmed' };
    return body;
  }

  #disputeJson(d: EmDispute): Json {
    const c = this.#state.captures[d.captureId];
    const body: Json = {
      dispute_id: d.id,
      create_time: paypalTime(d.createdAt),
      update_time: paypalTime(d.updatedAt),
      disputed_transactions: [
        {
          seller_transaction_id: d.captureId,
          create_time: c ? paypalTime(c.createdAt) : paypalTime(d.createdAt),
          transaction_status: 'COMPLETED',
          gross_amount: usd(c?.amountCents ?? d.amountCents),
          invoice_number: d.invoiceId,
          custom: d.customId,
          buyer: { name: 'Test Buyer' },
          seller: { email: this.#merchantEmail, merchant_id: this.#merchantId, name: 'HoldMySpot' },
        },
      ],
      reason: d.reason,
      status: d.status,
      dispute_amount: usd(d.amountCents),
      dispute_life_cycle_stage: d.stage,
      dispute_channel: 'INTERNAL',
      links: [link(`/v1/customer/disputes/${d.id}`, 'self')],
    };
    if (d.outcome) body.dispute_outcome = { outcome_code: d.outcome, amount_refunded: usd(d.outcome === 'RESOLVED_SELLER_FAVOUR' ? 0 : d.amountCents) };
    return body;
  }
}

interface ParsedBody {
  json: unknown;
  form: FormData | null;
  formInput: unknown;
  formFiles: number;
}

async function readBody(raw: unknown): Promise<ParsedBody> {
  if (raw instanceof FormData) {
    const input = raw.get('input');
    let formInput: unknown = null;
    const text = typeof input === 'string' ? input : input instanceof Blob ? await input.text() : null;
    if (text !== null) {
      try {
        formInput = JSON.parse(text);
      } catch {
        formInput = null;
      }
    }
    let files = 0;
    for (const [key, value] of raw.entries()) if (key !== 'input' && value instanceof Blob) files += 1;
    return { json: null, form: raw, formInput, formFiles: files };
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      return { json: JSON.parse(raw), form: null, formInput: null, formFiles: 0 };
    } catch {
      throw invalid('MALFORMED_REQUEST_JSON', 'The request JSON is not well formed.');
    }
  }
  return { json: null, form: null, formInput: null, formFiles: 0 };
}
