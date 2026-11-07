import {
  ContractError,
  JOB_BEFORE_PURCHASE,
  assertTransition,
  canTransition,
  clockProblem,
  earliestEta,
  formatUsd,
  geofenceProblem,
  rangeProblem,
  travelMinutes,
} from '@holdmyspot/shared';
import type {
  AskResult,
  AskTask,
  CheckInRequest,
  CheckInResponse,
  Claim,
  ClaimDetail,
  CreateAskRequest,
  FeeClock,
  FulfilmentMode,
  Item,
  Job,
  PositionReport,
  Proof,
  Shop,
  User,
  WithdrawAskResponse,
} from '@holdmyspot/shared';
import type { CheckInPhotoResult } from '../ports/ai.ts';
import { withTimeout } from '../util/serial.ts';
import type { App, Viewer } from './app.ts';
import { bumpReliability, itemById, itemOrThrow, requireRole } from './catalog.ts';
import { duplicateOf, ownFile, photoInput, priorPhotos } from './files.ts';
import { failJob } from './jobs.ts';
import { bookState, emitBook, runBook, setJobStatus } from './market.ts';
import { reconcileBid } from './money.ts';
import { emitAsk, emitClaim, emitProof, viewClaim, viewJob } from './views.ts';

/** Queuer commands: offers (asks) bound to a place and time, claims, check-in, lapses. */

const LIVE_CLAIM: readonly Claim['status'][] = ['awaiting_arrival', 'arrived', 'checked_in'];

/** The location, reliability and store-limit rules for posting an ask or claiming a bid. */
export function assertQueuerMayOffer(
  app: App,
  u: User,
  shop: Shop,
  item: Item,
  o: { capacity: number; modes: FulfilmentMode[]; etaAt: number; from: PositionReport },
): void {
  requireRole(u, 'queuer');
  const score = u.reliability?.score ?? 0;
  if (score < app.rules.reliabilityFloor) {
    throw new ContractError('RELIABILITY_TOO_LOW', `Reliability ${score} is below ${app.rules.reliabilityFloor}.`, { score });
  }
  if (o.modes.length === 0 || o.modes.some((m) => !item.modes.includes(m))) {
    throw new ContractError('MODE_NOT_ALLOWED', `${item.shortName} at ${shop.name} is ${item.modes.join(' or ')} only.`, { modes: item.modes });
  }
  if (!Number.isInteger(o.capacity) || o.capacity < 1) throw new ContractError('BAD_REQUEST', 'Capacity must be a positive whole number.');
  if (o.capacity > item.perPersonLimit) {
    throw new ContractError('OVER_STORE_LIMIT', `${shop.name} sells at most ${item.perPersonLimit} per person.`, { limit: item.perPersonLimit });
  }
  const range = rangeProblem(o.from, shop.lngLat, app.rules);
  if (range === 'GPS_TOO_COARSE') throw new ContractError('GPS_TOO_COARSE', 'Your location is too rough to tell how far you are.');
  if (range === 'OUT_OF_RANGE') {
    throw new ContractError('OUT_OF_RANGE', `${shop.name} is more than ${app.rules.maxTravelMinutes} minutes away.`, {
      travelMinutes: travelMinutes(o.from.lngLat, shop.lngLat, app.rules),
    });
  }
  const now = app.now();
  const earliest = earliestEta(o.from.lngLat, shop.lngLat, now, app.rules);
  const latest = earliest + app.rules.maxTravelMinutes * 60_000;
  if (o.etaAt < earliest) throw new ContractError('BAD_REQUEST', 'That ETA is earlier than you can get there.', { earliestEtaAt: earliest });
  if (o.etaAt > latest) throw new ContractError('BAD_REQUEST', `Your ETA must be within ${app.rules.maxTravelMinutes} minutes of the earliest arrival.`, { latestEtaAt: latest });
  for (const ask of app.store.asks.where('queuer_id = ? AND shop_id = ?', u.id, shop.id)) {
    const claim = app.store.claims.get(ask.claimId);
    if (claim && LIVE_CLAIM.includes(claim.status)) throw new ContractError('CONFLICT', `You already have an active visit at ${shop.name}.`, { askId: ask.id });
  }
}

/** Creates an ask and its claim (inside app.tx). */
export function createClaimAsk(
  app: App,
  u: User,
  shop: Shop,
  item: Item,
  o: { capacity: number; modes: FulfilmentMode[]; feeCents: number; clock: FeeClock | null; etaAt: number; origin: 'post' | 'claim'; targetBidId: string | null },
): { ask: AskTask; claim: Claim } {
  const now = app.now();
  const askId = app.nextId('ask');
  const claimId = app.nextId('clm');
  const ask: AskTask = {
    id: askId,
    queuerId: u.id,
    queuerName: u.displayName,
    shopId: shop.id,
    itemId: item.id,
    claimId,
    origin: o.origin,
    targetBidId: o.targetBidId,
    capacity: o.capacity,
    remainingCapacity: o.capacity,
    modes: o.modes,
    feeCents: o.feeCents,
    clock: o.clock,
    etaAt: o.etaAt,
    status: 'open',
    createdAt: now,
    pricedAt: now,
    updatedAt: now,
  };
  const claim: Claim = {
    id: claimId,
    askId,
    queuerId: u.id,
    queuerName: u.displayName,
    shopId: shop.id,
    windowStartsAt: now,
    windowEndsAt: o.etaAt + app.rules.arrivalGraceMinutes * 60_000,
    status: 'awaiting_arrival',
    checkInCode: app.code('checkin', claimId, `${u.id}@${shop.id}`),
    arrival: null,
    linePhotoProofId: null,
    checkedInAt: null,
    createdAt: now,
    updatedAt: now,
  };
  app.store.asks.insert(ask);
  app.store.claims.insert(claim);
  emitAsk(app, ask);
  emitClaim(app, claim);
  return { ask, claim };
}

export function createAsk(app: App, u: User, req: CreateAskRequest): AskResult {
  const { shop, item } = itemOrThrow(req.shopId, req.itemId);
  assertQueuerMayOffer(app, u, shop, item, req);
  if (!Number.isInteger(req.feeCents) || req.feeCents < item.minFeeCents) {
    throw new ContractError('FEE_BELOW_MINIMUM', `The fee must be at least ${formatUsd(item.minFeeCents, { exact: true })} per unit.`, { minFeeCents: item.minFeeCents });
  }
  let clock: FeeClock | null = null;
  if (req.clock) {
    const problem = clockProblem(req.feeCents, req.clock);
    if (problem) throw new ContractError('BAD_REQUEST', problem);
    if (req.clock.floorCents < item.minFeeCents) {
      throw new ContractError('FEE_BELOW_MINIMUM', `The clock floor must be at least ${formatUsd(item.minFeeCents, { exact: true })}.`, { minFeeCents: item.minFeeCents });
    }
    clock = { stepCents: req.clock.stepCents, intervalMs: req.clock.intervalMs, floorCents: req.clock.floorCents, startsAt: null };
  }
  if (bookState(app, item.id).status !== 'open') throw new ContractError('SOLD_OUT', `${item.shortName} is sold out at ${shop.name}.`);
  return app.tx(() => {
    const { ask, claim } = createClaimAsk(app, u, shop, item, {
      capacity: req.capacity,
      modes: req.modes,
      feeCents: req.feeCents,
      clock,
      etaAt: req.etaAt,
      origin: 'post',
      targetBidId: null,
    });
    const matches = runBook(app, item.id, 'new_ask');
    emitBook(app, item.id);
    return { ask: app.store.asks.must(ask.id), claim: app.store.claims.must(claim.id), matches };
  });
}

function ownClaim(app: App, u: User, claimId: string): Claim {
  const claim = app.store.claims.must(claimId, 'claim');
  if (claim.queuerId !== u.id) throw new ContractError('FORBIDDEN', 'This is not your visit.');
  return claim;
}

export function withdrawAsk(app: App, u: User, askId: string): WithdrawAskResponse {
  const ask = app.store.asks.must(askId, 'ask');
  if (ask.queuerId !== u.id) throw new ContractError('FORBIDDEN', 'This is not your offer.');
  return app.tx(() => {
    const a = app.store.asks.must(ask.id);
    assertTransition('ask', a.status, 'withdrawn');
    a.status = 'withdrawn';
    a.updatedAt = app.now();
    app.store.asks.update(a);
    emitAsk(app, a);
    const claim = app.store.claims.must(a.claimId);
    const jobs = app.store.jobs.where('ask_id = ?', a.id);
    if (jobs.length === 0) {
      const to = claim.status === 'checked_in' ? 'done' : 'cancelled';
      if (canTransition('claim', claim.status, to)) setClaimStatus(app, claim, to);
    } else {
      // Matched jobs stay; withdrawing after a match counts against reliability.
      bumpReliability(app, u.id, 'claimsLapsed');
    }
    emitBook(app, a.itemId);
    return { ask: a, claim: app.store.claims.must(claim.id), jobs: jobs.map((j) => viewJob(j, { userId: u.id, ops: false })) };
  });
}

function setClaimStatus(app: App, claim: Claim, to: Claim['status']): Claim {
  assertTransition('claim', claim.status, to);
  claim.status = to;
  claim.updatedAt = app.now();
  app.store.claims.update(claim);
  emitClaim(app, claim);
  return claim;
}

/** Closes the visit once every unit is bought and no capacity is left (inside app.tx). */
export function maybeFinishClaim(app: App, claimId: string): void {
  const claim = app.store.claims.get(claimId);
  if (!claim || claim.status !== 'checked_in') return;
  const ask = app.store.asks.must(claim.askId);
  if (ask.status === 'open') return;
  const jobs = app.store.jobs.where('claim_id = ?', claim.id);
  if (jobs.some((j) => JOB_BEFORE_PURCHASE.includes(j.status))) return;
  setClaimStatus(app, claim, 'done');
  if (canTransition('ask', ask.status, 'closed')) {
    ask.status = 'closed';
    ask.updatedAt = app.now();
    app.store.asks.update(ask);
    emitAsk(app, ask);
  }
  bumpReliability(app, claim.queuerId, 'claimsCompleted');
  emitBook(app, ask.itemId);
}

/** The queuer ends the visit: remaining capacity closes and unbought jobs go back to the book. */
export async function claimDone(app: App, u: User, claimId: string): Promise<ClaimDetail> {
  const claim = ownClaim(app, u, claimId);
  if (claim.status !== 'checked_in') throw new ContractError('INVALID_TRANSITION', 'Only a checked-in visit can be ended.');
  const bidIds = app.tx(() => {
    const c = app.store.claims.must(claim.id);
    const ask = app.store.asks.must(c.askId);
    const bids = new Set<string>();
    for (const job of app.store.jobs.where('claim_id = ?', c.id)) {
      if (JOB_BEFORE_PURCHASE.includes(job.status)) {
        failJob(app, job, 'queuer_withdrew', `${c.queuerName} ended the visit before buying.`);
        bids.add(job.bidId);
      }
    }
    setClaimStatus(app, c, 'done');
    if (canTransition('ask', ask.status, 'closed')) {
      ask.status = 'closed';
      ask.updatedAt = app.now();
      app.store.asks.update(ask);
      emitAsk(app, ask);
    }
    bumpReliability(app, c.queuerId, 'claimsCompleted');
    runBook(app, ask.itemId, 'requeue');
    emitBook(app, ask.itemId);
    return [...bids];
  });
  for (const id of bidIds) await reconcileBid(app, id);
  return claimDetail(app, { userId: u.id, ops: false }, claim.id);
}

export function claimDetail(app: App, viewer: Viewer, claimId: string): ClaimDetail {
  const claim = app.store.claims.must(claimId, 'claim');
  const jobs = app.store.jobs.where('claim_id = ?', claim.id);
  const participant = viewer.ops || viewer.userId === claim.queuerId || jobs.some((j) => j.requesterId === viewer.userId);
  if (!participant) throw new ContractError('FORBIDDEN', 'Only the queuer, their requesters and ops can see this visit.');
  return {
    claim: viewClaim(claim, viewer),
    ask: app.store.asks.must(claim.askId),
    jobs: jobs.filter((j) => viewer.ops || viewer.userId === j.queuerId || viewer.userId === j.requesterId).map((j) => viewJob(j, viewer)),
  };
}

// ---- check-in ------------------------------------------------------------------

export function checkIn(app: App, u: User, claimId: string, req: CheckInRequest): CheckInResponse {
  const claim = ownClaim(app, u, claimId);
  if (claim.status !== 'awaiting_arrival' && claim.status !== 'arrived') {
    throw new ContractError('INVALID_TRANSITION', `This visit is ${claim.status}.`);
  }
  const now = app.now();
  if (now > claim.windowEndsAt) throw new ContractError('WINDOW_CLOSED', 'The arrival window has ended.', { windowEndsAt: claim.windowEndsAt });
  const ask = app.store.asks.must(claim.askId);
  const { shop } = itemById(ask.itemId);
  const fence = geofenceProblem(req, shop, app.rules);
  if (fence.problem === 'GPS_TOO_COARSE') throw new ContractError('GPS_TOO_COARSE', `GPS accuracy must be ${app.rules.maxGpsAccuracyMeters} m or better.`);
  if (fence.problem === 'OUTSIDE_GEOFENCE') {
    throw new ContractError('OUTSIDE_GEOFENCE', `You are ${fence.distanceM} m from ${shop.name}; check in within ${shop.geofenceMeters} m.`, { distanceM: fence.distanceM });
  }
  const pending = app.store.proofs.first("claim_id = ? AND kind = 'check_in' AND status IN ('verifying', 'needs_review')", claim.id);
  if (pending) throw new ContractError('CONFLICT', 'A line photo for this visit is still being checked.', { proofId: pending.id });
  const file = ownFile(app, u.id, req.photoFileId, 'line_photo', { claimId: claim.id });

  const out = app.tx(() => {
    const c = app.store.claims.must(claim.id);
    c.arrival = { at: now, lngLat: req.lngLat, accuracyM: req.accuracyM, distanceM: fence.distanceM };
    if (c.status === 'awaiting_arrival') c.status = 'arrived';
    c.updatedAt = now;
    app.store.claims.update(c);
    emitClaim(app, c);
    const f = app.store.files.must(file.id);
    f.claimId = c.id;
    app.store.files.update(f);
    for (const job of app.store.jobs.where("claim_id = ? AND status = 'claimed'", c.id)) setJobStatus(app, job, 'checked_in');
    const proof: Proof = {
      id: app.nextId('prf'),
      kind: 'check_in',
      claimId: c.id,
      jobId: null,
      fileIds: [file.id],
      status: 'verifying',
      checks: [],
      receipt: null,
      amounts: null,
      peopleAhead: null,
      summary: 'Checking the line photo.',
      ai: { ...app.ai.info, latencyMs: 0 },
      decidedBy: null,
      createdAt: now,
      decidedAt: null,
    };
    app.store.proofs.insert(proof);
    emitProof(app, proof);
    emitBook(app, ask.itemId);
    return { claim: c, proof, jobs: app.store.jobs.where('claim_id = ?', c.id) };
  });
  app.background(`check-in ${out.proof.id}`, () => verifyCheckIn(app, out.proof.id));
  return { claim: out.claim, proof: out.proof, jobs: out.jobs.map((j) => viewJob(j, { userId: u.id, ops: false })) };
}

async function runAi<T>(app: App, what: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await app.aiQueue.run(() =>
        withTimeout(fn(), app.config.ai.timeoutMs, () => new ContractError('AI_UNAVAILABLE', `${what} timed out.`)),
      );
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

async function verifyCheckIn(app: App, proofId: string): Promise<void> {
  const proof = app.store.proofs.must(proofId);
  const claim = app.store.claims.must(proof.claimId!);
  const ask = app.store.asks.must(claim.askId);
  const { shop, item } = itemById(ask.itemId);
  const file = app.store.files.must(proof.fileIds[0]!);
  const photo = photoInput(file);
  const prior = priorPhotos(app, { claimId: claim.id, before: file.createdAt });
  const fenceOk = claim.arrival !== null && claim.arrival.distanceM <= shop.geofenceMeters;
  let verdict: CheckInPhotoResult;
  try {
    verdict = await runAi(app, 'The line photo check', () =>
      app.ai.checkInPhoto({
        claim,
        shop,
        item,
        photo,
        geofence: { ok: fenceOk, distanceM: claim.arrival?.distanceM ?? -1, radiusM: shop.geofenceMeters },
        duplicateOf: duplicateOf(photo, prior),
        priorPhotos: prior,
        now: app.now(),
      }),
    );
  } catch (err) {
    verdict = {
      status: 'needs_review',
      checks: [],
      peopleAhead: null,
      summary: `The AI check was not available (${err instanceof Error ? err.message : 'error'}); a person will review the photo.`,
      ai: { ...app.ai.info, latencyMs: 0 },
    };
  }
  // The lapse voids holds at PayPal, so it runs inside the command queue like every other money step.
  await app.exec(async () => {
    const lapsed = applyCheckInVerdict(app, proofId, verdict, 'ai_rules');
    if (lapsed) await lapseClaim(app, lapsed);
  });
}

/** Records a line-photo verdict. Passed: checked in, fee clock starts. Returns a claim id to lapse, if any. */
export function applyCheckInVerdict(
  app: App,
  proofId: string,
  verdict: Pick<CheckInPhotoResult, 'status' | 'checks' | 'peopleAhead' | 'summary' | 'ai'>,
  decidedBy: 'ai_rules' | 'ops',
): string | null {
  return app.tx(() => {
    const proof = app.store.proofs.must(proofId);
    const now = app.now();
    if (proof.status !== 'verifying' && proof.status !== 'needs_review') return null;
    assertTransition('proof', proof.status, verdict.status);
    proof.status = verdict.status;
    if (verdict.checks.length > 0) proof.checks = verdict.checks;
    proof.peopleAhead = verdict.peopleAhead;
    proof.summary = verdict.summary;
    proof.ai = verdict.ai;
    proof.decidedBy = verdict.status === 'needs_review' ? null : decidedBy;
    proof.decidedAt = verdict.status === 'needs_review' ? null : now;
    app.store.proofs.update(proof);
    emitProof(app, proof);
    const claim = app.store.claims.must(proof.claimId!);
    const ask = app.store.asks.must(claim.askId);
    if (verdict.status === 'passed' && (claim.status === 'arrived' || claim.status === 'awaiting_arrival')) {
      claim.status = 'checked_in';
      claim.checkedInAt = now;
      claim.linePhotoProofId = proof.id;
      claim.updatedAt = now;
      app.store.claims.update(claim);
      emitClaim(app, claim);
      if (ask.clock && ask.clock.startsAt === null) {
        ask.clock = { ...ask.clock, startsAt: now };
        ask.updatedAt = now;
        app.store.asks.update(ask);
        emitAsk(app, ask);
        const book = bookState(app, ask.itemId);
        book.lastClockRunAt = now;
        app.store.books.update(book);
      }
      for (const job of app.store.jobs.where('claim_id = ?', claim.id)) {
        if (job.status === 'claimed' || job.status === 'checked_in') setJobStatus(app, job, 'queueing');
      }
      emitBook(app, ask.itemId);
      return null;
    }
    if (verdict.status === 'failed' && now > claim.windowEndsAt && claim.status !== 'checked_in') return claim.id;
    return null;
  });
}

/** No check-in before the window ended: jobs not yet bought fail and go back to the book. */
export async function lapseClaim(app: App, claimId: string): Promise<string[]> {
  const bidIds = app.tx(() => {
    const claim = app.store.claims.must(claimId);
    if (claim.status !== 'awaiting_arrival' && claim.status !== 'arrived') return [];
    setClaimStatus(app, claim, 'lapsed');
    const ask = app.store.asks.must(claim.askId);
    if (canTransition('ask', ask.status, 'lapsed')) {
      ask.status = 'lapsed';
      ask.updatedAt = app.now();
      app.store.asks.update(ask);
      emitAsk(app, ask);
    }
    const bids = new Set<string>();
    for (const job of app.store.jobs.where('claim_id = ?', claim.id)) {
      if (JOB_BEFORE_PURCHASE.includes(job.status)) {
        failJob(app, job, 'no_show', `${claim.queuerName} did not check in before the window ended.`);
        bids.add(job.bidId);
      }
    }
    bumpReliability(app, claim.queuerId, 'claimsLapsed');
    runBook(app, ask.itemId, 'requeue');
    emitBook(app, ask.itemId);
    return [...bids];
  });
  for (const id of bidIds) await reconcileBid(app, id);
  return bidIds;
}

/** Claims whose window ended while waiting for a photo verdict are lapsed later, not now. */
export function claimHasPendingPhoto(app: App, claimId: string): boolean {
  return app.store.proofs.count("claim_id = ? AND kind = 'check_in' AND status IN ('verifying', 'needs_review')", claimId) > 0;
}

export type { Job };
