import { ContractError, disputeNoteTemplate, findItem, findShop, formatUsd, money } from '@holdmyspot/shared';
import type { Dispute, DisputeNoteFacts, Job, LedgerEntry, User } from '@holdmyspot/shared';
import type { DisputeResult } from '@holdmyspot/shared/ports';
import { disputeFromPayPal } from '../paypal/status.ts';
import type { Adapter, App } from './app.ts';
import { readStoredFile } from './files.ts';
import { appendLedger, captureEntries, moneyError, refundJob, send } from './money.ts';
import { emitDispute, emitJob } from './views.ts';

/**
 * The hard calls that reach a person (D-160, D-161): disputes synced from
 * PayPal, the evidence, accept and sandbox adjudicate routes, the dispute note
 * draft, and refund requests. The AI only words a note from facts this file
 * gathers; every amount and outcome comes from code and from PayPal.
 */

const DISPUTE_SEARCH_MS = 180 * 24 * 60 * 60_000;
/** The sandbox client reads each dispute in full, so it is listed at most this often. */
const SANDBOX_DISPUTE_READ_MS = 60_000;
const lastSandboxRead = new WeakMap<App, number>();

/** PayPal accepts JPEG, PNG, GIF and PDF evidence; photos in other formats stay out and the note says what went. */
const EVIDENCE_TYPES: readonly string[] = ['image/jpeg', 'image/png'];

const usd = (c: number) => formatUsd(c, { exact: true });

function jobOfCaptures(app: App, captureIds: readonly string[]): Job | null {
  for (const e of app.store.ledger.where("kind = 'captured'")) {
    if (e.jobId && e.paypal?.captureId && captureIds.includes(e.paypal.captureId)) return app.store.jobs.must(e.jobId);
  }
  return null;
}

function adapterOfJob(app: App, jobId: string | null): Adapter {
  const capture = jobId ? captureEntries(app, jobId)[0] : undefined;
  return capture?.mode ?? (app.config.mode === 'sandbox' ? 'sandbox' : 'fake');
}

/**
 * One PayPal dispute into our record: unchanged answers do nothing, a new
 * buyer-favour outcome is booked once, and every change is emitted. Inside app.tx.
 */
function applyDisputeResult(app: App, r: DisputeResult): boolean {
  const mapped = disputeFromPayPal(r);
  const job = jobOfCaptures(app, r.captureIds);
  const before = app.store.disputes.get(r.disputeId);
  const next: Dispute = {
    id: r.disputeId,
    jobId: job?.id ?? before?.jobId ?? null,
    captureId: r.captureIds[0] ?? before?.captureId ?? '',
    reason: r.reason,
    status: mapped.status,
    outcome: mapped.outcome,
    amount: money(r.amountCents),
    evidenceSubmitted: before?.evidenceSubmitted ?? false,
    evidenceNote: before?.evidenceNote ?? null,
    draft: before?.draft ?? null,
    decision: before?.decision ?? null,
    createdAt: before?.createdAt ?? r.createdAt,
    updatedAt: r.updatedAt,
  };
  const same =
    before !== null &&
    before.status === next.status &&
    before.outcome === next.outcome &&
    before.amount.cents === next.amount.cents &&
    before.jobId === next.jobId &&
    before.captureId === next.captureId &&
    before.reason === next.reason;
  if (same) return false;
  if (before) app.store.disputes.update(next);
  else app.store.disputes.insert(next);
  emitDispute(app, next);
  if (job && !job.disputed) {
    job.disputed = true;
    job.updatedAt = app.now();
    app.store.jobs.update(job);
    emitJob(app, job);
  }
  if (job && next.outcome === 'buyer_favor') bookBuyerFavour(app, next, job.id);
  return true;
}

/** PayPal returned this dispute's money to the buyer: one ledger line, and what is left to refund shrinks by it. */
function bookBuyerFavour(app: App, d: Dispute, jobId: string): void {
  const key = `dispute:${d.id}`;
  if (app.store.ledger.first('idempotency_key = ?', key)) return;
  const job = app.store.jobs.must(jobId);
  const amount = Math.min(d.amount.cents, job.amounts.capturedCents - job.amounts.refundedCents);
  if (amount <= 0) return;
  const bid = app.store.bids.must(job.bidId);
  appendLedger(app, {
    kind: 'refunded',
    amountCents: amount,
    text: `PayPal returned ${usd(amount)} to the buyer: dispute ${d.id}.`,
    userId: bid.requesterId,
    idempotencyKey: key,
    mode: adapterOfJob(app, jobId),
    status: 'succeeded',
    holdId: bid.holdId,
    bidId: bid.id,
    jobId,
    paypal: { captureId: d.captureId },
  });
  if (bid.holdId) {
    const hold = app.store.holds.must(bid.holdId);
    hold.refundedCents += amount;
    hold.updatedAt = app.now();
    app.store.holds.update(hold);
  }
  job.amounts = { ...job.amounts, refundedCents: job.amounts.refundedCents + amount };
  job.updatedAt = app.now();
  app.store.jobs.update(job);
  emitJob(app, job);
}

/** Facts for the note and what Send attaches, all read from the job's records. */
function noteMaterial(app: App, d: Dispute): { facts: DisputeNoteFacts; files: { name: string; contentType: string; bytes: Uint8Array }[]; tracking: { carrierName: string; trackingNumber: string } | null } {
  const job = d.jobId ? app.store.jobs.get(d.jobId) : null;
  const facts: DisputeNoteFacts = {
    disputeId: d.id,
    reason: d.reason,
    amountCents: d.amount.cents,
    itemName: null,
    qty: null,
    shopName: null,
    receiptTotal: null,
    receiptNumber: null,
    receiptDate: null,
    tracking: null,
    handedOver: false,
    capturedCents: 0,
    refundedCents: 0,
    attachments: [],
  };
  const files: { name: string; contentType: string; bytes: Uint8Array }[] = [];
  if (!job) return { facts, files, tracking: null };
  facts.itemName = findItem(job.itemId)?.shortName ?? null;
  facts.qty = job.qty;
  facts.shopName = findShop(job.shopId)?.name ?? null;
  facts.handedOver = job.mode === 'local' && job.status === 'delivered';
  facts.capturedCents = job.amounts.capturedCents;
  facts.refundedCents = job.amounts.refundedCents;
  facts.tracking = job.shipment ? { carrierName: job.shipment.carrierName, trackingNumber: job.shipment.trackingNumber } : null;
  const proof = app.store.proofs.where("job_id = ? AND kind = 'purchase' AND status = 'passed'", job.id).at(-1);
  if (proof) {
    const r = proof.receipt;
    if (r?.total) facts.receiptTotal = r.total.currency === 'USD' ? usd(r.total.minor) : `${r.total.currency} ${r.total.minor}`;
    facts.receiptNumber = r?.invoiceNumber ?? null;
    facts.receiptDate = r?.issuedAt?.slice(0, 10) ?? null;
    proof.fileIds.forEach((fileId, i) => {
      const f = app.store.files.get(fileId);
      if (!f || !EVIDENCE_TYPES.includes(f.ref.contentType)) return;
      const label = i === 0 ? 'receipt' : 'item-photo';
      const ext = f.ref.contentType === 'image/png' ? 'png' : 'jpg';
      files.push({ name: `${label}.${ext}`, contentType: f.ref.contentType, bytes: readStoredFile(f) });
    });
  }
  facts.attachments = [...files.map((f) => f.name), ...(facts.tracking ? ['tracking'] : [])];
  return { facts, files, tracking: facts.tracking };
}

async function writeDraft(app: App, disputeId: string, queued: boolean): Promise<Dispute> {
  const d = app.store.disputes.must(disputeId, 'dispute');
  const { facts } = noteMaterial(app, d);
  const res = app.ai.disputeNote
    ? await app.ai.disputeNote({ facts })
    : { text: disputeNoteTemplate(facts), ai: { ...app.ai.info, latencyMs: 0 }, template: true, templateReason: 'no_model' as const };
  const save = (): Dispute =>
    app.tx(() => {
      const cur = app.store.disputes.must(disputeId, 'dispute');
      cur.draft = { text: res.text, ai: res.ai, template: res.template, templateReason: res.templateReason, attachments: [...facts.attachments], at: app.now() };
      app.store.disputes.update(cur);
      emitDispute(app, cur);
      return cur;
    });
  return queued ? save() : app.exec(save);
}

/**
 * Reads PayPal's disputes on our HMS- invoices into store.disputes. Runs in the
 * status sync; `queued: true` is for callers already inside app.exec (a demo step).
 */
export async function syncDisputes(app: App, opts: { queued?: boolean } = {}): Promise<number> {
  const queued = opts.queued === true;
  let changed = 0;
  // Every adapter that captured here, and the sandbox even on a fresh database: a dispute outlives a reset.
  const adapters = [...new Set([...app.store.ledger.where("kind = 'captured'").map((e) => e.mode), ...(app.config.mode === 'sandbox' ? (['sandbox'] as const) : [])])];
  for (const adapter of adapters) {
    if (adapter === 'sandbox' && !queued) {
      const last = lastSandboxRead.get(app) ?? 0;
      if (Date.now() - last < SANDBOX_DISPUTE_READ_MS) continue;
      lastSandboxRead.set(app, Date.now());
    }
    let found: DisputeResult[];
    try {
      found = await app.payments(adapter).listDisputes(app.now() - DISPUTE_SEARCH_MS);
    } catch (err) {
      app.log(`dispute sync failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const r of found) {
      const apply = (): boolean => app.tx(() => applyDisputeResult(app, r));
      if (queued ? apply() : await app.exec(apply)) changed++;
    }
  }
  for (const d of app.store.disputes.where("status != 'resolved'")) {
    if (d.draft) continue;
    await writeDraft(app, d.id, queued).catch((err: unknown) => app.log(`dispute draft failed: ${err instanceof Error ? err.message : String(err)}`));
  }
  return changed;
}

/** A person asked for a fresh draft. Waits on the model outside the market's queue. */
export function redraftDispute(app: App, disputeId: string): Promise<Dispute> {
  return writeDraft(app, disputeId, false);
}

function openDispute(app: App, disputeId: string): Dispute {
  const d = app.store.disputes.must(disputeId, 'dispute');
  if (d.status === 'resolved') throw new ContractError('INVALID_TRANSITION', `Dispute ${d.id} is already resolved.`);
  return d;
}

function requireNoDecision(d: Dispute): void {
  if (d.decision) throw new ContractError('CONFLICT', `A person already ${d.decision.kind} dispute ${d.id}; PayPal settles it from here.`);
}

/** Sends the person's note with the files and tracking code took from the job. Sends once. */
export async function submitEvidence(app: App, disputeId: string, req: { note: string; includeTracking: boolean }): Promise<Dispute> {
  const d = openDispute(app, disputeId);
  if (d.evidenceSubmitted) throw new ContractError('CONFLICT', `Evidence for dispute ${d.id} was already sent.`);
  const { facts, files, tracking } = noteMaterial(app, d);
  const receipt = [facts.receiptTotal, facts.receiptNumber && `receipt ${facts.receiptNumber}`, facts.receiptDate].filter(Boolean).join(', ');
  const note = receipt ? `${req.note}\n\nReceipt on file: ${receipt}.` : req.note;
  const res = await send(app, adapterOfJob(app, d.jobId), (p) => p.provideEvidence(d.id, { note, files, tracking: req.includeTracking ? tracking : null }));
  if (!res.ok) throw moneyError(res.failure);
  const out = res.value;
  return app.tx(() => {
    applyDisputeResult(app, out);
    const cur = app.store.disputes.must(d.id);
    cur.evidenceSubmitted = true;
    cur.evidenceNote = note;
    cur.updatedAt = app.now();
    app.store.disputes.update(cur);
    emitDispute(app, cur);
    return cur;
  });
}

/** Accepts the buyer's claim: PayPal returns the money, and the sync or this answer books it once. */
export async function acceptDispute(app: App, disputeId: string, note: string): Promise<Dispute> {
  const d = openDispute(app, disputeId);
  requireNoDecision(d);
  const res = await send(app, adapterOfJob(app, d.jobId), (p) => p.acceptClaim(d.id, note));
  if (!res.ok) throw moneyError(res.failure);
  const out = res.value;
  return app.tx(() => {
    applyDisputeResult(app, out);
    const cur = app.store.disputes.must(d.id);
    cur.decision = { kind: 'accepted', outcome: 'buyer_favor', at: app.now() };
    cur.updatedAt = app.now();
    app.store.disputes.update(cur);
    emitDispute(app, cur);
    return cur;
  });
}

/**
 * Settles a dispute through PayPal's adjudicate call, which only its sandbox
 * has; this server has no live PayPal mode. Sent once: PayPal answers 200 and
 * resolves later, and a second call would be a second decision.
 */
export async function adjudicateDispute(app: App, disputeId: string, outcome: 'buyer_favor' | 'seller_favor'): Promise<Dispute> {
  const d = openDispute(app, disputeId);
  requireNoDecision(d);
  const res = await send(app, adapterOfJob(app, d.jobId), (p) => p.adjudicate(d.id, outcome === 'buyer_favor' ? 'BUYER_FAVOR' : 'SELLER_FAVOR'));
  if (!res.ok) throw moneyError(res.failure);
  const out = res.value;
  return app.tx(() => {
    applyDisputeResult(app, out);
    const cur = app.store.disputes.must(d.id);
    cur.decision = { kind: 'adjudicated', outcome, at: app.now() };
    cur.updatedAt = app.now();
    app.store.disputes.update(cur);
    emitDispute(app, cur);
    return cur;
  });
}

// ---- refunds a person decides ----------------------------------------------------

/**
 * A person refunds part or all of a job (D-160). The cap and the no-double-refund
 * rules are in refundJob; an open dispute is refused first, because PayPal could
 * return the same money twice.
 */
export async function refundByOps(app: App, jobId: string, amountCents: number, reason: string): Promise<LedgerEntry[]> {
  const open = app.store.disputes.where('job_id = ?', jobId).filter((d) => d.status !== 'resolved');
  if (open.length > 0) {
    throw new ContractError('CONFLICT', `Dispute ${open[0]!.id} is open on this job: settle it on PayPal first, or the same money could go back twice.`, { disputeId: open[0]!.id });
  }
  const ledger = await refundJob(app, jobId, amountCents, reason);
  app.tx(() => {
    const job = app.store.jobs.must(jobId);
    if (job.refundRequest && job.refundRequest.closedAt === null) {
      job.refundRequest = { ...job.refundRequest, closedAt: app.now(), closedNote: `Refunded ${usd(amountCents)}: ${reason}` };
      job.updatedAt = app.now();
      app.store.jobs.update(job);
      emitJob(app, job);
    }
  });
  return ledger;
}

/** The requester asks for money back. A person decides; nothing moves here. */
export function requestRefund(app: App, u: User, jobId: string, reason: string): Job {
  return app.tx(() => {
    const job = app.store.jobs.must(jobId, 'job');
    if (job.requesterId !== u.id) throw new ContractError('FORBIDDEN', 'Only the requester of this job can ask for a refund.');
    if (job.amounts.capturedCents - job.amounts.refundedCents <= 0) throw new ContractError('CONFLICT', 'Nothing on this job can be refunded.');
    if (job.refundRequest && job.refundRequest.closedAt === null) throw new ContractError('CONFLICT', 'A refund request is already open on this job.');
    job.refundRequest = { reason, by: u.id, at: app.now(), closedAt: null, closedNote: null };
    job.updatedAt = app.now();
    app.store.jobs.update(job);
    emitJob(app, job);
    return job;
  });
}

/** A person closes a refund request without moving money. */
export function closeRefundRequest(app: App, jobId: string, note: string): Job {
  return app.tx(() => {
    const job = app.store.jobs.must(jobId, 'job');
    if (!job.refundRequest || job.refundRequest.closedAt !== null) throw new ContractError('INVALID_TRANSITION', 'No refund request is open on this job.');
    job.refundRequest = { ...job.refundRequest, closedAt: app.now(), closedNote: note || 'Closed without a refund.' };
    job.updatedAt = app.now();
    app.store.jobs.update(job);
    emitJob(app, job);
    return job;
  });
}
