import { JOB_BEFORE_PURCHASE, askFeeAt, distanceMeters, formatUsd, travelMinutes } from '@holdmyspot/shared';
import type { AiStamp, Job, LngLat, MarketMs, OpsMove, UserId } from '@holdmyspot/shared';
import { MINUTE, clockText } from '../data/time.ts';
import { jobEnd, positionsAt } from '../data/mock/views.ts';
import { MAX_SHIFT_MINUTES, RULES_STAMP, applyOpsMove, getBid, itemById, opsMoveProblem, shopById } from '../data/mock/world.ts';
import type { OpsAction, World } from '../data/mock/world.ts';

/**
 * The rescheduler (D-101): an agent that drives the queuer board.
 *
 * 1. Rules find the trouble: a queuer who cannot reach the shop before the
 *    arrival window closes (or whose ETA passed without a check-in), and a
 *    job whose requester's PayPal hold can no longer pay.
 * 2. Rules list every move they would allow, each dry-run on a copy of the
 *    world so the board can draw it: reassign the job to another queuer's
 *    offer (at that offer's fee now, at or under the request's max fee),
 *    shift the late queuer's window, release the late queuer so the rules
 *    re-offer the job, or free a queuer's units from a hold that cannot pay.
 * 3. A model on the server's AI port picks one option per problem and says
 *    why (agents/reschedulerAgent.ts); without one the rules pick, and the
 *    card says so. The model never invents a move or an amount: it can only
 *    choose an option the rules built, and approving sends that option's
 *    moves to the server (POST /api/ops/moves), which checks them again.
 *
 * The same code runs on the console's replay and on the live server's
 * records (data/serverWorld.ts builds the same World).
 */

/** A bar the board draws for a dry run: where a job would run after the move. */
export interface ProposedMove {
  jobId: string;
  queuerId: UserId;
  queuerName: string;
  requesterName: string;
  qty: number;
  feeCents: number;
  startAt: MarketMs;
  endAt: MarketMs;
}

/** One move the rules allow for a problem, with its dry run. */
export interface ProposalOption {
  id: string;
  kind: OpsMove['kind'];
  /** Button text: what approving does, in a few words. */
  label: string;
  /** One sentence with the numbers behind it. */
  detail: string;
  moves: OpsMove[];
  ghosts: ProposedMove[];
  /** A shifted arrival window, drawn on the late queuer's row. */
  window: { queuerId: UserId; from: MarketMs; to: MarketMs; minutes: number } | null;
  /** The rules' preference: the highest wins when no model chooses. */
  score: number;
}

export interface Proposal {
  id: string;
  kind: 'late' | 'hold';
  severity: 'warning' | 'critical';
  title: string;
  /** What is wrong, in one sentence. */
  problem: string;
  /** Why the chosen option, in one or two sentences (the model's words, or the rules'). */
  summary: string;
  facts: string[];
  queuerId: UserId;
  shopId: string;
  raisedAt: MarketMs;
  /** When the market rules act on their own if nobody approves. */
  rulesActAt: MarketMs | null;
  affectedJobIds: string[];
  options: ProposalOption[];
  chosenId: string | null;
  decidedBy: 'model' | 'rules';
  /** The model was asked and has not answered yet. */
  thinking: boolean;
  /** The chosen option's dry run (ghost bars). */
  moves: ProposedMove[];
  status: 'open' | 'approved' | 'applied_by_rules';
  approvedAt: MarketMs | null;
  /** The approved option's label, for a closed card. */
  outcome: string | null;
  ai: AiStamp;
}

const usd = (c: number) => formatUsd(c, { exact: true });
const first = (name: string) => name.split(' ')[0] ?? name;

function what(job: Job): string {
  const item = itemById(job.itemId);
  const one: Record<string, string> = { cake: 'cake', plush: 'plush', ramen: 'ramen' };
  const many: Record<string, string> = { cake: 'cakes', plush: 'plush toys', ramen: 'ramen bowls' };
  return job.qty === 1 ? (one[item.kind] ?? item.kind) : `${job.qty} ${many[item.kind] ?? item.kind}`;
}

/** Jobs a move created on the copy: the ghost bars. */
function dryRun(w: World, t: MarketMs, moves: OpsMove[], reason: string): { ghosts: ProposedMove[]; ok: boolean } {
  const copy = structuredClone(w);
  const known = new Set(w.jobs.map((j) => j.id));
  let ok = true;
  for (const move of moves) ok = applyOpsMove(copy, { at: t, proposalId: null, move, reason, label: '', ai: RULES_STAMP }) && ok;
  const ghosts = copy.jobs
    .filter((j) => !known.has(j.id))
    .map((j) => ({ jobId: j.id, queuerId: j.queuerId, queuerName: j.queuerName, requesterName: j.requesterName, qty: j.qty, feeCents: j.feeCents, startAt: t, endAt: jobEnd(copy, j, t) }));
  return { ghosts, ok };
}

function same(a: LngLat | undefined, b: LngLat | undefined): boolean {
  return !!a && !!b && Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

/** Problems open at `t`, with every option the rules allow. */
export function findProblems(w: World, t: MarketMs): Proposal[] {
  const out: Proposal[] = [];
  const here = positionsAt(w, t);
  const before = positionsAt(w, t - 3 * MINUTE);

  // 1. Late queuers.
  for (const claim of w.claims) {
    if ((claim.status !== 'awaiting_arrival' && claim.status !== 'arrived') || claim.createdAt > t) continue;
    const jobs = w.jobs.filter((j) => j.claimId === claim.id && JOB_BEFORE_PURCHASE.includes(j.status) && j.createdAt <= t);
    if (jobs.length === 0) continue;
    const shop = shopById(claim.shopId);
    const ask = w.asks.find((a) => a.id === claim.askId);
    const pos = here[claim.queuerId];
    const travel = pos ? travelMinutes(pos, shop.lngLat) : null;
    const left = Math.floor((claim.windowEndsAt - t) / MINUTE);
    const behind = travel !== null && travel + 1 > left;
    const etaPassed = !!ask && t > ask.etaAt + 3 * MINUTE;
    if (!behind && !etaPassed) continue;
    const raisedAt = behind && travel !== null ? Math.max(claim.createdAt, claim.windowEndsAt - (travel + 1) * MINUTE) : (ask?.etaAt ?? t) + 3 * MINUTE;
    const moving = !same(pos, before[claim.queuerId]);
    const name = claim.queuerName;
    const km = pos ? (distanceMeters(pos, shop.lngLat) / 1000).toFixed(1) : null;
    const main = jobs[0]!;
    const bid = getBid(w, main.bidId);
    // Two kinds of evidence: the (demo) walk says he cannot make it, or his own ETA passed without a check-in.
    const facts = [
      ...(behind && km !== null && travel !== null
        ? [
            `${name} is ${km} km from ${shop.name} and needs about ${travel} min; the window closes at ${clockText(claim.windowEndsAt)} (${Math.max(0, left)} min left)`,
            moving ? `${name} is moving (demo walk)` : `${name} has not moved in the last 3 minutes (demo walk)`,
          ]
        : [
            `${name}'s ETA was ${clockText(ask?.etaAt ?? t)}; ${Math.round((t - (ask?.etaAt ?? t)) / MINUTE)} min later there is no check-in`,
            `The window closes at ${clockText(claim.windowEndsAt)} (${Math.max(0, left)} min left)`,
          ]),
      ...jobs.map((j) => `${j.requesterName}'s ${what(j)}: fee ${usd(j.feeCents)}${j.qty > 1 ? ' each' : ''}, max ${usd(getBid(w, j.bidId).maxFeeCents)}`),
    ];
    const options: ProposalOption[] = [];
    const reason = `${name} cannot reach ${shop.name} in time.`;

    // Reassign: every other offer at this shop the rules accept for all of these jobs.
    const targets = w.asks.filter((a) => a.shopId === claim.shopId && a.itemId === main.itemId && a.status === 'open' && a.queuerId !== claim.queuerId);
    for (const target of targets) {
      const moves: OpsMove[] = jobs.map((j) => ({ kind: 'reassign', jobId: j.id, toAskId: target.id }));
      if (moves.some((m) => opsMoveProblem(w, m, t) !== null)) continue;
      if (target.remainingCapacity < jobs.reduce((n, j) => n + j.qty, 0)) continue;
      const tc = w.claims.find((c) => c.id === target.claimId);
      const inLine = tc?.status === 'checked_in';
      const fee = askFeeAt(target, t);
      const run = dryRun(w, t, moves, reason);
      if (!run.ok) continue;
      const state = inLine ? `in line since ${clockText(tc?.checkedInAt ?? t)}` : `on the way, ETA ${clockText(target.etaAt)}`;
      const beatsLate = travel === null || target.etaAt < t + travel * MINUTE;
      options.push({
        id: `reassign:${target.id}`,
        kind: 'reassign',
        label: `Move to ${target.queuerName} at ${usd(fee)}`,
        detail: `${target.queuerName} is ${state} and asks ${usd(fee)} now, at or under ${bid.requesterName}'s max of ${usd(bid.maxFeeCents)}.`,
        moves,
        ghosts: run.ghosts,
        window: null,
        score: inLine ? 30 : beatsLate ? 15 : 5,
      });
    }

    // Shift the window: by what the walk says he still needs, or ten minutes when only his ETA passed.
    if (travel !== null || etaPassed) {
      const minutes = behind && travel !== null ? Math.max(1, travel + 2 - left) : 10;
      const move: OpsMove = { kind: 'extend', claimId: claim.id, minutes };
      if (minutes <= MAX_SHIFT_MINUTES && opsMoveProblem(w, move, t) === null) {
        options.push({
          // A stable id: the minutes change as the clock runs, the option does not.
          id: 'extend',
          kind: 'extend',
          label: `Give ${name} ${minutes} more min`,
          detail: `The window would close at ${clockText(claim.windowEndsAt + minutes * MINUTE)}; ${bid.requesterName}'s request waits that long${behind && !moving ? `, although ${name} has not moved lately` : ''}.`,
          moves: [move],
          ghosts: [],
          window: { queuerId: claim.queuerId, from: claim.windowEndsAt, to: claim.windowEndsAt + minutes * MINUTE, minutes },
          score: !behind ? 14 : moving ? (minutes <= 10 ? 25 : 18) : 4,
        });
      }
    }

    // Release: the jobs go back to the line-up now instead of at the window's end.
    {
      const moves: OpsMove[] = [{ kind: 'release', claimId: claim.id }];
      const run = dryRun(w, t, moves, reason);
      const takers = run.ghosts.map((g) => `${g.queuerName} at ${usd(g.feeCents)}`).join(' and ');
      options.push({
        id: 'release',
        kind: 'release',
        label: `Release ${name} now`,
        detail: takers ? `The rules re-offer the job at once; ${takers} would take it.` : 'The job goes back to the line-up at once; no offer would take it yet.',
        moves,
        ghosts: run.ghosts,
        window: null,
        score: takers ? 12 : 8,
      });
    }

    out.push({
      id: `late:${claim.id}`,
      kind: 'late',
      severity: 'warning',
      title: `${first(name)} will miss check-in`,
      problem: `${name} cannot reach ${shop.name} before ${clockText(claim.windowEndsAt)}.`,
      summary: '',
      facts,
      queuerId: claim.queuerId,
      shopId: claim.shopId,
      raisedAt,
      rulesActAt: claim.windowEndsAt,
      affectedJobIds: jobs.map((j) => j.id),
      options,
      chosenId: null,
      decidedBy: 'rules',
      thinking: false,
      moves: [],
      status: 'open',
      approvedAt: null,
      outcome: null,
      ai: RULES_STAMP,
    });
  }

  // 2. Jobs on a PayPal hold that can no longer pay.
  const byBid = new Map<string, Job[]>();
  for (const job of w.jobs) {
    if (!JOB_BEFORE_PURCHASE.includes(job.status) || job.createdAt > t) continue;
    const hold = w.holds.find((h) => h.id === getBid(w, job.bidId).holdId);
    if (!hold?.renewalRequired || hold.updatedAt > t) continue;
    byBid.set(job.bidId, [...(byBid.get(job.bidId) ?? []), job]);
  }
  for (const [bidId, jobs] of byBid) {
    const bid = getBid(w, bidId);
    const hold = w.holds.find((h) => h.id === bid.holdId)!;
    const job = jobs[0]!;
    const moves: OpsMove[] = jobs.map((j) => ({ kind: 'release_job', jobId: j.id }));
    const run = dryRun(w, t, moves, `${bid.requesterName}'s hold cannot pay.`);
    const names = run.ghosts.map((g) => first(g.requesterName));
    const fee = run.ghosts[0]?.feeCents ?? job.feeCents;
    const funding = hold.fundingSource === 'venmo' ? 'Venmo ' : '';
    out.push({
      id: `hold:${bidId}`,
      kind: 'hold',
      severity: 'critical',
      title: `${first(bid.requesterName)}'s PayPal hold needs a new approval`,
      problem: `PayPal could not renew ${first(bid.requesterName)}'s ${funding}hold, and ${job.queuerName} is lined up for ${what(job)}.`,
      summary: '',
      facts: [
        `Hold of ${usd(hold.amount.cents)} approved ${new Date(hold.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' })}${funding ? ' with Venmo' : ''}; its honor period is over`,
        `${job.queuerName} would buy on a hold that may not capture`,
        names.length ? `${names.join(' and ')} have usable holds and accept ${usd(fee)}` : 'No other request can take the units now',
      ],
      queuerId: job.queuerId,
      shopId: job.shopId,
      raisedAt: hold.updatedAt,
      rulesActAt: null,
      affectedJobIds: jobs.map((j) => j.id),
      options: [
        {
          id: 'release_job',
          kind: 'release_job',
          label: names.length ? `Give them to ${names.join(' and ')}` : `Free ${job.queuerName}'s units`,
          detail: names.length
            ? `${job.queuerName}'s ${what(job)} go to ${names.join(' and ')} at ${usd(fee)} each; ${first(bid.requesterName)} keeps the place in line once a new hold is approved.`
            : `${job.queuerName}'s units go back to the line-up for the next request.`,
          moves,
          ghosts: run.ghosts,
          window: null,
          score: 20,
        },
      ],
      chosenId: null,
      decidedBy: 'rules',
      thinking: false,
      moves: [],
      status: 'open',
      approvedAt: null,
      outcome: null,
      ai: RULES_STAMP,
    });
  }
  return out.map((p) => withChoice(p, null));
}

/** The rules' sentence for an option (the problem itself shows above it). */
export function rulesSummary(_p: Proposal, o: ProposalOption): string {
  return o.detail;
}

/** Sets the chosen option: the model's when it gave one, else the rules' best. */
export function withChoice(p: Proposal, choice: { optionId: string; reason: string; ai: AiStamp } | null): Proposal {
  const byModel = choice ? p.options.find((o) => o.id === choice.optionId) : undefined;
  const best = byModel ?? [...p.options].sort((a, b) => b.score - a.score)[0];
  if (!best) return { ...p, chosenId: null, moves: [], summary: p.problem };
  return {
    ...p,
    chosenId: best.id,
    moves: best.ghosts,
    decidedBy: byModel ? 'model' : 'rules',
    summary: byModel && choice ? choice.reason : rulesSummary(p, best),
    ai: byModel && choice ? choice.ai : RULES_STAMP,
  };
}

/**
 * Closed cards: problems already settled at `t`, by an approval (an action
 * with the proposal's id) or by the rules (a lapsed window, a failed capture).
 */
export function settledProblems(w: World, t: MarketMs, actions: readonly OpsAction[]): Proposal[] {
  const out: Proposal[] = [];
  const approved = new Map<string, OpsAction>();
  for (const a of actions) if (a.proposalId && a.at <= t && !approved.has(a.proposalId)) approved.set(a.proposalId, a);
  const base = { summary: '', facts: [], options: [], chosenId: null, thinking: false, moves: [], ai: RULES_STAMP, affectedJobIds: [] as string[] };
  for (const [id, a] of approved) {
    const queuerId = 'claimId' in a.move ? (w.claims.find((c) => c.id === (a.move as { claimId: string }).claimId)?.queuerId ?? '') : (w.jobs.find((j) => j.id === (a.move as { jobId: string }).jobId)?.queuerId ?? '');
    out.push({
      ...base,
      id,
      kind: id.startsWith('hold:') ? 'hold' : 'late',
      severity: id.startsWith('hold:') ? 'critical' : 'warning',
      title: a.label.split(': ')[0] || 'Moved',
      problem: '',
      queuerId,
      shopId: '',
      raisedAt: a.at,
      rulesActAt: null,
      decidedBy: a.ai.provider === 'fake' ? 'rules' : 'model',
      status: 'approved',
      approvedAt: a.at,
      outcome: a.label.split(': ').slice(1).join(': ') || a.reason,
      ai: a.ai,
    });
  }
  for (const claim of w.claims) {
    const id = `late:${claim.id}`;
    if (claim.status !== 'lapsed' || approved.has(id) || claim.updatedAt > t) continue;
    const missed = w.jobs.filter((j) => j.claimId === claim.id && j.failure?.reason === 'no_show');
    if (missed.length === 0) continue;
    out.push({
      ...base,
      id,
      kind: 'late',
      severity: 'warning',
      title: `${first(claim.queuerName)} missed check-in`,
      problem: '',
      queuerId: claim.queuerId,
      shopId: claim.shopId,
      raisedAt: claim.windowEndsAt,
      rulesActAt: claim.windowEndsAt,
      decidedBy: 'rules',
      status: 'applied_by_rules',
      approvedAt: null,
      outcome: 'The rules moved it when the window closed',
    });
  }
  for (const job of w.jobs) {
    const id = `hold:${job.bidId}`;
    if (job.failure?.reason !== 'payment_failed' || approved.has(id) || job.failure.at > t || out.some((p) => p.id === id)) continue;
    out.push({
      ...base,
      id,
      kind: 'hold',
      severity: 'critical',
      title: `${first(job.requesterName)}'s PayPal hold needs a new approval`,
      problem: '',
      queuerId: job.queuerId,
      shopId: job.shopId,
      raisedAt: job.failure.at,
      rulesActAt: null,
      decidedBy: 'rules',
      status: 'applied_by_rules',
      approvedAt: null,
      outcome: 'Nobody approved: the capture failed',
    });
  }
  return out;
}

/** Every card at `t`: open problems first, then settled ones. */
export function proposalsAt(w: World, t: MarketMs, actions: readonly OpsAction[] = []): Proposal[] {
  const settled = settledProblems(w, t, actions);
  // A shifted window only buys time: if the queuer is still late, the problem comes back.
  const extendedOnly = (id: string) => actions.filter((a) => a.proposalId === id && a.at <= t).every((a) => a.move.kind === 'extend');
  const open = findProblems(w, t).filter((p) => !settled.some((s) => s.id === p.id && !(s.status === 'approved' && extendedOnly(p.id))));
  return [...open, ...settled];
}

/** The moves of a proposal's option, as approved actions at `at`. */
export function actionsFor(p: Proposal, optionId: string | null, at: MarketMs): OpsAction[] {
  const option = p.options.find((o) => o.id === (optionId ?? p.chosenId));
  if (!option) return [];
  const label = `${p.title}: ${option.label.charAt(0).toLowerCase()}${option.label.slice(1)}`;
  const chosen = option.id === p.chosenId;
  const ai = p.decidedBy === 'model' && chosen ? p.ai : RULES_STAMP;
  // The reason is the pick's own sentence (the model's or the rules'), or the option's numbers when ops picked another.
  const reason = chosen && p.summary ? p.summary : option.detail;
  return option.moves.map((move) => ({ at, proposalId: p.id, move, reason, label, ai }));
}
