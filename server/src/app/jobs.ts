import {
  ContractError,
  JOB_BEFORE_PURCHASE,
  assertTransition,
  bidStatusForQty,
  canTransition,
  isTerminal,
  receiptCapture,
  shippingCapture,
} from '@holdmyspot/shared';
import type {
  AddShipmentRequest,
  BookSnapshot,
  Job,
  JobDetail,
  JobFailureReason,
  JobMoneyResult,
  LedgerEntry,
  Proof,
  ProofCheck,
  ReviewProofRequest,
  SubmitProofRequest,
  User,
} from '@holdmyspot/shared';
import type { PurchaseProofResult } from '../ports/ai.ts';
import { withTimeout } from '../util/serial.ts';
import type { App, Viewer } from './app.ts';
import { applyCheckInVerdict, lapseClaim, maybeFinishClaim } from './asks.ts';
import { bumpReliability, itemById } from './catalog.ts';
import { duplicateOf, ownFile, photoInput, priorPhotos } from './files.ts';
import { LIVE_BID_STATUSES, bookSnapshot, bookState, emitBook, runBook, setJobStatus } from './market.ts';
import { adapterOf, captureEntries, captureForJob, liveCaptureRequest, payoutsAfterCapture, reconcileBid, refundJob } from './money.ts';
import type { CaptureOutcome } from './money.ts';
import { emitAsk, emitBid, emitProof, viewJob } from './views.ts';

/** Job lifecycle: purchase, proof, captures at the receipt / tracking / handover, failures and re-offers. */

const QUEUER_SIDE: readonly JobFailureReason[] = ['no_show', 'proof_rejected', 'queuer_withdrew'];
const REQUESTER_SIDE: readonly JobFailureReason[] = ['requester_cancelled', 'hold_unavailable'];

/** PayPal answered the capture and refused it (not an outage: nothing is in flight). */
const declined = (out: CaptureOutcome) => !out.completed && out.entry.status === 'failed';

/** Wrong handover codes allowed per job in one window, so the 4-digit code cannot be guessed through the API. */
export const HANDOVER_MAX_MISSES = 5;
export const HANDOVER_LOCK_MS = 60 * 60_000;
/**
 * Wrong handover codes allowed per job in all, whatever the windows (D-148). After that the code no
 * longer works and the handover waits for a person, so a queuer holding the item can try at most 10
 * of the 10,000 codes: a 0.1% chance, against about 120 codes a day with the hourly window alone.
 */
export const HANDOVER_MAX_TOTAL_MISSES = 10;

/** Every wrong code's time for this job (`all`) and those inside the current window (`recent`). */
function handoverMisses(app: App, jobId: string): { all: number[]; recent: number[] } {
  const raw = app.db.getMeta(`handover-misses:${jobId}`);
  const all = raw ? (JSON.parse(raw) as number[]) : [];
  const since = app.now() - HANDOVER_LOCK_MS;
  return { all, recent: all.filter((t) => t > since) };
}

/**
 * Fails a job (inside app.tx). Before purchase, a queuer-side failure gives
 * the quantity back to the bid (re-offered); a requester-side failure gives
 * the capacity back to the ask. The caller runs matching and reconciles the bid.
 * `reoffer` gives the quantity back for another reason too (one queuer's unconfirmed sell-out report, D-152).
 */
export function failJob(app: App, job: Job, reason: JobFailureReason, detail: string, opts: { reoffer?: boolean } = {}): void {
  const was = job.status;
  const now = app.now();
  job.failure = { reason, at: now, detail };
  setJobStatus(app, job, 'failed');
  const bid = app.store.bids.must(job.bidId);
  const beforePurchase = JOB_BEFORE_PURCHASE.includes(was) || (reason === 'proof_rejected' && was === 'proof_submitted');
  if (
    (QUEUER_SIDE.includes(reason) || opts.reoffer === true) &&
    beforePurchase &&
    bid.closeReason === null &&
    LIVE_BID_STATUSES.includes(bid.status) &&
    now <= bid.deadlineAt &&
    bookState(app, bid.itemId).status === 'open'
  ) {
    bid.remainingQty += job.qty;
    const next = bidStatusForQty(bid.qty, bid.remainingQty);
    if (next !== bid.status) {
      assertTransition('bid', bid.status, next);
      bid.status = next;
    }
    bid.updatedAt = now;
    app.store.bids.update(bid);
    emitBid(app, bid);
  }
  if (REQUESTER_SIDE.includes(reason) && JOB_BEFORE_PURCHASE.includes(was)) {
    const ask = app.store.asks.must(job.askId);
    const claim = app.store.claims.get(ask.claimId);
    if (claim && ['awaiting_arrival', 'arrived', 'checked_in'].includes(claim.status) && (ask.status === 'open' || ask.status === 'filled')) {
      ask.remainingCapacity += job.qty;
      if (ask.status === 'filled') ask.status = 'open';
      ask.updatedAt = now;
      app.store.asks.update(ask);
      emitAsk(app, ask);
    }
  }
  if (reason === 'proof_rejected') bumpReliability(app, job.queuerId, 'proofsRejected');
  maybeFinishClaim(app, job.claimId);
}

function ownJobAsQueuer(app: App, u: User, jobId: string): Job {
  const job = app.store.jobs.must(jobId, 'job');
  if (job.queuerId !== u.id) throw new ContractError('FORBIDDEN', 'Only the queuer on this job can do that.');
  return job;
}

export function markBought(app: App, u: User, jobId: string): { job: Job } {
  const job = ownJobAsQueuer(app, u, jobId);
  return app.tx(() => {
    const j = app.store.jobs.must(job.id);
    if (j.status !== 'queueing') throw new ContractError('INVALID_TRANSITION', `The job is ${j.status}; buy once you are in the line (checked in).`);
    setJobStatus(app, j, 'bought');
    maybeFinishClaim(app, j.claimId);
    return { job: viewJob(app.store.jobs.must(j.id), { userId: u.id, ops: false }) };
  });
}

export function submitProof(app: App, u: User, jobId: string, req: SubmitProofRequest): { job: Job; proof: Proof } {
  const job = ownJobAsQueuer(app, u, jobId);
  if (job.status !== 'queueing' && job.status !== 'bought') throw new ContractError('INVALID_TRANSITION', `The job is ${job.status}.`);
  const receipt = ownFile(app, u.id, req.receiptFileId, 'receipt', { jobId: job.id });
  const itemPhoto = ownFile(app, u.id, req.itemFileId, 'item_photo', { jobId: job.id });
  const out = app.tx(() => {
    const j = app.store.jobs.must(job.id);
    setJobStatus(app, j, 'proof_submitted');
    for (const f of [receipt, itemPhoto]) {
      const row = app.store.files.must(f.id);
      row.jobId = j.id;
      app.store.files.update(row);
    }
    const now = app.now();
    const proof: Proof = {
      id: app.nextId('prf'),
      kind: 'purchase',
      claimId: j.claimId,
      jobId: j.id,
      fileIds: [receipt.id, itemPhoto.id],
      status: 'verifying',
      checks: [],
      receipt: null,
      amounts: null,
      peopleAhead: null,
      summary: 'Checking the receipt and the item photo.',
      ai: { ...app.ai.info, latencyMs: 0 },
      decidedBy: null,
      createdAt: now,
      decidedAt: null,
    };
    app.store.proofs.insert(proof);
    emitProof(app, proof);
    maybeFinishClaim(app, j.claimId);
    return { job: app.store.jobs.must(j.id), proof };
  });
  app.background(`proof ${out.proof.id}`, () => verifyPurchase(app, out.proof.id));
  return { job: viewJob(out.job, { userId: u.id, ops: false }), proof: out.proof };
}

async function verifyPurchase(app: App, proofId: string): Promise<void> {
  const proof = app.store.proofs.must(proofId);
  const job = app.store.jobs.must(proof.jobId!);
  const claim = app.store.claims.must(job.claimId);
  const { shop, item } = itemById(job.itemId);
  const receipt = photoInput(app.store.files.must(proof.fileIds[0]!));
  const itemPhoto = photoInput(app.store.files.must(proof.fileIds[1]!));
  const prior = priorPhotos(app, { jobId: job.id, before: proof.createdAt });
  const dup = duplicateOf(itemPhoto, prior) ?? duplicateOf(receipt, prior);
  let verdict: PurchaseProofResult;
  try {
    let lastErr: unknown = null;
    let result: PurchaseProofResult | null = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try {
        result = await app.aiQueue.run(() =>
          withTimeout(
            app.ai.purchaseProof({
              job,
              claim,
              shop,
              item,
              receipt,
              itemPhoto,
              checkedInAt: claim.checkedInAt,
              uploadedAt: proof.createdAt,
              duplicateOf: dup,
              priorPhotos: prior,
              now: app.now(),
            }),
            app.config.ai.timeoutMs,
            () => new ContractError('AI_UNAVAILABLE', 'The receipt check timed out.'),
          ),
        );
      } catch (err) {
        lastErr = err;
      }
    }
    if (!result) throw lastErr ?? new Error('no result');
    verdict = result;
  } catch (err) {
    verdict = {
      status: 'needs_review',
      checks: [],
      receipt: { printedName: null, sellerTaxId: null, invoiceNumber: null, issuedAt: null, currency: null, lines: [], total: null, qr: null, codeSeen: null },
      receiptTotal: null,
      retailCents: null,
      summary: `The AI check was not available (${err instanceof Error ? err.message : 'error'}); a person will review the receipt.`,
      ai: { ...app.ai.info, latencyMs: 0 },
    };
  }
  await app.exec(() => decidePurchase(app, proofId, verdict, 'ai_rules'));
}

/** Records a purchase verdict and runs what follows: capture and payout, or failure and re-offer. */
export async function decidePurchase(
  app: App,
  proofId: string,
  verdict: Pick<PurchaseProofResult, 'status' | 'checks' | 'receipt' | 'receiptTotal' | 'retailCents' | 'summary' | 'ai'>,
  decidedBy: 'ai_rules' | 'ops',
): Promise<LedgerEntry[]> {
  const outcome = app.tx(() => {
    const proof = app.store.proofs.must(proofId);
    if (proof.status !== 'verifying' && proof.status !== 'needs_review') return null;
    const job = app.store.jobs.must(proof.jobId!);
    const now = app.now();
    const retail = verdict.retailCents;
    const capture = retail === null ? null : receiptCapture(job.caps, retail, job.mode);
    assertTransition('proof', proof.status, verdict.status);
    proof.status = verdict.status;
    if (verdict.checks.length > 0) proof.checks = verdict.checks;
    proof.receipt = verdict.receipt;
    proof.amounts = {
      receiptTotal: verdict.receiptTotal,
      fxTwdPerUsd: job.fx?.twdPerUsd ?? null,
      retailCents: retail,
      captureCents: capture?.amountCents ?? null,
      processingCents: capture?.processingCents ?? null,
    };
    proof.summary = verdict.summary;
    proof.ai = verdict.ai;
    proof.decidedBy = verdict.status === 'needs_review' ? null : decidedBy;
    proof.decidedAt = verdict.status === 'needs_review' ? null : now;
    app.store.proofs.update(proof);
    emitProof(app, proof);
    if (verdict.status === 'passed') {
      if (job.status !== 'proof_submitted') return null;
      job.amounts = { ...job.amounts, retailCents: capture?.retailCents ?? 0 };
      setJobStatus(app, job, 'verified');
      return { kind: 'passed' as const, job };
    }
    if (verdict.status === 'failed' && job.status === 'proof_submitted') {
      failJob(app, job, 'proof_rejected', verdict.summary);
      runBook(app, job.itemId, 'requeue');
      emitBook(app, job.itemId);
      return { kind: 'failed' as const, job };
    }
    return null;
  });
  if (!outcome) return [];
  if (outcome.kind === 'failed') {
    await reconcileBid(app, outcome.job.bidId);
    return [];
  }
  if (outcome.job.mode === 'ship') return captureReceiptAndPay(app, outcome.job.id);
  return [];
}

/** Ship mode, capture #1: retail at cost (capped), the matched fee and processing at cost, then the fee payout. */
async function captureReceiptAndPay(app: App, jobId: string): Promise<LedgerEntry[]> {
  const job = app.store.jobs.must(jobId);
  const cap = receiptCapture(job.caps, job.amounts.retailCents ?? 0, job.mode);
  const parts = { retailCents: cap.retailCents, feeCents: cap.feeCents, shippingCents: 0, processingCents: cap.processingCents, captureFeeCents: cap.captureFeeCents, payoutFeesCents: cap.payoutFeesCents };
  try {
    const out = await captureForJob(app, jobId, 'receipt', cap.amountCents, parts);
    const ledger = [...out.entries];
    if (declined(out)) {
      // PayPal refused the charge: the job cannot be paid, so it ends now instead of waiting as verified.
      app.tx(() => {
        const j = app.store.jobs.must(jobId);
        if (canTransition('job', j.status, 'failed')) failJob(app, j, 'payment_failed', 'PayPal declined the charge for the receipt.');
      });
      await reconcileBid(app, job.bidId);
      return ledger;
    }
    if (out.completed) ledger.push(...(await payoutsAfterCapture(app, jobId, 'receipt', parts)));
    return ledger;
  } catch (err) {
    app.log(`receipt capture for ${jobId} failed: ${err instanceof Error ? err.message : String(err)}`);
    // An outage leaves the ledger entry pending; the sweeper resends it with the same idempotency key.
    if (err instanceof ContractError && err.code === 'PAYPAL_UNAVAILABLE') return [];
    app.tx(() => {
      const j = app.store.jobs.must(jobId);
      if (canTransition('job', j.status, 'failed')) failJob(app, j, 'payment_failed', err instanceof Error ? err.message : 'The capture failed.');
    });
    await reconcileBid(app, job.bidId);
    return [];
  }
}

export async function addShipment(app: App, u: User, jobId: string, req: AddShipmentRequest): Promise<JobMoneyResult> {
  const job = ownJobAsQueuer(app, u, jobId);
  if (job.mode !== 'ship') throw new ContractError('MODE_NOT_ALLOWED', 'This job is a local errand; use the handover code.');
  if (job.status !== 'verified') throw new ContractError('INVALID_TRANSITION', `The job is ${job.status}; add tracking after the receipt is verified.`);
  if (!req.carrierName.trim() || !req.trackingNumber.trim()) throw new ContractError('BAD_REQUEST', 'Carrier name and tracking number are required.');
  const receiptCap = captureEntries(app, job.id).find((e) => e.idempotencyKey.startsWith(`cap:${job.id}:receipt`));
  if (!receiptCap?.paypal?.captureId) throw new ContractError('CONFLICT', 'The receipt capture is not complete yet.');
  if (req.labelFileId) ownFile(app, u.id, req.labelFileId, 'label', { jobId: job.id });
  const bid = app.store.bids.must(job.bidId);
  const hold = app.store.holds.must(bid.holdId!);
  const ship = shippingCapture(job.caps, req.shippingCostCents, req.dutyPaidCents);

  if (!job.shipment) {
    try {
      await app.payments(adapterOf(hold)).addTracking(bid.paypalOrderId!, {
        // Same number, same key (a safe retry); a corrected number is a new request.
        requestId: `track:${job.id}:${req.trackingNumber.trim()}`,
        captureId: receiptCap.paypal.captureId,
        trackingNumber: req.trackingNumber.trim(),
        carrierName: req.carrierName.trim(),
        notifyPayer: true,
      });
    } catch (err) {
      const f = (err as { failure?: { code?: string; debugId?: string | null } }).failure;
      const e = new ContractError(f?.code === 'PAYPAL_UNAVAILABLE' ? 'PAYPAL_UNAVAILABLE' : 'PAYPAL_ERROR', 'PayPal did not accept the tracking number.');
      (e as ContractError & { paypalDebugId?: string }).paypalDebugId = f?.debugId ?? undefined;
      throw e;
    }
    app.tx(() => {
      const j = app.store.jobs.must(job.id);
      j.shipment = { carrierName: req.carrierName.trim(), trackingNumber: req.trackingNumber.trim(), addedAt: app.now() };
      if (req.labelFileId) {
        const f = app.store.files.must(req.labelFileId);
        f.jobId = j.id;
        app.store.files.update(f);
      }
      j.updatedAt = app.now();
      app.store.jobs.update(j);
    });
  }

  const ledger: LedgerEntry[] = [];
  let completed = true;
  // A shipping capture already sent (a retry after an outage) keeps its own amount: the payout
  // and the job follow what PayPal was asked to charge, never a new number from the retry.
  const sent = liveCaptureRequest(app, job.id, 'shipping');
  let shippingCents = sent ? sent.parts.shippingCents : ship.shippingCents;
  if (shippingCents > 0) {
    // Shipping as the queuer declared it (capped) plus this capture's own PayPal fee at cost (D-105); a resend keeps what was sent.
    const out = await captureForJob(
      app,
      job.id,
      'shipping',
      sent ? sent.amountCents : ship.amountCents,
      {
        retailCents: job.amounts.retailCents ?? 0,
        feeCents: 0,
        shippingCents,
        processingCents: ship.processingCents,
        captureFeeCents: ship.captureFeeCents,
        payoutFeesCents: ship.payoutFeesCents,
      },
      sent ? 0 : Math.min(req.dutyPaidCents, shippingCents),
    );
    ledger.push(...out.entries);
    if (out.request) shippingCents = out.request.parts.shippingCents;
    completed = out.completed;
    if (declined(out)) {
      // PayPal refused the shipping charge: nothing was taken for shipping, but the shop price was
      // charged with the receipt, so the queuer is still paid that back.
      app.log(`shipping capture for ${job.id} was declined; reimbursing the shop price only`);
      shippingCents = 0;
      completed = true;
    }
  }
  app.tx(() => {
    const j = app.store.jobs.must(job.id);
    j.amounts = { ...j.amounts, shippingCents };
    app.store.jobs.update(j);
    if (j.status === 'verified') setJobStatus(app, j, 'shipped');
  });
  if (completed) {
    ledger.push(...(await payoutsAfterCapture(app, job.id, 'shipping', { retailCents: job.amounts.retailCents ?? 0, feeCents: 0, shippingCents })));
  }
  await reconcileBid(app, job.bidId);
  return { job: viewJob(app.store.jobs.must(job.id), { userId: u.id, ops: false }), ledger };
}

const digitsOnly = (s: string) => s.replace(/\D/g, '');

export async function handover(app: App, u: User, jobId: string, code: string): Promise<JobMoneyResult> {
  const job = ownJobAsQueuer(app, u, jobId);
  if (job.mode !== 'local') throw new ContractError('MODE_NOT_ALLOWED', 'This job ships; add tracking instead.');
  if (job.status !== 'verified') throw new ContractError('INVALID_TRANSITION', `The job is ${job.status}; hand over after the receipt is verified.`);
  // The code is the requester's consent to the charge: after a few misses even the right code waits,
  // and after HANDOVER_MAX_TOTAL_MISSES in all it never works again (a person finishes the handover).
  const misses = handoverMisses(app, job.id);
  if (misses.all.length >= HANDOVER_MAX_TOTAL_MISSES) {
    throw new ContractError(
      'RATE_LIMITED',
      `${HANDOVER_MAX_TOTAL_MISSES} wrong handover codes: the code is locked for this job, and a person at HoldMySpot has to confirm the handover with the requester.`,
      { retryAt: null, locked: true },
    );
  }
  if (misses.recent.length >= HANDOVER_MAX_MISSES) {
    const retryAt = misses.recent[0]! + HANDOVER_LOCK_MS;
    throw new ContractError('RATE_LIMITED', 'Too many wrong handover codes; ask the requester again later.', { retryAt });
  }
  if (!job.handoverCode || digitsOnly(code) !== job.handoverCode) {
    app.db.setMeta(`handover-misses:${job.id}`, JSON.stringify([...misses.all, app.now()]));
    const left = Math.min(HANDOVER_MAX_MISSES - misses.recent.length, HANDOVER_MAX_TOTAL_MISSES - misses.all.length) - 1;
    throw new ContractError('WRONG_CODE', 'That is not the requester\'s handover code.', { attemptsLeft: Math.max(0, left) });
  }
  const cap = receiptCapture(job.caps, job.amounts.retailCents ?? 0, job.mode);
  const parts = { retailCents: cap.retailCents, feeCents: cap.feeCents, shippingCents: 0, processingCents: cap.processingCents, captureFeeCents: cap.captureFeeCents, payoutFeesCents: cap.payoutFeesCents };
  const out = await captureForJob(app, job.id, 'handover', cap.amountCents, parts);
  const ledger = [...out.entries];
  if (declined(out)) {
    // Nothing was charged: the item stays with the queuer and the job ends.
    app.tx(() => {
      const j = app.store.jobs.must(job.id);
      if (canTransition('job', j.status, 'failed')) failJob(app, j, 'payment_failed', 'PayPal declined the charge at the handover.');
    });
    await reconcileBid(app, job.bidId);
    throw new ContractError('PAYPAL_DECLINED', 'PayPal declined the charge; keep the item. Nothing was charged.', { jobId: job.id });
  }
  app.tx(() => {
    const j = app.store.jobs.must(job.id);
    if (j.status === 'verified') setJobStatus(app, j, 'delivered');
  });
  if (out.completed) ledger.push(...(await payoutsAfterCapture(app, job.id, 'handover', parts)));
  await reconcileBid(app, job.bidId);
  return { job: viewJob(app.store.jobs.must(job.id), { userId: u.id, ops: false }), ledger };
}

export async function markDelivered(app: App, jobId: string): Promise<{ job: Job }> {
  const job = app.store.jobs.must(jobId, 'job');
  if (job.status !== 'shipped') throw new ContractError('INVALID_TRANSITION', `The job is ${job.status}, not shipped.`);
  app.tx(() => setJobStatus(app, app.store.jobs.must(job.id), 'delivered'));
  await reconcileBid(app, job.bidId);
  return { job: app.store.jobs.must(job.id) };
}

/** Distinct checked-in queuers whose sell-out reports close a book (D-152). */
export const SOLD_OUT_REPORTS = 2;

/**
 * A checked-in queuer reports the item sold out (D-152). The report alone ends only the reporter's own unbought
 * jobs and offers on the item: nothing else is closed on one person's word (a check-in trusts the position the
 * phone reports, and the photo is optional and not read). When SOLD_OUT_REPORTS distinct checked-in queuers have
 * reported it, the book is sold out: every unbought job fails, open bids close and their holds are voided.
 */
export async function reportSoldOut(app: App, u: User, jobId: string, photoFileId: string | null): Promise<{ job: Job; book: BookSnapshot }> {
  const job = ownJobAsQueuer(app, u, jobId);
  const claim = app.store.claims.must(job.claimId);
  if (claim.status !== 'checked_in') throw new ContractError('INVALID_TRANSITION', 'Report a sell-out from inside the line (checked in).');
  if (photoFileId) ownFile(app, u.id, photoFileId, 'sold_out_photo', { jobId: job.id });
  const bidIds = app.tx(() => {
    const book = bookState(app, job.itemId);
    if (book.status === 'sold_out') return [];
    const reporters = [...new Set([...(book.soldOutReports ?? []), u.id])];
    book.soldOutReports = reporters;
    if (reporters.length < SOLD_OUT_REPORTS) {
      // One report: the reporter's own unbought jobs end and his offers on the item close; every other job,
      // request and hold stays as it was, and the book stays open until a second queuer in line confirms.
      app.store.books.update(book);
      const own = new Set<string>();
      for (const j of app.store.jobs.where('item_id = ?', job.itemId)) {
        if (j.queuerId === u.id && JOB_BEFORE_PURCHASE.includes(j.status)) {
          failJob(app, j, 'sold_out', `${u.displayName} reported ${itemById(j.itemId).item.shortName} sold out; the book closes when a second queuer in line confirms.`, { reoffer: true });
          own.add(j.bidId);
        }
      }
      for (const a of app.store.asks.where("item_id = ? AND status IN ('open', 'filled', 'withdrawn')", job.itemId)) {
        if (a.queuerId === u.id && canTransition('ask', a.status, 'closed')) {
          a.status = 'closed';
          a.updatedAt = app.now();
          app.store.asks.update(a);
          emitAsk(app, a);
        }
      }
      if (own.size > 0) runBook(app, job.itemId, 'requeue');
      emitBook(app, job.itemId);
      return [...own];
    }
    book.status = 'sold_out';
    book.soldOutAt = app.now();
    app.store.books.update(book);
    const bids = new Set<string>();
    for (const j of app.store.jobs.where('item_id = ?', job.itemId)) {
      if (JOB_BEFORE_PURCHASE.includes(j.status)) {
        failJob(app, j, 'sold_out', `${u.displayName} reported ${itemById(j.itemId).item.shortName} sold out.`);
        bids.add(j.bidId);
      }
    }
    for (const b of app.store.bids.where("item_id = ? AND status IN ('open', 'partially_matched', 'matched')", job.itemId)) {
      if (b.closeReason === null && b.remainingQty > 0) {
        b.closeReason = 'sold_out';
        b.updatedAt = app.now();
        app.store.bids.update(b);
        emitBid(app, b);
      }
      bids.add(b.id);
    }
    for (const a of app.store.asks.where("item_id = ? AND status IN ('open', 'filled', 'withdrawn')", job.itemId)) {
      if (canTransition('ask', a.status, 'closed')) {
        a.status = 'closed';
        a.updatedAt = app.now();
        app.store.asks.update(a);
        emitAsk(app, a);
      }
    }
    emitBook(app, job.itemId);
    return [...bids];
  });
  for (const id of bidIds) await reconcileBid(app, id);
  return { job: viewJob(app.store.jobs.must(job.id), { userId: u.id, ops: false }), book: bookSnapshot(app, job.itemId) };
}

/** Shipped jobs need tracking within shipWithinDays of verification, else they fail and capture #1 is refunded. */
export async function failNotShipped(app: App, jobId: string): Promise<void> {
  const job = app.store.jobs.must(jobId);
  if (job.status !== 'verified' || job.mode !== 'ship' || job.shipment) return;
  app.tx(() => failJob(app, app.store.jobs.must(jobId), 'not_shipped', `No tracking within ${app.rules.shipWithinDays} days of the verified receipt.`));
  const refundable = job.amounts.capturedCents - job.amounts.refundedCents;
  if (refundable > 0) {
    try {
      await refundJob(app, jobId, refundable, 'not shipped in time');
    } catch (err) {
      app.log(`refund for ${jobId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await reconcileBid(app, job.bidId);
}

/** Ops decides a proof that needs review. */
export async function reviewProof(app: App, proofId: string, req: ReviewProofRequest): Promise<{ proof: Proof; job: Job | null }> {
  const proof = app.store.proofs.must(proofId, 'proof');
  if (proof.status !== 'needs_review') throw new ContractError('INVALID_TRANSITION', `The proof is ${proof.status}, not waiting for review.`);
  const note: ProofCheck[] = proof.checks;
  const summary = `${req.decision === 'pass' ? 'Passed' : 'Failed'} by ops review${req.note ? `: ${req.note}` : '.'}`;
  if (proof.kind === 'check_in') {
    const lapse = applyCheckInVerdict(
      app,
      proof.id,
      { status: req.decision === 'pass' ? 'passed' : 'failed', checks: note, peopleAhead: proof.peopleAhead, summary, ai: proof.ai },
      'ops',
    );
    if (lapse) await lapseClaim(app, lapse);
  } else {
    const job = app.store.jobs.must(proof.jobId!);
    const { item } = itemById(job.itemId);
    const fallbackRetail = item.retail.currency === 'USD' ? item.retail.minor * job.qty : item.retailCents * job.qty;
    // An amount read as $0 counts as unread, like null: a pass charges the shop price (D-135).
    const read = proof.amounts?.retailCents ?? null;
    await decidePurchase(
      app,
      proof.id,
      {
        status: req.decision === 'pass' ? 'passed' : 'failed',
        checks: note,
        receipt: proof.receipt ?? { printedName: null, sellerTaxId: null, invoiceNumber: null, issuedAt: null, currency: null, lines: [], total: null, qr: null, codeSeen: null },
        receiptTotal: proof.amounts?.receiptTotal ?? null,
        retailCents: read !== null && read > 0 ? read : fallbackRetail,
        summary,
        ai: proof.ai,
      },
      'ops',
    );
  }
  const updated = app.store.proofs.must(proof.id);
  return { proof: updated, job: updated.jobId ? app.store.jobs.must(updated.jobId) : null };
}

export function jobDetail(app: App, viewer: Viewer, jobId: string): JobDetail {
  const job = app.store.jobs.must(jobId, 'job');
  const requester = viewer.userId === job.requesterId;
  if (!viewer.ops && !requester && viewer.userId !== job.queuerId) throw new ContractError('FORBIDDEN', 'Only the people on this job and ops can see it.');
  const proofs = app.store.proofs.where('job_id = ?', job.id);
  const claim = app.store.claims.must(job.claimId);
  const lineProof = claim.linePhotoProofId ? app.store.proofs.get(claim.linePhotoProofId) : null;
  return {
    job: viewJob(job, viewer),
    bid: viewer.ops || requester ? app.store.bids.must(job.bidId) : null,
    ask: app.store.asks.must(job.askId),
    claim: viewer.ops || viewer.userId === claim.queuerId ? claim : { ...claim, checkInCode: null, arrival: null },
    proofs: lineProof ? [lineProof, ...proofs] : proofs,
    ledger: app.store.ledger.where('job_id = ?', job.id).filter((e) => viewer.ops || e.userId === viewer.userId).reverse(),
    payouts: viewer.ops || viewer.userId === job.queuerId ? app.store.payouts.where('job_id = ?', job.id).map((p) => (viewer.ops ? p : { ...p, receiverEmail: null })).reverse() : [],
    dispute: app.store.disputes.first('job_id = ?', job.id),
  };
}

export function isSettledBid(app: App, bidId: string): boolean {
  return isTerminal('bid', app.store.bids.must(bidId).status);
}
