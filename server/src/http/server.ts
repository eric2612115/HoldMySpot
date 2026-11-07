import { createHash, timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CONTRACT_VERSION, ContractError, ENDPOINTS, endpointParts } from '@holdmyspot/shared';
import type { ApiKey, HelloEvent, User } from '@holdmyspot/shared';
import { OPS_VIEWER, type App, type Viewer } from '../app/app.ts';
import { canSee, redactEvent } from '../app/views.ts';
import { isLoopback } from '../config.ts';
import type { Director } from '../demo/director.ts';
import { MAX_UPLOAD_BYTES } from '../app/files.ts';
import type { StoredEvent } from '../realtime/bus.ts';
import { toErrorBody } from './errors.ts';
import { buildRoutes, type RouteCtx } from './routes.ts';
import { parseBody } from './schemas.ts';

/**
 * Fastify app for the contract in shared/src/contract.ts: every key of
 * ENDPOINTS is registered (unbuilt ones answer 501 NOT_BUILT), bodies are
 * validated with zod, mutating calls run one at a time with Idempotency-Key
 * replay, and GET /api/events streams the outbox as SSE.
 */

export interface HttpOptions {
  logger?: boolean;
  director?: Director | null;
}

const ALLOW_HEADERS = 'content-type, x-hms-user, x-hms-admin-key, idempotency-key, last-event-id';

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Admin routes are open on a loopback host; elsewhere they need X-HMS-Admin-Key. */
function adminAllowed(app: App, req: FastifyRequest): boolean {
  if (isLoopback(app.config.host)) return true;
  const given = header(req, 'x-hms-admin-key');
  if (!given || !app.config.adminKey) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(app.config.adminKey).digest();
  return timingSafeEqual(a, b);
}

function resolvePersona(app: App, id: string | undefined, req: FastifyRequest, required: boolean): { user: User | null; viewer: Viewer } {
  if (!id) {
    if (required) throw new ContractError('UNAUTHORIZED', 'Send X-HMS-User with a persona id (for example mia or wei).');
    return { user: null, viewer: { userId: null, ops: false } };
  }
  if (id === 'ops') {
    if (!adminAllowed(app, req)) throw new ContractError('UNAUTHORIZED', 'The ops persona needs X-HMS-Admin-Key on this host.');
    return { user: null, viewer: OPS_VIEWER };
  }
  const doc = app.store.users.get(id);
  if (!doc || doc.crowd) throw new ContractError('UNAUTHORIZED', `Unknown persona ${id}.`);
  return { user: doc.user, viewer: { userId: doc.id, ops: false } };
}

function bodyHash(body: unknown): string {
  if (body instanceof Uint8Array) return createHash('sha256').update(body).digest('hex');
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

interface SseConn {
  res: ServerResponse;
  close: (reason: string) => void;
}

export function buildHttp(app: App, opts: HttpOptions = {}): { fastify: FastifyInstance; resyncAll: (reason: string) => void } {
  const fastify = Fastify({
    logger: opts.logger ? { level: app.config.logLevel, redact: ['req.headers["x-hms-admin-key"]', 'req.headers.authorization'] } : false,
    bodyLimit: 1024 * 1024,
  });
  const conns = new Set<SseConn>();
  const resyncAll = (reason: string) => {
    for (const c of [...conns]) c.close(reason);
  };
  const director = opts.director ?? null;
  const routes = buildRoutes({ app, director, resyncAll });

  // JSON with empty bodies allowed (clients send content-type on bodiless POSTs).
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, null);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new ContractError('BAD_REQUEST', 'The body is not valid JSON.'), undefined);
    }
  });
  fastify.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp'], { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));

  fastify.addHook('onRequest', async (req, reply) => {
    const origin = header(req, 'origin');
    if (origin && app.config.webOrigins.includes(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
      reply.header('access-control-allow-headers', ALLOW_HEADERS);
      reply.header('access-control-allow-methods', 'GET, POST, PATCH, OPTIONS');
    }
    if (req.method === 'OPTIONS') return reply.code(204).send();
  });

  fastify.setErrorHandler((err, _req, reply) => {
    const { status, body } = toErrorBody(err);
    if (status >= 500) app.log(`HTTP ${status}: ${err instanceof Error ? err.message : String(err)}`);
    reply.code(status).send(body);
  });
  fastify.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: `No route ${req.method} ${req.url.split('?')[0]}.` } });
  });

  for (const key of Object.keys(ENDPOINTS) as ApiKey[]) {
    const meta = ENDPOINTS[key];
    const { method, path } = endpointParts(key);
    if (meta.sse) {
      fastify.get(path, (req, reply) => openStream(app, req, reply, conns));
      continue;
    }
    const def = routes[key];
    fastify.route({
      method,
      url: path,
      ...(key === 'POST /api/files' ? { bodyLimit: MAX_UPLOAD_BYTES } : {}),
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (!def) throw new ContractError('NOT_BUILT', `${key} is not built yet (${meta.phase}).`);
        if (meta.auth === 'fake' && app.config.mode !== 'fake') throw new ContractError('FAKE_ONLY', 'This route works only in fake mode.');
        if (meta.auth === 'demo' && !director) throw new ContractError('DEMO_ONLY', 'Demo routes need HMS_DEMO=1.');
        let who: { user: User | null; viewer: Viewer };
        if (meta.auth === 'admin') {
          if (!adminAllowed(app, req)) throw new ContractError('UNAUTHORIZED', 'Admin routes need X-HMS-Admin-Key on this host.');
          who = { user: null, viewer: OPS_VIEWER };
        } else {
          who = resolvePersona(app, header(req, 'x-hms-user'), req, meta.auth === 'persona');
        }
        const body = key === 'POST /api/files' ? req.body : parseBody(key, req.body);
        const ctx: RouteCtx = {
          params: req.params as Record<string, string>,
          query: req.query as Record<string, string | undefined>,
          body,
          user: who.user,
          viewer: who.viewer,
          req,
          reply,
        };
        const idemKey = meta.idempotent ? header(req, 'idempotency-key') : undefined;
        if (!def.exec) return def.handler(ctx);
        return app.exec(async () => {
          if (!idemKey) return def.handler(ctx);
          const persona = who.viewer.ops ? 'ops' : (who.viewer.userId ?? '-');
          const hash = bodyHash(body);
          const row = app.db.prepare('SELECT body_hash, response FROM idempotency WHERE key = ? AND route = ? AND persona = ?').get(idemKey, key, persona) as
            | { body_hash: string; response: string }
            | undefined;
          if (row) {
            if (row.body_hash !== hash) throw new ContractError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used with a different request.');
            reply.header('idempotent-replay', 'true');
            return JSON.parse(row.response) as unknown;
          }
          const result = await def.handler(ctx);
          app.db
            .prepare('INSERT INTO idempotency (key, route, persona, body_hash, status, response, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(idemKey, key, persona, hash, 200, JSON.stringify(result ?? null), Date.now());
          return result;
        });
      },
    });
  }
  return { fastify, resyncAll };
}

function envelope(ev: StoredEvent): string {
  const head = ev.seq > 0 ? `id: ${ev.seq}\n` : '';
  return `${head}event: ${ev.type}\ndata: ${JSON.stringify({ seq: ev.seq, type: ev.type, at: ev.at, data: ev.data })}\n\n`;
}

function openStream(app: App, req: FastifyRequest, reply: FastifyReply, conns: Set<SseConn>): void {
  const query = req.query as Record<string, string | undefined>;
  let viewer: Viewer;
  try {
    viewer = resolvePersona(app, query.as || undefined, req, false).viewer;
  } catch (err) {
    const { status, body } = toErrorBody(err);
    void reply.code(status).send(body);
    return;
  }
  const sinceRaw = header(req, 'last-event-id') ?? query.since;
  const since = sinceRaw !== undefined && sinceRaw !== '' && Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : null;

  reply.hijack();
  const res = reply.raw;
  const headers: Record<string, string> = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  };
  const origin = header(req, 'origin');
  if (origin && app.config.webOrigins.includes(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers.vary = 'Origin';
  }
  res.writeHead(200, headers);
  res.write('retry: 2000\n\n');

  let lastSent = 0;
  let replaying = true;
  const buffered: StoredEvent[] = [];
  const send = (ev: StoredEvent) => {
    if (ev.seq > 0 && ev.seq <= lastSent) return;
    if (!canSee(ev, viewer)) return;
    res.write(envelope(redactEvent(ev, viewer)));
    if (ev.seq > 0) lastSent = ev.seq;
  };
  const unsubscribe = app.bus.subscribe((ev) => (replaying ? buffered.push(ev) : send(ev)));

  const latest = app.bus.latestSeq();
  const hello: HelloEvent = {
    contractVersion: CONTRACT_VERSION,
    mode: app.config.mode,
    bootId: app.bootId,
    seq: latest,
    clock: app.clock.state(),
    as: viewer.ops ? 'ops' : viewer.userId,
  };
  res.write(`event: hello\ndata: ${JSON.stringify({ seq: latest, type: 'hello', at: app.now(), data: hello })}\n\n`);

  if (since !== null) {
    const floor = Number(app.db.getMeta('reset-floor') ?? '0');
    const oldest = app.bus.oldestSeq();
    const stale = since > latest || (floor > 0 && since <= floor) || (oldest !== null && since < oldest - 1);
    if (stale) {
      res.write(`event: resync\ndata: ${JSON.stringify({ seq: latest, type: 'resync', at: app.now(), data: { reason: since > latest ? 'unknown_position' : 'events_gone' } })}\n\n`);
      lastSent = latest;
    } else {
      for (const ev of app.bus.after(since)) if (ev.seq <= latest) send(ev);
    }
  } else {
    lastSent = latest;
  }
  replaying = false;
  for (const ev of buffered.splice(0)) send(ev);

  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  ping.unref();
  const conn: SseConn = {
    res,
    close: (reason) => {
      try {
        res.write(`event: resync\ndata: ${JSON.stringify({ seq: app.bus.latestSeq(), type: 'resync', at: app.now(), data: { reason } })}\n\n`);
        res.end();
      } catch {
        // already closed
      }
      cleanup();
    },
  };
  const cleanup = () => {
    clearInterval(ping);
    unsubscribe();
    conns.delete(conn);
  };
  conns.add(conn);
  req.raw.on('close', cleanup);
}
