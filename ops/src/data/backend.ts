import { CONTRACT_VERSION, DEFAULT_RULES, HEADERS, SEED_SHOPS, apiPath } from '@holdmyspot/shared';
import type { ApiErrorBody, ApiSpec, AppConfig, BookSnapshot, MarketMs, OpsDataset, OpsDatasetName, OpsMovesRequest, OpsRecords, Shop } from '@holdmyspot/shared';
import { casesFromRecords, manualRefundCase, refundablePicks } from '../people/cases.ts';
import type { PeopleCase, RefundablePick } from '../people/cases.ts';
import { emptyReplayState, peopleCasesAt, replayRefundablePicks } from './mock/peopleDay.ts';
import type { PeopleReplayState } from './mock/peopleDay.ts';
import { actionsFor, proposalsAt } from '../agents/rescheduler.ts';
import type { Proposal } from '../agents/rescheduler.ts';
import { boardDay, worldFromRecords } from './serverWorld.ts';
import { DEFAULT_MOMENT, MOMENTS, PROPOSAL_JO, PROPOSAL_NOOR, worldAt } from './mock/heroDay.ts';
import { boardBundle, booksAt, datasetsAt } from './mock/views.ts';
import type { BoardBundle } from './mock/views.ts';
import { RULES_STAMP, moveProblem, targetAsk } from './mock/world.ts';
import type { OpsAction, World } from './mock/world.ts';
import { parseMarketTime, sf } from './time.ts';

export type { BoardBundle } from './mock/views.ts';
export type { Proposal, ProposalOption, ProposedMove } from '../agents/rescheduler.ts';

/** Everything the console draws for one market moment. */
export interface MarketSnapshot {
  at: MarketMs;
  config: AppConfig;
  bundle: BoardBundle;
  books: BookSnapshot[];
  datasets: Record<OpsDatasetName, OpsDataset>;
  proposals: Proposal[];
  shops: Shop[];
  /** Open cases for the "Needs a person" page. */
  people: PeopleCase[];
  refundable: RefundablePick[];
}

export interface OpsBackend {
  kind: 'mock' | 'server';
  /** Moments to jump to (mock only). */
  moments: { id: string; label: string; at: MarketMs }[];
  initialAt(): MarketMs;
  snapshot(at: MarketMs): Promise<MarketSnapshot>;
  /** Applies one option of a rescheduler proposal (the chosen one when `optionId` is null). Returns what happened. */
  approve(proposal: Proposal, optionId: string | null, at: MarketMs): Promise<string>;
  /** Synchronous, for drag feedback: why this job cannot move to that queuer, or null. */
  moveProblem(jobId: string, toQueuerId: string, at: MarketMs): string | null;
  move(jobId: string, toQueuerId: string, at: MarketMs): Promise<string | null>;
  /** Server mode: pause or resume the server's own clock (demo runs). */
  setRunning?(running: boolean): Promise<void>;
  // ---- "Needs a person" (D-158) ----------------------------------------
  reviewProof(proofId: string, decision: 'pass' | 'fail', note: string): Promise<string>;
  refund(jobId: string, amountCents: number, reason: string): Promise<string>;
  closeRefundRequest(jobId: string, note: string): Promise<string>;
  sendEvidence(disputeId: string, note: string, includeTracking: boolean): Promise<string>;
  acceptClaim(disputeId: string, note: string): Promise<string>;
  adjudicate(disputeId: string, outcome: 'buyer_favor' | 'seller_favor'): Promise<string>;
  /** A URL for a stored proof photo, or null when it cannot be read. */
  photoUrl(fileId: string): Promise<string | null>;
  /** A refund row for a job a person picked, or null when the job is gone. */
  manualRefund(jobId: string): PeopleCase | null;
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

/** The approvals the URL asks for (?approve=all, or jo / noor), each made at its scene's moment with the rules' choice. */
function approvalsFromUrl(at: MarketMs): OpsAction[] {
  const value = new URLSearchParams(location.search).get('approve');
  if (!value) return [];
  const scenes: [string, string, MarketMs][] = [
    ['jo', PROPOSAL_JO, Math.min(at, sf('11:21'))],
    ['noor', PROPOSAL_NOOR, Math.min(at, sf('11:22'))],
  ];
  const actions: OpsAction[] = [];
  for (const [name, id, t] of scenes) {
    if (value !== 'all' && !value.includes(name)) continue;
    const proposal = proposalsAt(worldAt(t, actions), t, actions).find((p) => p.id === id && p.status === 'open');
    if (proposal) actions.push(...actionsFor(proposal, null, t));
  }
  return actions;
}

export class MockBackend implements OpsBackend {
  readonly kind = 'mock' as const;
  readonly moments = MOMENTS;
  /** Moves ops made (approvals and drags), replayed at their times. */
  private actions: OpsAction[];
  private readonly startAt: MarketMs;
  /** What a person did on the "Needs a person" page, in this browser. */
  private people: PeopleReplayState = emptyReplayState;

  constructor() {
    this.startAt = parseMarketTime(new URLSearchParams(location.search).get('at')) ?? DEFAULT_MOMENT;
    this.actions = approvalsFromUrl(this.startAt);
  }

  initialAt(): MarketMs {
    return this.startAt;
  }

  private world(at: MarketMs): World {
    return worldAt(at, this.actions.filter((a) => a.at <= at));
  }

  async snapshot(at: MarketMs): Promise<MarketSnapshot> {
    const actions = this.actions.filter((a) => a.at <= at);
    const w = worldAt(at, actions);
    return {
      at,
      config: fakeConfig(at),
      bundle: boardBundle(w, at),
      books: booksAt(w, at),
      datasets: datasetsAt(w, at),
      proposals: proposalsAt(w, at, actions),
      shops: SEED_SHOPS,
      people: peopleCasesAt(at, this.people),
      refundable: replayRefundablePicks,
    };
  }

  private closePeople(id: string, patch: Partial<PeopleReplayState> = {}): void {
    this.people = { ...this.people, closed: new Set([...this.people.closed, id]), ...patch };
  }

  async reviewProof(_proofId: string, decision: 'pass' | 'fail'): Promise<string> {
    this.closePeople('receipt:replay-receipt');
    return `${decision === 'pass' ? 'Passed' : 'Failed'} in this replay. No money moved and nothing left this browser.`;
  }

  async refund(_jobId: string, amountCents: number, reason: string): Promise<string> {
    if (amountCents > 4947) throw new Error('Only $49.47 of this job can be refunded.');
    this.closePeople('refund:replay-refund');
    return `Refunded $${(amountCents / 100).toFixed(2)} in this replay (${reason}). PayPal is not called here.`;
  }

  async closeRefundRequest(): Promise<string> {
    this.closePeople('refund:replay-refund');
    return 'Closed without a refund, in this replay.';
  }

  async sendEvidence(): Promise<string> {
    this.people = { ...this.people, sent: new Set([...this.people.sent, 'dispute:replay-dispute']) };
    return 'Sent in this replay. On a live server this goes to PayPal with the receipt and item photos attached.';
  }

  async acceptClaim(): Promise<string> {
    this.closePeople('dispute:replay-dispute');
    return 'Claim accepted, in this replay. PayPal is not called here.';
  }

  async adjudicate(_disputeId: string, outcome: 'buyer_favor' | 'seller_favor'): Promise<string> {
    this.closePeople('dispute:replay-dispute');
    return `Settled for the ${outcome === 'buyer_favor' ? 'buyer' : 'seller'}, in this replay. PayPal is not called here.`;
  }

  async photoUrl(): Promise<string | null> {
    return null;
  }

  manualRefund(): PeopleCase | null {
    return null;
  }

  async approve(proposal: Proposal, optionId: string | null, at: MarketMs): Promise<string> {
    if (this.actions.some((a) => a.proposalId === proposal.id && a.at <= at)) return 'Already approved.';
    const actions = actionsFor(proposal, optionId, at);
    this.actions = [...this.actions, ...actions];
    return actions.length ? 'Approved. The board shows the new plan.' : 'Nothing to move.';
  }

  moveProblem(jobId: string, toQueuerId: string, at: MarketMs): string | null {
    const w = this.world(at);
    const job = w.jobs.find((j) => j.id === jobId);
    if (!job) return 'This job is no longer on the board.';
    return moveProblem(w, job, toQueuerId, at);
  }

  async move(jobId: string, toQueuerId: string, at: MarketMs): Promise<string | null> {
    const w = this.world(at);
    const job = w.jobs.find((j) => j.id === jobId);
    if (!job) return 'This job is no longer on the board.';
    const problem = moveProblem(w, job, toQueuerId, at);
    if (problem) return problem;
    const ask = targetAsk(w, job, toQueuerId);
    if (!ask) return 'No open offer to move to.';
    this.actions = [...this.actions, { at, proposalId: null, move: { kind: 'reassign', jobId, toAskId: ask.id }, reason: 'Dragged on the board by ops.', label: 'Dragged on the board', ai: RULES_STAMP }];
    return null;
  }
}

/**
 * Talks to the HoldMySpot server through the contract. The server owns the
 * clock, the rules and every record: the console reads them in one call
 * (GET /api/ops/records) and draws them with the same functions the replay
 * uses (boardBundle, datasetsAt, and the rescheduler's proposalsAt), with the
 * server's own book snapshots. The console polls; the clock button pauses and
 * resumes a demo run. Approvals and drags go to POST /api/ops/moves, where
 * the server checks every move again with its own rules (D-102).
 */
export class ServerBackend implements OpsBackend {
  readonly kind = 'server' as const;
  readonly moments: { id: string; label: string; at: MarketMs }[] = [];
  private shops: Shop[] | null = null;
  private last: { sig: string; snapshot: MarketSnapshot; world: World; records: OpsRecords } | null = null;
  /** Approvals made from this console, so their cards stay as "approved" after the problem is gone. */
  private approved: OpsAction[] = [];
  constructor(
    private readonly base: string,
    private clockAt: MarketMs,
  ) {}

  private headers(json = false): Record<string, string> {
    const headers: Record<string, string> = json ? { 'content-type': 'application/json' } : {};
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
    const sig = JSON.stringify([config.mode, config.clock.paused, config.clock.speed, records, books.books, this.approved.length]);
    if (this.last?.sig === sig) return this.last.snapshot;
    const w = worldFromRecords(records);
    const snapshot: MarketSnapshot = {
      at,
      config,
      bundle: boardBundle(w, at, boardDay(at)),
      books: books.books,
      datasets: datasetsAt(w, at, books.books),
      proposals: proposalsAt(w, at, this.approved),
      shops: shops.shops,
      people: casesFromRecords(records),
      refundable: refundablePicks(records, casesFromRecords(records)),
    };
    this.last = { sig, snapshot, world: w, records };
    return snapshot;
  }

  /** Pauses or resumes the server's market clock (demo mode). */
  async setRunning(running: boolean): Promise<void> {
    const res = await fetch(`${this.base}${apiPath(running ? 'POST /api/demo/resume' : 'POST /api/demo/pause', {})}`, { method: 'POST', headers: this.headers() });
    if (!res.ok) throw new Error(`The server clock is not under demo control (${res.status}).`);
  }

  /** One "Needs a person" write. A stable key per case makes a double click one action. */
  private async post<T>(path: string, body: unknown, idemKey: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, { method: 'POST', headers: { ...this.headers(true), 'idempotency-key': idemKey }, body: JSON.stringify(body) });
    if (!res.ok) {
      let problem = `The server answered ${res.status}.`;
      try {
        problem = ((await res.json()) as ApiErrorBody).error.message || problem;
      } catch {
        // keep the status line
      }
      throw new Error(problem);
    }
    return (await res.json()) as T;
  }

  async reviewProof(proofId: string, decision: 'pass' | 'fail', note: string): Promise<string> {
    await this.post(`/api/ops/proofs/${encodeURIComponent(proofId)}/review`, { decision, note }, `people-review-${proofId}-${decision}`);
    return decision === 'pass' ? 'Passed. The money follows the receipt.' : 'Failed. Nothing is charged for it.';
  }

  async refund(jobId: string, amountCents: number, reason: string): Promise<string> {
    // The key names what was left: a double click is one refund, and a later refund of the same amount is a new one.
    const job = this.last?.records.jobs.find((j) => j.id === jobId);
    const left = job ? job.amounts.capturedCents - job.amounts.refundedCents : 'unknown';
    await this.post(`/api/ops/jobs/${encodeURIComponent(jobId)}/refund`, { amountCents, reason }, `people-refund-${jobId}-${left}-${amountCents}`);
    return `Refunded $${(amountCents / 100).toFixed(2)} through PayPal.`;
  }

  async closeRefundRequest(jobId: string, note: string): Promise<string> {
    await this.post(`/api/ops/jobs/${encodeURIComponent(jobId)}/refund-request/close`, { note }, `people-close-${jobId}`);
    return 'Closed without a refund.';
  }

  async sendEvidence(disputeId: string, note: string, includeTracking: boolean): Promise<string> {
    await this.post(`/api/ops/disputes/${encodeURIComponent(disputeId)}/evidence`, { note, includeTracking }, `people-evidence-${disputeId}`);
    return 'Sent to PayPal with the receipt and item photos attached.';
  }

  async acceptClaim(disputeId: string, note: string): Promise<string> {
    await this.post(`/api/ops/disputes/${encodeURIComponent(disputeId)}/accept`, { note }, `people-accept-${disputeId}`);
    return 'Claim accepted on PayPal.';
  }

  async adjudicate(disputeId: string, outcome: 'buyer_favor' | 'seller_favor'): Promise<string> {
    await this.post(`/api/ops/disputes/${encodeURIComponent(disputeId)}/adjudicate`, { outcome }, `people-adjudicate-${disputeId}`);
    return `Sent to PayPal: settle for the ${outcome === 'buyer_favor' ? 'buyer' : 'seller'}.`;
  }

  async photoUrl(fileId: string): Promise<string | null> {
    const res = await fetch(`${this.base}/api/files/${encodeURIComponent(fileId)}`, { headers: { ...this.headers(), [HEADERS.persona]: 'ops' } });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  }

  manualRefund(jobId: string): PeopleCase | null {
    const job = this.last?.records.jobs.find((j) => j.id === jobId);
    return job ? manualRefundCase(job) : null;
  }

  private async postMoves(body: OpsMovesRequest): Promise<{ ok: true; note: string } | { ok: false; problem: string }> {
    const res = await fetch(`${this.base}/api/ops/moves`, { method: 'POST', headers: { ...this.headers(true), 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(body) });
    if (!res.ok) {
      let problem = `The server answered ${res.status}.`;
      try {
        problem = ((await res.json()) as ApiErrorBody).error.message || problem;
      } catch {
        // keep the status line
      }
      return { ok: false, problem };
    }
    const out = (await res.json()) as ApiSpec['POST /api/ops/moves']['response'];
    const skipped = out.skipped.map((x) => x.problem).join(' ');
    return { ok: true, note: [out.applied.map((a) => a.note).join(' '), skipped ? `Skipped: ${skipped}` : ''].filter(Boolean).join(' ') };
  }

  async approve(proposal: Proposal, optionId: string | null, at: MarketMs): Promise<string> {
    const actions = actionsFor(proposal, optionId, at);
    if (actions.length === 0) return 'Nothing to move.';
    const first = actions[0]!;
    const out = await this.postMoves({ moves: actions.map((a) => a.move), reason: first.reason, proposalId: proposal.id, ai: first.ai.provider === 'fake' ? null : first.ai });
    if (!out.ok) return `The server refused: ${out.problem}`;
    this.approved = [...this.approved, ...actions];
    return `Approved. ${out.note}`;
  }

  moveProblem(jobId: string, toQueuerId: string, at: MarketMs): string | null {
    const w = this.last?.world;
    const job = w?.jobs.find((j) => j.id === jobId);
    if (!w || !job) return 'This job is no longer on the board.';
    return moveProblem(w, job, toQueuerId, at);
  }

  async move(jobId: string, toQueuerId: string, at: MarketMs): Promise<string | null> {
    const problem = this.moveProblem(jobId, toQueuerId, at);
    if (problem) return problem;
    const w = this.last!.world;
    const ask = targetAsk(w, w.jobs.find((j) => j.id === jobId)!, toQueuerId);
    if (!ask) return 'No open offer to move to.';
    const out = await this.postMoves({ moves: [{ kind: 'reassign', jobId, toAskId: ask.id }], reason: 'Dragged on the board by ops.', proposalId: null, ai: null });
    return out.ok ? null : out.problem;
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
