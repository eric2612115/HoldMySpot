import type { CityConfig } from '../config/cities';
import { bestOffer, holdFor, matchPoint, offerFeeAt, units, withBookSummary } from '../domain/book';
import { buildCatalog, randomBidder, seeded } from '../domain/catalog';
import { formatUsd, usd, type Cents } from '../domain/money';
import type { Bid, FeeOffer, TaskPoint } from '../domain/types';
import type { Activity } from '../services/payments';
import { isOpenOrder, patchOrder, patchPoint, setOrder, useMarket, type ActivityRow, type MarketDriver, type UserOrder } from './market';
import { clock, payments } from './services';

/**
 * The in-browser market: the seed catalog with demo books, a crowd that keeps
 * asking, queuers who check in (their fee clocks start then), the shared
 * matching engine, and the payments mock behind the same words as PayPal
 * (held, captured, released, paid out). Used when the server is not running.
 */

const MIN = 60_000;
/** Crowd requests kept per point, so a long demo keeps a readable book. */
const MAX_BOOK = 24;
const rnd = seeded(20261107);
let bidSeq = 0;

const get = () => useMarket.getState();
const point = (id: string) => get().points.find((p) => p.id === id);

function toRows(activity: Activity[]): ActivityRow[] {
  return activity.map((a) => ({ id: a.id, kind: a.kind, amountCents: a.amount.cents, text: a.text, at: a.at, status: 'succeeded', holdId: a.holdId ?? null }));
}

function syncMoney() {
  const held = payments
    .holds()
    .filter((h) => h.status === 'held' || h.status === 'partially_captured')
    .reduce((sum, h) => sum + h.amount.cents - h.capturedCents - h.releasedCents, 0);
  useMarket.setState({ activity: toRows(payments.activity()), heldCents: held });
}

function describe(p: TaskPoint, queuer: string): string {
  return `the ${p.itemShort} (${formatUsd(p.retailCents)} at the shop) and ${queuer}'s queue fee`;
}

function fail(pointId: string, err: unknown) {
  const message = err instanceof Error ? err.message : 'Something went wrong with the payment.';
  patchOrder(pointId, { status: 'error', message });
  get().toast(message, 'info');
}

/** The receipt is in: capture the shop price plus the matched fee, release the rest, pay the queuer. */
async function settle(p: TaskPoint, order: UserOrder) {
  if (!order.holdId || order.holdCents === undefined || order.fillFeeCents === undefined) return;
  const queuer = order.queuerName ?? 'The queuer';
  const charged = p.retailCents + order.fillFeeCents;
  patchOrder(p.id, { status: 'settling' });
  await payments.capture(order.holdId, charged, {
    description: `${p.itemShort}: ${formatUsd(p.retailCents, { exact: true })} from the receipt plus a ${formatUsd(order.fillFeeCents, { exact: true })} fee`,
    final: true,
  });
  patchOrder(p.id, { status: 'filled', chargedCents: charged, releasedCents: order.holdCents - charged });
  get().celebrate(p.id);
  get().toast(`Receipt checked. ${queuer} bought your ${p.itemShort}.`, 'win');
  const platform = Math.floor(order.fillFeeCents / 10);
  await payments.payout({ recipient: queuer, amountCents: charged - platform, note: `${p.itemShort} and the queue fee`, reference: p.id });
}

/** A used-up offer hands over to the next queuer, who checks in and opens a fresh offer. */
function reopen(p: TaskPoint, used: FeeOffer, now: number) {
  const [next, ...rest] = p.next;
  if (!next) return;
  const offer: FeeOffer = {
    ...next,
    askId: `${p.id}-ask-${next.queuerName.toLowerCase()}-${now}`,
    supply: next.capacity,
    checkedIn: true,
    etaAt: now,
    clock: next.clock ? { ...next.clock, startsAt: now } : null,
  };
  patchPoint(p.id, (q) => ({
    ...q,
    offers: [...q.offers.filter((o) => o.askId !== used.askId), offer],
    next: [...rest, { queuerName: used.queuerName, capacity: used.capacity, feeCents: used.feeCents, clock: used.clock, modes: used.modes, note: used.note }],
    queue: { ...q.queue, queuers: [...new Set([...q.queue.queuers.filter((n) => n !== used.queuerName), offer.queuerName])] },
  }));
  if (get().selectedId === p.id) get().toast(`${used.queuerName} is fully booked. ${offer.queuerName} takes over at a ${formatUsd(offer.feeCents)} fee.`, 'info');
}

/** Runs a few times a second: check-ins, matching, receipts. */
function tick() {
  const now = clock.now();
  for (const { id } of get().points) {
    let p = point(id)!;
    // Queuers on the way check in at their ETA; a fee clock starts only then.
    for (const o of p.offers) {
      if (o.checkedIn || o.etaAt > now) continue;
      patchPoint(id, (q) => ({
        ...q,
        offers: q.offers.map((x) => (x.askId === o.askId ? { ...x, checkedIn: true, clock: x.clock ? { ...x.clock, startsAt: x.etaAt } : null } : x)),
        queue: { ...q.queue, queuers: [...new Set([...q.queue.queuers, o.queuerName])] },
      }));
      if (get().selectedId === id) get().toast(`${o.queuerName} checked in at ${p.shop.name}${o.clock ? '. The fee clock is running.' : '.'}`, 'info');
      p = point(id)!;
    }

    const order = get().orders[id];
    if (order?.status === 'booked' && order.receiptAt !== undefined && now >= order.receiptAt) {
      settle(p, order).catch((err) => fail(id, err));
    }

    // Every request at or above an offer's current fee fills, best first, while supply lasts.
    for (let round = 0; round < 3; round++) {
      const fills = matchPoint(p, now);
      if (fills.length > 0) {
        let mine: { fee: Cents; queuer: string } | null = null;
        patchPoint(id, (q) => {
          let bids = q.bids;
          let offers = q.offers;
          for (const f of fills) {
            const b = bids.find((x) => x.id === f.bidId);
            const o = offers.find((x) => x.askId === f.askId);
            if (b?.mine && o) mine = { fee: f.feeCents, queuer: o.queuerName };
            bids = bids.map((x) => (x.id === f.bidId ? { ...x, qty: x.qty - f.qty } : x)).filter((x) => x.qty > 0);
            offers = offers.map((x) => (x.askId === f.askId ? { ...x, supply: x.supply - f.qty } : x));
          }
          return withBookSummary({ ...q, bids, offers });
        });
        if (mine) {
          const m = mine as { fee: Cents; queuer: string };
          const ord = get().orders[id];
          if (ord && (ord.status === 'resting' || ord.status === 'approving')) {
            patchOrder(id, { status: 'booked', fillFeeCents: m.fee, queuerName: m.queuer, receiptAt: now + Math.min(p.queue.minutes, 20) * MIN });
            get().toast(`Matched: ${m.queuer} will queue for you for a ${formatUsd(m.fee)} fee.`, 'money');
          }
        }
        get().bump(id);
        p = point(id)!;
      }
      const used = p.offers.find((o) => o.supply <= 0);
      if (!used || p.next.length === 0) break;
      reopen(p, used, now);
      p = point(id)!;
    }

    // Requests past their deadline leave the book.
    if (p.bids.some((b) => !b.mine && b.deadlineAt <= now)) {
      patchPoint(id, (q) => withBookSummary({ ...q, bids: q.bids.filter((b) => b.mine || b.deadlineAt > now) }));
    }
  }
}

/**
 * A new request from the crowd at a random point. Most people ask near the
 * floor and wait; a few ask closer to the offer. A new request is always below
 * the current offer, so it rests in the book until a fee clock reaches it.
 */
function crowdRequest() {
  const { points } = get();
  const live = points.filter((p) => p.status === 'open' && p.bids.length > 0);
  if (live.length === 0) return;
  const weights = live.map((p) => 1 + p.bids.length);
  let r = rnd() * weights.reduce((a, b) => a + b, 0);
  let target = live[0];
  for (let i = 0; i < live.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      target = live[i];
      break;
    }
  }
  const now = clock.now();
  const offer = bestOffer(target, now);
  const ceiling = offer ? offerFeeAt(offer, now) - 100 : (target.bestFeeCents ?? usd(9)) + 100;
  const floor = target.minFeeCents;
  if (ceiling < floor) return;
  const steps = Math.floor((ceiling - floor) / 50);
  const fee = floor + Math.floor(rnd() ** 1.8 * (steps + 1)) * 50;
  const bid: Bid = {
    id: `${target.id}-live-${++bidSeq}`,
    bidder: randomBidder(rnd),
    feeCents: Math.min(ceiling, Math.round(fee / 50) * 50),
    qty: 1,
    placedAt: now,
    deadlineAt: now + (24 + Math.round(rnd() * 48)) * 60 * MIN,
    mode: target.modes.includes('ship') && rnd() < 0.4 ? 'ship' : 'local',
  };
  // Keep a demo book a readable size: the lowest, oldest crowd request gives up.
  const trim = (bids: Bid[]) => {
    if (bids.length <= MAX_BOOK) return bids;
    const crowd = bids.filter((b) => !b.mine).sort((a, b) => a.feeCents - b.feeCents || a.placedAt - b.placedAt);
    return crowd[0] ? bids.filter((b) => b.id !== crowd[0].id) : bids;
  };
  patchPoint(target.id, (p) => withBookSummary({ ...p, bids: trim([...p.bids, bid]) }));
  get().bump(target.id);
}

async function placeMax(pointId: string, maxFeeCents: Cents, quiet: boolean) {
  const p = point(pointId);
  if (!p || !isOpenOrder(get().orders[pointId])) return;
  const holdCents = holdFor(p, maxFeeCents);
  setOrder({ pointId, kind: 'max', status: 'approving', mode: 'local', maxFeeCents, holdCents });
  try {
    const hold = await payments.placeHold({ amountCents: holdCents, reference: `${pointId}:max`, description: `the ${p.itemShort} and a queue fee of up to ${formatUsd(maxFeeCents)}` });
    // The hold is in place: the request joins the book like everyone else's.
    const bid: Bid = { id: `${pointId}-mine-${++bidSeq}`, bidder: 'You', feeCents: maxFeeCents, qty: 1, placedAt: clock.now(), deadlineAt: clock.now() + 2 * 24 * 60 * MIN, mode: 'local', mine: true };
    patchOrder(pointId, { status: 'resting', holdId: hold.id, bidId: bid.id });
    patchPoint(pointId, (q) => withBookSummary({ ...q, bids: [...q.bids, bid] }));
    get().bump(pointId);
    if (!quiet) get().toast(`${formatUsd(holdCents, { exact: true })} held. A queuer takes it when an offer reaches your ${formatUsd(maxFeeCents)} fee.`, 'money');
    tick();
  } catch (err) {
    fail(pointId, err);
  }
}

const driver: MarketDriver = {
  async requestNow(pointId) {
    const p = point(pointId);
    const now = clock.now();
    const offer = p ? bestOffer(p, now) : null;
    if (!p || !offer || !isOpenOrder(get().orders[pointId])) return;
    const fee = offerFeeAt(offer, now);
    const holdCents = holdFor(p, fee);
    setOrder({ pointId, kind: 'now', status: 'approving', mode: 'local', maxFeeCents: fee, holdCents, queuerName: offer.queuerName });
    try {
      const hold = await payments.placeHold({ amountCents: holdCents, reference: `${pointId}:now`, description: describe(p, offer.queuerName) });
      const live = point(pointId);
      const still = live?.offers.find((o) => o.askId === offer.askId);
      // Someone else took the last spot while PayPal was approving: give the money back.
      if (!live || !still || still.supply <= 0) {
        patchOrder(pointId, { status: 'releasing', holdId: hold.id });
        await payments.release(hold.id, { description: `${offer.queuerName} was fully booked first` });
        patchOrder(pointId, { status: 'missed', releasedCents: holdCents });
        return;
      }
      // The fee can only fall while PayPal approves; the requester gets the lower one.
      const fill = Math.min(fee, offerFeeAt(still, clock.now()));
      patchPoint(pointId, (q) => withBookSummary({ ...q, offers: q.offers.map((o) => (o.askId === still.askId ? { ...o, supply: o.supply - 1 } : o)) }));
      patchOrder(pointId, { status: 'booked', holdId: hold.id, fillFeeCents: fill, receiptAt: clock.now() + Math.min(live.queue.minutes, 20) * MIN });
      get().bump(pointId);
      get().toast(`${offer.queuerName} is queueing for you. ${formatUsd(holdCents, { exact: true })} is held, not charged.`, 'money');
    } catch (err) {
      fail(pointId, err);
    }
  },

  async setMax(pointId, maxFeeCents) {
    await placeMax(pointId, maxFeeCents, false);
  },

  async cancelMax(pointId) {
    const order = get().orders[pointId];
    if (!order?.holdId || order.status !== 'resting') return;
    // Out of the book first, so it cannot fill while the release goes through.
    patchPoint(pointId, (q) => withBookSummary({ ...q, bids: q.bids.filter((b) => b.id !== order.bidId) }));
    patchOrder(pointId, { status: 'releasing' });
    try {
      await payments.release(order.holdId, { description: 'you cancelled your request' });
      patchOrder(pointId, { status: 'released', releasedCents: order.holdCents });
    } catch (err) {
      fail(pointId, err);
    }
  },

  async take(pointId) {
    const p = point(pointId);
    const top = p ? [...p.bids].filter((b) => !b.mine).sort((a, b) => b.feeCents - a.feeCents || a.placedAt - b.placedAt)[0] : undefined;
    if (!p || !top) return;
    useMarket.setState((s) => ({ taken: { ...s.taken, [pointId]: { pointId, feeCents: top.feeCents, status: 'taken', at: clock.now() } } }));
    patchPoint(pointId, (q) => withBookSummary({ ...q, bids: q.bids.filter((b) => b.id !== top.id) }));
    get().bump(pointId);
    get().toast(`You took ${top.bidder}'s request: ${units(p.kind, 1)} for a ${formatUsd(top.feeCents)} fee. Walk over and check in.`, 'money');
  },

  approve() {
    /* The in-browser market approves its own holds. */
  },
};

let booted = false;

/**
 * Starts the in-browser market once per page load: loads the task points,
 * runs the tick, lets the crowd keep asking, and rests the viewer's own first
 * request (a real hold in the payments mock) so money is visible from the
 * first screen and fills on its own when a fee clock reaches it.
 */
export function bootMockMarket(city: CityConfig) {
  if (booted) return;
  booted = true;
  const points = buildCatalog(city.id, clock.now());
  useMarket.setState({ backend: 'mock', serverMode: null, points, driver });
  payments.subscribe(syncMoney);
  syncMoney();

  window.setInterval(tick, 250);
  const nextBid = () =>
    window.setTimeout(() => {
      crowdRequest();
      nextBid();
    }, 3800 + Math.random() * 4200);
  window.setTimeout(nextBid, 2500);

  // The viewer already asked for the first item whose queuer is in line with a fee clock.
  const first = points.find((p) => p.offers.some((o) => o.checkedIn && o.clock));
  if (first) {
    const top = first.bestFeeCents ?? usd(10);
    placeMax(first.id, top + 100, true).catch(() => {
      /* The demo still works without the seeded request. */
    });
  }
}
