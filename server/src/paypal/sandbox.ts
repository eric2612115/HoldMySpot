import type { SandboxPayPalFactory, SandboxPayPalOptions } from '../ports/payments.ts';
import { PayPalRestClient } from './client.ts';
import { DEFAULT_TIMEOUT_MS, SANDBOX_BASE_URL } from './constants.ts';
import { PayPalHttp, type HttpRetryPolicy } from './http.ts';
import type { RecordedResponse } from './types.ts';

/**
 * The sandbox adapter: real PayPal sandbox REST, nothing else.
 *
 * Loaded by server/src/ports/load.ts as
 * `createSandboxPayPal(options: SandboxPayPalOptions): PayPalPort`
 * (server/src/ports/payments.ts). Credentials come from `options.settings`,
 * which the server reads from ~/.config/paypal-hackathon/sandbox.env; this
 * file never reads files or the environment, and refuses any base URL other
 * than https://api-m.sandbox.paypal.com.
 */

/** Optional extras for tests and the probe script. The server passes none of them. */
export interface SandboxExtras {
  /** Tests inject a scripted fetch; the default is the global fetch. */
  fetchImpl?: typeof fetch;
  onResponse?: (r: RecordedResponse) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  retry?: Partial<HttpRetryPolicy>;
  invoicePrefix?: string;
  paymentSource?: 'send' | 'omit';
  /** Real-time clock (token cache, fields PayPal leaves out). Tests advance it. */
  now?: () => number;
}

export type CreateSandboxOptions = SandboxPayPalOptions & SandboxExtras;

/** Throws unless `url` is PayPal's sandbox REST host. */
export function assertSandboxBaseUrl(url: string): string {
  const clean = url.replace(/\/+$/, '');
  if (clean !== SANDBOX_BASE_URL) throw new Error(`Refusing PayPal base URL ${url}: HoldMySpot only talks to ${SANDBOX_BASE_URL}.`);
  return clean;
}

export class SandboxPayPal extends PayPalRestClient {
  constructor(options: CreateSandboxOptions) {
    const baseUrl = assertSandboxBaseUrl(options.baseUrl ?? SANDBOX_BASE_URL);
    const s = options.settings;
    if (s.env !== 'sandbox') throw new Error('PayPal settings must be for the sandbox (PAYPAL_ENV=sandbox).');
    if (!s.clientId || !s.clientSecret) throw new Error('PayPal sandbox settings need PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.');
    const http = new PayPalHttp({
      clientId: s.clientId,
      clientSecret: s.clientSecret,
      baseUrl,
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      timeoutMs: options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
      log: options.log,
      onResponse: options.onResponse ?? null,
      sleep: options.sleep,
      random: options.random,
      now: options.now,
      retry: options.retry,
    });
    super({
      mode: 'sandbox',
      http,
      webhookId: s.webhookId,
      invoicePrefix: options.invoicePrefix,
      paymentSource: options.paymentSource,
      now: options.now,
    });
  }
}

export function createSandboxPayPal(options: CreateSandboxOptions): SandboxPayPal {
  return new SandboxPayPal(options);
}

/** Compile-time check that this matches the factory type the server loads. */
export const sandboxPayPalFactory: SandboxPayPalFactory = createSandboxPayPal;
