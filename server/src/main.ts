import { describeConfig, loadConfig } from './config.ts';
import type { ServerConfig } from './config.ts';
import { loadLocalEnv } from './localenv.ts';
import { createServer } from './server.ts';

/** Boot: machine-local settings, config and mode, key report (names and presence only), listen. */

const local = loadLocalEnv();
/** A settings problem (for example HMS_MODE=sandbox without credentials) stops the boot with one clear line (D-108). */
function refuse(err: unknown): never {
  console.error(`[holdmyspot] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
let config: ServerConfig;
try {
  config = loadConfig();
} catch (err) {
  refuse(err);
}
const server = await createServer(config, { logger: true }).catch(refuse);
const log = (line: string) => console.log(`[holdmyspot] ${line}`);
if (local.length > 0) log(`server/.env.local set ${local.join(', ')}`);
log(describeConfig(server.app.config));
for (const line of server.report) log(line);
await server.fastify.listen({ host: config.host, port: config.port });
log(`listening on http://${config.host}:${config.port} (market clock speed ${server.app.clock.speed}${server.director ? ', demo mode' : ''})`);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log(`${signal}: closing`);
  await server.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
