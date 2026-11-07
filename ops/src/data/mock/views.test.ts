import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sf } from '../time.ts';
import { marketFacts } from '../../market/agent/facts.ts';
import { DEFAULT_RULES, SEED_SHOPS } from '@holdmyspot/shared';
import { PROPOSAL_JO, PROPOSAL_NOOR, worldAt } from './heroDay.ts';
import { boardBundle, booksAt, datasetsAt, proposalsAt } from './views.ts';

test('at 11:21 the rescheduler raises both problems with dry-run moves', () => {
  const proposals = proposalsAt(sf('11:21'), {});
  const jo = proposals.find((p) => p.id === PROPOSAL_JO);
  const noor = proposals.find((p) => p.id === PROPOSAL_NOOR);
  assert.equal(jo?.status, 'open');
  assert.deepEqual(jo?.moves.map((m) => [m.queuerId, m.requesterName, m.feeCents]), [['ava', 'Leo M.', 800]]);
  assert.equal(jo?.rulesActAt, sf('11:25'));
  assert.equal(noor?.status, 'open');
  assert.deepEqual(noor?.moves.map((m) => [m.queuerId, m.requesterName, m.feeCents]).sort(), [
    ['rin', 'Leo M.', 850],
    ['rin', 'Sam W.', 850],
  ]);
});

test('approved proposals stop asking; unapproved ones end the way the rules say', () => {
  const approved = proposalsAt(sf('11:30'), { [PROPOSAL_JO]: sf('11:21'), [PROPOSAL_NOOR]: sf('11:22') });
  assert.deepEqual(approved.map((p) => p.status).sort(), ['approved', 'approved']);
  const ignored = proposalsAt(sf('12:20'), {});
  assert.equal(ignored.find((p) => p.id === PROPOSAL_JO)?.status, 'applied_by_rules');
  assert.equal(ignored.find((p) => p.id === PROPOSAL_NOOR)?.status, 'applied_by_rules');
});

test('board events reference real records and stay inside the day', () => {
  const t = sf('11:21');
  const bundle = boardBundle(worldAt(t), t);
  assert.equal(bundle.board.resources.length, 6);
  assert.ok(bundle.board.resources.every((r) => r.cityId === 'sf'));
  for (const e of bundle.board.events) {
    assert.ok(e.endDate >= e.startDate, e.id);
    if (e.refs.jobId) assert.ok(bundle.jobs[e.refs.jobId], e.id);
    if (e.refs.askId) assert.ok(bundle.asks[e.refs.askId], e.id);
  }
  const clock = bundle.board.events.find((e) => e.id === 'clock-ask-wei-pm');
  assert.equal(clock?.startDate, sf('10:50'));
  assert.equal(clock?.endDate, sf('11:05'));
});

test('books and datasets agree; the widest gap at 12:05 is Steam Lantern at $2.00', () => {
  const t = sf('12:05');
  const w = worldAt(t);
  assert.equal(booksAt(w, t).length, SEED_SHOPS.reduce((n, s) => n + s.items.length, 0));
  const datasets = datasetsAt(w, t);
  const facts = marketFacts({ at: t, datasets } as never);
  assert.equal(facts.gaps[0]?.shop, 'Steam Lantern Ramen');
  assert.equal(facts.gaps[0]?.gapText, '$2.00');
  assert.equal(facts.gaps[0]?.askText, '$9.00');
  assert.ok(DEFAULT_RULES.platformFeeBps > 0);
});
