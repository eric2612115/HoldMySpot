import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPTED_MODEL } from '@holdmyspot/shared';
import type { AgentRunInput, AgentRunResult } from '../src/ports/ai.ts';
import { FakeAi } from '../src/fakes/ai.ts';
import { MIN, placeBid, testServer } from './helpers.ts';

/** A scripted agent: lower to $9, raise to $10, then ask for $15 (above the hold). */
class ScriptedAgentAi extends FakeAi {
  runs: AgentRunInput[] = [];
  readonly plan = [900, 1000, 1500];

  async biddingAgent(input: AgentRunInput): Promise<AgentRunResult> {
    this.runs.push(input);
    const to = this.plan[this.runs.length - 1] ?? input.bid.maxFeeCents;
    return {
      decision: {
        kind: to < input.bid.maxFeeCents ? 'lower_fee' : to > input.bid.maxFeeCents ? 'raise_fee' : 'keep',
        fromFeeCents: input.bid.maxFeeCents,
        toFeeCents: to,
        qty: null,
        reason: `Set the max fee to $${(to / 100).toFixed(2)}.`,
      },
      toolCalls: [],
      refused: [],
      ceilingCents: 1200,
      nextRunAt: input.now + 15 * MIN,
      decidedBy: 'policy',
      ai: { provider: 'fake', model: 'rules-v1', mode: 'fake', latencyMs: 0 },
    };
  }
}

describe('bidding agent loop', () => {
  it('runs on schedule, changes the max fee inside the hold, and logs every action', async () => {
    const s = await testServer();
    const ai = new ScriptedAgentAi();
    s.app.ai = ai;
    try {
      const placed = await placeBid(s.app, 'mia', { qty: 2, maxFeeCents: 1200, agent: { goal: '2 plush by Friday, as cheap as possible' } });
      const t0 = s.app.now();
      await s.at(t0);
      await s.app.idle();
      let bid = s.app.store.bids.must(placed.bid.id);
      assert.equal(bid.maxFeeCents, 900);
      assert.equal(bid.pricedAt, t0, 'a new max fee resets time priority');
      assert.equal(bid.agent?.nextRunAt, t0 + 15 * MIN);
      assert.equal(ai.runs[0]!.book.bids.length, 1);

      await s.at(t0 + 15 * MIN);
      await s.app.idle();
      bid = s.app.store.bids.must(placed.bid.id);
      assert.equal(bid.maxFeeCents, 1000);

      await s.at(t0 + 30 * MIN);
      await s.app.idle();
      bid = s.app.store.bids.must(placed.bid.id);
      assert.equal(bid.maxFeeCents, 1000, 'the hold is the mandate: $15 would need more than PayPal holds');
      const actions = s.app.store.agentActions.where('bid_id = ?', bid.id);
      assert.deepEqual(
        actions.map((a) => [a.kind, a.fromFeeCents, a.toFeeCents]),
        [
          ['lower_fee', 1200, 900],
          ['raise_fee', 900, 1000],
          ['note', 1000, null],
        ],
      );
      assert.match(actions[2]!.reason, /OVER_LIMIT/);
      const http = await s.call('GET', `/api/bids/${bid.id}/agent-actions`, { as: 'mia' });
      assert.equal(http.json.actions.length, 3);
      const paused = await s.call('POST', `/api/bids/${bid.id}/agent`, { as: 'mia', body: { enabled: false } });
      assert.equal(paused.json.bid.agent.status, 'paused');
      await s.at(t0 + 60 * MIN);
      await s.app.idle();
      assert.equal(ai.runs.length, 3, 'a paused agent does not run');
    } finally {
      await s.done();
    }
  });

  it('the fee-agent demo script raises $10, $11, $12 and the server refuses $14, stamped as scripted', async () => {
    const s = await testServer({ demo: true });
    try {
      await s.director!.start('fee-agent', null);
      s.app.clock.pause();
      await s.at(Date.parse('2026-11-12T10:50:00-08:00'));
      assert.equal(s.director!.state().status, 'finished');
      const bid = s.app.store.bids.where("requester_id = 'mia'")[0]!;
      assert.equal(bid.maxFeeCents, 1200, 'the refused raise changed nothing');
      assert.equal(bid.limitCents, 6370);
      assert.equal(bid.agent?.status, 'done');
      const actions = s.app.store.agentActions.where('bid_id = ?', bid.id);
      assert.deepEqual(
        actions.map((a) => [a.kind, a.fromFeeCents, a.toFeeCents, a.refusedFeeCents ?? null]),
        [
          ['lower_fee', 1200, 1000, null],
          ['raise_fee', 1000, 1100, null],
          ['raise_fee', 1100, 1200, null],
          ['note', 1200, null, 1400],
        ],
      );
      assert.match(actions[3]!.reason, /OVER_LIMIT/);
      assert.ok(actions.every((a) => a.ai.model === SCRIPTED_MODEL && a.ai.provider === 'fake'), 'no action claims a model');
      assert.equal(s.app.store.ledger.where("kind = 'captured'").length, 0, 'nothing is charged');
    } finally {
      await s.done();
    }
  });

  it('a model asking above the hold is refused before the server, and the action says which fee', async () => {
    const s = await testServer();
    const ai = new ScriptedAgentAi();
    ai.biddingAgent = async (input) => ({
      decision: { kind: 'keep', fromFeeCents: input.bid.maxFeeCents, toFeeCents: input.bid.maxFeeCents, qty: null, reason: 'Kept the fee; the suggested change was outside your limit.' },
      toolCalls: [],
      refused: ['set_fee: above the hold'],
      refusedFeeCents: 1500,
      ceilingCents: 1200,
      nextRunAt: null,
      decidedBy: 'model',
      ai: { provider: 'muse', model: 'muse-spark-1.3', mode: 'live', latencyMs: 5 },
    });
    s.app.ai = ai;
    try {
      const placed = await placeBid(s.app, 'mia', { qty: 1, maxFeeCents: 1200, agent: { goal: 'cheap' } });
      await s.at(s.app.now());
      await s.app.idle();
      const [a] = s.app.store.agentActions.where('bid_id = ?', placed.bid.id);
      assert.equal(a!.kind, 'keep');
      assert.equal(a!.refusedFeeCents, 1500);
      assert.equal(s.app.store.bids.must(placed.bid.id).maxFeeCents, 1200);
    } finally {
      await s.done();
    }
  });
});
