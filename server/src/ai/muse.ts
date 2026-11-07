import type { SecretValue } from './config.ts';
import { OpenAiCompatibleProvider } from './openai.ts';

/**
 * Muse Spark over Meta's Chat Completions endpoint, with JSON-schema output.
 * It is a preset of the OpenAI-compatible provider (openai.ts): provider id
 * `muse`, key MODEL_API_KEY, instructions as a `system` message. Tool calling
 * is not proven for this provider, so `agent()` reports `unsupported` and the
 * bidding agent runs in decision mode: one JSON answer per run, applied
 * through the same mandate checks.
 */

export interface MuseProviderOptions {
  apiKey: SecretValue;
  model: string;
  url: string;
  timeoutMs: number;
  /** Tests inject a stand-in. */
  fetch?: typeof fetch;
}

export class MuseProvider extends OpenAiCompatibleProvider {
  constructor(opts: MuseProviderOptions) {
    super({ ...opts, id: 'muse', label: 'Muse API', instructionRole: 'system' });
  }
}
