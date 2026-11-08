import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PROCESSING_LABEL, bidLimitCents, jobSettlement, paypalCaptureFeeCents, platformFeeCents, seeded } from '@holdmyspot/shared';
import type { CaptureResult, CreateOrderInput } from '@holdmyspot/shared/ports';
import { opsDataset } from '../src/app/ops.ts';
import { addShipment, markBought, reportSoldOut, submitProof } from '../src/app/jobs.ts';
import { MIN, SHOP, checkInAt, persona, placeBid, postAsk, sum, testServer, upload, type TestServer } from './helpers.ts';

/**
 * Processing and payouts at cost (docs/DECISIONS.md D-105), end to end on the
 * emulator: every completed job leaves HoldMySpot exactly 10% of its queue
 * fee, PayPal's fees are read from PayPal's own answers and equal the
 * processing line to the cent, a job that captures nothing costs everyone $0,
 * and no capture ever passes the hold.
 */

type Real = (...args: unknown[]) => Promise<unknown>;

/** Wraps one method of the fake PayPal port. */
function wrap(s: TestServer, method: string, fn: (real: Real, args: unknown[]) => Promise<unknown>): void {
  const fake = s.app.fakePayPal as unknown as Record<string, unknown>;
  const real = (fake[method] as Real).bind(s.app.fakePayPal);
  fake[method] = (...args: unknown[]) => fn(real, args);
}

/** One queuer fills `qty` of a fresh bid at `fee`, checks in, buys, and the receipt passes (or not). */
async function verifiedJob(s: TestServer, o: { qty?: number; fee?: number; scenario?: string; queuer?: string } = {}) {
  const queuer = o.queuer ?? 'wei';
  const placed = await placeBid(s.app, 'mia', { qty: o.qty ?? 2, maxFeeCents: 1200 });
  const ask = await postAsk(s.app, queuer, { capacity: o.qty ?? 2, feeCents: o.fee ?? 1200, etaInMin: 10 });
  await checkInAt(s.app, queuer, ask.claim.id, SHOP.lngLat);
  const job = s.app.store.jobs.where('bid_id = ?', placed.bid.id)[0]!;
  await s.app.exec(() => markBought(s.app, persona(s.app, queuer), job.id));
  await s.at(s.app.now() + 40 * MIN);
  const r = await upload(s.app, queuer, 'receipt', o.scenario ?? 'genuine');
  const p = await upload(s.app, queuer, 'item_photo', o.scenario ?? 'genuine');
  await s.app.exec(() => submitProof(s.app, persona(s.app, queuer), job.id, { receiptFileId: r.id, itemFileId: p.id }));
  await s.app.idle();
  return { bid: s.app.store.bids.must(placed.bid.id), job: s.app.store.jobs.must(job.id) };
}

const ship = (cents: number, n = 1) => ({ carrierName: 'Harbor Parcel Ground', trackingNumber: `HPG-PROC-${n}`, shippingCostCents: cents, dutyPaidCents: 0, labelFileId: null });

describe('processing and payouts at cost (D-105)', () => {
  it("ship-to-me: PayPal's fees, read from its own answers, equal the processing line and HoldMySpot keeps 10% of the fee", async () => {
    const s = await testServer();
    try {
      const { job } = await verifiedJob(s);
      await s.app.exec(() => addShipment(s.app, persona(s.app, 'wei'), job.id, ship(2440)));
      const done = s.app.store.jobs.must(job.id);
      const captures = s.app.store.ledger.where("job_id = ? AND kind = 'captured'", job.id);
      assert.equal(captures.length, 2);
      for (const c of captures) {
        // The fee on the ledger line is the one in PayPal's seller_receivable_breakdown for that capture.
        const answer = await s.app.fakePayPal.getCapture(c.paypal!.captureId!);
        assert.equal(c.paypal?.feeCents, answer.paypalFeeCents);
        assert.equal(answer.paypalFeeCents, paypalCaptureFeeCents(c.amount.cents));
      }
      assert.deepEqual(s.app.store.payouts.where('job_id = ?', done.id).map((p) => p.paypalFeeCents), [25, 25]);
      const money = jobSettlement(done.amounts);
      assert.equal(money.processingVarianceCents, 0);
      assert.equal(money.paypalFeesCents, money.processingCents);
      assert.equal(money.platformCents, platformFeeCents(2400));
      assert.equal(money.chargedCents, 5200 + 2400 + 2440 + money.processingCents, 'shop price, fees, shipping and processing');
    } finally {
      await s.done();
    }
  });

  it('a rejected receipt and a sold-out line capture nothing: $0 to PayPal, $0 kept, every hold released', async () => {
    const s = await testServer();
    try {
      const rejected = await verifiedJob(s, { qty: 1, scenario: 'fake_receipt' });
      assert.equal(rejected.job.status, 'failed');
      assert.equal(rejected.job.failure?.reason, 'proof_rejected');
      assert.deepEqual(jobSettlement(rejected.job.amounts), { chargedCents: 0, processingCents: 0, paidOutCents: 0, paypalFeesCents: 0, platformCents: 0, processingVarianceCents: 0 });

      // The re-offered request and a second one wait; Lin checks in and reports the plush sold out, and Ava confirms.
      const other = await placeBid(s.app, 'jun', { qty: 1, maxFeeCents: 1000 });
      const lin = await postAsk(s.app, 'lin', { capacity: 2, feeCents: 1000, etaInMin: 10 });
      await checkInAt(s.app, 'lin', lin.claim.id, SHOP.lngLat);
      const linJob = s.app.store.jobs.where("ask_id = ? AND status = 'queueing'", lin.ask.id)[0]!;
      await s.app.exec(() => reportSoldOut(s.app, persona(s.app, 'lin'), linJob.id, null));
      // One report ends only Lin's jobs (D-152); Ava takes both requests, checks in and confirms the sell-out.
      const ava = await postAsk(s.app, 'ava', { capacity: 2, feeCents: 1000, etaInMin: 20 });
      await checkInAt(s.app, 'ava', ava.claim.id, SHOP.lngLat);
      const avaJob = s.app.store.jobs.where("ask_id = ? AND status = 'queueing'", ava.ask.id)[0]!;
      await s.app.exec(() => reportSoldOut(s.app, persona(s.app, 'ava'), avaJob.id, null));
      for (const bidId of [rejected.bid.id, other.bid.id]) {
        const hold = s.app.store.holds.must(s.app.store.bids.must(bidId).holdId!);
        assert.equal(hold.status, 'released');
        assert.equal(hold.capturedCents, 0);
        assert.equal(hold.releasedCents, hold.amount.cents);
        assert.equal(s.app.fakePayPal.captureCount(hold.authorizationId!), 0, 'PayPal never captured, so it charged no fee');
      }
      assert.equal(s.app.store.payouts.count(), 0);
      for (const j of s.app.store.jobs.all()) assert.equal(jobSettlement(j.amounts).platformCents, 0);
    } finally {
      await s.done();
    }
  });

  it('shows the processing reserve on the PayPal order as its own line', async () => {
    const s = await testServer();
    try {
      let sent: CreateOrderInput | null = null;
      wrap(s, 'createOrder', async (real, args) => {
        sent = args[0] as CreateOrderInput;
        return real(...args);
      });
      const placed = await placeBid(s.app, 'mia', { qty: 2, maxFeeCents: 1200 });
      const order = sent as CreateOrderInput | null;
      assert.ok(order);
      const limit = bidLimitCents({ qty: 2, retailCapCents: 2800, maxFeeCents: 1200, shippingBudgetCents: 3500 });
      assert.equal(placed.hold.amount.cents, limit);
      assert.equal(order.amountCents, limit);
      assert.deepEqual(
        order.items.map((i) => [i.name, i.quantity, i.unitAmountCents]),
        [
          ['Lucky Cat plush, launch-day drop (shop price, up to)', 2, 2800],
          ['Queue fee (up to)', 2, 1200],
          [`${PROCESSING_LABEL}, at cost (up to)`, 1, limit - 2 * 4000 - 3500],
        ],
      );
      assert.equal(order.breakdown.itemTotalCents + order.breakdown.shippingCents, order.amountCents);
    } finally {
      await s.done();
    }
  });

  it("flags a fee PayPal reports differently: the job's variance and the platform's share move by exactly that much", async () => {
    const s = await testServer();
    try {
      // PayPal reports 10 cents less on every capture than the published rate.
      wrap(s, 'captureAuthorization', async (real, args) => {
        const r = (await real(...args)) as CaptureResult;
        return { ...r, paypalFeeCents: (r.paypalFeeCents ?? 0) - 10 };
      });
      const { job } = await verifiedJob(s);
      await s.app.exec(() => addShipment(s.app, persona(s.app, 'wei'), job.id, ship(2440)));
      const money = jobSettlement(s.app.store.jobs.must(job.id).amounts);
      assert.equal(money.processingVarianceCents, 20, 'two captures, 10 cents each');
      assert.equal(money.platformCents, platformFeeCents(2400) + 20, 'held for the requester until ops refunds it');
      const row = opsDataset(s.app, 'jobs').rows.find((r) => r.jobId === job.id)!;
      assert.equal(row.platformUsd, (platformFeeCents(2400) + 20) / 100);
      assert.equal(Math.round((row.processingUsd as number) * 100) - Math.round((row.paypalFeesUsd as number) * 100), 20);
    } finally {
      await s.done();
    }
  });

  it('never captures past the hold, however the units split between queuers, and every job leaves exactly 10% of its fee', async () => {
    const rnd = seeded(105);
    const queuers = ['wei', 'lin', 'rin'];
    for (let round = 0; round < 4; round++) {
      const s = await testServer();
      try {
        const qty = 2 + Math.floor(rnd() * 5); // 2 to 6, the shop's per-person limit
        const placed = await placeBid(s.app, 'mia', { qty, maxFeeCents: 1500 });
        let left = qty;
        for (const q of queuers) {
          if (left === 0) break;
          const capacity = q === 'rin' ? left : Math.max(1, Math.min(left, 1 + Math.floor(rnd() * left)));
          const fee = 800 + Math.floor(rnd() * 15) * 50; // $8.00 to $15.00
          const ask = await postAsk(s.app, q, { capacity, feeCents: fee, etaInMin: 10 });
          await checkInAt(s.app, q, ask.claim.id, SHOP.lngLat);
          left -= capacity;
        }
        await s.at(s.app.now() + 40 * MIN);
        const jobs = s.app.store.jobs.where('bid_id = ?', placed.bid.id);
        assert.equal(sum(jobs.map((j) => j.qty)), qty);
        let n = 0;
        for (const j of jobs) {
          const queuer = persona(s.app, j.queuerId);
          await s.app.exec(() => markBought(s.app, queuer, j.id));
          const r = await upload(s.app, j.queuerId, 'receipt', 'genuine');
          const p = await upload(s.app, j.queuerId, 'item_photo', 'genuine');
          await s.app.exec(() => submitProof(s.app, queuer, j.id, { receiptFileId: r.id, itemFileId: p.id }));
          await s.app.idle();
          const label = Math.floor(rnd() * (s.app.store.jobs.must(j.id).caps.shippingCents + 1));
          await s.app.exec(() => addShipment(s.app, queuer, j.id, ship(label, ++n)));
        }
        const hold = s.app.store.holds.must(placed.bid.holdId!);
        assert.ok(hold.capturedCents <= hold.amount.cents, `round ${round}: captured ${hold.capturedCents} of ${hold.amount.cents}`);
        assert.equal(hold.capturedCents + hold.releasedCents, hold.amount.cents);
        assert.equal(s.app.store.ledger.count("kind = 'captured' AND status = 'failed'"), 0, 'no capture was refused');
        for (const j of s.app.store.jobs.where('bid_id = ?', placed.bid.id)) {
          const money = jobSettlement(j.amounts);
          assert.equal(money.platformCents, platformFeeCents(j.feeCents * j.qty), `round ${round}, job ${j.id}`);
          assert.equal(money.processingVarianceCents, 0);
        }
      } finally {
        await s.done();
      }
    }
  });
});

describe('the local-errand demo script (D-105)', () => {
  it('holds $51.54, captures $49.47 at the handover ($47.00 plus $2.47 processing), pays Dana $46.10 and keeps $0.90', async () => {
    const s = await testServer({ demo: true });
    try {
      await s.director!.start('local-errand', null);
      s.app.clock.pause();
      await s.at(Date.parse('2026-11-12T10:35:00-05:00'));
      assert.equal(s.director!.state().status, 'finished');
      const job = s.app.store.jobs.first("queuer_id = 'dana'")!;
      assert.equal(job.status, 'delivered');
      const hold = s.app.store.holds.must(s.app.store.bids.must(job.bidId).holdId!);
      assert.deepEqual([hold.amount.cents, hold.capturedCents, hold.releasedCents], [5154, 4947, 207]);
      assert.deepEqual(jobSettlement(job.amounts), { chargedCents: 4947, processingCents: 247, paidOutCents: 4610, paypalFeesCents: 247, platformCents: 90, processingVarianceCents: 0 });
      const cues = s.app.bus.after(0).filter((e) => e.type === 'demo.cue').map((e) => (e.data as { text: string }).text);
      assert.equal(cues.at(-1), 'Held $51.54. Charged $49.47. Dana paid $46.10.');
    } finally {
      await s.done();
    }
  });
});
