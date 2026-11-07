import {
  assertTransition,
  bidDepth,
  bidStatusForQty,
  expectedWaitMinutes,
  jobCaps,
  matchBook,
} from '@holdmyspot/shared';
import type {
  AskQuote,
  AskTask,
  BidTask,
  BookAsk,
  BookBid,
  BookSnapshot,
  Claim,
  Fill,
  Hold,
  Job,
  JobStatus,
  Match,
  MatchTrigger,
} from '@holdmyspot/shared';
import type { BookState } from '../db/store.ts';
import type { App } from './app.ts';
import { itemById } from './catalog.ts';
import { ALL, emitAsk, emitBid, emitJob, emitMatch } from './views.ts';

/**
 * The order book on the queue fee, wired to storage. Matching itself is the
 * pure `matchBook` from @holdmyspot/shared (price-time priority, partial
 * fills, execution at the ask's current fee, compatibility filters); this
 * module decides what is matchable, turns fills into matches and jobs, and
 * builds the public book snapshot.
 */

export const LIVE_BID_STATUSES: readonly BidTask['status'][] = ['open', 'partially_matched', 'matched'];
const LIVE_CLAIM: readonly Claim['status'][] = ['awaiting_arrival', 'arrived', 'checked_in'];

/** PayPal time for a hold: real time for sandbox holds, market time for the fake. */
export function nowFor(app: App, hold: Pick<Hold, 'clockBasis'>): number {
  return hold.clockBasis === 'real' ? Date.now() : app.now();
}

export function bookState(app: App, itemId: string): BookState {
  const b = app.store.books.get(itemId);
  if (b) return b;
  const { shop } = itemById(itemId);
  const fresh: BookState = { id: itemId, shopId: shop.id, cityId: shop.cityId, status: 'open', lastClockRunAt: null, soldOutAt: null };
  app.store.books.insert(fresh);
  return fresh;
}

/** The hold can back a new fill right now. */
export function holdUsable(app: App, hold: Hold): boolean {
  if (hold.status !== 'held' && hold.status !== 'partially_captured') return false;
  if (hold.renewalRequired) return false;
  return hold.expiresAt === null || nowFor(app, hold) < hold.expiresAt;
}

/** The bid could still get fills (ignoring a pending hold renewal). */
export function canStillMatchLater(app: App, bid: BidTask, hold?: Hold | null): boolean {
  if (!LIVE_BID_STATUSES.includes(bid.status) || bid.remainingQty <= 0 || bid.closeReason !== null) return false;
  if (app.now() > bid.deadlineAt) return false;
  if (bookState(app, bid.itemId).status !== 'open') return false;
  const h = hold === undefined ? (bid.holdId ? app.store.holds.get(bid.holdId) : null) : hold;
  return !!h && (h.status === 'held' || h.status === 'partially_captured');
}

export function bidMatchableNow(app: App, bid: BidTask): boolean {
  const hold = bid.holdId ? app.store.holds.get(bid.holdId) : null;
  return !!hold && canStillMatchLater(app, bid, hold) && holdUsable(app, hold);
}

/** A job that may still trigger a capture (receipt, shipping or handover). */
export function jobMayCaptureAgain(job: Job): boolean {
  const before: readonly JobStatus[] = ['claimed', 'checked_in', 'queueing', 'bought', 'proof_submitted', 'verified'];
  return before.includes(job.status);
}

/**
 * What a bid's jobs have taken from its hold: everything captured, plus the
 * full caps (processing included, D-105) of every job that may still capture
 * (PayPal never gives captured money back to an authorization, refunds included).
 */
export function committedCents(app: App, bidId: string): number {
  let total = 0;
  for (const j of app.store.jobs.where('bid_id = ?', bidId)) {
    const caps = j.caps.retailCents + j.caps.feeCents + j.caps.shippingCents + (j.caps.processingCents ?? 0);
    total += jobMayCaptureAgain(j) ? Math.max(j.amounts.capturedCents, caps) : j.amounts.capturedCents;
  }
  return total;
}

/**
 * How many more units the hold can back, each as its own job at the retail
 * cap plus `maxFeeCents` plus its share of the shipping budget plus that
 * job's processing at its caps (the worst case, D-105). A fill beyond this
 * would give a queuer a job whose capture the user's limit refuses.
 */
export function backedQty(
  app: App,
  bid: Pick<BidTask, 'id' | 'qty' | 'retailCapCents' | 'maxFeeCents' | 'shippingBudgetCents' | 'destination'>,
  hold: Pick<Hold, 'amount'>,
  o: { qty?: number; maxFeeCents?: number } = {},
): number {
  const qty = o.qty ?? bid.qty;
  const fee = o.maxFeeCents ?? bid.maxFeeCents;
  const headroom = hold.amount.cents - committedCents(app, bid.id);
  if (headroom <= 0 || qty <= 0) return 0;
  const unit = jobCaps({ qty, retailCapCents: bid.retailCapCents, shippingBudgetCents: bid.shippingBudgetCents }, { qty: 1, feeCents: fee }, bid.destination.mode);
  return Math.floor(headroom / (unit.retailCents + unit.feeCents + unit.shippingCents + unit.processingCents));
}

/** Units the book may fill now: what is left, but never more than the hold can back. */
function fillableQty(app: App, bid: BidTask): number {
  const hold = bid.holdId ? app.store.holds.get(bid.holdId) : null;
  return hold ? Math.min(bid.remainingQty, backedQty(app, bid, hold)) : 0;
}

function toBookBid(app: App, bid: BidTask): BookBid {
  return {
    id: bid.id,
    requesterId: bid.requesterId,
    maxFeeCents: bid.maxFeeCents,
    remainingQty: fillableQty(app, bid),
    destination: bid.destination,
    deadlineAt: bid.deadlineAt,
    pricedAt: bid.pricedAt,
    matchable: bidMatchableNow(app, bid),
  };
}

function toBookAsk(app: App, ask: AskTask): BookAsk {
  const claim = app.store.claims.get(ask.claimId);
  return {
    id: ask.id,
    queuerId: ask.queuerId,
    feeCents: ask.feeCents,
    clock: ask.clock,
    remainingCapacity: ask.remainingCapacity,
    modes: ask.modes,
    etaAt: ask.etaAt,
    windowEndsAt: claim && claim.status !== 'checked_in' ? claim.windowEndsAt : null,
    pricedAt: ask.pricedAt,
    matchable: ask.status === 'open' && !!claim && LIVE_CLAIM.includes(claim.status),
    targetBidId: ask.targetBidId,
  };
}

export function bookAsks(app: App, itemId: string): BookAsk[] {
  return app.store.asks.where("item_id = ? AND status = 'open'", itemId).map((a) => toBookAsk(app, a));
}

/** Runs one matching pass for a book and applies the fills. Call inside app.tx. */
export function runBook(app: App, itemId: string, trigger: MatchTrigger): Match[] {
  const state = bookState(app, itemId);
  if (state.status !== 'open') return [];
  const { shop } = itemById(itemId);
  const bids = app.store.bids
    .where("item_id = ? AND status IN ('open', 'partially_matched')", itemId)
    .filter((b) => b.remainingQty > 0)
    .map((b) => toBookBid(app, b));
  const asks = bookAsks(app, itemId);
  const fills = matchBook(bids, asks, { shopCityId: shop.cityId, now: app.now() });
  const matches = fills.map((f) => applyFill(app, f, trigger));
  if (matches.length > 0) emitBook(app, itemId);
  return matches;
}

function jobStatusesAt(claim: Claim): JobStatus[] {
  if (claim.status === 'checked_in') return ['claimed', 'queueing'];
  if (claim.status === 'arrived') return ['claimed', 'checked_in'];
  return ['claimed'];
}

/** Turns one fill into an immutable match and its job. Call inside app.tx. */
export function applyFill(app: App, fill: Fill, trigger: MatchTrigger): Match {
  const bid = app.store.bids.must(fill.bidId);
  const ask = app.store.asks.must(fill.askId);
  const claim = app.store.claims.must(ask.claimId);
  const { item } = itemById(bid.itemId);
  const at = fill.at;
  const matchId = app.nextId('mat');
  const jobId = app.nextId('job');
  const match: Match = { id: matchId, shopId: bid.shopId, itemId: bid.itemId, bidId: bid.id, askId: ask.id, jobId, qty: fill.qty, feeCents: fill.feeCents, at, trigger };
  const statuses = jobStatusesAt(claim);
  const mode = bid.destination.mode;
  const job: Job = {
    id: jobId,
    matchId,
    bidId: bid.id,
    askId: ask.id,
    claimId: claim.id,
    requesterId: bid.requesterId,
    requesterName: bid.requesterName,
    queuerId: ask.queuerId,
    queuerName: ask.queuerName,
    shopId: bid.shopId,
    itemId: bid.itemId,
    qty: fill.qty,
    feeCents: fill.feeCents,
    mode,
    status: statuses[statuses.length - 1]!,
    failure: null,
    proofCode: app.code('proof', jobId, `${bid.requesterId}>${ask.queuerId}@${bid.shopId}`),
    handoverCode: mode === 'local' ? app.digits('handover', jobId) : null,
    fx: item.retail.currency === 'TWD' ? { twdPerUsd: app.rules.fxTwdPerUsd, lockedAt: at } : null,
    caps: jobCaps(bid, { qty: fill.qty, feeCents: fill.feeCents }, mode),
    amounts: { retailCents: null, shippingCents: null, capturedCents: 0, refundedCents: 0, paidOutCents: 0, processingCents: 0, paypalFeesCents: 0 },
    shipment: null,
    history: statuses.map((status) => ({ status, at })),
    disputed: false,
    createdAt: at,
    updatedAt: at,
  };

  bid.remainingQty -= fill.qty;
  const nextBid = bidStatusForQty(bid.qty, bid.remainingQty);
  if (nextBid !== bid.status) {
    assertTransition('bid', bid.status, nextBid);
    bid.status = nextBid;
  }
  bid.updatedAt = at;

  ask.remainingCapacity -= fill.qty;
  if (ask.remainingCapacity === 0) {
    assertTransition('ask', ask.status, 'filled');
    ask.status = 'filled';
  }
  ask.updatedAt = at;

  app.store.matches.insert(match);
  app.store.jobs.insert(job);
  app.store.bids.update(bid);
  app.store.asks.update(ask);
  emitMatch(app, match);
  emitJob(app, job);
  emitBid(app, bid);
  emitAsk(app, ask);
  return match;
}

/** Moves a job to a new status with history. Call inside app.tx. */
export function setJobStatus(app: App, job: Job, status: JobStatus): Job {
  assertTransition('job', job.status, status);
  const at = app.now();
  job.status = status;
  job.history = [...job.history, { status, at }];
  job.updatedAt = at;
  app.store.jobs.update(job);
  emitJob(app, job);
  return job;
}

export function latestLinePhoto(app: App, shopId: string): { peopleAhead: number | null; at: number } | null {
  let best: { peopleAhead: number | null; at: number } | null = null;
  for (const p of app.store.proofs.where("kind = 'check_in' AND status = 'passed'")) {
    const claim = p.claimId ? app.store.claims.get(p.claimId) : null;
    if (!claim || claim.shopId !== shopId) continue;
    const at = p.decidedAt ?? p.createdAt;
    if (!best || at >= best.at) best = { peopleAhead: p.peopleAhead, at };
  }
  return best;
}

/** What PayPal still holds for a bid: its hold less what was captured or released. */
function stillHeldCents(app: App, bid: BidTask): number {
  const hold = bid.holdId ? app.store.holds.get(bid.holdId) : null;
  return hold ? Math.max(0, hold.amount.cents - hold.capturedCents - hold.releasedCents) : 0;
}

/** What the public map shows for one book. No positions, no single bids. */
export function bookSnapshot(app: App, itemId: string): BookSnapshot {
  const { shop, item } = itemById(itemId);
  const state = bookState(app, itemId);
  const resting = app.store.bids
    .where("item_id = ? AND status IN ('open', 'partially_matched')", itemId)
    .filter((b) => b.remainingQty > 0)
    .map((b) => ({ maxFeeCents: b.maxFeeCents, remainingQty: fillableQty(app, b), matchable: bidMatchableNow(app, b), deadlineAt: b.deadlineAt, heldCents: stillHeldCents(app, b) }));
  const live = resting.filter((b) => b.matchable && b.remainingQty > 0);
  // Each level also says what PayPal holds behind it (D-111): the book view shows requests as money, not likes.
  const levels = bidDepth(live, 5).map((l) => ({ ...l, heldCents: live.filter((b) => b.maxFeeCents === l.feeCents).reduce((sum, b) => sum + b.heldCents, 0) }));
  const quotes: AskQuote[] = [];
  for (const ask of app.store.asks.where("item_id = ? AND status = 'open'", itemId)) {
    const claim = app.store.claims.get(ask.claimId);
    if (!claim || !LIVE_CLAIM.includes(claim.status) || ask.remainingCapacity <= 0) continue;
    const q = app.store.users.get(ask.queuerId);
    quotes.push({
      askId: ask.id,
      queuerId: ask.queuerId,
      queuerName: ask.queuerName,
      avatar: q?.user.avatar ?? null,
      claimStatus: claim.status,
      feeCents: ask.feeCents,
      clock: ask.clock,
      remainingCapacity: ask.remainingCapacity,
      modes: ask.modes,
      etaAt: ask.etaAt,
    });
  }
  const last = app.store.matches.where('item_id = ?', itemId).at(-1) ?? null;
  const line = latestLinePhoto(app, shop.id);
  const queuers = app.store.claims
    .where("shop_id = ? AND status = 'checked_in'", shop.id)
    .map((c) => c.queuerName)
    .filter((n, i, all) => all.indexOf(n) === i);
  return {
    shopId: shop.id,
    itemId,
    cityId: shop.cityId,
    asOf: app.now(),
    status: state.status,
    retailCents: item.retailCents,
    bids: {
      count: live.length,
      qty: live.reduce((s, b) => s + b.remainingQty, 0),
      bestFeeCents: levels[0]?.feeCents ?? null,
      levels,
      latestDeadlineAt: live.length > 0 ? Math.max(...live.map((b) => b.deadlineAt)) : null,
    },
    asks: { count: quotes.length, capacity: quotes.reduce((s, q) => s + q.remainingCapacity, 0), quotes },
    lastFill: last ? { feeCents: last.feeCents, qty: last.qty, at: last.at } : null,
    queue: {
      minutes: expectedWaitMinutes(item, line?.peopleAhead ?? null),
      peopleAhead: line?.peopleAhead ?? null,
      queuers,
    },
  };
}

export function emitBook(app: App, itemId: string): void {
  app.emit('book.updated', bookSnapshot(app, itemId), ALL);
}
