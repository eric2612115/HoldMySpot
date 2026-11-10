import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttp, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HERO } from '@holdmyspot/shared';
import { FakeAi } from '../src/fakes/ai.ts';
import { FakePayPal } from '../src/fakes/paypal.ts';
import { Database } from '../src/db/database.ts';
import { AiError } from '../src/ai/errors.ts';
import type { AiPort, AgentRunInput, CheckInPhotoInput } from '../src/ports/ai.ts';
import type { AiJsonRequest, AiProvider } from '@holdmyspot/shared/ports';
import { runAgent } from '../src/ai/agent.ts';
import { startAgentRun } from '../src/app/agent.ts';
import { AiBudget, HostedAi } from '../src/hosted/ai.ts';
import { MarketPool } from '../src/hosted/pool.ts';
import { COOKIE, createRouter } from '../src/hosted/router.ts';
import { hostedSettings } from '../src/hosted/settings.ts';
import type { HostedSettings } from '../src/hosted/settings.ts';
import { placeBid, testServer } from './helpers.ts';

/**
 * The hosted judge server (D-163): each visitor's market is theirs, created only when needed,
 * removed when idle or at the cap, and its admin routes open only through its own token.
 */

const MIN = 60_000;

interface Site {
  base: string;
  pool: MarketPool;
  now: { t: number };
  stop(): Promise<void>;
}

async function site(over: Partial<HostedSettings> = {}, poolOver: { now?: () => number; crowd?: boolean } = {}): Promise<Site> {
  const dist = mkdtempSync(join(tmpdir(), 'hms-hosted-dist-'));
  const web = join(dist, 'web');
  const ops = join(dist, 'ops');
  mkdirSync(join(web, 'assets'), { recursive: true });
  mkdirSync(join(ops, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<title>phone</title>');
  writeFileSync(join(web, 'judge.html'), '<title>judge</title>');
  writeFileSync(join(web, 'assets', 'a.js'), 'console.log(1)');
  writeFileSync(join(web, '.secret'), 'hidden');
  writeFileSync(join(ops, 'index.html'), '<title>ops</title>');
  const now = { t: 1_800_000_000_000 };
  const settings: HostedSettings = { ...hostedSettings({}), port: 0, cap: 50, createsPerMinute: 1000, createsPerIpPerHour: 1000, errandSpeed: 600, ...over };
  const pool = new MarketPool({
    settings,
    env: { HMS_SECRETS_DIR: join(dist, 'none'), HMS_CROWD: poolOver.crowd ? '1' : '0', HMS_AI_PROVIDER: 'fake', HMS_AI_FIXTURES_DIR: join(dist, 'none') },
    replayAi: new FakeAi(),
    liveAi: null,
    sandboxPayPal: null,
    now: poolOver.now ?? (() => now.t),
  });
  await pool.init();
  const server: Server = createHttp(createRouter(pool, { webDist: web, opsDist: ops }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    pool,
    now,
    async stop() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await pool.close();
      rmSync(dist, { recursive: true, force: true });
    },
  };
}

interface Visitor {
  token: string;
  get(path: string, as?: string): Promise<{ status: number; json: any }>;
  post(path: string, body?: unknown, as?: string): Promise<{ status: number; json: any }>;
}

function asVisitor(base: string, token: string, ip = '1.1.1.1'): Visitor {
  const call = async (method: string, path: string, body?: unknown, as?: string) => {
    const headers: Record<string, string> = { 'x-hms-market': token, 'x-forwarded-for': ip };
    if (as) headers['x-hms-user'] = as;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return { token, get: (p, as) => call('GET', p, undefined, as), post: (p, b, as) => call('POST', p, b ?? {}, as) };
}

async function visitor(s: Site, ip = '1.1.1.1'): Promise<Visitor> {
  const res = await fetch(`${s.base}/api/demo/session`, { method: 'POST', headers: { 'x-forwarded-for': ip } });
  assert.equal(res.status, 201);
  const { token } = (await res.json()) as { token: string };
  return asVisitor(s.base, token, ip);
}

function cookieOf(res: Response): string | null {
  const m = new RegExp(`${COOKIE}=([^;]+)`).exec(res.headers.get('set-cookie') ?? '');
  return m ? m[1]! : null;
}

describe('hosted router', () => {
  let s: Site;
  before(async () => {
    s = await site();
  });
  after(async () => {
    await s.stop();
  });

  it('health and pages create no market; a page hands out a signed cookie', async () => {
    const before = s.pool.size;
    const health = await fetch(`${s.base}/api/health`);
    assert.equal(health.status, 200);
    const page = await fetch(`${s.base}/`);
    assert.match(await page.text(), /judge/);
    const set = page.headers.get('set-cookie') ?? '';
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Lax/);
    assert.doesNotMatch(set, /Secure/);
    const secure = await fetch(`${s.base}/`, { headers: { 'x-forwarded-proto': 'https' } });
    assert.match(secure.headers.get('set-cookie') ?? '', /Secure/);
    assert.equal(s.pool.size, before, 'a crawler that runs no JS creates nothing');
  });

  it('routes the phone, the judge page, the ops console and refuses dotfiles and traversal', async () => {
    assert.match(await (await fetch(`${s.base}/?demo=1`)).text(), /phone/);
    assert.match(await (await fetch(`${s.base}/`)).text(), /judge/);
    assert.match(await (await fetch(`${s.base}/ops/`)).text(), /ops/);
    const redirect = await fetch(`${s.base}/ops`, { redirect: 'manual' });
    assert.equal(redirect.status, 308);
    assert.equal((await fetch(`${s.base}/.secret`)).status, 404);
    assert.equal((await fetch(`${s.base}/assets/../../../../etc/passwd`)).status, 404);
    assert.equal((await fetch(`${s.base}/assets/%2e%2e/%2e%2e/%2e%2e/etc/passwd`)).status, 404);
  });

  it('an API call with no token, or a forged one, gets no market', async () => {
    const before = s.pool.size;
    const none = await fetch(`${s.base}/api/config`);
    assert.equal(none.status, 401);
    assert.equal(((await none.json()) as any).error.code, 'NO_MARKET');
    const forged = await fetch(`${s.base}/api/config`, { headers: { 'x-hms-market': 'abc.def' } });
    assert.equal(forged.status, 401);
    const badCookie = await fetch(`${s.base}/api/config`, { headers: { cookie: `${COOKIE}=${'x'.repeat(30)}` } });
    assert.equal(badCookie.status, 401);
    assert.equal(s.pool.size, before);
  });

  it('a page cookie builds the market on the first API call, and concurrent first calls share one', async () => {
    const before = s.pool.size;
    const token = cookieOf(await fetch(`${s.base}/`))!;
    assert.ok(token);
    const cookie = { cookie: `${COOKIE}=${token}` };
    const replies = await Promise.all(['/api/config', '/api/clock', '/api/shops', '/api/users'].map((p) => fetch(`${s.base}${p}`, { headers: cookie })));
    for (const r of replies) assert.equal(r.status, 200);
    assert.equal(s.pool.size, before + 1);
  });

  it('a fresh market is a fresh demo: paused at the start of the hero day', async () => {
    const v = await visitor(s);
    const state = await v.get('/api/demo/state');
    assert.equal(state.json.status, 'idle');
    assert.equal(state.json.scriptId, 'hero');
    const clock = await v.get('/api/clock');
    assert.equal(clock.json.paused, true);
    assert.equal(clock.json.marketNow, Date.parse('2026-11-12T10:30:00-08:00'));
  });

  it('isolation: one visitor acts and resets, the other sees nothing change', async () => {
    const a = await visitor(s);
    const b = await visitor(s);
    const snapshot = async () => JSON.stringify([(await b.get('/api/demo/state')).json, { ...(await b.get('/api/clock')).json, realNow: 0 }, (await b.get('/api/ledger?mine=1', 'mia')).json, (await b.get('/api/ops/records', 'ops')).json.bids]);
    const seen = await snapshot();
    assert.equal((await a.post('/api/hosted/hold')).status, 200);
    const held = await a.get('/api/ledger?mine=1', 'mia');
    assert.ok(held.json.entries.some((e: any) => e.kind === 'held' && e.amount.cents === 6370));
    assert.equal(await snapshot(), seen, 'after a hold on the other market');
    assert.equal((await a.post('/api/demo/reset', { scriptId: 'hero' })).status, 200);
    assert.equal(await snapshot(), seen, 'after a reset of the other market');
    assert.equal((await a.get('/api/ledger?mine=1', 'mia')).json.entries.length, 0);
  });

  it('the whole errand runs through the router with the hero numbers', async () => {
    const v = await visitor(s);
    await v.post('/api/hosted/hold');
    await v.post('/api/hosted/run');
    for (let i = 0; i < 120; i++) {
      if ((await v.get('/api/demo/state')).json.status === 'finished') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal((await v.get('/api/demo/state')).json.status, 'finished');
    const mia = (await v.get('/api/ledger?mine=1', 'mia')).json.entries.map((e: any) => `${e.kind} ${e.amount.cents} ${e.status}`).sort();
    assert.deepEqual(mia, ['captured 4869 succeeded', 'captured 957 succeeded', 'held 6370 succeeded', 'released 544 succeeded']);
    const wei = (await v.get('/api/ledger?mine=1', 'wei')).json.entries.map((e: any) => `${e.kind} ${e.amount.cents} ${e.status}`).sort();
    assert.deepEqual(wei, ['paid_out 1080 succeeded', 'paid_out 4275 succeeded']);
    const info = (await v.get('/api/hosted/info')).json;
    assert.deepEqual(info.money, { heldCents: 6370, capturedCents: 5826, releasedCents: 544, paidCents: 5355 });
  });

  it('"Try to break it" stops right before Wei sends his receipt', async () => {
    const v = await visitor(s);
    const res = await v.post('/api/hosted/break');
    assert.equal(res.status, 200);
    const job = (await v.get(`/api/jobs/${res.json.jobId}`, 'wei')).json.job;
    assert.equal(job.status, 'bought');
    assert.equal((await v.get('/api/ledger?mine=1', 'wei')).json.entries.length, 0);
  });

  it('admin routes answer only through the owner\'s token, with no key anywhere', async () => {
    const a = await visitor(s);
    const b = await visitor(s);
    assert.equal((await a.post('/api/hosted/hold')).status, 200);
    const mine = await a.get('/api/ops/records');
    assert.equal(mine.status, 200);
    assert.ok(mine.json.bids.some((x: any) => x.requesterId === 'mia'));
    const other = await b.get('/api/ops/records');
    assert.equal(other.status, 200);
    assert.equal(other.json.bids.filter((x: any) => x.requesterId === 'mia').length, 0, "another visitor's token sees only their own market");
    const anon = await fetch(`${s.base}/api/ops/records`, { headers: { 'x-hms-admin-key': 'anything' } });
    assert.equal(anon.status, 401, 'an admin key is not a way in');
    const config = (await a.get('/api/config')).json;
    assert.doesNotMatch(JSON.stringify(config), /adminKey|MODEL_API_KEY|clientSecret/);
  });

  it('the event stream works through the router and ends when the market goes', async () => {
    const v = await visitor(s);
    const u = new URL(`${s.base}/api/events?as=mia`);
    const got = await new Promise<{ first: string; ended: Promise<void> }>((resolve, reject) => {
      const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { 'x-hms-market': v.token, accept: 'text/event-stream' } }, (res) => {
        assert.equal(res.statusCode, 200);
        assert.match(String(res.headers['content-type']), /event-stream/);
        let text = '';
        const ended = new Promise<void>((done) => res.on('close', () => done()));
        res.on('data', (d: Buffer) => {
          text += d.toString();
          if (text.includes('event: hello')) resolve({ first: text, ended });
        });
      });
      req.on('error', reject);
      req.end();
    });
    assert.match(got.first, /"contractVersion"/);
    await s.pool.evict(s.pool.peek(v.token)!, 'test');
    await got.ended;
    assert.equal((await v.get('/api/config')).status, 410);
  });
});

describe('hosted eviction and caps', () => {
  it('removes idle markets, says so, and a page load starts a new one', async () => {
    const s = await site({ idleMs: 60 * MIN });
    try {
      const v = await visitor(s);
      assert.equal(s.pool.size, 1);
      s.now.t += 59 * MIN;
      await s.pool.sweep();
      assert.equal(s.pool.size, 1, 'not yet idle');
      s.now.t += 2 * MIN;
      await s.pool.sweep();
      assert.equal(s.pool.size, 0);
      const gone = await v.get('/api/config');
      assert.equal(gone.status, 410);
      assert.equal(gone.json.error.code, 'MARKET_GONE');
      assert.equal(s.pool.size, 0, 'a gone token never rebuilds itself');
      const page = await fetch(`${s.base}/`, { headers: { cookie: `${COOKIE}=${v.token}` } });
      const fresh = cookieOf(page);
      assert.ok(fresh && fresh !== v.token, 'a new cookie replaces the gone one');
    } finally {
      await s.stop();
    }
  });

  it('an open event stream does not keep a market alive, but real calls do', async () => {
    const s = await site({ idleMs: 60 * MIN });
    try {
      const v = await visitor(s);
      s.now.t += 40 * MIN;
      await v.get('/api/config');
      s.now.t += 40 * MIN;
      await s.pool.sweep();
      assert.equal(s.pool.size, 1, 'the call forty minutes ago counts');
      s.now.t += 61 * MIN;
      await s.pool.sweep();
      assert.equal(s.pool.size, 0);
    } finally {
      await s.stop();
    }
  });

  it('a market never outlives the age limit, however busy', async () => {
    const s = await site({ idleMs: 60 * MIN, maxAgeMs: 240 * MIN });
    try {
      const v = await visitor(s);
      for (let i = 0; i < 9; i++) {
        s.now.t += 30 * MIN;
        await v.get('/api/config');
        await s.pool.sweep();
      }
      assert.equal(s.pool.size, 0);
    } finally {
      await s.stop();
    }
  });

  it('at the cap the longest idle market goes first; if all are in use the visitor is told to retry', async () => {
    const s = await site({ cap: 2, minIdleToEvictMs: 2 * MIN });
    try {
      const a = await visitor(s);
      s.now.t += 5 * MIN;
      const b = await visitor(s);
      s.now.t += 5 * MIN;
      await b.get('/api/config');
      s.now.t += 1 * MIN;
      const c = await visitor(s);
      assert.equal(s.pool.size, 2);
      assert.equal((await a.get('/api/config')).status, 410, 'the longest idle went first');
      assert.equal((await b.get('/api/config')).status, 200);
      assert.equal((await c.get('/api/config')).status, 200);
      s.now.t += 10_000;
      const full = await fetch(`${s.base}/api/demo/session`, { method: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' } });
      assert.equal(full.status, 503);
      assert.equal(((await full.json()) as any).error.code, 'MARKET_CAP');
    } finally {
      await s.stop();
    }
  });

  it('limits new markets per address', async () => {
    const s = await site({ createsPerIpPerHour: 2 });
    try {
      await visitor(s, '2.2.2.2');
      await visitor(s, '2.2.2.2');
      const third = await fetch(`${s.base}/api/demo/session`, { method: 'POST', headers: { 'x-forwarded-for': '2.2.2.2' } });
      assert.equal(third.status, 429);
      assert.equal(s.pool.size, 2);
      await visitor(s, '3.3.3.3');
      assert.equal(s.pool.size, 3, 'another address is not limited');
      s.now.t += 61 * MIN;
      await visitor(s, '2.2.2.2');
      assert.equal(s.pool.size, 4, 'the window passes');
    } finally {
      await s.stop();
    }
  });

  it('refuses a sandbox market when none is configured', async () => {
    const s = await site();
    try {
      const res = await fetch(`${s.base}/api/demo/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'sandbox' }) });
      assert.equal(res.status, 503);
      assert.equal(s.pool.size, 0);
    } finally {
      await s.stop();
    }
  });
});

describe('more scenes on the hosted site', () => {
  async function finished(v: Visitor) {
    for (let i = 0; i < 120; i++) {
      if ((await v.get('/api/demo/state')).json.status === 'finished') return;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.fail('the scene did not finish');
  }

  it("the sold-out scene and the local pickup play in the visitor's own market, with their own people and money", async () => {
    const s = await site({}, { crowd: true });
    try {
      const v = await visitor(s);
      const other = await visitor(s);

      assert.equal((await v.post('/api/demo/start', { scriptId: 'sold-out', speed: 600 })).status, 200);
      await finished(v);
      let info = (await v.get('/api/hosted/info')).json;
      assert.deepEqual(info.people, { requester: 'mia', queuer: 'wei' });
      assert.deepEqual(info.money, { heldCents: 6370, capturedCents: 0, releasedCents: 6370, paidCents: 0 });
      const records = (await v.get('/api/ops/records')).json;
      const plush = records.bids.filter((b: any) => b.itemId === HERO.itemId);
      assert.equal(plush.length, 13);
      for (const b of plush) {
        const hold = records.holds.find((h: any) => h.id === b.holdId);
        assert.equal(b.closeReason, 'sold_out');
        assert.deepEqual([hold.status, hold.capturedCents, hold.releasedCents], ['released', 0, hold.amount.cents], `${b.requesterId}: released, $0 charged`);
      }
      assert.equal(records.ledger.filter((e: any) => e.kind === 'captured' || e.kind === 'paid_out').length, 0);
      for (const step of ['/api/hosted/hold', '/api/hosted/break']) {
        const refused = await v.post(step);
        assert.equal(refused.status, 409, `${step} belongs to the hero errand`);
        assert.equal(refused.json.error.code, 'OTHER_SCENE');
      }

      assert.equal((await v.post('/api/demo/start', { scriptId: 'local-errand', speed: 600 })).status, 200);
      await finished(v);
      info = (await v.get('/api/hosted/info')).json;
      assert.deepEqual(info.people, { requester: 'jun', queuer: 'dana' });
      assert.deepEqual(info.money, { heldCents: 5154, capturedCents: 4947, releasedCents: 207, paidCents: 4610 }, 'one capture at the handover code');
      const jun = (await v.get('/api/ledger?mine=1', 'jun')).json.entries.filter((e: any) => e.kind === 'captured');
      assert.equal(jun.length, 1);

      const theirs = (await other.get('/api/hosted/info')).json;
      assert.deepEqual([theirs.demo.scriptId, theirs.demo.status, theirs.money.heldCents], ['hero', 'idle', 0], "another visitor's market did not move");
      assert.equal((await v.post('/api/demo/reset', { scriptId: 'hero' })).status, 200);
      assert.deepEqual((await v.get('/api/hosted/info')).json.people, { requester: 'mia', queuer: 'wei' }, 'Start over returns to the hero errand');
    } finally {
      await s.stop();
    }
  });
});

describe('the sandbox path on the emulator', () => {
  it("Wei's errand runs on the server with the stamped photos and pays out the hero's numbers", async () => {
    const dist = mkdtempSync(join(tmpdir(), 'hms-hosted-sb-'));
    // The emulator's clock runs fast, so a payout batch settles in moments instead of its real minute.
    const started = Date.now();
    const paypal = new FakePayPal(new Database(':memory:'), () => started + (Date.now() - started) * 300, []);
    const settings: HostedSettings = { ...hostedSettings({}), port: 0 };
    const pool = new MarketPool({
      settings,
      env: {
        HMS_SECRETS_DIR: join(dist, 'none'),
        HMS_CROWD: '0',
        PAYPAL_ENV: 'sandbox',
        PAYPAL_CLIENT_ID: 'x',
        PAYPAL_CLIENT_SECRET: 'x',
        PAYPAL_MERCHANT_EMAIL: 'm@business.example.com',
        PAYPAL_MERCHANT_ID: 'x',
        PAYPAL_BUYER_EMAIL: 'b@personal.example.com',
        PAYPAL_PAYOUT_EMAIL: 'r@personal.example.com',
      },
      liveAi: null,
      sandboxPayPal: paypal,
    });
    await pool.init();
    const server: Server = createHttp(createRouter(pool, { webDist: dist, opsDist: dist }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${base}/api/demo/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'sandbox' }) });
      assert.equal(res.status, 201);
      const v = asVisitor(base, ((await res.json()) as { token: string }).token);
      assert.equal((await v.get('/api/hosted/info')).json.marketMode, 'sandbox');
      assert.equal((await v.post('/api/hosted/errand')).status, 409, 'no hold yet');
      const destination = { mode: 'ship', country: 'US', region: 'NY', city: 'New York', postalCode: '10012' };
      const order = { shopId: HERO.shopId, itemId: HERO.itemId, qty: 1, destination };
      const quote = (await v.post('/api/bids/quote', order, 'mia')).json;
      const created = (await v.post('/api/bids', { ...order, retailCapCents: quote.suggested.retailCapCents, maxFeeCents: 1200, shippingBudgetCents: quote.suggested.shippingBudgetCents, deadlineAt: Date.parse('2026-11-14T10:30:00-08:00'), funding: 'paypal', agent: null }, 'mia')).json;
      assert.equal(created.checkout.next, 'js_sdk');
      await paypal.approveOrder(created.checkout.orderId, 'paypal', 'approve');
      assert.equal((await v.post(`/api/bids/${created.bid.id}/authorize`, { orderId: created.checkout.orderId }, 'mia')).status, 200);
      assert.equal((await v.post('/api/hosted/errand')).status, 202);
      let status: any = null;
      for (let i = 0; i < 60; i++) {
        status = (await v.get('/api/hosted/errand')).json;
        if (status.errand.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.equal(status.errand.status, 'done', `${status.errand.error ?? ''} | ${status.errand.steps.join(' | ')}`);
      const money = (await v.get('/api/hosted/info')).json.money;
      assert.deepEqual(money, { heldCents: 6370, capturedCents: 5826, releasedCents: 544, paidCents: 5355 });
      assert.ok(status.ledger.some((e: any) => e.kind === 'captured' && e.paypalId), 'PayPal ids are on the page');
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await pool.close();
      rmSync(dist, { recursive: true, force: true });
    }
  });
});

describe('hosted AI', () => {
  const settings: HostedSettings = { ...hostedSettings({}), aiReadsPerMarket: 2, aiTurnsPerMarket: 2, aiReadsPerDay: 3, aiTurnsPerDay: 100 };
  const photo = (scenario: string | null) => ({ scenario }) as CheckInPhotoInput['photo'];
  const noTruth = () => {
    throw new AiError('no_truth', 'unknown photo');
  };

  function ports(live: boolean) {
    const calls: string[] = [];
    const replay = {
      info: { provider: 'muse', model: 'm', mode: 'replay' },
      checkInPhoto: async (i: CheckInPhotoInput) => {
        calls.push('replay');
        if (i.photo.scenario === null) noTruth();
        return { verdict: 'replayed' };
      },
    } as unknown as AiPort;
    const livePort = live
      ? ({
          info: { provider: 'muse', model: 'm', mode: 'live' },
          checkInPhoto: async () => {
            calls.push('live');
            return { verdict: 'model read' };
          },
          purchaseProof: async () => ({}) as never,
          opsAgentTurn: async () => {
            calls.push('turn');
            return { calls: [] };
          },
        } as unknown as AiPort)
      : null;
    return { replay, live: livePort, calls };
  }

  it('without a key an unknown photo stays unread and the agents say no model', async () => {
    const { replay, live } = ports(false);
    const ai = new HostedAi(replay, live, new AiBudget(settings), { reads: 0, turns: 0 });
    await assert.rejects(() => ai.checkInPhoto({ photo: photo(null) } as CheckInPhotoInput), (e: unknown) => e instanceof AiError && e.kind === 'no_truth');
    await assert.rejects(() => ai.opsAgentTurn({ agent: 'market' } as never), /No AI model/);
    assert.equal(ai.info.mode, 'replay');
  });

  it('a demo photo or a chosen simulated reading never reaches the model, and a visitor\'s photo does, up to the cap', async () => {
    const { replay, live, calls } = ports(true);
    const use = { reads: 0, turns: 0 };
    const ai = new HostedAi(replay, live, new AiBudget(settings), use);
    assert.deepEqual(await ai.checkInPhoto({ photo: photo('line_ok') } as CheckInPhotoInput), { verdict: 'replayed' });
    assert.deepEqual(calls, ['replay']);
    assert.deepEqual(await ai.checkInPhoto({ photo: photo(null) } as CheckInPhotoInput), { verdict: 'model read' });
    assert.deepEqual(await ai.checkInPhoto({ photo: photo(null) } as CheckInPhotoInput), { verdict: 'model read' });
    assert.equal(use.reads, 2);
    await assert.rejects(() => ai.checkInPhoto({ photo: photo(null) } as CheckInPhotoInput), (e: unknown) => e instanceof AiError && e.kind === 'unavailable' && /used up/.test(e.message));
    assert.deepEqual(calls.filter((c) => c === 'live').length, 2);
  });

  it('the daily cap is shared across markets and resets the next day', async () => {
    const { replay, live } = ports(true);
    let t = Date.parse('2026-11-12T12:00:00Z');
    const budget = new AiBudget(settings, () => t);
    const a = new HostedAi(replay, live, budget, { reads: 0, turns: 0 });
    const b = new HostedAi(replay, live, budget, { reads: 0, turns: 0 });
    await a.checkInPhoto({ photo: photo(null) } as CheckInPhotoInput);
    await a.checkInPhoto({ photo: photo(null) } as CheckInPhotoInput);
    await b.checkInPhoto({ photo: photo(null) } as CheckInPhotoInput);
    await assert.rejects(() => b.checkInPhoto({ photo: photo(null) } as CheckInPhotoInput), /used up/);
    t += 24 * 60 * MIN;
    assert.deepEqual(await b.checkInPhoto({ photo: photo(null) } as CheckInPhotoInput), { verdict: 'model read' });
  });

  it('agent turns stop at the cap and say so', async () => {
    const { replay, live, calls } = ports(true);
    const ai = new HostedAi(replay, live, new AiBudget(settings), { reads: 0, turns: 0 });
    await ai.opsAgentTurn({ agent: 'market' } as never);
    await ai.opsAgentTurn({ agent: 'market' } as never);
    await assert.rejects(() => ai.opsAgentTurn({ agent: 'market' } as never), /used up/);
    assert.equal(calls.filter((c) => c === 'turn').length, 2);
  });

  /** A stand-in for Meta's Muse Spark: decision mode (no tool use), one JSON answer per run, stamped live. */
  function museSpark(fees: number[]) {
    const asked: AiJsonRequest[] = [];
    const provider: AiProvider = {
      id: 'muse',
      model: 'muse-spark-1.3',
      mode: 'live',
      vision: true,
      async json<T>(req: AiJsonRequest) {
        asked.push(req);
        const cents = fees[asked.length - 1] ?? 1000;
        const data = { action: 'lower_fee', maxFeeCents: cents, qty: null, reason: `No queuer is in line yet, so it opens at $${(cents / 100).toFixed(2)}.` };
        return { data: data as T, stamp: { provider: 'muse' as const, model: 'muse-spark-1.3', mode: 'live' as const, latencyMs: 1200 }, usage: null };
      },
      async agent() {
        throw new AiError('unsupported', 'Muse answers in decision mode.');
      },
    };
    // The live port's bidding agent is the real runAgent on that provider, as server/src/ai/index.ts builds it.
    const live = {
      info: { provider: 'muse', model: 'muse-spark-1.3', mode: 'live' },
      biddingAgent: (input: AgentRunInput) => runAgent(input, provider),
      opsAgentTurn: async () => ({ calls: [] }),
    } as unknown as AiPort;
    // The replay port's bidding agent: a replay miss, so the written policy decides.
    const replay = Object.assign(new FakeAi(), { biddingAgent: (input: AgentRunInput) => runAgent(input, null) });
    return { live, replay, asked };
  }

  async function agentRuns(ai: HostedAi, runs: number) {
    const s = await testServer();
    s.app.ai = ai;
    try {
      const placed = await placeBid(s.app, 'mia', { qty: 1, maxFeeCents: 1200, agent: { goal: 'As cheap as I can get it, never above my max fee.' } });
      for (let i = 0; i < runs; i++) {
        startAgentRun(s.app, placed.bid.id);
        await s.app.idle();
      }
      const http = await s.call('GET', `/api/bids/${placed.bid.id}/agent-actions`, { as: 'mia' });
      return { actions: http.json.actions as any[], bid: s.app.store.bids.must(placed.bid.id) };
    } finally {
      await s.done();
    }
  }

  it('the bidding agent decides on the live model under the agent turn caps, then the written rules decide and say why', async () => {
    const { live, replay, asked } = museSpark([1000, 900]);
    const use = { reads: 0, turns: 0 };
    const ai = new HostedAi(replay, live, new AiBudget(settings), use);
    const { actions, bid } = await agentRuns(ai, 3);
    assert.equal(asked.length, 2, 'two model calls: the per-market turn cap');
    assert.equal(use.turns, 2);
    assert.deepEqual(
      actions.slice(0, 2).map((a) => [a.kind, a.fromFeeCents, a.toFeeCents]),
      [
        ['lower_fee', 1200, 1000],
        ['lower_fee', 1000, 900],
      ],
    );
    for (const a of actions.slice(0, 2)) assert.deepEqual([a.ai.provider, a.ai.model, a.ai.mode], ['muse', 'muse-spark-1.3', 'live'], 'the phone row reads "Decided by AI · muse muse-spark-1.3 (live)"');
    assert.equal(bid.maxFeeCents, 900, "each model decision went through the same checks as the requester's own change");
    const third = actions[2];
    assert.equal(third.ai.provider, 'fake', 'past the cap the written policy decides');
    assert.match(third.reason, /\(The written rules decided: the live AI turns of this hosted demo are used up for now\.\)$/);
    await assert.rejects(() => ai.opsAgentTurn({ agent: 'market' } as never), /used up/, 'the ops agents share the same turns');
  });

  it('without a key the bidding agent keeps its written rules and says there is no model', async () => {
    const { replay } = museSpark([]);
    const { actions } = await agentRuns(new HostedAi(replay, null, new AiBudget(settings), { reads: 0, turns: 0 }), 1);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].ai.provider, 'fake');
    assert.match(actions[0].reason, /\(The written rules decided: this hosted demo has no AI model\.\)$/);
  });
});
