import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jobSettlement } from '@holdmyspot/shared';
import type { MarketMs } from '@holdmyspot/shared';
import { actionsFor, proposalsAt } from '../../agents/rescheduler.ts';
import { sf } from '../time.ts';
import { PROPOSAL_JO, PROPOSAL_NOOR, worldAt } from './heroDay.ts';
import type { OpsAction } from './world.ts';

const cents = (w: ReturnType<typeof worldAt>, kind: string, userId: string) =>
  w.ledger.filter((e) => e.kind === kind && e.userId === userId && e.status === 'succeeded').map((e) => e.amount.cents);

/** Approves each proposal at its time with the option given (the rules' pick when null), as an operator would. */
function approve(steps: [string, MarketMs, string | null][]): OpsAction[] {
  const actions: OpsAction[] = [];
  for (const [id, t, option] of steps) {
    const p = proposalsAt(worldAt(t, actions), t, actions).find((x) => x.id === id && x.status === 'open');
    assert.ok(p, `${id} is open at ${t}`);
    actions.push(...actionsFor(p, option, t));
  }
  return actions;
}

test('the Paper Moon part follows the hero script and its money', () => {
  const w = worldAt(sf('14:20'), approve([[PROPOSAL_JO, sf('11:21'), null], [PROPOSAL_NOOR, sf('11:22'), null]]));
  const mia = w.jobs.find((j) => j.requesterId === 'mia' && j.shopId === 'paper-moon-toys');
  assert.ok(mia);
  assert.equal(mia.queuerId, 'wei');
  assert.equal(mia.qty, 1, 'one per customer');
  assert.equal(mia.feeCents, 1200);
  assert.equal(mia.createdAt, sf('11:05'));
  const miaCaptures = w.ledger.filter((e) => e.kind === 'captured' && e.jobId === mia.id).map((e) => e.amount.cents);
  // Processing and payouts at cost ride on each capture (D-105): $46.00 + $2.69, then $8.75 + $0.82.
  assert.deepEqual(miaCaptures, [4869, 957]);
  const released = w.ledger.filter((e) => e.kind === 'released' && e.bidId === mia.bidId).map((e) => e.amount.cents);
  assert.deepEqual(released, [544]);
  const weiPayouts = w.payouts.filter((p) => p.reference === mia.id).map((p) => p.amount.cents);
  assert.deepEqual(weiPayouts, [1080, 4275]);
  assert.deepEqual(cents(w, 'held', 'mia').includes(6370), true);
  const money = jobSettlement(mia.amounts);
  assert.deepEqual([money.processingCents, money.paypalFeesCents, money.platformCents], [351, 351, 120], 'the same money story as the server');
});

test("Rex's fake receipt moves $0 and Priya's plush goes to Lin at $10", () => {
  const w = worldAt(sf('11:21'));
  const rex = w.jobs.find((j) => j.queuerId === 'rex');
  assert.ok(rex);
  assert.equal(rex.status, 'failed');
  assert.equal(rex.failure?.reason, 'proof_rejected');
  assert.equal(rex.amounts.capturedCents, 0);
  const priya = w.jobs.find((j) => j.requesterId === 'priya' && j.queuerId === 'lin');
  assert.ok(priya);
  assert.equal(priya.feeCents, 1000);
  assert.equal(priya.createdAt, sf('11:20'));
  const fills = w.matches.filter((m) => m.askId === 'ask-wei-pm').map((m) => [m.feeCents, m.qty]);
  assert.deepEqual(fills, [[1200, 1]], "Wei's clock steps $15, $14, $13 and meets Mia's $12");
  assert.equal(w.notes.length, 1);
});

test('without approval Jo lapses at 11:25 and Ava takes the plush; approving the move gives it to her at once', () => {
  const late = worldAt(sf('11:26'));
  const avaLate = late.jobs.find((j) => j.queuerId === 'ava' && j.requesterId === 'leo');
  assert.equal(avaLate?.createdAt, sf('11:25'));
  assert.equal(avaLate?.feeCents, 800);
  const early = worldAt(sf('11:22'), approve([[PROPOSAL_JO, sf('11:21'), null]]));
  const avaEarly = early.jobs.find((j) => j.queuerId === 'ava' && j.requesterId === 'leo');
  assert.equal(avaEarly?.createdAt, sf('11:21'));
  assert.equal(avaEarly?.feeCents, 800);
  assert.equal(early.jobs.find((j) => j.queuerId === 'jo')?.failure?.reason, 'queuer_withdrew');
  const released = worldAt(sf('11:22'), approve([[PROPOSAL_JO, sf('11:21'), 'release']]));
  assert.equal(released.claims.find((c) => c.id === 'claim-jo-ll')?.status, 'lapsed', 'releasing Jo lapses his claim at once');
  assert.equal(released.jobs.find((j) => j.queuerId === 'ava' && j.requesterId === 'leo')?.createdAt, sf('11:21'));
});

test("shifting Jo's window keeps Leo's plush with him until the new end", () => {
  const actions = approve([[PROPOSAL_JO, sf('11:21'), 'extend']]);
  assert.equal(actions[0]?.move.kind, 'extend');
  const w = worldAt(sf('11:30'), actions);
  const claim = w.claims.find((c) => c.id === 'claim-jo-ll');
  assert.equal(claim?.status, 'awaiting_arrival');
  assert.equal(claim?.windowEndsAt, sf('11:34'));
  assert.equal(w.jobs.find((j) => j.queuerId === 'jo')?.status, 'claimed');
  // Jo still has not moved, so the problem comes back with the approved card beside it.
  const cards = proposalsAt(w, sf('11:30'), actions).filter((p) => p.id === PROPOSAL_JO);
  assert.deepEqual(cards.map((p) => p.status).sort(), ['approved', 'open']);
  assert.equal(worldAt(sf('11:35'), actions).claims.find((c) => c.id === 'claim-jo-ll')?.status, 'lapsed');
});

test("Noor's unrenewed hold: approval moves Rin's cakes; without it the capture fails", () => {
  const approved = worldAt(sf('12:20'), approve([[PROPOSAL_NOOR, sf('11:22'), null]]));
  const rin = approved.jobs.filter((j) => j.queuerId === 'rin' && j.status !== 'failed').map((j) => j.requesterId).sort();
  assert.deepEqual(rin, ['leo', 'sam']);
  const declined = worldAt(sf('12:20'));
  const noorJob = declined.jobs.find((j) => j.requesterId === 'noor' && j.queuerId === 'rin');
  assert.equal(noorJob?.failure?.reason, 'payment_failed');
  assert.ok(declined.ledger.some((e) => e.kind === 'captured' && e.status === 'failed'));
});

test('the same inputs give the same ids', () => {
  const actions = approve([[PROPOSAL_JO, sf('11:21'), null]]);
  const a = worldAt(sf('14:20'), actions);
  const b = worldAt(sf('14:20'), actions);
  assert.deepEqual(
    a.ledger.map((e) => e.id + e.amount.cents),
    b.ledger.map((e) => e.id + e.amount.cents),
  );
});
