import { JOB_FAILURE_REASONS, disputeNoteTemplate, findItem, findShop, formatUsd, noteUsesOnlyFacts } from '@holdmyspot/shared';
import type { AiStamp, ItemKind, JobFailureReason } from '@holdmyspot/shared';
import type { AiProvider } from '@holdmyspot/shared/ports';
import type { DisputeNoteInput, DisputeNoteResult, ReassignNoteInput } from '../ports/ai.ts';
import { AiError } from './errors.ts';
import { FAKE_MODEL } from './fake.ts';
import { DISPUTE_NOTE_SYSTEM, NOTE_SYSTEM } from './prompts.ts';
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

/**
 * The dispute note a person reviews before Send (D-159). The model only words
 * the facts; with no model, on a provider error, or when its note names a number
 * the facts do not hold, the template writes it and the result says so.
 */
export async function disputeNote(input: DisputeNoteInput, provider: AiProvider | null): Promise<DisputeNoteResult> {
  const text = disputeNoteTemplate(input.facts);
  const stamp: AiStamp = { provider: 'fake', model: FAKE_MODEL, mode: 'fake', latencyMs: 0 };
  const template = (reason: 'no_model' | 'provider_error' | 'rejected'): DisputeNoteResult => ({ text, ai: stamp, template: true, templateReason: reason });
  if (!provider || provider.mode === 'fake') return template('no_model');
  const prompt = `Facts:\n${JSON.stringify(input.facts, null, 1)}\n\nA plain version of the note:\n${text}\n\nWord this note for PayPal's reviewer, keeping every fact and number.`;
  try {
    const res = await provider.json<SentencesOutput>({
      task: 'dispute_note',
      system: DISPUTE_NOTE_SYSTEM,
      prompt,
      images: [],
      schemaName: 'sentences',
      schema: SENTENCES_SCHEMA,
      effort: 'low',
      fixtureKey: fixtureKey({ task: 'dispute_note', schemaName: 'sentences', system: DISPUTE_NOTE_SYSTEM, prompt, images: [] }),
    });
    const written = res.data.sentences.join(' ').replace(/\s+/g, ' ').trim();
    if (!written) return template('provider_error');
    if (!noteUsesOnlyFacts(written, input.facts)) return template('rejected');
    return { text: written, ai: res.stamp, template: false, templateReason: null };
  } catch (err) {
    return template(err instanceof AiError && (err.kind === 'unsupported' || err.kind === 'no_truth') ? 'no_model' : 'provider_error');
  }
}
