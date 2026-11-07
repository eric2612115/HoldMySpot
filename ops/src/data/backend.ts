import { CONTRACT_VERSION, DEFAULT_RULES, HEADERS, SEED_SHOPS, apiPath } from '@holdmyspot/shared';
import type { ApiSpec, AppConfig, BookSnapshot, MarketMs, OpsDataset, OpsDatasetName, Shop } from '@holdmyspot/shared';
import { boardDay, worldFromRecords } from './serverWorld.ts';
import { DEFAULT_MOMENT, MOMENTS, PROPOSAL_JO, PROPOSAL_NOOR, worldAt } from './mock/heroDay.ts';
import type { Approvals } from './mock/heroDay.ts';
import { boardBundle, booksAt, datasetsAt, proposalsAt } from './mock/views.ts';
import type { BoardBundle, Proposal } from './mock/views.ts';
import { getJob, moveProblem, targetAsk } from './mock/world.ts';
import type { ManualMove } from './mock/world.ts';
import { parseMarketTime } from './time.ts';

export type { BoardBundle, Proposal, ProposedMove } from './mock/views.ts';

/** Everything the console draws for one market moment. */
export interface MarketSnapshot {
  at: MarketMs;
  config: AppConfig;
  bundle: BoardBundle;
  books: BookSnapshot[];
  datasets: Record<OpsDatasetName, OpsDataset>;
  proposals: Proposal[];
  shops: Shop[];
}

export interface OpsBackend {
  kind: 'mock' | 'server';
  /** Moments to jump to (mock only). */
  moments: { id: string; label: string; at: MarketMs }[];
  initialAt(): MarketMs;
  snapshot(at: MarketMs): Promise<MarketSnapshot>;
  approve(proposalId: string, at: MarketMs): Promise<void>;
  /** Synchronous, for drag feedback: why this job cannot move to that queuer, or null. */
  moveProblem(jobId: string, toQueuerId: string, at: MarketMs): string | null;
  move(jobId: string, toQueuerId: string, at: MarketMs): Promise<string | null>;
  /** Server mode: pause or resume the server's own clock (demo runs). */
  setRunning?(running: boolean): Promise<void>;
}

function fakeConfig(at: MarketMs): AppConfig {
  return {
    contractVersion: CONTRACT_VERSION,
    mode: 'fake',
    modeReason: 'Ops console mock: the HoldMySpot server is not running, so the console replays the hero day in the browser.',
    paypal: { clientId: null, sdkUrl: null, components: [], currency: 'USD', testBuyerCountry: null, funding: ['paypal', 'venmo'] },
    ai: { provider: 'fake', model: 'rules', mode: 'fake' },
    clock: { speed: 60, paused: true, marketNow: at, realNow: Date.now() },
    demo: { enabled: true, scriptId: 'hero' },
    rules: DEFAULT_RULES,
  };
}

/** Approvals given in the URL (?approve=all or ?approve=jo,noor), applied at the opening moment. */
function approvalsFromUrl(at: MarketMs): Approvals {
  const value = new URLSearchParams(location.search).get('approve');
  if (!value) return {};
  const all = value === 'all';
  const out: Approvals = {};
  if (all || value.includes('jo')) out[PROPOSAL_JO] = Math.min(at, Date.parse('2026-11-12T11:21:00-08:00'));
  if (all || value.includes('noor')) out[PROPOSAL_NOOR] = Math.min(at, Date.parse('2026-11-12T11:22:00-08:00'));
  return out;
}

export class MockBackend implements OpsBackend {
  readonly kind = 'mock' as const;
  readonly moments = MOMENTS;
  private approvals: Approvals;
  private moves: ManualMove[] = [];
  private readonly startAt: MarketMs;

  constructor() {
    this.startAt = parseMarketTime(new URLSearchParams(location.search).get('at')) ?? DEFAULT_MOMENT;
    this.approvals = approvalsFromUrl(this.startAt);
  }

  initialAt(): MarketMs {
    return this.startAt;
  }

  async snapshot(at: MarketMs): Promise<MarketSnapshot> {
    const approvals = Object.fromEntries(Object.entries(this.approvals).filter(([, t]) => t <= at));
    const moves = this.moves.filter((m) => m.at <= at);
    const w = worldAt(at, approvals, moves);
    return {
      at,
      config: fakeConfig(at),
      bundle: boardBundle(w, at),
      books: booksAt(w, at),
      datasets: datasetsAt(w, at),
      proposals: proposalsAt(at, approvals),
      shops: SEED_SHOPS,
    };
  }

  async approve(proposalId: string, at: MarketMs): Promise<void> {
    if (this.approvals[proposalId] === undefined) this.approvals = { ...this.approvals, [proposalId]: at };
  }

  moveProblem(jobId: string, toQueuerId: string, at: MarketMs): string | null {
    const w = worldAt(at, this.approvals, this.moves);
    const job = w.jobs.find((j) => j.id === jobId);
    if (!job) return 'This job is no longer on the board.';
    return moveProblem(w, job, toQueuerId, at);
  }

  async move(jobId: string, toQueuerId: string, at: MarketMs): Promise<string | null> {
    const w = worldAt(at, this.approvals, this.moves);
    const job = getJob(w, jobId);
    const problem = moveProblem(w, job, toQueuerId, at);
    if (problem) return problem;
    const ask = targetAsk(w, job, toQueuerId);
    if (!ask) return 'No open offer to move to.';
    this.moves = [...this.moves, { bidId: job.bidId, fromAskId: job.askId, toAskId: ask.id, at }];
    return null;
  }
}

/**
 * Talks to the HoldMySpot server through the contract. The server owns the
 * clock, the rules and every record: the console reads them in one call
 * (GET /api/ops/records) and draws them with the same functions the replay
 * uses (boardBundle, datasetsAt), with the server's own book snapshots. The
 * console polls; the clock button pauses and resumes a demo run.
 * Rescheduling proposals and drag-to-reassign need routes the contract does
 * not have yet, so they stay in the replay for now.
 */
export class ServerBackend implements OpsBackend {
  readonly kind = 'server' as const;
  readonly moments: { id: string; label: string; at: MarketMs }[] = [];
  private shops: Shop[] | null = null;
  private last: { sig: string; snapshot: MarketSnapshot } | null = null;
  constructor(
    private readonly base: string,
    private clockAt: MarketMs,
  ) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {};
    const admin = import.meta.env.VITE_HMS_ADMIN_KEY as string | undefined;
    if (admin) headers[HEADERS.admin] = admin;
    return headers;
  }

  private async get<K extends keyof ApiSpec>(path: string): Promise<ApiSpec[K]['response']> {
    const res = await fetch(`${this.base}${path}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    return (await res.json()) as ApiSpec[K]['response'];
  }

  initialAt(): MarketMs {
    return this.clockAt;
  }

  async snapshot(): Promise<MarketSnapshot> {
    const [config, records, books, shops] = await Promise.all([
      this.get<'GET /api/config'>('/api/config'),
      this.get<'GET /api/ops/records'>('/api/ops/records'),
      this.get<'GET /api/books'>('/api/books'),
      this.shops ? Promise.resolve({ shops: this.shops }) : this.get<'GET /api/shops'>('/api/shops'),
    ]);
    this.shops = shops.shops;
    const at = records.at;
    this.clockAt = at;
    // A paused market answers the same records: keep the same snapshot so nothing redraws.
    const sig = JSON.stringify([config.mode, config.clock.paused, config.clock.speed, records, books.books]);
    if (this.last?.sig === sig) return this.last.snapshot;
    const w = worldFromRecords(records);
    const snapshot: MarketSnapshot = {
      at,
      config,
      bundle: boardBundle(w, at, boardDay(at)),
      books: books.books,
      datasets: datasetsAt(w, at, books.books),
      proposals: [],
      shops: shops.shops,
    };
    this.last = { sig, snapshot };
    return snapshot;
  }

  /** Pauses or resumes the server's market clock (demo mode). */
  async setRunning(running: boolean): Promise<void> {
    const res = await fetch(`${this.base}${apiPath(running ? 'POST /api/demo/resume' : 'POST /api/demo/pause', {})}`, { method: 'POST', headers: this.headers() });
    if (!res.ok) throw new Error(`The server clock is not under demo control (${res.status}).`);
  }

  async approve(): Promise<void> {
    await fetch(`${this.base}/api/ops/sweep`, { method: 'POST', headers: this.headers() });
  }

  moveProblem(): string | null {
    return 'Moving a job needs a reassign route on the server (not in the contract yet).';
  }

  async move(): Promise<string | null> {
    return this.moveProblem();
  }
}

/** The server's market time now (its clock runs on its own speed). */
async function serverClock(base: string): Promise<MarketMs> {
  try {
    const c = (await (await fetch(`${base}/api/clock`)).json()) as ApiSpec['GET /api/clock']['response'];
    return c.paused ? c.marketNow : c.marketNow + (Date.now() - c.realNow) * c.speed;
  } catch {
    return Date.now();
  }
}

async function serverAnswers(base: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 700);
    const res = await fetch(`${base}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const body = (await res.json()) as ApiSpec['GET /api/health']['response'];
    return body.ok === true && body.contractVersion === CONTRACT_VERSION;
  } catch {
    return false;
  }
}

/** auto (default): the server when it answers with the same contract version, else the mock. */
export async function pickBackend(): Promise<OpsBackend> {
  const params = new URLSearchParams(location.search);
  const wanted = params.get('backend') ?? (import.meta.env.VITE_HMS_BACKEND as string | undefined) ?? 'auto';
  const base = (import.meta.env.VITE_HMS_API as string | undefined) ?? '';
  if (wanted === 'mock') return new MockBackend();
  if (wanted === 'server' || (await serverAnswers(base))) return new ServerBackend(base, await serverClock(base));
  return new MockBackend();
}
