import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
});
