import type { BidDetail, Job, JobStatus } from '@holdmyspot/shared';
import { describe, expect, it } from 'vitest';
import { orderOf } from './orderOf';

const NAMES = { shopName: 'Paper Moon Toys', itemShort: 'Mochi Bunny plush' };

/** Mia's $63.70 hold on the hero day, with Wei's job in `status` and what PayPal holds, captured and released so far. */
function mia(o: { bid?: string; closeReason?: string | null; job?: JobStatus | null; captured?: number; released?: number; pending?: boolean; mode?: 'ship' | 'local' }): BidDetail {
  const mode = o.mode ?? 'ship';
  const job = o.job ? ({ id: 'job-1', status: o.job, queuerName: 'Wei', feeCents: 1200, mode } as unknown as Job) : null;
  return {
    bid: {
      id: 'bid-1',
      itemId: 'plush-paper-moon',
      status: o.bid ?? 'matched',
      closeReason: o.closeReason ?? null,
      maxFeeCents: 1200,
      limitCents: 6370,
      destination: { mode },
    },
    hold: { id: 'hold-1', amount: { currency: 'USD', cents: 6370 }, capturedCents: o.captured ?? 0, releasedCents: o.released ?? 0 },
    matches: [],
    jobs: job ? [job] : [],
    ledger: o.pending ? [{ status: 'pending' }] : [],
    agentActions: [],
  } as unknown as BidDetail;
}

describe('orderOf: the requester card follows the hold, not only the receipt (D-115)', () => {
  it('a shipped errand is bought, not filled, between the receipt capture and tracking', () => {
    const o = orderOf(mia({ job: 'verified', captured: 4869 }), NAMES);
    expect(o.status).toBe('bought');
    expect(o.chargedCents).toBe(4869);
    expect((o.holdCents ?? 0) - (o.chargedCents ?? 0) - (o.releasedCents ?? 0)).toBe(1501);
  });

  it('is filled once the parcel shipped and the final capture released the rest', () => {
    const o = orderOf(mia({ bid: 'settled', closeReason: 'filled', job: 'shipped', captured: 5826, released: 544 }), NAMES);
    expect(o.status).toBe('filled');
    expect([o.chargedCents, o.releasedCents]).toEqual([5826, 544]);
  });

  it('a local errand waits for the handover code before anything is charged', () => {
    expect(orderOf(mia({ job: 'verified', mode: 'local' }), NAMES).status).toBe('bought');
    expect(orderOf(mia({ bid: 'settled', job: 'delivered', mode: 'local', captured: 4947, released: 207 }), NAMES).status).toBe('filled');
  });

  it('settling while a capture or payout is pending, booked before the receipt', () => {
    expect(orderOf(mia({ job: 'verified', captured: 4869, pending: true }), NAMES).status).toBe('settling');
    expect(orderOf(mia({ job: 'proof_submitted' }), NAMES).status).toBe('settling');
    expect(orderOf(mia({ job: 'queueing' }), NAMES).status).toBe('booked');
  });
});

describe('orderOf: a sell-out has its own words (D-116)', () => {
  it('a request closed by a sell-out is released and says why', () => {
    const o = orderOf(mia({ bid: 'expired', closeReason: 'sold_out', job: 'failed', released: 6370 }), NAMES);
    expect(o.status).toBe('released');
    expect(o.message).toBe('Paper Moon Toys sold out before Wei could buy yours. Nothing was charged.');
    expect(o.message).not.toMatch(/fully booked/);
  });

  it('an approval that lands after the sell-out holds nothing', () => {
    const o = orderOf(mia({ bid: 'failed', closeReason: 'sold_out' }), NAMES);
    expect(o.status).toBe('error');
    expect(o.message).toMatch(/while PayPal was approving\. Nothing was held or charged\.$/);
  });

  it('a request the requester cancelled keeps the plain wording', () => {
    expect(orderOf(mia({ bid: 'cancelled', closeReason: 'requester_cancelled', released: 6370 }), NAMES).message).toBeUndefined();
  });
});
