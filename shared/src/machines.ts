import { ContractError } from './contract.ts';
import type { AskStatus, BidStatus, ClaimStatus, HoldStatus, JobStatus, PayoutStatus, ProofStatus } from './contract.ts';

/**
 * State machines. The server calls `assertTransition` before every status
 * change; the apps use `canTransition` to decide which buttons to show.
 * docs/DOMAIN.md lists the trigger and side effects of each transition.
 */

interface StatusByMachine {
  bid: BidStatus;
  hold: HoldStatus;
  ask: AskStatus;
  claim: ClaimStatus;
  job: JobStatus;
  proof: ProofStatus;
  payout: PayoutStatus;
}

export type MachineName = keyof StatusByMachine;
export type StatusOf<M extends MachineName> = StatusByMachine[M];

type Table<S extends string> = Readonly<Record<S, readonly S[]>>;

export const BID_TRANSITIONS: Table<BidStatus> = {
  awaiting_approval: ['open', 'failed'],
  open: ['partially_matched', 'matched', 'closing', 'cancelled', 'expired'],
  partially_matched: ['open', 'matched', 'closing', 'settled', 'cancelled', 'expired'],
  matched: ['open', 'partially_matched', 'closing', 'settled', 'expired'],
  closing: ['settled', 'cancelled', 'expired'],
  settled: [],
  cancelled: [],
  expired: [],
  failed: [],
};

/** held -> held is a reauthorization (new authorization id, new honor period). */
export const HOLD_TRANSITIONS: Table<HoldStatus> = {
  pending_approval: ['held', 'failed'],
  held: ['held', 'partially_captured', 'captured', 'released'],
  partially_captured: ['partially_captured', 'captured', 'released'],
  captured: [],
  released: [],
  failed: [],
};

export const ASK_TRANSITIONS: Table<AskStatus> = {
  open: ['filled', 'withdrawn', 'lapsed', 'closed'],
  filled: ['open', 'lapsed', 'closed'],
  withdrawn: ['lapsed', 'closed'],
  lapsed: [],
  closed: [],
};

export const CLAIM_TRANSITIONS: Table<ClaimStatus> = {
  awaiting_arrival: ['arrived', 'checked_in', 'lapsed', 'cancelled'],
  arrived: ['checked_in', 'lapsed', 'cancelled'],
  checked_in: ['done'],
  done: [],
  lapsed: [],
  cancelled: [],
};

export const JOB_TRANSITIONS: Table<JobStatus> = {
  claimed: ['checked_in', 'queueing', 'failed'],
  checked_in: ['queueing', 'failed'],
  queueing: ['bought', 'proof_submitted', 'failed'],
  bought: ['proof_submitted', 'failed'],
  proof_submitted: ['verified', 'failed'],
  verified: ['shipped', 'delivered', 'failed', 'refunded'],
  shipped: ['delivered', 'refunded'],
  delivered: ['refunded'],
  failed: [],
  refunded: [],
};

export const PROOF_TRANSITIONS: Table<ProofStatus> = {
  verifying: ['passed', 'failed', 'needs_review'],
  needs_review: ['passed', 'failed'],
  passed: [],
  failed: [],
};

export const PAYOUT_TRANSITIONS: Table<PayoutStatus> = {
  pending: ['succeeded', 'unclaimed', 'failed'],
  unclaimed: ['succeeded', 'returned', 'cancelled'],
  succeeded: [],
  failed: [],
  returned: [],
  cancelled: [],
};

export const TRANSITIONS: { readonly [M in MachineName]: Table<StatusByMachine[M]> } = {
  bid: BID_TRANSITIONS,
  hold: HOLD_TRANSITIONS,
  ask: ASK_TRANSITIONS,
  claim: CLAIM_TRANSITIONS,
  job: JOB_TRANSITIONS,
  proof: PROOF_TRANSITIONS,
  payout: PAYOUT_TRANSITIONS,
};

/** Job statuses after which the job will never capture again (settlement can proceed). */
export const JOB_SETTLED: readonly JobStatus[] = ['delivered', 'failed', 'refunded'];

/** Job statuses in which the queuer has not bought anything yet (a failure returns the quantity to the book). */
export const JOB_BEFORE_PURCHASE: readonly JobStatus[] = ['claimed', 'checked_in', 'queueing'];

export function canTransition<M extends MachineName>(machine: M, from: StatusOf<M>, to: StatusOf<M>): boolean {
  const table = TRANSITIONS[machine] as Readonly<Record<string, readonly string[]>>;
  return (table[from] ?? []).includes(to);
}

export function assertTransition<M extends MachineName>(machine: M, from: StatusOf<M>, to: StatusOf<M>): void {
  if (!canTransition(machine, from, to)) {
    throw new ContractError('INVALID_TRANSITION', `A ${machine} cannot go from ${from} to ${to}.`, { machine, from, to });
  }
}

/** True when no transition leaves this status. */
export function isTerminal<M extends MachineName>(machine: M, status: StatusOf<M>): boolean {
  const table = TRANSITIONS[machine] as Readonly<Record<string, readonly string[]>>;
  return (table[status] ?? []).length === 0;
}

/** Bid status implied by quantities (for the non-terminal, non-closing states). */
export function bidStatusForQty(qty: number, remainingQty: number): 'open' | 'partially_matched' | 'matched' {
  if (remainingQty >= qty) return 'open';
  if (remainingQty <= 0) return 'matched';
  return 'partially_matched';
}
