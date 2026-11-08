import { SCRIPTED_MODEL, formatUsd } from '@holdmyspot/shared';
import type { AgentAction, AiStamp } from '@holdmyspot/shared';

/** Who made one agent decision, in the same honest words as the photo checks' stamps (D-128, D-158). */
export function decidedBy(ai: AiStamp): string {
  if (ai.model === SCRIPTED_MODEL) return 'Scripted demo step, no AI';
  if (ai.provider === 'fake' || ai.mode === 'fake') return 'Written rules, no AI';
  const how = ai.mode === 'live' ? 'live' : ai.mode === 'record' ? 'live, recorded' : 'replay of a saved answer';
  return `Decided by AI · ${ai.provider} ${ai.model} (${how})`;
}

export interface AgentLogRow {
  id: string;
  at: number;
  /** The headline: "Set $10.00", "$10.00 to $11.00", "Kept $12.00", or the refusal. */
  title: string;
  refused: boolean;
  reason: string;
  who: string;
}

const usd = (c: number) => formatUsd(c, { exact: true });

export function agentRow(a: AgentAction, first: boolean): AgentLogRow {
  const refused = (a.refusedFeeCents ?? null) !== null;
  let title: string;
  if (refused) title = `Refused: above what PayPal holds (${usd(a.refusedFeeCents as number)})`;
  else if ((a.kind === 'raise_fee' || a.kind === 'lower_fee') && a.toFeeCents !== null) title = first ? `Set ${usd(a.toFeeCents)}` : `${usd(a.fromFeeCents ?? a.toFeeCents)} to ${usd(a.toFeeCents)}`;
  else if (a.kind === 'keep') title = `Kept ${usd(a.toFeeCents ?? a.fromFeeCents ?? 0)}`;
  else if (a.kind === 'reduce_qty') title = 'Reduced the quantity';
  else if (a.kind === 'cancel') title = 'Cancelled the rest';
  else title = 'Note';
  return { id: a.id, at: a.at, title, refused, reason: a.reason, who: decidedBy(a.ai) };
}

/** Newest first, at most `limit` rows. */
export function agentRows(actions: readonly AgentAction[], limit = 6): AgentLogRow[] {
  return actions
    .map((a, i) => agentRow(a, i === 0))
    .reverse()
    .slice(0, limit);
}
