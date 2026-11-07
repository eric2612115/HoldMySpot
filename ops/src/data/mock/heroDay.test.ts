import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sf } from '../time.ts';
import { PROPOSAL_JO, PROPOSAL_NOOR, worldAt } from './heroDay.ts';

const cents = (w: ReturnType<typeof worldAt>, kind: string, userId: string) =>
  w.ledger.filter((e) => e.kind === kind && e.userId === userId && e.status === 'succeeded').map((e) => e.amount.cents);

test('the Paper Moon part follows the hero script and its money', () => {
  const w = worldAt(sf('14:20'), { [PROPOSAL_JO]: sf('11:21'), [PROPOSAL_NOOR]: sf('11:22') });
  const mia = w.jobs.find((j) => j.requesterId === 'mia' && j.shopId === 'paper-moon-toys');
  assert.ok(mia);
  assert.equal(mia.queuerId, 'wei');
  assert.equal(mia.qty, 1, 'one per customer');
  assert.equal(mia.feeCents, 1200);
  assert.equal(mia.createdAt, sf('11:05'));
  const miaCaptures = w.ledger.filter((e) => e.kind === 'captured' && e.jobId === mia.id).map((e) => e.amount.cents);
  assert.deepEqual(miaCaptures, [4600, 875]);
  const released = w.ledger.filter((e) => e.kind === 'released' && e.bidId === mia.bidId).map((e) => e.amount.cents);
  assert.deepEqual(released, [525]);
  const weiPayouts = w.payouts.filter((p) => p.reference === mia.id).map((p) => p.amount.cents);
  assert.deepEqual(weiPayouts, [1080, 4275]);
  assert.deepEqual(cents(w, 'held', 'mia').includes(6000), true);
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

test('without approval Jo lapses at 11:25 and Ava takes the plush; with approval it happens at once', () => {
  const late = worldAt(sf('11:26'));
  const avaLate = late.jobs.find((j) => j.queuerId === 'ava' && j.requesterId === 'leo');
  assert.equal(avaLate?.createdAt, sf('11:25'));
  assert.equal(avaLate?.feeCents, 800);
  const early = worldAt(sf('11:22'), { [PROPOSAL_JO]: sf('11:21') });
  const avaEarly = early.jobs.find((j) => j.queuerId === 'ava' && j.requesterId === 'leo');
  assert.equal(avaEarly?.createdAt, sf('11:21'));
  assert.equal(early.claims.find((c) => c.id === 'claim-jo-ll')?.status, 'lapsed');
});

test("Noor's unrenewed hold: approval moves Rin's cakes; without it the capture fails", () => {
  const approved = worldAt(sf('12:20'), { [PROPOSAL_NOOR]: sf('11:22') });
  const rin = approved.jobs.filter((j) => j.queuerId === 'rin' && j.status !== 'failed').map((j) => j.requesterId).sort();
  assert.deepEqual(rin, ['leo', 'sam']);
  const declined = worldAt(sf('12:20'));
  const noorJob = declined.jobs.find((j) => j.requesterId === 'noor' && j.queuerId === 'rin');
  assert.equal(noorJob?.failure?.reason, 'payment_failed');
  assert.ok(declined.ledger.some((e) => e.kind === 'captured' && e.status === 'failed'));
});

test('the same inputs give the same ids', () => {
  const a = worldAt(sf('14:20'), { [PROPOSAL_JO]: sf('11:21') });
  const b = worldAt(sf('14:20'), { [PROPOSAL_JO]: sf('11:21') });
  assert.deepEqual(
    a.ledger.map((e) => e.id + e.amount.cents),
    b.ledger.map((e) => e.id + e.amount.cents),
  );
});
