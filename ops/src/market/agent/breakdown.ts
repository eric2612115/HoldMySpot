import type { OpsDatasetName, Shop } from '@holdmyspot/shared';
import type { MarketSnapshot } from '../../data/backend.ts';
import { shopLabel } from '../studioData.ts';

/**
 * Code decides the figures a dashboard widget shows (D-130). Two pieces for the market desk:
 *
 * - `breakdownSpec`: a table or chart of one money measure by one dimension (captures by shop, payouts
 *   by queuer, ...), with the exact dataset, filters and aggregations, so neither the desk nor Studio's
 *   Widget agent picks a field that only looks right (an average over holds is not an average capture).
 * - `readWidget`: reads any widget's own field mapping and filters back and computes, from the same
 *   rows the dashboard draws, what it shows, with warnings for a count drawn as dollars or an average
 *   per request. The desk compares that with read_market before it answers.
 */

export const MEASURES = ['captures', 'releases', 'payouts', 'holds', 'queue_fees'] as const;
export type Measure = (typeof MEASURES)[number];
export const DIMENSIONS = ['shop', 'city', 'queuer', 'requester'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

interface Filter {
  field: string;
  value: string;
}

interface MeasureSpec {
  table: OpsDatasetName;
  label: string;
  /** The money field. */
  amount: string;
  /** A field that is 1 per event (summed to count), or null when the table has none. */
  events: string | null;
  filters: Filter[];
  by: Partial<Record<Dimension, string>>;
}

const MEASURE_SPECS: Record<Measure, MeasureSpec> = {
  captures: {
    table: 'ledger',
    label: 'PayPal captures',
    amount: 'ledger.amountUsd',
    events: 'ledger.events',
    filters: [
      { field: 'ledger.kind', value: 'Captured' },
      { field: 'ledger.status', value: 'succeeded' },
    ],
    by: { shop: 'shops.shop', city: 'shops.city', requester: 'ledger.who' },
  },
  releases: {
    table: 'ledger',
    label: 'holds released',
    amount: 'ledger.amountUsd',
    events: 'ledger.events',
    filters: [
      { field: 'ledger.kind', value: 'Released' },
      { field: 'ledger.status', value: 'succeeded' },
    ],
    by: { shop: 'shops.shop', city: 'shops.city', requester: 'ledger.who' },
  },
  payouts: {
    table: 'ledger',
    label: 'PayPal payouts',
    amount: 'ledger.amountUsd',
    events: 'ledger.events',
    filters: [
      { field: 'ledger.kind', value: 'Paid out' },
      { field: 'ledger.status', value: 'succeeded' },
    ],
    by: { shop: 'shops.shop', city: 'shops.city', queuer: 'ledger.who' },
  },
  holds: {
    table: 'holds',
    label: 'PayPal holds (one per request)',
    amount: 'holds.heldUsd',
    events: null,
    filters: [],
    by: { shop: 'shops.shop', city: 'shops.city', requester: 'holds.requester' },
  },
  queue_fees: {
    table: 'fills',
    label: 'queue fees matched',
    amount: 'fills.valueUsd',
    events: 'fills.qty',
    filters: [],
    by: { shop: 'shops.shop', city: 'shops.city', queuer: 'fills.queuer', requester: 'fills.requester' },
  },
};

const usd = (dollars: number) => `$${dollars.toFixed(2)}`;
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The rows of one table with the shop's name and city joined in, keyed `table.field` and `shops.field`. */
function joinedRows(snap: MarketSnapshot, table: OpsDatasetName): Record<string, unknown>[] {
  const ds = snap.datasets[table];
  if (!ds) return [];
  const byId = new Map<string, Shop>(snap.shops.map((s) => [s.id, s]));
  return ds.rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) out[`${table}.${k}`] = v;
    // The ledger counts each row as one event (studioData's description: "events is 1 per row").
    if (table === 'ledger' && out['ledger.events'] === undefined) out['ledger.events'] = 1;
    const shop = typeof r.shopId === 'string' ? byId.get(r.shopId) : undefined;
    if (shop) {
      out['shops.shop'] = shopLabel(shop, snap.shops);
      out['shops.city'] = shop.cityId === 'sf' ? 'San Francisco' : 'New York';
    }
    return out;
  });
}

export interface BreakdownRow {
  key: string;
  count: number | null;
  total: number;
  average: number | null;
}

export interface Breakdown {
  measure: Measure;
  by: Dimension;
  label: string;
  rows: BreakdownRow[];
  /** Studio's widget for it: type, field mapping and the widget filters to add. */
  widget: { type: 'grid' | 'bar-chart-grouped'; dataMapping: Record<string, unknown>; sort: unknown[]; filters: Filter[]; title: string };
  /** The figures as sentences, for the desk's answer. */
  text: string;
}

/** Whether a dimension exists for a measure (payouts have queuers, holds have requesters). */
export function dimensionsFor(measure: Measure): Dimension[] {
  return DIMENSIONS.filter((d) => MEASURE_SPECS[measure].by[d]);
}

export function breakdownSpec(snap: MarketSnapshot, measure: Measure, by: Dimension, chart: 'table' | 'bar' = 'table'): Breakdown {
  const spec = MEASURE_SPECS[measure];
  const byField = spec.by[by];
  if (!byField) throw new Error(`${spec.label} cannot be broken down by ${by}: use ${dimensionsFor(measure).join(', ')}.`);
  const rows = joinedRows(snap, spec.table).filter((r) => spec.filters.every((f) => r[f.field] === f.value));
  const groups = new Map<string, { count: number; total: number }>();
  for (const r of rows) {
    const key = String(r[byField] ?? '(none)');
    const g = groups.get(key) ?? { count: 0, total: 0 };
    g.count += spec.events ? n(r[spec.events]) : 1;
    g.total += n(r[spec.amount]);
    groups.set(key, g);
  }
  const out: BreakdownRow[] = [...groups]
    .map(([key, g]) => ({ key, count: g.count, total: Math.round(g.total * 100) / 100, average: g.count > 0 ? Math.round((g.total / g.count) * 100) / 100 : null }))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  const title = `${spec.label.charAt(0).toUpperCase()}${spec.label.slice(1)} by ${by}`;
  const amountSum = { id: spec.amount, aggregation: 'sum' };
  const amountAvg = { id: spec.amount, aggregation: 'avg' };
  const widget =
    chart === 'bar'
      ? { type: 'bar-chart-grouped' as const, dataMapping: { categoryKey: [{ id: byField }], valueKey: [amountSum] }, sort: [{ field: amountSum, direction: 'desc' }], filters: spec.filters, title }
      : {
          type: 'grid' as const,
          dataMapping: { cols: [{ id: byField }, ...(spec.events ? [{ id: spec.events, aggregation: 'sum' }] : []), amountSum, amountAvg] },
          sort: [{ field: amountSum, direction: 'desc' }],
          filters: spec.filters,
          title,
        };
  const unit = measure === 'queue_fees' ? 'unit' : measure === 'holds' ? 'request' : 'event';
  const text =
    out.length === 0
      ? `No ${spec.label} yet.`
      : `${title} (${spec.filters.map((f) => `${f.field} = ${f.value}`).join(', ') || 'all rows'}): ${out
          .map((r) => `${r.key} ${r.count !== null ? `${r.count} ${unit}${r.count === 1 ? '' : 's'}, ` : ''}${usd(r.total)} in all${r.average !== null ? `, ${usd(r.average)} average` : ''}`)
          .join('; ')}.`;
  return { measure, by, label: spec.label, rows: out, widget, text };
}

// ---- reading a widget back ----------------------------------------------------------------------

interface MappedField {
  id: string;
  aggregation?: string;
}

interface WidgetState {
  type?: string;
  dataMapping?: Record<string, MappedField[] | undefined>;
  format?: { title?: { text?: string } };
}

interface FilterState {
  field?: { id?: string };
  model?: { operator?: string; value?: unknown };
}

export interface WidgetReading {
  widgetId: string;
  title: string;
  figures: string;
  warnings: string[];
}

const AGGREGATE: Record<string, (xs: number[]) => number | null> = {
  sum: (xs) => xs.reduce((a, b) => a + b, 0),
  avg: (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null),
  count: (xs) => xs.length,
  min: (xs) => (xs.length ? Math.min(...xs) : null),
  max: (xs) => (xs.length ? Math.max(...xs) : null),
};

const isMoney = (id: string) => id.endsWith('Usd');

/**
 * What a widget shows, computed from its own mapping and filters on the snapshot's rows (page filters
 * included). Supports one table joined to shops, equals filters and sum, avg, count, min and max.
 */
export function readWidget(snap: MarketSnapshot, widgetId: string, widget: WidgetState | undefined, filters: FilterState[]): WidgetReading {
  if (!widget) return { widgetId, title: widgetId, figures: `There is no widget ${widgetId} on the page.`, warnings: [] };
  const title = widget.format?.title?.text ?? widget.type ?? widgetId;
  const fields = Object.values(widget.dataMapping ?? {}).flatMap((xs) => xs ?? []);
  const dims = fields.filter((f) => !f.aggregation);
  const measures = fields.filter((f) => f.aggregation);
  const warnings: string[] = [];
  for (const m of measures) {
    if (m.aggregation === 'count' && isMoney(m.id)) warnings.push(`${m.id} is counted, so the count is drawn with a dollar sign; sum a count field (ledger.events, fills.qty) instead.`);
    if (m.id.startsWith('holds.') && m.aggregation === 'avg' && m.id !== 'holds.heldUsd') warnings.push(`${m.id} is averaged over holds (one per request, zero for those not captured), not over captures; captures are ledger rows with ledger.kind = Captured.`);
  }
  const tables = [...new Set(fields.map((f) => f.id.split('.')[0]!).filter((t) => t !== 'shops'))];
  if (tables.length !== 1) return { widgetId, title, figures: tables.length === 0 ? 'It maps no data fields yet: it is not configured.' : `It mixes tables (${tables.join(', ')}); not checked.`, warnings };
  const unsupported = measures.find((m) => !AGGREGATE[m.aggregation!]);
  if (unsupported) return { widgetId, title, figures: `It uses the ${unsupported.aggregation} aggregation; not checked.`, warnings };
  const equals = filters.filter((f) => f.field?.id && (f.model?.operator ?? 'equals') === 'equals');
  if (equals.length !== filters.length) warnings.push('It has a filter other than "equals"; the figures below ignore it.');
  const rows = joinedRows(snap, tables[0] as OpsDatasetName).filter((r) => equals.every((f) => String(r[f.field!.id!]) === String(f.model?.value)));
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const key = dims.map((d) => String(r[d.id] ?? '(none)')).join(' / ') || 'All rows';
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  if (measures.length === 0) return { widgetId, title, figures: `${rows.length} rows, no totals.`, warnings };
  const show = (m: MappedField, v: number | null) => (v === null ? '-' : m.aggregation === 'count' || !isMoney(m.id) ? String(Math.round(v * 100) / 100) : usd(v));
  const lines = [...groups].map(([key, rs]) => `${key}: ${measures.map((m) => `${m.aggregation} ${m.id} ${show(m, AGGREGATE[m.aggregation!]!(rs.map((r) => n(r[m.id]))))}`).join(', ')}`);
  const where = equals.length ? ` where ${equals.map((f) => `${f.field!.id} = ${String(f.model?.value)}`).join(' and ')}` : '';
  return { widgetId, title, figures: `${title}${where}: ${lines.join('; ') || 'no rows'}.`, warnings };
}
