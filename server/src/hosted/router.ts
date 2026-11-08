import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { CONTRACT_VERSION, HERO } from '@holdmyspot/shared';
import type { Market, MarketMode, MarketPool } from './pool.ts';
import { PoolError } from './pool.ts';
import { runSandboxErrand, sandboxErrandStatus } from './sandboxErrand.ts';

/**
 * The one door of the hosted server (D-163). A plain node:http handler in front of a pool of
 * whole HoldMySpot servers: it serves the built pages, finds the visitor's market from a cookie or
 * the X-HMS-Market header, and hands the raw request to that market's Fastify (`routing`), so the
 * event stream and photo uploads work unchanged. No admin key exists on this path: an instance's
 * admin routes are reachable only through its owner's token.
 */

export const COOKIE = 'hms_market';
export const MARKET_HEADER = 'x-hms-market';
const COOKIE_MAX_AGE_S = 8 * 60 * 60;

/** Query words of a phone link; without one, `/` is the judge's page. */
const PHONE_PARAMS = ['demo', 'phone', 'as', 'queuer', 'backend', 'view', 'city', 'speed'];

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.gltf': 'model/gltf+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.gltf', '.map']);

export interface RouterOptions {
  webDist: string;
  opsDist: string;
  log?: (line: string) => void;
  startedAt?: number;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** The address a create is counted against. The proxy in front of Render puts the client first. */
export function clientIp(req: IncomingMessage): string {
  return (headerValue(req, 'x-forwarded-for') ?? '').split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

function isHttps(req: IncomingMessage): boolean {
  return headerValue(req, 'x-forwarded-proto') === 'https';
}

function setCookie(res: ServerResponse, req: IncomingMessage, token: string): void {
  res.setHeader('set-cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}${isHttps(req) ? '; Secure' : ''}`);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 16 * 1024) throw new PoolError(413, 'BODY_TOO_LARGE', 'That body is too large.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new PoolError(400, 'BAD_REQUEST', 'The body is not valid JSON.');
  }
}

/** Runs the market's own routes in-process, so a hosted action obeys the same checks a request would. */
async function inner(market: Market, method: 'GET' | 'POST', url: string, body?: unknown, persona?: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (persona) headers['x-hms-user'] = persona;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await market.server.fastify.inject({ method, url, headers, ...(body !== undefined ? { payload: body as object } : {}) });
  if (res.statusCode >= 400) throw new PoolError(res.statusCode, 'MARKET_ERROR', `${method} ${url} answered ${res.statusCode}.`);
  return res.body ? JSON.parse(res.body) : null;
}

interface Entry {
  kind: string;
  amount: { cents: number };
  status: string;
}

/** Totals for the judge's page, from the same ledger the phones read. */
async function moneyOf(market: Market): Promise<{ heldCents: number; capturedCents: number; releasedCents: number; paidCents: number }> {
  const [mia, wei] = (await Promise.all([inner(market, 'GET', '/api/ledger?mine=1', undefined, HERO.requesterId), inner(market, 'GET', '/api/ledger?mine=1', undefined, HERO.queuerId)])) as { entries: Entry[] }[];
  const sum = (entries: Entry[], kind: string) => entries.filter((e) => e.kind === kind && e.status === 'succeeded').reduce((n, e) => n + e.amount.cents, 0);
  return { heldCents: sum(mia!.entries, 'held'), capturedCents: sum(mia!.entries, 'captured'), releasedCents: sum(mia!.entries, 'released'), paidCents: sum(wei!.entries, 'paid_out') };
}

export function createRouter(pool: MarketPool, opts: RouterOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const log = opts.log ?? (() => undefined);
  const startedAt = opts.startedAt ?? Date.now();
  const webDist = resolve(opts.webDist);
  const opsDist = resolve(opts.opsDist);
  const gzipped = new Map<string, Buffer>();

  const tokenOf = (req: IncomingMessage): string | null => {
    const fromHeader = headerValue(req, MARKET_HEADER);
    if (fromHeader) return pool.validToken(fromHeader) ? fromHeader : null;
    const fromCookie = cookies(req)[COOKIE];
    return pool.validToken(fromCookie) ? fromCookie : null;
  };

  /** Static files: dotfiles and anything outside the build folder are 404. */
  const file = (req: IncomingMessage, res: ServerResponse, root: string, rel: string): boolean => {
    const clean = normalize(rel);
    if (clean.split(sep).some((p) => p.startsWith('.'))) return false;
    const path = resolve(join(root, clean));
    if (path !== root && !path.startsWith(root + sep)) return false;
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    const ext = extname(path).toLowerCase();
    const type = TYPES[ext] ?? 'application/octet-stream';
    const immutable = /[/\\]assets[/\\]/.test(path);
    const headers: Record<string, string | number> = { 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache', 'x-content-type-options': 'nosniff' };
    if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(headerValue(req, 'accept-encoding') ?? '')) {
      const key = `${path}:${stat.mtimeMs}`;
      let body = gzipped.get(key);
      if (!body) {
        body = gzipSync(readFileSync(path));
        gzipped.set(key, body);
      }
      res.writeHead(200, { ...headers, 'content-encoding': 'gzip', 'content-length': body.length, vary: 'Accept-Encoding' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return true;
    }
    res.writeHead(200, { ...headers, 'content-length': stat.size });
    if (req.method === 'HEAD') res.end();
    else createReadStream(path).pipe(res);
    return true;
  };

  /** An HTML page: gives the browser its market cookie (a token only, no market is built yet). */
  const page = (req: IncomingMessage, res: ServerResponse, root: string, rel: string): void => {
    const existing = cookies(req)[COOKIE];
    if (!pool.validToken(existing) || pool.isGone(existing)) setCookie(res, req, pool.mintToken());
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    if (!file(req, res, root, rel)) sendError(res, 503, 'NOT_BUILT', 'This page is not built. Run npm run hosted, or the build command in docs/HOSTING.md.');
  };

  const handleHostedRoute = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const token = tokenOf(req);
    if (path === '/api/hosted/info' && req.method === 'GET') {
      const market = token ? pool.peek(token) : undefined;
      const use = market?.ai ?? { reads: 0, turns: 0 };
      sendJson(res, 200, {
        hosted: true,
        demo: market?.server.director?.state() ?? null,
        money: market ? await moneyOf(market) : null,
        market: market ? 'alive' : token && pool.isGone(token) ? 'gone' : 'none',
        marketMode: market?.mode ?? null,
        idleMinutes: Math.round(pool.settings.idleMs / 60_000),
        sandbox: { available: pool.sandboxAvailable, leftToday: pool.sandboxLeftToday() },
        ai: {
          live: pool.liveAiAvailable,
          provider: pool.liveAiInfo?.provider ?? null,
          model: pool.liveAiInfo?.model ?? null,
          readsLeft: pool.liveAiAvailable ? pool.budget.readsLeft(use) : 0,
          turnsLeft: pool.liveAiAvailable ? pool.budget.turnsLeft(use) : 0,
        },
      });
      return;
    }
    if (!token) return sendError(res, 401, 'NO_MARKET', 'No market on this request. Open the site in a browser, or POST /api/demo/session and send its token as X-HMS-Market.');
    const market = await pool.obtain(token, clientIp(req));
    pool.touch(market);
    const director = market.server.director;
    if (!director) return sendError(res, 500, 'NO_DIRECTOR', 'This market has no demo director.');

    if (req.method === 'POST' && path === '/api/hosted/hold') {
      if (market.mode === 'sandbox') return sendError(res, 409, 'USE_PAYPAL_WINDOW', "On the real sandbox, tap the plush on Mia's phone and approve the hold in PayPal's window.");
      for (let i = 0; i < 5; i++) {
        const next = director.peek();
        if (!next || next.index > 2) break;
        await director.step();
      }
      return sendJson(res, 200, { state: director.state() });
    }
    if (req.method === 'POST' && path === '/api/hosted/run') {
      if (market.mode === 'sandbox') return sendError(res, 409, 'USE_ERRAND', 'On the real sandbox, use "Let Wei run the errand".');
      await inner(market, 'POST', '/api/demo/clock', { speed: pool.settings.errandSpeed });
      await inner(market, 'POST', '/api/demo/resume', {});
      return sendJson(res, 200, { state: director.state() });
    }
    if (req.method === 'POST' && path === '/api/hosted/break') {
      if (market.mode === 'sandbox') return sendError(res, 409, 'USE_ERRAND', 'Try to break it runs on the simulated market.');
      if (director.state().status === 'running') director.pause();
      for (let i = 0; i < 40; i++) {
        const next = director.peek();
        if (!next) return sendError(res, 409, 'ERRAND_OVER', 'This errand has finished. Start over to try again.');
        if (next.kind === 'job.proof' && next.label.startsWith('Wei uploads')) break;
        await director.step();
      }
      const jobs = market.server.app.store.jobs.where('queuer_id = ? AND requester_id = ?', HERO.queuerId, HERO.requesterId);
      return sendJson(res, 200, { state: director.state(), jobId: jobs.at(-1)?.id ?? null });
    }
    if (req.method === 'POST' && path === '/api/hosted/errand') return sendJson(res, 202, await runSandboxErrand(market, log));
    if (req.method === 'GET' && path === '/api/hosted/errand') return sendJson(res, 200, await sandboxErrandStatus(market));
    sendError(res, 404, 'NOT_FOUND', `No route ${req.method} ${path}.`);
  };

  const handleSession = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJson(req);
    const mode: MarketMode = body.mode === 'sandbox' ? 'sandbox' : 'fake';
    const token = pool.mintToken();
    const old = tokenOf(req);
    await pool.obtain(token, clientIp(req), { mode });
    if (old && old !== token && !headerValue(req, MARKET_HEADER)) await pool.replace(old);
    setCookie(res, req, token);
    sendJson(res, 201, {
      token,
      header: 'X-HMS-Market',
      mode,
      idleMinutes: Math.round(pool.settings.idleMs / 60_000),
      next: 'Send this token as the X-HMS-Market header on every call. Every route in docs/API.md then acts on your own market; POST /api/demo/start {"scriptId":"hero","speed":600} runs the scripted day.',
    });
  };

  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://hosted.invalid');
    const path = url.pathname;
    res.setHeader('x-content-type-options', 'nosniff');

    void (async () => {
      if (path === '/api/health') {
        sendJson(res, 200, { ok: true, mode: 'fake', contractVersion: CONTRACT_VERSION, uptimeMs: Date.now() - startedAt, hosted: { markets: pool.size, cap: pool.settings.cap } });
        return;
      }
      if (path === '/api/demo/session' && req.method === 'POST') return handleSession(req, res);
      if (path.startsWith('/api/hosted/')) return handleHostedRoute(req, res, path);
      if (path.startsWith('/api/') || path === '/api') {
        const token = tokenOf(req);
        if (!token) {
          sendError(res, 401, 'NO_MARKET', 'No market on this request. Open the site in a browser, or POST /api/demo/session and send its token as X-HMS-Market.');
          return;
        }
        const market = await pool.obtain(token, clientIp(req));
        if (path !== '/api/events') pool.touch(market);
        if (req.method === 'POST' && (path === '/api/demo/reset' || path === '/api/demo/start')) {
          if (market.errand?.status === 'running') {
            sendError(res, 409, 'ERRAND_RUNNING', "Wei's errand is still running on PayPal's sandbox. Wait for it to finish.");
            return;
          }
          market.errand = null;
        }
        market.server.fastify.routing(req, res);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Pages only answer GET.');
        return;
      }
      if (path === '/ops') {
        res.writeHead(308, { location: `/ops/${url.search}` });
        res.end();
        return;
      }
      if (path === '/ops/') return page(req, res, opsDist, 'index.html');
      if (path.startsWith('/ops/')) {
        if (!file(req, res, opsDist, path.slice('/ops/'.length))) sendError(res, 404, 'NOT_FOUND', `No file ${path}.`);
        return;
      }
      if (path === '/') {
        const phone = PHONE_PARAMS.some((k) => url.searchParams.has(k));
        const judge = !phone && existsSync(join(webDist, 'judge.html'));
        return page(req, res, webDist, judge ? 'judge.html' : 'index.html');
      }
      if (path === '/characters') return page(req, res, webDist, 'index.html');
      if (!file(req, res, webDist, path.slice(1))) sendError(res, 404, 'NOT_FOUND', `No file ${path}.`);
    })().catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof PoolError) return sendError(res, err.status, err.code, err.message);
      log(`router error: ${err instanceof Error ? err.message : String(err)}`);
      sendError(res, 500, 'INTERNAL', 'Something went wrong on the server.');
    });
  };
}
