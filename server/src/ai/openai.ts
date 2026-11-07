import type { AiAgentRequest, AiAgentResult, AiJsonRequest, AiJsonResult, AiProvider } from '@holdmyspot/shared/ports';
import type { SecretValue } from './config.ts';
import { AiError } from './errors.ts';
import { validateJson } from './schemas.ts';

/**
 * Any OpenAI-compatible Chat Completions endpoint (docs/AI-SERVICES.md
 * section 2): OpenAI itself (`HMS_AI_PROVIDER=openai`, key OPENAI_API_KEY,
 * endpoint HMS_AI_BASE_URL, model HMS_AI_MODEL) and Meta's Muse Spark, which
 * is a preset of this class (muse.ts).
 *
 * - Structured output through `response_format: json_schema` (not strict:
 *   our own validator checks every answer against the schema).
 * - `reasoning_effort` comes from the request. A model that does not take it
 *   (HTTP 400 naming the parameter) is asked again once without it, and this
 *   instance stops sending it.
 * - The instructions go as a `developer` message to api.openai.com (o1 and
 *   newer models) and as a `system` message to every other endpoint.
 * - No tool calling: `agent()` reports `unsupported`, so the bidding agent
 *   runs in decision mode (one JSON answer per run, applied through the same
 *   mandate checks).
 *
 * The key is sent only in the Authorization header and never appears in an
 * error message.
 */

export const OPENAI_HOST = 'api.openai.com';

export interface OpenAiCompatibleOptions {
  id: 'openai' | 'muse';
  /** For error messages, for example "OpenAI API". */
  label: string;
  apiKey: SecretValue;
  model: string;
  /** The full Chat Completions URL (see chatCompletionsUrl). */
  url: string;
  timeoutMs: number;
  /** Role of the instructions message; default `developer` for api.openai.com, else `system`. */
  instructionRole?: 'system' | 'developer';
  /** Tests inject a stand-in. */
  fetch?: typeof fetch;
}

/** `https://host/v1` or a full `.../chat/completions` URL, to the full Chat Completions URL. */
export function chatCompletionsUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

/** The host name of a URL, or '' when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

type ChatPayload = {
  choices?: { message?: { content?: unknown; refusal?: unknown }; finish_reason?: unknown }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
};

type ErrorPayload = { error?: { message?: unknown; code?: unknown; param?: unknown; type?: unknown } | string };

/** A short, key-free description of an error body: code, parameter and the first words of the message. */
function errorDetail(body: ErrorPayload | null): { text: string; param: string; mentionsEffort: boolean } {
  const err = body?.error;
  if (!err) return { text: '', param: '', mentionsEffort: false };
  if (typeof err === 'string') {
    const msg = scrub(err);
    return { text: msg, param: '', mentionsEffort: /reasoning_effort/i.test(err) };
  }
  const code = typeof err.code === 'string' ? err.code : '';
  const param = typeof err.param === 'string' ? err.param : '';
  const message = typeof err.message === 'string' ? scrub(err.message) : '';
  const text = [code, param && `parameter ${param}`, message].filter(Boolean).join('; ');
  return { text, param, mentionsEffort: param === 'reasoning_effort' || /reasoning_effort|reasoning effort/i.test(message) };
}

/** Drops anything that looks like a key from provider text, and keeps it short. */
function scrub(text: string): string {
  return text
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_*-]{6,}/g, '$1-[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 240);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('');
  }
  return '';
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly id: 'openai' | 'muse';
  readonly mode = 'live' as const;
  readonly vision = true;
  readonly model: string;
  readonly #opts: OpenAiCompatibleOptions;
  readonly #role: 'system' | 'developer';
  #sendEffort = true;

  constructor(opts: OpenAiCompatibleOptions) {
    this.#opts = opts;
    this.id = opts.id;
    this.model = opts.model;
    this.#role = opts.instructionRole ?? (hostOf(opts.url) === OPENAI_HOST ? 'developer' : 'system');
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
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: this.#role, content: req.system },
        { role: 'user', content },
      ],
      response_format: { type: 'json_schema', json_schema: { name: req.schemaName, schema: req.schema } },
    };
    let res = await this.#post({ ...body, ...(this.#sendEffort ? { reasoning_effort: req.effort } : {}) });
    if (res.status === 400 && this.#sendEffort) {
      const detail = errorDetail(await this.#errorBody(res.clone()));
      if (detail.mentionsEffort) {
        this.#sendEffort = false;
        res = await this.#post(body);
      }
    }
    if (!res.ok) {
      const detail = errorDetail(await this.#errorBody(res));
      if (res.status === 401 || res.status === 403) throw new AiError('unavailable', `The ${this.#opts.label} key was rejected (HTTP ${res.status}).`, res.status);
      throw new AiError('http', `The ${this.#opts.label} answered HTTP ${res.status}${detail.text ? ` (${detail.text})` : ''}.`, res.status);
    }
    let payload: ChatPayload;
    try {
      payload = (await res.json()) as ChatPayload;
    } catch {
      throw new AiError('invalid_output', `The ${this.#opts.label} answer was not JSON.`);
    }
    const choice = payload.choices?.[0];
    const message = choice?.message;
    if (message?.refusal) throw new AiError('refusal', 'The model declined to read this.');
    if (choice?.finish_reason === 'length') throw new AiError('invalid_output', 'The answer was cut off before it ended.');
    let data: unknown;
    try {
      data = JSON.parse(textOf(message?.content));
    } catch {
      throw new AiError('invalid_output', 'The answer was not JSON.');
    }
    const problems = validateJson(req.schema, data);
    if (problems.length > 0) throw new AiError('invalid_output', `The answer did not match the schema: ${problems.slice(0, 3).join('; ')}`);
    return {
      data: data as T,
      stamp: { provider: this.id, model: payload.model || this.model, mode: 'live', latencyMs: Math.round(performance.now() - t0) },
      usage: payload.usage ? { inputTokens: payload.usage.prompt_tokens ?? 0, outputTokens: payload.usage.completion_tokens ?? 0 } : null,
    };
  }

  async agent(_req: AiAgentRequest): Promise<AiAgentResult> {
    throw new AiError('unsupported', `Tool calling is not wired for the ${this.#opts.label}; the agent uses decision mode.`);
  }

  async #post(body: Record<string, unknown>): Promise<Response> {
    const doFetch = this.#opts.fetch ?? fetch;
    try {
      return await doFetch(this.#opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#opts.apiKey.reveal()}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#opts.timeoutMs),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') throw new AiError('timeout', 'The model did not answer in time.');
      throw new AiError('unavailable', `Could not reach the ${this.#opts.label}.`);
    }
  }

  async #errorBody(res: Response): Promise<ErrorPayload | null> {
    try {
      return (await res.json()) as ErrorPayload;
    } catch {
      return null;
    }
  }
}
