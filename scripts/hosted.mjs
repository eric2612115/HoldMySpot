#!/usr/bin/env node
// The hosted judge site on this machine: one process, one port, one in-memory market per visitor (D-163).
//
//   npm run hosted                     builds the web app and ops console if needed, then serves them with the API
//   npm run hosted -- --build-only     only the build (Render's build step)
//   npm run hosted -- --build          build again, then serve
//   npm run hosted -- --port-offset 700
//
// The AG Studio key, when there is one, is read at build time (VITE_AG_STUDIO_LICENSE_KEY, or
// agstudio-license.txt in HMS_SECRETS_DIR or .secrets/). Nothing secret is printed.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_PORTS, REPO, bold, dim, green, red, requireNode } from './common.mjs';

const { values: args } = parseArgs({
  options: { build: { type: 'boolean' }, 'build-only': { type: 'boolean' }, 'port-offset': { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  strict: true,
});
if (args.help) {
  console.log('npm run hosted [-- --build | --build-only | --port-offset N | --port P]');
  process.exit(0);
}
requireNode();

const stamp = path.join(REPO, 'ops', 'dist', '.hosted-build');
const needBuild = args.build || args['build-only'] || !fs.existsSync(stamp) || !fs.existsSync(path.join(REPO, 'web', 'dist', 'judge.html'));
if (needBuild) {
  for (const [pkg, env] of [['web', {}], ['ops', { HMS_OPS_BASE: '/ops/' }]]) {
    console.log(bold(`Building ${pkg}/`));
    const r = spawnSync('npm', ['run', 'build'], { cwd: path.join(REPO, pkg), stdio: 'inherit', env: { ...process.env, ...env } });
    if (r.status !== 0) {
      console.error(red(`The ${pkg} build failed.`));
      process.exit(r.status ?? 1);
    }
  }
  fs.writeFileSync(stamp, 'built for /ops/\n');
  console.log(green('Built.'));
}
if (args['build-only']) process.exit(0);

const port = args.port ?? String(DEFAULT_PORTS.server + Number(args['port-offset'] ?? 0));
const child = spawn(process.execPath, ['src/hosted/main.ts'], { cwd: path.join(REPO, 'server'), stdio: 'inherit', env: { ...process.env, HMS_PORT: port, PORT: '', HMS_HOST: process.env.HMS_HOST ?? '127.0.0.1' } });
console.log(dim(`Judge's page: http://127.0.0.1:${port}/   Ops console: http://127.0.0.1:${port}/ops/`));
const stop = (signal) => child.kill(signal);
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
child.on('exit', (code) => process.exit(code ?? 0));
