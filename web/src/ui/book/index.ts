/**
 * The order book view (one shop item): requests by fee level with what PayPal
 * holds behind them, offers walking down their step-down clocks, the spread,
 * recent matches, and in demo mode a clock to show the steps. Mounted by
 * pages/MapPage.tsx; opened from the shop sheet, the queuer's task card and
 * the map labels.
 */
export { BookGlyph, BookStrip } from './BookStrip';
export { OrderBookLayer } from './OrderBook';
export { openBook, useBook, type BookEntry } from './store';
