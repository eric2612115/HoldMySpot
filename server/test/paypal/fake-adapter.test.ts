import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CreateOrderInput } from '@holdmyspot/shared/ports';
import type { FakePaymentsControls, PaymentsPort } from '../../src/ports/payments.ts';
import { createFakePayPal, parseFailures, PayPalError, type FakePayPal, type FakePayPalOptions } from '../../src/paypal/index.ts';
import { heroOrderInput, localOrderInput } from './helpers.ts';

/**
 * The fake adapter: the sandbox REST client running against the in-process
 * emulator. These tests check PayPal's rules as the emulator copies them
 * (docs/PAYPAL-MAPPING.md section 10), through the same PayPalPort calls the
 * server makes. No network.
 */

const DAY = 86_400_000;
const START = Date.parse('2026-11-12T00:30:00Z');

function setup(opts: FakePayPalOptions = {}): { fake: FakePayPal; advance: (ms: number) => void; now: () => number } {
  let t = START;
  const now = () => t;
  return { fake: createFakePayPal({ now, ...opts }), advance: (ms) => void (t += ms), now };
}

async function hold(fake: FakePayPal, input: CreateOrderInput = heroOrderInput(), funding: 'paypal' | 'venmo' | 'paylater' = 'paypal') {
  const order = await fake.createOrder(input);
  await fake.approveOrder(order.orderId, funding, 'approve');
  const auth = await fake.authorizeOrder(order.orderId, `auth:${input.customId}`);
  return { order, auth };
}

const cap = (requestId: string, amountCents: number, finalCapture: boolean, invoiceId: string) => ({
  requestId,
  amountCents,
  finalCapture,
  invoiceId,
  noteToPayer: '',
  softDescriptor: 'HOLDMYSPOT',
});

async function rejectsWith(p: Promise<unknown>): Promise<PayPalError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof PayPalError, `expected PayPalError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected the call to fail');
}

describe('fake adapter: the hero hold', () => {
  it('holds $115.00, captures $76.01, adds tracking, captures $26.40 final, then refuses more', async () => {
    const { fake } = setup();
    const { order, auth } = await hold(fake);
    assert.equal(order.orderId, 'FAKE-ORDER-0001');
    assert.equal(order.status, 'PAYER_ACTION_REQUIRED');
    assert.equal(auth.authorizationId, 'FAKE-AUTH-0001');
    assert.equal(auth.status, 'CREATED');
    assert.equal(auth.amountCents, 11_500);
    assert.equal(auth.createdAt, START);
    assert.equal(auth.expiresAt, START + 29 * DAY);
    assert.deepEqual(auth.shipTo, { country: 'US', region: 'NY', city: 'New York', postalCode: '10001' });

    const c1 = await fake.captureAuthorization(auth.authorizationId, cap('cap:job_0001:receipt', 7_601, false, 'HMS-job_0001-R'));
    assert.equal(c1.captureId, 'FAKE-CAP-0001');
    assert.equal(c1.status, 'COMPLETED');
    assert.equal((await fake.getAuthorization(auth.authorizationId)).status, 'PARTIALLY_CAPTURED');

    await fake.addTracking(order.orderId, { requestId: 'track:job_0001', captureId: c1.captureId, trackingNumber: 'HAP-0001', carrierName: 'Harbor Parcel Ground', notifyPayer: true });
    const c2 = await fake.captureAuthorization(auth.authorizationId, cap('cap:job_0001:shipping', 2_640, true, 'HMS-job_0001-S'));
    assert.equal(c2.finalCapture, true);
    assert.equal((await fake.getAuthorization(auth.authorizationId)).status, 'CAPTURED');

    const more = await rejectsWith(fake.captureAuthorization(auth.authorizationId, cap('cap:job_0001:extra', 100, true, 'HMS-job_0001-H')));
    assert.equal(more.code, 'HOLD_CLOSED');
    assert.equal(more.issue, 'AUTHORIZATION_ALREADY_CAPTURED');

    const details = await fake.getOrder(order.orderId);
    assert.equal(details.status, 'COMPLETED');
    assert.deepEqual(details.trackers, [{ trackingNumber: 'HAP-0001', carrierName: null, captureId: 'FAKE-CAP-0001', status: 'SHIPPED' }]);
    const charged = details.captures.reduce((s, c) => s + c.amountCents, 0);
    assert.equal(charged, 10_241, 'charged $102.41');
    assert.equal(11_500 - charged, 1_259, 'released $12.59');
  });

  it('pays the hero payouts: $21.60 and $78.41 to a known receiver', async () => {
    const { fake } = setup();
    const p1 = await fake.createPayout({
      senderBatchId: 'payout:job_0001:fee',
      emailSubject: 'You have a payout from HoldMySpot',
      emailMessage: 'Queue fee for 2 plush at Little Lantern Toys.',
      items: [{ receiverEmail: 'wei@holdmyspot.test', amountCents: 2_160, note: 'Queue fee', senderItemId: 'po_0001' }],
    });
    assert.equal(p1.batchId, 'FAKE-BATCH-0001');
    assert.equal(p1.batchStatus, 'PENDING');
    const b1 = await fake.getPayoutBatch(p1.batchId);
    assert.equal(b1.batchStatus, 'SUCCESS');
    assert.deepEqual(b1.items, [{ itemId: 'FAKE-ITEM-0001', senderItemId: 'po_0001', status: 'SUCCESS', amountCents: 2_160 }]);
    const p2 = await fake.createPayout({
      senderBatchId: 'payout:job_0001:reimb',
      emailSubject: 'You have a payout from HoldMySpot',
      emailMessage: 'Shop price and shipping, at cost.',
      items: [{ receiverEmail: 'wei@holdmyspot.test', amountCents: 7_841, note: 'Reimbursement', senderItemId: 'po_0002' }],
    });
    assert.equal((await fake.getPayoutBatch(p2.batchId)).items[0]?.status, 'SUCCESS');
  });
});

describe('fake adapter: approvals', () => {
  it('authorize needs the buyer approval first', async () => {
    const { fake } = setup();
    const order = await fake.createOrder(heroOrderInput());
    const err = await rejectsWith(fake.authorizeOrder(order.orderId, 'auth:bid_0001'));
    assert.equal(err.code, 'PAYPAL_DECLINED');
    assert.equal(err.issue, 'ORDER_NOT_APPROVED');
    assert.equal(err.restartCheckout, true);
  });

  it('a declined instrument restarts checkout; a new approval then works', async () => {
    const { fake } = setup();
    const order = await fake.createOrder(heroOrderInput());
    assert.deepEqual(await fake.approveOrder(order.orderId, 'paypal', 'decline'), { orderId: order.orderId, status: 'APPROVED' });
    const err = await rejectsWith(fake.authorizeOrder(order.orderId, 'auth:bid_0001'));
    assert.equal(err.code, 'PAYPAL_DECLINED');
    assert.equal(err.issue, 'INSTRUMENT_DECLINED');
    assert.equal(err.restartCheckout, true);
    assert.equal((await fake.getOrder(order.orderId)).status, 'PAYER_ACTION_REQUIRED');
    await fake.approveOrder(order.orderId, 'venmo', 'approve');
    const auth = await fake.authorizeOrder(order.orderId, 'auth:bid_0001:2');
    assert.equal(auth.status, 'CREATED');
    assert.equal(auth.fundingSource, 'venmo');
  });

  it('cancel leaves the order waiting, and a second authorize returns the same hold', async () => {
    const { fake } = setup();
    const order = await fake.createOrder(heroOrderInput());
    assert.equal((await fake.approveOrder(order.orderId, 'paypal', 'cancel')).status, 'PAYER_ACTION_REQUIRED');
    await fake.approveOrder(order.orderId, 'paypal', 'approve');
    const a1 = await fake.authorizeOrder(order.orderId, 'auth:bid_0001');
    const a2 = await fake.authorizeOrder(order.orderId, 'auth:bid_0001:other-key');
    assert.equal(a2.authorizationId, a1.authorizationId, 'ORDER_ALREADY_AUTHORIZED is turned into the existing hold');
  });

  it('local pickup orders have no ship-to; Pay Later shows as PayPal', async () => {
    const { fake } = setup();
    const { auth } = await hold(fake, localOrderInput(), 'paylater');
    assert.equal(auth.shipTo, null);
    assert.equal(auth.fundingSource, 'paypal');
    assert.equal(auth.amountCents, 5_000);
  });

  it('implements the server port and the fake approval control', async () => {
    const { fake } = setup();
    const port: PaymentsPort = fake;
    const controls: FakePaymentsControls = fake;
    assert.equal(port.mode, 'fake');
    const order = await port.createOrder(heroOrderInput());
    assert.deepEqual(await controls.approveOrder(order.orderId, 'paypal', 'approve'), { orderId: order.orderId, status: 'APPROVED' });
  });
});

describe('fake adapter: PayPal capture rules', () => {
  it('accepts captures up to 115% like PayPal, so our own 100% limit must stop them', async () => {
    const { fake } = setup();
    const { auth } = await hold(fake);
    await fake.captureAuthorization(auth.authorizationId, cap('c1', 13_225, false, 'HMS-job_0009-R'));
    const err = await rejectsWith(fake.captureAuthorization(auth.authorizationId, cap('c2', 1, true, 'HMS-job_0009-S')));
    assert.equal(err.code, 'OVER_CAPTURE');
    assert.equal(err.issue, 'MAX_CAPTURE_AMOUNT_EXCEEDED');
  });

  it('voids after a partial capture and refuses later captures and voids', async () => {
    const { fake } = setup();
    const { auth } = await hold(fake);
    await fake.captureAuthorization(auth.authorizationId, cap('c1', 1_000, false, 'HMS-job_0002-R'));
    const voided = await fake.voidAuthorization(auth.authorizationId, 'void:hold_0001:1');
    assert.equal(voided.status, 'VOIDED');
    assert.equal(voided.fundingSource, 'paypal');
    assert.equal((await rejectsWith(fake.captureAuthorization(auth.authorizationId, cap('c2', 100, true, 'HMS-job_0002-S')))).code, 'HOLD_CLOSED');
    assert.equal((await rejectsWith(fake.voidAuthorization(auth.authorizationId, 'void:hold_0001:2'))).code, 'HOLD_CLOSED');
  });

  it('refuses a second capture with the same invoice id under a new request id', async () => {
    const { fake } = setup();
    const { auth } = await hold(fake);
    await fake.captureAuthorization(auth.authorizationId, cap('c1', 1_000, false, 'HMS-job_0003-R'));
    const err = await rejectsWith(fake.captureAuthorization(auth.authorizationId, cap('c2', 1_000, false, 'HMS-job_0003-R')));
    assert.equal(err.issue, 'DUPLICATE_INVOICE_ID');
  });

  it('refunds up to what was captured', async () => {
    const { fake } = setup();
    const { auth } = await hold(fake);
    const c = await fake.captureAuthorization(auth.authorizationId, cap('c1', 7_601, false, 'HMS-job_0004-R'));
    const r1 = await fake.refundCapture(c.captureId, { requestId: 'refund:job_0004:1', amountCents: 500, invoiceId: 'HMS-job_0004-F1', noteToPayer: 'Partial refund' });
    assert.deepEqual([r1.refundId, r1.captureId, r1.status, r1.amountCents], ['FAKE-REFUND-0001', c.captureId, 'COMPLETED', 500]);
    assert.equal((await fake.getCapture(c.captureId)).status, 'PARTIALLY_REFUNDED');
    const over = await rejectsWith(fake.refundCapture(c.captureId, { requestId: 'refund:job_0004:2', amountCents: 7_200, invoiceId: 'HMS-job_0004-F2', noteToPayer: '' }));
    assert.equal(over.issue, 'REFUND_AMOUNT_EXCEEDED');
    await fake.refundCapture(c.captureId, { requestId: 'refund:job_0004:3', amountCents: 7_101, invoiceId: 'HMS-job_0004-F3', noteToPayer: '' });
    assert.equal((await fake.getCapture(c.captureId)).status, 'REFUNDED');
  });

  it('a pending capture completes later', async () => {
    const { fake } = setup({ failures: 'capture:pending' });
    const { auth } = await hold(fake);
    const c = await fake.captureAuthorization(auth.authorizationId, cap('c1', 1_000, false, 'HMS-job_0005-R'));
    assert.equal(c.status, 'PENDING');
    fake.completePendingCapture(c.captureId);
    assert.equal((await fake.getCapture(c.captureId)).status, 'COMPLETED');
  });
});

describe('fake adapter: honor period, validity and renewals on the market clock', () => {
  it('reauthorizes only from day 4, keeps the original validity, and never renews a renewal', async () => {
    const { fake, advance } = setup();
    const { auth } = await hold(fake);

    advance(1 * DAY);
    const early = await rejectsWith(fake.reauthorize(auth.authorizationId, { requestId: 'reauth:hold_0001:1', amountCents: 11_500 }));
    assert.equal(early.issue, 'FAKE_HONOR_PERIOD_NOT_OVER');

    advance(2 * DAY + 60_000); // day 4 starts after three full days
    const r1 = await fake.reauthorize(auth.authorizationId, { requestId: 'reauth:hold_0001:2', amountCents: 11_500 });
    assert.equal(r1.authorizationId, 'FAKE-AUTH-0002');
    assert.equal(r1.status, 'CREATED');
    assert.equal(r1.orderId, 'FAKE-ORDER-0001');
    assert.equal(r1.createdAt, START + 3 * DAY + 60_000);
    assert.equal(r1.expiresAt, START + 29 * DAY, 'validity still counts from the original');

    const child = await rejectsWith(fake.reauthorize(r1.authorizationId, { requestId: 'reauth:hold_0001:3', amountCents: 11_500 }));
    assert.equal(child.issue, 'FAKE_REAUTHORIZED_PAYMENT');

    advance(2 * DAY);
    const r2 = await fake.reauthorize(auth.authorizationId, { requestId: 'reauth:hold_0001:4', amountCents: 11_500 });
    assert.equal(r2.authorizationId, 'FAKE-AUTH-0003', 'the original can be reauthorized again');

    advance(24 * DAY); // day 29
    assert.equal((await fake.getAuthorization(auth.authorizationId)).status, 'EXPIRED');
    const late = await rejectsWith(fake.captureAuthorization(r2.authorizationId, cap('c1', 1_000, false, 'HMS-job_0006-R')));
    assert.equal(late.code, 'HOLD_EXPIRED');
  });

  it('caps a reauthorization at 115% and +$75', async () => {
    const { fake, advance } = setup();
    const big = heroOrderInput({
      requestId: 'order:bid_0100',
      invoiceId: 'HMS-bid_0100',
      customId: 'bid_0100',
      amountCents: 100_000,
      breakdown: { itemTotalCents: 100_000, shippingCents: 0 },
      items: [{ name: 'Mochi Bunny plush (shop price, up to)', quantity: 1, unitAmountCents: 100_000, category: 'PHYSICAL_GOODS' }],
    });
    const { auth } = await hold(fake, big);
    advance(4 * DAY);
    const err = await rejectsWith(fake.reauthorize(auth.authorizationId, { requestId: 'r1', amountCents: 107_501 }));
    assert.equal(err.issue, 'FAKE_REAUTHORIZE_LIMIT_EXCEEDED');
    assert.equal((await fake.reauthorize(auth.authorizationId, { requestId: 'r2', amountCents: 107_500 })).amountCents, 107_500);
  });
});

describe('fake adapter: idempotency and failure injection', () => {
  it('a repeated request id returns the first capture', async () => {
    const { fake } = setup();
    const { order, auth } = await hold(fake);
    const a = await fake.captureAuthorization(auth.authorizationId, cap('cap:job_0001:receipt', 7_601, false, 'HMS-job_0001-R'));
    const b = await fake.captureAuthorization(auth.authorizationId, cap('cap:job_0001:receipt', 7_601, false, 'HMS-job_0001-R'));
    assert.equal(b.captureId, a.captureId);
    assert.equal((await fake.getOrder(order.orderId)).captures.length, 1);
  });

  it('survives a lost response: the automatic retry gets the first capture back', async () => {
    const lines: string[] = [];
    const { fake } = setup({ failures: 'capture:lost', log: (l) => lines.push(l) });
    const { order, auth } = await hold(fake);
    const c = await fake.captureAuthorization(auth.authorizationId, cap('cap:job_0001:receipt', 7_601, false, 'HMS-job_0001-R'));
    assert.equal(c.status, 'COMPLETED');
    assert.equal((await fake.getOrder(order.orderId)).captures.length, 1, 'charged once');
    assert.ok(lines.some((l) => l.includes('authorizations.capture') && l.includes('-> 503')));
    assert.ok(lines.some((l) => l.includes('authorizations.capture') && l.includes('attempt=2')));
  });

  it('rides out a one-off outage and reports a lasting one as retryable', async () => {
    const once = setup({ failures: ['capture:once'] });
    const h1 = await hold(once.fake);
    assert.equal((await once.fake.captureAuthorization(h1.auth.authorizationId, cap('c1', 1_000, false, 'HMS-job_0007-R'))).status, 'COMPLETED');

    const always = setup({ failures: 'capture:always' });
    const h2 = await hold(always.fake);
    const err = await rejectsWith(always.fake.captureAuthorization(h2.auth.authorizationId, cap('c1', 1_000, false, 'HMS-job_0008-R')));
    assert.equal(err.code, 'PAYPAL_UNAVAILABLE');
    assert.equal(err.retryable, true);
  });

  it('retries rate limiting', async () => {
    const { fake } = setup({ failures: 'any:ratelimit:2' });
    assert.equal((await fake.createOrder(heroOrderInput())).orderId, 'FAKE-ORDER-0001');
  });

  it('parses HMS_FAKE_FAIL rules and rejects unknown ones', () => {
    assert.deepEqual(parseFailures('capture:once, payout:unclaimed:*, any:ratelimit:2'), [
      { op: 'capture', effect: 'unavailable', remaining: 1 },
      { op: 'payout', effect: 'unclaimed', remaining: Number.POSITIVE_INFINITY },
      { op: 'any', effect: 'ratelimit', remaining: 2 },
    ]);
    assert.deepEqual(parseFailures(['capture:always']), [{ op: 'capture', effect: 'unavailable', remaining: Number.POSITIVE_INFINITY }]);
    assert.deepEqual(parseFailures(''), []);
    assert.throws(() => parseFailures('capturez:once'), /unknown call/);
    assert.throws(() => parseFailures('capture:explode'), /unknown effect/);
  });
});

describe('fake adapter: payouts', () => {
  it('known receivers succeed; others stay UNCLAIMED until claimed, or are cancelled back', async () => {
    const { fake } = setup();
    const ok = await fake.createPayout({ senderBatchId: 'payout:job_0001:fee', emailSubject: 's', emailMessage: 'm', items: [{ receiverEmail: 'queuer-payouts@personal.example.com', amountCents: 2_160, note: 'n', senderItemId: 'po_0001' }] });
    assert.equal((await fake.getPayoutBatch(ok.batchId)).items[0]?.status, 'SUCCESS');

    const unknown = await fake.createPayout({ senderBatchId: 'payout:job_0002:fee', emailSubject: 's', emailMessage: 'm', items: [{ receiverEmail: 'nobody@unknown-receiver.invalid', amountCents: 900, note: 'n', senderItemId: 'po_0002' }] });
    const item = (await fake.getPayoutBatch(unknown.batchId)).items[0];
    assert.equal(item?.status, 'UNCLAIMED');
    const cancelled = await fake.cancelUnclaimedPayoutItem(item?.itemId ?? '');
    assert.equal(cancelled.status, 'RETURNED');
    const again = await rejectsWith(fake.cancelUnclaimedPayoutItem(item?.itemId ?? ''));
    assert.equal(again.code, 'PAYPAL_ERROR');

    const third = await fake.createPayout({ senderBatchId: 'payout:job_0003:fee', emailSubject: 's', emailMessage: 'm', items: [{ receiverEmail: 'later@unknown-receiver.invalid', amountCents: 500, note: 'n', senderItemId: 'po_0003' }] });
    const itemId = (await fake.getPayoutBatch(third.batchId)).items[0]?.itemId ?? '';
    fake.claimPayoutItem(itemId);
    const read = await fake.getPayoutItem(itemId);
    assert.equal(read.status, 'SUCCESS');
    assert.equal(read.receiver, 'later@unknown-receiver.invalid');
  });

  it('the same sender_batch_id returns the first batch; HMS_FAKE_FAIL payout:unclaimed holds a known receiver', async () => {
    const { fake } = setup({ failures: 'payout:unclaimed' });
    const input = { senderBatchId: 'payout:job_0001:fee', emailSubject: 's', emailMessage: 'm', items: [{ receiverEmail: 'wei@holdmyspot.test', amountCents: 2_160, note: 'n', senderItemId: 'po_0001' }] };
    const a = await fake.createPayout(input);
    const b = await fake.createPayout(input);
    assert.equal(b.batchId, a.batchId);
    assert.equal((await fake.getPayoutBatch(a.batchId)).items[0]?.status, 'UNCLAIMED');
  });
});

describe('fake adapter: disputes', () => {
  it('lists, takes evidence, then settles in the seller favour (sandbox adjudicate)', async () => {
    const { fake, now } = setup();
    const { auth } = await hold(fake);
    const c = await fake.captureAuthorization(auth.authorizationId, cap('c1', 7_601, false, 'HMS-job_0001-R'));
    const id = fake.openDispute(c.captureId);
    assert.equal(id, 'FAKE-DISPUTE-0001');
    const listed = await fake.listDisputes(now() - 60_000);
    assert.deepEqual(
      listed.map((d) => [d.disputeId, d.status, d.invoiceIds[0], d.captureIds[0], d.amountCents]),
      [[id, 'WAITING_FOR_SELLER_RESPONSE', 'HMS-job_0001-R', c.captureId, 7_601]],
    );
    const tooSoon = await rejectsWith(fake.adjudicate(id, 'SELLER_FAVOR'));
    assert.equal(tooSoon.issue, 'FAKE_DISPUTE_NOT_UNDER_REVIEW');
    const reviewed = await fake.provideEvidence(id, { note: 'Receipt verified; tracked parcel.', files: [{ name: 'receipt.png', contentType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) }] });
    assert.equal(reviewed.status, 'UNDER_REVIEW');
    const settled = await fake.adjudicate(id, 'SELLER_FAVOR');
    assert.equal(settled.status, 'RESOLVED');
    assert.equal(settled.outcome, 'RESOLVED_SELLER_FAVOUR');
    assert.equal((await fake.getCapture(c.captureId)).status, 'COMPLETED', 'seller keeps the money');
  });

  it('escalates then settles for the buyer, or accepts the claim; both refund the buyer', async () => {
    const { fake } = setup();
    const { auth } = await hold(fake);
    const c = await fake.captureAuthorization(auth.authorizationId, cap('c1', 3_000, false, 'HMS-job_0001-R'));
    const d1 = fake.openDispute(c.captureId, { amountCents: 1_000 });
    assert.equal((await fake.escalateDispute(d1, 'Escalating to a claim.')).status, 'UNDER_REVIEW');
    const buyer = await fake.adjudicate(d1, 'BUYER_FAVOR');
    assert.equal(buyer.outcome, 'RESOLVED_BUYER_FAVOUR');
    assert.equal((await fake.getCapture(c.captureId)).status, 'PARTIALLY_REFUNDED');
    const d2 = fake.openDispute(c.captureId);
    const accepted = await fake.acceptClaim(d2, 'Refunding the rest.');
    assert.equal(accepted.status, 'RESOLVED');
    assert.equal(accepted.outcome, 'ACCEPTED');
    assert.equal((await fake.getCapture(c.captureId)).status, 'REFUNDED');
  });
});

describe('fake adapter: webhooks and persistence', () => {
  it('verifies signed events and rejects tampered ones', async () => {
    const { fake } = setup({ webhookId: 'WH-FAKE-ID' });
    const event = fake.emulator.makeWebhookEvent('PAYMENT.CAPTURE.COMPLETED', { id: 'FAKE-CAP-0001', status: 'COMPLETED', invoice_id: 'HMS-job_0001-R' }, 'capture');
    const signed = fake.emulator.signWebhook(event);
    assert.equal(await fake.verifyWebhook(signed.headers, signed.rawBody), true);
    assert.equal(await fake.verifyWebhook(signed.headers, signed.rawBody.replace('COMPLETED', 'REFUNDED')), false);
    const { fake: noId } = setup();
    assert.equal(await noId.verifyWebhook(signed.headers, signed.rawBody), false);
  });

  it('exports and reloads its state, keeping ids and holds', async () => {
    const first = setup();
    const { auth } = await hold(first.fake);
    const state = first.fake.exportState();
    const second = createFakePayPal({ now: first.now, state });
    assert.equal((await second.getAuthorization(auth.authorizationId)).status, 'CREATED');
    assert.equal((await second.createOrder(heroOrderInput({ requestId: 'order:bid_0002', invoiceId: 'HMS-bid_0002', customId: 'bid_0002' }))).orderId, 'FAKE-ORDER-0002');
    assert.equal(JSON.parse(JSON.stringify(state)).version, 1, 'state is plain JSON');
  });
});
