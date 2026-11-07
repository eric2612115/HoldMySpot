import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AiProviderId } from '@holdmyspot/shared';
import type { AiAgentRequest, AiAgentResult, AiImage, AiJsonRequest, AiJsonResult, AiProvider, AiTask } from '@holdmyspot/shared/ports';
import { PROMPT_VERSION } from './prompts.ts';
import { validateJson } from './schemas.ts';

/**
 * Record and replay (docs/AI-SERVICES.md section 3).
 *
 * A fixture holds one structured answer (or one agent run) plus the provider
 * and model that produced it. It never holds keys, prompts or images. Its key
 * is a SHA-256 of the prompt version, task, schema name, system and user
 * prompt and the SHA-256 of each image, so a fixture recorded with one
 * provider replays under any provider, and any prompt change misses.
 */

export function imageSha256(img: AiImage): string {
  return createHash('sha256').update(Buffer.from(img.base64, 'base64')).digest('hex');
}

export function fixtureKey(parts: { task: AiTask; schemaName: string; system: string; prompt: string; images: readonly AiImage[] }): string {
  const body = JSON.stringify({
    v: PROMPT_VERSION,
    task: parts.task,
    schema: parts.schemaName,
    system: parts.system,
    prompt: parts.prompt,
    images: parts.images.map(imageSha256),
  });
  return createHash('sha256').update(body).digest('hex');
}

export interface AiFixture {
  format: 1;
  task: AiTask;
  fixtureKey: string;
  provider: AiProviderId;
  model: string;
  /** Real time of the recording, ISO 8601. */
  recordedAt: string;
  latencyMs: number;
  data?: unknown;
  agent?: { summary: string; toolCalls: { name: string; input: unknown; output: unknown }[] };
}

export class FixtureStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  path(task: AiTask, key: string): string {
    return join(this.dir, task, `${key}.json`);
  }

  read(task: AiTask, key: string): AiFixture | null {
    try {
      const fx = JSON.parse(readFileSync(this.path(task, key), 'utf8')) as AiFixture;
      return fx.format === 1 && fx.fixtureKey === key ? fx : null;
    } catch {
      return null;
    }
  }

  write(fx: AiFixture): void {
    const file = this.path(fx.task, fx.fixtureKey);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(fx, null, 2)}\n`);
    renameSync(tmp, file);
  }
}

/** Returns saved answers; on a miss (or a stale fixture) asks the fallback, normally the rules-only fake. */
export class ReplayProvider implements AiProvider {
  readonly id: AiProviderId;
  readonly model: string;
  readonly mode = 'replay' as const;
  readonly vision = true;
  readonly #store: FixtureStore;
  readonly #fallback: AiProvider;

  constructor(store: FixtureStore, fallback: AiProvider, label: { id: AiProviderId; model: string }) {
    this.#store = store;
    this.#fallback = fallback;
    this.id = label.id;
    this.model = label.model;
  }

  async json<T>(req: AiJsonRequest): Promise<AiJsonResult<T>> {
    const t0 = performance.now();
    const fx = this.#store.read(req.task, req.fixtureKey);
    if (fx && fx.data !== undefined && validateJson(req.schema, fx.data).length === 0) {
      return {
        data: fx.data as T,
        stamp: { provider: fx.provider, model: fx.model, mode: 'replay', latencyMs: Math.round(performance.now() - t0) },
        usage: null,
      };
    }
    return this.#fallback.json<T>(req);
  }

  async agent(req: AiAgentRequest): Promise<AiAgentResult> {
    const t0 = performance.now();
    const fx = this.#store.read(req.task, req.fixtureKey);
    if (!fx?.agent) return this.#fallback.agent(req);
    // Re-run the recorded tool calls so today's mandate checks apply to them again.
    const toolCalls: AiAgentResult['toolCalls'] = [];
    for (const call of fx.agent.toolCalls.slice(0, req.maxSteps * 4)) {
      const tool = req.tools.find((t) => t.name === call.name);
      const output = tool ? await tool.run(call.input) : { ok: false, error: `Unknown tool ${call.name}.` };
      toolCalls.push({ name: call.name, input: call.input, output });
    }
    return {
      summary: fx.agent.summary,
      toolCalls,
      stamp: { provider: fx.provider, model: fx.model, mode: 'replay', latencyMs: Math.round(performance.now() - t0) },
    };
  }
}

/** Calls the live provider and saves every answer as a fixture. */
export class RecordingProvider implements AiProvider {
  readonly id: AiProviderId;
  readonly model: string;
  readonly mode = 'record' as const;
  readonly vision: boolean;
  readonly #store: FixtureStore;
  readonly #live: AiProvider;

  constructor(store: FixtureStore, live: AiProvider) {
    this.#store = store;
    this.#live = live;
    this.id = live.id;
    this.model = live.model;
    this.vision = live.vision;
  }

  async json<T>(req: AiJsonRequest): Promise<AiJsonResult<T>> {
    const res = await this.#live.json<T>(req);
    this.#store.write({
      format: 1,
      task: req.task,
      fixtureKey: req.fixtureKey,
      provider: res.stamp.provider,
      model: res.stamp.model,
      recordedAt: new Date().toISOString(),
      latencyMs: res.stamp.latencyMs,
      data: res.data,
    });
    return { ...res, stamp: { ...res.stamp, mode: 'record' } };
  }

  async agent(req: AiAgentRequest): Promise<AiAgentResult> {
    const res = await this.#live.agent(req);
    this.#store.write({
      format: 1,
      task: req.task,
      fixtureKey: req.fixtureKey,
      provider: res.stamp.provider,
      model: res.stamp.model,
      recordedAt: new Date().toISOString(),
      latencyMs: res.stamp.latencyMs,
      agent: { summary: res.summary, toolCalls: res.toolCalls },
    });
    return { ...res, stamp: { ...res.stamp, mode: 'record' } };
  }
}
