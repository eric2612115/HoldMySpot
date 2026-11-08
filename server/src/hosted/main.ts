import { createServer as createHttp } from 'node:http';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalEnv } from '../localenv.ts';
import { MarketPool } from './pool.ts';
import { createRouter } from './router.ts';
import { hostedSettings } from './settings.ts';

/** The hosted judge server: `npm run hosted` locally, the start command on Render (docs/HOSTING.md). */

const log = (line: string) => console.log(`[hosted] ${line}`);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

loadLocalEnv();
const settings = hostedSettings();
const pool = new MarketPool({ settings, log });
for (const line of await pool.init()) log(line);
pool.startSweeping();

const server = createHttp(createRouter(pool, { webDist: join(REPO, 'web', 'dist'), opsDist: join(REPO, 'ops', 'dist'), log }));
server.listen(settings.port, settings.host, () => {
  log(`listening on http://${settings.host}:${settings.port} (market cap ${settings.cap}, idle ${settings.idleMs / 60_000} min)`);
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log(`${signal}: closing`);
  server.close();
  await pool.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
