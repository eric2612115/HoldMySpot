import type Anthropic from '@anthropic-ai/sdk';
import type { AiAgentRequest, AiAgentResult, AiJsonRequest, AiJsonResult, AiProvider } from '@holdmyspot/shared/ports';
import type { SecretValue } from './config.ts';
import { AiError } from './errors.ts';
import { validateJson } from './schemas.ts';

/**
 * Claude through the official `@anthropic-ai/sdk` (docs/AI-SERVICES.md section 6).
 *
 * - Structured output via `output_config.format` (json_schema); effort set
 *   explicitly on every call (the model's default is medium).
 * - Thinking is left at the model default (adaptive; it cannot be turned off
 *   on this model). No temperature or sampling parameters.
 * - Server-side fallback is on (`fallbacks: "default"`, beta
 *   `server-side-fallback-2026-07-01`): a policy decline is retried on the
 *   model Anthropic recommends for it. `stop_reason` is checked before any
 *   content is read; a refusal that survives becomes `needs_review`.
 * - Agent runs: strict tool schemas, `tool_choice` auto (forced tool choice
 *   is rejected by this model), a manual loop capped at `maxSteps`, and the
 *   assistant content appended back unchanged.
 *
 * The SDK is imported on first use, so rules-only mode works without it.
 */

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

type Sdk = typeof import('@anthropic-ai/sdk');
type MessagesClient = { beta: { messages: { create: Anthropic['beta']['messages']['create'] } } };

export interface AnthropicProviderOptions {
  apiKey: SecretValue;
  model: string;
  /** Per structured-output call. */
  timeoutMs: number;
  /** For a whole agent run (all tool rounds together). */
  agentTimeoutMs: number;
  /** Tests inject a stand-in client; production builds one from the SDK. */
  client?: MessagesClient;
}

export class AnthropicProvider implements AiProvider {
  readonly id = 'anthropic' as const;
  readonly mode = 'live' as const;
  readonly vision = true;
  readonly model: string;
  readonly #opts: AnthropicProviderOptions;
  #sdk: Promise<Sdk | null> | null = null;
  #client: Promise<MessagesClient> | null = null;

  constructor(opts: AnthropicProviderOptions) {
    this.#opts = opts;
    this.model = opts.model;
    if (opts.client) this.#client = Promise.resolve(opts.client);
  }

  #loadSdk(): Promise<Sdk | null> {
    this.#sdk ??= import('@anthropic-ai/sdk').then(
      (m) => m,
      () => null,
    );
    return this.#sdk;
  }

  #getClient(): Promise<MessagesClient> {
    this.#client ??= this.#loadSdk().then((sdk) => {
      if (!sdk) throw new AiError('unavailable', 'The @anthropic-ai/sdk package is not installed.');
      return new sdk.default({ apiKey: this.#opts.apiKey.reveal(), maxRetries: 1, timeout: this.#opts.timeoutMs });
    });
    return this.#client;
  }

  async #mapError(e: unknown): Promise<AiError> {
    if (e instanceof AiError) return e;
    const sdk = await this.#loadSdk();
    if (sdk) {
      if (e instanceof sdk.APIConnectionTimeoutError) return new AiError('timeout', 'The model did not answer in time.');
      if (e instanceof sdk.APIUserAbortError) return new AiError('timeout', 'The call was cancelled at its deadline.');
      if (e instanceof sdk.AuthenticationError) return new AiError('unavailable', 'The Anthropic API key was rejected.', 401);
      if (e instanceof sdk.PermissionDeniedError) return new AiError('unavailable', 'The Anthropic API key may not use this model.', 403);
      if (e instanceof sdk.RateLimitError) return new AiError('http', 'Anthropic rate limit reached.', 429);
      if (e instanceof sdk.BadRequestError) return new AiError('http', `Anthropic rejected the request: ${e.message}`, 400);
      if (e instanceof sdk.APIError) return new AiError('http', `Anthropic error ${String(e.status ?? '')}`.trim(), typeof e.status === 'number' ? e.status : null);
      if (e instanceof sdk.APIConnectionError) return new AiError('unavailable', 'Could not reach the Anthropic API.');
    }
    return new AiError('unavailable', e instanceof Error ? e.message : String(e));
  }

  async json<T>(req: AiJsonRequest): Promise<AiJsonResult<T>> {
    const t0 = performance.now();
    const client = await this.#getClient();
    const content: Anthropic.Beta.BetaContentBlockParam[] = [
      ...req.images.map((img) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: img.mime, data: img.base64 } })),
      { type: 'text' as const, text: req.prompt },
    ];
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await client.beta.messages.create(
        {
          model: this.model,
          max_tokens: 16000,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          system: req.system,
          messages: [{ role: 'user', content }],
          output_config: { effort: req.effort, format: { type: 'json_schema', schema: req.schema } },
        },
        { timeout: this.#opts.timeoutMs },
      );
    } catch (e) {
      throw await this.#mapError(e);
    }
    if (res.stop_reason === 'refusal') {
      throw new AiError('refusal', `The model declined to read this${res.stop_details?.category ? ` (${res.stop_details.category})` : ''}.`);
    }
    if (res.stop_reason === 'max_tokens') throw new AiError('invalid_output', 'The answer was cut off.');
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new AiError('invalid_output', 'The answer was not JSON.');
    }
    const problems = validateJson(req.schema, data);
    if (problems.length > 0) throw new AiError('invalid_output', `The answer did not match the schema: ${problems.slice(0, 3).join('; ')}`);
    return {
      data: data as T,
      stamp: { provider: 'anthropic', model: res.model || this.model, mode: 'live', latencyMs: Math.round(performance.now() - t0) },
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
    };
  }

  async agent(req: AiAgentRequest): Promise<AiAgentResult> {
    const t0 = performance.now();
    const deadline = Date.now() + this.#opts.agentTimeoutMs;
    const client = await this.#getClient();
    const tools: Anthropic.Beta.BetaTool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      strict: true,
    }));
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: req.prompt }];
    const toolCalls: AiAgentResult['toolCalls'] = [];
    let summary = '';
    let model = this.model;
    for (let step = 0; step < req.maxSteps; step++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AiError('timeout', 'The agent run took too long.');
      let res: Anthropic.Beta.BetaMessage;
      try {
        res = await client.beta.messages.create(
          {
            model: this.model,
            max_tokens: 16000,
            betas: [FALLBACK_BETA],
            fallbacks: 'default',
            system: req.system,
            messages,
            tools,
            tool_choice: { type: 'auto' },
            output_config: { effort: 'low' },
          },
          { timeout: remaining },
        );
      } catch (e) {
        throw await this.#mapError(e);
      }
      if (res.stop_reason === 'refusal') throw new AiError('refusal', 'The model declined this agent run.');
      model = res.model || model;
      // Append the whole assistant turn unchanged (thinking blocks included).
      messages.push({ role: 'assistant', content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
      const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ').trim();
      if (text) summary = text;
      const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || uses.length === 0) break;
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of uses) {
        const tool = req.tools.find((t) => t.name === use.name);
        let output: unknown;
        if (!tool) output = { ok: false, error: `Unknown tool ${use.name}.` };
        else {
          const problems = validateJson(tool.inputSchema, use.input);
          if (problems.length > 0) output = { ok: false, error: `Invalid input: ${problems.join('; ')}` };
          else {
            try {
              output = await tool.run(use.input);
            } catch (e) {
              output = { ok: false, error: e instanceof Error ? e.message : String(e) };
            }
          }
        }
        toolCalls.push({ name: use.name, input: use.input, output });
        const isError = typeof output === 'object' && output !== null && (output as { ok?: unknown }).ok === false;
        results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(output), is_error: isError });
      }
      // All results of one turn go back in a single user message.
      messages.push({ role: 'user', content: results });
    }
    return { summary, toolCalls, stamp: { provider: 'anthropic', model, mode: 'live', latencyMs: Math.round(performance.now() - t0) } };
  }
}
