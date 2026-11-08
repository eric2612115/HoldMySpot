import { join, relative, resolve, sep } from 'node:path';
import { evaluateCheckIn, evaluatePurchase } from '@holdmyspot/shared';
import type { ProofCheck, ProofCheckCode, VerdictStatus } from '@holdmyspot/shared';
import type { AiAgentRequest, AiAgentResult, AiJsonRequest, AiJsonResult, AiProvider, AiTask } from '@holdmyspot/shared/ports';
import { checkBasis } from '../../src/ai/basis.ts';
import type { Basis } from '../../src/ai/basis.ts';
import { SERVER_ROOT } from '../../src/ai/config.ts';
import { AiError } from '../../src/ai/errors.ts';
import { FakeProvider, FixtureTruth } from '../../src/ai/fake.ts';
import { checkInContext, checkInPhoto, purchaseContext, purchaseProof, toLineReading, toPurchaseReading } from '../../src/ai/proof.ts';
import { FixtureStore, ReplayProvider } from '../../src/ai/replay.ts';
import type { CheckInExtraction, PurchaseExtraction } from '../../src/ai/schemas.ts';
import { PROOFS_DIR, checkInInput, listCases, loadHistory, purchaseInput } from '../ai-fixtures/load.ts';
import type { LoadedCase } from '../ai-fixtures/load.ts';
import type { PriorPhoto } from '../../src/ports/ai.ts';

/**
 * The ablation behind docs/ABLATION.md: every fixture photo in
 * server/fixtures/proofs decided three ways.
 *
 *   Rules + AI  the server's pipeline (server/src/ai/proof.ts): photo hashes, the
 *               receipt QR and file metadata, the model's reading, the shared rules
 *   Rules only  the same pre-steps and the same rules context, with the photo's
 *               truth.json as the reading (one factor changed: the reading)
 *   AI only     the model's own answer alone, no rule: stopped when the model itself
 *               reported a problem, passes otherwise
 *
 * Recorded (the default): the model's saved answers in server/fixtures/ai are
 * replayed; a photo without one is an error, never a quiet fallback to the truth
 * sidecar. No key is read and nothing touches the network. Live: one answer per
 * photo from the provider passed in feeds both Rules + AI and AI only.
 *
 * Used by `npm run ablation` (cli.ts here) and server/test/ablation.test.ts, which
 * fails when the committed docs/ABLATION.md or docs/evidence/ablation.json differs
 * from a fresh recorded run.
 */

export const REPO_ROOT = resolve(SERVER_ROOT, '..');
export const ABLATION_DOC = join(REPO_ROOT, 'docs', 'ABLATION.md');
export const ABLATION_JSON = join(REPO_ROOT, 'docs', 'evidence', 'ablation.json');
export const RECORDED_ANSWERS_DIR = join(SERVER_ROOT, 'fixtures', 'ai');

/** Repo-relative path with forward slashes, for output that must read the same on every machine. */
export const repoPath = (file: string): string => relative(REPO_ROOT, file).split(sep).join('/');

export type Category = 'fake' | 'genuine' | 'review';
export type { Basis };

export interface FailedCheck {
  code: ProofCheckCode;
  weight: 'hard' | 'soft';
  basis: Basis;
  /** What the check compared, in a few words ("photo hash", "printed time"). */
  source: string;
}

export interface RulesOutcome {
  status: VerdictStatus;
  failed: FailedCheck[];
}

export interface AiOnlyOutcome {
  /** "no answer": the model gave none (a live provider error); counted as stopped. */
  outcome: 'stopped' | 'passes' | 'no answer';
  /** The problems the model reported itself, in its own words for anomalies. */
  flags: string[];
}

export interface AnswerInfo {
  /** provider/model/mode of the answer, as the pipeline stamps it. */
  stamp: string;
  /** The recorded answer's file (recorded runs), repo-relative. */
  recording: string | null;
  recordedAt: string | null;
  /** A live provider error (the server sends the proof to review). */
  error: string | null;
}

export interface AblationRow {
  id: string;
  kind: 'purchase' | 'check_in';
  category: Category;
  description: string;
  expected: { status: VerdictStatus; hard: ProofCheckCode[]; soft: ProofCheckCode[] };
  rulesAndAi: RulesOutcome;
  rulesOnly: RulesOutcome;
  aiOnly: AiOnlyOutcome;
  answer: AnswerInfo;
}

export interface AblationResult {
  answers: 'recorded' | 'live';
  rows: AblationRow[];
}

export interface RunOptions {
  /** A live provider. Without one the recorded answers are replayed. */
  provider?: AiProvider;
  /** Folder of recorded answers (default server/fixtures/ai). */
  recordedDir?: string;
  /** Only these case ids. */
  only?: readonly string[] | null;
  /** Called after each case (progress for the CLI). */
  onCase?: (row: AblationRow) => void;
}

const categoryOf = (status: VerdictStatus): Category => (status === 'failed' ? 'fake' : status === 'passed' ? 'genuine' : 'review');

/** Stands behind the replay provider: a photo with no recorded answer is an error here, not a truth-sidecar reading. */
const NO_RECORDING: AiProvider = {
  id: 'fake',
  model: 'none',
  mode: 'replay',
  vision: true,
  json: async <T>(_req: AiJsonRequest): Promise<AiJsonResult<T>> => {
    throw new AiError('no_truth', 'no recorded answer for this photo');
  },
  agent: async (_req: AiAgentRequest): Promise<AiAgentResult> => {
    throw new AiError('unsupported', 'the ablation reads photos only');
  },
};

/** The same provider, noting which answer each call asked for (task and fixture key). */
function noting(provider: AiProvider, asked: { task: AiTask; key: string }[]): AiProvider {
  return {
    id: provider.id,
    model: provider.model,
    mode: provider.mode,
    vision: provider.vision,
    json: <T>(req: AiJsonRequest): Promise<AiJsonResult<T>> => {
      asked.push({ task: req.task, key: req.fixtureKey });
      return provider.json<T>(req);
    },
    agent: (req: AiAgentRequest) => provider.agent(req),
  };
}

/** A failed check with where it got its answer (`checkBasis`, shared with `npm run attack`). */
export function classify(check: Pick<ProofCheck, 'code' | 'weight'>, qrStoreId: boolean): FailedCheck {
  return { code: check.code, weight: check.weight, ...checkBasis(check.code, qrStoreId) };
}

function outcome(status: VerdictStatus, checks: readonly ProofCheck[], qrStoreId: boolean): RulesOutcome {
  return { status, failed: checks.filter((c) => !c.ok).map((c) => classify(c, qrStoreId)) };
}

/**
 * The problems the model reported by itself, with no rule and nothing to compare
 * with: an anomaly it listed, no code seen, no line seen, nothing read to charge.
 * Its prompts carry no job details on purpose (server/src/ai/prompts.ts), so this
 * is everything it could flag on its own.
 */
export function modelFlags(kind: AblationRow['kind'], extraction: PurchaseExtraction | CheckInExtraction): string[] {
  const flags: string[] = [];
  if (kind === 'purchase') {
    const ex = extraction as PurchaseExtraction;
    for (const a of ex.anomalies) if (a.trim()) flags.push(`anomaly: ${a.trim()}`);
    if (!ex.itemPhoto.codeSeen?.trim()) flags.push('no code seen next to the item');
    if (ex.totalMinor === null || ex.lines.length === 0) flags.push('no total or no lines read');
    return flags;
  }
  const ex = extraction as CheckInExtraction;
  if (!ex.codeSeen?.trim()) flags.push('no code seen');
  if (ex.lineVisible !== true) flags.push('no line seen');
  return flags;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs the server's pipeline; a recorded run stops on any missing answer, a live run turns a provider error into review as the server does. */
async function shippedRun<T>(run: () => Promise<T>, id: string, live: boolean): Promise<{ result: T; error: null } | { result: null; error: string }> {
  try {
    return { result: await run(), error: null };
  } catch (e) {
    if (!live) throw new Error(`${id}: ${message(e)}. Record the model's answers with npm run ai:eval -- --record (calls the model), or run npm run ablation -- --live.`);
    return { result: null, error: message(e) };
  }
}

/** A live provider error: the server never passes such a proof, it sends it to a person (docs/AI-SERVICES.md section 1). */
const TO_REVIEW: RulesOutcome = { status: 'needs_review', failed: [] };

async function decide(lc: LoadedCase, prior: PriorPhoto[], model: AiProvider, truth: AiProvider, live: boolean, store: FixtureStore): Promise<AblationRow> {
  const c = lc.data;
  const asked: { task: AiTask; key: string }[] = [];
  const tapped = noting(model, asked);
  const sorted = (codes: readonly ProofCheckCode[]) => [...codes].sort();

  let rulesAndAi: RulesOutcome;
  let rulesOnly: RulesOutcome;
  let extraction: PurchaseExtraction | CheckInExtraction | null;
  let stamp: string;
  let error: string | null;

  if (c.kind === 'purchase') {
    const want = lc.truth.purchase_proof;
    if (!want) throw new Error(`${c.id}: truth.json has no purchase_proof reading`);
    const input = await purchaseInput(lc, prior);
    const qrShop = input.shop.receipt.sellerTaxId !== null;
    const run = await shippedRun(() => purchaseProof(input, tapped), c.id, live);
    error = run.error;
    if (run.result) {
      const shipped = run.result;
      const qrStoreId = qrShop && !!shipped.qr?.receiptQr?.sellerTaxId;
      rulesAndAi = outcome(shipped.status, shipped.checks, qrStoreId);
      extraction = shipped.extraction;
      stamp = `${shipped.ai.provider}/${shipped.ai.model}/${shipped.ai.mode}`;
      // Rules only: the same QR, metadata, duplicate and rules context; only the reading changes.
      const generator = shipped.photos.some((p) => p.generator.length > 0);
      const verdict = evaluatePurchase(toPurchaseReading(want, shipped.qr?.receiptQr ?? null, generator), purchaseContext(input, shipped.duplicateOf));
      rulesOnly = outcome(verdict.status, verdict.checks, qrStoreId);
    } else {
      rulesAndAi = TO_REVIEW;
      extraction = null;
      stamp = `${model.id}/${model.model}/error`;
      const r = await purchaseProof(input, truth);
      rulesOnly = outcome(r.status, r.checks, qrShop && !!r.qr?.receiptQr?.sellerTaxId);
    }
  } else {
    const want = lc.truth.check_in_photo;
    if (!want) throw new Error(`${c.id}: truth.json has no check_in_photo reading`);
    const input = await checkInInput(lc, prior);
    const run = await shippedRun(() => checkInPhoto(input, tapped), c.id, live);
    error = run.error;
    if (run.result) {
      const shipped = run.result;
      rulesAndAi = outcome(shipped.status, shipped.checks, false);
      extraction = shipped.extraction;
      stamp = `${shipped.ai.provider}/${shipped.ai.model}/${shipped.ai.mode}`;
      const verdict = evaluateCheckIn(toLineReading(want), checkInContext(input, shipped.duplicateOf));
      rulesOnly = outcome(verdict.status, verdict.checks, false);
    } else {
      rulesAndAi = TO_REVIEW;
      extraction = null;
      stamp = `${model.id}/${model.model}/error`;
      const r = await checkInPhoto(input, truth);
      rulesOnly = outcome(r.status, r.checks, false);
    }
  }

  const flags = extraction ? modelFlags(c.kind, extraction) : [];
  const aiOnly: AiOnlyOutcome = { outcome: extraction === null ? 'no answer' : flags.length > 0 ? 'stopped' : 'passes', flags };
  const call = asked[0];
  const recorded = !live && call ? store.read(call.task, call.key) : null;
  return {
    id: c.id,
    kind: c.kind,
    category: categoryOf(c.expect.status),
    description: c.description,
    expected: { status: c.expect.status, hard: sorted(c.expect.hard), soft: sorted(c.expect.soft) },
    rulesAndAi,
    rulesOnly,
    aiOnly,
    answer: {
      stamp,
      recording: recorded && call ? repoPath(store.path(call.task, call.key)) : null,
      recordedAt: recorded?.recordedAt ?? null,
      error,
    },
  };
}

/** Decides every fixture case three ways. Recorded answers unless `opts.provider` is a live provider. */
export async function runAblation(opts: RunOptions = {}): Promise<AblationResult> {
  const live = opts.provider ?? null;
  const store = new FixtureStore(opts.recordedDir ?? RECORDED_ANSWERS_DIR);
  const model = live ?? new ReplayProvider(store, NO_RECORDING, { id: 'fake', model: 'recorded' });
  const truth = new FakeProvider(new FixtureTruth(PROOFS_DIR));
  const cases = listCases().filter((lc) => !opts.only || opts.only.includes(lc.data.id));
  if (cases.length === 0) throw new Error('No fixture cases found in server/fixtures/proofs (or none match --only).');
  const prior = await loadHistory();
  const rows: AblationRow[] = [];
  for (const lc of cases) {
    const row = await decide(lc, prior, model, truth, live !== null, store);
    rows.push(row);
    opts.onCase?.(row);
  }
  return { answers: live ? 'live' : 'recorded', rows };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export const stoppedByRules = (o: RulesOutcome) => o.status !== 'passed';
export const stoppedByModel = (o: AiOnlyOutcome) => o.outcome !== 'passes';
const sameChecks = (a: RulesOutcome, b: RulesOutcome) =>
  a.failed.map((f) => f.code).sort().join() === b.failed.map((f) => f.code).sort().join();

export interface SettingSummary {
  fakesStopped: number;
  genuinePassed: number;
  reviewStopped: number;
  /** Cases stopped when they should be and passed when they should be. */
  rightOutcome: number;
  /** passed, failed and needs review exactly as expected; null for AI only, which gives no verdict. */
  exactVerdicts: number | null;
}

export interface AblationSummary {
  cases: { total: number; fake: number; genuine: number; review: number };
  rulesAndAi: SettingSummary;
  rulesOnly: SettingSummary;
  aiOnly: SettingSummary;
  /** Fakes in Rules + AI: stopped by a check that uses no reading, by a rule on the model's reading, by either. */
  layers: { codeAlone: string[]; ruleOnReading: string[]; readingOnly: string[]; modelOwnFlags: string[]; notStopped: string[] };
  /** Rules only against Rules + AI: same verdict, same failed checks. */
  agreement: { verdicts: number; failedChecks: number };
  answers: { stamps: Record<string, number>; recordings: number; recordedOn: string[]; errors: number };
}

const byCategory = (rows: readonly AblationRow[], cat: Category) => rows.filter((r) => r.category === cat);

function setting(rows: readonly AblationRow[], stopped: (r: AblationRow) => boolean, exact: ((r: AblationRow) => boolean) | null): SettingSummary {
  const fakes = byCategory(rows, 'fake');
  const genuine = byCategory(rows, 'genuine');
  const review = byCategory(rows, 'review');
  const fakesStopped = fakes.filter(stopped).length;
  const genuinePassed = genuine.filter((r) => !stopped(r)).length;
  const reviewStopped = review.filter(stopped).length;
  return {
    fakesStopped,
    genuinePassed,
    reviewStopped,
    rightOutcome: fakesStopped + genuinePassed + reviewStopped,
    exactVerdicts: exact ? rows.filter(exact).length : null,
  };
}

export function summarize(result: AblationResult): AblationSummary {
  const rows = result.rows;
  const fakes = byCategory(rows, 'fake');
  const stamps: Record<string, number> = {};
  for (const r of rows) stamps[r.answer.stamp] = (stamps[r.answer.stamp] ?? 0) + 1;
  const recordedOn = [...new Set(rows.map((r) => r.answer.recordedAt?.slice(0, 10)).filter((d): d is string => !!d))].sort();
  const code = (r: AblationRow) => r.rulesAndAi.failed.some((f) => f.basis === 'code');
  const reading = (r: AblationRow) => r.rulesAndAi.failed.some((f) => f.basis === 'reading');
  return {
    cases: { total: rows.length, fake: fakes.length, genuine: byCategory(rows, 'genuine').length, review: byCategory(rows, 'review').length },
    rulesAndAi: setting(rows, (r) => stoppedByRules(r.rulesAndAi), (r) => r.rulesAndAi.status === r.expected.status),
    rulesOnly: setting(rows, (r) => stoppedByRules(r.rulesOnly), (r) => r.rulesOnly.status === r.expected.status),
    aiOnly: setting(rows, (r) => stoppedByModel(r.aiOnly), null),
    layers: {
      codeAlone: fakes.filter(code).map((r) => r.id),
      ruleOnReading: fakes.filter(reading).map((r) => r.id),
      readingOnly: fakes.filter((r) => reading(r) && !code(r)).map((r) => r.id),
      modelOwnFlags: fakes.filter((r) => stoppedByModel(r.aiOnly)).map((r) => r.id),
      notStopped: fakes.filter((r) => !stoppedByRules(r.rulesAndAi)).map((r) => r.id),
    },
    agreement: {
      verdicts: rows.filter((r) => r.rulesOnly.status === r.rulesAndAi.status).length,
      failedChecks: rows.filter((r) => sameChecks(r.rulesOnly, r.rulesAndAi)).length,
    },
    answers: { stamps, recordings: rows.filter((r) => r.answer.recording !== null).length, recordedOn, errors: rows.filter((r) => r.answer.error !== null).length },
  };
}

/** Fakes first by what stopped them (code and reading, code, reading), then by id; the rest by id. */
export function ordered(rows: readonly AblationRow[], cat: Category): AblationRow[] {
  const rank = (r: AblationRow) => {
    const code = r.rulesAndAi.failed.some((f) => f.basis === 'code');
    const reading = r.rulesAndAi.failed.some((f) => f.basis === 'reading');
    return cat !== 'fake' ? 0 : code && reading ? 0 : code ? 1 : reading ? 2 : 3;
  };
  return byCategory(rows, cat).sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
