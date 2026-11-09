/**
 * Screen words. docs/DOMAIN.md section 9 keeps exchange vocabulary (spread,
 * trading) off the screens, while the product keeps "walking order book"
 * as the name of its mechanism (docs/DECISIONS.md D-37). The console
 * defaults to the plain set; VITE_OPS_WORDS=market switches every label,
 * dataset name and agent sentence to the market set in one place.
 */
export type WordSet = 'plain' | 'market';

export interface Words {
  bid: string;
  bids: string;
  ask: string;
  asks: string;
  bestBid: string;
  bestAsk: string;
  spread: string;
  widestSpread: string;
  depth: string;
  fills: string;
  fill: string;
  filled: string;
  book: string;
}

const PLAIN: Words = {
  bid: 'request',
  bids: 'requests',
  ask: 'offer',
  asks: 'offers',
  bestBid: 'Top request',
  bestAsk: 'Lowest offer',
  spread: 'Gap',
  widestSpread: 'widest gap',
  depth: 'Depth',
  fills: 'Matches',
  fill: 'match',
  filled: 'matched',
  book: 'line-up',
};

const MARKET: Words = {
  bid: 'bid',
  bids: 'bids',
  ask: 'ask',
  asks: 'asks',
  bestBid: 'Best bid',
  bestAsk: 'Best ask',
  spread: 'Spread',
  widestSpread: 'widest spread',
  depth: 'Depth',
  fills: 'Fills',
  fill: 'fill',
  filled: 'filled',
  book: 'book',
};

function pick(): WordSet {
  const fromUrl = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('words');
  const value = fromUrl ?? (import.meta.env?.VITE_OPS_WORDS as string | undefined) ?? 'plain';
  return value === 'market' ? 'market' : 'plain';
}

export const WORD_SET: WordSet = pick();
export const W: Words = WORD_SET === 'market' ? MARKET : PLAIN;
