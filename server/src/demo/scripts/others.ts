import { DAY_MS, DEMO_MARKET_START, DEMO_TIME_ZONE, HERO, SCRIPTED_MODEL, findShop, formatUsd } from '@holdmyspot/shared';
import { applyAgentResult } from '../../app/agent.ts';
import { checkIn } from '../../app/asks.ts';
import { authorizeBid, claimBid, createBid, quoteBid } from '../../app/bids.ts';
import { handover, markBought, submitProof } from '../../app/jobs.ts';
import type { AgentRunResult } from '../../ports/ai.ts';
import type { DemoScript, StepContext } from '../director.ts';

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
  cast: { requester: 'jun', queuer: 'dana' },
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

/**
 * The bidding agent on the phone, with no key and no model (D-158): Mia holds for a $12 max fee, the
 * decisions are written here in advance and stamped as scripted, and each one goes through the server's
 * own check. The last asks for $14: the hold does not cover it, so the server refuses it.
 */
function scriptedAgentRun(ctx: StepContext, fromFeeCents: number, toFeeCents: number, reason: string, nextRunAt: number | null): Promise<unknown> {
  const result: AgentRunResult = {
    decision: { kind: toFeeCents < fromFeeCents ? 'lower_fee' : 'raise_fee', fromFeeCents, toFeeCents, qty: null, reason },
    toolCalls: [],
    refused: [],
    ceilingCents: 1200,
    nextRunAt,
    decidedBy: 'policy',
    ai: { provider: 'fake', model: SCRIPTED_MODEL, mode: 'fake', latencyMs: 0 },
  };
  return applyAgentResult(ctx.app, ctx.ref('miaBid'), result, null);
}

export const feeAgentScript: DemoScript = {
  id: 'fee-agent',
  title: 'The fee agent works inside the hold',
  description:
    'Mia holds $63.70 for a plush with a $12 max fee and lets the agent set it. Scripted decisions, no AI: $10, $11, $12, then $14, which the server refuses because PayPal does not hold it. No queuer takes it; nothing is charged.',
  startsAt: DEMO_MARKET_START,
  timeZone: DEMO_TIME_ZONE,
  speed: 60,
  steps: [
    {
      at: '10:31',
      kind: 'bid.create',
      label: 'Mia holds for a $12 max fee and turns the agent on',
      async run(ctx) {
        const mia = ctx.user(HERO.requesterId);
        const destination = { mode: 'ship' as const, country: 'US' as const, region: 'NY', city: 'New York', postalCode: '10012' };
        const quote = await quoteBid(ctx.app, mia, { shopId: HERO.shopId, itemId: HERO.itemId, qty: 1, destination });
        const created = await createBid(ctx.app, mia, {
          shopId: HERO.shopId,
          itemId: HERO.itemId,
          qty: 1,
          retailCapCents: quote.suggested.retailCapCents,
          maxFeeCents: 1200,
          shippingBudgetCents: quote.suggested.shippingBudgetCents,
          destination,
          deadlineAt: ctx.time('10:31') + 2 * DAY_MS,
          funding: 'paypal',
          agent: { goal: 'As cheap as I can get it, never above my max fee.' },
        });
        ctx.refs.set('miaBid', created.bid.id);
        // The script decides from here: the scheduler must not run the written policy in between.
        ctx.app.tx(() => {
          const b = ctx.app.store.bids.must(created.bid.id);
          b.agent = { ...b.agent!, nextRunAt: null };
          ctx.app.store.bids.update(b);
        });
        if (created.checkout.next === 'fake_approve') {
          await ctx.app.fakePayPal.approveOrder(created.checkout.orderId, 'paypal', 'approve');
          await authorizeBid(ctx.app, { userId: mia.id, ops: false }, created.bid.id, created.checkout.orderId);
        }
      },
    },
    {
      at: '10:31',
      kind: 'wait_for',
      label: "Mia's hold is authorized",
      until: (ctx) => ctx.app.store.bids.must(ctx.ref('miaBid')).status !== 'awaiting_approval',
      async run() {},
    },
    {
      at: '10:33',
      kind: 'agent.run',
      label: 'The agent opens at $10',
      run: (ctx) => scriptedAgentRun(ctx, 1200, 1000, 'No queuer is in line yet, so it opens at $10.00 instead of your whole max.', ctx.time('23:00')).then(() => undefined),
    },
    {
      at: '10:37',
      kind: 'agent.run',
      label: 'The agent raises to $11',
      run: (ctx) => scriptedAgentRun(ctx, 1000, 1100, 'No offer has come near $10.00, so it adds a dollar.', ctx.time('23:00')).then(() => undefined),
    },
    {
      at: '10:41',
      kind: 'agent.run',
      label: 'The agent raises to $12',
      run: (ctx) => scriptedAgentRun(ctx, 1100, 1200, 'Still no offer, so it goes up to your max.', ctx.time('23:00')).then(() => undefined),
    },
    {
      at: '10:45',
      kind: 'agent.run',
      label: 'The agent asks for $14 and is refused',
      run: (ctx) => scriptedAgentRun(ctx, 1200, 1400, 'Tries $14.00 to win a queuer sooner.', null).then(() => undefined),
    },
  ],
};
