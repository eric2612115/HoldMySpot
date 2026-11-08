import * as shared from '@holdmyspot/shared';
import { PoolError } from './pool.ts';
import type { ErrandRun, Market } from './pool.ts';

/**
 * "Let Wei run the errand" (D-163): the queuer's side of the real-sandbox path, played on the server
 * with the same code `npm run errand` uses (scripts/lib/sandbox-lifecycle.mjs), over the market's own
 * routes in-process, so PayPal really captures, releases and pays out.
 */

const { HERO, zonedLocalToEpoch } = shared;
const sf = (hhmm: string) => zonedLocalToEpoch(`2026-11-12 ${hhmm}`, 'America/Los_Angeles');
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

interface ApiOptions {
  as?: string;
  body?: unknown;
  bytes?: Uint8Array;
  contentType?: string;
  idem?: string;
}

function client(market: Market) {
  return async function api(method: string, route: string, { as, body, bytes, contentType = 'image/png', idem }: ApiOptions = {}): Promise<any> {
    const headers: Record<string, string> = {};
    if (as) headers['x-hms-user'] = as;
    if (idem) headers['idempotency-key'] = idem;
    let payload: string | Buffer | undefined;
    if (bytes) {
      headers['content-type'] = contentType;
      payload = Buffer.from(bytes);
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await market.server.fastify.inject({ method: method as 'GET', url: route, headers, ...(payload !== undefined ? { payload } : {}) });
    const json = res.body ? (JSON.parse(res.body) as { error?: { code?: string; message?: string } }) : null;
    if (res.statusCode >= 400) throw new Error(`${method} ${route} answered ${res.statusCode} ${json?.error?.code ?? ''}: ${json?.error?.message ?? ''}`);
    return json;
  };
}

function heldBid(market: Market): string {
  const app = market.server.app;
  const mine = app.store.bids.where('requester_id = ? AND item_id = ?', HERO.requesterId, HERO.itemId);
  const held = mine.filter((b) => b.status === 'open').sort((a, b) => (a.id < b.id ? 1 : -1))[0];
  if (!held) {
    const waiting = mine.find((b) => b.status === 'awaiting_approval');
    throw new PoolError(409, waiting ? 'AWAITING_APPROVAL' : 'NO_HOLD', waiting ? "Mia's request still waits for PayPal: approve it in PayPal's window first." : "Mia has no hold yet. On Mia's phone, tap the plush, set the fee and approve the hold in PayPal's window.");
  }
  return held.id;
}

export async function runSandboxErrand(market: Market, log: (line: string) => void): Promise<ErrandRun> {
  if (market.mode !== 'sandbox') throw new PoolError(409, 'NOT_SANDBOX', 'This market uses simulated PayPal. Use "Run the whole errand".');
  if (market.errand?.status === 'running') return market.errand;
  if (market.errand?.status === 'done') throw new PoolError(409, 'ERRAND_OVER', 'This errand has finished. Start over to try again.');
  const bidId = heldBid(market);
  const run: ErrandRun = { status: 'running', bidId, steps: [], error: null };
  market.errand = run;
  const api = client(market);
  const clock = (hhmm: string) => api('POST', '/api/demo/clock', { body: { jumpTo: sf(hhmm), paused: true } });
  const step = (name: string, text?: string) => {
    run.steps.push(text ? `${name}: ${text}` : name);
  };
  void (async () => {
    // Loaded on first use: the same module `npm run errand` runs.
    const { playQueuerErrand } = (await import(new URL('../../../scripts/lib/sandbox-lifecycle.mjs', import.meta.url).href)) as {
      playQueuerErrand: (o: Record<string, unknown>) => Promise<unknown>;
    };
    await playQueuerErrand({ api, shared, bidId, clock, step, requesterId: HERO.requesterId });
    run.status = 'done';
  })().catch((err: unknown) => {
    run.status = 'failed';
    run.error = err instanceof Error ? err.message : String(err);
    log(`sandbox errand failed: ${run.error}`);
  });
  return run;
}

export async function sandboxErrandStatus(market: Market): Promise<unknown> {
  const run = market.errand;
  if (!run) return { errand: null, ledger: [] };
  const detail = await client(market)('GET', `/api/bids/${encodeURIComponent(run.bidId)}`, { as: 'ops' });
  const ledger = (detail.ledger as { kind: string; amount: { cents: number }; status: string; paypal?: Record<string, string | number | null> }[]).slice().reverse().map((e) => ({
    kind: e.kind,
    amount: usd(e.amount.cents),
    status: e.status,
    paypalId: e.paypal?.captureId ?? e.paypal?.payoutBatchId ?? e.paypal?.authorizationId ?? e.paypal?.orderId ?? null,
  }));
  return { errand: run, ledger };
}
