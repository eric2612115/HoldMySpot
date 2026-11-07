import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HERO, zonedLocalToEpoch } from '@holdmyspot/shared';
import type { BookSnapshot } from '@holdmyspot/shared';
import { testServer, type TestServer } from './helpers.ts';

/**
 * The book snapshot says what PayPal holds at each request level (D-111), so
 * the web app's order book can show requests as money without seeing single
 * requests: each level's held amount is the sum of its requests' holds.
 */

const sf = (hhmm: string) => zonedLocalToEpoch(`2026-11-12 ${hhmm}`, 'America/Los_Angeles')!;

describe('book snapshot: money held at each request level', () => {
  let s: TestServer;
  const book = async (): Promise<BookSnapshot> => (await s.call('GET', `/api/books/${HERO.shopId}/${HERO.itemId}`)).json.book;
  /** What PayPal holds now for the live requests at a fee, read from the holds themselves. */
  const heldAt = (feeCents: number) =>
    s.app.store.bids
      .where("item_id = ? AND status IN ('open', 'partially_matched')", HERO.itemId)
      .filter((b) => b.maxFeeCents === feeCents && b.remainingQty > 0 && b.holdId)
      .map((b) => s.app.store.holds.must(b.holdId!))
      .reduce((sum, h) => sum + h.amount.cents - h.capturedCents - h.releasedCents, 0);

  before(async () => {
    s = await testServer({ demo: true, crowd: true });
    await s.director!.start('hero', null);
    s.app.clock.pause();
    await s.at(sf('10:52'));
  });
  after(() => s.done());

  it("puts Mia's whole hold behind the best level once Wei is in line", async () => {
    const levels = (await book()).bids.levels;
    const mia = s.app.store.bids.first("requester_id = 'mia'")!;
    assert.equal(levels[0]?.feeCents, mia.maxFeeCents);
    assert.equal(levels[0]?.count, 1);
    assert.equal(levels[0]?.heldCents, s.app.store.holds.must(mia.holdId!).amount.cents);
  });

  it('sums the holds of every request at each level', async () => {
    const levels = (await book()).bids.levels;
    assert.ok(levels.length >= 3);
    for (const l of levels) {
      assert.equal(l.heldCents, heldAt(l.feeCents), `level ${l.feeCents}`);
      assert.ok((l.heldCents ?? 0) > l.qty * l.feeCents, 'a hold covers the shop price as well as the fee');
    }
  });

  it("drops Mia's level when Wei's clock meets it at 11:05", async () => {
    await s.at(sf('11:06'));
    const levels = (await book()).bids.levels;
    assert.ok(levels.every((l) => l.feeCents < 1200));
    for (const l of levels) assert.equal(l.heldCents, heldAt(l.feeCents));
  });
});
