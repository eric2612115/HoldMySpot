import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEED_SHOPS } from '@holdmyspot/shared';
import type { MarketSnapshot } from '../../data/backend.ts';
import { worldAt } from '../../data/mock/heroDay.ts';
import { boardBundle, booksAt, datasetsAt } from '../../data/mock/views.ts';
import { sf } from '../../data/time.ts';
import { breakdownSpec, readWidget } from './breakdown.ts';
import { marketClockNote, otherTopicsNote } from './facts.ts';
import { plainRefs } from './serverAdapter.ts';

const snapAt = (hhmm: string): MarketSnapshot => {
  const t = sf(hhmm);
  const w = worldAt(t);
  return { at: t, datasets: datasetsAt(w, t), bundle: boardBundle(w, t), shops: SEED_SHOPS, proposals: [], books: booksAt(w, t) } as unknown as MarketSnapshot;
};

test('a capture breakdown counts and averages PayPal captures, not holds (D-130)', () => {
  const snap = snapAt('14:10');
  const b = breakdownSpec(snap, 'captures', 'shop');
  // The same figures straight from the ledger rows.
  const captured = snap.datasets.ledger.rows.filter((r) => r.kind === 'Captured' && r.status === 'succeeded');
  const paperMoon = captured.filter((r) => r.shop === 'Paper Moon Toys');
  const total = Math.round(paperMoon.reduce((s, r) => s + Number(r.amountUsd), 0) * 100) / 100;
  const row = b.rows.find((r) => r.key === 'Paper Moon Toys')!;
  assert.equal(row.count, paperMoon.length);
  assert.equal(row.total, total);
  assert.equal(row.average, Math.round((total / paperMoon.length) * 100) / 100);
  assert.ok(row.count! >= 2, 'Mia\'s two captures at least');
  // The widget Studio gets: the ledger filtered to succeeded captures, a count that is a sum of events, total and average.
  assert.deepEqual(b.widget.filters, [
    { field: 'ledger.kind', value: 'Captured' },
    { field: 'ledger.status', value: 'succeeded' },
  ]);
  assert.deepEqual(b.widget.dataMapping, {
    cols: [{ id: 'shops.shop' }, { id: 'ledger.events', aggregation: 'sum' }, { id: 'ledger.amountUsd', aggregation: 'sum' }, { id: 'ledger.amountUsd', aggregation: 'avg' }],
  });
  assert.match(b.text, /^PayPal captures by shop \(ledger\.kind = Captured, ledger\.status = succeeded\): Paper Moon Toys \d+ events, \$\d+\.\d\d in all, \$\d+\.\d\d average/);
  assert.throws(() => breakdownSpec(snap, 'payouts', 'requester'), /cannot be broken down by requester/);
});

test('reading a widget back finds what it really shows, and flags a count in dollars or an average over holds', () => {
  const snap = snapAt('14:10');
  // What Studio's Widget agent built in the judge's run: holds.capturedUsd averaged and counted.
  const made = readWidget(
    snap,
    'w-avg-capture',
    { type: 'grid', dataMapping: { cols: [{ id: 'shops.shop' }, { id: 'holds.capturedUsd', aggregation: 'avg' }, { id: 'holds.capturedUsd', aggregation: 'count' }] }, format: { title: { text: 'Average capture by shop' } } },
    [],
  );
  assert.equal(made.warnings.length, 2);
  assert.match(made.warnings.join(' '), /counted, so the count is drawn with a dollar sign/);
  assert.match(made.warnings.join(' '), /averaged over holds/);
  // The breakdown's own widget reads back to the breakdown's figures.
  const b = breakdownSpec(snap, 'captures', 'shop');
  const back = readWidget(
    snap,
    'w-desk',
    { type: 'grid', dataMapping: b.widget.dataMapping as never, format: { title: { text: b.widget.title } } },
    b.widget.filters.map((f) => ({ field: { id: f.field }, model: { operator: 'equals', value: f.value } })),
  );
  const row = b.rows.find((r) => r.key === 'Paper Moon Toys')!;
  assert.deepEqual(back.warnings, []);
  assert.ok(back.figures.includes(`Paper Moon Toys: sum ledger.events ${row.count}, sum ledger.amountUsd $${row.total.toFixed(2)}, avg ledger.amountUsd $${row.average!.toFixed(2)}`), back.figures);
  assert.match(readWidget(snap, 'w-x', undefined, []).figures, /no widget w-x/);
});

test('the panel reads plain words, the offline planner names what it answered, and Studio agents get the market day', () => {
  assert.equal(
    plainRefs('Built @widget[w-avg-capture] from @table[ledger] grouped by @field[shops.shop]. Page id is market for Widget agents.'),
    'Built w-avg-capture from ledger grouped by shops.shop.',
  );
  assert.equal(
    otherTopicsNote('Which queuer has earned the most so far, and how much has PayPal released back to requesters?', 'holds'),
    ' (Offline planner: I answered holds and releases. Ask about queuer earnings ("Top earner") on its own for that part.)',
  );
  assert.equal(otherTopicsNote('How much is PayPal holding?', 'holds'), '');
  // The "Holds and captures" chip: the holds answer has the captured total too.
  assert.equal(otherTopicsNote('How much is PayPal holding, and how much was captured or released so far?', 'holds'), '');
  assert.match(marketClockNote(snapAt('12:10')), /^Market clock: 2026-11-12 12:10 \(America\/Los_Angeles\)\. "Today"/);
});
