import { useMemo } from 'react';
import type { AgWidgetParams } from 'ag-studio';
import { SEED_SHOPS } from '@holdmyspot/shared';
import { W } from '../../data/vocab.ts';
import { money, num, str, useRows } from './useRows.ts';

const SLOTS = ['shop', 'bestBid', 'bestAsk', 'bidDepth', 'askDepth'];

export interface GapRow {
  shop: string;
  bid: number | null;
  ask: number | null;
  gap: number | null;
  bidQty: number;
  askQty: number;
  accent: string;
}

export function accentFor(shopLabel: string): string {
  const s = SEED_SHOPS.find((x) => shopLabel.startsWith(x.name));
  return s?.accent ?? '#7e839d';
}

export function toGapRows(rows: Record<string, unknown>[], keys: Record<string, string | undefined>): GapRow[] {
  return rows
    .map((r) => {
      const bid = keys.bestBid ? num(r[keys.bestBid]) : null;
      const ask = keys.bestAsk ? num(r[keys.bestAsk]) : null;
      const shop = keys.shop ? str(r[keys.shop]) : '';
      return {
        shop,
        bid,
        ask,
        gap: bid !== null && ask !== null ? Math.round((ask - bid) * 100) / 100 : null,
        bidQty: keys.bidDepth ? (num(r[keys.bidDepth]) ?? 0) : 0,
        askQty: keys.askDepth ? (num(r[keys.askDepth]) ?? 0) : 0,
        accent: accentFor(shop),
      };
    })
    .filter((r) => r.shop && (r.bid !== null || r.ask !== null))
    .sort((a, b) => (b.gap ?? -1) - (a.gap ?? -1) || (b.bid ?? 0) - (a.bid ?? 0));
}

/**
 * Custom AG Studio widget: one rail per shop with the top request and the
 * lowest offer as markers and the gap between them drawn as a bridge.
 * Clicking a shop cross-filters the page to it.
 */
export function GapBoard(params: AgWidgetParams) {
  const { rows, slots } = useRows(params, SLOTS, ['shop', 'bestBid', 'bestAsk']);
  const keys = useMemo(() => Object.fromEntries(SLOTS.map((s) => [s, slots[s]?.key])), [slots]);
  const data = useMemo(() => (rows ? toGapRows(rows, keys) : []), [rows, keys]);
  const max = Math.ceil((Math.max(5, ...data.flatMap((r) => [r.bid ?? 0, r.ask ?? 0])) * 1.05) / 5) * 5;
  const pct = (v: number) => `${(v / max) * 100}%`;
  const selected = params.widgetApi.getCrossFilterSelections?.() ?? [];
  const selectedShops = new Set(selected.flatMap((s) => (s as { values?: { value?: unknown }[] }).values?.map((v) => str(v.value)) ?? []));

  const toggle = (shop: string) => {
    const field = slots.shop;
    if (!field) return;
    params.widgetApi.toggleCrossFilter({ type: 'value', field, value: shop, group: 0 });
  };

  return (
    <div className="hms-w hms-gapboard">
      <div className="hms-gap-scale" aria-hidden="true">
        <span>$0</span>
        <span>{money(max / 2)}</span>
        <span>{money(max)}</span>
      </div>
      <ol className="hms-gap-list">
        {data.map((r, i) => (
          <li key={r.shop} className={`${i === 0 && r.gap !== null ? 'is-top' : ''}${selectedShops.has(r.shop) ? ' is-picked' : ''}`}>
            <button type="button" className="hms-gap-row" onClick={() => toggle(r.shop)} style={{ ['--accent' as string]: r.accent }}>
              <span className="hms-gap-shop">
                <i />
                <span>{r.shop}</span>
              </span>
              <span className="hms-rail">
                <span className="hms-rail-line" />
                {r.bid !== null && r.ask !== null && (
                  <span className="hms-bridge" style={{ left: pct(r.bid), width: pct(Math.max(r.ask - r.bid, 0)) }}>
                    <b>{money(r.gap)}</b>
                  </span>
                )}
                {r.bid !== null && (
                  <span className="hms-dot is-bid" style={{ left: pct(r.bid) }} title={`${W.bestBid} ${money(r.bid)}`}>
                    <em>{money(r.bid)}</em>
                  </span>
                )}
                {r.ask !== null && (
                  <span className="hms-dot is-ask" style={{ left: pct(r.ask) }} title={`${W.bestAsk} ${money(r.ask)}`}>
                    <em>{money(r.ask)}</em>
                  </span>
                )}
              </span>
              <span className="hms-gap-depth">
                <span className="is-bid">{r.bidQty} waiting</span>
                <span className="is-ask">{r.ask === null ? `no ${W.ask}` : `${r.askQty} ${r.askQty === 1 ? W.ask : W.asks}`}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      <div className="hms-gap-key" aria-hidden="true">
        <span className="is-bid">{W.bestBid}</span>
        <span className="is-ask">{W.bestAsk}</span>
        <span className="is-gap">{W.spread}</span>
      </div>
    </div>
  );
}
