import type { AskTask, BidTask, Claim, Dispute, Hold, Job, LedgerEntry, Match, Payout, Proof, User } from '@holdmyspot/shared';
import type { UserDoc } from '../db/store.ts';
import type { Audience, StoredEvent } from '../realtime/bus.ts';
import type { App, Viewer } from './app.ts';

/**
 * What each viewer may see (docs/API.md section 5). The same rules apply to
 * REST responses and to SSE delivery: codes go only to the person who needs
 * them, sandbox receiver emails and home positions only to ops.
 */

export const ALL: Audience = { all: true };

export function to(...ids: (string | null | undefined)[]): Audience {
  return { users: [...new Set(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))] };
}

export function viewUser(doc: UserDoc, viewer: Viewer): User {
  const self = viewer.ops || viewer.userId === doc.id;
  return { ...doc.user, home: self ? doc.user.home : null };
}

export function viewClaim(c: Claim, viewer: Viewer): Claim {
  if (viewer.ops || viewer.userId === c.queuerId) return c;
  return { ...c, checkInCode: null, arrival: null };
}

export function viewJob(j: Job, viewer: Viewer): Job {
  if (viewer.ops) return j;
  return {
    ...j,
    proofCode: viewer.userId === j.queuerId ? j.proofCode : null,
    handoverCode: viewer.userId === j.requesterId ? j.handoverCode : null,
  };
}

export function viewPayout(p: Payout, viewer: Viewer): Payout {
  return viewer.ops ? p : { ...p, receiverEmail: null };
}

export function canSee(ev: StoredEvent, viewer: Viewer): boolean {
  if (viewer.ops || 'all' in ev.audience) return true;
  return viewer.userId !== null && ev.audience.users.includes(viewer.userId);
}

/** A copy of the event with the fields this viewer may not see removed. */
export function redactEvent(ev: StoredEvent, viewer: Viewer): StoredEvent {
  switch (ev.type) {
    case 'claim.updated':
      return { ...ev, data: viewClaim(ev.data as Claim, viewer) };
    case 'job.updated':
      return { ...ev, data: viewJob(ev.data as Job, viewer) };
    case 'payout.updated':
      return { ...ev, data: viewPayout(ev.data as Payout, viewer) };
    default:
      return ev;
  }
}

// ---- event helpers (call inside app.tx) -------------------------------------

export function emitBid(app: App, bid: BidTask): void {
  app.emit('bid.updated', bid, to(bid.requesterId));
}

export function emitHold(app: App, hold: Hold, requesterId: string): void {
  app.emit('hold.updated', hold, to(requesterId));
}

export function emitAsk(app: App, ask: AskTask): void {
  app.emit('ask.updated', ask, ALL);
}

export function emitClaim(app: App, claim: Claim): void {
  app.emit('claim.updated', claim, ALL);
}

export function emitMatch(app: App, match: Match): void {
  app.emit('match.created', match, ALL);
}

export function emitJob(app: App, job: Job): void {
  app.emit('job.updated', job, to(job.requesterId, job.queuerId));
}

export function emitLedger(app: App, entry: LedgerEntry): void {
  app.emit('ledger.appended', entry, to(entry.userId));
}

export function emitPayout(app: App, payout: Payout): void {
  app.emit('payout.updated', payout, to(payout.recipientUserId));
}

export function emitDispute(app: App, dispute: Dispute): void {
  app.emit('dispute.updated', dispute, { users: [] });
}

export function emitProof(app: App, proof: Proof): void {
  const ids: string[] = [];
  if (proof.jobId) {
    const job = app.store.jobs.get(proof.jobId);
    if (job) ids.push(job.requesterId, job.queuerId);
  }
  if (proof.claimId) {
    const claim = app.store.claims.get(proof.claimId);
    if (claim) {
      ids.push(claim.queuerId);
      if (proof.kind === 'check_in') for (const j of app.store.jobs.where('claim_id = ?', claim.id)) ids.push(j.requesterId);
    }
  }
  app.emit('proof.updated', proof, to(...ids));
}

export function emitClock(app: App): void {
  app.emit('clock.updated', app.clock.state(), ALL);
}
