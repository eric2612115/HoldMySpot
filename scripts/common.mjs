// Shared helpers for the root scripts (setup, dev, doctor, test-all, setup-keys).
// Node built-ins only, so they run before any package is installed. Nothing here prints a
// secret: values read from secret files stay in memory and are reported as names only.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Install and test order: shared first, since the others link it with file:../shared. */
export const PACKAGES = ['shared', 'server', 'web', 'ops'];
export const DEFAULT_PORTS = Object.freeze({ server: 8796, web: 5190, ops: 5197 });
export const MIN_NODE_MAJOR = 24;
/** Keys written by `npm run keys` live here (git-ignored, mode 700, files mode 600). */
export const REPO_SECRETS_DIR = path.join(REPO, '.secrets');
export const RUN_DIR = path.join(REPO, '.run');

/** Every name the server needs for PayPal sandbox mode (server/src/config.ts SANDBOX_REQUIRED). */
export const SANDBOX_NAMES = ['PAYPAL_ENV', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_MERCHANT_EMAIL', 'PAYPAL_MERCHANT_ID', 'PAYPAL_BUYER_EMAIL', 'PAYPAL_PAYOUT_EMAIL'];
/** Older names the server still reads for these (PAYPAL_TW_PAYOUT_EMAIL was the payout receiver's first name). */
export const SANDBOX_ALIASES = Object.freeze({ PAYPAL_PAYOUT_EMAIL: 'PAYPAL_TW_PAYOUT_EMAIL' });
/** What npm run keys -- --from-env reads; it finds PAYPAL_ENV, PAYPAL_MERCHANT_EMAIL and PAYPAL_MERCHANT_ID itself. */
export const KEYS_FROM_ENV = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_BUYER_EMAIL', 'PAYPAL_PAYOUT_EMAIL'];
export const AI_KEY_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MODEL_API_KEY'];
/** Non-secret AI settings that may sit in .secrets/ai.env next to the key; the launcher passes them on. */
export const AI_SETTING_NAMES = ['HMS_AI_PROVIDER', 'HMS_AI_MODEL', 'HMS_AI_BASE_URL', 'HMS_AI_MODE', 'HMS_ANTHROPIC_MODEL', 'HMS_MUSE_MODEL', 'HMS_MUSE_URL'];
export const LICENCE_FILES = {
  grid: { file: 'aggrid-license.txt', env: 'HMS_AG_LICENSE_FILE', label: 'AG Grid / AG Charts Enterprise' },
  studio: { file: 'agstudio-license.txt', env: 'HMS_AG_STUDIO_LICENSE_FILE', label: 'AG Studio' },
};

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\u001b[${code}m${s}\u001b[0m` : String(s));
export const bold = paint('1');
export const dim = paint('2');
export const red = paint('31');
export const green = paint('32');
export const yellow = paint('33');
export const cyan = paint('36');

export function expandHome(p) {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

/** A path for messages: relative to the repo when inside it, ~ for the home folder. */
export function shown(p) {
  const rel = path.relative(REPO, p);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  if (!rel) return '.';
  const home = os.homedir();
  return p.startsWith(home + path.sep) ? `~/${path.relative(home, p)}` : p;
}

// ---------------------------------------------------------------------------
// Node and npm
// ---------------------------------------------------------------------------

export function nodeStatus() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= MIN_NODE_MAJOR) return { ok: true, version: process.versions.node, text: `Node ${process.versions.node}` };
  return {
    ok: false,
    version: process.versions.node,
    text: `Node ${process.versions.node} is too old: HoldMySpot needs Node ${MIN_NODE_MAJOR} or newer (the server runs TypeScript directly and uses node:sqlite). With nvm: nvm install ${MIN_NODE_MAJOR} && nvm use (the repo has an .nvmrc).`,
  };
}

/** Exits with a clear message on an old Node, unless HMS_SKIP_NODE_CHECK=1. */
export function requireNode() {
  const s = nodeStatus();
  if (s.ok || process.env.HMS_SKIP_NODE_CHECK === '1') return;
  console.error(red(s.text));
  process.exit(1);
}

export function npmVersion() {
  const r = spawnSync(npmCommand(), ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Whether a package's node_modules exists and matches its lockfile: every
 * required (non-optional) entry of package-lock.json must be in npm's own
 * record of what it installed (node_modules/.package-lock.json) at the same version.
 */
export function packageStatus(pkg) {
  const dir = path.join(REPO, pkg);
  const out = { pkg, installed: false, upToDate: false, detail: '' };
  if (!fs.existsSync(path.join(dir, 'node_modules'))) return { ...out, detail: 'not installed' };
  const lock = readJson(path.join(dir, 'package-lock.json'));
  const hidden = readJson(path.join(dir, 'node_modules', '.package-lock.json'));
  if (!lock || !hidden) return { ...out, installed: true, detail: 'installed, but npm has no record of it (run npm run setup)' };
  const drift = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith('node_modules/') || entry.optional || entry.link) continue;
    const got = hidden.packages?.[key];
    if (!got || got.version !== entry.version) drift.push(key.slice('node_modules/'.length));
  }
  if (drift.length > 0) return { ...out, installed: true, detail: `out of date with its lockfile (${drift.slice(0, 3).join(', ')}${drift.length > 3 ? ` and ${drift.length - 3} more` : ''})` };
  return { pkg, installed: true, upToDate: true, detail: 'installed' };
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

function canBind(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

function answers(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (v) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(700, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Free when nothing answers on 127.0.0.1:<port> and it can be bound there. */
export async function portFree(port) {
  if (await answers(port, '127.0.0.1')) return false;
  return canBind(port, '127.0.0.1');
}

/** Who holds a port, for messages: "pid 123 (node)" from lsof when it is there, else null. */
export function portOwner(port) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  const pid = /^p(\d+)/m.exec(r.stdout)?.[1];
  const cmd = /^c(.+)$/m.exec(r.stdout)?.[1];
  return pid ? `pid ${pid}${cmd ? ` (${cmd})` : ''}` : null;
}

export async function fetchJson(url, timeoutMs = 1500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Ports from flags: explicit --server-port etc. win, else default + --port-offset. */
export function resolvePorts(args) {
  const offset = args['port-offset'] === undefined ? 0 : Number(args['port-offset']);
  if (!Number.isInteger(offset) || offset < 0 || offset > 50000) throw new Error('--port-offset must be a whole number from 0 to 50000.');
  const pick = (name) => {
    const raw = args[`${name}-port`];
    const port = raw === undefined ? DEFAULT_PORTS[name] + offset : Number(raw);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`--${name}-port must be a port number from 1024 to 65535.`);
    return port;
  };
  const ports = { server: pick('server'), web: pick('web'), ops: pick('ops') };
  if (new Set(Object.values(ports)).size !== 3) throw new Error('The server, web and ops ports must differ.');
  return ports;
}

// ---------------------------------------------------------------------------
// Dotenv and secrets
// ---------------------------------------------------------------------------

/** KEY=value pairs (optional export, quotes, # comments). Values are never printed. */
export function parseDotenv(text) {
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

export function readDotenvFile(file) {
  try {
    return parseDotenv(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The HMS_* lines of server/.env.local (machine-local settings the server reads at boot). */
export function serverLocalEnv() {
  const env = readDotenvFile(path.join(REPO, 'server', '.env.local'));
  const out = {};
  if (env) for (const [k, v] of env) if (k.startsWith('HMS_')) out[k] = v;
  return out;
}

/**
 * Which secrets folder the server will use (D-131): HMS_SECRETS_DIR when set, else this repo's
 * .secrets/ (written by npm run keys). No folder outside the repo is read unless HMS_SECRETS_DIR
 * names it, so every machine runs the same zero-key demo until keys are saved.
 * `outside`: the folder is not inside this repo (doctor says so).
 */
export function secretsChoice(env = process.env) {
  const fromEnv = env.HMS_SECRETS_DIR?.trim();
  if (fromEnv) {
    const dir = path.resolve(expandHome(fromEnv));
    const rel = path.relative(REPO, dir);
    return { dir, source: `HMS_SECRETS_DIR (${shown(dir)})`, pass: true, outside: rel.startsWith('..') || path.isAbsolute(rel) };
  }
  const exists = fs.existsSync(REPO_SECRETS_DIR);
  return { dir: REPO_SECRETS_DIR, source: exists ? '.secrets/ in this repo (npm run keys)' : 'none yet (.secrets/ is written by npm run keys)', pass: exists, outside: false };
}

export function fileMode(file) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

/** Writes a private file atomically (folder 700, file 600). */
export function writePrivate(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // A shared folder may belong to another setup; the file mode is what matters.
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

// ---------------------------------------------------------------------------
// PayPal sandbox OAuth (the only PayPal call doctor makes)
// ---------------------------------------------------------------------------

export const SANDBOX_API = 'https://api-m.sandbox.paypal.com';
export const PAYPAL_FEATURES = [
  { feature: 'authorize and capture', pattern: /payments\/payment\/authcapture/, dashboard: 'Accept payments' },
  { feature: 'refunds', pattern: /payments\/refund/, dashboard: 'Accept payments' },
  { feature: 'payouts', pattern: /payments\/payouts/, dashboard: 'Payouts' },
  { feature: 'disputes', pattern: /disputes\/(read|update)-seller/, dashboard: 'Customer disputes' },
  { feature: 'shipment tracking', pattern: /shipping\/trackers/, dashboard: 'Shipment tracking (if listed)' },
];

/** POST /v1/oauth2/token with the client ID and secret. Returns status, scopes and the token (kept in memory). */
export async function paypalToken(clientId, secret) {
  try {
    const res = await fetch(`${SANDBOX_API}/v1/oauth2/token`, {
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
    if (!res.ok) return { ok: false, status: res.status, debugId, error: typeof data?.error === 'string' ? data.error : null };
    const scopes = typeof data?.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : [];
    const features = PAYPAL_FEATURES.map((f) => ({ ...f, ok: scopes.some((s) => f.pattern.test(s)) }));
    return { ok: true, status: res.status, debugId, features, token: typeof data?.access_token === 'string' ? data.access_token : null };
  } catch (err) {
    return { ok: false, status: 0, debugId: null, error: err?.name === 'TimeoutError' ? 'timeout' : 'network error' };
  }
}

export function describePayPalFailure(r) {
  if (r.status === 401) return `PayPal did not accept this client ID and secret (HTTP 401${r.debugId ? `, debug id ${r.debugId}` : ''}). Check that both come from the same app, with the Sandbox switch on.`;
  if (r.status === 0) return `could not reach PayPal (${r.error}).`;
  return `PayPal answered HTTP ${r.status}${r.error ? ` (${r.error})` : ''}${r.debugId ? `, debug id ${r.debugId}` : ''}.`;
}

// ---------------------------------------------------------------------------
// The server's own view of a configuration (exact, from its code)
// ---------------------------------------------------------------------------

const PROBE = `
const { loadLocalEnv } = await import('./src/localenv.ts');
const local = loadLocalEnv();
const { loadConfig, SANDBOX_REQUIRED } = await import('./src/config.ts');
const { resolveAiSettings, aiBootLine } = await import('./src/ai/config.ts');
// Inspection only: report what sandbox mode is missing instead of failing like a real boot does (D-108).
const c = loadConfig({ ...process.env, HMS_SANDBOX_FALLBACK: 'fake' });
const r = resolveAiSettings({ runtimeMode: c.mode, secretsDir: c.secretsDir, aiProvider: c.ai.provider, aiMode: c.ai.mode, timeoutMs: c.ai.timeoutMs, fixturesDir: c.ai.fixturesDir });
const s = r.settings;
console.log(JSON.stringify({
  local, mode: c.mode, modeReason: c.modeReason, sandboxRequired: SANDBOX_REQUIRED, port: c.port, demo: c.demo,
  ai: { provider: s.provider, model: s.model, mode: s.mode, reason: s.reason, requested: s.requestedProvider,
        keys: { anthropic: r.report.anthropicKeyPresent, muse: r.report.museKeyPresent, openai: r.report.openaiKeyPresent === true },
        sources: r.sources, bootLine: aiBootLine(r) },
}));
`;

const PING = `
const { loadLocalEnv } = await import('./src/localenv.ts');
loadLocalEnv();
const { loadConfig } = await import('./src/config.ts');
const { resolveAiSettings } = await import('./src/ai/config.ts');
const { createLiveProvider } = await import('./src/ai/provider.ts');
const c = loadConfig({ ...process.env, HMS_SANDBOX_FALLBACK: 'fake' });
const r = resolveAiSettings({ runtimeMode: c.mode, secretsDir: c.secretsDir, aiProvider: c.ai.provider, aiMode: 'live', timeoutMs: 45000 });
const p = createLiveProvider(r);
if (!p) {
  console.log(JSON.stringify({ ok: false, reason: 'no live provider: ' + r.settings.reason }));
} else {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  try {
    const res = await p.json({ task: 'reassign_note', system: 'You are a health check. Answer with JSON only.', prompt: 'Reply with {"ok": true}.', images: [], schemaName: 'health_check', schema, effort: 'low', fixtureKey: 'health-check' });
    console.log(JSON.stringify({ ok: res.data.ok === true, provider: res.stamp.provider, model: res.stamp.model, latencyMs: res.stamp.latencyMs }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, provider: p.id, model: p.model, reason: (e && e.kind ? e.kind + ': ' : '') + (e && e.message ? e.message : String(e)) }));
  }
}
`;

function runServerSnippet(code, env, timeout) {
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], {
    cwd: path.join(REPO, 'server'),
    env,
    encoding: 'utf8',
    timeout,
  });
  const last = (r.stdout ?? '').trim().split('\n').pop() ?? '';
  if (r.status === 0 && last.startsWith('{')) {
    try {
      return { ok: true, value: JSON.parse(last) };
    } catch {
      // fall through
    }
  }
  const err = (r.stderr ?? '').trim().split('\n').filter((l) => /Error|error:/.test(l)).slice(-2).join(' ');
  return { ok: false, error: r.error?.code === 'ETIMEDOUT' ? 'timed out' : err || `exit ${r.status}` };
}

/** What the server would do with this env: PayPal mode (with missing names) and the AI provider. Needs server/ installed. */
export function probeServer(env) {
  return runServerSnippet(PROBE, env, 30_000);
}

/** One tiny live model call through the server's own provider code (a few tokens). */
export function aiPing(env) {
  return runServerSnippet(PING, env, 60_000);
}

// ---------------------------------------------------------------------------
// The server environment the launcher uses
// ---------------------------------------------------------------------------

/** The env assignments at the start of server/package.json's "demo" script (the zero-key market). */
export function serverDemoEnv() {
  const fallback = { HMS_DEMO: '1', HMS_DEMO_RESET: '1', HMS_MARKET_START: '2026-11-12T10:30:00-08:00', HMS_CLOCK_SPEED: '60' };
  const pkg = readJson(path.join(REPO, 'server', 'package.json'));
  const script = typeof pkg?.scripts?.demo === 'string' ? pkg.scripts.demo : '';
  const out = {};
  for (const token of script.trim().split(/\s+/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(token);
    if (!m) break;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return Object.keys(out).length > 0 ? out : fallback;
}

/**
 * The environment for the server, web and ops of one run. `base` is the caller's env:
 * it wins for every setting below except the mode, the port and the --ai choice.
 */
export function launchEnv({ mode, ai, ports, demo = true, base = process.env }) {
  const server = { ...base };
  const set = (name, value) => {
    if (base[name] === undefined || base[name] === '') server[name] = value;
  };
  if (demo) for (const [k, v] of Object.entries(serverDemoEnv())) set(k, v);
  server.HMS_MODE = mode;
  server.HMS_PORT = String(ports.server);
  server.HMS_HOST = base.HMS_HOST || '127.0.0.1';
  set('HMS_WEB_ORIGINS', [ports.web, ports.ops].flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]).join(','));
  if (ports.server !== DEFAULT_PORTS.server) {
    // A second instance on other ports keeps its own market file and uploads.
    set('HMS_DB_PATH', path.join(REPO, 'server', 'data', `holdmyspot-${ports.server}.sqlite`));
    set('HMS_UPLOAD_DIR', path.join(REPO, 'server', 'data', `uploads-${ports.server}`));
  }

  const secrets = secretsChoice(base);
  if (secrets.pass) server.HMS_SECRETS_DIR = secrets.dir;
  const aiEnv = readDotenvFile(path.join(secrets.dir, 'ai.env'));
  if (aiEnv) {
    for (const name of AI_SETTING_NAMES) if (aiEnv.get(name)) set(name, aiEnv.get(name));
  }
  if (secrets.pass && fs.existsSync(path.join(secrets.dir, 'ai.env'))) {
    // Read first; any key files named in the environment or server/.env.local still follow.
    const existing = base.HMS_AI_KEY_FILES || serverLocalEnv().HMS_AI_KEY_FILES || '';
    server.HMS_AI_KEY_FILES = [path.join(secrets.dir, 'ai.env'), ...existing.split(',').map((s) => s.trim()).filter(Boolean)].join(',');
  }
  if (ai === 'live') server.HMS_AI_MODE = 'live';
  else if (ai === 'replay') server.HMS_AI_MODE = 'replay';
  else if (ai === 'rules') server.HMS_AI_PROVIDER = 'fake';

  const proxy = `http://127.0.0.1:${ports.server}`;
  const vite = { ...base, HMS_API_PROXY: proxy };
  const web = { ...vite };
  const ops = { ...vite, OPS_PORT: String(ports.ops) };
  const licences = {};
  for (const [kind, l] of Object.entries(LICENCE_FILES)) {
    // Licence files written by npm run keys sit in the chosen secrets folder (.secrets/ or HMS_SECRETS_DIR).
    const file = path.join(secrets.dir, l.file);
    if (base[l.env]) licences[kind] = l.env;
    else if (secrets.pass && fs.existsSync(file)) {
      ops[l.env] = file;
      licences[kind] = secrets.dir === REPO_SECRETS_DIR ? '.secrets/' : 'HMS_SECRETS_DIR';
    }
  }
  return { server, web, ops, secrets, licences };
}

/**
 * Where the ops console gets each AG key, in ops/vite.config.ts's order: the inline VITE_* key (shell
 * or ops/.env.local), else the key file named by HMS_AG_*_LICENSE_FILE, else the file in the secrets
 * folder; HMS_AG_TRIAL=1 (--no-ag-licence) ignores them all. Names and places only, never the key.
 */
export function licenceSources(env = process.env) {
  const opsLocal = readDotenvFile(path.join(REPO, 'ops', '.env.local'));
  const out = {};
  for (const [kind, l] of Object.entries(LICENCE_FILES)) {
    const inlineName = kind === 'grid' ? 'VITE_AG_LICENSE_KEY' : 'VITE_AG_STUDIO_LICENSE_KEY';
    const inline = env[inlineName] ? inlineName : opsLocal?.get(inlineName) ? `${inlineName} in ops/.env.local` : null;
    const chosen = secretsChoice(env);
    if (env.HMS_AG_TRIAL === '1') out[kind] = { source: 'none: trial mode forced (--no-ag-licence)', present: false };
    else if (inline) out[kind] = { source: inline, present: true };
    else if (env[l.env]) out[kind] = { source: `${l.env} (${fs.existsSync(expandHome(env[l.env])) ? 'file exists' : 'file missing'})`, present: fs.existsSync(expandHome(env[l.env])) };
    else if (chosen.pass && fs.existsSync(path.join(chosen.dir, l.file))) out[kind] = { source: `${shown(path.join(chosen.dir, l.file))}`, present: true };
    else out[kind] = { source: 'none (trial mode; AG hides its watermark on localhost and 127.0.0.1 anyway)', present: false };
  }
  return out;
}
