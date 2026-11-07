#!/usr/bin/env node
// Writes the keys HoldMySpot reads into the git-ignored .secrets/ folder of this repo
// (folder mode 700, files mode 600) and checks them. It never prints a value: only names,
// "set" or "missing", and the results of the checks.
//
//   npm run keys                    interactive; secrets are typed or pasted with hidden input
//   npm run keys -- --from-env      non-interactive (scripts, AI agents): reads the variables below
//   npm run keys -- --check         what is saved (names only), plus the PayPal OAuth check
//
// Files written:
//   .secrets/sandbox.env            PayPal sandbox app (the format server/src/config.ts and
//                                   server/src/paypal/credentials.ts read)
//   .secrets/ai.env                 the AI provider, its key and optional model and endpoint
//   .secrets/aggrid-license.txt     AG Grid / AG Charts Enterprise licence key (ops console)
//   .secrets/agstudio-license.txt   AG Studio licence key (ops console)
//
// Network: the PayPal check is one OAuth token call to the sandbox. When the merchant email and
// ID are not given, it also creates one $1.00 sandbox order that is never approved (it expires on
// its own) to read the app's business account from the answer. The AI check is one tiny model
// call through the server's own provider code. --no-verify skips all of it.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import {
  REPO,
  REPO_SECRETS_DIR,
  SANDBOX_API,
  aiPing,
  bold,
  describePayPalFailure,
  dim,
  expandHome,
  fileMode,
  green,
  packageStatus,
  parseDotenv,
  paypalToken,
  red,
  requireNode,
  shown,
  writePrivate,
  yellow,
} from './common.mjs';

const USAGE = `Save HoldMySpot's keys in .secrets/ (git-ignored, mode 600). Values are never printed.

  npm run keys                     interactive
  npm run keys -- --from-env       non-interactive: reads the variables below from the environment
  npm run keys -- --check          show what is saved (names only) and check the PayPal keys

Variables for --from-env (set only the sections you want):
  PayPal sandbox  PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_BUYER_EMAIL, PAYPAL_PAYOUT_EMAIL
                  optional: PAYPAL_MERCHANT_EMAIL and PAYPAL_MERCHANT_ID (looked up when absent),
                  PAYPAL_WEBHOOK_ID (only with a public URL)
  AI              OPENAI_API_KEY, ANTHROPIC_API_KEY or MODEL_API_KEY (Meta), and HMS_AI_PROVIDER
                  (openai, anthropic or muse; needed only when several keys are set);
                  optional HMS_AI_MODEL and HMS_AI_BASE_URL (any OpenAI-compatible endpoint)
  AG licences     AG_GRID_LICENSE_KEY, AG_STUDIO_LICENSE_KEY

Options:
  --only paypal,ai,ag       only these sections
  --dir <dir>               secrets folder (default: $HMS_SECRETS_DIR, else .secrets/ in this repo)
  --client-id <id>, --buyer-email <e>, --payout-email <e>, --merchant-email <e>, --merchant-id <id>,
  --webhook-id <id>         PayPal values as flags (public ones only; the secret is never a flag)
  --secret-stdin            read the PayPal client secret from standard input
  --keep-secret             keep the saved PayPal secret (same client ID only)
  --no-verify               no network checks at all
  --no-lookup               do not create the $1.00 lookup order; ask for or require the merchant values
  --live-ai                 with --check: also one tiny live model call with the saved AI key
  --dry-run                 show what would be written (names only); write nothing
  -h, --help
`;

const PAYPAL_MANAGED = ['PAYPAL_ENV', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_MERCHANT_EMAIL', 'PAYPAL_MERCHANT_ID', 'PAYPAL_BUYER_EMAIL', 'PAYPAL_TW_PAYOUT_EMAIL', 'PAYPAL_WEBHOOK_ID'];
const AI_PROVIDERS = {
  openai: { key: 'OPENAI_API_KEY', label: 'OpenAI', defaultModel: 'gpt-6.1-sol (the server default)' },
  anthropic: { key: 'ANTHROPIC_API_KEY', label: 'Anthropic', defaultModel: 'claude-opus-5-5 (the server default)' },
  muse: { key: 'MODEL_API_KEY', label: "Meta's Muse Spark", defaultModel: 'muse-spark-1.3 (the server default)' },
};
const AI_MANAGED = ['HMS_AI_PROVIDER', 'HMS_AI_MODEL', 'HMS_AI_BASE_URL', 'HMS_ANTHROPIC_MODEL', 'HMS_MUSE_MODEL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MODEL_API_KEY'];
const LICENCES = [
  { env: 'AG_GRID_LICENSE_KEY', file: 'aggrid-license.txt', label: 'AG Grid / AG Charts Enterprise licence key' },
  { env: 'AG_STUDIO_LICENSE_KEY', file: 'agstudio-license.txt', label: 'AG Studio licence key' },
];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SAFE = /^[^\s"'#\\]+$/;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

let rl = null;
function lineReader() {
  rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}
function closeReader() {
  rl?.close();
  rl = null;
}

async function ask(question) {
  return (await lineReader().question(question)).trim();
}

async function yes(question, def = false) {
  const a = (await ask(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
  return a ? a.startsWith('y') : def;
}

/** One line with the terminal in raw mode: nothing is echoed, not even asterisks. */
function askHidden(question) {
  closeReader();
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

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Lines of an existing dotenv file whose names this script does not manage (kept as they are). */
function otherLines(raw, managed) {
  const kept = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && !managed.includes(m[1])) kept.push(line);
  }
  return kept;
}

function dotenvValue(name, value) {
  if (SAFE.test(value)) return value;
  if (!value.includes('"') && !/[\r\n]/.test(value)) return `"${value}"`;
  throw new Error(`${name} contains characters a dotenv file cannot hold; please check it.`);
}

function writeDotenv(file, header, values, order, kept) {
  const lines = [...header];
  for (const k of order) if (values[k]) lines.push(`${k}=${dotenvValue(k, values[k])}`);
  if (kept.length > 0) lines.push('# Other names, kept from the previous file:', ...kept);
  writePrivate(file, `${lines.join('\n')}\n`);
}

function status(values, names) {
  return names.map((k) => `${k} ${values[k] ? 'set' : 'missing'}`).join(', ');
}

// ---------------------------------------------------------------------------
// PayPal
// ---------------------------------------------------------------------------

/** Creates one $1.00 sandbox order (never approved) and reads the app's business account from it. */
async function lookupMerchant(token) {
  try {
    const res = await fetch(`${SANDBOX_API}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        'PayPal-Request-Id': `hms-keys-${randomUUID()}`,
      },
      body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: '1.00' }, description: 'HoldMySpot setup check, never approved' }] }),
      signal: AbortSignal.timeout(20_000),
    });
    const debugId = res.headers.get('paypal-debug-id');
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    const payee = data?.purchase_units?.[0]?.payee;
    if (res.ok && typeof payee?.email_address === 'string' && typeof payee?.merchant_id === 'string') {
      return { ok: true, email: payee.email_address, merchantId: payee.merchant_id };
    }
    return { ok: false, why: res.ok ? 'the answer named no payee' : `HTTP ${res.status}${debugId ? `, debug id ${debugId}` : ''}` };
  } catch (err) {
    return { ok: false, why: err?.name === 'TimeoutError' ? 'timeout' : 'network error' };
  }
}

async function paypalSection(ctx) {
  const file = path.join(ctx.dir, 'sandbox.env');
  const raw = readText(file);
  const saved = parseDotenv(raw);
  const v = { PAYPAL_ENV: 'sandbox' };
  const env = process.env;
  const a = ctx.args;
  const pick = (key, flag, fromEnv) => flag || (ctx.fromEnv ? fromEnv : '') || saved.get(key) || '';
  v.PAYPAL_CLIENT_ID = pick('PAYPAL_CLIENT_ID', a['client-id'], env.PAYPAL_CLIENT_ID);
  v.PAYPAL_BUYER_EMAIL = pick('PAYPAL_BUYER_EMAIL', a['buyer-email'], env.PAYPAL_BUYER_EMAIL);
  v.PAYPAL_TW_PAYOUT_EMAIL = pick('PAYPAL_TW_PAYOUT_EMAIL', a['payout-email'], env.PAYPAL_PAYOUT_EMAIL || env.PAYPAL_TW_PAYOUT_EMAIL);
  v.PAYPAL_MERCHANT_EMAIL = pick('PAYPAL_MERCHANT_EMAIL', a['merchant-email'], env.PAYPAL_MERCHANT_EMAIL);
  v.PAYPAL_MERCHANT_ID = pick('PAYPAL_MERCHANT_ID', a['merchant-id'], env.PAYPAL_MERCHANT_ID);
  v.PAYPAL_WEBHOOK_ID = pick('PAYPAL_WEBHOOK_ID', a['webhook-id'], env.PAYPAL_WEBHOOK_ID);
  const clientChanged = Boolean(saved.get('PAYPAL_CLIENT_ID')) && saved.get('PAYPAL_CLIENT_ID') !== v.PAYPAL_CLIENT_ID;
  if (clientChanged && !a['merchant-email'] && !(ctx.fromEnv && env.PAYPAL_MERCHANT_EMAIL)) {
    // Another app: its business account is looked up again.
    v.PAYPAL_MERCHANT_EMAIL = '';
    v.PAYPAL_MERCHANT_ID = '';
  }

  if (ctx.interactive) {
    console.log(bold('\nPayPal sandbox') + dim(' (developer.paypal.com > Apps & Credentials, switch on Sandbox, open or create your app)'));
    const keep = (k) => (v[k] ? dim(' (Enter keeps the saved one)') : '');
    const id = await ask(`  Client ID${keep('PAYPAL_CLIENT_ID')}: `);
    if (id) {
      if (id !== saved.get('PAYPAL_CLIENT_ID')) {
        v.PAYPAL_MERCHANT_EMAIL = a['merchant-email'] || '';
        v.PAYPAL_MERCHANT_ID = a['merchant-id'] || '';
      }
      v.PAYPAL_CLIENT_ID = id;
    }
    console.log(dim('  Sandbox accounts: developer.paypal.com > Testing Tools > Sandbox Accounts (personal accounts).'));
    const buyer = await ask(`  Buyer email: the personal sandbox account you approve holds with${keep('PAYPAL_BUYER_EMAIL')}: `);
    if (buyer) v.PAYPAL_BUYER_EMAIL = buyer;
    const payout = await ask(`  Payout email: another personal sandbox account that receives queuer payouts${keep('PAYPAL_TW_PAYOUT_EMAIL')}: `);
    if (payout) v.PAYPAL_TW_PAYOUT_EMAIL = payout;
  }

  const missing = ['PAYPAL_CLIENT_ID', 'PAYPAL_BUYER_EMAIL', 'PAYPAL_TW_PAYOUT_EMAIL'].filter((k) => !v[k]);
  if (missing.length > 0) {
    const names = missing.map((k) => (k === 'PAYPAL_TW_PAYOUT_EMAIL' ? 'PAYPAL_PAYOUT_EMAIL' : k));
    throw new Error(`PayPal: missing ${names.join(', ')}.`);
  }
  for (const k of ['PAYPAL_BUYER_EMAIL', 'PAYPAL_TW_PAYOUT_EMAIL', 'PAYPAL_MERCHANT_EMAIL']) {
    if (v[k] && !EMAIL.test(v[k])) throw new Error(`PayPal: ${k === 'PAYPAL_TW_PAYOUT_EMAIL' ? 'PAYPAL_PAYOUT_EMAIL' : k} does not look like an email address.`);
  }
  for (const k of PAYPAL_MANAGED) if (v[k] && !SAFE.test(v[k])) throw new Error(`PayPal: ${k} contains spaces, quotes or #; please check it.`);
  if (v.PAYPAL_BUYER_EMAIL.toLowerCase() === v.PAYPAL_TW_PAYOUT_EMAIL.toLowerCase()) {
    console.log(yellow('  Note: the buyer and the payout receiver are the same account; a second personal sandbox account makes the money easier to follow.'));
  }

  // The one secret.
  const savedSecret = saved.get('PAYPAL_CLIENT_SECRET') || '';
  const canKeep = Boolean(savedSecret) && saved.get('PAYPAL_CLIENT_ID') === v.PAYPAL_CLIENT_ID;
  let secret = '';
  if (a['keep-secret']) {
    if (!canKeep) throw new Error('--keep-secret: there is no saved secret for this client ID.');
    secret = savedSecret;
  } else if (a['secret-stdin']) secret = await readStdinLine();
  else if (ctx.fromEnv) secret = env.PAYPAL_CLIENT_SECRET || (canKeep ? savedSecret : '');
  if (ctx.dryRun) {
    console.log(`  Would write ${shown(file)}: ${status({ ...v, PAYPAL_CLIENT_SECRET: secret || (canKeep ? 'x' : '') }, PAYPAL_MANAGED.filter((k) => k !== 'PAYPAL_ENV'))}`);
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (!secret && ctx.interactive) {
      const answer = await askHidden(`  Client secret (Secret key 1 on the app page; nothing is shown${canKeep ? '; Enter keeps the saved one' : ''}): `);
      secret = answer || (canKeep ? savedSecret : '');
      if (answer) console.log(dim(`  Received ${answer.length} characters.`));
    }
    if (!secret) throw new Error('PayPal: missing PAYPAL_CLIENT_SECRET.');
    if (!SAFE.test(secret)) {
      secret = '';
      if (!ctx.interactive) throw new Error('PayPal: PAYPAL_CLIENT_SECRET contains spaces or quotes; a PayPal secret does not.');
      console.log(red('  That contains spaces or quotes; a PayPal secret does not. Try again.'));
      continue;
    }
    if (ctx.noVerify) break;
    const r = await paypalToken(v.PAYPAL_CLIENT_ID, secret);
    if (r.ok) {
      console.log(`  ${green('ok')} The PayPal sandbox accepted the client ID and secret. Features of this app:`);
      for (const f of r.features) console.log(`     ${f.ok ? green('yes') : red('NO ')}  ${f.feature}${f.ok ? '' : dim(`  (app page > Features: tick "${f.dashboard}", save; then npm run keys -- --check)`)}`);
      if (!v.PAYPAL_MERCHANT_EMAIL || !v.PAYPAL_MERCHANT_ID) {
        if (ctx.args['no-lookup']) console.log(dim('  Merchant lookup skipped (--no-lookup).'));
        else if (r.token) {
          console.log(dim("  Looking up the app's business account (one $1.00 sandbox order, never approved; it expires on its own)..."));
          const m = await lookupMerchant(r.token);
          if (m.ok) {
            v.PAYPAL_MERCHANT_EMAIL = m.email;
            v.PAYPAL_MERCHANT_ID = m.merchantId;
            console.log(`  ${green('ok')} Found the business account (PAYPAL_MERCHANT_EMAIL and PAYPAL_MERCHANT_ID set).`);
          } else console.log(yellow(`  Could not look it up (${m.why}).`));
        }
      }
      break;
    }
    console.log(red(`  ${describePayPalFailure(r)}`));
    if (r.status === 0) {
      console.log(dim('  Saving anyway; run npm run keys -- --check later.'));
      break;
    }
    secret = '';
    if (!ctx.interactive || attempt === 3) throw new Error('PayPal: the client ID and secret were not accepted; nothing was saved.');
  }

  if ((!v.PAYPAL_MERCHANT_EMAIL || !v.PAYPAL_MERCHANT_ID) && ctx.interactive) {
    console.log(dim('  The business account of the app: Sandbox Accounts > the business account > View/Edit (email and Account ID).'));
    if (!v.PAYPAL_MERCHANT_EMAIL) v.PAYPAL_MERCHANT_EMAIL = await ask('  Business account email: ');
    if (!v.PAYPAL_MERCHANT_ID) v.PAYPAL_MERCHANT_ID = await ask('  Business account ID (Account ID): ');
  }
  if (!v.PAYPAL_MERCHANT_EMAIL || !v.PAYPAL_MERCHANT_ID) {
    throw new Error('PayPal: PAYPAL_MERCHANT_EMAIL and PAYPAL_MERCHANT_ID are needed (the business account of the app: Sandbox Accounts > View/Edit); set them, or allow the lookup.');
  }
  for (const k of ['PAYPAL_MERCHANT_EMAIL', 'PAYPAL_MERCHANT_ID']) if (!SAFE.test(v[k]) || (k === 'PAYPAL_MERCHANT_EMAIL' && !EMAIL.test(v[k]))) throw new Error(`PayPal: ${k} does not look right.`);

  v.PAYPAL_CLIENT_SECRET = secret;
  writeDotenv(
    file,
    ['# PayPal sandbox credentials for HoldMySpot (npm run keys). Private: mode 600, never commit or share it.', `# Written ${new Date().toISOString()}.`],
    v,
    PAYPAL_MANAGED,
    otherLines(raw, PAYPAL_MANAGED),
  );
  secret = '';
  v.PAYPAL_CLIENT_SECRET = 'x';
  console.log(`  ${green('saved')} ${shown(file)}: ${status(v, PAYPAL_MANAGED.filter((k) => k !== 'PAYPAL_ENV'))}`);
  ctx.saved.push('paypal');
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

async function aiSection(ctx) {
  const file = path.join(ctx.dir, 'ai.env');
  const raw = readText(file);
  const saved = parseDotenv(raw);
  const env = process.env;
  const v = Object.fromEntries(AI_MANAGED.map((k) => [k, saved.get(k) || '']));
  let provider = '';

  if (ctx.fromEnv) {
    const given = Object.entries(AI_PROVIDERS).filter(([, p]) => env[p.key]);
    provider = (env.HMS_AI_PROVIDER || '').trim().toLowerCase();
    if (!provider) {
      if (given.length > 1) throw new Error(`AI: several AI keys are set (${given.map(([, p]) => p.key).join(', ')}); set HMS_AI_PROVIDER to openai, anthropic or muse.`);
      provider = given[0]?.[0] ?? '';
    }
    if (!AI_PROVIDERS[provider]) throw new Error('AI: HMS_AI_PROVIDER must be openai, anthropic or muse.');
    const keyName = AI_PROVIDERS[provider].key;
    if (!env[keyName] && !v[keyName]) throw new Error(`AI: missing ${keyName} for HMS_AI_PROVIDER=${provider}.`);
    if (env[keyName]) v[keyName] = env[keyName].trim();
    v.HMS_AI_MODEL = (env.HMS_AI_MODEL ?? '').trim();
    v.HMS_AI_BASE_URL = (env.HMS_AI_BASE_URL ?? '').trim();
  } else {
    console.log(bold('\nAI model for the photo checks') + dim(' (without one, the demo replays recorded answers)'));
    console.log('  1) OpenAI   2) Anthropic   3) Meta Muse Spark   4) another OpenAI-compatible endpoint');
    const choice = await ask(`  Which one? (1-4, Enter to skip${saved.get('HMS_AI_PROVIDER') ? `; saved: ${saved.get('HMS_AI_PROVIDER')}` : ''}): `);
    if (!choice) return;
    provider = { 1: 'openai', 2: 'anthropic', 3: 'muse', 4: 'openai' }[choice] ?? '';
    if (!provider) throw new Error('AI: choose 1, 2, 3 or 4.');
    const p = AI_PROVIDERS[provider];
    const hasSaved = Boolean(v[p.key]);
    const key = await askHidden(`  ${choice === '4' ? 'API key of that endpoint' : `${p.label} API key`} (nothing is shown${hasSaved ? '; Enter keeps the saved one' : ''}): `);
    if (key) {
      v[p.key] = key;
      console.log(dim(`  Received ${key.length} characters.`));
    }
    if (!v[p.key]) throw new Error(`AI: no ${p.key} given.`);
    v.HMS_AI_BASE_URL = choice === '4' ? await ask('  Base URL of the endpoint (for example https://host/v1): ') : provider === 'openai' ? '' : v.HMS_AI_BASE_URL;
    if (choice === '4' && !v.HMS_AI_BASE_URL) throw new Error('AI: an OpenAI-compatible endpoint needs its base URL.');
    if (provider === 'openai') v.HMS_AI_MODEL = await ask(`  Model (Enter for ${choice === '4' ? 'the server default, which may not exist there' : p.defaultModel}): `);
    else v.HMS_AI_MODEL = '';
  }
  if (provider !== 'openai') v.HMS_AI_BASE_URL = '';
  if (v.HMS_AI_BASE_URL && !/^https?:\/\/\S+$/.test(v.HMS_AI_BASE_URL)) throw new Error('AI: HMS_AI_BASE_URL must be an http(s) URL.');
  if (provider !== 'openai' && v.HMS_AI_MODEL) {
    // HMS_AI_MODEL belongs to the OpenAI-compatible provider; the others have their own names.
    v[provider === 'anthropic' ? 'HMS_ANTHROPIC_MODEL' : 'HMS_MUSE_MODEL'] = v.HMS_AI_MODEL;
    v.HMS_AI_MODEL = '';
  }
  v.HMS_AI_PROVIDER = provider;
  const order = AI_MANAGED;
  if (ctx.dryRun) {
    console.log(`  Would write ${shown(file)}: HMS_AI_PROVIDER=${provider}; ${status(v, [AI_PROVIDERS[provider].key])}`);
    return;
  }
  for (const k of AI_MANAGED) if (v[k] && /[\r\n]/.test(v[k])) throw new Error(`AI: ${k} spans several lines; please check it.`);
  writeDotenv(
    file,
    ['# AI provider and key for HoldMySpot (npm run keys). Private: mode 600, never commit or share it.', '# The server reads the key names; npm run demo and dev:sandbox pass the HMS_AI_* settings on.'],
    v,
    order,
    otherLines(raw, AI_MANAGED),
  );
  console.log(`  ${green('saved')} ${shown(file)}: HMS_AI_PROVIDER=${provider}${v.HMS_AI_MODEL ? `, HMS_AI_MODEL=${v.HMS_AI_MODEL}` : ''}${v.HMS_AI_BASE_URL ? ', HMS_AI_BASE_URL set' : ''}, ${AI_PROVIDERS[provider].key} set`);
  ctx.saved.push('ai');

  if (ctx.noVerify) return;
  await checkAi(ctx, { HMS_AI_PROVIDER: provider, HMS_AI_MODEL: v.HMS_AI_MODEL, HMS_AI_BASE_URL: v.HMS_AI_BASE_URL, HMS_ANTHROPIC_MODEL: v.HMS_ANTHROPIC_MODEL, HMS_MUSE_MODEL: v.HMS_MUSE_MODEL });
}

/** One tiny live call through the server's provider code, reading the key from the folder just written. */
async function checkAi(ctx, settings) {
  if (!packageStatus('server').installed) {
    console.log(dim('  Key check skipped: server/ is not installed yet (npm run setup), then: npm run doctor -- --live-ai'));
    return;
  }
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('HMS_') || ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MODEL_API_KEY'].includes(k)) delete env[k];
  // Only the folder just written: no key files from the environment or server/.env.local.
  Object.assign(env, { HMS_SECRETS_DIR: ctx.dir, HMS_MODE: 'fake', HMS_AI_KEY_FILES: '' });
  for (const [k, val] of Object.entries(settings)) if (val) env[k] = val;
  console.log(dim('  Checking the key with one tiny model call (a few tokens)...'));
  const r = aiPing(env);
  if (r.ok && r.value.ok) console.log(`  ${green('ok')} ${r.value.provider} ${r.value.model} answered in ${r.value.latencyMs} ms.`);
  else console.log(yellow(`  The check did not pass: ${r.ok ? r.value.reason : r.error}. The key is saved; fix it and run npm run keys again.`));
}

// ---------------------------------------------------------------------------
// AG licences
// ---------------------------------------------------------------------------

async function agSection(ctx) {
  if (ctx.interactive) {
    console.log(bold('\nAG licences for the ops console') + dim(' (optional: AG hides its trial watermark on localhost and 127.0.0.1 anyway)'));
  }
  let wrote = 0;
  for (const l of LICENCES) {
    const file = path.join(ctx.dir, l.file);
    const exists = fs.existsSync(file);
    let key = '';
    if (ctx.fromEnv) key = (process.env[l.env] ?? '').trim();
    else key = await askHidden(`  ${l.label} (nothing is shown; Enter ${exists ? 'keeps the saved one' : 'skips'}): `);
    if (!key) continue;
    if (/[\r\n]/.test(key)) throw new Error(`${l.env} spans several lines; please check it.`);
    if (ctx.dryRun) {
      console.log(`  Would write ${shown(file)} (${key.length} characters)`);
      continue;
    }
    writePrivate(file, `${key}\n`);
    wrote++;
    console.log(`  ${green('saved')} ${shown(file)} (${key.length} characters)`);
  }
  if (wrote > 0) ctx.saved.push('ag');
}

// ---------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------

async function check(ctx) {
  console.log(bold(`Keys in ${shown(ctx.dir)}`) + dim(' (names only)'));
  if (!fs.existsSync(ctx.dir)) {
    console.log('  The folder does not exist yet. Run: npm run keys');
    return 1;
  }
  const mode = fileMode(ctx.dir);
  if (mode !== null && (mode & 0o077) !== 0) console.log(yellow(`  The folder is readable by other users (mode ${mode.toString(8)}): chmod 700 it.`));
  let code = 0;
  if (ctx.sections.includes('paypal')) {
    const file = path.join(ctx.dir, 'sandbox.env');
    const env = parseDotenv(readText(file));
    const values = Object.fromEntries(PAYPAL_MANAGED.map((k) => [k, env.get(k) || '']));
    const fm = fileMode(file);
    console.log(`  sandbox.env: ${fm === null ? 'absent' : `mode ${fm.toString(8)}; ${status(values, PAYPAL_MANAGED)}`}`);
    if (fm !== null && values.PAYPAL_CLIENT_ID && values.PAYPAL_CLIENT_SECRET && !ctx.noVerify) {
      const r = await paypalToken(values.PAYPAL_CLIENT_ID, values.PAYPAL_CLIENT_SECRET);
      if (r.ok) console.log(`    ${green('ok')} PayPal sandbox OAuth; ${r.features.map((f) => `${f.feature} ${f.ok ? 'yes' : 'NO'}`).join(', ')}`);
      else {
        console.log(`    ${red('failed')} ${describePayPalFailure(r)}`);
        code = 1;
      }
    }
  }
  if (ctx.sections.includes('ai')) {
    const file = path.join(ctx.dir, 'ai.env');
    const env = parseDotenv(readText(file));
    const fm = fileMode(file);
    const provider = env.get('HMS_AI_PROVIDER') || 'auto';
    console.log(`  ai.env: ${fm === null ? 'absent' : `mode ${fm.toString(8)}; HMS_AI_PROVIDER=${provider}; ${['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MODEL_API_KEY'].map((k) => `${k} ${env.get(k) ? 'set' : 'missing'}`).join(', ')}`}`);
    if (fm !== null && ctx.args['live-ai'] && !ctx.noVerify) {
      await checkAi(ctx, Object.fromEntries(['HMS_AI_PROVIDER', 'HMS_AI_MODEL', 'HMS_AI_BASE_URL', 'HMS_ANTHROPIC_MODEL', 'HMS_MUSE_MODEL'].map((k) => [k, env.get(k) || ''])));
    }
  }
  if (ctx.sections.includes('ag')) {
    for (const l of LICENCES) {
      const fm = fileMode(path.join(ctx.dir, l.file));
      console.log(`  ${l.file}: ${fm === null ? 'absent' : `present, mode ${fm.toString(8)}`}`);
    }
  }
  return code;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let args;
  try {
    ({ values: args } = parseArgs({
      options: {
        'from-env': { type: 'boolean' },
        check: { type: 'boolean' },
        only: { type: 'string' },
        dir: { type: 'string' },
        'client-id': { type: 'string' },
        'buyer-email': { type: 'string' },
        'payout-email': { type: 'string' },
        'merchant-email': { type: 'string' },
        'merchant-id': { type: 'string' },
        'webhook-id': { type: 'string' },
        'secret-stdin': { type: 'boolean' },
        'keep-secret': { type: 'boolean' },
        'no-verify': { type: 'boolean' },
        'no-lookup': { type: 'boolean' },
        'live-ai': { type: 'boolean' },
        'dry-run': { type: 'boolean' },
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
  requireNode();
  const sections = args.only ? args.only.split(',').map((s) => s.trim().toLowerCase()) : ['paypal', 'ai', 'ag'];
  if (sections.some((s) => !['paypal', 'ai', 'ag'].includes(s))) {
    console.error('--only takes paypal, ai and ag.');
    return 2;
  }
  const dir = path.resolve(expandHome(args.dir || process.env.HMS_SECRETS_DIR || REPO_SECRETS_DIR));
  const ctx = {
    args,
    dir,
    sections,
    fromEnv: Boolean(args['from-env']),
    interactive: !args['from-env'] && !args['secret-stdin'] && !args['keep-secret'] && Boolean(process.stdin.isTTY),
    noVerify: Boolean(args['no-verify']),
    dryRun: Boolean(args['dry-run']),
    saved: [],
  };
  if (args.check) return check(ctx);

  if (!ctx.fromEnv && !ctx.interactive && !args['secret-stdin'] && !args['keep-secret']) {
    console.error(red('No terminal to type into. Use: npm run keys -- --from-env (see --help for the variable names).'));
    return 2;
  }
  if (dir.startsWith(REPO + path.sep) && path.relative(REPO, dir) !== '.secrets') {
    console.error(red(`Refusing to write keys inside the repo outside .secrets/ (${shown(dir)}).`));
    return 2;
  }

  console.log(bold(`HoldMySpot keys -> ${shown(dir)}`) + dim(' (git-ignored; folder 700, files 600; values are never printed)'));
  const todo = sections.filter((s) => {
    if (!ctx.fromEnv) return true;
    const env = process.env;
    if (s === 'paypal') return Boolean(env.PAYPAL_CLIENT_ID || env.PAYPAL_CLIENT_SECRET || env.PAYPAL_BUYER_EMAIL || env.PAYPAL_PAYOUT_EMAIL || env.PAYPAL_TW_PAYOUT_EMAIL || args['client-id']);
    if (s === 'ai') return Boolean(env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || env.MODEL_API_KEY || env.HMS_AI_PROVIDER);
    return Boolean(env.AG_GRID_LICENSE_KEY || env.AG_STUDIO_LICENSE_KEY);
  });
  if (ctx.fromEnv && todo.length === 0) {
    console.error(`${red('--from-env: none of the variables are set.')}\n\n${USAGE}`);
    return 2;
  }
  const errors = [];
  for (const s of todo) {
    try {
      if (ctx.interactive && s === 'paypal' && !(await yes(`\nSet up the PayPal sandbox now (needed for npm run dev:sandbox)?`))) continue;
      if (ctx.interactive && s === 'ag' && !(await yes(`\nAdd AG licence keys (optional)?`))) continue;
      if (s === 'paypal') await paypalSection(ctx);
      else if (s === 'ai') await aiSection(ctx);
      else await agSection(ctx);
    } catch (err) {
      errors.push(err.message);
      console.error(red(`  ${err.message}`));
    } finally {
      closeReader();
    }
  }
  if (ctx.dryRun) return errors.length > 0 ? 1 : 0;
  console.log('');
  if (ctx.saved.length > 0) {
    const next = [];
    if (ctx.saved.includes('paypal')) next.push('npm run dev:sandbox');
    if (ctx.saved.includes('ai') && !ctx.saved.includes('paypal')) next.push('npm run demo -- --ai live');
    if (ctx.saved.includes('ag') && next.length === 0) next.push('npm run demo');
    console.log(`${green('Saved')} ${ctx.saved.join(', ')} in ${shown(dir)}. Check any time: npm run doctor. Next: ${next.join(' or ')}`);
  }
  if (dir === REPO_SECRETS_DIR) console.log(dim('npm run demo, dev:sandbox, gates and ai:eval use this folder automatically.'));
  else if (!process.env.HMS_SECRETS_DIR && ctx.saved.length > 0) console.log(dim(`To use this folder, set HMS_SECRETS_DIR=${shown(dir)} when you run npm run demo or dev:sandbox.`));
  return errors.length > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(red(err?.message ?? String(err)));
    process.exit(1);
  },
);
