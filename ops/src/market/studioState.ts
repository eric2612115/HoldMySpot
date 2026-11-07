import type { AgReportState } from 'ag-studio';
import { W } from '../data/vocab.ts';
import { PLACEHOLDER_ID } from './agent/marketDesk.ts';
import { DEPTH_LADDER, GAP_BOARD } from './widgets/defs.ts';

/**
 * The dashboard a judge sees first: money at the top, the line-ups in the
 * middle (two custom widgets), matches, earnings and holds below, the ledger
 * last. 24 columns; one row track is 16 px. Users can edit all of it.
 */

const sum = (id: string) => ({ id, aggregation: 'sum' as const });
const legend = { style: { theme: { common: { legend: { enabled: true, position: 'bottom' } } } } };
const legendRight = { style: { theme: { common: { legend: { enabled: true, position: 'right' } } } } };
const title = (text: string, subtitle?: string) => ({
  title: { enabled: true, text },
  ...(subtitle ? { subtitle: { enabled: true, text: subtitle } } : {}),
});

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
        text: `Ask the market desk on the right, for example "Which shop has the ${W.widestSpread} right now?". It answers and builds its widget here.`,
        textAlign: 'center',
        verticalAlign: 'center',
        color: '#7e839d',
        padding: true,
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
    dataMapping: { cols: [{ id: 'ledger.slot' }, { id: 'ledger.kind' }, { id: 'ledger.amountUsd' }, { id: 'ledger.who' }, { id: 'ledger.text' }] },
    sort: [{ field: { id: 'ledger.slot' }, direction: 'desc' }],
    format: { ...title('Ledger', 'Every money event, newest first') },
  },
};

const widgetLayout = {
  'w-money': { xTrack: 0, yTrack: 0, xSpan: 14, ySpan: 8 },
  'w-units': { xTrack: 14, yTrack: 0, xSpan: 5, ySpan: 8 },
  'w-fees': { xTrack: 19, yTrack: 0, xSpan: 5, ySpan: 8 },
  'w-gap': { xTrack: 0, yTrack: 8, xSpan: 14, ySpan: 19 },
  [PLACEHOLDER_ID]: { xTrack: 14, yTrack: 8, xSpan: 10, ySpan: 19 },
  'w-fills': { xTrack: 0, yTrack: 27, xSpan: 12, ySpan: 18 },
  'w-holds': { xTrack: 12, yTrack: 27, xSpan: 12, ySpan: 18 },
  'w-earn': { xTrack: 0, yTrack: 45, xSpan: 10, ySpan: 18 },
  'w-depth': { xTrack: 10, yTrack: 45, xSpan: 14, ySpan: 18 },
  'w-ledger': { xTrack: 0, yTrack: 63, xSpan: 24, ySpan: 20 },
};

export const INITIAL_STATE = {
  pages: [{ id: 'market', widgets, widgetLayout }],
  selectedPageId: 'market',
  panels: { data: { collapsed: true }, edit: { collapsed: true }, filters: { collapsed: true }, ai: { collapsed: false, width: 372 } },
} as unknown as AgReportState;
