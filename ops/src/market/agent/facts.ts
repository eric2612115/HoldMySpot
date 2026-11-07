import { formatUsd } from '@holdmyspot/shared';
import type { MarketSnapshot } from '../../data/backend.ts';
import { clockText } from '../../data/time.ts';
import { W } from '../../data/vocab.ts';

/** What the market desk knows at one market moment, read from the same datasets the dashboard shows. */
export interface MarketFacts {
  time: string;
  gaps: { shop: string; bidText: string; askText: string; gapText: string; gap: number; why: string }[];
  depth: { shop: string; bidUnits: number; bidLevels: number; topBid: string; askUnits: number; bestAsk: string | null } | null;
  money: { open: string; captured: string; released: string; paidOut: string };
  earners: { name: string; amount: string; jobs: number }[];
  summary: string;
}

const usd = (dollars: number) => formatUsd(Math.round(dollars * 100), { exact: true });
const n = (v: unknown) => (typeof v === 'number' ? v : 0);

export function marketFacts(s: MarketSnapshot): MarketFacts {
  const time = clockText(s.at);
  const books = s.datasets.books.rows;
  const gaps = books
    .filter((r) => typeof r.spreadUsd === 'number')
    .map((r) => {
      const by = r.askBy ? String(r.askBy) : 'A queuer';
      const note = String(r.askNote ?? '');
      const next = r.nextStep && typeof r.nextAskUsd === 'number' ? ` The next step at ${String(r.nextStep)} brings it to ${usd(r.nextAskUsd)}.` : '';
      return {
        shop: String(r.shop),
        bidText: usd(n(r.bestBidUsd)),
        askText: usd(n(r.bestAskUsd)),
        gap: n(r.spreadUsd),
        gapText: usd(n(r.spreadUsd)),
        why: `${by}'s ${W.ask} is ${note.charAt(0).toLowerCase()}${note.slice(1)}.${next}`,
      };
    })
    .sort((a, b) => b.gap - a.gap);

  const ghBids = s.datasets.bids.rows.filter((r) => r.shopId === 'paper-moon-toys' && ['open', 'partially_matched'].includes(String(r.status)) && n(r.remainingQty) > 0);
  const ghAsks = s.datasets.asks.rows.filter((r) => r.shopId === 'paper-moon-toys' && r.status === 'open' && n(r.remainingCapacity) > 0);
  const levels = new Set(ghBids.map((r) => n(r.maxFeeUsd)));
  const depth = ghBids.length
    ? {
        shop: 'Paper Moon Toys',
        bidUnits: ghBids.reduce((t, r) => t + n(r.remainingQty), 0),
        bidLevels: levels.size,
        topBid: usd(Math.max(...levels)),
        askUnits: ghAsks.reduce((t, r) => t + n(r.remainingCapacity), 0),
        bestAsk: ghAsks.length ? usd(Math.min(...ghAsks.map((r) => n(r.feeNowUsd)))) : null,
      }
    : null;

  const holds = s.datasets.holds.rows;
  const sum = (rows: typeof holds, key: string) => rows.reduce((t, r) => t + n(r[key]), 0);
  const money = {
    open: usd(sum(holds, 'openUsd')),
    captured: usd(sum(holds, 'capturedUsd')),
    released: usd(sum(holds, 'releasedUsd')),
    paidOut: usd(sum(s.datasets.payouts.rows, 'amountUsd')),
  };

  const byQueuer = new Map<string, { amount: number; jobs: number }>();
  for (const j of s.datasets.jobs.rows) {
    if (j.payState !== 'Paid out') continue;
    const e = byQueuer.get(String(j.queuer)) ?? { amount: 0, jobs: 0 };
    e.amount += n(j.earningsUsd);
    e.jobs += 1;
    byQueuer.set(String(j.queuer), e);
  }
  const earners = [...byQueuer]
    .sort((a, b) => b[1].amount - a[1].amount)
    .map(([name, e]) => ({ name, amount: usd(e.amount), jobs: e.jobs }));

  const summary = [
    `Market time ${time} (San Francisco).`,
    gaps.length ? `${W.spread}s: ${gaps.map((g) => `${g.shop} ${g.gapText} (${W.bestBid.toLowerCase()} ${g.bidText}, ${W.bestAsk.toLowerCase()} ${g.askText})`).join('; ')}.` : `No shop has both sides.`,
    `Money: held ${money.open} open, captured ${money.captured}, released ${money.released}, paid out ${money.paidOut}.`,
    earners.length ? `Fees earned: ${earners.map((e) => `${e.name} ${e.amount}`).join(', ')}.` : 'No fees earned yet.',
  ].join(' ');

  return { time, gaps, depth, money, earners, summary };
}
