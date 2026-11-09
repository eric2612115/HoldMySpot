import { describe, expect, it } from 'vitest';
import type { ActivityRow } from './market';
import { paidOutCents } from './paidOut';

const row = (id: string, kind: string, amountCents: number, status = 'succeeded') => ({ id, kind, amountCents, status }) as unknown as ActivityRow;

describe("the queuer's paid-out total", () => {
  it('counts payouts filed with the requester lines, as on a phone that is one person for both roles', () => {
    const own = [row('l1', 'held', 6370), row('p1', 'paid_out', 1080), row('p2', 'paid_out', 4275)];
    expect(paidOutCents(own, [])).toBe(5355);
  });

  it('counts each payout once, skips pending ones and every other kind', () => {
    const requester = [row('c1', 'captured', 4869), row('p1', 'paid_out', 1080)];
    const queuer = [row('p1', 'paid_out', 1080), row('p2', 'paid_out', 4275), row('p3', 'paid_out', 500, 'pending')];
    expect(paidOutCents(requester, queuer)).toBe(5355);
  });
});
