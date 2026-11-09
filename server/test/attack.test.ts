import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_MARKET_START } from '@holdmyspot/shared';

/**
 * `npm run attack` in CI mode (scripts/attack.mjs, docs/DECISIONS.md D-137 to D-139, D-147 to D-149):
 * its own zero-key server, six fake receipts on fresh demo markets, the money tricks over the HTTP API,
 * a receipt reprinted at the cap on one more market, and three calls straight at the PayPal emulator. Every
 * attempt must move exactly what the shared money rules say ($0.00 when refused), the layer the run
 * derives from each answer must be the one docs/TECHNICAL-DETAILS.md names, and its sample table must be this
 * run's table. Against a server that pays the queuer more than the rules say, it must exit 1.
 */

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const ATTACK = join(REPO, 'scripts', 'attack.mjs');

interface Money {
  captured: number;
  refunded: number;
  paidOut: number;
  held: number;
}
interface Row {
  n: number;
  id: string;
  stoppedBy: string;
  code: string;
  answer: string;
  refused: boolean;
  moved: Money;
  expected: Money;
  outcome: 'refused' | 'to_a_person' | 'intended' | 'capped';
  intended: boolean;
  ok: boolean;
  asExpected: boolean;
  notes: string[];
}
interface Report {
  ok: boolean;
  rows: Row[];
  table: string[];
  markets: { market: string; holds: number; violations: string[] }[];
  server: { startedHere: boolean } | null;
}

/**
 * Every row of a full run, in table order: its id, the layer the run derives from the answer (a
 * receipt's failed checks, or the refusal code), the code it answers, and what it is meant to do.
 */
const EXPECTED: readonly [id: string, stoppedBy: string, code: string, outcome: Row['outcome']][] = [
  ['genuine', '-', 'passed', 'intended'],
  ['paper-moon-recycled-photo', 'rules', 'duplicate_photo', 'refused'],
  ['paper-moon-qr-wrong-store', 'rules', 'shop_match', 'refused'],
  ['paper-moon-time-before-checkin', 'AI + rules', 'time_window', 'refused'],
  ['paper-moon-totals-off', 'AI + rules', 'totals_add_up', 'refused'],
  ['paper-moon-wrong-code', 'AI + rules', 'code_visible', 'refused'],
  ['paper-moon-generator-metadata', 'sent to a person', 'generator_metadata', 'to_a_person'],
  ['raise-max-fee', 'rules', 'OVER_LIMIT', 'refused'],
  ['no-check-in', 'state machine', 'INVALID_TRANSITION', 'refused'],
  ['check-in-from-home', 'rules', 'OUTSIDE_GEOFENCE', 'refused'],
  ['claim-released', 'state machine', 'CONFLICT', 'refused'],
  ['inflate-shipping', 'rules', 'capped', 'capped'],
  ['replay-tracking', 'state machine', 'REPLAYED', 'refused'],
  ['capture-after-final', 'state machine', 'INVALID_TRANSITION', 'refused'],
  ['second-fee-payout', 'state machine', 'INVALID_TRANSITION', 'refused'],
  ['approve-after-sell-out', 'state machine', 'SOLD_OUT', 'refused'],
  ['sell-out-alone', 'rules', 'ONE_REPORT', 'refused'],
  ['guess-handover-code', 'rules', 'RATE_LIMITED', 'refused'],
  ['paypal-over-115', 'PayPal emulator', 'MAX_CAPTURE_AMOUNT_EXCEEDED', 'refused'],
  ['paypal-after-final', 'PayPal emulator', 'AUTHORIZATION_ALREADY_CAPTURED', 'refused'],
  ['paypal-payout-again', 'PayPal emulator', 'USER_BUSINESS_ERROR', 'refused'],
  ['reprint-at-cap', 'sent to a person', 'listed_price', 'to_a_person'],
];

/** The rows that move money, in cents (shared/src/money.ts on the worked example, docs/DOMAIN.md section 7). */
const MOVES: Record<string, Partial<Money>> = {
  // $34.00 shop price + $12.00 fee + $2.69 processing; Wei's fee minus HoldMySpot's 10%.
  genuine: { captured: 4869, paidOut: 1080 },
  // Shipping as Wei reports it, capped at the $12.00 budget, + $0.94 PayPal fee on it; the $34.00 shop price and that $12.00 back to Wei.
  'inflate-shipping': { captured: 1294, paidOut: 4600 },
};

// A busy machine can slow the nine markets down a lot (11 s idle, minutes under load), so the limit is generous.
function run(args: string[], timeoutMs = 600_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ATTACK, ...args], { cwd: REPO, env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** No HMS_*, PAYPAL_* or AI key from the shell, so neither a server nor the attack can find a key. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('HMS_') || k.startsWith('PAYPAL_') || ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MODEL_API_KEY'].includes(k)) continue;
    env[k] = v;
  }
  return env;
}

/** `npm test -- --quick` leaves this out (the full run, and CI, keep it; D-149). */
const QUICK = process.env.HMS_TEST_QUICK === '1' ? 'skipped by npm test -- --quick' : false;

describe('npm run attack, CI mode', { skip: QUICK }, () => {
  it('stops every attempt with $0.00 moved, moves exactly the intended amount twice, and matches the README table', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hms-attack-test-'));
    try {
      const file = join(dir, 'report.json');
      const r = await run(['--ci', '--json', file]);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /Every attempt moved exactly what the shared money rules say\./);
      const report = JSON.parse(readFileSync(file, 'utf8')) as Report;
      assert.equal(report.ok, true);
      assert.equal(report.server?.startedHere, true, 'it attacks a server it started itself');
      assert.deepEqual(
        report.rows.map((x) => [x.id, x.stoppedBy, x.code, x.outcome]),
        EXPECTED.map((e) => [...e]),
      );
      for (const row of report.rows) {
        assert.ok(row.ok && row.asExpected, `row ${row.n} ${row.id}: ${row.notes.join('; ')}`);
        const want = { captured: 0, refunded: 0, paidOut: 0, held: 0, ...MOVES[row.id] };
        assert.deepEqual(row.moved, want, `row ${row.n} ${row.id} moved`);
        assert.equal(row.intended, row.outcome === 'intended');
        const through = ['intended', 'capped'].includes(row.outcome);
        assert.equal(row.refused, !through, `row ${row.n} ${row.id} refused`);
      }
      assert.equal(report.markets.length, 9, 'six fake-receipt markets, the handover market, the money market and the reprint market');
      assert.deepEqual(report.markets.flatMap((m) => m.violations), []);

      const readme = readFileSync(join(REPO, 'docs', 'TECHNICAL-DETAILS.md'), 'utf8');
      const block = /<!-- attack-table:start -->\n```text\n([\s\S]*?)\n```\n<!-- attack-table:end -->/.exec(readme);
      assert.ok(block, 'docs/TECHNICAL-DETAILS.md has the sample table between its attack-table markers');
      assert.deepEqual(block[1]!.split('\n'), report.table, "docs/TECHNICAL-DETAILS.md's sample table is this run's table (run npm run attack and paste it)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 against a server that pays the queuer more than the rules say', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hms-attack-test-'));
    const noKeys = join(dir, 'no-keys');
    mkdirSync(noKeys);
    const port = await freePort();
    const server = spawn(process.execPath, ['src/main.ts'], {
      cwd: join(REPO, 'server'),
      env: {
        ...cleanEnv(),
        HMS_MODE: 'fake',
        HMS_AI_MODE: 'replay',
        HMS_DEMO: '1',
        HMS_DEMO_RESET: '1',
        HMS_MARKET_START: DEMO_MARKET_START,
        HMS_CLOCK_SPEED: '60',
        HMS_HOST: '127.0.0.1',
        HMS_PORT: String(port),
        HMS_DB_PATH: join(dir, 'market.sqlite'),
        HMS_UPLOAD_DIR: join(dir, 'uploads'),
        HMS_SECRETS_DIR: noKeys,
        HMS_AI_KEY_FILES: '',
        HMS_LOG_LEVEL: 'warn',
        // The bug to catch: HoldMySpot keeps nothing, so Wei is paid the whole $12.00 fee instead of $10.80.
        HMS_PLATFORM_FEE_BPS: '0',
      },
      stdio: 'ignore',
    });
    const exited = new Promise((resolve) => server.once('exit', resolve));
    try {
      const t0 = Date.now();
      for (;;) {
        const ok = await fetch(`http://127.0.0.1:${port}/api/health`)
          .then((res) => res.ok)
          .catch(() => false);
        if (ok) break;
        assert.ok(Date.now() - t0 < 60_000, 'the server answered within 60 s');
        await new Promise((r) => setTimeout(r, 200));
      }
      const file = join(dir, 'report.json');
      const r = await run(['--reuse', '--server-port', String(port), '--only', 'money', '--ci', '--json', file]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /One problem: money moved where the rules say it should not/);
      const report = JSON.parse(readFileSync(file, 'utf8')) as Report;
      assert.equal(report.ok, false);
      const genuine = report.rows.find((x) => x.id === 'genuine');
      assert.ok(genuine);
      assert.equal(genuine.ok, false);
      assert.deepEqual([genuine.moved.paidOut, genuine.expected.paidOut], [1200, 1080]);
      assert.ok(
        report.rows.filter((x) => x.id !== 'genuine').every((x) => x.ok),
        'every other attempt still moved what it should',
      );
    } finally {
      server.kill('SIGTERM');
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([exited, new Promise((r) => (timer = setTimeout(r, 8000)))]);
      clearTimeout(timer);
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
