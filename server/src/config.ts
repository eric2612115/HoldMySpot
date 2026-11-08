import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RULES, DEMO_SEED } from '@holdmyspot/shared';
import type { AiMode, CheckoutFunding, MarketRules, RuntimeMode } from '@holdmyspot/shared';

/**
 * Server configuration from environment variables (docs/ARCHITECTURE.md
 * section 10). PayPal credentials are read only in sandbox mode, only from
 * `sandbox.env` in HMS_SECRETS_DIR (or the process env), and are never
 * logged: `describeConfig` reports names and presence only.
 */

export const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The repo's own key folder, written by `npm run keys` (git-ignored). The default secrets folder (D-131). */
export const DEFAULT_SECRETS_DIR = join(SERVER_ROOT, '..', '.secrets');

/** HMS_SECRETS_DIR with a leading ~ expanded, or null when unset. */
export function expandSecretsDir(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  return v === '~' ? homedir() : v.startsWith('~/') ? join(homedir(), v.slice(2)) : resolve(v);
}

export const SANDBOX_REQUIRED = [
  'PAYPAL_ENV',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_MERCHANT_EMAIL',
  'PAYPAL_MERCHANT_ID',
  'PAYPAL_BUYER_EMAIL',
  'PAYPAL_PAYOUT_EMAIL',
] as const;

/** Older names still read (D-132): PAYPAL_TW_PAYOUT_EMAIL was the payout receiver's first name. */
export const PAYPAL_NAME_ALIASES: Readonly<Record<string, string>> = { PAYPAL_PAYOUT_EMAIL: 'PAYPAL_TW_PAYOUT_EMAIL' };

export interface PayPalSettings {
  env: 'sandbox';
  clientId: string;
  /** Kept in memory for the sandbox adapter only. Never logged or returned. */
  clientSecret: string;
  merchantEmail: string;
  merchantId: string;
  buyerEmail: string;
  payoutReceiverEmail: string;
  webhookId: string | null;
}

export interface ServerConfig {
  mode: RuntimeMode;
  modeReason: string;
  /**
   * HMS_SANDBOX_FALLBACK=fake: an explicit opt-in to run the simulated PayPal
   * when HMS_MODE=sandbox cannot start (tests and the launcher's settings
   * probe). Without it, a sandbox request with missing settings fails (D-108).
   */
  sandboxFallback: boolean;
  host: string;
  port: number;
  dbPath: string;
  uploadDir: string;
  secretsDir: string;
  demo: boolean;
  demoScript: string;
  /** Demo mode only: start every boot from a fresh market at the script's start (HMS_DEMO_RESET=1, set by `npm run demo`). */
  demoResetOnBoot: boolean;
  seed: number;
  /** Market start in epoch ms; null means real now. */
  marketStart: number | null;
  clockSpeed: number;
  rules: MarketRules;
  sweepSeconds: number;
  /** Seed crowd bids at reset (off in most tests). */
  crowd: boolean;
  /** Codes and ids derived from the seed (demo mode and tests). */
  deterministic: boolean;
  paypal: PayPalSettings | null;
  paypalSync: 'poll' | 'webhook';
  paypalPollSeconds: number;
  paypalTimeoutMs: number;
  funding: CheckoutFunding[];
  fakeFail: string[];
  ai: {
    provider: 'auto' | 'anthropic' | 'muse' | 'openai' | 'fake';
    mode: AiMode;
    timeoutMs: number;
    fixturesDir: string;
  };
  webOrigins: string[];
  adminKey: string | null;
  logLevel: string;
}

type Env = Record<string, string | undefined>;

function num(env: Env, name: string, fallback: number, min?: number, max?: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number.`);
  if ((min !== undefined && n < min) || (max !== undefined && n > max)) throw new Error(`${name} must be between ${min} and ${max}.`);
  return n;
}

function list(env: Env, name: string, fallback: string): string[] {
  return (env[name] ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parses a dotenv file into a map. Values are never printed. */
export function readDotenv(path: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out.set(m[1]!, value);
  }
  return out;
}

function loadPayPal(env: Env, secretsDir: string): { settings: PayPalSettings | null; missing: string[]; source: string } {
  const file = join(secretsDir, 'sandbox.env');
  const fromFile = readDotenv(file);
  const alias = (k: string) => PAYPAL_NAME_ALIASES[k];
  const get = (k: string) => env[k] || fromFile.get(k) || (alias(k) ? env[alias(k)!] || fromFile.get(alias(k)!) : '') || '';
  const missing = SANDBOX_REQUIRED.filter((k) => !get(k));
  const source = existsSync(file) ? 'sandbox.env' : 'process env';
  if (missing.length > 0) return { settings: null, missing, source };
  if (get('PAYPAL_ENV') !== 'sandbox') return { settings: null, missing: ['PAYPAL_ENV=sandbox'], source };
  return {
    settings: {
      env: 'sandbox',
      clientId: get('PAYPAL_CLIENT_ID'),
      clientSecret: get('PAYPAL_CLIENT_SECRET'),
      merchantEmail: get('PAYPAL_MERCHANT_EMAIL'),
      merchantId: get('PAYPAL_MERCHANT_ID'),
      buyerEmail: get('PAYPAL_BUYER_EMAIL'),
      payoutReceiverEmail: get('PAYPAL_PAYOUT_EMAIL'),
      webhookId: get('PAYPAL_WEBHOOK_ID') || null,
    },
    missing: [],
    source,
  };
}

/**
 * HMS_MODE=sandbox was asked for, but the PayPal sandbox settings are not all
 * there. The server refuses to start rather than quietly simulating PayPal
 * (D-108). Names only: never a value.
 */
export class SandboxConfigError extends Error {
  readonly missing: string[];
  readonly source: string;

  constructor(missing: string[], source: string) {
    const where =
      source === 'sandbox.env'
        ? 'sandbox.env in the secrets folder (HMS_SECRETS_DIR) is missing'
        : 'there is no sandbox.env in the secrets folder (HMS_SECRETS_DIR), and the environment is missing';
    super(
      `HMS_MODE=sandbox needs the PayPal sandbox settings, but ${where} ${missing.join(', ')}. ` +
        'Nothing was started. Run npm run keys (or npm run keys -- --from-env), or leave HMS_MODE unset for the simulated PayPal. ' +
        'Tests that want the simulated PayPal instead set HMS_SANDBOX_FALLBACK=fake.',
    );
    this.name = 'SandboxConfigError';
    this.missing = missing;
    this.source = source;
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export const isLoopback = (host: string) => LOOPBACK.has(host);

export function loadConfig(env: Env = process.env, overrides: Partial<ServerConfig> = {}): ServerConfig {
  const requested = (env.HMS_MODE ?? 'fake') as RuntimeMode;
  if (requested !== 'fake' && requested !== 'sandbox') throw new Error('HMS_MODE must be fake or sandbox.');
  // Keys live in HMS_SECRETS_DIR, else the repo's .secrets/ (npm run keys); no folder outside the repo is read by default (D-131).
  const secretsDir = expandSecretsDir(env.HMS_SECRETS_DIR) ?? DEFAULT_SECRETS_DIR;

  let mode: RuntimeMode = 'fake';
  let modeReason = 'HMS_MODE=fake: simulated PayPal, no network.';
  let paypal: PayPalSettings | null = null;
  const sandboxFallback = env.HMS_SANDBOX_FALLBACK === 'fake';
  if (requested === 'sandbox') {
    const loaded = loadPayPal(env, secretsDir);
    if (loaded.settings) {
      mode = 'sandbox';
      paypal = loaded.settings;
      modeReason = `HMS_MODE=sandbox: PayPal sandbox credentials found (${loaded.source}).`;
    } else if (sandboxFallback) {
      modeReason = `HMS_MODE=sandbox but ${loaded.source} is missing ${loaded.missing.join(', ')}: running fake.`;
    } else {
      throw new SandboxConfigError(loaded.missing, loaded.source);
    }
  }

  const demo = env.HMS_DEMO === '1';
  const startRaw = env.HMS_MARKET_START;
  const marketStart = startRaw ? Date.parse(startRaw) : null;
  if (marketStart !== null && !Number.isFinite(marketStart)) throw new Error('HMS_MARKET_START must be an ISO 8601 time.');

  const aiProvider = (env.HMS_AI_PROVIDER ?? 'auto') as ServerConfig['ai']['provider'];
  const aiMode = (env.HMS_AI_MODE ?? (mode === 'fake' ? 'replay' : 'live')) as AiMode;

  const rules: MarketRules = {
    ...DEFAULT_RULES,
    platformFeeBps: num(env, 'HMS_PLATFORM_FEE_BPS', DEFAULT_RULES.platformFeeBps, 0, 5000),
    fxTwdPerUsd: num(env, 'HMS_FX_TWD_PER_USD', DEFAULT_RULES.fxTwdPerUsd, 1, 1000),
  };

  const config: ServerConfig = {
    mode,
    modeReason,
    sandboxFallback,
    host: env.HMS_HOST ?? '127.0.0.1',
    port: num(env, 'HMS_PORT', 8796, 0, 65535),
    dbPath: env.HMS_DB_PATH ?? join(SERVER_ROOT, 'data', 'holdmyspot.sqlite'),
    uploadDir: env.HMS_UPLOAD_DIR ?? join(SERVER_ROOT, 'data', 'uploads'),
    secretsDir,
    demo,
    demoScript: env.HMS_DEMO_SCRIPT ?? 'hero',
    demoResetOnBoot: demo && env.HMS_DEMO_RESET === '1',
    seed: num(env, 'HMS_SEED', DEMO_SEED),
    marketStart,
    clockSpeed: num(env, 'HMS_CLOCK_SPEED', 1, 1, 600),
    rules,
    sweepSeconds: num(env, 'HMS_SWEEP_SECONDS', 15, 1, 3600),
    crowd: env.HMS_CROWD !== '0',
    deterministic: demo || env.HMS_DETERMINISTIC === '1',
    paypal,
    paypalSync: env.HMS_PAYPAL_SYNC === 'webhook' ? 'webhook' : 'poll',
    paypalPollSeconds: num(env, 'HMS_PAYPAL_POLL_SECONDS', 20, 5, 3600),
    paypalTimeoutMs: num(env, 'HMS_PAYPAL_TIMEOUT_MS', 10_000, 1000, 120_000),
    funding: list(env, 'HMS_PAYPAL_FUNDING', 'paypal,venmo').filter((f): f is CheckoutFunding => f === 'paypal' || f === 'venmo' || f === 'paylater'),
    fakeFail: list(env, 'HMS_FAKE_FAIL', ''),
    ai: {
      provider: aiProvider,
      mode: aiMode,
      timeoutMs: num(env, 'HMS_AI_TIMEOUT_MS', 60_000, 1000, 600_000),
      fixturesDir: env.HMS_AI_FIXTURES_DIR ?? join(SERVER_ROOT, 'fixtures', 'ai'),
    },
    webOrigins: list(env, 'HMS_WEB_ORIGINS', 'http://127.0.0.1:5190,http://localhost:5190,http://127.0.0.1:5197,http://localhost:5197'),
    adminKey: env.HMS_ADMIN_KEY || null,
    logLevel: env.HMS_LOG_LEVEL ?? 'info',
    ...overrides,
  };
  if (!isLoopback(config.host) && !config.adminKey) {
    throw new Error(`HMS_HOST=${config.host} is not a loopback address: set HMS_ADMIN_KEY first.`);
  }
  return config;
}

/** One boot line: names and presence only, never secret values. */
export function describeConfig(c: ServerConfig): string {
  const pp = c.paypal ? `client id present, secret present, payouts to ${c.paypal.payoutReceiverEmail ? 'the sandbox receiver account' : 'nobody'}` : 'no credentials loaded';
  return `mode=${c.mode} (${c.modeReason}) paypal: ${pp}; demo=${c.demo ? c.demoScript : 'off'}; db=${c.dbPath === ':memory:' ? 'memory' : 'file'}`;
}
