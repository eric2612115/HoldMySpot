import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AiJsonRequest, AiJsonResult, AiProvider } from '@holdmyspot/shared/ports';
import { buildAiPort } from '../src/ai/index.ts';
import { AiError } from '../src/ai/errors.ts';
import { extractJsonObject, lenientJsonFetch, parseArguments, renderPrompt, runOpsTurn } from '../src/ai/opsTurn.ts';
import { DAY, MIN, SHOP, checkInAt, placeBid, postAsk, testServer, type TestServer } from './helpers.ts';

/** A stand-in live model that answers every turn with `answer` and remembers what it was asked. */
function stubModel(answer: unknown): AiProvider & { asked: AiJsonRequest[] } {
  const asked: AiJsonRequest[] = [];
  return {
    id: 'muse',
    model: 'stub-model',
    mode: 'live',
    vision: false,
    asked,
    async json<T>(req: AiJsonRequest): Promise<AiJsonResult<T>> {
      asked.push(req);
      return { data: answer as T, stamp: { provider: 'muse', model: 'stub-model', mode: 'live', latencyMs: 5 }, usage: null };
    },
    async agent() {
      throw new Error('not used');
    },
  };
}

const READ_MARKET = { name: 'read_market', description: 'Reads the market.', parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } };

describe('ops agent turns (D-100)', () => {
  it('asks the live model for one turn and returns its calls with JSON arguments', async () => {
    const model = stubModel({ say: '', calls: [{ tool: 'read_market', arguments: '{"topic":"holds"}' }, { tool: 'drop_tables', arguments: '{}' }] });
    const out = await runOpsTurn(
      { agent: 'market-desk', instructions: 'Answer from read_market.', messages: [{ role: 'user', text: 'How much is held?' }], tools: [READ_MARKET], toolChoice: 'auto' },
      model,
      'offline',
    );
    assert.equal(out.calls.length, 1, 'a tool the console did not offer is dropped');
    assert.equal(out.calls[0]!.name, 'read_market');
    assert.deepEqual(JSON.parse(out.calls[0]!.arguments), { topic: 'holds' });
    assert.equal(out.ai.provider, 'muse');
    const req = model.asked[0]!;
    assert.equal(req.task, 'ops_agent');
    assert.match(req.system, /Answer from read_market/);
    assert.match(req.prompt, /How much is held\?/);
    assert.deepEqual((req.schema as { required: string[] }).required, ['say', 'calls']);
  });

  it('takes arguments as an object, and asks once more when the answer was not JSON', async () => {
    let n = 0;
    const flaky = stubModel({ say: '', calls: [{ tool: 'read_market', arguments: { topic: 'captures' } }] });
    const inner = flaky.json.bind(flaky);
    flaky.json = async <T,>(req: AiJsonRequest) => {
      if (n++ === 0) throw new AiError('invalid_output', 'The answer was not JSON.');
      return inner<T>(req);
    };
    const out = await runOpsTurn({ agent: 'market-desk', instructions: '', messages: [{ role: 'user', text: 'Captures?' }], tools: [READ_MARKET], toolChoice: 'auto' }, flaky, 'offline');
    assert.equal(n, 2);
    assert.deepEqual(JSON.parse(out.calls[0]!.arguments), { topic: 'captures' });
    assert.match(flaky.asked[0]!.prompt, /not valid JSON/);
    const props = (flaky.asked[0]!.schema as { properties: { calls: { items: { properties: { arguments: { type: string } } } } } }).properties;
    assert.equal(props.calls.items.properties.arguments.type, 'object', 'a non-strict provider gets object arguments');
  });

  it('refuses without a live model, and in replay mode', async () => {
    await assert.rejects(runOpsTurn({ agent: 'x', instructions: '', messages: [{ role: 'user', text: 'hi' }], tools: [], toolChoice: 'auto' }, null, 'No AI model.'), /No AI model/);
    const port = buildAiPort({ env: {}, secretsDir: '/nonexistent', aiProvider: 'auto', aiMode: 'replay' });
    await assert.rejects(port.opsAgentTurn!({ agent: 'x', instructions: '', messages: [{ role: 'user', text: 'hi' }], tools: [], toolChoice: 'auto' }), /No AI model|replay/);
  });

  it('hands the provider the JSON alone when a turn wraps it in fences or a sentence', async () => {
    const body = (content: string) => JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] });
    const fenced = lenientJsonFetch(async () => new Response(body('Here is the turn:\n```json\n{"say":"hi","calls":[]}\n```'), { status: 200 }));
    const out = (await (await fenced('https://example.test', {})).json()) as { choices: { message: { content: string } }[] };
    assert.deepEqual(JSON.parse(out.choices[0]!.message.content), { say: 'hi', calls: [] });
    assert.equal(extractJsonObject('no json here'), null);
  });

  it('reads arguments from fenced or twice-encoded JSON, and the prompt cuts long tool results', () => {
    assert.deepEqual(parseArguments('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseArguments(JSON.stringify(JSON.stringify({ b: 2 }))), { b: 2 });
    assert.deepEqual(parseArguments('not json'), {});
    const prompt = renderPrompt({
      agent: 'data',
      instructions: '',
      messages: [
        { role: 'user', text: 'q' },
        { role: 'assistant', text: '', calls: [{ id: 'c1', name: 'read_market', arguments: '{}' }] },
        { role: 'tool', callId: 'c1', text: 'x'.repeat(9000) },
      ],
      tools: [READ_MARKET],
      toolChoice: { name: 'read_market' },
    });
    assert.match(prompt, /Call the tool read_market this turn/);
    assert.match(prompt, /more characters\)/);
  });
});

describe('ops routes: a model turn and approved moves', () => {
  let s: TestServer;
  before(async () => {
    s = await testServer();
  });
  after(() => s.done());

  it('answers 503 AI_UNAVAILABLE on the rules-only fake, and a turn with a live model', async () => {
    const body = { agent: 'market-desk', instructions: '', messages: [{ role: 'user', text: 'Hello' }], tools: [READ_MARKET], toolChoice: 'auto' };
    const off = await s.call('POST', '/api/ops/agents/turn', { body });
    assert.equal(off.status, 503);
    assert.equal(off.json.error.code, 'AI_UNAVAILABLE');
    const before = s.app.ai;
    s.app.ai = buildAiPort({ provider: stubModel({ say: 'Nothing is held yet.', calls: [] }) });
    try {
      const on = await s.call('POST', '/api/ops/agents/turn', { body });
      assert.equal(on.status, 200);
      assert.equal(on.json.say, 'Nothing is held yet.');
      assert.deepEqual(on.json.calls, []);
    } finally {
      s.app.ai = before;
    }
  });

  it('reassigns a late queuer\'s job to a queuer in line, at that offer\'s fee now', async () => {
    const mia = await placeBid(s.app, 'mia', { qty: 1, maxFeeCents: 1200 });
    const jo = await postAsk(s.app, 'jo', { capacity: 1, feeCents: 1000, etaInMin: 20 });
    const joJob = s.app.store.jobs.where('ask_id = ?', jo.ask.id)[0]!;
    assert.equal(joJob.bidId, mia.bid.id);
    const ava = await postAsk(s.app, 'ava', { capacity: 2, feeCents: 900, etaInMin: 15 });
    await checkInAt(s.app, 'ava', ava.claim.id, SHOP.lngLat);
    const ai = { provider: 'muse', model: 'stub-model', mode: 'live', latencyMs: 9 };
    const res = await s.call('POST', '/api/ops/moves', {
      body: { moves: [{ kind: 'reassign', jobId: joJob.id, toAskId: ava.ask.id }], reason: 'Jo cannot reach the shop in time; Ava is in line.', proposalId: `late:${jo.claim.id}`, ai },
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.skipped.length, 0);
    const moved = s.app.store.jobs.must(res.json.applied[0].jobIds[0]);
    assert.equal(moved.queuerId, 'ava');
    assert.equal(moved.feeCents, 900);
    assert.equal(moved.bidId, mia.bid.id);
    assert.equal(s.app.store.jobs.must(joJob.id).failure?.reason, 'queuer_withdrew');
    assert.equal(s.app.store.bids.must(mia.bid.id).remainingQty, 0);
    const note = s.app.store.agentActions.where('bid_id = ?', mia.bid.id).at(-1)!;
    assert.equal(note.kind, 'reassign');
    assert.equal(note.toFeeCents, 900);
    assert.equal(note.ai.model, 'stub-model');
  });

  it('refuses a move the rules do not allow, and says why', async () => {
    const jun = await placeBid(s.app, 'jun', { qty: 1, maxFeeCents: 800 });
    const rin = await postAsk(s.app, 'rin', { capacity: 1, feeCents: 700, etaInMin: 20 });
    const rinJob = s.app.store.jobs.where('ask_id = ?', rin.ask.id)[0]!;
    assert.equal(rinJob.bidId, jun.bid.id);
    const lin = await postAsk(s.app, 'lin', { capacity: 1, feeCents: 1100, etaInMin: 25 });
    const res = await s.call('POST', '/api/ops/moves', { body: { moves: [{ kind: 'reassign', jobId: rinJob.id, toAskId: lin.ask.id }], reason: 'Try Lin.', proposalId: null, ai: null } });
    assert.equal(res.status, 409);
    assert.match(res.json.error.message, /above .*max fee of \$8\.00/);
    assert.equal(s.app.store.jobs.must(rinJob.id).status, 'claimed', 'nothing changed');
  });
});

describe('ops routes: a batch with an unknown id (D-117)', () => {
  it('skips the move that names an unknown record and keeps the ones already applied', async () => {
    const s = await testServer();
    try {
      const wei = await postAsk(s.app, 'wei', { capacity: 1, feeCents: 1050, etaInMin: 15 });
      const end = s.app.store.claims.must(wei.claim.id).windowEndsAt;
      const moves = [
        { kind: 'extend', claimId: wei.claim.id, minutes: 5 },
        { kind: 'release_job', jobId: 'job_9999' },
      ];
      const res = await s.call('POST', '/api/ops/moves', { body: { moves, reason: 'Wei is 5 minutes out.', proposalId: null, ai: null } });
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.deepEqual(res.json.applied.map((a: { move: { kind: string } }) => a.move.kind), ['extend']);
      assert.equal(s.app.store.claims.must(wei.claim.id).windowEndsAt, end + 5 * MIN, 'the first move stays applied');
      assert.equal(res.json.skipped.length, 1);
      assert.match(res.json.skipped[0].problem, /job_9999/);
      const none = await s.call('POST', '/api/ops/moves', { body: { moves: [{ kind: 'release', claimId: 'claim_9999' }], reason: 'Release.', proposalId: null, ai: null } });
      assert.equal(none.status, 409, 'nothing applied');
      assert.match(none.json.error.message, /claim_9999/);
    } finally {
      await s.done();
    }
  });
});

describe('ops routes: shift a window, then release', () => {
  it('shifts a late queuer\'s window, then releases him so the rules re-offer the job', async () => {
    const s = await testServer();
    try {
      const leo = await placeBid(s.app, 'leo', { qty: 1, maxFeeCents: 1100, deadlineAt: s.app.now() + DAY });
      const wei = await postAsk(s.app, 'wei', { capacity: 1, feeCents: 1050, etaInMin: 15 });
      const weiJob = s.app.store.jobs.where('ask_id = ?', wei.ask.id)[0]!;
      assert.equal(weiJob.bidId, leo.bid.id);
      const end = s.app.store.claims.must(wei.claim.id).windowEndsAt;
      const eta = s.app.store.asks.must(wei.ask.id).etaAt;
      const shifted = await s.call('POST', '/api/ops/moves', { body: { moves: [{ kind: 'extend', claimId: wei.claim.id, minutes: 9 }], reason: 'Wei is 9 minutes out.', proposalId: null, ai: null } });
      assert.equal(shifted.status, 200, JSON.stringify(shifted.json));
      assert.equal(s.app.store.claims.must(wei.claim.id).windowEndsAt, end + 9 * MIN);
      assert.equal(s.app.store.asks.must(wei.ask.id).etaAt, eta + 9 * MIN);
      // Ava checks in with a $9.00 offer; releasing Wei sends Leo's job back to the line-up, where her offer takes it.
      const ava = await postAsk(s.app, 'ava', { capacity: 1, feeCents: 900, etaInMin: 15 });
      await checkInAt(s.app, 'ava', ava.claim.id, SHOP.lngLat);
      const released = await s.call('POST', '/api/ops/moves', { body: { moves: [{ kind: 'release', claimId: wei.claim.id }], reason: 'Wei stopped moving.', proposalId: null, ai: null } });
      assert.equal(released.status, 200, JSON.stringify(released.json));
      assert.equal(s.app.store.claims.must(wei.claim.id).status, 'lapsed');
      assert.equal(s.app.store.jobs.must(weiJob.id).failure?.reason, 'no_show');
      const next = s.app.store.jobs.where('bid_id = ?', leo.bid.id).find((j) => j.status !== 'failed');
      assert.equal(next?.queuerId, 'ava');
      assert.equal(next?.feeCents, 900);
      assert.match(released.json.applied[0].note, /Released Wei: Leo .*job went to Ava at \$9\.00/);
    } finally {
      await s.done();
    }
  });
});
