import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO_MARKET_START, findShop } from '@holdmyspot/shared';
import type { BidResult, CreateBidRequest, Destination, LngLat, User } from '@holdmyspot/shared';
import type { App } from '../src/app/app.ts';
import { createAsk, checkIn } from '../src/app/asks.ts';
import { authorizeBid, createBid } from '../src/app/bids.ts';
import { saveUpload } from '../src/app/files.ts';
import { advanceTo, tick } from '../src/app/scheduler.ts';
import { MarketClock } from '../src/clock.ts';
import { loadConfig } from '../src/config.ts';
import { FakeAi } from '../src/fakes/ai.ts';
import { createServer, type HmsServer } from '../src/server.ts';
import { placeholderPng } from '../src/util/images.ts';

/** Test harness: in-memory database, fake PayPal, rules-only AI, and a market clock moved by hand. */

export const START = Date.parse(DEMO_MARKET_START);
export const MIN = 60_000;
export const DAY = 24 * 60 * MIN;
/**
 * The default shop and item of these tests: Little Lantern Toys' Lucky Cat
 * plush ($26.00, up to 6 per person, local errand or shipped), so a queuer can
 * fill several requests at once. The hero's own plush is one per customer.
 */
export const SHOP = findShop('little-lantern-toys')!;
export const ITEM = 'plush-little-lantern';
export const NY_SHIP: Destination = { mode: 'ship', country: 'US', region: 'NY', city: 'New York', postalCode: '10012' };

export interface TestServer extends HmsServer {
  dir: string;
  clock: MarketClock;
  /** Jumps the market clock and runs everything that became due. */
  at(t: number): Promise<void>;
  call(method: 'GET' | 'POST' | 'PATCH', url: string, opts?: { as?: string; body?: unknown; idem?: string; headers?: Record<string, string> }): Promise<{ status: number; json: any; headers: Record<string, unknown> }>;
  done(): Promise<void>;
}

/** Names the AI services read keys from; tests that load the real AI port clear them so nothing can reach a model. */
export const AI_KEY_ENV = ['ANTHROPIC_API_KEY', 'MODEL_API_KEY', 'HMS_AI_KEY_FILES', 'HMS_AI_MODE', 'HMS_AI_PROVIDER', 'HMS_AI_PROOF_FIXTURES_DIR'] as const;

export async function testServer(
  opts: { crowd?: boolean; demo?: boolean; env?: Record<string, string>; start?: number; ai?: 'fake' | 'real'; dbPath?: string } = {},
): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'hms-test-'));
  const start = opts.start ?? START;
  const real = opts.ai === 'real';
  // The real AI port (server/src/ai) in fake mode: no key, so rules only and replay, never the network.
  if (real) for (const k of AI_KEY_ENV) delete process.env[k];
  const config = loadConfig({
    HMS_DB_PATH: opts.dbPath ?? ':memory:',
    HMS_UPLOAD_DIR: join(dir, 'uploads'),
    HMS_SECRETS_DIR: join(dir, 'no-secrets'),
    HMS_CROWD: opts.crowd ? '1' : '0',
    HMS_DETERMINISTIC: '1',
    HMS_MARKET_START: new Date(start).toISOString(),
    HMS_DEMO: opts.demo ? '1' : '0',
    HMS_AI_PROVIDER: real ? 'auto' : 'fake',
    // Recorded model answers (server/fixtures/ai) are tested on their own (test/replay.test.ts); every other
    // suite reads the photos with the rules only, so its numbers never depend on a recording.
    HMS_AI_FIXTURES_DIR: join(dir, 'no-replay'),
    ...opts.env,
  });
  const clock = new MarketClock({ marketStart: start, speed: 1, paused: true });
  const server = await createServer(config, { workers: false, clock, ...(real ? {} : { ai: new FakeAi() }), log: () => undefined });
  server.app.clock.pause();
  return {
    ...server,
    dir,
    clock,
    async at(t: number) {
      await advanceTo(server.app, t);
      await server.app.idle();
      await tick(server.app);
    },
    async call(method, url, o = {}) {
      const headers: Record<string, string> = { ...(o.headers ?? {}) };
      if (o.as) headers['x-hms-user'] = o.as;
      if (o.idem) headers['idempotency-key'] = o.idem;
      let payload: string | Buffer | undefined;
      if (o.body instanceof Uint8Array) {
        payload = Buffer.from(o.body);
        headers['content-type'] ??= 'image/png';
      } else if (o.body !== undefined) {
        payload = JSON.stringify(o.body);
        headers['content-type'] = 'application/json';
      }
      const res = await server.fastify.inject({ method, url, headers, payload });
      let json: unknown = null;
      try {
        json = res.json();
      } catch {
        json = res.body;
      }
      return { status: res.statusCode, json, headers: res.headers as Record<string, unknown> };
    },
    async done() {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function persona(app: App, id: string): User {
  return app.store.users.must(id).user;
}

/** Creates a bid, approves it in the simulated PayPal sheet and authorizes it. */
export async function placeBid(
  app: App,
  userId: string,
  b: Partial<CreateBidRequest> & { itemId?: string; shopId?: string } = {},
): Promise<BidResult> {
  return app.exec(async () => {
    const req: CreateBidRequest = {
      shopId: b.shopId ?? SHOP.id,
      itemId: b.itemId ?? ITEM,
      qty: b.qty ?? 2,
      retailCapCents: b.retailCapCents ?? 2800,
      maxFeeCents: b.maxFeeCents ?? 1200,
      shippingBudgetCents: b.shippingBudgetCents ?? 3500,
      destination: b.destination ?? NY_SHIP,
      deadlineAt: b.deadlineAt ?? app.now() + 2 * DAY,
      funding: b.funding ?? 'paypal',
      agent: b.agent ?? null,
    };
    const created = await createBid(app, persona(app, userId), req);
    await app.fakePayPal.approveOrder(created.checkout.orderId, req.funding, 'approve');
    return authorizeBid(app, { userId, ops: false }, created.bid.id, created.checkout.orderId);
  });
}

/** Posts an ask from the queuer's home. */
export async function postAsk(
  app: App,
  queuerId: string,
  o: { capacity?: number; feeCents?: number; clock?: { stepCents: number; intervalMs: number; floorCents: number } | null; etaInMin?: number; itemId?: string; shopId?: string; modes?: ('ship' | 'local')[] } = {},
) {
  return app.exec(() => {
    const u = persona(app, queuerId);
    return createAsk(app, u, {
      shopId: o.shopId ?? SHOP.id,
      itemId: o.itemId ?? ITEM,
      capacity: o.capacity ?? 2,
      modes: o.modes ?? ['ship'],
      feeCents: o.feeCents ?? 1500,
      clock: o.clock === undefined ? null : o.clock,
      etaAt: app.now() + (o.etaInMin ?? 15) * MIN,
      from: { lngLat: u.home!, accuracyM: 10 },
    });
  });
}

let photoCounter = 0;

export async function upload(app: App, ownerId: string, purpose: 'line_photo' | 'receipt' | 'item_photo' | 'label', scenario: string | null = null, label?: string) {
  return saveUpload(app, ownerId, purpose, 'image/png', placeholderPng(label ?? `test-${++photoCounter}`), { scenario });
}

/** Geofence plus a line photo; waits for the photo check. */
export async function checkInAt(app: App, queuerId: string, claimId: string, where: LngLat, scenario = 'line_ok') {
  const photo = await upload(app, queuerId, 'line_photo', scenario);
  const out = await app.exec(() => checkIn(app, persona(app, queuerId), claimId, { lngLat: where, accuracyM: 8, photoFileId: photo.id }));
  await app.idle();
  return out;
}

export function ledgerOf(app: App, bidId: string) {
  return app.store.ledger.where('bid_id = ?', bidId);
}

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
