import { askFeeAt, bidDisclosures, shippingNumbers } from '@holdmyspot/shared';
import type { AppConfig, BidDetail, BookSnapshot, ClockState, Destination, EventEnvelope, HelloEvent, Item, LedgerEntry, Shop, User } from '@holdmyspot/shared';
import type { CityConfig } from '../config/cities';
import type { AppParams } from '../config/params';
import { bestOffer, holdFor, units } from '../domain/book';
import { lookOf } from '../domain/catalog';
import { reachOf, travelText } from '../domain/earning';
import { formatUsd, type Cents } from '../domain/money';
import type { FeeOffer, TaskPoint } from '../domain/types';
import { api, ApiError, eventsUrl } from '../services/api';
import { isOpenOrder, patchOrder, setOrder, useMarket, type ActivityRow, type MarketDriver, type OrderStatus, type UserOrder } from './market';
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

/** The order card of one of my requests, from the bid, its hold and its jobs. */
function orderOf(d: BidDetail): UserOrder {
  const { bid, hold } = d;
  const job = d.jobs.find((j) => j.status !== 'failed') ?? d.jobs.at(-1) ?? null;
  const done = d.jobs.some((j) => ['verified', 'shipped', 'delivered'].includes(j.status));
  const settling = d.jobs.some((j) => j.status === 'proof_submitted') || d.ledger.some((e) => e.status === 'pending');
  let status: OrderStatus;
  if (bid.status === 'awaiting_approval') status = 'approving';
  else if (bid.status === 'failed') status = 'error';
  else if (bid.status === 'cancelled' || bid.status === 'expired') status = bid.closeReason === 'sold_out' ? 'missed' : 'released';
  else if (done && (bid.status === 'settled' || bid.status === 'matched' || bid.status === 'closing')) status = 'filled';
  else if (settling) status = 'settling';
  else if (job && !['failed', 'refunded'].includes(job.status)) status = 'booked';
  else status = 'resting';
  return {
    pointId: bid.itemId,
    kind: 'max',
    status,
    mode: bid.destination.mode,
    maxFeeCents: bid.maxFeeCents,
    holdId: hold?.id,
    holdCents: hold?.amount.cents ?? bid.limitCents,
    bidId: bid.id,
    fillFeeCents: job?.feeCents,
    queuerName: job?.queuerName,
    chargedCents: hold?.capturedCents,
    releasedCents: hold?.releasedCents,
  };
}

async function refreshOrder(bidId: string) {
  try {
    const d = await api('GET /api/bids/:bidId', { bidId }, null, { as: requester });
    if (!get().points.some((p) => p.id === d.bid.itemId)) return;
    const prev = get().orders[d.bid.itemId];
    // A newer request for the same item wins over an older one.
    if (prev?.bidId && prev.bidId !== d.bid.id && prev.bidId > d.bid.id) return;
    const next = orderOf(d);
    setOrder(next);
    if (prev && prev.status !== next.status) {
      const p = get().points.find((x) => x.id === next.pointId);
      if (next.status === 'booked' && p) get().toast(`Matched: ${next.queuerName ?? 'a queuer'} will queue for you for a ${formatUsd(next.fillFeeCents ?? 0)} fee.`, 'money');
      if (next.status === 'filled' && p) {
        get().celebrate(p.id);
        get().toast(`Receipt checked. ${next.queuerName ?? 'The queuer'} bought your ${p.itemShort}.`, 'win');
      }
    }
  } catch {
    /* The next event or reload brings it back. */
  }
}

function scheduleRefresh(bidId: string) {
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
  useMarket.setState({ activity: sorted, heldCents: heldOf(requesterRows), paidOutCents: paidOut });
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
  const mine = bids.filter((b) => points.some((p) => p.id === b.itemId)).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const b of mine) await refreshOrder(b.id);
}

function listen() {
  const es = new EventSource(eventsUrl(requester));
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

async function holdAndAsk(pointId: string, maxFeeCents: Cents, kind: 'now' | 'max') {
  const p = get().points.find((x) => x.id === pointId);
  if (!p || !isOpenOrder(get().orders[pointId])) return;
  const destination = destinationFor(p);
  if (!destination) {
    get().toast(`${p.itemShort} is a local errand: only for requesters in ${p.cityId === 'sf' ? 'San Francisco' : 'New York'}.`, 'info');
    return;
  }
  setOrder({ pointId, kind, status: 'approving', mode: destination.mode, maxFeeCents, holdCents: holdFor(p, maxFeeCents, 1, get().shippingFor(pointId)) });
  try {
    const quote = await api('POST /api/bids/quote', {}, { shopId: p.shop.id, itemId: p.id, qty: 1, destination }, { as: requester });
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
        funding: 'paypal',
        agent: null,
      },
      { as: requester, idempotencyKey: crypto.randomUUID() },
    );
    patchOrder(pointId, { bidId: created.bid.id, holdCents: created.bid.limitCents, holdId: created.hold.id });
    if (created.checkout.next !== 'fake_approve') {
      patchOrder(pointId, { status: 'error', message: 'This server runs the PayPal sandbox: approve the hold with PayPal’s own buttons (not wired in this build).' });
      return;
    }
    const what = destination.mode === 'ship' ? `${units(p.kind, 1)} shipped to you` : units(p.kind, 1);
    const b = created.bid;
    useMarket.setState({
      checkout: {
        pointId,
        amountCents: b.limitCents,
        description: `${what} from ${p.shop.name}: the shop price at cost, a queue fee of up to ${formatUsd(maxFeeCents)}${destination.mode === 'ship' ? ' and shipping at cost' : ''}`,
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
    const result = await api('POST /api/bids/:bidId/authorize', { bidId: created.bid.id }, { orderId: created.checkout.orderId }, { as: requester, idempotencyKey: `auth-${created.bid.id}` });
    get().toast(
      result.matches.length > 0
        ? `${formatUsd(result.hold.amount.cents, { exact: true })} held. Matched at once.`
        : `${formatUsd(result.hold.amount.cents, { exact: true })} held. A queuer takes it when an offer reaches your ${formatUsd(maxFeeCents)} fee.`,
      'money',
    );
    await refreshOrder(created.bid.id);
  } catch (err) {
    useMarket.setState({ checkout: null });
    patchOrder(pointId, { status: 'error', message: message(err) });
    get().toast(message(err), 'info');
  }
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
  async setMax(pointId, maxFeeCents) {
    await holdAndAsk(pointId, maxFeeCents, 'max');
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
      );
    } catch (err) {
      useMarket.setState((s) => ({ taken: { ...s.taken, [pointId]: { pointId, feeCents: p.bestFeeCents!, status: 'error', at: clock.now(), message: message(err) } } }));
      get().toast(message(err), 'info');
    }
  },
  approve(ok) {
    const done = approval;
    approval = null;
    done?.(ok);
  },
};

/** Connects to the server, loads the city, then follows its events. Throws when the server cannot be used. */
export async function bootServerMarket(city: CityConfig, params: AppParams): Promise<void> {
  if (city.id === 'taipei') throw new Error('Taipei is a map-only option.');
  cityId = city.id;
  const defaults = DEFAULT_PERSONAS[city.id];
  requester = params.as ?? defaults.requester;
  queuer = params.queuer ?? defaults.queuer;
  const config: AppConfig = await api('GET /api/config', {}, null);
  clock.follow(config.clock);
  const [r, q] = await Promise.all([api('GET /api/me', {}, null, { as: requester }), api('GET /api/me', {}, null, { as: queuer })]);
  requesterUser = r.user;
  requesterName = r.user.displayName;
  queuerName = q.user.displayName;
  useMarket.setState({
    backend: 'server',
    serverMode: config.mode,
    driver,
    persona: { requesterId: r.user.id, requesterName: r.user.displayName, requesterCity: r.user.cityId === 'sf' ? 'San Francisco' : 'New York', queuerId: q.user.id, queuerName: q.user.displayName },
  });
  await loadAll();
  listen();
}
