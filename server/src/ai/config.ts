import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { AI_MODES } from '@holdmyspot/shared';
import type { AiMode, AiProviderId, RuntimeMode } from '@holdmyspot/shared';
import type { AiKeyReport } from '@holdmyspot/shared/ports';

/**
 * AI keys and provider selection (docs/AI-SERVICES.md section 2, D-27).
 *
 * Keys are read only under two names (ANTHROPIC_API_KEY, MODEL_API_KEY) and
 * only from: the process environment, `<HMS_SECRETS_DIR>/ai.env`, and the
 * dotenv files listed in HMS_AI_KEY_FILES (every other line of those files
 * is ignored). An entry of HMS_AI_KEY_FILES may narrow what is read from
 * that file to some of the two names, as `path#MODEL_API_KEY` (several names
 * joined with `+`): this machine reads only MODEL_API_KEY from the owner's
 * Meta project file this way. Values live in `SecretValue`, which prints,
 * serialises and inspects as "[redacted]"; reports carry names and presence
 * only.
 */

export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return '[redacted]';
  }

  toJSON(): string {
    return '[redacted]';
  }

  [inspect.custom](): string {
    return 'SecretValue([redacted])';
  }
}

export const AI_KEY_NAMES = ['ANTHROPIC_API_KEY', 'MODEL_API_KEY'] as const;
type KeyName = (typeof AI_KEY_NAMES)[number];

/** The server package root (server/), from this file's location. */
export const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
export const DEFAULT_MUSE_MODEL = 'muse-spark-1.3';
export const DEFAULT_MUSE_URL = 'https://api.meta.ai/v1/chat/completions';

/** Reads only the named keys from a dotenv file; every other line is skipped unread. */
export function readDotenvKeys(file: string, names: readonly string[]): Map<string, SecretValue> {
  const out = new Map<string, SecretValue>();
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !names.includes(m[1] ?? '')) continue;
    let value = (m[2] ?? '').trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    if (value) out.set(m[1] ?? '', new SecretValue(value));
  }
  return out;
}

/**
 * HMS_AI_KEY_FILES entries: comma-separated dotenv paths, each optionally
 * narrowed to some key names with `#NAME[+NAME]`. Unknown names are dropped,
 * so an entry can never widen what is read.
 */
export function keyFileEntries(raw: string | undefined): { file: string; names: readonly string[] }[] {
  const out: { file: string; names: readonly string[] }[] = [];
  for (const part of (raw ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const hash = part.lastIndexOf('#');
    if (hash <= 0) {
      out.push({ file: part, names: AI_KEY_NAMES });
      continue;
    }
    const wanted = part.slice(hash + 1).split('+').map((x) => x.trim());
    const names = AI_KEY_NAMES.filter((n) => wanted.includes(n));
    if (names.length > 0) out.push({ file: part.slice(0, hash), names });
  }
  return out;
}

export interface AiSettings {
  runtimeMode: RuntimeMode;
  requestedProvider: 'auto' | AiProviderId;
  /** Provider for live and record calls; `fake` when no key is available. */
  provider: AiProviderId;
  /** Model of that provider, or `rules-v1`. */
  model: string;
  mode: AiMode;
  anthropicModel: string;
  museModel: string;
  museUrl: string;
  timeoutMs: number;
  agentTimeoutMs: number;
  /** Replay fixtures: server/fixtures/ai. */
  fixturesDir: string;
  /** Demo photos with truth sidecars: server/fixtures/proofs. */
  proofFixturesDir: string;
  /** Why this provider and mode, in one plain sentence (names only). */
  reason: string;
}

export interface AiKeys {
  anthropic: SecretValue | null;
  muse: SecretValue | null;
}

export interface ResolvedAi {
  settings: AiSettings;
  keys: AiKeys;
  report: AiKeyReport;
  /** Where each key came from: "process env" or a file name. Never the value. */
  sources: { anthropic: string | null; muse: string | null };
}

export interface ResolveOptions {
  env?: Record<string, string | undefined>;
  runtimeMode?: RuntimeMode;
  secretsDir?: string;
  /** Values the server already parsed (ServerConfig.ai); they win over the env. */
  aiProvider?: 'auto' | AiProviderId;
  aiMode?: AiMode;
  timeoutMs?: number;
  fixturesDir?: string;
  proofFixturesDir?: string;
}

const PROVIDERS = ['auto', 'anthropic', 'muse', 'fake'] as const;

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function resolveAiSettings(opts: ResolveOptions = {}): ResolvedAi {
  const env = opts.env ?? process.env;
  const runtimeMode: RuntimeMode = opts.runtimeMode ?? (env.HMS_MODE === 'sandbox' ? 'sandbox' : 'fake');
  const secretsDir = opts.secretsDir ?? env.HMS_SECRETS_DIR ?? join(homedir(), '.config', 'paypal-hackathon');

  const searched = ['process env'];
  const found: Record<KeyName, { value: SecretValue; source: string } | null> = { ANTHROPIC_API_KEY: null, MODEL_API_KEY: null };
  for (const name of AI_KEY_NAMES) {
    const v = env[name]?.trim();
    if (v) found[name] = { value: new SecretValue(v), source: 'process env' };
  }
  const files = [{ file: join(secretsDir, 'ai.env'), names: AI_KEY_NAMES as readonly string[] }, ...keyFileEntries(env.HMS_AI_KEY_FILES)];
  for (const { file, names } of files) {
    searched.push(names.length === AI_KEY_NAMES.length ? file : `${file} (${names.join(', ')} only)`);
    if (!existsSync(file)) continue;
    const keys = readDotenvKeys(file, names);
    for (const name of AI_KEY_NAMES) {
      const v = keys.get(name);
      if (v && !found[name]) found[name] = { value: v, source: basename(file) };
    }
  }

  const rawProvider = opts.aiProvider ?? (env.HMS_AI_PROVIDER?.trim() || 'auto');
  const requestedProvider = (PROVIDERS as readonly string[]).includes(rawProvider) ? (rawProvider as ResolvedAi['settings']['requestedProvider']) : 'auto';
  const hasAnthropic = found.ANTHROPIC_API_KEY !== null;
  const hasMuse = found.MODEL_API_KEY !== null;

  let provider: AiProviderId = 'fake';
  let reason: string;
  if (requestedProvider === 'fake') {
    reason = 'HMS_AI_PROVIDER=fake: rules only';
  } else if (requestedProvider === 'anthropic') {
    provider = hasAnthropic ? 'anthropic' : 'fake';
    reason = hasAnthropic ? 'HMS_AI_PROVIDER=anthropic' : 'HMS_AI_PROVIDER=anthropic but ANTHROPIC_API_KEY was not found';
  } else if (requestedProvider === 'muse') {
    provider = hasMuse ? 'muse' : 'fake';
    reason = hasMuse ? 'HMS_AI_PROVIDER=muse' : 'HMS_AI_PROVIDER=muse but MODEL_API_KEY was not found';
  } else {
    provider = hasAnthropic ? 'anthropic' : hasMuse ? 'muse' : 'fake';
    reason = hasAnthropic ? 'auto: Anthropic key found' : hasMuse ? 'auto: no Anthropic key, Muse key found' : 'auto: no AI key found';
  }

  const rawMode = opts.aiMode ?? env.HMS_AI_MODE?.trim();
  let mode: AiMode = rawMode && (AI_MODES as readonly string[]).includes(rawMode) ? (rawMode as AiMode) : runtimeMode === 'sandbox' ? 'live' : 'replay';
  if (requestedProvider === 'fake') mode = 'fake';
  else if (provider === 'fake' && (mode === 'live' || mode === 'record')) {
    mode = 'replay';
    reason += '; replaying saved answers, rules only for anything else';
  }

  const anthropicModel = env.HMS_ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL;
  const museModel = env.HMS_MUSE_MODEL?.trim() || DEFAULT_MUSE_MODEL;
  const settings: AiSettings = {
    runtimeMode,
    requestedProvider,
    provider,
    model: provider === 'anthropic' ? anthropicModel : provider === 'muse' ? museModel : 'rules-v1',
    mode,
    anthropicModel,
    museModel,
    museUrl: env.HMS_MUSE_URL?.trim() || DEFAULT_MUSE_URL,
    timeoutMs: opts.timeoutMs ?? positiveInt(env.HMS_AI_TIMEOUT_MS, 60_000),
    agentTimeoutMs: positiveInt(env.HMS_AI_AGENT_TIMEOUT_MS, 30_000),
    fixturesDir: resolve(opts.fixturesDir ?? (env.HMS_AI_FIXTURES_DIR?.trim() || join(SERVER_ROOT, 'fixtures', 'ai'))),
    proofFixturesDir: resolve(opts.proofFixturesDir ?? (env.HMS_AI_PROOF_FIXTURES_DIR?.trim() || join(SERVER_ROOT, 'fixtures', 'proofs'))),
    reason,
  };
  return {
    settings,
    keys: { anthropic: found.ANTHROPIC_API_KEY?.value ?? null, muse: found.MODEL_API_KEY?.value ?? null },
    report: { anthropicKeyPresent: hasAnthropic, museKeyPresent: hasMuse, searched, chosen: provider, reason },
    sources: { anthropic: found.ANTHROPIC_API_KEY?.source ?? null, muse: found.MODEL_API_KEY?.source ?? null },
  };
}

/** The one boot log line: names and presence only, never values. */
export function aiBootLine(r: ResolvedAi): string {
  const k = (present: boolean, source: string | null) => (present ? `present (${source})` : 'absent');
  const using =
    r.settings.mode === 'replay' && r.settings.provider === 'fake'
      ? 'using replay of saved answers, rules only otherwise'
      : r.settings.mode === 'fake'
        ? 'using rules only (fake)'
        : `using ${r.settings.provider} ${r.settings.model}, mode ${r.settings.mode}`;
  return `AI: anthropic key ${k(r.report.anthropicKeyPresent, r.sources.anthropic)}, muse key ${k(r.report.museKeyPresent, r.sources.muse)}; ${using}`;
}
