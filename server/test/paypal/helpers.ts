import { readFileSync } from 'node:fs';
import type { CreateOrderInput } from '@holdmyspot/shared/ports';
import { createSandboxPayPal, type SandboxExtras, type SandboxPayPal, type SandboxSettings } from '../../src/paypal/index.ts';

/** Test helpers for the PayPal module. Nothing here touches the network. */

export interface FixtureResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

const ALL = JSON.parse(readFileSync(new URL('./fixtures/documented-responses.json', import.meta.url), 'utf8')) as Record<string, unknown>;

/** A deep copy of one documented response fixture. */
export function fixture(name: string): FixtureResponse {
  const f = ALL[name];
  if (f === undefined) throw new Error(`No fixture ${name}`);
  return structuredClone(f) as FixtureResponse;
}

/** A raw object from the fixture file (webhook events are stored as bodies only). */
export function fixtureBody(name: string): Record<string, unknown> {
  const f = ALL[name];
  if (f === undefined) throw new Error(`No fixture ${name}`);
  return structuredClone(f) as Record<string, unknown>;
}

export interface Call {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: string | FormData | null;
}

export type Respond = FixtureResponse | 'network-error' | ((call: Call) => FixtureResponse);

export interface Step {
  method?: 'GET' | 'POST';
  path?: string | RegExp;
  respond: Respond;
}

export interface Script {
  fetch: typeof fetch;
  calls: Call[];
  problems: string[];
  left(): number;
}

/** A fetch that plays back `steps` in order and records every call. */
export function scriptedFetch(steps: Step[]): Script {
  const queue = [...steps];
  const calls: Call[] = [];
  const problems: string[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = init?.body;
    const call: Call = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      search: url.search,
      headers,
      body: typeof body === 'string' || body instanceof FormData ? body : null,
    };
    calls.push(call);
    if (url.origin !== 'https://api-m.sandbox.paypal.com') problems.push(`call to ${url.origin}`);
    const step = queue.shift();
    if (!step) {
      problems.push(`unexpected call ${call.method} ${call.path}`);
      return new Response(JSON.stringify({ name: 'UNEXPECTED_TEST_CALL' }), { status: 418 });
    }
    if (step.method && step.method !== call.method) problems.push(`expected ${step.method}, got ${call.method} ${call.path}`);
    if (step.path && !(typeof step.path === 'string' ? step.path === call.path : step.path.test(call.path))) {
      problems.push(`expected path ${String(step.path)}, got ${call.path}`);
    }
    if (step.respond === 'network-error') throw new TypeError('fetch failed');
    const r = typeof step.respond === 'function' ? step.respond(call) : step.respond;
    const resHeaders = { 'content-type': 'application/json', ...(r.headers ?? {}) };
    if (r.status === 204 || r.body === undefined) return new Response(null, { status: r.status, headers: resHeaders });
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status, headers: resHeaders });
  };
  return { fetch: f, calls, problems, left: () => queue.length };
}

export const OAUTH: Step = { method: 'POST', path: '/v1/oauth2/token', respond: fixture('oauth-token') };

export const TEST_SECRET = 'test-client-secret-not-real';
export const TEST_TOKEN = 'A21AAFIXTUREACCESSTOKENVALUE0000';

export function testSettings(overrides: Partial<SandboxSettings> = {}): SandboxSettings {
  return {
    env: 'sandbox',
    clientId: 'test-client-id',
    clientSecret: TEST_SECRET,
    merchantEmail: 'merchant@business.example.com',
    merchantId: 'MERCHANT123ABC',
    buyerEmail: 'buyer@personal.example.com',
    twPayoutEmail: 'queuer-payouts@personal.example.com',
    webhookId: null,
    ...overrides,
  };
}

export interface TestClient {
  client: SandboxPayPal;
  script: Script;
  logs: string[];
  sleeps: number[];
  clock: { now: () => number; advance: (ms: number) => void };
}

export function makeClient(steps: Step[], opts: { settings?: Partial<SandboxSettings>; extras?: SandboxExtras } = {}): TestClient {
  const script = scriptedFetch(steps);
  const logs: string[] = [];
  const sleeps: number[] = [];
  let t = Date.parse('2026-11-08T01:00:00Z');
  const clock = { now: () => t, advance: (ms: number) => void (t += ms) };
  const client = createSandboxPayPal({
    settings: testSettings(opts.settings),
    baseUrl: 'https://api-m.sandbox.paypal.com',
    timeoutMs: 1000,
    log: (line) => logs.push(line),
    fetchImpl: script.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    now: clock.now,
    ...opts.extras,
  });
  return { client, script, logs, sleeps, clock };
}

/** The hero bid's order (docs/PAYPAL-MAPPING.md section 4). */
export function heroOrderInput(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    requestId: 'order:bid_0001',
    invoiceId: 'HMS-bid_0001',
    customId: 'bid_0001',
    description: 'HoldMySpot hold: up to $115.00 for 2 x Lucky Cat plush, launch-day drop',
    softDescriptor: 'HOLDMYSPOT',
    amountCents: 11_500,
    breakdown: { itemTotalCents: 8_000, shippingCents: 3_500 },
    items: [
      { name: 'Lucky Cat plush, launch-day drop (shop price, up to)', quantity: 2, unitAmountCents: 2_800, category: 'PHYSICAL_GOODS' },
      { name: 'Queue fee (up to)', quantity: 2, unitAmountCents: 1_200, category: null },
    ],
    shipping: { type: 'SHIPPING', preference: 'GET_FROM_FILE' },
    funding: 'paypal',
    returnUrl: 'http://127.0.0.1:8796/api/paypal/return',
    cancelUrl: 'http://127.0.0.1:8796/api/paypal/cancel',
    ...overrides,
  };
}

/** A New York local errand: one shortcake, picked up in person (docs/ARCHITECTURE.md section 8). */
export function localOrderInput(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return heroOrderInput({
    requestId: 'order:bid_0002',
    invoiceId: 'HMS-bid_0002',
    customId: 'bid_0002',
    description: 'HoldMySpot hold: up to $50.00 for 1 x Strawberry shortcake',
    amountCents: 5_000,
    breakdown: { itemTotalCents: 5_000, shippingCents: 0 },
    items: [
      { name: 'Strawberry shortcake (shop price, up to)', quantity: 1, unitAmountCents: 4_000, category: 'PHYSICAL_GOODS' },
      { name: 'Queue fee (up to)', quantity: 1, unitAmountCents: 1_000, category: null },
    ],
    shipping: { type: 'PICKUP_FROM_PERSON', preference: 'NO_SHIPPING' },
    ...overrides,
  });
}

export function jsonBody(call: Call | undefined): Record<string, unknown> {
  if (!call || typeof call.body !== 'string') throw new Error('expected a JSON body');
  return JSON.parse(call.body) as Record<string, unknown>;
}
