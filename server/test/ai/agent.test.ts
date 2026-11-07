import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bidLimitCents, findItem, findShop, seeded } from '@holdmyspot/shared';
import type { AgentAction, BidTask, BookAsk } from '@holdmyspot/shared';
import { agentCeilingCents, goalUrgency, runAgent } from '../../src/ai/agent.ts';
import { AiError } from '../../src/ai/errors.ts';
import { FakeProvider, MemoryTruth } from '../../src/ai/fake.ts';
import { FixtureStore, ReplayProvider } from '../../src/ai/replay.ts';
import type { AgentRunInput } from '../../src/ai/types.ts';
import { MIN, StubProvider, T0, ask, mia, tempDir } from './helpers.ts';

const shop = findShop('little-lantern-toys')!;
const item = findItem('plush-little-lantern')!;

function run(bid: BidTask, now: number, asks: BookAsk[] = [], extra: Partial<AgentRunInput> = {}): AgentRunInput {
  return { bid, item, shop, now, book: { status: 'open', bids: [], asks, askNames: { 'ask-wei': 'Wei' } }, ...extra };
}

/** The hold a 2-plush request needs at this max fee, processing included (D-105). */
const holdAt = (maxFeeCents: number) => bidLimitCents({ qty: 2, retailCapCents: 2800, maxFeeCents, shippingBudgetCents: 3500 });

const earlier: AgentAction = { id: 'a1', bidId: 'bid-mia', at: T0, kind: 'lower_fee', fromFeeCents: 1200, toFeeCents: 900, reason: 'Starting low.', ai: { provider: 'fake', model: 'rules-v1', mode: 'fake', latencyMs: 0 } };

describe('mandate', () => {
  it('derives the ceiling from the hold: the highest fee whose worst case, processing included, fits', () => {
    assert.equal(agentCeilingCents(mia()), 1200);
    assert.equal(holdAt(1400), 12_636);
    assert.equal(agentCeilingCents(mia({ limitCents: holdAt(1400) })), 1400);
    // The old formula, floor((limit - shipping) / qty) - retail cap, would allow $14.00 on $119.00; processing leaves $10.44.
    assert.equal(agentCeilingCents(mia({ limitCents: 11_900 })), 1044);
  });

  it('reads the urgency of a goal', () => {
    assert.equal(goalUrgency('2 plush by Thursday noon, as cheap as possible'), 'cheap');
    assert.equal(goalUrgency('need it ASAP'), 'fast');
    assert.equal(goalUrgency('two plush toys this week'), 'balanced');
  });
});

describe('written policy (rules-only mode)', () => {
  it('starts below the ceiling on the first run and explains it', async () => {
    const r = await runAgent(run(mia(), T0 + MIN), null);
    assert.equal(r.decidedBy, 'policy');
    assert.deepEqual([r.decision.kind, r.decision.fromFeeCents, r.decision.toFeeCents], ['lower_fee', 1200, 900]);
    assert.match(r.decision.reason, /\$9\.00 per plush, below your \$12\.00 ceiling/);
    assert.ok(r.nextRunAt !== null && r.nextRunAt > T0 + MIN && r.nextRunAt <= T0 + 16 * MIN);
  });

  it('raises step by step as the deadline nears', async () => {
    const r = await runAgent(run(mia({ maxFeeCents: 900, limitCents: holdAt(1200) }), T0 + 105 * MIN, [], { history: [earlier] }), null);
    assert.deepEqual([r.decision.kind, r.decision.toFeeCents], ['raise_fee', 1000]);
    assert.match(r.decision.reason, /No offer is in reach yet/);
  });

  it('keeps when an offer is in reach or a fee clock steps to the max soon', async () => {
    const inReach = await runAgent(run(mia(), T0 + 30 * MIN, [ask('ask-wei', { feeCents: 1100 })], { history: [earlier] }), null);
    assert.equal(inReach.decision.kind, 'keep');
    assert.match(inReach.decision.reason, /Wei's offer is \$11\.00/);
    const clock = ask('ask-wei', { feeCents: 1500, clock: { stepCents: 100, intervalMs: 5 * MIN, floorCents: 800, startsAt: T0 + 19 * MIN } });
    const soon = await runAgent(run(mia(), T0 + 30 * MIN, [clock], { history: [earlier] }), null);
    assert.equal(soon.decision.kind, 'keep');
    assert.match(soon.decision.reason, /steps down to \$12\.00 at 11:04/);
    assert.equal(soon.nextRunAt, T0 + 33 * MIN, 'looks again a minute before that step');
  });

  it('takes an offer within the ceiling when the deadline is close', async () => {
    const bid = mia({ limitCents: holdAt(1400), maxFeeCents: 1200 });
    const r = await runAgent(run(bid, bid.deadlineAt - 40 * MIN, [ask('ask-wei', { feeCents: 1350 })], { history: [earlier] }), null);
    assert.deepEqual([r.decision.kind, r.decision.toFeeCents], ['raise_fee', 1350]);
  });

  it('cancels the rest only when the shop is sold out', async () => {
    const r = await runAgent({ ...run(mia(), T0 + 30 * MIN), book: { status: 'sold_out', bids: [], asks: [] } }, null);
    assert.equal(r.decision.kind, 'cancel');
    assert.equal(r.nextRunAt, null);
  });

  it('never leaves the mandate, whatever the book looks like', async () => {
    const rnd = seeded(7);
    for (let i = 0; i < 300; i++) {
      const qty = 1 + Math.floor(rnd() * 3);
      const maxFeeCents = 500 + Math.floor(rnd() * 20) * 50;
      const bid = mia({ qty, remainingQty: qty, maxFeeCents, limitCents: bidLimitCents({ qty, retailCapCents: 2800, maxFeeCents: maxFeeCents + Math.floor(rnd() * 600), shippingBudgetCents: 3500 }) });
      const asks = rnd() > 0.4 ? [ask('ask-wei', { feeCents: 500 + Math.floor(rnd() * 2000), etaAt: T0 + Math.floor(rnd() * 300) * MIN })] : [];
      const now = T0 + Math.floor(rnd() * 260) * MIN;
      const r = await runAgent(run(bid, now, asks, { history: rnd() > 0.5 ? [earlier] : [] }), null);
      if (r.decision.toFeeCents !== null) {
        assert.ok(r.decision.toFeeCents <= r.ceilingCents, `case ${i}: ${r.decision.toFeeCents} > ${r.ceilingCents}`);
        assert.ok(r.decision.toFeeCents >= item.minFeeCents || r.decision.toFeeCents === bid.maxFeeCents);
      }
    }
  });
});

describe('model runs stay inside the mandate', () => {
  it('refuses a fee above the ceiling and keeps instead', async () => {
    const provider = new StubProvider({
      agent: async () => ({
        summary: 'Kept the fee.',
        calls: [
          { name: 'get_book', input: {} },
          { name: 'set_max_fee', input: { maxFeeCents: 5000, reason: 'Pay whatever it takes.' } },
          { name: 'keep', input: { reason: 'Holding at $12.00 while Wei checks in.' } },
        ],
      }),
    });
    const r = await runAgent(run(mia(), T0 + 30 * MIN), provider);
    assert.equal(r.decidedBy, 'model');
    assert.equal(r.decision.kind, 'keep');
    assert.equal(r.decision.reason, 'Holding at $12.00 while Wei checks in.');
    assert.equal(r.refused.length, 1);
    assert.match(r.refused[0] ?? '', /cannot be above \$12\.00/);
    assert.equal(r.toolCalls.length, 3);
    const book = r.toolCalls[0]?.output as { request: { ceilingCents: number } };
    assert.equal(book.request.ceilingCents, 1200);
  });

  it('applies one action per run', async () => {
    const provider = new StubProvider({
      agent: async () => ({
        summary: '',
        calls: [
          { name: 'set_max_fee', input: { maxFeeCents: 1000, reason: 'Lowered to $10.00 to wait for the clock.' } },
          { name: 'cancel_bid', input: { reason: 'Changed my mind.' } },
        ],
      }),
    });
    const r = await runAgent(run(mia(), T0 + 30 * MIN), provider);
    assert.deepEqual([r.decision.kind, r.decision.toFeeCents], ['lower_fee', 1000]);
    assert.match(r.refused[0] ?? '', /one action per run/i);
  });

  it('checks decision-mode answers the same way', async () => {
    const provider = new StubProvider({ id: 'muse', json: () => ({ action: 'raise_fee', maxFeeCents: 9999, qty: null, reason: 'Go big.' }) });
    const r = await runAgent(run(mia(), T0 + 30 * MIN), provider);
    assert.equal(r.decision.kind, 'keep');
    assert.equal(r.refused.length, 1);
    assert.equal(provider.jsonCalls[0]?.schemaName, 'agent_decision');
  });

  it('keeps the fee and logs a note when the provider fails', async () => {
    const provider = new StubProvider({
      agent: async () => {
        throw new AiError('timeout', 'slow');
      },
    });
    const r = await runAgent(run(mia(), T0 + 30 * MIN), provider);
    assert.equal(r.decision.kind, 'note');
    assert.match(r.decision.reason, /could not run this time \(timeout\), so your fee stays at \$12\.00/);
  });

  it('uses the written policy on a replay miss', async () => {
    const replay = new ReplayProvider(new FixtureStore(tempDir()), new FakeProvider(new MemoryTruth()), { id: 'fake', model: 'rules-v1' });
    const r = await runAgent(run(mia(), T0 + MIN), replay);
    assert.equal(r.decidedBy, 'policy');
    assert.equal(r.decision.kind, 'lower_fee');
  });
});
