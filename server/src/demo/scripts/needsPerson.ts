import { DEMO_MARKET_START, DEMO_TIME_ZONE, HERO, findShop } from '@holdmyspot/shared';
import type { Destination, LngLat } from '@holdmyspot/shared';
import { checkIn } from '../../app/asks.ts';
import { authorizeBid, claimBid, createBid, quoteBid } from '../../app/bids.ts';
import { requestRefund, syncDisputes } from '../../app/disputes.ts';
import { handover, markBought, submitProof } from '../../app/jobs.ts';
import { captureEntries } from '../../app/money.ts';
import type { DemoScript, DemoStep, StepContext } from '../director.ts';
import { pinFixtureCode } from '../fixtures.ts';

/**
 * The "Needs a person" page's scripted moment on the live zero-key server
 * (D-160): three separate errands end with exactly one receipt to review, one
 * refund request and one open dispute. It is its own market, so the hero day's
 * money does not change. PayPal here is the emulator.
 */

const petal = findShop('petal-crumb-bakery')!;
const paperMoon = findShop(HERO.shopId)!;
const REPRINT = '_reprint-at-cap';
const WEI_LINE = 'checkin-paper-moon-wei';
const NYC: Destination = { mode: 'local', cityId: 'nyc' };
const SHIP: Destination = { mode: 'ship', country: 'US', region: 'NY', city: 'New York', postalCode: '10012' };

interface Errand {
  ref: string;
  requester: string;
  queuer: string;
  shopId: string;
  itemId: string;
  destination: Destination;
  fee: number;
}

const RECEIPT: Errand = { ref: 'receipt', requester: 'mia', queuer: 'wei', shopId: HERO.shopId, itemId: HERO.itemId, destination: SHIP, fee: 1200 };
const REFUND: Errand = { ref: 'refund', requester: 'jun', queuer: 'dana', shopId: petal.id, itemId: 'cake-petal-crumb', destination: NYC, fee: 900 };
const DISPUTE: Errand = { ref: 'dispute', requester: 'priya', queuer: 'mo', shopId: petal.id, itemId: 'cake-petal-crumb', destination: NYC, fee: 900 };

async function placeBid(ctx: StepContext, e: Errand): Promise<void> {
  const requester = ctx.user(e.requester);
  const quote = await quoteBid(ctx.app, requester, { shopId: e.shopId, itemId: e.itemId, qty: 1, destination: e.destination });
  const created = await createBid(ctx.app, requester, {
    shopId: e.shopId,
    itemId: e.itemId,
    qty: 1,
    retailCapCents: e === RECEIPT ? 3600 : quote.suggested.retailCapCents,
    maxFeeCents: e.fee,
    shippingBudgetCents: e.destination.mode === 'ship' ? 1200 : 0,
    destination: e.destination,
    deadlineAt: ctx.time('20:00'),
    funding: 'paypal',
    agent: null,
  });
  ctx.refs.set(e.ref, created.bid.id);
  if (created.checkout.next === 'fake_approve') {
    await ctx.app.fakePayPal.approveOrder(created.checkout.orderId, 'paypal', 'approve');
    await authorizeBid(ctx.app, { userId: requester.id, ops: false }, created.bid.id, created.checkout.orderId);
  }
}

function takeBid(ctx: StepContext, e: Errand, etaHhmm: string): void {
  const queuer = ctx.user(e.queuer);
  claimBid(ctx.app, queuer, ctx.ref(e.ref), {
    qty: 1,
    etaAt: ctx.time(etaHhmm),
    modes: [e.destination.mode === 'ship' ? 'ship' : 'local'],
    from: { lngLat: queuer.home!, accuracyM: 10 },
  });
}

async function checkInAt(ctx: StepContext, e: Errand, lngLat: LngLat, photoFixture: string | null): Promise<void> {
  const queuer = ctx.user(e.queuer);
  const claim = ctx.app.store.claims.first("queuer_id = ? AND shop_id = ? AND status = 'awaiting_arrival'", queuer.id, e.shopId)!;
  const photo = await ctx.photo(queuer.id, 'line_photo', photoFixture, `${e.ref}-line`, 'line_ok');
  checkIn(ctx.app, queuer, claim.id, { lngLat, accuracyM: 8, photoFileId: photo.id });
}

async function handOverCake(ctx: StepContext, e: Errand): Promise<void> {
  const job = ctx.job(e.queuer, e.requester);
  await handover(ctx.app, ctx.user(e.queuer), job.id, job.handoverCode ?? '');
}

async function genuineProof(ctx: StepContext, e: Errand): Promise<void> {
  const queuer = ctx.user(e.queuer);
  const job = ctx.job(e.queuer, e.requester);
  const receipt = await ctx.upload(queuer.id, 'receipt', `${job.id}-receipt`, 'genuine');
  const item = await ctx.upload(queuer.id, 'item_photo', `${job.id}-item`, 'genuine');
  submitProof(ctx.app, queuer, job.id, { receiptFileId: receipt.id, itemFileId: item.id });
}

const step = (at: string, kind: DemoStep['kind'], label: string, run: DemoStep['run']): DemoStep => ({ at, kind, label, run });

export const needsPersonScript: DemoScript = {
  id: 'needs-person',
  title: 'Three hard calls for a person',
  description:
    'Three errands end with one receipt the rules would not settle, one refund request and one open PayPal dispute: exactly one row of each kind on the ops console, #/people. Its own market; the hero day is untouched.',
  startsAt: DEMO_MARKET_START,
  timeZone: DEMO_TIME_ZONE,
  speed: 60,
  async setup(ctx) {
    pinFixtureCode(ctx.app, 'proof', `mia>wei@${paperMoon.id}`, REPRINT);
    pinFixtureCode(ctx.app, 'checkin', `wei@${paperMoon.id}`, WEI_LINE);
  },
  steps: [
    step('10:31', 'bid.create', "Three requests on PayPal holds: Mia's plush, Jun's and Priya's cakes", async (ctx) => {
      await placeBid(ctx, RECEIPT);
      await placeBid(ctx, REFUND);
      await placeBid(ctx, DISPUTE);
    }),
    step('10:33', 'bid.claim', 'Wei, Dana and Mo take them', async (ctx) => {
      takeBid(ctx, RECEIPT, '10:49');
      takeBid(ctx, REFUND, '10:44');
      takeBid(ctx, DISPUTE, '10:44');
    }),
    step('10:44', 'claim.checkIn', 'Dana and Mo check in at Petal & Crumb', async (ctx) => {
      await checkInAt(ctx, REFUND, petal.lngLat, null);
      await checkInAt(ctx, DISPUTE, petal.lngLat, null);
    }),
    step('10:50', 'claim.checkIn', 'Wei checks in at Paper Moon Toys', async (ctx) => {
      await checkInAt(ctx, RECEIPT, paperMoon.lngLat, `${WEI_LINE}/line.png`);
    }),
    step('11:05', 'job.bought', 'Dana and Mo buy the cakes', async (ctx) => {
      markBought(ctx.app, ctx.user(REFUND.queuer), ctx.job(REFUND.queuer, REFUND.requester).id);
      markBought(ctx.app, ctx.user(DISPUTE.queuer), ctx.job(DISPUTE.queuer, DISPUTE.requester).id);
    }),
    step('11:06', 'job.proof', 'Their receipts pass', async (ctx) => {
      await genuineProof(ctx, REFUND);
      await genuineProof(ctx, DISPUTE);
    }),
    step('11:30', 'job.handover', 'Both cakes handed over: one capture each', async (ctx) => {
      await handOverCake(ctx, REFUND);
      await handOverCake(ctx, DISPUTE);
    }),
    step('11:41', 'job.bought', 'Wei buys the plush', async (ctx) => {
      markBought(ctx.app, ctx.user(RECEIPT.queuer), ctx.job(RECEIPT.queuer, RECEIPT.requester).id);
    }),
    step('11:42', 'job.proof', 'A receipt reprinted at the cap: the listed-price check sends it to a person', async (ctx) => {
      const wei = ctx.user(RECEIPT.queuer);
      const job = ctx.job(RECEIPT.queuer, RECEIPT.requester);
      const receipt = await ctx.photo(wei.id, 'receipt', `${REPRINT}/receipt.png`, `${job.id}-receipt`, 'unreadable');
      const item = await ctx.photo(wei.id, 'item_photo', `${REPRINT}/item.png`, `${job.id}-item`, 'unreadable');
      submitProof(ctx.app, wei, job.id, { receiptFileId: receipt.id, itemFileId: item.id });
    }),
    step('11:43', 'job.refund_request', 'Jun asks for money back: the cake box was crushed', async (ctx) => {
      const job = ctx.job(REFUND.queuer, REFUND.requester);
      requestRefund(ctx.app, ctx.user(REFUND.requester), job.id, 'The cake box was crushed at the handover; the top layer is ruined.');
    }),
    step('11:44', 'dispute.open', 'Priya opens a PayPal dispute: item not received', async (ctx) => {
      const job = ctx.job(DISPUTE.queuer, DISPUTE.requester);
      const capture = captureEntries(ctx.app, job.id)[0]?.paypal?.captureId;
      if (!capture) throw new Error(`No capture on ${job.id}.`);
      ctx.app.fakePayPal.openDispute(capture, { stage: 'INQUIRY' });
      await syncDisputes(ctx.app, { queued: true });
    }),
  ],
};
