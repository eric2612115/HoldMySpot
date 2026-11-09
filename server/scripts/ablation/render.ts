import type { ProofCheckCode, VerdictStatus } from '@holdmyspot/shared';
import { ordered, summarize } from './ablate.ts';
import type { AblationResult, AblationRow, AblationSummary, AiOnlyOutcome, FailedCheck, RulesOutcome, SettingSummary } from './ablate.ts';

/**
 * docs/ABLATION.md and docs/evidence/ablation.json from one ablation run.
 * Every number and every list in them is computed here from the run, and a
 * recorded run renders byte for byte the same on every machine (no clock, no
 * latency, no paths outside the repo), so server/test/ablation.test.ts can
 * compare the committed files with a fresh run.
 */

export interface RenderOptions {
  /** A line about a scratch run (when, which cases); the committed page carries nothing that changes between runs. */
  runNote?: string;
  /** The committed docs/ABLATION.md (default for a recorded run); false for live and partial runs written to .run/. */
  committed?: boolean;
}

const SETTINGS = {
  rulesAndAi: {
    label: 'Rules + AI',
    definition:
      "What the server runs (`purchaseProof` and `checkInPhoto` in `server/src/ai/proof.ts`): photo hashes, the receipt QR and file metadata, the model's reading, then the shared rules.",
  },
  rulesOnly: {
    label: 'Rules on the true reading',
    definition:
      "The model is switched off and each photo's `truth.json`, the reading it was drawn with, is the reading; the hashes, QR, metadata and the rules' context are the same as in Rules + AI.",
  },
  aiOnly: {
    label: 'Model without the job, not asked for a verdict',
    definition:
      "The rules are switched off and the model's own answer decides: a proof is stopped when the model itself reported a problem (an anomaly it listed, no code seen, no line of people seen, or no total or lines read) and passes otherwise. The model is asked only to read, as HoldMySpot asks it.",
  },
} as const;

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** What is wrong with a proof, from the checks it is expected to fail (case.json). */
const WRONG: Record<ProofCheckCode, string> = {
  geofence: 'checked in away from the shop',
  line_visible: 'no line in the photo',
  code_visible: 'the one-time code is missing or wrong',
  shop_match: "another shop's receipt",
  time_window: 'printed outside the check-in window',
  item_match: 'an unrelated line on the receipt',
  qty_within_limit: 'the wrong quantity',
  totals_add_up: 'the lines do not add up to the total',
  qr_matches_print: 'the print was edited (the QR disagrees)',
  within_retail_cap: 'the price is above the cap',
  listed_price: 'the price is above the listed shop price',
  duplicate_photo: 'a recycled photo',
  generator_metadata: 'image-generator metadata in the file',
};

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const id = (s: string) => `\`${s}\``;
const frac = (n: number, d: number) => `${n}/${d}`;
const of = (n: number, d: number) => `${n} of ${d}`;

/** "`a`", "`a` and `b`", "`a`, `b` and `c`". */
function names(ids: readonly string[]): string {
  const q = ids.map(id);
  if (q.length <= 1) return q.join('');
  return `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`;
}

const verdict = (s: VerdictStatus) => (s === 'needs_review' ? 'needs review' : s);

function aiCell(o: AiOnlyOutcome): string {
  if (o.outcome === 'no answer') return 'stopped (no answer)';
  if (o.outcome === 'passes') return 'passes';
  const short = o.flags.map((f) => (f.startsWith('anomaly: ') ? 'listed an anomaly' : f));
  return `stopped: ${[...new Set(short)].join('; ')}`;
}

function stoppedBy(o: RulesOutcome): string {
  if (o.failed.length === 0) return o.status === 'needs_review' ? 'provider error (to review)' : '–';
  const part = (basis: FailedCheck['basis'], label: string) => {
    const fs = o.failed.filter((f) => f.basis === basis);
    return fs.length ? `${label}: ${fs.map((f) => `${id(f.code)} (${f.source})`).join(', ')}` : null;
  };
  return [part('code', 'code'), part('reading', 'reading')].filter(Boolean).join('; ');
}

const wrongWith = (r: AblationRow) => [...r.expected.hard, ...r.expected.soft].map((c) => WRONG[c]).join('; ');

function answersLine(result: AblationResult, s: AblationSummary): string {
  const parts: string[] = [];
  for (const [stamp, n] of Object.entries(s.answers.stamps).sort()) {
    const [provider = '?', model = '?', mode = ''] = stamp.split('/');
    if (mode === 'replay') parts.push(`${n} replayed from the recorded ${provider}/${model} answers in \`server/fixtures/ai/\``);
    else if (mode === 'error') parts.push(`${n} ended in a provider error and went to review, as in the server`);
    else parts.push(`${n} ${mode} from ${provider}/${model}`);
  }
  const when = s.answers.recordedOn.length ? ` (recorded on ${s.answers.recordedOn.join(', ')})` : '';
  const calls = result.answers === 'live' ? ` The model was called ${s.cases.total - s.answers.recordings} times.` : ' No model was called.';
  return `Answers: ${parts.join('; ')}${when}.${calls}`;
}

function summaryRow(label: string, pick: (x: SettingSummary) => string, s: AblationSummary): string {
  return `| ${label} | ${pick(s.rulesAndAi)} | ${pick(s.rulesOnly)} | ${pick(s.aiOnly)} |`;
}

/** The findings, each sentence built from the numbers so it stays true when they change. */
function findings(result: AblationResult, s: AblationSummary): string[] {
  const { fake: F, genuine: G, review: R, total: N } = s.cases;
  const rows = result.rows;
  const ra = s.rulesAndAi;
  const out: string[] = [];
  out.push(
    `Rules + AI stops ${of(ra.fakesStopped, F)} fakes, passes ${of(ra.genuinePassed, G)} genuine proofs and stops ${of(ra.reviewStopped, R)} review cases; ${of(ra.exactVerdicts ?? 0, N)} verdicts are exactly as expected.`,
  );
  const same = s.agreement.verdicts === N && s.agreement.failedChecks === N;
  out.push(
    `The rules on the true reading and Rules + AI reach the same verdict on ${of(s.agreement.verdicts, N)} photos and fail the same checks on ${of(s.agreement.failedChecks, N)}${same ? ": on these photos the model's reading changed no decision" : ''}.`,
  );
  const fakes = rows.filter((r) => r.category === 'fake');
  const aiStopped = fakes.filter((r) => r.aiOnly.outcome !== 'passes').map((r) => r.id);
  const aiPassed = fakes.filter((r) => r.aiOnly.outcome === 'passes').map((r) => r.id);
  const reviewPassed = rows.filter((r) => r.category === 'review' && r.aiOnly.outcome === 'passes').map((r) => r.id);
  out.push(
    `The model without the job, not asked for a verdict, stops ${of(aiStopped.length, F)} fakes${aiStopped.length ? ` (${names(aiStopped)})` : ''}${aiPassed.length ? ` and passes the other ${aiPassed.length} (${names(aiPassed)})` : ''}. It passes ${of(s.aiOnly.genuinePassed, G)} genuine proofs${reviewPassed.length ? ` and would also pass ${of(reviewPassed.length, R)} review cases (${names(reviewPassed)})` : ''}.`,
  );
  const L = s.layers;
  out.push(
    `Code alone (a photo hash, the receipt QR's store ID, file metadata or the phone's location) stops ${of(L.codeAlone.length, F)} fakes${L.codeAlone.length ? ` (${names(L.codeAlone)})` : ''}. ${L.readingOnly.length ? `The other ${L.readingOnly.length} (${names(L.readingOnly)}) are stopped only by a rule applied to what the model read.` : 'No fake needs the reading to be stopped.'}`,
  );
  if (L.notStopped.length) out.push(`Not stopped by Rules + AI: ${names(L.notStopped)}.`);
  const allStopped = L.notStopped.length === 0 && ra.genuinePassed === G;
  if (allStopped && aiPassed.length > 0 && L.readingOnly.length > 0) {
    out.push(
      `Neither layer is enough alone: code cannot read a printed time, a total, a quantity or a code, and the model is never given the job, the shop's store ID, the check-in time or earlier photos. Together they stop every fake here and pass every genuine proof. The fakes the model alone passes show what the rules add to a reader that is not given the job.`,
    );
  }
  return out;
}

export function renderMarkdown(result: AblationResult, opts: RenderOptions = {}): string {
  const s = summarize(result);
  const { fake: F, genuine: G, review: R, total: N } = s.cases;
  const committed = opts.committed ?? result.answers === 'recorded';
  const lines: string[] = [];
  const p = (...xs: string[]) => lines.push(...xs);

  p('# Ablation: which layer stops which fake', '');
  p(
    committed
      ? 'Generated by `npm run ablation` (`server/scripts/ablation/`); do not edit by hand. `server/test/ablation.test.ts`, part of `npm test`, fails when this page or [evidence/ablation.json](evidence/ablation.json) differs from a fresh run.'
      : 'Generated by `npm run ablation` (`server/scripts/ablation/`) as a scratch run, with `ablation.json` beside it; no test checks it. The committed page, `docs/ABLATION.md`, is the run on the recorded answers.',
    '',
  );
  if (opts.runNote) p(opts.runNote, '');
  p(
    `HoldMySpot decides each proof in two layers: a vision model reads the photos into fields, and code decides with photo hashes, the receipt QR, file metadata and the shared rules in \`shared/src/proofs.ts\`. This page switches each layer off in turn on the ${N} fixture photos in \`server/fixtures/proofs/\`: ${F} fakes the rules must fail, ${G} genuine proofs that must pass, and ${R} that belong to a person (needs review).`,
    '',
  );
  p(answersLine(result, s), '');
  p(
    `**In short:** ${SETTINGS.rulesAndAi.label} stops ${frac(s.rulesAndAi.fakesStopped, F)} fakes and passes ${frac(s.rulesAndAi.genuinePassed, G)} genuine proofs. The model without the job, not asked for a verdict, stops ${frac(s.aiOnly.fakesStopped, F)} fakes; code alone stops ${frac(s.layers.codeAlone.length, F)}. Each baseline switches one layer off: one gives the rules a perfect reading, the other lets the model's own report decide.`,
    '',
  );

  p('## Result', '');
  p(`| | ${SETTINGS.rulesAndAi.label} | ${SETTINGS.rulesOnly.label} | ${SETTINGS.aiOnly.label} |`, '|---|---|---|---|');
  p(summaryRow('Fakes stopped', (x) => frac(x.fakesStopped, F), s));
  p(summaryRow('Genuine proofs passed', (x) => frac(x.genuinePassed, G), s));
  p(summaryRow('Review cases stopped', (x) => frac(x.reviewStopped, R), s));
  p(summaryRow('Right outcome (stopped or passed)', (x) => frac(x.rightOutcome, N), s));
  p(summaryRow('Exact verdict (passed, failed or needs review)', (x) => (x.exactVerdicts === null ? 'no verdict' : frac(x.exactVerdicts, N)), s));
  p('', '"Stopped" means the proof failed or went to a person instead of passing.', '');
  for (const f of findings(result, s)) p(`- ${f}`);
  p('');

  p('## The three settings', '');
  p(`- **${SETTINGS.rulesAndAi.label}**: ${lowerFirst(SETTINGS.rulesAndAi.definition)}`);
  p(`- **${SETTINGS.rulesOnly.label}**: ${lowerFirst(SETTINGS.rulesOnly.definition)} It shows what the rules decide when the reading is right.`);
  p(
    `- **${SETTINGS.aiOnly.label}**: ${lowerFirst(SETTINGS.aiOnly.definition)} The model is never given the job, the shop's store ID, the check-in time or earlier photos (its prompts carry no job details on purpose, \`server/src/ai/prompts.ts\`), so this counts every problem it could report by itself.`,
  );
  p('');

  p(`## Which layer stops which fake (${F})`, '');
  p(
    '"What stopped it" lists the checks that failed in Rules + AI. **code**: the check uses no reading (photo hash, receipt QR store ID, file metadata, location). **reading**: a rule compared something the model read (in brackets) with the job, the shop, the clock or the QR.',
    '',
  );
  p(`| Fake | What is wrong | ${SETTINGS.rulesOnly.label} | ${SETTINGS.aiOnly.label} | ${SETTINGS.rulesAndAi.label} | What stopped it |`, '|---|---|---|---|---|---|');
  for (const r of ordered(result.rows, 'fake')) {
    p(`| ${id(r.id)} | ${cell(wrongWith(r))} | ${verdict(r.rulesOnly.status)} | ${cell(aiCell(r.aiOnly))} | ${verdict(r.rulesAndAi.status)} | ${cell(stoppedBy(r.rulesAndAi))} |`);
  }
  p(
    `| **Stopped** | | **${frac(s.rulesOnly.fakesStopped, F)}** | **${frac(s.aiOnly.fakesStopped, F)}** | **${frac(s.rulesAndAi.fakesStopped, F)}** | code ${frac(s.layers.codeAlone.length, F)}, reading ${frac(s.layers.ruleOnReading.length, F)} |`,
  );
  p('');

  p(`## Genuine proofs (${G})`, '');
  p(`| Proof | ${SETTINGS.rulesOnly.label} | ${SETTINGS.aiOnly.label} | ${SETTINGS.rulesAndAi.label} |`, '|---|---|---|---|');
  for (const r of ordered(result.rows, 'genuine')) p(`| ${id(r.id)} | ${verdict(r.rulesOnly.status)} | ${cell(aiCell(r.aiOnly))} | ${verdict(r.rulesAndAi.status)} |`);
  p(`| **Passed** | **${frac(s.rulesOnly.genuinePassed, G)}** | **${frac(s.aiOnly.genuinePassed, G)}** | **${frac(s.rulesAndAi.genuinePassed, G)}** |`, '');

  p(`## Review cases (${R})`, '');
  p(`| Case | Why a person should look | ${SETTINGS.rulesOnly.label} | ${SETTINGS.aiOnly.label} | ${SETTINGS.rulesAndAi.label} | What stopped it |`, '|---|---|---|---|---|---|');
  for (const r of ordered(result.rows, 'review')) {
    p(`| ${id(r.id)} | ${cell(wrongWith(r))} | ${verdict(r.rulesOnly.status)} | ${cell(aiCell(r.aiOnly))} | ${verdict(r.rulesAndAi.status)} | ${cell(stoppedBy(r.rulesAndAi))} |`);
  }
  p(`| **Stopped** | | **${frac(s.rulesOnly.reviewStopped, R)}** | **${frac(s.aiOnly.reviewStopped, R)}** | **${frac(s.rulesAndAi.reviewStopped, R)}** | |`, '');

  const flagged = result.rows.filter((r) => r.aiOnly.flags.length > 0);
  p("## The model's own flags", '');
  if (flagged.length === 0) p('The model reported no problem on any photo.');
  else {
    p(
      'Everything the model reported by itself, as it wrote it (anomalies) or as its answer shows it (no code, no line, nothing to charge). The rules do not read the anomalies: on a proof that passes, an anomaly only lowers the pipeline\'s confidence score (`confidenceOf` in `server/src/ai/proof.ts`).',
      '',
    );
    for (const r of flagged) p(`- ${id(r.id)} (${r.category}): ${r.aiOnly.flags.map(cell).join('; ')}`);
  }
  p('');

  p('## Scope', '');
  p(`- The ${N} photos are rendered by \`server/scripts/render-receipts.ts\`, each with its \`truth.json\`, so every field has a known right answer.`);
  p(`- The answers are one recorded run of one model (see Answers above). \`npm run ablation -- --live\` repeats the run with the configured model.`);
  p(
    "- The model-alone column counts what the model reports when it is asked the way HoldMySpot asks it: to read, with no job details. HoldMySpot never asks a model whether a proof is valid (the receipt prompt tells it not to decide, `server/src/ai/prompts.ts`); the rules decide.",
  );
  p("- The rules on the true reading read each photo's `truth.json`, so that column shows the rules' coverage on a correct reading (field accuracy of the real reader: `npm run ai:eval`).");
  p('- This page is about verdicts. What a failed proof does to the PayPal hold is tested elsewhere: a rejected receipt captures nothing (`server/test/processing.test.ts`).', '');

  p('## Run it', '');
  p('```sh');
  p('npm run ablation                # offline: recorded answers, no key; rewrites this page and evidence/ablation.json');
  p('npm run ablation -- --check     # exit 1 when this page or the JSON is out of date; writes nothing');
  p(`npm run ablation -- --live      # the configured model reads all ${N} photos again (${N} model calls, needs a key); writes .run/ablation/`);
  p('```', '');
  p('`npm run ablation` is the same as `npm run ai:eval -- --ablate`.');
  return `${lines.join('\n')}\n`;
}

/** The machine-readable twin of the page, for scripts that quote its numbers. */
export function renderJson(result: AblationResult): string {
  const s = summarize(result);
  const layer = (ids: string[]) => ({ count: ids.length, ids });
  const doc = {
    format: 1,
    generatedBy: 'npm run ablation (server/scripts/ablation/)',
    page: 'docs/ABLATION.md',
    answers: {
      source: result.answers,
      modelCalls: result.answers === 'live' ? s.cases.total - s.answers.recordings : 0,
      stamps: s.answers.stamps,
      recordedOn: s.answers.recordedOn,
      providerErrors: s.answers.errors,
    },
    cases: s.cases,
    settings: {
      rulesAndAi: { ...SETTINGS.rulesAndAi, ...s.rulesAndAi },
      rulesOnly: { ...SETTINGS.rulesOnly, ...s.rulesOnly },
      aiOnly: { ...SETTINGS.aiOnly, ...s.aiOnly },
    },
    layers: {
      definition:
        'Fakes in Rules + AI. codeAlone: a failed check used no reading (photo hash, receipt QR store ID, file metadata, location). ruleOnReading: a failed check compared what the model read. readingOnly: ruleOnReading without codeAlone. modelOwnFlags: the model alone (aiOnly) stopped it.',
      codeAlone: layer(s.layers.codeAlone),
      ruleOnReading: layer(s.layers.ruleOnReading),
      readingOnly: layer(s.layers.readingOnly),
      modelOwnFlags: layer(s.layers.modelOwnFlags),
      notStopped: layer(s.layers.notStopped),
    },
    agreement: { ...s.agreement, of: s.cases.total },
    rows: result.rows,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
