import { disputeReasonText, findItem, findShop, formatUsd } from '@holdmyspot/shared';
import type { AiStamp, Dispute, Job, OpsRecords, Proof } from '@holdmyspot/shared';

/** One open case on the "Needs a person" page: the row the grid draws, built the same way for the replay and a live server. */
export type CaseKind = 'receipt' | 'refund' | 'dispute';

export interface CasePhoto {
  label: string;
  /** Server files are fetched with the admin header; replay photos are plain URLs. */
  fileId?: string;
  url?: string;
}

export interface PeopleCase {
  id: string;
  kind: CaseKind;
  kindLabel: string;
  who: string;
  what: string;
  amountText: string;
  why: string;
  aiNote: string | null;
  /** provider/model/mode, or null when no AI touched this case. */
  aiStamp: string | null;
  /** True when a plain template wrote the note (no model, or a provider error). */
  template: boolean;
  templateWhy: string | null;
  photos: CasePhoto[];
  attachments: string[];
  /** Ids the action buttons need. */
  proofId?: string;
  jobId?: string;
  disputeId?: string;
  /** Refund rows: the most this row may return. */
  refundableCents?: number;
  /** Dispute rows. */
  evidenceSent?: boolean;
  decided?: string | null;
  hasTracking?: boolean;
  /** Set only for a refund a person opened from the picker. */
  manual?: boolean;
}

/** Jobs a person may start a refund from (anything with money still captured). */
export interface RefundablePick {
  jobId: string;
  label: string;
  refundableCents: number;
}

const usd = (c: number) => formatUsd(c, { exact: true });

export const stampText = (ai: AiStamp): string => `${ai.provider}/${ai.model}/${ai.mode}`;

const refundableOf = (job: Job) => job.amounts.capturedCents - job.amounts.refundedCents;

function whatOf(job: Job): string {
  const name = findItem(job.itemId)?.shortName ?? 'Item';
  return `${job.qty} x ${name}`;
}

function receiptCase(proof: Proof, job: Job | null): PeopleCase {
  const failed = proof.checks.filter((c) => !c.ok);
  const why = failed.length > 0 ? failed.map((c) => c.detail).join(' ') : 'The AI and the rules could not settle this photo.';
  const r = proof.receipt;
  const read = r && (r.printedName || r.total)
    ? `Read ${[r.printedName, r.total ? (r.total.currency === 'USD' ? usd(r.total.minor) : `${r.total.currency} ${r.total.minor}`) : null, r.issuedAt?.slice(0, 16).replace('T', ' ')].filter(Boolean).join(', ')}. `
    : '';
  const capture = proof.amounts?.captureCents ?? null;
  const kindLabel = proof.kind === 'check_in' ? 'Line photo to review' : 'Receipt to review';
  return {
    id: `receipt:${proof.id}`,
    kind: 'receipt',
    kindLabel,
    who: job ? `${job.queuerName} for ${job.requesterName}` : 'Check-in',
    what: job ? whatOf(job) : 'Line photo',
    amountText: capture !== null ? `${usd(capture)} if it passes` : 'Nothing charged yet',
    why,
    aiNote: `${read}${proof.summary}`,
    aiStamp: stampText(proof.ai),
    template: false,
    templateWhy: null,
    photos: proof.fileIds.map((fileId, i) => ({ fileId, label: proof.kind === 'check_in' ? 'Line' : i === 0 ? 'Receipt' : 'Item' })),
    attachments: [],
    proofId: proof.id,
    jobId: job?.id,
  };
}

function refundCase(job: Job, why: string, manual = false): PeopleCase {
  const refundable = refundableOf(job);
  return {
    id: `refund:${job.id}`,
    kind: 'refund',
    kindLabel: 'Refund',
    who: job.requesterName,
    what: whatOf(job),
    amountText: `${usd(refundable)} refundable of ${usd(job.amounts.capturedCents)} captured`,
    why,
    aiNote: null,
    aiStamp: null,
    template: false,
    templateWhy: null,
    photos: [],
    attachments: [],
    jobId: job.id,
    refundableCents: refundable,
    manual,
  };
}

const DISPUTE_STATE: Readonly<Record<Dispute['status'], string>> = {
  open: 'PayPal has opened this case.',
  waiting_for_seller: 'PayPal is waiting for our answer.',
  under_review: 'PayPal is reviewing it.',
  resolved: '',
};

const TEMPLATE_WHY: Readonly<Record<string, string>> = {
  no_model: 'Written from the template: no AI model on this server.',
  provider_error: 'Written from the template: the AI model did not answer.',
  rejected: 'Written from the template: the AI note named a number the facts do not hold.',
};

function disputeCase(d: Dispute, job: Job | null): PeopleCase {
  const draft = d.draft ?? null;
  const decided = d.decision ? `${d.decision.kind === 'accepted' ? 'Claim accepted' : `Settled for the ${d.decision.outcome === 'buyer_favor' ? 'buyer' : 'seller'}`}; waiting for PayPal.` : null;
  return {
    id: `dispute:${d.id}`,
    kind: 'dispute',
    kindLabel: 'Dispute',
    who: job ? `${job.requesterName}, with ${job.queuerName}` : 'No job in this market',
    what: job ? whatOf(job) : `Capture ${d.captureId}`,
    amountText: `${usd(d.amount.cents)} in dispute`,
    why: `PayPal case ${d.id}: ${disputeReasonText(d.reason)}. ${DISPUTE_STATE[d.status]}`,
    aiNote: draft?.text ?? null,
    aiStamp: draft ? stampText(draft.ai) : null,
    template: draft?.template ?? false,
    templateWhy: draft?.templateReason ? (TEMPLATE_WHY[draft.templateReason] ?? null) : null,
    photos: [],
    attachments: draft?.attachments ?? [],
    disputeId: d.id,
    jobId: d.jobId ?? undefined,
    evidenceSent: d.evidenceSubmitted,
    decided,
    hasTracking: job ? job.shipment !== null : false,
  };
}

/** The open cases in a set of server records: review proofs, refund requests and open disputes. */
export function casesFromRecords(r: OpsRecords): PeopleCase[] {
  const jobs = new Map(r.jobs.map((j) => [j.id, j]));
  const cases: PeopleCase[] = [];
  for (const p of r.proofs) {
    if (p.status !== 'needs_review') continue;
    cases.push(receiptCase(p, p.jobId ? (jobs.get(p.jobId) ?? null) : null));
  }
  for (const job of r.jobs) {
    if (refundableOf(job) <= 0) continue;
    const req = job.refundRequest ?? null;
    if (req && req.closedAt === null) cases.push(refundCase(job, `${job.requesterName} asks for money back: "${req.reason}"`));
    else if (job.status === 'failed') cases.push(refundCase(job, `The job failed (${job.failure ?? 'no reason on file'}) with money still captured; the automatic refund did not finish.`));
  }
  for (const d of r.disputes) if (d.status !== 'resolved') cases.push(disputeCase(d, d.jobId ? (jobs.get(d.jobId) ?? null) : null));
  return cases;
}

/** Every job a person could refund: anything captured that is not already a row and has no open dispute. */
export function refundablePicks(r: OpsRecords, rows: readonly PeopleCase[]): RefundablePick[] {
  const taken = new Set(rows.filter((c) => c.kind === 'refund').map((c) => c.jobId));
  const disputed = new Set(r.disputes.filter((d) => d.status !== 'resolved').map((d) => d.jobId));
  return r.jobs
    .filter((j) => refundableOf(j) > 0 && !taken.has(j.id) && !disputed.has(j.id))
    .map((j) => ({ jobId: j.id, label: `${j.requesterName}: ${whatOf(j)} at ${findShop(j.shopId)?.name ?? j.shopId}, ${usd(refundableOf(j))}`, refundableCents: refundableOf(j) }));
}

/** A refund row a person opened from the picker. */
export function manualRefundCase(job: Job): PeopleCase {
  return refundCase(job, 'Opened by a person for a job with captured money.', true);
}
