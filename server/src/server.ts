import type { FastifyInstance } from 'fastify';
import { App } from './app/app.ts';
import { recoverPending } from './app/money.ts';
import { startWorkers } from './app/scheduler.ts';
import { resetMarket } from './app/seed.ts';
import type { MarketClock } from './clock.ts';
import type { ServerConfig } from './config.ts';
import { Director } from './demo/director.ts';
import { heroScript } from './demo/scripts/hero.ts';
import { localErrandScript, renewalScript } from './demo/scripts/others.ts';
import { buildHttp } from './http/server.ts';
import type { AiPort } from './ports/ai.ts';
import { loadAi, loadSandboxPayPal } from './ports/load.ts';
import type { PaymentsPort } from './ports/payments.ts';

/** Composition root: config, ports, kernel, director, HTTP, workers. */

export interface CreateOptions {
  logger?: boolean;
  /** Start the timers (off in tests, which drive the clock by hand). */
  workers?: boolean;
  clock?: MarketClock;
  ai?: AiPort;
  sandboxPayPal?: PaymentsPort | null;
  log?: (line: string) => void;
}

export interface HmsServer {
  app: App;
  fastify: FastifyInstance;
  director: Director | null;
  /** What the boot found, names and presence only. */
  report: string[];
  close(): Promise<void>;
}

export const DEMO_SCRIPTS = [heroScript, localErrandScript, renewalScript];

export async function createServer(config: ServerConfig, opts: CreateOptions = {}): Promise<HmsServer> {
  const log = opts.log ?? ((line: string) => console.log(`[holdmyspot] ${line}`));
  const report: string[] = [];

  let sandbox: PaymentsPort | null = opts.sandboxPayPal ?? null;
  if (sandbox === null && config.mode === 'sandbox') {
    const loaded = await loadSandboxPayPal(config, log);
    sandbox = loaded.port;
    if (!sandbox) {
      config = { ...config, mode: 'fake', modeReason: `${config.modeReason.replace(/\.$/, '')}, but ${loaded.reason}: running fake.` };
    }
  }
  report.push(`PayPal: ${config.mode === 'sandbox' ? 'sandbox adapter' : 'simulated (the sandbox REST client answered by the in-process emulator)'}. ${config.modeReason}`);

  let ai = opts.ai ?? null;
  if (!ai) {
    const loaded = await loadAi(config, log);
    ai = loaded.port;
    report.push(`AI: ${ai.info.provider} ${ai.info.model}, mode ${ai.info.mode} (${loaded.reason}).`);
  } else {
    report.push(`AI: ${ai.info.provider} ${ai.info.model}, mode ${ai.info.mode}.`);
  }

  const app = new App({ config, clock: opts.clock, ai, sandboxPayPal: sandbox, log });
  const director = config.demo ? new Director(app, DEMO_SCRIPTS) : null;
  app.director = director;

  if (app.store.users.count() === 0 || (director && config.demoResetOnBoot)) {
    if (director) await app.exec(() => director.reset(config.demoScript, null));
    else {
      await app.exec(() =>
        resetMarket(app, {
          seed: config.seed,
          marketStart: config.marketStart ?? Date.now(),
          speed: config.clockSpeed,
          paused: app.clock.paused,
          crowd: config.crowd,
        }),
      );
    }
    report.push(`Seeded a new market (${app.store.bids.count()} resting requests).`);
  }
  const recovered = await app.exec(() => recoverPending(app));
  if (recovered > 0) report.push(`Retried ${recovered} pending money call(s) with their original idempotency keys.`);

  const { fastify } = buildHttp(app, { logger: opts.logger ?? false, director });
  const stopWorkers = opts.workers === false ? () => undefined : startWorkers(app);
  return {
    app,
    fastify,
    director,
    report,
    async close() {
      stopWorkers();
      await fastify.close();
      await app.idle().catch(() => undefined);
      app.close();
    },
  };
}
