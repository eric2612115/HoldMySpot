import { SEED_CITIES, SEED_USERS, epochToZonedLocal } from '@holdmyspot/shared';
import type { MarketMs, OpsRecords, Reliability, User, UserId } from '@holdmyspot/shared';
import { HERO_TZ, sf } from './time.ts';
import type { CrowdPerson, World } from './mock/world.ts';

/**
 * The live server's records (GET /api/ops/records) as the console's World,
 * so the board, the map and the dashboard are drawn by the same functions in
 * both modes (boardBundle, booksAt, datasetsAt in mock/views.ts). The server
 * owns every record; nothing here changes them.
 */
export function worldFromRecords(r: OpsRecords): World {
  // Ops sees home positions; the seed is the fallback for a server that hides them.
  const seedHome = new Map(SEED_USERS.map((u) => [u.id, u.home]));
  const users = new Map<UserId, User>(r.users.map((u) => [u.id, { ...u, home: u.home ?? seedHome.get(u.id) ?? null }]));
  const reliability = new Map<UserId, Reliability>();
  for (const u of r.users) if (u.reliability) reliability.set(u.id, u.reliability);
  const crowd = new Map<UserId, CrowdPerson>(
    r.crowd.map((c) => [c.id, { id: c.id, displayName: c.displayName, cityName: SEED_CITIES.find((x) => x.id === c.cityId)?.name ?? c.cityId, region: '' }]),
  );
  return {
    now: r.at,
    users,
    crowd,
    reliability,
    bids: r.bids,
    holds: r.holds,
    asks: r.asks,
    claims: r.claims,
    matches: r.matches,
    jobs: r.jobs,
    ledger: r.ledger,
    payouts: r.payouts,
    notes: r.agentActions,
    stalledClaims: new Set(),
    seq: {},
  };
}

/** The board's day around a market time: San Francisco 10:00 to 17:00 that day, widened to keep `at` in view. */
export function boardDay(at: MarketMs): { from: MarketMs; to: MarketMs; date: string } {
  const date = epochToZonedLocal(at, HERO_TZ).slice(0, 10);
  return { from: Math.min(sf('10:00', date), at - 60 * 60_000), to: Math.max(sf('17:00', date), at + 2 * 60 * 60_000), date };
}
