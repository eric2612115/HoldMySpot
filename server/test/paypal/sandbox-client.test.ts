import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ContractError } from '@holdmyspot/shared';
import { toPayPalFailure } from '../../src/ports/payments.ts';
import { assertSandboxBaseUrl, createSandboxPayPal, isDuplicatePayout, needsNewApproval, PayPalError } from '../../src/paypal/index.ts';
import { fixture, heroOrderInput, jsonBody, localOrderInput, makeClient, OAUTH, TEST_SECRET, TEST_TOKEN, testSettings, type Step } from './helpers.ts';

/**
 * The sandbox adapter against a scripted fetch that plays back documented
 * PayPal responses (fixtures/documented-responses.json). No network.
 */

const AUTH_ID = '0AW2184448108334S';
const ORDER_ID = '5O190127TN364715T';
const CAPTURE_ID = '7TK53561YB803214S';

function done(t: { script: { problems: string[]; left(): number } }): void {
  assert.deepEqual(t.script.problems, []);
  assert.equal(t.script.left(), 0, 'every scripted response was used');
}

async function rejectsWith(p: Promise<unknown>): Promise<PayPalError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof PayPalError, `expected PayPalError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected the call to fail');
}

describe('sandbox adapter: safety', () => {
  it('refuses any base URL other than the PayPal sandbox', () => {
    assert.equal(assertSandboxBaseUrl('https://api-m.sandbox.paypal.com/'), 'https://api-m.sandbox.paypal.com');
    assert.throws(() => assertSandboxBaseUrl('https://api-m.paypal.com'), /Refusing/);
    assert.throws(
      () => createSandboxPayPal({ settings: testSettings(), baseUrl: 'https://api-m.paypal.com' as 'https://api-m.sandbox.paypal.com', timeoutMs: 1000, log: () => {} }),
      /Refusing/,
    );
    assert.throws(
      () => createSandboxPayPal({ settings: { ...testSettings(), env: 'live' as 'sandbox' }, baseUrl: 'https://api-m.sandbox.paypal.com', timeoutMs: 1000, log: () => {} }),
      /sandbox/,
    );
  });

  it('gets one OAuth token, reuses it, and never logs the secret or the token', async () => {
    const t = makeClient([OAUTH, { method: 'GET', path: `/v2/payments/captures/${CAPTURE_ID}`, respond: fixture('capture-receipt') }, { method: 'GET', respond: fixture('capture-receipt') }]);
    await t.client.getCapture(CAPTURE_ID);
    await t.client.getCapture(CAPTURE_ID);
    done(t);
    const oauth = t.script.calls.filter((c) => c.path === '/v1/oauth2/token');
    assert.equal(oauth.length, 1);
    assert.equal(oauth[0]?.headers.authorization, `Basic ${Buffer.from(`test-client-id:${TEST_SECRET}`).toString('base64')}`);
    assert.equal(oauth[0]?.body, 'grant_type=client_credentials');
    const api = t.script.calls.find((c) => c.path.startsWith('/v2/'));
    assert.equal(api?.headers.authorization, `Bearer ${TEST_TOKEN}`);
    const logged = t.logs.join('\n');
    assert.ok(!logged.includes(TEST_SECRET));
    assert.ok(!logged.includes(TEST_TOKEN));
    assert.ok(!/Basic |Bearer /.test(logged));
  });

  it('shares one token request between concurrent first calls', async () => {
    const t = makeClient([OAUTH]);
    await Promise.all([t.client.tokenScopes(), t.client.tokenScopes()]);
    assert.equal(t.script.calls.filter((c) => c.path === '/v1/oauth2/token').length, 1);
    done(t);
  });

  it('refreshes the token before it expires and after a 401', async () => {
    const t = makeClient([
      OAUTH,
      { method: 'GET', path: `/v2/payments/captures/${CAPTURE_ID}`, respond: fixture('capture-receipt') },
      OAUTH,
      { method: 'GET', respond: fixture('capture-receipt') },
      { method: 'GET', respond: fixture('error-unauthorized-token') },
      OAUTH,
      { method: 'GET', respond: fixture('capture-receipt') },
    ]);
    await t.client.getCapture(CAPTURE_ID);
    t.clock.advance((32_400 - 59) * 1000); // within 60 s of expires_in
    await t.client.getCapture(CAPTURE_ID);
    await t.client.getCapture(CAPTURE_ID); // 401 -> one refresh -> retry
    assert.equal(t.script.calls.filter((c) => c.path === '/v1/oauth2/token').length, 3);
    done(t);
  });

  it('reports wrong credentials without retrying', async () => {
    const t = makeClient([{ method: 'POST', path: '/v1/oauth2/token', respond: fixture('error-oauth-invalid-client') }]);
    const err = await rejectsWith(t.client.tokenScopes());
    assert.equal(err.code, 'PAYPAL_ERROR');
    assert.equal(err.paypalName, 'invalid_client');
    assert.equal(err.retryable, false);
    assert.ok(!err.message.includes(TEST_SECRET));
    done(t);
  });
});

describe('sandbox adapter: orders', () => {
  it('creates an AUTHORIZE order with the documented body and headers', async () => {
    const t = makeClient([OAUTH, { method: 'POST', path: '/v2/checkout/orders', respond: fixture('order-create') }]);
    const res = await t.client.createOrder(heroOrderInput());
    assert.deepEqual(res, {
      orderId: ORDER_ID,
      status: 'PAYER_ACTION_REQUIRED',
      debugId: 'f1a2b3c4d5e6f',
      approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER_ID}`,
    });
    const call = t.script.calls[1];
    assert.equal(call?.headers['paypal-request-id'], 'order:bid_0001');
    assert.equal(call?.headers.prefer, 'return=representation');
    assert.equal(call?.headers['content-type'], 'application/json');
    assert.deepEqual(jsonBody(call), {
      intent: 'AUTHORIZE',
      purchase_units: [
        {
          reference_id: 'bid_0001',
          custom_id: 'bid_0001',
          invoice_id: 'HMS-bid_0001',
          description: 'HoldMySpot hold: up to $115.00 for 2 x Lucky Cat plush, launch-day drop',
          soft_descriptor: 'HOLDMYSPOT',
          amount: {
            currency_code: 'USD',
            value: '115.00',
            breakdown: { item_total: { currency_code: 'USD', value: '80.00' }, shipping: { currency_code: 'USD', value: '35.00' } },
          },
          items: [
            { name: 'Lucky Cat plush, launch-day drop (shop price, up to)', quantity: '2', unit_amount: { currency_code: 'USD', value: '28.00' }, category: 'PHYSICAL_GOODS' },
            { name: 'Queue fee (up to)', quantity: '2', unit_amount: { currency_code: 'USD', value: '12.00' } },
          ],
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'HoldMySpot',
            shipping_preference: 'GET_FROM_FILE',
            user_action: 'CONTINUE',
            return_url: 'http://127.0.0.1:8796/api/paypal/return',
            cancel_url: 'http://127.0.0.1:8796/api/paypal/cancel',
          },
        },
      },
    });
    done(t);
  });

  it('builds local pickup and Venmo orders', async () => {
    const t = makeClient([OAUTH, { method: 'POST', respond: fixture('order-create') }, { method: 'POST', respond: fixture('order-create') }]);
    await t.client.createOrder(localOrderInput());
    const local = jsonBody(t.script.calls[1]);
    const unit = (local.purchase_units as Record<string, unknown>[])[0];
    assert.deepEqual(unit?.shipping, { type: 'PICKUP_FROM_PERSON' });
    assert.deepEqual((unit?.amount as Record<string, unknown>).breakdown, { item_total: { currency_code: 'USD', value: '50.00' } });
    assert.equal(((local.payment_source as Record<string, Record<string, Record<string, unknown>>>).paypal?.experience_context)?.shipping_preference, 'NO_SHIPPING');

    await t.client.createOrder(heroOrderInput({ funding: 'venmo', requestId: 'order:bid_0003', invoiceId: 'HMS-bid_0003', customId: 'bid_0003' }));
    assert.deepEqual(jsonBody(t.script.calls[2]).payment_source, { venmo: { experience_context: { brand_name: 'HoldMySpot', shipping_preference: 'GET_FROM_FILE' } } });
    done(t);
  });

  it('checks amounts and fields before calling PayPal', async () => {
    const t = makeClient([]);
    await assert.rejects(t.client.createOrder(heroOrderInput({ amountCents: 11_400 })), (e: unknown) => e instanceof ContractError && e.code === 'INVALID_AMOUNT');
    await assert.rejects(
      t.client.createOrder(heroOrderInput({ breakdown: { itemTotalCents: 8_100, shippingCents: 3_400 } })),
      (e: unknown) => e instanceof ContractError && e.code === 'INVALID_AMOUNT' && /item lines/.test(e.message),
    );
    await assert.rejects(t.client.createOrder(heroOrderInput({ invoiceId: 'bid_0001' })), (e: unknown) => e instanceof ContractError && /HMS-/.test(e.message));
    await assert.rejects(t.client.createOrder(heroOrderInput({ softDescriptor: 'HOLDMYSPOT QUEUE FEE 2026' })), (e: unknown) => e instanceof ContractError && e.code === 'BAD_REQUEST');
    await assert.rejects(t.client.createOrder(heroOrderInput({ amountCents: 115.5 })), (e: unknown) => e instanceof ContractError && e.code === 'INVALID_AMOUNT');
    assert.equal(t.script.calls.length, 0, 'nothing reached PayPal, not even OAuth');
  });

  it('authorizes an approved order and reads the hold', async () => {
    const t = makeClient([OAUTH, { method: 'POST', path: `/v2/checkout/orders/${ORDER_ID}/authorize`, respond: fixture('order-authorize') }]);
    const a = await t.client.authorizeOrder(ORDER_ID, 'auth:bid_0001');
    assert.deepEqual(a, {
      authorizationId: AUTH_ID,
      orderId: ORDER_ID,
      status: 'CREATED',
      amountCents: 11_500,
      createdAt: Date.parse('2026-11-08T01:00:05Z'),
      expiresAt: Date.parse('2026-12-07T01:00:05Z'),
      fundingSource: 'paypal',
      shipTo: { country: 'US', region: 'NY', city: 'New York', postalCode: '10001' },
      debugId: 'a9b8c7d6e5f40',
    });
    assert.equal(t.script.calls[1]?.headers['paypal-request-id'], 'auth:bid_0001');
    done(t);
  });

  it('reads Venmo as the funding source', async () => {
    const venmo = fixture('order-authorize');
    (venmo.body as Record<string, unknown>).payment_source = { venmo: { email_address: 'buyer@personal.example.com', account_id: 'QYR5Z8XDVJNXQ', user_name: 'test-buyer' } };
    const t = makeClient([OAUTH, { method: 'POST', respond: venmo }]);
    assert.equal((await t.client.authorizeOrder(ORDER_ID, 'auth:bid_0001')).fundingSource, 'venmo');
    done(t);
  });

  it('INSTRUMENT_DECLINED on authorize asks for a new approval and is not retried', async () => {
    const t = makeClient([OAUTH, { method: 'POST', respond: fixture('error-instrument-declined') }]);
    const err = await rejectsWith(t.client.authorizeOrder(ORDER_ID, 'auth:bid_0001'));
    assert.equal(err.code, 'PAYPAL_DECLINED');
    assert.equal(err.issue, 'INSTRUMENT_DECLINED');
    assert.equal(err.restartCheckout, true);
    assert.equal(err.retryable, false);
    assert.equal(err.debugId, '90957fca61718');
    assert.equal(needsNewApproval(err), true);
    assert.deepEqual(toPayPalFailure(err), {
      code: 'PAYPAL_DECLINED',
      paypalName: 'UNPROCESSABLE_ENTITY',
      issue: 'INSTRUMENT_DECLINED',
      httpStatus: 422,
      debugId: '90957fca61718',
      retryable: false,
    });
    done(t);
  });

  it('a repeated authorize returns the existing authorization', async () => {
    const t = makeClient([
      OAUTH,
      { method: 'POST', path: `/v2/checkout/orders/${ORDER_ID}/authorize`, respond: fixture('error-order-already-authorized') },
      { method: 'GET', path: `/v2/checkout/orders/${ORDER_ID}`, respond: { ...fixture('order-authorize'), status: 200 } },
    ]);
    const a = await t.client.authorizeOrder(ORDER_ID, 'auth:bid_0001:retry');
    assert.equal(a.authorizationId, AUTH_ID);
    assert.equal(a.status, 'CREATED');
    done(t);
  });

  it('adds tracking with carrier OTHER and treats a tracker PayPal already has as done', async () => {
    const t = makeClient([
      OAUTH,
      { method: 'POST', path: `/v2/checkout/orders/${ORDER_ID}/track`, respond: fixture('order-tracked') },
      {
        method: 'POST',
        respond: { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'DUPLICATE_TRACKING_INFO' }], debug_id: 'x1' } },
      },
    ]);
    const input = { requestId: 'track:job_0001', captureId: CAPTURE_ID, trackingNumber: 'HMS0001TRACK', carrierName: 'Harbor Parcel Ground', notifyPayer: true };
    await t.client.addTracking(ORDER_ID, input);
    assert.deepEqual(jsonBody(t.script.calls[1]), {
      capture_id: CAPTURE_ID,
      tracking_number: 'HMS0001TRACK',
      carrier: 'OTHER',
      carrier_name_other: 'Harbor Parcel Ground',
      notify_payer: true,
    });
    await t.client.addTracking(ORDER_ID, input);
    done(t);
  });
});

describe('sandbox adapter: captures, voids, renewals, refunds', () => {
  it('captures with final_capture and an HMS invoice id', async () => {
    const t = makeClient([OAUTH, { method: 'POST', path: `/v2/payments/authorizations/${AUTH_ID}/capture`, respond: fixture('capture-receipt') }]);
    const c = await t.client.captureAuthorization(AUTH_ID, {
      requestId: 'cap:job_0001:receipt',
      amountCents: 7_601,
      finalCapture: false,
      invoiceId: 'HMS-job_0001-R',
      noteToPayer: 'Little Lantern Toys receipt, 2 plush, plus the queue fee',
      softDescriptor: 'HOLDMYSPOT',
    });
    assert.deepEqual(c, {
      captureId: CAPTURE_ID,
      authorizationId: AUTH_ID,
      status: 'COMPLETED',
      amountCents: 7_601,
      finalCapture: false,
      paypalFeeCents: 314,
      createdAt: Date.parse('2026-11-08T01:44:00Z'),
      debugId: 'e4f5061728394',
    });
    assert.deepEqual(jsonBody(t.script.calls[1]), {
      amount: { currency_code: 'USD', value: '76.01' },
      invoice_id: 'HMS-job_0001-R',
      final_capture: false,
      note_to_payer: 'Little Lantern Toys receipt, 2 plush, plus the queue fee',
      soft_descriptor: 'HOLDMYSPOT',
    });
    assert.equal(t.script.calls[1]?.headers['paypal-request-id'], 'cap:job_0001:receipt');
    assert.ok(t.logs.some((l) => l.includes('debug_id=e4f5061728394') && l.includes('request_id=cap:job_0001:receipt') && l.includes('-> 201')));
    done(t);
  });

  const captureInput = { requestId: 'cap:job_0001:shipping', amountCents: 2_640, finalCapture: true, invoiceId: 'HMS-job_0001-S', noteToPayer: '', softDescriptor: 'HOLDMYSPOT' };
  const cases: [string, string, string, boolean][] = [
    ['error-authorization-expired', 'HOLD_EXPIRED', 'AUTHORIZATION_EXPIRED', false],
    ['error-authorization-voided', 'HOLD_CLOSED', 'AUTHORIZATION_VOIDED', false],
    ['error-max-capture-amount', 'OVER_CAPTURE', 'MAX_CAPTURE_AMOUNT_EXCEEDED', false],
    ['error-permission-not-granted', 'PAYPAL_ERROR', 'PERMISSION_NOT_GRANTED', false],
    ['error-not-found', 'PAYPAL_ERROR', 'INVALID_RESOURCE_ID', false],
  ];
  for (const [name, code, issue, retryable] of cases) {
    it(`maps ${issue} to ${code}`, async () => {
      const t = makeClient([OAUTH, { method: 'POST', respond: fixture(name) }]);
      const err = await rejectsWith(t.client.captureAuthorization(AUTH_ID, captureInput));
      assert.equal(err.code, code);
      assert.equal(err.issue, issue);
      assert.equal(err.retryable, retryable);
      assert.equal(err.restartCheckout, false);
      assert.ok(err.debugId);
      assert.ok(err.message.includes(err.debugId ?? ''));
      done(t);
    });
  }

  it('backs off on 429 and replays with the same PayPal-Request-Id', async () => {
    const t = makeClient([OAUTH, { method: 'POST', respond: fixture('error-rate-limit') }, { method: 'POST', respond: fixture('capture-receipt') }]);
    await t.client.captureAuthorization(AUTH_ID, captureInput);
    assert.deepEqual(t.sleeps, [2000], 'Retry-After: 2 was honoured');
    assert.equal(t.script.calls[1]?.headers['paypal-request-id'], 'cap:job_0001:shipping');
    assert.equal(t.script.calls[2]?.headers['paypal-request-id'], 'cap:job_0001:shipping');
    done(t);
  });

  it('gives up after repeated 429s with a retryable PAYPAL_UNAVAILABLE', async () => {
    const rl = { method: 'POST' as const, respond: fixture('error-rate-limit') };
    const t = makeClient([OAUTH, rl, rl, rl, rl]);
    const err = await rejectsWith(t.client.captureAuthorization(AUTH_ID, captureInput));
    assert.equal(err.code, 'PAYPAL_UNAVAILABLE');
    assert.equal(err.retryable, true);
    assert.equal(t.sleeps.length, 3);
    done(t);
  });

  it('retries 5xx and network errors only when the call can be replayed', async () => {
    const a = makeClient([OAUTH, { method: 'POST', respond: fixture('error-internal') }, { method: 'POST', respond: fixture('capture-receipt') }]);
    await a.client.captureAuthorization(AUTH_ID, captureInput);
    assert.equal(a.sleeps.length, 1);
    done(a);

    const b = makeClient([OAUTH, { method: 'GET', respond: 'network-error' }, { method: 'GET', respond: fixture('error-internal') }, { method: 'GET', respond: 'network-error' }]);
    const err = await rejectsWith(b.client.getCapture(CAPTURE_ID));
    assert.equal(err.code, 'PAYPAL_UNAVAILABLE');
    assert.equal(err.retryable, true);
    assert.equal(err.paypalName, 'NETWORK_ERROR');
    done(b);

    const c = makeClient([OAUTH, { method: 'POST', path: '/v1/notifications/verify-webhook-signature', respond: fixture('error-internal') }], { settings: { webhookId: 'WH-ID-1' } });
    const sample = webhookSample();
    const err2 = await rejectsWith(c.client.verifyWebhook(sample.headers, sample.rawBody));
    assert.equal(err2.code, 'PAYPAL_UNAVAILABLE');
    assert.equal(err2.retryable, false, 'no PayPal-Request-Id, so no blind replay');
    done(c);
  });

  it('void answers 204, then the authorization is read back', async () => {
    const t = makeClient([
      OAUTH,
      { method: 'POST', path: `/v2/payments/authorizations/${AUTH_ID}/void`, respond: { status: 204 } },
      { method: 'GET', path: `/v2/payments/authorizations/${AUTH_ID}`, respond: fixture('authorization-voided') },
      { method: 'GET', path: `/v2/checkout/orders/${ORDER_ID}`, respond: { ...fixture('order-authorize'), status: 200 } },
    ]);
    const a = await t.client.voidAuthorization(AUTH_ID, 'void:hold_0001:1');
    assert.equal(a.status, 'VOIDED');
    assert.equal(a.orderId, ORDER_ID);
    assert.equal(a.fundingSource, 'paypal', 'funding read from the order once');
    assert.equal(t.script.calls[1]?.headers['paypal-request-id'], 'void:hold_0001:1');
    done(t);
  });

  it('reauthorize returns the new authorization with the original order', async () => {
    const t = makeClient([
      OAUTH,
      { method: 'POST', path: `/v2/checkout/orders/${ORDER_ID}/authorize`, respond: fixture('order-authorize') },
      { method: 'POST', path: `/v2/payments/authorizations/${AUTH_ID}/reauthorize`, respond: fixture('authorization-reauthorized') },
    ]);
    await t.client.authorizeOrder(ORDER_ID, 'auth:bid_0001');
    const r = await t.client.reauthorize(AUTH_ID, { requestId: 'reauth:hold_0001:1', amountCents: 11_500 });
    assert.equal(r.authorizationId, '8AA831015G517922L');
    assert.equal(r.orderId, ORDER_ID);
    assert.equal(r.status, 'CREATED');
    assert.equal(r.createdAt, Date.parse('2026-11-11T09:00:00Z'));
    assert.equal(r.expiresAt, Date.parse('2026-12-07T01:00:05Z'));
    assert.equal(r.fundingSource, 'paypal');
    assert.deepEqual(jsonBody(t.script.calls[2]), { amount: { currency_code: 'USD', value: '115.00' } });
    done(t);
  });

  it('refunds part of a capture', async () => {
    const t = makeClient([OAUTH, { method: 'POST', path: `/v2/payments/captures/${CAPTURE_ID}/refund`, respond: fixture('refund-completed') }]);
    const r = await t.client.refundCapture(CAPTURE_ID, { requestId: 'refund:job_0001:1', amountCents: 500, invoiceId: 'HMS-job_0001-F1', noteToPayer: 'Partial refund' });
    assert.deepEqual(r, { refundId: '1JU08902781691411', captureId: CAPTURE_ID, status: 'COMPLETED', amountCents: 500, debugId: 'f50617283940a' });
    assert.deepEqual(jsonBody(t.script.calls[1]), { amount: { currency_code: 'USD', value: '5.00' }, invoice_id: 'HMS-job_0001-F1', note_to_payer: 'Partial refund' });
    done(t);
  });
});

describe('sandbox adapter: payouts and disputes', () => {
  it('sends one payout batch keyed by sender_batch_id and reads item statuses', async () => {
    const t = makeClient([
      OAUTH,
      { method: 'POST', path: '/v1/payments/payouts', respond: fixture('payout-create') },
      { method: 'GET', path: '/v1/payments/payouts/5UXD2E8A7EBQJ', respond: fixture('payout-batch') },
      { method: 'GET', path: '/v1/payments/payouts-item/8AELMXH8UB2P8', respond: fixture('payout-item-unclaimed') },
      { method: 'POST', path: '/v1/payments/payouts', respond: fixture('error-payout-duplicate') },
    ]);
    const input = {
      senderBatchId: 'payout:job_0001:fee',
      emailSubject: 'You have a payout from HoldMySpot',
      emailMessage: 'Queue fee for 2 plush at Little Lantern Toys.',
      items: [{ receiverEmail: 'queuer-payouts@personal.example.com', amountCents: 2_160, note: 'Queue fee, 2 x Lucky Cat plush, Little Lantern Toys', senderItemId: 'po_0001' }],
    };
    const created = await t.client.createPayout(input);
    assert.deepEqual(created, {
      batchId: '5UXD2E8A7EBQJ',
      batchStatus: 'PENDING',
      items: [{ itemId: null, senderItemId: 'po_0001', status: 'PENDING', amountCents: 2_160 }],
      debugId: '17283940a1b2c',
    });
    assert.equal(t.script.calls[1]?.headers['paypal-request-id'], 'payout:job_0001:fee');
    assert.deepEqual(jsonBody(t.script.calls[1]), {
      sender_batch_header: {
        sender_batch_id: 'payout:job_0001:fee',
        email_subject: 'You have a payout from HoldMySpot',
        email_message: 'Queue fee for 2 plush at Little Lantern Toys.',
        recipient_type: 'EMAIL',
      },
      items: [
        {
          recipient_type: 'EMAIL',
          amount: { value: '21.60', currency: 'USD' },
          note: 'Queue fee, 2 x Lucky Cat plush, Little Lantern Toys',
          sender_item_id: 'po_0001',
          receiver: 'queuer-payouts@personal.example.com',
          notification_language: 'en-US',
        },
      ],
    });
    const batch = await t.client.getPayoutBatch('5UXD2E8A7EBQJ');
    assert.equal(batch.batchStatus, 'SUCCESS');
    // feeCents: PayPal's payout_item_fee as this documented answer gives it (D-105).
    assert.deepEqual(batch.items, [{ itemId: '8AELMXH8UB2P8', senderItemId: 'po_0001', status: 'SUCCESS', amountCents: 2_160, feeCents: 0 }]);
    const item = await t.client.getPayoutItem('8AELMXH8UB2P8');
    assert.equal(item.status, 'UNCLAIMED');
    assert.equal(item.errorName, 'RECEIVER_UNREGISTERED');
    assert.equal(item.batchId, '5UXD2E8A7EBQJ');
    const dup = await rejectsWith(t.client.createPayout(input));
    assert.equal(dup.code, 'PAYPAL_ERROR');
    assert.equal(dup.paypalName, 'USER_BUSINESS_ERROR');
    assert.equal(dup.retryable, false);
    done(t);
  });

  it('lists disputes on HMS invoices only', async () => {
    const t = makeClient([
      OAUTH,
      { method: 'GET', path: '/v1/customer/disputes', respond: fixture('disputes-list') },
      { method: 'GET', path: '/v1/customer/disputes/PP-D-27803', respond: fixture('dispute-hms') },
      { method: 'GET', path: '/v1/customer/disputes/PP-D-27804', respond: fixture('dispute-other-app') },
    ]);
    const since = Date.parse('2026-11-08T00:00:00Z');
    const disputes = await t.client.listDisputes(since);
    assert.deepEqual(disputes, [
      {
        disputeId: 'PP-D-27803',
        captureIds: [CAPTURE_ID],
        invoiceIds: ['HMS-job_0001-R'],
        reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        status: 'WAITING_FOR_SELLER_RESPONSE',
        outcome: null,
        amountCents: 7_601,
        createdAt: Date.parse('2026-11-08T07:00:00.000Z'),
        updatedAt: Date.parse('2026-11-08T07:00:00.000Z'),
      },
    ]);
    const search = new URLSearchParams(t.script.calls[1]?.search);
    assert.equal(search.get('start_time'), new Date(since).toISOString());
    assert.equal(search.get('page_size'), '50');
    done(t);
  });

  it('sends evidence as multipart with an input part, and refuses file types PayPal does not take', async () => {
    const t = makeClient([
      OAUTH,
      { method: 'POST', path: '/v1/customer/disputes/PP-D-27803/provide-evidence', respond: fixture('dispute-action') },
      { method: 'GET', path: '/v1/customer/disputes/PP-D-27803', respond: fixture('dispute-hms') },
    ]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const d = await t.client.provideEvidence('PP-D-27803', {
      note: 'Receipt and item photo checked; parcel tracked.',
      files: [{ name: 'receipt.jpg', contentType: 'image/jpeg', bytes: jpeg }],
      tracking: { carrierName: 'Harbor Parcel Ground', trackingNumber: 'HMS0001TRACK' },
    });
    assert.equal(d.disputeId, 'PP-D-27803');
    const form = t.script.calls[1]?.body;
    assert.ok(form instanceof FormData);
    const input = JSON.parse(await (form.get('input') as Blob).text()) as { evidences: Record<string, unknown>[] };
    assert.deepEqual(input.evidences[0], {
      evidence_type: 'PROOF_OF_FULFILLMENT',
      notes: 'Receipt and item photo checked; parcel tracked.',
      evidence_info: { tracking_info: [{ carrier_name: 'OTHER', carrier_name_other: 'Harbor Parcel Ground', tracking_number: 'HMS0001TRACK' }] },
      documents: [{ name: 'receipt.jpg' }],
    });
    const file = form.get('file1');
    assert.ok(file instanceof Blob);
    assert.equal(file.type, 'image/jpeg');
    assert.equal(t.script.calls[1]?.headers['content-type'], undefined, 'fetch adds the multipart boundary itself');
    done(t);

    const u = makeClient([]);
    await assert.rejects(
      u.client.provideEvidence('PP-D-27803', { note: 'x', files: [{ name: 'a.webp', contentType: 'image/webp', bytes: jpeg }] }),
      (e: unknown) => e instanceof ContractError && /JPEG, PNG, GIF or PDF/.test(e.message),
    );
    assert.equal(u.script.calls.length, 0);
  });

  it('adjudicates (sandbox only) and accepts claims with the documented bodies', async () => {
    const t = makeClient([
      OAUTH,
      { method: 'POST', path: '/v1/customer/disputes/PP-D-27803/adjudicate', respond: fixture('dispute-action') },
      { method: 'GET', respond: fixture('dispute-resolved-seller') },
      { method: 'POST', path: '/v1/customer/disputes/PP-D-27803/accept-claim', respond: fixture('dispute-action') },
      { method: 'GET', respond: fixture('dispute-hms') },
    ]);
    const d = await t.client.adjudicate('PP-D-27803', 'SELLER_FAVOR');
    assert.equal(d.status, 'RESOLVED');
    assert.equal(d.outcome, 'RESOLVED_SELLER_FAVOUR');
    assert.deepEqual(jsonBody(t.script.calls[1]), { adjudication_outcome: 'SELLER_FAVOR' });
    await t.client.acceptClaim('PP-D-27803', 'Refunding in full.');
    assert.deepEqual(jsonBody(t.script.calls[3]), { note: 'Refunding in full.' });
    done(t);
  });
});

function webhookSample(): { headers: Record<string, string>; rawBody: string } {
  // Odd spacing and "1.0" would change if the event were parsed and re-serialised.
  const rawBody = '{"id":"WH-1",  "event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"7TK53561YB803214S","amount":{"value":"76.10"}},"n":1.0}';
  return {
    rawBody,
    headers: {
      'PAYPAL-AUTH-ALGO': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270',
      'paypal-transmission-id': '69cd13f0-d67a-11e5-baa3-778b53f4ae55',
      'paypal-transmission-sig': 'lmI95Jx3Y9nhR5SJWlHVIWpg4AgFk7n9bCHSRxbrd8A9zrhdu2rMyFrmz+Zjh3s3boXB07VXCXUZy/UFzUlnGJn0wDugt7FlSvdKeIJenLRemUxYCPVoEZzg9VFNqOa48gMkvF+XTpxBeUx/kWy6B5cp7GkT2+pOowfRK7OaynuxUoKW3JcMWw272VKjLTtTAShncla7tGF+55rxyt2KNZIIqxNMJ48RDZheGU5w1npu9dZHnPgTXB9iomeVRoD8O/jhRpnKsGrDschyNdkeh81BJJMH4Ctc6lnCCquoP/GzCzz33MMsNdid7vL/NIWaCsekQpW26FpWPi/tfj8nLA==',
      'paypal-transmission-time': '2026-11-08T01:44:30Z',
    },
  };
}

describe('sandbox adapter: webhooks and scopes', () => {
  it('answers false without PAYPAL_WEBHOOK_ID, without calling PayPal', async () => {
    const t = makeClient([]);
    const s = webhookSample();
    assert.equal(await t.client.verifyWebhook(s.headers, s.rawBody), false);
    assert.equal(t.script.calls.length, 0);
  });

  it('embeds the raw event byte for byte and reads verification_status', async () => {
    const t = makeClient(
      [
        OAUTH,
        { method: 'POST', path: '/v1/notifications/verify-webhook-signature', respond: fixture('webhook-verify-success') },
        { method: 'POST', respond: fixture('webhook-verify-failure') },
      ],
      { settings: { webhookId: '1JE4291016473214C' } },
    );
    const s = webhookSample();
    assert.equal(await t.client.verifyWebhook(s.headers, s.rawBody), true);
    const sent = t.script.calls[1]?.body;
    assert.equal(typeof sent, 'string');
    assert.ok((sent as string).endsWith(`"webhook_event":${s.rawBody}}`), 'raw body kept exactly');
    const parsed = JSON.parse(sent as string) as Record<string, unknown>;
    assert.equal(parsed.webhook_id, '1JE4291016473214C');
    assert.equal(parsed.auth_algo, 'SHA256withRSA');
    assert.equal(parsed.transmission_id, '69cd13f0-d67a-11e5-baa3-778b53f4ae55');
    assert.equal(t.script.calls[1]?.headers['paypal-request-id'], undefined);
    assert.equal(await t.client.verifyWebhook(s.headers, s.rawBody), false);
    done(t);
  });

  it('answers false for missing headers or a certificate outside paypal.com, without calling PayPal', async () => {
    const t = makeClient([], { settings: { webhookId: '1JE4291016473214C' } });
    const s = webhookSample();
    const missing: Record<string, string> = { ...s.headers };
    delete missing['paypal-transmission-sig'];
    assert.equal(await t.client.verifyWebhook(missing, s.rawBody), false);
    assert.equal(await t.client.verifyWebhook({ ...s.headers, 'paypal-cert-url': 'https://certs.example.com/cert.pem' }, s.rawBody), false);
    assert.equal(await t.client.verifyWebhook(s.headers, 'not json'), false);
    assert.equal(t.script.calls.length, 0);
  });

  it('reports token scopes (names only) and records API responses but never the OAuth body', async () => {
    const recorded: string[] = [];
    const t = makeClient([OAUTH, { method: 'GET', respond: fixture('capture-receipt') }], { extras: { onResponse: (r) => recorded.push(r.op) } });
    const scopes = await t.client.tokenScopes();
    assert.ok(scopes.includes('https://uri.paypal.com/payments/payouts'));
    assert.ok(scopes.every((s) => !s.includes(TEST_TOKEN)));
    await t.client.getCapture(CAPTURE_ID);
    assert.deepEqual(recorded, ['captures.get']);
    done(t);
  });
});

describe('sandbox adapter: thin responses after money moved', () => {
  it('a capture response without links or amount still reports the capture', async () => {
    const t = makeClient([OAUTH, { method: 'POST', respond: { status: 201, headers: { 'paypal-debug-id': 'thin1' }, body: { id: 'CAPTHIN0000000001', status: 'COMPLETED' } } }]);
    const c = await t.client.captureAuthorization(AUTH_ID, { requestId: 'cap:job_0001:receipt', amountCents: 7_601, finalCapture: false, invoiceId: 'HMS-job_0001-R', noteToPayer: '', softDescriptor: 'HOLDMYSPOT' });
    assert.deepEqual([c.captureId, c.authorizationId, c.amountCents, c.finalCapture, c.status], ['CAPTHIN0000000001', AUTH_ID, 7_601, false, 'COMPLETED']);
    done(t);
  });

  it('a reauthorization without an order link finds the order through the original authorization', async () => {
    const thin = fixture('authorization-reauthorized');
    (thin.body as Record<string, unknown>).links = [];
    const t = makeClient([
      OAUTH,
      { method: 'POST', path: `/v2/payments/authorizations/${AUTH_ID}/reauthorize`, respond: thin },
      { method: 'GET', path: `/v2/payments/authorizations/${AUTH_ID}`, respond: fixture('authorization-get') },
      { method: 'GET', path: `/v2/checkout/orders/${ORDER_ID}`, respond: { ...fixture('order-authorize'), status: 200 } },
    ]);
    const r = await t.client.reauthorize(AUTH_ID, { requestId: 'reauth:hold_0001:1', amountCents: 11_500 });
    assert.equal(r.authorizationId, '8AA831015G517922L');
    assert.equal(r.orderId, ORDER_ID);
    done(t);
  });

  it('recognises a payout batch PayPal already has', async () => {
    const t = makeClient([OAUTH, { method: 'POST', respond: fixture('error-payout-duplicate') }]);
    const err = await rejectsWith(
      t.client.createPayout({ senderBatchId: 'payout:job_0001:fee', emailSubject: 's', emailMessage: 'm', items: [{ receiverEmail: 'queuer-payouts@personal.example.com', amountCents: 2_160, note: 'n', senderItemId: 'po_0001' }] }),
    );
    assert.equal(isDuplicatePayout(err), true);
    assert.equal(isDuplicatePayout(new Error('x')), false);
    done(t);
  });
});

describe('sandbox adapter: requests carry no secrets', () => {
  it('no request except OAuth carries the client secret', async () => {
    const steps: Step[] = [OAUTH, { method: 'POST', respond: fixture('order-create') }, { method: 'POST', respond: fixture('order-authorize') }, { method: 'POST', respond: fixture('capture-receipt') }];
    const t = makeClient(steps);
    const o = await t.client.createOrder(heroOrderInput());
    await t.client.authorizeOrder(o.orderId, 'auth:bid_0001');
    await t.client.captureAuthorization(AUTH_ID, { requestId: 'cap:job_0001:receipt', amountCents: 7_601, finalCapture: false, invoiceId: 'HMS-job_0001-R', noteToPayer: '', softDescriptor: 'HOLDMYSPOT' });
    for (const c of t.script.calls.slice(1)) {
      assert.ok(!JSON.stringify(c.headers).includes(Buffer.from(`test-client-id:${TEST_SECRET}`).toString('base64')));
      assert.ok(typeof c.body !== 'string' || !c.body.includes(TEST_SECRET));
    }
    done(t);
  });
});
