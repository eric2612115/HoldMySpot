import {
  ContractError,
  JOB_SETTLED,
  PAYPAL_PRICING,
  assertCaptureWithinLimit,
  assertTransition,
  canTransition,
  captureCapCents,
  formatUsd,
  holdTiming,
  isFinalCapture,
  isTerminal,
  money,
  paypalCaptureFeeCents,
  payoutsForCapture,
  renewalVerdict,
} from '@holdmyspot/shared';
import type { BidStatus, BidTask, Hold, Job, LedgerEntry, LedgerKind, LedgerStatus, Match, Payout, PayoutPart, PayoutStatus } from '@holdmyspot/shared';
import type { AuthorizationResult, CaptureResult, PayoutBatchResult, PayPalFailure, RefundResult } from '@holdmyspot/shared/ports';
import { describeFailure, toPayPalFailure } from '../ports/payments.ts';
import type { Adapter, App } from './app.ts';
import { itemById, userDoc } from './catalog.ts';
import { bookState, canStillMatchLater, emitBook, jobMayCaptureAgain, nowFor, runBook, setJobStatus } from './market.ts';
import { emitBid, emitHold, emitJob, emitLedger, emitPayout } from './views.ts';

/**
 * Money. Every PayPal call uses the ledger as its outbox (docs/PAYPAL-MAPPING.md
 * section 8): insert the entry as `pending` with its idempotency key and the
 * request, call PayPal with that key, then mark it `succeeded` or `failed`
 * and update the hold, job and payout. Rules enforced here:
 *
 * - captures never take the total past the user's own limit (100% of the
 *   hold, although PayPal accepts 115%), and never past the job's caps;
 * - payouts only after a COMPLETED capture;
 * - a bid that can capture nothing more is voided (or was closed by a final capture);
 * - untouched holds of open bids are reauthorized from day 4 to day 29;
 * - an outcome we do not know (an outage, a lost or unreadable answer) stays
 *   `pending` and is only ever resent with its own key, never as a new call;
 * - no authorization is left at PayPal without a live request behind it.
 */

export type CapturePart = 'receipt' | 'shipping' | 'handover';

/**
 * What one capture pays for. Processing (D-105) is this capture's own PayPal
 * fee plus the Payouts fees it carries; requests stored before D-105 have none.
 */
export interface CaptureParts {
  retailCents: number;
  feeCents: number;
  shippingCents: number;
  processingCents?: number;
  captureFeeCents?: number;
  payoutFeesCents?: number;
}

type MoneyRequest =
  | { op: 'authorize'; adapter: Adapter; orderId: string; bidId: string }
  | {
      op: 'capture';
      adapter: Adapter;
      authorizationId: string;
      amountCents: number;
      finalCapture: boolean;
      invoiceId: string;
      jobId: string;
      part: CapturePart;
      parts: CaptureParts;
    }
  /** `stray`: an authorization the hold does not use (it arrived late), so the void leaves the hold as it is. */
  | { op: 'void'; adapter: Adapter; authorizationId: string; holdId: string; amountCents: number; stray?: boolean }
  | { op: 'reauthorize'; adapter: Adapter; authorizationId: string; holdId: string; amountCents: number }
  /** `duplicate`: PayPal said this batch already exists (sent before, answer lost); never resent, reconciled by hand. */
  | { op: 'payout'; adapter: Adapter; payoutId: string; jobId: string; receiverEmail: string; amountCents: number; note: string; message: string; duplicate?: boolean }
  | { op: 'refund'; adapter: Adapter; captureId: string; jobId: string; amountCents: number; invoiceId: string; note: string };

const INVOICE_SUFFIX: Record<CapturePart, string> = { receipt: 'R', shipping: 'S', handover: 'H' };
const usd = (c: number) => formatUsd(c, { exact: true });

/** "processing $2.69 at cost ($2.19 to take this payment, $0.50 for 2 payouts)": the processing part of a capture, to the cent. */
function processingWords(parts: CaptureParts): string {
  const processing = parts.processingCents ?? 0;
  const payouts = parts.payoutFeesCents ?? 0;
  const items = Math.round(payouts / PAYPAL_PRICING.payoutItemCents);
  const take = parts.captureFeeCents ?? processing - payouts;
  const detail = payouts > 0 ? `${usd(take)} to take this payment, ${usd(payouts)} for ${items} ${items === 1 ? 'payout' : 'payouts'}` : 'taking this payment';
  return `processing ${usd(processing)} at cost (${detail})`;
}

export const adapterOf = (hold: Pick<Hold, 'clockBasis'>): Adapter => (hold.clockBasis === 'real' ? 'sandbox' : 'fake');

// ---- ledger ------------------------------------------------------------------

function storeRequest(app: App, ledgerId: string, request: MoneyRequest): void {
  app.db.prepare('INSERT INTO ledger_requests (ledger_id, request) VALUES (?, ?) ON CONFLICT(ledger_id) DO UPDATE SET request = excluded.request').run(ledgerId, JSON.stringify(request));
}

export function loadRequest(app: App, ledgerId: string): MoneyRequest | null {
  const row = app.db.prepare('SELECT request FROM ledger_requests WHERE ledger_id = ?').get(ledgerId) as { request: string } | undefined;
  return row ? (JSON.parse(row.request) as MoneyRequest) : null;
}

/** Appends a ledger entry (inside app.tx). */
export function appendLedger(
  app: App,
  e: {
    kind: LedgerKind;
    amountCents: number;
    text: string;
    userId: string;
    idempotencyKey: string;
    mode: Adapter;
    status?: LedgerStatus;
    holdId?: string | null;
    bidId?: string | null;
    jobId?: string | null;
    payoutId?: string | null;
    paypal?: LedgerEntry['paypal'];
  },
  request?: MoneyRequest,
): LedgerEntry {
  const entry: LedgerEntry = {
    id: app.nextId('led'),
    kind: e.kind,
    amount: money(e.amountCents),
    text: e.text,
    at: app.now(),
    holdId: e.holdId ?? null,
    payoutId: e.payoutId ?? null,
    bidId: e.bidId ?? null,
    jobId: e.jobId ?? null,
    userId: e.userId,
    idempotencyKey: e.idempotencyKey,
    status: e.status ?? 'pending',
    mode: e.mode,
    paypal: e.paypal ?? null,
  };
  app.store.ledger.insert(entry);
  if (request) storeRequest(app, entry.id, request);
  emitLedger(app, entry);
  return entry;
}

function settleLedger(app: App, entry: LedgerEntry, status: LedgerStatus, paypal?: LedgerEntry['paypal']): LedgerEntry {
  entry.status = status;
  if (paypal) entry.paypal = { ...(entry.paypal ?? {}), ...paypal };
  app.store.ledger.update(entry);
  emitLedger(app, entry);
  return entry;
}

/**
 * The idempotency key for a money call: the base key, or base:2, base:3...
 * after failed attempts. Returns the live entry when one already succeeded
 * or is still pending (the call must not be made twice).
 */
export function ledgerKey(app: App, base: string): { key: string; existing: LedgerEntry | null } {
  for (let n = 1; n < 100; n++) {
    const key = n === 1 ? base : `${base}:${n}`;
    const e = app.store.ledger.first('idempotency_key = ?', key);
    if (!e) return { key, existing: null };
    if (e.status !== 'failed') return { key, existing: e };
  }
  throw new ContractError('CONFLICT', `Too many failed attempts for ${base}.`);
}

function pendingCaptureCents(app: App, holdId: string): number {
  return app.store.ledger.where("hold_id = ? AND kind = 'captured' AND status = 'pending'", holdId).reduce((s, e) => s + e.amount.cents, 0);
}

/** A void of the hold's own authorization is in flight: nothing may be captured from it now. */
function voidInFlight(app: App, holdId: string): boolean {
  return app.store.ledger.where("hold_id = ? AND kind = 'released' AND status = 'pending'", holdId).some((e) => {
    const req = loadRequest(app, e.id);
    return req?.op === 'void' && !req.stray;
  });
}

/** The capture request this job already sent (or is sending) for one part, if any: its amounts win over a retry's. */
export function liveCaptureRequest(app: App, jobId: string, part: CapturePart): Extract<MoneyRequest, { op: 'capture' }> | null {
  const { existing } = ledgerKey(app, `cap:${jobId}:${part}`);
  if (!existing) return null;
  const req = loadRequest(app, existing.id);
  return req?.op === 'capture' ? req : null;
}

function holdOfBid(app: App, bid: BidTask): Hold {
  if (!bid.holdId) throw new ContractError('HOLD_NOT_FOUND', `Bid ${bid.id} has no hold.`);
  return app.store.holds.must(bid.holdId, 'hold', 'HOLD_NOT_FOUND');
}

function moneyError(f: PayPalFailure): ContractError {
  const err = new ContractError(f.code, describeFailure(f), { issue: f.issue, paypalName: f.paypalName, httpStatus: f.httpStatus });
  (err as ContractError & { paypalDebugId?: string }).paypalDebugId = f.debugId ?? undefined;
  return err;
}

async function send<T>(app: App, adapter: Adapter, call: (port: ReturnType<App['payments']>) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; failure: PayPalFailure }> {
  try {
    return { ok: true, value: await call(app.payments(adapter)) };
  } catch (err) {
    if (err instanceof ContractError && err.code === 'PAYPAL_UNAVAILABLE') {
      return { ok: false, failure: { code: 'PAYPAL_UNAVAILABLE', paypalName: null, issue: 'ADAPTER_NOT_LOADED', httpStatus: null, debugId: null, retryable: true } };
    }
    const failure = toPayPalFailure(err);
    // A 2xx answer we could not read: PayPal may have done it. Treat it like an outage, so the
    // entry stays pending and is resent with the same key (PayPal answers a repeat with the first result).
    if (failure.paypalName === 'UNEXPECTED_RESPONSE') return { ok: false, failure: { ...failure, code: 'PAYPAL_UNAVAILABLE', retryable: true } };
    return { ok: false, failure };
  }
}

// ---- authorization -------------------------------------------------------------

/** Applies an authorization (new hold or reauthorization) to the hold and its bid. Inside app.tx. */
function applyAuthorization(app: App, hold: Hold, bid: BidTask, r: AuthorizationResult): void {
  const first = hold.originalAuthorizationId === null;
  const authorizedAt = r.createdAt;
  const originalAuthorizedAt = first ? authorizedAt : (hold.originalAuthorizedAt ?? authorizedAt);
  const timing = holdTiming({ authorizedAt, originalAuthorizedAt }, app.rules);
  assertTransition('hold', hold.status, 'held');
  hold.status = 'held';
  hold.authorizationId = r.authorizationId;
  hold.originalAuthorizationId = hold.originalAuthorizationId ?? r.authorizationId;
  hold.authorizedAt = authorizedAt;
  hold.originalAuthorizedAt = originalAuthorizedAt;
  hold.honorEndsAt = timing.honorEndsAt;
  hold.expiresAt = first ? (r.expiresAt ?? timing.expiresAt) : (hold.expiresAt ?? timing.expiresAt);
  hold.fundingSource = r.fundingSource;
  hold.updatedAt = app.now();
  app.store.holds.update(hold);
  bid.paypalAuthorizationId = r.authorizationId;
  bid.updatedAt = app.now();
  app.store.bids.update(bid);
  emitHold(app, hold, bid.requesterId);
}

/**
 * Authorizes an approved order (the buyer approved in PayPal or the
 * simulated sheet). On success the hold is `held` and the bid `open`;
 * the caller runs matching. A decline leaves the bid awaiting approval.
 */
export async function authorizeHold(app: App, bidId: string, orderId: string): Promise<LedgerEntry> {
  const prep = app.tx(() => {
    const bid = app.store.bids.must(bidId);
    const hold = holdOfBid(app, bid);
    const adapter = adapterOf(hold);
    const { key, existing } = ledgerKey(app, `auth:${bid.id}`);
    if (existing?.status === 'succeeded') return { entry: existing, request: null };
    const request: MoneyRequest = { op: 'authorize', adapter, orderId, bidId: bid.id };
    const entry =
      existing ??
      appendLedger(
        app,
        {
          kind: 'held',
          amountCents: hold.amount.cents,
          text: `PayPal is holding up to ${usd(hold.amount.cents)} for ${bid.qty} x ${itemById(bid.itemId).item.shortName}.`,
          userId: bid.requesterId,
          idempotencyKey: key,
          mode: adapter,
          holdId: hold.id,
          bidId: bid.id,
          paypal: { orderId },
        },
        request,
      );
    return { entry, request };
  });
  if (!prep.request) return prep.entry;
  return finishAuthorize(app, prep.entry.id, prep.request as Extract<MoneyRequest, { op: 'authorize' }>);
}

async function finishAuthorize(app: App, ledgerId: string, req: Extract<MoneyRequest, { op: 'authorize' }>): Promise<LedgerEntry> {
  const entry0 = app.store.ledger.must(ledgerId);
  const res = await send(app, req.adapter, (p) => p.authorizeOrder(req.orderId, entry0.idempotencyKey));
  if (!res.ok) {
    // Settle the failure in its own transaction, then throw (a throw inside app.tx would roll it back).
    // An outage stays pending and is resent with the same key; a refusal gets a new key next time.
    const failure = res.failure;
    app.tx(() => {
      if (failure.retryable) return;
      settleLedger(app, app.store.ledger.must(ledgerId), 'failed', { debugId: failure.debugId ?? undefined });
    });
    throw moneyError(failure);
  }
  const auth = res.value;
  const out = app.tx(() => {
    const entry = app.store.ledger.must(ledgerId);
    const bid = app.store.bids.must(req.bidId);
    const hold = holdOfBid(app, bid);
    if (hold.status === 'failed') {
      // The request ended (cancelled, approval timed out) before PayPal's answer arrived, for
      // example when the recovery sweep resends it. Never keep that money held: void it at once.
      settleLedger(app, entry, 'failed', { authorizationId: auth.authorizationId, debugId: auth.debugId ?? undefined });
      const { key, existing } = ledgerKey(app, `void:${hold.id}:late`);
      if (existing) return { entry, release: existing.status === 'pending' ? existing : null };
      const request: MoneyRequest = { op: 'void', adapter: req.adapter, authorizationId: auth.authorizationId, holdId: hold.id, amountCents: hold.amount.cents, stray: true };
      const release = appendLedger(
        app,
        {
          kind: 'released',
          amountCents: hold.amount.cents,
          text: `Released ${usd(hold.amount.cents)}: PayPal confirmed the hold after the request had ended.`,
          userId: bid.requesterId,
          idempotencyKey: key,
          mode: req.adapter,
          holdId: hold.id,
          bidId: bid.id,
          paypal: { orderId: req.orderId, authorizationId: auth.authorizationId },
        },
        request,
      );
      return { entry, release };
    }
    applyAuthorization(app, hold, bid, auth);
    return { entry: settleLedger(app, entry, 'succeeded', { authorizationId: auth.authorizationId, debugId: auth.debugId ?? undefined }), release: null };
  });
  if (out.release) {
    const request = loadRequest(app, out.release.id);
    if (request?.op === 'void') await finishVoid(app, out.release.id, request);
  }
  return out.entry;
}

/**
 * The buyer approved and PayPal authorized: the request joins the book.
 * Used when the authorization was completed outside POST .../authorize (the
 * recovery sweep, or at the approval timeout), so an authorized hold never
 * sits behind a request that cannot match. Returns the matches it made.
 */
export function openAuthorizedBid(app: App, bidId: string): Match[] {
  return app.tx(() => {
    const bid = app.store.bids.must(bidId);
    if (bid.status !== 'awaiting_approval' || !bid.holdId) return [];
    const hold = app.store.holds.must(bid.holdId);
    if (hold.status !== 'held') return [];
    assertTransition('bid', bid.status, 'open');
    bid.status = 'open';
    bid.updatedAt = app.now();
    app.store.bids.update(bid);
    emitBid(app, bid);
    const matches = runBook(app, bid.itemId, 'new_bid');
    emitBook(app, bid.itemId);
    return matches;
  });
}

// ---- captures --------------------------------------------------------------------

export interface CaptureOutcome {
  entry: LedgerEntry;
  /** The capture is COMPLETED (payouts may follow). */
  completed: boolean;
  /** The ledger entries written by this call (capture, and release when final). */
  entries: LedgerEntry[];
  /** The request PayPal got for this part (the first one wins over a retry's numbers); null if unknown. */
  request: Extract<MoneyRequest, { op: 'capture' }> | null;
}

/**
 * Captures part of a job's money from its bid's hold. Refuses (OVER_LIMIT)
 * anything that would take captures past the user's own limit or the job's
 * caps, before any PayPal call is made.
 */
export async function captureForJob(
  app: App,
  jobId: string,
  part: CapturePart,
  amountCents: number,
  parts: CaptureParts,
  /** Duty the queuer prepaid inside a shipping capture (0 for a US domestic parcel), for the wording only. */
  dutyCents = 0,
): Promise<CaptureOutcome> {
  const prep = app.tx(() => {
    const job = app.store.jobs.must(jobId);
    const bid = app.store.bids.must(job.bidId);
    const hold = holdOfBid(app, bid);
    const adapter = adapterOf(hold);
    const { key, existing } = ledgerKey(app, `cap:${job.id}:${part}`);
    if (existing) return { existing, request: null };

    // Each part's cap with its processing at cost on top (D-105).
    const jobCap = captureCapCents(job.caps, job.mode, part);
    if (amountCents > jobCap) {
      throw new ContractError('OVER_LIMIT', `Capture of ${usd(amountCents)} is above this job's ${part} cap of ${usd(jobCap)}.`, { amountCents, capCents: jobCap });
    }
    if (voidInFlight(app, hold.id)) throw new ContractError('HOLD_CLOSED', 'The PayPal hold is being released; nothing more can be charged.', { holdId: hold.id });
    // The rule that matters most: never past 100% of the user's own limit.
    assertCaptureWithinLimit(
      { limitCents: hold.amount.cents, capturedCents: hold.capturedCents + pendingCaptureCents(app, hold.id), status: hold.status },
      amountCents,
    );
    if (hold.expiresAt !== null && nowFor(app, hold) >= hold.expiresAt) {
      throw new ContractError('HOLD_EXPIRED', 'The PayPal hold has expired.', { holdId: hold.id });
    }
    if (!hold.authorizationId) throw new ContractError('HOLD_CLOSED', 'The hold has no authorization.');

    const others = app.store.jobs.where('bid_id = ?', bid.id).filter((j) => j.id !== job.id && jobMayCaptureAgain(j));
    const finalCapture = isFinalCapture({
      moreCapturesForThisJob: part === 'receipt' && job.mode === 'ship',
      otherActiveJobs: others.length,
      bidRemainingQty: bid.remainingQty,
      bidCanStillMatch: canStillMatchLater(app, bid, hold),
    });
    const { item } = itemById(job.itemId);
    const request: MoneyRequest = {
      op: 'capture',
      adapter,
      authorizationId: hold.authorizationId,
      amountCents,
      finalCapture,
      invoiceId: `HMS-${job.id}-${INVOICE_SUFFIX[part]}`,
      jobId: job.id,
      part,
      parts,
    };
    const processing = (parts.processingCents ?? 0) > 0 ? processingWords(parts) : null;
    const text =
      part === 'shipping'
        ? `Charged ${usd(amountCents)}: ${dutyCents > 0 ? 'shipping and duty' : 'shipping'} ${usd(parts.shippingCents)} at cost${processing ? ` and ${processing}` : ''}.`
        : `Charged ${usd(amountCents)}: shop price ${usd(parts.retailCents)} at cost, queue fee ${job.qty} x ${usd(job.feeCents)} for ${item.shortName}${processing ? `, and ${processing}` : ''}.`;
    const entry = appendLedger(
      app,
      {
        kind: 'captured',
        amountCents,
        text,
        userId: bid.requesterId,
        idempotencyKey: key,
        mode: adapter,
        holdId: hold.id,
        bidId: bid.id,
        jobId: job.id,
        paypal: { orderId: hold.paypalOrderId ?? undefined, authorizationId: hold.authorizationId },
      },
      request,
    );
    return { existing: null, request, entry };
  });
  if (prep.existing) {
    const request = loadRequest(app, prep.existing.id);
    const sent = request?.op === 'capture' ? request : null;
    if (prep.existing.status === 'succeeded') return { entry: prep.existing, completed: true, entries: [], request: sent };
    if (!sent) return { entry: prep.existing, completed: false, entries: [], request: null };
    return finishCapture(app, prep.existing.id, sent);
  }
  return finishCapture(app, prep.entry!.id, prep.request as Extract<MoneyRequest, { op: 'capture' }>);
}

async function finishCapture(app: App, ledgerId: string, req: Extract<MoneyRequest, { op: 'capture' }>): Promise<CaptureOutcome> {
  const key = app.store.ledger.must(ledgerId).idempotencyKey;
  const res = await send(app, req.adapter, (p) =>
    p.captureAuthorization(req.authorizationId, {
      requestId: key,
      amountCents: req.amountCents,
      finalCapture: req.finalCapture,
      invoiceId: req.invoiceId,
      noteToPayer: req.part === 'shipping' ? 'Shipping at cost' : 'Shop price at cost plus queue fee',
      softDescriptor: 'HOLDMYSPOT',
    }),
  );
  if (!res.ok) {
    const failure = res.failure;
    app.tx(() => {
      const entry = app.store.ledger.must(ledgerId);
      if (failure.retryable) return; // stays pending; retried with the same key
      settleLedger(app, entry, 'failed', { debugId: failure.debugId ?? undefined });
    });
    if (failure.code === 'HOLD_EXPIRED') {
      const job = app.store.jobs.must(req.jobId);
      const bid = app.store.bids.must(job.bidId);
      if (bid.holdId) await expireHold(app, bid.holdId);
    }
    throw moneyError(failure);
  }
  return app.tx(() => applyCapture(app, ledgerId, req, res.value));
}

/** Applies a capture result to the ledger, hold and job. Inside app.tx. Also used by the PayPal status sync. */
export function applyCapture(app: App, ledgerId: string, req: Extract<MoneyRequest, { op: 'capture' }>, r: CaptureResult): CaptureOutcome {
  const entry = app.store.ledger.must(ledgerId);
  if (entry.status === 'succeeded') return { entry, completed: true, entries: [], request: req };
  if (entry.status === 'failed') return { entry, completed: false, entries: [], request: req };
  const paypal = { captureId: r.captureId, debugId: r.debugId ?? undefined };
  if (r.status === 'PENDING') {
    if (!entry.paypal?.captureId) settleLedger(app, entry, 'pending', paypal);
    return { entry, completed: false, entries: [entry], request: req };
  }
  // A capture refunded since (for example by a dispute) was still captured; refunds are tracked on their own.
  if (r.status !== 'COMPLETED' && r.status !== 'PARTIALLY_REFUNDED' && r.status !== 'REFUNDED') {
    settleLedger(app, entry, 'failed', paypal);
    return { entry, completed: false, entries: [entry], request: req };
  }
  const job = app.store.jobs.must(req.jobId);
  const bid = app.store.bids.must(job.bidId);
  const hold = holdOfBid(app, bid);
  const next = req.finalCapture ? 'captured' : 'partially_captured';
  assertTransition('hold', hold.status, next);
  hold.capturedCents += req.amountCents;
  hold.status = next;
  hold.updatedAt = app.now();
  // PayPal's own fee on this capture (seller_receivable_breakdown.paypal_fee); the schedule's when PayPal reports none.
  const expectedFee = paypalCaptureFeeCents(req.amountCents);
  const feeCents = r.paypalFeeCents ?? expectedFee;
  if (feeCents !== expectedFee) {
    app.log(`capture ${r.captureId}: PayPal reported a ${usd(feeCents)} fee, the schedule says ${usd(expectedFee)}; the job's processing variance shows on the ops board`);
  }
  const entries: LedgerEntry[] = [settleLedger(app, entry, 'succeeded', { ...paypal, feeCents })];
  if (req.finalCapture) {
    const rest = Math.max(0, hold.amount.cents - hold.capturedCents);
    hold.releasedCents += rest;
    if (rest > 0) {
      entries.push(
        appendLedger(app, {
          kind: 'released',
          amountCents: rest,
          text: `The final capture released the remaining ${usd(rest)}.`,
          userId: bid.requesterId,
          idempotencyKey: `rel:${hold.id}:final`,
          mode: req.adapter,
          status: 'succeeded',
          holdId: hold.id,
          bidId: bid.id,
          jobId: job.id,
          paypal: { authorizationId: req.authorizationId, captureId: r.captureId },
        }),
      );
    }
  }
  app.store.holds.update(hold);
  emitHold(app, hold, bid.requesterId);
  job.amounts = {
    ...job.amounts,
    capturedCents: job.amounts.capturedCents + req.amountCents,
    processingCents: (job.amounts.processingCents ?? 0) + (req.parts.processingCents ?? 0),
    paypalFeesCents: (job.amounts.paypalFeesCents ?? 0) + feeCents,
  };
  job.updatedAt = app.now();
  app.store.jobs.update(job);
  emitJob(app, job);
  return { entry, completed: true, entries, request: req };
}

/** The capture id of a job's receipt (or handover) capture, for tracking and refunds. */
export function captureEntries(app: App, jobId: string): LedgerEntry[] {
  return app.store.ledger.where("job_id = ? AND kind = 'captured' AND status = 'succeeded'", jobId);
}

// ---- payouts -----------------------------------------------------------------------

const PAYOUT_SUFFIX: Record<PayoutPart['purpose'], string> = { fee: 'fee', reimbursement: 'reimb', fee_and_reimbursement: 'all' };

function payoutStatusOf(s: PayoutBatchResult['items'][number]['status']): PayoutStatus {
  switch (s) {
    case 'SUCCESS':
      return 'succeeded';
    case 'UNCLAIMED':
      return 'unclaimed';
    case 'FAILED':
    case 'BLOCKED':
    case 'DENIED':
      return 'failed';
    case 'RETURNED':
    case 'REFUNDED':
    case 'REVERSED':
      return 'returned';
    case 'CANCELED':
      return 'cancelled';
    default:
      return 'pending';
  }
}

/** Pays the queuer the parts that follow a COMPLETED capture. */
export async function payoutsAfterCapture(
  app: App,
  jobId: string,
  capture: CapturePart,
  parts: { retailCents: number; feeCents: number; shippingCents: number },
): Promise<LedgerEntry[]> {
  const job = app.store.jobs.must(jobId);
  const out: LedgerEntry[] = [];
  for (const part of payoutsForCapture(job.mode, capture, parts, app.rules)) {
    if (part.amountCents <= 0) continue;
    out.push(...(await payout(app, jobId, part)));
  }
  return out;
}

async function payout(app: App, jobId: string, part: PayoutPart): Promise<LedgerEntry[]> {
  const prep = app.tx(() => {
    const job = app.store.jobs.must(jobId);
    const bid = app.store.bids.must(job.bidId);
    const hold = holdOfBid(app, bid);
    const adapter = adapterOf(hold);
    const { key, existing } = ledgerKey(app, `payout:${job.id}:${PAYOUT_SUFFIX[part.purpose]}`);
    if (existing) return { existing, request: null };
    const queuer = userDoc(app, job.queuerId);
    const receiverEmail = adapter === 'sandbox' ? (app.config.paypal?.twPayoutEmail ?? '') : (queuer.payoutEmail ?? `${job.queuerId}@queuers.example`);
    const { shop, item } = itemById(job.itemId);
    const what =
      part.purpose === 'fee'
        ? `Queue fee, ${job.qty} x ${item.shortName}, ${shop.name}`
        : part.purpose === 'reimbursement'
          ? `Shop price and shipping at cost, ${job.qty} x ${item.shortName}, ${shop.name}`
          : `Shop price at cost and queue fee, ${job.qty} x ${item.shortName}, ${shop.name}`;
    const note = `${what} (${job.queuerName})`;
    const payoutId = app.nextId('po');
    const now = app.now();
    const record: Payout = {
      id: payoutId,
      recipient: job.queuerName,
      recipientUserId: job.queuerId,
      receiverEmail,
      amount: money(part.amountCents),
      note,
      reference: job.id,
      purpose: part.purpose,
      platformFeeCents: part.platformFeeCents,
      status: 'pending',
      paypalBatchId: null,
      paypalItemId: null,
      paypalFeeCents: null,
      createdAt: now,
      updatedAt: now,
    };
    app.store.payouts.insert(record);
    emitPayout(app, record);
    const request: MoneyRequest = {
      op: 'payout',
      adapter,
      payoutId,
      jobId: job.id,
      receiverEmail,
      amountCents: part.amountCents,
      note,
      message: `${what}.`,
    };
    const feeText = part.platformFeeCents > 0 ? ` (queue fee minus ${usd(part.platformFeeCents)} platform fee)` : '';
    const entry = appendLedger(
      app,
      {
        kind: 'paid_out',
        amountCents: part.amountCents,
        text: `Paid ${job.queuerName} ${usd(part.amountCents)}${feeText}.`,
        userId: job.queuerId,
        idempotencyKey: key,
        mode: adapter,
        bidId: bid.id,
        jobId: job.id,
        payoutId,
      },
      request,
    );
    return { existing: null, request, entry };
  });
  if (prep.existing) {
    if (prep.existing.status !== 'pending') return [];
    const request = loadRequest(app, prep.existing.id);
    // A batch PayPal already has is never sent again (it would be refused, or worse, paid twice).
    if (request?.op !== 'payout' || request.duplicate) return [];
    return finishPayout(app, prep.existing.id, request);
  }
  return finishPayout(app, prep.entry!.id, prep.request as Extract<MoneyRequest, { op: 'payout' }>);
}

/** PayPal refused a payout because its sender_batch_id was used before (see isDuplicatePayout in paypal/errors.ts). */
const isDuplicateBatch = (f: PayPalFailure) => f.issue !== null && /already exists|DUPLICATE/i.test(f.issue);

async function finishPayout(app: App, ledgerId: string, req: Extract<MoneyRequest, { op: 'payout' }>): Promise<LedgerEntry[]> {
  const key = app.store.ledger.must(ledgerId).idempotencyKey;
  const res = await send(app, req.adapter, (p) =>
    p.createPayout({
      senderBatchId: key,
      emailSubject: 'You have a payout from HoldMySpot',
      emailMessage: req.message,
      items: [{ receiverEmail: req.receiverEmail, amountCents: req.amountCents, note: req.note, senderItemId: req.payoutId }],
    }),
  );
  // PayPal answers a new batch with PENDING and no item status; read the batch once
  // right away (the status sync finishes anything still processing later).
  if (res.ok && !res.value.items.some((i) => i.senderItemId === req.payoutId && i.status !== 'PENDING' && i.status !== 'NEW')) {
    const batchId = res.value.batchId;
    const again = await send(app, req.adapter, (p) => p.getPayoutBatch(batchId));
    if (again.ok) res.value = again.value;
  }
  return app.tx(() => {
    const entry = app.store.ledger.must(ledgerId);
    const record = app.store.payouts.must(req.payoutId);
    if (!res.ok) {
      if (res.failure.retryable) return [entry];
      if (entry.status !== 'pending') return [entry];
      if (isDuplicateBatch(res.failure)) {
        // PayPal already has this batch: it was sent before and only the answer was lost. The money
        // went out, so the payout is neither failed nor sent again; it stays pending until reconciled.
        storeRequest(app, ledgerId, { ...req, duplicate: true });
        app.log(`payout ${req.payoutId}: PayPal already has batch ${entry.idempotencyKey}; kept pending for reconciliation, not resent`);
        return [settleLedger(app, entry, 'pending', { debugId: res.failure.debugId ?? undefined })];
      }
      if (canTransitionPayout(record.status, 'failed')) {
        record.status = 'failed';
        record.updatedAt = app.now();
        app.store.payouts.update(record);
        emitPayout(app, record);
      }
      return [settleLedger(app, entry, 'failed', { debugId: res.failure.debugId ?? undefined })];
    }
    return [applyPayout(app, ledgerId, req.payoutId, res.value)];
  });
}

/** Applies a payout batch result. Inside app.tx. Also used by the PayPal status sync. */
export function applyPayout(app: App, ledgerId: string, payoutId: string, r: PayoutBatchResult): LedgerEntry {
  const entry = app.store.ledger.must(ledgerId);
  const record = app.store.payouts.must(payoutId);
  const item = r.items.find((i) => i.senderItemId === payoutId) ?? r.items[0];
  let status = item ? payoutStatusOf(item.status) : 'pending';
  // A first answer of RETURNED or CANCELED (never seen as pending or unclaimed here) counts as failed.
  if (status !== record.status && !canTransitionPayout(record.status, status) && record.status === 'pending') status = 'failed';
  if (status !== record.status && canTransitionPayout(record.status, status)) {
    record.status = status;
    record.paypalBatchId = r.batchId;
    record.paypalItemId = item?.itemId ?? null;
    record.updatedAt = app.now();
    app.store.payouts.update(record);
    emitPayout(app, record);
  } else if (record.paypalBatchId === null) {
    record.paypalBatchId = r.batchId;
    record.paypalItemId = item?.itemId ?? null;
    app.store.payouts.update(record);
    emitPayout(app, record);
  }
  const paypal = { payoutBatchId: r.batchId, payoutItemId: item?.itemId ?? undefined };
  if (status === 'succeeded' && entry.status !== 'succeeded') {
    // PayPal's Payouts fee on this item (payout_item_fee), paid from the requester's processing line (D-105).
    const feeCents = item?.feeCents ?? PAYPAL_PRICING.payoutItemCents;
    record.paypalFeeCents = feeCents;
    app.store.payouts.update(record);
    emitPayout(app, record);
    const job = app.store.jobs.must(record.reference);
    job.amounts = { ...job.amounts, paidOutCents: job.amounts.paidOutCents + record.amount.cents, paypalFeesCents: (job.amounts.paypalFeesCents ?? 0) + feeCents };
    job.updatedAt = app.now();
    app.store.jobs.update(job);
    emitJob(app, job);
    return settleLedger(app, entry, 'succeeded', { ...paypal, feeCents });
  }
  if (status === 'failed' || status === 'returned' || status === 'cancelled') return settleLedger(app, entry, 'failed', paypal);
  return settleLedger(app, entry, 'pending', paypal);
}

function canTransitionPayout(from: PayoutStatus, to: PayoutStatus): boolean {
  return canTransition('payout', from, to);
}

// ---- voids, renewals, expiry -----------------------------------------------------

/** Releases what is left of a hold (void), also after partial captures. */
export async function voidHold(app: App, holdId: string, reason: string): Promise<LedgerEntry | null> {
  const prep = app.tx(() => {
    const hold = app.store.holds.must(holdId, 'hold', 'HOLD_NOT_FOUND');
    if (hold.status !== 'held' && hold.status !== 'partially_captured') return null;
    if (pendingCaptureCents(app, hold.id) > 0 || !hold.authorizationId) return null;
    const bid = app.store.bids.must(hold.reference);
    const adapter = adapterOf(hold);
    const { key, existing } = ledgerKey(app, `void:${hold.id}`);
    if (existing) return { existing, request: null };
    const amountCents = Math.max(0, hold.amount.cents - hold.capturedCents);
    const request: MoneyRequest = { op: 'void', adapter, authorizationId: hold.authorizationId, holdId: hold.id, amountCents };
    const entry = appendLedger(
      app,
      {
        kind: 'released',
        amountCents,
        text: `Released ${usd(amountCents)}: ${reason}.`,
        userId: bid.requesterId,
        idempotencyKey: key,
        mode: adapter,
        holdId: hold.id,
        bidId: bid.id,
        paypal: { authorizationId: hold.authorizationId },
      },
      request,
    );
    return { existing: null, request, entry };
  });
  if (!prep) return null;
  if (prep.existing) {
    if (prep.existing.status !== 'pending') return prep.existing;
    const request = loadRequest(app, prep.existing.id);
    if (request?.op !== 'void') return prep.existing;
    return finishVoid(app, prep.existing.id, request);
  }
  return finishVoid(app, prep.entry!.id, prep.request as Extract<MoneyRequest, { op: 'void' }>);
}

async function finishVoid(app: App, ledgerId: string, req: Extract<MoneyRequest, { op: 'void' }>): Promise<LedgerEntry> {
  const key = app.store.ledger.must(ledgerId).idempotencyKey;
  const res = await send(app, req.adapter, (p) => p.voidAuthorization(req.authorizationId, key));
  let synced: AuthorizationResult | null = null;
  if (!res.ok && res.failure.code === 'HOLD_CLOSED') {
    const again = await send(app, req.adapter, (p) => p.getAuthorization(req.authorizationId));
    if (again.ok) synced = again.value;
  }
  return app.tx(() => {
    const entry = app.store.ledger.must(ledgerId);
    const hold = app.store.holds.must(req.holdId, 'hold', 'HOLD_NOT_FOUND');
    const voided = res.ok || synced?.status === 'VOIDED';
    if (!voided) {
      if (!res.ok && res.failure.retryable) return entry;
      return settleLedger(app, entry, 'failed', { debugId: res.ok ? undefined : (res.failure.debugId ?? undefined) });
    }
    if (!req.stray && (hold.status === 'held' || hold.status === 'partially_captured')) {
      assertTransition('hold', hold.status, 'released');
      hold.status = 'released';
      hold.releasedCents += req.amountCents;
      hold.updatedAt = app.now();
      app.store.holds.update(hold);
      const bid = app.store.bids.must(hold.reference);
      emitHold(app, hold, bid.requesterId);
    }
    return settleLedger(app, entry, 'succeeded', {});
  });
}

export interface RenewalOutcome {
  verdict: 'not_needed' | 'reauthorize' | 'renewal_required';
  hold: Hold;
  ledger: LedgerEntry[];
}

/** Applies the renewal rule to one hold (sweeper and the ops button). */
export async function renewHold(app: App, holdId: string): Promise<RenewalOutcome> {
  const prep = app.tx(() => {
    const hold = app.store.holds.must(holdId, 'hold', 'HOLD_NOT_FOUND');
    const bid = app.store.bids.must(hold.reference);
    if (hold.authorizedAt === null || hold.originalAuthorizedAt === null || !hold.authorizationId) return { verdict: 'not_needed' as const, hold };
    const verdict = renewalVerdict(
      {
        status: hold.status,
        // A capture still in flight counts: PayPal refuses to reauthorize a captured authorization.
        capturedCents: hold.capturedCents + pendingCaptureCents(app, hold.id),
        authorizedAt: hold.authorizedAt,
        originalAuthorizedAt: hold.originalAuthorizedAt,
        renewalRequired: hold.renewalRequired,
      },
      nowFor(app, hold),
      { bidStillOpen: canStillMatchLater(app, bid, hold), reauthorizeSupported: hold.fundingSource !== 'venmo' },
      app.rules,
    );
    if (verdict === 'renewal_required') {
      markRenewalRequired(app, hold, bid);
      return { verdict, hold };
    }
    if (verdict === 'not_needed') return { verdict, hold };
    const adapter = adapterOf(hold);
    const { key, existing } = ledgerKey(app, `reauth:${hold.id}:${hold.renewals + 1}`);
    // This renewal is already in flight (its answer is outstanding): the recovery sweep finishes it.
    if (existing) return { verdict: 'not_needed' as const, hold };
    // PayPal reauthorizes the ORIGINAL authorization; a reauthorized payment cannot itself be reauthorized.
    const renewFrom = hold.originalAuthorizationId ?? hold.authorizationId;
    const request: MoneyRequest = { op: 'reauthorize', adapter, authorizationId: renewFrom, holdId: hold.id, amountCents: hold.amount.cents };
    const entry = appendLedger(
      app,
      {
        kind: 'renewed',
        amountCents: hold.amount.cents,
        text: `PayPal renewed the ${usd(hold.amount.cents)} hold for another ${app.rules.honorPeriodDays} days.`,
        userId: bid.requesterId,
        idempotencyKey: key,
        mode: adapter,
        holdId: hold.id,
        bidId: bid.id,
        paypal: { authorizationId: renewFrom },
      },
      request,
    );
    return { verdict, hold, entry, request };
  });
  if (!('entry' in prep) || !prep.entry) return { verdict: prep.verdict, hold: prep.hold, ledger: [] };
  return finishReauthorize(app, prep.entry.id, prep.request as Extract<MoneyRequest, { op: 'reauthorize' }>);
}

/**
 * Sends (or resends, with the same key) one reauthorization and applies it.
 * An outage keeps the entry pending and stops new fills on the hold until the
 * answer is known. A renewal that arrives after the hold moved on (captured or
 * released meanwhile) is not used, and its new authorization is voided, so
 * PayPal never keeps a second hold for one request.
 */
async function finishReauthorize(app: App, ledgerId: string, req: Extract<MoneyRequest, { op: 'reauthorize' }>): Promise<RenewalOutcome> {
  const key = app.store.ledger.must(ledgerId).idempotencyKey;
  const res = await send(app, req.adapter, (p) => p.reauthorize(req.authorizationId, { requestId: key, amountCents: req.amountCents }));
  const out = app.tx(() => {
    const entry = app.store.ledger.must(ledgerId);
    const hold = app.store.holds.must(req.holdId, 'hold', 'HOLD_NOT_FOUND');
    const bid = app.store.bids.must(hold.reference);
    if (entry.status !== 'pending') return { verdict: 'not_needed' as const, ledger: [entry], release: null };
    if (!res.ok) {
      if (!res.failure.retryable) settleLedger(app, entry, 'failed', { debugId: res.failure.debugId ?? undefined });
      markRenewalRequired(app, hold, bid);
      return { verdict: 'renewal_required' as const, ledger: [entry], release: null };
    }
    const auth = res.value;
    const usable = hold.status === 'held' && hold.capturedCents === 0 && pendingCaptureCents(app, hold.id) === 0 && !voidInFlight(app, hold.id);
    if (usable) {
      hold.renewals += 1;
      hold.renewalRequired = false;
      applyAuthorization(app, hold, bid, auth);
      const done = settleLedger(app, entry, 'succeeded', { authorizationId: auth.authorizationId });
      emitBook(app, bid.itemId);
      return { verdict: 'reauthorize' as const, ledger: [done], release: null };
    }
    settleLedger(app, entry, 'failed', { authorizationId: auth.authorizationId, debugId: auth.debugId ?? undefined });
    const { key: voidKey, existing } = ledgerKey(app, `void:${hold.id}:renewal:${hold.renewals + 1}`);
    const release =
      existing ??
      appendLedger(
        app,
        {
          kind: 'released',
          amountCents: auth.amountCents,
          text: `Released ${usd(auth.amountCents)}: a renewal PayPal confirmed late was no longer needed.`,
          userId: bid.requesterId,
          idempotencyKey: voidKey,
          mode: req.adapter,
          holdId: hold.id,
          bidId: bid.id,
          paypal: { authorizationId: auth.authorizationId },
        },
        { op: 'void', adapter: req.adapter, authorizationId: auth.authorizationId, holdId: hold.id, amountCents: auth.amountCents, stray: true },
      );
    return { verdict: 'renewal_required' as const, ledger: [entry, release], release: release.status === 'pending' ? release : null };
  });
  if (out.release) {
    const request = loadRequest(app, out.release.id);
    if (request?.op === 'void') await finishVoid(app, out.release.id, request);
  }
  return { verdict: out.verdict, hold: app.store.holds.must(req.holdId, 'hold', 'HOLD_NOT_FOUND'), ledger: out.ledger };
}

function markRenewalRequired(app: App, hold: Hold, bid: BidTask): void {
  if (hold.renewalRequired) return;
  hold.renewalRequired = true;
  hold.updatedAt = app.now();
  app.store.holds.update(hold);
  emitHold(app, hold, bid.requesterId);
  emitBook(app, bid.itemId);
}

/** PayPal let the authorization expire (day 29): what was not captured is released. */
export async function expireHold(app: App, holdId: string): Promise<void> {
  const bidId = app.tx(() => {
    const hold = app.store.holds.must(holdId, 'hold', 'HOLD_NOT_FOUND');
    if (hold.status !== 'held' && hold.status !== 'partially_captured') return null;
    const bid = app.store.bids.must(hold.reference);
    const rest = Math.max(0, hold.amount.cents - hold.capturedCents);
    assertTransition('hold', hold.status, 'released');
    hold.status = 'released';
    hold.releasedCents += rest;
    hold.updatedAt = app.now();
    app.store.holds.update(hold);
    emitHold(app, hold, bid.requesterId);
    appendLedger(app, {
      kind: 'released',
      amountCents: rest,
      text: `The PayPal hold expired; ${usd(rest)} was released.`,
      userId: bid.requesterId,
      idempotencyKey: `expire:${hold.id}`,
      mode: adapterOf(hold),
      status: 'succeeded',
      holdId: hold.id,
      bidId: bid.id,
    });
    if (bid.closeReason === null && !isTerminal('bid', bid.status)) {
      bid.closeReason = 'hold_lapsed';
      bid.updatedAt = app.now();
      app.store.bids.update(bid);
      emitBid(app, bid);
    }
    for (const job of app.store.jobs.where('bid_id = ?', bid.id)) {
      if (jobMayCaptureAgain(job) && canTransition('job', job.status, 'failed')) {
        job.failure = { reason: 'hold_unavailable', at: app.now(), detail: 'The PayPal hold expired before this job could be charged.' };
        setJobStatus(app, job, 'failed');
      }
    }
    emitBook(app, bid.itemId);
    return bid.id;
  });
  if (bidId) await reconcileBid(app, bidId);
}

// ---- refunds -----------------------------------------------------------------------

/**
 * Refunds part or all of what a job captured, newest capture first. A refund
 * still in flight for the job (an outage, or an answer that never came) is
 * finished first with its own key, and this call then starts nothing new:
 * resending can never refund twice, a fresh key could.
 */
export async function refundJob(app: App, jobId: string, amountCents: number, reason: string): Promise<LedgerEntry[]> {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new ContractError('INVALID_AMOUNT', 'A refund must be a positive whole number of cents.');
  app.store.jobs.must(jobId);
  const inflight = app.store.ledger.where("job_id = ? AND kind = 'refunded' AND status = 'pending'", jobId).filter((e) => !e.paypal?.refundId);
  if (inflight.length > 0) {
    const out: LedgerEntry[] = [];
    for (const e of inflight) {
      const req = loadRequest(app, e.id);
      if (req?.op === 'refund') out.push(await finishRefund(app, e.id, req));
    }
    return out;
  }
  const plan = app.tx(() => {
    const job = app.store.jobs.must(jobId);
    const refundable = job.amounts.capturedCents - job.amounts.refundedCents;
    if (amountCents > refundable) {
      throw new ContractError('INVALID_AMOUNT', `Only ${usd(refundable)} of this job can be refunded.`, { refundableCents: refundable });
    }
    const pieces: { captureId: string; cents: number; adapter: Adapter }[] = [];
    let left = amountCents;
    const refunded = new Map<string, number>();
    for (const e of app.store.ledger.where("job_id = ? AND kind = 'refunded' AND status IN ('succeeded', 'pending')", jobId)) {
      const req = loadRequest(app, e.id);
      if (req?.op === 'refund') refunded.set(req.captureId, (refunded.get(req.captureId) ?? 0) + e.amount.cents);
    }
    for (const cap of captureEntries(app, jobId).reverse()) {
      const id = cap.paypal?.captureId;
      if (!id || left === 0) continue;
      const free = cap.amount.cents - (refunded.get(id) ?? 0);
      const take = Math.min(free, left);
      if (take > 0) {
        pieces.push({ captureId: id, cents: take, adapter: cap.mode });
        left -= take;
      }
    }
    return pieces;
  });
  const out: LedgerEntry[] = [];
  for (const piece of plan) {
    const prep = app.tx(() => {
      const job = app.store.jobs.must(jobId);
      const bid = app.store.bids.must(job.bidId);
      const n = app.store.ledger.count("job_id = ? AND kind = 'refunded'", jobId) + 1;
      const { key } = ledgerKey(app, `refund:${job.id}:${n}`);
      const request: MoneyRequest = {
        op: 'refund',
        adapter: piece.adapter,
        captureId: piece.captureId,
        jobId: job.id,
        amountCents: piece.cents,
        invoiceId: `HMS-${job.id}-F${n}`,
        note: reason,
      };
      const entry = appendLedger(
        app,
        {
          kind: 'refunded',
          amountCents: piece.cents,
          text: `Refunded ${usd(piece.cents)}: ${reason}.`,
          userId: bid.requesterId,
          idempotencyKey: key,
          mode: piece.adapter,
          holdId: bid.holdId,
          bidId: bid.id,
          jobId: job.id,
          paypal: { captureId: piece.captureId },
        },
        request,
      );
      return { entry, request };
    });
    out.push(await finishRefund(app, prep.entry.id, prep.request as Extract<MoneyRequest, { op: 'refund' }>));
  }
  return out;
}

/** Sends (or resends, with the same key) one refund and applies the answer. An outage keeps it pending and throws. */
async function finishRefund(app: App, ledgerId: string, req: Extract<MoneyRequest, { op: 'refund' }>): Promise<LedgerEntry> {
  const key = app.store.ledger.must(ledgerId).idempotencyKey;
  const res = await send(app, req.adapter, (p) =>
    p.refundCapture(req.captureId, { requestId: key, amountCents: req.amountCents, invoiceId: req.invoiceId, noteToPayer: req.note }),
  );
  if (!res.ok) {
    const failure = res.failure;
    app.tx(() => {
      const entry = app.store.ledger.must(ledgerId);
      if (failure.retryable || entry.status !== 'pending') return; // stays pending; resent with the same key
      settleLedger(app, entry, 'failed', { debugId: failure.debugId ?? undefined });
    });
    throw moneyError(failure);
  }
  const refunded = res.value;
  return app.tx(() => applyRefund(app, app.store.ledger.must(ledgerId), req, refunded));
}

function applyRefund(app: App, entry: LedgerEntry, req: Extract<MoneyRequest, { op: 'refund' }>, r: RefundResult): LedgerEntry {
  // Applied once: a resend that PayPal answers with the first result changes nothing.
  if (entry.status !== 'pending' || entry.paypal?.refundId) return entry;
  const status: LedgerStatus = r.status === 'COMPLETED' ? 'succeeded' : r.status === 'PENDING' ? 'pending' : 'failed';
  if (status !== 'failed') {
    const job = app.store.jobs.must(req.jobId);
    const bid = app.store.bids.must(job.bidId);
    const hold = holdOfBid(app, bid);
    hold.refundedCents += req.amountCents;
    hold.updatedAt = app.now();
    app.store.holds.update(hold);
    emitHold(app, hold, bid.requesterId);
    job.amounts = { ...job.amounts, refundedCents: job.amounts.refundedCents + req.amountCents };
    job.updatedAt = app.now();
    app.store.jobs.update(job);
    if (job.amounts.refundedCents >= job.amounts.capturedCents && canTransition('job', job.status, 'refunded')) setJobStatus(app, job, 'refunded');
    else emitJob(app, job);
  }
  return settleLedger(app, entry, status, { refundId: r.refundId });
}

// ---- bid settlement ------------------------------------------------------------------

function moveBid(app: App, bid: BidTask, to: BidStatus): void {
  if (bid.status === to) return;
  if (!canTransition('bid', bid.status, to) && canTransition('bid', bid.status, 'closing')) {
    bid.status = 'closing';
  }
  assertTransition('bid', bid.status, to);
  bid.status = to;
  bid.updatedAt = app.now();
  app.store.bids.update(bid);
  emitBid(app, bid);
}

function defaultCloseReason(app: App, bid: BidTask, jobs: Job[], captured: boolean): NonNullable<BidTask['closeReason']> {
  if (bookState(app, bid.itemId).status === 'sold_out') return 'sold_out';
  if (jobs.some((j) => j.failure?.reason === 'hold_unavailable' || j.failure?.reason === 'payment_failed')) return 'hold_lapsed';
  if (app.now() > bid.deadlineAt && bid.remainingQty > 0) return 'deadline';
  return captured || bid.remainingQty === 0 ? 'filled' : 'deadline';
}

/**
 * Brings a bid in line with its jobs and hold: closing when a close reason
 * arrived while jobs are active; void when nothing more can be captured;
 * settled, cancelled or expired when everything is finished.
 */
export async function reconcileBid(app: App, bidId: string): Promise<void> {
  const plan = app.tx(() => {
    const bid = app.store.bids.must(bidId);
    if (isTerminal('bid', bid.status) || bid.status === 'awaiting_approval' || !bid.holdId) return null;
    const hold = app.store.holds.get(bid.holdId);
    if (!hold) return null;
    const jobs = app.store.jobs.where('bid_id = ?', bid.id);
    const active = jobs.filter((j) => !JOB_SETTLED.includes(j.status));
    const canMatch = canStillMatchLater(app, bid, hold);
    if (!canMatch && bid.closeReason !== null && bid.remainingQty > 0 && active.length > 0 && bid.status !== 'closing') {
      moveBid(app, bid, 'closing');
    }
    const mayCapture = canMatch || jobs.some(jobMayCaptureAgain);
    const needVoid = !mayCapture && (hold.status === 'held' || hold.status === 'partially_captured');
    return { needVoid, holdId: hold.id };
  });
  if (!plan) return;
  if (plan.needVoid) {
    const bid = app.store.bids.must(bidId);
    const reason =
      bid.closeReason === 'requester_cancelled'
        ? 'request cancelled'
        : bid.closeReason === 'deadline'
          ? 'deadline passed'
          : bid.closeReason === 'sold_out'
            ? 'sold out'
            : 'nothing more to charge';
    try {
      await voidHold(app, plan.holdId, reason);
    } catch (err) {
      app.log(`void ${plan.holdId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  app.tx(() => {
    const bid = app.store.bids.must(bidId);
    if (isTerminal('bid', bid.status) || bid.status === 'awaiting_approval') return;
    const hold = bid.holdId ? app.store.holds.get(bid.holdId) : null;
    if (!hold) return;
    const jobs = app.store.jobs.where('bid_id = ?', bid.id);
    const active = jobs.filter((j) => !JOB_SETTLED.includes(j.status));
    if (active.length > 0 || canStillMatchLater(app, bid, hold)) return;
    if (hold.status === 'held' || hold.status === 'partially_captured') return; // void still pending
    bid.closeReason = bid.closeReason ?? defaultCloseReason(app, bid, jobs, hold.capturedCents > 0);
    if (hold.capturedCents > 0) moveBid(app, bid, 'settled');
    else moveBid(app, bid, bid.closeReason === 'requester_cancelled' ? 'cancelled' : 'expired');
    emitBook(app, bid.itemId);
  });
}

// ---- recovery -------------------------------------------------------------------------

/**
 * Retries money calls left `pending` by a crash or an outage, with the same
 * idempotency keys (PayPal answers a repeat with the first result), and
 * finishes what each one implies: a request whose authorization landed joins
 * the book, a request whose void landed closes.
 */
export async function recoverPending(app: App): Promise<number> {
  let n = 0;
  for (const entry of app.store.ledger.where("status = 'pending'")) {
    const req = loadRequest(app, entry.id);
    if (!req) continue;
    // Entries PayPal already answered (a PENDING capture, a payout batch, a PENDING refund) wait for the
    // status sync, not for a resend. A refund entry names the capture it refunds, which is not an answer.
    if (req.op === 'capture' && entry.paypal?.captureId) continue;
    if (req.op === 'payout' && entry.paypal?.payoutBatchId) continue;
    if (req.op === 'refund' && entry.paypal?.refundId) continue;
    // A batch PayPal already has is reconciled by hand, never sent again.
    if (req.op === 'payout' && req.duplicate) continue;
    // Settled meanwhile (for example by another recovery step in this sweep).
    if (app.store.ledger.must(entry.id).status !== 'pending') continue;
    try {
      if (req.op === 'capture') {
        const out = await finishCapture(app, entry.id, req);
        if (out.completed) await payoutsAfterCapture(app, req.jobId, req.part, req.parts);
      } else if (req.op === 'payout') await finishPayout(app, entry.id, req);
      else if (req.op === 'void') {
        await finishVoid(app, entry.id, req);
        const hold = app.store.holds.get(req.holdId);
        if (hold?.status === 'released') await reconcileBid(app, hold.reference);
      } else if (req.op === 'authorize') {
        await finishAuthorize(app, entry.id, req);
        openAuthorizedBid(app, req.bidId);
      } else if (req.op === 'reauthorize') await finishReauthorize(app, entry.id, req);
      else if (req.op === 'refund') await finishRefund(app, entry.id, req);
      else continue;
      n++;
    } catch (err) {
      app.log(`recovery of ${entry.idempotencyKey} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return n;
}

export type { MoneyRequest };
export { holdOfBid };
export type JobRef = Pick<Job, 'id'>;
