import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SandboxSettings } from './types.ts';

/**
 * Reads sandbox credentials from sandbox.env in the secrets folder
 * (HMS_SECRETS_DIR, else the repo's .secrets/) for standalone tools such as the probe script. The
 * server itself loads them in server/src/config.ts. Only the file is read,
 * never the process environment, and values are never printed: results name
 * missing variables only, and the secret is a non-enumerable property, so it
 * does not show up in JSON or console output.
 */

export const SANDBOX_ENV_FILE = 'sandbox.env';
export const REQUIRED_KEYS = ['PAYPAL_ENV', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'] as const;
export const RECOMMENDED_KEYS = ['PAYPAL_MERCHANT_EMAIL', 'PAYPAL_MERCHANT_ID', 'PAYPAL_BUYER_EMAIL', 'PAYPAL_PAYOUT_EMAIL'] as const;

/** HMS_SECRETS_DIR (a leading ~ expanded), else the repo's .secrets/ written by npm run keys (D-131). */
export function secretsDir(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.HMS_SECRETS_DIR?.trim();
  if (fromEnv) return fromEnv.startsWith('~/') ? join(homedir(), fromEnv.slice(2)) : fromEnv;
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.secrets');
}

/** Parses dotenv text (KEY=value, optional `export`, quotes, comments, CRLF). */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m?.[1]) continue;
    let value = m[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    out.set(m[1], value);
  }
  return out;
}

export type SandboxEnvLoad =
  | { ok: true; file: string; settings: SandboxSettings; missingRecommended: string[]; warnings: string[] }
  | { ok: false; file: string; missing: string[]; reason: string; warnings: string[] };

export function loadSandboxEnvFile(opts: { dir?: string; fileName?: string } = {}): SandboxEnvLoad {
  const file = join(opts.dir ?? secretsDir(), opts.fileName ?? SANDBOX_ENV_FILE);
  const warnings: string[] = [];
  if (!existsSync(file)) return { ok: false, file, missing: [...REQUIRED_KEYS], reason: `${file} not found`, warnings };
  try {
    if ((statSync(file).mode & 0o077) !== 0) warnings.push(`${file} can be read by other users; run chmod 600 on it.`);
  } catch {
    // The mode check is advice only.
  }
  let values: Map<string, string>;
  try {
    values = parseDotenv(readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, file, missing: [...REQUIRED_KEYS], reason: `${file} cannot be read`, warnings };
  }
  // PAYPAL_TW_PAYOUT_EMAIL is the payout receiver's older name, still read (D-132).
  const get = (k: string) => values.get(k)?.trim() || (k === 'PAYPAL_PAYOUT_EMAIL' ? (values.get('PAYPAL_TW_PAYOUT_EMAIL')?.trim() ?? '') : '');
  const missing = REQUIRED_KEYS.filter((k) => get(k) === '');
  if (missing.length > 0) return { ok: false, file, missing, reason: `${file} is missing ${missing.join(', ')}`, warnings };
  if (get('PAYPAL_ENV') !== 'sandbox') return { ok: false, file, missing: [], reason: 'PAYPAL_ENV is not "sandbox"; HoldMySpot only uses the PayPal sandbox', warnings };
  const settings = {
    env: 'sandbox',
    clientId: get('PAYPAL_CLIENT_ID'),
    merchantEmail: get('PAYPAL_MERCHANT_EMAIL'),
    merchantId: get('PAYPAL_MERCHANT_ID'),
    buyerEmail: get('PAYPAL_BUYER_EMAIL'),
    payoutReceiverEmail: get('PAYPAL_PAYOUT_EMAIL'),
    webhookId: get('PAYPAL_WEBHOOK_ID') || null,
  } as SandboxSettings;
  Object.defineProperty(settings, 'clientSecret', { value: get('PAYPAL_CLIENT_SECRET'), enumerable: false, writable: false });
  const missingRecommended = RECOMMENDED_KEYS.filter((k) => get(k) === '');
  return { ok: true, file, settings, missingRecommended, warnings };
}

/** "BAA_hc...hkE4": enough to recognise a client id on screen. Client ids are public, but long. */
export function maskId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 6)}...${id.slice(-4)}`;
}
