import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { AiJsonRequest } from '@holdmyspot/shared/ports';
import { AnthropicProvider } from '../../src/ai/anthropic.ts';
import type { AnthropicProviderOptions } from '../../src/ai/anthropic.ts';
import { SecretValue } from '../../src/ai/config.ts';
import { AiError } from '../../src/ai/errors.ts';
import { FakeProvider, MemoryTruth } from '../../src/ai/fake.ts';
import { encodePng } from '../../src/ai/image.ts';
import { MuseProvider } from '../../src/ai/muse.ts';
import { FixtureStore, RecordingProvider, ReplayProvider, fixtureKey } from '../../src/ai/replay.ts';
import { CHECK_IN_SCHEMA } from '../../src/ai/schemas.ts';
import { StubProvider, scene, tempDir } from './helpers.ts';

const png = encodePng(scene(8, 8, (x) => x * 20));
const image = { mime: 'image/png' as const, base64: Buffer.from(png).toString('base64') };
const answer = { lineVisible: true, peopleAhead: 12, codeSeen: 'M4RT7', storefrontText: 'SHOP HILL BAKERY' };

function request(prompt = 'Read the line photo.'): AiJsonRequest {
  const parts = { task: 'check_in_photo' as const, schemaName: 'check_in_photo', system: 'system text', prompt, images: [image] };
  return { ...parts, schema: CHECK_IN_SCHEMA, effort: 'low', fixtureKey: fixtureKey(parts) };
}

function message(content: unknown[], stop_reason = 'end_turn', extra: Record<string, unknown> = {}) {
  return { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_details: null, usage: { input_tokens: 10, output_tokens: 5 }, ...extra };
}

function anthropic(responses: unknown[]) {
  const calls: { params: Record<string, unknown>; opts: Record<string, unknown> }[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>, opts: Record<string, unknown>) => {
          calls.push({ params: structuredClone(params), opts });
          const next = responses.shift();
          if (next instanceof Error) throw next;
          return next;
        },
      },
    },
  };
  const provider = new AnthropicProvider({
    apiKey: new SecretValue('sk-test'),
    model: 'claude-opus-5-5',
    timeoutMs: 1234,
    agentTimeoutMs: 5000,
    client: client as unknown as AnthropicProviderOptions['client'],
  });
  return { provider, calls };
}

describe('Anthropic provider', () => {
  it('asks for structured output with effort, fallback and the image, and validates the answer', async () => {
    const { provider, calls } = anthropic([message([{ type: 'text', text: JSON.stringify(answer) }])]);
    const res = await provider.json(request());
    assert.deepEqual(res.data, answer);
    assert.deepEqual([res.stamp.provider, res.stamp.model, res.stamp.mode], ['anthropic', 'claude-opus-5-5', 'live']);
    const { params, opts } = calls[0]!;
    assert.equal(params.model, 'claude-opus-5-5');
    assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(params.fallbacks, 'default');
    assert.deepEqual(params.output_config, { effort: 'low', format: { type: 'json_schema', schema: CHECK_IN_SCHEMA } });
    assert.equal(params.system, 'system text');
    const content = (params.messages as { content: { type: string; source?: { media_type: string } }[] }[])[0]!.content;
    assert.equal(content[0]?.type, 'image');
    assert.equal(content[0]?.source?.media_type, 'image/png');
    assert.equal(content[1]?.type, 'text');
    for (const banned of ['temperature', 'top_p', 'top_k', 'thinking']) assert.ok(!(banned in params), `${banned} must not be sent`);
    assert.equal(opts.timeout, 1234);
  });

  it('turns refusals, cut-off and malformed answers into AI errors', async () => {
    const cases: [unknown, AiError['kind']][] = [
      [message([], 'refusal', { stop_details: { type: 'refusal', category: null, explanation: null } }), 'refusal'],
      [message([{ type: 'text', text: '{"lineVisible": tr' }], 'max_tokens'), 'invalid_output'],
      [message([{ type: 'text', text: 'not json' }]), 'invalid_output'],
      [message([{ type: 'text', text: JSON.stringify({ ...answer, extra: 1 }) }]), 'invalid_output'],
    ];
    for (const [response, kind] of cases) {
      const { provider } = anthropic([response]);
      await assert.rejects(provider.json(request()), (e: unknown) => e instanceof AiError && e.kind === kind);
    }
  });

  it('runs a tool-use loop with strict tools and returns every call', async () => {
    const { provider, calls } = anthropic([
      message([{ type: 'tool_use', id: 't1', name: 'get_book', input: {} }], 'tool_use'),
      message([{ type: 'tool_use', id: 't2', name: 'keep', input: { reason: 'Waiting for the clock.' } }], 'tool_use'),
      message([{ type: 'text', text: 'Kept the fee.' }]),
    ]);
    const ran: string[] = [];
    const res = await provider.agent({
      task: 'bidding_agent',
      system: 'agent system',
      prompt: 'Decide.',
      maxSteps: 4,
      fixtureKey: 'k',
      tools: [
        { name: 'get_book', description: 'book', inputSchema: { type: 'object', additionalProperties: false, properties: {}, required: [] }, run: async () => (ran.push('get_book'), { ok: true }) },
        {
          name: 'keep',
          description: 'keep',
          inputSchema: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string' } } },
          run: async () => (ran.push('keep'), { ok: true }),
        },
      ],
    });
    assert.deepEqual(ran, ['get_book', 'keep']);
    assert.equal(res.summary, 'Kept the fee.');
    assert.equal(res.toolCalls.length, 2);
    const first = calls[0]!.params;
    assert.deepEqual(first.tool_choice, { type: 'auto' });
    assert.ok((first.tools as { strict?: boolean }[]).every((t) => t.strict === true));
    const second = calls[1]!.params.messages as { role: string; content: { type: string; tool_use_id?: string }[] }[];
    assert.equal(second[1]?.role, 'assistant');
    assert.equal(second[2]?.content[0]?.tool_use_id, 't1');
  });
});

describe('Muse provider', () => {
  it('sends the Chat Completions JSON-schema request and reads the answer', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchStub = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ model: 'muse-spark-1.3', choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new MuseProvider({ apiKey: new SecretValue('muse-key'), model: 'muse-spark-1.3', url: 'https://muse.test/v1/chat/completions', timeoutMs: 1000, fetch: fetchStub });
    const res = await p.json(request());
    assert.deepEqual(res.data, answer);
    assert.equal(res.stamp.provider, 'muse');
    const s = seen as unknown as { url: string; init: RequestInit };
    const body = JSON.parse(String(s.init.body)) as { response_format: { type: string; json_schema: { name: string } }; reasoning_effort: string; messages: { content: unknown }[] };
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.name, 'check_in_photo');
    assert.equal(body.reasoning_effort, 'low');
    assert.match(JSON.stringify(body.messages[1]?.content), /data:image\/png;base64,/);
    assert.ok(String((s.init.headers as Record<string, string>).authorization).startsWith('Bearer '));
  });

  it('reports a rejected key and has no tool use', async () => {
    const fetchStub = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    const p = new MuseProvider({ apiKey: new SecretValue('bad'), model: 'm', url: 'https://muse.test', timeoutMs: 1000, fetch: fetchStub });
    await assert.rejects(p.json(request()), (e: unknown) => e instanceof AiError && e.kind === 'unavailable' && e.status === 401);
    await assert.rejects(p.agent({ task: 'bidding_agent', system: '', prompt: '', tools: [], maxSteps: 1, fixtureKey: 'k' }), (e: unknown) => e instanceof AiError && e.kind === 'unsupported');
  });
});

describe('record, replay and the rules-only provider', () => {
  it('keys fixtures by prompt and image content', () => {
    const a = request().fixtureKey;
    assert.equal(a, request().fixtureKey);
    assert.notEqual(a, request('Another prompt.').fixtureKey);
  });

  it('records an answer without the prompt or images and replays it under the recorded provider', async () => {
    const dir = tempDir();
    const store = new FixtureStore(dir);
    const live = new StubProvider({ json: () => answer });
    const recorded = await new RecordingProvider(store, live).json(request('SECRET PROMPT TEXT'));
    assert.equal(recorded.stamp.mode, 'record');
    const file = join(dir, 'check_in_photo', readdirSync(join(dir, 'check_in_photo'))[0]!);
    const saved = readFileSync(file, 'utf8');
    assert.ok(!saved.includes('SECRET PROMPT TEXT') && !saved.includes(image.base64.slice(0, 40)));
    const replay = new ReplayProvider(store, new FakeProvider(new MemoryTruth()), { id: 'fake', model: 'rules-v1' });
    const res = await replay.json(request('SECRET PROMPT TEXT'));
    assert.deepEqual(res.data, answer);
    assert.deepEqual([res.stamp.provider, res.stamp.mode], ['anthropic', 'replay']);
  });

  it('falls back to fixture truth on a miss, and reads nothing from unknown photos', async () => {
    const truth = new MemoryTruth().add([png], { check_in_photo: answer });
    const replay = new ReplayProvider(new FixtureStore(tempDir()), new FakeProvider(truth), { id: 'fake', model: 'rules-v1' });
    const res = await replay.json(request());
    assert.deepEqual([res.stamp.provider, res.stamp.mode], ['fake', 'fake']);
    const unknown = { ...request(), images: [{ mime: 'image/png' as const, base64: Buffer.from(encodePng(scene(4, 4, () => 9))).toString('base64') }] };
    await assert.rejects(new FakeProvider(truth).json(unknown), (e: unknown) => e instanceof AiError && e.kind === 'no_truth');
  });

  it('refuses fixture truth that does not match the schema', async () => {
    const truth = new MemoryTruth().add([png], { check_in_photo: { lineVisible: 'yes' } });
    await assert.rejects(new FakeProvider(truth).json(request()), (e: unknown) => e instanceof AiError && e.kind === 'invalid_output');
  });
});
