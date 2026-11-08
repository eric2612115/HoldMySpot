import { askFeeAt, askNextDropAt, formatUsd } from '@holdmyspot/shared';
import type { AskTask, Dispute, OpsDataset } from '@holdmyspot/shared';
import type { MarketSnapshot } from '../../data/backend.ts';
import { clockText } from '../../data/time.ts';
import { W } from '../../data/vocab.ts';

/**
 * What the market desk knows at one market moment, read from the same
 * snapshot the dashboard draws (the eight datasets plus the board's records).
 * Every number the desk says comes from here: code decides the figures, the
 * model only words them (D-100).
 */

export interface MarketFacts {
  time: string;
  gaps: { shop: string; bidText: string; askText: string; gapText: string; gap: number; why: string }[];
  depth: { shop: string; bidUnits: number; bidLevels: number; topBid: string; askUnits: number; bestAsk: string | null } | null;
  money: { open: string; captured: string; released: string; paidOut: string };
  earners: { name: string; amount: string; jobs: number }[];
  summary: string;
}

export const TOPICS = ['overview', 'gaps', 'depth', 'holds', 'captures', 'payouts', 'fills', 'stepdowns', 'disputes', 'earnings'] as const;
export type Topic = (typeof TOPICS)[number];

const usd = (dollars: number) => formatUsd(Math.round(dollars * 100), { exact: true });
const cents = (c: number) => formatUsd(c, { exact: true });
const n = (v: unknown) => (typeof v === 'number' ? v : 0);
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
type Row = OpsDataset['rows'][number];

/** Rows of a dataset, narrowed to one shop when `shop` names one (any part of its name, any case). */
function rowsOf(snap: MarketSnapshot, name: keyof MarketSnapshot['datasets'], shop?: string): Row[] {
  const rows = snap.datasets[name].rows;
  if (!shop) return rows;
  const q = shop.toLowerCase();
  return rows.filter((r) => s(r.shop).toLowerCase().includes(q));
}

function shopMatches(snap: MarketSnapshot, shopId: string, shop?: string): boolean {
  if (!shop) return true;
  const name = snap.shops.find((x) => x.id === shopId)?.name ?? shopId;
  return name.toLowerCase().includes(shop.toLowerCase());
}

export function marketFacts(snap: MarketSnapshot, depthShop = 'Paper Moon Toys'): MarketFacts {
  const time = clockText(snap.at);
  const books = snap.datasets.books.rows;
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

  const shopId = snap.shops.find((x) => x.name.toLowerCase().includes(depthShop.toLowerCase()))?.id ?? 'paper-moon-toys';
  const shopName = snap.shops.find((x) => x.id === shopId)?.name ?? depthShop;
  const ghBids = snap.datasets.bids.rows.filter((r) => r.shopId === shopId && ['open', 'partially_matched'].includes(String(r.status)) && n(r.remainingQty) > 0);
  const ghAsks = snap.datasets.asks.rows.filter((r) => r.shopId === shopId && r.status === 'open' && n(r.remainingCapacity) > 0);
  const levels = new Set(ghBids.map((r) => n(r.maxFeeUsd)));
  const depth = ghBids.length
    ? {
        shop: shopName,
        bidUnits: ghBids.reduce((t, r) => t + n(r.remainingQty), 0),
        bidLevels: levels.size,
        topBid: usd(Math.max(...levels)),
        askUnits: ghAsks.reduce((t, r) => t + n(r.remainingCapacity), 0),
        bestAsk: ghAsks.length ? usd(Math.min(...ghAsks.map((r) => n(r.feeNowUsd)))) : null,
      }
    : null;

  const holds = snap.datasets.holds.rows;
  const sum = (rows: Row[], key: string) => rows.reduce((t, r) => t + n(r[key]), 0);
  const money = {
    open: usd(sum(holds, 'openUsd')),
    captured: usd(sum(holds, 'capturedUsd')),
    released: usd(sum(holds, 'releasedUsd')),
    paidOut: usd(sum(snap.datasets.payouts.rows, 'amountUsd')),
  };

  const byQueuer = new Map<string, { amount: number; jobs: number }>();
  for (const j of snap.datasets.jobs.rows) {
    if (j.payState !== 'Paid out') continue;
    const e = byQueuer.get(String(j.queuer)) ?? { amount: 0, jobs: 0 };
    e.amount += n(j.earningsUsd);
    e.jobs += 1;
    byQueuer.set(String(j.queuer), e);
  }
  const earners = [...byQueuer].sort((a, b) => b[1].amount - a[1].amount).map(([name, e]) => ({ name, amount: usd(e.amount), jobs: e.jobs }));

  const summary = [
    `Market time ${time} (San Francisco).`,
    gaps.length ? `${W.spread}s: ${gaps.map((g) => `${g.shop} ${g.gapText} (${W.bestBid.toLowerCase()} ${g.bidText}, ${W.bestAsk.toLowerCase()} ${g.askText})`).join('; ')}.` : `No shop has both sides.`,
    `Money: held ${money.open} open, captured ${money.captured}, released ${money.released}, paid out ${money.paidOut}.`,
    earners.length ? `Fees earned: ${earners.map((e) => `${e.name} ${e.amount}`).join(', ')}.` : 'No fees earned yet.',
  ].join(' ');

  return { time, gaps, depth, money, earners, summary };
}

function holdsText(snap: MarketSnapshot, shop?: string): string {
  const rows = rowsOf(snap, 'holds', shop);
  if (rows.length === 0) return `No PayPal holds${shop ? ` at ${shop}` : ''} yet.`;
  const sum = (k: string) => usd(rows.reduce((t, r) => t + n(r[k]), 0));
  const renew = rows.filter((r) => r.renewalRequired === true);
  const venmo = rows.filter((r) => r.funding === 'Venmo').length;
  const big = [...rows].sort((a, b) => n(b.openUsd) - n(a.openUsd)).slice(0, 4);
  return [
    `${rows.length} PayPal holds${shop ? ` at ${shop}` : ''} (${venmo} funded with Venmo): ${sum('heldUsd')} approved in total, ${sum('openUsd')} still held, ${sum('capturedUsd')} captured, ${sum('releasedUsd')} released back to requesters.`,
    `Largest still held: ${big.map((r) => `${s(r.requester)} ${usd(n(r.openUsd))} (${s(r.shop)})`).join(', ')}.`,
    renew.length
      ? `Needs a new approval (PayPal could not renew it): ${renew.map((r) => `${s(r.requester)} ${usd(n(r.heldUsd))} via ${s(r.funding)}`).join(', ')}.`
      : 'Every hold can still be captured.',
    'A capture never goes above the requester\'s own limit (the hold).',
  ].join(' ');
}

function capturesText(snap: MarketSnapshot, shop?: string): string {
  const ledger = rowsOf(snap, 'ledger', shop);
  const caps = ledger.filter((r) => r.kind === 'Captured');
  const ok = caps.filter((r) => r.status === 'succeeded');
  const failed = caps.filter((r) => r.status === 'failed');
  const released = ledger.filter((r) => r.kind === 'Released' && r.status === 'succeeded');
  const refunded = ledger.filter((r) => r.kind === 'Refunded' && r.status === 'succeeded');
  const total = (rows: Row[]) => usd(rows.reduce((t, r) => t + n(r.amountUsd), 0));
  if (caps.length === 0 && released.length === 0) return `No captures${shop ? ` at ${shop}` : ''} yet: nothing has been charged.`;
  const list = ok.slice(-6).map((r) => `${s(r.who)} ${usd(n(r.amountUsd))} at ${s(r.slot)}${r.paypalId ? ` (PayPal capture ${s(r.paypalId)})` : ''}`);
  return [
    `${ok.length} captures succeeded for ${total(ok)}${shop ? ` at ${shop}` : ''}; ${released.length} releases gave back ${total(released)}${refunded.length ? `; ${refunded.length} refunds of ${total(refunded)}` : ''}.`,
    list.length ? `Captures: ${list.join('; ')}.` : '',
    failed.length ? `Failed captures: ${failed.map((r) => `${s(r.who)} ${usd(n(r.amountUsd))} at ${s(r.slot)} (${s(r.text)})`).join('; ')}.` : 'No capture failed.',
    'Captures happen at a verified receipt (shop price, queue fee and processing at cost) and after tracking (the shipping the queuer declared, up to the budget, plus its own PayPal fee at cost), never above the request\'s hold.',
  ]
    .filter(Boolean)
    .join(' ');
}

function payoutsText(snap: MarketSnapshot, shop?: string): string {
  const rows = rowsOf(snap, 'payouts', shop);
  if (rows.length === 0) return 'No PayPal Payouts yet: queuers are paid after the capture that covers their fee.';
  const byQueuer = new Map<string, { paid: number; pending: number; fee: number; n: number }>();
  for (const r of rows) {
    const e = byQueuer.get(s(r.queuer)) ?? { paid: 0, pending: 0, fee: 0, n: 0 };
    if (r.status === 'succeeded') e.paid += n(r.amountUsd);
    else e.pending += n(r.amountUsd);
    e.fee += n(r.platformFeeUsd);
    e.n += 1;
    byQueuer.set(s(r.queuer), e);
  }
  const total = rows.filter((r) => r.status === 'succeeded').reduce((t, r) => t + n(r.amountUsd), 0);
  const pending = rows.filter((r) => r.status !== 'succeeded');
  return [
    `${rows.length} PayPal Payouts, ${usd(total)} paid out.`,
    `By queuer: ${[...byQueuer].map(([q, e]) => `${q} ${usd(e.paid)} in ${e.n} payout${e.n > 1 ? 's' : ''} (platform fee ${usd(e.fee)})${e.pending ? `, ${usd(e.pending)} pending` : ''}`).join('; ')}.`,
    pending.length ? `Not settled yet: ${pending.map((r) => `${s(r.queuer)} ${usd(n(r.amountUsd))} ${s(r.status)}`).join(', ')}.` : 'Every payout has succeeded.',
  ].join(' ');
}

function fillsText(snap: MarketSnapshot, shop?: string): string {
  const bids = rowsOf(snap, 'bids', shop).filter((r) => !['awaiting_approval', 'approval_failed'].includes(s(r.status)));
  const fills = rowsOf(snap, 'fills', shop);
  const byShop = new Map<string, { asked: number; waiting: number; matched: number; fees: number; matches: number }>();
  for (const r of bids) {
    const e = byShop.get(s(r.shop)) ?? { asked: 0, waiting: 0, matched: 0, fees: 0, matches: 0 };
    e.asked += n(r.qty);
    e.waiting += ['open', 'partially_matched'].includes(s(r.status)) ? n(r.remainingQty) : 0;
    byShop.set(s(r.shop), e);
  }
  for (const f of fills) {
    const e = byShop.get(s(f.shop)) ?? { asked: 0, waiting: 0, matched: 0, fees: 0, matches: 0 };
    e.matched += n(f.qty);
    e.fees += n(f.valueUsd);
    e.matches += 1;
    byShop.set(s(f.shop), e);
  }
  if (byShop.size === 0) return `No requests${shop ? ` at ${shop}` : ''} yet.`;
  const lines = [...byShop]
    .sort((a, b) => b[1].matched - a[1].matched || b[1].asked - a[1].asked)
    .map(([name, e]) => {
      const rate = e.asked > 0 ? Math.round((100 * Math.min(e.matched, e.asked)) / e.asked) : 0;
      const avg = e.matched > 0 ? `, average fee ${usd(e.fees / e.matched)}` : '';
      return `${name}: ${e.matched} of ${e.asked} units ${W.filled} (${rate}%)${avg}, ${e.waiting} still waiting`;
    });
  const units = [...byShop.values()].reduce((t, e) => t + e.matched, 0);
  const asked = [...byShop.values()].reduce((t, e) => t + e.asked, 0);
  return `Fill rate is units ${W.filled} over units requested (a unit matched again after a failure counts again). Overall ${units} of ${asked} units (${asked ? Math.round((100 * Math.min(units, asked)) / asked) : 0}%). ${lines.join('; ')}.`;
}

function stepdownsText(snap: MarketSnapshot, shop?: string): string {
  const clocks = Object.values(snap.bundle.asks).filter((a): a is AskTask & { clock: NonNullable<AskTask['clock']> } => a.clock !== null && shopMatches(snap, a.shopId, shop));
  if (clocks.length === 0) return `No offer${shop ? ` at ${shop}` : ''} has a fee clock: every fee is fixed.`;
  const t = snap.at;
  const lines = clocks.map((a) => {
    const shopName = snap.shops.find((x) => x.id === a.shopId)?.name ?? a.shopId;
    const step = `${cents(a.clock.stepCents)} every ${Math.round(a.clock.intervalMs / 60_000)} min to a floor of ${cents(a.clock.floorCents)}`;
    const matches = Object.values(snap.bundle.jobs).filter((j) => j.askId === a.id);
    const matched = matches.length ? ` Matched ${matches.map((j) => `${j.requesterName} at ${cents(j.feeCents)} (${clockText(j.createdAt)})`).join(', ')}.` : '';
    if (a.clock.startsAt === null) return `${a.queuerName} at ${shopName}: opens at ${cents(a.feeCents)}, ${step}; the clock starts at check-in (ETA ${clockText(a.etaAt)}).${matched}`;
    const now = askFeeAt(a, t);
    const open = a.status === 'open';
    const next = open ? askNextDropAt(a, t) : null;
    // A clock stops at the match that took its last unit (D-132): "at the floor" only for a clock still running there.
    const nextText = next !== null ? ` Next step at ${clockText(next)}: ${cents(askFeeAt(a, next))}.` : open && now <= a.clock.floorCents ? ' At the floor.' : '';
    const last = matches.slice().sort((x, y) => x.createdAt - y.createdAt).at(-1);
    const state = open ? `fee now ${cents(now)}` : last ? `${a.status} at ${cents(last.feeCents)} when matched` : `${a.status}`;
    return `${a.queuerName} at ${shopName}: opened at ${cents(a.feeCents)} at check-in (${clockText(a.clock.startsAt)}), ${step}; ${state}.${nextText}${matched}`;
  });
  return `${lines.join(' ')} A step-down never goes below the floor, and a request fills at the first step at or under its max fee.`;
}

function disputesText(snap: MarketSnapshot, disputes: Dispute[] | null, shop?: string): string {
  const jobs = Object.values(snap.bundle.jobs).filter((j) => shopMatches(snap, j.shopId, shop));
  const rejected = jobs.filter((j) => j.failure?.reason === 'proof_rejected');
  const failedPay = jobs.filter((j) => j.failure?.reason === 'payment_failed');
  const capFails = rowsOf(snap, 'ledger', shop).filter((r) => r.kind === 'Captured' && r.status === 'failed');
  const open = (disputes ?? []).filter((d) => d.status !== 'resolved');
  return [
    disputes === null
      ? 'The replay has no PayPal dispute records. The server\'s dispute sync is not built yet; disputes ran only in the sandbox gate script (G7).'
      : open.length
        ? `${open.length} open PayPal dispute${open.length > 1 ? 's' : ''}: ${open.map((d) => `${cents(d.amount.cents)} on capture ${d.captureId} (${d.reason}, ${d.status})`).join('; ')}.`
        : `No open PayPal disputes on record${disputes.length ? ` (${disputes.length} resolved)` : ''}; the server's sync with PayPal's Disputes API is not built yet.`,
    rejected.length ? `Rejected receipts (nothing captured): ${rejected.map((j) => `${j.queuerName} for ${j.requesterName} at ${clockText(j.failure!.at)}`).join('; ')}.` : 'No receipt was rejected.',
    failedPay.length || capFails.length
      ? `Failed captures: ${(failedPay.length ? failedPay.map((j) => `${j.requesterName} via ${j.queuerName} at ${clockText(j.failure!.at)}`) : capFails.map((r) => `${s(r.who)} ${usd(n(r.amountUsd))}`)).join('; ')}.`
      : 'No capture failed.',
  ].join(' ');
}

function earningsText(f: MarketFacts): string {
  if (f.earners.length === 0) return `No queuer has a verified receipt yet at ${f.time}, so nobody has earned a fee.`;
  return `Queue fees earned after the 10% platform fee, paid jobs only: ${f.earners.map((e) => `${e.name} ${e.amount} (${e.jobs} job${e.jobs > 1 ? 's' : ''})`).join(', ')}.`;
}

function gapsText(f: MarketFacts): string {
  const top = f.gaps[0];
  if (!top) return `No shop has both a ${W.bid} and an ${W.ask} at ${f.time}, so there is no ${W.spread.toLowerCase()}.`;
  return `${W.spread}s at ${f.time}, widest first: ${f.gaps.map((g) => `${g.shop} ${g.gapText} (${W.bestBid.toLowerCase()} ${g.bidText}, ${W.bestAsk.toLowerCase()} ${g.askText})`).join('; ')}. ${top.why}`;
}

function depthText(f: MarketFacts): string {
  const d = f.depth;
  if (!d) return `Nothing waits at that shop at ${f.time}.`;
  return `${d.shop}: ${d.bidUnits} units waiting across ${d.bidLevels} fee levels, the top at ${d.topBid}; ${d.askUnits} units offered${d.bestAsk ? ` from ${d.bestAsk}` : ''}.`;
}

/** The read_market tool's answer for one topic: plain sentences with every number. */
export function topicFacts(snap: MarketSnapshot, topic: Topic, shop?: string, disputes: Dispute[] | null = null): string {
  const f = marketFacts(snap, shop || undefined);
  const head = `Market time ${f.time}, San Francisco.`;
  switch (topic) {
    case 'gaps':
      return `${head} ${gapsText(f)}`;
    case 'depth':
      return `${head} ${depthText(f)}`;
    case 'holds':
      return `${head} ${holdsText(snap, shop)}`;
    case 'captures':
      return `${head} ${capturesText(snap, shop)}`;
    case 'payouts':
      return `${head} ${payoutsText(snap, shop)}`;
    case 'fills':
      return `${head} ${fillsText(snap, shop)}`;
    case 'stepdowns':
      return `${head} ${stepdownsText(snap, shop)}`;
    case 'disputes':
      return `${head} ${disputesText(snap, disputes, shop)}`;
    case 'earnings':
      return `${head} ${earningsText(f)}`;
    default:
      return f.summary;
  }
}

/** The topic a free-text question is about, for the offline planner. */
export function topicOf(text: string): Topic | 'help' {
  const t = text.toLowerCase();
  if (/(dispute|chargeback|reject|fake|fraud|failed capture|declin)/.test(t)) return 'disputes';
  if (/(step|clock|step-down|stepdown|drop|floor)/.test(t)) return 'stepdowns';
  if (/(fill|fill rate|matched|match rate)/.test(t)) return 'fills';
  if (/(payout|paid out|paid to|pay out)/.test(t)) return 'payouts';
  // "How much is PayPal holding, and how much was captured or released?": the holds answer has all three totals.
  if (/(hold|held)/.test(t) && /(captur|charged|charge|releas)/.test(t)) return 'holds';
  if (/(captur|charged|charge)/.test(t)) return 'captures';
  if (/(spread|gap|widest|difference|apart)/.test(t)) return 'gaps';
  if (/(depth|deep|ladder|how many.*wait)/.test(t)) return 'depth';
  if (/(hold|held|releas|money|paypal)/.test(t)) return 'holds';
  if (/(earn|best queuer|top earner|who made)/.test(t)) return 'earnings';
  if (/(overview|summary|how is the market|what is going on|status)/.test(t)) return 'overview';
  return 'help';
}

/** Every topic a question touches, in topicOf's order (the offline planner answers the first). */
export function topicsIn(text: string): Topic[] {
  const t = text.toLowerCase();
  const tests: [Topic, RegExp][] = [
    ['disputes', /(dispute|chargeback|reject|fake|fraud|failed capture|declin)/],
    ['stepdowns', /(step|clock|step-down|stepdown|drop|floor)/],
    ['fills', /(fill|fill rate|matched|match rate)/],
    ['payouts', /(payout|paid out|paid to|pay out)/],
    ['captures', /(captur|charged|charge)/],
    ['gaps', /(spread|gap|widest|difference|apart)/],
    ['depth', /(depth|deep|ladder|how many.*wait)/],
    ['holds', /(hold|held|releas)/],
    ['earnings', /(earn|best queuer|top earner|who made)/],
  ];
  return tests.filter(([, re]) => re.test(t)).map(([topic]) => topic);
}

/** A shop named in a question, if any. */
export function shopIn(snap: MarketSnapshot, text: string): string | undefined {
  const t = text.toLowerCase();
  return snap.shops.find((x) => t.includes(x.name.toLowerCase()) || t.includes(x.name.split(' ').slice(0, 2).join(' ').toLowerCase()))?.name;
}

const TOPIC_WORDS: Record<Topic, string> = {
  overview: 'the overview',
  gaps: `the ${W.widestSpread}`,
  depth: `the ${W.depth.toLowerCase()}`,
  holds: 'holds and releases',
  captures: 'captures',
  payouts: 'payouts',
  fills: 'fill rates',
  stepdowns: 'step-downs',
  disputes: 'disputes',
  earnings: 'queuer earnings ("Top earner")',
};

/** The offline planner answers one topic: it says which, and names the other parts of the question to ask on their own. */
export function otherTopicsNote(question: string, answered: Topic): string {
  // The holds answer has the held, captured and released totals, so "holds and captures" needs no second question.
  const covers: Partial<Record<Topic, Topic[]>> = { holds: ['captures'], overview: [...TOPICS] };
  const others = topicsIn(question).filter((t) => t !== answered && !(covers[answered] ?? []).includes(t));
  if (others.length === 0) return '';
  return ` (Offline planner: I answered ${TOPIC_WORDS[answered]}. Ask about ${others.map((t) => TOPIC_WORDS[t]).join(' and ')} on its own for that part.)`;
}

/** The market day and time for Studio's agents, which otherwise read the browser's real date as "today". */
export function marketClockNote(snap: MarketSnapshot): string {
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(snap.at)
    .replace(', ', ' ');
  return `Market clock: ${local} (America/Los_Angeles). "Today" and "so far" mean this market day; every time in the data is market time. Do not filter on the real date.`;
}

