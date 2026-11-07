import {
  ContractError,
  DAY_MS,
  assertBidMoney,
  assertTransition,
  bidDisclosures,
  bidLimitCents,
  bidStatusForQty,
  formatUsd,
  isTerminal,
  money,
  platformFeeLine,
  suggestedRetailCapCents,
} from '@holdmyspot/shared';
import type {
  AmendBidRequest,
  BidDetail,
  BidQuote,
  BidResult,
  BidTask,
  ClaimBidRequest,
  ClaimBidResponse,
  CreateBidRequest,
  CreateBidResponse,
  Destination,
  Hold,
  Item,
  Match,
  QuoteRequest,
  Shop,
  User,
} from '@holdmyspot/shared';
import type { App, Viewer } from './app.ts';
import { itemOrThrow, requireRole } from './catalog.ts';
import { applyFill, backedQty, bidMatchableNow, committedCents, emitBook, latestLinePhoto, runBook } from './market.ts';
import { authorizeHold, openAuthorizedBid, reconcileBid, voidHold } from './money.ts';
import { emitBid, emitHold, viewJob } from './views.ts';
import { assertQueuerMayOffer, createClaimAsk } from './asks.ts';
import { failJob } from './jobs.ts';

/** Requester commands: quote, bid, PayPal approval and authorization, amend, cancel; and a queuer's direct claim. */

/** Approval must arrive within this time, or the bid fails (our own timeout). */
export const APPROVAL_TIMEOUT_MS = 3 * 60 * 60_000;

function checkDestination(u: User, shop: Shop, item: Item, d: Destination): void {
  if (!item.modes.includes(d.mode)) {
    throw new ContractError('MODE_NOT_ALLOWED', `${item.shortName} from ${shop.name} is ${item.modes.includes('ship') ? 'shipped only' : 'a local errand only'}.`, {
      modes: item.modes,
    });
  }
  if (d.mode === 'local' && (d.cityId !== shop.cityId || u.cityId !== shop.cityId)) {
    throw new ContractError('MODE_NOT_ALLOWED', 'Local errands are only for requesters in the shop\'s own city.', { shopCity: shop.cityId, cityId: d.cityId });
  }
  if (d.mode === 'ship' && d.country !== 'US') throw new ContractError('MODE_NOT_ALLOWED', 'Parcels ship to the US only.');
}

export async function quoteBid(app: App, u: User, req: QuoteRequest): Promise<BidQuote> {
  requireRole(u, 'requester');
  const { shop, item } = itemOrThrow(req.shopId, req.itemId);
  checkDestination(u, shop, item, req.destination);
  if (!Number.isInteger(req.qty) || req.qty < 1) throw new ContractError('BAD_REQUEST', 'Quantity must be a positive whole number.');
  if (req.qty > item.perPersonLimit) throw new ContractError('OVER_STORE_LIMIT', `${shop.name} sells at most ${item.perPersonLimit} per person.`);
  const fee = await app.ai.feeEstimate({ shop, item, at: app.now(), latestLinePhoto: latestLinePhoto(app, shop.id), rules: app.rules });
  const shipping = req.destination.mode === 'ship' ? await app.ai.shippingEstimate({ item, qty: req.qty, destination: req.destination }) : null;
  const suggested = {
    retailCapCents: suggestedRetailCapCents(item.retailCents),
    maxFeeCents: fee.suggestedFeeCents,
    shippingBudgetCents: shipping?.budgetCents ?? 0,
  };
  const b = { qty: req.qty, ...suggested };
  return {
    retailCents: item.retailCents,
    suggested,
    limitCents: bidLimitCents(b),
    fee,
    shipping,
    platformFee: platformFeeLine(suggested.maxFeeCents, app.rules),
    disclosures: bidDisclosures({ ...b, mode: req.destination.mode }, app.rules),
  };
}

function validateBid(app: App, u: User, req: CreateBidRequest): { shop: Shop; item: Item } {
  requireRole(u, 'requester');
  if (u.country !== 'US') throw new ContractError('FORBIDDEN', 'Requesters must be in the US.');
  const { shop, item } = itemOrThrow(req.shopId, req.itemId);
  checkDestination(u, shop, item, req.destination);
  assertBidMoney(req, req.destination.mode);
  if (req.qty > item.perPersonLimit) {
    throw new ContractError('OVER_STORE_LIMIT', `${shop.name} sells at most ${item.perPersonLimit} per person.`, { limit: item.perPersonLimit });
  }
  if (req.retailCapCents < item.retailCents) {
    throw new ContractError('RETAIL_CAP_TOO_LOW', `The retail cap must be at least the shop price (${formatUsd(item.retailCents, { exact: true })}).`, {
      retailCents: item.retailCents,
    });
  }
  if (req.maxFeeCents < item.minFeeCents) {
    throw new ContractError('FEE_BELOW_MINIMUM', `The queue fee must be at least ${formatUsd(item.minFeeCents, { exact: true })} per unit.`, {
      minFeeCents: item.minFeeCents,
    });
  }
  const now = app.now();
  if (!(req.deadlineAt > now) || req.deadlineAt > now + app.rules.maxBidDays * DAY_MS) {
    throw new ContractError('DEADLINE_OUT_OF_RANGE', `The deadline must be within ${app.rules.maxBidDays} days.`, { now, deadlineAt: req.deadlineAt });
  }
  if (!app.config.funding.includes(req.funding)) {
    throw new ContractError('MODE_NOT_ALLOWED', `The ${req.funding} button is not offered.`, { funding: app.config.funding });
  }
  return { shop, item };
}

/** Creates the bid, its hold and the PayPal order (intent AUTHORIZE) for the user's own limit. */
export async function createBid(app: App, u: User, req: CreateBidRequest, opts: { crowd?: boolean } = {}): Promise<CreateBidResponse> {
  const { shop, item } = validateBid(app, u, req);
  const adapter = app.adapterFor({ crowd: opts.crowd ?? false });
  const limitCents = bidLimitCents(req);
  const { bid, hold } = app.tx(() => {
    const now = app.now();
    const bidId = app.nextId('bid');
    const holdId = app.nextId('hold');
    const hold: Hold = {
      id: holdId,
      reference: bidId,
      description: `HoldMySpot hold: up to ${formatUsd(limitCents, { exact: true })} for ${req.qty} x ${item.name}`,
      amount: money(limitCents),
      capturedCents: 0,
      releasedCents: 0,
      refundedCents: 0,
      status: 'pending_approval',
      fundingSource: null,
      paypalOrderId: null,
      authorizationId: null,
      originalAuthorizationId: null,
      authorizedAt: null,
      originalAuthorizedAt: null,
      honorEndsAt: null,
      expiresAt: null,
      clockBasis: adapter === 'sandbox' ? 'real' : 'market',
      renewals: 0,
      renewalRequired: false,
      createdAt: now,
      updatedAt: now,
    };
    const bid: BidTask = {
      id: bidId,
      requesterId: u.id,
      requesterName: u.displayName,
      shopId: shop.id,
      itemId: item.id,
      qty: req.qty,
      remainingQty: req.qty,
      retailCapCents: req.retailCapCents,
      maxFeeCents: req.maxFeeCents,
      shippingBudgetCents: req.shippingBudgetCents,
      limitCents,
      destination: req.destination,
      deadlineAt: req.deadlineAt,
      status: 'awaiting_approval',
      closeReason: null,
      holdId,
      paypalOrderId: null,
      paypalAuthorizationId: null,
      agent: req.agent ? { enabled: true, goal: req.agent.goal, status: 'active', lastRunAt: null, nextRunAt: now } : null,
      createdAt: now,
      pricedAt: now,
      updatedAt: now,
    };
    app.store.holds.insert(hold);
    app.store.bids.insert(bid);
    emitHold(app, hold, u.id);
    emitBid(app, bid);
    return { bid, hold };
  });

  const itemTotal = req.qty * (req.retailCapCents + req.maxFeeCents);
  let orderId: string;
  try {
    const order = await app.payments(adapter).createOrder({
      requestId: `order:${bid.id}`,
      invoiceId: `HMS-${bid.id}`,
      customId: bid.id,
      description: hold.description.slice(0, 127),
      softDescriptor: 'HOLDMYSPOT',
      amountCents: limitCents,
      breakdown: { itemTotalCents: itemTotal, shippingCents: req.shippingBudgetCents },
      items: [
        { name: `${item.name} (shop price, up to)`.slice(0, 127), quantity: req.qty, unitAmountCents: req.retailCapCents, category: 'PHYSICAL_GOODS' },
        { name: 'Queue fee (up to)', quantity: req.qty, unitAmountCents: req.maxFeeCents, category: null },
      ],
      shipping: req.destination.mode === 'ship' ? { type: 'SHIPPING', preference: 'GET_FROM_FILE' } : { type: 'PICKUP_FROM_PERSON', preference: 'NO_SHIPPING' },
      funding: req.funding,
      returnUrl: `http://${app.config.host}:${app.config.port}/api/paypal/return`,
      cancelUrl: `http://${app.config.host}:${app.config.port}/api/paypal/cancel`,
    });
    orderId = order.orderId;
  } catch (err) {
    app.tx(() => failApproval(app, bid.id, 'approval_failed'));
    throw err;
  }
  const out = app.tx(() => {
    const b = app.store.bids.must(bid.id);
    const h = app.store.holds.must(hold.id);
    b.paypalOrderId = orderId;
    h.paypalOrderId = orderId;
    app.store.bids.update(b);
    app.store.holds.update(h);
    emitBid(app, b);
    emitHold(app, h, u.id);
    return { bid: b, hold: h };
  });
  return { ...out, checkout: { orderId, mode: adapter, next: adapter === 'fake' ? 'fake_approve' : 'js_sdk' } };
}

function failApproval(app: App, bidId: string, reason: 'approval_failed' | 'requester_cancelled'): { bid: BidTask; hold: Hold } {
  const bid = app.store.bids.must(bidId);
  const hold = app.store.holds.must(bid.holdId!);
  if (bid.status === 'awaiting_approval') {
    assertTransition('bid', bid.status, 'failed');
    bid.status = 'failed';
    bid.closeReason = reason;
    bid.updatedAt = app.now();
    app.store.bids.update(bid);
    emitBid(app, bid);
  }
  if (hold.status === 'pending_approval') {
    hold.status = 'failed';
    hold.updatedAt = app.now();
    app.store.holds.update(hold);
    emitHold(app, hold, bid.requesterId);
  }
  return { bid, hold };
}

function ownBid(app: App, viewer: Viewer, bidId: string): BidTask {
  const bid = app.store.bids.must(bidId, 'bid');
  if (!viewer.ops && viewer.userId !== bid.requesterId) throw new ContractError('FORBIDDEN', 'This is not your request.');
  return bid;
}

/** The buyer approved: authorize, open the bid and run matching. */
export async function authorizeBid(app: App, viewer: Viewer, bidId: string, orderId: string): Promise<BidResult> {
  const bid = ownBid(app, viewer, bidId);
  if (bid.paypalOrderId !== orderId) throw new ContractError('BAD_REQUEST', 'That PayPal order does not belong to this request.', { orderId });
  if (bid.status !== 'awaiting_approval') {
    if (bid.status === 'failed') throw new ContractError('INVALID_TRANSITION', 'This request already failed; create a new one.');
    const hold = app.store.holds.must(bid.holdId!);
    return { bid, hold, matches: app.store.matches.where('bid_id = ?', bid.id) };
  }
  await authorizeHold(app, bid.id, orderId);
  return app.tx(() => {
    const b = app.store.bids.must(bid.id);
    assertTransition('bid', b.status, 'open');
    b.status = 'open';
    b.updatedAt = app.now();
    app.store.bids.update(b);
    emitBid(app, b);
    const matches = runBook(app, b.itemId, 'new_bid');
    emitBook(app, b.itemId);
    return { bid: app.store.bids.must(b.id), hold: app.store.holds.must(b.holdId!), matches };
  });
}

export function approvalFailed(app: App, viewer: Viewer, bidId: string): { bid: BidTask; hold: Hold } {
  const bid = ownBid(app, viewer, bidId);
  if (bid.status !== 'awaiting_approval' && bid.status !== 'failed') {
    throw new ContractError('INVALID_TRANSITION', `The request is already ${bid.status}.`);
  }
  if (bid.holdId && app.store.holds.get(bid.holdId)?.status === 'held') {
    throw new ContractError('INVALID_TRANSITION', 'PayPal already holds the money for this request; cancel the request to release it.');
  }
  return app.tx(() => failApproval(app, bid.id, 'approval_failed'));
}

/** Cancels the unmatched remainder. Jobs whose queuer has not arrived yet end too. */
export async function cancelBid(app: App, viewer: Viewer, bidId: string): Promise<{ bid: BidTask; hold: Hold }> {
  const bid = ownBid(app, viewer, bidId);
  if (bid.status === 'awaiting_approval') {
    const out = app.tx(() => failApproval(app, bid.id, 'requester_cancelled'));
    // PayPal already authorized (the request had not opened yet): release it now.
    if (out.hold.status === 'held') await voidHold(app, out.hold.id, 'request cancelled');
    return { bid: app.store.bids.must(bid.id), hold: app.store.holds.must(out.hold.id) };
  }
  if (isTerminal('bid', bid.status) || bid.status === 'closing') throw new ContractError('INVALID_TRANSITION', `The request is already ${bid.status}.`);
  app.tx(() => {
    const b = app.store.bids.must(bid.id);
    b.closeReason = 'requester_cancelled';
    b.updatedAt = app.now();
    app.store.bids.update(b);
    emitBid(app, b);
    for (const job of app.store.jobs.where("bid_id = ? AND status = 'claimed'", b.id)) {
      failJob(app, job, 'requester_cancelled', `${b.requesterName} cancelled before the queuer arrived.`);
    }
    runBook(app, b.itemId, 'requeue');
    emitBook(app, b.itemId);
  });
  await reconcileBid(app, bid.id);
  const b = app.store.bids.must(bid.id);
  return { bid: b, hold: app.store.holds.must(b.holdId!) };
}

/** Changes max fee, qty or deadline inside the hold (the bidding agent's only lever). */
export async function amendBid(app: App, viewer: Viewer, bidId: string, req: AmendBidRequest): Promise<{ bid: BidTask; matches: Match[] }> {
  const bid = ownBid(app, viewer, bidId);
  if (bid.status !== 'open' && bid.status !== 'partially_matched' && bid.status !== 'matched') {
    throw new ContractError('INVALID_TRANSITION', `A ${bid.status} request cannot be changed.`);
  }
  const { item } = itemOrThrow(bid.shopId, bid.itemId);
  const hold = app.store.holds.must(bid.holdId!);
  const matchedQty = bid.qty - bid.remainingQty;
  const qty = req.qty ?? bid.qty;
  const maxFeeCents = req.maxFeeCents ?? bid.maxFeeCents;
  const deadlineAt = req.deadlineAt ?? bid.deadlineAt;
  if (!Number.isInteger(qty) || qty < Math.max(1, matchedQty)) throw new ContractError('BAD_REQUEST', `Quantity cannot go below the ${matchedQty} already matched.`);
  if (qty > item.perPersonLimit) throw new ContractError('OVER_STORE_LIMIT', `At most ${item.perPersonLimit} per person.`);
  if (!Number.isInteger(maxFeeCents) || maxFeeCents < item.minFeeCents) throw new ContractError('FEE_BELOW_MINIMUM', 'The fee is below the item minimum.');
  const limit = bidLimitCents({ qty, retailCapCents: bid.retailCapCents, maxFeeCents, shippingBudgetCents: bid.shippingBudgetCents });
  if (limit > hold.amount.cents) {
    throw new ContractError('OVER_LIMIT', `That would need ${formatUsd(limit, { exact: true })}, more than the ${formatUsd(hold.amount.cents, { exact: true })} PayPal holds.`, {
      neededCents: limit,
      limitCents: hold.amount.cents,
    });
  }
  // Jobs already matched keep the fees they were filled at: what is left must still fit beside them.
  const backed = backedQty(app, bid, hold, { qty, maxFeeCents });
  if (qty - matchedQty > backed) {
    const used = committedCents(app, bid.id);
    throw new ContractError(
      'OVER_LIMIT',
      `Matched jobs already use ${formatUsd(used, { exact: true })} of the ${formatUsd(hold.amount.cents, { exact: true })} PayPal holds; at ${formatUsd(maxFeeCents, { exact: true })} it can back ${backed} more, not ${qty - matchedQty}.`,
      { committedCents: used, limitCents: hold.amount.cents, backedQty: backed },
    );
  }
  if (!(deadlineAt > app.now()) || deadlineAt > bid.createdAt + app.rules.maxBidDays * DAY_MS) {
    throw new ContractError('DEADLINE_OUT_OF_RANGE', `The deadline must be within ${app.rules.maxBidDays} days of the request.`);
  }
  return app.tx(() => {
    const b = app.store.bids.must(bid.id);
    const now = app.now();
    if (maxFeeCents !== b.maxFeeCents) b.pricedAt = now;
    b.maxFeeCents = maxFeeCents;
    b.remainingQty = qty - matchedQty;
    b.qty = qty;
    b.deadlineAt = deadlineAt;
    const next = bidStatusForQty(b.qty, b.remainingQty);
    if (next !== b.status) {
      assertTransition('bid', b.status, next);
      b.status = next;
    }
    b.updatedAt = now;
    app.store.bids.update(b);
    emitBid(app, b);
    const matches = runBook(app, b.itemId, 'amend');
    emitBook(app, b.itemId);
    return { bid: app.store.bids.must(b.id), matches };
  });
}

/** A queuer takes one bid directly at its max fee (an ask aimed at that bid). */
export function claimBid(app: App, u: User, bidId: string, req: ClaimBidRequest): ClaimBidResponse {
  const bid = app.store.bids.must(bidId, 'bid');
  const { shop, item } = itemOrThrow(bid.shopId, bid.itemId);
  if (bid.requesterId === u.id) throw new ContractError('SELF_MATCH', 'You cannot take your own request.');
  if (bid.status !== 'open' && bid.status !== 'partially_matched') throw new ContractError('CONFLICT', 'This request is not open.');
  if (!Number.isInteger(req.qty) || req.qty < 1 || req.qty > bid.remainingQty) {
    throw new ContractError('BAD_REQUEST', `You can take 1 to ${bid.remainingQty} of this request.`, { remainingQty: bid.remainingQty });
  }
  if (!req.modes.includes(bid.destination.mode)) throw new ContractError('MODE_NOT_ALLOWED', `This request needs ${bid.destination.mode} fulfilment.`);
  assertQueuerMayOffer(app, u, shop, item, { capacity: req.qty, modes: req.modes, etaAt: req.etaAt, from: req.from });
  if (req.etaAt > bid.deadlineAt) throw new ContractError('DEADLINE_OUT_OF_RANGE', 'Your ETA is after the request deadline.');
  return app.tx(() => {
    const b = app.store.bids.must(bid.id);
    if (!b.holdId) throw new ContractError('HOLD_NOT_FOUND', 'The request has no hold.');
    const hold = app.store.holds.must(b.holdId);
    if (hold.status !== 'held' && hold.status !== 'partially_captured') throw new ContractError('HOLD_CLOSED', 'The PayPal hold is not active.');
    if (hold.renewalRequired) throw new ContractError('RENEWAL_REQUIRED', 'The requester must approve a new hold first.');
    // The same rules as the book: a request that is closing (cancelled, past its deadline, sold
    // out, its hold expiring or being voided) takes no new queuer.
    if (b.status !== 'open' && b.status !== 'partially_matched') throw new ContractError('CONFLICT', 'This request is not open.');
    if (!bidMatchableNow(app, b)) throw new ContractError('CONFLICT', 'This request is closing and takes no new queuers.', { closeReason: b.closeReason });
    if (req.qty > b.remainingQty) throw new ContractError('BAD_REQUEST', `You can take 1 to ${b.remainingQty} of this request.`, { remainingQty: b.remainingQty });
    const backed = backedQty(app, b, hold);
    if (req.qty > backed) {
      throw new ContractError('OVER_LIMIT', `The requester's PayPal hold can back ${backed} more at ${formatUsd(b.maxFeeCents, { exact: true })}.`, { backedQty: backed });
    }
    const { ask, claim } = createClaimAsk(app, u, shop, item, {
      capacity: req.qty,
      modes: req.modes,
      feeCents: b.maxFeeCents,
      clock: null,
      etaAt: req.etaAt,
      origin: 'claim',
      targetBidId: b.id,
    });
    const match = applyFill(app, { bidId: b.id, askId: ask.id, qty: req.qty, feeCents: b.maxFeeCents, at: app.now() }, 'claim');
    emitBook(app, b.itemId);
    const job = app.store.jobs.must(match.jobId);
    return {
      ask: app.store.asks.must(ask.id),
      claim: app.store.claims.must(claim.id),
      match,
      job: viewJob(job, { userId: u.id, ops: false }),
    };
  });
}

export function setAgent(app: App, viewer: Viewer, bidId: string, enabled: boolean): { bid: BidTask } {
  const bid = ownBid(app, viewer, bidId);
  if (!bid.agent) throw new ContractError('CONFLICT', 'This request has no bidding agent.');
  return app.tx(() => {
    const b = app.store.bids.must(bid.id);
    b.agent = { ...b.agent!, enabled, status: enabled ? 'active' : 'paused', nextRunAt: enabled ? app.now() : null };
    b.updatedAt = app.now();
    app.store.bids.update(b);
    emitBid(app, b);
    return { bid: b };
  });
}

export function bidDetail(app: App, viewer: Viewer, bidId: string): BidDetail {
  const bid = ownBid(app, viewer, bidId);
  return {
    bid,
    hold: bid.holdId ? app.store.holds.get(bid.holdId) : null,
    matches: app.store.matches.where('bid_id = ?', bid.id),
    jobs: app.store.jobs.where('bid_id = ?', bid.id).map((j) => viewJob(j, viewer)),
    ledger: app.store.ledger.where('bid_id = ?', bid.id).reverse(),
    agentActions: app.store.agentActions.where('bid_id = ?', bid.id),
  };
}

export function holdForViewer(app: App, viewer: Viewer, holdId: string): Hold {
  const hold = app.store.holds.must(holdId, 'hold', 'HOLD_NOT_FOUND');
  const bid = app.store.bids.must(hold.reference);
  if (!viewer.ops && viewer.userId !== bid.requesterId) throw new ContractError('FORBIDDEN', 'This is not your hold.');
  return hold;
}

/**
 * Bids still waiting for approval past the timeout fail (sweeper). One whose
 * hold PayPal already authorized opens instead: the buyer approved, and a
 * failed request would leave that money held with nothing behind it.
 */
export function expireApproval(app: App, bidId: string): void {
  openAuthorizedBid(app, bidId);
  app.tx(() => failApproval(app, bidId, 'approval_failed'));
}

