import { ContractError, SEED_CITIES, SEED_SHOPS } from '@holdmyspot/shared';
import type { City, Item, Reliability, Shop, User } from '@holdmyspot/shared';
import type { UserDoc } from '../db/store.ts';
import type { App } from './app.ts';

/** The fixed seed catalog (shops and items are read-only in v1) and persona lookups. */

export function cities(): City[] {
  return SEED_CITIES;
}

export function shopOrThrow(shopId: string): Shop {
  const shop = SEED_SHOPS.find((s) => s.id === shopId);
  if (!shop) throw new ContractError('NOT_FOUND', `No shop with id ${shopId}.`, { shopId });
  return shop;
}

export function itemOrThrow(shopId: string, itemId: string): { shop: Shop; item: Item } {
  const shop = shopOrThrow(shopId);
  const item = shop.items.find((i) => i.id === itemId);
  if (!item) throw new ContractError('NOT_FOUND', `${shop.name} has no item ${itemId}.`, { shopId, itemId });
  return { shop, item };
}

export function itemById(itemId: string): { shop: Shop; item: Item } {
  for (const shop of SEED_SHOPS) {
    const item = shop.items.find((i) => i.id === itemId);
    if (item) return { shop, item };
  }
  throw new ContractError('NOT_FOUND', `No item with id ${itemId}.`, { itemId });
}

export function allItems(): { shop: Shop; item: Item }[] {
  return SEED_SHOPS.flatMap((shop) => shop.items.map((item) => ({ shop, item })));
}

export function userDoc(app: App, userId: string): UserDoc {
  const doc = app.store.users.get(userId);
  if (!doc) throw new ContractError('UNAUTHORIZED', `Unknown persona ${userId}.`, { userId });
  return doc;
}

export function user(app: App, userId: string): User {
  return userDoc(app, userId).user;
}

export function requireRole(u: User, role: 'requester' | 'queuer'): void {
  if (!u.roles.includes(role)) throw new ContractError('FORBIDDEN', `${u.displayName} is not a ${role}.`, { userId: u.id, role });
}

/** Score = completed claims over all claims that ended (same formula as the seed). */
export function scoreOf(r: Omit<Reliability, 'score'>): number {
  const total = r.claimsCompleted + r.claimsLapsed + r.proofsRejected;
  return total === 0 ? 100 : Math.round((100 * r.claimsCompleted) / total);
}

/** Changes a queuer's reliability counters (inside a transaction). */
export function bumpReliability(app: App, userId: string, field: 'claimsCompleted' | 'claimsLapsed' | 'proofsRejected'): void {
  const doc = app.store.users.get(userId);
  if (!doc || !doc.user.reliability) return;
  const r = { ...doc.user.reliability, [field]: doc.user.reliability[field] + 1 };
  r.score = scoreOf(r);
  doc.user = { ...doc.user, reliability: r };
  app.store.users.update(doc);
}
