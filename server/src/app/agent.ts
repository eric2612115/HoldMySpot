import { ContractError, formatUsd } from '@holdmyspot/shared';
import type { AgentAction, BidTask } from '@holdmyspot/shared';
import type { AgentRunResult } from '../ports/ai.ts';
import type { App } from './app.ts';
import { amendBid, cancelBid } from './bids.ts';
import { itemById } from './catalog.ts';
import { bidMatchableNow, bookAsks, bookState, latestLinePhoto } from './market.ts';
import { emitBid } from './views.ts';

/**
 * The bidding agent loop (docs/AI-SERVICES.md 4.5). The AI services decide;
 * the core schedules runs and applies each decision through the same checks
 * as PATCH /api/bids/:bidId, so the agent can only move inside the PayPal
 * hold (the hold is the mandate). It never captures, pays out or sees PayPal ids.
 */

const LIVE: readonly BidTask['status'][] = ['open', 'partially_matched'];

/** Bids whose agent is due, for the scheduler. */
export function agentDue(app: App): { bidId: string; at: number }[] {
  if (!app.ai.biddingAgent) return [];
  const out: { bidId: string; at: number }[] = [];
  for (const bid of app.store.bids.where("status IN ('open', 'partially_matched')")) {
    const a = bid.agent;
    if (!a || !a.enabled || a.status !== 'active' || a.nextRunAt === null) continue;
    out.push({ bidId: bid.id, at: a.nextRunAt });
  }
  return out;
}

/** Starts one agent run: the model call runs outside the command queue, the decision is applied inside it. */
export function startAgentRun(app: App, bidId: string): void {
  const bid = app.store.bids.get(bidId);
  if (!bid?.agent || !LIVE.includes(bid.status)) return;
  // Mark the run as started so the scheduler does not start it twice.
  app.tx(() => {
    const b = app.store.bids.must(bidId);
    b.agent = { ...b.agent!, nextRunAt: null, lastRunAt: app.now() };
    app.store.bids.update(b);
  });
  const now = app.now();
  app.background(`agent ${bidId}`, async () => {
    const b = app.store.bids.must(bidId);
    const { shop, item } = itemById(b.itemId);
    const bids = app.store.bids
      .where("item_id = ? AND status IN ('open', 'partially_matched')", b.itemId)
      .filter((x) => x.remainingQty > 0)
      .map((x) => ({
        id: x.id,
        requesterId: x.requesterId,
        maxFeeCents: x.maxFeeCents,
        remainingQty: x.remainingQty,
        destination: x.destination,
        deadlineAt: x.deadlineAt,
        pricedAt: x.pricedAt,
        matchable: bidMatchableNow(app, x),
      }));
    const asks = bookAsks(app, b.itemId);
    const askNames: Record<string, string> = {};
    const checkedIn: string[] = [];
    for (const a of asks) {
      const ask = app.store.asks.must(a.id);
      askNames[a.id] = ask.queuerName;
      if (app.store.claims.get(ask.claimId)?.status === 'checked_in') checkedIn.push(a.id);
    }
    let result: AgentRunResult | null = null;
    let failure: string | null = null;
    try {
      const fee = await app.ai.feeEstimate({ shop, item, at: now, latestLinePhoto: latestLinePhoto(app, shop.id), rules: app.rules });
      result = await app.ai.biddingAgent!({
        bid: b,
        item,
        shop,
        now,
        book: { status: bookState(app, b.itemId).status, bids, asks, askNames, checkedInAskIds: checkedIn },
        fee,
        history: app.store.agentActions.where('bid_id = ?', b.id),
      });
    } catch (err) {
      failure = err instanceof Error ? err.message : 'error';
    }
    await app.exec(() => applyAgentResult(app, bidId, result, failure));
  });
}

/** Applies one agent decision inside the hold and logs it as an AgentAction. */
export async function applyAgentResult(app: App, bidId: string, result: AgentRunResult | null, failure: string | null): Promise<AgentAction> {
  const bid = app.store.bids.must(bidId);
  const viewer = { userId: bid.requesterId, ops: false };
  const stamp = result?.ai ?? { ...app.ai.info, latencyMs: 0 };
  let kind: AgentAction['kind'] = result?.decision.kind ?? 'note';
  let reason = result?.decision.reason ?? `The agent could not run (${failure ?? 'no result'}); the max fee stays ${formatUsd(bid.maxFeeCents, { exact: true })}.`;
  let fromFee: number | null = result?.decision.fromFeeCents ?? null;
  let toFee: number | null = result?.decision.toFeeCents ?? null;
  if (result && LIVE.includes(bid.status)) {
    try {
      const d = result.decision;
      if ((d.kind === 'raise_fee' || d.kind === 'lower_fee') && d.toFeeCents !== null && d.toFeeCents !== bid.maxFeeCents) {
        fromFee = bid.maxFeeCents;
        await amendBid(app, viewer, bid.id, { maxFeeCents: d.toFeeCents });
      } else if (d.kind === 'reduce_qty' && d.qty !== null) {
        await amendBid(app, viewer, bid.id, { qty: d.qty });
      } else if (d.kind === 'cancel') {
        await cancelBid(app, viewer, bid.id);
      }
    } catch (err) {
      kind = 'note';
      toFee = null;
      reason = `The server refused the agent's change (${err instanceof ContractError ? err.code : 'error'}): ${err instanceof Error ? err.message : ''}`.trim();
    }
  }
  return app.tx(() => {
    const action: AgentAction = { id: app.nextId('act'), bidId, at: app.now(), kind, fromFeeCents: fromFee, toFeeCents: toFee, reason, ai: stamp };
    app.store.agentActions.insert(action);
    app.emit('agent.action', action, { users: [bid.requesterId] });
    const b = app.store.bids.must(bidId);
    if (b.agent) {
      const live = LIVE.includes(b.status) && b.agent.enabled;
      // A failed run keeps the current max fee and tries again in 15 market minutes.
      const next = !live ? null : result ? result.nextRunAt : app.now() + 15 * 60_000;
      b.agent = {
        ...b.agent,
        lastRunAt: app.now(),
        nextRunAt: next,
        status: !b.agent.enabled ? 'paused' : live && next !== null ? 'active' : 'done',
      };
      app.store.bids.update(b);
      emitBid(app, b);
    }
    return action;
  });
}
