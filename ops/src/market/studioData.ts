import type { AgDataSourcesDefinition, AgFieldDefinition, AgRelationDefinition } from 'ag-studio';
import type { OpsDataset, OpsDatasetName, Shop } from '@holdmyspot/shared';
import type { MarketSnapshot } from '../data/backend.ts';
import { toWall } from '../board/boardModel.ts';
import { W } from '../data/vocab.ts';

/**
 * AG Studio's data model for the market dashboard: the contract's eight ops
 * datasets (GET /api/ops/datasets/:name) plus a shops table that every
 * dataset joins to, so one click on a shop cross-filters the whole page.
 * Field descriptions are written for Studio's agents, which read them.
 */

const usdFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

const DESCRIPTIONS: Partial<Record<OpsDatasetName, string>> = {
  books: `One row per shop item: the ${W.bestBid.toLowerCase()} (highest fee a requester will pay per unit), the ${W.bestAsk.toLowerCase()} (lowest fee a queuer asks now, after fee-clock steps), the ${W.spread.toLowerCase()} between them and how many units wait on each side.`,
  fills: 'Every match of a requester and a queuer: units, the fee per unit (always the offer price at the moment of the match) and the time slot.',
  bids: 'Requests backed by a PayPal hold: units wanted, max fee per unit, the hold amount and status.',
  asks: 'Queuer offers at a shop: units, the fee now on the fee clock, the opening fee and the floor.',
  jobs: 'One job per match: the queuer, the requester, the stage and what the queuer earns (fee minus the 10% platform fee).',
  holds: 'PayPal holds behind the requests: held, captured, released and still held, in US dollars.',
  ledger: 'Every money event: held, captured, released, paid out, renewed, refunded; its amount, status (succeeded, pending, failed), whose money, the PayPal object and its id, and one plain sentence. events is 1 per row (sum it to count events).',
  payouts: 'PayPal Payouts to queuers: the queue fee after the platform fee, and shop price plus shipping at cost.',
};

/** What the grid's cell renderers draw for a field (src/market/widgets/cells.ts); Studio carries it, never reads it. */
export interface HmsFieldContext {
  cell?: 'pill' | 'paypal' | 'money';
}

/** Fields drawn as a coloured pill: money events, statuses and stages. */
const PILL_FIELDS = new Set(['status', 'kind', 'stage', 'payState', 'funding']);
/** Money that sums to zero rather than "N/A" when nothing happened yet. */
const ZERO_MONEY = new Set<OpsDatasetName>(['holds', 'payouts', 'ledger', 'fills', 'jobs']);

/**
 * Notes Studio's agents read on the fields they confuse (D-130): holds are one row per request, captures
 * are ledger rows, and a count is a sum of events, never a count of a dollar field.
 */
const FIELD_NOTES: Record<string, string> = {
  'holds.capturedUsd': 'Captured so far from this request\'s hold: one row per request, zero when nothing was captured. Not one row per capture: for capture amounts, counts or an average capture use ledger rows with kind Captured and status succeeded (ledger.amountUsd).',
  'holds.heldUsd': 'The hold of one request (one row per request).',
  'ledger.amountUsd': 'The amount of one money event. Filter ledger.kind (Captured, Released, Paid out, Held) and ledger.status (succeeded) before summing or averaging.',
  'ledger.events': '1 per row: sum it to count money events (never count a dollar field).',
  'payouts.amountUsd': 'One PayPal payout to a queuer.',
  'fills.qty': 'Units matched: sum it to count units.',
};

/** Shorter column names for the dashboard's grids, where the shared label is long. */
const SHORT_NAME: Record<string, string> = { 'ledger.slot': 'Time', 'fills.slot': 'Time', 'ledger.paypalObject': 'PayPal object' };

function fieldFor(dataset: OpsDatasetName, f: OpsDataset['fields'][number]): AgFieldDefinition {
  const note = FIELD_NOTES[`${dataset}.${f.name}`];
  const base = { id: f.name, name: SHORT_NAME[`${dataset}.${f.name}`] ?? f.label, ...(note ? { description: note } : {}) };
  if (f.type === 'number') {
    if (f.name.endsWith('Usd')) {
      return { ...base, format: 'currencyFormat', formatOptions: { format: usdFormat }, context: { cell: 'money' }, ...(ZERO_MONEY.has(dataset) ? { blankValue: '$0.00' } : {}) } as AgFieldDefinition;
    }
    return { ...base, format: 'integerFormat', ...(dataset === 'fills' || f.name === 'events' ? { blankValue: '0' } : {}) } as AgFieldDefinition;
  }
  if (f.type === 'date') return { ...base, format: 'dateTimeFormat' } as AgFieldDefinition;
  if (f.type === 'boolean') return { ...base, format: 'booleanFormat' } as AgFieldDefinition;
  if (f.name === 'paypalId') return { ...base, format: 'textFormat', context: { cell: 'paypal' } } as AgFieldDefinition;
  const hide = (f.name.endsWith('Id') && f.name !== 'paypalId') || f.name === 'accent';
  const context: HmsFieldContext | undefined = PILL_FIELDS.has(f.name) ? { cell: 'pill' } : undefined;
  return { ...base, format: 'textFormat', ...(hide ? { hide: true } : {}), ...(context ? { context } : {}) } as AgFieldDefinition;
}

function rowsFor(d: OpsDataset): Record<string, unknown>[] {
  const dates = d.fields.filter((f) => f.type === 'date').map((f) => f.name);
  if (dates.length === 0) return d.rows;
  return d.rows.map((r) => {
    const out: Record<string, unknown> = { ...r };
    for (const name of dates) {
      const v = r[name];
      out[name] = typeof v === 'number' ? toWall(v) : v;
    }
    return out;
  });
}

/** Shop names as shown on the dashboard; a name used in two cities gets its city. */
export function shopLabel(shop: Shop, shops: Shop[]): string {
  const twins = shops.filter((s) => s.name === shop.name).length;
  return twins > 1 ? `${shop.name} (${shop.cityId === 'sf' ? 'San Francisco' : 'New York'})` : shop.name;
}

function shopsSource(shops: Shop[]) {
  return {
    id: 'shops',
    name: 'Shops',
    description: 'The fictional shops. Every other table joins here on shopId.',
    primaryKeyField: 'shopId',
    data: shops.map((s) => ({
      shopId: s.id,
      shop: shopLabel(s, shops),
      city: s.cityId === 'sf' ? 'San Francisco' : 'New York',
      street: s.street,
      opens: s.hours.opens,
    })),
    fields: [
      { id: 'shopId', name: 'Shop id', format: 'textFormat', hide: true },
      { id: 'shop', name: 'Shop', format: 'textFormat', description: 'Shop name. Use this field for shop categories so a click filters every table.' },
      { id: 'city', name: 'City', format: 'textFormat' },
      { id: 'street', name: 'Street', format: 'textFormat' },
      { id: 'opens', name: 'Opens', format: 'textFormat' },
    ] as AgFieldDefinition[],
  };
}

export function studioData(snapshot: MarketSnapshot): AgDataSourcesDefinition {
  const sources = Object.values(snapshot.datasets).map((d) => ({
    id: d.name,
    name: d.name.charAt(0).toUpperCase() + d.name.slice(1),
    description: DESCRIPTIONS[d.name],
    data: rowsFor(d),
    fields: d.fields.map((f) => fieldFor(d.name, f)),
  }));
  const relationships: AgRelationDefinition[] = Object.values(snapshot.datasets)
    .filter((d) => d.fields.some((f) => f.name === 'shopId'))
    .map((d) => ({ id: `${d.name}-shop`, type: 'many-to-one', source: `${d.name}.shopId`, target: 'shops.shopId' }));
  return {
    description:
      'HoldMySpot: requesters in the US post requests backed by PayPal holds; queuers near a shop post offers and stand in line; a verified receipt triggers captures and PayPal Payouts. Money is US dollars. Times are San Francisco market time.',
    sources: [shopsSource(snapshot.shops), ...sources] as AgDataSourcesDefinition['sources'],
    relationships,
  };
}
