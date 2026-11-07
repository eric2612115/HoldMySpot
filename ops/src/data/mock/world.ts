import {
  DEFAULT_RULES,
  DEMO_TIME_ZONE,
  JOB_BEFORE_PURCHASE,
  JOB_SETTLED,
  SEED_SHOPS,
  SEED_USERS,
  askFeeAt,
  assertCaptureWithinLimit,
  compatible,
  bidLimitCents,
  bidStatusForQty,
  formatUsd,
  holdTiming,
  isFinalCapture,
  jobCaps,
  localToUsdCents,
  matchBook,
  money,
  nextClockStepAt,
  PAYPAL_PRICING,
  paypalCaptureFeeCents,
  payoutsForCapture,
  receiptCapture,
  shippingCapture,
} from '@holdmyspot/shared';
import type {
  AgentAction,
  AiStamp,
  AskTask,
  BidTask,
  BookAsk,
  BookBid,
  Cents,
  Claim,
  Destination,
  FeeClock,
  FundingSource,
  Hold,
  Item,
  Job,
  JobFailureReason,
  JobStatus,
  LedgerEntry,
  LedgerKind,
  LedgerStatus,
  LngLat,
  MarketMs,
  Match,
  MatchTrigger,
  OpsMove,
  Payout,
  Reliability,
  Shop,
  User,
  UserId,
} from '@holdmyspot/shared';
import { MINUTE } from '../time.ts';

/**
 * An in-browser stand-in for the server's records, so the console runs
 * before server/ exists (and offline while filming). Every change goes
 * through the shared rules: matchBook for fills, the stepdown clock for
 * prices, jobCaps / receiptCapture / shippingCapture / isFinalCapture for
 * captures, payoutsForCapture for payouts. Commands mirror the server's.
 */

export interface CrowdPerson {
  id: UserId;
  displayName: string;
  cityName: string;
  region: string;
}

export interface World {
  now: MarketMs;
  users: Map<UserId, User>;
  crowd: Map<UserId, CrowdPerson>;
  reliability: Map<UserId, Reliability>;
  bids: BidTask[];
  holds: Hold[];
  asks: AskTask[];
  claims: Claim[];
  matches: Match[];
  jobs: Job[];
  ledger: LedgerEntry[];
  payouts: Payout[];
  /** Notes the rescheduler wrote after a rule moved work (AI-SERVICES.md 4.6). */
  notes: AgentAction[];
  /** Claims whose queuer never leaves home (the synthetic walk stalls; they will miss check-in). */
  stalledClaims: Set<string>;
  seq: Record<string, number>;
}

export const RULES = DEFAULT_RULES;
const FX = RULES.fxTwdPerUsd;

export function shopById(id: string): Shop {
  const s = SEED_SHOPS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown shop ${id}`);
  return s;
}

export function itemById(id: string): Item {
  for (const s of SEED_SHOPS) {
    const item = s.items.find((i) => i.id === id);
    if (item) return item;
  }
  throw new Error(`Unknown item ${id}`);
}

export function createWorld(start: MarketMs, crowd: CrowdPerson[], stalledClaims: string[]): World {
  const users = new Map(SEED_USERS.map((u) => [u.id, u]));
  const reliability = new Map<UserId, Reliability>();
  for (const u of SEED_USERS) if (u.reliability) reliability.set(u.id, { ...u.reliability });
  return {
    now: start,
    users,
    crowd: new Map(crowd.map((c) => [c.id, c])),
    reliability,
    bids: [],
    holds: [],
    asks: [],
    claims: [],
    matches: [],
    jobs: [],
    ledger: [],
    payouts: [],
    notes: [],
    stalledClaims: new Set(stalledClaims),
    seq: {},
  };
}

function nextId(w: World, prefix: string, width = 3): string {
  const n = (w.seq[prefix] ?? 0) + 1;
  w.seq[prefix] = n;
  return `${prefix}-${String(n).padStart(width, '0')}`;
}

export function nameOf(w: World, userId: UserId): string {
  return w.users.get(userId)?.displayName ?? w.crowd.get(userId)?.displayName ?? userId;
}

const usd = (cents: Cents) => formatUsd(cents, { exact: true });

function unitWord(item: Item, qty: number): string {
  const one: Record<string, string> = { cake: 'cake', plush: 'plush', ramen: 'ramen bowl' };
  const many: Record<string, string> = { cake: 'cakes', plush: 'plush toys', ramen: 'ramen bowls' };
  return qty === 1 ? `1 ${one[item.kind]}` : `${qty} ${many[item.kind]}`;
}

export const getBid = (w: World, id: string) => must(w.bids.find((b) => b.id === id), id);
export const getAsk = (w: World, id: string) => must(w.asks.find((a) => a.id === id), id);
export const getClaim = (w: World, id: string) => must(w.claims.find((c) => c.id === id), id);
export const getJob = (w: World, id: string) => must(w.jobs.find((j) => j.id === id), id);
export const getHold = (w: World, id: string) => must(w.holds.find((h) => h.id === id), id);

function must<T>(value: T | undefined, id: string): T {
  if (value === undefined) throw new Error(`Missing record ${id}`);
  return value;
}

function addLedger(
  w: World,
  e: {
    kind: LedgerKind;
    cents: Cents;
    text: string;
    at: MarketMs;
    userId: UserId;
    key: string;
    holdId?: string | null;
    bidId?: string | null;
    jobId?: string | null;
    payoutId?: string | null;
    status?: LedgerStatus;
    paypal?: LedgerEntry['paypal'];
  },
): LedgerEntry {
  const entry: LedgerEntry = {
    id: nextId(w, 'led', 4),
    kind: e.kind,
    amount: money(e.cents),
    text: e.text,
    at: e.at,
    holdId: e.holdId ?? null,
    payoutId: e.payoutId ?? null,
    bidId: e.bidId ?? null,
    jobId: e.jobId ?? null,
    userId: e.userId,
    idempotencyKey: e.key,
    status: e.status ?? 'succeeded',
    mode: 'fake',
    paypal: e.paypal ?? null,
  };
  w.ledger.push(entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Bids and holds
// ---------------------------------------------------------------------------

export interface BidSpec {
  id: string;
  requesterId: UserId;
  shopId: string;
  itemId: string;
  qty: number;
  retailCapCents: Cents;
  maxFeeCents: Cents;
  shippingBudgetCents: Cents;
  createdAt: MarketMs;
  deadlineAt: MarketMs;
  funding?: FundingSource;
  /** Local errand or shipped. Default: shipped when there is a shipping budget and the item ships, else the item's first mode. */
  mode?: 'local' | 'ship';
}

function destinationFor(w: World, requesterId: UserId, mode: 'ship' | 'local', shop: Shop): Destination {
  if (mode === 'local') return { mode: 'local', cityId: shop.cityId };
  const user = w.users.get(requesterId);
  if (user?.cityId === 'sf') return { mode: 'ship', country: 'US', region: 'CA', city: 'San Francisco', postalCode: null };
  if (user) return { mode: 'ship', country: 'US', region: 'NY', city: 'New York', postalCode: null };
  const c = w.crowd.get(requesterId);
  return { mode: 'ship', country: 'US', region: c?.region ?? 'NY', city: c?.cityName ?? 'New York', postalCode: null };
}

export function placeBid(w: World, s: BidSpec): BidTask {
  const shop = shopById(s.shopId);
  const item = itemById(s.itemId);
  const mode = s.mode ?? (s.shippingBudgetCents > 0 && item.modes.includes('ship') ? 'ship' : (item.modes[0] ?? 'ship'));
  const limitCents = bidLimitCents(s);
  const holdId = `hold-${s.id}`;
  const authorizedAt = s.createdAt;
  const timing = holdTiming({ authorizedAt, originalAuthorizedAt: authorizedAt });
  const funding = s.funding ?? 'paypal';
  const requesterName = nameOf(w, s.requesterId);
  const hold: Hold = {
    id: holdId,
    reference: s.id,
    description: `${unitWord(item, s.qty)} from ${shop.name}`,
    amount: money(limitCents),
    capturedCents: 0,
    releasedCents: 0,
    refundedCents: 0,
    status: 'held',
    fundingSource: funding,
    paypalOrderId: `FAKE-ORDER-${s.id}`,
    authorizationId: `FAKE-AUTH-${s.id}`,
    originalAuthorizationId: `FAKE-AUTH-${s.id}`,
    authorizedAt,
    originalAuthorizedAt: authorizedAt,
    honorEndsAt: timing.honorEndsAt,
    expiresAt: timing.expiresAt,
    clockBasis: 'market',
    renewals: 0,
    renewalRequired: false,
    createdAt: s.createdAt,
    updatedAt: s.createdAt,
  };
  const bid: BidTask = {
    id: s.id,
    requesterId: s.requesterId,
    requesterName,
    shopId: s.shopId,
    itemId: s.itemId,
    qty: s.qty,
    remainingQty: s.qty,
    retailCapCents: s.retailCapCents,
    maxFeeCents: s.maxFeeCents,
    shippingBudgetCents: s.shippingBudgetCents,
    limitCents,
    destination: destinationFor(w, s.requesterId, mode, shop),
    deadlineAt: s.deadlineAt,
    status: 'open',
    closeReason: null,
    holdId,
    paypalOrderId: hold.paypalOrderId,
    paypalAuthorizationId: hold.authorizationId,
    agent: null,
    createdAt: s.createdAt,
    pricedAt: s.createdAt,
    updatedAt: s.createdAt,
  };
  w.holds.push(hold);
  w.bids.push(bid);
  addLedger(w, {
    kind: 'held',
    cents: limitCents,
    text: `PayPal holds up to ${usd(limitCents)} for ${requesterName}'s ${unitWord(item, s.qty)} from ${shop.name}.`,
    at: s.createdAt,
    userId: s.requesterId,
    key: `auth:${s.id}`,
    holdId,
    bidId: s.id,
    paypal: { orderId: hold.paypalOrderId ?? undefined, authorizationId: hold.authorizationId ?? undefined },
  });
  match(w, s.shopId, s.itemId, s.createdAt, 'new_bid');
  return bid;
}

/** The hold cannot back new fills or captures until the requester approves a new one. */
export function markRenewalRequired(w: World, bidId: string, at: MarketMs): void {
  const bid = getBid(w, bidId);
  const hold = getHold(w, bid.holdId ?? '');
  hold.renewalRequired = true;
  hold.updatedAt = at;
  addLedger(w, {
    kind: 'renewed',
    cents: hold.amount.cents,
    text: `PayPal could not renew ${bid.requesterName}'s ${hold.fundingSource === 'venmo' ? 'Venmo ' : ''}hold of ${usd(hold.amount.cents)}; she needs to approve a new one.`,
    at,
    userId: bid.requesterId,
    key: `reauth:${hold.id}:1`,
    holdId: hold.id,
    bidId,
    status: 'failed',
  });
}

function holdUsable(w: World, bid: BidTask): boolean {
  const hold = bid.holdId ? w.holds.find((h) => h.id === bid.holdId) : undefined;
  return !!hold && (hold.status === 'held' || hold.status === 'partially_captured') && !hold.renewalRequired;
}

// ---------------------------------------------------------------------------
// Asks, claims and check-in
// ---------------------------------------------------------------------------

export interface AskSpec {
  id: string;
  queuerId: UserId;
  shopId: string;
  itemId: string;
  capacity: number;
  feeCents: Cents;
  clock: { stepCents: Cents; intervalMinutes: number; floorCents: Cents } | null;
  etaAt: MarketMs;
  createdAt: MarketMs;
  /** Modes this queuer serves. Default: every mode the item allows. */
  modes?: ('local' | 'ship')[];
}

function newClaim(w: World, askId: string, queuerId: UserId, shopId: string, createdAt: MarketMs, etaAt: MarketMs): Claim {
  const claim: Claim = {
    id: `claim-${askId.replace(/^ask-/, '')}`,
    askId,
    queuerId,
    queuerName: nameOf(w, queuerId),
    shopId,
    windowStartsAt: createdAt,
    windowEndsAt: etaAt + RULES.arrivalGraceMinutes * MINUTE,
    status: 'awaiting_arrival',
    checkInCode: null,
    arrival: null,
    linePhotoProofId: null,
    checkedInAt: null,
    createdAt,
    updatedAt: createdAt,
  };
  w.claims.push(claim);
  return claim;
}

export function postAsk(w: World, s: AskSpec): AskTask {
  const clock: FeeClock | null = s.clock
    ? { stepCents: s.clock.stepCents, intervalMs: s.clock.intervalMinutes * MINUTE, floorCents: s.clock.floorCents, startsAt: null }
    : null;
  const claim = newClaim(w, s.id, s.queuerId, s.shopId, s.createdAt, s.etaAt);
  const ask: AskTask = {
    id: s.id,
    queuerId: s.queuerId,
    queuerName: nameOf(w, s.queuerId),
    shopId: s.shopId,
    itemId: s.itemId,
    claimId: claim.id,
    origin: 'post',
    targetBidId: null,
    capacity: s.capacity,
    remainingCapacity: s.capacity,
    modes: s.modes ? [...s.modes] : [...itemById(s.itemId).modes],
    feeCents: s.feeCents,
    clock,
    etaAt: s.etaAt,
    status: 'open',
    createdAt: s.createdAt,
    pricedAt: s.createdAt,
    updatedAt: s.createdAt,
  };
  w.asks.push(ask);
  match(w, s.shopId, s.itemId, s.createdAt, 'new_ask');
  return ask;
}

/** A queuer takes one resting bid at its max fee (a claim-ask that only fills that bid). */
export function claimBid(w: World, s: { id: string; bidId: string; queuerId: UserId; etaAt: MarketMs; at: MarketMs }): AskTask {
  const bid = getBid(w, s.bidId);
  const claim = newClaim(w, s.id, s.queuerId, bid.shopId, s.at, s.etaAt);
  const ask: AskTask = {
    id: s.id,
    queuerId: s.queuerId,
    queuerName: nameOf(w, s.queuerId),
    shopId: bid.shopId,
    itemId: bid.itemId,
    claimId: claim.id,
    origin: 'claim',
    targetBidId: bid.id,
    capacity: bid.remainingQty,
    remainingCapacity: bid.remainingQty,
    modes: [bid.destination.mode],
    feeCents: bid.maxFeeCents,
    clock: null,
    etaAt: s.etaAt,
    status: 'open',
    createdAt: s.at,
    pricedAt: s.at,
    updatedAt: s.at,
  };
  w.asks.push(ask);
  match(w, bid.shopId, bid.itemId, s.at, 'claim');
  return ask;
}

function pushHistory(job: Job, status: JobStatus, at: MarketMs): void {
  job.status = status;
  job.history.push({ status, at });
  job.updatedAt = at;
}

export function checkIn(w: World, claimId: string, arrivedAt: MarketMs, checkedInAt: MarketMs): void {
  const claim = getClaim(w, claimId);
  const shop = shopById(claim.shopId);
  claim.status = 'checked_in';
  claim.arrival = { at: arrivedAt, lngLat: shop.lngLat, accuracyM: 12, distanceM: 24 };
  claim.linePhotoProofId = `proof-line-${claim.id}`;
  claim.checkedInAt = checkedInAt;
  claim.updatedAt = checkedInAt;
  const ask = getAsk(w, claim.askId);
  if (ask.clock) ask.clock = { ...ask.clock, startsAt: checkedInAt };
  ask.updatedAt = checkedInAt;
  for (const job of w.jobs) {
    if (job.claimId !== claim.id || job.status !== 'claimed') continue;
    pushHistory(job, 'checked_in', arrivedAt);
    pushHistory(job, 'queueing', checkedInAt);
  }
  match(w, ask.shopId, ask.itemId, checkedInAt, 'clock_step');
}

/** No check-in before the window ended (or ops lapsed it early): jobs fail and their quantity is re-offered. */
export function lapseClaim(w: World, claimId: string, at: MarketMs): Job[] {
  const claim = getClaim(w, claimId);
  claim.status = 'lapsed';
  claim.updatedAt = at;
  const ask = getAsk(w, claim.askId);
  ask.status = 'lapsed';
  ask.updatedAt = at;
  const rel = w.reliability.get(claim.queuerId);
  if (rel) {
    rel.claimsLapsed += 1;
    const total = rel.claimsCompleted + rel.claimsLapsed + rel.proofsRejected;
    rel.score = Math.round((100 * rel.claimsCompleted) / total);
  }
  const failed: Job[] = [];
  for (const job of w.jobs) {
    if (job.claimId !== claim.id || JOB_SETTLED.includes(job.status)) continue;
    failJob(w, job.id, at, 'no_show', `${claim.queuerName} did not check in before ${new Date(claim.windowEndsAt).toISOString()}.`, { requeue: false });
    failed.push(job);
  }
  match(w, claim.shopId, ask.itemId, at, 'requeue');
  return failed;
}

/** Ends a queuer's visit: any capacity left is closed. */
export function endVisit(w: World, claimId: string, at: MarketMs, askStatus: 'closed' | 'withdrawn' = 'closed'): void {
  const claim = getClaim(w, claimId);
  if (claim.status === 'checked_in' || claim.status === 'arrived') claim.status = 'done';
  claim.updatedAt = at;
  const ask = getAsk(w, claim.askId);
  if (ask.status === 'open') ask.status = askStatus;
  ask.updatedAt = at;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function bookBids(w: World, shopId: string, itemId: string): BookBid[] {
  return w.bids
    .filter((b) => b.shopId === shopId && b.itemId === itemId)
    .map((b) => ({
      id: b.id,
      requesterId: b.requesterId,
      maxFeeCents: b.maxFeeCents,
      remainingQty: b.remainingQty,
      destination: b.destination,
      deadlineAt: b.deadlineAt,
      pricedAt: b.pricedAt,
      matchable: holdUsable(w, b) && ['open', 'partially_matched', 'matched'].includes(b.status),
    }));
}

function bookAsks(w: World, shopId: string, itemId: string): BookAsk[] {
  return w.asks
    .filter((a) => a.shopId === shopId && a.itemId === itemId)
    .map((a) => {
      const claim = w.claims.find((c) => c.id === a.claimId);
      const enRoute = claim && (claim.status === 'awaiting_arrival' || claim.status === 'arrived');
      return {
        id: a.id,
        queuerId: a.queuerId,
        feeCents: a.feeCents,
        clock: a.clock,
        remainingCapacity: a.remainingCapacity,
        modes: a.modes,
        etaAt: a.etaAt,
        windowEndsAt: enRoute ? claim.windowEndsAt : null,
        pricedAt: a.pricedAt,
        matchable: a.status === 'open',
        targetBidId: a.targetBidId,
      };
    });
}

export function match(w: World, shopId: string, itemId: string, at: MarketMs, trigger: MatchTrigger): Match[] {
  const shop = shopById(shopId);
  const fills = matchBook(bookBids(w, shopId, itemId), bookAsks(w, shopId, itemId), { shopCityId: shop.cityId, now: at });
  const created: Match[] = [];
  for (const f of fills) {
    const bid = getBid(w, f.bidId);
    const ask = getAsk(w, f.askId);
    const claim = getClaim(w, ask.claimId);
    const item = itemById(itemId);
    const matchId = nextId(w, 'match');
    const jobId = nextId(w, 'job');
    const m: Match = { id: matchId, shopId, itemId, bidId: bid.id, askId: ask.id, jobId, qty: f.qty, feeCents: f.feeCents, at, trigger };
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
      shopId,
      itemId,
      qty: f.qty,
      feeCents: f.feeCents,
      mode: bid.destination.mode,
      status: 'claimed',
      failure: null,
      proofCode: null,
      handoverCode: null,
      fx: item.retail.currency === 'TWD' ? { twdPerUsd: FX, lockedAt: at } : null,
      caps: jobCaps(bid, { qty: f.qty, feeCents: f.feeCents }),
      amounts: { retailCents: null, shippingCents: null, capturedCents: 0, refundedCents: 0, paidOutCents: 0 },
      shipment: null,
      history: [{ status: 'claimed', at }],
      disputed: false,
      createdAt: at,
      updatedAt: at,
    };
    if (claim.status === 'checked_in') pushHistory(job, 'queueing', at);
    w.matches.push(m);
    w.jobs.push(job);
    created.push(m);
    bid.remainingQty -= f.qty;
    bid.status = bidStatusForQty(bid.qty, bid.remainingQty);
    bid.updatedAt = at;
    ask.remainingCapacity -= f.qty;
    if (ask.remainingCapacity === 0) ask.status = 'filled';
    ask.updatedAt = at;
  }
  return created;
}

/** The next market time at which a fee clock steps or an arrival window ends, after `now`. */
export function nextRuleTime(w: World, now: MarketMs): MarketMs | null {
  let next: MarketMs | null = null;
  const keys = new Set(w.asks.map((a) => `${a.shopId}|${a.itemId}`));
  for (const key of keys) {
    const [shopId, itemId] = key.split('|') as [string, string];
    const t = nextClockStepAt(bookAsks(w, shopId, itemId), now);
    if (t !== null && t > now && (next === null || t < next)) next = t;
  }
  for (const c of w.claims) {
    if ((c.status === 'awaiting_arrival' || c.status === 'arrived') && c.windowEndsAt > now && (next === null || c.windowEndsAt < next)) {
      next = c.windowEndsAt;
    }
  }
  return next;
}

/** Applies the time-driven rules at `t`: clock steps (matching) and lapsed arrival windows. */
export function runRulesAt(w: World, t: MarketMs): void {
  for (const c of w.claims) {
    if ((c.status === 'awaiting_arrival' || c.status === 'arrived') && c.windowEndsAt <= t) {
      const failed = lapseClaim(w, c.id, c.windowEndsAt);
      noteRequeue(w, failed, c.windowEndsAt, `${c.queuerName} missed check-in at ${clockOf(c.windowEndsAt)}`);
    }
  }
  const keys = new Set(w.asks.filter((a) => a.status === 'open').map((a) => `${a.shopId}|${a.itemId}`));
  for (const key of keys) {
    const [shopId, itemId] = key.split('|') as [string, string];
    match(w, shopId, itemId, t, 'clock_step');
  }
}

const clockFmt = new Intl.DateTimeFormat('en-GB', { timeZone: DEMO_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const clockOf = (t: MarketMs) => clockFmt.format(t);

/** One plain sentence for the board after a rule moved quantity (AI-SERVICES.md 4.6, fake template). */
export function noteRequeue(w: World, failed: Job[], at: MarketMs, cause: string, ai: AiStamp = RULES_STAMP): void {
  for (const job of failed) {
    const next = w.matches.find((m) => m.bidId === job.bidId && m.at === at && m.trigger === 'requeue');
    const item = itemById(job.itemId);
    const what = unitWord(item, job.qty).replace(/^1 /, '');
    let reason = `${cause}; ${job.requesterName}'s ${what} went back to the line-up`;
    if (next) {
      const ask = getAsk(w, next.askId);
      reason += ` and ${ask.queuerName}'s offer (${usd(next.feeCents)}, ETA ${clockOf(ask.etaAt)}) took it.`;
    } else {
      reason += '.';
    }
    w.notes.push({
      id: nextId(w, 'agent'),
      bidId: job.bidId,
      at,
      kind: 'reassign',
      fromFeeCents: job.feeCents,
      toFeeCents: next?.feeCents ?? null,
      reason,
      ai,
    });
  }
}

// ---------------------------------------------------------------------------
// Jobs, proofs, captures and payouts
// ---------------------------------------------------------------------------

export function failJob(
  w: World,
  jobId: string,
  at: MarketMs,
  reason: JobFailureReason,
  detail: string,
  opts: { requeue: boolean; freeCapacity?: boolean },
): void {
  const job = getJob(w, jobId);
  // Quantity goes back to the requester only when nothing was bought for it
  // (or the purchase proof was rejected): docs/DOMAIN.md section 4, rule 7.
  const returnQty = JOB_BEFORE_PURCHASE.includes(job.status) || reason === 'proof_rejected';
  job.failure = { reason, at, detail };
  pushHistory(job, 'failed', at);
  if (!returnQty) return;
  const bid = getBid(w, job.bidId);
  bid.remainingQty += job.qty;
  bid.status = bidStatusForQty(bid.qty, bid.remainingQty);
  bid.updatedAt = at;
  if (opts.freeCapacity) {
    const ask = getAsk(w, job.askId);
    ask.remainingCapacity += job.qty;
    if (ask.status === 'filled') ask.status = 'open';
    ask.updatedAt = at;
  }
  if (opts.requeue) match(w, job.shopId, job.itemId, at, 'requeue');
}

export function markBought(w: World, jobIds: string[], at: MarketMs): void {
  for (const id of jobIds) {
    const job = getJob(w, id);
    if (job.status === 'queueing') pushHistory(job, 'bought', at);
  }
}

/** A purchase proof that the rules reject: nothing is captured ("$0 moved") and the quantity is re-offered. */
export function rejectProof(w: World, jobId: string, submittedAt: MarketMs, decidedAt: MarketMs, detail: string): void {
  const job = getJob(w, jobId);
  pushHistory(job, 'proof_submitted', submittedAt);
  const rel = w.reliability.get(job.queuerId);
  if (rel) {
    rel.proofsRejected += 1;
    const total = rel.claimsCompleted + rel.claimsLapsed + rel.proofsRejected;
    rel.score = Math.round((100 * rel.claimsCompleted) / total);
  }
  failJob(w, jobId, decidedAt, 'proof_rejected', detail, { requeue: true });
  endVisit(w, job.claimId, decidedAt);
  noteRequeue(w, [job], decidedAt, `${job.queuerName}'s receipt failed 4 checks, so $0 moved`);
}

function bidCanStillMatch(w: World, bid: BidTask, at: MarketMs): boolean {
  return holdUsable(w, bid) && at <= bid.deadlineAt && ['open', 'partially_matched', 'matched'].includes(bid.status);
}

function capture(
  w: World,
  job: Job,
  at: MarketMs,
  part: 'receipt' | 'shipping',
  amountCents: Cents,
  textParts: string,
  payoutParts: ReturnType<typeof payoutsForCapture>,
  /** The capture's processing and payouts at cost (D-105), part of amountCents. */
  processingCents = 0,
): void {
  const bid = getBid(w, job.bidId);
  const hold = getHold(w, bid.holdId ?? '');
  const otherActiveJobs = w.jobs.filter(
    (j) => j.bidId === bid.id && j.id !== job.id && !JOB_SETTLED.includes(j.status) && j.status !== 'shipped',
  ).length;
  const final = isFinalCapture({
    moreCapturesForThisJob: part === 'receipt' && job.mode === 'ship',
    otherActiveJobs,
    bidRemainingQty: bid.remainingQty,
    bidCanStillMatch: bidCanStillMatch(w, bid, at),
  });
  assertCaptureWithinLimit({ limitCents: hold.amount.cents, capturedCents: hold.capturedCents, status: hold.status }, amountCents);
  hold.capturedCents += amountCents;
  hold.status = final ? 'captured' : 'partially_captured';
  hold.updatedAt = at;
  job.amounts.capturedCents += amountCents;
  // PayPal's fee on this capture, as the emulator charges it; the processing line pays it (D-105).
  job.amounts.processingCents = (job.amounts.processingCents ?? 0) + processingCents;
  job.amounts.paypalFeesCents = (job.amounts.paypalFeesCents ?? 0) + paypalCaptureFeeCents(amountCents);
  const captureId = nextId(w, 'FAKE-CAP', 4);
  addLedger(w, {
    kind: 'captured',
    cents: amountCents,
    text: `Captured ${usd(amountCents)} from ${bid.requesterName}: ${textParts}.`,
    at,
    userId: bid.requesterId,
    key: `cap:${job.id}:${part}`,
    holdId: hold.id,
    bidId: bid.id,
    jobId: job.id,
    paypal: { authorizationId: hold.authorizationId ?? undefined, captureId },
  });
  if (final) {
    const released = hold.amount.cents - hold.capturedCents - hold.releasedCents;
    if (released > 0) {
      hold.releasedCents += released;
      addLedger(w, {
        kind: 'released',
        cents: released,
        text: `Released ${usd(released)} back to ${bid.requesterName}: the rest of the hold.`,
        at,
        userId: bid.requesterId,
        key: `void:${hold.id}:final`,
        holdId: hold.id,
        bidId: bid.id,
        // As on the server: the final capture released the rest, so the release names that capture.
        paypal: { authorizationId: hold.authorizationId ?? undefined, captureId },
      });
    }
    bid.status = 'settled';
    bid.closeReason = 'filled';
    bid.updatedAt = at;
  }
  for (const p of payoutParts) {
    const payoutId = nextId(w, 'payout');
    const key = p.purpose === 'fee' ? 'fee' : p.purpose === 'reimbursement' ? 'reimb' : 'all';
    const queuerName = job.queuerName;
    const note =
      p.purpose === 'fee'
        ? `Queue fee ${usd(job.caps.feeCents)} minus the 10% platform fee`
        : p.purpose === 'reimbursement'
          ? 'Shop price and shipping at cost'
          : 'Shop price and queue fee minus the 10% platform fee';
    const payout: Payout = {
      id: payoutId,
      recipient: queuerName,
      recipientUserId: job.queuerId,
      receiverEmail: null,
      amount: money(p.amountCents),
      note,
      reference: job.id,
      purpose: p.purpose,
      platformFeeCents: p.platformFeeCents,
      status: 'succeeded',
      // The emulator's id format (FAKE-BATCH-0001, FAKE-ITEM-0001), as the live server shows them.
      paypalBatchId: nextId(w, 'FAKE-BATCH', 4),
      paypalItemId: nextId(w, 'FAKE-ITEM', 4),
      paypalFeeCents: PAYPAL_PRICING.payoutItemCents,
      createdAt: at,
      updatedAt: at,
    };
    w.payouts.push(payout);
    job.amounts.paidOutCents += p.amountCents;
    job.amounts.paypalFeesCents = (job.amounts.paypalFeesCents ?? 0) + PAYPAL_PRICING.payoutItemCents;
    addLedger(w, {
      kind: 'paid_out',
      cents: p.amountCents,
      text: `Paid ${queuerName} ${usd(p.amountCents)}: ${note.charAt(0).toLowerCase()}${note.slice(1)}.`,
      at,
      userId: job.queuerId,
      key: `payout:${job.id}:${key}`,
      payoutId,
      jobId: job.id,
      bidId: bid.id,
      paypal: { payoutBatchId: payout.paypalBatchId ?? undefined, payoutItemId: payout.paypalItemId ?? undefined },
    });
  }
}

/** Receipt and item photos pass: capture #1 (receipt retail at cost plus the matched fee) and pay the fee. */
export function passProof(w: World, jobId: string, submittedAt: MarketMs, verifiedAt: MarketMs, receiptMinor: number): void {
  const job = getJob(w, jobId);
  if (job.status === 'queueing') pushHistory(job, 'bought', submittedAt);
  pushHistory(job, 'proof_submitted', submittedAt);
  const item = itemById(job.itemId);
  const retailUsd = localToUsdCents({ currency: item.retail.currency, minor: receiptMinor }, job.fx?.twdPerUsd ?? FX);
  const bid = getBid(w, job.bidId);
  const hold = getHold(w, bid.holdId ?? '');
  if (hold.renewalRequired) {
    // The honor period is over and the hold was never renewed: PayPal declines the capture.
    addLedger(w, {
      kind: 'captured',
      cents: 0,
      text: `PayPal declined the capture for ${bid.requesterName}: her hold was past its honor period and never renewed.`,
      at: verifiedAt,
      userId: bid.requesterId,
      key: `cap:${job.id}:receipt`,
      holdId: hold.id,
      bidId: bid.id,
      jobId: job.id,
      status: 'failed',
    });
    failJob(w, jobId, verifiedAt, 'payment_failed', 'PayPal declined the receipt capture (hold renewal required).', { requeue: false });
    return;
  }
  const rc = receiptCapture(job.caps, retailUsd, job.mode);
  job.amounts.retailCents = rc.retailCents;
  pushHistory(job, 'verified', verifiedAt);
  const parts = payoutsForCapture(job.mode, job.mode === 'ship' ? 'receipt' : 'handover', {
    retailCents: rc.retailCents,
    feeCents: job.caps.feeCents,
    shippingCents: 0,
  });
  const fees = job.qty === 1 ? `a fee of ${usd(job.feeCents)}` : `${job.qty} fees of ${usd(job.feeCents)}`;
  const processing = `processing ${usd(rc.processingCents)} at cost`;
  capture(w, job, verifiedAt, 'receipt', rc.amountCents, `receipt ${usd(rc.retailCents)} plus ${fees} plus ${processing}`, parts, rc.processingCents);
  const rel = w.reliability.get(job.queuerId);
  if (rel && w.jobs.filter((j) => j.claimId === job.claimId && j.status !== 'verified').length === 0) {
    rel.claimsCompleted += 1;
  }
}

/** Tracking added: capture #2 (shipping at cost, up to the cap); final when nothing else can capture. */
export function shipJob(w: World, jobId: string, at: MarketMs, labelCents: Cents, dutyCents: Cents, tracking: string): void {
  const job = getJob(w, jobId);
  if (job.status !== 'verified') return;
  const sc = shippingCapture(job.caps, labelCents, dutyCents);
  job.amounts.shippingCents = sc.shippingCents;
  job.shipment = { carrierName: 'Harbor Parcel Ground', trackingNumber: tracking, addedAt: at };
  pushHistory(job, 'shipped', at);
  const parts = payoutsForCapture('ship', 'shipping', {
    retailCents: job.amounts.retailCents ?? 0,
    feeCents: job.caps.feeCents,
    shippingCents: sc.shippingCents,
  });
  capture(w, job, at, 'shipping', sc.amountCents, `shipping and duty ${usd(sc.shippingCents)} plus processing ${usd(sc.processingCents)}, at cost`, parts, sc.processingCents);
}

export function feeNow(ask: AskTask, at: MarketMs): Cents {
  return askFeeAt(ask, at);
}

export function homeOf(w: World, userId: UserId): LngLat | null {
  return w.users.get(userId)?.home ?? null;
}

// ---------------------------------------------------------------------------
// Ops moves (drag to reassign on the board)
// ---------------------------------------------------------------------------

export interface ManualMove {
  bidId: string;
  fromAskId: string;
  toAskId: string;
  at: MarketMs;
}

/** The open offer a queuer has for this job's book right now, if any. */
export function targetAsk(w: World, job: Job, queuerId: UserId): AskTask | undefined {
  return w.asks.find((a) => a.queuerId === queuerId && a.shopId === job.shopId && a.itemId === job.itemId && a.status === 'open');
}

/**
 * Why a job cannot move to another queuer, in one plain sentence, or null.
 * Same checks the matcher uses: the target must stand in this shop's line-up
 * with room, be compatible with the request, and price at or under its max fee.
 */
export function moveProblem(w: World, job: Job, toQueuerId: UserId, at: MarketMs): string | null {
  if (job.queuerId === toQueuerId) return null;
  if (!JOB_BEFORE_PURCHASE.includes(job.status)) return `${job.queuerName} already bought it, so the job stays.`;
  const ask = targetAsk(w, job, toQueuerId);
  const name = nameOf(w, toQueuerId);
  if (!ask) return `${name} has no open offer at ${shopById(job.shopId).name}.`;
  if (ask.remainingCapacity < job.qty) return `${name} has room for ${ask.remainingCapacity}, the job needs ${job.qty}.`;
  const bid = getBid(w, job.bidId);
  const claim = getClaim(w, ask.claimId);
  const enRoute = claim.status === 'awaiting_arrival' || claim.status === 'arrived';
  const ok = compatible(
    { id: bid.id, requesterId: bid.requesterId, maxFeeCents: bid.maxFeeCents, remainingQty: job.qty, destination: bid.destination, deadlineAt: bid.deadlineAt, pricedAt: bid.pricedAt, matchable: true },
    { id: ask.id, queuerId: ask.queuerId, feeCents: ask.feeCents, clock: ask.clock, remainingCapacity: ask.remainingCapacity, modes: ask.modes, etaAt: ask.etaAt, windowEndsAt: enRoute ? claim.windowEndsAt : null, pricedAt: ask.pricedAt, matchable: true, targetBidId: ask.targetBidId },
    { shopCityId: shopById(job.shopId).cityId, now: at },
  );
  if (!ok) return `${name}'s offer does not fit this request (mode, ETA or deadline).`;
  const fee = askFeeAt(ask, at);
  if (fee > bid.maxFeeCents) return `${name} asks ${usd(fee)}, above ${bid.requesterName}'s max fee of ${usd(bid.maxFeeCents)}.`;
  return null;
}

/** Moves a job to another queuer's offer at that offer's current fee (the match price rule). */
export function moveJob(w: World, move: ManualMove, meta: { reason: string; ai: AiStamp } | null = null): boolean {
  const job = w.jobs.find((j) => j.bidId === move.bidId && j.askId === move.fromAskId && j.status !== 'failed');
  const target = w.asks.find((a) => a.id === move.toAskId);
  if (!job || !target || moveProblem(w, job, target.queuerId, move.at) !== null) return false;
  // As on the server (failJob, queuer side): the units go back to the request, not to the old offer.
  failJob(w, job.id, move.at, 'queuer_withdrew', `Moved by ops to ${target.queuerName}.`, { requeue: false });
  const bid = getBid(w, job.bidId);
  const fee = askFeeAt(target, move.at);
  const claim = getClaim(w, target.claimId);
  const item = itemById(job.itemId);
  const matchId = nextId(w, 'match');
  const jobId = nextId(w, 'job');
  w.matches.push({ id: matchId, shopId: job.shopId, itemId: job.itemId, bidId: bid.id, askId: target.id, jobId, qty: job.qty, feeCents: fee, at: move.at, trigger: 'requeue' });
  const moved: Job = {
    ...job,
    id: jobId,
    matchId,
    askId: target.id,
    claimId: target.claimId,
    queuerId: target.queuerId,
    queuerName: target.queuerName,
    feeCents: fee,
    status: 'claimed',
    failure: null,
    fx: item.retail.currency === 'TWD' ? { twdPerUsd: FX, lockedAt: move.at } : null,
    caps: jobCaps(bid, { qty: job.qty, feeCents: fee }),
    amounts: { retailCents: null, shippingCents: null, capturedCents: 0, refundedCents: 0, paidOutCents: 0 },
    history: [{ status: 'claimed', at: move.at }],
    createdAt: move.at,
    updatedAt: move.at,
  };
  if (claim.status === 'checked_in') pushHistory(moved, 'queueing', move.at);
  w.jobs.push(moved);
  bid.remainingQty -= job.qty;
  bid.status = bidStatusForQty(bid.qty, bid.remainingQty);
  target.remainingCapacity -= job.qty;
  if (target.remainingCapacity === 0) target.status = 'filled';
  w.notes.push({
    id: nextId(w, 'agent'),
    bidId: bid.id,
    at: move.at,
    kind: 'reassign',
    fromFeeCents: job.feeCents,
    toFeeCents: fee,
    reason: `Ops moved ${bid.requesterName}'s job from ${job.queuerName} to ${target.queuerName} at ${usd(fee)} (the offer's current fee).${meta?.reason ? ` ${meta.reason}` : ''}`,
    ai: meta?.ai ?? RULES_STAMP,
  });
  match(w, job.shopId, job.itemId, move.at, 'requeue');
  return true;
}

// ---------------------------------------------------------------------------
// The rescheduler's moves (D-101): the same four the server applies through
// POST /api/ops/moves (server/src/app/opsAgents.ts), with the same checks.
// ---------------------------------------------------------------------------

/** One approved move, replayed at its market time. `proposalId` is null for a drag. */
export interface OpsAction {
  at: MarketMs;
  proposalId: string | null;
  move: OpsMove;
  /** Why, in one sentence: what the board's notes and the server's log say. */
  reason: string;
  /** What was approved, for the closed card: "Jo will miss check-in: move to Ava at $8.00". */
  label: string;
  ai: AiStamp;
}

export const RULES_STAMP: AiStamp = { provider: 'fake', model: 'rules', mode: 'fake', latencyMs: 0 };
export const MAX_SHIFT_MINUTES = 30;

const LIVE_CLAIM = ['awaiting_arrival', 'arrived'];

/** Why the rules refuse a move now, in one plain sentence, or null. */
export function opsMoveProblem(w: World, move: OpsMove, at: MarketMs): string | null {
  if (move.kind === 'reassign') {
    const job = w.jobs.find((j) => j.id === move.jobId);
    const ask = w.asks.find((a) => a.id === move.toAskId);
    if (!job || job.status === 'failed') return 'This job is no longer on the board.';
    if (!ask) return 'That offer is gone.';
    if (ask.queuerId === job.queuerId) return `The job is already with ${job.queuerName}.`;
    const problem = moveProblem(w, job, ask.queuerId, at);
    if (problem) return problem;
    return targetAsk(w, job, ask.queuerId)?.id === ask.id ? null : `${ask.queuerName}'s offer is not open now.`;
  }
  if (move.kind === 'extend') {
    const claim = w.claims.find((c) => c.id === move.claimId);
    if (!claim || !LIVE_CLAIM.includes(claim.status)) return 'That queuer is not on the way any more.';
    if (!(move.minutes >= 1 && move.minutes <= MAX_SHIFT_MINUTES)) return `A window moves by 1 to ${MAX_SHIFT_MINUTES} minutes.`;
    const end = claim.windowEndsAt + move.minutes * MINUTE;
    if (end <= at) return 'The shifted window would already be over.';
    for (const job of w.jobs.filter((j) => j.claimId === claim.id && JOB_BEFORE_PURCHASE.includes(j.status))) {
      const bid = getBid(w, job.bidId);
      if (end > bid.deadlineAt) return `${bid.requesterName}'s request ends before the shifted window.`;
    }
    return null;
  }
  if (move.kind === 'release') {
    const claim = w.claims.find((c) => c.id === move.claimId);
    return claim && LIVE_CLAIM.includes(claim.status) ? null : 'That queuer is not on the way any more.';
  }
  const job = w.jobs.find((j) => j.id === move.jobId);
  if (!job || !JOB_BEFORE_PURCHASE.includes(job.status)) return 'This job is no longer waiting to be bought.';
  return holdUsable(w, getBid(w, job.bidId)) ? `${job.requesterName}'s hold can still pay, so the job stays.` : null;
}

/** Applies one approved move to the world at its time; false when the rules refuse it now. */
export function applyOpsMove(w: World, a: OpsAction): boolean {
  if (opsMoveProblem(w, a.move, a.at) !== null) return false;
  const m = a.move;
  if (m.kind === 'reassign') {
    const job = getJob(w, m.jobId);
    return moveJob(w, { bidId: job.bidId, fromAskId: job.askId, toAskId: m.toAskId, at: a.at }, { reason: a.reason, ai: a.ai });
  }
  if (m.kind === 'extend') {
    const claim = getClaim(w, m.claimId);
    const ask = getAsk(w, claim.askId);
    claim.windowEndsAt += m.minutes * MINUTE;
    claim.updatedAt = a.at;
    ask.etaAt += m.minutes * MINUTE;
    ask.updatedAt = a.at;
    const bids = new Set(w.jobs.filter((j) => j.claimId === claim.id && JOB_BEFORE_PURCHASE.includes(j.status)).map((j) => j.bidId));
    for (const bidId of bids) {
      w.notes.push({
        id: nextId(w, 'agent'),
        bidId,
        at: a.at,
        kind: 'note',
        fromFeeCents: null,
        toFeeCents: null,
        reason: `Ops gave ${claim.queuerName} ${m.minutes} more minutes to reach ${shopById(claim.shopId).name}: check in by ${clockOf(claim.windowEndsAt)}. ${a.reason}`.trim(),
        ai: a.ai,
      });
    }
    return true;
  }
  if (m.kind === 'release') {
    const claim = getClaim(w, m.claimId);
    const failed = lapseClaim(w, claim.id, a.at);
    noteRequeue(w, failed, a.at, `Ops released ${claim.queuerName} before the window closed at ${clockOf(claim.windowEndsAt)}`, a.ai);
    return true;
  }
  const job = getJob(w, m.jobId);
  failJob(w, job.id, a.at, 'hold_unavailable', `${job.requesterName}'s PayPal hold cannot pay; ops freed ${job.queuerName}'s units for the next requests.`, { requeue: true, freeCapacity: true });
  const taken = w.matches.filter((x) => x.askId === job.askId && x.at === a.at && x.trigger === 'requeue');
  const names = taken.map((x) => w.bids.find((b) => b.id === x.bidId)?.requesterName ?? x.bidId);
  const what = unitWord(itemById(job.itemId), job.qty).replace(/^1 /, '');
  w.notes.push({
    id: nextId(w, 'agent'),
    bidId: job.bidId,
    at: a.at,
    kind: 'reassign',
    fromFeeCents: job.feeCents,
    toFeeCents: taken[0]?.feeCents ?? null,
    reason:
      (names.length > 0
        ? `${job.requesterName}'s hold could not pay, so ${job.queuerName}'s ${what} went to ${names.join(' and ')} at ${usd(taken[0]?.feeCents ?? job.feeCents)} each (approved by ops). ${job.requesterName.split(' ')[0]} keeps the place in line once a new hold is approved.`
        : `${job.requesterName}'s hold could not pay; ${job.queuerName}'s ${what} went back to the line-up (approved by ops).`) + (a.reason ? ` ${a.reason}` : ''),
    ai: a.ai,
  });
  return true;
}
