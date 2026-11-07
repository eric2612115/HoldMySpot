import assert from 'node:assert/strict';
import { test } from 'node:test';
import { worldAt } from '../data/mock/heroDay.ts';
import { boardBundle } from '../data/mock/views.ts';
import { withReasonAfter } from '../data/mock/world.ts';
import { sf } from '../data/time.ts';
import { buildBars, buildRows } from './boardModel.ts';

const weiClock = (hhmm: string, patch: (bundle: ReturnType<typeof boardBundle>) => void = () => {}) => {
  const t = sf(hhmm);
  const bundle = boardBundle(worldAt(t), t);
  patch(bundle);
  const ask = Object.values(bundle.asks).find((a) => a.queuerId === 'wei' && a.shopId === 'paper-moon-toys')!;
  return buildBars(bundle, [], t).find((b) => b.kind === 'fee_clock' && b.id === `clock-${ask.id}`)!;
};

test("Wei's fee clock steps down while his offer is open", () => {
  const bar = weiClock('11:00');
  assert.equal(bar.title, 'Fee now $13');
  assert.deepEqual(bar.steps?.map((s) => `${s.label} ${s.state}`), ['$15 past', '$14 past', '$13 now', '$12 next', '$11 next', '$10 next', '$9 next', '$8 next']);
});

test("Wei's fee clock stops at the $12 match: no step to the $8 floor afterwards (D-132)", () => {
  for (const hhmm of ['11:10', '12:40']) {
    const bar = weiClock(hhmm);
    assert.equal(bar.title, 'Matched at $12', hhmm);
    assert.deepEqual(bar.steps?.map((s) => `${s.label} ${s.state}`), ['$15 past', '$14 past', '$13 past', '$12 now'], hhmm);
    assert.equal(bar.endDate.getTime() - bar.startDate.getTime(), 15 * 60_000, `${hhmm}: the bar ends at the 11:05 match`);
  }
  // The visit closing later (as on the live server once he bought) does not restart the steps.
  const closed = weiClock('12:40', (bundle) => {
    const ask = Object.values(bundle.asks).find((a) => a.queuerId === 'wei' && a.shopId === 'paper-moon-toys')!;
    bundle.asks[ask.id] = { ...ask, status: 'closed', updatedAt: sf('11:40') };
  });
  assert.equal(closed.title, 'Matched at $12');
  assert.equal(closed.steps?.at(-1)?.label, '$12');
});

test("a queuer whose ETA has passed says so (Jo at 11:21 was due at 11:15)", () => {
  const t = sf('11:21');
  const bundle = boardBundle(worldAt(t), t);
  const jo = buildRows(bundle, [], t).find((r) => r.id === 'jo')!;
  assert.match(jo.status, /^On the way to Little Lantern Toys, ETA 11:15 passed$/);
});

test("a move note does not repeat the pick's reason", () => {
  const base = "Noor A.'s hold could not pay, so Rin's cakes went to Sam W. and Leo M. at $8.50 each (approved by ops). Noor keeps the place in line once a new hold is approved.";
  assert.equal(withReasonAfter(base, 'Noor keeps the place in line once a new hold is approved.'), base);
  assert.equal(withReasonAfter(base, 'Sam and Leo can still capture.'), `${base} Sam and Leo can still capture.`);
  assert.equal(withReasonAfter(base, null), base);
});
