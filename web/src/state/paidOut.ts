import type { Cents } from '@holdmyspot/shared';
import type { ActivityRow } from './market';

/**
 * What the queuer was paid: every succeeded payout line, counted once, from every list the phone keeps.
 * A phone that is one person for both roles (the judge page's Wei: `as=wei&queuer=wei`) files its own
 * payouts with its requester lines, so the queuer's list alone would read nothing.
 */
export function paidOutCents(...lists: ActivityRow[][]): Cents {
  const byId = new Map<string, number>();
  for (const rows of lists) for (const r of rows) if (r.kind === 'paid_out' && r.status === 'succeeded') byId.set(r.id, r.amountCents);
  let total = 0;
  for (const cents of byId.values()) total += cents;
  return total;
}
