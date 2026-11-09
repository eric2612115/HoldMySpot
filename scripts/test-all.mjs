#!/usr/bin/env node
// Runs every package's tests and type checks and prints one summary.
//
//   npm test                     shared check, server check, web and ops type checks and tests
//                                (several minutes; the generated server days and the attack take most of it)
//   npm test -- --quick          the same without the generated server days and the attack, for a short check
//   npm test -- --build          also the web and ops production builds
//   npm test -- --only server --verbose
//   npm test -- --json report.json   also write the counts as JSON (scripts/readme-numbers.mjs reads it)
//
// The tests are hermetic: AI keys and HMS_* settings from your shell are not passed to them,
// so they never call a model or PayPal.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AI_KEY_NAMES, PACKAGES, REPO, bold, dim, gitState, green, npmCommand, npmVersion, packageStatus, red, requireNode } from './common.mjs';

const USAGE = `Run HoldMySpot's tests and type checks.

  npm test [-- options]

Options:
  --only shared,server,web,ops   run only these packages
  --quick                        leave out the slow tests: the generated server days
                                 (server/test/engine.property.test.ts) and the attack (server/test/attack.test.ts);
                                 the full run takes several minutes, more on a busy machine; CI runs the full one
  --build                        also run the web and ops production builds (vite build)
  --recording                    set by npm run numbers -- --record, which replaces the logs the README check
                                 reads (server/test/readme-numbers.test.ts) and checks README itself afterwards
  --verbose                      print every step's output, not only failures
  --json <file>                  also write the counts as JSON: each step's tests, passed, failed and
                                 skipped, the property tests with their generated runs, the commit,
                                 Node, npm and the platform (docs/evidence/tests.json is one)
  -h, --help
`;

/** Steps per package, as npm scripts. */
function steps(build) {
  return [
    { pkg: 'shared', script: 'check', label: 'type check + tests' },
    { pkg: 'server', script: 'check', label: 'type check + tests' },
    { pkg: 'web', script: 'typecheck', label: 'type check' },
    { pkg: 'web', script: 'test', label: 'tests (vitest)' },
    ...(build ? [{ pkg: 'web', script: 'build', label: 'build' }] : []),
    { pkg: 'ops', script: 'typecheck', label: 'type check' },
    { pkg: 'ops', script: 'test', label: 'tests' },
    ...(build ? [{ pkg: 'ops', script: 'build', label: 'build' }] : []),
  ];
}

function hermeticEnv(quick, recording) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('HMS_') || AI_KEY_NAMES.includes(k) || k.startsWith('PAYPAL_')) delete env[k];
  // The only settings passed on (D-149): the slow suites skip themselves, and the README check knows a
  // record is replacing the logs it reads.
  if (quick) env.HMS_TEST_QUICK = '1';
  if (recording) env.HMS_NUMBERS_RECORD = '1';
  return env;
}

function run(step, verbose, quick, recording) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    const child = spawn(npmCommand(), ['run', step.script, '--silent'], {
      cwd: path.join(REPO, step.pkg),
      env: hermeticEnv(quick, recording),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    const take = (chunk) => {
      out += chunk;
      if (verbose) process.stdout.write(chunk);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (err) => resolve({ code: 1, out: String(err), ms: Date.now() - t0 }));
    child.on('exit', (code) => resolve({ code: code ?? 1, out, ms: Date.now() - t0 }));
  });
}

/** "293 passed" from node:test or vitest output, when it is there. */
function counts(out) {
  const node = /ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/.exec(out);
  if (node) return `${node[1]} passed, ${node[2]} failed`;
  const vitest = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(out.replace(/\u001b\[[0-9;]*m/g, ''));
  if (vitest) return `${vitest[2]} passed${vitest[1] ? `, ${vitest[1]} failed` : ''}`;
  return '';
}

/** The same counts as numbers for --json: node:test's summary lines, or vitest's "Tests" line. Null for a type check. */
function tally(out) {
  const text = out.replace(/\u001b\[[0-9;]*m/g, '');
  const n = (name) => {
    const m = new RegExp(`ℹ ${name} (\\d+)`).exec(text);
    return m ? Number(m[1]) : null;
  };
  if (n('tests') !== null) return { tests: n('tests'), passed: n('pass') ?? 0, failed: n('fail') ?? 0, skipped: (n('skipped') ?? 0) + (n('todo') ?? 0) };
  const v = /Tests\s+([^\n]*?)\((\d+)\)/.exec(text);
  if (v) {
    const part = (word) => Number(new RegExp(`(\\d+) ${word}`).exec(v[1])?.[1] ?? 0);
    return { tests: Number(v[2]), passed: part('passed'), failed: part('failed'), skipped: part('skipped') + part('todo') };
  }
  return null;
}

/**
 * Property tests (P1 to P8) and their generated runs, from the passing test names ("... (2000 runs)"),
 * with what the generated server days reached when the test printed it ("ℹ coverage {...}").
 */
function properties(out) {
  const props = [];
  for (const line of out.replace(/\u001b\[[0-9;]*m/g, '').split('\n')) {
    const m = /^\s*✔ (P\d[^\n]*?) \((\d[\d,]*) runs\)/.exec(line);
    if (m) {
      props.push({ name: m[1].trim(), runs: Number(m[2].replace(/,/g, '')) });
      continue;
    }
    const c = /^\s*ℹ coverage (\{.*\})\s*$/.exec(line);
    if (c && props.length > 0) {
      try {
        props.at(-1).coverage = JSON.parse(c[1]);
      } catch {
        // not a coverage line after all
      }
    }
  }
  return props;
}


function writeReport(file, { results, ms, build, only, startedAt, quick }) {
  const git = gitState();
  const steps = results.map((r) => ({ pkg: r.pkg, label: r.label, ok: r.ok, seconds: Number((r.ms / 1000).toFixed(1)), ...(r.tally ?? {}), ...(r.props.length > 0 ? { properties: r.props } : {}) }));
  const sum = (k) => steps.reduce((a, s) => a + (s[k] ?? 0), 0);
  const report = {
    tool: 'npm test',
    format: 1,
    ok: results.every((r) => r.ok),
    startedAt: startedAt.toISOString(),
    seconds: Number((ms / 1000).toFixed(1)),
    commit: git.commit,
    uncommittedChanges: git.dirty,
    codeTrees: git.trees,
    commitCodeTrees: git.commitTrees,
    node: process.versions.node,
    npm: npmVersion(),
    platform: `${process.platform} ${process.arch}`,
    build,
    quick,
    packages: only,
    totals: { steps: steps.length, tests: sum('tests'), passed: sum('passed'), failed: sum('failed'), skipped: sum('skipped') },
    steps,
  };
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  let args;
  try {
    ({ values: args } = parseArgs({ options: { only: { type: 'string' }, build: { type: 'boolean' }, quick: { type: 'boolean' }, recording: { type: 'boolean' }, verbose: { type: 'boolean' }, json: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true }));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  requireNode();
  const only = args.only ? args.only.split(',').map((s) => s.trim()) : PACKAGES;
  const plan = steps(Boolean(args.build)).filter((s) => only.includes(s.pkg));
  const results = [];
  const startedAt = new Date();
  const t0 = Date.now();
  for (const step of plan) {
    const name = `${step.pkg} ${step.label}`;
    if (!packageStatus(step.pkg).installed) {
      results.push({ name, pkg: step.pkg, label: step.label, ok: false, note: 'not installed (run npm run setup)', ms: 0, tally: null, props: [] });
      console.log(`  ${red('FAIL')} ${name.padEnd(28)} not installed (run npm run setup)`);
      continue;
    }
    const live = process.stdout.isTTY && !args.verbose;
    if (live) process.stdout.write(`  ...  ${name}`);
    const r = await run(step, Boolean(args.verbose), Boolean(args.quick), Boolean(args.recording));
    const ok = r.code === 0;
    const note = counts(r.out);
    results.push({ name, pkg: step.pkg, label: step.label, ok, note, ms: r.ms, out: r.out, tally: tally(r.out), props: properties(r.out) });
    if (live) process.stdout.write('\r\u001b[K');
    console.log(`  ${ok ? green('ok  ') : red('FAIL')} ${name.padEnd(28)} ${dim(`${(r.ms / 1000).toFixed(1).padStart(5)} s`)}  ${note}`);
    if (!ok && !args.verbose) {
      const lines = r.out.trimEnd().split('\n');
      console.log(dim(`       last lines of npm run ${step.script} in ${step.pkg}/:`));
      console.log(lines.slice(-40).map((l) => `       ${l}`).join('\n'));
    }
  }
  const failed = results.filter((r) => !r.ok);
  if (args.json) writeReport(args.json, { results, ms: Date.now() - t0, build: Boolean(args.build), only, startedAt, quick: Boolean(args.quick) });
  console.log(bold(`\n${failed.length === 0 ? green('All green') : red(`${failed.length} of ${results.length} failed`)}: ${results.length} steps in ${((Date.now() - t0) / 1000).toFixed(1)} s.`));
  if (args.quick) console.log(dim('Quick run: the generated server days and the attack were skipped; npm test without --quick runs them (CI does).'));
  if (failed.length > 0) console.log(`Failed: ${failed.map((r) => r.name).join('; ')}`);
  return failed.length === 0 ? 0 : 1;
}

main().then((code) => process.exit(code));
