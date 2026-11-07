import { CONTRACT_VERSION, HEADERS, apiPath, endpointParts } from '@holdmyspot/shared';
import type { ApiErrorBody, ApiKey, ApiSpec, HealthResponse } from '@holdmyspot/shared';

/**
 * The typed client for the HoldMySpot server (docs/API.md section 1). Same
 * origin by default: Vite proxies /api to 127.0.0.1:8796. VITE_HMS_API points
 * it elsewhere.
 */
const BASE = ((import.meta.env.VITE_HMS_API as string | undefined) ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, body: ApiErrorBody | null) {
    super(body?.error.message ?? `The server answered ${status}.`);
    this.name = 'ApiError';
    this.code = body?.error.code ?? 'INTERNAL';
    this.status = status;
    this.details = body?.error.details ?? null;
  }
}

export async function api<K extends ApiKey>(
  key: K,
  params: ApiSpec[K]['params'],
  body: ApiSpec[K]['body'],
  opts: { as?: string | null; query?: ApiSpec[K]['query']; idempotencyKey?: string; signal?: AbortSignal } = {},
): Promise<ApiSpec[K]['response']> {
  const { method } = endpointParts(key);
  const query = Object.entries((opts.query ?? {}) as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null);
  const qs = new URLSearchParams(query.map(([k, v]) => [k, String(v)])).toString();
  const res = await fetch(`${BASE}${apiPath(key, params)}${qs ? `?${qs}` : ''}`, {
    method,
    headers: {
      ...(body === null || body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(opts.as ? { [HEADERS.persona]: opts.as } : {}),
      ...(opts.idempotencyKey ? { [HEADERS.idempotency]: opts.idempotencyKey } : {}),
    },
    body: body === null || body === undefined ? undefined : JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    let parsed: ApiErrorBody | null = null;
    try {
      parsed = (await res.json()) as ApiErrorBody;
    } catch {
      parsed = null;
    }
    throw new ApiError(res.status, parsed);
  }
  return (await res.json()) as ApiSpec[K]['response'];
}

/** True when a HoldMySpot server of this contract answers on the API base within `ms`. */
export async function serverAnswers(ms = 1500): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: ctrl.signal });
    if (!res.ok) return false;
    const h = (await res.json()) as HealthResponse;
    return h.contractVersion === CONTRACT_VERSION;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

export function eventsUrl(as: string, since?: number): string {
  const q = new URLSearchParams({ as });
  if (since !== undefined) q.set('since', String(since));
  return `${BASE}/api/events?${q.toString()}`;
}
