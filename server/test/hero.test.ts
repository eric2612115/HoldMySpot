import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HERO, jobSettlement, zonedLocalToEpoch } from '@holdmyspot/shared';
import type { DemoCue } from '@holdmyspot/shared';
import { testServer, type TestServer } from './helpers.ts';

/**
 * The hero script end to end (docs/ARCHITECTURE.md section 8): the ledger
 * must show held $63.70, captures $48.69 and $9.57 (processing at cost
 * included, D-105), $5.44 released, payouts $10.80 and $42.75, PayPal's fees
 * $3.51 paid to the cent by the processing line, HoldMySpot keeping $1.20,
 * and $0 moved for Rex's fake receipt.
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

  it('charges Mia $58.26 of the $63.70 held and pays Wei $10.80 then $42.75', () => {
    const bid = s.app.store.bids.first("requester_id = 'mia'")!;
    const hold = s.app.store.holds.must(bid.holdId!);
    assert.equal(hold.amount.cents, 6370);
    assert.equal(hold.capturedCents, 5826);
    assert.equal(hold.releasedCents, 544);
    assert.equal(hold.status, 'captured');
    const mine = s.app.store.ledger.where('bid_id = ? AND user_id = ?', bid.id, 'mia');
    assert.deepEqual(
      mine.map((e) => [e.kind, e.amount.cents, e.status]),
      [
        ['held', 6370, 'succeeded'],
        ['captured', 4869, 'succeeded'],
        ['captured', 957, 'succeeded'],
        ['released', 544, 'succeeded'],
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

  it("explains Mia's charge to the cent: PayPal's fees are exactly the processing line and HoldMySpot keeps $1.20", () => {
    const bid = s.app.store.bids.first("requester_id = 'mia'")!;
    const job = s.app.store.jobs.first("bid_id = ? AND queuer_id = 'wei'", bid.id)!;
    const captures = s.app.store.ledger.where("job_id = ? AND kind = 'captured'", job.id);
    assert.deepEqual(
      captures.map((e) => [e.amount.cents, e.paypal?.feeCents, e.text]),
      [
        [4869, 219, 'Charged $48.69: shop price $34.00 at cost, queue fee 1 x $12.00 for Mochi Bunny plush, and processing $2.69 at cost ($2.19 to take this payment, $0.50 for 2 payouts).'],
        [957, 82, 'Charged $9.57: shipping $8.75 at cost and processing $0.82 at cost (taking this payment).'],
      ],
    );
    assert.deepEqual(s.app.store.payouts.where('job_id = ?', job.id).map((p) => p.paypalFeeCents), [25, 25]);
    assert.deepEqual(jobSettlement(job.amounts), { chargedCents: 5826, processingCents: 351, paidOutCents: 5355, paypalFeesCents: 351, platformCents: 120, processingVarianceCents: 0 });
    assert.equal(5826, 3400 + 1200 + 875 + 351, 'shop price, fee, shipping and processing');
  });

  it("captures $46.62 for Priya's plush from Lin's receipt ($34.00 + $10.00 + $2.62 processing)", () => {
    const job = s.app.store.jobs.first("queuer_id = 'lin'")!;
    assert.equal(job.requesterId, 'priya');
    assert.equal(job.status, 'verified');
    assert.equal(job.amounts.capturedCents, 4662);
    assert.equal(job.amounts.processingCents, 262);
    assert.deepEqual(s.app.store.payouts.where('job_id = ?', job.id).map((p) => [p.amount.cents, p.status]), [[900, 'succeeded']]);
  });

  it('ends with the closing caption built from the ledger', () => {
    const cues = s.app.bus.after(0).filter((e) => e.type === 'demo.cue').map((e) => e.data as DemoCue);
    assert.equal(cues.at(-1)?.text, 'Held $63.70. Charged $58.26. Fake receipt: $0.');
  });

  it("Wei's visit is done and the plush he bought passed", () => {
    const claim = s.app.store.claims.first("queuer_id = 'wei'")!;
    assert.equal(claim.status, 'done');
    const jobs = s.app.store.jobs.where("queuer_id = 'wei'");
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.status, 'shipped');
  });

  it('refuses a second one-per-customer plush for Mia once hers was bought (D-132)', async () => {
    const NY = { mode: 'ship', country: 'US', region: 'NY', city: 'New York', postalCode: '10012' };
    const quote = await s.call('POST', '/api/bids/quote', { as: 'mia', body: { shopId: HERO.shopId, itemId: HERO.itemId, qty: 1, destination: NY } });
    assert.equal(quote.status, 400);
    assert.equal(quote.json.error.code, 'OVER_STORE_LIMIT');
    assert.match(quote.json.error.message, /at most 1 Mochi Bunny plush per person, and you already have one requested or bought/);
    const bid = await s.call('POST', '/api/bids', {
      as: 'mia',
      idem: 'mia-second-plush',
      body: { shopId: HERO.shopId, itemId: HERO.itemId, qty: 1, retailCapCents: 3600, maxFeeCents: 1200, shippingBudgetCents: 1200, destination: NY, deadlineAt: sf('14:05') + 86_400_000, funding: 'paypal', agent: null },
    });
    assert.equal(bid.status, 400);
    assert.equal(bid.json.error.code, 'OVER_STORE_LIMIT');
  });

  it("stops Wei's fee clock on the ops board at the $12 match, not at the $8 floor (D-132)", async () => {
    const wei = s.app.store.asks.first("queuer_id = 'wei'")!;
    assert.notEqual(wei.status, 'open');
    const board = (await s.call('GET', `/api/ops/board?cityId=sf&from=${sf('10:00')}&to=${sf('15:00')}`)).json;
    const clock = board.events.find((e: { kind: string; refs: { askId?: string } }) => e.kind === 'fee_clock' && e.refs.askId === wei.id);
    assert.ok(clock, "Wei's fee clock is on the board");
    assert.equal(clock.startDate, sf('10:50'));
    // The match at 11:05 took his only unit; the floor ($8) would have been 11:25.
    assert.equal(clock.endDate, sf('11:05'));
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

describe('hero script with a request Mia placed in the web app before Play (D-132)', () => {
  let s: TestServer;
  before(async () => {
    s = await testServer({ demo: true, crowd: true });
    await s.director!.reset('hero', null);
    s.app.clock.pause();
    // The judge's own request on a fresh market: the web app's default $12 max fee, shipped to New York.
    const NY = { mode: 'ship', country: 'US', region: 'NY', city: 'New York', postalCode: '10012' };
    const quote = (await s.call('POST', '/api/bids/quote', { as: 'mia', body: { shopId: HERO.shopId, itemId: HERO.itemId, qty: 1, destination: NY } })).json;
    const created = (
      await s.call('POST', '/api/bids', {
        as: 'mia',
        idem: 'mia-before-play',
        body: { shopId: HERO.shopId, itemId: HERO.itemId, qty: 1, retailCapCents: quote.suggested.retailCapCents, maxFeeCents: 1200, shippingBudgetCents: quote.suggested.shippingBudgetCents, destination: NY, deadlineAt: s.app.now() + 2 * 86_400_000, funding: 'paypal', agent: null },
      })
    ).json;
    await s.call('POST', `/api/fake/paypal/orders/${created.checkout.orderId}/approve`, { body: { funding: 'paypal', outcome: 'approve' } });
    await s.call('POST', `/api/bids/${created.bid.id}/authorize`, { as: 'mia', body: { orderId: created.checkout.orderId } });
    s.director!.resume();
    s.app.clock.pause();
    await s.at(sf('14:05'));
  });
  after(() => s.done());

  it('runs the day with her request instead of a second one, to the same ledger', () => {
    const mine = s.app.store.bids.where('requester_id = ? AND item_id = ?', 'mia', HERO.itemId);
    assert.equal(mine.length, 1, 'one plush request for Mia');
    const hold = s.app.store.holds.must(mine[0]!.holdId!);
    assert.deepEqual([hold.amount.cents, hold.capturedCents, hold.releasedCents, hold.status], [6370, 5826, 544, 'captured']);
    assert.equal(s.director!.state().status, 'finished');
  });
});
