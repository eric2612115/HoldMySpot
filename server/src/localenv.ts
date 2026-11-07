import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVER_ROOT } from './config.ts';

/**
 * Machine-local server settings: `server/.env.local` (git-ignored), read at
 * boot by `npm run dev`, `npm start`, `npm run demo` and `npm run ai:eval`.
 * Only HMS_* names are taken, and a value already in the process
 * environment wins. Secrets never go in this file: it names where keys are
 * (HMS_AI_KEY_FILES), never the keys themselves. Tests do not load it.
 */
export function loadLocalEnv(file = join(SERVER_ROOT, '.env.local'), env: Record<string, string | undefined> = process.env): string[] {
  if (!existsSync(file)) return [];
  const taken: string[] = [];
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?(HMS_[A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1]!;
    let value = (m[2] ?? '').trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    if (env[name] !== undefined) continue;
    env[name] = value;
    taken.push(name);
  }
  return taken;
}
