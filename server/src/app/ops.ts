import { ContractError, OPS_DATASETS, reachesAt, epochToZonedLocal, zonedLocalToEpoch, askSchedule, opsDatasets } from '@holdmyspot/shared';
import type { BoardData, BoardEvent, BoardTimeRange, CityId, OpsDataset, OpsDatasetName, OpsRecords } from '@holdmyspot/shared';
import { OPS_VIEWER, type App } from './app.ts';
import { viewUser } from './views.ts';
import { allItems, itemById } from './catalog.ts';
import { bookSnapshot } from './market.ts';

/** Read models for the operator console: the Bryntum queuer board and flat AG Studio datasets. */

function parseTime(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new ContractError('BAD_REQUEST', `Not a time: ${v}.`);
  return t;
}

export function board(app: App, q: { from?: string; to?: string; cityId?: CityId }): BoardData {
  const now = app.now();
  const from = parseTime(q.from, now - 2 * 60 * 60_000);
  const to = parseTime(q.to, now + 6 * 60 * 60_000);
  const queuers = app.store.users.where('crowd = 0').filter((u) => u.user.roles.includes('queuer') && (!q.cityId || u.user.cityId === q.cityId));
  const ids = new Set(queuers.map((u) => u.id));
  const events: BoardEvent[] = [];
  const overlaps = (s: number, e: number) => e >= from && s <= to;
  for (const c of app.store.claims.all()) {
    if (!ids.has(c.queuerId)) continue;
    if (overlaps(c.windowStartsAt, c.windowEndsAt)) {
      events.push({
        id: `win-${c.id}`,
        resourceId: c.queuerId,
        kind: 'claim_window',
        name: `Arrive at ${itemById(app.store.asks.must(c.askId).itemId).shop.name}`,
        startDate: c.windowStartsAt,
        endDate: c.windowEndsAt,
        status: c.status,
        refs: { claimId: c.id, askId: c.askId },
      });
    }
    if (c.checkedInAt !== null) {
      const end = c.status === 'done' ? c.updatedAt : Math.max(now, c.checkedInAt + 60_000);
      if (overlaps(c.checkedInAt, end)) {
        events.push({ id: `line-${c.id}`, resourceId: c.queuerId, kind: 'queueing', name: 'In line', startDate: c.checkedInAt, endDate: end, status: c.status, refs: { claimId: c.id } });
      }
    }
  }
  for (const a of app.store.asks.all()) {
    if (!ids.has(a.queuerId)) continue;
    const s = askSchedule(a);
    if (!s) continue;
    const floorAt = reachesAt(s, s.floorCents) ?? s.startsAt;
    const end = a.status === 'open' ? floorAt : Math.min(floorAt, a.updatedAt);
    if (overlaps(s.startsAt, Math.max(end, s.startsAt + 60_000))) {
      events.push({
        id: `clock-${a.id}`,
        resourceId: a.queuerId,
        kind: 'fee_clock',
        name: `Fee $${(s.openCents / 100).toFixed(2)} down to $${(s.floorCents / 100).toFixed(2)}`,
        startDate: s.startsAt,
        endDate: Math.max(end, s.startsAt + 60_000),
        status: a.status,
        refs: { askId: a.id },
      });
    }
  }
  const holdsShown = new Set<string>();
  for (const j of app.store.jobs.all()) {
    if (!ids.has(j.queuerId)) continue;
    const done = ['delivered', 'failed', 'refunded', 'shipped'].includes(j.status);
    const end = done ? j.updatedAt : Math.max(now, j.createdAt + 60_000);
    const { item } = itemById(j.itemId);
    if (overlaps(j.createdAt, end)) {
      events.push({
        id: `job-${j.id}`,
        resourceId: j.queuerId,
        kind: 'job',
        name: `${j.qty} x ${item.shortName} for ${j.requesterName}`,
        startDate: j.createdAt,
        endDate: end,
        status: j.status,
        refs: { jobId: j.id, bidId: j.bidId, askId: j.askId, claimId: j.claimId },
      });
    }
    const bid = app.store.bids.get(j.bidId);
    const hold = bid?.holdId ? app.store.holds.get(bid.holdId) : null;
    if (hold && hold.clockBasis === 'market' && hold.authorizedAt !== null && hold.honorEndsAt !== null && !holdsShown.has(`${hold.id}:${j.queuerId}`)) {
      holdsShown.add(`${hold.id}:${j.queuerId}`);
      if (overlaps(hold.authorizedAt, hold.honorEndsAt)) {
        events.push({
          id: `hold-${hold.id}-${j.queuerId}`,
          resourceId: j.queuerId,
          kind: 'hold_honor',
          name: `${j.requesterName}'s hold honored`,
          startDate: hold.authorizedAt,
          endDate: hold.honorEndsAt,
          status: hold.status,
          refs: { holdId: hold.id, bidId: hold.reference },
        });
      }
    }
  }
  const timeRanges: BoardTimeRange[] = [];
  const shops = [...new Map(allItems().map(({ shop }) => [shop.id, shop])).values()].filter((s) => !q.cityId || s.cityId === q.cityId);
  for (const shop of shops) {
    for (let day = from - 24 * 60 * 60_000; day <= to + 24 * 60 * 60_000; day += 24 * 60 * 60_000) {
      const date = epochToZonedLocal(day, shop.timezone).slice(0, 10);
      const opens = zonedLocalToEpoch(`${date} ${shop.hours.opens}`, shop.timezone);
      const closes = zonedLocalToEpoch(`${date} ${shop.hours.closes}`, shop.timezone);
      if (opens === null || closes === null || !overlaps(opens, closes)) continue;
      if (timeRanges.some((r) => r.id === `hours-${shop.id}-${date}`)) continue;
      timeRanges.push({ id: `hours-${shop.id}-${date}`, name: `${shop.name} open`, kind: 'shop_hours', startDate: opens, endDate: closes });
    }
  }
  return {
    from,
    to,
    resources: queuers.map((u) => ({ id: u.id, name: u.user.displayName, cityId: u.user.cityId, reliability: u.user.reliability?.score ?? null, avatar: u.user.avatar })),
    events,
    timeRanges,
    generatedAt: now,
  };
}

/** Display names by user id (personas and crowd requesters). */
function names(app: App): Record<string, string> {
  return Object.fromEntries(app.store.users.all().map((u) => [u.id, u.user.displayName]));
}

/** The dashboard datasets, built by the shared opsDatasets (the console builds the same rows). */
export function opsDataset(app: App, name: string): OpsDataset {
  if (!OPS_DATASETS.includes(name as OpsDatasetName)) throw new ContractError('NOT_FOUND', `No dataset ${name}.`, { datasets: OPS_DATASETS });
  const view = {
    bids: app.store.bids.all(),
    holds: app.store.holds.all(),
    asks: app.store.asks.all(),
    matches: app.store.matches.all(),
    jobs: app.store.jobs.all(),
    ledger: app.store.ledger.all(),
    payouts: app.store.payouts.all(),
    books: allItems().map(({ item }) => bookSnapshot(app, item.id)),
    names: names(app),
  };
  return opsDatasets(view, app.now())[name as OpsDatasetName];
}

/** GET /api/ops/records: every record the operator console draws, in one read (admin only). */
export function opsRecords(app: App): OpsRecords {
  return {
    at: app.now(),
    users: app.store.users.where('crowd = 0').map((u) => viewUser(u, OPS_VIEWER)),
    crowd: app.store.users.where('crowd = 1').map((u) => ({ id: u.id, displayName: u.user.displayName, cityId: u.user.cityId })),
    bids: app.store.bids.all(),
    holds: app.store.holds.all(),
    asks: app.store.asks.all(),
    claims: app.store.claims.all(),
    matches: app.store.matches.all(),
    jobs: app.store.jobs.all(),
    proofs: app.store.proofs.all(),
    ledger: app.store.ledger.all(),
    payouts: app.store.payouts.all(),
    agentActions: app.store.agentActions.all(),
  };
}
