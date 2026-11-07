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
  ledger: 'Every money event: held, captured, released, paid out, renewed; one plain sentence each.',
  payouts: 'PayPal Payouts to queuers: the queue fee after the platform fee, and shop price plus shipping at cost.',
};

function fieldFor(f: OpsDataset['fields'][number]): AgFieldDefinition {
  const base = { id: f.name, name: f.label };
  if (f.type === 'number') {
    if (f.name.endsWith('Usd')) return { ...base, format: 'currencyFormat', formatOptions: { format: usdFormat } } as AgFieldDefinition;
    return { ...base, format: 'integerFormat' } as AgFieldDefinition;
  }
  if (f.type === 'date') return { ...base, format: 'dateTimeFormat' } as AgFieldDefinition;
  if (f.type === 'boolean') return { ...base, format: 'booleanFormat' } as AgFieldDefinition;
  const hide = f.name.endsWith('Id') || f.name === 'accent';
  return { ...base, format: 'textFormat', ...(hide ? { hide: true } : {}) } as AgFieldDefinition;
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
    fields: d.fields.map(fieldFor),
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
