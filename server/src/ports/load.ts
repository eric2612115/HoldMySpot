import type { ServerConfig } from '../config.ts';
import { FakeAi } from '../fakes/ai.ts';
import type { AiPort, AiPortFactory } from './ai.ts';
import type { PaymentsPort, SandboxPayPalFactory } from './payments.ts';

/**
 * Loads the real adapters built in server/src/paypal and server/src/ai when
 * they exist, and falls back to the in-process fakes otherwise. Module paths
 * are computed so this file compiles before those folders exist.
 */

async function importOptional(relative: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(new URL(relative, import.meta.url).href)) as Record<string, unknown>;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}

export async function loadSandboxPayPal(config: ServerConfig, log: (line: string) => void): Promise<{ port: PaymentsPort | null; reason: string }> {
  if (config.mode !== 'sandbox' || !config.paypal) return { port: null, reason: 'fake mode' };
  try {
    const mod = await importOptional('../paypal/sandbox.ts');
    const factory = (mod?.createSandboxPayPal ?? mod?.default) as SandboxPayPalFactory | undefined;
    if (typeof factory !== 'function') return { port: null, reason: 'server/src/paypal/sandbox.ts with createSandboxPayPal() is not available' };
    const port = factory({ settings: config.paypal, baseUrl: 'https://api-m.sandbox.paypal.com', timeoutMs: config.paypalTimeoutMs, log });
    return { port, reason: 'sandbox adapter loaded' };
  } catch (err) {
    return { port: null, reason: `the sandbox adapter failed to load (${err instanceof Error ? err.message : 'error'})` };
  }
}

export async function loadAi(config: ServerConfig, log: (line: string) => void): Promise<{ port: AiPort; reason: string }> {
  if (config.ai.provider === 'fake') return { port: new FakeAi(), reason: 'HMS_AI_PROVIDER=fake' };
  try {
    const mod = await importOptional('../ai/index.ts');
    const factory = mod?.createAiPort as AiPortFactory | undefined;
    if (typeof factory !== 'function') return { port: new FakeAi(), reason: 'server/src/ai/index.ts with createAiPort() is not available; using rules-only fake AI' };
    return { port: await factory({ config, log }), reason: 'AI services loaded' };
  } catch (err) {
    return { port: new FakeAi(), reason: `the AI services failed to load (${err instanceof Error ? err.message : 'error'}); using rules-only fake AI` };
  }
}
