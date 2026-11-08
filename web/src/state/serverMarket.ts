import { askFeeAt, bidDisclosures, shippingNumbers } from '@holdmyspot/shared';
import type {
  AppConfig,
  BidDetail,
  BidQuote,
  BidResult,
  BookSnapshot,
  CheckoutFunding,
  ClockState,
  CreateBidResponse,
  Destination,
  EventEnvelope,
  HelloEvent,
  Item,
  LedgerEntry,
  Shop,
  User,
} from '@holdmyspot/shared';
import type { CityConfig } from '../config/cities';
import type { AppParams } from '../config/params';
import { bestOffer, holdFor, units } from '../domain/book';
import { lookOf } from '../domain/catalog';
import { reachOf, travelText } from '../domain/earning';
import { formatUsd, type Cents } from '../domain/money';
import type { FeeOffer, TaskPoint } from '../domain/types';
import { api, ApiError, eventsUrl } from '../services/api';
import { createCheckout, startBidApproval, type BidApprovalOutcome, type CheckoutService } from '../services/payments';
import { isOpenOrder, patchOrder, setOrder, useMarket, type ActivityRow, type BidChoice, type MarketDriver, type UserOrder } from './market';
import { orderOf } from './orderOf';
import { playerLngLat } from './position';
import { clock } from './services';

/**
 * The server driver (docs/WEB-INTEGRATION.md): shops and books over REST, then
 * server-sent events; the requester's own requests, holds and the real ledger;
 * requests go through the quote, the PayPal order (approved in the Simulated
 * PayPal sheet in fake mode) and the authorization. Taking a task posts an
 * offer as the queuer persona at the top request's fee.
 */

const DAY = 24 * 60 * 60_000;
const get = () => useMarket.getState();

const DEFAULT_PERSONAS: Record<string, { requester: string; queuer: string }> = {
  sf: { requester: 'mia', queuer: 'wei' },
  nyc: { requester: 'jun', queuer: 'dana' },
};

const SHIP_TO: Record<string, Destination> = {
  nyc: { mode: 'ship', country: 'US', region: 'NY', city: 'New York', postalCode: '10012' },
  sf: { mode: 'ship', country: 'US', region: 'CA', city: 'San Francisco', postalCode: '94110' },
};

let requester = 'mia';
let requesterName = 'Mia';
let queuerName = 'Wei';
/** The requester's ledger lines (held, captured, released) and the queuer's (paid out), newest first once merged. */
let requesterRows: ActivityRow[] = [];
let queuerRows: ActivityRow[] = [];
/** Catalog items by id, for the shipping budget a request adds (the server quotes the same numbers). */
const itemsById = new Map<string, Item>();
let queuer = 'wei';
let requesterUser: User | null = null;
let cityId: 'sf' | 'nyc' = 'sf';
let bootId: string | null = null;
let shops: Shop[] = [];
let approval: ((ok: boolean) => void) | null = null;
/** Sandbox mode: PayPal's own buttons (JS SDK v6). Null in fake mode, which keeps the Simulated PayPal sheet. */
let checkout: CheckoutService | null = null;
const orderTimers = new Map<string, number>();

const hhmm = (t: number, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(t);

function offerOf(q: BookSnapshot['asks']['quotes'][number], shop: Shop): FeeOffer {
  const inLine = q.claimStatus === 'checked_in';
  return {
    askId: q.askId,
    queuerName: q.queuerName,
    capacity: q.remainingCapacity,
    supply: q.remainingCapacity,
    feeCents: q.feeCents,
    clock: q.clock,
    checkedIn: inLine,
    etaAt: q.etaAt,
    modes: q.modes,
    note: inLine
      ? `${q.queuerName} is in line now and buys at the shop price.`
      : `${q.queuerName} is on the way (arriving ${hhmm(q.etaAt, shop.timezone)}).${q.clock ? ' The fee clock starts at check-in.' : ''}`,
  };
}

function pointOf(shop: Shop, item: Item, book: BookSnapshot | undefined): TaskPoint {
  const offers = (book?.asks.quotes ?? []).map((q) => offerOf(q, shop));
  return {
    id: item.id,
    cityId: shop.cityId,
    kind: item.kind,
    look: lookOf(item),
    itemName: item.name,
    itemShort: item.shortName,
    shop: { id: shop.id, name: shop.name, street: shop.street, hours: shop.hours, timezone: shop.timezone },
    retailCents: item.retailCents,
    perPersonLimit: item.perPersonLimit,
    modes: [...item.modes],
    minFeeCents: item.minFeeCents,
    tags: item.tags,
    lngLat: shop.lngLat,
    queue: book ? { minutes: book.queue.minutes, peopleAhead: book.queue.peopleAhead, queuers: book.queue.queuers } : { minutes: item.expectedWaitMinutes, peopleAhead: null, queuers: [] },
    bids: [],
    depth: book?.bids.levels ?? [],
    bidCount: book?.bids.count ?? 0,
    bidQty: book?.bids.qty ?? 0,
    bestFeeCents: book?.bids.bestFeeCents ?? null,
    latestDeadlineAt: book?.bids.latestDeadlineAt ?? null,
    offers,
    next: [],
    hue: shop.accent ?? '#5B4CF0',
    status: book?.status ?? 'open',
  };
}

function applyBook(book: BookSnapshot) {
  const shop = shops.find((s) => s.id === book.shopId);
  const item = shop?.items.find((i) => i.id === book.itemId);
  if (!shop || !item) return;
  const before = get().points.find((p) => p.id === item.id);
  const next = pointOf(shop, item, book);
  useMarket.setState((s) => ({ points: s.points.map((p) => (p.id === next.id ? next : p)) }));
  if (before && (before.bidCount !== next.bidCount || before.offers.length !== next.offers.length)) get().bump(next.id);
}

/** Requests whose "receipt checked" moment was already shown (or was past when the page loaded). */
const receiptShown = new Set<string>();

/** The order card of one of my requests (state/orderOf.ts), with the shop and item names for its sentences. */
function orderFor(d: BidDetail): UserOrder {
  const p = get().points.find((x) => x.id === d.bid.itemId);
  return orderOf(d, p ? { shopName: p.shop.name, itemShort: p.itemShort } : undefined);
}

async function refreshOrder(bidId: string) {
  try {
    const d = await api('GET /api/bids/:bidId', { bidId }, null, { as: requester });
    if (!get().points.some((p) => p.id === d.bid.itemId)) return;
    const prev = get().orders[d.bid.itemId];
    // A newer request for the same item wins over an older one.
    if (prev?.bidId && prev.bidId !== d.bid.id && prev.bidId > d.bid.id) return;
    const next = orderFor(d);
    // This screen ended that request's approval (closed window, refused order): what the server says until
    // approval-failed lands ("awaiting approval", then "failed") does not replace the words shown for it.
    if (endedHere.has(d.bid.id) && (next.status === 'approving' || next.status === 'error')) return;
    // A new request is on its way to the server (no id yet): an older, finished one does not replace it.
    if (prev && !prev.bidId && prev.status === 'approving' && isOpenOrder(next)) return;
    // The same request as on screen (its id may not be back from POST /api/bids yet).
    if (prev && (prev.bidId === d.bid.id || (!prev.bidId && prev.status === 'approving'))) {
      // A request that ended in PayPal's window keeps the words shown for it: the server only says "failed".
      if (prev.message && isOpenOrder(prev) && next.status === 'error') return;
      // "Book now" stays "now" while PayPal approves it (the server's record does not say which button).
      next.kind = prev.kind;
    }
    setOrder(next);
    const pastReceipt = next.status === 'bought' || next.status === 'filled';
    if (prev && prev.status !== next.status) {
      const p = get().points.find((x) => x.id === next.pointId);
      if (next.status === 'booked' && p) get().toast(`Matched: ${next.queuerName ?? 'a queuer'} will queue for you for a ${formatUsd(next.fillFeeCents ?? 0)} fee.`, 'money', 'requester');
      const who = next.queuerName ?? 'The queuer';
      // The receipt is the win, once per request (a shipped errand's hold stays open until tracking, D-115);
      // the last capture, which closes the hold, gets its own line.
      if (p && pastReceipt && !receiptShown.has(d.bid.id)) {
        get().celebrate(p.id);
        get().toast(`Receipt checked. ${who} bought your ${p.itemShort}.`, 'win', 'requester');
      } else if (p && next.status === 'filled') {
        const back = next.releasedCents ?? 0;
        get().toast(`${who} ${next.mode === 'ship' ? 'shipped' : 'handed over'} your ${p.itemShort}. ${back > 0 ? `${formatUsd(back, { exact: true })} of your hold went back to you.` : 'Nothing more is held.'}`, 'money', 'requester');
      }
    }
    if (pastReceipt) receiptShown.add(d.bid.id);
  } catch {
    /* The next event or reload brings it back. */
  }
}

/** Wei's phone beside Mia's on the judge's page follows only his own person: requests are Mia's to read (D-163). */
let followsRequests = true;

function scheduleRefresh(bidId: string) {
  if (!followsRequests) return;
  window.clearTimeout(orderTimers.get(bidId));
  orderTimers.set(bidId, window.setTimeout(() => void refreshOrder(bidId), 250));
}

function rowOf(e: LedgerEntry, who: string): ActivityRow {
  return { id: e.id, kind: e.kind, amountCents: e.amount.cents, text: e.text, at: e.at, status: e.status, bidId: e.bidId, holdId: e.holdId, who };
}

/** Still held on the requester's PayPal: per request, held minus captured and released. */
function heldOf(rows: ActivityRow[]): Cents {
  const by = new Map<string, number>();
  for (const r of rows) {
    if (r.status !== 'succeeded' || !r.bidId) continue;
    const sign = r.kind === 'held' ? 1 : r.kind === 'captured' || r.kind === 'released' ? -1 : 0;
    by.set(r.bidId, (by.get(r.bidId) ?? 0) + sign * r.amountCents);
  }
  let total = 0;
  for (const v of by.values()) total += Math.max(0, v);
  return total;
}

/** Keeps the latest record per id (a pending line turns succeeded or failed later). */
function upsert(rows: ActivityRow[], row: ActivityRow): ActivityRow[] {
  return [...rows.filter((r) => r.id !== row.id), row];
}

/** One money list for the page: the requester's lines and the queuer's payouts, newest first. */
function publishActivity() {
  const sorted = [...requesterRows, ...queuerRows].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
  const paidOut = queuerRows.filter((r) => r.kind === 'paid_out' && r.status === 'succeeded').reduce((sum, r) => sum + r.amountCents, 0);
  let charged = 0;
  for (const r of requesterRows) {
    if (r.status !== 'succeeded') continue;
    if (r.kind === 'captured') charged += r.amountCents;
    else if (r.kind === 'refunded') charged -= r.amountCents;
  }
  useMarket.setState({ activity: sorted, heldCents: heldOf(requesterRows), paidOutCents: paidOut, chargedCents: Math.max(0, charged) });
}

async function loadAll() {
  const [{ shops: s }, { books }] = await Promise.all([api('GET /api/shops', {}, null, { query: { cityId } }), api('GET /api/books', {}, null, { query: { cityId } })]);
  shops = s;
  const points = shops.flatMap((shop) => shop.items.map((item) => pointOf(shop, item, books.find((b) => b.itemId === item.id))));
  itemsById.clear();
  for (const shop of shops) for (const item of shop.items) itemsById.set(item.id, item);
  useMarket.setState({ points, walkers: {} });
  const [{ entries }, { bids }, payouts] = await Promise.all([
    api('GET /api/ledger', {}, null, { as: requester, query: { mine: '1' } }),
    api('GET /api/bids', {}, null, { as: requester, query: { mine: '1' } }),
    queuer === requester ? Promise.resolve({ entries: [] as LedgerEntry[] }) : api('GET /api/ledger', {}, null, { as: queuer, query: { mine: '1' } }),
  ]);
  requesterRows = entries.map((e) => rowOf(e, requesterName));
  queuerRows = payouts.entries.map((e) => rowOf(e, queuerName));
  publishActivity();
  useMarket.setState({ orders: {} });
  receiptShown.clear();
  const mine = bids.filter((b) => points.some((p) => p.id === b.itemId)).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const b of mine) await refreshOrder(b.id);
}

/**
 * Every record event of the two persona streams, for screens that follow more
 * than the map: the queuer's errand (web/src/ui/queuer) reads its claims, jobs,
 * proofs and payouts from here instead of opening more streams.
 */
export type StreamEvent = { who: 'requester' | 'queuer'; type: string; data: unknown };
const streamListeners = new Set<(e: StreamEvent) => void>();
const FORWARDED = ['hello', 'resync', 'claim.updated', 'ask.updated', 'match.created', 'job.updated', 'proof.updated', 'payout.updated', 'ledger.appended'];

export function onStreamEvent(fn: (e: StreamEvent) => void): () => void {
  streamListeners.add(fn);
  return () => void streamListeners.delete(fn);
}

function forward(es: EventSource, who: StreamEvent['who']) {
  for (const type of FORWARDED) {
    es.addEventListener(type, (ev) => {
      let data: unknown;
      try {
        data = (JSON.parse((ev as MessageEvent).data) as EventEnvelope).data;
      } catch {
        return;
      }
      for (const fn of streamListeners) fn({ who, type, data });
    });
  }
}

function listen() {
  const es = new EventSource(eventsUrl(requester));
  forward(es, 'requester');
  if (queuer === requester) forward(es, 'queuer');
  const on = (type: string, fn: (data: never) => void) =>
    es.addEventListener(type, (e) => {
      try {
        fn((JSON.parse((e as MessageEvent).data) as EventEnvelope).data as never);
      } catch {
        /* A malformed event is skipped; the next one carries the full record. */
      }
    });
  on('hello', (h: HelloEvent) => {
    clock.follow(h.clock);
    if (bootId !== null && h.bootId !== bootId) void loadAll();
    bootId = h.bootId;
  });
  on('resync', () => void loadAll());
  on('clock.updated', (c: ClockState) => clock.follow(c));
  on('book.updated', (b: BookSnapshot) => applyBook(b));
  on('match.created', (m: { itemId: string }) => get().bump(m.itemId));
  on('bid.updated', (b: { id: string }) => scheduleRefresh(b.id));
  on('hold.updated', (h: { reference: string }) => scheduleRefresh(h.reference));
  on('job.updated', (j: { bidId: string }) => scheduleRefresh(j.bidId));
  on('ledger.appended', (e: LedgerEntry) => {
    requesterRows = upsert(requesterRows, rowOf(e, requesterName));
    publishActivity();
    if (e.bidId) scheduleRefresh(e.bidId);
  });
  on('queuer.moved', (m: { userId: string; lngLat: [number, number] }) => {
    useMarket.setState((st) => ({ walkers: { ...st.walkers, [m.userId]: { lngLat: m.lngLat, at: Date.now() } } }));
  });
  on('demo.cue', (c: { text: string }) => {
    if (c.text) get().toast(c.text, 'info');
  });
  // The queuer persona's own stream carries their payouts (each ledger line goes only to its owner).
  if (queuer !== requester) {
    const qs = new EventSource(eventsUrl(queuer));
    forward(qs, 'queuer');
    qs.addEventListener('ledger.appended', (ev) => {
      try {
        const e = (JSON.parse((ev as MessageEvent).data) as EventEnvelope).data as LedgerEntry;
        queuerRows = upsert(queuerRows, rowOf(e, queuerName));
        publishActivity();
      } catch {
        /* The next event or reload brings it back. */
      }
    });
  }
}

function destinationFor(p: TaskPoint): Destination | null {
  const home = requesterUser?.cityId ?? 'nyc';
  if (p.modes.includes('local') && home === p.cityId) return { mode: 'local', cityId: home };
  if (p.modes.includes('ship')) return SHIP_TO[home] ?? SHIP_TO.nyc;
  return null;
}

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

async function holdAndAsk(pointId: string, maxFeeCents: Cents, kind: 'now' | 'max', agent = false) {
  const p = get().points.find((x) => x.id === pointId);
  if (!p || !isOpenOrder(get().orders[pointId])) return;
  const destination = destinationFor(p);
  if (!destination) {
    get().toast(`${p.itemShort} is a local errand: only for requesters in ${p.cityId === 'sf' ? 'San Francisco' : 'New York'}.`, 'info', 'requester');
    return;
  }
  setOrder({ pointId, kind, status: 'approving', mode: destination.mode, maxFeeCents, holdCents: holdFor(p, maxFeeCents, 1, get().shippingFor(pointId)) });
  try {
    const created = await createRequest(p, destination, maxFeeCents, 'paypal', agent);
    if (created.checkout.next !== 'fake_approve') {
      patchOrder(pointId, { status: 'error', message: 'This server runs the PayPal sandbox now: reload the page to get PayPal’s own buttons.' });
      return;
    }
    const what = destination.mode === 'ship' ? `${units(p.kind, 1)} shipped to you` : units(p.kind, 1);
    const b = created.bid;
    useMarket.setState({
      checkout: {
        pointId,
        amountCents: b.limitCents,
        description: `${what} from ${p.shop.name}: the shop price at cost, a queue fee of up to ${formatUsd(maxFeeCents)}${destination.mode === 'ship' ? ', shipping up to your budget' : ''} and processing at cost`,
        disclosures: bidDisclosures({ qty: b.qty, retailCapCents: b.retailCapCents, maxFeeCents: b.maxFeeCents, shippingBudgetCents: b.shippingBudgetCents, mode: destination.mode }),
      },
    });
    const ok = await new Promise<boolean>((resolve) => {
      approval = resolve;
    });
    useMarket.setState({ checkout: null });
    if (!ok) {
      await api('POST /api/bids/:bidId/approval-failed', { bidId: created.bid.id }, { reason: 'cancelled', detail: null }, { as: requester });
      patchOrder(pointId, { status: 'released', releasedCents: 0, message: 'You cancelled in the PayPal sheet. Nothing was held.' });
      return;
    }
    await api('POST /api/fake/paypal/orders/:orderId/approve', { orderId: created.checkout.orderId }, { funding: 'paypal', outcome: 'approve' });
    const result = await authorizeRequest(created.bid.id, created.checkout.orderId);
    get().toast(heldText(result, maxFeeCents), 'money', 'requester');
    await refreshOrder(created.bid.id);
  } catch (err) {
    useMarket.setState({ checkout: null });
    patchOrder(pointId, { status: 'error', message: message(err) });
    get().toast(message(err), 'info', 'requester');
  }
}

/** What the phone tells the bidding agent when the requester turns it on (D-158). */
const AGENT_GOAL = 'As cheap as possible, never above my max fee.';

/** Quote, then create the request: the server creates the PayPal order (intent AUTHORIZE) for its whole limit. */
async function createRequest(p: TaskPoint, destination: Destination, maxFeeCents: Cents, funding: CheckoutFunding, agent: boolean, live: () => boolean = () => true): Promise<CreateBidResponse> {
  // Sandbox: the quote was asked for when the sheet opened (its live estimates take seconds while PayPal's window waits).
  const quote = await (checkout ? quoteFor(p, destination) : api('POST /api/bids/quote', {}, { shopId: p.shop.id, itemId: p.id, qty: 1, destination }, { as: requester }));
  const created = await api(
    'POST /api/bids',
    {},
    {
      shopId: p.shop.id,
      itemId: p.id,
      qty: 1,
      retailCapCents: quote.suggested.retailCapCents,
      maxFeeCents,
      shippingBudgetCents: destination.mode === 'ship' ? quote.suggested.shippingBudgetCents : 0,
      destination,
      deadlineAt: clock.now() + 2 * DAY,
      funding,
      agent: agent ? { goal: AGENT_GOAL } : null,
    },
    { as: requester, idempotencyKey: crypto.randomUUID() },
  );
  if (live()) patchOrder(p.id, { bidId: created.bid.id, holdCents: created.bid.limitCents, holdId: created.hold.id });
  return created;
}

/** Sandbox: quotes asked for ahead of the click, by point (the shop price cap and the shipping budget). */
const quotes = new Map<string, { key: string; at: number; quote: Promise<BidQuote> }>();
const QUOTE_TTL_MS = 10 * 60_000;

function quoteFor(p: TaskPoint, destination: Destination): Promise<BidQuote> {
  const key = JSON.stringify(destination);
  const hit = quotes.get(p.id);
  if (hit && hit.key === key && Date.now() - hit.at < QUOTE_TTL_MS) return hit.quote;
  const quote = api('POST /api/bids/quote', {}, { shopId: p.shop.id, itemId: p.id, qty: 1, destination }, { as: requester });
  quotes.set(p.id, { key, at: Date.now(), quote });
  quote.catch(() => {
    if (quotes.get(p.id)?.quote === quote) quotes.delete(p.id);
  });
  return quote;
}

/** Sandbox: a sheet opened, so its quote starts now and PayPal's window does not wait for it after the click. */
function primeQuote(pointId: string | null) {
  const p = pointId ? get().points.find((x) => x.id === pointId) : undefined;
  const destination = p ? destinationFor(p) : null;
  if (!checkout || !p || !destination) return;
  quoteFor(p, destination).catch(() => undefined);
}

/** The buyer approved: the hold exists once this answers, and matching has run. */
function authorizeRequest(bidId: string, orderId: string): Promise<BidResult> {
  return api('POST /api/bids/:bidId/authorize', { bidId }, { orderId }, { as: requester, idempotencyKey: `auth-${bidId}` });
}

function heldText(result: BidResult, maxFeeCents: Cents): string {
  const held = formatUsd(result.hold.amount.cents, { exact: true });
  return result.matches.length > 0 ? `${held} held. Matched at once.` : `${held} held. A queuer takes it when an offer reaches your ${formatUsd(maxFeeCents)} fee.`;
}

// ---- sandbox: PayPal's own buttons (JS SDK v6) -------------------------------------------------

/** Points whose request waits in PayPal's window right now. */
const inPayPal = new Set<string>();
/**
 * Requests whose approval ended on this screen (closed window, refused order). The server
 * still says "awaiting approval" until approval-failed lands, then only "failed": neither
 * replaces the words already shown.
 */
const endedHere = new Set<string>();
/** Points where the buyer pressed Stop while PayPal's window was open. */
const stoppedHere = new Set<string>();
const STOPPED_TEXT = 'You stopped waiting for PayPal. Nothing was held.';

function loadPayPal() {
  const c = checkout;
  if (!c) return;
  useMarket.setState({ paypalButtons: { status: 'loading', buttons: [], message: null } });
  c.prepare().then(
    (buttons) =>
      useMarket.setState({
        paypalButtons:
          buttons.length > 0
            ? { status: 'ready', buttons, message: null }
            : { status: 'failed', buttons: [], message: 'PayPal offers no button for this account and browser right now.' },
      }),
    (err: unknown) => useMarket.setState({ paypalButtons: { status: 'failed', buttons: [], message: message(err) } }),
  );
}

/**
 * A click on one of PayPal's own buttons. Everything up to checkout.start runs inside that
 * click, so PayPal's window may open; the request is created while the window loads.
 */
function payWithPayPal(pointId: string, choice: BidChoice, funding: CheckoutFunding) {
  const p = get().points.find((x) => x.id === pointId);
  if (!p || !checkout || !isOpenOrder(get().orders[pointId])) return;
  if (checkout.busy()) {
    get().toast('PayPal’s window is already open for another request. Finish or close it first.', 'info', 'requester');
    return;
  }
  const destination = destinationFor(p);
  if (!destination) {
    get().toast(`${p.itemShort} is a local errand: only for requesters in ${p.cityId === 'sf' ? 'San Francisco' : 'New York'}.`, 'info', 'requester');
    return;
  }
  let maxFeeCents: Cents;
  if (choice.kind === 'now') {
    const offer = bestOffer(p, clock.now());
    if (!offer) return;
    maxFeeCents = askFeeAt(offer, clock.now());
  } else maxFeeCents = choice.maxFeeCents;
  setOrder({ pointId, kind: choice.kind, status: 'approving', mode: destination.mode, maxFeeCents, holdCents: holdFor(p, maxFeeCents, 1, get().shippingFor(pointId)) });
  inPayPal.add(pointId);
  let over = false; // this attempt's outcome is on screen
  let bidId: string | null = null;
  startBidApproval(
    checkout,
    funding,
    {
      async createBid(f) {
        const created = await createRequest(p, destination, maxFeeCents, f, choice.kind === 'max' && choice.agent === true, () => !over);
        bidId = created.bid.id;
        if (over) endedHere.add(bidId); // closed before the server answered: the screen keeps its words
        if (created.checkout.next !== 'js_sdk') {
          await api('POST /api/bids/:bidId/approval-failed', { bidId: created.bid.id }, { reason: 'error', detail: 'not a sandbox order' }, { as: requester }).catch(() => undefined);
          throw new Error('This server is not in PayPal sandbox mode any more. Reload the page.');
        }
        return { bidId: created.bid.id, orderId: created.checkout.orderId };
      },
      authorize: authorizeRequest,
      async approvalFailed(id, reason, detail) {
        await api('POST /api/bids/:bidId/approval-failed', { bidId: id }, { reason, detail }, { as: requester });
      },
      recheck(id) {
        endedHere.delete(id);
        void refreshOrder(id);
      },
    },
    (out) => {
      over = true;
      inPayPal.delete(pointId);
      if (bidId && (out.kind === 'cancelled' || out.kind === 'failed')) endedHere.add(bidId);
      endApproval(pointId, maxFeeCents, out);
    },
  );
}

function endApproval(pointId: string, maxFeeCents: Cents, out: BidApprovalOutcome) {
  const stopped = stoppedHere.delete(pointId);
  switch (out.kind) {
    case 'held': {
      // Shown at once; the server's full record (with the queuer's name) follows.
      const fill = out.result.matches[0];
      patchOrder(pointId, {
        status: fill ? 'booked' : 'resting',
        bidId: out.bidId,
        holdId: out.result.hold.id,
        holdCents: out.result.hold.amount.cents,
        fillFeeCents: fill?.feeCents,
        message: undefined,
      });
      get().toast(heldText(out.result, maxFeeCents), 'money', 'requester');
      void refreshOrder(out.bidId);
      return;
    }
    case 'cancelled':
      patchOrder(pointId, { status: 'released', releasedCents: 0, message: stopped ? STOPPED_TEXT : out.message });
      return;
    case 'failed':
      patchOrder(pointId, { status: 'error', message: out.message });
      get().toast(out.message, 'info', 'requester');
      return;
    case 'check':
      patchOrder(pointId, { status: 'error', message: out.message });
      get().toast(out.message, 'info', 'requester');
      void refreshOrder(out.bidId);
  }
}

/** Stop waiting: PayPal's window closes; with no window (a reload), the server ends the request. */
function cancelApproval(pointId: string) {
  const order = get().orders[pointId];
  if (!order || order.status !== 'approving') return;
  if (inPayPal.has(pointId) && checkout?.busy()) {
    stoppedHere.add(pointId);
    checkout.cancel();
    return;
  }
  inPayPal.delete(pointId);
  const bidId = order.bidId;
  if (!bidId) {
    patchOrder(pointId, { status: 'released', releasedCents: 0, message: STOPPED_TEXT });
    return;
  }
  api('POST /api/bids/:bidId/approval-failed', { bidId }, { reason: 'cancelled', detail: 'stopped waiting in the app' }, { as: requester }).then(
    () => {
      endedHere.add(bidId);
      patchOrder(pointId, { status: 'released', releasedCents: 0, message: STOPPED_TEXT });
    },
    (err: unknown) => {
      patchOrder(pointId, { status: 'error', message: `${message(err)} Showing the request as the server has it.` });
      void refreshOrder(bidId);
    },
  );
}

const driver: MarketDriver = {
  shippingFor(pointId) {
    const p = get().points.find((x) => x.id === pointId);
    const item = itemsById.get(pointId);
    if (!p || !item || destinationFor(p)?.mode !== 'ship') return 0;
    return shippingNumbers(item, 1).budgetCents;
  },
  async requestNow(pointId) {
    const p = get().points.find((x) => x.id === pointId);
    const offer = p ? bestOffer(p, clock.now()) : null;
    if (!offer) return;
    await holdAndAsk(pointId, askFeeAt(offer, clock.now()), 'now');
  },
  async setMax(pointId, maxFeeCents, agent) {
    await holdAndAsk(pointId, maxFeeCents, 'max', agent === true);
  },
  async cancelMax(pointId) {
    const order = get().orders[pointId];
    if (!order?.bidId || order.status !== 'resting') return;
    patchOrder(pointId, { status: 'releasing' });
    try {
      const out = await api('POST /api/bids/:bidId/cancel', { bidId: order.bidId }, { reason: 'cancelled in the app' }, { as: requester, idempotencyKey: `cancel-${order.bidId}` });
      patchOrder(pointId, { status: 'released', releasedCents: out.hold.releasedCents });
    } catch (err) {
      patchOrder(pointId, { status: 'error', message: message(err) });
    }
  },
  async take(pointId) {
    const p = get().points.find((x) => x.id === pointId);
    if (!p || p.bestFeeCents === null) return;
    const from = playerLngLat();
    // The ETA is the trip the sheet shows (walk or transit) plus a minute to find the line, so the
    // arrival window (ETA plus the grace minutes) always covers it.
    const reach = reachOf(p, from, clock.now());
    useMarket.setState((s) => ({ taken: { ...s.taken, [pointId]: { pointId, feeCents: p.bestFeeCents!, status: 'posting', at: clock.now() } } }));
    try {
      const out = await api(
        'POST /api/asks',
        {},
        { shopId: p.shop.id, itemId: p.id, capacity: 1, modes: [...p.modes], feeCents: p.bestFeeCents, clock: null, etaAt: reach.arriveAt, from: { lngLat: from, accuracyM: 15 } },
        { as: queuer, idempotencyKey: crypto.randomUUID() },
      );
      useMarket.setState((s) => ({ taken: { ...s.taken, [pointId]: { pointId, feeCents: p.bestFeeCents!, status: 'taken', at: clock.now(), windowEndsAt: out.claim.windowEndsAt } } }));
      const trip = `${travelText(reach)} there`;
      get().toast(
        out.matches.length > 0
          ? `You took a request at ${formatUsd(out.matches[0]!.feeCents)}. ${trip}: check in before ${hhmm(out.claim.windowEndsAt, p.shop.timezone)}.`
          : `Your offer is up at ${formatUsd(p.bestFeeCents)}. ${trip}: check in before ${hhmm(out.claim.windowEndsAt, p.shop.timezone)}.`,
        'money',
        'queuer',
      );
    } catch (err) {
      useMarket.setState((s) => ({ taken: { ...s.taken, [pointId]: { pointId, feeCents: p.bestFeeCents!, status: 'error', at: clock.now(), message: message(err) } } }));
      get().toast(message(err), 'info', 'queuer');
    }
  },
  approve(ok) {
    const done = approval;
    approval = null;
    done?.(ok);
  },
  payWith: payWithPayPal,
  cancelApproval,
  loadPayPal,
};

/** Connects to the server, loads the city, then follows its events. Throws when the server cannot be used. */
export async function bootServerMarket(city: CityConfig, params: AppParams): Promise<void> {
  if (city.id === 'taipei') throw new Error('Taipei is a map-only option.');
  cityId = city.id;
  const defaults = DEFAULT_PERSONAS[city.id];
  requester = params.as ?? defaults.requester;
  followsRequests = !(params.solo && new URLSearchParams(window.location.search).get('phone') === 'queuer');
  queuer = params.queuer ?? defaults.queuer;
  const config: AppConfig = await api('GET /api/config', {}, null);
  clock.follow(config.clock);
  // Sandbox: PayPal's script starts loading now, so its buttons are ready when a sheet opens.
  checkout = createCheckout(config.mode, config.paypal);
  if (checkout) {
    loadPayPal();
    // The quote of a sheet's item starts when the sheet opens (see primeQuote).
    useMarket.subscribe((s, before) => {
      if (s.selectedId !== before.selectedId) primeQuote(s.selectedId);
    });
  } else if (config.mode === 'sandbox') {
    useMarket.setState({ paypalButtons: { status: 'failed', buttons: [], message: 'This server runs the PayPal sandbox but sent no client id, so PayPal’s buttons cannot load.' } });
  }
  const [r, q] = await Promise.all([api('GET /api/me', {}, null, { as: requester }), api('GET /api/me', {}, null, { as: queuer })]);
  requesterUser = r.user;
  requesterName = r.user.displayName;
  queuerName = q.user.displayName;
  useMarket.setState({
    backend: 'server',
    serverMode: config.mode,
    // No live model in fake mode: the phone offers a simulated reading for photos with no recording (D-128).
    simulatedReadings: config.mode === 'fake' && config.ai.mode !== 'live' && config.ai.mode !== 'record',
    driver,
    persona: { requesterId: r.user.id, requesterName: r.user.displayName, requesterCity: r.user.cityId === 'sf' ? 'San Francisco' : 'New York', queuerId: q.user.id, queuerName: q.user.displayName },
  });
  await loadAll();
  listen();
}
