import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  disputeFromPayPal,
  holdFromAuthorization,
  isFinalPayoutItem,
  ledgerFromCapture,
  parseInvoiceId,
  payoutFromItem,
  summarizeWebhookEvent,
  verifyWebhookEvent,
} from '../../src/paypal/index.ts';
import { splitTrackerId } from '../../src/paypal/wire.ts';
import { fixtureBody } from './helpers.ts';

describe('PayPal status mapping (PAYPAL-MAPPING.md section 6)', () => {
  it('maps authorizations to hold statuses', () => {
    assert.deepEqual(holdFromAuthorization('CREATED'), { status: 'held', matchable: true, expired: false });
    assert.deepEqual(holdFromAuthorization('PENDING'), { status: 'held', matchable: false, expired: false });
    assert.deepEqual(holdFromAuthorization('PARTIALLY_CAPTURED'), { status: 'partially_captured', matchable: true, expired: false });
    assert.deepEqual(holdFromAuthorization('CAPTURED'), { status: 'captured', matchable: false, expired: false });
    assert.deepEqual(holdFromAuthorization('VOIDED'), { status: 'released', matchable: false, expired: false });
    assert.deepEqual(holdFromAuthorization('EXPIRED'), { status: 'released', matchable: false, expired: true });
    assert.deepEqual(holdFromAuthorization('DENIED'), { status: 'failed', matchable: false, expired: false });
  });

  it('maps captures to ledger statuses', () => {
    assert.equal(ledgerFromCapture('COMPLETED'), 'succeeded');
    assert.equal(ledgerFromCapture('PARTIALLY_REFUNDED'), 'succeeded');
    assert.equal(ledgerFromCapture('PENDING'), 'pending');
    assert.equal(ledgerFromCapture('DECLINED'), 'failed');
    assert.equal(ledgerFromCapture('FAILED'), 'failed');
  });

  it('maps payout items and knows which are final', () => {
    const expected: Record<string, string> = {
      SUCCESS: 'succeeded',
      UNCLAIMED: 'unclaimed',
      PENDING: 'pending',
      NEW: 'pending',
      ONHOLD: 'pending',
      FAILED: 'failed',
      BLOCKED: 'failed',
      DENIED: 'failed',
      RETURNED: 'returned',
      REFUNDED: 'returned',
      REVERSED: 'returned',
      CANCELED: 'cancelled',
    };
    for (const [paypal, ours] of Object.entries(expected)) assert.equal(payoutFromItem(paypal as Parameters<typeof payoutFromItem>[0]), ours, paypal);
    assert.equal(isFinalPayoutItem('SUCCESS'), true);
    assert.equal(isFinalPayoutItem('UNCLAIMED'), false, 'an unclaimed payout can still be claimed or returned');
    assert.equal(isFinalPayoutItem('PENDING'), false);
  });

  it('maps disputes', () => {
    assert.deepEqual(disputeFromPayPal({ status: 'WAITING_FOR_SELLER_RESPONSE', outcome: null }), { status: 'waiting_for_seller', outcome: null });
    assert.deepEqual(disputeFromPayPal({ status: 'UNDER_REVIEW', outcome: null }), { status: 'under_review', outcome: null });
    assert.deepEqual(disputeFromPayPal({ status: 'RESOLVED', outcome: 'RESOLVED_SELLER_FAVOUR' }), { status: 'resolved', outcome: 'seller_favor' });
    assert.deepEqual(disputeFromPayPal({ status: 'RESOLVED', outcome: 'ACCEPTED' }), { status: 'resolved', outcome: 'buyer_favor' });
    assert.deepEqual(disputeFromPayPal({ status: 'OPEN', outcome: null }), { status: 'open', outcome: null });
  });

  it('parses our invoice ids', () => {
    assert.deepEqual(parseInvoiceId('HMS-bid_0001'), { kind: 'bid', bidId: 'bid_0001' });
    assert.deepEqual(parseInvoiceId('HMS-job_0001-R'), { kind: 'job', jobId: 'job_0001', part: 'receipt', n: null });
    assert.deepEqual(parseInvoiceId('HMS-job_0001-S'), { kind: 'job', jobId: 'job_0001', part: 'shipping', n: null });
    assert.deepEqual(parseInvoiceId('HMS-job_0001-H'), { kind: 'job', jobId: 'job_0001', part: 'handover', n: null });
    assert.deepEqual(parseInvoiceId('HMS-job_0001-F2'), { kind: 'job', jobId: 'job_0001', part: 'refund', n: 2 });
    assert.deepEqual(parseInvoiceId('HMS-GATE-20261108-A'), { kind: 'other', rest: 'GATE-20261108-A' });
    assert.equal(parseInvoiceId('OTHER-APP-0042'), null);
    assert.equal(parseInvoiceId(null), null);
  });

  it('splits tracker ids even when parts contain dashes', () => {
    assert.deepEqual(splitTrackerId('FAKE-CAP-0001-HAP-0001', ['FAKE-CAP-0001']), { captureId: 'FAKE-CAP-0001', trackingNumber: 'HAP-0001' });
    assert.deepEqual(splitTrackerId('7TK53561YB803214S-HMS-0001', []), { captureId: '7TK53561YB803214S', trackingNumber: 'HMS-0001' });
    assert.equal(splitTrackerId(null, []), null);
  });
});

describe('PayPal webhooks', () => {
  it('summarizes a capture event and recognises our invoice', () => {
    const s = summarizeWebhookEvent(fixtureBody('webhook-event-capture-completed'));
    assert.deepEqual(s, {
      eventId: 'WH-58D329510W468432D-8HN650336L201105X',
      eventType: 'PAYMENT.CAPTURE.COMPLETED',
      kind: 'capture',
      resourceId: '7TK53561YB803214S',
      status: 'COMPLETED',
      invoiceId: 'HMS-job_0001-R',
      senderBatchId: null,
      ours: true,
      createdAt: Date.parse('2026-11-08T01:44:30.000Z'),
    });
  });

  it('summarizes a payout item event by its sender_batch_id', () => {
    const s = summarizeWebhookEvent(fixtureBody('webhook-event-payout-item'));
    assert.equal(s?.kind, 'payout_item');
    assert.equal(s?.resourceId, '8AELMXH8UB2P8');
    assert.equal(s?.status, 'UNCLAIMED');
    assert.equal(s?.senderBatchId, 'payout:job_0001:fee');
    assert.equal(s?.ours, true);
  });

  it('flags events from other apps on the shared account as not ours', () => {
    const e = fixtureBody('webhook-event-capture-completed');
    (e.resource as Record<string, unknown>).invoice_id = 'OTHER-APP-0042';
    assert.equal(summarizeWebhookEvent(e)?.ours, false);
    assert.equal(summarizeWebhookEvent({ hello: 'world' }), null);
  });

  it('verifies with PayPal before trusting an event, and never calls PayPal for a non-event', async () => {
    let calls = 0;
    const port = {
      verifyWebhook: async () => {
        calls += 1;
        return true;
      },
    };
    const raw = JSON.stringify(fixtureBody('webhook-event-capture-completed'));
    const ok = await verifyWebhookEvent(port, {}, raw);
    assert.equal(ok.verified, true);
    assert.equal(ok.event?.kind, 'capture');
    assert.deepEqual(await verifyWebhookEvent(port, {}, 'not json'), { verified: false, event: null });
    assert.deepEqual(await verifyWebhookEvent(port, {}, '{"a":1}'), { verified: false, event: null });
    assert.equal(calls, 1);
  });
});
