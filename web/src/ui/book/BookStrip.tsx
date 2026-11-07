import { formatUsd } from '../../domain/money';
import type { TaskPoint } from '../../domain/types';
import { useNow } from '../hooks';
import { askRows, bidLevels, spreadOf } from './model';
import { openBook, type BookEntry } from './store';
import './book.css';

const usd = (c: number) => formatUsd(c, { exact: true });

/** A small ladder: requests below, an offer stepping down above. */
export function BookGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true" className="obook-glyph">
      <rect x="1" y="2" width="5" height="2.2" rx="1.1" fill="currentColor" opacity="0.55" />
      <rect x="8" y="2" width="5" height="2.2" rx="1.1" fill="currentColor" />
      <rect x="1" y="6" width="5" height="2.2" rx="1.1" fill="currentColor" opacity="0.55" />
      <rect x="1" y="10" width="5" height="2.2" rx="1.1" fill="currentColor" opacity="0.55" />
      <path d="M10.5 6v5.5M8.6 9.8l1.9 1.9 1.9-1.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The way into an item's order book from a sheet or a task card: the best
 * request, the spread and the best offer right now, one tap from the full book.
 */
export function BookStrip({ point, from }: { point: TaskPoint; from: BookEntry }) {
  const now = useNow(1000);
  const s = spreadOf(bidLevels(point), askRows(point, now));
  return (
    <button type="button" className="obook-strip" onClick={() => openBook(point.id, from)} aria-label={`Open the order book of ${point.itemShort}`}>
      <span className="obook-strip__cell is-bid">
        <small>Best request</small>
        <b>{s.bidCents !== null ? usd(s.bidCents) : 'none'}</b>
      </span>
      <span className="obook-strip__cell is-mid">
        <small>spread</small>
        <b>{s.spreadCents === null ? '–' : s.crossed ? 'met' : usd(s.spreadCents)}</b>
      </span>
      <span className="obook-strip__cell is-ask">
        <small>Best offer</small>
        <b>{s.askCents !== null ? usd(s.askCents) : 'none'}</b>
      </span>
      <span className="obook-strip__go">
        <BookGlyph />
        Order book
      </span>
    </button>
  );
}
