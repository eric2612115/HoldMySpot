import type { AgReportState } from 'ag-studio';
import { W } from '../data/vocab.ts';
import { PLACEHOLDER_ID } from './agent/planner.ts';
import { DEPTH_LADDER, GAP_BOARD } from './widgets/defs.ts';

/**
 * The dashboard a judge sees first: PayPal money at the top, the line-ups
 * (custom gap board) beside the market desk's answer slot, then the PayPal
 * ledger in AG Grid (status pills, PayPal ids) next to a pivot table of the
 * holds grouped by shop with a pinned grand total; charts and payouts below.
 * 24 columns; one row track is 16 px. Users can edit all of it.
 */

const sum = (id: string) => ({ id, aggregation: 'sum' as const });
const legend = { style: { theme: { common: { legend: { enabled: true, position: 'bottom' } } } } };
const legendRight = { style: { theme: { common: { legend: { enabled: true, position: 'right' } } } } };
const title = (text: string, subtitle?: string) => ({
  title: { enabled: true, text },
  ...(subtitle ? { subtitle: { enabled: true, text: subtitle } } : {}),
});

/** AG Grid inside Studio, in the app's palette: compact rows, soft row lines, a lilac header. */
const GRID_STYLE = {
  columnAutoSize: true,
  theme: { rowHeight: 30, rowBorder: { color: '#eef0f6', width: 1 }, columnBorder: { color: 'transparent', width: 0 } },
  headerRow: { borderColor: '#e3defe', borderWidth: 1 },
};

const widgets = {
  'w-money': {
    type: 'multi-kpi',
    dataMapping: { values: [sum('holds.openUsd'), sum('holds.capturedUsd'), sum('holds.releasedUsd'), sum('payouts.amountUsd')] },
    format: { ...title('PayPal money now', 'Held for open requests, captured at verified receipts, released, paid out to queuers'), style: { columns: 4, typography: { fontSize: 21 } } },
  },
  'w-units': {
    type: 'value',
    dataMapping: { value: [sum('fills.qty')] },
    format: { ...title(`Units ${W.filled}`) },
  },
  'w-fees': {
    type: 'value',
    dataMapping: { value: [sum('fills.valueUsd')] },
    format: { ...title('Fees ' + W.filled) },
  },
  'w-gap': {
    type: GAP_BOARD,
    dataMapping: {
      shop: [{ id: 'shops.shop' }],
      bestBid: [{ id: 'books.bestBidUsd', aggregation: 'max' }],
      bestAsk: [{ id: 'books.bestAskUsd', aggregation: 'min' }],
      bidDepth: [sum('books.bidQty')],
      askDepth: [sum('books.askCapacity')],
    },
    format: { ...title(`${W.bestBid}, ${W.bestAsk.toLowerCase()} and the ${W.spread.toLowerCase()}`, 'Click a shop to filter the page') },
  },
  [PLACEHOLDER_ID]: {
    type: 'text',
    dataMapping: {},
    format: {
      style: {
        text: `Ask the market desk on the right about holds, captures, payouts, fill rates, step-downs or disputes, or "Which shop has the ${W.widestSpread} right now?". It answers there and builds its widgets here.`,
        textAlign: 'center',
        verticalAlign: 'center',
        color: '#7e839d',
        padding: true,
        typography: { fontSize: 15 },
      },
    },
  },
  'w-fills': {
    type: 'column-chart-stacked',
    dataMapping: { categoryKey: [{ id: 'fills.slot' }], valueKey: [sum('fills.qty')], legendKey: [{ id: 'shops.shop' }] },
    sort: [{ field: { id: 'fills.slot' }, direction: 'asc' }],
    format: { ...title(`${W.fills} over time`, 'Units per 15 minutes, San Francisco time'), ...legendRight },
  },
  'w-earn': {
    type: 'bar-chart-grouped',
    dataMapping: { categoryKey: [{ id: 'jobs.queuer' }], valueKey: [sum('jobs.earningsUsd')] },
    sort: [{ field: sum('jobs.earningsUsd'), direction: 'desc' }],
    format: { ...title('Queuer earnings', 'Fees after the 10% platform fee, matched jobs') },
  },
  'w-holds': {
    type: 'column-chart-grouped',
    dataMapping: { categoryKey: [{ id: 'shops.city' }], valueKey: [sum('holds.heldUsd'), sum('holds.capturedUsd'), sum('holds.releasedUsd')] },
    format: { ...title('Holds versus captures', 'By city of the shop'), ...legend },
  },
  'w-depth': {
    type: DEPTH_LADDER,
    dataMapping: {},
    format: { ...title(`${W.depth} ladder`) },
  },
  'w-ledger': {
    type: 'grid',
    dataMapping: {
      cols: [
        { id: 'ledger.slot' },
        { id: 'ledger.kind' },
        { id: 'ledger.amountUsd' },
        { id: 'ledger.status' },
        { id: 'ledger.paypalId' },
      ],
    },
    sort: [{ field: { id: 'ledger.slot' }, direction: 'desc' }],
    format: { ...title('PayPal ledger', 'Every money event, newest first, with the id of the PayPal object it touched'), style: GRID_STYLE },
  },
  'w-hold-pivot': {
    type: 'pivot-grid',
    dataMapping: {
      rows: [{ id: 'shops.city' }, { id: 'shops.shop' }],
      columns: [],
      values: [sum('holds.heldUsd'), sum('holds.capturedUsd')],
    },
    format: {
      ...title('PayPal holds by city and shop', 'Grouped, with subtotals and the total pinned'),
      style: { ...GRID_STYLE, columnAutoSize: false, columnWidth: 86, grandTotalRow: { enabled: true, borderColor: '#cfc8fd', borderWidth: 2 } },
    },
  },
  'w-payouts': {
    type: 'grid',
    dataMapping: {
      cols: [{ id: 'payouts.queuer' }, sum('payouts.amountUsd'), sum('payouts.platformFeeUsd'), { id: 'payouts.purpose' }, { id: 'payouts.status' }],
    },
    sort: [{ field: sum('payouts.amountUsd'), direction: 'desc' }],
    format: { ...title('PayPal Payouts to queuers', 'Queue fee after the 10% platform fee, and shop price plus shipping at cost; total pinned'), style: { ...GRID_STYLE, grandTotalRow: { enabled: true, borderColor: '#cfc8fd', borderWidth: 2 } } },
  },
};

const widgetLayout = {
  'w-money': { xTrack: 0, yTrack: 0, xSpan: 14, ySpan: 8 },
  'w-units': { xTrack: 14, yTrack: 0, xSpan: 5, ySpan: 8 },
  'w-fees': { xTrack: 19, yTrack: 0, xSpan: 5, ySpan: 8 },
  'w-gap': { xTrack: 0, yTrack: 8, xSpan: 14, ySpan: 19 },
  [PLACEHOLDER_ID]: { xTrack: 14, yTrack: 8, xSpan: 10, ySpan: 19 },
  'w-ledger': { xTrack: 0, yTrack: 27, xSpan: 13, ySpan: 18 },
  'w-hold-pivot': { xTrack: 13, yTrack: 27, xSpan: 11, ySpan: 18 },
  'w-fills': { xTrack: 0, yTrack: 45, xSpan: 12, ySpan: 18 },
  'w-holds': { xTrack: 12, yTrack: 45, xSpan: 12, ySpan: 18 },
  'w-earn': { xTrack: 0, yTrack: 63, xSpan: 10, ySpan: 18 },
  'w-depth': { xTrack: 10, yTrack: 63, xSpan: 14, ySpan: 18 },
  'w-payouts': { xTrack: 0, yTrack: 81, xSpan: 24, ySpan: 16 },
};

export const INITIAL_STATE = {
  pages: [{ id: 'market', widgets, widgetLayout }],
  selectedPageId: 'market',
  panels: { data: { collapsed: true }, edit: { collapsed: true }, filters: { collapsed: true }, ai: { collapsed: false, width: 344 } },
} as unknown as AgReportState;
