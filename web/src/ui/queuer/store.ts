import { formatUsd } from '@holdmyspot/shared';
import type { AskTask, Claim, ClaimDetail, HelloEvent, Job, JobDetail, Match, Payout, Proof, User } from '@holdmyspot/shared';
import { create } from 'zustand';
import type { Reach } from '../../domain/earning';
import type { TaskPoint } from '../../domain/types';
import { api, ApiError } from '../../services/api';
import { useMarket } from '../../state/market';
import { usePosition } from '../../state/position';
import { onStreamEvent, type StreamEvent } from '../../state/serverMarket';
import { clock, params } from '../../state/services';
import { activeClaimId, isStale, type OfferForm, type QueuerRecords } from './logic';
import { usePhone } from './phone';
import { uploadPhoto } from './photos';

/**
 * The queuer's phone (docs/WEB-INTEGRATION.md section 7): their offers and
 * visits (asks and claims, with the one-time check-in code), the jobs matched
 * to them (with each job's proof code), the AI checks and the payouts. REST
 * once, then the queuer persona's own event stream (forwarded by
 * state/serverMarket.ts). Every action calls the contract's endpoints as the
 * queuer persona; the server decides, this store only shows records.
 */

export interface QueuerState extends QueuerRecords {
  ready: boolean;
  queuerId: string | null;
  requesterId: string | null;
  /** The requester persona's own jobs (the handover code of a local errand is only on the requester's phone). */
  requesterJobs: Record<string, Job>;
  users: User[];
  /** The visit on screen. */
  focusId: string | null;
  sheetOpen: boolean;
  /** What is in flight, in words, or null. */
  busy: string | null;
  error: string | null;
}

export const useQueuer = create<QueuerState>()(() => ({
  ready: false,
  queuerId: null,
  requesterId: null,
  claims: {},
  asks: {},
  jobs: {},
  proofs: {},
  payouts: {},
  requesterJobs: {},
  users: [],
  focusId: null,
  sheetOpen: false,
  busy: null,
  error: null,
}));

const get = () => useQueuer.getState();
if (import.meta.env.DEV) Object.assign(window as object, { __queuer: useQueuer });
const set = useQueuer.setState;
const key = () => crypto.randomUUID();

let started = false;
let bootId: string | null = null;
let reloadTimer = 0;

/** The visit on screen survives a reload of the page (per queuer, this tab only), so a finished payout stays until "Done". */
const memoryKey = () => `hms.queuer.${get().queuerId ?? ''}`;

function remember(focusId: string | null, sheetOpen: boolean) {
  try {
    window.sessionStorage.setItem(memoryKey(), JSON.stringify({ focusId, sheetOpen }));
  } catch {
    /* Private mode: the phone just starts on the map. */
  }
}

function recall(): { focusId: string | null; sheetOpen: boolean } | null {
  try {
    const raw = window.sessionStorage.getItem(memoryKey());
    return raw ? (JSON.parse(raw) as { focusId: string | null; sheetOpen: boolean }) : null;
  } catch {
    return null;
  }
}

function message(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

/** Toasts for the queuer only show on the queuer's phone. */
function tell(text: string, tone: 'money' | 'info' | 'win' = 'info') {
  if (usePhone.getState().phone === 'queuer') useMarket.getState().toast(text, tone);
}

/** Keeps the latest copy per id; an older copy (a late HTTP answer) never replaces a newer one from the stream. */
function upsert<T extends { id: string }>(rec: Record<string, T>, items: readonly T[], kind?: 'claim' | 'job' | 'proof' | 'payout' | 'ask'): Record<string, T> {
  if (items.length === 0) return rec;
  const next = { ...rec };
  for (const it of items) {
    if (kind && isStale(kind, next[it.id] as never, it as never)) continue;
    next[it.id] = it;
  }
  return next;
}

function applyDetail(d: ClaimDetail) {
  set((s) => ({ claims: upsert(s.claims, [d.claim], 'claim'), asks: upsert(s.asks, [d.ask], 'ask'), jobs: upsert(s.jobs, d.jobs, 'job') }));
}

function applyJobDetail(d: JobDetail) {
  set((s) => ({
    jobs: upsert(s.jobs, [d.job], 'job'),
    asks: upsert(s.asks, [d.ask], 'ask'),
    claims: s.claims[d.claim.id]?.checkInCode && !d.claim.checkInCode ? s.claims : upsert(s.claims, [d.claim], 'claim'),
    proofs: upsert(s.proofs, d.proofs, 'proof'),
    payouts: upsert(s.payouts, d.payouts, 'payout'),
  }));
}

async function loadAll(): Promise<void> {
  const { queuerId: q, requesterId: r } = get();
  if (!q) return;
  const [{ asks }, { jobs }, { payouts }, mine, { users }] = await Promise.all([
    api('GET /api/asks', {}, null, { as: q, query: { mine: '1' } }),
    api('GET /api/jobs', {}, null, { as: q, query: { mine: '1', role: 'queuer' } }),
    api('GET /api/payouts', {}, null, { as: q, query: { mine: '1' } }),
    r ? api('GET /api/jobs', {}, null, { as: r, query: { mine: '1', role: 'requester' } }) : Promise.resolve({ jobs: [] as Job[] }),
    api('GET /api/users', {}, null),
  ]);
  // The newest visits are the ones the phone shows; older ones stay on the server.
  const recent = asks.slice(0, 4);
  const details = (await Promise.all(recent.map((a) => api('GET /api/claims/:claimId', { claimId: a.claimId }, null, { as: q }).catch(() => null)))).filter(
    (d): d is ClaimDetail => d !== null,
  );
  const jobIds = details.flatMap((d) => d.jobs.map((j) => j.id));
  const jobDetails = (await Promise.all(jobIds.map((id) => api('GET /api/jobs/:jobId', { jobId: id }, null, { as: q }).catch(() => null)))).filter(
    (d): d is JobDetail => d !== null,
  );
  set({
    claims: {},
    asks: upsert({}, asks),
    jobs: upsert({}, jobs),
    proofs: {},
    payouts: upsert({}, payouts),
    requesterJobs: upsert({}, mine.jobs),
    users,
  });
  for (const d of details) applyDetail(d);
  for (const d of jobDetails) applyJobDetail(d);
  const s = get();
  const kept = recall();
  const focus = s.focusId && s.claims[s.focusId] ? s.focusId : kept?.focusId && s.claims[kept.focusId] ? kept.focusId : activeClaimId(s);
  set({ ready: true, focusId: focus, sheetOpen: s.sheetOpen || (!!focus && kept?.focusId === focus && kept.sheetOpen) });
}

function scheduleReload() {
  window.clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => void loadAll().catch(() => undefined), 300);
}

async function refreshClaim(claimId: string) {
  const q = get().queuerId;
  if (!q) return;
  try {
    applyDetail(await api('GET /api/claims/:claimId', { claimId }, null, { as: q }));
  } catch {
    /* The next event brings it back. */
  }
}

function onEvent(e: StreamEvent) {
  const s = get();
  if (e.type === 'hello') {
    const h = e.data as HelloEvent;
    if (e.who === 'queuer') {
      if (bootId !== null && h.bootId !== bootId) scheduleReload();
      bootId = h.bootId;
    }
    return;
  }
  if (e.type === 'resync') {
    scheduleReload();
    return;
  }
  if (e.who === 'requester') {
    if (e.type === 'job.updated') {
      const j = e.data as Job;
      if (j.requesterId === s.requesterId) set((st) => ({ requesterJobs: upsert(st.requesterJobs, [j], 'job') }));
    }
    return;
  }
  switch (e.type) {
    case 'claim.updated': {
      const c = e.data as Claim;
      if (c.queuerId !== s.queuerId) return;
      const before = s.claims[c.id];
      // A redacted copy never replaces the queuer's own code.
      const merged = before?.checkInCode && !c.checkInCode ? { ...c, checkInCode: before.checkInCode, arrival: c.arrival ?? before.arrival } : c;
      set((st) => ({ claims: upsert(st.claims, [merged], 'claim') }));
      if (before && before.status !== c.status && c.status === 'lapsed') tell('The arrival window ended before check-in. The request went back to the book.', 'info');
      return;
    }
    case 'ask.updated': {
      const a = e.data as AskTask;
      if (a.queuerId === s.queuerId) set((st) => ({ asks: upsert(st.asks, [a], 'ask') }));
      return;
    }
    case 'match.created': {
      const m = e.data as Match;
      const a = s.asks[m.askId];
      if (a) void refreshClaim(a.claimId);
      return;
    }
    case 'job.updated': {
      const j = e.data as Job;
      if (j.queuerId !== s.queuerId) return;
      const before = s.jobs[j.id];
      set((st) => ({ jobs: upsert(st.jobs, [j], 'job') }));
      if (!before) tell(`Matched: ${j.requesterName}'s request, a ${formatUsd(j.feeCents)} fee.`, 'money');
      else if (before.status !== j.status && j.status === 'failed' && j.failure?.reason === 'sold_out') tell('Sold out reported. Nothing was charged and the hold is released.', 'info');
      return;
    }
    case 'proof.updated': {
      const p = e.data as Proof;
      const before = s.proofs[p.id];
      set((st) => ({ proofs: upsert(st.proofs, [p], 'proof') }));
      const mine = (p.claimId && s.claims[p.claimId]) || (p.jobId && s.jobs[p.jobId]);
      if (!mine || before?.status === p.status || p.status === 'verifying') return;
      if (p.kind === 'check_in') tell(p.status === 'passed' ? 'Line photo passed: you are checked in.' : p.status === 'failed' ? 'Line photo failed. Read why and try again.' : 'A person will check the line photo.', p.status === 'passed' ? 'win' : 'info');
      else if (p.status === 'passed') tell(p.amounts?.captureCents ? `Receipt passed. PayPal captured ${formatUsd(p.amounts.captureCents, { exact: true })}.` : 'Receipt passed.', 'money');
      else if (p.status === 'failed') tell('Receipt rejected: $0 moved.', 'info');
      return;
    }
    case 'payout.updated': {
      const p = e.data as Payout;
      if (p.recipientUserId !== s.queuerId) return;
      const before = s.payouts[p.id];
      set((st) => ({ payouts: upsert(st.payouts, [p], 'payout') }));
      if (p.status === 'succeeded' && before?.status !== 'succeeded') tell(`Paid ${formatUsd(p.amount.cents, { exact: true })} by PayPal Payouts.`, 'money');
      return;
    }
  }
}

/** Starts following the queuer persona (once per page load). */
export async function startQueuer(persona: { requesterId: string; queuerId: string }): Promise<void> {
  if (started) return;
  started = true;
  set({ queuerId: persona.queuerId, requesterId: persona.requesterId });
  onStreamEvent(onEvent);
  useQueuer.subscribe((now, before) => {
    if (now.ready && (now.focusId !== before.focusId || now.sheetOpen !== before.sheetOpen)) remember(now.focusId, now.sheetOpen);
  });
  try {
    await loadAll();
  } catch (err) {
    set({ ready: true, error: message(err) });
  }
}

/** Runs one queuer action: one at a time, with its error shown on the errand. */
async function run<T>(label: string, fn: (q: string) => Promise<T>): Promise<T | null> {
  const q = get().queuerId;
  if (!q || get().busy) return null;
  set({ busy: label, error: null });
  try {
    return await fn(q);
  } catch (err) {
    const text = message(err);
    set({ error: text });
    useMarket.getState().toast(text, 'info');
    return null;
  } finally {
    set({ busy: null });
  }
}

function markTaken(point: TaskPoint, feeCents: number, windowEndsAt: number) {
  useMarket.setState((s) => ({ taken: { ...s.taken, [point.id]: { pointId: point.id, feeCents, status: 'taken', at: clock.now(), windowEndsAt } } }));
}

/** Where the queuer stands for the server: the avatar's spot, with the accuracy of a demo fix or a phone's GPS. */
function here(): { lngLat: [number, number]; accuracyM: number } {
  const pos = usePosition.getState();
  return { lngLat: pos.lngLat, accuracyM: params.demo || pos.source === 'demo' ? 8 : 15 };
}

async function postAsk(q: string, point: TaskPoint, form: OfferForm, tripMinutes: number): Promise<Claim> {
  // The ETA must still cover the trip when the request leaves (the sheet may have been open a while).
  const etaAt = Math.max(form.etaAt, clock.now() + (tripMinutes + 1) * 60_000);
  const out = await api(
    'POST /api/asks',
    {},
    { shopId: point.shop.id, itemId: point.id, capacity: form.capacity, modes: [...point.modes], feeCents: form.feeCents, clock: form.clock, etaAt, from: here() },
    { as: q, idempotencyKey: key() },
  );
  set((s) => ({ asks: upsert(s.asks, [out.ask], 'ask'), claims: upsert(s.claims, [out.claim], 'claim'), focusId: out.claim.id, sheetOpen: true }));
  markTaken(point, form.feeCents, out.claim.windowEndsAt);
  await refreshClaim(out.claim.id);
  return out.claim;
}

export const queuerActions = {
  /** "Take this task": an offer at the top request's fee, arriving after the trip shown, which fills that request at once. */
  take(point: TaskPoint, reach: Reach) {
    if (point.bestFeeCents === null) return Promise.resolve(null);
    const form: OfferForm = { feeCents: point.bestFeeCents, clock: null, etaAt: reach.arriveAt, capacity: 1 };
    return run('Taking the task', (q) => postAsk(q, point, form, reach.travelMin));
  },
  /** An offer of the queuer's own: fee, optional step-down, ETA and how many they can buy. */
  offer(point: TaskPoint, form: OfferForm, tripMinutes: number) {
    return run('Posting your offer', (q) => postAsk(q, point, form, tripMinutes));
  },
  checkIn(claim: Claim, photo: Blob) {
    return run('Checking in', async (q) => {
      const file = await uploadPhoto(q, 'line_photo', photo);
      const out = await api('POST /api/claims/:claimId/check-in', { claimId: claim.id }, { ...here(), photoFileId: file.id }, { as: q, idempotencyKey: key() });
      set((s) => ({ claims: upsert(s.claims, [out.claim], 'claim'), jobs: upsert(s.jobs, out.jobs, 'job'), proofs: out.proof ? upsert(s.proofs, [out.proof], 'proof') : s.proofs }));
      return out;
    });
  },
  bought(job: Job) {
    return run('Marking it bought', async (q) => {
      const out = await api('POST /api/jobs/:jobId/bought', { jobId: job.id }, null, { as: q, idempotencyKey: key() });
      set((s) => ({ jobs: upsert(s.jobs, [out.job], 'job') }));
      return out;
    });
  },
  soldOut(job: Job, photo: Blob | null) {
    return run('Reporting the sell-out', async (q) => {
      const file = photo ? await uploadPhoto(q, 'sold_out_photo', photo) : null;
      const out = await api('POST /api/jobs/:jobId/sold-out', { jobId: job.id }, { photoFileId: file?.id ?? null }, { as: q, idempotencyKey: key() });
      set((s) => ({ jobs: upsert(s.jobs, [out.job], 'job') }));
      await refreshClaim(job.claimId);
      return out;
    });
  },
  proof(job: Job, receipt: Blob, item: Blob) {
    return run('Sending the photos', async (q) => {
      const r = await uploadPhoto(q, 'receipt', receipt);
      const i = await uploadPhoto(q, 'item_photo', item);
      const out = await api('POST /api/jobs/:jobId/proof', { jobId: job.id }, { receiptFileId: r.id, itemFileId: i.id }, { as: q, idempotencyKey: key() });
      set((s) => ({ jobs: upsert(s.jobs, [out.job], 'job'), proofs: upsert(s.proofs, [out.proof], 'proof') }));
      return out;
    });
  },
  ship(job: Job, form: { carrierName: string; trackingNumber: string; shippingCostCents: number; dutyPaidCents: number }) {
    return run('Adding tracking', async (q) => {
      const out = await api('POST /api/jobs/:jobId/shipment', { jobId: job.id }, { ...form, labelFileId: null }, { as: q, idempotencyKey: key() });
      set((s) => ({ jobs: upsert(s.jobs, [out.job], 'job') }));
      return out;
    });
  },
  handover(job: Job, code: string) {
    return run('Checking the code', async (q) => {
      const out = await api('POST /api/jobs/:jobId/handover', { jobId: job.id }, { code }, { as: q, idempotencyKey: key() });
      set((s) => ({ jobs: upsert(s.jobs, [out.job], 'job') }));
      return out;
    });
  },
  withdraw(ask: AskTask) {
    return run('Cancelling the visit', async (q) => {
      const out = await api('POST /api/asks/:askId/withdraw', { askId: ask.id }, null, { as: q, idempotencyKey: key() });
      set((s) => ({ asks: upsert(s.asks, [out.ask], 'ask'), claims: upsert(s.claims, [out.claim], 'claim'), jobs: upsert(s.jobs, out.jobs, 'job') }));
      useMarket.setState((m) => ({ taken: { ...m.taken, [ask.itemId]: undefined } }));
      return out;
    });
  },
  endVisit(claim: Claim) {
    return run('Ending the visit', async (q) => {
      const out = await api('POST /api/claims/:claimId/done', { claimId: claim.id }, null, { as: q, idempotencyKey: key() });
      applyDetail(out);
      return out;
    });
  },
  open(claimId: string | null) {
    set({ focusId: claimId ?? get().focusId, sheetOpen: true, error: null });
  },
  close() {
    set({ sheetOpen: false });
  },
  /** Leaves a finished visit: the phone goes back to the map. */
  dismiss() {
    const s = get();
    const focus = s.focusId ? s.claims[s.focusId] : null;
    if (focus) useMarket.setState((m) => ({ taken: { ...m.taken, [s.asks[focus.askId]?.itemId ?? '']: undefined } }));
    const rest = { ...s, claims: Object.fromEntries(Object.entries(s.claims).filter(([id]) => id !== s.focusId)) };
    set({ focusId: activeClaimId(rest), sheetOpen: false, error: null });
  },
};
