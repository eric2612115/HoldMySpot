import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LedgerEntry, OpsRecords } from '@holdmyspot/shared';
import { sf } from './time.ts';
import { worldFromRecords } from './serverWorld.ts';
import { worldAt } from './mock/heroDay.ts';
import { datasetsAt } from './mock/views.ts';

/**
 * The console's Market page on a live server (GET /api/ops/records): the AG Studio ledger grid shows the PayPal
 * id each ledger line carries, so after the hosted site's real-sandbox errand it lists that run's own ids.
 */

// The ids PayPal's sandbox gave the hero errand (docs/SANDBOX-GATES.md): a hold, two captures.
const SANDBOX = { authorizationId: '88232929HR885933A', captures: ['54N68839TA957213Y', '4U786596DF2537313'] };

test("on a live server the AG Studio ledger lists the server ledger's own PayPal ids", () => {
  const t = sf('14:10');
  const day = worldAt(t);
  let capture = 0;
  // The same day as the server would serve it, with the sandbox's ids on Mia's money lines.
  const ledger: LedgerEntry[] = day.ledger.map((e) => {
    if (e.userId !== 'mia') return e;
    if (e.kind === 'held') return { ...e, paypal: { authorizationId: SANDBOX.authorizationId } };
    if (e.kind === 'captured') return { ...e, paypal: { authorizationId: SANDBOX.authorizationId, captureId: SANDBOX.captures[capture++] } };
    return e;
  });
  const records = {
    at: t,
    users: [...day.users.values()],
    crowd: [...day.crowd.values()].map((c) => ({ id: c.id, displayName: c.displayName, cityId: 'nyc' })),
    bids: day.bids,
    holds: day.holds,
    asks: day.asks,
    claims: day.claims,
    matches: day.matches,
    jobs: day.jobs,
    proofs: [],
    ledger,
    payouts: day.payouts,
    agentActions: [],
    disputes: [],
  } as unknown as OpsRecords;
  const rows = datasetsAt(worldFromRecords(records), t).ledger.rows;
  const ids = rows.map((r) => r.paypalId);
  assert.ok(ids.includes(SANDBOX.authorizationId), 'the hold, by its authorization');
  for (const id of SANDBOX.captures) assert.ok(ids.includes(id), `capture ${id}`);
  const captured = rows.filter((r) => r.paypalId === SANDBOX.captures[0]);
  assert.deepEqual(captured.map((r) => r.paypalObject), ['Capture']);
});
