import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';
import type { AiJsonRequest } from '@holdmyspot/shared/ports';
import { SecretValue, aiBootLine, resolveAiSettings } from '../../src/ai/config.ts';
import { AiError } from '../../src/ai/errors.ts';
import { encodePng } from '../../src/ai/image.ts';
import { OpenAiCompatibleProvider, chatCompletionsUrl } from '../../src/ai/openai.ts';
import { createLiveProvider } from '../../src/ai/provider.ts';
import { fixtureKey } from '../../src/ai/replay.ts';
import { CHECK_IN_SCHEMA } from '../../src/ai/schemas.ts';
import { scene, tempDir } from './helpers.ts';

/** The OpenAI-compatible provider (HMS_AI_PROVIDER=openai) and its key rules (D-88). */

const OPENAI_KEY = 'sk-test-openai-0123456789';
const META_KEY = 'meta-test-key-9876543210';
const png = encodePng(scene(8, 8, (x) => x * 20));
const image = { mime: 'image/png' as const, base64: Buffer.from(png).toString('base64') };
const answer = { lineVisible: true, peopleAhead: 12, codeSeen: 'M4RT7', storefrontText: 'SHOP HILL BAKERY' };

function request(): AiJsonRequest {
  const parts = { task: 'check_in_photo' as const, schemaName: 'check_in_photo', system: 'system text', prompt: 'Read the line photo.', images: [image] };
  return { ...parts, schema: CHECK_IN_SCHEMA, effort: 'low', fixtureKey: fixtureKey(parts) };
}

type Seen = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

/** A fetch stand-in that answers from a list and records every request. */
function stub(responses: (() => Response)[]): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: init.headers as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error('no more stub responses');
    return next();
  }) as unknown as typeof fetch;
  return { fetch: f, seen };
}

const ok = (content: unknown, extra: Record<string, unknown> = {}) => () =>
  new Response(JSON.stringify({ model: 'gpt-6.1-sol-2026-10-01', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 }, ...extra }), { status: 200 });

function provider(url: string, fetchStub: typeof fetch): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({ id: 'openai', label: 'OpenAI API', apiKey: new SecretValue(OPENAI_KEY), model: 'gpt-6.1-sol', url, timeoutMs: 1000, fetch: fetchStub });
}

describe('OpenAI-compatible settings', () => {
  const none = () => ({ secretsDir: tempDir() });

  it('picks OpenAI with only OPENAI_API_KEY, with the default model and endpoint, and never shows the key', () => {
    const r = resolveAiSettings({ env: { OPENAI_API_KEY: OPENAI_KEY }, runtimeMode: 'sandbox', ...none() });
    assert.deepEqual([r.settings.provider, r.settings.model, r.settings.mode], ['openai', 'gpt-6.1-sol', 'live']);
    assert.equal(r.settings.openaiUrl, 'https://api.openai.com/v1/chat/completions');
    assert.equal(r.keys.openai?.reveal(), OPENAI_KEY);
    assert.match(aiBootLine(r), /openai key present \(process env\); using openai gpt-6\.1-sol at api\.openai\.com, mode live$/);
    for (const shown of [JSON.stringify(r), inspect(r, { depth: 10 }), aiBootLine(r)]) assert.ok(!shown.includes(OPENAI_KEY));
  });

  it('takes the model and any OpenAI-compatible endpoint from HMS_AI_MODEL and HMS_AI_BASE_URL', () => {
    const env = { OPENAI_API_KEY: OPENAI_KEY, HMS_AI_PROVIDER: 'openai', HMS_AI_BASE_URL: 'https://llm.example.test/v1/', HMS_AI_MODEL: 'some-vision-model' };
    const r = resolveAiSettings({ env, ...none() });
    assert.deepEqual([r.settings.provider, r.settings.model, r.settings.openaiUrl], ['openai', 'some-vision-model', 'https://llm.example.test/v1/chat/completions']);
    assert.equal(chatCompletionsUrl('https://llm.example.test/v1/chat/completions'), 'https://llm.example.test/v1/chat/completions');
  });

  it("sends Meta's key only to Meta's host, also through the openai provider", () => {
    const meta = { MODEL_API_KEY: META_KEY, HMS_AI_PROVIDER: 'openai' };
    const toOpenAi = resolveAiSettings({ env: meta, ...none() });
    assert.equal(toOpenAi.settings.provider, 'fake', 'MODEL_API_KEY is never sent to api.openai.com');
    assert.match(toOpenAi.settings.reason, /OPENAI_API_KEY was not found/);
    const toOther = resolveAiSettings({ env: { ...meta, HMS_AI_BASE_URL: 'https://llm.example.test/v1' }, ...none() });
    assert.equal(toOther.keys.openai, null, 'nor to any other host');
    const toMeta = resolveAiSettings({ env: { ...meta, HMS_AI_BASE_URL: 'https://api.meta.ai/v1', HMS_AI_MODEL: 'muse-spark-1.3' }, runtimeMode: 'sandbox', ...none() });
    assert.deepEqual([toMeta.settings.provider, toMeta.settings.model, toMeta.settings.openaiUrl], ['openai', 'muse-spark-1.3', 'https://api.meta.ai/v1/chat/completions']);
    assert.equal(toMeta.keys.openai?.reveal(), META_KEY);
    assert.match(toMeta.sources.openai ?? '', /MODEL_API_KEY for Meta's host/);
  });

  it('keeps the earlier auto order (Anthropic, then Muse) ahead of OpenAI, and leaves the boot line unchanged without an OpenAI key', () => {
    assert.equal(resolveAiSettings({ env: { MODEL_API_KEY: META_KEY, OPENAI_API_KEY: OPENAI_KEY }, ...none() }).settings.provider, 'muse');
    assert.equal(resolveAiSettings({ env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: OPENAI_KEY }, ...none() }).settings.provider, 'anthropic');
    const muse = resolveAiSettings({ env: { MODEL_API_KEY: META_KEY }, ...none() });
    assert.equal(muse.sources.openai, undefined);
    assert.doesNotMatch(aiBootLine(muse), /openai/);
  });

  it('builds the live provider for openai with its endpoint', async () => {
    const r = resolveAiSettings({ env: { OPENAI_API_KEY: OPENAI_KEY, HMS_AI_MODE: 'live' }, ...none() });
    const { fetch: f, seen } = stub([ok(JSON.stringify(answer))]);
    const live = createLiveProvider(r, { fetch: f });
    assert.ok(live instanceof OpenAiCompatibleProvider);
    assert.deepEqual([live.id, live.model], ['openai', 'gpt-6.1-sol']);
    await live.json(request());
    assert.equal(seen[0]?.url, 'https://api.openai.com/v1/chat/completions');
  });
});

describe('OpenAI-compatible provider', () => {
  it('sends a JSON-schema request with the image, effort and a developer message to OpenAI, and reads the answer', async () => {
    const { fetch: f, seen } = stub([ok(JSON.stringify(answer))]);
    const res = await provider('https://api.openai.com/v1/chat/completions', f).json(request());
    assert.deepEqual(res.data, answer);
    assert.deepEqual([res.stamp.provider, res.stamp.model, res.stamp.mode], ['openai', 'gpt-6.1-sol-2026-10-01', 'live']);
    assert.deepEqual(res.usage, { inputTokens: 3, outputTokens: 4 });
    const body = seen[0]!.body as { messages: { role: string; content: unknown }[]; response_format: { type: string; json_schema: { name: string } }; reasoning_effort: string; model: string };
    assert.equal(body.model, 'gpt-6.1-sol');
    assert.equal(body.messages[0]?.role, 'developer');
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.name, 'check_in_photo');
    assert.equal(body.reasoning_effort, 'low');
    assert.match(JSON.stringify(body.messages[1]?.content), /data:image\/png;base64,/);
    assert.equal(seen[0]!.headers.authorization, `Bearer ${OPENAI_KEY}`);
  });

  it('uses a system message elsewhere and reads an answer given as content parts', async () => {
    const { fetch: f, seen } = stub([ok([{ type: 'text', text: JSON.stringify(answer) }])]);
    const res = await provider('https://llm.example.test/v1/chat/completions', f).json(request());
    assert.deepEqual(res.data, answer);
    assert.equal((seen[0]!.body.messages as { role: string }[])[0]?.role, 'system');
  });

  it('asks again without reasoning_effort when the model does not take it, and stops sending it', async () => {
    const unsupported = () =>
      new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model.", type: 'invalid_request_error', param: 'reasoning_effort', code: 'unsupported_parameter' } }), { status: 400 });
    const { fetch: f, seen } = stub([unsupported, ok(JSON.stringify(answer)), ok(JSON.stringify(answer))]);
    const p = provider('https://api.openai.com/v1/chat/completions', f);
    assert.deepEqual((await p.json(request())).data, answer);
    await p.json(request());
    assert.deepEqual(seen.map((s) => 'reasoning_effort' in s.body), [true, false, false]);
  });

  it('maps errors without ever showing the key', async () => {
    const leaky = `Incorrect API key provided: ${OPENAI_KEY}`;
    const cases: [() => Response, (e: AiError) => boolean][] = [
      [() => new Response(JSON.stringify({ error: { message: leaky, code: 'invalid_api_key' } }), { status: 401 }), (e) => e.kind === 'unavailable' && e.status === 401],
      [() => new Response(JSON.stringify({ error: { message: `The model does not exist (key ${OPENAI_KEY})`, code: 'model_not_found' } }), { status: 404 }), (e) => e.kind === 'http' && /model_not_found/.test(e.message)],
      [ok(null, { choices: [{ message: { content: null, refusal: 'No.' } }] }), (e) => e.kind === 'refusal'],
      [ok('{"lineVisible": tr', { choices: [{ message: { content: '{"lineVisible": tr' }, finish_reason: 'length' }] }), (e) => e.kind === 'invalid_output'],
      [ok(JSON.stringify({ lineVisible: 'yes' })), (e) => e.kind === 'invalid_output'],
    ];
    for (const [response, check] of cases) {
      const { fetch: f } = stub([response]);
      await assert.rejects(provider('https://api.openai.com/v1/chat/completions', f).json(request()), (e: unknown) => {
        assert.ok(e instanceof AiError);
        assert.ok(!e.message.includes(OPENAI_KEY), `the key leaked into: ${e.message}`);
        return check(e);
      });
    }
    const { fetch: f } = stub([]);
    await assert.rejects(provider('https://api.openai.com/v1/chat/completions', f).agent({ task: 'bidding_agent', system: '', prompt: '', tools: [], maxSteps: 1, fixtureKey: 'k' }), (e: unknown) => e instanceof AiError && e.kind === 'unsupported');
  });
});
