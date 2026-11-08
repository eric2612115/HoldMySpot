import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DEMO_MARKET_START } from '@holdmyspot/shared';
import { createAiPort } from '../ai/index.ts';
import { loadConfig } from '../config.ts';
import type { ServerConfig } from '../config.ts';
import { loadSandboxPayPal } from '../ports/load.ts';
import type { AiPort } from '../ports/ai.ts';
import type { PaymentsPort } from '../ports/payments.ts';
import { createServer } from '../server.ts';
import type { HmsServer } from '../server.ts';
import { AiBudget, HostedAi } from './ai.ts';
import type { MarketAiUse } from './ai.ts';
import type { HostedSettings } from './settings.ts';

/**
 * Every visitor's own market (D-163): a whole HoldMySpot server (App, SQLite in memory, its own
 * upload folder) built on first use, removed when idle or at the cap. Nothing in one market can
 * reach another: they share only the process, the AI ports and the PayPal sandbox client.
 */

export type MarketMode = 'fake' | 'sandbox';

export interface ErrandRun {
  status: 'running' | 'done' | 'failed';
  bidId: string;
  steps: string[];
  error: string | null;
}

export interface Market {
  token: string;
  mode: MarketMode;
  server: HmsServer;
  uploadDir: string;
  createdAt: number;
  lastActive: number;
  ai: MarketAiUse;
  errand: ErrandRun | null;
}

export class PoolError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'PoolError';
    this.status = status;
    this.code = code;
  }
}

const GONE_REMEMBERED = 10_000;
const HOUR = 3_600_000;
const WORKERS_AWAKE_MS = 2 * 60_000;

export interface PoolOptions {
  settings: HostedSettings;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  now?: () => number;
  /** Tests: ports to use instead of loading them. */
  replayAi?: AiPort;
  liveAi?: AiPort | null;
  sandboxPayPal?: PaymentsPort | null;
}

export class MarketPool {
  readonly settings: HostedSettings;
  readonly budget: AiBudget;
  readonly #env: Record<string, string | undefined>;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  readonly #secret = randomBytes(32);
  readonly #root: string;
  readonly #markets = new Map<string, Market>();
  readonly #pending = new Map<string, Promise<Market>>();
  readonly #gone = new Set<string>();
  readonly #ipCreates = new Map<string, number[]>();
  #minute: number[] = [];
  #sandboxDay = '';
  #sandboxToday = 0;
  #replay: AiPort | null;
  #live: AiPort | null;
  #sandbox: PaymentsPort | null;
  #sandboxConfigured = false;
  readonly #loadLive: boolean;
  readonly #loadSandbox: boolean;
  #sweep: NodeJS.Timeout | null = null;

  constructor(opts: PoolOptions) {
    this.settings = opts.settings;
    this.#env = opts.env ?? process.env;
    this.#log = opts.log ?? (() => undefined);
    this.#now = opts.now ?? Date.now;
    this.budget = new AiBudget(opts.settings, this.#now);
    this.#root = mkdtempSync(join(tmpdir(), 'hms-hosted-'));
    this.#replay = opts.replayAi ?? null;
    this.#live = opts.liveAi ?? null;
    this.#sandbox = opts.sandboxPayPal ?? null;
    this.#loadLive = opts.liveAi === undefined;
    this.#loadSandbox = opts.sandboxPayPal === undefined;
  }

  /** Loads what every market shares: the replay port, the live port when a key exists, the sandbox client when configured. */
  async init(): Promise<string[]> {
    const report: string[] = [];
    const base = this.#marketConfig('fake', join(this.#root, 'init'));
    if (!this.#replay) this.#replay = await createAiPort({ config: { ...base, ai: { ...base.ai, mode: 'replay' } }, log: () => undefined });
    report.push(`recorded answers: ${this.#replay.info.provider}/${this.#replay.info.model}, ${this.#replay.info.mode}`);
    if (this.#loadLive) {
      const live = await createAiPort({ config: { ...base, ai: { ...base.ai, provider: 'muse', mode: 'live' } }, log: () => undefined });
      this.#live = live.info.mode === 'live' && live.info.provider === 'muse' ? live : null;
    }
    report.push(this.#live ? `live AI: ${this.#live.info.provider}/${this.#live.info.model} (key present, value not shown)` : 'live AI: none (no MODEL_API_KEY); recorded answers and simulated readings only');
    if (this.#loadSandbox) {
      try {
        const cfg = this.#marketConfig('sandbox', join(this.#root, 'init'));
        const loaded = await loadSandboxPayPal(cfg, () => undefined);
        this.#sandbox = loaded.port;
      } catch {
        this.#sandbox = null;
      }
    }
    this.#sandboxConfigured = this.#sandbox !== null;
    report.push(this.#sandbox ? 'PayPal sandbox: available (keys present, values not shown)' : 'PayPal sandbox: not configured; simulated PayPal only');
    return report;
  }

  startSweeping(): void {
    this.#sweep = setInterval(() => void this.sweep(), 60_000);
    this.#sweep.unref();
  }

  // ---- tokens -----------------------------------------------------------

  #sign(id: string): string {
    return createHmac('sha256', this.#secret).update(id).digest('base64url').slice(0, 22);
  }

  /** A new token: random, signed, so only tokens this process gave out can ever create a market. */
  mintToken(): string {
    const id = randomBytes(16).toString('base64url');
    return `${id}.${this.#sign(id)}`;
  }

  validToken(token: string | undefined | null): token is string {
    if (!token || token.length > 80) return false;
    const dot = token.indexOf('.');
    if (dot <= 0) return false;
    const given = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(this.#sign(token.slice(0, dot)));
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  // ---- markets ----------------------------------------------------------

  get size(): number {
    return this.#markets.size + this.#pending.size;
  }

  get liveAiAvailable(): boolean {
    return this.#live !== null;
  }

  get liveAiInfo(): AiPort['info'] | null {
    return this.#live?.info ?? null;
  }

  get sandboxAvailable(): boolean {
    return this.#sandboxConfigured;
  }

  sandboxLeftToday(): number {
    const day = new Date(this.#now()).toISOString().slice(0, 10);
    if (day !== this.#sandboxDay) {
      this.#sandboxDay = day;
      this.#sandboxToday = 0;
    }
    return Math.max(0, this.settings.sandboxPerDay - this.#sandboxToday);
  }

  peek(token: string): Market | undefined {
    return this.#markets.get(token);
  }

  /** A request other than the event stream: the visitor is still here. */
  touch(market: Market): void {
    market.lastActive = this.#now();
  }

  isGone(token: string): boolean {
    return this.#gone.has(token);
  }

  /** The market of this token, created on first use. Concurrent first calls share one market. */
  async obtain(token: string, ip: string, opts: { mode?: MarketMode } = {}): Promise<Market> {
    const market = this.#markets.get(token);
    if (market) {
      if (opts.mode && market.mode !== opts.mode) throw new PoolError(409, 'MARKET_MODE', `This market runs in ${market.mode} mode. Ask for a new session to change it.`);
      return market;
    }
    const pending = this.#pending.get(token);
    if (pending) return pending;
    if (this.#gone.has(token)) throw new PoolError(410, 'MARKET_GONE', 'This market was cleared after being idle or at the capacity limit. Reload the page, or POST /api/demo/session, for a new one.');
    const created = this.#create(token, ip, opts.mode ?? 'fake').finally(() => this.#pending.delete(token));
    this.#pending.set(token, created);
    return created;
  }

  async #create(token: string, ip: string, mode: MarketMode): Promise<Market> {
    const now = this.#now();
    if (mode === 'sandbox') {
      if (!this.#sandbox) throw new PoolError(503, 'SANDBOX_UNAVAILABLE', 'The PayPal sandbox is not configured on this server.');
      if (this.sandboxLeftToday() <= 0) throw new PoolError(429, 'SANDBOX_DAILY_CAP', 'The real PayPal sandbox runs of this hosted demo are used up for today. The simulated market still works.');
    }
    this.#limitCreate(ip, now);
    if (this.#markets.size + this.#pending.size >= this.settings.cap) this.#makeRoom(now);
    const uploadDir = join(this.#root, token.slice(0, 16));
    mkdirSync(uploadDir, { recursive: true });
    const config = this.#marketConfig(mode, uploadDir);
    const ai: MarketAiUse = { reads: 0, turns: 0 };
    if (!this.#replay) throw new Error('MarketPool.init() was not called.');
    let lastActive = (): number => now;
    let clockPaused = (): boolean => true;
    let errandRunning = (): boolean => false;
    const server = await createServer(config, {
      logger: false,
      // A paused market nobody touches has nothing due; its timers wake with its next request.
      workersActive: () => !clockPaused() || errandRunning() || this.#now() - lastActive() < WORKERS_AWAKE_MS,
      ai: new HostedAi(this.#replay, this.#live, this.budget, ai),
      sandboxPayPal: mode === 'sandbox' ? this.#sandbox : null,
      log: (line) => {
        if (line.startsWith('HTTP 5')) this.#log(line);
      },
    });
    await server.fastify.ready();
    if (mode === 'sandbox') this.#sandboxToday++;
    const market: Market = { token, mode, server, uploadDir, createdAt: now, lastActive: now, ai, errand: null };
    lastActive = () => market.lastActive;
    clockPaused = () => server.app.clock.paused;
    errandRunning = () => market.errand?.status === 'running';
    this.#markets.set(token, market);
    return market;
  }

  #limitCreate(ip: string, now: number): void {
    this.#minute = this.#minute.filter((t) => t > now - 60_000);
    if (this.#minute.length >= this.settings.createsPerMinute) throw new PoolError(429, 'CREATE_RATE_LIMITED', 'Too many new markets this minute. Try again shortly.');
    for (const [k, times] of this.#ipCreates) {
      const kept = times.filter((t) => t > now - HOUR);
      if (kept.length === 0) this.#ipCreates.delete(k);
      else this.#ipCreates.set(k, kept);
    }
    const mine = this.#ipCreates.get(ip) ?? [];
    if (mine.length >= this.settings.createsPerIpPerHour) throw new PoolError(429, 'CREATE_RATE_LIMITED', 'Too many new markets from this address in the last hour. Reuse the one you have (X-HMS-Market or the cookie).');
    mine.push(now);
    this.#ipCreates.set(ip, mine);
    this.#minute.push(now);
  }

  #makeRoom(now: number): void {
    let oldest: Market | null = null;
    for (const m of this.#markets.values()) if (!oldest || m.lastActive < oldest.lastActive) oldest = m;
    if (!oldest || now - oldest.lastActive < this.settings.minIdleToEvictMs) throw new PoolError(503, 'MARKET_CAP', 'The hosted demo is at capacity and every market is in use. Try again in a few minutes.');
    void this.evict(oldest, 'capacity');
  }

  async evict(market: Market, reason: string): Promise<void> {
    if (this.#markets.get(market.token) !== market) return;
    this.#markets.delete(market.token);
    this.#rememberGone(market.token);
    this.#log(`market evicted (${reason}); ${this.#markets.size} alive`);
    try {
      market.server.resyncAll('market_gone');
      await market.server.close();
    } catch (err) {
      this.#log(`closing a market failed: ${err instanceof Error ? err.message : 'error'}`);
    }
    rmSync(market.uploadDir, { recursive: true, force: true });
  }

  /** A visitor replaced their market (sandbox choice): free the old one at once. */
  async replace(token: string): Promise<void> {
    const market = this.#markets.get(token);
    if (market) await this.evict(market, 'replaced');
    else this.#rememberGone(token);
  }

  #rememberGone(token: string): void {
    this.#gone.add(token);
    if (this.#gone.size > GONE_REMEMBERED) this.#gone.delete(this.#gone.values().next().value as string);
  }

  async sweep(): Promise<void> {
    const now = this.#now();
    for (const m of [...this.#markets.values()]) {
      if (now - m.lastActive > this.settings.idleMs) await this.evict(m, 'idle');
      else if (now - m.createdAt > this.settings.maxAgeMs) await this.evict(m, 'age');
    }
  }

  async close(): Promise<void> {
    if (this.#sweep) clearInterval(this.#sweep);
    await Promise.all([...this.#markets.values()].map((m) => this.evict(m, 'shutdown')));
    rmSync(this.#root, { recursive: true, force: true });
  }

  #marketConfig(mode: MarketMode, uploadDir: string): ServerConfig {
    const env = this.#env;
    return loadConfig({
      ...env,
      HMS_MODE: mode,
      // The instance never listens: the router is its only door, and only a visitor's own token opens it.
      // Admin routes are open inside the instance (the loopback rule), which is what lets the ops
      // console work with no key in the browser (D-163).
      HMS_HOST: '127.0.0.1',
      HMS_PORT: '0',
      HMS_DB_PATH: ':memory:',
      HMS_UPLOAD_DIR: uploadDir,
      HMS_DEMO: '1',
      HMS_DEMO_RESET: '1',
      HMS_MARKET_START: DEMO_MARKET_START,
      HMS_CLOCK_SPEED: '60',
      HMS_CROWD: env.HMS_CROWD ?? '1',
      HMS_DEMO_SCRIPT: 'hero',
      // A sweep on a market nobody touches costs nothing; a sandbox market polls PayPal a little faster.
      HMS_PAYPAL_POLL_SECONDS: mode === 'sandbox' ? '5' : '20',
      HMS_AI_MODE: 'replay',
    });
  }
}
