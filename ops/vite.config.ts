import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * Operator console. Ports follow docs/ARCHITECTURE.md section 11:
 * dev 5197, preview 5198 (5190 and 5191 belong to the web app).
 * /api goes to the HoldMySpot server on 127.0.0.1:8796; when it is not
 * running the console uses its in-browser mock (src/data/backend.ts).
 *
 * AG licence (AG Grid and AG Charts Enterprise, also given to AG Studio): the
 * key is read here, at dev-server or build time, from VITE_AG_LICENSE_KEY in
 * the git-ignored ops/.env.local, else from the owner's key file
 * (HMS_AG_LICENSE_FILE, default ~/.config/paypal-hackathon/aggrid-license.txt).
 * It is never printed and never written into the repo; a build carries it in
 * the git-ignored dist/ like any browser licence key.
 */
const root = fileURLToPath(new URL('.', import.meta.url));
const shared = fileURLToPath(new URL('../shared', import.meta.url));

function agLicenseKey(env: Record<string, string>): { key: string; source: string } {
  const inline = (env.VITE_AG_LICENSE_KEY || env.VITE_AG_STUDIO_LICENSE_KEY || '').trim();
  if (inline) return { key: inline, source: 'ops/.env.local' };
  const file = env.HMS_AG_LICENSE_FILE || join(homedir(), '.config', 'paypal-hackathon', 'aggrid-license.txt');
  if (!existsSync(file)) return { key: '', source: 'none' };
  return { key: readFileSync(file, 'utf8').trim(), source: 'key file' };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '');
  const target = env.HMS_API_PROXY || 'http://127.0.0.1:8796';
  const proxy = { '/api': { target, changeOrigin: false } };
  const port = Number(env.OPS_PORT || 5197);
  // Extra host names the dev server answers (for example a test name mapped to 127.0.0.1 to see licence watermarks).
  const allowedHosts = env.OPS_ALLOWED_HOSTS ? env.OPS_ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean) : undefined;
  const license = agLicenseKey(env);
  console.log(`[ops] AG licence: ${license.key ? `loaded from the ${license.source} (value not shown)` : 'none, trial mode'}`);
  return {
    plugins: [react()],
    define: { __HMS_AG_LICENSE__: JSON.stringify(license.key) },
    server: { host: '127.0.0.1', port, strictPort: true, proxy, fs: { allow: [root, shared] }, ...(allowedHosts ? { allowedHosts } : {}) },
    preview: { host: '127.0.0.1', port: port + 1, strictPort: true, proxy, ...(allowedHosts ? { allowedHosts } : {}) },
    build: { chunkSizeWarningLimit: 8000 },
  };
});
