import { askFeeAt, askSchedule, compatible, formatUsd, nextDropAt, priceAt, reachesAt, sortBids, suggestedFeeCents } from '@holdmyspot/shared';
import type { AiStamp, BidTask, BookBid, Cents, MarketMs } from '@holdmyspot/shared';
import type { AiJsonResult, AiProvider, AiTool } from '@holdmyspot/shared/ports';
import { asAiError } from './errors.ts';
import { FAKE_MODEL } from './fake.ts';
import { AGENT_SYSTEM } from './prompts.ts';
import { fixtureKey } from './replay.ts';
import { AGENT_DECISION_SCHEMA } from './schemas.ts';
import type { AgentDecisionOutput, JsonSchema } from './schemas.ts';
import { oneSentence, unitWord } from './text.ts';
import { dayTime, formatDuration, hhmm } from './time.ts';
import type { AgentDecision, AgentRunInput, AgentRunResult } from './types.ts';

/**
 * The bidding agent (docs/AI-SERVICES.md 4.5, decision D-29).
 *
 * The requester approves one PayPal hold for the bid's limit; that hold is
 * the agent's whole mandate. Inside it the agent may set the max fee per unit
 * (never above the ceiling the hold covers, never below the item minimum),
 * reduce the quantity, keep, or cancel the rest when the shop is sold out or
 * the goal can no longer be met. It never captures, pays out, sees PayPal ids
 * or creates holds. Every run ends in exactly one decision with one plain
 * sentence of explanation; the server applies it through its own commands
 * (PATCH /api/bids/:bidId or cancel), which check the limit again.
 *
 * Who decides:
 * - live Anthropic: a tool-use loop (get_book, get_fee_estimate, then one of
 *   set_max_fee, reduce_qty, cancel_bid, keep), at most 4 steps;
 * - providers without tool use (Muse): one JSON decision;
 * - rules-only mode and replay misses: the written policy below.
 * Every model-proposed action passes the same mandate checks; a refused one
 * becomes "keep". Any provider failure keeps the current fee and logs a note.
 */

export const AGENT_MAX_STEPS = 4;
const MINUTE = 60_000;

const round50 = (cents: number): Cents => Math.round(cents / 50) * 50;

/** The most the agent may set as the max fee per unit: floor((limit - shipping budget) / qty) - retail cap. */
export function agentCeilingCents(bid: Pick<BidTask, 'limitCents' | 'shippingBudgetCents' | 'qty' | 'retailCapCents'>): Cents {
  return Math.floor((bid.limitCents - bid.shippingBudgetCents) / bid.qty) - bid.retailCapCents;
}

export type GoalUrgency = 'fast' | 'cheap' | 'balanced';

/** Reads the requester's goal for the policy's starting fee. */
export function goalUrgency(goal: string | null | undefined): GoalUrgency {
  const g = (goal ?? '').toLowerCase();
  if (/\b(asap|urgent|fast|quick|quickly|soon|right away|immediately)\b/.test(g)) return 'fast';
  if (/\b(cheap|cheapest|cheaply|lowest|low|save|saving|budget|as little)\b/.test(g)) return 'cheap';
  return 'balanced';
}

const usd = (c: Cents) => formatUsd(c, { exact: true });

export interface OfferView {
  name: string;
  feeNowCents: Cents;
  checkedIn: boolean;
  /** Local time of the next fee step, when the clock runs. */
  nextStepAt: string | null;
  nextStepInMinutes: number | null;
  nextFeeCents: Cents | null;
  /** The lowest fee this offer's clock reaches. */
  lowestFeeCents: Cents;
  /** Local time the fee first reaches the request's current max fee (null: never, or clock not started). */
  reachesMaxFeeAt: string | null;
  units: number;
  eta: string;
}

export interface BookView {
  now: string;
  deadline: string;
  minutesToDeadline: number;
  status: 'open' | 'sold_out' | 'closed';
  request: { qty: number; remainingQty: number; maxFeeCents: Cents; ceilingCents: Cents; minFeeCents: Cents; retailCapCents: Cents };
  /** Offers that can fill this request, cheapest first. */
  offers: OfferView[];
  inReachNow: boolean;
  requestsAhead: { count: number; units: number };
  feeEstimate: { suggestedFeeCents: Cents; expectedWaitMinutes: number };
}

interface OfferCalc {
  view: OfferView;
  feeNow: Cents;
  nextAt: MarketMs | null;
  nextFee: Cents | null;
}

function offers(input: AgentRunInput): OfferCalc[] {
  const { bid, now, book, shop } = input;
  const tz = shop.timezone;
  const me: BookBid = {
    id: bid.id,
    requesterId: bid.requesterId,
    maxFeeCents: bid.maxFeeCents,
    remainingQty: bid.remainingQty,
    destination: bid.destination,
    deadlineAt: bid.deadlineAt,
    pricedAt: bid.pricedAt,
    matchable: true,
  };
  const ctx = { shopCityId: shop.cityId, now };
  const out: OfferCalc[] = [];
  for (const a of book.asks) {
    if (!a.matchable || a.remainingCapacity <= 0 || !compatible(me, a, ctx)) continue;
    const feeNow = askFeeAt(a, now);
    const schedule = askSchedule(a);
    const nextAt = schedule ? nextDropAt(schedule, now) : null;
    const nextFee = schedule && nextAt !== null ? priceAt(schedule, nextAt) : null;
    const reach = schedule ? reachesAt(schedule, bid.maxFeeCents) : feeNow <= bid.maxFeeCents ? now : null;
    out.push({
      feeNow,
      nextAt,
      nextFee,
      view: {
        name: book.askNames?.[a.id] ?? 'A helper',
        feeNowCents: feeNow,
        checkedIn: a.windowEndsAt === null || (book.checkedInAskIds?.includes(a.id) ?? false),
        nextStepAt: nextAt !== null ? hhmm(nextAt, tz) : null,
        nextStepInMinutes: nextAt !== null ? Math.ceil((nextAt - now) / MINUTE) : null,
        nextFeeCents: nextFee,
        lowestFeeCents: a.clock ? a.clock.floorCents : a.feeCents,
        reachesMaxFeeAt: reach !== null ? hhmm(Math.max(reach, now), tz) : null,
        units: a.remainingCapacity,
        eta: hhmm(a.etaAt, tz),
      },
    });
  }
  return out.sort((x, y) => x.feeNow - y.feeNow);
}

export function bookView(input: AgentRunInput, ceiling: Cents): { view: BookView; calc: OfferCalc[] } {
  const { bid, now, shop, item, book } = input;
  const tz = shop.timezone;
  const calc = offers(input);
  const others = book.bids.filter((b) => b.matchable && b.remainingQty > 0 && b.id !== bid.id);
  const ranked = sortBids([...others, { id: bid.id, maxFeeCents: bid.maxFeeCents, pricedAt: bid.pricedAt, remainingQty: bid.remainingQty }]);
  const ahead = ranked.slice(0, ranked.findIndex((b) => b.id === bid.id));
  const fee = input.fee ?? null;
  const estimate = fee
    ? { suggestedFeeCents: fee.suggestedFeeCents, expectedWaitMinutes: fee.expectedWaitMinutes }
    : { suggestedFeeCents: suggestedFeeCents(item, item.expectedWaitMinutes), expectedWaitMinutes: item.expectedWaitMinutes };
  return {
    calc,
    view: {
      now: dayTime(now, tz),
      deadline: dayTime(bid.deadlineAt, tz),
      minutesToDeadline: Math.max(0, Math.floor((bid.deadlineAt - now) / MINUTE)),
      status: book.status,
      request: {
        qty: bid.qty,
        remainingQty: bid.remainingQty,
        maxFeeCents: bid.maxFeeCents,
        ceilingCents: ceiling,
        minFeeCents: item.minFeeCents,
        retailCapCents: bid.retailCapCents,
      },
      offers: calc.map((c) => c.view),
      inReachNow: calc.some((c) => c.feeNow <= bid.maxFeeCents),
      requestsAhead: { count: ahead.length, units: ahead.reduce((s, b) => s + b.remainingQty, 0) },
      feeEstimate: estimate,
    },
  };
}

// ---------------------------------------------------------------------------
// Mandate checks (every proposed action passes these, whoever proposed it)
// ---------------------------------------------------------------------------

export function feeProblem(input: AgentRunInput, ceiling: Cents, cents: unknown): string | null {
  if (typeof cents !== 'number' || !Number.isInteger(cents)) return 'The fee must be a whole number of cents.';
  if (cents < input.item.minFeeCents) return `The fee cannot be below the ${usd(input.item.minFeeCents)} minimum for this item.`;
  if (cents > ceiling) return `The fee cannot be above ${usd(ceiling)}: the PayPal hold covers at most that per unit.`;
  if (cents === input.bid.maxFeeCents) return 'That is already the max fee.';
  return null;
}

export function qtyProblem(bid: BidTask, qty: unknown): string | null {
  const matched = bid.qty - bid.remainingQty;
  const lowest = Math.max(1, matched);
  if (typeof qty !== 'number' || !Number.isInteger(qty)) return 'The quantity must be a whole number.';
  if (qty < lowest) return `The quantity cannot go below ${lowest}.`;
  if (qty >= bid.qty) return 'The agent can only reduce the quantity.';
  return null;
}

export function cancelProblem(input: AgentRunInput, view: BookView): string | null {
  if (input.book.status === 'sold_out') return null;
  const reachable = view.offers.some((o) => o.feeNowCents <= view.request.ceilingCents || o.lowestFeeCents <= view.request.ceilingCents);
  if (view.minutesToDeadline <= 15 && !reachable) return null;
  return 'Cancelling is only allowed when the shop is sold out or the goal can no longer be met.';
}

// ---------------------------------------------------------------------------
// The written policy (rules-only mode and replay misses)
// ---------------------------------------------------------------------------

function decision(kind: AgentDecision['kind'], from: Cents | null, to: Cents | null, reason: string, qty: number | null = null): AgentDecision {
  return { kind, fromFeeCents: from, toFeeCents: to, qty, reason };
}

/** Elapsed share of the agent's window: from creation to 30 minutes before the deadline. */
export function elapsedShare(bid: Pick<BidTask, 'createdAt' | 'deadlineAt'>, now: MarketMs): number {
  const end = bid.deadlineAt - 30 * MINUTE;
  if (end <= bid.createdAt) return 1;
  return Math.min(1, Math.max(0, (now - bid.createdAt) / (end - bid.createdAt)));
}

export function startFeeCents(input: AgentRunInput, ceiling: Cents, view: BookView): Cents {
  const factor = { fast: 1, balanced: 0.9, cheap: 0.75 }[goalUrgency(input.bid.agent?.goal)];
  return Math.min(ceiling, Math.max(input.item.minFeeCents, round50(view.feeEstimate.suggestedFeeCents * factor)));
}

export function policyDecision(input: AgentRunInput, ceiling: Cents, built: { view: BookView; calc: OfferCalc[] }): AgentDecision {
  const { bid, now, shop, item } = input;
  const { view, calc } = built;
  const cur = bid.maxFeeCents;
  const per = unitWord(1, item.kind);
  if (input.book.status === 'sold_out') {
    return decision('cancel', cur, null, `${shop.name} is sold out, so I cancelled the rest of this request; nothing more will be charged for it.`);
  }
  if (bid.remainingQty === 0) return decision('keep', cur, cur, 'Every unit is matched; nothing to change.');
  if (now >= bid.deadlineAt) return decision('keep', cur, cur, 'The deadline has passed, so the request will close.');
  if (input.book.status === 'closed') return decision('keep', cur, cur, `${shop.name} is closed right now; I kept your fee at ${usd(cur)} and will check again.`);

  const best = calc[0];
  if (best && best.feeNow <= cur) {
    return decision('keep', cur, cur, `${best.view.name}'s offer is ${usd(best.feeNow)}, within your max of ${usd(cur)}, so it should fill at that fee.`);
  }
  const soon = calc.find((c) => c.nextFee !== null && c.nextFee <= cur && c.nextAt !== null && c.nextAt - now <= 10 * MINUTE);
  if (soon && soon.nextAt !== null && soon.nextFee !== null) {
    return decision('keep', cur, cur, `${soon.view.name}'s fee steps down to ${usd(soon.nextFee)} at ${hhmm(soon.nextAt, shop.timezone)}, within your max, so I am waiting.`);
  }
  const f = elapsedShare(bid, now);
  const left = formatDuration(bid.deadlineAt - now);
  if (best && best.feeNow <= ceiling && (f >= 0.75 || view.minutesToDeadline <= 60)) {
    return decision('raise_fee', cur, best.feeNow, `The deadline is ${left} away and ${best.view.name}'s offer is ${usd(best.feeNow)}, within your ceiling, so I raised the fee to take it.`);
  }
  const start = startFeeCents(input, ceiling, view);
  const target = Math.min(ceiling, Math.max(item.minFeeCents, round50(start + (ceiling - start) * f ** 1.5)));
  const firstRun = (input.history ?? []).length === 0;
  if (target > cur) {
    return decision('raise_fee', cur, target, `No offer is in reach yet and ${left} is left, so I raised the fee to ${usd(target)} per ${per} (your ceiling is ${usd(ceiling)}).`);
  }
  if (target < cur && firstRun) {
    return decision('lower_fee', cur, target, `Starting at ${usd(target)} per ${per}, below your ${usd(ceiling)} ceiling; I will raise it step by step if no helper takes it.`);
  }
  return decision('keep', cur, cur, `Holding at ${usd(cur)} per ${per}: no offer is in reach yet and ${left} is left before the deadline.`);
}

// ---------------------------------------------------------------------------
// Model runs
// ---------------------------------------------------------------------------

const EMPTY_INPUT: JsonSchema = { type: 'object', additionalProperties: false, properties: {}, required: [] };
const REASON = { type: 'string', description: 'One plain sentence for the requester, with the amounts.' };

interface RunState {
  decision: AgentDecision | null;
  refused: string[];
}

function applyProposal(
  input: AgentRunInput,
  ceiling: Cents,
  view: BookView,
  state: RunState,
  p: { kind: 'set_fee' | 'reduce_qty' | 'cancel' | 'keep'; cents?: unknown; qty?: unknown; reason: unknown },
): { ok: boolean; error?: string; applied?: string } {
  if (state.decision) {
    const error = `Only one action per run; already decided: ${state.decision.kind}.`;
    state.refused.push(`${p.kind}: ${error}`);
    return { ok: false, error };
  }
  const cur = input.bid.maxFeeCents;
  const reason = typeof p.reason === 'string' && p.reason.trim() ? oneSentence(p.reason) : '';
  let problem: string | null = null;
  if (p.kind === 'set_fee') {
    problem = feeProblem(input, ceiling, p.cents);
    if (!problem) {
      const to = p.cents as number;
      state.decision = decision(to > cur ? 'raise_fee' : 'lower_fee', cur, to, reason || `Changed the fee to ${usd(to)}.`);
    }
  } else if (p.kind === 'reduce_qty') {
    problem = qtyProblem(input.bid, p.qty);
    if (!problem) state.decision = decision('reduce_qty', cur, cur, reason || `Reduced the quantity to ${String(p.qty)}.`, p.qty as number);
  } else if (p.kind === 'cancel') {
    problem = cancelProblem(input, view);
    if (!problem) state.decision = decision('cancel', cur, null, reason || 'Cancelled the rest of this request.');
  } else {
    state.decision = decision('keep', cur, cur, reason || `Kept the fee at ${usd(cur)}.`);
  }
  if (problem) {
    state.refused.push(`${p.kind}: ${problem}`);
    return { ok: false, error: problem };
  }
  return { ok: true, applied: state.decision?.kind ?? p.kind };
}

function agentPrompt(input: AgentRunInput, view: BookView): string {
  const { bid, item, shop } = input;
  return [
    `Requester's goal: "${bid.agent?.goal ?? 'fill the request before the deadline at the lowest fee'}".`,
    `Request: ${item.name} at ${shop.name}; ${bid.qty} units, ${bid.remainingQty} not matched yet.`,
    `Max fee now ${bid.maxFeeCents} cents per unit; ceiling ${view.request.ceilingCents} cents; item minimum ${item.minFeeCents} cents.`,
    `Now ${view.now} (${shop.timezone}); deadline ${view.deadline}, in ${view.minutesToDeadline} minutes.`,
  ].join('\n');
}

function buildTools(input: AgentRunInput, ceiling: Cents, view: BookView, state: RunState): AiTool[] {
  return [
    {
      name: 'get_book',
      description: 'Current offers from helpers that can fill this request (cheapest first, with their fee clocks), the request itself, its ceiling and time left.',
      inputSchema: EMPTY_INPUT,
      run: async () => ({ ok: true, ...view }),
    },
    {
      name: 'get_fee_estimate',
      description: 'The suggested queue fee per unit and the expected wait in the line for this item.',
      inputSchema: EMPTY_INPUT,
      run: async () => ({ ok: true, ...view.feeEstimate }),
    },
    {
      name: 'set_max_fee',
      description: `Set the request's max queue fee per unit, in US cents. At least ${input.item.minFeeCents}, at most the ceiling ${ceiling}. A lower fee waits longer; a fee at or above an offer's current fee fills at the offer's fee.`,
      inputSchema: { type: 'object', additionalProperties: false, required: ['maxFeeCents', 'reason'], properties: { maxFeeCents: { type: 'integer' }, reason: REASON } },
      run: async (raw) => {
        const i = raw as { maxFeeCents?: unknown; reason?: unknown };
        return applyProposal(input, ceiling, view, state, { kind: 'set_fee', cents: i.maxFeeCents, reason: i.reason });
      },
    },
    {
      name: 'reduce_qty',
      description: 'Reduce how many units the request still wants (never below the units already matched).',
      inputSchema: { type: 'object', additionalProperties: false, required: ['qty', 'reason'], properties: { qty: { type: 'integer' }, reason: REASON } },
      run: async (raw) => {
        const i = raw as { qty?: unknown; reason?: unknown };
        return applyProposal(input, ceiling, view, state, { kind: 'reduce_qty', qty: i.qty, reason: i.reason });
      },
    },
    {
      name: 'cancel_bid',
      description: 'Cancel the unmatched rest of the request. Only when the shop is sold out or the goal can no longer be met.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: REASON } },
      run: async (raw) => applyProposal(input, ceiling, view, state, { kind: 'cancel', reason: (raw as { reason?: unknown }).reason }),
    },
    {
      name: 'keep',
      description: 'Change nothing this time.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: REASON } },
      run: async (raw) => applyProposal(input, ceiling, view, state, { kind: 'keep', reason: (raw as { reason?: unknown }).reason }),
    },
  ];
}

function nextRunAt(input: AgentRunInput, calc: OfferCalc[], d: AgentDecision): MarketMs | null {
  const { bid, now } = input;
  if (d.kind === 'cancel' || bid.remainingQty === 0 || now >= bid.deadlineAt || input.book.status === 'sold_out') return null;
  const max = d.toFeeCents ?? bid.maxFeeCents;
  const times = [now + 15 * MINUTE];
  for (const t of [bid.deadlineAt - 60 * MINUTE, bid.deadlineAt - 15 * MINUTE]) if (t > now) times.push(t);
  for (const c of calc) {
    if (c.nextAt === null || c.nextFee === null) continue;
    // Look again a minute before a clock step brings an offer to the max fee.
    if (c.nextFee <= max) times.push(c.nextAt - MINUTE);
  }
  return Math.max(now + MINUTE, Math.min(...times));
}

const policyStamp: AiStamp = { provider: 'fake', model: FAKE_MODEL, mode: 'fake', latencyMs: 0 };

export async function runAgent(input: AgentRunInput, provider: AiProvider | null): Promise<AgentRunResult> {
  const ceiling = agentCeilingCents(input.bid);
  const built = bookView(input, ceiling);
  const { view, calc } = built;
  const finish = (d: AgentDecision, extra: Partial<AgentRunResult> = {}): AgentRunResult => ({
    decision: d,
    toolCalls: [],
    refused: [],
    ceilingCents: ceiling,
    nextRunAt: nextRunAt(input, calc, d),
    decidedBy: 'policy',
    ai: policyStamp,
    ...extra,
  });

  const forced = input.book.status === 'sold_out' || input.bid.remainingQty === 0 || input.now >= input.bid.deadlineAt;
  if (!provider || provider.mode === 'fake' || forced) return finish(policyDecision(input, ceiling, built));

  const state: RunState = { decision: null, refused: [] };
  const prompt = agentPrompt(input, view);
  const t0 = performance.now();
  try {
    // 1) Tool use.
    try {
      const tools = buildTools(input, ceiling, view, state);
      const res = await provider.agent({
        task: 'bidding_agent',
        system: AGENT_SYSTEM,
        prompt: `${prompt}\nCheck the offers, then take exactly one action.`,
        tools,
        maxSteps: AGENT_MAX_STEPS,
        fixtureKey: fixtureKey({ task: 'bidding_agent', schemaName: 'tools-v1', system: AGENT_SYSTEM, prompt: `${prompt}\n${JSON.stringify(view)}`, images: [] }),
      });
      const d = state.decision ?? decision('keep', input.bid.maxFeeCents, input.bid.maxFeeCents, res.summary ? oneSentence(res.summary) : `Kept the fee at ${usd(input.bid.maxFeeCents)}.`);
      return finish(d, { toolCalls: res.toolCalls, refused: state.refused, decidedBy: 'model', ai: res.stamp });
    } catch (e) {
      if (asAiError(e).kind !== 'unsupported') throw e;
    }
    // 2) Decision mode: one JSON answer, applied through the same checks.
    const decisionPrompt = `${prompt}\nCurrent offers and the request (JSON):\n${JSON.stringify(view)}\nAnswer with one action and one plain sentence of reason.`;
    let res: AiJsonResult<AgentDecisionOutput>;
    try {
      res = await provider.json<AgentDecisionOutput>({
        task: 'bidding_agent',
        system: AGENT_SYSTEM,
        prompt: decisionPrompt,
        images: [],
        schemaName: 'agent_decision',
        schema: AGENT_DECISION_SCHEMA,
        effort: 'low',
        fixtureKey: fixtureKey({ task: 'bidding_agent', schemaName: 'agent_decision', system: AGENT_SYSTEM, prompt: decisionPrompt, images: [] }),
      });
    } catch (e) {
      const kind = asAiError(e).kind;
      // Rules-only fallback (a replay miss): the written policy decides.
      if (kind === 'unsupported' || kind === 'no_truth') return finish(policyDecision(input, ceiling, built));
      throw e;
    }
    const out = res.data;
    const kind = out.action === 'raise_fee' || out.action === 'lower_fee' ? 'set_fee' : out.action === 'cancel' ? 'cancel' : out.action === 'reduce_qty' ? 'reduce_qty' : 'keep';
    applyProposal(input, ceiling, view, state, { kind, cents: out.maxFeeCents, qty: out.qty, reason: out.reason });
    const d = state.decision ?? decision('keep', input.bid.maxFeeCents, input.bid.maxFeeCents, `Kept the fee at ${usd(input.bid.maxFeeCents)}; the suggested change was outside your limit.`);
    return finish(d, { refused: state.refused, decidedBy: 'model', ai: res.stamp });
  } catch (e) {
    const err = asAiError(e);
    const cur = input.bid.maxFeeCents;
    return finish(decision('note', cur, cur, `The agent could not run this time (${err.kind}), so your fee stays at ${usd(cur)}.`), {
      refused: state.refused,
      decidedBy: 'model',
      ai: { provider: provider.id, model: provider.model, mode: provider.mode, latencyMs: Math.round(performance.now() - t0) },
    });
  }
}
