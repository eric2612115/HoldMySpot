import { JOB_FAILURE_REASONS, findItem, findShop, formatUsd } from '@holdmyspot/shared';
import type { AiStamp, ItemKind, JobFailureReason } from '@holdmyspot/shared';
import type { AiProvider } from '@holdmyspot/shared/ports';
import type { ReassignNoteInput } from '../ports/ai.ts';
import { FAKE_MODEL } from './fake.ts';
import { NOTE_SYSTEM } from './prompts.ts';
import { fixtureKey } from './replay.ts';
import { SENTENCES_SCHEMA } from './schemas.ts';
import type { SentencesOutput } from './schemas.ts';
import { oneSentence, unitWord, units } from './text.ts';
import { hhmm } from './time.ts';

/**
 * The ops-board note when a job fails and its units go back on offer
 * (docs/AI-SERVICES.md 4.6), for example "Rex's receipt was rejected, so the
 * plush was offered again; Lin took it at $10.00 (ETA 11:30)." The template is
 * always available; outside rules-only mode a model may rephrase it, keeping
 * every fact.
 */

const REOFFERED: ReadonlySet<string> = new Set(['no_show', 'proof_rejected', 'queuer_withdrew']);

export function reassignTemplate(input: ReassignNoteInput, opts: { checksFailed?: number } = {}): string {
  const { job, takenBy } = input;
  const kind: ItemKind = findItem(job.itemId)?.kind ?? 'plush';
  const timeZone = findShop(job.shopId)?.timezone ?? 'UTC';
  const q = job.qty;
  const what = q === 1 ? `the ${unitWord(1, kind)}` : `the ${units(q, kind)}`;
  const was = q === 1 ? 'was' : 'were';
  const it = q === 1 ? 'it' : 'them';
  const name = job.queuerName;
  const n = opts.checksFailed ?? 0;
  const known = (JOB_FAILURE_REASONS as readonly string[]).includes(input.reason);
  const causes: Record<JobFailureReason, string> = {
    proof_rejected: n > 0 ? `${name}'s receipt failed ${n} check${n === 1 ? '' : 's'}` : `${name}'s receipt was rejected`,
    no_show: `${name} did not check in in time`,
    queuer_withdrew: `${name} withdrew`,
    sold_out: `The shop sold out before ${name} could buy`,
    shop_closed: 'The shop closed',
    hold_unavailable: "The requester's PayPal hold could not be used",
    payment_failed: 'A payment step failed',
    requester_cancelled: 'The requester cancelled',
    not_shipped: `${name} did not add tracking in time`,
  };
  const cause = known ? causes[input.reason as JobFailureReason] : `${name}'s job ended (${input.reason})`;
  const head = cause.charAt(0).toUpperCase() + cause.slice(1);
  if (known && !REOFFERED.has(input.reason)) return `${head}; ${what} ${was} not bought and nothing was charged for ${it}.`;
  const next = takenBy
    ? `${takenBy.queuerName} took ${it} at ${formatUsd(takenBy.feeCents, { exact: true })} (ETA ${hhmm(takenBy.etaAt, timeZone)})`
    : `${it} ${q === 1 ? 'is' : 'are'} waiting for the next offer`;
  return `${head}, so ${what} ${was} offered again; ${next}.`;
}

export async function reassignNote(input: ReassignNoteInput, provider: AiProvider | null): Promise<{ text: string; ai: AiStamp }> {
  const text = reassignTemplate(input);
  const stamp: AiStamp = { provider: 'fake', model: FAKE_MODEL, mode: 'fake', latencyMs: 0 };
  if (!provider || provider.mode === 'fake') return { text, ai: stamp };
  const prompt = `Rewrite this note as one short sentence for an operations board, keeping every fact and number:\n${text}`;
  try {
    const res = await provider.json<SentencesOutput>({
      task: 'reassign_note',
      system: NOTE_SYSTEM,
      prompt,
      images: [],
      schemaName: 'sentences',
      schema: SENTENCES_SCHEMA,
      effort: 'low',
      fixtureKey: fixtureKey({ task: 'reassign_note', schemaName: 'sentences', system: NOTE_SYSTEM, prompt, images: [] }),
    });
    const first = res.data.sentences[0];
    return first ? { text: oneSentence(first), ai: res.stamp } : { text, ai: stamp };
  } catch {
    return { text, ai: stamp };
  }
}
