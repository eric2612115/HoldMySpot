import { createWidgets } from 'ag-studio-react';
import type { AgWidgetDefinition } from 'ag-studio-react';
import { W } from '../../data/vocab.ts';
import { DepthLadder } from './DepthLadder.tsx';
import { GapBoard } from './GapBoard.tsx';
import { GapSpotlight } from './GapSpotlight.tsx';

/** Custom widget type ids. The agent adds 'hms-gap-spotlight' with Studio's own add_widget tool. */
export const GAP_BOARD = 'hms-gap-board';
export const DEPTH_LADDER = 'hms-depth-ladder';
export const GAP_SPOTLIGHT = 'hms-gap-spotlight';

const icon = (path: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">${path}</svg>`;

const shop = { type: 'field' as const, supportedRoles: ['category' as const], required: true, aiDescription: 'Shop name, use shops.shop so clicks filter every table.' };
const measure = (aiDescription: string, required = false) => ({ type: 'field' as const, supportedRoles: ['numeric' as const], required, aiDescription });
const label = { type: 'field' as const, supportedRoles: ['category' as const], aiDescription: 'Text shown next to the answer.' };

const gapMapping = {
  shop: [{ id: 'shops.shop' }],
  bestBid: [{ id: 'books.bestBidUsd', aggregation: 'max' }],
  bestAsk: [{ id: 'books.bestAskUsd', aggregation: 'min' }],
  bidDepth: [{ id: 'books.bidQty', aggregation: 'sum' }],
  askDepth: [{ id: 'books.askCapacity', aggregation: 'sum' }],
};

const gapBoard: AgWidgetDefinition = {
  id: GAP_BOARD,
  label: `${W.spread} board`,
  icon: icon('<path d="M2 4h12M2 8h12M2 12h12"/><circle cx="5" cy="4" r="1.4" fill="currentColor"/><circle cx="11" cy="8" r="1.4" fill="currentColor"/><circle cx="8" cy="12" r="1.4" fill="currentColor"/>'),
  comp: GapBoard,
  dataMapping: {
    shop,
    bestBid: measure(`${W.bestBid} per unit in USD (aggregate with max).`, true),
    bestAsk: measure(`${W.bestAsk} per unit in USD after fee-clock steps (aggregate with min).`, true),
    bidDepth: measure('Units waiting on the request side (sum).'),
    askDepth: measure('Units offered by queuers (sum).'),
  },
  form: (p) =>
    p.createDefaults({
      supportsTriggerCrossFilter: false,
      dataMappingItems: [
        { key: 'shop', label: 'Shop' },
        { key: 'bestBid', label: W.bestBid },
        { key: 'bestAsk', label: W.bestAsk },
        { key: 'bidDepth', label: `${W.bids} waiting` },
        { key: 'askDepth', label: `${W.asks} available` },
      ],
    }),
  defaultState: { dataMapping: gapMapping } as never,
  defaultSize: { width: 640, height: 300 },
  minSize: { width: 360, height: 180 },
  featureConfig: { crossFilter: { supportsHighlight: false } },
  ai: {
    label: `${W.spread} board`,
    description: `One rail per shop: the ${W.bestBid.toLowerCase()} and the ${W.bestAsk.toLowerCase()} as markers with the ${W.spread.toLowerCase()} drawn between them, widest first. Clicking a shop cross-filters the page.`,
    usage: `Use for questions comparing shops by ${W.spread.toLowerCase()}, ${W.bestBid.toLowerCase()} or ${W.bestAsk.toLowerCase()}.`,
  },
};

const depthLadder: AgWidgetDefinition = {
  id: DEPTH_LADDER,
  label: `${W.depth} ladder`,
  icon: icon('<path d="M8 2v12M3 4h4M4 7h3M5 10h2M9 5h4M9 8h3M9 11h2"/>'),
  comp: DepthLadder,
  form: (p) => p.createDefaults({}),
  defaultSize: { width: 420, height: 300 },
  minSize: { width: 280, height: 200 },
  ai: {
    label: `${W.depth} ladder`,
    description: `Units waiting at each fee level for one shop: ${W.bids} on the left, ${W.asks} on the right. Follows the page's cross-filter.`,
  },
};

const gapSpotlight: AgWidgetDefinition = {
  id: GAP_SPOTLIGHT,
  label: `${W.widestSpread.charAt(0).toUpperCase()}${W.widestSpread.slice(1)}`,
  icon: icon('<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>'),
  comp: GapSpotlight,
  dataMapping: {
    shop,
    bestBid: measure(`${W.bestBid} per unit (max).`, true),
    bestAsk: measure(`${W.bestAsk} per unit (min).`, true),
    bidDepth: measure('Units waiting (sum).'),
    askDepth: measure('Units offered (sum).'),
    askBy: label,
    askNote: label,
    nextStep: label,
    nextAsk: measure(`${W.bestAsk} after the next fee-clock step (min).`),
  },
  form: (p) =>
    p.createDefaults({
      dataMappingItems: [
        { key: 'shop', label: 'Shop' },
        { key: 'bestBid', label: W.bestBid },
        { key: 'bestAsk', label: W.bestAsk },
        { key: 'askBy', label: 'Offered by' },
        { key: 'askNote', label: 'Offer status' },
      ],
    }),
  defaultState: {
    dataMapping: {
      ...gapMapping,
      askBy: [{ id: 'books.askBy' }],
      askNote: [{ id: 'books.askNote' }],
      nextStep: [{ id: 'books.nextStep' }],
      nextAsk: [{ id: 'books.nextAskUsd', aggregation: 'min' }],
    },
  } as never,
  defaultSize: { width: 420, height: 300 },
  minSize: { width: 300, height: 220 },
  ai: {
    label: `${W.widestSpread} spotlight`,
    description: `Names the shop with the ${W.widestSpread} between the ${W.bestBid.toLowerCase()} and the ${W.bestAsk.toLowerCase()}, why, and the runners-up.`,
    usage: `Add it to answer "which shop has the ${W.widestSpread}" questions. It needs no configuration.`,
  },
};

export const WIDGETS = createWidgets({
  additionalTypes: [gapBoard, depthLadder, gapSpotlight],
  menu: [
    { label: 'HoldMySpot', widgetIds: [GAP_BOARD, DEPTH_LADDER, GAP_SPOTLIGHT] },
  ],
} as never);
