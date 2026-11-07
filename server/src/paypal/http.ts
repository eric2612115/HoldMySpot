import { toPayPalError, unexpectedResponse } from './errors.ts';
import type { RecordedResponse } from './types.ts';

/**
 * The one place that talks HTTP to PayPal.
 *
 * - OAuth 2 client credentials, token cached in memory until 60 seconds
 *   before `expires_in`, one token request at a time.
 * - `PayPal-Request-Id` on every money call (the ledger's idempotency key),
 *   `Prefer: return=representation` on every POST.
 * - Retries: HTTP 429 always (honouring Retry-After), 5xx, timeouts and
 *   network errors only when the call can be replayed safely (GET, or a POST
 *   with a PayPal-Request-Id, which PayPal answers with the first result).
 *   A 401 on an API call refreshes the token once.
 * - One log line per attempt with PayPal's debug id. Never logs headers,
 *   tokens, credentials or bodies.
 */

export interface HttpRetryPolicy {
  /** Extra attempts after HTTP 429. */
  rateLimit: number;
  /** Extra attempts after 5xx, timeouts and network errors (replayable calls only). */
  server: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: HttpRetryPolicy = { rateLimit: 3, server: 2, baseDelayMs: 400, maxDelayMs: 5000 };

export interface PayPalHttpOptions {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  log?: ((line: string) => void) | null;
  /** Receives every API response body (never the OAuth one). Used by the probe script to record fixtures. */
  onResponse?: ((r: RecordedResponse) => void) | null;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Real time for the token cache. */
  now?: () => number;
  retry?: Partial<HttpRetryPolicy>;
}

export interface PayPalRequest {
  /** Our name for the call, for example `authorizations.capture`. */
  op: string;
  method: 'GET' | 'POST';
  /** Path and query under the base URL, starting with '/'. */
  path: string;
  json?: unknown;
  /** A body that is already JSON text (webhook verification embeds the raw event). */
  rawJson?: string;
  form?: FormData;
  requestId?: string | null;
}

export interface PayPalResponse {
  status: number;
  data: unknown;
  debugId: string | null;
}

interface TokenState {
  value: string;
  expiresAt: number;
  scopes: string[];
}

interface RawResponse {
  status: number;
  headers: Headers;
  data: unknown;
}

class TransportFailure extends Error {
  readonly kind: 'TIMEOUT' | 'NETWORK_ERROR';
  constructor(kind: 'TIMEOUT' | 'NETWORK_ERROR') {
    super(kind);
    this.kind = kind;
  }
}

const OAUTH_PATH = '/v1/oauth2/token';

function parseBody(text: string): unknown {
  const t = text.trim();
  if (t === '') return null;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

function bodyDebugId(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const v = (data as Record<string, unknown>).debug_id;
  return typeof v === 'string' && v !== '' ? v : null;
}

function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export class PayPalHttp {
  readonly #basic: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #log: ((line: string) => void) | null;
  readonly #onResponse: ((r: RecordedResponse) => void) | null;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #retry: HttpRetryPolicy;
  #token: TokenState | null = null;
  #tokenRequest: Promise<TokenState> | null = null;

  constructor(o: PayPalHttpOptions) {
    if (!o.clientId || !o.clientSecret) throw new Error('PayPal client id and secret are required.');
    this.#basic = `Basic ${Buffer.from(`${o.clientId}:${o.clientSecret}`).toString('base64')}`;
    this.#baseUrl = o.baseUrl.replace(/\/+$/, '');
    this.#fetch = o.fetchImpl;
    this.#timeoutMs = o.timeoutMs;
    this.#log = o.log ?? null;
    this.#onResponse = o.onResponse ?? null;
    this.#sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#random = o.random ?? Math.random;
    this.#now = o.now ?? Date.now;
    this.#retry = { ...DEFAULT_RETRY, ...o.retry };
  }

  /** Scope URLs of the current token (fetches one if needed). */
  async scopes(): Promise<string[]> {
    const token = await this.#ensureToken();
    return [...token.scopes];
  }

  /** Forgets the cached token (tests, or after the secret changed). */
  dropToken(): void {
    this.#token = null;
  }

  async request(req: PayPalRequest): Promise<PayPalResponse> {
    if (!req.path.startsWith('/') || req.path.includes('://')) throw new Error(`PayPal path must be relative: ${req.path}`);
    const requestId = req.requestId ?? null;
    const replayable = req.method === 'GET' || requestId !== null;
    let attempt = 0;
    let rateRetries = 0;
    let serverRetries = 0;
    let authRetried = false;

    for (;;) {
      attempt += 1;
      const token = await this.#ensureToken();
      const headers: Record<string, string> = { Authorization: `Bearer ${token.value}`, Accept: 'application/json' };
      let body: string | FormData | undefined;
      if (req.method === 'POST') {
        headers.Prefer = 'return=representation';
        if (req.form) {
          body = req.form;
        } else {
          headers['Content-Type'] = 'application/json';
          if (req.rawJson !== undefined) body = req.rawJson;
          else if (req.json !== undefined) body = JSON.stringify(req.json);
        }
      }
      if (requestId) headers['PayPal-Request-Id'] = requestId;

      const started = this.#now();
      let res: RawResponse;
      try {
        res = await this.#send(this.#baseUrl + req.path, { method: req.method, headers, body });
      } catch (err) {
        const kind = err instanceof TransportFailure ? err.kind : 'NETWORK_ERROR';
        if (replayable && serverRetries < this.#retry.server) {
          serverRetries += 1;
          this.#line(req, null, null, started, attempt, `retry after ${kind}`);
          await this.#sleep(this.#backoff(serverRetries));
          continue;
        }
        this.#line(req, null, null, started, attempt, kind);
        throw toPayPalError({ op: req.op, method: req.method, path: req.path, requestId, status: null, body: null, debugIdHeader: null, transport: kind });
      }

      const debugId = res.headers.get('paypal-debug-id') ?? bodyDebugId(res.data);
      this.#record(req, res.status, debugId, res.data);

      if (res.status >= 200 && res.status < 300) {
        this.#line(req, res.status, debugId, started, attempt, null);
        return { status: res.status, data: res.data, debugId };
      }
      if (res.status === 401 && !authRetried) {
        authRetried = true;
        this.#token = null;
        this.#line(req, res.status, debugId, started, attempt, 'token refresh');
        continue;
      }
      if (res.status === 429 && rateRetries < this.#retry.rateLimit) {
        rateRetries += 1;
        const wait = retryAfterMs(res.headers.get('retry-after'), this.#now()) ?? this.#backoff(rateRetries);
        this.#line(req, res.status, debugId, started, attempt, 'rate limited, retrying');
        await this.#sleep(Math.min(wait, this.#retry.maxDelayMs));
        continue;
      }
      if (res.status >= 500 && replayable && serverRetries < this.#retry.server) {
        serverRetries += 1;
        this.#line(req, res.status, debugId, started, attempt, 'retrying');
        await this.#sleep(this.#backoff(serverRetries));
        continue;
      }
      const error = toPayPalError({ op: req.op, method: req.method, path: req.path, requestId, status: res.status, body: res.data, debugIdHeader: debugId });
      this.#line(req, res.status, debugId, started, attempt, [error.paypalName, error.issue].filter(Boolean).join('/') || 'error');
      throw error;
    }
  }

  async #ensureToken(): Promise<TokenState> {
    const cached = this.#token;
    if (cached && this.#now() < cached.expiresAt) return cached;
    if (!this.#tokenRequest) {
      this.#tokenRequest = this.#fetchToken().finally(() => {
        this.#tokenRequest = null;
      });
    }
    return this.#tokenRequest;
  }

  async #fetchToken(): Promise<TokenState> {
    const req: PayPalRequest = { op: 'oauth.token', method: 'POST', path: OAUTH_PATH };
    let attempt = 0;
    let rateRetries = 0;
    let serverRetries = 0;
    for (;;) {
      attempt += 1;
      const started = this.#now();
      let res: RawResponse;
      try {
        res = await this.#send(this.#baseUrl + OAUTH_PATH, {
          method: 'POST',
          headers: { Authorization: this.#basic, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: 'grant_type=client_credentials',
        });
      } catch (err) {
        const kind = err instanceof TransportFailure ? err.kind : 'NETWORK_ERROR';
        if (serverRetries < this.#retry.server) {
          serverRetries += 1;
          this.#line(req, null, null, started, attempt, `retry after ${kind}`);
          await this.#sleep(this.#backoff(serverRetries));
          continue;
        }
        this.#line(req, null, null, started, attempt, kind);
        throw toPayPalError({ op: req.op, method: 'POST', path: OAUTH_PATH, requestId: null, status: null, body: null, debugIdHeader: null, transport: kind });
      }
      const debugId = res.headers.get('paypal-debug-id') ?? bodyDebugId(res.data);
      if (res.status >= 200 && res.status < 300) {
        const data = (typeof res.data === 'object' && res.data !== null ? res.data : {}) as Record<string, unknown>;
        const value = data.access_token;
        if (typeof value !== 'string' || value === '') throw unexpectedResponse(req.op, 'no access token in the OAuth response', debugId);
        const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 32_400;
        const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : [];
        const token: TokenState = { value, expiresAt: this.#now() + Math.max(0, expiresIn - 60) * 1000, scopes };
        this.#token = token;
        this.#line(req, res.status, debugId, started, attempt, null);
        return token;
      }
      if (res.status === 429 && rateRetries < this.#retry.rateLimit) {
        rateRetries += 1;
        const wait = retryAfterMs(res.headers.get('retry-after'), this.#now()) ?? this.#backoff(rateRetries);
        this.#line(req, res.status, debugId, started, attempt, 'rate limited, retrying');
        await this.#sleep(Math.min(wait, this.#retry.maxDelayMs));
        continue;
      }
      if (res.status >= 500 && serverRetries < this.#retry.server) {
        serverRetries += 1;
        this.#line(req, res.status, debugId, started, attempt, 'retrying');
        await this.#sleep(this.#backoff(serverRetries));
        continue;
      }
      const error = toPayPalError({ op: req.op, method: 'POST', path: OAUTH_PATH, requestId: null, status: res.status, body: res.data, debugIdHeader: debugId });
      this.#line(req, res.status, debugId, started, attempt, error.paypalName ?? 'error');
      throw error;
    }
  }

  async #send(url: string, init: { method: string; headers: Record<string, string>; body: string | FormData | undefined }): Promise<RawResponse> {
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, { method: init.method, headers: init.headers, body: init.body, signal });
    } catch (err) {
      throw new TransportFailure(isTimeout(err) ? 'TIMEOUT' : 'NETWORK_ERROR');
    }
    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      throw new TransportFailure(isTimeout(err) ? 'TIMEOUT' : 'NETWORK_ERROR');
    }
    return { status: response.status, headers: response.headers, data: parseBody(text) };
  }

  #backoff(n: number): number {
    const base = Math.min(this.#retry.maxDelayMs, this.#retry.baseDelayMs * 2 ** (n - 1));
    return Math.round(base * (0.5 + this.#random() / 2));
  }

  #record(req: PayPalRequest, status: number, debugId: string | null, body: unknown): void {
    if (!this.#onResponse) return;
    try {
      this.#onResponse({ op: req.op, method: req.method, path: req.path, status, debugId, body });
    } catch {
      // A recorder must never break a money call.
    }
  }

  #line(req: PayPalRequest, status: number | null, debugId: string | null, started: number, attempt: number, note: string | null): void {
    if (!this.#log) return;
    const parts = [
      `paypal ${req.op}`,
      `${req.method} ${req.path.split('?')[0]}`,
      `-> ${status ?? 'no response'}`,
      `debug_id=${debugId ?? '-'}`,
      `${Math.max(0, this.#now() - started)}ms`,
    ];
    if (req.requestId) parts.push(`request_id=${req.requestId}`);
    if (attempt > 1) parts.push(`attempt=${attempt}`);
    if (note) parts.push(`(${note})`);
    try {
      this.#log(parts.join(' '));
    } catch {
      // Logging must never break a money call.
    }
  }
}

function isTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && ((err as { name?: unknown }).name === 'TimeoutError' || (err as { name?: unknown }).name === 'AbortError');
}
