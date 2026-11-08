#!/usr/bin/env node
// README.md's numbers, derived from the logs and fixtures that prove them (docs/DECISIONS.md D-143).
//
//   npm run numbers                     derive docs/evidence/numbers.json from the files below and rewrite
//                                       README.md's generated blocks; then check the rest of README.md
//   npm run numbers -- --check          change nothing; exit 1 when numbers.json or README.md disagrees
//                                       with those files (server/test/readme-numbers.test.ts runs this)
//   npm run numbers -- --record         first run the zero-key commands again and save their reports in
//                                       docs/evidence/ (ai:eval, attack, the smoke check, then npm test; a
//                                       few minutes), then derive and write as above
//   npm run numbers -- --check --fresh <dir>
//                                       also compare with reports a fresh run wrote to <dir> (CI)
//
// Sources: docs/evidence/tests.json (npm test -- --json), docs/evidence/ai-eval.json (npm run ai:eval
// -- --json, recorded answers replayed), docs/evidence/attack.json (npm run attack -- --json),
// docs/evidence/smoke.json (written by --record around npm run demo -- --smoke), docs/evidence/ablation.json
// (npm run ablation), docs/SANDBOX-GATES.md and PayPal's recorded answers in
// server/test/paypal/fixtures/recorded/ (written by scripts/sandbox-gates.mjs), the logs of the 11-07 sandbox
// runs in docs/evidence/ (PayPal's GET-only read-back of both hero errands, the web app walk, the Venmo
// check), the recorded model answers in server/fixtures/ai/, and the worked example computed by the shared
// money rules (shared/src/money.ts).
//
// README.md holds generated blocks between <!-- numbers:NAME:start --> and <!-- numbers:NAME:end -->
// markers, rewritten from numbers.json, and prose that the checks below read: a hand edit of a number
// that disagrees with its source turns npm test red. Nothing here needs a key or the network.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { AI_KEY_NAMES, REPO, bold, dim, gitState, green, npmCommand, npmVersion, red, requireNode } from './common.mjs';

const USAGE = `Derive README.md's numbers from the logs and fixtures that prove them, and check README.md.

  npm run numbers [-- options]

Options:
  --check            write nothing; exit 1 when docs/evidence/numbers.json or README.md is out of date
  --record           run npm run ai:eval, npm run attack, npm run demo -- --smoke and then npm test first
                     (zero keys) and save their reports in docs/evidence/; record from a committed tree on an
                     idle machine when the reports are evidence (each report says which code it ran on)
  --fresh <dir>      with --check: also compare with the reports in <dir> (tests.json, ai-eval.json,
                     attack.json, smoke.json, any of them), written by a fresh run (CI)
  --port-offset <n>  with --record: the smoke check's port offset (default 400)
  --readme <file>    check this file instead of README.md (tests)
  --numbers <file>   compare this file instead of docs/evidence/numbers.json (tests)
  --print            print the derived numbers as JSON and stop
  -h, --help
`;

const rel = (...p) => path.join(REPO, ...p);
const SRC = {
  tests: 'docs/evidence/tests.json',
  aiEval: 'docs/evidence/ai-eval.json',
  attack: 'docs/evidence/attack.json',
  smoke: 'docs/evidence/smoke.json',
  runs: 'docs/evidence/runs.json',
  ablation: 'docs/evidence/ablation.json',
  gates: 'docs/SANDBOX-GATES.md',
  serverRun: 'server/test/paypal/fixtures/recorded/20261107-2047-lifecycle',
  firstRun: 'server/test/paypal/fixtures/recorded/20261107-1642-lifecycle',
  readback: 'docs/evidence/sandbox-readback-20261107.txt',
  webRun: 'docs/evidence/web-run-20261107.txt',
  venmo: 'docs/evidence/venmo-hold-20261107.txt',
  aiAnswers: 'server/fixtures/ai',
  rules: 'shared/src/money.ts',
};
const NUMBERS = 'docs/evidence/numbers.json';

/** The worked example's inputs (docs/DOMAIN.md section 7, shared/src/money.test.ts): Mia's request and Wei's receipt and label. */
const WORKED = { bid: { qty: 1, retailCapCents: 3600, maxFeeCents: 1200, shippingBudgetCents: 1200 }, receiptCents: 3400, labelCents: 875 };

class Stale extends Error {}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const d = (cents) => (cents / 100).toFixed(2);
const usd = (cents) => `$${d(cents)}`;
const toCents = (value) => Math.round(Number(value) * 100);
const pct = (a, b) => (b === 0 ? '-' : `${((a / b) * 100).toFixed(1)}%`);
const grouped = (n) => n.toLocaleString('en-US');
/** "row 1", "rows 21 and 22", "rows 2, 3 and 4". */
const rowList = (ns) => (ns.length === 0 ? 'no row' : ns.length === 1 ? `row ${ns[0]}` : `rows ${ns.slice(0, -1).join(', ')} and ${ns.at(-1)}`);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const majorMinor = (v) => (v ? v.split('.').slice(0, 2).join('.') : null);
const osName = (platform) => ({ darwin: 'macOS', linux: 'Linux', win32: 'Windows' })[String(platform).split(' ')[0]] ?? String(platform);

function readJson(file, hint) {
  const full = rel(file);
  if (!fs.existsSync(full)) throw new Stale(`${file} is missing${hint ? `: ${hint}` : ''}.`);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function readText(file) {
  const full = rel(file);
  if (!fs.existsSync(full)) throw new Stale(`${file} is missing.`);
  return fs.readFileSync(full, 'utf8');
}

/** JSON with keys in insertion order and a final newline, as the files are written. */
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

// ---------------------------------------------------------------------------
// Derivations, one per source
// ---------------------------------------------------------------------------

function deriveTests(report) {
  if (report.tool !== 'npm test') throw new Stale(`${SRC.tests} is not an npm test report.`);
  if (!report.ok || report.totals.failed > 0) throw new Stale(`${SRC.tests} records a failing run; README numbers come only from a green run.`);
  if (report.quick) throw new Stale(`${SRC.tests} records npm test -- --quick, which skips the server days and the attack; README numbers come only from a full run.`);
  const byPackage = {};
  for (const s of report.steps) if (s.tests !== undefined) byPackage[s.pkg] = (byPackage[s.pkg] ?? 0) + s.tests;
  const props = report.steps.flatMap((s) =>
    (s.properties ?? []).map((p) => ({ pkg: s.pkg, id: /^P\d(?:-P\d)?/.exec(p.name)?.[0] ?? p.name.split(' ')[0], name: p.name, runs: p.runs, ...(p.coverage ? { coverage: p.coverage } : {}) })),
  );
  const ids = [...new Set(props.flatMap((p) => p.name.match(/P\d-P\d|\bP\d\b/g) ?? []))];
  const covered = new Set();
  for (const id of ids) {
    const range = /^P(\d)-P(\d)$/.exec(id);
    if (range) for (let i = Number(range[1]); i <= Number(range[2]); i++) covered.add(`P${i}`);
    else covered.add(id);
  }
  return {
    steps: report.totals.steps,
    tests: report.totals.tests,
    passed: report.totals.passed,
    failed: report.totals.failed,
    skipped: report.totals.skipped,
    byPackage,
    seconds: report.seconds,
    aboutSeconds: Math.max(10, Math.round(report.seconds / 10) * 10),
    os: osName(report.platform),
    platform: report.platform,
    node: report.node,
    npm: report.npm,
    commit: report.commit,
    recordedOn: report.startedAt.slice(0, 10),
    properties: {
      tests: props.length,
      runs: sum(props.map((p) => p.runs)),
      runsByPackage: Object.fromEntries(['shared', 'server', 'ops'].map((pkg) => [pkg, sum(props.filter((p) => p.pkg === pkg).map((p) => p.runs))])),
      covers: [...covered].sort(),
      list: props.map(({ pkg, name, runs }) => ({ pkg, name, runs })),
      // What the generated server days reached (the coverage each server property prints, D-149).
      serverDays: props.filter((p) => p.pkg === 'server' && p.coverage).map((p) => ({ name: p.name, runs: p.runs, coverage: p.coverage })),
    },
  };
}

async function deriveWorkedExample() {
  const m = await import(pathToFileURL(rel(SRC.rules)).href);
  const { bid, receiptCents, labelCents } = WORKED;
  const held = m.bidLimitCents(bid);
  const caps = m.jobCaps(bid, { qty: 1, feeCents: bid.maxFeeCents }, 'ship');
  const receipt = m.receiptCapture(caps, receiptCents, 'ship');
  const shipping = m.shippingCapture(caps, labelCents, 0);
  const payouts = [
    ...m.payoutsForCapture('ship', 'receipt', { retailCents: receiptCents, feeCents: bid.maxFeeCents, shippingCents: 0 }),
    ...m.payoutsForCapture('ship', 'shipping', { retailCents: receiptCents, feeCents: 0, shippingCents: labelCents }),
  ];
  const captureFees = [m.paypalCaptureFeeCents(receipt.amountCents), m.paypalCaptureFeeCents(shipping.amountCents)];
  const payoutFee = m.PAYPAL_PRICING.payoutItemCents;
  const paidOut = sum(payouts.map((p) => p.amountCents));
  const settlement = m.jobSettlement({
    capturedCents: receipt.amountCents + shipping.amountCents,
    refundedCents: 0,
    paidOutCents: paidOut,
    processingCents: receipt.processingCents + shipping.processingCents,
    paypalFeesCents: sum(captureFees) + payouts.length * payoutFee,
  });
  return {
    inputs: { retailCapCents: bid.retailCapCents, maxFeeCents: bid.maxFeeCents, shippingBudgetCents: bid.shippingBudgetCents, receiptCents, labelCents },
    pricing: { captureBps: m.PAYPAL_PRICING.captureBps, captureFixedCents: m.PAYPAL_PRICING.captureFixedCents, payoutItemCents: payoutFee },
    processingReserveCents: m.processingReserveCents(bid),
    heldCents: held,
    receiptCapture: { amountCents: receipt.amountCents, retailCents: receipt.retailCents, feeCents: receipt.feeCents, processingCents: receipt.processingCents, paypalFeeCents: captureFees[0], payoutFeesCents: receipt.payoutFeesCents },
    shippingCapture: { amountCents: shipping.amountCents, shippingCents: shipping.shippingCents, processingCents: shipping.processingCents, paypalFeeCents: captureFees[1] },
    capturedCents: settlement.chargedCents,
    releasedCents: held - settlement.chargedCents,
    payouts: payouts.map((p) => ({ purpose: p.purpose, amountCents: p.amountCents })),
    paidOutCents: settlement.paidOutCents,
    processingCents: settlement.processingCents,
    paypalFeesCents: settlement.paypalFeesCents,
    platformCents: settlement.platformCents,
  };
}

function readFixtures(dir) {
  const full = rel(dir);
  if (!fs.existsSync(full)) throw new Stale(`${dir} is missing.`);
  return fs
    .readdirSync(full)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(full, f), 'utf8')) }));
}

/** One recorded lifecycle run: PayPal's own answers to GET calls after the errand (scripts/lib/sandbox-lifecycle.mjs). */
function deriveRun(dir) {
  const fx = readFixtures(dir);
  const of = (op) => fx.filter((f) => f.op === op).map((f) => f.body);
  const auth = of('authorizations.get').at(-1);
  const order = of('orders.get').at(-1);
  if (!auth || !order) throw new Stale(`${dir} has no authorization or order answer.`);
  const captures = of('captures.get')
    .map((c) => ({ id: c.id, status: c.status, amountCents: toCents(c.amount.value), paypalFeeCents: toCents(c.seller_receivable_breakdown.paypal_fee.value), final: c.final_capture, at: c.create_time }))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map(({ at, ...c }) => c);
  const payouts = of('payouts.get')
    .map((p) => ({
      batch: p.batch_header.payout_batch_id,
      purpose: /:fee@/.test(p.batch_header.sender_batch_header.sender_batch_id) ? 'fee' : 'reimbursement',
      status: p.batch_header.batch_status,
      amountCents: toCents(p.batch_header.amount.value),
      paypalFeeCents: sum((p.items ?? []).map((i) => toCents(i.payout_item_fee?.value ?? 0))),
      at: p.batch_header.time_created,
    }))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map(({ at, ...p }) => p);
  const tracker = order.purchase_units?.[0]?.shipping?.trackers?.[0] ?? null;
  const capturedCents = sum(captures.map((c) => c.amountCents));
  const paidOutCents = sum(payouts.map((p) => p.amountCents));
  const paypalFeesCents = sum(captures.map((c) => c.paypalFeeCents)) + sum(payouts.map((p) => p.paypalFeeCents));
  return {
    run: path.basename(dir).replace(/-[a-z]+$/, ''),
    fixtures: dir,
    order: order.id,
    authorization: { id: auth.id, status: auth.status, amountCents: toCents(auth.amount.value) },
    captures,
    capturedCents,
    releasedCents: toCents(auth.amount.value) - capturedCents,
    tracking: tracker ? { number: tracker.id.split('-').slice(1).join('-'), status: tracker.status } : null,
    payouts,
    paidOutCents,
    paypalFeesCents,
    platformCents: capturedCents - paidOutCents - paypalFeesCents,
  };
}

/** The GET-only read-back log: one section per run ("== name"), each line one PayPal answer (ids, statuses, amounts). */
function deriveReadback(text) {
  const runs = {};
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    let m = /^== (.+)$/.exec(line);
    if (m) {
      cur = { name: m[1], captures: [], payouts: [] };
      runs[/^lifecycle (\d{8}-\d{4})/.exec(m[1])?.[1] ?? (/web app run/.test(m[1]) ? 'web' : m[1])] = cur;
      continue;
    }
    if (!cur) continue;
    if ((m = /^authorization (\S+) \$([\d.]+) (\w+) order (\S+)$/.exec(line))) cur.authorization = { id: m[1], amountCents: toCents(m[2]), status: m[3], order: m[4] };
    else if ((m = /^order (\S+) (\w+); trackers: (\S+) (\w+)$/.exec(line))) cur.order = { id: m[1], status: m[2], tracking: { number: m[3], status: m[4] } };
    else if ((m = /^capture (\S+) \$([\d.]+) (\w+) fee \$([\d.]+) schedule \$([\d.]+)$/.exec(line))) cur.captures.push({ id: m[1], amountCents: toCents(m[2]), status: m[3], paypalFeeCents: toCents(m[4]), scheduleCents: toCents(m[5]) });
    else if ((m = /^payout batch (\S+) (\w+) item (\S+) \$([\d.]+) (\w+) fee \$([\d.]+)$/.exec(line))) cur.payouts.push({ batch: m[1], batchStatus: m[2], item: m[3], amountCents: toCents(m[4]), status: m[5], paypalFeeCents: toCents(m[6]) });
    else if ((m = /^captured \$([\d.]+), released \$([\d.]+), paid out \$([\d.]+), PayPal fees \$([\d.]+), left with HoldMySpot \$([\d.]+)$/.exec(line))) {
      cur.totals = { capturedCents: toCents(m[1]), releasedCents: toCents(m[2]), paidOutCents: toCents(m[3]), paypalFeesCents: toCents(m[4]), platformCents: toCents(m[5]) };
    }
  }
  const takenAt = /^# Run (\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC)/m.exec(text)?.[1] ?? null;
  for (const [key, r] of Object.entries(runs)) {
    if (!r.authorization || !r.order || !r.totals || r.captures.length === 0) throw new Stale(`${SRC.readback}: the ${key} section is incomplete.`);
  }
  return { takenAt, runs };
}

/** The web app walk's own checks of the server's ledger and payouts (web/scripts/sandbox-walk.mjs output). */
function deriveWalk(text) {
  const ids = JSON.parse(/^Ids: (\{[\s\S]*?\n\})$/m.exec(text)?.[1] ?? 'null');
  const result = /^(\d+)\/(\d+) checks passed\.$/m.exec(text);
  if (!ids || !result) throw new Stale(`${SRC.webRun} has no Ids block or check count.`);
  const ledger = /^ok +Ledger for Mia: held (\d+), captured (\d+) and (\d+), released (\d+)/m.exec(text);
  const payouts = /^ok +Payouts to Wei: fee (\d+) and reimbursement (\d+), both succeeded/m.exec(text);
  return {
    checks: { passed: Number(result[1]), of: Number(result[2]) },
    order: ids.order,
    authorization: ids.authorization,
    tracking: ids.tracking,
    captures: ids.captures.map((c) => {
      const m = /^(\S+) \$([\d.]+) \(PayPal fee \$([\d.]+)\)$/.exec(c);
      return { id: m[1], amountCents: toCents(m[2]), paypalFeeCents: toCents(m[3]) };
    }),
    payouts: ids.payouts.map((p) => {
      const m = /^(\w+) \$([\d.]+) batch (\S+) item (\S+)$/.exec(p);
      return { purpose: m[1], amountCents: toCents(m[2]), batch: m[3], item: m[4] };
    }),
    ledger: ledger ? { heldCents: Number(ledger[1]), capturedCents: [Number(ledger[2]), Number(ledger[3])], releasedCents: Number(ledger[4]) } : null,
    payoutCents: payouts ? { fee: Number(payouts[1]), reimbursement: Number(payouts[2]) } : null,
    liveModel: /AI muse\/muse-spark-1\.3 live/.test(text),
  };
}

/** The Venmo check: the server's record of the request after the approval through PayPal's Venmo button. */
function deriveVenmo(text) {
  const rec = JSON.parse(/^server: (\{.*\})$/m.exec(text)?.[1] ?? 'null');
  if (!rec) throw new Stale(`${SRC.venmo} has no server record.`);
  return { authorization: rec.authorization, order: rec.order, amountCents: rec.amount, button: rec.funding, holdStatus: rec.holdStatus, takenAt: /^# The web app's Venmo check on the real PayPal sandbox, (\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC)/m.exec(text)?.[1] ?? null };
}

/** A Markdown table's rows after a line that starts with `header`: the cells of each row, trimmed. */
function tableAfter(text, header) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith(header));
  if (at < 0) return [];
  const rows = [];
  for (let i = at + 2; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i].replace(/^\|\s*|\s*\|$/g, '').split(/\s+\|\s+/));
  return rows;
}

function deriveGates(text, serverRun) {
  const gates = {};
  for (const [id, , status] of tableAfter(text, '| Gate |')) gates[id] = status;
  const by = (status) => Object.keys(gates).filter((g) => gates[g] === status).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const section = text.split('## Full job through the server (sandbox)')[1]?.split('\n## ')[0] ?? '';
  const checks = tableAfter(section, '| Check |');
  const idsLine = /^Ids: (.*)$/m.exec(section)?.[1] ?? '';
  const runs = tableAfter(text, '| Run |');
  const lifecycle = runs.find(([run, , , command]) => run === serverRun.run && command === 'lifecycle');
  const edges = tableAfter(text.split('## Edge cases')[1] ?? '', '| Call |').map(([call, answer]) => ({ call, answer }));
  const probeRun = /run (\d{8}-\d{4})\. The emulator/.exec(text)?.[1] ?? null;
  return {
    page: SRC.gates,
    lastUpdate: /^Last update: ([^.]+)\./m.exec(text)?.[1] ?? null,
    pass: by('pass'),
    waiting: by('waiting'),
    notRun: by('not run'),
    serverRun: {
      run: lifecycle ? lifecycle[0] : null,
      passed: /\): passed\./.test(section),
      checks: checks.length,
      matches: checks.filter((c) => c[1] === 'match').length,
      ids: idsLine,
    },
    probeRun,
    edges,
  };
}

function deriveAnswers(dir) {
  const full = rel(dir);
  const answers = [];
  for (const task of fs.readdirSync(full).sort()) {
    for (const f of fs.readdirSync(path.join(full, task)).sort()) {
      if (f.endsWith('.json')) answers.push(JSON.parse(fs.readFileSync(path.join(full, task, f), 'utf8')));
    }
  }
  const latency = answers.map((a) => a.latencyMs).sort((a, b) => a - b);
  const models = [...new Set(answers.map((a) => `${a.provider}/${a.model}`))];
  return {
    recordings: answers.length,
    models,
    recordedOn: [...new Set(answers.map((a) => a.recordedAt.slice(0, 10)))].sort(),
    medianMs: latency[Math.floor(latency.length / 2)] ?? 0,
    medianSeconds: Number(((latency[Math.floor(latency.length / 2)] ?? 0) / 1000).toFixed(1)),
    maxMs: latency.at(-1) ?? 0,
  };
}

function deriveAiEval(report, answers) {
  const r = report.reports;
  const stamps = Object.entries(report.answers ?? {});
  const replayed = sum(stamps.filter(([s]) => s.endsWith('/replay')).map(([, n]) => n));
  if (replayed !== r.length) throw new Stale(`${SRC.aiEval} must replay recorded answers only (npm run ai:eval with no flags); it has ${stamps.map(([s, n]) => `${n} ${s}`).join(', ')}.`);
  const fields = r.flatMap((x) => x.fields);
  const money = r.filter((x) => x.moneyOk !== null);
  const fakes = r.filter((x) => x.expected === 'failed');
  const genuine = r.filter((x) => x.expected === 'passed');
  return {
    cases: r.length,
    purchaseProofs: r.filter((x) => x.kind === 'purchase').length,
    linePhotos: r.filter((x) => x.kind === 'check_in').length,
    expected: { failed: fakes.length, passed: genuine.length, needsReview: r.filter((x) => x.expected === 'needs_review').length },
    stamp: stamps[0]?.[0].replace(/\/replay$/, '') ?? null,
    replayed,
    modelCalls: r.length - replayed,
    verdicts: r.filter((x) => x.verdictOk).length,
    exactCheckSets: r.filter((x) => x.checksOk).length,
    money: { ok: money.filter((x) => x.moneyOk).length, of: money.length },
    fields: { ok: fields.filter((f) => f.ok).length, of: fields.length },
    badProofsCaught: { caught: fakes.filter((x) => x.got === 'failed').length, of: fakes.length },
    genuineWronglyFailed: { failed: genuine.filter((x) => x.got === 'failed').length, of: genuine.length },
    recorded: answers,
  };
}

function deriveAblation(j) {
  const s = (k) => {
    const x = j.settings[k];
    return { fakesStopped: x.fakesStopped, genuinePassed: x.genuinePassed, reviewStopped: x.reviewStopped, rightOutcome: x.rightOutcome, exactVerdicts: x.exactVerdicts ?? null };
  };
  return {
    page: j.page,
    cases: j.cases,
    modelCalls: j.answers.modelCalls,
    rulesAndAi: s('rulesAndAi'),
    rulesOnly: s('rulesOnly'),
    aiOnly: s('aiOnly'),
    codeAlone: j.layers.codeAlone.count,
    readingOnly: j.layers.readingOnly.count,
  };
}

function deriveAttack(report) {
  if (report.tool !== 'npm run attack') throw new Stale(`${SRC.attack} is not an npm run attack report.`);
  if (!report.ok) throw new Stale(`${SRC.attack} records a run where money moved wrongly or an attempt was not stopped.`);
  if (report.rows.some((x) => x.outcome === undefined)) throw new Stale(`${SRC.attack} predates the outcome of each row (D-149): run npm run numbers -- --record.`);
  const zero = (m) => m.captured === 0 && m.refunded === 0 && m.paidOut === 0 && m.held === 0;
  const by = (o) => report.rows.filter((x) => x.ok && x.outcome === o);
  const moved = (x) => ({ n: x.n, id: x.id, capturedCents: x.moved.captured, paidOutCents: x.moved.paidOut });
  // The layer of each refusal, as the run derived it from the answer (D-149).
  const layers = {};
  for (const row of by('refused')) layers[row.stoppedBy] = (layers[row.stoppedBy] ?? 0) + 1;
  return {
    attempts: report.rows.length,
    movedNothing: report.rows.filter((x) => zero(x.moved)).length,
    refused: by('refused').length,
    toPerson: by('to_a_person').map((x) => x.n),
    intended: by('intended').map(moved),
    capped: by('capped').map(moved),
    knownLimits: by('known_limit').map(moved),
    stoppedBy: layers,
    markets: report.markets.length,
    // Holds a capture was tried on; the seeded crowd's other holds in those markets are not counted.
    holdsChecked: sum(report.markets.map((m) => m.holds ?? 0)),
    jobsChecked: sum(report.markets.map((m) => m.jobs ?? 0)),
    violations: sum(report.markets.map((m) => m.violations.length)),
    rows: report.rows.map((x) => ({ n: x.n, id: x.id, stoppedBy: x.stoppedBy, code: x.code, outcome: x.outcome, moved: x.moved })),
    serverStartedHere: report.server?.startedHere ?? null,
    recordedOn: report.startedAt.slice(0, 10),
  };
}

function deriveRuns(report) {
  const seconds = (cmd) => report.commands.find((c) => c.command === cmd)?.seconds ?? null;
  const attack = seconds('npm run attack');
  return {
    recordedOn: report.startedAt.slice(0, 10),
    attackSeconds: attack,
    // README states the attack's duration loosely; runs.json keeps the exact time and the machine's load beside it.
    attackDuration: attack === null ? null : attack < 60 ? 'under a minute' : attack < 90 ? 'about a minute' : `about ${Math.round(attack / 60)} minutes`,
    aiEvalSeconds: seconds('npm run ai:eval'),
    commands: report.commands.map((c) => c.command),
  };
}

function deriveSmoke(report) {
  if (!report.ok) throw new Stale(`${SRC.smoke} records a failed smoke check.`);
  return { answered: report.answered, readySeconds: report.readySeconds, paypal: report.paypal, ai: report.ai, os: osName(report.platform), node: report.node, recordedOn: report.startedAt.slice(0, 10) };
}

/** Which code each log in docs/evidence/ ran on (D-149): claims.md's generated "logs" table. */
function deriveLogs() {
  const kinds = [
    ['tests', 'npm test -- --json', 'startedAt'],
    ['aiEval', 'npm run ai:eval -- --json', 'at'],
    ['attack', 'npm run attack -- --json', 'startedAt'],
    ['smoke', 'npm run demo -- --smoke', 'startedAt'],
    ['runs', 'npm run numbers -- --record', 'startedAt'],
  ];
  const logs = [];
  for (const [key, tool, atKey] of kinds) {
    if (!fs.existsSync(rel(SRC[key]))) continue;
    const r = readJson(SRC[key]);
    logs.push({
      file: path.basename(SRC[key]),
      path: SRC[key],
      tool,
      at: typeof r[atKey] === 'string' ? r[atKey].slice(0, 16).replace('T', ' ') : null,
      commit: r.commit ?? null,
      uncommittedChanges: r.uncommittedChanges ?? null,
      codeTrees: r.codeTrees ?? null,
    });
  }
  return logs;
}

async function derive() {
  const tests = deriveTests(readJson(SRC.tests, 'run npm run numbers -- --record'));
  const worked = await deriveWorkedExample();
  const serverRun = deriveRun(SRC.serverRun);
  const firstRun = deriveRun(SRC.firstRun);
  const readback = deriveReadback(readText(SRC.readback));
  const walk = deriveWalk(readText(SRC.webRun));
  const venmo = deriveVenmo(readText(SRC.venmo));
  const gates = deriveGates(readText(SRC.gates), serverRun);
  const answers = deriveAnswers(SRC.aiAnswers);
  const aiEval = deriveAiEval(readJson(SRC.aiEval, 'run npm run numbers -- --record'), answers);
  const ablation = deriveAblation(readJson(SRC.ablation, 'run npm run ablation'));
  const attack = deriveAttack(readJson(SRC.attack, 'run npm run numbers -- --record'));
  const smoke = deriveSmoke(readJson(SRC.smoke, 'run npm run numbers -- --record'));
  // Durations come only from a --record run; without one, README's stated durations are not checked.
  const runs = fs.existsSync(rel(SRC.runs)) ? deriveRuns(readJson(SRC.runs)) : null;

  // The sandbox run must be the worked example to the cent: the rules' numbers are PayPal's numbers.
  const same = {
    held: serverRun.authorization.amountCents === worked.heldCents,
    captures: isDeepStrictEqual(
      serverRun.captures.map((c) => [c.amountCents, c.paypalFeeCents]),
      [
        [worked.receiptCapture.amountCents, worked.receiptCapture.paypalFeeCents],
        [worked.shippingCapture.amountCents, worked.shippingCapture.paypalFeeCents],
      ],
    ),
    released: serverRun.releasedCents === worked.releasedCents,
    payouts: isDeepStrictEqual(
      serverRun.payouts.map((p) => [p.purpose, p.amountCents, p.paypalFeeCents]),
      worked.payouts.map((p) => [p.purpose, p.amountCents, worked.pricing.payoutItemCents]),
    ),
    fees: serverRun.paypalFeesCents === worked.paypalFeesCents && worked.paypalFeesCents === worked.processingCents,
    platform: serverRun.platformCents === worked.platformCents,
  };
  const off = Object.keys(same).filter((k) => !same[k]);
  if (off.length > 0) throw new Stale(`PayPal's recorded run ${serverRun.run} differs from the worked example in shared/src/money.ts: ${off.join(', ')}.`);
  if (!serverRun.tracking) throw new Stale(`${SRC.serverRun} has no tracker on the order.`);

  // Two reads of the server run from PayPal (the gate script's fixtures, the later GET-only read-back) must agree.
  const again = readback.runs[serverRun.run];
  if (!again) throw new Stale(`${SRC.readback} has no section for run ${serverRun.run}.`);
  const sameRun =
    again.authorization.id === serverRun.authorization.id &&
    again.authorization.amountCents === serverRun.authorization.amountCents &&
    again.authorization.order === serverRun.order &&
    again.order.tracking.number === serverRun.tracking.number &&
    isDeepStrictEqual(again.captures.map((c) => [c.id, c.amountCents, c.paypalFeeCents]), serverRun.captures.map((c) => [c.id, c.amountCents, c.paypalFeeCents])) &&
    isDeepStrictEqual(again.payouts.map((p) => [p.batch, p.amountCents, p.paypalFeeCents]), serverRun.payouts.map((p) => [p.batch, p.amountCents, p.paypalFeeCents])) &&
    again.totals.platformCents === serverRun.platformCents;
  if (!sameRun) throw new Stale(`${SRC.readback} and ${SRC.serverRun} disagree about run ${serverRun.run}.`);

  // The web app run: PayPal's side (the read-back) must be the worked example, and the walk's ledger must be PayPal's side.
  const web = readback.runs.web;
  if (!web) throw new Stale(`${SRC.readback} has no section for the web app run.`);
  const webAmounts = {
    held: web.authorization.amountCents === worked.heldCents,
    captures: isDeepStrictEqual(web.captures.map((c) => [c.amountCents, c.paypalFeeCents, c.scheduleCents]), [
      [worked.receiptCapture.amountCents, worked.receiptCapture.paypalFeeCents, worked.receiptCapture.paypalFeeCents],
      [worked.shippingCapture.amountCents, worked.shippingCapture.paypalFeeCents, worked.shippingCapture.paypalFeeCents],
    ]),
    totals: web.totals.releasedCents === worked.releasedCents && web.totals.paypalFeesCents === worked.paypalFeesCents && web.totals.platformCents === worked.platformCents && web.totals.paidOutCents === worked.paidOutCents,
    payouts: isDeepStrictEqual(web.payouts.map((p) => [p.amountCents, p.paypalFeeCents]), worked.payouts.map((p) => [p.amountCents, worked.pricing.payoutItemCents])),
  };
  const offWeb = Object.keys(webAmounts).filter((k) => !webAmounts[k]);
  if (offWeb.length > 0) throw new Stale(`${SRC.readback}: the web app run differs from the worked example: ${offWeb.join(', ')}.`);
  const byId = (xs) => [...xs].sort((a, b) => a.id.localeCompare(b.id)).map((c) => [c.id, c.amountCents, c.paypalFeeCents]);
  const sameWeb =
    walk.order === web.authorization.order &&
    walk.authorization === web.authorization.id &&
    walk.tracking === web.order.tracking.number &&
    isDeepStrictEqual(byId(walk.captures), byId(web.captures)) &&
    isDeepStrictEqual(
      [...walk.payouts].sort((a, b) => a.batch.localeCompare(b.batch)).map((p) => [p.batch, p.item, p.amountCents]),
      [...web.payouts].sort((a, b) => a.batch.localeCompare(b.batch)).map((p) => [p.batch, p.item, p.amountCents]),
    ) &&
    walk.ledger?.heldCents === web.authorization.amountCents &&
    isDeepStrictEqual([...(walk.ledger?.capturedCents ?? [])].sort((a, b) => a - b), web.captures.map((c) => c.amountCents).sort((a, b) => a - b)) &&
    walk.ledger?.releasedCents === web.totals.releasedCents &&
    walk.checks.passed === walk.checks.of;
  if (!sameWeb) throw new Stale(`${SRC.webRun} (the server's ledger) and ${SRC.readback} (PayPal) disagree about the web app run.`);
  const purposeOf = (batch) => walk.payouts.find((p) => p.batch === batch)?.purpose ?? null;
  const webRun = {
    readBackAt: readback.takenAt,
    order: web.authorization.order,
    orderStatus: web.order.status,
    authorization: { id: web.authorization.id, status: web.authorization.status, amountCents: web.authorization.amountCents },
    captures: web.captures.map(({ id, status, amountCents, paypalFeeCents }) => ({ id, status, amountCents, paypalFeeCents })),
    releasedCents: web.totals.releasedCents,
    tracking: web.order.tracking,
    payouts: web.payouts.map((p) => ({ purpose: purposeOf(p.batch), batch: p.batch, item: p.item, status: p.status, amountCents: p.amountCents, paypalFeeCents: p.paypalFeeCents })),
    paypalFeesCents: web.totals.paypalFeesCents,
    platformCents: web.totals.platformCents,
    walkChecks: walk.checks,
    liveModel: walk.liveModel,
    matchesWorkedExample: true,
    matchesLedger: true,
  };

  return {
    format: 1,
    generatedBy: 'npm run numbers (scripts/readme-numbers.mjs)',
    note: 'Derived from the files in "sources"; do not edit. server/test/readme-numbers.test.ts fails when this file or README.md disagrees with them.',
    sources: SRC,
    tests,
    workedExample: worked,
    sandbox: { serverRun: { ...serverRun, matchesWorkedExample: true, readBackAgain: readback.takenAt }, webRun, firstRun, venmo, gates },
    aiEval,
    ablation,
    attack,
    smoke,
    runs,
    logs: deriveLogs(),
  };
}

// ---------------------------------------------------------------------------
// README.md: generated blocks
// ---------------------------------------------------------------------------

const BLOCKS = {
  'hero-totals': (n) => {
    const w = n.workedExample;
    const [fee, reimb] = [w.payouts.find((p) => p.purpose === 'fee'), w.payouts.find((p) => p.purpose === 'reimbursement')];
    const shopFee = w.receiptCapture.retailCents;
    return [
      `Mia: held \\${usd(w.heldCents)}, charged \\${usd(w.capturedCents)} (\\${usd(shopFee)} shop price, \\${usd(w.receiptCapture.feeCents)} fee, \\${usd(w.shippingCapture.shippingCents)} shipping, \\${usd(w.processingCents)} processing), \\${usd(w.releasedCents)} released.` +
        ` Wei: received \\${usd(w.paidOutCents)} (\\${usd(reimb.amountCents)} back for the plush and the postage he paid, \\${usd(fee.amountCents)} for his time).` +
        ` PayPal: \\${usd(w.paypalFeesCents)} (\\${usd(w.receiptCapture.paypalFeeCents)} and \\${usd(w.shippingCapture.paypalFeeCents)} on the two captures, \\${usd(w.pricing.payoutItemCents)} on each payout), exactly the processing line.` +
        ` HoldMySpot: \\${usd(w.platformCents)}, 10% of the queue fee. The fake receipt: \\$0.`,
    ];
  },
  'ai-eval': (n) => {
    const a = n.aiEval;
    return [
      '```text',
      `Cases: ${a.cases} (${a.purchaseProofs} purchase proofs, ${a.linePhotos} line photos)`,
      `Answers: ${a.replayed} replayed from recorded ${a.stamp} answers. No model was called in this run.`,
      `Verdict accuracy:         ${a.verdicts}/${a.cases} = ${pct(a.verdicts, a.cases)}`,
      `Exact failed-check sets:  ${a.exactCheckSets}/${a.cases} = ${pct(a.exactCheckSets, a.cases)}`,
      `Money (retail, capture):  ${a.money.ok}/${a.money.of} = ${pct(a.money.ok, a.money.of)}`,
      `Fields read correctly:    ${a.fields.ok}/${a.fields.of} = ${pct(a.fields.ok, a.fields.of)}`,
      `Bad proofs caught:        ${a.badProofsCaught.caught}/${a.badProofsCaught.of}; genuine proofs wrongly failed: ${a.genuineWronglyFailed.failed}/${a.genuineWronglyFailed.of}`,
      '```',
    ];
  },
  tests: (n) => {
    const t = n.tests;
    return [
      '```sh',
      `npm test              # shared, server, web and ops: type checks and ${t.tests} tests, ends with "All green: ${t.steps} steps"`,
      'npm test -- --quick   # the same without the generated server days and the attack, for a short check',
      'npm test -- --build   # also the web and ops production builds',
      '```',
    ];
  },
  evidence: (n) => {
    const t = n.tests;
    const w = n.workedExample;
    const run = n.sandbox.serverRun;
    const g = n.sandbox.gates;
    const web = n.sandbox.webRun;
    const a = n.aiEval;
    const ab = n.ablation;
    const at = n.attack;
    const s = n.smoke;
    const pkgs = Object.entries(t.byPackage).map(([p, c]) => `${p} ${c}`).join(', ');
    const fees = run.captures.map((c) => `\\${usd(c.paypalFeeCents)}`).join(' + ') + ` + ${run.payouts.length} x \\${usd(w.pricing.payoutItemCents)}`;
    const capt = run.captures.map((c) => `\\${usd(c.amountCents)}`).join(' + ');
    const paid = run.payouts.map((p) => `\\${usd(p.amountCents)}`).join(' + ');
    const layers = Object.entries(at.stoppedBy).map(([k, v]) => `${k} ${v}`).join(', ');
    const days = t.properties.serverDays[0];
    const p5 = t.properties.list.find((p) => p.pkg === 'server' && /^P5\b/.test(p.name));
    const c = days?.coverage;
    const daysLine = c
      ? `The ${days.runs} days of ${days.name.split(':')[0]} reached ${c.checkIns} passed check-ins, ${c.matches} matches (${c.clockFills} below the opening fee), ${c.completed} completed jobs, ${c.rejected} receipts failing a hard check, ${c.failures} PayPal failures injected, ${c.restarts} server restarts and ${c.reassigned} reassignments`
      : 'The server days printed no coverage';
    const list = (xs) => xs.join(', ');
    return [
      '| Claim | Result | Run it | Log or fixture |',
      '|---|---|---|---|',
      `| The tests pass with no keys, calling neither PayPal nor a model | ${t.tests} tests in ${t.steps} steps: ${t.passed} passed, ${t.failed} failed (${pkgs}); on ${t.os} (${t.platform.split(' ')[1]}), Node ${t.node}, npm ${t.npm}, ${t.recordedOn} | \`npm test\` | [tests.json](docs/evidence/tests.json) |`,
      `| The money and market rules hold on generated cases (${t.properties.covers[0]} to ${t.properties.covers.at(-1)}) | ${t.properties.tests} property tests, ${grouped(t.properties.runs)} generated cases in every \`npm test\` (fixed seed; each test's name gives its runs): ${grouped(t.properties.runsByPackage.shared)} cases of the shared rules, ${grouped(t.properties.runsByPackage.ops)} rescheduler mornings on the ops console's replay model, and ${grouped(t.properties.runsByPackage.server)} generated market days on the server with the PayPal emulator${p5 ? ` (P5 plays each of its ${p5.runs} days twice, with and without PayPal failures)` : ''}. ${daysLine} | \`npm test\` | [tests.json](docs/evidence/tests.json) |`,
      `| PayPal's sandbox charged what the rules say | Run \`${run.run}\`: held \\${usd(run.authorization.amountCents)}, captured ${capt}, released \\${usd(run.releasedCents)}, paid out ${paid}; PayPal's fees ${fees} = \\${usd(run.paypalFeesCents)}, the processing line; HoldMySpot kept \\${usd(run.platformCents)}; ${g.serverRun.matches} of ${g.serverRun.checks} read-back checks match; the same amounts as the worked example in \`shared/src/money.ts\` | \`npm run gates -- lifecycle\` (your sandbox keys) | [SANDBOX-GATES.md](docs/SANDBOX-GATES.md#full-job-through-the-server-sandbox), [PayPal's answers](${run.fixtures}/) |`,
      `| The web app run on PayPal's sandbox read back the same | PayPal on ${web.readBackAt}: authorization \`${web.authorization.id}\` \\${usd(web.authorization.amountCents)} ${web.authorization.status}; captures ${web.captures.map((c) => `\\${usd(c.amountCents)}`).join(' + ')} ${[...new Set(web.captures.map((c) => c.status))].join(', ')} (PayPal's fees ${web.captures.map((c) => `\\${usd(c.paypalFeeCents)}`).join(' + ')}); released \\${usd(web.releasedCents)}; payouts ${web.payouts.map((p) => `\\${usd(p.amountCents)}`).join(' + ')} ${[...new Set(web.payouts.map((p) => p.status))].join(', ')}; tracking ${web.tracking.status}; HoldMySpot kept \\${usd(web.platformCents)}. The walk's own checks of the server's ledger: ${web.walkChecks.passed}/${web.walkChecks.of}, the same ids and amounts | \`web/scripts/sandbox-walk.mjs\` (your sandbox keys, a second sandbox buyer) | [web-run-20261107.txt](docs/evidence/web-run-20261107.txt), [sandbox-readback-20261107.txt](docs/evidence/sandbox-readback-20261107.txt) |`,
      `| Sandbox gates | pass: ${list(g.pass)}; waiting: ${list(g.waiting)}; not run: ${list(g.notRun)} | \`npm run gates -- status\` (your sandbox keys) | [SANDBOX-GATES.md](docs/SANDBOX-GATES.md) |`,
      `| The model reads, the rules decide (${a.cases} demo photos, recorded ${a.stamp} answers) | ${a.modelCalls} model calls: ${a.verdicts}/${a.cases} verdicts, ${a.exactCheckSets}/${a.cases} exact failed-check sets, ${a.money.ok}/${a.money.of} money, ${a.fields.ok}/${a.fields.of} fields, ${a.badProofsCaught.caught}/${a.badProofsCaught.of} bad proofs caught, ${a.genuineWronglyFailed.failed}/${a.genuineWronglyFailed.of} genuine proofs failed | \`npm run ai:eval\` | [ai-eval.json](docs/evidence/ai-eval.json) |`,
      `| Which layer stops which fake | Fakes stopped: Rules + AI ${ab.rulesAndAi.fakesStopped}/${ab.cases.fake}; the rules on the true reading (each photo's truth.json, not a reader) ${ab.rulesOnly.fakesStopped}/${ab.cases.fake}; the model without the job, not asked for a verdict, ${ab.aiOnly.fakesStopped}/${ab.cases.fake}; code alone ${ab.codeAlone}/${ab.cases.fake}, a rule on the model's reading for the other ${ab.readingOnly}; genuine proofs passed ${ab.rulesAndAi.genuinePassed}/${ab.cases.genuine} in each | \`npm run ablation\` | [ABLATION.md](docs/ABLATION.md), [ablation.json](docs/evidence/ablation.json) |`,
      `| What the cheating attempts move | ${at.attempts} attempts: ${at.refused} refused with \\$0.00 moved (${layers}); ${rowList(at.toPerson)} sent to a person, \\$0.00 until they decide; ${rowList(at.intended.map((x) => x.n))} moved exactly the genuine receipt's amount; ${rowList(at.capped.map((x) => x.n))} paid shipping as claimed, up to the budget; ${rowList(at.knownLimits.map((x) => x.n))} got through, the known limits (a receipt reprinted at the cap, a spoofed position); ${at.violations === 0 ? 'no hold captured more than it held and no job paid out more than it charged' : `${at.violations} broken invariants`} in ${at.markets} markets (${at.holdsChecked} holds a capture was tried on, ${at.jobsChecked} jobs) | \`npm run attack\` | [attack.json](docs/evidence/attack.json) |`,
      `| A fresh start answers with no keys | ${list(s.answered)} answered, ready in ${s.readySeconds} s. PayPal: ${s.paypal}. AI: ${s.ai} | \`npm run demo -- --smoke\` | [smoke.json](docs/evidence/smoke.json) |`,
    ];
  },
};

const CODE_FOLDERS = ['shared', 'server', 'web', 'ops', 'scripts'];

/** claims.md's generated blocks: the code each log ran on. */
const CLAIMS_BLOCKS = {
  logs: (n) => [
    '| Log | Made by | Recorded (UTC) | Commit | Uncommitted changes | Git trees of shared, server, web, ops and scripts |',
    '|---|---|---|---|---|---|',
    ...n.logs.map(
      (l) =>
        `| [${l.file}](${l.path}) | \`${l.tool}\` | ${l.at ?? '-'} | ${l.commit ? `\`${l.commit}\`` : '-'} | ${l.uncommittedChanges === null ? '-' : l.uncommittedChanges ? 'yes' : 'no'} | ${l.codeTrees ? CODE_FOLDERS.map((f) => `\`${l.codeTrees[f] ?? '-'}\``).join(', ') : 'not recorded'} |`,
    ),
  ],
};

const marker = (name, edge) => `<!-- numbers:${name}:${edge} -->`;

function renderReadme(readme, numbers, blocks = BLOCKS) {
  let out = readme;
  const missing = [];
  for (const [name, render] of Object.entries(blocks)) {
    const start = marker(name, 'start');
    const end = marker(name, 'end');
    const i = out.indexOf(start);
    const j = out.indexOf(end);
    if (i < 0 || j < i) {
      missing.push(name);
      continue;
    }
    out = `${out.slice(0, i + start.length)}\n${render(numbers).join('\n')}\n${out.slice(j)}`;
  }
  return { text: out, missing };
}

// ---------------------------------------------------------------------------
// README.md: prose checks (outside the generated blocks)
// ---------------------------------------------------------------------------

/**
 * Each check finds a number where README.md states it and compares it with its source. `want` is the
 * captured groups one match must show, or a list of such tuples matched in order. `required` checks
 * fail when the sentence is gone, so a rewrite has to come back here.
 */
function proseChecks(n) {
  const w = n.workedExample;
  const run = n.sandbox.serverRun;
  const first = n.sandbox.firstRun;
  const a = n.aiEval;
  const fee = w.payouts.find((p) => p.purpose === 'fee');
  const reimb = w.payouts.find((p) => p.purpose === 'reimbursement');
  const $ = '\\\\?\\$';
  const amt = '(\\d+(?:\\.\\d\\d)?)';
  return [
    // The AI evaluation (recorded answers in server/fixtures/ai, docs/evidence/ai-eval.json)
    { name: 'verdicts', re: /(\d+)\/(\d+) verdicts/g, want: [String(a.verdicts), String(a.cases)], required: true },
    { name: 'fields read', re: /(?<!one photo, )(\d+)\/(\d+) fields/g, want: [String(a.fields.ok), String(a.fields.of)], required: true },
    { name: 'bad proofs caught', re: /(\d+)\/(\d+) bad proofs caught/g, want: [String(a.badProofsCaught.caught), String(a.badProofsCaught.of)], required: true },
    { name: 'genuine proofs failed', re: /(\d+)\/(\d+) genuine (?:ones|proofs) (?:wrongly )?failed/g, want: [String(a.genuineWronglyFailed.failed), String(a.genuineWronglyFailed.of)], required: true },
    { name: 'median model latency', re: /median (\d+(?:\.\d)?) s per photo/g, want: [a.recorded.medianSeconds.toFixed(1)], required: true },
    { name: 'live run date and photos', re: /readings of all (\d+) demo photos, recorded live on (\d{4}-\d{2}-\d{2})/g, want: [String(a.cases), a.recorded.recordedOn.at(-1)], required: true },
    { name: 'demo photo count', re: /\b(\d+) (?:rendered )?demo photos/g, want: [String(a.cases)] },
    { name: 'line photos and receipt sets', re: /(\d+) line photos, (\d+) receipt sets/g, want: [String(a.linePhotos), String(a.purchaseProofs)], required: true },
    {
      name: 'eval cases by expected verdict',
      re: /The (\d+) cases are (\d+) bad proofs \(expected `failed`\), (\d+) genuine ones \(`passed`\) and (\d+) that belong in ops review/g,
      want: [String(a.cases), String(a.expected.failed), String(a.expected.passed), String(a.expected.needsReview)],
      required: true,
    },
    // The hero errand (shared/src/money.ts, equal to PayPal's recorded run)
    { name: 'story: the hold', re: new RegExp(`PayPal authorizes a \\*\\*${$}${amt} hold\\*\\*`, 'g'), want: [d(w.heldCents)], required: true },
    {
      name: 'story: the receipt capture',
      re: new RegExp(`PayPal captures \\*\\*${$}${amt}\\*\\* \\(the ${$}${amt} shop price, the ${$}${amt} fee and ${$}${amt} processing: PayPal's ${$}${amt} fee on this capture and ${$}${amt} for each of the two payouts\\)`, 'g'),
      want: [d(w.receiptCapture.amountCents), d(w.receiptCapture.retailCents), d(w.receiptCapture.feeCents), d(w.receiptCapture.processingCents), d(w.receiptCapture.paypalFeeCents), d(w.pricing.payoutItemCents)],
      required: true,
    },
    { name: 'story: the payouts to Wei', re: new RegExp(`Payouts sends Wei \\*\\*${$}${amt}\\*\\*`, 'g'), want: [[d(fee.amountCents)], [d(reimb.amountCents)]], required: true },
    {
      name: 'story: the shipping capture',
      re: new RegExp(`a final capture of \\*\\*${$}${amt}\\*\\* \\(the ${$}${amt} shipping Wei reports, under her ${$}(\\d+) budget, and PayPal's ${$}${amt} fee on it\\) releases the remaining \\*\\*${$}${amt}\\*\\*`, 'g'),
      want: [d(w.shippingCapture.amountCents), d(w.shippingCapture.shippingCents), String(w.inputs.shippingBudgetCents / 100), d(w.shippingCapture.paypalFeeCents), d(w.releasedCents)],
      required: true,
    },
    {
      name: "story: Mia's request",
      re: new RegExp(`shop price up to ${$}(\\d+), queue fee up to ${$}(\\d+), shipping up to ${$}(\\d+), and up to ${$}${amt} for processing`, 'g'),
      want: [String(w.inputs.retailCapCents / 100), String(w.inputs.maxFeeCents / 100), String(w.inputs.shippingBudgetCents / 100), d(w.processingReserveCents)],
      required: true,
    },
    // The sandbox proof table: PayPal's recorded answers (server column; the web app run used the same rules)
    { name: 'proof: authorization amount', re: new RegExp(`Authorization for ${$}${amt}`, 'g'), want: [d(run.authorization.amountCents)], required: true },
    { name: 'proof: receipt capture', re: new RegExp(`Receipt capture, ${$}${amt} \\(PayPal's fee ${$}${amt}\\)`, 'g'), want: [d(run.captures[0].amountCents), d(run.captures[0].paypalFeeCents)], required: true },
    { name: 'proof: shipping capture', re: new RegExp(`Final shipping capture, ${$}${amt} \\(PayPal's fee ${$}${amt}\\)`, 'g'), want: [d(run.captures[1].amountCents), d(run.captures[1].paypalFeeCents)], required: true },
    { name: 'proof: released', re: new RegExp(`Released by the final capture \\| ${$}${amt} \\| ${$}${amt}`, 'g'), want: [d(run.releasedCents), d(run.releasedCents)], required: true },
    { name: "proof: Wei's fee payout", re: new RegExp(`Payout of Wei's fee, ${$}${amt} \\(PayPal's fee ${$}${amt}\\)`, 'g'), want: [d(run.payouts.find((p) => p.purpose === 'fee').amountCents), d(run.payouts.find((p) => p.purpose === 'fee').paypalFeeCents)], required: true },
    {
      name: 'proof: reimbursement payout',
      re: new RegExp(`Payout of the shop price and shipping, ${$}${amt} \\(PayPal's fee ${$}${amt}\\)`, 'g'),
      want: [d(run.payouts.find((p) => p.purpose === 'reimbursement').amountCents), d(run.payouts.find((p) => p.purpose === 'reimbursement').paypalFeeCents)],
      required: true,
    },
    { name: "proof: PayPal's fees", re: new RegExp(`PayPal's fees, equal to Mia's processing line \\| ${$}${amt} \\| ${$}${amt}`, 'g'), want: [d(run.paypalFeesCents), d(run.paypalFeesCents)], required: true },
    { name: "proof: HoldMySpot's share", re: new RegExp(`10% of the ${$}(\\d+) fee \\| ${$}${amt} \\| ${$}${amt}`, 'g'), want: [String(w.inputs.maxFeeCents / 100), d(run.platformCents), d(run.platformCents)], required: true },
    { name: 'proof: first server run', re: new RegExp(`The first server run\\*\\* \\(\`(\\d{8}-\\d{4})\`, before D-105\\) held ${$}${amt}; PayPal's ${$}${amt} in fees`, 'g'), want: [first.run, d(first.authorization.amountCents), d(first.paypalFeesCents)], required: true },
    // The web app run's top line and the Venmo check (docs/evidence/sandbox-readback-20261107.txt, venmo-hold-20261107.txt)
    {
      name: 'top line: the web app run',
      re: /authorization `(\w+)`, captures `(\w+)` and `(\w+)`, payout batches `(\w+)` and `(\w+)`\. Read back from PayPal/g,
      want: [n.sandbox.webRun.authorization.id, ...n.sandbox.webRun.captures.map((c) => c.id), ...n.sandbox.webRun.payouts.map((p) => p.batch)],
      required: true,
    },
    { name: 'the Venmo-button hold', re: new RegExp(`approved a ${$}${amt} hold through PayPal's Venmo button \\(authorization \`(\\w+)\``, 'g'), want: [d(n.sandbox.venmo.amountCents), n.sandbox.venmo.authorization], required: true },
    // Versions of the recorded runs (docs/evidence/tests.json)
    { name: 'checked platform', re: /Checked on (\w+) with Node (\d+\.\d+) and npm (\d+\.\d+)/g, want: [n.tests.os, majorMinor(n.tests.node), majorMinor(n.tests.npm)], required: true },
    { name: 'known limits platform', re: /checked on (\w+) \(Node (\d+\.\d+), npm (\d+\.\d+)\)/g, want: [n.tests.os, majorMinor(n.tests.node), majorMinor(n.tests.npm)], required: true },
    { name: 'test steps', re: /All green: (\d+) steps/g, want: [String(n.tests.steps)] },
    ...(n.runs ? [{ name: 'attack duration', re: /One command, no keys, (under a minute|about a minute|about \d+ minutes)/g, want: [n.runs.attackDuration], required: true }] : []),
  ];
}

/** Ids that must appear in README.md as written: both runs' PayPal objects and the Venmo hold. */
function anchors(n) {
  const run = n.sandbox.serverRun;
  const web = n.sandbox.webRun;
  return [
    ['web app run order', `\`${web.order}\``],
    ['web app run authorization', `\`${web.authorization.id}\``],
    ...web.captures.map((c, i) => [`web app run capture ${i + 1}`, `\`${c.id}\``]),
    ['web app run tracking', `\`${web.tracking.number}\``],
    ...web.payouts.map((p) => [`web app run ${p.purpose} payout batch`, `\`${p.batch}\``]),
    ['Venmo-button hold', `\`${n.sandbox.venmo.authorization}\``],
    ['server run id', `\`${run.run}\``],
    ['server run order', `\`${run.order}\``],
    ['server run authorization', `\`${run.authorization.id}\``],
    ...run.captures.map((c, i) => [`server run capture ${i + 1}`, `\`${c.id}\``]),
    ['server run tracking', `\`${run.tracking.number}\``],
    ...run.payouts.map((p) => [`server run ${p.purpose} payout batch`, `batch \`${p.batch}\``]),
  ];
}

/** Gates named in README's "Gates passed" line must have that status on the gates page. */
function gateLineProblems(readme, n) {
  const line = readme.split('\n').find((l) => l.startsWith('- **Gates passed**'));
  if (!line) return ['README.md has no "- **Gates passed**" line'];
  const [passedPart, rest = ''] = line.split('**Waiting:**');
  const [waitingPart, notYet = ''] = rest.split('**Not on the gates page yet:**');
  const gatesIn = (s) => [...s.matchAll(/\bG(\d+)\b/g)].map((m) => `G${m[1]}`);
  const g = n.sandbox.gates;
  const problems = [];
  for (const id of gatesIn(passedPart)) if (!g.pass.includes(id)) problems.push(`README lists ${id} as passed; ${SRC.gates} says ${id} is not a pass`);
  for (const id of gatesIn(waitingPart)) if (!g.waiting.includes(id)) problems.push(`README lists ${id} as waiting; ${SRC.gates} says otherwise`);
  for (const id of gatesIn(notYet)) if (g.pass.includes(id)) problems.push(`README says ${id} is not on the gates page yet; ${SRC.gates} records it as a pass`);
  return problems;
}

/** Every refusal code in README's edge-case table must be one PayPal gave in the probe, with the same amounts. */
function edgeProblems(readme, n) {
  const rows = tableAfter(readme, "| Call | PayPal's answer |");
  if (rows.length === 0) return ["README.md has no \"| Call | PayPal's answer |\" table"];
  const problems = [];
  for (const [call, answer] of rows) {
    const code = /`([A-Z_]+)`/.exec(answer)?.[1];
    if (!code) continue;
    const hits = n.sandbox.gates.edges.filter((e) => e.answer.includes(code));
    if (hits.length === 0) {
      problems.push(`README's edge case "${call}" answers ${code}, which ${SRC.gates} does not record`);
      continue;
    }
    const amounts = [...call.matchAll(/\\?\$(\d+\.\d\d)/g)].map((m) => `$${m[1]}`);
    if (!hits.some((e) => amounts.every((x) => e.call.includes(x)))) problems.push(`README's edge case "${call}": ${SRC.gates} records ${code} for other amounts`);
  }
  return problems;
}

function readmeProblems(readme, numbers) {
  const problems = [];
  const { text, missing } = renderReadme(readme, numbers);
  for (const name of missing) problems.push(`README.md has no generated block "${name}" (${marker(name, 'start')} ... ${marker(name, 'end')})`);
  if (text !== readme) {
    for (const name of Object.keys(BLOCKS)) {
      const grab = (t) => t.slice(t.indexOf(marker(name, 'start')), t.indexOf(marker(name, 'end')));
      if (!missing.includes(name) && grab(text) !== grab(readme)) problems.push(`README.md's generated block "${name}" differs from docs/evidence/numbers.json (npm run numbers rewrites it)`);
    }
  }
  for (const c of proseChecks(numbers)) {
    const found = [...readme.matchAll(c.re)].map((m) => m.slice(1));
    if (found.length === 0) {
      if (c.required) problems.push(`README.md no longer states ${c.name} where this check looks (${c.re.source}); update scripts/readme-numbers.mjs with the new sentence`);
      continue;
    }
    const sequence = Array.isArray(c.want[0]);
    found.forEach((got, i) => {
      const want = sequence ? c.want[i] : c.want;
      if (!want) problems.push(`README.md states ${c.name} more often than its source has values (${got.join(', ')})`);
      else if (!isDeepStrictEqual(got, want)) problems.push(`README.md states ${c.name} as ${got.join(', ')}; the source says ${want.join(', ')}`);
    });
  }
  for (const [name, text2] of anchors(numbers)) if (!readme.includes(text2)) problems.push(`README.md does not show the ${name}, ${text2}, recorded in docs/evidence/ or ${numbers.sandbox.serverRun.fixtures}`);
  problems.push(...gateLineProblems(readme, numbers), ...edgeProblems(readme, numbers));
  return problems;
}

// ---------------------------------------------------------------------------
// Fresh reports (CI): the counts a new run gives must be the recorded ones
// ---------------------------------------------------------------------------

function freshProblems(dir, numbers) {
  try {
    return freshProblemsOrThrow(dir, numbers);
  } catch (err) {
    if (err instanceof Stale) return [`a fresh report in ${dir}: ${err.message}`];
    throw err;
  }
}

function freshProblemsOrThrow(dir, numbers) {
  const problems = [];
  const read = (f) => {
    const full = path.join(dir, f);
    return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')) : null;
  };
  let compared = 0;
  const t = read('tests.json');
  if (t) {
    compared++;
    if (!t.ok) problems.push(`the fresh npm test run failed (${dir}/tests.json)`);
    else {
      const f = deriveTests(t);
      const pick = (x) => ({ steps: x.steps, tests: x.tests, byPackage: x.byPackage, properties: x.properties.list.map((p) => [p.pkg, p.name, p.runs]) });
      if (!isDeepStrictEqual(pick(f), pick(numbers.tests))) problems.push(`the fresh npm test run has ${f.tests} tests (${JSON.stringify(f.byPackage)}); ${SRC.tests} has ${numbers.tests.tests} (${JSON.stringify(numbers.tests.byPackage)}): run npm run numbers -- --record`);
    }
  }
  const a = read('ai-eval.json');
  if (a) {
    compared++;
    const f = deriveAiEval(a, numbers.aiEval.recorded);
    const { recorded: _r1, ...x } = f;
    const { recorded: _r2, ...y } = numbers.aiEval;
    if (!isDeepStrictEqual(x, y)) problems.push(`the fresh npm run ai:eval differs from ${SRC.aiEval}: run npm run numbers -- --record`);
  }
  const k = read('attack.json');
  if (k) {
    compared++;
    if (!k.ok) problems.push(`the fresh npm run attack moved money it should not or let an attempt through (${dir}/attack.json)`);
    else {
      const f = deriveAttack(k);
      const pick = (x) => ({ attempts: x.attempts, movedNothing: x.movedNothing, intended: x.intended, capped: x.capped, knownLimits: x.knownLimits, stoppedBy: x.stoppedBy, rows: x.rows, violations: x.violations });
      if (!isDeepStrictEqual(pick(f), pick(numbers.attack))) problems.push(`the fresh npm run attack differs from ${SRC.attack}: run npm run numbers -- --record`);
    }
  }
  const s = read('smoke.json');
  if (s) {
    compared++;
    if (!s.ok) problems.push(`the fresh smoke check failed (${dir}/smoke.json)`);
  }
  if (compared === 0) problems.push(`no fresh reports in ${dir} (tests.json, ai-eval.json, attack.json or smoke.json)`);
  return problems;
}

// ---------------------------------------------------------------------------
// --record: run the zero-key commands and keep their reports
// ---------------------------------------------------------------------------

/** No keys reach the commands: no HMS_*, PAYPAL_* or model key, an empty secrets folder, no key files. */
function zeroKeyEnv(emptyDir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!(k.startsWith('HMS_') || k.startsWith('PAYPAL_') || AI_KEY_NAMES.includes(k))) env[k] = v;
  return { ...env, HMS_SECRETS_DIR: emptyDir, HMS_AI_KEY_FILES: '', NO_COLOR: '1' };
}

function runCommand(label, cmd, args, env, { capture = false } = {}) {
  return new Promise((resolve) => {
    console.log(bold(`\n> ${label}`));
    const t0 = Date.now();
    let out = '';
    const child = spawn(cmd, args, { cwd: REPO, env, stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'], shell: process.platform === 'win32' });
    if (capture) {
      const take = (chunk) => {
        out += chunk;
        process.stdout.write(chunk);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
    }
    child.on('error', (err) => resolve({ code: 1, out: String(err), seconds: (Date.now() - t0) / 1000 }));
    child.on('exit', (code) => resolve({ code: code ?? 1, out, seconds: (Date.now() - t0) / 1000 }));
  });
}


async function record(portOffset, outDir = rel('docs', 'evidence')) {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hms-numbers-nokeys-'));
  const env = zeroKeyEnv(empty);
  const npm = npmCommand();
  // Each report is written to a staging folder and replaces the kept one only when its command succeeded,
  // so a failed record never leaves a failing report behind for the next npm test to trip over (D-149).
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'hms-numbers-stage-'));
  const out = (f) => path.join(stage, f);
  const keep = (f) => fs.copyFileSync(out(f), path.join(outDir, f));
  fs.mkdirSync(outDir, { recursive: true });
  const failures = [];
  const timings = [];
  const recordedAt = new Date();
  try {
    // The other reports first, and npm test last (D-149): npm test's readme-numbers test checks README and
    // claims.md against the logs, so they are brought up to date with these reports before it runs.
    const evalRun = await runCommand('npm run ai:eval -- --json', npm, ['run', '-s', 'ai:eval', '--', '--json', out('ai-eval.json')], env);
    if (evalRun.code !== 0) failures.push('npm run ai:eval');
    else keep('ai-eval.json');
    timings.push({ command: 'npm run ai:eval', exitCode: evalRun.code, seconds: Number(evalRun.seconds.toFixed(1)) });
    const attack = await runCommand('npm run attack -- --ci --json', npm, ['run', '-s', 'attack', '--', '--ci', '--json', out('attack.json')], env);
    if (attack.code !== 0) failures.push('npm run attack');
    else keep('attack.json');
    timings.push({ command: 'npm run attack', exitCode: attack.code, seconds: Number(attack.seconds.toFixed(1)) });
    const startedAt = new Date();
    const smoke = await runCommand(`npm run demo -- --smoke --port-offset ${portOffset}`, process.execPath, [rel('scripts', 'dev.mjs'), '--smoke', '--port-offset', String(portOffset)], env, { capture: true });
    const text = smoke.out.replace(/\u001b\[[0-9;]*m/g, '');
    const git = gitState();
    const report = {
      tool: 'npm run demo -- --smoke',
      format: 1,
      ok: smoke.code === 0 && /Smoke check passed/.test(text),
      exitCode: smoke.code,
      startedAt: startedAt.toISOString(),
      seconds: Number(smoke.seconds.toFixed(1)),
      commit: git.commit,
      uncommittedChanges: git.dirty,
      codeTrees: git.trees,
      node: process.versions.node,
      npm: npmVersion(),
      platform: `${process.platform} ${process.arch}`,
      portOffset,
      answered: [...text.matchAll(/^\s*ok (server|web|ops)\b/gm)].map((m) => m[1]),
      readySeconds: Number(/ready in ([\d.]+) s/.exec(text)?.[1] ?? NaN),
      paypal: /^\s*PayPal: (.*)$/m.exec(text)?.[1]?.trim() ?? null,
      ai: /^\s*AI: +(.*)$/m.exec(text)?.[1]?.trim() ?? null,
      keys: 'none: no HMS_*, PAYPAL_* or model key variables, an empty HMS_SECRETS_DIR and no key files',
    };
    fs.writeFileSync(out('smoke.json'), serialize(report));
    if (!report.ok) failures.push('npm run demo -- --smoke');
    else keep('smoke.json');
    timings.push({ command: 'npm run demo -- --smoke', exitCode: smoke.code, seconds: report.seconds });
    if (outDir === rel('docs', 'evidence')) {
      // README, numbers.json and claims.md from these reports and the previous tests.json, which npm test replaces.
      try {
        writeDerived(await derive());
      } catch (err) {
        if (!(err instanceof Stale)) throw err;
        console.log(dim(`Before npm test, the numbers could not be derived yet: ${err.message}`));
      }
    }
    const tests = await runCommand('npm test -- --json', npm, ['test', '--', '--recording', '--json', out('tests.json')], env);
    if (tests.code !== 0) failures.push('npm test');
    else keep('tests.json');
    timings.push({ command: 'npm test', exitCode: tests.code, seconds: Number(tests.seconds.toFixed(1)) });
    const load = os.loadavg();
    fs.writeFileSync(
      failures.length === 0 ? path.join(outDir, 'runs.json') : out('runs.json'),
      serialize({
        tool: 'npm run numbers -- --record',
        format: 1,
        startedAt: recordedAt.toISOString(),
        commit: git.commit,
        uncommittedChanges: git.dirty,
        codeTrees: git.trees,
        node: process.versions.node,
        npm: npmVersion(),
        platform: `${process.platform} ${process.arch}`,
        cpus: os.cpus().length,
        loadAverageAtEnd: load.map((x) => Number(x.toFixed(1))),
        commands: timings,
      }),
    );
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
    if (failures.length > 0) console.log(dim(`The failing reports were not kept in ${path.relative(REPO, outDir)}; they are in ${stage}.`));
    else fs.rmSync(stage, { recursive: true, force: true });
  }
  return failures;
}

/** Writes numbers.json and the generated blocks of README.md and claims.md; returns what it wrote. */
function writeDerived(numbers, files = { numbers: rel(NUMBERS), readme: rel('README.md'), claims: rel('claims.md') }) {
  fs.mkdirSync(path.dirname(files.numbers), { recursive: true });
  fs.writeFileSync(files.numbers, serialize(numbers));
  const readme = fs.readFileSync(files.readme, 'utf8');
  const claims = fs.readFileSync(files.claims, 'utf8');
  const r = renderReadme(readme, numbers);
  const c = renderReadme(claims, numbers, CLAIMS_BLOCKS);
  if (r.text !== readme) fs.writeFileSync(files.readme, r.text);
  if (c.text !== claims) fs.writeFileSync(files.claims, c.text);
  return { readme: r, claims: c, readmeChanged: r.text !== readme, claimsChanged: c.text !== claims };
}

// ---------------------------------------------------------------------------

async function main() {
  requireNode();
  let args;
  try {
    ({ values: args } = parseArgs({
      options: {
        check: { type: 'boolean' },
        record: { type: 'boolean' },
        fresh: { type: 'string' },
        'port-offset': { type: 'string' },
        readme: { type: 'string' },
        numbers: { type: 'string' },
        print: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.check && args.record) {
    console.error('Use --check or --record, not both.');
    return 2;
  }
  if (args.record) {
    const failures = await record(Number(args['port-offset'] ?? 400));
    if (failures.length > 0) {
      console.error(red(`\nNot recorded: ${failures.join(', ')} failed. README.md and numbers.json are unchanged.`));
      return 1;
    }
  }

  let numbers;
  try {
    numbers = await derive();
  } catch (err) {
    if (err instanceof Stale) {
      console.error(red(`Cannot derive the numbers: ${err.message}`));
      return 1;
    }
    throw err;
  }
  if (args.print) {
    process.stdout.write(serialize(numbers));
    return 0;
  }

  const numbersFile = args.numbers ? path.resolve(args.numbers) : rel(NUMBERS);
  const readmeFile = args.readme ? path.resolve(args.readme) : rel('README.md');
  const claimsFile = rel('claims.md');
  const readme = fs.readFileSync(readmeFile, 'utf8');
  const claims = fs.readFileSync(claimsFile, 'utf8');
  const problems = [];

  if (args.check) {
    const onDisk = fs.existsSync(numbersFile) ? fs.readFileSync(numbersFile, 'utf8') : null;
    if (onDisk !== serialize(numbers)) problems.push(`${path.relative(REPO, numbersFile)} is ${onDisk === null ? 'missing' : 'out of date with its sources'} (npm run numbers rewrites it)`);
    problems.push(...readmeProblems(readme, numbers));
    const c = renderReadme(claims, numbers, CLAIMS_BLOCKS);
    for (const name of c.missing) problems.push(`claims.md has no generated block "${name}"`);
    if (c.text !== claims) problems.push('claims.md\'s generated block "logs" differs from docs/evidence/ (npm run numbers rewrites it)');
    if (args.fresh) problems.push(...freshProblems(path.resolve(args.fresh), numbers));
  } else {
    const w = writeDerived(numbers, { numbers: numbersFile, readme: readmeFile, claims: claimsFile });
    console.log(`${green('Wrote')} ${path.relative(REPO, numbersFile)}${w.readmeChanged ? ` and README.md's generated blocks` : ''}${w.claimsChanged ? " and claims.md's logs table" : ''}.`);
    for (const name of w.readme.missing) problems.push(`README.md has no generated block "${name}"`);
    for (const name of w.claims.missing) problems.push(`claims.md has no generated block "${name}"`);
    problems.push(...readmeProblems(w.readme.text, numbers).filter((p) => !p.includes('generated block')));
  }

  const t = numbers.tests;
  const a = numbers.aiEval;
  console.log(
    dim(
      `Tests ${t.passed}/${t.tests} (${t.properties.tests} property tests, ${grouped(t.properties.runs)} cases); sandbox run ${numbers.sandbox.serverRun.run} = worked example (${usd(numbers.workedExample.heldCents)} held, ${usd(numbers.workedExample.capturedCents)} charged); AI ${a.verdicts}/${a.cases} verdicts, ${a.fields.ok}/${a.fields.of} fields; attack ${numbers.attack.movedNothing}/${numbers.attack.attempts} moved $0.00.`,
    ),
  );
  if (problems.length > 0) {
    console.error(red(bold(`\n${problems.length === 1 ? 'One problem' : `${problems.length} problems`}:`)));
    for (const p of problems) console.error(red(`  - ${p}`));
    return 1;
  }
  console.log(green(args.check ? 'README.md and docs/evidence/numbers.json agree with the logs and fixtures.' : 'README.md agrees with the logs and fixtures.'));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(red(err?.stack ?? String(err)));
    process.exit(1);
  });

