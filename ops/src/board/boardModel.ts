import { SEED_SHOPS, askFeeAt, formatUsd, ladder, platformFeeCents } from '@holdmyspot/shared';
import type { AskTask, BoardEvent, Job, MarketMs, Shop } from '@holdmyspot/shared';
import type { BoardBundle, Proposal } from '../data/backend.ts';
import { clockText, heroOffsetMin } from '../data/time.ts';

/**
 * Turns the contract's BoardData (plus the records it references) into the
 * rows and bars Bryntum draws. Bryntum Community renders in the browser's
 * own time zone, so market times are shifted to San Francisco wall-clock
 * time here and nowhere else.
 */

export function toWall(ms: MarketMs): Date {
  const local = -new Date(ms).getTimezoneOffset();
  return new Date(ms + (heroOffsetMin(ms) - local) * 60_000);
}

export function fromWall(d: Date): MarketMs {
  const local = -d.getTimezoneOffset();
  return d.getTime() - (heroOffsetMin(d.getTime()) - local) * 60_000;
}

export type BarTone = 'window' | 'line' | 'clock' | 'job' | 'ship' | 'ghost';

export interface ClockStep {
  at: MarketMs;
  label: string;
  /** 0..1 across the bar. */
  x: number;
  state: 'past' | 'now' | 'next';
}

export interface BarRecord {
  id: string;
  resourceId: string;
  name: string;
  startDate: Date;
  endDate: Date;
  kind: BoardEvent['kind'] | 'proposal';
  status: string;
  tone: BarTone;
  title: string;
  sub: string;
  chip: { text: string; tone: 'held' | 'captured' | 'paid' | 'released' | 'hot' | 'sun' | 'grape' | 'quiet' } | null;
  steps: ClockStep[] | null;
  /** 0..1: how much of the bar is already behind the market clock. */
  progress: number;
  issue: 'at_risk' | 'payment' | null;
  shopId: string | null;
  jobId: string | null;
  draggable: boolean;
  resizable: boolean;
  cls: string;
}

export interface QueuerRow {
  id: string;
  name: string;
  initial: string;
  reliability: number | null;
  status: string;
  shopId: string | null;
  accent: string;
  earnedCents: number;
  alert: boolean;
}

const shopOf = (id: string | undefined): Shop | undefined => SEED_SHOPS.find((s) => s.id === id);
const usd = (c: number) => formatUsd(c, { exact: c % 100 !== 0 });

function progressOf(start: MarketMs, end: MarketMs, now: MarketMs): number {
  if (end <= start) return now >= start ? 1 : 0;
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
}

function clockSteps(ask: AskTask, start: MarketMs, end: MarketMs, now: MarketMs): ClockStep[] {
  if (!ask.clock) return [];
  const steps = ladder({ openCents: ask.feeCents, stepCents: ask.clock.stepCents, intervalMs: ask.clock.intervalMs, floorCents: ask.clock.floorCents, startsAt: start });
  const span = Math.max(end - start, 1);
  const current = askFeeAt({ feeCents: ask.feeCents, clock: { ...ask.clock, startsAt: start } }, now);
  return steps
    .filter((s) => s.at <= end + 1)
    .map((s) => ({
      at: s.at,
      label: usd(s.priceCents),
      x: Math.min(1, (s.at - start) / span),
      state: ask.clock?.startsAt === null || s.at > now ? 'next' : s.priceCents === current ? 'now' : 'past',
    }));
}

const FAILURE_TEXT: Record<string, string> = {
  proof_rejected: 'Receipt failed, $0 moved',
  no_show: 'No-show, re-offered',
  hold_unavailable: 'Hold needs approval',
  payment_failed: 'Capture declined',
  queuer_withdrew: 'Moved by ops',
  sold_out: 'Sold out',
};

function jobChip(job: Job): BarRecord['chip'] {
  if (job.failure) return { text: FAILURE_TEXT[job.failure.reason] ?? job.failure.reason, tone: 'hot' };
  if (job.status === 'shipped' || job.status === 'delivered') return { text: `Captured ${usd(job.amounts.capturedCents)}`, tone: 'captured' };
  if (job.status === 'verified') return { text: `Captured ${usd(job.amounts.capturedCents)}`, tone: 'captured' };
  if (job.status === 'proof_submitted') return { text: 'Checking proof', tone: 'grape' };
  if (job.status === 'bought') return { text: 'Bought', tone: 'grape' };
  return { text: 'Held', tone: 'held' };
}

export function buildBars(bundle: BoardBundle, proposals: Proposal[], now: MarketMs): BarRecord[] {
  const bars: BarRecord[] = [];
  const atRisk = new Map<string, 'at_risk' | 'payment'>();
  for (const p of proposals) {
    if (p.status !== 'open') continue;
    for (const id of p.affectedJobIds) atRisk.set(id, p.kind === 'payment_failed' ? 'payment' : 'at_risk');
  }

  for (const e of bundle.board.events) {
    const base = {
      id: e.id,
      resourceId: e.resourceId,
      name: e.name,
      startDate: toWall(e.startDate),
      endDate: toWall(e.endDate),
      kind: e.kind,
      status: e.status,
      progress: progressOf(e.startDate, e.endDate, now),
      issue: null,
      steps: null,
      chip: null,
      draggable: false,
      resizable: false,
      jobId: e.refs.jobId ?? null,
    } satisfies Partial<BarRecord>;
    const claim = e.refs.claimId ? bundle.claims[e.refs.claimId] : undefined;
    const ask = e.refs.askId ? bundle.asks[e.refs.askId] : undefined;
    const shop = shopOf(claim?.shopId ?? ask?.shopId);
    const shopId = shop?.id ?? null;

    if (e.kind === 'claim_window') {
      const lapsed = e.status === 'lapsed';
      const due = claim ? clockText(claim.windowEndsAt) : '';
      bars.push({
        ...base,
        tone: 'window',
        title: lapsed ? `Missed ${shop?.name ?? ''}` : (shop?.name ?? e.name),
        sub: lapsed ? `Window closed ${due}` : e.status === 'checked_in' || e.status === 'done' ? `Checked in ${claim?.checkedInAt ? clockText(claim.checkedInAt) : ''}` : `On the way, check in by ${due}`,
        chip: lapsed ? { text: 'Lapsed', tone: 'hot' } : null,
        shopId,
        cls: `hms-bar hms-window${lapsed ? ' is-lapsed' : ''}`,
      });
    } else if (e.kind === 'queueing') {
      const planned = e.status === 'planned';
      bars.push({
        ...base,
        tone: 'line',
        title: planned ? `Line at ${shop?.name ?? ''}` : `In line at ${shop?.name ?? ''}`,
        sub: planned ? `Expected from ${clockText(e.startDate)}` : e.status === 'done' ? `Done ${clockText(e.endDate)}` : `Counter about ${clockText(e.endDate)}`,
        shopId,
        cls: `hms-bar hms-line${planned ? ' is-planned' : ''}`,
      });
    } else if (e.kind === 'fee_clock' && ask?.clock) {
      const steps = clockSteps(ask, e.startDate, e.endDate, now);
      const fee = askFeeAt(ask, now);
      const planned = e.status === 'planned';
      bars.push({
        ...base,
        tone: 'clock',
        title: planned ? `Clock ${usd(ask.feeCents)} to ${usd(ask.clock.floorCents)}` : `Fee now ${usd(fee)}`,
        sub: `${usd(ask.clock.stepCents)} every ${Math.round(ask.clock.intervalMs / 60_000)} min, floor ${usd(ask.clock.floorCents)}`,
        steps,
        shopId,
        cls: `hms-bar hms-clock${planned ? ' is-planned' : ''}`,
      });
    } else if (e.kind === 'job') {
      const job = e.refs.jobId ? bundle.jobs[e.refs.jobId] : undefined;
      if (!job) continue;
      const js = shopOf(job.shopId);
      if (e.id.startsWith('ship-')) {
        bars.push({
          ...base,
          tone: 'ship',
          title: `Shipped to ${job.requesterName}`,
          sub: job.shipment ? `${job.shipment.carrierName} ${job.shipment.trackingNumber}` : '',
          chip: { text: `Paid ${usd(job.amounts.paidOutCents)}`, tone: 'paid' },
          shopId: js?.id ?? null,
          cls: 'hms-bar hms-ship',
        });
        continue;
      }
      const issue = atRisk.get(job.id) ?? null;
      const before = ['claimed', 'checked_in', 'queueing'].includes(job.status);
      bars.push({
        ...base,
        tone: 'job',
        title: `${job.requesterName}${job.qty > 1 ? ` x${job.qty}` : ''}`,
        sub: `${usd(job.feeCents)} fee${job.qty > 1 ? ' each' : ''}, matched ${clockText(job.createdAt)}`,
        chip: jobChip(job),
        issue,
        shopId: js?.id ?? null,
        draggable: before,
        cls: `hms-bar hms-job is-${job.status}${issue ? ` has-${issue}` : ''}${before ? ' is-movable' : ''}`,
      });
    } else if (e.kind === 'hold_honor') {
      bars.push({
        ...base,
        tone: 'window',
        title: e.name,
        sub: 'PayPal honor period',
        shopId,
        cls: 'hms-bar hms-hold',
      });
    }
  }

  // Ghost bars: where the rescheduler would move work if an operator approves.
  for (const p of proposals) {
    if (p.status !== 'open') continue;
    for (const m of p.moves) {
      bars.push({
        id: `ghost-${p.id}-${m.jobId}`,
        resourceId: m.queuerId,
        name: m.requesterName,
        startDate: toWall(m.startAt),
        endDate: toWall(m.endAt),
        kind: 'proposal',
        status: 'proposed',
        tone: 'ghost',
        title: `${m.requesterName}${m.qty > 1 ? ` x${m.qty}` : ''}`,
        sub: `Proposed at ${usd(m.feeCents)}${m.qty > 1 ? ' each' : ''}`,
        chip: { text: 'Needs approval', tone: 'grape' },
        steps: null,
        progress: 0,
        issue: null,
        shopId: p.shopId,
        jobId: null,
        draggable: false,
        resizable: false,
        cls: 'hms-bar hms-ghost',
      });
    }
  }
  return bars;
}

export function buildRows(bundle: BoardBundle, proposals: Proposal[], now: MarketMs): QueuerRow[] {
  const jobs = Object.values(bundle.jobs);
  const claims = Object.values(bundle.claims);
  return bundle.board.resources.map((r) => {
    const mine = claims.filter((c) => c.queuerId === r.id && c.createdAt <= now).sort((a, b) => b.createdAt - a.createdAt);
    const current = mine[0];
    const shop = shopOf(current?.shopId);
    let status = 'Free';
    if (current && shop) {
      if (current.status === 'awaiting_arrival' || current.status === 'arrived') status = `On the way to ${shop.name}, ETA ${clockText(bundle.asks[current.askId]?.etaAt ?? current.windowEndsAt)}`;
      else if (current.status === 'checked_in') status = `In line at ${shop.name} since ${clockText(current.checkedInAt ?? now)}`;
      else if (current.status === 'lapsed') status = `Missed check-in at ${shop.name}`;
      else if (current.status === 'done') status = `Done at ${shop.name}`;
    }
    // Fees earned today: the matched fee minus the platform fee, once the receipt capture is done.
    const earnedCents = jobs
      .filter((j) => j.queuerId === r.id && ['verified', 'shipped', 'delivered'].includes(j.status))
      .reduce((s, j) => s + j.feeCents * j.qty - platformFeeCents(j.feeCents * j.qty), 0);
    const alert = proposals.some((p) => p.status === 'open' && (p.queuerId === r.id || p.moves.some((m) => m.queuerId === r.id)));
    return {
      id: r.id,
      name: r.name,
      initial: r.name.slice(0, 1),
      reliability: r.reliability,
      status,
      shopId: shop?.id ?? null,
      accent: shop?.accent ?? '#7e839d',
      earnedCents,
      alert,
    };
  });
}
