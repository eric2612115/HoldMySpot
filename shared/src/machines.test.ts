import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ASK_STATUSES, BID_STATUSES, CLAIM_STATUSES, ContractError, HOLD_STATUSES, JOB_STATUSES, PAYOUT_STATUSES, PROOF_STATUSES } from './contract.ts';
import { TRANSITIONS, assertTransition, bidStatusForQty, canTransition, isTerminal, type MachineName } from './machines.ts';

const ALL: Record<MachineName, readonly string[]> = {
  bid: BID_STATUSES,
  hold: HOLD_STATUSES,
  ask: ASK_STATUSES,
  claim: CLAIM_STATUSES,
  job: JOB_STATUSES,
  proof: PROOF_STATUSES,
  payout: PAYOUT_STATUSES,
};

describe('state machines', () => {
  it('cover every status and only point at known statuses', () => {
    for (const [machine, statuses] of Object.entries(ALL) as [MachineName, readonly string[]][]) {
      const table = TRANSITIONS[machine] as Record<string, readonly string[]>;
      assert.deepEqual(Object.keys(table).sort(), [...statuses].sort(), machine);
      for (const targets of Object.values(table)) for (const t of targets) assert.ok(statuses.includes(t), `${machine}: ${t}`);
    }
  });

  it('walks the ship-mode job path', () => {
    const path = ['claimed', 'checked_in', 'queueing', 'bought', 'proof_submitted', 'verified', 'shipped', 'delivered'] as const;
    for (let i = 1; i < path.length; i++) assert.ok(canTransition('job', path[i - 1]!, path[i]!), `${path[i - 1]} -> ${path[i]}`);
  });

  it('walks the local-mode job path (handover straight from verified)', () => {
    assert.ok(canTransition('job', 'verified', 'delivered'));
    assert.ok(canTransition('job', 'claimed', 'queueing')); // matched after the queuer already checked in
  });

  it('refuses shortcuts around money steps', () => {
    assert.equal(canTransition('job', 'queueing', 'verified'), false);
    assert.equal(canTransition('job', 'proof_submitted', 'shipped'), false);
    assert.equal(canTransition('hold', 'captured', 'released'), false);
    assert.throws(
      () => assertTransition('bid', 'settled', 'open'),
      (e) => e instanceof ContractError && e.code === 'INVALID_TRANSITION',
    );
  });

  it('allows reauthorization as held -> held', () => {
    assert.ok(canTransition('hold', 'held', 'held'));
    assert.equal(canTransition('hold', 'partially_captured', 'held'), false);
  });

  it('knows terminal statuses', () => {
    assert.ok(isTerminal('bid', 'settled'));
    assert.ok(isTerminal('job', 'failed'));
    assert.equal(isTerminal('job', 'delivered'), false); // a refund can still follow
    assert.ok(isTerminal('claim', 'lapsed'));
  });

  it('derives bid status from quantities', () => {
    assert.equal(bidStatusForQty(2, 2), 'open');
    assert.equal(bidStatusForQty(2, 1), 'partially_matched');
    assert.equal(bidStatusForQty(2, 0), 'matched');
  });
});
