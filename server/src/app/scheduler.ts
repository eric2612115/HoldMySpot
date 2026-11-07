import { DAY_MS, askNextDropAt } from '@holdmyspot/shared';
import type { SweepResult } from '@holdmyspot/shared';
import { agentDue, startAgentRun } from './agent.ts';
import type { App } from './app.ts';
import { claimHasPendingPhoto, lapseClaim } from './asks.ts';
import { APPROVAL_TIMEOUT_MS, expireApproval } from './bids.ts';
import { failNotShipped } from './jobs.ts';
import { bookAsks, canStillMatchLater, emitBook, runBook } from './market.ts';
import { expireHold, reconcileBid, recoverPending, renewHold } from './money.ts';
import { syncPayPal } from './sync.ts';
import { emitBid } from './views.ts';

/**
 * Timed work on the market clock, run as a discrete-event loop: every due
 * item (fee-clock steps, arrival windows, deadlines, approval timeouts, hold
 * renewals and expiry, shipping deadlines, demo steps) runs at its exact due
 * time, in time order, whatever the clock speed. A real-time sweeper covers
 * sandbox holds (PayPal's own clock) and housekeeping.
 */

interface Due {
  at: number;
  key: string;
  /** Order among items due at the same time. */
  order: number;
  demo: boolean;
  run: () => Promise<unknown>;
}

interface SchedulerState {
  ticking: boolean;
  /** Items already run, as "<key>@<due time>", for the market of `boot`. */
  done: Set<string>;
  /** The market (App.bootId) `done` belongs to. A reset starts a new market whose ids and times repeat. */
  boot: string;
  timers: NodeJS.Timeout[];
}

const states = new WeakMap<App, SchedulerState>();

function state(app: App): SchedulerState {
  let s = states.get(app);
  if (!s) {
    s = { ticking: false, done: new Set(), boot: app.bootId, timers: [] };
    states.set(app, s);
  }
  // A demo reset replays the same ids at the same market times: forget what the old market ran.
  if (s.boot !== app.bootId) {
    s.done.clear();
    s.boot = app.bootId;
  }
  return s;
}

function lastEntered(history: { status: string; at: number }[], status: string): number | null {
  for (let i = history.length - 1; i >= 0; i--) if (history[i]!.status === status) return history[i]!.at;
  return null;
}

async function closeAtDeadline(app: App, bidId: string): Promise<void> {
  app.tx(() => {
    const bid = app.store.bids.must(bidId);
    if (bid.closeReason !== null || bid.remainingQty <= 0) return;
    bid.closeReason = 'deadline';
    bid.updatedAt = app.now();
    app.store.bids.update(bid);
    emitBid(app, bid);
    emitBook(app, bid.itemId);
  });
  await reconcileBid(app, bidId);
}

async function clockStep(app: App, itemId: string, at: number): Promise<void> {
  app.tx(() => {
    runBook(app, itemId, 'clock_step');
    const book = app.store.books.must(itemId);
    book.lastClockRunAt = at;
    app.store.books.update(book);
  });
}

function collectDue(app: App): Due[] {
  const out: Due[] = [];
  const d = app.director?.nextDue();
  if (d) out.push({ at: d.at, key: d.key, order: 0, demo: true, run: d.run });

  for (const bid of app.store.bids.where("status = 'awaiting_approval'")) {
    out.push({ at: bid.createdAt + APPROVAL_TIMEOUT_MS, key: `approval:${bid.id}`, order: 1, demo: false, run: async () => expireApproval(app, bid.id) });
  }
  for (const claim of app.store.claims.where("status IN ('awaiting_arrival', 'arrived')")) {
    if (claimHasPendingPhoto(app, claim.id)) continue;
    out.push({ at: claim.windowEndsAt + 1, key: `lapse:${claim.id}`, order: 2, demo: false, run: () => lapseClaim(app, claim.id) });
  }
  for (const bid of app.store.bids.where("status IN ('open', 'partially_matched', 'matched')")) {
    if (bid.closeReason !== null || bid.remainingQty <= 0) continue;
    out.push({ at: bid.deadlineAt + 1, key: `deadline:${bid.id}`, order: 3, demo: false, run: () => closeAtDeadline(app, bid.id) });
  }
  for (const book of app.store.books.where("status = 'open'")) {
    let next: number | null = null;
    for (const ask of bookAsks(app, book.id)) {
      if (!ask.matchable || ask.remainingCapacity <= 0 || !ask.clock || ask.clock.startsAt === null) continue;
      const from = Math.max(book.lastClockRunAt ?? ask.clock.startsAt, ask.clock.startsAt);
      const t = askNextDropAt(ask, from);
      if (t !== null && (next === null || t < next)) next = t;
    }
    if (next !== null) {
      const at = next;
      out.push({ at, key: `clock:${book.id}`, order: 4, demo: false, run: () => clockStep(app, book.id, at) });
    }
  }
  for (const hold of app.store.holds.where("status = 'held' AND adapter = 'fake'")) {
    if (hold.capturedCents > 0 || hold.renewalRequired || hold.honorEndsAt === null) continue;
    const bid = app.store.bids.get(hold.reference);
    if (!bid || !canStillMatchLater(app, bid, hold)) continue;
    out.push({ at: hold.honorEndsAt + 1, key: `renew:${hold.id}:${hold.renewals}`, order: 5, demo: false, run: () => renewHold(app, hold.id) });
  }
  for (const hold of app.store.holds.where("status IN ('held', 'partially_captured') AND adapter = 'fake'")) {
    if (hold.expiresAt === null) continue;
    out.push({ at: hold.expiresAt, key: `expire:${hold.id}`, order: 6, demo: false, run: () => expireHold(app, hold.id) });
  }
  for (const a of agentDue(app)) {
    out.push({ at: a.at, key: `agent:${a.bidId}`, order: 8, demo: false, run: async () => startAgentRun(app, a.bidId) });
  }
  for (const job of app.store.jobs.where("status = 'verified'")) {
    if (job.mode !== 'ship' || job.shipment) continue;
    const verifiedAt = lastEntered(job.history, 'verified');
    if (verifiedAt === null) continue;
    out.push({ at: verifiedAt + app.rules.shipWithinDays * DAY_MS, key: `ship:${job.id}`, order: 7, demo: false, run: () => failNotShipped(app, job.id) });
  }
  return out;
}

/** The earliest time anything is due (for tests and the demo clock). */
export function nextDueAt(app: App): number | null {
  const s = state(app);
  let best: number | null = null;
  for (const d of collectDue(app)) {
    if (s.done.has(`${d.key}@${d.at}`)) continue;
    if (best === null || d.at < best) best = d.at;
  }
  return best;
}

/**
 * Runs everything due up to the clock's now, one due time at a time, each
 * item pinned to its exact due time. Returns how many items ran.
 */
export async function tick(app: App): Promise<number> {
  const s = state(app);
  if (s.ticking) return 0;
  s.ticking = true;
  let ran = 0;
  try {
    for (let guard = 0; guard < 5000; guard++) {
      const now = app.clock.now();
      // Read the state again: a reset between two items starts a new market.
      const done = state(app).done;
      const due = collectDue(app).filter((d) => d.at <= now && !done.has(`${d.key}@${d.at}`));
      if (due.length === 0) break;
      const t = Math.min(...due.map((d) => d.at));
      const batch = due.filter((d) => d.at === t).sort((a, b) => a.order - b.order);
      const boot = app.bootId;
      for (const item of batch) {
        // A reset ran in between: these items belong to the old market; collect again.
        if (app.bootId !== boot) break;
        const current = state(app).done;
        if (current.has(`${item.key}@${item.at}`)) continue;
        current.add(`${item.key}@${item.at}`);
        if (current.size > 20_000) current.clear();
        await app.atTime(t, async () => {
          try {
            await app.exec(item.run);
          } catch (err) {
            app.log(`scheduled ${item.key} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          if (item.demo) await app.idle();
        });
        ran++;
      }
    }
  } finally {
    s.ticking = false;
  }
  return ran;
}

/** Jumps the market clock forward and runs everything that became due on the way. */
export async function advanceTo(app: App, t: number): Promise<number> {
  if (t > app.clock.now()) app.clock.jumpTo(t);
  return tick(app);
}

/** Sandbox holds run on PayPal's real clock: renew and expire them by real time. */
async function realTimeHolds(app: App, result: SweepResult): Promise<void> {
  const nowReal = Date.now();
  for (const hold of app.store.holds.where("status IN ('held', 'partially_captured') AND adapter = 'sandbox'")) {
    if (hold.expiresAt !== null && nowReal >= hold.expiresAt) {
      await app.exec(() => expireHold(app, hold.id));
      continue;
    }
    if (hold.status === 'held' && hold.capturedCents === 0 && !hold.renewalRequired && hold.honorEndsAt !== null && nowReal > hold.honorEndsAt) {
      const out = await app.exec(() => renewHold(app, hold.id));
      if (out.verdict === 'reauthorize') result.renewed.push(hold.id);
      if (out.verdict === 'renewal_required') result.renewalRequired.push(hold.id);
    }
  }
}

function housekeeping(app: App): void {
  app.bus.prune();
  app.db.prepare('DELETE FROM idempotency WHERE created_at < ?').run(Date.now() - DAY_MS);
  app.saveClock();
}

/** POST /api/ops/sweep: run everything due now and report what changed. */
export async function sweepNow(app: App): Promise<SweepResult> {
  const before = new Map(app.store.holds.all().map((h) => [h.id, h]));
  const claimsBefore = new Map(app.store.claims.all().map((c) => [c.id, c.status]));
  const bidsBefore = new Map(app.store.bids.all().map((b) => [b.id, b.status]));
  const result: SweepResult = { renewed: [], renewalRequired: [], lapsedClaims: [], expiredBids: [], voided: [] };
  await tick(app);
  await realTimeHolds(app, result);
  await app.exec(() => recoverPending(app));
  for (const h of app.store.holds.all()) {
    const prev = before.get(h.id);
    if (!prev) continue;
    if (h.renewals > prev.renewals && !result.renewed.includes(h.id)) result.renewed.push(h.id);
    if (h.renewalRequired && !prev.renewalRequired && !result.renewalRequired.includes(h.id)) result.renewalRequired.push(h.id);
    if (h.status === 'released' && prev.status !== 'released') result.voided.push(h.id);
  }
  for (const c of app.store.claims.all()) if (c.status === 'lapsed' && claimsBefore.get(c.id) !== 'lapsed') result.lapsedClaims.push(c.id);
  for (const b of app.store.bids.all()) if ((b.status === 'expired' || b.status === 'failed') && bidsBefore.get(b.id) !== b.status) result.expiredBids.push(b.id);
  housekeeping(app);
  return result;
}

/** Starts the market timers. Returns a stop function. */
export function startWorkers(app: App): () => void {
  const s = state(app);
  const tickTimer = setInterval(() => {
    void tick(app);
  }, 200);
  const sweepTimer = setInterval(() => {
    const result: SweepResult = { renewed: [], renewalRequired: [], lapsedClaims: [], expiredBids: [], voided: [] };
    void realTimeHolds(app, result)
      .then(() => app.exec(() => recoverPending(app)))
      .then(() => housekeeping(app))
      .catch((err: unknown) => app.log(`sweep failed: ${err instanceof Error ? err.message : String(err)}`));
  }, app.config.sweepSeconds * 1000);
  const clockTimer = setInterval(() => app.saveClock(), 5000);
  // The status poll runs in both modes: fake mode's PayPal is the sandbox client on the
  // in-process emulator, so pending captures and payouts settle the same way.
  const syncTimer = setInterval(() => {
    void syncPayPal(app).catch((err: unknown) => app.log(`PayPal sync failed: ${err instanceof Error ? err.message : String(err)}`));
  }, app.config.paypalPollSeconds * 1000);
  const timers = [tickTimer, sweepTimer, clockTimer, syncTimer];
  for (const t of timers) t.unref();
  s.timers.push(...timers);
  return () => {
    for (const t of s.timers) clearInterval(t);
    s.timers = [];
  };
}
