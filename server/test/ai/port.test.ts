import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encode as encodeJpeg } from 'jpeg-js';
import { findItem, findShop } from '@holdmyspot/shared';
import type { Job } from '@holdmyspot/shared';
import { loadConfig } from '../../src/config.ts';
import { encodePng } from '../../src/ai/image.ts';
import { buildAiPort, createAiPort } from '../../src/ai/index.ts';
import { reassignTemplate } from '../../src/ai/notes.ts';
import { checkInInput, listCases } from '../../scripts/ai-fixtures/load.ts';
import { at, scene, tempDir } from './helpers.ts';

describe('AiPort factory', () => {
  it('builds the port from the server config and logs one line without values', async () => {
    const lines: string[] = [];
    const config = loadConfig({ HMS_SECRETS_DIR: tempDir(), HMS_AI_PROVIDER: 'fake' });
    const ai = await createAiPort({ config, log: (l) => lines.push(l) });
    assert.deepEqual(ai.info, { provider: 'fake', model: 'rules-v1', mode: 'fake' });
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /^AI: anthropic key (absent|present \(.+\)), muse key (absent|present \(.+\)); using rules only/);
    for (const name of ['checkInPhoto', 'purchaseProof', 'feeEstimate', 'shippingEstimate', 'reassignNote', 'dHash', 'eta', 'biddingAgent'] as const) {
      assert.equal(typeof ai[name], 'function', name);
    }
  });

  it('reads its own fixtures, and hands simulated-scenario or unknown photos (no key) to the rules-only fake', async () => {
    const config = loadConfig({ HMS_SECRETS_DIR: tempDir(), HMS_AI_PROVIDER: 'auto', HMS_AI_FIXTURES_DIR: tempDir() });
    const ai = await createAiPort({ config, log: () => undefined });
    assert.deepEqual([ai.info.provider, ai.info.mode], ['fake', 'replay']);
    const lc = listCases().find((c) => c.data.id === 'checkin-paper-moon-wei')!;
    const input = await checkInInput(lc, []);
    const known = await ai.checkInPhoto(input);
    assert.equal(known.status, 'passed');
    assert.equal(known.extraction?.codeSeen, 'M4RT7', 'read from the fixture truth sidecar');
    const staged = await ai.checkInPhoto({ ...input, photo: { ...input.photo, scenario: 'line_ok' } });
    assert.equal(staged.extraction?.codeSeen, 'M4RT7', 'a rendered fixture is read offline even when the upload names a scenario');
    const stranger = encodePng(scene(20, 20, (x, y) => (x * 13 + y * 7) % 255));
    const scenario = await ai.checkInPhoto({ ...input, photo: { ...input.photo, scenario: 'no_code', bytes: async () => stranger } });
    assert.equal(scenario.status, 'failed', 'an unknown photo with a scenario gets the simulated reading');
    assert.equal(scenario.extraction, null);
    const unknown = await ai.checkInPhoto({ ...input, photo: { ...input.photo, bytes: async () => stranger } });
    assert.equal(unknown.status, 'passed', 'the rules-only fake reads an unknown photo as genuine');
    assert.equal(unknown.ai.provider, 'fake');
  });

  it('hashes PNG and JPEG uploads and skips formats it cannot decode', async () => {
    const ai = buildAiPort({ env: {}, secretsDir: tempDir() });
    const img = scene(32, 24, (x, y) => x * 6 + y);
    assert.match((await ai.dHash(encodePng(img))) ?? '', /^[0-9a-f]{16}$/);
    const jpg = new Uint8Array(encodeJpeg({ width: 32, height: 24, data: Buffer.from(img.data) }, 90).data);
    assert.match((await ai.dHash(jpg)) ?? '', /^[0-9a-f]{16}$/);
    assert.equal(await ai.dHash(new Uint8Array(Buffer.from('RIFF0000WEBPVP8X'))), null);
  });
});

describe('ops note', () => {
  const job = { queuerName: 'Rex', qty: 1, itemId: 'plush-paper-moon', shopId: 'paper-moon-toys' } as Job;

  it('says why the units went back on offer and who took them', async () => {
    const takenBy = { queuerName: 'Lin', feeCents: 1000, etaAt: at('11:30') };
    assert.equal(reassignTemplate({ job, reason: 'proof_rejected', takenBy }, { checksFailed: 4 }), "Rex's receipt failed 4 checks, so the plush was offered again; Lin took it at $10.00 (ETA 11:30).");
    const ai = buildAiPort({ env: {}, secretsDir: tempDir(), aiProvider: 'fake' });
    assert.equal(await ai.reassignNote?.({ job, reason: 'no_show', takenBy: null }), 'Rex did not check in in time, so the plush was offered again; it is waiting for the next offer.');
    assert.equal(reassignTemplate({ job: { ...job, qty: 2 }, reason: 'sold_out', takenBy: null }), 'The shop sold out before Rex could buy; the 2 plush toys were not bought and nothing was charged for them.');
  });

  it('knows the catalog it names', () => {
    assert.ok(findShop('paper-moon-toys') && findItem('plush-paper-moon'));
  });
});
