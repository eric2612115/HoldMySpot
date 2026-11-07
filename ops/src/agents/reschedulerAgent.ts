import { useEffect, useMemo, useRef, useState } from 'react';
import type { AiStamp, MarketMs, OpsAgentTurnRequest, OpsAgentTurnResponse } from '@holdmyspot/shared';
import { clockText } from '../data/time.ts';
import { askServer } from './brain.ts';
import type { Brain } from './brain.ts';
import { withChoice } from './rescheduler.ts';
import type { Proposal } from './rescheduler.ts';

/**
 * The rescheduler's model step (D-101): one turn on the server's AI port for
 * all open problems at once. The model gets each problem's facts and the
 * options the rules built (with their dry-run results) and must call
 * `choose_moves` with one option id per problem and a reason the operator
 * reads. Anything it returns that is not one of those options is ignored,
 * and the rules' choice stands.
 */

export const RESCHEDULER_INSTRUCTIONS = `You are the rescheduler on HoldMySpot's queuer board. Queuers walk to a shop, check in inside an arrival window, stand in line and buy for requesters whose PayPal holds pay for it.
For each problem, choose exactly one of its options and explain the choice to the operator in one or two short sentences that a person reads in five seconds: who, which shop, the money (fees and max fees exactly as given), and why this option beats the others.
Prefer getting the requester's item bought soon at a fee within the request's max; give a late queuer more time only when the facts say he is moving and close; release a queuer who has not moved; never leave a queuer buying on a hold that cannot pay.
You can only choose among the given option ids. Call choose_moves once.`;

export interface ModelChoice {
  optionId: string;
  reason: string;
  ai: AiStamp;
}

export function choiceRequest(open: readonly Proposal[], at: MarketMs): OpsAgentTurnRequest {
  const problems = open.map((p) => ({
    id: p.id,
    problem: p.problem,
    facts: p.facts,
    rulesActAt: p.rulesActAt ? `${clockText(p.rulesActAt)}: ${p.kind === 'late' ? 'the window closes and the rules re-offer the job' : 'the rules act'}` : 'the rules will not act on their own',
    options: p.options.map((o) => ({ id: o.id, does: o.label, detail: o.detail, moves: o.moves.map((m) => m.kind) })),
  }));
  return {
    agent: 'rescheduler',
    instructions: RESCHEDULER_INSTRUCTIONS,
    messages: [{ role: 'user', text: `Market time ${clockText(at)}, San Francisco. Problems on the board:\n${JSON.stringify(problems, null, 1)}` }],
    tools: [
      {
        name: 'choose_moves',
        description: 'Choose one option for each problem, with the reason the operator reads.',
        parameters: {
          type: 'object',
          properties: {
            choices: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  problem: { type: 'string', enum: open.map((p) => p.id) },
                  option: { type: 'string', description: 'One of that problem\'s option ids.' },
                  reason: { type: 'string', description: 'One or two short sentences for the operator.' },
                },
                required: ['problem', 'option', 'reason'],
              },
            },
          },
          required: ['choices'],
        },
      },
    ],
    toolChoice: { name: 'choose_moves' },
  };
}

/** The model's valid choices by problem id; anything else is dropped. */
export function readChoices(open: readonly Proposal[], turn: OpsAgentTurnResponse): Record<string, ModelChoice> {
  const out: Record<string, ModelChoice> = {};
  for (const call of turn.calls) {
    if (call.name !== 'choose_moves') continue;
    let args: { choices?: { problem?: unknown; option?: unknown; reason?: unknown }[] };
    try {
      args = JSON.parse(call.arguments) as typeof args;
    } catch {
      continue;
    }
    for (const c of args.choices ?? []) {
      const p = open.find((x) => x.id === c.problem);
      const option = p?.options.find((o) => o.id === c.option);
      const reason = typeof c.reason === 'string' ? c.reason.trim() : '';
      if (p && option && reason) out[p.id] = { optionId: option.id, reason: reason.slice(0, 400), ai: turn.ai };
    }
  }
  return out;
}

/** A problem as the model saw it: its id and its options. A changed option list asks again. */
const keyOf = (p: Proposal) => `${p.id}=${p.options.map((o) => o.id).join(',')}`;

/**
 * Proposals with the model's choices merged in. Asks the model once per
 * problem it has not seen (never on a timer, and only about the new ones);
 * while it thinks, the rules' choice shows with `thinking`. A failed turn
 * keeps the rules' choice.
 */
export function useAgentProposals(proposals: Proposal[], brain: Brain, at: MarketMs): { proposals: Proposal[]; error: string | null } {
  const [choices, setChoices] = useState<Record<string, ModelChoice>>({});
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(new Set<string>());
  const inflight = useRef(new Map<AbortController, string[]>());
  const open = useMemo(() => proposals.filter((p) => p.status === 'open' && p.options.length > 0), [proposals]);
  const openSig = open.map(keyOf).join('|');
  const atRef = useRef(at);
  atRef.current = at;

  // On unmount, stop asking; the problems may be asked about again by the next mount.
  useEffect(
    () => () => {
      for (const [ctrl, keys] of inflight.current) {
        ctrl.abort();
        for (const k of keys) asked.current.delete(k);
      }
      inflight.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (brain.kind !== 'model') return;
    const unseen = open.filter((p) => !asked.current.has(keyOf(p)));
    if (unseen.length === 0) return;
    const keys = unseen.map(keyOf);
    for (const k of keys) asked.current.add(k);
    const ctrl = new AbortController();
    inflight.current.set(ctrl, keys);
    setPending((p) => [...p, ...keys]);
    setError(null);
    askServer(choiceRequest(unseen, atRef.current), ctrl.signal)
      .then((turn) => {
        const got = readChoices(unseen, turn);
        setChoices((c) => ({ ...c, ...Object.fromEntries(unseen.filter((p) => got[p.id]).map((p) => [keyOf(p), got[p.id]!])) }));
      })
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        inflight.current.delete(ctrl);
        setPending((p) => p.filter((k) => !keys.includes(k)));
      });
    // `open` is captured by its signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brain.kind, openSig]);

  const merged = useMemo(
    () =>
      proposals.map((p) => {
        if (p.status !== 'open') return p;
        const choice = choices[keyOf(p)] ?? null;
        return { ...withChoice(p, choice), thinking: brain.kind === 'model' && !choice && pending.includes(keyOf(p)) };
      }),
    [proposals, choices, pending, brain.kind],
  );
  return { proposals: merged, error };
}
