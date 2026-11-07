import { randomUUID } from 'node:crypto';
import {
  CROWD_NAMES,
  DAY_MS,
  HERO,
  SEED_SHOPS,
  SEED_USERS,
  findItem,
  seeded,
  shippingNumbers,
  suggestedRetailCapCents,
} from '@holdmyspot/shared';
import type { CityId, CreateBidRequest, Destination, User } from '@holdmyspot/shared';
import type { UserDoc } from '../db/store.ts';
import { FAKE_RECEIVER_DOMAIN } from '../fakes/paypal.ts';
import type { App } from './app.ts';
import { authorizeBid, createBid } from './bids.ts';
import { allItems } from './catalog.ts';
import { bookState, emitBook } from './market.ts';
import { emitClock } from './views.ts';

/**
 * Reset and seed: personas, books, and the crowd's resting bids that light
 * up the map before anyone queues. Seeded bids go through the same commands
 * as a requester's (create, simulated approval, authorize), always on the
 * fake PayPal adapter, so every hold and ledger entry is real data.
 */

const CITY_DESTINATIONS: Record<'nyc' | 'sf', Destination> = {
  nyc: { mode: 'ship', country: 'US', region: 'NY', city: 'New York', postalCode: '10012' },
  sf: { mode: 'ship', country: 'US', region: 'CA', city: 'San Francisco', postalCode: '94110' },
};

export interface ResetOptions {
  seed: number;
  marketStart: number;
  speed: number;
  paused?: boolean;
  crowd: boolean;
}

function crowdUsers(): User[] {
  return CROWD_NAMES.map((name, i) => ({
    id: `crowd-${String(i + 1).padStart(2, '0')}`,
    displayName: name,
    roles: ['requester'],
    // Two in three live in San Francisco (the default city), one in three in New York.
    cityId: (i % 3 === 2 ? 'nyc' : 'sf') as CityId,
    country: 'US',
    avatar: null,
    reliability: null,
    home: null,
  }));
}

/** Empties the market and seeds a fresh one at `marketStart`. Call inside app.exec. */
export async function resetMarket(app: App, opts: ResetOptions): Promise<void> {
  const floor = app.bus.latestSeq();
  app.tx(() => {
    app.store.clearAll();
    app.fakePayPal.reset();
    app.bus.clear();
    app.db.setMeta('reset-floor', String(floor));
    app.db.setMeta('seed', String(opts.seed));
  });
  app.bootId = randomUUID();
  app.clock.reset({ marketStart: opts.marketStart, speed: opts.speed, paused: opts.paused ?? false });
  app.saveClock();

  app.tx(() => {
    for (const u of SEED_USERS) {
      const doc: UserDoc = { id: u.id, user: u, crowd: false, payoutEmail: u.roles.includes('queuer') ? `${u.id}${FAKE_RECEIVER_DOMAIN}` : null };
      app.store.users.insert(doc);
    }
    for (const u of crowdUsers()) app.store.users.insert({ id: u.id, user: u, crowd: true, payoutEmail: null });
    for (const { item } of allItems()) bookState(app, item.id);
    emitClock(app);
  });
  if (opts.crowd) await seedCrowd(app, opts.seed, opts.marketStart);
  app.tx(() => {
    for (const { item } of allItems()) emitBook(app, item.id);
  });
}

interface CrowdBid {
  userId: string;
  itemId: string;
  qty: number;
  feeCents: number;
  deadlineDays: number;
  /** A short deadline instead, in minutes after the market start (requests about to end). */
  deadlineMinutes?: number;
}

/**
 * The hero book (docs/ARCHITECTURE.md section 8): 12 requests for the Mochi
 * Bunny plush, one each (one per customer). Priya's $11 is the best; the
 * crowd rests at $10.50 or below, so Wei's fee clock first meets a request
 * when Mia's $12 arrives.
 */
function heroBids(): CrowdBid[] {
  const item = HERO.itemId;
  const crowd = [1050, 1000, 1000, 950, 900, 900, 850, 800, 750, 700, 600];
  return [
    { userId: 'priya', itemId: item, qty: 1, feeCents: 1100, deadlineDays: 3 },
    ...crowd.map((feeCents, i) => ({ userId: `crowd-${String(i + 1).padStart(2, '0')}`, itemId: item, qty: 1, feeCents, deadlineDays: 2 + (i % 3) })),
  ];
}

function otherBids(seed: number): CrowdBid[] {
  const rand = seeded(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const inCity = (cityId: CityId) => crowdUsers().filter((u) => u.cityId === cityId).map((u) => u.id);
  const anyone = crowdUsers().map((u) => u.id);
  const plan: { itemId: string; count: number; fees: number[]; deadlineMinutes?: number }[] = [
    // San Francisco, around Japantown.
    { itemId: 'plush-little-lantern', count: 4, fees: [500, 600, 700, 800] },
    { itemId: 'ramen-steam-lantern', count: 5, fees: [500, 600, 700, 800, 900] },
    { itemId: 'cake-sugar-cloud', count: 6, fees: [600, 700, 800, 900, 1000, 1200] },
    // San Francisco, further out (some beyond a 30-minute trip from Japantown).
    { itemId: 'cake-butter-bell', count: 4, fees: [700, 900, 1100, 1300] },
    { itemId: 'plush-pocket-pals', count: 5, fees: [800, 1000, 1200, 1500] },
    { itemId: 'ramen-kettle-moon', count: 3, fees: [500, 600, 800] },
    { itemId: 'plush-little-wave', count: 3, fees: [600, 800, 1000] },
    { itemId: 'cake-crumb-clover', count: 3, fees: [600, 700, 900] },
    { itemId: 'ramen-sunset-house', count: 2, fees: [500, 700] },
    // Requests that end 15 minutes after the market opens: too soon to reach from Japantown.
    { itemId: 'ramen-dogpatch-noodle', count: 2, fees: [600, 800], deadlineMinutes: 15 },
    { itemId: 'cake-ocean-beach', count: 3, fees: [600, 800, 1000] },
    { itemId: 'plush-geneva-corner', count: 2, fees: [700, 900] },
    // New York.
    { itemId: 'cake-petal-crumb', count: 3, fees: [600, 700, 800, 1000] },
    { itemId: 'plush-little-orbit', count: 3, fees: [600, 800, 1000] },
    { itemId: 'ramen-bowery-noodle', count: 2, fees: [400, 500, 600] },
    { itemId: 'cake-houston-bakeshop', count: 2, fees: [500, 600, 700] },
  ];
  const out: CrowdBid[] = [];
  for (const p of plan) {
    const item = findItem(p.itemId)!;
    const shop = SEED_SHOPS.find((s) => s.id === item.shopId)!;
    // Perishables are local errands: only requesters in the shop's own city. Plush can ship anywhere in the US.
    const who = item.modes.includes('ship') ? anyone : inCity(shop.cityId);
    for (let i = 0; i < p.count; i++) {
      out.push({
        userId: pick(who),
        itemId: p.itemId,
        qty: Math.min(item.perPersonLimit, 1 + Math.floor(rand() * 2)),
        feeCents: pick(p.fees),
        deadlineDays: 1 + Math.floor(rand() * 4),
        ...(p.deadlineMinutes ? { deadlineMinutes: p.deadlineMinutes } : {}),
      });
    }
  }
  return out;
}

async function seedCrowd(app: App, seed: number, start: number): Promise<void> {
  const all = [...heroBids(), ...otherBids(seed)];
  const step = Math.floor((85 * 60_000) / all.length);
  for (let i = 0; i < all.length; i++) {
    const c = all[i]!;
    const at = start - 90 * 60_000 + i * step;
    await app.atTime(at, async () => {
      const doc = app.store.users.must(c.userId);
      const item = findItem(c.itemId)!;
      const shop = SEED_SHOPS.find((s) => s.id === item.shopId)!;
      // Local when the requester lives in the shop's city, else shipped (plush only).
      const local = item.modes.includes('local') && doc.user.cityId === shop.cityId;
      const destination: Destination = local ? { mode: 'local', cityId: shop.cityId } : CITY_DESTINATIONS[doc.user.cityId === 'sf' ? 'sf' : 'nyc'];
      const req: CreateBidRequest = {
        shopId: shop.id,
        itemId: item.id,
        qty: c.qty,
        retailCapCents: suggestedRetailCapCents(item.retailCents),
        maxFeeCents: Math.max(item.minFeeCents, c.feeCents),
        shippingBudgetCents: local ? 0 : shippingNumbers(item, c.qty).budgetCents,
        destination,
        deadlineAt: c.deadlineMinutes ? start + c.deadlineMinutes * 60_000 : start + c.deadlineDays * DAY_MS,
        funding: 'paypal',
        agent: null,
      };
      // Callers run resetMarket inside app.exec, so commands are called directly here.
      const created = await createBid(app, doc.user, req, { crowd: true });
      await app.fakePayPal.approveOrder(created.checkout.orderId, 'paypal', 'approve');
      await authorizeBid(app, { userId: doc.id, ops: false }, created.bid.id, created.checkout.orderId);
    });
  }
}
