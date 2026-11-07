#!/usr/bin/env node
// Writes the PayPal sandbox credentials file that HoldMySpot reads:
//   ~/.config/paypal-hackathon/sandbox.env  (or $HMS_SECRETS_DIR/sandbox.env), mode 600.
//
// It asks for one secret only, the sandbox app's client secret, typed or pasted
// with no echo. Public values (client ID, sandbox account emails, merchant ID)
// come from, in order: command-line flags, the existing file, an existing
// backend .env that lists sandbox apps in PAYPAL_MERCHANT_CREDS (by default
// ../Paypal/backend/.env next to this repository; only client IDs, account IDs
// and emails are taken from it, never its secrets), and finally a visible
// prompt. Keys this script does not manage are kept as they are, so any other
// local project that reads the same file keeps working.
//
// Nothing secret is printed or logged. The only network call is the optional
// check of the client ID and secret against PayPal's sandbox OAuth endpoint.
//
// Usage: node scripts/setup-sandbox-secrets.mjs [--check] [--help]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX_OAUTH = 'https://api-m.sandbox.paypal.com/v1/oauth2/token';
const MANAGED = [
  'PAYPAL_ENV',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_MERCHANT_EMAIL',
  'PAYPAL_MERCHANT_ID',
  'PAYPAL_BUYER_EMAIL',
  'PAYPAL_TW_PAYOUT_EMAIL',
  'PAYPAL_WEBHOOK_ID',
];
const FEATURES = [
  { feature: 'authorize and capture', pattern: /payments\/payment\/authcapture/, dashboard: 'Accept payments' },
  { feature: 'refunds', pattern: /payments\/refund/, dashboard: 'Accept payments' },
  { feature: 'payouts', pattern: /payments\/payouts/, dashboard: 'Payouts' },
  { feature: 'disputes', pattern: /disputes\/(read|update)-seller/, dashboard: 'Customer disputes' },
  { feature: 'shipment tracking', pattern: /shipping\/trackers/, dashboard: 'Shipment tracking (if listed)' },
];

const USAGE = `Set up the PayPal sandbox credentials file for HoldMySpot.

  node scripts/setup-sandbox-secrets.mjs [options]

Writes sandbox.env in $HMS_SECRETS_DIR or ~/.config/paypal-hackathon (mode 600).
Asks only for the client secret (input hidden). Public values come from flags,
the existing file, an existing backend .env with PAYPAL_MERCHANT_CREDS, or a prompt.

Options:
  --check                   Check the saved file (names, mode, live sandbox OAuth); write nothing.
  --dry-run                 Show what would be written (public values only); write nothing.
  --from <file>             Backend .env to read public values from
                            (default: $PAYPAL_SETUP_FROM, else ../Paypal/backend/.env next to this repo).
  --merchant-email <email>  Which app in PAYPAL_MERCHANT_CREDS to use (default: DEMO_MARKET_EMAIL there).
  --client-id <id>          Sandbox REST app client ID (public).
  --merchant-id <id>        Sandbox business account ID (public).
  --buyer-email <email>     US personal sandbox account that approves holds.
  --payout-email <email>    Taiwan personal sandbox account that receives payouts.
  --webhook-id <id>         PayPal webhook ID (only with a public URL).
  --dir <dir>               Secrets folder (default: $HMS_SECRETS_DIR or ~/.config/paypal-hackathon).
  --keep-secret             Keep the saved secret without asking (only if the client ID did not change).
  --secret-stdin            Read the secret from standard input instead of a hidden prompt.
  --no-verify               Skip the live check against the PayPal sandbox.
  -h, --help                Show this help.
`;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SAFE_VALUE = /^[^\s"'#\\]+$/;

function expandHome(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function mask(id) {
  return id.length <= 12 ? id : `${id.slice(0, 6)}...${id.slice(-4)}`;
}

/** KEY=value pairs; quotes removed; values are never printed. */
function parseDotenv(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2] ?? '';
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    out.set(m[1], value);
  }
  return out;
}

function readEnvFile(file) {
  try {
    return parseDotenv(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Public values from a backend .env that lists sandbox apps as
 * PAYPAL_MERCHANT_CREDS={"<email>":{"clientId":"...","clientSecret":"...","accountId":"..."}}.
 * Only clientId, accountId and the emails are read; secrets are dropped at once.
 */
function sourceValues(file, merchantEmailFlag) {
  const env = readEnvFile(file);
  if (!env) return null;
  const merchantEmail = merchantEmailFlag || env.get('DEMO_MARKET_EMAIL') || '';
  let apps = {};
  try {
    apps = JSON.parse(env.get('PAYPAL_MERCHANT_CREDS') || '{}');
  } catch {
    apps = {};
  }
  const out = { file, merchantEmail, clientId: '', merchantId: '', buyerEmail: env.get('PAYPAL_GRANTOR_EMAIL') || '', apps: [] };
  if (apps && typeof apps === 'object') {
    for (const [email, app] of Object.entries(apps)) {
      out.apps.push(email);
      if (email === merchantEmail && app && typeof app === 'object') {
        if (typeof app.clientId === 'string') out.clientId = app.clientId.trim();
        if (typeof app.accountId === 'string') out.merchantId = app.accountId.trim();
      }
    }
  }
  apps = null;
  return out;
}

async function askVisible(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Reads one line with the terminal in raw mode: nothing is echoed, not even asterisks. */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = '';
    const wasRaw = Boolean(stdin.isRaw);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const finish = (err) => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write('\n');
      if (err) reject(err);
      // Drop terminal escape sequences (bracketed paste markers, arrow keys).
      else resolve(value.replace(/\u001b\[[0-9;]*[A-Za-z~]/g, '').trim());
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(null);
        if (ch === '\u0003') return finish(new Error('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch === '\u0015') value = '';
        else if (ch === '\u001b' || ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readStdinLine() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return (data.split(/\r?\n/)[0] ?? '').trim();
}

async function checkWithPayPal(clientId, secret) {
  try {
    const res = await fetch(SANDBOX_OAUTH, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(20_000),
    });
    const debugId = res.headers.get('paypal-debug-id');
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) return { ok: false, status: res.status, debugId, error: data && typeof data.error === 'string' ? data.error : null };
    return { ok: true, status: res.status, debugId, scope: data && typeof data.scope === 'string' ? data.scope : '' };
  } catch (err) {
    return { ok: false, status: 0, debugId: null, error: err && err.name === 'TimeoutError' ? 'timeout' : 'network error' };
  }
}

function printFeatures(scope) {
  const scopes = scope.split(/\s+/).filter(Boolean);
  for (const f of FEATURES) {
    const ok = scopes.some((s) => f.pattern.test(s));
    console.log(`     ${ok ? 'yes' : 'NO '}  ${f.feature}${ok ? '' : `  (developer.paypal.com > Apps & Credentials > Sandbox > your app > Features: tick "${f.dashboard}", save, run this again)`}`);
  }
}

function describeFailure(r) {
  if (r.status === 401) return `PayPal did not accept this client ID and secret pair (HTTP 401${r.debugId ? `, debug id ${r.debugId}` : ''}). Check that both come from the same app, with the switch on Sandbox.`;
  if (r.status === 0) return `Could not reach PayPal (${r.error}).`;
  return `PayPal answered HTTP ${r.status}${r.error ? ` (${r.error})` : ''}${r.debugId ? `, debug id ${r.debugId}` : ''}.`;
}

function fileMode(file) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

/** Writes atomically with mode 600: managed keys first, then the other keys' original lines. */
function writeSecretsFile(file, values, keptLines) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // The folder may belong to another setup; the file mode below is what matters.
  }
  const lines = [
    '# PayPal sandbox credentials for local PayPal hackathon projects.',
    `# Written by HoldMySpot scripts/setup-sandbox-secrets.mjs on ${new Date().toISOString()}.`,
    '# Private: keep mode 600, never commit or share this file.',
  ];
  for (const key of MANAGED) if (values[key]) lines.push(`${key}=${values[key]}`);
  if (keptLines.length > 0) lines.push('# Other keys, kept from the previous file:', ...keptLines);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function otherKeyLines(raw) {
  const kept = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && !MANAGED.includes(m[1])) kept.push(line);
  }
  return kept;
}

function show(key, value, origin) {
  let shown;
  if (!value) shown = '(not set)';
  else if (key === 'PAYPAL_CLIENT_SECRET') shown = 'set (hidden)';
  else if (key === 'PAYPAL_CLIENT_ID') shown = mask(value);
  else shown = value;
  console.log(`  ${key.padEnd(24)} ${shown}${origin ? `   [${origin}]` : ''}`);
}

async function check(file, verify) {
  console.log(`\nChecking ${file}`);
  const env = readEnvFile(file);
  if (!env) {
    console.log('  Not found. Run: node scripts/setup-sandbox-secrets.mjs');
    return 2;
  }
  const mode = fileMode(file);
  console.log(`  mode ${mode === null ? 'unknown' : mode.toString(8)}${mode !== null && (mode & 0o077) !== 0 ? '  (other users can read it: chmod 600 it)' : ''}`);
  for (const key of MANAGED) show(key, env.get(key) || '', null);
  const others = [...env.keys()].filter((k) => !MANAGED.includes(k));
  if (others.length > 0) console.log(`  Other keys kept for other projects: ${others.join(', ')}`);
  let code = 0;
  if (env.get('PAYPAL_ENV') !== 'sandbox') {
    console.log('  PAYPAL_ENV must be "sandbox".');
    code = 1;
  }
  const clientId = env.get('PAYPAL_CLIENT_ID') || '';
  const secret = env.get('PAYPAL_CLIENT_SECRET') || '';
  if (!clientId || !secret) {
    console.log('  PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are both needed.');
    return 2;
  }
  if (verify) {
    const r = await checkWithPayPal(clientId, secret);
    if (r.ok) {
      console.log(`  Live check: PayPal sandbox accepted the credentials (HTTP ${r.status}${r.debugId ? `, debug id ${r.debugId}` : ''}). Features:`);
      printFeatures(r.scope);
    } else {
      console.log(`  Live check failed: ${describeFailure(r)}`);
      code = 1;
    }
  }
  return code;
}

async function main() {
  let args;
  try {
    ({ values: args } = parseArgs({
      options: {
        check: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        from: { type: 'string' },
        'merchant-email': { type: 'string' },
        'client-id': { type: 'string' },
        'merchant-id': { type: 'string' },
        'buyer-email': { type: 'string' },
        'payout-email': { type: 'string' },
        'webhook-id': { type: 'string' },
        dir: { type: 'string' },
        'keep-secret': { type: 'boolean' },
        'secret-stdin': { type: 'boolean' },
        'no-verify': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(String(err.message ?? err));
    console.error('Run with --help for the options.');
    return 1;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const dir = expandHome(args.dir || process.env.HMS_SECRETS_DIR || path.join(os.homedir(), '.config', 'paypal-hackathon'));
  const file = path.join(dir, 'sandbox.env');
  if (args.check) return check(file, !args['no-verify']);

  const existingRaw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const existing = parseDotenv(existingRaw);
  const sourceFile = expandHome(args.from || process.env.PAYPAL_SETUP_FROM || path.resolve(REPO, '..', 'Paypal', 'backend', '.env'));
  const src = sourceValues(sourceFile, args['merchant-email']);

  console.log('\nHoldMySpot: PayPal sandbox credentials');
  console.log(`  File: ${file}`);
  if (src) console.log(`  Public values from: ${sourceFile}${src.merchantEmail ? ` (app of ${src.merchantEmail})` : ''}`);
  else if (args.from) console.log(`  Could not read ${sourceFile}; using flags, the existing file and prompts.`);

  // Public values: flag > existing file > source .env > prompt. A --merchant-email flag
  // means "switch app", so the source's client ID and account ID then win over the file.
  const values = { PAYPAL_ENV: 'sandbox' };
  const origin = { PAYPAL_ENV: 'fixed' };
  const switching = Boolean(args['merchant-email']);
  const pick = (key, flag, fromSource, sourceWins = false) => {
    const prior = existing.get(key) || '';
    if (flag) [values[key], origin[key]] = [flag, 'flag'];
    else if (sourceWins && fromSource) [values[key], origin[key]] = [fromSource, 'backend .env'];
    else if (prior) [values[key], origin[key]] = [prior, 'kept'];
    else if (fromSource) [values[key], origin[key]] = [fromSource, 'backend .env'];
    else values[key] = '';
  };
  pick('PAYPAL_CLIENT_ID', args['client-id'], src?.clientId, switching);
  pick('PAYPAL_MERCHANT_EMAIL', args['merchant-email'], src?.merchantEmail, switching);
  pick('PAYPAL_MERCHANT_ID', args['merchant-id'], src?.merchantId, switching);
  pick('PAYPAL_BUYER_EMAIL', args['buyer-email'], src?.buyerEmail);
  pick('PAYPAL_TW_PAYOUT_EMAIL', args['payout-email'], '');
  pick('PAYPAL_WEBHOOK_ID', args['webhook-id'], '');

  const interactive = Boolean(process.stdin.isTTY) && !args['secret-stdin'];
  if (!args['dry-run'] && interactive) {
    if (!values.PAYPAL_CLIENT_ID) {
      values.PAYPAL_CLIENT_ID = await askVisible('\nSandbox app client ID (public; developer.paypal.com > Apps & Credentials > Sandbox > your app): ');
      origin.PAYPAL_CLIENT_ID = 'typed';
    }
    const optional = [
      ['PAYPAL_MERCHANT_EMAIL', 'Sandbox business account email of that app (Enter to skip): '],
      ['PAYPAL_MERCHANT_ID', 'Sandbox business account ID (Enter to skip): '],
      ['PAYPAL_BUYER_EMAIL', 'US personal sandbox account email that approves holds (Enter to skip): '],
      ['PAYPAL_TW_PAYOUT_EMAIL', 'Taiwan personal sandbox account email that receives payouts (Enter to skip): '],
    ];
    for (const [key, question] of optional) {
      if (values[key]) continue;
      const answer = await askVisible(question);
      if (answer) [values[key], origin[key]] = [answer, 'typed'];
    }
  }

  for (const key of ['PAYPAL_MERCHANT_EMAIL', 'PAYPAL_BUYER_EMAIL', 'PAYPAL_TW_PAYOUT_EMAIL']) {
    if (values[key] && !EMAIL.test(values[key])) {
      console.error(`${key} does not look like an email address.`);
      return 1;
    }
  }
  for (const key of MANAGED) {
    if (key !== 'PAYPAL_CLIENT_SECRET' && values[key] && !SAFE_VALUE.test(values[key])) {
      console.error(`${key} contains spaces, quotes or #; please check it.`);
      return 1;
    }
  }
  if (!values.PAYPAL_CLIENT_ID) {
    console.error('\nNo client ID: pass --client-id <id>, or --from a backend .env that lists the app.');
    return 2;
  }

  // The one secret.
  const savedSecret = existing.get('PAYPAL_CLIENT_SECRET') || '';
  const sameApp = (existing.get('PAYPAL_CLIENT_ID') || '') === values.PAYPAL_CLIENT_ID;
  const canKeep = Boolean(savedSecret) && sameApp;
  if (args['dry-run']) {
    console.log('\nWould write (secret not shown, nothing asked):');
    origin.PAYPAL_CLIENT_SECRET = canKeep ? 'kept' : 'would ask';
    for (const key of MANAGED) show(key, key === 'PAYPAL_CLIENT_SECRET' ? (canKeep ? 'x' : '') : values[key], origin[key] ?? '');
    const kept = otherKeyLines(existingRaw);
    if (kept.length > 0) console.log(`  plus ${kept.length} other key(s) kept for other projects`);
    return 0;
  }

  const verify = !args['no-verify'];
  let secret = '';
  if (args['keep-secret']) {
    if (!canKeep) {
      console.error('--keep-secret: there is no saved secret for this client ID.');
      return 2;
    }
    secret = savedSecret;
    origin.PAYPAL_CLIENT_SECRET = 'kept';
  } else if (args['secret-stdin']) {
    secret = await readStdinLine();
    origin.PAYPAL_CLIENT_SECRET = 'stdin';
  } else if (!process.stdin.isTTY) {
    console.error('Run this in a terminal (the secret is typed with hidden input), or use --secret-stdin or --keep-secret.');
    return 2;
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (!secret) {
      console.log(`\nClient secret of app ${mask(values.PAYPAL_CLIENT_ID)}: on its page in developer.paypal.com (Sandbox), copy "Secret key".`);
      const answer = await askHidden(`Paste it here (nothing is shown${canKeep ? '; Enter keeps the saved one' : ''}): `);
      if (!answer && canKeep) {
        secret = savedSecret;
        origin.PAYPAL_CLIENT_SECRET = 'kept';
      } else {
        secret = answer;
        origin.PAYPAL_CLIENT_SECRET = 'typed';
        if (secret) console.log(`  Received ${secret.length} characters.`);
      }
    }
    if (!secret) {
      console.log('  Nothing received.');
      if (!interactive) return 2;
      continue;
    }
    if (/\s/.test(secret) || !SAFE_VALUE.test(secret)) {
      console.log('  That contains spaces or quotes; a PayPal secret does not. Try again.');
      secret = '';
      if (!interactive) return 1;
      continue;
    }
    if (!verify) break;
    const r = await checkWithPayPal(values.PAYPAL_CLIENT_ID, secret);
    if (r.ok) {
      console.log(`  PayPal sandbox accepted the credentials (HTTP ${r.status}${r.debugId ? `, debug id ${r.debugId}` : ''}). Features of this app:`);
      printFeatures(r.scope);
      break;
    }
    console.log(`  ${describeFailure(r)}`);
    if (r.status === 0) {
      console.log('  Saving anyway; run with --check later to test the connection.');
      break;
    }
    secret = '';
    if (!interactive || attempt === 3) {
      console.error('\nNot saved.');
      return 1;
    }
  }
  if (!secret) {
    console.error('\nNo secret: not saved.');
    return 2;
  }

  values.PAYPAL_CLIENT_SECRET = secret;
  const kept = otherKeyLines(existingRaw);
  writeSecretsFile(file, values, kept);
  secret = '';
  values.PAYPAL_CLIENT_SECRET = 'x';

  console.log(`\nSaved ${file} (mode 600):`);
  for (const key of MANAGED) show(key, values[key], origin[key] ?? '');
  if (kept.length > 0) console.log(`  plus ${kept.length} other key(s) kept for other projects`);
  const missing = ['PAYPAL_MERCHANT_EMAIL', 'PAYPAL_MERCHANT_ID', 'PAYPAL_BUYER_EMAIL', 'PAYPAL_TW_PAYOUT_EMAIL'].filter((k) => !values[k]);
  if (missing.length > 0) console.log(`\nStill empty: ${missing.join(', ')}. The HoldMySpot server needs them for sandbox mode; run again with the matching flags.`);
  console.log('\nNext: node scripts/sandbox-gates.mjs plan');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\n${err && err.message ? err.message : String(err)}`);
    process.exit(1);
  },
);
