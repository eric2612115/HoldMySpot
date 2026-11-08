import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * README.md's numbers come from logs and fixtures, not from typing (scripts/readme-numbers.mjs,
 * docs/DECISIONS.md D-143): docs/evidence/numbers.json must be what its sources give, README.md's
 * generated blocks must be what numbers.json gives, and the numbers README.md states in its own words
 * (the sandbox run, the AI scores, the gates) must be the recorded ones. A hand edit turns this red.
 */

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO, 'scripts', 'readme-numbers.mjs');

/**
 * `npm run numbers -- --record` runs npm test to replace docs/evidence/tests.json, then checks README
 * itself. If the tests.json it is replacing records a failing run (a record that failed half-way), no
 * README can agree with it, so only then, and only inside that record, these checks wait for the record's
 * own check after npm test (D-149). Every other npm test runs them.
 */
function failedTestsLog(): boolean {
  try {
    const t = JSON.parse(readFileSync(join(REPO, 'docs', 'evidence', 'tests.json'), 'utf8')) as { ok?: boolean; totals?: { failed?: number } };
    return t.ok !== true || (t.totals?.failed ?? 0) > 0;
  } catch {
    return true;
  }
}
const WAIT_FOR_RECORD = process.env.HMS_NUMBERS_RECORD === '1' && failedTestsLog() ? 'npm run numbers -- --record is replacing a failing tests.json and checks README after npm test' : false;

function run(args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 180_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** README.md with one edit, in a temporary file; the check runs against it. */
function checkEdited(edit: (readme: string) => string): { code: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hms-readme-numbers-'));
  try {
    const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
    const edited = edit(readme);
    assert.notEqual(edited, readme, 'the edit changed README.md');
    const file = join(dir, 'README.md');
    writeFileSync(file, edited);
    return run(['--check', '--readme', file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Moved {
  n: number;
  capturedCents: number;
}
interface Run {
  run: string;
  authorization: { id: string; amountCents: number };
  captures: { amountCents: number; paypalFeeCents: number }[];
  payouts: { purpose: string; amountCents: number; paypalFeeCents: number }[];
  releasedCents: number;
  paidOutCents: number;
  paypalFeesCents: number;
  platformCents: number;
  shipTo: string | null;
  tracking: unknown;
}
interface Numbers {
  workedExample: { heldCents: number; capturedCents: number; releasedCents: number; paypalFeesCents: number; processingCents: number; platformCents: number; payouts: { purpose: string; amountCents: number }[] };
  localExample: { heldCents: number; capturedCents: number; releasedCents: number; paypalFeesCents: number; processingCents: number; platformCents: number; payouts: { purpose: string; amountCents: number }[] };
  sandbox: {
    serverRun: Run & { matchesWorkedExample: boolean };
    localRun: Run & { matchesLocalExample: boolean };
    venmo: {
      authorization: string;
      paypal: { paymentSource: string; authorization: { id: string; before: string; after: string; amountCents: number }; capture: { id: string; status: string; amountCents: number; final: boolean; paypalFeeCents: number }; releasedCents: number };
    };
    gates: { pass: string[]; partial: string[]; localRun: { checks: number; matches: number } };
  };
  aiEval: { cases: number; verdicts: number; modelCalls: number };
  attack: { attempts: number; refused: number; toPerson: number[]; intended: Moved[]; capped: Moved[]; knownLimits: Moved[]; violations: number };
  tests: { tests: number; failed: number; properties: { serverDays: { name: string; runs: number; coverage: Record<string, number> }[] } };
  logs: { file: string; commit: string | null; codeTrees: Record<string, string> | null }[];
}

describe('README numbers (scripts/readme-numbers.mjs)', { skip: WAIT_FOR_RECORD }, () => {
  it('README.md agrees with docs/evidence/numbers.json, and numbers.json with the logs and fixtures it comes from', () => {
    const r = run(['--check']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /agree with the logs and fixtures/);
  });

  it("derives the hero errand from PayPal's recorded answers and the shared money rules, and they agree to the cent", () => {
    const r = run(['--print']);
    assert.equal(r.code, 0, r.out);
    const n = JSON.parse(r.out) as Numbers;
    const w = n.workedExample;
    const s = n.sandbox.serverRun;
    assert.equal(s.run, '20261107-2047');
    assert.equal(s.authorization.id, '5XK23595W1944882C');
    assert.deepEqual([w.heldCents, w.capturedCents, w.releasedCents, w.paypalFeesCents, w.platformCents], [6370, 5826, 544, 351, 120]);
    assert.equal(w.processingCents, w.paypalFeesCents, "PayPal's fees are exactly the processing line");
    assert.deepEqual(w.payouts.map((p) => [p.purpose, p.amountCents]), [['fee', 1080], ['reimbursement', 4275]]);
    assert.deepEqual([s.authorization.amountCents, ...s.captures.map((c) => [c.amountCents, c.paypalFeeCents]), s.releasedCents, s.platformCents], [6370, [4869, 219], [957, 82], 544, 120]);
    assert.equal(s.matchesWorkedExample, true);
    // The local pickup errand (D-156): one capture at the handover, one payout, no shipping; PayPal's fees are its processing line.
    const l = n.sandbox.localRun;
    const le = n.localExample;
    assert.equal(l.run, '20261108-1357');
    assert.equal(l.authorization.id, '2KG09036B9936292Y');
    assert.deepEqual([le.heldCents, le.capturedCents, le.releasedCents, le.paypalFeesCents, le.platformCents], [5050, 4843, 207, 243, 120]);
    assert.equal(le.processingCents, le.paypalFeesCents, "PayPal's fees are exactly the local errand's processing line");
    assert.deepEqual(le.payouts.map((p) => [p.purpose, p.amountCents]), [['fee_and_reimbursement', 4480]]);
    assert.deepEqual(
      [l.authorization.amountCents, l.captures.map((c) => [c.amountCents, c.paypalFeeCents]), l.releasedCents, l.payouts.map((p) => [p.purpose, p.amountCents, p.paypalFeeCents]), l.platformCents, l.shipTo, l.tracking],
      [5050, [[4843, 218]], 207, [['fee_and_reimbursement', 4480, 25]], 120, null, null],
    );
    assert.equal(l.matchesLocalExample, true);
    assert.deepEqual([n.sandbox.gates.localRun.matches, n.sandbox.gates.localRun.checks], [11, 11]);
    // Gate G4 passed (D-157): the Venmo-button hold, Venmo-funded by PayPal's own record, captured in part with final_capture.
    assert.deepEqual([n.sandbox.gates.partial, n.sandbox.gates.pass.includes('G4')], [[], true]);
    const v = n.sandbox.venmo.paypal;
    assert.deepEqual([v.paymentSource, v.authorization.id, v.authorization.before, v.authorization.after], ['venmo', n.sandbox.venmo.authorization, 'CREATED', 'CAPTURED']);
    assert.deepEqual([v.capture.id, v.capture.status, v.capture.final, v.capture.amountCents, v.capture.paypalFeeCents, v.releasedCents], ['41C59314FX8286919', 'COMPLETED', true, 1000, 84, 4600]);
    assert.equal(n.aiEval.modelCalls, 0, 'the AI numbers come from replayed recordings');
    assert.equal(n.tests.failed, 0);
    assert.equal(n.attack.violations, 0);
    const a = n.attack;
    assert.equal(a.refused + a.toPerson.length + a.intended.length + a.capped.length + a.knownLimits.length, a.attempts, 'every attempt is refused, sent to a person, intended, capped or a known limit');
    assert.deepEqual([a.intended.map((x) => x.n), a.capped.map((x) => x.n), a.knownLimits.map((x) => x.n)], [[1], [12], [23]]);
    // One day per run; P5 plays each of its days twice, with and without PayPal failures.
    for (const d of n.tests.properties.serverDays) assert.equal(d.coverage.days, /^P5\b/.test(d.name) ? 2 * d.runs : d.runs, `${d.name}: the server days report what they reached`);
    // Every log names the code it ran on. npm run numbers -- --record writes tests.json and runs.json after
    // the npm test run that runs this check, so those two can be one recording older than the others.
    for (const log of n.logs) {
      assert.ok(log.commit, `${log.file} records its commit`);
      if (log.file !== 'tests.json' && log.file !== 'runs.json') assert.ok(log.codeTrees, `${log.file} records the git tree of each code folder`);
    }
  });

  it('turns red when a number README.md states in its own words is edited by hand', () => {
    const r = checkEdited((t) => t.replace('161/164 fields', '162/164 fields'));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /fields read as 162, 164; the source says 161, 164/);
    const ids = checkEdited((t) => t.replace('`24U26127PB091713A`', '`24U26127PB091713B`'));
    assert.equal(ids.code, 1, ids.out);
    assert.match(ids.out, /server run capture 1, `24U26127PB091713A`/);
    const story = checkEdited((t) => t.replace('PayPal captures **\\$48.69**', 'PayPal captures **\\$48.70**'));
    assert.equal(story.code, 1, story.out);
    assert.match(story.out, /story: the receipt capture/);
    const web = checkEdited((t) => t.replace('authorization `88232929HR885933A`, captures', 'authorization `88232929HR885933B`, captures'));
    assert.equal(web.code, 1, web.out);
    assert.match(web.out, /top line: the web app run as 88232929HR885933B/);
    // The local pickup errand on the sandbox: its ids and the amounts README states in its own words.
    const localId = checkEdited((t) => t.replaceAll('`5KN64357P0403214L`', '`5KN64357P0403214M`'));
    assert.equal(localId.code, 1, localId.out);
    assert.match(localId.out, /local run capture, `5KN64357P0403214L`/);
    const localStory = checkEdited((t) => t.replace("one capture of \\$48.43 at Sam's handover code", "one capture of \\$48.44 at Sam's handover code"));
    assert.equal(localStory.code, 1, localStory.out);
    assert.match(localStory.out, /local errand: the sandbox run in the story as 48\.44, 2\.07, 44\.80; the source says 48\.43, 2\.07, 44\.80/);
  });

  it('turns red when a generated block is edited by hand, a gate is claimed that the gates page does not record, or a sentence it reads is removed', () => {
    const block = checkEdited((t) => t.replace(/(<!-- numbers:ai-eval:start -->[\s\S]*?Verdict accuracy: +)21\/21/, (_m, head: string) => `${head}20/21`));
    assert.equal(block.code, 1, block.out);
    assert.match(block.out, /generated block "ai-eval" differs/);
    const gate = checkEdited((t) => t.replace('(G1, G2), void', '(G1, G2, G10), void'));
    assert.equal(gate.code, 1, gate.out);
    assert.match(gate.out, /README lists G10 as passed/);
    // G4 passed on the gates page: README may not list it as waiting, and the capture it states is PayPal's.
    const venmoWaiting = checkEdited((t) => t.replace('wait for 2026-11-10 (G10).', 'wait for 2026-11-10 (G10, G4).'));
    assert.equal(venmoWaiting.code, 1, venmoWaiting.out);
    assert.match(venmoWaiting.out, /README lists G4 as waiting/);
    const venmoCapture = checkEdited((t) => t.replace('captured \\$10.00 of it with', 'captured \\$10.01 of it with'));
    assert.equal(venmoCapture.code, 1, venmoCapture.out);
    assert.match(venmoCapture.out, /G4: the capture of the Venmo-funded hold as 10\.01, 41C59314FX8286919, 0\.84, 46\.00; the source says 10\.00/);
    const gone = checkEdited((t) => t.replace(/readings of all 21 demo photos, recorded live on \d{4}-\d{2}-\d{2}/, 'readings of the demo photos'));
    assert.equal(gone.code, 1, gone.out);
    assert.match(gone.out, /no longer states live run date and photos/);
  });

  it('runs npm run ai:eval again now, with a key named in the environment and in a key file: it reads no key, calls no model, and gives the numbers recorded in docs/evidence/ai-eval.json (D-149)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hms-ai-eval-fresh-'));
    try {
      const keyFile = join(dir, 'keys.env');
      writeFileSync(keyFile, 'MODEL_API_KEY=not-a-real-key\n');
      const r = spawnSync(process.execPath, ['--no-warnings', join('scripts', 'ai-eval.ts'), '--json', join(dir, 'ai-eval.json')], {
        cwd: join(REPO, 'server'),
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1', HMS_AI_KEY_FILES: keyFile, MODEL_API_KEY: 'not-a-real-key-either' },
        // Seconds when the machine is idle; a busy machine can make the 21 replays take minutes.
        timeout: 600_000,
      });
      const out = `${r.stdout}${r.stderr}`;
      assert.equal(r.status, 0, out);
      assert.match(out, /no key is read \(ignored: [^)]*MODEL_API_KEY[^)]*HMS_AI_KEY_FILES/);
      assert.match(out, /No model was called in this run\./);
      assert.doesNotMatch(out, /not-a-real-key/, 'no key value is printed');
      // The fresh report against the committed one: the same cases, answers and scores.
      const fresh = run(['--check', '--fresh', dir]);
      assert.equal(fresh.code, 0, fresh.out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('turns red when docs/evidence/numbers.json is edited by hand', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hms-readme-numbers-'));
    try {
      const n = JSON.parse(readFileSync(join(REPO, 'docs', 'evidence', 'numbers.json'), 'utf8')) as Numbers;
      n.tests.tests += 1;
      const file = join(dir, 'numbers.json');
      writeFileSync(file, `${JSON.stringify(n, null, 2)}\n`);
      const r = run(['--check', '--numbers', file]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /numbers\.json is out of date with its sources/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
