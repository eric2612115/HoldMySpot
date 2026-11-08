#!/usr/bin/env node
// Installs every package from its lockfile, shared first (server, web and ops link it with
// file:../shared): npm ci in shared, server, web and ops. No keys, no network beyond the npm registry.
//
//   npm run setup                     all four packages
//   npm run setup -- --only server,web

import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PACKAGES, REPO, bold, dim, green, npmCommand, npmVersion, red, requireNode } from './common.mjs';

const USAGE = `Install HoldMySpot's packages (npm ci in ${PACKAGES.join(', ')}, in that order).

  npm run setup [-- --only <list>]

Options:
  --only shared,server,web,ops   install only these (shared is always done first when listed)
  -h, --help
`;

function run(cwd) {
  return new Promise((resolve) => {
    const child = spawn(npmCommand(), ['ci', '--include=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd, stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function main() {
  let args;
  try {
    ({ values: args } = parseArgs({ options: { only: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true }));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  requireNode();
  const npm = npmVersion();
  if (!npm) {
    console.error(red('npm was not found on PATH. It comes with Node: https://nodejs.org'));
    return 1;
  }
  const wanted = args.only ? args.only.split(',').map((s) => s.trim()).filter(Boolean) : PACKAGES;
  const unknown = wanted.filter((p) => !PACKAGES.includes(p));
  if (unknown.length > 0) {
    console.error(red(`Unknown package: ${unknown.join(', ')}. Choose from ${PACKAGES.join(', ')}.`));
    return 2;
  }
  const order = PACKAGES.filter((p) => wanted.includes(p));
  console.log(bold(`Installing ${order.join(', ')} with npm ${npm} on Node ${process.versions.node}`));
  const t0 = Date.now();
  for (const pkg of order) {
    const t = Date.now();
    process.stdout.write(`  ${pkg.padEnd(7)} npm ci ...\n`);
    const code = await run(path.join(REPO, pkg));
    if (code !== 0) {
      console.error(red(`\nnpm ci failed in ${pkg}/ (exit ${code}).`));
      console.error('Check the network and the Node version (npm run doctor), then run npm run setup again.');
      return 1;
    }
    console.log(`  ${green('ok')} ${pkg.padEnd(7)} ${dim(`${((Date.now() - t) / 1000).toFixed(1)} s`)}`);
  }
  console.log(bold(`\nInstalled in ${((Date.now() - t0) / 1000).toFixed(1)} s.`) + ' Next: npm run demo   (or npm run doctor to check keys and ports)');
  return 0;
}

main().then((code) => process.exit(code));
