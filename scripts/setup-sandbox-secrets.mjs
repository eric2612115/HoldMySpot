#!/usr/bin/env node
// The PayPal part of scripts/setup-keys.mjs, for a secrets folder outside the repo:
// $HMS_SECRETS_DIR, else ~/.config/paypal-hackathon (the server's default). Same flags as
// `npm run keys -- --only paypal`: --check, --dry-run, --client-id, --buyer-email, --payout-email,
// --merchant-email, --merchant-id, --webhook-id, --secret-stdin, --keep-secret, --no-verify,
// --no-lookup, --dir. Names the file does not manage are kept as they are. Nothing secret is printed.
//
// Judges: use `npm run keys`, which writes .secrets/ in this repo; npm run demo and dev:sandbox read it.

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
if (argv.includes('--from')) {
  console.error('--from is no longer supported: pass the public values as flags (see --help), or use npm run keys.');
  process.exit(2);
}
const hasDir = argv.some((a) => a === '--dir' || a.startsWith('--dir='));
const dir = process.env.HMS_SECRETS_DIR || path.join(os.homedir(), '.config', 'paypal-hackathon');
const args = [path.join(here, 'setup-keys.mjs'), '--only', 'paypal', ...(hasDir ? [] : ['--dir', dir]), ...argv];
const child = spawn(process.execPath, args, { stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
