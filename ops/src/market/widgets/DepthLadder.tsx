import { useEffect, useMemo, useState } from 'react';
import type { AgWidgetField, AgWidgetParams } from 'ag-studio';
import { W } from '../../data/vocab.ts';
import { accentFor } from './GapBoard.tsx';
import { money, num, str } from './useRows.ts';

interface Level {
  fee: number;
  qty: number;
}

interface Book {
  shop: string;
  bids: Level[];
  asks: Level[];
}

function field(params: AgWidgetParams, id: string): AgWidgetField | undefined {
  for (const table of params.widgetApi.getSchema()) {
    const f = table.fields.find((x) => x.fieldId === id);
    if (f) return f;
  }
  return undefined;
}

function group(rows: Record<string, unknown>[], shopKey: string, feeKey: string, qtyKey: string, statusKey: string, open: string[]) {
  const books = new Map<string, Map<number, number>>();
  for (const r of rows) {
    const qty = num(r[qtyKey]) ?? 0;
    const fee = num(r[feeKey]);
    if (qty <= 0 || fee === null || !open.includes(str(r[statusKey]))) continue;
    const shop = str(r[shopKey]);
    const levels = books.get(shop) ?? new Map<number, number>();
    levels.set(fee, (levels.get(fee) ?? 0) + qty);
    books.set(shop, levels);
  }
  return books;
}

/**
 * Custom AG Studio widget: the classic depth ladder for one shop, requests
 * on the left and offers on the right, by fee per unit. It follows the page's
 * cross-filter, so clicking a shop on the gap board switches it.
 */
export function DepthLadder(params: AgWidgetParams) {
  const { widgetApi } = params;
  const [books, setBooks] = useState<Book[] | null>(null);

  useEffect(() => {
    const shop = field(params, 'shops.shop');
    const bidFee = field(params, 'bids.maxFeeUsd');
    const bidQty = field(params, 'bids.remainingQty');
    const bidStatus = field(params, 'bids.status');
    const askFee = field(params, 'asks.feeNowUsd');
    const askQty = field(params, 'asks.remainingCapacity');
    const askStatus = field(params, 'asks.status');
    if (!shop || !bidFee || !bidQty || !bidStatus || !askFee || !askQty || !askStatus) {
      widgetApi.setDisplayState('noData');
      return;
    }
    let live = true;
    const load = async () => {
      const [b, a] = await Promise.all([
        widgetApi.getData({ fields: [shop, bidFee, bidQty, bidStatus] }, { crossFilter: 'filter' }),
        widgetApi.getData({ fields: [shop, askFee, askQty, askStatus] }, { crossFilter: 'filter' }),
      ]);
      if (!live) return;
      const bids = group(b.results.rows, shop.key, bidFee.key, bidQty.key, bidStatus.key, ['open', 'partially_matched']);
      const asks = group(a.results.rows, shop.key, askFee.key, askQty.key, askStatus.key, ['open']);
      const names = new Set([...bids.keys(), ...asks.keys()]);
      const out: Book[] = [...names].map((name) => ({
        shop: name,
        bids: [...(bids.get(name) ?? new Map<number, number>())].map(([fee, qty]) => ({ fee, qty })).sort((x, y) => y.fee - x.fee),
        asks: [...(asks.get(name) ?? new Map<number, number>())].map(([fee, qty]) => ({ fee, qty })).sort((x, y) => x.fee - y.fee),
      }));
      setBooks(out);
      widgetApi.setDisplayState(out.length ? 'displayed' : 'noData');
    };
    widgetApi.setDisplayState('loading');
    void load().catch(() => live && widgetApi.setDisplayState('noData'));
    return () => {
      live = false;
    };
    // Reload when Studio hands the widget new params (filters, cross-filters, data).
  }, [params, widgetApi]);

  // Without a picked shop, show the two-sided book with the most units waiting.
  const book = useMemo(() => {
    if (!books?.length) return null;
    const twoSided = books.filter((b) => b.bids.length && b.asks.length);
    const pool = twoSided.length ? twoSided : books;
    return [...pool].sort((x, y) => y.bids.reduce((s, l) => s + l.qty, 0) - x.bids.reduce((s, l) => s + l.qty, 0))[0] ?? null;
  }, [books]);

  if (!book) return <div className="hms-w hms-empty">No {W.bids} or {W.asks} match the filters.</div>;
  const maxQty = Math.max(1, ...book.bids.map((l) => l.qty), ...book.asks.map((l) => l.qty));
  const rowsCount = Math.max(book.bids.length, book.asks.length);
  return (
    <div className="hms-w hms-depth" style={{ ['--accent' as string]: accentFor(book.shop) }}>
      <div className="hms-depth-head">
        <i />
        <strong>{book.shop}</strong>
        <span>{books && books.length > 1 ? 'Click a shop on the gap board to switch' : 'Filtered shop'}</span>
      </div>
      <div className="hms-depth-cols">
        <span>{W.bids}</span>
        <span>Fee</span>
        <span>{W.asks}</span>
      </div>
      <ol className="hms-depth-rows">
        {Array.from({ length: rowsCount }, (_, i) => {
          const b = book.bids[i];
          const a = book.asks[i];
          return (
            <li key={i}>
              <span className="hms-depth-bid">
                {b && (
                  <>
                    <em>{b.qty}</em>
                    <span style={{ width: `${(b.qty / maxQty) * 100}%` }} />
                  </>
                )}
              </span>
              <span className="hms-depth-fee">
                <b className="is-bid">{b ? money(b.fee) : ''}</b>
                <b className="is-ask">{a ? money(a.fee) : ''}</b>
              </span>
              <span className="hms-depth-ask">
                {a && (
                  <>
                    <span style={{ width: `${(a.qty / maxQty) * 100}%` }} />
                    <em>{a.qty}</em>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
