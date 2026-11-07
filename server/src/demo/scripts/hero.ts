import { DEMO_MARKET_START, DEMO_SPEED, DEMO_TIME_ZONE, HERO, findShop, formatUsd, travelMinutes } from '@holdmyspot/shared';
import type { LngLat } from '@holdmyspot/shared';
import { createAsk, checkIn } from '../../app/asks.ts';
import { authorizeBid, claimBid, createBid, quoteBid } from '../../app/bids.ts';
import { saveUpload } from '../../app/files.ts';
import { addShipment, markBought, submitProof } from '../../app/jobs.ts';
import { placeholderPng } from '../../util/images.ts';
import type { DemoScript, StepContext } from '../director.ts';
import { pinFixtureCode, stageHistory, uploadFixtureOr, uploadHash } from '../fixtures.ts';

/**
 * The hero run (docs/ARCHITECTURE.md section 8, amounts from docs/DOMAIN.md
 * section 7): Mia in New York holds $63.70 for the Mochi Bunny plush from
 * Paper Moon Toys in San Francisco's Japantown, shipped to her (one per
 * customer). Wei's fee clock steps down from $15 and meets her $12 request;
 * Rex's fake receipt moves $0 and Priya's request goes back to the book,
 * where Lin's $10 offer takes it. Mia is charged $58.26 in two captures (the
 * second after tracking; processing and payouts at cost included, D-105) and
 * $5.44 is released.
 *
 * Photos: where a rendered fixture exists (server/fixtures/proofs) the queuer
 * uploads it and the script pins the code it shows on the claim or job, so the
 * AI services read the real photo (QR, hashes, duplicate check, shared rules).
 * Each upload still names its scenario, which the rules-only fake AI uses when
 * it is the loaded port (HMS_AI_PROVIDER=fake) or when a fixture is missing.
 */

const shop = findShop(HERO.shopId)!;
const AT_SHOP: LngLat = shop.lngLat;
const RECYCLED = 'rex-item-photo-older-job';

/** Rendered fixtures of the hero: the case folder for each claim or job, keyed by who and where. */
const CHECK_IN_FIXTURES: Record<string, string> = { wei: 'checkin-paper-moon-wei', rex: 'checkin-paper-moon-rex' };
const PROOF_FIXTURES: Record<string, string> = {
  'mia>wei': 'paper-moon-mia-genuine',
  'priya>lin': 'paper-moon-priya-genuine',
  'priya>rex': 'paper-moon-rex-fake',
};
/** Rex's item photo is one he already used for an older job (the same file). */
const REX_ITEM = 'paper-moon-rex-fake/item.png';

async function rexOlderItemPhoto(ctx: StepContext, historical: boolean, scenario: string | null) {
  return uploadFixtureOr(ctx.app, HERO.fakeReceiptQueuerId, 'item_photo', REX_ITEM, scenario, () =>
    saveUpload(ctx.app, HERO.fakeReceiptQueuerId, 'item_photo', 'image/png', placeholderPng(`hero/${RECYCLED}`), { scenario, historical, dHash: uploadHash(ctx.app) }),
  { historical },
  );
}

async function proofFor(ctx: StepContext, queuerId: string, requesterId: string, scenario: string | null): Promise<void> {
  const job = ctx.job(queuerId, requesterId);
  const fixture = PROOF_FIXTURES[`${requesterId}>${queuerId}`] ?? null;
  const receipt = await ctx.photo(queuerId, 'receipt', fixture && `${fixture}/receipt.png`, `${job.id}-receipt`, scenario);
  const photo = await ctx.photo(queuerId, 'item_photo', fixture && `${fixture}/item.png`, `${job.id}-item`, scenario);
  submitProof(ctx.app, ctx.user(queuerId), job.id, { receiptFileId: receipt.id, itemFileId: photo.id });
}

export const heroScript: DemoScript = {
  id: 'hero',
  title: 'A plush drop in Japantown, shipped to New York',
  description:
    "Mia in New York holds $63.70 for the Mochi Bunny plush from Paper Moon Toys in San Francisco. Wei checks in and his fee clock meets her $12 request. Rex fakes a receipt: $0 moves and Priya's request goes back to the book, where Lin takes it at $10. Mia is charged $58.26, processing at cost included; the rest is released.",
  startsAt: DEMO_MARKET_START,
  timeZone: DEMO_TIME_ZONE,
  speed: DEMO_SPEED,
  async setup(ctx) {
    // The codes the rendered photos show (deterministic demo markets only).
    for (const [queuerId, caseId] of Object.entries(CHECK_IN_FIXTURES)) pinFixtureCode(ctx.app, 'checkin', `${queuerId}@${HERO.shopId}`, caseId);
    for (const [pair, caseId] of Object.entries(PROOF_FIXTURES)) pinFixtureCode(ctx.app, 'proof', `${pair}@${HERO.shopId}`, caseId);
    // Earlier uploads by other queuers, and an item photo Rex uploaded for an older job:
    // his "new" photo will be the same file.
    await stageHistory(ctx.app);
    await ctx.app.atTime(ctx.app.now() - 7 * 24 * 60 * 60_000, () => rexOlderItemPhoto(ctx, true, null));
    const priya = ctx.app.store.bids.first("requester_id = 'priya' AND item_id = ?", HERO.itemId);
    if (priya) ctx.refs.set('priyaBid', priya.id);
  },
  steps: [
    {
      at: '10:30',
      kind: 'cue',
      label: 'Requests light up the map',
      async run(ctx) {
        ctx.cue({ name: 'focus_shop', target: HERO.shopId, text: 'Requests light up the map before anyone queues.' });
      },
    },
    {
      at: '10:31',
      kind: 'bid.create',
      label: 'Mia holds $63.70 for one plush, shipped to New York',
      async run(ctx) {
        const mia = ctx.user(HERO.requesterId);
        const destination = { mode: 'ship' as const, country: 'US' as const, region: 'NY', city: 'New York', postalCode: '10012' };
        const quote = await quoteBid(ctx.app, mia, { shopId: HERO.shopId, itemId: HERO.itemId, qty: 1, destination });
        const created = await createBid(ctx.app, mia, {
          shopId: HERO.shopId,
          itemId: HERO.itemId,
          qty: 1,
          retailCapCents: quote.suggested.retailCapCents,
          maxFeeCents: quote.suggested.maxFeeCents,
          shippingBudgetCents: quote.suggested.shippingBudgetCents,
          destination,
          deadlineAt: ctx.time('10:31') + 2 * 24 * 60 * 60_000,
          funding: 'paypal',
          agent: null,
        });
        ctx.refs.set('miaBid', created.bid.id);
        if (created.checkout.next === 'fake_approve') {
          await ctx.app.fakePayPal.approveOrder(created.checkout.orderId, 'paypal', 'approve');
          await authorizeBid(ctx.app, { userId: mia.id, ops: false }, created.bid.id, created.checkout.orderId);
        }
      },
    },
    {
      at: '10:31',
      kind: 'wait_for',
      label: "Mia's hold is authorized (a sandbox run waits for the PayPal approval)",
      until: (ctx) => ctx.app.store.bids.must(ctx.ref('miaBid')).status !== 'awaiting_approval',
      async run(ctx) {
        const bid = ctx.app.store.bids.must(ctx.ref('miaBid'));
        ctx.cue({ name: 'show_ledger', target: HERO.requesterId, text: `PayPal holds up to ${formatUsd(bid.limitCents, { exact: true })}. Nothing is charged yet.` });
      },
    },
    {
      at: '10:33',
      kind: 'bid.claim',
      label: "Rex takes Priya's request at $11",
      async run(ctx) {
        const rex = ctx.user(HERO.fakeReceiptQueuerId);
        claimBid(ctx.app, rex, ctx.ref('priyaBid'), {
          qty: 1,
          etaAt: ctx.time('10:55'),
          modes: ['ship'],
          from: { lngLat: rex.home!, accuracyM: 12 },
        });
        ctx.walk(rex.id, AT_SHOP, ctx.time('10:55'));
      },
    },
    {
      at: '10:35',
      kind: 'ask.create',
      label: 'Wei offers to queue: $15, down $1 every 5 minutes to $8',
      async run(ctx) {
        const wei = ctx.user(HERO.queuerId);
        createAsk(ctx.app, wei, {
          shopId: HERO.shopId,
          itemId: HERO.itemId,
          capacity: 1,
          modes: ['local', 'ship'],
          feeCents: 1500,
          clock: { stepCents: 100, intervalMs: 5 * 60_000, floorCents: 800 },
          etaAt: ctx.time('10:50'),
          from: { lngLat: wei.home!, accuracyM: 10 },
        });
        ctx.walk(wei.id, AT_SHOP, ctx.time('10:49'));
        const minutes = travelMinutes(wei.home!, AT_SHOP, ctx.app.rules);
        ctx.cue({ name: 'focus_user', target: wei.id, text: `Offers are bound to a place: Wei is ${minutes} minutes away.` });
      },
    },
    {
      at: '10:50',
      kind: 'claim.checkIn',
      label: 'Wei checks in; his fee clock starts at $15',
      async run(ctx) {
        const wei = ctx.user(HERO.queuerId);
        const claim = ctx.app.store.claims.first("queuer_id = ? AND shop_id = ? AND status = 'awaiting_arrival'", wei.id, HERO.shopId)!;
        const photo = await ctx.photo(wei.id, 'line_photo', `${CHECK_IN_FIXTURES.wei}/line.png`, 'wei-line', 'line_ok');
        checkIn(ctx.app, wei, claim.id, { lngLat: AT_SHOP, accuracyM: 8, photoFileId: photo.id });
      },
    },
    {
      at: '10:57',
      kind: 'claim.checkIn',
      label: 'Rex checks in',
      async run(ctx) {
        const rex = ctx.user(HERO.fakeReceiptQueuerId);
        const claim = ctx.app.store.claims.first("queuer_id = ? AND shop_id = ? AND status = 'awaiting_arrival'", rex.id, HERO.shopId)!;
        const photo = await ctx.photo(rex.id, 'line_photo', `${CHECK_IN_FIXTURES.rex}/line.png`, 'rex-line', 'line_ok');
        checkIn(ctx.app, rex, claim.id, { lngLat: [AT_SHOP[0] + 0.0002, AT_SHOP[1]], accuracyM: 9, photoFileId: photo.id });
      },
    },
    {
      at: '11:05',
      kind: 'cue',
      label: "The clock reaches $12: Mia's request fills",
      async run(ctx) {
        ctx.cue({ name: 'focus_shop', target: HERO.shopId, text: "Wei's fee stepped down to $12 and met Mia's request." });
      },
    },
    {
      at: '11:16',
      kind: 'job.bought',
      label: 'Rex says he bought the plush',
      async run(ctx) {
        markBought(ctx.app, ctx.user('rex'), ctx.job('rex', 'priya').id);
      },
    },
    {
      at: '11:18',
      kind: 'job.proof',
      label: "Rex's receipt fails four checks: $0 moved",
      async run(ctx) {
        const rex = ctx.user('rex');
        const job = ctx.job('rex', 'priya');
        const receipt = await ctx.photo(rex.id, 'receipt', `${PROOF_FIXTURES['priya>rex']}/receipt.png`, `${job.id}-receipt`, 'fake_receipt');
        const photo = await rexOlderItemPhoto(ctx, false, 'fake_receipt');
        submitProof(ctx.app, rex, job.id, { receiptFileId: receipt.id, itemFileId: photo.id });
        ctx.cue({ name: 'show_receipt', target: job.id, text: "Fake receipt: $0 moved. Priya's request goes back to the book." });
      },
    },
    {
      at: '11:20',
      kind: 'ask.create',
      label: "Lin offers to queue at $10: Priya's request fills at once",
      async run(ctx) {
        const lin = ctx.user(HERO.nextQueuerId);
        createAsk(ctx.app, lin, {
          shopId: HERO.shopId,
          itemId: HERO.itemId,
          capacity: 1,
          modes: ['local', 'ship'],
          feeCents: 1000,
          clock: null,
          etaAt: ctx.time('11:30'),
          from: { lngLat: lin.home!, accuracyM: 10 },
        });
        ctx.walk(lin.id, AT_SHOP, ctx.time('11:29'));
      },
    },
    {
      at: '11:30',
      kind: 'claim.checkIn',
      label: 'Lin checks in',
      async run(ctx) {
        const lin = ctx.user(HERO.nextQueuerId);
        const claim = ctx.app.store.claims.first("queuer_id = ? AND shop_id = ? AND status = 'awaiting_arrival'", lin.id, HERO.shopId)!;
        const photo = await ctx.upload(lin.id, 'line_photo', 'lin-line', 'line_ok');
        checkIn(ctx.app, lin, claim.id, { lngLat: [AT_SHOP[0] - 0.0001, AT_SHOP[1]], accuracyM: 7, photoFileId: photo.id });
      },
    },
    {
      at: '11:38',
      kind: 'job.bought',
      label: 'Wei buys the plush for Mia',
      async run(ctx) {
        markBought(ctx.app, ctx.user('wei'), ctx.job('wei', HERO.requesterId).id);
      },
    },
    {
      at: '11:42',
      kind: 'job.proof',
      label: "Wei uploads Mia's receipt: capture $48.69",
      async run(ctx) {
        await proofFor(ctx, 'wei', HERO.requesterId, 'genuine');
      },
    },
    {
      at: '11:50',
      kind: 'job.bought',
      label: 'Lin buys the plush for Priya',
      async run(ctx) {
        markBought(ctx.app, ctx.user('lin'), ctx.job('lin', 'priya').id);
      },
    },
    {
      at: '11:52',
      kind: 'job.proof',
      label: "Lin uploads Priya's receipt: capture $46.62",
      async run(ctx) {
        await proofFor(ctx, 'lin', 'priya', 'genuine');
      },
    },
    {
      at: '11:53',
      kind: 'clock.jump',
      label: 'Later that day',
      async run(ctx) {
        ctx.jumpTo('13:58');
      },
    },
    {
      at: '14:00',
      kind: 'job.shipment',
      label: "Wei ships Mia's parcel: final capture $9.57",
      async run(ctx) {
        const job = ctx.job('wei', HERO.requesterId);
        const label = await ctx.upload('wei', 'label', `${job.id}-label`, null);
        await addShipment(ctx.app, ctx.user('wei'), job.id, {
          carrierName: 'Harbor Parcel Ground',
          trackingNumber: 'HPG-2611-1200-0042',
          shippingCostCents: 875,
          dutyPaidCents: 0,
          labelFileId: label.id,
        });
      },
    },
    {
      at: '14:01',
      kind: 'cue',
      label: 'Closing numbers',
      async run(ctx) {
        const bid = ctx.app.store.bids.must(ctx.ref('miaBid'));
        const hold = ctx.app.store.holds.must(bid.holdId!);
        const rexJob = ctx.job('rex', 'priya');
        const text = `Held ${formatUsd(hold.amount.cents, { exact: true })}. Charged ${formatUsd(hold.capturedCents, { exact: true })}. Fake receipt: ${formatUsd(rexJob.amounts.capturedCents)}.`;
        ctx.cue({ name: 'caption', target: null, text });
      },
    },
  ],
};
