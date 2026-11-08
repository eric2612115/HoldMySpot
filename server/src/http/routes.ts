import { CONTRACT_VERSION, ContractError, FILE_PURPOSES, SEED_SHOPS, formatUsd } from '@holdmyspot/shared';
import type {
  AmendBidRequest,
  AppConfig,
  ApiKey,
  BookSnapshot,
  CheckInRequest,
  ClaimBidRequest,
  CreateAskRequest,
  CreateBidRequest,
  DemoClockRequest,
  FakeApproveRequest,
  FeeEstimateRequest,
  FilePurpose,
  OpsAgentTurnRequest,
  OpsMovesRequest,
  QuoteRequest,
  ShippingEstimateRequest,
  User,
} from '@holdmyspot/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { App, Viewer } from '../app/app.ts';
import { checkIn, claimDetail, claimDone, createAsk, withdrawAsk } from '../app/asks.ts';
import { amendBid, approvalFailed, authorizeBid, bidDetail, cancelBid, claimBid, createBid, holdForViewer, quoteBid, setAgent } from '../app/bids.ts';
import { cities, itemById, itemOrThrow, shopOrThrow } from '../app/catalog.ts';
import { canReadFile, readStoredFile, saveUpload } from '../app/files.ts';
import { addShipment, handover, jobDetail, markBought, markDelivered, reportSoldOut, reviewProof, submitProof } from '../app/jobs.ts';
import { bookSnapshot, latestLinePhoto } from '../app/market.ts';
import { acceptDispute, adjudicateDispute, closeRefundRequest, redraftDispute, refundByOps, requestRefund, submitEvidence } from '../app/disputes.ts';
import { renewHold } from '../app/money.ts';
import { board, opsDataset, opsRecords } from '../app/ops.ts';
import { applyOpsMoves, opsAgentTurn } from '../app/opsAgents.ts';
import { sweepNow } from '../app/scheduler.ts';
import { emitClock, viewJob, viewPayout, viewUser } from '../app/views.ts';
import type { Director } from '../demo/director.ts';
import { ALL_SCENARIOS } from '../fakes/scenarios.ts';

/**
 * One handler per contract endpoint. `exec: true` handlers change state and
 * run one at a time through app.exec (with Idempotency-Key replay inside the
 * same queue). Endpoints without a handler answer 501 NOT_BUILT.
 */

export interface RouteCtx {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
  user: User | null;
  viewer: Viewer;
  req: FastifyRequest;
  reply: FastifyReply;
}

export interface RouteDef {
  exec: boolean;
  handler: (ctx: RouteCtx) => unknown;
}

export interface RouteDeps {
  app: App;
  director: Director | null;
  /** Ends every SSE connection with a resync (after a reset). */
  resyncAll: (reason: string) => void;
}

function needUser(ctx: RouteCtx): User {
  if (!ctx.user) throw new ContractError('FORBIDDEN', 'Act as a persona (X-HMS-User) for this action.');
  return ctx.user;
}

const q = (ctx: RouteCtx, name: string): string | undefined => {
  const v = ctx.query[name];
  return v === undefined || v === '' ? undefined : v;
};

export function buildRoutes({ app, director, resyncAll }: RouteDeps): Partial<Record<ApiKey, RouteDef>> {
  const read = (handler: RouteDef['handler']): RouteDef => ({ exec: false, handler });
  const write = (handler: RouteDef['handler']): RouteDef => ({ exec: true, handler });
  const needDirector = (): Director => {
    if (!director) throw new ContractError('DEMO_ONLY', 'Demo routes need HMS_DEMO=1.');
    return director;
  };

  const config = (): AppConfig => {
    const sandbox = app.config.mode === 'sandbox' && app.config.paypal !== null;
    return {
      contractVersion: CONTRACT_VERSION,
      mode: app.config.mode,
      modeReason: app.config.modeReason,
      paypal: {
        clientId: sandbox ? app.config.paypal!.clientId : null,
        sdkUrl: sandbox ? 'https://www.sandbox.paypal.com/web-sdk/v6/core' : null,
        components: ['paypal-payments', 'venmo-payments'],
        currency: 'USD',
        testBuyerCountry: sandbox ? 'US' : null,
        funding: app.config.funding,
      },
      ai: { ...app.ai.info },
      clock: app.clock.state(),
      demo: { enabled: director !== null, scriptId: director?.state().scriptId ?? null },
      rules: app.rules,
    };
  };

  return {
    // ---- system ---------------------------------------------------------
    'GET /api/health': read(() => ({ ok: true, mode: app.config.mode, contractVersion: CONTRACT_VERSION, uptimeMs: Date.now() - app.startedAt })),
    'GET /api/config': read(config),
    'GET /api/clock': read(() => app.clock.state()),

    // ---- catalog and people --------------------------------------------
    'GET /api/cities': read(() => ({ cities: cities() })),
    'GET /api/shops': read((ctx) => ({ shops: SEED_SHOPS.filter((s) => !q(ctx, 'cityId') || s.cityId === q(ctx, 'cityId')) })),
    'GET /api/shops/:shopId': read((ctx) => {
      const shop = shopOrThrow(ctx.params.shopId!);
      return { shop, books: shop.items.map((i) => bookSnapshot(app, i.id)) };
    }),
    'GET /api/users': read((ctx) => ({
      users: app.store.users
        .where('crowd = 0')
        .filter((u) => !q(ctx, 'role') || u.user.roles.includes(q(ctx, 'role') as 'requester' | 'queuer'))
        .map((u) => viewUser(u, ctx.viewer)),
    })),
    'GET /api/me': read((ctx) => ({ user: viewUser(app.store.users.must(needUser(ctx).id), ctx.viewer) })),

    // ---- market --------------------------------------------------------
    'GET /api/books': read((ctx) => {
      const books: BookSnapshot[] = [];
      for (const shop of SEED_SHOPS) {
        if (q(ctx, 'cityId') && shop.cityId !== q(ctx, 'cityId')) continue;
        for (const item of shop.items) books.push(bookSnapshot(app, item.id));
      }
      return { books, asOf: app.now() };
    }),
    'GET /api/books/:shopId/:itemId': read((ctx) => {
      const { item } = itemOrThrow(ctx.params.shopId!, ctx.params.itemId!);
      return {
        book: bookSnapshot(app, item.id),
        asks: app.store.asks.where("item_id = ? AND status IN ('open', 'filled')", item.id),
        recentMatches: app.store.matches.where('item_id = ?', item.id).slice(-20).reverse(),
      };
    }),

    // ---- files ---------------------------------------------------------
    'POST /api/files': write(async (ctx) => {
      const user = needUser(ctx);
      const purpose = q(ctx, 'purpose');
      if (!purpose || !FILE_PURPOSES.includes(purpose as FilePurpose)) {
        throw new ContractError('BAD_REQUEST', `?purpose= must be one of ${FILE_PURPOSES.join(', ')}.`);
      }
      const fixture = q(ctx, 'fixture') ?? null;
      if (fixture !== null) {
        if (app.config.mode !== 'fake') throw new ContractError('FAKE_ONLY', 'Simulated photo readings work only in fake mode.');
        if (!ALL_SCENARIOS.includes(fixture)) throw new ContractError('BAD_REQUEST', `Unknown fixture ${fixture}.`, { fixtures: ALL_SCENARIOS });
      }
      const body = ctx.body;
      if (!(body instanceof Uint8Array)) throw new ContractError('BAD_REQUEST', 'Send the photo as raw bytes with Content-Type image/jpeg, image/png or image/webp.');
      const dHash = app.ai.dHash ? (bytes: Uint8Array, type: string) => app.ai.dHash!(bytes, type) : null;
      const file = await saveUpload(app, user.id, purpose as FilePurpose, ctx.req.headers['content-type'], body, { scenario: fixture, dHash });
      return { file: file.ref };
    }),
    'GET /api/files/:fileId': read((ctx) => {
      const f = app.store.files.must(ctx.params.fileId!, 'file');
      if (!canReadFile(app, ctx.viewer, f)) throw new ContractError('FORBIDDEN', 'Only the people on this job and ops can see this photo.');
      ctx.reply.header('content-type', f.ref.contentType).header('cache-control', 'private, max-age=3600');
      return readStoredFile(f);
    }),

    // ---- bids ----------------------------------------------------------
    'POST /api/bids/quote': read((ctx) => quoteBid(app, needUser(ctx), ctx.body as QuoteRequest)),
    'POST /api/bids': write((ctx) => createBid(app, needUser(ctx), ctx.body as CreateBidRequest)),
    'POST /api/bids/:bidId/authorize': write((ctx) => authorizeBid(app, ctx.viewer, ctx.params.bidId!, (ctx.body as { orderId: string }).orderId)),
    'POST /api/bids/:bidId/approval-failed': write((ctx) => approvalFailed(app, ctx.viewer, ctx.params.bidId!)),
    'GET /api/bids': read((ctx) => {
      const status = q(ctx, 'status');
      const shopId = q(ctx, 'shopId');
      const all = ctx.viewer.ops && q(ctx, 'mine') !== '1' ? app.store.bids.all() : app.store.bids.where('requester_id = ?', needUser(ctx).id);
      return { bids: all.filter((b) => (!status || b.status === status) && (!shopId || b.shopId === shopId)).reverse() };
    }),
    'GET /api/bids/:bidId': read((ctx) => bidDetail(app, ctx.viewer, ctx.params.bidId!)),
    'PATCH /api/bids/:bidId': write((ctx) => amendBid(app, ctx.viewer, ctx.params.bidId!, ctx.body as AmendBidRequest)),
    'POST /api/bids/:bidId/cancel': write((ctx) => cancelBid(app, ctx.viewer, ctx.params.bidId!)),
    'POST /api/bids/:bidId/claim': write((ctx) => claimBid(app, needUser(ctx), ctx.params.bidId!, ctx.body as ClaimBidRequest)),
    'GET /api/bids/:bidId/agent-actions': read((ctx) => {
      bidDetail(app, ctx.viewer, ctx.params.bidId!);
      return { actions: app.store.agentActions.where('bid_id = ?', ctx.params.bidId!) };
    }),
    'POST /api/bids/:bidId/agent': write((ctx) => setAgent(app, ctx.viewer, ctx.params.bidId!, (ctx.body as { enabled: boolean }).enabled)),

    // ---- asks, claims --------------------------------------------------
    'POST /api/asks': write((ctx) => createAsk(app, needUser(ctx), ctx.body as CreateAskRequest)),
    'GET /api/asks': read((ctx) => {
      const status = q(ctx, 'status');
      const shopId = q(ctx, 'shopId');
      const asks = q(ctx, 'mine') === '1' ? app.store.asks.where('queuer_id = ?', needUser(ctx).id) : app.store.asks.all();
      return { asks: asks.filter((a) => (!status || a.status === status) && (!shopId || a.shopId === shopId)).reverse() };
    }),
    'POST /api/asks/:askId/withdraw': write((ctx) => withdrawAsk(app, needUser(ctx), ctx.params.askId!)),
    'GET /api/claims/:claimId': read((ctx) => claimDetail(app, ctx.viewer, ctx.params.claimId!)),
    'POST /api/claims/:claimId/check-in': write((ctx) => checkIn(app, needUser(ctx), ctx.params.claimId!, ctx.body as CheckInRequest)),
    'POST /api/claims/:claimId/done': write((ctx) => claimDone(app, needUser(ctx), ctx.params.claimId!)),

    // ---- jobs ----------------------------------------------------------
    'GET /api/jobs': read((ctx) => {
      const role = q(ctx, 'role');
      const status = q(ctx, 'status');
      let jobs = app.store.jobs.all();
      if (!ctx.viewer.ops || q(ctx, 'mine') === '1') {
        const me = needUser(ctx).id;
        jobs = jobs.filter((j) => (role === 'requester' ? j.requesterId === me : role === 'queuer' ? j.queuerId === me : j.requesterId === me || j.queuerId === me));
      }
      return { jobs: jobs.filter((j) => !status || j.status === status).reverse().map((j) => viewJob(j, ctx.viewer)) };
    }),
    'GET /api/jobs/:jobId': read((ctx) => jobDetail(app, ctx.viewer, ctx.params.jobId!)),
    'POST /api/jobs/:jobId/bought': write((ctx) => markBought(app, needUser(ctx), ctx.params.jobId!)),
    'POST /api/jobs/:jobId/sold-out': write((ctx) => reportSoldOut(app, needUser(ctx), ctx.params.jobId!, (ctx.body as { photoFileId: string | null }).photoFileId)),
    'POST /api/jobs/:jobId/proof': write((ctx) => submitProof(app, needUser(ctx), ctx.params.jobId!, ctx.body as { receiptFileId: string; itemFileId: string })),
    'POST /api/jobs/:jobId/shipment': write((ctx) => addShipment(app, needUser(ctx), ctx.params.jobId!, ctx.body as Parameters<typeof addShipment>[3])),
    'POST /api/jobs/:jobId/handover': write((ctx) => handover(app, needUser(ctx), ctx.params.jobId!, (ctx.body as { code: string }).code)),
    'POST /api/jobs/:jobId/delivered': write((ctx) => markDelivered(app, ctx.params.jobId!)),
    'POST /api/jobs/:jobId/refund-request': write((ctx) => ({ job: requestRefund(app, needUser(ctx), ctx.params.jobId!, (ctx.body as { reason: string }).reason) })),

    // ---- money ---------------------------------------------------------
    'GET /api/holds/:holdId': read((ctx) => ({ hold: holdForViewer(app, ctx.viewer, ctx.params.holdId!) })),
    'GET /api/ledger': read((ctx) => {
      const bidId = q(ctx, 'bidId');
      const jobId = q(ctx, 'jobId');
      let entries = app.store.ledger.all();
      if (!ctx.viewer.ops || q(ctx, 'mine') === '1') {
        const me = needUser(ctx).id;
        entries = entries.filter((e) => e.userId === me);
      }
      return { entries: entries.filter((e) => (!bidId || e.bidId === bidId) && (!jobId || e.jobId === jobId)).reverse() };
    }),
    'GET /api/payouts': read((ctx) => {
      let payouts = app.store.payouts.all();
      if (!ctx.viewer.ops || q(ctx, 'mine') === '1') {
        const me = needUser(ctx).id;
        payouts = payouts.filter((p) => p.recipientUserId === me);
      }
      return { payouts: payouts.reverse().map((p) => viewPayout(p, ctx.viewer)) };
    }),

    // ---- AI estimates --------------------------------------------------
    'POST /api/estimates/fee': read(async (ctx) => {
      const body = ctx.body as FeeEstimateRequest;
      const { shop, item } = itemOrThrow(body.shopId, body.itemId);
      return app.ai.feeEstimate({ shop, item, at: body.at ?? app.now(), latestLinePhoto: latestLinePhoto(app, shop.id), rules: app.rules });
    }),
    'POST /api/estimates/shipping': read(async (ctx) => {
      const body = ctx.body as ShippingEstimateRequest;
      const { item } = itemById(body.itemId);
      if (!item.shippable) throw new ContractError('MODE_NOT_ALLOWED', `${item.shortName} is a local errand only.`);
      return app.ai.shippingEstimate({ item, qty: body.qty, destination: body.destination });
    }),

    // ---- ops -----------------------------------------------------------
    'GET /api/ops/board': read((ctx) => board(app, { from: q(ctx, 'from'), to: q(ctx, 'to'), cityId: q(ctx, 'cityId') as 'nyc' | 'sf' | undefined })),
    'GET /api/ops/datasets/:name': read((ctx) => opsDataset(app, ctx.params.name!)),
    'GET /api/ops/records': read(() => opsRecords(app)),
    'POST /api/ops/proofs/:proofId/review': write((ctx) => reviewProof(app, ctx.params.proofId!, ctx.body as { decision: 'pass' | 'fail'; note: string })),
    'POST /api/ops/jobs/:jobId/refund': write(async (ctx) => {
      const body = ctx.body as { amountCents: number; reason: string };
      const ledger = await refundByOps(app, ctx.params.jobId!, body.amountCents, body.reason);
      return { job: app.store.jobs.must(ctx.params.jobId!), ledger };
    }),
    'POST /api/ops/holds/:holdId/reauthorize': write(async (ctx) => {
      const out = await renewHold(app, ctx.params.holdId!);
      if (out.verdict === 'not_needed') {
        const h = out.hold;
        const when = h.honorEndsAt ? `the honor period ends ${new Date(h.honorEndsAt).toISOString()}` : 'the hold is not authorized';
        throw new ContractError('CONFLICT', `Not renewed: only an uncaptured hold of an open request can be reauthorized, from day 4 to day 29 (${when}).`, {
          status: h.status,
          capturedCents: h.capturedCents,
        });
      }
      return { hold: out.hold, ledger: out.ledger };
    }),
    'POST /api/ops/sweep': read(() => sweepNow(app)),
    'POST /api/ops/jobs/:jobId/refund-request/close': write((ctx) => ({ job: closeRefundRequest(app, ctx.params.jobId!, (ctx.body as { note: string }).note) })),
    'GET /api/ops/disputes': read(() => ({ disputes: app.store.disputes.all().reverse() })),
    // A model turn is a read: it waits on the model, never on the market's queue (D-159).
    'POST /api/ops/disputes/:disputeId/draft': read(async (ctx) => ({ dispute: await redraftDispute(app, ctx.params.disputeId!) })),
    'POST /api/ops/disputes/:disputeId/evidence': write(async (ctx) => {
      const body = ctx.body as { note: string; includeTracking: boolean };
      return { dispute: await submitEvidence(app, ctx.params.disputeId!, body) };
    }),
    'POST /api/ops/disputes/:disputeId/accept': write(async (ctx) => ({ dispute: await acceptDispute(app, ctx.params.disputeId!, (ctx.body as { note: string }).note) })),
    'POST /api/ops/disputes/:disputeId/adjudicate': write(async (ctx) => ({
      dispute: await adjudicateDispute(app, ctx.params.disputeId!, (ctx.body as { outcome: 'buyer_favor' | 'seller_favor' }).outcome),
    })),
    // Ops agents (D-100 to D-102). A model turn is a read: it waits on the model, never on the market's queue.
    'POST /api/ops/agents/turn': read((ctx) => opsAgentTurn(app, ctx.body as OpsAgentTurnRequest)),
    'POST /api/ops/moves': write((ctx) => applyOpsMoves(app, ctx.body as OpsMovesRequest)),

    // ---- fake PayPal ---------------------------------------------------
    'POST /api/fake/paypal/orders/:orderId/approve': write(async (ctx) => {
      const body = ctx.body as FakeApproveRequest;
      return app.fakePayPal.approveOrder(ctx.params.orderId!, body.funding, body.outcome);
    }),

    // ---- demo ----------------------------------------------------------
    'GET /api/demo/scripts': read(() => ({ scripts: needDirector().scripts() })),
    'GET /api/demo/state': read(() => needDirector().state()),
    'POST /api/demo/reset': write(async (ctx) => {
      const body = ctx.body as { seed: number | null; scriptId: string | null };
      // Old clients drop first, then reconnect to the new market (new bootId).
      resyncAll('reset');
      return needDirector().reset(body.scriptId, body.seed);
    }),
    'POST /api/demo/start': write(async (ctx) => {
      const body = ctx.body as { scriptId: string; speed: number | null };
      resyncAll('reset');
      return needDirector().start(body.scriptId, body.speed);
    }),
    'POST /api/demo/pause': write(() => needDirector().pause()),
    'POST /api/demo/resume': write(() => needDirector().resume()),
    'POST /api/demo/step': read(() => needDirector().step()),
    'POST /api/demo/clock': write((ctx) => {
      needDirector();
      const body = ctx.body as DemoClockRequest;
      if (body.speed !== undefined) app.clock.setSpeed(body.speed);
      if (body.paused === true) app.clock.pause();
      if (body.paused === false) app.clock.resume();
      if (body.jumpTo !== undefined) app.clock.jumpTo(body.jumpTo);
      app.saveClock();
      emitClock(app);
      return app.clock.state();
    }),
  };
}

/** For logs: one line per money amount, used by the boot report. */
export const describeCents = (c: number) => formatUsd(c, { exact: true });
