import {
  DEFAULT_RULES,
  askFeeAt,
  askNextDropAt,
  askSchedule,
  checkLabel,
  clockProblem,
  distanceMeters,
  earliestEta,
  formatUsd,
  platformFeeCents,
  priceAt,
} from '@holdmyspot/shared';
import type {
  AskTask,
  Cents,
  Claim,
  Job,
  LngLat,
  LocalMoney,
  MarketRules,
  Payout,
  Proof,
  ProofCheck,
  ProofCheckCode,
  Shop,
  StepDownSchedule,
} from '@holdmyspot/shared';

/**
 * The queuer's errand as plain functions: which step a visit is on, the
 * geofence, countdowns, the AI check as rows a person can read, the payout
 * summary with the realized hourly rate, and the offer form's checks. No
 * React and no network here, so all of it is covered by logic.test.ts.
 */

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** One visit: the claim (with its ask), the jobs matched to it, the line photo check and each job's purchase check. */
export interface Errand {
  claim: Claim;
  ask: AskTask | null;
  jobs: Job[];
  /** The latest line-photo check of this claim, if any. */
  lineProof: Proof | null;
  /** The latest purchase check per job id. */
  purchaseProofs: Record<string, Proof | undefined>;
  /** Payouts per job id, oldest first. */
  payouts: Record<string, Payout[] | undefined>;
}

export type JobStage =
  | 'waiting_check_in' // matched; the visit has not cleared check-in yet
  | 'in_line' // checked in: buy, or report a sell-out
  | 'proof' // bought: upload the receipt and the item photo
  | 'verifying' // photos sent; the AI check runs
  | 'review' // the AI could not decide; a person reviews
  | 'finish' // verified: ship (tracking) or hand over (code)
  | 'paid' // shipped or delivered; payouts follow the captures
  | 'rejected' // the purchase check failed: nothing captured
  | 'sold_out'
  | 'no_show'
  | 'ended'; // any other failure or refund

export type ErrandStage =
  | 'arrival' // on the way: arrival window running
  | 'checking' // line photo being checked (or with a person)
  | 'waiting' // in line, no request matched yet (an offer waiting for its fee to meet one)
  | 'in_line'
  | 'proof'
  | 'verifying'
  | 'finish'
  | 'paid'
  | 'rejected'
  | 'sold_out'
  | 'lapsed'
  | 'cancelled'
  | 'ended';

/** The records the queuer's phone keeps, latest per id. */
export interface QueuerRecords {
  claims: Record<string, Claim>;
  asks: Record<string, AskTask>;
  jobs: Record<string, Job>;
  proofs: Record<string, Proof>;
  payouts: Record<string, Payout>;
}

const newestFirst = <T extends { id: string; createdAt: number }>(a: T, b: T) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);

/** How far each record is along its state machine, to break ties between two copies of the same moment. */
const RANKS = {
  claim: { awaiting_arrival: 0, arrived: 1, checked_in: 2, done: 3, lapsed: 3, cancelled: 3 } as Record<Claim['status'], number>,
  job: { claimed: 0, checked_in: 1, queueing: 2, bought: 3, proof_submitted: 4, verified: 5, shipped: 6, delivered: 7, failed: 8, refunded: 9 } as Record<Job['status'], number>,
  proof: { verifying: 0, needs_review: 1, passed: 2, failed: 2 } as Record<Proof['status'], number>,
  payout: { pending: 0, unclaimed: 1, succeeded: 2, failed: 2, returned: 3, cancelled: 3 } as Record<Payout['status'], number>,
  ask: { open: 0, filled: 1, withdrawn: 2, lapsed: 3, closed: 3 } as Record<AskTask['status'], number>,
};

type Versioned =
  | { kind: 'claim'; rec: Claim }
  | { kind: 'job'; rec: Job }
  | { kind: 'proof'; rec: Proof }
  | { kind: 'payout'; rec: Payout }
  | { kind: 'ask'; rec: AskTask };

function versionOf(v: Versioned): [number, number] {
  switch (v.kind) {
    case 'proof':
      return [v.rec.decidedAt ?? v.rec.createdAt, RANKS.proof[v.rec.status]];
    case 'claim':
      return [v.rec.updatedAt, RANKS.claim[v.rec.status]];
    case 'job':
      return [v.rec.updatedAt, RANKS.job[v.rec.status]];
    case 'payout':
      return [v.rec.updatedAt, RANKS.payout[v.rec.status]];
    case 'ask':
      return [v.rec.updatedAt, RANKS.ask[v.rec.status]];
  }
}

/**
 * True when `incoming` is an older copy than `existing`: an HTTP answer can
 * arrive after the event stream already brought a newer state (the AI check
 * finishes in milliseconds), and must not roll the screen back.
 */
export function isStale<K extends Versioned['kind']>(kind: K, existing: Extract<Versioned, { kind: K }>['rec'] | undefined, incoming: Extract<Versioned, { kind: K }>['rec']): boolean {
  if (!existing) return false;
  const [ta, ra] = versionOf({ kind, rec: existing } as Versioned);
  const [tb, rb] = versionOf({ kind, rec: incoming } as Versioned);
  return tb < ta || (tb === ta && rb < ra);
}

/** One visit put together from the records, or null when the claim is unknown. */
export function buildErrand(r: QueuerRecords, claimId: string): Errand | null {
  const claim = r.claims[claimId];
  if (!claim) return null;
  const jobs = Object.values(r.jobs)
    .filter((j) => j.claimId === claimId)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const proofs = Object.values(r.proofs).sort(newestFirst);
  const purchaseProofs: Errand['purchaseProofs'] = {};
  const payouts: Errand['payouts'] = {};
  for (const j of jobs) {
    purchaseProofs[j.id] = proofs.find((p) => p.kind === 'purchase' && p.jobId === j.id);
    payouts[j.id] = Object.values(r.payouts)
      .filter((p) => p.reference === j.id)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }
  return {
    claim,
    ask: r.asks[claim.askId] ?? null,
    jobs,
    lineProof: proofs.find((p) => p.kind === 'check_in' && p.claimId === claimId) ?? null,
    purchaseProofs,
    payouts,
  };
}

/** The visit to show: the newest one the queuer still has something to do on (a claim is done once everything is bought, but the proof, tracking or handover may still be ahead), else null. */
export function activeClaimId(r: QueuerRecords): string | null {
  for (const c of Object.values(r.claims).sort(newestFirst)) {
    const e = buildErrand(r, c.id);
    if (e && !isFinished(errandStage(e))) return c.id;
  }
  return null;
}

/** The steps the tracker at the top of the errand shows. */
export const ERRAND_STEPS = ['Arrive', 'Check in', 'In line', 'Proof', 'Finish', 'Paid'] as const;

export function jobStage(job: Job, proof: Proof | null | undefined): JobStage {
  switch (job.status) {
    case 'claimed':
    case 'checked_in':
      return 'waiting_check_in';
    case 'queueing':
      return 'in_line';
    case 'bought':
      return 'proof';
    case 'proof_submitted':
      return proof?.status === 'needs_review' ? 'review' : 'verifying';
    case 'verified':
      return 'finish';
    case 'shipped':
    case 'delivered':
      return 'paid';
    case 'failed':
      if (job.failure?.reason === 'proof_rejected') return 'rejected';
      if (job.failure?.reason === 'sold_out') return 'sold_out';
      if (job.failure?.reason === 'no_show') return 'no_show';
      return 'ended';
    case 'refunded':
      return 'ended';
  }
}

const JOB_ORDER: JobStage[] = ['waiting_check_in', 'in_line', 'proof', 'verifying', 'review', 'finish', 'paid', 'rejected', 'sold_out', 'no_show', 'ended'];

/** The job the errand is about now: the one furthest behind that still needs the queuer, else the latest. */
export function currentJob(e: Pick<Errand, 'jobs' | 'purchaseProofs'>): Job | null {
  if (e.jobs.length === 0) return null;
  const ranked = [...e.jobs].sort((a, b) => JOB_ORDER.indexOf(jobStage(a, e.purchaseProofs[a.id])) - JOB_ORDER.indexOf(jobStage(b, e.purchaseProofs[b.id])) || (a.id < b.id ? -1 : 1));
  return ranked[0] ?? null;
}

export function errandStage(e: Errand): ErrandStage {
  const { claim } = e;
  if (claim.status === 'lapsed') return 'lapsed';
  if (claim.status === 'cancelled') return 'cancelled';
  if (claim.status === 'awaiting_arrival') return 'arrival';
  if (claim.status === 'arrived') {
    const p = e.lineProof;
    return p && (p.status === 'verifying' || p.status === 'needs_review') ? 'checking' : 'arrival';
  }
  const job = currentJob(e);
  if (!job) return claim.status === 'done' ? 'ended' : 'waiting';
  const stage = jobStage(job, e.purchaseProofs[job.id]);
  switch (stage) {
    case 'waiting_check_in':
      return 'checking';
    case 'review':
      return 'verifying';
    case 'no_show':
      return 'lapsed';
    default:
      return stage;
  }
}

/** Index into ERRAND_STEPS for the tracker (the step in progress). */
export function stepIndex(stage: ErrandStage): number {
  switch (stage) {
    case 'arrival':
    case 'lapsed':
    case 'cancelled':
      return 0;
    case 'checking':
      return 1;
    case 'waiting':
    case 'in_line':
    case 'sold_out':
      return 2;
    case 'proof':
    case 'verifying':
    case 'rejected':
      return 3;
    case 'finish':
      return 4;
    case 'paid':
    case 'ended':
      return 5;
  }
}

/** Live visits come first; the rest are finished. */
export function isLiveClaim(c: Pick<Claim, 'status'>): boolean {
  return c.status === 'awaiting_arrival' || c.status === 'arrived' || c.status === 'checked_in';
}

/** True when nothing is left for the queuer to do on this visit. */
export function isFinished(stage: ErrandStage): boolean {
  return stage === 'paid' || stage === 'rejected' || stage === 'sold_out' || stage === 'lapsed' || stage === 'cancelled' || stage === 'ended';
}

/** The errand sheet's fine print, in the words of the mode banner every screen carries (`useModeBanner`). */
export function errandFinePrint(banner: string): string {
  return `${banner}, US dollars throughout. Your codes are shown only on this phone.`;
}

// ---------------------------------------------------------------------------
// Place and time
// ---------------------------------------------------------------------------

/** How far the queuer stands from the shop, and whether that is inside its check-in radius. */
export function fenceOf(at: LngLat, shop: Pick<Shop, 'lngLat' | 'geofenceMeters'>): { distanceM: number; inside: boolean } {
  const distanceM = Math.round(distanceMeters(at, shop.lngLat));
  return { distanceM, inside: distanceM <= shop.geofenceMeters };
}

/** "9:05" or "1:02:03" (counts down to zero, never negative). */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** A countdown or a timer that never reads like a time of day: "11m 57s", "1h 08m". */
export function countText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s).padStart(2, '0')}s`;
}

/** "45 s", "12 min", "1 h 10 min". */
export function durationText(ms: number): string {
  const min = Math.round(Math.max(0, ms) / 60_000);
  if (min < 1) return `${Math.max(0, Math.round(ms / 1000))} s`;
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

/** "Mia R." to "Mia". */
export const firstName = (displayName: string) => displayName.split(' ')[0] ?? displayName;

/** "10:44 AM" in the shop's own time zone. */
export function timeIn(t: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(t);
}

/** When a job entered a status (from its history), or null. */
export function enteredAt(job: Pick<Job, 'history'>, status: Job['status']): number | null {
  const hit = [...job.history].reverse().find((h) => h.status === status);
  return hit ? hit.at : null;
}

// ---------------------------------------------------------------------------
// The fee
// ---------------------------------------------------------------------------

export interface LiveFee {
  feeCents: Cents;
  /** The clock runs (it starts at check-in). */
  running: boolean;
  /** The clock exists but waits for the check-in. */
  waiting: boolean;
  nextAt: number | null;
  nextCents: Cents | null;
  floorCents: Cents | null;
  schedule: StepDownSchedule | null;
}

/** An offer's fee now: fixed, the opening fee before check-in, or the stepping clock after. */
export function liveFee(ask: Pick<AskTask, 'feeCents' | 'clock'>, now: number): LiveFee {
  const schedule = askSchedule(ask);
  const nextAt = askNextDropAt(ask, now);
  return {
    feeCents: askFeeAt(ask, now),
    running: schedule !== null,
    waiting: ask.clock !== null && schedule === null,
    nextAt,
    nextCents: schedule && nextAt !== null ? priceAt(schedule, nextAt) : null,
    floorCents: ask.clock?.floorCents ?? null,
    schedule,
  };
}

/** What the queuer keeps of a job's queue fee after HoldMySpot's share (the rest is reimbursement at cost). */
export function keptFeeCents(job: Pick<Job, 'feeCents' | 'qty'>, rules: Pick<MarketRules, 'platformFeeBps'> = DEFAULT_RULES): Cents {
  const fee = job.feeCents * job.qty;
  return fee - platformFeeCents(fee, rules.platformFeeBps);
}

/** Time the errand took: from taking the task (the claim) to the purchase (or the proof, if "Bought" was skipped). */
export function timeSpentMs(claim: Pick<Claim, 'createdAt'>, job: Pick<Job, 'history'>): number | null {
  const end = enteredAt(job, 'bought') ?? enteredAt(job, 'proof_submitted');
  return end === null ? null : Math.max(0, end - claim.createdAt);
}

/** Cents per hour of what the queuer kept of the fee, over the time spent. */
export function realizedPerHour(keptCents: Cents, ms: number | null): number | null {
  if (ms === null || ms <= 0) return null;
  return Math.round((keptCents * 3_600_000) / ms);
}

/** "$9.26/h". */
export function perHourText(centsPerHour: number | null): string {
  return centsPerHour === null ? '–' : `${formatUsd(centsPerHour, { exact: true })}/h`;
}

export interface PayoutLine {
  id: string;
  label: string;
  cents: Cents;
  status: Payout['status'];
}

export interface PayoutSummary {
  /** Sent by PayPal Payouts (succeeded). */
  paidCents: Cents;
  /** Waiting for PayPal. */
  pendingCents: Cents;
  lines: PayoutLine[];
}

const PURPOSE_LABEL: Record<Payout['purpose'], string> = {
  fee: 'Queue fee, after HoldMySpot’s 10%',
  reimbursement: 'Shop price and shipping, at cost',
  fee_and_reimbursement: 'Shop price at cost and the queue fee, after HoldMySpot’s 10%',
};

export function payoutSummary(payouts: readonly Payout[]): PayoutSummary {
  let paidCents = 0;
  let pendingCents = 0;
  const lines = [...payouts]
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .map((p) => {
      if (p.status === 'succeeded') paidCents += p.amount.cents;
      else if (p.status === 'pending' || p.status === 'unclaimed') pendingCents += p.amount.cents;
      return { id: p.id, label: PURPOSE_LABEL[p.purpose], cents: p.amount.cents, status: p.status };
    });
  return { paidCents, pendingCents, lines };
}

// ---------------------------------------------------------------------------
// Offer form
// ---------------------------------------------------------------------------

export interface OfferForm {
  feeCents: Cents;
  /** null: a fixed fee. */
  clock: { stepCents: Cents; intervalMs: number; floorCents: Cents } | null;
  etaAt: number;
  capacity: number;
}

/** ETA choices the server accepts: from the honest trip (plus a minute) up to 30 minutes after the earliest arrival by the market's rule. */
export function etaChoices(now: number, from: LngLat, shop: LngLat, tripMinutes: number, rules: Pick<MarketRules, 'travelMetersPerMinute' | 'maxTravelMinutes'> = DEFAULT_RULES): number[] {
  const first = now + (tripMinutes + 1) * 60_000;
  // A minute of slack under the server's latest, for the trip to the server.
  const last = earliestEta(from, shop, now, rules) + (rules.maxTravelMinutes - 1) * 60_000;
  const out: number[] = [first];
  for (const extra of [5, 10, 15, 20, 30]) {
    const t = first + extra * 60_000;
    if (t <= last) out.push(t);
  }
  return out;
}

/** What is wrong with an offer before it is sent (the server checks the same), or null. */
export function offerProblem(form: OfferForm, item: { minFeeCents: Cents; perPersonLimit: number }): string | null {
  if (!Number.isInteger(form.feeCents) || form.feeCents < item.minFeeCents) return `The fee must be at least ${formatUsd(item.minFeeCents, { exact: true })}.`;
  if (!Number.isInteger(form.capacity) || form.capacity < 1 || form.capacity > item.perPersonLimit) return `You can buy 1 to ${item.perPersonLimit} for others on one visit.`;
  if (form.clock) {
    const problem = clockProblem(form.feeCents, form.clock);
    if (problem) return problem;
    if (form.clock.floorCents < item.minFeeCents) return `The floor must be at least ${formatUsd(item.minFeeCents, { exact: true })}.`;
  }
  return null;
}

/** The step-down a new offer would run, starting at a check-in at `startsAt` (a preview). */
export function previewSchedule(form: Pick<OfferForm, 'feeCents' | 'clock'>, startsAt: number): StepDownSchedule | null {
  if (!form.clock) return null;
  return { openCents: form.feeCents, stepCents: form.clock.stepCents, intervalMs: form.clock.intervalMs, floorCents: form.clock.floorCents, startsAt };
}

// ---------------------------------------------------------------------------
// The AI check, as rows
// ---------------------------------------------------------------------------

export interface CheckRow {
  label: string;
  /** What was read or measured. */
  value: string;
  /** null: not checked (or not read yet). */
  ok: boolean | null;
  detail: string | null;
}

export interface CheckView {
  status: Proof['status'];
  title: string;
  summary: string;
  stamp: string;
  rows: CheckRow[];
  /** Failed checks with their reasons, hard ones first. */
  flags: { label: string; detail: string; hard: boolean }[];
}

/** "$34.00" for USD minor units, "NT$1,100" for TWD. */
export function localMoneyText(m: LocalMoney | null): string {
  if (!m) return '–';
  if (m.currency === 'USD') return formatUsd(m.minor, { exact: true });
  return `NT$${m.minor.toLocaleString('en-US')}`;
}

/** "Checked by AI and rules · muse-spark-1.3 (replay)" (docs/DOMAIN.md section 9). */
export function stampText(ai: Proof['ai']): string {
  const how = ai.mode === 'live' ? 'live' : ai.mode === 'record' ? 'live, recorded' : ai.mode === 'replay' ? 'replay of a saved answer' : 'rules only';
  return `Checked by AI and rules · ${ai.provider} ${ai.model} (${how})`;
}

function find(checks: readonly ProofCheck[], code: ProofCheckCode): ProofCheck | undefined {
  return checks.find((c) => c.code === code);
}

function both(checks: readonly ProofCheck[], codes: ProofCheckCode[]): { ok: boolean | null; detail: string | null } {
  const hits = codes.map((c) => find(checks, c)).filter((c): c is ProofCheck => !!c);
  if (hits.length === 0) return { ok: null, detail: null };
  const bad = hits.find((c) => !c.ok);
  return { ok: !bad, detail: (bad ?? hits[0]!).detail };
}

function flagsOf(checks: readonly ProofCheck[]): CheckView['flags'] {
  return checks
    .filter((c) => !c.ok)
    .sort((a, b) => (a.weight === b.weight ? 0 : a.weight === 'hard' ? -1 : 1))
    .map((c) => ({ label: checkLabel(c.code), detail: c.detail, hard: c.weight === 'hard' }));
}

const TITLES: Record<Proof['status'], string> = {
  verifying: 'Checking',
  passed: 'Passed',
  failed: 'Failed',
  needs_review: 'A person will check',
};

/** The line photo check as rows: code, place, line, photo. */
export function lineCheckView(proof: Proof, claim: Pick<Claim, 'checkInCode' | 'arrival'>): CheckView {
  const c = proof.checks;
  const code = find(c, 'code_visible');
  const fence = find(c, 'geofence');
  const line = find(c, 'line_visible');
  const dup = find(c, 'duplicate_photo');
  const rows: CheckRow[] = [
    { label: 'Code', value: claim.checkInCode ?? '–', ok: code ? code.ok : null, detail: code?.detail ?? null },
    { label: 'Place', value: claim.arrival ? `${claim.arrival.distanceM} m from the shop` : '–', ok: fence ? fence.ok : null, detail: fence?.detail ?? null },
    {
      label: 'Line',
      value: proof.peopleAhead !== null ? `about ${proof.peopleAhead} people ahead` : line?.ok ? 'visible' : '–',
      ok: line ? line.ok : null,
      detail: line?.detail ?? null,
    },
    { label: 'Photo', value: dup ? (dup.ok ? 'new' : 'used before') : '–', ok: dup ? dup.ok : null, detail: dup?.detail ?? null },
  ];
  return { status: proof.status, title: TITLES[proof.status], summary: proof.summary, stamp: stampText(proof.ai), rows, flags: flagsOf(c) };
}

/** The receipt and item photo check as rows: store, time, items, totals, code, photos, money. */
export function purchaseCheckView(
  proof: Proof,
  job: Pick<Job, 'proofCode' | 'qty' | 'caps' | 'feeCents'>,
  shop: Pick<Shop, 'name' | 'timezone'>,
  checkedInAt: number | null,
): CheckView {
  const c = proof.checks;
  const r = proof.receipt;
  const storeId = r?.qr?.sellerTaxId ?? r?.sellerTaxId ?? null;
  const store = both(c, ['shop_match']);
  const time = both(c, ['time_window']);
  const items = both(c, ['item_match', 'qty_within_limit']);
  const totals = both(c, ['totals_add_up', 'qr_matches_print']);
  const code = both(c, ['code_visible']);
  const photos = both(c, ['duplicate_photo', 'generator_metadata']);
  const cap = both(c, ['within_retail_cap']);
  const printed = r?.issuedAt ? timeIn(Date.parse(r.issuedAt), shop.timezone) : null;
  const lines = r?.lines ?? [];
  const retail = proof.amounts?.retailCents ?? null;
  const capture = proof.amounts?.captureCents ?? null;
  const processing = proof.amounts?.processingCents ?? null;
  const rows: CheckRow[] = [
    { label: 'Store', value: r?.printedName ? `${r.printedName}${storeId ? ` · store ID ${storeId}` : ''}` : '–', ...store },
    {
      label: 'Time',
      value: printed ? `printed ${printed}${checkedInAt !== null ? `, check-in ${timeIn(checkedInAt, shop.timezone)}` : ''}` : '–',
      ...time,
    },
    {
      label: 'Items',
      value: lines.length > 0 ? lines.map((l) => `${l.qty} × ${l.name} ${localMoneyText(l.total)}`).join('; ') : '–',
      ...items,
    },
    { label: 'Totals', value: r?.total ? `total ${localMoneyText(r.total)}${r.qr ? ', QR read' : ''}` : '–', ...totals },
    { label: 'Job code', value: r?.codeSeen ? `${r.codeSeen}${job.proofCode ? ` (yours: ${job.proofCode})` : ''}` : job.proofCode ? `expected ${job.proofCode}` : '–', ...code },
    { label: 'Photos', value: photos.ok === false ? 'flagged' : photos.ok ? 'new, no generator marks' : '–', ...photos },
    proof.status === 'failed'
      ? { label: 'Money', value: '$0 moved: nothing captured', ok: null, detail: null }
      : {
          label: 'Money',
          value:
            retail !== null
              ? `shop price ${formatUsd(retail, { exact: true })} (cap ${formatUsd(job.caps.retailCents, { exact: true })})${
                  capture !== null
                    ? ` + fee ${formatUsd(job.caps.feeCents, { exact: true })}${processing ? ` + processing ${formatUsd(processing, { exact: true })} at cost` : ''} = ${formatUsd(capture, { exact: true })}`
                    : ''
                }`
              : '–',
          ...cap,
        },
  ];
  return { status: proof.status, title: TITLES[proof.status], summary: proof.summary, stamp: stampText(proof.ai), rows, flags: flagsOf(c) };
}

/** One plain sentence for a job that ended without a purchase or a payment. */
export function failureText(job: Pick<Job, 'failure' | 'requesterName'>): string {
  const who = job.requesterName;
  switch (job.failure?.reason) {
    case 'proof_rejected':
      return `Nothing was captured: $0 moved. ${who}'s request went back to the book and the PayPal hold stays as it was.`;
    case 'sold_out':
      return `Sold out: nothing was bought or charged. Every open request for it closed, ${who}'s included, and PayPal released those holds.`;
    case 'no_show':
      return `The arrival window ended before check-in. ${who}'s request went back to the book; nothing was charged.`;
    case 'queuer_withdrew':
      return `You ended the visit before buying. ${who}'s request went back to the book; nothing was charged.`;
    case 'payment_failed':
      return `PayPal declined the charge, so nothing was taken. Keep the item until ops follows up.`;
    case undefined:
      return 'This job ended.';
    default:
      return job.failure?.detail ?? 'This job ended.';
  }
}
