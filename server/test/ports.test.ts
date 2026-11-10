import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetMarket } from '../src/app/seed.ts';
import { loadConfig } from '../src/config.ts';
import { FakeAi } from '../src/fakes/ai.ts';
import { createFakePayPal } from '../src/paypal/fake.ts';
import { isDuplicatePayout } from '../src/paypal/errors.ts';
import { parseInvoiceId } from '../src/paypal/status.ts';
import { loadAi } from '../src/ports/load.ts';
import { runScoped } from '../src/ports/runscope.ts';
import { AI_KEY_ENV, DAY, MIN, placeBid, testServer } from './helpers.ts';

/**
 * How the real services plug in through their ports (docs/DECISIONS.md D-47, D-48):
 * fake mode's PayPal is the sandbox REST client on the in-process emulator,
 * saved in SQLite; the AI services load by default and need no key.
 */

describe('PayPal port in fake mode', () => {
  it('keeps every authorization across a restart (emulator state lives in SQLite)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hms-ports-'));
    const dbPath = join(dir, 'market.sqlite');
    try {
      const a = await testServer({ dbPath });
      const placed = await placeBid(a.app, 'mia', { qty: 1, maxFeeCents: 1200 });
      const authId = a.app.store.holds.must(placed.bid.holdId!).authorizationId!;
      await a.done();

      const b = await testServer({ dbPath });
      try {
        assert.equal(b.app.fakePayPal.inspectAuthorization(authId)?.status, 'CREATED', 'PayPal still holds the money after the restart');
        const out = await b.call('POST', `/api/bids/${placed.bid.id}/cancel`, { as: 'mia', body: { reason: 'changed my mind' } });
        assert.equal(out.status, 200, JSON.stringify(out.json));
        assert.equal(out.json.hold.status, 'released');
        assert.equal(b.app.fakePayPal.inspectAuthorization(authId)?.status, 'VOIDED');
      } finally {
        await b.done();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('forgets PayPal state with the market on a demo reset', async () => {
    const s = await testServer({ demo: true });
    try {
      const placed = await placeBid(s.app, 'mia', { qty: 1, maxFeeCents: 1200 });
      const authId = s.app.store.holds.must(placed.bid.holdId!).authorizationId!;
      await s.director!.reset('hero', null);
      assert.equal(s.app.fakePayPal.inspectAuthorization(authId), null);
      const again = await placeBid(s.app, 'mia', { qty: 1, maxFeeCents: 1200 });
      assert.equal(s.app.store.holds.must(again.bid.holdId!).authorizationId, 'FAKE-AUTH-0001', 'ids restart with the market');
    } finally {
      await s.done();
    }
  });

  it('renews a hold once by reauthorizing the original, then keeps it without a second renewal (PayPal allows one, G10)', async () => {
    const s = await testServer();
    try {
      const placed = await placeBid(s.app, 'jun', { qty: 1, maxFeeCents: 900, deadlineAt: s.app.now() + 9 * DAY });
      const h0 = s.app.store.holds.must(placed.bid.holdId!);
      await s.at(h0.honorEndsAt! + MIN);
      const h1 = s.app.store.holds.must(h0.id);
      assert.equal(h1.renewals, 1);
      assert.notEqual(h1.authorizationId, h0.authorizationId);
      await s.at(h1.honorEndsAt! + MIN);
      const h2 = s.app.store.holds.must(h0.id);
      assert.equal(h2.renewals, 1, 'no second renewal');
      assert.equal(h2.renewalRequired, false, 'the renewed hold is still valid until day 29');
      assert.equal(h2.authorizationId, h1.authorizationId);
      assert.equal(h2.originalAuthorizationId, h0.authorizationId);
      const renewed = s.app.store.ledger.where("hold_id = ? AND kind = 'renewed'", h0.id);
      assert.deepEqual(renewed.map((e) => [e.status, e.paypal?.authorizationId]), [['succeeded', h1.authorizationId]]);
      assert.equal(s.app.fakePayPal.inspectAuthorization(h1.authorizationId!)?.status, 'CREATED');
    } finally {
      await s.done();
    }
  });
});

describe('PayPal decline and a second approval over HTTP', () => {
  it('a declined authorization leaves the bid awaiting approval; the buyer approves the same order again and the hold goes through', async () => {
    const s = await testServer();
    try {
      const destination = { mode: 'ship', country: 'US', region: 'NY', city: 'New York', postalCode: '10012' };
      const created = await s.call('POST', '/api/bids', {
        as: 'mia',
        body: { shopId: 'paper-moon-toys', itemId: 'plush-paper-moon', qty: 1, retailCapCents: 3600, maxFeeCents: 1200, shippingBudgetCents: 1200, destination, deadlineAt: s.app.now() + DAY, funding: 'paypal', agent: null },
      });
      assert.equal(created.status, 200, JSON.stringify(created.json));
      const { bid, checkout } = created.json;
      await s.call('POST', `/api/fake/paypal/orders/${checkout.orderId}/approve`, { body: { funding: 'paypal', outcome: 'decline' } });
      const declined = await s.call('POST', `/api/bids/${bid.id}/authorize`, { as: 'mia', body: { orderId: checkout.orderId } });
      assert.equal(declined.status, 402);
      assert.equal(declined.json.error.code, 'PAYPAL_DECLINED');
      assert.equal(declined.json.error.details.issue, 'INSTRUMENT_DECLINED');
      assert.equal((await s.call('GET', `/api/bids/${bid.id}`, { as: 'mia' })).json.bid.status, 'awaiting_approval');
      const again = await s.call('POST', `/api/fake/paypal/orders/${checkout.orderId}/approve`, { body: { funding: 'paypal', outcome: 'approve' } });
      assert.equal(again.json.status, 'APPROVED');
      const ok = await s.call('POST', `/api/bids/${bid.id}/authorize`, { as: 'mia', body: { orderId: checkout.orderId } });
      assert.equal(ok.status, 200, JSON.stringify(ok.json));
      assert.equal(ok.json.hold.status, 'held');
      const keys = s.app.store.ledger.where('bid_id = ?', bid.id).map((e) => [e.idempotencyKey, e.status]);
      assert.deepEqual(keys, [[`auth:${bid.id}`, 'failed'], [`auth:${bid.id}:2`, 'succeeded']]);
    } finally {
      await s.done();
    }
  });
});

describe('sandbox ids per market run (a demo reset must not resend old PayPal keys)', () => {
  const order = (requestId: string, invoiceId: string) => ({
    requestId,
    invoiceId,
    customId: 'bid_0001',
    description: 'test',
    softDescriptor: 'HOLDMYSPOT',
    amountCents: 2600,
    breakdown: { itemTotalCents: 2600, shippingCents: 0 },
    items: [{ name: 'Plush', quantity: 1, unitAmountCents: 2600, category: 'PHYSICAL_GOODS' as const }],
    shipping: { type: 'SHIPPING' as const, preference: 'GET_FROM_FILE' as const },
    funding: 'paypal' as const,
    returnUrl: 'https://example.com/return',
    cancelUrl: 'https://example.com/cancel',
  });
  const payout = (senderBatchId: string) => ({
    senderBatchId,
    emailSubject: 'Payout',
    emailMessage: 'Queue fee',
    items: [{ receiverEmail: 'buyer@holdmyspot.test', amountCents: 900, note: 'fee', senderItemId: 'po_0001' }],
  });

  it('adds the run to every key and invoice id: retries in a run repeat, a new run never collides', async () => {
    const pp = createFakePayPal({ now: () => Date.parse('2026-11-12T00:30:00Z') });
    let run = 'r1';
    const port = runScoped(pp, () => run);
    const a = await port.createOrder(order('order:bid_0001', 'HMS-bid_0001'));
    const again = await port.createOrder(order('order:bid_0001', 'HMS-bid_0001'));
    assert.equal(again.orderId, a.orderId, 'the same key in the same run is an idempotent retry');
    assert.equal(pp.emulator.exportState().orders[a.orderId]?.invoiceId, 'HMS-r1-bid_0001');
    const p1 = await port.createPayout(payout('payout:job_0001:fee'));
    run = 'r2';
    const b = await port.createOrder(order('order:bid_0001', 'HMS-bid_0001'));
    assert.notEqual(b.orderId, a.orderId, "a reset market gets a new order, not the old run's");
    const p2 = await port.createPayout(payout('payout:job_0001:fee'));
    assert.notEqual(p2.batchId, p1.batchId, 'the new run pays its queuer instead of getting the old batch back');
    // Without the run, a repeated key is the first run's batch: PayPal refuses it as a duplicate (sandbox, 11-07).
    const unscoped = await pp.createPayout(payout('payout:job_0001:fee@r1')).catch((e: unknown) => e);
    assert.ok(isDuplicatePayout(unscoped), `the first run's batch id is taken (${String(p1.batchId)})`);
    assert.deepEqual(parseInvoiceId('HMS-r2-job_0001-R'), { kind: 'job', jobId: 'job_0001', part: 'receipt', n: null, run: 'r2' });
    assert.deepEqual(parseInvoiceId('HMS-r2-bid_0001'), { kind: 'bid', bidId: 'bid_0001', run: 'r2' });
  });

  it('gives each market run of the kernel its own run id, used only for the sandbox adapter', async () => {
    const s = await testServer();
    try {
      const sandbox = createFakePayPal({ now: () => s.app.now() });
      s.app.sandboxPayPal = sandbox;
      const run1 = s.app.paypalRun();
      const o1 = await s.app.payments('sandbox').createOrder(order('order:bid_0001', 'HMS-bid_0001'));
      assert.equal(sandbox.emulator.exportState().orders[o1.orderId]?.invoiceId, `HMS-${run1}-bid_0001`);
      await new Promise((r) => setTimeout(r, 2));
      await s.app.exec(() => resetMarket(s.app, { seed: 1, marketStart: s.app.now(), speed: 1, paused: true, crowd: false }));
      const run2 = s.app.paypalRun();
      assert.notEqual(run2, run1);
      const o2 = await s.app.payments('sandbox').createOrder(order('order:bid_0001', 'HMS-bid_0001'));
      assert.notEqual(o2.orderId, o1.orderId);
      const fake = await s.app.payments('fake').createOrder(order('order:bid_0001', 'HMS-bid_0001'));
      assert.equal(s.app.fakePayPal.inspectOrder(fake.orderId)?.invoiceId, 'HMS-bid_0001', 'fake mode stays unscoped');
    } finally {
      await s.done();
    }
  });
});

describe('AI port loading', () => {
  it('loads the AI services by default (rules only and replay without a key), and the in-process fake only on request', async () => {
    for (const k of AI_KEY_ENV) delete process.env[k];
    const dir = mkdtempSync(join(tmpdir(), 'hms-ai-'));
    try {
      const auto = await loadAi(loadConfig({ HMS_SECRETS_DIR: dir, HMS_DB_PATH: ':memory:' }), () => undefined);
      assert.deepEqual(auto.port.info, { provider: 'fake', model: 'rules-v1', mode: 'replay' });
      assert.equal(typeof auto.port.dHash, 'function');
      assert.equal(typeof auto.port.biddingAgent, 'function');
      assert.ok(!(auto.port instanceof FakeAi));
      const fake = await loadAi(loadConfig({ HMS_SECRETS_DIR: dir, HMS_DB_PATH: ':memory:', HMS_AI_PROVIDER: 'fake' }), () => undefined);
      assert.ok(fake.port instanceof FakeAi);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
