import type { AiAgentRequest, AiAgentResult, AiJsonRequest, AiJsonResult, AiProvider } from '@holdmyspot/shared/ports';
import type { SecretValue } from './config.ts';
import { AiError } from './errors.ts';
import { validateJson } from './schemas.ts';

/**
 * Muse Spark over its Chat Completions endpoint, with JSON-schema output
 * (the same request shape the owner's earlier server used). Tool calling is
 * not proven for this provider, so `agent()` reports `unsupported` and the
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

export class MuseProvider implements AiProvider {
  readonly id = 'muse' as const;
  readonly mode = 'live' as const;
  readonly vision = true;
  readonly model: string;
  readonly #opts: MuseProviderOptions;

  constructor(opts: MuseProviderOptions) {
    this.#opts = opts;
    this.model = opts.model;
  }

  async json<T>(req: AiJsonRequest): Promise<AiJsonResult<T>> {
    const t0 = performance.now();
    const content =
      req.images.length === 0
        ? req.prompt
        : [
            { type: 'text', text: req.prompt },
            ...req.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } })),
          ];
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content },
      ],
      response_format: { type: 'json_schema', json_schema: { name: req.schemaName, schema: req.schema } },
      reasoning_effort: req.effort,
    };
    const doFetch = this.#opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(this.#opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#opts.apiKey.reveal()}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#opts.timeoutMs),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') throw new AiError('timeout', 'The model did not answer in time.');
      throw new AiError('unavailable', 'Could not reach the Muse API.');
    }
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new AiError('unavailable', 'The Muse API key was rejected.', res.status);
      throw new AiError('http', `The Muse API answered HTTP ${res.status}.`, res.status);
    }
    let payload: { choices?: { message?: { content?: unknown; refusal?: unknown } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string };
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      throw new AiError('invalid_output', 'The Muse API answer was not JSON.');
    }
    const message = payload.choices?.[0]?.message;
    if (message?.refusal) throw new AiError('refusal', 'The model declined to read this.');
    let data: unknown;
    try {
      data = JSON.parse(String(message?.content ?? ''));
    } catch {
      throw new AiError('invalid_output', 'The answer was not JSON.');
    }
    const problems = validateJson(req.schema, data);
    if (problems.length > 0) throw new AiError('invalid_output', `The answer did not match the schema: ${problems.slice(0, 3).join('; ')}`);
    return {
      data: data as T,
      stamp: { provider: 'muse', model: payload.model || this.model, mode: 'live', latencyMs: Math.round(performance.now() - t0) },
      usage: payload.usage ? { inputTokens: payload.usage.prompt_tokens ?? 0, outputTokens: payload.usage.completion_tokens ?? 0 } : null,
    };
  }

  async agent(_req: AiAgentRequest): Promise<AiAgentResult> {
    throw new AiError('unsupported', 'Tool calling is not proven for Muse Spark; the agent uses decision mode.');
  }
}
