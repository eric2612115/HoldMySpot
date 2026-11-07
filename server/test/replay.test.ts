import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { zonedLocalToEpoch } from '@holdmyspot/shared';
import { SERVER_ROOT } from '../src/config.ts';
import { testServer, type TestServer } from './helpers.ts';

/**
 * The hero demo on the recorded model answers (server/fixtures/ai, made by
 * `npm run ai:eval -- --record` with Meta's Muse Spark): the demo's "replay"
 * mode reads every hero photo from a real model reading, offline, and the
 * money comes out exactly as with the rules-only reader. Every other suite
 * points the replay folder at an empty one, so its numbers never depend on
 * a recording.
 */

const sf = (hhmm: string) => zonedLocalToEpoch(`2026-11-12 ${hhmm}`, 'America/Los_Angeles')!;
const FIXTURES = join(SERVER_ROOT, 'fixtures', 'ai');
const recorded = existsSync(join(FIXTURES, 'purchase_proof')) && readdirSync(join(FIXTURES, 'purchase_proof')).length > 0;

describe('the hero demo on recorded model answers (replay)', { skip: recorded ? false : 'no recorded answers in server/fixtures/ai' }, () => {
  let s: TestServer;
  before(async () => {
    s = await testServer({ demo: true, crowd: true, ai: 'real', env: { HMS_AI_FIXTURES_DIR: FIXTURES } });
    await s.director!.start('hero', null);
    s.app.clock.pause();
    await s.at(sf('14:05'));
  });
  after(() => s.done());

  it('reads the hero photos from the recorded Muse Spark answers, stamped as replay', () => {
    const wei = s.app.store.claims.first("queuer_id = 'wei'")!;
    const checkIn = s.app.store.proofs.first("claim_id = ? AND kind = 'check_in'", wei.id)!;
    const miaJob = s.app.store.jobs.first("queuer_id = 'wei' AND requester_id = 'mia'")!;
    const receipt = s.app.store.proofs.first("job_id = ? AND kind = 'purchase'", miaJob.id)!;
    const rexJob = s.app.store.jobs.first("queuer_id = 'rex'")!;
    const fake = s.app.store.proofs.first("job_id = ? AND kind = 'purchase'", rexJob.id)!;
    for (const p of [checkIn, receipt, fake]) {
      assert.equal(p.ai?.provider, 'muse', p.id);
      assert.equal(p.ai?.mode, 'replay', p.id);
    }
    assert.equal(checkIn.status, 'passed');
    assert.equal(receipt.status, 'passed');
    assert.equal(fake.status, 'failed');
  });

  it('moves the same money as the rules-only reader: held $63.70, charged $58.26, Rex $0', () => {
    assert.equal(s.director!.state().status, 'finished');
    const bid = s.app.store.bids.first("requester_id = 'mia'")!;
    const hold = s.app.store.holds.must(bid.holdId!);
    assert.deepEqual([hold.amount.cents, hold.capturedCents, hold.releasedCents], [6370, 5826, 544]);
    const paid = s.app.store.payouts.where("recipient_user_id = 'wei'").map((p) => [p.amount.cents, p.status]);
    assert.deepEqual(paid, [
      [1080, 'succeeded'],
      [4275, 'succeeded'],
    ]);
    const rexJob = s.app.store.jobs.first("queuer_id = 'rex'")!;
    assert.equal(rexJob.amounts.capturedCents, 0);
    const proof = s.app.store.proofs.first("job_id = ? AND kind = 'purchase'", rexJob.id)!;
    assert.deepEqual(proof.checks.filter((c) => !c.ok).map((c) => c.code), ['shop_match', 'time_window', 'totals_add_up', 'duplicate_photo']);
  });

  it('holds the market still on the closing numbers once the script ends, even when asked to resume', () => {
    const state = s.director!.resume();
    assert.equal(state.status, 'finished');
    assert.equal(s.app.clock.paused, true);
  });
});
