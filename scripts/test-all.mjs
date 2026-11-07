#!/usr/bin/env node
// Runs every package's tests and type checks and prints one summary.
//
//   npm test                     shared check, server check, web and ops type checks and tests
//   npm test -- --build          also the web and ops production builds
//   npm test -- --only server --verbose
//
// The tests are hermetic: AI keys and HMS_* settings from your shell are not passed to them,
// so they never call a model or PayPal.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AI_KEY_NAMES, PACKAGES, REPO, bold, dim, green, npmCommand, packageStatus, red, requireNode } from './common.mjs';

const USAGE = `Run HoldMySpot's tests and type checks.

  npm test [-- options]

Options:
  --only shared,server,web,ops   run only these packages
  --build                        also run the web and ops production builds (vite build)
  --verbose                      print every step's output, not only failures
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

function hermeticEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('HMS_') || AI_KEY_NAMES.includes(k) || k.startsWith('PAYPAL_')) delete env[k];
  return env;
}

function run(step, verbose) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    const child = spawn(npmCommand(), ['run', step.script, '--silent'], {
      cwd: path.join(REPO, step.pkg),
      env: hermeticEnv(),
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

async function main() {
  let args;
  try {
    ({ values: args } = parseArgs({ options: { only: { type: 'string' }, build: { type: 'boolean' }, verbose: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, strict: true }));
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
  const t0 = Date.now();
  for (const step of plan) {
    const name = `${step.pkg} ${step.label}`;
    if (!packageStatus(step.pkg).installed) {
      results.push({ name, ok: false, note: 'not installed (run npm run setup)', ms: 0 });
      console.log(`  ${red('FAIL')} ${name.padEnd(28)} not installed (run npm run setup)`);
      continue;
    }
    const live = process.stdout.isTTY && !args.verbose;
    if (live) process.stdout.write(`  ...  ${name}`);
    const r = await run(step, Boolean(args.verbose));
    const ok = r.code === 0;
    const note = counts(r.out);
    results.push({ name, ok, note, ms: r.ms, out: r.out });
    if (live) process.stdout.write('\r\u001b[K');
    console.log(`  ${ok ? green('ok  ') : red('FAIL')} ${name.padEnd(28)} ${dim(`${(r.ms / 1000).toFixed(1).padStart(5)} s`)}  ${note}`);
    if (!ok && !args.verbose) {
      const lines = r.out.trimEnd().split('\n');
      console.log(dim(`       last lines of npm run ${step.script} in ${step.pkg}/:`));
      console.log(lines.slice(-40).map((l) => `       ${l}`).join('\n'));
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(bold(`\n${failed.length === 0 ? green('All green') : red(`${failed.length} of ${results.length} failed`)}: ${results.length} steps in ${((Date.now() - t0) / 1000).toFixed(1)} s.`));
  if (failed.length > 0) console.log(`Failed: ${failed.map((r) => r.name).join('; ')}`);
  return failed.length === 0 ? 0 : 1;
}

main().then((code) => process.exit(code));
