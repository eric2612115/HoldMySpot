import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { PAYPAL_PRICING, bidLimitCents, grossUpCapture, jobCaps, paypalCaptureFeeCents, payoutsForCapture, receiptCapture } from '@holdmyspot/shared';
import {
  captureFeeCents,
  createFakePayPal,
  isDuplicatePayout,
  PAYOUT_ITEM_FEE_CENTS,
  PayPalError,
  SANDBOX_LINK_HOST,
  toPayPalError,
  type FakePayPal,
  type RecordedResponse,
} from '../../src/paypal/index.ts';
import { heroOrderInput, makeClient, OAUTH } from './helpers.ts';

/**
 * What the real PayPal sandbox answered on 11-07 (scripts/sandbox-gates.mjs run, probe,
 * lifecycle and disputes) and 11-08 (lifecycle --local, and the GET read-back of the Venmo-button
 * hold for gate G4); sanitized copies in fixtures/recorded, and the emulator and the client
 * following them. The emulator runs fake mode, so it must not tell a different story.
 */

const recorded = (rel: string) => JSON.parse(readFileSync(new URL(`./fixtures/recorded/${rel}`, import.meta.url), 'utf8')) as RecordedResponse;

const START = Date.parse('2026-11-12T18:30:00Z');

function setup(opts: Parameters<typeof createFakePayPal>[0] = {}) {
  let t = START;
  const seen: RecordedResponse[] = [];
  const fake = createFakePayPal({ now: () => t, onResponse: (r) => seen.push(r), ...opts });
  return { fake, seen, advance: (ms: number) => void (t += ms) };
}

async function held(fake: FakePayPal, overrides: Parameters<typeof heroOrderInput>[0] = {}) {
  const order = await fake.createOrder(heroOrderInput(overrides));
  await fake.approveOrder(order.orderId, 'paypal', 'approve');
  const auth = await fake.authorizeOrder(order.orderId, `auth:${order.orderId}`);
  return { order, auth };
}

const cap = (requestId: string, amountCents: number, finalCapture: boolean, invoiceId: string) => ({ requestId, amountCents, finalCapture, invoiceId, noteToPayer: '', softDescriptor: 'HOLDMYSPOT' });

async function refusal(p: Promise<unknown>): Promise<PayPalError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof PayPalError, `expected PayPalError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected PayPal to refuse');
}

describe('the real sandbox, as recorded on 11-07', () => {
  it('charged 3.49% + $0.49 on every capture and $0.25 per payout item', () => {
    for (const [file, gross, fee] of [
      ['20261107-1614/012-authorizations.capture-201.json', '76.01', '3.14'],
      ['20261107-1614/016-authorizations.capture-201.json', '26.40', '1.41'],
      ['20261107-1614/022-authorizations.capture-201.json', '12.00', '0.91'],
      ['20261107-1642-lifecycle/005-captures.get-200.json', '8.75', '0.80'],
    ] as const) {
      const b = recorded(file).body as { amount: { value: string }; seller_receivable_breakdown: { paypal_fee: { value: string } } };
      assert.equal(b.amount.value, gross);
      assert.equal(b.seller_receivable_breakdown.paypal_fee.value, fee);
      assert.equal(captureFeeCents(Math.round(Number(gross) * 100)), Math.round(Number(fee) * 100), `the emulator's fee on $${gross}`);
    }
    const batch = recorded('20261107-1642-lifecycle/006-payouts.get-200.json').body as { batch_header: { batch_status: string }; items: { transaction_status: string; payout_item_fee: { value: string } }[] };
    assert.equal(batch.batch_header.batch_status, 'PROCESSING', 'the batch still read PROCESSING after its item was paid');
    assert.equal(batch.items[0]?.transaction_status, 'SUCCESS');
    assert.equal(Math.round(Number(batch.items[0]?.payout_item_fee.value) * 100), PAYOUT_ITEM_FEE_CENTS);
  });

  it("is the price the processing line passes through (D-105): the shared schedule equals the emulator's and the recorded fees", () => {
    for (let cents = 1; cents <= 50_000; cents++) assert.equal(paypalCaptureFeeCents(cents), captureFeeCents(cents), `fee on ${cents}`);
    assert.equal(PAYPAL_PRICING.payoutItemCents, PAYOUT_ITEM_FEE_CENTS);
    // The lifecycle run's capture: $46.00 cost $2.10, so the same receipt now captures $48.69, whose $2.19 fee and two $0.25 payouts it covers.
    const lifecycle = recorded('20261107-1642-lifecycle/004-captures.get-200.json').body as { amount: { value: string }; seller_receivable_breakdown: { paypal_fee: { value: string }; net_amount: { value: string } } };
    assert.deepEqual([lifecycle.amount.value, lifecycle.seller_receivable_breakdown.paypal_fee.value, lifecycle.seller_receivable_breakdown.net_amount.value], ['46.00', '2.10', '43.90']);
    const g = grossUpCapture(4600, 2);
    assert.deepEqual([g.amountCents, g.captureFeeCents, g.payoutFeesCents], [4869, 219, 50]);
    assert.equal(g.amountCents - captureFeeCents(g.amountCents), 4600 + 2 * PAYOUT_ITEM_FEE_CENTS);
  });

  it('charged the D-105 errand exactly its processing line, $2.19 + $0.82 + 2 x $0.25 (lifecycle 20261107-2047)', () => {
    const run = '20261107-2047-lifecycle';
    const cents = (v: string) => Math.round(Number(v) * 100);
    const auth = recorded(`${run}/002-authorizations.get-200.json`).body as { status: string; amount: { value: string } };
    assert.deepEqual([auth.status, auth.amount.value], ['CAPTURED', '63.70']);
    type Capture = { amount: { value: string }; invoice_id: string; seller_receivable_breakdown: { paypal_fee: { value: string }; net_amount: { value: string } } };
    const [receipt, shipping] = ['004', '005'].map((n) => recorded(`${run}/${n}-captures.get-200.json`).body as Capture);
    assert.match(receipt!.invoice_id, /-R$/);
    assert.match(shipping!.invoice_id, /-S$/);
    const parts = (c: Capture) => [c.amount.value, c.seller_receivable_breakdown.paypal_fee.value, c.seller_receivable_breakdown.net_amount.value];
    assert.deepEqual([parts(receipt!), parts(shipping!)], [
      ['48.69', '2.19', '46.50'],
      ['9.57', '0.82', '8.75'],
    ]);
    // The receipt capture nets the shop price, the fee and both payout fees; the shipping capture nets the label alone.
    const r = grossUpCapture(3400 + 1200, 2);
    const s = grossUpCapture(875, 0);
    assert.deepEqual([r.amountCents, r.captureFeeCents, s.amountCents, s.captureFeeCents], [4869, 219, 957, 82]);
    for (const c of [receipt!, shipping!]) assert.equal(paypalCaptureFeeCents(cents(c.amount.value)), cents(c.seller_receivable_breakdown.paypal_fee.value));
    type Batch = { items: { transaction_status: string; payout_item: { amount: { value: string } }; payout_item_fee: { value: string } }[] };
    const items = ['006', '007'].flatMap((n) => (recorded(`${run}/${n}-payouts.get-200.json`).body as Batch).items);
    assert.deepEqual(items.map((i) => [i.transaction_status, i.payout_item.amount.value, i.payout_item_fee.value]).sort(), [
      ['SUCCESS', '10.80', '0.25'],
      ['SUCCESS', '42.75', '0.25'],
    ]);
    const paypalFees = cents(receipt!.seller_receivable_breakdown.paypal_fee.value) + cents(shipping!.seller_receivable_breakdown.paypal_fee.value) + items.reduce((t, i) => t + cents(i.payout_item_fee.value), 0);
    const charged = cents(receipt!.amount.value) + cents(shipping!.amount.value);
    const paidOut = items.reduce((t, i) => t + cents(i.payout_item.amount.value), 0);
    assert.deepEqual([paypalFees, charged - paidOut - paypalFees], [351, 120], "PayPal's fees equal the $3.51 processing line; HoldMySpot keeps 10% of the $12 fee");
  });

  it('charged the local pickup errand one capture at the handover, exactly its processing line, $2.18 + $0.25 (lifecycle 20261108-1357-local, D-156)', () => {
    const run = '20261108-1357-lifecycle-local';
    const cents = (v: string) => Math.round(Number(v) * 100);
    type Capture = { id: string; status: string; final_capture: boolean; amount: { value: string }; invoice_id: string; seller_receivable_breakdown: { paypal_fee: { value: string }; net_amount: { value: string } } };
    type Order = {
      intent: string;
      purchase_units: { shipping?: unknown; items: { name: string; unit_amount: { value: string } }[]; payments: { authorizations: { id: string; status: string }[]; captures: Capture[] } }[];
    };
    // Sam's request: a PICKUP_FROM_PERSON order, so PayPal keeps no shipping at all; the items are the plush cap, the fee and the processing reserve.
    const order = recorded(`${run}/003-orders.get-200.json`).body as Order;
    const pu = order.purchase_units[0]!;
    assert.equal(order.intent, 'AUTHORIZE');
    assert.equal(pu.shipping, undefined, 'no ship-to and no tracker on a local pickup order');
    assert.deepEqual(pu.items.map((i) => i.unit_amount.value), ['36.00', '12.00', '2.50']);
    const bid = { qty: 1, retailCapCents: 3600, maxFeeCents: 1200, shippingBudgetCents: 0 };
    const auth = recorded(`${run}/002-authorizations.get-200.json`).body as { status: string; amount: { value: string } };
    assert.deepEqual([auth.status, cents(auth.amount.value)], ['CAPTURED', bidLimitCents(bid, 'local')]);
    // Nothing at the receipt: the order holds one capture, the handover's (invoice suffix H), final, and the rest was released.
    assert.equal(pu.payments.captures.length, 1);
    const capture = recorded(`${run}/004-captures.get-200.json`).body as Capture;
    assert.deepEqual([capture.id, capture.status, capture.final_capture], [pu.payments.captures[0]!.id, 'COMPLETED', true]);
    assert.match(capture.invoice_id, /-H$/, 'the handover capture');
    const handover = receiptCapture(jobCaps(bid, { qty: 1, feeCents: 1200 }, 'local'), 3400, 'local');
    assert.deepEqual(
      [cents(capture.amount.value), cents(capture.seller_receivable_breakdown.paypal_fee.value), cents(capture.seller_receivable_breakdown.net_amount.value)],
      [handover.amountCents, handover.captureFeeCents, 3400 + 1200 + PAYPAL_PRICING.payoutItemCents],
      'the capture nets the shop price, the fee and the one payout fee',
    );
    assert.deepEqual([handover.amountCents, handover.captureFeeCents, handover.processingCents], [4843, 218, 243]);
    assert.equal(bidLimitCents(bid, 'local') - handover.amountCents, 207, 'released by the final capture');
    // One payout: the shop price and the fee minus HoldMySpot's 10%, with PayPal's $0.25 item fee.
    type Batch = { batch_header: { sender_batch_header: { sender_batch_id: string } }; items: { transaction_status: string; payout_item: { amount: { value: string } }; payout_item_fee: { value: string } }[] };
    const batch = recorded(`${run}/005-payouts.get-200.json`).body as Batch;
    assert.match(batch.batch_header.sender_batch_header.sender_batch_id, /^payout:job_\d+:all@/);
    const [payout] = payoutsForCapture('local', 'handover', { retailCents: 3400, feeCents: 1200, shippingCents: 0 });
    assert.deepEqual(
      batch.items.map((i) => [i.transaction_status, cents(i.payout_item.amount.value), cents(i.payout_item_fee.value)]),
      [['SUCCESS', payout!.amountCents, PAYOUT_ITEM_FEE_CENTS]],
    );
    const paypalFees = cents(capture.seller_receivable_breakdown.paypal_fee.value) + cents(batch.items[0]!.payout_item_fee.value);
    assert.deepEqual([paypalFees, cents(capture.amount.value) - cents(batch.items[0]!.payout_item.amount.value) - paypalFees], [handover.processingCents, 120], "PayPal's fees equal the $2.43 processing line; HoldMySpot keeps 10% of the $12 fee");
  });

  it('read the Venmo-button hold back before its capture: an AUTHORIZE order whose payment_source is venmo, its authorization CREATED and nothing captured (record-g4, 11-08)', () => {
    const run = '20261108-1358-record-g4';
    const order = recorded(`${run}/001-orders.get-200.json`).body as { id: string; intent: string; payment_source: Record<string, unknown>; purchase_units: { payments: { captures?: unknown[] } }[] };
    assert.deepEqual([order.id, order.intent, Object.keys(order.payment_source)], ['03979024TL691052W', 'AUTHORIZE', ['venmo']]);
    assert.equal(order.purchase_units[0]!.payments.captures?.length ?? 0, 0);
    const auth = recorded(`${run}/002-authorizations.get-200.json`).body as { id: string; status: string; amount: { value: string } };
    assert.deepEqual([auth.id, auth.status, auth.amount.value], ['7RB884471X718305E', 'CREATED', '56.00']);
  });

  it('captured $10.00 of the Venmo-funded hold with final_capture: COMPLETED at the PayPal-funded fee schedule, the authorization CAPTURED and the rest released (gate G4, venmo 20261108-1415, D-157)', () => {
    const run = '20261108-1415-venmo';
    const cents = (v: string) => Math.round(Number(v) * 100);
    // Before: PayPal's own record says the order is paid with Venmo, and nothing was captured on it.
    const order = recorded(`${run}/001-orders.get-200.json`).body as { id: string; intent: string; payment_source: Record<string, unknown>; purchase_units: { payments: { captures?: unknown[] } }[] };
    assert.deepEqual([order.id, order.intent, Object.keys(order.payment_source), order.purchase_units[0]!.payments.captures?.length ?? 0], ['03979024TL691052W', 'AUTHORIZE', ['venmo'], 0]);
    type Auth = { id: string; status: string; amount: { value: string } };
    const before = recorded(`${run}/002-authorizations.get-200.json`).body as Auth;
    const after = recorded(`${run}/005-authorizations.get-200.json`).body as Auth;
    assert.deepEqual([before.id, before.status, before.amount.value, after.id, after.status], ['7RB884471X718305E', 'CREATED', '56.00', '7RB884471X718305E', 'CAPTURED']);
    // The capture, as PayPal answered the POST and as a later GET reads it: final, COMPLETED, the gate's own invoice id.
    type Capture = { id: string; status: string; final_capture: boolean; invoice_id: string; amount: { value: string }; seller_receivable_breakdown: { paypal_fee: { value: string }; net_amount: { value: string } } };
    const posted = recorded(`${run}/003-authorizations.capture-201.json`);
    const capture = recorded(`${run}/004-captures.get-200.json`).body as Capture;
    assert.equal(posted.method, 'POST');
    assert.equal((posted.body as Capture).id, capture.id);
    assert.deepEqual([capture.id, capture.status, capture.final_capture, capture.amount.value], ['41C59314FX8286919', 'COMPLETED', true, '10.00']);
    assert.match(capture.invoice_id, /^HMS-GATE-\d{8}-\d{4}-G4-V$/);
    // PayPal's fee on a Venmo-funded capture is the schedule PayPal-funded captures pay (3.49% + $0.49).
    const fee = cents(capture.seller_receivable_breakdown.paypal_fee.value);
    assert.deepEqual([fee, cents(capture.seller_receivable_breakdown.net_amount.value)], [84, 916]);
    assert.equal(fee, paypalCaptureFeeCents(1_000));
    assert.equal(fee, captureFeeCents(1_000), "the emulator's fee");
    assert.equal(cents(before.amount.value) - cents(capture.amount.value), 4_600, 'released by the final capture');
  });

  it('read every capture of a closed authorization as final_capture=true, although the first was sent false', () => {
    const post = recorded('20261107-1614/012-authorizations.capture-201.json').body as { final_capture: boolean };
    assert.equal(post.final_capture, false);
    const get = recorded('20261107-1642-lifecycle/004-captures.get-200.json').body as { final_capture: boolean; invoice_id: string };
    assert.match(get.invoice_id, /-R$/, 'the receipt capture, sent with final_capture=false');
    assert.equal(get.final_capture, true);
  });

  it('listed a new dispute without invoice numbers: the client reads the dispute itself to find ours', async () => {
    const list = recorded('20261107-1646-disputes/001-disputes.list-200.json');
    const detail = recorded('20261107-1646-disputes/002-disputes.get-200.json');
    const id = (detail.body as { dispute_id: string }).dispute_id;
    const t = makeClient([
      OAUTH,
      { method: 'GET', path: '/v1/customer/disputes', respond: { status: 200, body: list.body } },
      { method: 'GET', path: `/v1/customer/disputes/${id}`, respond: { status: 200, body: detail.body } },
    ]);
    const disputes = await t.client.listDisputes(Date.parse('2026-11-01T00:00:00Z'));
    assert.deepEqual(
      disputes.map((d) => [d.disputeId, d.status, d.invoiceIds, d.captureIds, d.amountCents]),
      [[id, 'UNDER_REVIEW', ['HMS-GATE-20261107-1614-A-R'], ['1M687255LP844644Y'], 7_601]],
    );
    assert.deepEqual(t.script.problems, []);
  });

  it('named its refusals: PREVIOUSLY_CAPTURED, DUPLICATE_TRANSACTION, REAUTHORIZATION_TOO_SOON, CAPTURE_ID_NOT_FOUND, ITEM_INCORRECT_STATUS', () => {
    const issue = (rel: string) => {
      const b = recorded(rel).body as { name: string; details?: { issue: string }[] };
      return b.details?.[0]?.issue ?? b.name;
    };
    assert.equal(issue('20261107-1644-probe/001-authorizations.void-422.json'), 'PREVIOUSLY_CAPTURED');
    assert.equal(issue('20261107-1644-probe/016-authorizations.capture-422.json'), 'DUPLICATE_TRANSACTION');
    assert.equal(issue('20261107-1644-probe/012-authorizations.reauthorize-422.json'), 'REAUTHORIZATION_TOO_SOON');
    assert.equal(issue('20261107-1644-probe/008-orders.track-422.json'), 'CAPTURE_ID_NOT_FOUND');
    assert.equal(issue('20261107-1644-probe/009-payouts.item.cancel-400.json'), 'ITEM_INCORRECT_STATUS');
    assert.equal(issue('20261107-1644-probe/013-authorizations.capture-422.json'), 'MAX_CAPTURE_AMOUNT_EXCEEDED');
  });

  it('offered adjudicate about 20 minutes after the claim opened, answered 200, and resolved it about 3 minutes later', () => {
    const fresh = recorded('20261107-1646-disputes/002-disputes.get-200.json').body as { links: { rel: string }[]; dispute_state: string };
    assert.deepEqual(fresh.links.map((l) => l.rel), ['self', 'provide_supporting_info']);
    assert.equal(fresh.dispute_state, 'UNDER_PAYPAL_REVIEW');
    const refused = recorded('20261107-1646-disputes/003-disputes.adjudicate-400.json').body as { name: string; details: { issue: string }[] };
    assert.deepEqual([refused.name, refused.details[0]?.issue], ['INVALID_REQUEST', 'ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE']);
    const later = recorded('20261107-1701-disputes/002-disputes.get-200.json').body as { links: { rel: string }[] };
    assert.deepEqual(later.links.map((l) => l.rel), ['self', 'accept_claim', 'adjudicate', 'require_evidence', 'provide_supporting_info']);
    assert.equal(recorded('20261107-1701-disputes/003-disputes.adjudicate-200.json').status, 200);
    const done = recorded('20261107-1705-disputes/002-disputes.get-200.json').body as { status: string; dispute_outcome: { outcome_code: string; outcome_reason: string } };
    assert.deepEqual([done.status, done.dispute_outcome.outcome_code, done.dispute_outcome.outcome_reason], ['RESOLVED', 'RESOLVED_SELLER_FAVOUR', 'INELIGIBLE_BUYER_PROTECTION_POLICY']);
  });

  it('refused a payout batch sent again with the same sender_batch_id and request id, naming the batch it has', () => {
    const r = recorded('20261107-1700-probe-payout/001-payouts.create-400.json');
    const err = toPayPalError({ op: r.op, method: r.method, path: r.path, requestId: 'HMS-GATE-20261107-1614-G6', status: r.status, body: r.body, debugIdHeader: r.debugId });
    assert.ok(isDuplicatePayout(err), 'the server keeps such a payout pending instead of failing or resending it (D-53)');
    const link = (r.body as { details: { link: { href: string }[] }[] }).details[0]?.link[0]?.href;
    assert.match(link ?? '', /\/v1\/payments\/payouts\/JMYKU2MVUQH6Q$/, 'the first G6 batch');
  });
});

describe('the emulator matches the sandbox', () => {
  it('answers an order with a payment_source with 200 and links on the classic sandbox host', async () => {
    const { fake, seen } = setup();
    await fake.createOrder(heroOrderInput());
    const create = seen.find((r) => r.op === 'orders.create');
    assert.equal(create?.status, 200);
    const body = create?.body as { status: string; links: { href: string; rel: string }[]; create_time?: string };
    assert.equal(body.status, 'PAYER_ACTION_REQUIRED');
    assert.equal(body.create_time, undefined);
    assert.ok(body.links.find((l) => l.rel === 'self')?.href.startsWith(`${SANDBOX_LINK_HOST}/v2/checkout/orders/`));
  });

  it('charges the fee, replays a request id with 200, reads closed captures as final, and refuses a void after the final capture', async () => {
    const { fake, seen } = setup();
    const { auth } = await held(fake);
    const c1 = await fake.captureAuthorization(auth.authorizationId, cap('cap:1', 7_601, false, 'HMS-job_0001-R'));
    assert.equal(c1.finalCapture, false);
    assert.equal(c1.paypalFeeCents, 314);
    const again = await fake.captureAuthorization(auth.authorizationId, cap('cap:1', 7_601, false, 'HMS-job_0001-R'));
    assert.equal(again.captureId, c1.captureId);
    assert.equal(seen.filter((r) => r.op === 'authorizations.capture').map((r) => r.status).join(','), '201,200');
    const dup = await refusal(fake.captureAuthorization(auth.authorizationId, cap('cap:dup', 100, false, 'HMS-job_0001-R')));
    assert.deepEqual([dup.httpStatus, dup.issue], [422, 'DUPLICATE_TRANSACTION']);
    await fake.captureAuthorization(auth.authorizationId, cap('cap:2', 875, true, 'HMS-job_0001-S'));
    assert.equal((await fake.getCapture(c1.captureId)).finalCapture, true, 'the authorization is closed');
    const voided = await refusal(fake.voidAuthorization(auth.authorizationId, 'void:1'));
    assert.deepEqual([voided.issue, voided.code], ['PREVIOUSLY_CAPTURED', 'HOLD_CLOSED']);
    const third = await refusal(fake.captureAuthorization(auth.authorizationId, cap('cap:3', 100, true, 'HMS-job_0001-X')));
    assert.equal(third.issue, 'AUTHORIZATION_ALREADY_CAPTURED');
  });

  it('allows captures up to exactly 115% of the authorization, like the sandbox ($11.50 on $10.00)', async () => {
    const { fake } = setup();
    const { auth } = await held(fake, {
      requestId: 'order:bid_0009',
      invoiceId: 'HMS-bid_0009',
      customId: 'bid_0009',
      amountCents: 1_000,
      breakdown: { itemTotalCents: 1_000, shippingCents: 0 },
      items: [{ name: 'Plush (shop price, up to)', quantity: 1, unitAmountCents: 1_000, category: 'PHYSICAL_GOODS' }],
      shipping: { type: 'SHIPPING', preference: 'NO_SHIPPING' },
    });
    assert.equal((await refusal(fake.captureAuthorization(auth.authorizationId, cap('c0', 1_151, false, 'HMS-job_0009-X')))).issue, 'MAX_CAPTURE_AMOUNT_EXCEEDED');
    await fake.captureAuthorization(auth.authorizationId, cap('c1', 500, false, 'HMS-job_0009-R'));
    assert.equal((await refusal(fake.captureAuthorization(auth.authorizationId, cap('c2', 651, false, 'HMS-job_0009-Y')))).code, 'OVER_CAPTURE');
    const last = await fake.captureAuthorization(auth.authorizationId, cap('c3', 650, true, 'HMS-job_0009-S'));
    assert.equal(last.status, 'COMPLETED');
    assert.equal((await fake.getAuthorization(auth.authorizationId)).status, 'CAPTURED');
  });

  it('accepts the same tracker twice and refuses a capture from another order', async () => {
    const { fake } = setup();
    const a = await held(fake);
    const b = await held(fake, { requestId: 'order:bid_0002', invoiceId: 'HMS-bid_0002', customId: 'bid_0002' });
    const ca = await fake.captureAuthorization(a.auth.authorizationId, cap('ca', 1_000, false, 'HMS-job_0001-R'));
    const cb = await fake.captureAuthorization(b.auth.authorizationId, cap('cb', 1_000, false, 'HMS-job_0002-R'));
    const track = { captureId: ca.captureId, trackingNumber: 'HPG-2611-1200-0042', carrierName: 'Harbor Parcel Ground', notifyPayer: true };
    await fake.addTracking(a.order.orderId, { requestId: 'track:1', ...track });
    await fake.addTracking(a.order.orderId, { requestId: 'track:2', ...track });
    const order = await fake.getOrder(a.order.orderId);
    assert.deepEqual(order.trackers.map((t) => [t.trackingNumber, t.captureId, t.status]), [['HPG-2611-1200-0042', ca.captureId, 'SHIPPED']]);
    const foreign = await refusal(fake.addTracking(a.order.orderId, { requestId: 'track:3', ...track, captureId: cb.captureId }));
    assert.deepEqual([foreign.httpStatus, foreign.issue], [422, 'CAPTURE_ID_NOT_FOUND']);
  });

  it('refuses a reauthorization inside the honor period with REAUTHORIZATION_TOO_SOON', async () => {
    const { fake, advance } = setup();
    const { auth } = await held(fake);
    advance(2 * 86_400_000);
    const early = await refusal(fake.reauthorize(auth.authorizationId, { requestId: 'reauth:1', amountCents: 11_500 }));
    assert.deepEqual([early.httpStatus, early.issue, early.code], [422, 'REAUTHORIZATION_TOO_SOON', 'PAYPAL_ERROR']);
  });

  it('walks a payout through PENDING, then SUCCESS with the batch PROCESSING, then SUCCESS; fees $0.25; a paid item cannot be cancelled', async () => {
    const { fake, advance, seen } = setup({ payoutProcessingMs: 15_000, payoutSettleMs: 60_000 });
    const created = await fake.createPayout({
      senderBatchId: 'payout:job_0001:fee@run1',
      emailSubject: 'You have a payout from HoldMySpot',
      emailMessage: 'Queue fee.',
      items: [{ receiverEmail: 'wei@holdmyspot.test', amountCents: 1_080, note: 'Queue fee', senderItemId: 'po_0001' }],
    });
    assert.deepEqual([created.batchStatus, created.items[0]?.status], ['PENDING', 'PENDING']);
    const first = await fake.getPayoutBatch(created.batchId);
    assert.deepEqual([first.batchStatus, first.items[0]?.status], ['PENDING', 'PENDING']);
    advance(15_000);
    const paid = await fake.getPayoutBatch(created.batchId);
    assert.deepEqual([paid.batchStatus, paid.items[0]?.status], ['PROCESSING', 'SUCCESS']);
    const body = seen.filter((r) => r.op === 'payouts.get').at(-1)?.body as { batch_header: { fees: { value: string }; funding_source: string }; items: { payout_item_fee: { value: string } }[] };
    assert.deepEqual([body.batch_header.fees.value, body.items[0]?.payout_item_fee.value, body.batch_header.funding_source], ['0.25', '0.25', 'BALANCE']);
    advance(60_000);
    assert.equal((await fake.getPayoutBatch(created.batchId)).batchStatus, 'SUCCESS');
    const cancel = await refusal(fake.cancelUnclaimedPayoutItem(paid.items[0]!.itemId!));
    assert.deepEqual([cancel.httpStatus, cancel.paypalName, cancel.issue, cancel.code], [400, 'ITEM_INCORRECT_STATUS', null, 'PAYPAL_ERROR']);
  });
});
