import { z } from 'zod';
import { CITY_IDS, ContractError, FULFILMENT_MODES } from '@holdmyspot/shared';
import type { ApiKey } from '@holdmyspot/shared';

/** Request bodies validated at the edge (zod), mirroring the contract types. */

const id = z.string().min(1).max(128);
const cents = z.number().int().min(0).max(100_000_000);
const ms = z.number().int().min(0);
const lngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const position = z.object({ lngLat, accuracyM: z.number().min(0).max(100_000) });
const destination = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('local'), cityId: z.enum(CITY_IDS) }),
  z.object({
    mode: z.literal('ship'),
    country: z.literal('US'),
    region: z.string().min(1).max(64),
    city: z.string().min(1).max(64),
    postalCode: z.string().max(16).nullable().default(null),
  }),
]);
const funding = z.enum(['paypal', 'venmo', 'paylater']);
const modes = z.array(z.enum(FULFILMENT_MODES)).min(1).max(2);
const qty = z.number().int().min(1).max(100);

export const BODY_SCHEMAS: Partial<Record<ApiKey, z.ZodType>> = {
  'POST /api/bids/quote': z.object({ shopId: id, itemId: id, qty, destination }),
  'POST /api/bids': z.object({
    shopId: id,
    itemId: id,
    qty,
    retailCapCents: cents,
    maxFeeCents: cents,
    shippingBudgetCents: cents,
    destination,
    deadlineAt: ms,
    funding,
    agent: z.object({ goal: z.string().min(1).max(500) }).nullable().default(null),
  }),
  'POST /api/bids/:bidId/authorize': z.object({ orderId: id }),
  'POST /api/bids/:bidId/approval-failed': z.object({ reason: z.enum(['cancelled', 'error']), detail: z.string().max(2000).nullable().default(null) }),
  'PATCH /api/bids/:bidId': z.object({ maxFeeCents: cents.optional(), qty: qty.optional(), deadlineAt: ms.optional() }),
  'POST /api/bids/:bidId/cancel': z.object({ reason: z.string().max(500).nullable().default(null) }),
  'POST /api/bids/:bidId/claim': z.object({ qty, etaAt: ms, modes, from: position }),
  'POST /api/bids/:bidId/agent': z.object({ enabled: z.boolean() }),
  'POST /api/asks': z.object({
    shopId: id,
    itemId: id,
    capacity: qty,
    modes,
    feeCents: cents,
    clock: z
      .object({ stepCents: cents, intervalMs: z.number().int().min(1), floorCents: cents })
      .nullable()
      .default(null),
    etaAt: ms,
    from: position,
  }),
  'POST /api/claims/:claimId/check-in': position.extend({ photoFileId: id }),
  'POST /api/jobs/:jobId/sold-out': z.object({ photoFileId: id.nullable().default(null) }),
  'POST /api/jobs/:jobId/proof': z.object({ receiptFileId: id, itemFileId: id }),
  'POST /api/jobs/:jobId/shipment': z.object({
    carrierName: z.string().min(1).max(64),
    trackingNumber: z.string().min(1).max(64),
    shippingCostCents: cents,
    dutyPaidCents: cents.default(0),
    labelFileId: id.nullable().default(null),
  }),
  'POST /api/jobs/:jobId/handover': z.object({ code: z.string().min(1).max(16) }),
  'POST /api/estimates/fee': z.object({ shopId: id, itemId: id, at: ms.nullable().default(null) }),
  'POST /api/estimates/shipping': z.object({ itemId: id, qty, destination }),
  'POST /api/ops/proofs/:proofId/review': z.object({ decision: z.enum(['pass', 'fail']), note: z.string().max(1000).default('') }),
  'POST /api/ops/jobs/:jobId/refund': z.object({ amountCents: cents, reason: z.string().min(1).max(200) }),
  'POST /api/fake/paypal/orders/:orderId/approve': z.object({
    funding: funding.default('paypal'),
    outcome: z.enum(['approve', 'cancel', 'decline']).default('approve'),
  }),
  'POST /api/demo/reset': z.object({ seed: z.number().int().nullable().default(null), scriptId: z.string().nullable().default(null) }),
  'POST /api/demo/start': z.object({ scriptId: z.string().min(1), speed: z.number().min(1).max(600).nullable().default(null) }),
  'POST /api/demo/clock': z.object({ speed: z.number().min(1).max(600).optional(), paused: z.boolean().optional(), jumpTo: ms.optional() }),
};

/** Parses a body (an empty body counts as {} so defaults apply). */
export function parseBody(key: ApiKey, body: unknown): unknown {
  const schema = BODY_SCHEMAS[key];
  if (!schema) return body;
  const res = schema.safeParse(body ?? {});
  if (!res.success) {
    const issues = res.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new ContractError('BAD_REQUEST', `Invalid request: ${issues.map((i) => `${i.path || 'body'} ${i.message}`).join('; ')}.`, { issues });
  }
  return res.data;
}
