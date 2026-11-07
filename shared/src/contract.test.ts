import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { API_ERROR_CODES, ContractError, ENDPOINTS, SERVER_EVENT_TYPES, apiPath, endpointParts, type ApiKey } from './contract.ts';
import { distanceMeters, geofenceProblem, rangeProblem, travelMinutes } from './geo.ts';
import { DEMO_MARKET_START, HERO, SEED_CITIES, SEED_SHOPS, SEED_USERS, findItem, findShop } from './seed.ts';

describe('endpoint table', () => {
  it('has a method and a path for every endpoint', () => {
    for (const key of Object.keys(ENDPOINTS) as ApiKey[]) {
      const { method, path } = endpointParts(key);
      assert.ok(['GET', 'POST', 'PATCH'].includes(method), key);
      assert.ok(path.startsWith('/api/'), key);
    }
  });

  it('fills and encodes path parameters', () => {
    assert.equal(apiPath('POST /api/bids/:bidId/authorize', { bidId: 'bid 1' }), '/api/bids/bid%201/authorize');
    assert.equal(apiPath('GET /api/books/:shopId/:itemId', { shopId: 'paper-moon-toys', itemId: 'plush-paper-moon' }), '/api/books/paper-moon-toys/plush-paper-moon');
    assert.throws(() => apiPath('GET /api/bids/:bidId', {} as { bidId: string }), ContractError);
  });

  it('keeps the web prototype payment error codes', () => {
    for (const c of ['INVALID_AMOUNT', 'HOLD_NOT_FOUND', 'HOLD_CLOSED', 'OVER_CAPTURE'] as const) assert.ok(API_ERROR_CODES.includes(c));
  });

  it('lists every event type once', () => {
    assert.equal(new Set(SERVER_EVENT_TYPES).size, SERVER_EVENT_TYPES.length);
  });
});

describe('seed catalog', () => {
  it('has the hero shop, item and people', () => {
    assert.equal(findShop(HERO.shopId)?.name, 'Paper Moon Toys');
    const plush = findItem(HERO.itemId)!;
    assert.equal(plush.retailCents, 3400);
    assert.equal(plush.perPersonLimit, 1, 'one per customer');
    assert.deepEqual(plush.modes, ['local', 'ship']);
    assert.ok(SEED_USERS.some((u) => u.id === HERO.requesterId && u.cityId === 'nyc'));
    assert.ok(SEED_USERS.some((u) => u.id === HERO.queuerId && u.cityId === 'sf'));
    assert.equal(DEMO_MARKET_START, '2026-11-12T10:30:00-08:00');
  });

  it('sells only cakes, plush and ramen; perishables are local errands, plush can ship', () => {
    for (const s of SEED_SHOPS) {
      for (const i of s.items) {
        assert.ok(['cake', 'plush', 'ramen'].includes(i.kind), i.id);
        assert.equal(i.shopId, s.id);
        assert.equal(i.retail.currency, 'USD', i.id);
        assert.ok(!('publishedOdds' in i), `${i.id} carries no chance-item odds`);
        if (i.perishable) assert.deepEqual(i.modes, ['local'], `${i.id} is perishable`);
        else assert.deepEqual(i.modes, ['local', 'ship'], `${i.id} can ship`);
        assert.equal(i.kind === 'plush', !i.perishable, i.id);
      }
    }
  });

  it('has unique ids and requesters only in US cities', () => {
    const ids = [...SEED_SHOPS.map((s) => s.id), ...SEED_SHOPS.flatMap((s) => s.items.map((i) => i.id)), ...SEED_USERS.map((u) => u.id)];
    assert.equal(new Set(ids).size, ids.length);
    for (const u of SEED_USERS) assert.equal(u.country, 'US', u.id);
    assert.deepEqual(
      SEED_CITIES.map((c) => c.id),
      ['sf', 'nyc'],
    );
  });
});

describe('location rules', () => {
  const shop = findShop(HERO.shopId)!;

  it('measures distance and travel time', () => {
    const near: [number, number] = [shop.lngLat[0] + 0.001, shop.lngLat[1]];
    const d = distanceMeters(shop.lngLat, near);
    assert.ok(d > 85 && d < 91, String(d)); // 0.001 degrees of longitude at 37.8 degrees north
    assert.equal(travelMinutes(shop.lngLat, near), 1);
  });

  it('lets Wei post from home but not a queuer across town', () => {
    const wei = SEED_USERS.find((u) => u.id === 'wei')!;
    assert.equal(rangeProblem({ lngLat: wei.home!, accuracyM: 20 }, shop.lngLat), null);
    assert.equal(rangeProblem({ lngLat: [-122.25, 37.8], accuracyM: 20 }, shop.lngLat), 'OUT_OF_RANGE'); // across the bay
  });

  it('checks in only inside the geofence with a usable fix', () => {
    assert.equal(geofenceProblem({ lngLat: shop.lngLat, accuracyM: 10 }, shop).problem, null);
    assert.equal(geofenceProblem({ lngLat: [shop.lngLat[0] + 0.002, shop.lngLat[1]], accuracyM: 10 }, shop).problem, 'OUTSIDE_GEOFENCE');
    assert.equal(geofenceProblem({ lngLat: shop.lngLat, accuracyM: 120 }, shop).problem, 'GPS_TOO_COARSE');
  });
});
