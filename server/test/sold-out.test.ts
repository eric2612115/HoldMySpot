import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HERO } from '@holdmyspot/shared';
import { testServer } from './helpers.ts';

/**
 * The "sold out" scene (D-152): two independent checked-in queuers report the Mochi Bunny plush sold out,
 * every requester's hold on it is released, nothing is captured from anyone, and the phones' own reads say so.
 */

describe('the sold-out demo script (D-152)', () => {
  it('two checked-in queuers report the plush sold out: every hold on it is released and $0 is charged', async () => {
    const s = await testServer({ demo: true, crowd: true });
    try {
      await s.director!.start('sold-out', null);
      s.app.clock.pause();
      await s.at(Date.parse('2026-11-12T11:10:00-08:00'));
      assert.equal(s.director!.state().status, 'finished');

      // Both reports came from checked-in queuers, on their own jobs; the second closed the book.
      const rex = s.app.store.jobs.first("queuer_id = 'rex' AND requester_id = 'priya'")!;
      const wei = s.app.store.jobs.first("queuer_id = 'wei' AND requester_id = 'mia'")!;
      for (const job of [rex, wei]) {
        assert.ok(s.app.store.claims.must(job.claimId).checkedInAt !== null, `${job.queuerId} reported from inside the line`);
        assert.equal(job.status, 'failed');
        assert.equal(job.failure?.reason, 'sold_out');
      }
      const book = await s.call('GET', `/api/books/${HERO.shopId}/${HERO.itemId}`, { as: 'mia' });
      assert.equal(book.json.book.status, 'sold_out');

      // Every request on the plush: closed as sold out, its hold released in full, nothing captured.
      const bids = s.app.store.bids.where('item_id = ?', HERO.itemId);
      const requesters = bids.map((b) => b.requesterId);
      assert.ok(requesters.includes('mia') && requesters.includes('priya'), 'Mia and Priya are among them');
      assert.equal(bids.length, 13, 'Mia, Priya and the eleven crowd requesters');
      for (const bid of bids) {
        assert.equal(bid.closeReason, 'sold_out', bid.requesterId);
        const hold = s.app.store.holds.must(bid.holdId!);
        assert.equal(hold.status, 'released', `${bid.requesterId}'s hold is released`);
        assert.equal(hold.capturedCents, 0, `${bid.requesterId} is charged $0`);
        assert.equal(hold.releasedCents, hold.amount.cents, `${bid.requesterId}'s whole hold is released`);
      }

      // The ledger the phones read: one release per hold, no capture and no payout anywhere.
      const entries = s.app.store.ledger.all();
      assert.equal(entries.filter((e) => e.kind === 'captured').length, 0);
      assert.equal(entries.filter((e) => e.kind === 'paid_out').length, 0);
      assert.equal(s.app.store.payouts.all().length, 0);
      const releases = entries.filter((e) => e.kind === 'released' && e.status === 'succeeded');
      for (const bid of bids) assert.equal(releases.filter((e) => e.holdId === bid.holdId).length, 1, `one release for ${bid.requesterId}`);

      // Mia's phone: her request is closed as sold out, held $63.70, released $63.70, charged $0.00.
      const mine = await s.call('GET', '/api/ledger?mine=1', { as: 'mia' });
      assert.deepEqual(mine.json.entries.map((e: any) => `${e.kind} ${e.amount.cents} ${e.status}`).sort(), ['held 6370 succeeded', 'released 6370 succeeded']);
      const miaBid = bids.find((b) => b.requesterId === 'mia')!;
      const detail = await s.call('GET', `/api/bids/${miaBid.id}`, { as: 'mia' });
      assert.equal(detail.json.bid.closeReason, 'sold_out');
      assert.ok(['cancelled', 'expired'].includes(detail.json.bid.status), detail.json.bid.status);
      assert.deepEqual([detail.json.hold.amount.cents, detail.json.hold.capturedCents, detail.json.hold.releasedCents], [6370, 0, 6370]);
      // Wei's phone: his job ended as sold out, and he was paid nothing for it.
      const weiJob = await s.call('GET', `/api/jobs/${wei.id}`, { as: 'wei' });
      assert.equal(weiJob.json.job.failure.reason, 'sold_out');
      assert.equal((await s.call('GET', '/api/ledger?mine=1', { as: 'wei' })).json.entries.length, 0);

      const cues = s.app.bus.after(0).filter((e) => e.type === 'demo.cue').map((e) => (e.data as { text: string }).text);
      const held = bids.reduce((n, b) => n + s.app.store.holds.must(b.holdId!).amount.cents, 0);
      assert.equal(held, 68316, 'every hold, released in full');
      assert.equal(cues.at(-1), 'Paper Moon Toys sold out. 13 holds released ($683.16). Charged $0.00.');
    } finally {
      await s.done();
    }
  });

  it('after the first report alone every other hold on the plush is still held', async () => {
    const s = await testServer({ demo: true, crowd: true });
    try {
      await s.director!.start('sold-out', null);
      s.app.clock.pause();
      await s.at(Date.parse('2026-11-12T11:01:00-08:00'));
      const rex = s.app.store.jobs.first("queuer_id = 'rex' AND requester_id = 'priya'")!;
      assert.equal(rex.failure?.reason, 'sold_out', "Rex's own job ended");
      const book = await s.call('GET', `/api/books/${HERO.shopId}/${HERO.itemId}`, { as: 'mia' });
      assert.equal(book.json.book.status, 'open', 'one report does not close the book');
      for (const bid of s.app.store.bids.where('item_id = ?', HERO.itemId)) assert.equal(s.app.store.holds.must(bid.holdId!).status, 'held', `${bid.requesterId}'s hold stays`);
    } finally {
      await s.done();
    }
  });
});
