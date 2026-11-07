import { SEED_SHOPS, seeded } from '@holdmyspot/shared';
import type { FeeClock, Item, Shop as SeedShop } from '@holdmyspot/shared';
import type { CityId } from '../config/cities';
import { withBookSummary } from './book';
import { usd } from './money';
import type { Bid, FeeOffer, ItemLook, TaskPoint } from './types';

/**
 * The in-browser market's data: the server's own seed catalog (shared/src/seed.ts),
 * with demo books around it (resting requests, queuers in line or on the way).
 * Every shop, item and person is fictional. The server replaces all of this
 * with live books when it is running.
 */

export { seeded };

const MIN = 60_000;

const BIDDERS = [
  'Maya R.', 'Ken L.', 'Pia K.', 'Tom B.', 'Ana S.', 'Lou M.', 'Sal W.', 'Nia A.',
  'Ivy C.', 'Ben T.', 'Kai H.', 'Zoe P.', 'Omar F.', 'Lena G.', 'Ravi D.', 'Mae N.',
  'Ethan Y.', 'Sofia V.', 'Hana O.', 'Luca E.', 'Grace Z.', 'Ade O.', 'Nico J.', 'Elle Q.',
];

export function randomBidder(rnd: () => number): string {
  return BIDDERS[Math.floor(rnd() * BIDDERS.length)];
}

/** Which model and icon an item uses. */
export function lookOf(item: Pick<Item, 'id' | 'kind'>): ItemLook {
  if (item.kind === 'cake') return 'cake';
  if (item.kind === 'ramen') return 'ramen';
  if (item.id.includes('lantern') || item.id.includes('cat')) return 'cat';
  if (item.id.includes('otter') || item.id.includes('pocket') || item.id.includes('wave')) return 'otter';
  if (item.id.includes('pup') || item.id.includes('orbit') || item.id.includes('geneva')) return 'pup';
  return 'bunny';
}

interface BookPlan {
  /** Max fees per unit, in dollars. */
  fees: number[];
  /** Requests end this many minutes from now (default: one to three days). */
  endsInMin?: number;
  offer?: { queuer: string; fee: number; capacity: number; clock?: { step: number; everyMin: number; floor: number }; startedMinAgo?: number; etaInMin?: number; note: string };
  next?: { queuer: string; fee: number; capacity: number; note: string }[];
}

/** Demo books by item id. Every book starts uncrossed: no request reaches the offer's fee now. */
const PLANS: Record<string, BookPlan> = {
  // San Francisco, Japantown.
  'plush-paper-moon': {
    fees: [11, 10.5, 10, 10, 9.5, 9, 9, 8.5, 8, 7.5, 7, 6],
    offer: { queuer: 'Wei', fee: 15, capacity: 1, clock: { step: 1, everyMin: 5, floor: 8 }, startedMinAgo: 6, note: 'Wei is in line now and buys one per customer, at the shop price.' },
    next: [{ queuer: 'Lin', fee: 10, capacity: 1, note: 'Lin is a few minutes away and buys at the shop price.' }],
  },
  'plush-little-lantern': {
    fees: [7.5, 7, 6.5, 6, 5.5],
    offer: { queuer: 'Ava', fee: 8, capacity: 3, startedMinAgo: 12, note: 'Ava is in line with a fixed fee.' },
  },
  'cake-sugar-cloud': {
    fees: [12, 10, 9, 9, 8, 7, 6],
    offer: { queuer: 'Rin', fee: 14, capacity: 2, clock: { step: 1, everyMin: 5, floor: 7 }, etaInMin: 9, note: 'Rin is on the way; her fee starts stepping down when she checks in.' },
  },
  'ramen-steam-lantern': { fees: [9, 8, 7, 7, 6] },
  // San Francisco, further out.
  'cake-butter-bell': { fees: [13, 11, 9, 7] },
  'plush-pocket-pals': {
    fees: [15, 12, 10, 8, 8],
    offer: { queuer: 'Jo', fee: 16, capacity: 1, startedMinAgo: 20, note: 'Jo is in line downtown with a fixed fee.' },
  },
  'ramen-kettle-moon': { fees: [8, 6, 5] },
  'plush-little-wave': { fees: [10, 8, 6] },
  'cake-crumb-clover': { fees: [9, 7, 6] },
  'ramen-sunset-house': { fees: [7, 5] },
  'ramen-dogpatch-noodle': { fees: [8, 6], endsInMin: 12 },
  'cake-ocean-beach': { fees: [10, 8, 6] },
  'plush-geneva-corner': { fees: [9, 7] },
  // New York.
  'cake-petal-crumb': {
    fees: [12, 11, 10, 10, 9, 9, 8, 8, 7],
    offer: { queuer: 'Mo', fee: 15, capacity: 2, clock: { step: 1, everyMin: 5, floor: 8 }, startedMinAgo: 6, note: 'Mo is in line now and buys each cake at the shop price.' },
    next: [{ queuer: 'Kit', fee: 11, capacity: 2, note: 'Kit joined the line behind Mo.' }],
  },
  'plush-little-orbit': {
    fees: [11, 10, 9, 8],
    offer: { queuer: 'Dana', fee: 12, capacity: 1, startedMinAgo: 9, note: 'Dana is in line with a fixed fee.' },
  },
  'ramen-bowery-noodle': { fees: [9, 8, 7] },
  'cake-houston-bakeshop': {
    fees: [8, 7, 6],
    offer: { queuer: 'Theo', fee: 11, capacity: 2, clock: { step: 1, everyMin: 5, floor: 6 }, etaInMin: 7, note: 'Theo is on the way; his fee steps down once he checks in.' },
  },
};

function clockOf(plan: NonNullable<BookPlan['offer']>, startsAt: number | null): FeeClock | null {
  if (!plan.clock) return null;
  return { stepCents: usd(plan.clock.step), intervalMs: plan.clock.everyMin * MIN, floorCents: usd(plan.clock.floor), startsAt };
}

function bidsFor(id: string, plan: BookPlan, now: number, local: boolean, ships: boolean, limit: number, seed: number): Bid[] {
  const rnd = seeded(seed);
  return plan.fees.map((fee, i) => ({
    id: `${id}-b${i}`,
    bidder: BIDDERS[(seed + i * 7) % BIDDERS.length],
    feeCents: usd(fee),
    qty: Math.min(limit, 1 + (rnd() > 0.75 ? 1 : 0)),
    placedAt: now - Math.round((4 + rnd() * 50) * MIN),
    deadlineAt: plan.endsInMin ? now + plan.endsInMin * MIN : now + Math.round((24 + rnd() * 48) * 60) * MIN,
    // Out-of-town requesters have a plush shipped; perishables are local errands.
    mode: ships && (!local || rnd() < 0.45) ? 'ship' : 'local',
  }));
}

function pointFor(shop: Pick<SeedShop, 'id' | 'cityId' | 'name' | 'street' | 'hours' | 'timezone' | 'lngLat' | 'accent'>, item: Item, now: number, seed: number): TaskPoint {
  const plan = PLANS[item.id] ?? { fees: [] };
  const offers: FeeOffer[] = [];
  if (plan.offer) {
    const o = plan.offer;
    const checkedIn = o.etaInMin === undefined;
    offers.push({
      askId: `${item.id}-ask-${o.queuer.toLowerCase()}`,
      queuerName: o.queuer,
      capacity: Math.min(o.capacity, item.perPersonLimit),
      supply: Math.min(o.capacity, item.perPersonLimit),
      feeCents: usd(o.fee),
      clock: clockOf(o, checkedIn ? now - (o.startedMinAgo ?? 0) * MIN - 1_000 : null),
      checkedIn,
      etaAt: checkedIn ? now - (o.startedMinAgo ?? 0) * MIN : now + (o.etaInMin ?? 10) * MIN,
      modes: [...item.modes],
      note: o.note,
    });
  }
  const minutes = item.expectedWaitMinutes;
  const point: TaskPoint = {
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
    queue: { minutes, peopleAhead: Math.round(minutes * 0.8), queuers: offers.filter((o) => o.checkedIn).map((o) => o.queuerName) },
    bids: bidsFor(item.id, plan, now, true, item.modes.includes('ship'), item.perPersonLimit, seed),
    depth: [],
    bidCount: 0,
    bidQty: 0,
    bestFeeCents: null,
    latestDeadlineAt: null,
    offers,
    next: (plan.next ?? []).map((n) => ({ queuerName: n.queuer, capacity: Math.min(n.capacity, item.perPersonLimit), feeCents: usd(n.fee), clock: null, modes: [...item.modes], note: n.note })),
    hue: shop.accent ?? '#5B4CF0',
    status: 'open',
  };
  return withBookSummary(point);
}

/**
 * Taipei stays a hidden map option (?city=taipei) for street shots: a few
 * web-only fictional shops in Ximending with the same three kinds of item.
 */
const TAIPEI_SHOPS: { shop: Parameters<typeof pointFor>[0]; item: Item }[] = (() => {
  const base = { cityId: 'sf' as const, timezone: 'Asia/Taipei', hours: { opens: '10:00', closes: '21:00' } };
  const item = (p: Partial<Item> & Pick<Item, 'id' | 'kind' | 'name' | 'shortName'>): Item => ({
    shopId: '',
    retail: { currency: 'USD', minor: 3000 },
    retailCents: 3000,
    perPersonLimit: 2,
    modes: ['local'],
    shippable: false,
    perishable: true,
    weightGrams: 500,
    dutyCategory: 'toys',
    expectedWaitMinutes: 35,
    minFeeCents: 500,
    tags: ['Errand only', 'Paid at shop price'],
    receiptAliases: [],
    ...p,
  });
  return [
    { shop: { ...base, id: 'tpe-moon-rabbit', name: 'Moon Rabbit Toys', street: 'Hanzhong St', lngLat: [121.50755, 25.04383], accent: '#FF8FB8' }, item: item({ id: 'plush-tpe-moon-rabbit', kind: 'plush', name: 'Moon Rabbit plush, night market drop', shortName: 'Moon Rabbit plush', perPersonLimit: 1, modes: ['local', 'ship'], perishable: false, tags: ['One per customer', 'Paid at shop price'] }) },
    { shop: { ...base, id: 'tpe-cloud-bakery', name: 'Little Cloud Bakery', street: 'Emei St', lngLat: [121.50673, 25.04344], accent: '#7FD6C2' }, item: item({ id: 'cake-tpe-cloud', kind: 'cake', name: 'Strawberry roll cake, 30 a day', shortName: 'Roll cake', retailCents: 2600 }) },
    { shop: { ...base, id: 'tpe-ximen-ramen', name: 'Ximen Noodle Bar', street: 'Kunming St', lngLat: [121.50789, 25.04529], accent: '#FFB454' }, item: item({ id: 'ramen-tpe-ximen', kind: 'ramen', name: 'Tonkotsu ramen, takeout', shortName: 'Tonkotsu ramen', retailCents: 1400 }) },
    { shop: { ...base, id: 'tpe-lucky-cat', name: 'Lucky Paw Toys', street: 'Wuchang St', lngLat: [121.50711, 25.04473], accent: '#B69CFF' }, item: item({ id: 'plush-tpe-lucky-paw', kind: 'plush', name: 'Lucky Cat plush, temple drop', shortName: 'Lucky Cat plush', perishable: false }) },
  ];
})();

const TAIPEI_PLANS: Record<string, BookPlan> = {
  'plush-tpe-moon-rabbit': { fees: [12, 11, 10, 9, 9, 8], offer: { queuer: 'Wei', fee: 15, capacity: 1, clock: { step: 1, everyMin: 5, floor: 8 }, startedMinAgo: 6, note: 'Wei is in line now.' } },
  'cake-tpe-cloud': { fees: [10, 9, 8, 7] },
  'ramen-tpe-ximen': { fees: [8, 7, 6], offer: { queuer: 'Lin', fee: 9, capacity: 2, etaInMin: 8, note: 'Lin is on the way.' } },
  'plush-tpe-lucky-paw': { fees: [9, 8, 7, 6] },
};

export function buildCatalog(city: CityId, now: number): TaskPoint[] {
  if (city === 'taipei') {
    return TAIPEI_SHOPS.map(({ shop, item }, i) => {
      PLANS[item.id] ??= TAIPEI_PLANS[item.id] ?? { fees: [] };
      return { ...pointFor(shop, item, now, 50 + i * 6), cityId: 'taipei' as const };
    });
  }
  const out: TaskPoint[] = [];
  SEED_SHOPS.filter((s) => s.cityId === city).forEach((shop, i) => {
    for (const item of shop.items) out.push(pointFor(shop, item, now, 11 + i * 6));
  });
  return out;
}
