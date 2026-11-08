import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '@holdmyspot/shared';
import { authorizeBid, claimBid, cancelBid, createBid, quoteBid } from '../src/app/bids.ts';
import { markBought, reportSoldOut, submitProof } from '../src/app/jobs.ts';
import { bookSnapshot } from '../src/app/market.ts';
import { ITEM, DAY, SHOP, MIN, NY_SHIP, checkInAt, persona, placeBid, postAsk, testServer, upload, type TestServer } from './helpers.ts';

const code = (err: unknown) => (err instanceof ContractError ? err.code : String(err));

describe('order book: price-time priority and partial fills', () => {
  let s: TestServer;
  before(async () => {
    s = await testServer();
  });
  after(() => s.done());

  it('fills the highest max fee first, then the earliest at the same fee, at the ask fee', async () => {
    const t0 = s.app.now();
    const mia = await placeBid(s.app, 'mia', { qty: 2, maxFeeCents: 1200 });
    await s.at(t0 + MIN);
    const jun = await placeBid(s.app, 'jun', { qty: 1, maxFeeCents: 1400 });
    await s.at(t0 + 2 * MIN);
    const priya = await placeBid(s.app, 'priya', { qty: 1, maxFeeCents: 1200 });
    const { matches, ask } = await postAsk(s.app, 'wei', { capacity: 3, feeCents: 1100 });

    assert.deepEqual(
      matches.map((m) => [m.bidId, m.qty, m.feeCents, m.trigger]),
      [
        [jun.bid.id, 1, 1100, 'new_ask'],
        [mia.bid.id, 2, 1100, 'new_ask'],
      ],
    );
    assert.equal(s.app.store.bids.must(priya.bid.id).remainingQty, 1);
    assert.equal(s.app.store.bids.must(mia.bid.id).status, 'matched');
    assert.equal(s.app.store.asks.must(ask.id).status, 'filled');
    const jobs = s.app.store.jobs.where('ask_id = ?', ask.id);
    assert.equal(jobs.length, 2);
    for (const j of jobs) {
      assert.equal(j.status, 'claimed');
      assert.ok(j.proofCode && j.proofCode.length === 5);
      assert.equal(j.fx, null, 'US shops: receipts in dollars, no exchange rate');
    }
    // Per-job caps: retail cap x qty, matched fee x qty, shipping budget in proportion.
    const miaJob = jobs.find((j) => j.bidId === mia.bid.id)!;
    // Plus the most processing the job's two captures can carry at their caps (D-105).
    assert.deepEqual(miaJob.caps, { retailCents: 5600, feeCents: 2200, shippingCents: 3500, processingCents: 562 });
    const book = bookSnapshot(s.app, ITEM);
    assert.equal(book.bids.count, 1);
    assert.equal(book.bids.bestFeeCents, 1200);
    assert.equal(book.lastFill?.feeCents, 1100);
  });
});

describe('order book: one bid across several asks', () => {
  it('takes the cheapest asks first and creates one job per fill', async () => {
    const s = await testServer();
    try {
      await postAsk(s.app, 'rin', { capacity: 1, feeCents: 1000 });
      await postAsk(s.app, 'lin', { capacity: 1, feeCents: 1100 });
      await postAsk(s.app, 'jo', { capacity: 2, feeCents: 1300 });
      const { matches, bid } = await placeBid(s.app, 'mia', { qty: 2, maxFeeCents: 1200 });
      assert.deepEqual(
        matches.map((m) => [s.app.store.asks.must(m.askId).queuerId, m.qty, m.feeCents, m.trigger]),
        [
          ['rin', 1, 1000, 'new_bid'],
          ['lin', 1, 1100, 'new_bid'],
        ],
      );
      assert.equal(s.app.store.bids.must(bid.id).status, 'matched');
      assert.equal(s.app.store.jobs.where('bid_id = ?', bid.id).length, 2);
    } finally {
      await s.done();
    }
  });
});

describe('fee clock (starts at check-in)', () => {
  it('stays at the opening fee until check-in, then fills resting bids at each step', async () => {
    const s = await testServer();
    try {
      const top = await placeBid(s.app, 'jun', { qty: 1, maxFeeCents: 1400 });
      const mia = await placeBid(s.app, 'mia', { qty: 2, maxFeeCents: 1200 });
      const low = await placeBid(s.app, 'priya', { qty: 1, maxFeeCents: 950 });
      const t0 = s.app.now();
      const { ask, claim } = await postAsk(s.app, 'wei', {
        capacity: 6,
        feeCents: 1500,
        clock: { stepCents: 100, intervalMs: 5 * MIN, floorCents: 800 },
        etaInMin: 15,
      });
      // En route: the clock has not started, nothing at $15 matches, time passing changes nothing.
      await s.at(t0 + 14 * MIN);
      assert.equal(s.app.store.matches.count(), 0);

      await checkInAt(s.app, 'wei', claim.id, SHOP.lngLat);
      const started = s.app.store.asks.must(ask.id).clock!.startsAt!;
      assert.equal(started, t0 + 14 * MIN);
      assert.equal(s.app.store.claims.must(claim.id).status, 'checked_in');

      await s.at(started + 31 * MIN);
      const fills = s.app.store.matches.where('ask_id = ?', ask.id).map((m) => ({ bid: m.bidId, qty: m.qty, fee: m.feeCents, at: m.at - started, trigger: m.trigger }));
      assert.deepEqual(fills, [
        { bid: top.bid.id, qty: 1, fee: 1400, at: 5 * MIN, trigger: 'clock_step' },
        { bid: mia.bid.id, qty: 2, fee: 1200, at: 15 * MIN, trigger: 'clock_step' },
        { bid: low.bid.id, qty: 1, fee: 900, at: 30 * MIN, trigger: 'clock_step' },
      ]);
      // Matched after check-in: jobs go straight to queueing.
      for (const j of s.app.store.jobs.where('ask_id = ?', ask.id)) assert.equal(j.status, 'queueing');
    } finally {
      await s.done();
    }
  });
});

describe('direct claims and compatibility', () => {
  it("a claim takes the target bid at its max fee, even with a cheaper ask resting", async () => {
    const s = await testServer();
    try {
      await postAsk(s.app, 'lin', { capacity: 1, feeCents: 1300 });
      const priya = await placeBid(s.app, 'priya', { qty: 1, maxFeeCents: 1100 });
      const rex = persona(s.app, 'rex');
      const out = await s.app.exec(() =>
        claimBid(s.app, rex, priya.bid.id, { qty: 1, etaAt: s.app.now() + 20 * MIN, modes: ['ship'], from: { lngLat: rex.home!, accuracyM: 12 } }),
      );
      assert.equal(out.match.feeCents, 1100);
      assert.equal(out.match.trigger, 'claim');
      assert.equal(out.ask.origin, 'claim');
      assert.equal(out.ask.targetBidId, priya.bid.id);
      assert.equal(s.app.store.bids.must(priya.bid.id).status, 'matched');
      // The claim-ask cannot fill anyone else.
      const other = await placeBid(s.app, 'mia', { qty: 1, maxFeeCents: 1500 });
      assert.deepEqual(
        other.matches.map((m) => s.app.store.asks.must(m.askId).queuerId),
        ['lin'],
      );
    } finally {
      await s.done();
    }
  });

  it('never matches an ask whose ETA is after the bid deadline', async () => {
    const s = await testServer();
    try {
      await placeBid(s.app, 'mia', { qty: 1, maxFeeCents: 1500, deadlineAt: s.app.now() + 10 * MIN });
      const { matches } = await postAsk(s.app, 'wei', { capacity: 1, feeCents: 1000, etaInMin: 20 });
      assert.equal(matches.length, 0);
    } finally {
      await s.done();
    }
  });

  it('refuses asks from too far away, below the reliability floor or above the store limit', async () => {
    const s = await testServer();
    try {
      const wei = persona(s.app, 'wei');
      const base = { shopId: SHOP.id, itemId: ITEM, capacity: 1, modes: ['ship' as const], feeCents: 1000, clock: null, etaAt: s.app.now() + 20 * MIN };
      const { createAsk } = await import('../src/app/asks.ts');
      assert.equal(code(await s.app.exec(() => createAsk(s.app, wei, { ...base, from: { lngLat: [121.6, 25.09], accuracyM: 10 } })).catch((e) => e)), 'OUT_OF_RANGE');
      assert.equal(code(await s.app.exec(() => createAsk(s.app, wei, { ...base, capacity: 7, from: { lngLat: wei.home!, accuracyM: 10 } })).catch((e) => e)), 'OVER_STORE_LIMIT');
      assert.equal(code(await s.app.exec(() => createAsk(s.app, wei, { ...base, feeCents: 400, from: { lngLat: wei.home!, accuracyM: 10 } })).catch((e) => e)), 'FEE_BELOW_MINIMUM');
      // A queuer who cannot get there by the ETA cannot promise it.
      assert.equal(code(await s.app.exec(() => createAsk(s.app, wei, { ...base, etaAt: s.app.now() + MIN, from: { lngLat: wei.home!, accuracyM: 10 } })).catch((e) => e)), 'BAD_REQUEST');
      // Drop Rex below 60 and he cannot post.
      s.app.tx(() => {
        const doc = s.app.store.users.must('rex');
        doc.user = { ...doc.user, reliability: { ...doc.user.reliability!, score: 55 } };
        s.app.store.users.update(doc);
      });
      const rex = persona(s.app, 'rex');
      assert.equal(code(await s.app.exec(() => createAsk(s.app, rex, { ...base, from: { lngLat: rex.home!, accuracyM: 10 } })).catch((e) => e)), 'RELIABILITY_TOO_LOW');
    } finally {
      await s.done();
    }
  });

  it('refuses bids that break the store limit, the retail cap or the deadline window', async () => {
    const s = await testServer();
    try {
      const mia = persona(s.app, 'mia');
      const base = {
        shopId: SHOP.id,
        itemId: ITEM,
        qty: 2,
        retailCapCents: 2800,
        maxFeeCents: 1200,
        shippingBudgetCents: 3500,
        destination: NY_SHIP,
        deadlineAt: s.app.now() + DAY,
        funding: 'paypal' as const,
        agent: null,
      };
      const attempt = (over: object) => s.app.exec(() => createBid(s.app, mia, { ...base, ...over })).catch((e) => e);
      assert.equal(code(await attempt({ qty: 7 })), 'OVER_STORE_LIMIT');
      assert.equal(code(await attempt({ retailCapCents: 2500 })), 'RETAIL_CAP_TOO_LOW');
      assert.equal(code(await attempt({ maxFeeCents: 300 })), 'FEE_BELOW_MINIMUM');
      assert.equal(code(await attempt({ deadlineAt: s.app.now() + 11 * DAY })), 'DEADLINE_OUT_OF_RANGE');
      assert.equal(code(await attempt({ destination: { mode: 'local', cityId: 'nyc' } })), 'MODE_NOT_ALLOWED');
      assert.equal(code(await attempt({ shippingBudgetCents: 0 })), 'BAD_REQUEST');
    } finally {
      await s.done();
    }
  });
});

describe('failures re-offer quantity', () => {
  it('a rejected receipt sends the quantity back to the book, where the next ask takes it', async () => {
    const s = await testServer();
    try {
      const mia = await placeBid(s.app, 'mia', { qty: 1, maxFeeCents: 1200 });
      const wei = await postAsk(s.app, 'wei', { capacity: 1, feeCents: 1200, etaInMin: 10 });
      assert.equal(wei.matches.length, 1);
      await postAsk(s.app, 'lin', { capacity: 1, feeCents: 1100, etaInMin: 10 });
      await checkInAt(s.app, 'wei', wei.claim.id, SHOP.lngLat);
      const job = s.app.store.jobs.where('ask_id = ?', wei.ask.id)[0]!;
      await s.app.exec(() => markBought(s.app, persona(s.app, 'wei'), job.id));
      const r = await upload(s.app, 'wei', 'receipt', 'fake_receipt');
      const p = await upload(s.app, 'wei', 'item_photo', 'fake_receipt');
      const before = persona(s.app, 'wei').reliability!;
      await s.app.exec(() => submitProof(s.app, persona(s.app, 'wei'), job.id, { receiptFileId: r.id, itemFileId: p.id }));
      await s.app.idle();

      const failed = s.app.store.jobs.must(job.id);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.failure?.reason, 'proof_rejected');
      assert.equal(failed.amounts.capturedCents, 0);
      const proof = s.app.store.proofs.first('job_id = ?', job.id)!;
      assert.equal(proof.status, 'failed');
      assert.deepEqual(proof.checks.filter((c) => !c.ok).map((c) => c.code), ['shop_match', 'time_window', 'totals_add_up']);
      const requeued = s.app.store.matches.where('bid_id = ?', mia.bid.id).at(-1)!;
      assert.equal(requeued.trigger, 'requeue');
      assert.equal(s.app.store.asks.must(requeued.askId).queuerId, 'lin');
      assert.equal(requeued.feeCents, 1100);
      assert.equal(persona(s.app, 'wei').reliability!.proofsRejected, before.proofsRejected + 1);
      assert.equal(s.app.store.ledger.where("bid_id = ? AND kind = 'captured'", mia.bid.id).length, 0);
    } finally {
      await s.done();
    }
  });

  it('a claim that never checks in lapses: no-show, quantity re-offered, reliability down', async () => {
    const s = await testServer();
    try {
      const mia = await placeBid(s.app, 'mia', { qty: 1, maxFeeCents: 1200 });
      const wei = await postAsk(s.app, 'wei', { capacity: 1, feeCents: 1200, etaInMin: 10 });
      const lapsedBefore = persona(s.app, 'wei').reliability!.claimsLapsed;
      await s.at(wei.claim.windowEndsAt + 1);
      assert.equal(s.app.store.claims.must(wei.claim.id).status, 'lapsed');
      assert.equal(s.app.store.asks.must(wei.ask.id).status, 'lapsed');
      const job = s.app.store.jobs.where('ask_id = ?', wei.ask.id)[0]!;
      assert.equal(job.failure?.reason, 'no_show');
      assert.equal(s.app.store.bids.must(mia.bid.id).status, 'open');
      assert.equal(s.app.store.bids.must(mia.bid.id).remainingQty, 1);
      assert.equal(persona(s.app, 'wei').reliability!.claimsLapsed, lapsedBefore + 1);
      // Check-in after the window is refused.
      const { checkIn } = await import('../src/app/asks.ts');
      const photo = await upload(s.app, 'wei', 'line_photo');
      assert.equal(
        code(await s.app.exec(() => checkIn(s.app, persona(s.app, 'wei'), wei.claim.id, { lngLat: SHOP.lngLat, accuracyM: 5, photoFileId: photo.id })).catch((e) => e)),
        'INVALID_TRANSITION',
      );
    } finally {
      await s.done();
    }
  });

  it("a requester cancelling before the queuer arrives frees the queuer's capacity and voids the hold", async () => {
    const s = await testServer();
    try {
      const mia = await placeBid(s.app, 'mia', { qty: 2, maxFeeCents: 1200 });
      const wei = await postAsk(s.app, 'wei', { capacity: 3, feeCents: 1100 });
      assert.equal(s.app.store.asks.must(wei.ask.id).remainingCapacity, 1);
      const out = await s.app.exec(() => cancelBid(s.app, { userId: 'mia', ops: false }, mia.bid.id));
      assert.equal(out.bid.status, 'cancelled');
      assert.equal(out.hold.status, 'released');
      assert.equal(out.hold.releasedCents, 12_222);
      assert.equal(s.app.store.asks.must(wei.ask.id).remainingCapacity, 3);
      assert.equal(s.app.store.asks.must(wei.ask.id).status, 'open');
      const released = s.app.store.ledger.where("bid_id = ? AND kind = 'released'", mia.bid.id);
      assert.deepEqual(released.map((e) => [e.amount.cents, e.status, e.idempotencyKey]), [[12_222, 'succeeded', `void:${mia.bid.holdId}`]]);
      assert.equal(s.app.fakePayPal.inspectAuthorization(out.hold.authorizationId!)?.status, 'VOIDED');
    } finally {
      await s.done();
    }
  });

  it('sold out (D-152): one report ends only the reporter\'s job; a second checked-in queuer\'s report fails unbought jobs, closes open requests and voids their holds', async () => {
    const s = await testServer();
    try {
      const mia = await placeBid(s.app, 'mia', { qty: 1, maxFeeCents: 1200 });
      const jun = await placeBid(s.app, 'jun', { qty: 1, maxFeeCents: 600 });
      // Priya's request waits in PayPal's window while the line sells out.
      const shipTo = { qty: 1, retailCapCents: 2800, maxFeeCents: 1000, shippingBudgetCents: 3500, destination: NY_SHIP, funding: 'paypal' as const, agent: null };
      const pending = await s.app.exec(() =>
        createBid(s.app, persona(s.app, 'priya'), { shopId: SHOP.id, itemId: ITEM, deadlineAt: s.app.now() + DAY, ...shipTo }),
      );
      await s.app.fakePayPal.approveOrder(pending.checkout.orderId, 'paypal', 'approve');
      const wei = await postAsk(s.app, 'wei', { capacity: 1, feeCents: 1100, etaInMin: 10 });
      await checkInAt(s.app, 'wei', wei.claim.id, SHOP.lngLat);
      const job = s.app.store.jobs.where('ask_id = ?', wei.ask.id)[0]!;
      const first = await s.app.exec(() => reportSoldOut(s.app, persona(s.app, 'wei'), job.id, null));
      // One person's word closes nothing else: Wei's own job ends and Mia's request goes back on the book, still held.
      assert.equal(first.book.status, 'open');
      assert.equal(s.app.store.jobs.must(job.id).failure?.reason, 'sold_out');
      assert.equal(s.app.store.asks.must(wei.ask.id).status, 'closed');
      const back = s.app.store.bids.must(mia.bid.id);
      assert.deepEqual([back.status, back.remainingQty, back.closeReason], ['open', 1, null]);
      assert.equal(s.app.store.holds.must(back.holdId!).status, 'held');
      assert.equal(s.app.store.holds.must(s.app.store.bids.must(jun.bid.id).holdId!).status, 'held');
      // A second queuer takes Mia's request, checks in and confirms: now the book is sold out.
      const lin = await postAsk(s.app, 'lin', { capacity: 1, feeCents: 1100, etaInMin: 10 });
      await checkInAt(s.app, 'lin', lin.claim.id, SHOP.lngLat);
      const linJob = s.app.store.jobs.where('ask_id = ?', lin.ask.id)[0]!;
      // The same queuer reporting again (refused once his claim ended, or counted once) never closes the book alone.
      await s.app.exec(() => reportSoldOut(s.app, persona(s.app, 'wei'), job.id, null)).catch(() => null);
      assert.equal(s.app.store.books.get(ITEM)?.status, 'open');
      const out = await s.app.exec(() => reportSoldOut(s.app, persona(s.app, 'lin'), linJob.id, null));
      assert.equal(out.book.status, 'sold_out');
      assert.equal(s.app.store.jobs.must(linJob.id).failure?.reason, 'sold_out');
      for (const id of [mia.bid.id, jun.bid.id]) {
        const b = s.app.store.bids.must(id);
        assert.equal(b.status, 'expired', id);
        assert.equal(b.closeReason, 'sold_out');
        assert.equal(s.app.store.holds.must(b.holdId!).status, 'released');
      }
      assert.equal(code(await postAsk(s.app, 'rex').catch((e) => e)), 'SOLD_OUT');
      // No new request either (D-116): the quote and the bid are refused, so no hold opens on a book
      // that can never fill, and an approval that lands after the sell-out authorizes nothing.
      const quote = await s.app.exec(() => quoteBid(s.app, persona(s.app, 'sam'), { shopId: SHOP.id, itemId: ITEM, qty: 1, destination: NY_SHIP })).catch((e) => e);
      assert.equal(code(quote), 'SOLD_OUT');
      assert.equal(code(await placeBid(s.app, 'sam', { qty: 1 }).catch((e) => e)), 'SOLD_OUT');
      const late = await s.app.exec(() => authorizeBid(s.app, { userId: 'priya', ops: false }, pending.bid.id, pending.checkout.orderId)).catch((e) => e);
      assert.equal(code(late), 'SOLD_OUT');
      const refused = s.app.store.bids.must(pending.bid.id);
      assert.deepEqual([refused.status, refused.closeReason], ['failed', 'sold_out']);
      assert.equal(s.app.store.holds.must(refused.holdId!).status, 'failed');
      assert.deepEqual(s.app.store.ledger.where('bid_id = ?', refused.id), [], 'nothing held, nothing to release');
      assert.equal(s.app.store.bids.where("item_id = ? AND status IN ('open', 'partially_matched', 'matched')", ITEM).length, 0);
    } finally {
      await s.done();
    }
  });

  it('requests expire at their deadline and bids without approval fail after 3 hours', async () => {
    const s = await testServer();
    try {
      const t0 = s.app.now();
      const mia = await placeBid(s.app, 'mia', { qty: 1, maxFeeCents: 1200, deadlineAt: t0 + 60 * MIN });
      const pending = await s.app.exec(() =>
        createBid(s.app, persona(s.app, 'jun'), {
          shopId: SHOP.id,
          itemId: ITEM,
          qty: 1,
          retailCapCents: 2800,
          maxFeeCents: 1000,
          shippingBudgetCents: 2500,
          destination: NY_SHIP,
          deadlineAt: t0 + DAY,
          funding: 'paypal',
          agent: null,
        }),
      );
      await s.at(t0 + 61 * MIN);
      const b = s.app.store.bids.must(mia.bid.id);
      assert.equal(b.status, 'expired');
      assert.equal(b.closeReason, 'deadline');
      assert.equal(s.app.store.holds.must(b.holdId!).releasedCents, b.limitCents);
      await s.at(t0 + 3 * 60 * MIN + 1);
      assert.equal(s.app.store.bids.must(pending.bid.id).status, 'failed');
      assert.equal(s.app.store.holds.must(pending.bid.holdId!).status, 'failed');
    } finally {
      await s.done();
    }
  });
});
