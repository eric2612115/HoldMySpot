import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  epochToZonedLocal,
  evaluateCheckIn,
  evaluatePurchase,
  hammingHex,
  normalizeCode,
  zonedLocalToEpoch,
  type PurchaseContext,
  type PurchaseReading,
} from './proofs.ts';
import { HERO, findItem, findShop } from './seed.ts';

const shop = findShop(HERO.shopId)!;
const item = findItem(HERO.itemId)!;
const at = (local: string) => zonedLocalToEpoch(local, 'America/Los_Angeles')!;

const ctx: PurchaseContext = {
  shop,
  item,
  job: { qty: 1, proofCode: 'K7M4P', retailCapCents: 3600, twdPerUsd: null },
  checkedInAt: at('2026-11-12 10:50'),
  uploadedAt: at('2026-11-12 11:42'),
  duplicateOf: null,
};

const genuine: PurchaseReading = {
  printedName: 'PAPER MOON TOYS',
  sellerTaxId: '41500017',
  invoiceNumber: 'PM-1112-0042',
  issuedAtLocal: '2026-11-12 11:41',
  currency: 'USD',
  lines: [{ name: 'MOCHI BUNNY PLUSH SAKURA', qty: 1, unitMinor: 3400, totalMinor: 3400 }],
  totalMinor: 3400,
  qr: { invoiceNumber: 'PM-1112-0042', issuedDate: '2026-11-12', sellerTaxId: '41500017', totalMinor: 3400 },
  itemPhoto: { codeSeen: 'k7m4p', unitsVisible: 1 },
  anomalies: [],
  generatorMetadata: false,
};

describe('time helpers', () => {
  it('converts shop-local times both ways', () => {
    const t = at('2026-11-12 11:41');
    assert.equal(new Date(t).toISOString(), '2026-11-12T19:41:00.000Z');
    assert.equal(epochToZonedLocal(t, 'America/Los_Angeles'), '2026-11-12 11:41');
    assert.equal(epochToZonedLocal(Date.parse('2026-11-12T01:41:00Z'), 'Asia/Taipei'), '2026-11-12 09:41');
    assert.equal(new Date(zonedLocalToEpoch('2026-11-11 19:31', 'America/New_York')!).toISOString(), '2026-11-12T00:31:00.000Z');
  });

  it('folds look-alike characters and counts hash bits', () => {
    assert.equal(normalizeCode('k7-m4 p'), 'K7M4P');
    assert.equal(normalizeCode('S0'), normalizeCode('5O'));
    assert.equal(hammingHex('ff00', 'ff01'), 1);
  });
});

describe('purchase proof rules', () => {
  it('passes the genuine plush receipt at $34.00', () => {
    const v = evaluatePurchase(genuine, ctx);
    assert.equal(v.status, 'passed', JSON.stringify(v.checks.filter((c) => !c.ok)));
    assert.equal(v.retailCents, 3400);
    assert.equal(v.summary, 'Receipt matches Paper Moon Toys at 11:41.');
  });

  it("fails Rex's fake receipt on exactly four checks", () => {
    const fake: PurchaseReading = {
      ...genuine,
      sellerTaxId: '41500093',
      issuedAtLocal: '2026-11-12 10:41',
      lines: [{ name: 'MOCHI BUNNY PLUSH SAKURA', qty: 1, unitMinor: 3400, totalMinor: 3400 }],
      totalMinor: 3600,
      qr: { invoiceNumber: 'PM-1112-0042', issuedDate: '2026-11-12', sellerTaxId: '41500093', totalMinor: 3600 },
    };
    const v = evaluatePurchase(fake, { ...ctx, checkedInAt: at('2026-11-12 10:57'), duplicateOf: 'file_0001' });
    assert.equal(v.status, 'failed');
    assert.deepEqual(
      v.checks.filter((c) => !c.ok).map((c) => c.code),
      ['shop_match', 'time_window', 'totals_add_up', 'duplicate_photo'],
    );
    assert.equal(v.summary, 'Receipt failed 4 checks: shop, printed time, totals, recycled photo.');
  });

  it('sends a receipt above the retail cap to a person', () => {
    const over: PurchaseReading = {
      ...genuine,
      lines: [{ name: 'MOCHI BUNNY PLUSH SAKURA', qty: 1, unitMinor: 3800, totalMinor: 3800 }],
      totalMinor: 3800,
      qr: { ...genuine.qr!, totalMinor: 3800 },
    };
    const v = evaluatePurchase(over, ctx);
    assert.equal(v.status, 'needs_review');
    assert.equal(v.retailCents, 3800);
    assert.deepEqual(v.checks.filter((c) => !c.ok).map((c) => c.code), ['within_retail_cap']);
  });

  it('checks a bakery receipt by printed name, without a QR', () => {
    const ny = findShop('petal-crumb-bakery')!;
    const nyItem = findItem('cake-petal-crumb')!;
    const v = evaluatePurchase(
      {
        ...genuine,
        printedName: 'Petal & Crumb Bakery, Prince St',
        sellerTaxId: null,
        issuedAtLocal: '2026-11-12 10:05',
        currency: 'USD',
        lines: [{ name: 'STRAWBERRY SHORTCAKE', qty: 1, unitMinor: 3800, totalMinor: 3800 }],
        totalMinor: 3800,
        qr: null,
      },
      {
        shop: ny,
        item: nyItem,
        job: { qty: 1, proofCode: 'K7M4P', retailCapCents: 4000, twdPerUsd: null },
        checkedInAt: zonedLocalToEpoch('2026-11-12 09:40', ny.timezone),
        uploadedAt: zonedLocalToEpoch('2026-11-12 10:06', ny.timezone)!,
        duplicateOf: null,
      },
    );
    assert.equal(v.status, 'passed', JSON.stringify(v.checks.filter((c) => !c.ok)));
    assert.equal(v.retailCents, 3800);
    assert.ok(!v.checks.some((c) => c.code === 'qr_matches_print'));
  });
});

describe('line photo rules', () => {
  it('passes with the code and a line, fails without the code', () => {
    const base = { code: 'K7M4P', geofence: { ok: true, distanceM: 12, radiusM: 80 }, duplicateOf: null };
    const ok = evaluateCheckIn({ lineVisible: true, peopleAhead: 40, codeSeen: 'K7M4P', storefrontText: null }, base);
    assert.equal(ok.status, 'passed');
    assert.equal(ok.peopleAhead, 40);
    const bad = evaluateCheckIn({ lineVisible: true, peopleAhead: 40, codeSeen: null, storefrontText: null }, base);
    assert.equal(bad.status, 'failed');
    const review = evaluateCheckIn({ lineVisible: false, peopleAhead: null, codeSeen: 'K7M4P', storefrontText: null }, base);
    assert.equal(review.status, 'needs_review');
  });
});
