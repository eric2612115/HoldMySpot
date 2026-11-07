import { SEED_SHOPS, bidDepth, epochToZonedLocal, formatUsd, maxSteps, opsDatasets, travelMinutes } from '@holdmyspot/shared';
import type {
  AgentAction,
  AskQuote,
  AskTask,
  BidTask,
  BoardData,
  BoardEvent,
  BoardResource,
  BoardTimeRange,
  BookSnapshot,
  Claim,
  Hold,
  Job,
  LedgerEntry,
  LngLat,
  MarketMs,
  OpsDataset,
  OpsDatasetName,
  Shop,
  UserId,
} from '@holdmyspot/shared';
import { HERO_DAY, HERO_TZ, MINUTE, sf } from '../time.ts';
import { W } from '../vocab.ts';
import { DAY_END, DAY_START } from './heroDay.ts';
import { itemById, shopById } from './world.ts';
import type { World } from './world.ts';

/** Records the board renders next to BoardData (the server exposes them through the contract's GET routes). */
export interface BoardBundle {
  board: BoardData;
  asks: Record<string, AskTask>;
  claims: Record<string, Claim>;
  jobs: Record<string, Job>;
  bids: Record<string, BidTask>;
  holds: Record<string, Hold>;
  notes: AgentAction[];
  positions: Record<UserId, LngLat>;
}

/** The San Francisco queuers: one board row each. */
const SF_QUEUERS = ['wei', 'rex', 'lin', 'ava', 'rin', 'jo'];
/** Shops on the board: the Japantown shops where the day's lines are. */
const BOARD_SHOPS = ['paper-moon-toys', 'little-lantern-toys', 'sugar-cloud-bakery', 'steam-lantern-ramen'];

function openAt(shop: Shop, t: MarketMs): MarketMs {
  return sf(shop.hours.opens, epochToZonedLocal(t, HERO_TZ).slice(0, 10));
}

/** When a queuer who joined the line at `from` should reach the counter. */
function expectedBuyAt(shop: Shop, from: MarketMs): MarketMs {
  const wait = itemById(shop.items[0]?.id ?? '').expectedWaitMinutes;
  return Math.max(from + wait * MINUTE, openAt(shop, from) + 6 * MINUTE);
}

function historyAt(job: Job, status: string): MarketMs | null {
  return job.history.find((h) => h.status === status)?.at ?? null;
}

function claimBuyAt(w: World, claim: Claim): MarketMs | null {
  const times = w.jobs.filter((j) => j.claimId === claim.id).map((j) => historyAt(j, 'bought')).filter((t): t is number => t !== null);
  return times.length > 0 ? Math.min(...times) : null;
}

/** When a job's bar ends on the board: its failure, its verification, or its expected purchase plus a few minutes. */
export function jobEnd(w: World, job: Job, now: MarketMs): MarketMs {
  if (job.failure) return job.failure.at;
  const verified = historyAt(job, 'verified');
  if (verified !== null) return verified;
  const claim = w.claims.find((c) => c.id === job.claimId);
  const shop = shopById(job.shopId);
  const bought = historyAt(job, 'bought');
  const base = bought ?? (claim ? expectedBuyAt(shop, claim.checkedInAt ?? w.asks.find((a) => a.id === job.askId)?.etaAt ?? now) : now);
  return Math.max(base + 6 * MINUTE, now + 3 * MINUTE);
}

function clockEnd(w: World, ask: AskTask, start: MarketMs): MarketMs {
  const clock = ask.clock;
  if (!clock) return start;
  const floorAt = start + maxSteps({ openCents: ask.feeCents, stepCents: clock.stepCents, intervalMs: clock.intervalMs, floorCents: clock.floorCents, startsAt: start }) * clock.intervalMs;
  if (ask.status === 'filled') {
    const last = Math.max(...w.matches.filter((m) => m.askId === ask.id).map((m) => m.at));
    return Math.max(start + MINUTE, last);
  }
  if (ask.status !== 'open') return Math.max(start + MINUTE, ask.updatedAt);
  return Math.max(floorAt, start + clock.intervalMs);
}

export function positionsAt(w: World, t: MarketMs): Record<UserId, LngLat> {
  const out: Record<UserId, LngLat> = {};
  for (const id of [...SF_QUEUERS, 'dana', 'theo', 'mo']) {
    const user = w.users.get(id);
    if (!user?.home) continue;
    let origin: LngLat = user.home;
    let pos: LngLat = origin;
    const claims = w.claims.filter((c) => c.queuerId === id && c.createdAt <= t).sort((a, b) => a.createdAt - b.createdAt);
    for (const claim of claims) {
      const shop = shopById(claim.shopId);
      if (w.stalledClaims.has(claim.id) || claim.status === 'lapsed') {
        pos = origin;
        continue;
      }
      const ask = w.asks.find((a) => a.id === claim.askId);
      const arrival = claim.arrival?.at ?? ask?.etaAt ?? claim.windowEndsAt;
      const spot = queueSpot(shop.lngLat, SF_QUEUERS.indexOf(id));
      const travel = travelMinutes(origin, spot) * MINUTE;
      const depart = arrival - travel;
      if (t < depart) pos = origin;
      else if (t < arrival) {
        const f = (t - depart) / Math.max(travel, 1);
        pos = [origin[0] + (spot[0] - origin[0]) * f, origin[1] + (spot[1] - origin[1]) * f];
      } else pos = spot;
      origin = spot;
    }
    out[id] = pos;
  }
  return out;
}

/** A spot in the line a few metres from the door, different per queuer. */
function queueSpot(door: LngLat, index: number): LngLat {
  const angle = (index * 67 * Math.PI) / 180;
  const metres = 14 + (index % 3) * 6;
  const dLat = (metres * Math.cos(angle)) / 111_320;
  const dLng = (metres * Math.sin(angle)) / (111_320 * Math.cos((door[1] * Math.PI) / 180));
  return [door[0] + dLng, door[1] + dLat];
}

/** `day` sets the board's range and shop hours (default: the hero day, 10:00 to 17:00 in San Francisco). */
export function boardBundle(w: World, t: MarketMs, day: { from: MarketMs; to: MarketMs; date: string } = { from: DAY_START, to: DAY_END, date: HERO_DAY }): BoardBundle {
  const resources: BoardResource[] = SF_QUEUERS.map((id) => {
    const u = w.users.get(id);
    return { id, name: u?.displayName ?? id, cityId: 'sf', reliability: w.reliability.get(id)?.score ?? null, avatar: u?.avatar ?? null };
  });
  const events: BoardEvent[] = [];
  for (const claim of w.claims) {
    if (!SF_QUEUERS.includes(claim.queuerId)) continue;
    const ask = w.asks.find((a) => a.id === claim.askId);
    if (!ask) continue;
    const shop = shopById(claim.shopId);
    const refs = { claimId: claim.id, askId: ask.id };
    const windowEnd = claim.checkedInAt ?? claim.windowEndsAt;
    events.push({
      id: `win-${claim.id}`,
      resourceId: claim.queuerId,
      kind: 'claim_window',
      name: shop.name,
      startDate: claim.windowStartsAt,
      endDate: Math.max(windowEnd, claim.windowStartsAt + 2 * MINUTE),
      status: claim.status,
      refs,
    });
    if (claim.checkedInAt !== null) {
      const bought = claimBuyAt(w, claim);
      const end = bought ?? (claim.status === 'done' ? claim.updatedAt : Math.max(expectedBuyAt(shop, claim.checkedInAt), t + 2 * MINUTE));
      events.push({
        id: `line-${claim.id}`,
        resourceId: claim.queuerId,
        kind: 'queueing',
        name: `In line at ${shop.name}`,
        startDate: claim.checkedInAt,
        endDate: end,
        status: bought !== null || claim.status === 'done' ? 'done' : 'in_line',
        refs,
      });
    } else if (claim.status === 'awaiting_arrival' || claim.status === 'arrived') {
      events.push({
        id: `line-${claim.id}`,
        resourceId: claim.queuerId,
        kind: 'queueing',
        name: `Line at ${shop.name}`,
        startDate: ask.etaAt,
        endDate: expectedBuyAt(shop, ask.etaAt),
        status: 'planned',
        refs,
      });
    }
    if (ask.clock && ask.status !== 'lapsed') {
      const start = ask.clock.startsAt ?? ask.etaAt;
      const running = ask.clock.startsAt !== null && ask.status === 'open';
      events.push({
        id: `clock-${ask.id}`,
        resourceId: claim.queuerId,
        kind: 'fee_clock',
        name: `Fee clock ${formatUsd(ask.feeCents)} to ${formatUsd(ask.clock.floorCents)}`,
        startDate: start,
        endDate: clockEnd(w, ask, start),
        status: ask.clock.startsAt === null ? 'planned' : running ? 'running' : 'done',
        refs: { askId: ask.id, claimId: claim.id },
      });
    }
  }
  for (const job of w.jobs) {
    if (!SF_QUEUERS.includes(job.queuerId)) continue;
    const refs = { jobId: job.id, bidId: job.bidId, askId: job.askId, claimId: job.claimId };
    events.push({
      id: `job-${job.id}`,
      resourceId: job.queuerId,
      kind: 'job',
      name: `${job.requesterName} x${job.qty}`,
      startDate: job.createdAt,
      endDate: jobEnd(w, job, t),
      status: job.status,
      refs,
    });
    if (job.shipment) {
      events.push({
        id: `ship-${job.id}`,
        resourceId: job.queuerId,
        kind: 'job',
        name: `Shipped to ${job.requesterName}`,
        startDate: job.shipment.addedAt,
        endDate: job.shipment.addedAt,
        status: 'shipped',
        refs,
      });
    }
  }
  const timeRanges: BoardTimeRange[] = SEED_SHOPS.filter((s) => BOARD_SHOPS.includes(s.id)).map((s) => ({
    id: `open-${s.id}`,
    name: `${s.name} opens`,
    kind: 'shop_hours' as const,
    startDate: sf(s.hours.opens, day.date),
    endDate: sf(s.hours.closes, day.date),
  }));
  const index = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));
  return {
    board: { from: day.from, to: day.to, resources, events, timeRanges, generatedAt: t },
    asks: index(w.asks),
    claims: index(w.claims),
    jobs: index(w.jobs),
    bids: index(w.bids),
    holds: index(w.holds),
    notes: [...w.notes].sort((a, b) => b.at - a.at),
    positions: positionsAt(w, t),
  };
}

// ---------------------------------------------------------------------------
// Books
// ---------------------------------------------------------------------------

function holdUsable(w: World, bid: BidTask): boolean {
  const hold = w.holds.find((h) => h.id === bid.holdId);
  return !!hold && (hold.status === 'held' || hold.status === 'partially_captured') && !hold.renewalRequired;
}

export function booksAt(w: World, t: MarketMs): BookSnapshot[] {
  const books: BookSnapshot[] = [];
  for (const shop of SEED_SHOPS) {
    for (const item of shop.items) {
      const bids = w.bids
        .filter((b) => b.itemId === item.id && ['open', 'partially_matched'].includes(b.status) && b.remainingQty > 0)
        .map((b) => ({ maxFeeCents: b.maxFeeCents, remainingQty: b.remainingQty, matchable: holdUsable(w, b), deadlineAt: b.deadlineAt }));
      const live = bids.filter((b) => b.matchable);
      const asks = w.asks.filter((a) => a.itemId === item.id && a.status === 'open' && a.remainingCapacity > 0);
      const quotes: AskQuote[] = asks.map((a) => ({
        askId: a.id,
        queuerId: a.queuerId,
        queuerName: a.queuerName,
        avatar: w.users.get(a.queuerId)?.avatar ?? null,
        claimStatus: w.claims.find((c) => c.id === a.claimId)?.status ?? 'awaiting_arrival',
        feeCents: a.feeCents,
        clock: a.clock,
        remainingCapacity: a.remainingCapacity,
        modes: a.modes,
        etaAt: a.etaAt,
      }));
      const fills = w.matches.filter((m) => m.itemId === item.id).sort((a, b) => b.at - a.at);
      const last = fills[0];
      const inLine = w.claims.filter((c) => c.shopId === shop.id && c.status === 'checked_in').map((c) => c.queuerName);
      books.push({
        shopId: shop.id,
        itemId: item.id,
        cityId: shop.cityId,
        asOf: t,
        status: 'open',
        retailCents: item.retailCents,
        bids: {
          count: live.length,
          qty: live.reduce((s, b) => s + b.remainingQty, 0),
          bestFeeCents: live.length ? Math.max(...live.map((b) => b.maxFeeCents)) : null,
          levels: bidDepth(live, 8),
          latestDeadlineAt: live.length ? Math.max(...live.map((b) => b.deadlineAt)) : null,
        },
        asks: { count: quotes.length, capacity: quotes.reduce((s, q) => s + q.remainingCapacity, 0), quotes },
        lastFill: last ? { feeCents: last.feeCents, qty: last.qty, at: last.at } : null,
        queue: { minutes: item.expectedWaitMinutes, peopleAhead: null, queuers: inLine },
      });
    }
  }
  return books;
}

/** The lowest offer now, from the quotes with the shared step-down helpers (shared, so the server agrees). */
export { bestAskCents } from '@holdmyspot/shared';

// ---------------------------------------------------------------------------
// Datasets for AG Studio. Built by the shared opsDatasets, which the server's
// GET /api/ops/datasets/:name uses too, so mock and live rows are identical.
// ---------------------------------------------------------------------------

/** Display names by user id (personas and crowd requesters), for "whose money". */
export function namesOf(w: World): Record<UserId, string> {
  const out: Record<UserId, string> = {};
  for (const [id, u] of w.users) out[id] = u.displayName;
  for (const [id, c] of w.crowd) out[id] ??= c.displayName;
  return out;
}

export function datasetsAt(w: World, t: MarketMs, books: BookSnapshot[] = booksAt(w, t)): Record<OpsDatasetName, OpsDataset> {
  const view = { bids: w.bids, holds: w.holds, asks: w.asks, matches: w.matches, jobs: w.jobs, ledger: w.ledger, payouts: w.payouts, books, names: namesOf(w) };
  const out = opsDatasets(view, t, { words: W, slotFloor: DAY_START });
  return { ...out, ledger: withPayPalIds(out.ledger, w.ledger) };
}

/** The PayPal object a ledger line is about and its id, most specific first (capture before its authorization). */
export function paypalRef(e: LedgerEntry | undefined): { object: string; id: string } | null {
  const p = e?.paypal;
  if (!p) return null;
  if (p.captureId) return { object: 'Capture', id: p.captureId };
  if (p.refundId) return { object: 'Refund', id: p.refundId };
  if (p.payoutItemId) return { object: 'Payout item', id: p.payoutItemId };
  if (p.payoutBatchId) return { object: 'Payout batch', id: p.payoutBatchId };
  if (p.authorizationId) return { object: 'Authorization', id: p.authorizationId };
  if (p.orderId) return { object: 'Order', id: p.orderId };
  return null;
}

/**
 * The console's ledger rows also carry the PayPal id of each money event, for
 * the dashboard's ledger grid (the shared rows stay as the server serves them).
 */
function withPayPalIds(ds: OpsDataset, entries: readonly LedgerEntry[]): OpsDataset {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return {
    ...ds,
    fields: [
      ...ds.fields,
      { name: 'paypalObject', type: 'string', label: 'PayPal object' },
      { name: 'paypalId', type: 'string', label: 'PayPal id' },
      { name: 'events', type: 'number', label: 'Events' },
    ],
    rows: ds.rows.map((r) => {
      const ref = paypalRef(byId.get(String(r.entryId)));
      return { ...r, paypalObject: ref?.object ?? null, paypalId: ref?.id ?? null, events: 1 };
    }),
  };
}
