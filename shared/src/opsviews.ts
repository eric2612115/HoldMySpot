import type {
  AskTask,
  BidTask,
  BookSnapshot,
  Cents,
  Hold,
  Job,
  LedgerEntry,
  MarketMs,
  Match,
  OpsDataset,
  OpsDatasetName,
  Payout,
  Shop,
  UserId,
} from './contract.ts';
import { platformFeeCents } from './money.ts';
import { epochToZonedLocal } from './proofs.ts';
import { DEMO_TIME_ZONE, SEED_CITIES, SEED_SHOPS } from './seed.ts';
import { askFeeAt, askNextDropAt } from './stepdown.ts';

/**
 * The operator console's datasets (GET /api/ops/datasets/:name and the AG
 * Studio market dashboard), built in one place from contract records so the
 * server and the console (live or replaying the hero day) show the same rows.
 * Money is in dollars in fields ending in `Usd`, times are epoch ms in `at`
 * and `*At` fields, every table carries `shopId` so the dashboard can join
 * them, and `slot` fields are "HH:MM" in the market's time zone.
 */

/** Screen words the field labels use (docs/DECISIONS.md D-37: plain words by default). */
export interface OpsWords {
  bids: string;
  asks: string;
  bestBid: string;
  bestAsk: string;
  spread: string;
  fill: string;
}

export const PLAIN_OPS_WORDS: OpsWords = {
  bids: 'requests',
  asks: 'offers',
  bestBid: 'Top request',
  bestAsk: 'Lowest offer',
  spread: 'Gap',
  fill: 'match',
};

export interface OpsViewInput {
  bids: readonly BidTask[];
  holds: readonly Hold[];
  asks: readonly AskTask[];
  matches: readonly Match[];
  jobs: readonly Job[];
  ledger: readonly LedgerEntry[];
  payouts: readonly Payout[];
  books: readonly BookSnapshot[];
  /** Display names by user id (personas and crowd requesters), for "whose money". */
  names: Readonly<Record<UserId, string>>;
}

export interface OpsViewOptions {
  words?: OpsWords;
  /** Zone of the `slot` fields. Default the hero day's zone, San Francisco (where the hero shops are). */
  timeZone?: string;
  /** Ledger slots earlier than this read as this time (seeded holds before the market opens). */
  slotFloor?: MarketMs;
}

const MINUTE = 60_000;

const JOB_STAGE: Record<string, string> = {
  claimed: 'On the way',
  checked_in: 'In line',
  queueing: 'In line',
  bought: 'Bought',
  proof_submitted: 'Checking proof',
  verified: 'Verified',
  shipped: 'Shipped',
  delivered: 'Delivered',
  failed: 'Failed',
  refunded: 'Refunded',
};

const LEDGER_LABEL: Record<string, string> = {
  held: 'Held',
  renewed: 'Renewed',
  captured: 'Captured',
  released: 'Released',
  paid_out: 'Paid out',
  refunded: 'Refunded',
};

const dollars = (cents: number | null | undefined) => (cents === null || cents === undefined ? null : Math.round(cents) / 100);

function shopOf(id: string): Shop | undefined {
  return SEED_SHOPS.find((s) => s.id === id);
}

const shopName = (id: string) => shopOf(id)?.name ?? id;

function cityName(shopId: string): string {
  const cityId = shopOf(shopId)?.cityId;
  return SEED_CITIES.find((c) => c.id === cityId)?.name ?? cityId ?? '';
}

function itemShortName(itemId: string): string {
  for (const s of SEED_SHOPS) {
    const item = s.items.find((i) => i.id === itemId);
    if (item) return item.shortName;
  }
  return itemId;
}

/** The lowest offer at `t`, from the quotes with the shared step-down helpers. */
export function bestAskCents(book: BookSnapshot, t: MarketMs): Cents | null {
  const fees = book.asks.quotes.map((q) => askFeeAt(q, t));
  return fees.length ? Math.min(...fees) : null;
}

type Field = OpsDataset['fields'][number];
const f = (name: string, type: Field['type'], label: string): Field => ({ name, type, label });

export function opsDatasets(input: OpsViewInput, t: MarketMs, opts: OpsViewOptions = {}): Record<OpsDatasetName, OpsDataset> {
  const W = opts.words ?? PLAIN_OPS_WORDS;
  const zone = opts.timeZone ?? DEMO_TIME_ZONE;
  const clockText = (ms: MarketMs) => epochToZonedLocal(ms, zone).slice(11);
  const ds = (name: OpsDatasetName, fields: Field[], rows: OpsDataset['rows']): OpsDataset => ({ name, fields, rows, generatedAt: t });
  const bidById = new Map(input.bids.map((b) => [b.id, b]));
  const askById = new Map(input.asks.map((a) => [a.id, a]));
  const jobById = new Map(input.jobs.map((j) => [j.id, j]));

  return {
    books: ds(
      'books',
      [
        f('shopId', 'string', 'Shop id'),
        f('shop', 'string', 'Shop'),
        f('city', 'string', 'City'),
        f('item', 'string', 'Item'),
        f('bestBidUsd', 'number', W.bestBid),
        f('bestAskUsd', 'number', W.bestAsk),
        f('spreadUsd', 'number', W.spread),
        f('bidQty', 'number', `${W.bids} (units)`),
        f('bidCount', 'number', `${W.bids} (count)`),
        f('askCapacity', 'number', `${W.asks} (units)`),
        f('askCount', 'number', `${W.asks} (count)`),
        f('lastFillUsd', 'number', `Last ${W.fill}`),
        f('waitMinutes', 'number', 'Expected wait (min)'),
        f('askBy', 'string', `${W.bestAsk} from`),
        f('askNote', 'string', `${W.bestAsk} status`),
        f('nextAskUsd', 'number', `${W.bestAsk} after the next step`),
        f('nextStep', 'string', 'Next fee step'),
        f('accent', 'string', 'Accent'),
      ],
      input.books.map((b) => {
        const shop = shopOf(b.shopId);
        const ask = bestAskCents(b, t);
        const bid = b.bids.bestFeeCents;
        const quote = [...b.asks.quotes].sort((x, y) => askFeeAt(x, t) - askFeeAt(y, t))[0];
        const next = quote ? askNextDropAt(quote, t) : null;
        const note = !quote
          ? 'No offer yet'
          : quote.claimStatus === 'checked_in'
            ? quote.clock
              ? 'In line, fee clock running'
              : 'In line, fixed fee'
            : quote.clock
              ? `On the way, ETA ${clockText(quote.etaAt)}; clock starts at check-in`
              : `On the way, ETA ${clockText(quote.etaAt)}`;
        return {
          askBy: quote?.queuerName ?? null,
          askNote: note,
          nextAskUsd: next !== null && quote ? dollars(askFeeAt(quote, next)) : null,
          nextStep: next !== null ? clockText(next) : null,
          shopId: b.shopId,
          shop: shop?.name ?? b.shopId,
          city: cityName(b.shopId),
          item: itemShortName(b.itemId),
          bestBidUsd: dollars(bid),
          bestAskUsd: dollars(ask),
          spreadUsd: bid !== null && ask !== null ? dollars(ask - bid) : null,
          bidQty: b.bids.qty,
          bidCount: b.bids.count,
          askCapacity: b.asks.capacity,
          askCount: b.asks.count,
          lastFillUsd: dollars(b.lastFill?.feeCents),
          waitMinutes: b.queue.minutes,
          accent: shop?.accent ?? '#5b4cf0',
        };
      }),
    ),
    fills: ds(
      'fills',
      [
        f('matchId', 'string', 'Match id'),
        f('at', 'date', 'Time'),
        f('slot', 'string', 'Time (San Francisco)'),
        f('shopId', 'string', 'Shop id'),
        f('shop', 'string', 'Shop'),
        f('queuer', 'string', 'Queuer'),
        f('requester', 'string', 'Requester'),
        f('qty', 'number', 'Units'),
        f('feeUsd', 'number', 'Fee per unit'),
        f('valueUsd', 'number', 'Queue fees'),
        f('trigger', 'string', 'Trigger'),
      ],
      input.matches.map((m) => ({
        matchId: m.id,
        at: m.at,
        slot: clockText(Math.floor(m.at / (15 * MINUTE)) * 15 * MINUTE),
        shopId: m.shopId,
        shop: shopName(m.shopId),
        queuer: askById.get(m.askId)?.queuerName ?? '',
        requester: bidById.get(m.bidId)?.requesterName ?? '',
        qty: m.qty,
        feeUsd: dollars(m.feeCents),
        valueUsd: dollars(m.feeCents * m.qty),
        trigger: m.trigger,
      })),
    ),
    bids: ds(
      'bids',
      [
        f('bidId', 'string', 'Request id'),
        f('shopId', 'string', 'Shop id'),
        f('shop', 'string', 'Shop'),
        f('requester', 'string', 'Requester'),
        f('qty', 'number', 'Units'),
        f('remainingQty', 'number', 'Units waiting'),
        f('maxFeeUsd', 'number', 'Max fee'),
        f('limitUsd', 'number', 'Hold'),
        f('status', 'string', 'Status'),
        f('createdAt', 'date', 'Created'),
      ],
      input.bids.map((b) => ({
        bidId: b.id,
        shopId: b.shopId,
        shop: shopName(b.shopId),
        requester: b.requesterName,
        qty: b.qty,
        remainingQty: b.remainingQty,
        maxFeeUsd: dollars(b.maxFeeCents),
        limitUsd: dollars(b.limitCents),
        status: b.status,
        createdAt: b.createdAt,
      })),
    ),
    asks: ds(
      'asks',
      [
        f('askId', 'string', 'Offer id'),
        f('shopId', 'string', 'Shop id'),
        f('shop', 'string', 'Shop'),
        f('queuer', 'string', 'Queuer'),
        f('capacity', 'number', 'Units'),
        f('remainingCapacity', 'number', 'Units left'),
        f('feeNowUsd', 'number', 'Fee now'),
        f('openFeeUsd', 'number', 'Opening fee'),
        f('floorUsd', 'number', 'Floor'),
        f('status', 'string', 'Status'),
        f('etaAt', 'date', 'ETA'),
      ],
      input.asks.map((a) => ({
        askId: a.id,
        shopId: a.shopId,
        shop: shopName(a.shopId),
        queuer: a.queuerName,
        capacity: a.capacity,
        remainingCapacity: a.remainingCapacity,
        feeNowUsd: dollars(askFeeAt(a, t)),
        openFeeUsd: dollars(a.feeCents),
        floorUsd: dollars(a.clock?.floorCents ?? a.feeCents),
        status: a.status,
        etaAt: a.etaAt,
      })),
    ),
    jobs: ds(
      'jobs',
      [
        f('jobId', 'string', 'Job id'),
        f('shopId', 'string', 'Shop id'),
        f('shop', 'string', 'Shop'),
        f('queuer', 'string', 'Queuer'),
        f('requester', 'string', 'Requester'),
        f('qty', 'number', 'Units'),
        f('feeUsd', 'number', 'Fee per unit'),
        f('stage', 'string', 'Stage'),
        f('payState', 'string', 'Queuer pay'),
        f('earningsUsd', 'number', 'Queuer earnings'),
        f('capturedUsd', 'number', 'Captured'),
        f('paidOutUsd', 'number', 'Paid out'),
        f('failure', 'string', 'Failure'),
      ],
      input.jobs.map((j) => {
        const fee = j.feeCents * j.qty;
        const earnings = j.status === 'failed' ? 0 : fee - platformFeeCents(fee);
        const payState = j.status === 'failed' ? 'Nothing (job failed)' : j.amounts.paidOutCents > 0 ? 'Paid out' : 'On its way';
        return {
          jobId: j.id,
          shopId: j.shopId,
          shop: shopName(j.shopId),
          queuer: j.queuerName,
          requester: j.requesterName,
          qty: j.qty,
          feeUsd: dollars(j.feeCents),
          stage: JOB_STAGE[j.status] ?? j.status,
          payState,
          earningsUsd: dollars(earnings),
          capturedUsd: dollars(j.amounts.capturedCents),
          paidOutUsd: dollars(j.amounts.paidOutCents),
          failure: j.failure?.reason ?? null,
        };
      }),
    ),
    holds: ds(
      'holds',
      [
        f('holdId', 'string', 'Hold id'),
        f('bidId', 'string', 'Request id'),
        f('shopId', 'string', 'Shop id'),
        f('shop', 'string', 'Shop'),
        f('requester', 'string', 'Requester'),
        f('heldUsd', 'number', 'Held'),
        f('capturedUsd', 'number', 'Captured'),
        f('releasedUsd', 'number', 'Released'),
        f('openUsd', 'number', 'Still held'),
        f('status', 'string', 'Status'),
        f('funding', 'string', 'Paid with'),
        f('renewalRequired', 'boolean', 'Needs new approval'),
      ],
      input.holds.map((h) => {
        const bid = bidById.get(h.reference);
        return {
          holdId: h.id,
          bidId: h.reference,
          shopId: bid?.shopId ?? '',
          shop: bid ? shopName(bid.shopId) : '',
          requester: bid?.requesterName ?? '',
          heldUsd: dollars(h.amount.cents),
          capturedUsd: dollars(h.capturedCents),
          releasedUsd: dollars(h.releasedCents),
          openUsd: dollars(h.amount.cents - h.capturedCents - h.releasedCents),
          status: h.status,
          funding: h.fundingSource === 'venmo' ? 'Venmo' : 'PayPal',
          renewalRequired: h.renewalRequired,
        };
      }),
    ),
    ledger: ds(
      'ledger',
      [
        f('entryId', 'string', 'Entry id'),
        f('at', 'date', 'Time'),
        f('slot', 'string', 'Time (San Francisco)'),
        f('kind', 'string', 'Kind'),
        f('amountUsd', 'number', 'Amount'),
        f('status', 'string', 'Status'),
        f('who', 'string', 'Whose money'),
        f('shopId', 'string', 'Shop id'),
        f('shop', 'string', 'Shop'),
        f('text', 'string', 'What happened'),
      ],
      input.ledger
        .filter((e) => e.at <= t)
        .map((e) => {
          const bid = e.bidId ? bidById.get(e.bidId) : undefined;
          return {
            entryId: e.id,
            at: e.at,
            slot: clockText(opts.slotFloor !== undefined ? Math.max(e.at, opts.slotFloor) : e.at),
            kind: LEDGER_LABEL[e.kind] ?? e.kind,
            amountUsd: dollars(e.amount.cents),
            status: e.status,
            who: input.names[e.userId] ?? e.userId,
            shopId: bid?.shopId ?? '',
            shop: bid ? shopName(bid.shopId) : '',
            text: e.text,
          };
        }),
    ),
    payouts: ds(
      'payouts',
      [
        f('payoutId', 'string', 'Payout id'),
        f('shopId', 'string', 'Shop id'),
        f('at', 'date', 'Time'),
        f('queuer', 'string', 'Queuer'),
        f('amountUsd', 'number', 'Paid out'),
        f('platformFeeUsd', 'number', 'Platform fee'),
        f('purpose', 'string', 'For'),
        f('status', 'string', 'Status'),
      ],
      input.payouts.map((p) => ({
        payoutId: p.id,
        shopId: jobById.get(p.reference)?.shopId ?? '',
        at: p.createdAt,
        queuer: p.recipient,
        amountUsd: dollars(p.amount.cents),
        platformFeeUsd: dollars(p.platformFeeCents),
        purpose: p.purpose === 'fee' ? 'Queue fee' : p.purpose === 'reimbursement' ? 'Shop price and shipping' : 'Everything',
        status: p.status,
      })),
    ),
  };
}
