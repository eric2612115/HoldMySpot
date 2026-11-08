import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * Operator console. Ports follow docs/ARCHITECTURE.md section 11:
 * dev 5197, preview 5198 (5190 and 5191 belong to the web app).
 * /api goes to the HoldMySpot server on 127.0.0.1:8796; when it is not
 * running the console uses its in-browser mock (src/data/backend.ts).
 *
 * AG licences (D-82): two optional keys, read here at dev-server or build time.
 * - AG Studio key: VITE_AG_STUDIO_LICENSE_KEY, else the file named by
 *   HMS_AG_STUDIO_LICENSE_FILE, else agstudio-license.txt in the secrets folder
 *   (HMS_SECRETS_DIR, else the repo's .secrets/ written by npm run keys; D-131).
 *   It is the only key the console needs (D-83).
 * - AG Grid and AG Charts Enterprise key: VITE_AG_LICENSE_KEY, else the file named
 *   by HMS_AG_LICENSE_FILE, else aggrid-license.txt in the same folder.
 * - HMS_AG_TRIAL=1 (the launcher's --no-ag-licence) ignores every key: AG's trial mode.
 * The VITE_* values go in the git-ignored ops/.env.local or the shell. A key put
 * in the other slot still reaches the product it is for (its [03A], [03B] or
 * [03C] tag marks an AG Studio key). Without keys the console runs in AG's trial
 * mode. Keys are never printed (the log names only the source) and never written
 * into the repo; a build carries them in the git-ignored dist/ like any browser
 * licence key.
 */
const root = fileURLToPath(new URL('.', import.meta.url));
const shared = fileURLToPath(new URL('../shared', import.meta.url));

interface AgKey {
  key: string;
  /** Where the key came from, for the log: a variable name, never the value. */
  source: string;
}

/** The secrets folder, as the server reads it: HMS_SECRETS_DIR, else the repo's .secrets/ (D-131). */
function secretsDir(env: Record<string, string>): { dir: string; label: string } {
  const raw = (env.HMS_SECRETS_DIR || '').trim();
  if (!raw) return { dir: join(root, '..', '.secrets'), label: '.secrets/' };
  const dir = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : isAbsolute(raw) ? raw : resolve(raw);
  return { dir, label: 'HMS_SECRETS_DIR' };
}

/** One AG key: the inline variable, else the key file. Missing or empty gives undefined. */
function readAgKey(env: Record<string, string>, inline: string, fileVar: string, defaultFile: string): AgKey | undefined {
  const value = (env[inline] || '').trim();
  if (value) return { key: value, source: inline };
  const folder = secretsDir(env);
  const file = env[fileVar] || join(folder.dir, defaultFile);
  const source = env[fileVar] ? fileVar : `${defaultFile} in ${folder.label}`;
  try {
    const key = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
    return key ? { key, source } : undefined;
  } catch {
    console.warn(`[ops] ${source} could not be read; ignored.`);
    return undefined;
  }
}

/** AG Studio keys carry [03A] (Core), [03B] (Pro) or [03C] (Pro with AI); AG Grid and AG Charts keys [01], [02] or [0102]. */
const isStudioKey = (key: string) => /\[03[ABC]\]/.test(key);

/** The AG Studio key and the AG Grid and AG Charts key, each from its own slot first. */
function agLicenses(env: Record<string, string>): { studio?: AgKey; grid?: AgKey } {
  if (env.HMS_AG_TRIAL === '1') return {};
  const studioSlot = readAgKey(env, 'VITE_AG_STUDIO_LICENSE_KEY', 'HMS_AG_STUDIO_LICENSE_FILE', 'agstudio-license.txt');
  const gridSlot = readAgKey(env, 'VITE_AG_LICENSE_KEY', 'HMS_AG_LICENSE_FILE', 'aggrid-license.txt');
  return {
    studio: [studioSlot, gridSlot].find((k) => k && isStudioKey(k.key)),
    grid: [gridSlot, studioSlot].find((k) => k && !isStudioKey(k.key)),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '');
  const target = env.HMS_API_PROXY || 'http://127.0.0.1:8796';
  const proxy = { '/api': { target, changeOrigin: false } };
  const port = Number(env.OPS_PORT || 5197);
  // Extra host names the dev server answers (for example a test name mapped to 127.0.0.1 to see licence watermarks).
  const allowedHosts = env.OPS_ALLOWED_HOSTS ? env.OPS_ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean) : undefined;
  const licenses = agLicenses(env);
  // OPS_HMR=off: no hot updates, so an open page (a screenshot run) is never reloaded by an edit; a new page load gets the new code.
  const still = env.OPS_HMR === 'off';
  console.log(
    `[ops] AG Studio licence: ${licenses.studio ? `from ${licenses.studio.source} (value not shown)` : `none, trial mode${env.HMS_AG_TRIAL === '1' ? ' (HMS_AG_TRIAL=1)' : ''} (a watermark on hosts other than localhost)`}`,
  );
  console.log(
    `[ops] AG Grid and AG Charts licence: ${licenses.grid ? `from ${licenses.grid.source} (value not shown)` : 'none (not needed: every grid and chart here is drawn by AG Studio)'}`,
  );
  return {
    // The hosted judge server (D-163) serves the console under /ops/.
    base: env.HMS_OPS_BASE || '/',
    plugins: [react()],
    define: {
      __HMS_AG_STUDIO_LICENSE__: JSON.stringify(licenses.studio?.key ?? ''),
      __HMS_AG_LICENSE__: JSON.stringify(licenses.grid?.key ?? ''),
    },
    server: { host: '127.0.0.1', port, strictPort: true, proxy, fs: { allow: [root, shared] }, ...(allowedHosts ? { allowedHosts } : {}), ...(still ? { hmr: false } : {}) },
    preview: { host: '127.0.0.1', port: port + 1, strictPort: true, proxy, ...(allowedHosts ? { allowedHosts } : {}) },
    build: { chunkSizeWarningLimit: 8000 },
  };
});
