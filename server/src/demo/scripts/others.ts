import { DAY_MS, DEMO_TIME_ZONE, HERO, findShop, formatUsd } from '@holdmyspot/shared';
import { checkIn } from '../../app/asks.ts';
import { authorizeBid, claimBid, createBid, quoteBid } from '../../app/bids.ts';
import { handover, markBought, submitProof } from '../../app/jobs.ts';
import type { DemoScript } from '../director.ts';

/** Shorter demo scripts: a New York local errand, and a hold renewal on day 4. */

const petal = findShop('petal-crumb-bakery')!;

export const localErrandScript: DemoScript = {
  id: 'local-errand',
  title: 'Shortcake errand in New York',
  description:
    "Jun asks for a shortcake; Dana takes it at $9, checks in, buys at $38.00 and hands it over with Jun's code. One capture of $49.47 ($47.00 plus $2.47 processing at cost); Dana is paid $46.10.",
  startsAt: '2026-11-12T09:30:00-05:00',
  timeZone: 'America/New_York',
  speed: 60,
  steps: [
    {
      at: '09:31',
      kind: 'bid.create',
      label: 'Jun asks for a shortcake: fee up to $9',
      async run(ctx) {
        const jun = ctx.user('jun');
        const destination = { mode: 'local' as const, cityId: 'nyc' as const };
        const quote = await quoteBid(ctx.app, jun, { shopId: petal.id, itemId: 'cake-petal-crumb', qty: 1, destination });
        const created = await createBid(ctx.app, jun, {
          shopId: petal.id,
          itemId: 'cake-petal-crumb',
          qty: 1,
          retailCapCents: quote.suggested.retailCapCents,
          maxFeeCents: 900,
          shippingBudgetCents: 0,
          destination,
          deadlineAt: ctx.time('18:00'),
          funding: 'venmo',
          agent: null,
        });
        ctx.refs.set('junBid', created.bid.id);
        if (created.checkout.next === 'fake_approve') {
          await ctx.app.fakePayPal.approveOrder(created.checkout.orderId, 'venmo', 'approve');
          await authorizeBid(ctx.app, { userId: jun.id, ops: false }, created.bid.id, created.checkout.orderId);
        }
      },
    },
    {
      at: '09:31',
      kind: 'wait_for',
      label: "Jun's hold is authorized",
      until: (ctx) => ctx.app.store.bids.must(ctx.ref('junBid')).status !== 'awaiting_approval',
      async run() {},
    },
    {
      at: '09:33',
      kind: 'bid.claim',
      label: 'Dana takes the errand',
      async run(ctx) {
        const dana = ctx.user('dana');
        claimBid(ctx.app, dana, ctx.ref('junBid'), { qty: 1, etaAt: ctx.time('09:45'), modes: ['local'], from: { lngLat: dana.home!, accuracyM: 10 } });
        ctx.walk(dana.id, petal.lngLat, ctx.time('09:44'));
      },
    },
    {
      at: '09:44',
      kind: 'claim.checkIn',
      label: 'Dana checks in',
      async run(ctx) {
        const dana = ctx.user('dana');
        const claim = ctx.app.store.claims.first("queuer_id = 'dana' AND status = 'awaiting_arrival'")!;
        const photo = await ctx.upload(dana.id, 'line_photo', 'dana-line', 'line_ok');
        checkIn(ctx.app, dana, claim.id, { lngLat: petal.lngLat, accuracyM: 6, photoFileId: photo.id });
      },
    },
    {
      at: '10:05',
      kind: 'job.bought',
      label: 'Dana buys the cake',
      async run(ctx) {
        markBought(ctx.app, ctx.user('dana'), ctx.job('dana', 'jun').id);
      },
    },
    {
      at: '10:06',
      kind: 'job.proof',
      label: 'USD receipt checked',
      async run(ctx) {
        const dana = ctx.user('dana');
        const job = ctx.job('dana', 'jun');
        const receipt = await ctx.upload(dana.id, 'receipt', `${job.id}-receipt`, 'genuine');
        const photo = await ctx.upload(dana.id, 'item_photo', `${job.id}-item`, 'genuine');
        submitProof(ctx.app, dana, job.id, { receiptFileId: receipt.id, itemFileId: photo.id });
      },
    },
    {
      at: '10:30',
      kind: 'job.handover',
      label: "Handover with Jun's code: one capture of $49.47",
      async run(ctx) {
        const job = ctx.job('dana', 'jun');
        await handover(ctx.app, ctx.user('dana'), job.id, job.handoverCode ?? '');
        // Built from the ledger: held $51.54, charged $49.47, Dana paid $46.10.
        const hold = ctx.app.store.holds.must(ctx.app.store.bids.must(ctx.ref('junBid')).holdId!);
        const paid = ctx.app.store.payouts.where('job_id = ?', job.id).reduce((s, p) => s + p.amount.cents, 0);
        const usd = (c: number) => formatUsd(c, { exact: true });
        ctx.cue({ name: 'show_ledger', target: 'jun', text: `Held ${usd(hold.amount.cents)}. Charged ${usd(hold.capturedCents)}. Dana paid ${usd(paid)}.` });
      },
    },
  ],
};

export const renewalScript: DemoScript = {
  id: 'renewal',
  title: 'A hold renewed on day 4',
  description: 'Leo holds a 9-day request for the Mochi Bunny plush. PayPal honors a hold for 3 days, so on day 4 the server reauthorizes it: a new authorization id, the same amount.',
  startsAt: '2026-11-12T10:00:00-08:00',
  timeZone: DEMO_TIME_ZONE,
  speed: 60,
  steps: [
    {
      at: '10:01',
      kind: 'bid.create',
      label: 'Leo holds a 9-day request',
      async run(ctx) {
        const leo = ctx.user('leo');
        const destination = { mode: 'local' as const, cityId: 'sf' as const };
        const quote = await quoteBid(ctx.app, leo, { shopId: HERO.shopId, itemId: HERO.itemId, qty: 1, destination });
        const created = await createBid(ctx.app, leo, {
          shopId: HERO.shopId,
          itemId: HERO.itemId,
          qty: 1,
          retailCapCents: quote.suggested.retailCapCents,
          maxFeeCents: 900,
          shippingBudgetCents: 0,
          destination,
          deadlineAt: ctx.time('10:01') + 9 * DAY_MS,
          funding: 'paypal',
          agent: null,
        });
        ctx.refs.set('leoBid', created.bid.id);
        if (created.checkout.next === 'fake_approve') {
          await ctx.app.fakePayPal.approveOrder(created.checkout.orderId, 'paypal', 'approve');
          await authorizeBid(ctx.app, { userId: leo.id, ops: false }, created.bid.id, created.checkout.orderId);
        }
      },
    },
    {
      at: '10:02',
      kind: 'clock.jump',
      label: 'Three days later',
      async run(ctx) {
        const t = ctx.time('10:05') + 3 * DAY_MS;
        if (t > ctx.app.clock.now()) ctx.app.clock.jumpTo(t);
        ctx.cue({ name: 'show_ledger', target: 'leo', text: 'Day 4: the 3-day honor period is over, so the hold is renewed.' });
      },
    },
  ],
};
