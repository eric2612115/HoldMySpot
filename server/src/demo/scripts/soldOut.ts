import { DEMO_MARKET_START, DEMO_SPEED, DEMO_TIME_ZONE, HERO, findShop, formatUsd } from '@holdmyspot/shared';
import type { Hold } from '@holdmyspot/shared';
import { claimBid } from '../../app/bids.ts';
import { reportSoldOut } from '../../app/jobs.ts';
import type { DemoScript, StepContext } from '../director.ts';
import { heroScript, miaAuthorized, miaHolds, rexChecksIn, rexTakesPriya, weiChecksIn } from './hero.ts';

/**
 * Paper Moon Toys sells out of the Mochi Bunny plush (D-152): on the hero's morning, Mia holds $63.70 and
 * Wei takes her request, Rex takes Priya's, and both check in. Rex reports the plush sold out: one report
 * ends only his own job. Wei confirms: two independent checked-in queuers have reported it, so the book
 * closes, every unbought job ends, and PayPal releases every hold on the plush with nothing charged.
 */

const shop = findShop(HERO.shopId)!;
const usd = (cents: number) => formatUsd(cents, { exact: true });

/** The holds on the plush, from the ledger the phones read. */
function plushHolds(ctx: StepContext) {
  return ctx.app.store.bids
    .where('item_id = ?', HERO.itemId)
    .map((b) => (b.holdId ? ctx.app.store.holds.get(b.holdId) : null))
    .filter((h): h is Hold => h !== null);
}

export const soldOutScript: DemoScript = {
  id: 'sold-out',
  title: 'Sold out at Paper Moon Toys',
  description:
    'Mia holds $63.70 for the Mochi Bunny plush; Wei takes her request and Rex takes Priya\'s, and both check in. Rex reports the plush sold out: only his own job ends. Wei confirms it: the book closes, every hold on the plush is released, and $0 is charged.',
  startsAt: DEMO_MARKET_START,
  timeZone: DEMO_TIME_ZONE,
  speed: DEMO_SPEED,
  // The hero's morning: the codes the rendered line photos show, and Priya's resting request.
  setup: (ctx) => heroScript.setup!(ctx),
  steps: [
    miaHolds,
    miaAuthorized,
    rexTakesPriya,
    {
      at: '10:35',
      kind: 'bid.claim',
      label: "Wei takes Mia's request at $12",
      async run(ctx) {
        const wei = ctx.user(HERO.queuerId);
        claimBid(ctx.app, wei, ctx.ref('miaBid'), { qty: 1, etaAt: ctx.time('10:50'), modes: ['ship'], from: { lngLat: wei.home!, accuracyM: 10 } });
        ctx.walk(wei.id, shop.lngLat, ctx.time('10:49'));
      },
    },
    weiChecksIn,
    rexChecksIn,
    {
      at: '11:00',
      kind: 'job.sold_out',
      label: 'Rex reports the plush sold out: only his own job ends',
      async run(ctx) {
        await reportSoldOut(ctx.app, ctx.user(HERO.fakeReceiptQueuerId), ctx.job(HERO.fakeReceiptQueuerId, 'priya').id, null);
        ctx.cue({ name: 'focus_shop', target: HERO.shopId, text: 'One report ends only the reporter\'s own job: every other request stays held.' });
      },
    },
    {
      at: '11:02',
      kind: 'job.sold_out',
      label: 'Wei confirms: the book closes and every hold on the plush is released',
      async run(ctx) {
        await reportSoldOut(ctx.app, ctx.user(HERO.queuerId), ctx.job(HERO.queuerId, HERO.requesterId).id, null);
      },
    },
    {
      at: '11:03',
      kind: 'cue',
      label: 'Closing numbers',
      async run(ctx) {
        const holds = plushHolds(ctx);
        const released = holds.filter((h) => h.status === 'released');
        const charged = holds.reduce((n, h) => n + h.capturedCents, 0);
        const text = `${shop.name} sold out. ${released.length} holds released (${usd(released.reduce((n, h) => n + h.releasedCents, 0))}). Charged ${usd(charged)}.`;
        ctx.cue({ name: 'caption', target: null, text });
      },
    },
  ],
};
