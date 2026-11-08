import { SCRIPTED_MODEL } from '@holdmyspot/shared';
import type { AgentAction } from '@holdmyspot/shared';
import { describe, expect, it } from 'vitest';
import { agentRows, decidedBy } from './agentLogRows';

const action = (over: Partial<AgentAction>): AgentAction => ({
  id: 'act_1',
  bidId: 'bid_1',
  at: 0,
  kind: 'raise_fee',
  fromFeeCents: 1000,
  toFeeCents: 1100,
  reason: 'r',
  ai: { provider: 'fake', model: SCRIPTED_MODEL, mode: 'fake', latencyMs: 0 },
  ...over,
});

describe('who decided an agent step', () => {
  it('never says AI for a scripted step or the written rules', () => {
    expect(decidedBy({ provider: 'fake', model: SCRIPTED_MODEL, mode: 'fake', latencyMs: 0 })).toBe('Scripted demo step, no AI');
    expect(decidedBy({ provider: 'fake', model: 'rules-v1', mode: 'fake', latencyMs: 0 })).toBe('Written rules, no AI');
  });

  it('names provider, model and mode for a model', () => {
    expect(decidedBy({ provider: 'muse', model: 'muse-spark-1.3', mode: 'live', latencyMs: 900 })).toBe('Decided by AI · muse muse-spark-1.3 (live)');
    expect(decidedBy({ provider: 'muse', model: 'muse-spark-1.3', mode: 'replay', latencyMs: 0 })).toBe('Decided by AI · muse muse-spark-1.3 (replay of a saved answer)');
  });
});

describe('agent log rows', () => {
  it('shows the opening fee, each raise, and the refusal newest first', () => {
    const rows = agentRows([
      action({ id: 'a', kind: 'lower_fee', fromFeeCents: 1200, toFeeCents: 1000 }),
      action({ id: 'b' }),
      action({ id: 'c', kind: 'note', fromFeeCents: 1100, toFeeCents: null, refusedFeeCents: 1400 }),
    ]);
    expect(rows.map((r) => r.title)).toEqual(['Refused: above what PayPal holds ($14.00)', '$10.00 to $11.00', 'Set $10.00']);
    expect(rows[0]!.refused).toBe(true);
  });
});
