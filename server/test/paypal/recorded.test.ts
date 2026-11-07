import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { toPayPalError } from '../../src/paypal/index.ts';
import {
  mapCapture,
  mapDispute,
  mapOrderDetails,
  mapOrderSummary,
  mapPayoutBatch,
  mapPayoutItem,
  mapRefund,
  orderIdOfAuthorization,
  mapAuthorization,
} from '../../src/paypal/wire.ts';

/**
 * Real sandbox responses saved (sanitized) by scripts/sandbox-gates.mjs under
 * fixtures/recorded/<run>/. Each one must map without errors, so a change in
 * PayPal's shapes shows up here. Skipped until the gates have run once.
 */

interface Recorded {
  op: string;
  method: string;
  path: string;
  status: number;
  debugId: string | null;
  body: unknown;
}

const ROOT = fileURLToPath(new URL('./fixtures/recorded/', import.meta.url));

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : name.endsWith('.json') ? [p] : [];
  });
}

function check(r: Recorded): void {
  const now = Date.now();
  if (r.status < 200 || r.status >= 300) {
    const err = toPayPalError({ op: r.op, method: r.method, path: r.path, requestId: 'recorded', status: r.status, body: r.body, debugIdHeader: r.debugId });
    assert.ok(err.code, `${r.op}: mapped an error`);
    return;
  }
  switch (r.op) {
    case 'orders.create':
      assert.ok(mapOrderSummary(r.body, r.debugId).orderId);
      return;
    case 'orders.get':
    case 'orders.authorize':
    case 'orders.track':
      assert.ok(mapOrderDetails(r.body, r.debugId).orderId);
      return;
    case 'authorizations.get':
    case 'authorizations.reauthorize':
    case 'authorizations.void':
      if (r.status === 204) return;
      assert.ok(mapAuthorization(r.body, { orderId: orderIdOfAuthorization(r.body), fundingSource: null, shipTo: null, debugId: r.debugId, now, op: r.op }).authorizationId);
      return;
    case 'authorizations.capture':
    case 'captures.get':
      assert.ok(mapCapture(r.body, r.debugId, now).captureId);
      return;
    case 'captures.refund':
      assert.ok(mapRefund(r.body, r.debugId, 'unknown').refundId);
      return;
    case 'payouts.get':
      assert.ok(mapPayoutBatch(r.body, r.debugId).batchId);
      return;
    case 'payouts.item':
    case 'payouts.item.cancel':
      assert.ok(mapPayoutItem(r.body, r.debugId).itemId);
      return;
    case 'disputes.get':
      assert.ok(mapDispute(r.body, now).disputeId);
      return;
    default:
      return; // payouts.create, disputes.list and dispute actions are read through other calls.
  }
}

describe('recorded sandbox responses', () => {
  const all = files(ROOT);
  if (all.length === 0) {
    it('none recorded yet (run scripts/sandbox-gates.mjs with sandbox credentials)', { skip: true }, () => {});
    return;
  }
  for (const file of all) {
    it(`maps ${file.slice(ROOT.length)}`, () => {
      check(JSON.parse(readFileSync(file, 'utf8')) as Recorded);
    });
  }
});
