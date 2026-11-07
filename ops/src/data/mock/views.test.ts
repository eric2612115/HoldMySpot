import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RULES, SEED_SHOPS } from '@holdmyspot/shared';
import { actionsFor, proposalsAt } from '../../agents/rescheduler.ts';
import { sf } from '../time.ts';
import { marketFacts, topicFacts, topicOf } from '../../market/agent/facts.ts';
import type { MarketSnapshot } from '../backend.ts';
import { PROPOSAL_JO, PROPOSAL_NOOR, worldAt } from './heroDay.ts';
import { boardBundle, booksAt, datasetsAt } from './views.ts';
import type { OpsAction } from './world.ts';

const at = (hhmm: string, actions: OpsAction[] = []) => proposalsAt(worldAt(sf(hhmm), actions), sf(hhmm), actions);

test('at 11:21 the rescheduler raises both problems, with every option the rules allow and a dry run each', () => {
  const proposals = at('11:21');
  const jo = proposals.find((p) => p.id === PROPOSAL_JO);
  const noor = proposals.find((p) => p.id === PROPOSAL_NOOR);
  assert.equal(jo?.status, 'open');
  assert.deepEqual(jo?.options.map((o) => o.id), ['reassign:ask-ava-ll', 'extend', 'release']);
  assert.equal(jo?.chosenId, 'reassign:ask-ava-ll', 'Ava is in line under Leo\'s max fee');
  assert.equal(jo?.decidedBy, 'rules');
  assert.deepEqual(jo?.moves.map((m) => [m.queuerId, m.requesterName, m.feeCents]), [['ava', 'Leo M.', 800]]);
  assert.deepEqual(jo?.options.find((o) => o.id === 'release')?.ghosts.map((m) => m.queuerId), ['ava'], 'releasing Jo lets the rules give it to Ava');
  assert.equal(jo?.options.find((o) => o.id === 'extend')?.window?.to, sf('11:34'));
  assert.equal(jo?.rulesActAt, sf('11:25'));
  assert.equal(noor?.status, 'open');
  assert.deepEqual(noor?.moves.map((m) => [m.queuerId, m.requesterName, m.feeCents]).sort(), [
    ['rin', 'Leo M.', 850],
    ['rin', 'Sam W.', 850],
  ]);
  assert.deepEqual(noor?.options[0]?.moves.map((m) => m.kind), ['release_job']);
});

test('approved proposals stop asking; unapproved ones end the way the rules say', () => {
  const actions: OpsAction[] = [];
  for (const [id, t] of [[PROPOSAL_JO, '11:21'], [PROPOSAL_NOOR, '11:22']] as const) {
    const p = at(t, actions).find((x) => x.id === id)!;
    actions.push(...actionsFor(p, null, sf(t)));
  }
  assert.deepEqual(at('11:30', actions).map((p) => p.status).sort(), ['approved', 'approved']);
  const ignored = at('12:20');
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
  const facts = marketFacts({ at: t, datasets, shops: SEED_SHOPS } as never);
  assert.equal(facts.gaps[0]?.shop, 'Steam Lantern Ramen');
  assert.equal(facts.gaps[0]?.gapText, '$2.00');
  assert.equal(facts.gaps[0]?.askText, '$9.00');
  assert.ok(DEFAULT_RULES.platformFeeBps > 0);
  // The ledger rows carry the PayPal id of each money event (the dashboard's ledger grid).
  const capture = datasets.ledger.rows.find((r) => r.kind === 'Captured' && r.status === 'succeeded');
  assert.equal(capture?.paypalObject, 'Capture');
  assert.match(String(capture?.paypalId), /^FAKE-CAP-/);
});

test('the market desk reads holds, captures, fill rates, step-downs and disputes from the same snapshot', () => {
  const t = sf('12:05');
  const w = worldAt(t);
  const snap = { at: t, datasets: datasetsAt(w, t), bundle: boardBundle(w, t), shops: SEED_SHOPS, proposals: [], books: booksAt(w, t) } as unknown as MarketSnapshot;
  assert.match(topicFacts(snap, 'stepdowns'), /Wei at Paper Moon Toys: opened at \$15\.00 at check-in \(10:50\), \$1\.00 every 5 min to a floor of \$8\.00; .*Matched Mia .* at \$12\.00/);
  // His clock stopped at the match (D-132): it is not "at the floor" just because the floor time has passed.
  const wei = topicFacts(snap, 'stepdowns').split(/(?<=\.) (?=[A-Z][a-z]+ at )/).find((l) => l.startsWith('Wei at Paper Moon Toys'))!;
  assert.match(wei, /filled at \$12\.00 when matched/);
  assert.doesNotMatch(wei, /At the floor/);
  assert.match(topicFacts(snap, 'holds'), /Needs a new approval .*Noor A\./);
  assert.match(topicFacts(snap, 'captures'), /captures succeeded/);
  assert.match(topicFacts(snap, 'fills'), /Paper Moon Toys: \d+ of \d+ units matched/);
  assert.match(topicFacts(snap, 'disputes'), /Rejected receipts .*Rex for Priya/);
  assert.match(topicFacts(snap, 'disputes', undefined, []), /No open PayPal disputes/);
});

test('replay PayPal ids follow the emulator; "Holds and captures" gets the holds totals', () => {
  const t = sf('14:10');
  const w = worldAt(t);
  const ledger = datasetsAt(w, t).ledger.rows;
  // The final capture released the rest of the hold, so the release names that capture (as on the live server).
  const release = ledger.find((r) => r.kind === 'Released' && r.status === 'succeeded');
  assert.equal(release?.paypalObject, 'Capture');
  assert.match(String(release?.paypalId), /^FAKE-CAP-\d{4}$/);
  const payouts = ledger.filter((r) => r.kind === 'Paid out');
  assert.ok(payouts.length > 0);
  for (const p of payouts) assert.match(String(p.paypalId), /^FAKE-ITEM-\d{4}$/);
  assert.equal(topicOf('How much is PayPal holding, and how much was captured or released so far?'), 'holds');
  assert.equal(topicOf('Which capture was the largest?'), 'captures');
  const snap = { at: t, datasets: datasetsAt(w, t), bundle: boardBundle(w, t), shops: SEED_SHOPS, proposals: [], books: booksAt(w, t) } as unknown as MarketSnapshot;
  assert.match(topicFacts(snap, 'captures'), /processing at cost/);
  assert.match(topicFacts(snap, 'disputes'), /dispute sync is not built yet/);
});
