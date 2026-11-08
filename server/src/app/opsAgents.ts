import { ContractError, JOB_BEFORE_PURCHASE, askFeeAt, assertTransition, canTransition, compatible, epochToZonedLocal, formatUsd } from '@holdmyspot/shared';
import type {
  AgentAction,
  AgentActionKind,
  AiStamp,
  BookBid,
  OpsAgentTurnRequest,
  OpsAgentTurnResponse,
  OpsMove,
  OpsMovesRequest,
  OpsMovesResult,
} from '@holdmyspot/shared';
import type { App } from './app.ts';
import { bumpReliability, itemById } from './catalog.ts';
import { failJob } from './jobs.ts';
import { applyFill, bookAsks, emitBook, holdUsable, runBook } from './market.ts';
import { reconcileBid } from './money.ts';
import { emitAsk, emitClaim } from './views.ts';
import { withTimeout } from '../util/serial.ts';

/**
 * The server side of the ops console's two agents (D-100 to D-102).
 *
 * - `opsAgentTurn`: one model turn for the market desk, the AG Studio agents
 *   it delegates to, or the rescheduler. The console runs the tools; the key
 *   stays here. Without a live model it answers 503 AI_UNAVAILABLE and the
 *   console falls back to its offline planner and its rules.
 * - `applyOpsMoves`: the moves an operator approved (or dragged), each checked
 *   again here with the market rules before anything changes: reassign a job
 *   to another queuer's offer, shift a late queuer's arrival window, release
 *   a late queuer, or free a queuer's units from a hold that cannot pay. A
 *   model never sets an amount: a reassigned job runs at the new offer's fee
 *   now, which must be at or under the request's max fee.
 */

const MINUTE = 60_000;
/** Turns in flight at once, and per ten minutes, so a runaway loop cannot run up a bill. */
const MAX_IN_FLIGHT = 3;
const MAX_PER_WINDOW = 150;
const WINDOW_MS = 10 * MINUTE;
const MAX_SHIFT_MINUTES = 30;
/**
 * Studio's agents the market desk delegates to (Widget, Page, Data) get 30 s per turn instead of the
 * model's own timeout, so a slow delegate fails fast and the desk answers from read_market (D-130).
 */
const DELEGATE_AGENTS = new Set(['widget', 'page', 'data']);
const DELEGATE_TURN_MS = 30_000;

/** The limiter belongs to one market (a hosted server runs many in one process, D-163). */
interface TurnLimiter {
  inFlight: number;
  recent: number[];
}
const limiters = new WeakMap<App, TurnLimiter>();
function limiter(app: App): TurnLimiter {
  let l = limiters.get(app);
  if (!l) {
    l = { inFlight: 0, recent: [] };
    limiters.set(app, l);
  }
  return l;
}

export async function opsAgentTurn(app: App, req: OpsAgentTurnRequest): Promise<OpsAgentTurnResponse> {
  const turn = app.ai.opsAgentTurn?.bind(app.ai);
  if (!turn) {
    throw new ContractError('AI_UNAVAILABLE', `No AI model on this server (${app.ai.info.provider}, ${app.ai.info.mode} mode): the console uses its offline planner and rules.`);
  }
  const now = Date.now();
  const limit = limiter(app);
  while (limit.recent.length > 0 && limit.recent[0]! < now - WINDOW_MS) limit.recent.shift();
  if (limit.inFlight >= MAX_IN_FLIGHT || limit.recent.length >= MAX_PER_WINDOW) throw new ContractError('RATE_LIMITED', 'Too many ops agent turns at once; try again in a moment.');
  limit.inFlight++;
  limit.recent.push(now);
  try {
    const out = DELEGATE_AGENTS.has(req.agent)
      ? await withTimeout(turn(req), Math.min(DELEGATE_TURN_MS, app.config.ai.timeoutMs), () => Object.assign(new Error(`Studio's ${req.agent} agent took over ${DELEGATE_TURN_MS / 1000} s for one turn.`), { kind: 'timeout' }))
      : await turn(req);
    app.log(`ops agent turn: ${req.agent}, ${out.calls.length} call(s), ${out.ai.provider}/${out.ai.model} ${out.ai.latencyMs} ms`);
    return out;
  } catch (err) {
    if (err instanceof ContractError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const kind = (err as { kind?: string }).kind ?? 'unavailable';
    app.log(`ops agent turn failed: ${req.agent}, ${kind}`);
    throw new ContractError('AI_UNAVAILABLE', message, { kind });
  } finally {
    limit.inFlight--;
  }
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

class Refused extends Error {}
const refuse = (why: string): never => {
  throw new Refused(why);
};
const usd = (c: number) => formatUsd(c, { exact: true });

function clock(t: number, itemId: string): string {
  return epochToZonedLocal(t, itemById(itemId).shop.timezone).slice(11, 16);
}

interface Done {
  note: string;
  jobIds: string[];
  bidIds: string[];
  actions: AgentAction[];
}

function logAction(app: App, bidId: string, kind: AgentActionKind, fromFee: number | null, toFee: number | null, reason: string, ai: AiStamp): AgentAction {
  const bid = app.store.bids.must(bidId);
  const action: AgentAction = { id: app.nextId('act'), bidId, at: app.now(), kind, fromFeeCents: fromFee, toFeeCents: toFee, reason, ai };
  app.store.agentActions.insert(action);
  app.emit('agent.action', action, { users: [bid.requesterId] });
  return action;
}

function reassign(app: App, move: Extract<OpsMove, { kind: 'reassign' }>, why: string, ai: AiStamp): Done {
  const now = app.now();
  const job = app.store.jobs.must(move.jobId, 'job');
  if (!JOB_BEFORE_PURCHASE.includes(job.status)) refuse(`${job.queuerName} already bought it, so the job stays.`);
  const target = app.store.asks.must(move.toAskId, 'offer');
  const { shop } = itemById(job.itemId);
  if (target.id === job.askId || target.queuerId === job.queuerId) refuse(`The job is already with ${job.queuerName}.`);
  if (target.itemId !== job.itemId) refuse(`${target.queuerName}'s offer is for another item.`);
  const book = bookAsks(app, job.itemId).find((a) => a.id === target.id);
  if (!book || !book.matchable) refuse(`${target.queuerName} has no open offer at ${shop.name} now.`);
  const ask = book!;
  if (ask.remainingCapacity < job.qty) refuse(`${target.queuerName} has room for ${ask.remainingCapacity}, the job needs ${job.qty}.`);
  const bid = app.store.bids.must(job.bidId, 'request');
  const hold = bid.holdId ? app.store.holds.get(bid.holdId) : null;
  if (!hold || !holdUsable(app, hold)) refuse(`${bid.requesterName}'s PayPal hold cannot pay now, so no queuer should start on it.`);
  if (bid.closeReason !== null || now > bid.deadlineAt) refuse(`${bid.requesterName}'s request is closed.`);
  const asBook: BookBid = {
    id: bid.id,
    requesterId: bid.requesterId,
    maxFeeCents: bid.maxFeeCents,
    remainingQty: job.qty,
    destination: bid.destination,
    deadlineAt: bid.deadlineAt,
    pricedAt: bid.pricedAt,
    matchable: true,
  };
  if (!compatible(asBook, ask, { shopCityId: shop.cityId, now })) refuse(`${target.queuerName}'s offer does not fit this request (mode, ETA or deadline).`);
  const fee = askFeeAt(ask, now);
  if (fee > bid.maxFeeCents) refuse(`${target.queuerName} asks ${usd(fee)}, above ${bid.requesterName}'s max fee of ${usd(bid.maxFeeCents)}.`);

  failJob(app, job, 'queuer_withdrew', `Moved by ops to ${target.queuerName}. ${why}`.trim());
  if (app.store.bids.must(bid.id).remainingQty < job.qty) refuse(`${bid.requesterName}'s request could not take the units back.`);
  const match = applyFill(app, { bidId: bid.id, askId: target.id, qty: job.qty, feeCents: fee, at: now }, 'requeue');
  emitBook(app, job.itemId);
  const each = job.qty > 1 ? ' each' : '';
  const note = `Moved ${bid.requesterName}'s job from ${job.queuerName} to ${target.queuerName} at ${usd(fee)}${each}, the offer's fee now (max ${usd(bid.maxFeeCents)}).`;
  const action = logAction(app, bid.id, 'reassign', job.feeCents, fee, `${note} ${why}`.trim(), ai);
  return { note, jobIds: [match.jobId], bidIds: [bid.id], actions: [action] };
}

function shiftWindow(app: App, move: Extract<OpsMove, { kind: 'extend' }>, why: string, ai: AiStamp): Done {
  const now = app.now();
  const claim = app.store.claims.must(move.claimId, 'claim');
  if (claim.status !== 'awaiting_arrival' && claim.status !== 'arrived') refuse(`${claim.queuerName} is not on the way any more; there is no arrival window to shift.`);
  const minutes = Math.round(move.minutes);
  if (!(minutes >= 1 && minutes <= MAX_SHIFT_MINUTES)) refuse(`A window moves by 1 to ${MAX_SHIFT_MINUTES} minutes.`);
  const ask = app.store.asks.must(claim.askId, 'offer');
  const end = claim.windowEndsAt + minutes * MINUTE;
  if (end <= now) refuse('The shifted window would already be over.');
  const jobs = app.store.jobs.where('claim_id = ?', claim.id).filter((j) => JOB_BEFORE_PURCHASE.includes(j.status));
  for (const j of jobs) {
    const bid = app.store.bids.must(j.bidId);
    if (end > bid.deadlineAt) refuse(`${bid.requesterName}'s request ends at ${clock(bid.deadlineAt, ask.itemId)}; the window cannot pass it.`);
  }
  claim.windowEndsAt = end;
  claim.updatedAt = now;
  app.store.claims.update(claim);
  emitClaim(app, claim);
  ask.etaAt += minutes * MINUTE;
  ask.updatedAt = now;
  app.store.asks.update(ask);
  emitAsk(app, ask);
  emitBook(app, ask.itemId);
  const { shop } = itemById(ask.itemId);
  const note = `Gave ${claim.queuerName} ${minutes} more minutes to reach ${shop.name}: check in by ${clock(end, ask.itemId)}.`;
  const actions = [...new Set(jobs.map((j) => j.bidId))].map((bidId) => logAction(app, bidId, 'note', null, null, `${note} ${why}`.trim(), ai));
  return { note, jobIds: jobs.map((j) => j.id), bidIds: [], actions };
}

function release(app: App, move: Extract<OpsMove, { kind: 'release' }>, why: string, ai: AiStamp): Done {
  const now = app.now();
  const claim = app.store.claims.must(move.claimId, 'claim');
  if (claim.status !== 'awaiting_arrival' && claim.status !== 'arrived') refuse(`${claim.queuerName} is not on the way any more, so there is nothing to release.`);
  const ask = app.store.asks.must(claim.askId, 'offer');
  assertTransition('claim', claim.status, 'lapsed');
  claim.status = 'lapsed';
  claim.updatedAt = now;
  app.store.claims.update(claim);
  emitClaim(app, claim);
  if (canTransition('ask', ask.status, 'lapsed')) {
    ask.status = 'lapsed';
    ask.updatedAt = now;
    app.store.asks.update(ask);
    emitAsk(app, ask);
  }
  const failed = app.store.jobs.where('claim_id = ?', claim.id).filter((j) => JOB_BEFORE_PURCHASE.includes(j.status));
  for (const job of failed) failJob(app, job, 'no_show', `Released by ops before the window ended at ${clock(claim.windowEndsAt, ask.itemId)}. ${why}`.trim());
  bumpReliability(app, claim.queuerId, 'claimsLapsed');
  const matches = runBook(app, ask.itemId, 'requeue');
  emitBook(app, ask.itemId);
  const actions: AgentAction[] = [];
  const parts: string[] = [];
  for (const job of failed) {
    const next = matches.find((m) => m.bidId === job.bidId);
    const taker = next ? app.store.asks.get(next.askId) : null;
    const line = next && taker ? `${job.requesterName}'s job went to ${taker.queuerName} at ${usd(next.feeCents)}` : `${job.requesterName}'s job went back to the line-up`;
    parts.push(line);
    actions.push(logAction(app, job.bidId, 'reassign', job.feeCents, next?.feeCents ?? null, `Released ${claim.queuerName}; ${line}. ${why}`.trim(), ai));
  }
  const note = `Released ${claim.queuerName}${parts.length ? `: ${parts.join('; ')}` : ''}.`;
  return { note, jobIds: matches.map((m) => m.jobId), bidIds: failed.map((j) => j.bidId), actions };
}

function releaseJob(app: App, move: Extract<OpsMove, { kind: 'release_job' }>, why: string, ai: AiStamp): Done {
  const job = app.store.jobs.must(move.jobId, 'job');
  if (!JOB_BEFORE_PURCHASE.includes(job.status)) refuse(`${job.queuerName} already bought it, so the job stays.`);
  const bid = app.store.bids.must(job.bidId, 'request');
  const hold = bid.holdId ? app.store.holds.get(bid.holdId) : null;
  if (hold && holdUsable(app, hold)) refuse(`${bid.requesterName}'s PayPal hold can still pay, so the job stays.`);
  failJob(app, job, 'hold_unavailable', `${bid.requesterName}'s PayPal hold cannot pay; ops freed ${job.queuerName}'s units for the next requests. ${why}`.trim());
  const matches = runBook(app, job.itemId, 'requeue');
  emitBook(app, job.itemId);
  const names = matches.map((m) => app.store.bids.get(m.bidId)?.requesterName ?? m.bidId);
  const note = names.length
    ? `Freed ${job.queuerName}'s ${job.qty} unit${job.qty > 1 ? 's' : ''} from ${bid.requesterName}'s hold; ${names.join(' and ')} took them at ${usd(matches[0]!.feeCents)}.`
    : `Freed ${job.queuerName}'s ${job.qty} unit${job.qty > 1 ? 's' : ''} from ${bid.requesterName}'s hold; they wait for the next request.`;
  const actions = [logAction(app, bid.id, 'reassign', job.feeCents, matches[0]?.feeCents ?? null, `${note} ${why}`.trim(), ai)];
  return { note, jobIds: matches.map((m) => m.jobId), bidIds: [bid.id, ...matches.map((m) => m.bidId)], actions };
}

/**
 * POST /api/ops/moves: applies the moves in order, each in its own transaction. A move the rules
 * refuse, or one naming a record the server does not have, is skipped with its reason and the
 * moves before it stay applied; 409 only when none applied (D-102, D-117).
 */
export async function applyOpsMoves(app: App, req: OpsMovesRequest): Promise<OpsMovesResult> {
  const ai: AiStamp = req.ai ?? { provider: 'fake', model: 'ops', mode: 'fake', latencyMs: 0 };
  const result: OpsMovesResult = { applied: [], skipped: [], actions: [] };
  const why = req.reason.trim();
  for (const move of req.moves) {
    let done: Done | null = null;
    try {
      done = app.tx(() => {
        if (move.kind === 'reassign') return reassign(app, move, why, ai);
        if (move.kind === 'extend') return shiftWindow(app, move, why, ai);
        if (move.kind === 'release') return release(app, move, why, ai);
        return releaseJob(app, move, why, ai);
      });
    } catch (err) {
      if (err instanceof Refused || (err instanceof ContractError && err.code === 'NOT_FOUND')) {
        result.skipped.push({ move, problem: err.message });
        continue;
      }
      throw err;
    }
    for (const bidId of done.bidIds) await reconcileBid(app, bidId);
    // A move that touches a request is an AgentAction on it; every applied move, one with no
    // matched job included (a window shift for a queuer nobody waits on yet), is in the server log.
    app.log(`ops move ${move.kind} applied (${ai.provider}/${ai.model}): ${done.note}${why ? ` Reason: ${why}` : ''}`);
    result.applied.push({ move, note: done.note, jobIds: done.jobIds });
    result.actions.push(...done.actions);
  }
  if (result.applied.length === 0) {
    throw new ContractError('CONFLICT', result.skipped.map((s) => s.problem).join(' ') || 'Nothing to move.', { skipped: result.skipped });
  }
  return result;
}
