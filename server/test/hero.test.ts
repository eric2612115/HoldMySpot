import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HERO, zonedLocalToEpoch } from '@holdmyspot/shared';
import type { DemoCue } from '@holdmyspot/shared';
import { testServer, type TestServer } from './helpers.ts';

/**
 * The hero script end to end (docs/ARCHITECTURE.md section 8): the ledger
 * must show held $60.00, captures $46.00 and $8.75, $5.25 released, payouts
 * $10.80 and $42.75, and $0 moved for Rex's fake receipt.
 */

const sf = (hhmm: string) => zonedLocalToEpoch(`2026-11-12 ${hhmm}`, 'America/Los_Angeles')!;

describe('hero script', () => {
  let s: TestServer;
  before(async () => {
    s = await testServer({ demo: true, crowd: true });
    await s.director!.start('hero', null);
    s.app.clock.pause();
    await s.at(sf('14:05'));
  });
  after(() => s.done());

  it('finishes every step', () => {
    const state = s.director!.state();
    assert.equal(state.status, 'finished');
    assert.equal(state.scriptId, 'hero');
  });

  it("seeds Paper Moon's book with 12 one-plush requests before anyone queues", () => {
    const book = s.app.store.bids.where('item_id = ?', HERO.itemId).filter((b) => b.createdAt < sf('10:30'));
    assert.equal(book.length, 12);
    assert.ok(book.every((b) => b.qty === 1), 'one per customer');
    const fees = book.map((b) => b.maxFeeCents).sort((a, b) => b - a);
    assert.deepEqual(fees.slice(0, 3), [1100, 1050, 1000]);
    assert.equal(book.find((b) => b.maxFeeCents === 1100)?.requesterId, 'priya');
  });

  it("steps Wei's fee down from $15 until Mia's $12 request meets it, then Lin's $10 offer takes Priya's re-offered request", () => {
    const wei = s.app.store.asks.first("queuer_id = 'wei'")!;
    const fillsOf = (askId: string) =>
      s.app.store.matches.where('ask_id = ?', askId).map((m) => {
        const bid = s.app.store.bids.must(m.bidId);
        return [bid.requesterId, m.qty, m.feeCents, m.at, m.trigger];
      });
    assert.deepEqual(fillsOf(wei.id), [['mia', 1, 1200, sf('11:05'), 'clock_step']]);
    assert.equal(wei.clock?.startsAt, sf('10:50'));
    const lin = s.app.store.asks.first("queuer_id = 'lin'")!;
    assert.deepEqual(fillsOf(lin.id), [['priya', 1, 1000, sf('11:20'), 'new_ask']]);
  });

  it("moves $0 for Rex's fake receipt, which fails four checks", () => {
    const rexJob = s.app.store.jobs.first("queuer_id = 'rex'")!;
    assert.equal(rexJob.status, 'failed');
    assert.equal(rexJob.failure?.reason, 'proof_rejected');
    assert.equal(rexJob.amounts.capturedCents, 0);
    assert.equal(s.app.store.ledger.count('job_id = ?', rexJob.id), 0);
    const proof = s.app.store.proofs.first('job_id = ?', rexJob.id)!;
    assert.deepEqual(proof.checks.filter((c) => !c.ok).map((c) => c.code), ['shop_match', 'time_window', 'totals_add_up', 'duplicate_photo']);
    assert.equal(proof.summary, 'Receipt failed 4 checks: shop, printed time, totals, recycled photo.');
  });

  it('charges Mia $54.75 of the $60.00 held and pays Wei $10.80 then $42.75', () => {
    const bid = s.app.store.bids.first("requester_id = 'mia'")!;
    const hold = s.app.store.holds.must(bid.holdId!);
    assert.equal(hold.amount.cents, 6000);
    assert.equal(hold.capturedCents, 5475);
    assert.equal(hold.releasedCents, 525);
    assert.equal(hold.status, 'captured');
    const mine = s.app.store.ledger.where('bid_id = ? AND user_id = ?', bid.id, 'mia');
    assert.deepEqual(
      mine.map((e) => [e.kind, e.amount.cents, e.status]),
      [
        ['held', 6000, 'succeeded'],
        ['captured', 4600, 'succeeded'],
        ['captured', 875, 'succeeded'],
        ['released', 525, 'succeeded'],
      ],
    );
    const job = s.app.store.jobs.first("bid_id = ? AND queuer_id = 'wei'", bid.id)!;
    assert.equal(job.status, 'shipped');
    assert.deepEqual(
      s.app.store.payouts.where('job_id = ?', job.id).map((p) => [p.amount.cents, p.status]),
      [
        [1080, 'succeeded'],
        [4275, 'succeeded'],
      ],
    );
    const captureTimes = mine.filter((e) => e.kind === 'captured').map((e) => e.at);
    assert.deepEqual(captureTimes, [sf('11:42'), sf('14:00')]);
  });

  it("captures $44.00 for Priya's plush from Lin's receipt", () => {
    const job = s.app.store.jobs.first("queuer_id = 'lin'")!;
    assert.equal(job.requesterId, 'priya');
    assert.equal(job.status, 'verified');
    assert.equal(job.amounts.capturedCents, 4400);
    assert.deepEqual(s.app.store.payouts.where('job_id = ?', job.id).map((p) => [p.amount.cents, p.status]), [[900, 'succeeded']]);
  });

  it('ends with the closing caption built from the ledger', () => {
    const cues = s.app.bus.after(0).filter((e) => e.type === 'demo.cue').map((e) => e.data as DemoCue);
    assert.equal(cues.at(-1)?.text, 'Held $60.00. Charged $54.75. Fake receipt: $0.');
  });

  it("Wei's visit is done and the plush he bought passed", () => {
    const claim = s.app.store.claims.first("queuer_id = 'wei'")!;
    assert.equal(claim.status, 'done');
    const jobs = s.app.store.jobs.where("queuer_id = 'wei'");
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.status, 'shipped');
  });
});

describe('hero script, second take in the same server', () => {
  it('runs every step again after a restart of the script (the scheduler forgets the old market)', async () => {
    const s = await testServer({ demo: true, crowd: true });
    try {
      const fills = () => s.app.store.matches.all().map((m) => [m.feeCents, m.at]);
      await s.director!.start('hero', null);
      s.app.clock.pause();
      await s.at(sf('11:25'));
      const first = fills();
      assert.ok(first.length >= 3, 'the first take filled Mia, Rex and Lin');
      await s.director!.start('hero', null);
      s.app.clock.pause();
      assert.equal(s.app.store.matches.count(), 0, 'the reset emptied the market');
      await s.at(sf('11:25'));
      assert.ok(s.director!.state().stepIndex > 5, 'the second take ran its steps');
      assert.deepEqual(fills(), first, 'and gave the same fills at the same times');
    } finally {
      await s.done();
    }
  });
});
