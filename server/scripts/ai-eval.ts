/**
 * Evaluates the AI proof pipeline on the synthetic fixtures in
 * server/fixtures/proofs and reports accuracy.
 *
 *   npm run ai:eval                       saved answers (replay), else fixture truth; no network
 *   npm run ai:eval -- --live             the configured provider, live (spends model credits; needs a key)
 *   npm run ai:eval -- --record           live, and saves each answer as a replay fixture
 *   npm run ai:eval -- --provider muse    pick a provider (auto, anthropic, muse, openai, fake)
 *   npm run ai:eval -- --only paper-moon-rex-fake,checkin-no-code
 *   npm run ai:eval -- --json /path/report.json --min 0.9
 *
 * Scores per case: the verdict (passed, failed, needs review), the exact set
 * of failed checks, the money (retail and capture), and how many fields the
 * reader got right against the truth sidecar. A provider error counts as
 * needs review, as in the server. Keys are never printed.
 *
 * The summary says where the answers came from, counted from each case's
 * stamp: replayed recordings of a model (no model is called), live model
 * answers, or the rules-only reader (the truth sidecar of a demo photo).
 * The `openai` provider is any OpenAI-compatible Chat Completions endpoint
 * (OPENAI_API_KEY, HMS_AI_BASE_URL, HMS_AI_MODEL).
 */
import { writeFileSync } from 'node:fs';
import { grossUpCapture, normalizeCode, payoutItemsCovered, receiptCapture } from '@holdmyspot/shared';
import type { AiMode, AiProviderId } from '@holdmyspot/shared';
import { buildAiPort } from '../src/ai/index.ts';
import { loadLocalEnv } from '../src/localenv.ts';
import type { CheckInExtraction, PurchaseExtraction } from '../src/ai/schemas.ts';
import { nameSimilarity } from '../src/ai/text.ts';
import { parseLocalDateTime } from '../src/ai/time.ts';
import type { CheckInResult, PurchaseResult } from '../src/ai/types.ts';
import { checkInInput, listCases, loadHistory, purchaseInput } from './ai-fixtures/load.ts';
import type { LoadedCase } from './ai-fixtures/load.ts';
import type { CheckInPhotoInput, PurchaseProofInput } from '../src/ports/ai.ts';

interface Args {
  live: boolean;
  record: boolean;
  provider: 'auto' | AiProviderId | undefined;
  only: string[] | null;
  json: string | null;
  min: number | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { live: false, record: false, provider: undefined, only: null, json: null, min: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--live') a.live = true;
    else if (v === '--record') a.record = true;
    else if (v === '--provider') a.provider = argv[++i] as Args['provider'];
    else if (v === '--only') a.only = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (v === '--json') a.json = argv[++i] ?? null;
    else if (v === '--min') a.min = Number(argv[++i]);
    else if (v === '--help' || v === '-h') {
      console.log('Usage: node scripts/ai-eval.ts [--live | --record] [--provider auto|anthropic|muse|openai|fake] [--only ids] [--json file] [--min 0..1]');
      process.exit(0);
    }
  }
  return a;
}

interface FieldScore {
  name: string;
  ok: boolean;
  got: unknown;
  want: unknown;
}

const sameCode = (a: string | null, b: string | null) => (a === null || b === null ? a === b : normalizeCode(a) === normalizeCode(b));
const sameInvoice = (a: string | null, b: string | null) => (a ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '') === (b ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const sameTime = (a: string | null, b: string | null) => {
  const x = parseLocalDateTime(a);
  const y = parseLocalDateTime(b);
  return x !== null && y !== null && x.year === y.year && x.month === y.month && x.day === y.day && x.hour === y.hour && x.minute === y.minute;
};

function scorePurchase(got: PurchaseExtraction, want: PurchaseExtraction): FieldScore[] {
  const f = (name: string, ok: boolean, g: unknown, w: unknown): FieldScore => ({ name, ok, got: g, want: w });
  const linesOk =
    got.lines.length === want.lines.length &&
    want.lines.every((w, i) => {
      const g = got.lines[i];
      return !!g && g.qty === w.qty && g.unitMinor === w.unitMinor && g.totalMinor === w.totalMinor && nameSimilarity(g.name, w.name) >= 0.85;
    });
  return [
    f('printedName', !!got.printedName && !!want.printedName && nameSimilarity(got.printedName, want.printedName) >= 0.9, got.printedName, want.printedName),
    f('sellerTaxId', (got.sellerTaxId ?? '').replace(/\D/g, '') === (want.sellerTaxId ?? '').replace(/\D/g, ''), got.sellerTaxId, want.sellerTaxId),
    f('invoiceNumber', sameInvoice(got.invoiceNumber, want.invoiceNumber), got.invoiceNumber, want.invoiceNumber),
    f('issuedAtLocal', sameTime(got.issuedAtLocal, want.issuedAtLocal), got.issuedAtLocal, want.issuedAtLocal),
    f('currency', got.currency === want.currency, got.currency, want.currency),
    f('lines', linesOk, got.lines, want.lines),
    f('totalMinor', got.totalMinor === want.totalMinor, got.totalMinor, want.totalMinor),
    f('codeSeen', sameCode(got.itemPhoto.codeSeen, want.itemPhoto.codeSeen), got.itemPhoto.codeSeen, want.itemPhoto.codeSeen),
    f('unitsVisible', got.itemPhoto.unitsVisible === want.itemPhoto.unitsVisible, got.itemPhoto.unitsVisible, want.itemPhoto.unitsVisible),
  ];
}

function scoreCheckIn(got: CheckInExtraction, want: CheckInExtraction): FieldScore[] {
  const f = (name: string, ok: boolean, g: unknown, w: unknown): FieldScore => ({ name, ok, got: g, want: w });
  const people =
    want.peopleAhead === null ? got.peopleAhead === null || got.peopleAhead === 0 : got.peopleAhead !== null && Math.abs(got.peopleAhead - want.peopleAhead) <= Math.max(3, want.peopleAhead * 0.2);
  return [
    f('lineVisible', got.lineVisible === want.lineVisible, got.lineVisible, want.lineVisible),
    f('peopleAhead (within 20%)', people, got.peopleAhead, want.peopleAhead),
    f('codeSeen', sameCode(got.codeSeen, want.codeSeen), got.codeSeen, want.codeSeen),
    f('storefrontText', !!got.storefrontText && !!want.storefrontText && nameSimilarity(got.storefrontText, want.storefrontText) >= 0.8, got.storefrontText, want.storefrontText),
  ];
}

interface CaseReport {
  id: string;
  kind: 'purchase' | 'check_in';
  expected: string;
  got: string;
  verdictOk: boolean;
  checksOk: boolean;
  moneyOk: boolean | null;
  failedHard: string[];
  failedSoft: string[];
  fields: FieldScore[];
  confidence: number | null;
  latencyMs: number;
  stamp: string;
  error: string | null;
  summary: string;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

async function runCase(lc: LoadedCase, port: ReturnType<typeof buildAiPort>, prior: Awaited<ReturnType<typeof loadHistory>>): Promise<CaseReport> {
  const c = lc.data;
  const base = { id: c.id, kind: c.kind, expected: c.expect.status };
  const input: PurchaseProofInput | CheckInPhotoInput = c.kind === 'purchase' ? await purchaseInput(lc, prior) : await checkInInput(lc, prior);
  const t0 = performance.now();
  let result: PurchaseResult | CheckInResult;
  try {
    result = 'job' in input ? await port.purchaseProof(input) : await port.checkInPhoto(input);
  } catch (e) {
    // The server turns any AI error into needs_review.
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ...base,
      got: 'needs_review',
      verdictOk: c.expect.status === 'needs_review',
      checksOk: false,
      moneyOk: null,
      failedHard: [],
      failedSoft: [],
      fields: [],
      confidence: null,
      latencyMs: Math.round(performance.now() - t0),
      stamp: `${port.info.provider}/${port.info.model}/error`,
      error: msg,
      summary: `AI error: ${msg}`,
    };
  }
  const failedHard = result.checks.filter((k) => !k.ok && k.weight === 'hard').map((k) => k.code);
  const failedSoft = result.checks.filter((k) => !k.ok && k.weight === 'soft').map((k) => k.code);
  let moneyOk: boolean | null = null;
  let fields: FieldScore[] = [];
  const latencyMs = Math.round(performance.now() - t0);
  if (c.kind === 'purchase' && 'retailCents' in result && 'job' in input) {
    if (c.expect.retailCents !== undefined) {
      // The fixture's capture is shop price plus fee; PayPal captures it with processing at cost on top (D-105).
      const mode = input.job.mode;
      const cap = result.retailCents !== null ? receiptCapture(input.job.caps, result.retailCents, mode) : null;
      const want = c.expect.captureCents === undefined ? null : grossUpCapture(c.expect.captureCents, payoutItemsCovered(mode, mode === 'ship' ? 'receipt' : 'handover')).amountCents;
      moneyOk = result.retailCents === c.expect.retailCents && (want === null || cap?.amountCents === want);
    }
    const want = lc.truth.purchase_proof;
    if (want) fields = scorePurchase(result.extraction as PurchaseExtraction, want);
  } else if (c.kind === 'check_in') {
    const want = lc.truth.check_in_photo;
    if (want) fields = scoreCheckIn(result.extraction as CheckInExtraction, want);
  }
  return {
    ...base,
    got: result.status,
    verdictOk: result.status === c.expect.status,
    checksOk: sameSet(failedHard, c.expect.hard) && sameSet(failedSoft, c.expect.soft),
    moneyOk,
    failedHard,
    failedSoft,
    fields,
    confidence: result.confidence,
    latencyMs,
    stamp: `${result.ai.provider}/${result.ai.model}/${result.ai.mode}`,
    error: null,
    summary: result.summary,
  };
}

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);

/** How many cases each answer stamp ("provider/model/mode") produced. */
function stampCounts(reports: readonly CaseReport[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of reports) out.set(r.stamp, (out.get(r.stamp) ?? 0) + 1);
  return out;
}

/**
 * Where the answers came from, in words, from each case's stamp: a replay is
 * a recording of a model played back (no model is called); "fake" is the
 * rules-only reader, which knows only the demo photos' truth sidecars.
 */
function answerSources(reports: readonly CaseReport[]): string {
  const parts: string[] = [];
  let called = false;
  for (const [stamp, count] of stampCounts(reports)) {
    const [provider = '?', model = '?', mode = ''] = stamp.split('/');
    if (mode === 'replay') parts.push(`${count} replayed from recorded ${provider}/${model} answers`);
    else if (mode === 'live' || mode === 'record') {
      called = true;
      parts.push(`${count} live from ${provider}/${model}${mode === 'record' ? ' (recorded)' : ''}`);
    } else if (mode === 'error') parts.push(`${count} ended in a ${provider} error (counted as needs review)`);
    else if (provider === 'fake') parts.push(`${count} from the rules-only reader (the photo's truth sidecar, no model)`);
    else parts.push(`${count} ${stamp}`);
  }
  return `${parts.join('; ')}.${called ? '' : ' No model was called in this run.'}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadLocalEnv();
  const mode: AiMode = args.record ? 'record' : args.live ? 'live' : ((process.env.HMS_AI_MODE as AiMode | undefined) ?? 'replay');
  const port = buildAiPort({ runtimeMode: 'fake', aiMode: mode, ...(args.provider ? { aiProvider: args.provider } : {}) });
  console.log(port.bootLine);
  if ((args.live || args.record) && port.info.mode !== mode) {
    console.error('No AI key was found for a live run (checked ANTHROPIC_API_KEY, MODEL_API_KEY and OPENAI_API_KEY by name only). Nothing was sent.');
    process.exit(2);
  }
  const cases = listCases().filter((lc) => !args.only || args.only.includes(lc.data.id));
  if (cases.length === 0) {
    console.error('No fixture cases found. Run npm run ai:render first.');
    process.exit(2);
  }
  const prior = await loadHistory();
  const reports: CaseReport[] = [];
  for (const lc of cases) {
    const r = await runCase(lc, port, prior);
    reports.push(r);
    const mark = r.verdictOk && r.checksOk && r.moneyOk !== false ? 'ok  ' : 'MISS';
    const fieldsOk = r.fields.filter((f) => f.ok).length;
    console.log(
      `${mark} ${r.id.padEnd(34)} want ${r.expected.padEnd(12)} got ${r.got.padEnd(12)} checks ${r.checksOk ? 'ok ' : 'off'}  money ${r.moneyOk === null ? '-  ' : r.moneyOk ? 'ok ' : 'off'}  fields ${r.fields.length ? `${fieldsOk}/${r.fields.length}` : '-'}  conf ${r.confidence ?? '-'}  ${r.latencyMs} ms  ${r.stamp}`,
    );
    if (mark === 'MISS') {
      console.log(`       failed hard [${r.failedHard.join(', ')}] soft [${r.failedSoft.join(', ')}]${r.error ? `; error: ${r.error}` : ''}`);
      console.log(`       ${r.summary}`);
    }
    for (const f of r.fields.filter((x) => !x.ok)) console.log(`       field ${f.name}: got ${JSON.stringify(f.got)}, want ${JSON.stringify(f.want)}`);
  }
  const n = reports.length;
  const verdicts = reports.filter((r) => r.verdictOk).length;
  const checks = reports.filter((r) => r.checksOk).length;
  const money = reports.filter((r) => r.moneyOk !== null);
  const moneyOk = money.filter((r) => r.moneyOk).length;
  const fields = reports.flatMap((r) => r.fields);
  const fieldsOk = fields.filter((f) => f.ok).length;
  const failCases = reports.filter((r) => r.expected === 'failed');
  const caught = failCases.filter((r) => r.got === 'failed').length;
  const genuine = reports.filter((r) => r.expected === 'passed');
  const wrongly = genuine.filter((r) => r.got === 'failed').length;
  const latency = reports.map((r) => r.latencyMs).sort((a, b) => a - b);
  console.log('');
  console.log(`Cases: ${n} (${reports.filter((r) => r.kind === 'purchase').length} purchase proofs, ${reports.filter((r) => r.kind === 'check_in').length} line photos)`);
  console.log(`Answers: ${answerSources(reports)}`);
  console.log(`Verdict accuracy:         ${verdicts}/${n} = ${pct(verdicts, n)}`);
  console.log(`Exact failed-check sets:  ${checks}/${n} = ${pct(checks, n)}`);
  console.log(`Money (retail, capture):  ${moneyOk}/${money.length} = ${pct(moneyOk, money.length)}`);
  console.log(`Fields read correctly:    ${fieldsOk}/${fields.length} = ${pct(fieldsOk, fields.length)}`);
  console.log(`Bad proofs caught:        ${caught}/${failCases.length}; genuine proofs wrongly failed: ${wrongly}/${genuine.length}`);
  console.log(`Latency: median ${latency[Math.floor(latency.length / 2)] ?? 0} ms, max ${latency[latency.length - 1] ?? 0} ms`);
  const summary = {
    at: new Date().toISOString(),
    ai: port.info,
    answers: Object.fromEntries(stampCounts(reports)),
    cases: n,
    verdictAccuracy: verdicts / n,
    exactCheckSets: checks / n,
    moneyAccuracy: money.length ? moneyOk / money.length : null,
    fieldAccuracy: fields.length ? fieldsOk / fields.length : null,
    badProofsCaught: `${caught}/${failCases.length}`,
    genuineWronglyFailed: `${wrongly}/${genuine.length}`,
    reports,
  };
  if (args.json) writeFileSync(args.json, `${JSON.stringify(summary, null, 2)}\n`);
  const min = args.min ?? (port.info.mode === 'live' || port.info.mode === 'record' ? 0.8 : 1);
  if (verdicts / n < min) {
    console.error(`Verdict accuracy ${pct(verdicts, n)} is below the minimum ${pct(min, 1)}.`);
    process.exitCode = 1;
  }
}

await main();
