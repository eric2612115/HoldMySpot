import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * The player map app. Dev 5190, preview 5191 (docs/ARCHITECTURE.md section 11).
 * /api goes to the HoldMySpot server on 127.0.0.1:8796 (fake PayPal mode by
 * default); when it does not answer, the app runs its in-browser mock.
 */
const root = fileURLToPath(new URL('.', import.meta.url));
const shared = fileURLToPath(new URL('../shared', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '');
  const proxy = { '/api': { target: env.HMS_API_PROXY || 'http://127.0.0.1:8796', changeOrigin: false } };
  return {
    plugins: [react()],
    server: { host: '127.0.0.1', port: 5190, strictPort: true, proxy, fs: { allow: [root, shared] } },
    preview: { host: '127.0.0.1', port: 5191, strictPort: true, proxy },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
  };
});
