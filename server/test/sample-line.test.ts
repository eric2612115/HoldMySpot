import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HERO, findShop } from '@holdmyspot/shared';
import { SERVER_ROOT } from '../src/config.ts';
import { testServer, type TestServer } from './helpers.ts';

/**
 * The check-in card's "Use the sample line photo" (demo mode): the phone fetches web/public/samples/line.png,
 * a copy of Wei's rendered line photo, and sends it as it is. On a fresh demo market Wei's visit to Paper
 * Moon Toys carries the code that photo shows, so the recorded Muse Spark answer reads it and the check passes.
 */

const FIXTURES = join(SERVER_ROOT, 'fixtures', 'ai');
const recorded = existsSync(join(FIXTURES, 'check_in_photo')) && readdirSync(join(FIXTURES, 'check_in_photo')).length > 0;
const SAMPLE = join(SERVER_ROOT, '..', 'web', 'public', 'samples', 'line.png');
const shop = findShop(HERO.shopId)!;

describe('the sample line photo on a fresh demo market', { skip: recorded ? false : 'no recorded answers in server/fixtures/ai' }, () => {
  let s: TestServer;
  before(async () => {
    s = await testServer({ demo: true, crowd: true, ai: 'real', env: { HMS_AI_FIXTURES_DIR: FIXTURES } });
    await s.director!.reset('hero', null);
  });
  after(() => s.done());

  async function checkInWithSample(fixture: string | null) {
    const wei = s.app.store.users.must(HERO.queuerId).user;
    const offer = await s.call('POST', '/api/asks', {
      as: wei.id,
      body: { shopId: HERO.shopId, itemId: HERO.itemId, capacity: 1, modes: ['local', 'ship'], feeCents: 1500, clock: null, etaAt: s.app.now() + 20 * 60_000, from: { lngLat: wei.home, accuracyM: 10 } },
    });
    assert.equal(offer.status, 200, JSON.stringify(offer.json));
    const claim = offer.json.claim;
    assert.equal(claim.checkInCode, 'M4RT7', "Wei's demo visit carries the code the sample photo shows");
    const query = fixture ? `&fixture=${fixture}` : '';
    const upload = await s.call('POST', `/api/files?purpose=line_photo${query}`, { as: wei.id, body: new Uint8Array(readFileSync(SAMPLE)) });
    assert.ok(upload.status < 300, JSON.stringify(upload.json));
    const file = upload.json.file as { id: string };
    const checkIn = await s.call('POST', `/api/claims/${claim.id}/check-in`, { as: wei.id, body: { lngLat: shop.lngLat, accuracyM: 8, photoFileId: file.id } });
    assert.equal(checkIn.status, 200, JSON.stringify(checkIn.json));
    await s.app.idle();
    return s.app.store.proofs.first("claim_id = ? AND kind = 'check_in'", claim.id)!;
  }

  it('passes with the recorded Muse Spark reading: code M4RT7, about 30 people ahead', async () => {
    // The zero-key phone sends its default simulated reading (line_ok); a rendered photo is still read from its recording.
    const proof = await checkInWithSample('line_ok');
    assert.equal(proof.status, 'passed');
    assert.equal(proof.peopleAhead, 32);
    assert.deepEqual([proof.ai?.provider, proof.ai?.model, proof.ai?.mode], ['muse', 'muse-spark-1.3', 'replay']);
    assert.ok(proof.checks.find((c) => c.code === 'code_visible')?.ok, 'the code on the photo is the visit\'s');
  });
});
