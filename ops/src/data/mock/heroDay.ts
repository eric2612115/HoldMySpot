import { CROWD_NAMES, formatUsd, usd } from '@holdmyspot/shared';
import type { MarketMs, UserId } from '@holdmyspot/shared';
import { MINUTE, sf } from '../time.ts';
import {
  checkIn,
  claimBid,
  createWorld,
  endVisit,
  failJob,
  getAsk,
  lapseClaim,
  markBought,
  markRenewalRequired,
  moveJob,
  nextRuleTime,
  noteRequeue,
  passProof,
  placeBid,
  postAsk,
  rejectProof,
  runRulesAt,
  shipJob,
} from './world.ts';
import type { BidSpec, CrowdPerson, ManualMove, World } from './world.ts';

/**
 * The hero day (docs/ARCHITECTURE.md section 8) as seen from the ops console:
 * San Francisco's Japantown, Thursday 2026-11-12, with every San Francisco
 * queuer at work. The Paper Moon part follows the hero script exactly (Mia's
 * hold $60.00, capture $46.00, payout $10.80, final capture $8.75, $5.25
 * released, payout $42.75; Rex's fake receipt moves $0 and Priya's plush goes
 * to Lin at $10). Around it: Jo will miss his Little Lantern check-in and
 * Noor's Venmo hold at Sugar Cloud cannot be renewed. Those two are the
 * rescheduler's proposals; an operator approves them (or the rules act later
 * on their own).
 */

export const DAY_START = sf('10:00');
export const DAY_END = sf('17:00');

/** Moments worth jumping to while filming. */
export const MOMENTS: { id: string; label: string; at: MarketMs }[] = [
  { id: 'clock', label: 'Clock opens', at: sf('10:52') },
  { id: 'trouble', label: 'Two problems', at: sf('11:21') },
  { id: 'gap', label: 'Wei on the way', at: sf('12:05') },
  { id: 'shops', label: 'Lines moving', at: sf('12:40') },
  { id: 'shipped', label: 'Parcels shipped', at: sf('14:10') },
];

export const DEFAULT_MOMENT = sf('11:21');

/** Proposal ids the rescheduler can raise; approving one applies it at the approval time. */
export const PROPOSAL_JO = 'reschedule-jo-little-lantern';
export const PROPOSAL_NOOR = 'reschedule-noor-sugar-cloud';

const CROWD_CITIES: [string, string][] = [
  ['Chicago', 'IL'],
  ['Austin', 'TX'],
  ['Seattle', 'WA'],
  ['Boston', 'MA'],
  ['Denver', 'CO'],
  ['Portland', 'OR'],
];

export const CROWD: CrowdPerson[] = CROWD_NAMES.map((name, i) => {
  const [cityName, region] = CROWD_CITIES[i % CROWD_CITIES.length] ?? ['Chicago', 'IL'];
  return { id: `crowd-${String(i + 1).padStart(2, '0')}`, displayName: name, cityName, region };
});

const crowdId = (n: number) => `crowd-${String(n).padStart(2, '0')}`;
const day = (d: string, hhmm: string) => sf(hhmm, d);
const DEADLINE = day('2026-11-14', '20:00');

type Step = { at: MarketMs; run: (w: World) => void };

/** Bids that already rest in the books when the day starts. */
function seedBids(): BidSpec[] {
  // Paper Moon: the Mochi Bunny plush, one per customer; the crowd is out of state, so every request ships.
  const pm = { shopId: 'paper-moon-toys', itemId: 'plush-paper-moon', retailCapCents: usd(36), shippingBudgetCents: usd(12), deadlineAt: DEADLINE };
  const ll = { shopId: 'little-lantern-toys', itemId: 'plush-little-lantern', retailCapCents: usd(28), deadlineAt: DEADLINE };
  const sc = { shopId: 'sugar-cloud-bakery', itemId: 'cake-sugar-cloud', retailCapCents: usd(40), shippingBudgetCents: 0, deadlineAt: DEADLINE, mode: 'local' as const };
  const sl = { shopId: 'steam-lantern-ramen', itemId: 'ramen-steam-lantern', retailCapCents: usd(20), shippingBudgetCents: 0, deadlineAt: DEADLINE, mode: 'local' as const };
  const pmCrowd: [number, number, string][] = [
    [1, 10.5, '10:10'],
    [2, 10, '10:12'],
    [3, 10, '10:14'],
    [4, 9.5, '09:20'],
    [5, 9, '09:25'],
    [6, 9, '09:31'],
    [7, 8.5, '09:40'],
    [8, 8, '09:45'],
    [9, 7.5, '09:52'],
    [10, 7, '09:58'],
    [11, 6, '10:02'],
  ];
  const bids: BidSpec[] = pmCrowd.map(([n, fee, at]) => ({
    ...pm,
    id: `bid-pm-c${String(n).padStart(2, '0')}`,
    requesterId: crowdId(n),
    qty: 1,
    maxFeeCents: usd(fee),
    createdAt: sf(at),
  }));
  bids.push(
    { ...pm, id: 'bid-pm-priya', requesterId: 'priya', qty: 1, maxFeeCents: usd(11), createdAt: sf('10:20') },
    // Little Lantern: Leo's request is the one Jo will fail to reach.
    { ...ll, id: 'bid-ll-leo', requesterId: 'leo', qty: 1, maxFeeCents: usd(10), shippingBudgetCents: 0, mode: 'local', createdAt: day('2026-11-11', '21:00') },
    { ...ll, id: 'bid-ll-sam', requesterId: 'sam', qty: 1, maxFeeCents: usd(8.5), shippingBudgetCents: 0, mode: 'local', createdAt: sf('10:05') },
    { ...ll, id: 'bid-ll-c12', requesterId: crowdId(12), qty: 2, maxFeeCents: usd(7.5), shippingBudgetCents: usd(13), createdAt: sf('09:50') },
    { ...ll, id: 'bid-ll-c13', requesterId: crowdId(13), qty: 1, maxFeeCents: usd(7), shippingBudgetCents: usd(9), createdAt: sf('09:55') },
    // Sugar Cloud: Noor's hold is four days old and was approved with Venmo: it cannot be reauthorized on day 4.
    { ...sc, id: 'bid-sc-noor', requesterId: 'noor', qty: 2, maxFeeCents: usd(9.5), createdAt: day('2026-11-08', '10:00'), funding: 'venmo' },
    { ...sc, id: 'bid-sc-sam', requesterId: 'sam', qty: 1, maxFeeCents: usd(8.5), createdAt: sf('09:40') },
    { ...sc, id: 'bid-sc-leo', requesterId: 'leo', qty: 1, maxFeeCents: usd(8.5), createdAt: sf('10:02') },
    // Steam Lantern: lunch takeout for later.
    { ...sl, id: 'bid-sl-noor', requesterId: 'noor', qty: 1, maxFeeCents: usd(7), createdAt: sf('09:30') },
    { ...sl, id: 'bid-sl-leo', requesterId: 'leo', qty: 2, maxFeeCents: usd(6.5), createdAt: sf('09:35') },
    // New York: requests resting for later errands (no offers at this hour).
    { id: 'bid-ny-jun', requesterId: 'jun', shopId: 'petal-crumb-bakery', itemId: 'cake-petal-crumb', qty: 1, retailCapCents: usd(40), maxFeeCents: usd(9), shippingBudgetCents: 0, createdAt: sf('10:40'), deadlineAt: DEADLINE },
    { id: 'bid-ny-mia', requesterId: 'mia', shopId: 'petal-crumb-bakery', itemId: 'cake-petal-crumb', qty: 1, retailCapCents: usd(40), maxFeeCents: usd(8), shippingBudgetCents: 0, createdAt: sf('10:45'), deadlineAt: DEADLINE },
    { id: 'bid-ny-priya', requesterId: 'priya', shopId: 'little-orbit-toys', itemId: 'plush-little-orbit', qty: 1, retailCapCents: usd(34), maxFeeCents: usd(6), shippingBudgetCents: 0, mode: 'local', createdAt: sf('10:50'), deadlineAt: DEADLINE },
  );
  return bids;
}

/** The scripted steps, in market time. Approvals are injected by `worldAt`. */
function script(): Step[] {
  const steps: Step[] = [];
  const at = (hhmm: string, run: (w: World) => void) => steps.push({ at: sf(hhmm), run });
  const jobsOf = (w: World, askId: string) => w.jobs.filter((j) => j.askId === askId && j.status !== 'failed');
  const jobFor = (w: World, askId: string, requesterId: UserId) => w.jobs.find((j) => j.askId === askId && j.requesterId === requesterId && j.status !== 'failed');
  const proofs = (askId: string, hhmm: string, unitMinor: number) =>
    at(hhmm, (w) => {
      for (const [i, job] of jobsOf(w, askId).entries()) {
        if (job.status === 'queueing' || job.status === 'bought') passProof(w, job.id, sf(hhmm) + i * MINUTE, sf(hhmm) + (i + 1) * MINUTE, unitMinor * job.qty);
      }
    });

  // ---- Paper Moon Toys: the hero script.
  at('10:31', (w) =>
    placeBid(w, { id: 'bid-pm-mia', requesterId: 'mia', shopId: 'paper-moon-toys', itemId: 'plush-paper-moon', qty: 1, retailCapCents: usd(36), maxFeeCents: usd(12), shippingBudgetCents: usd(12), createdAt: sf('10:31'), deadlineAt: DEADLINE }),
  );
  at('10:33', (w) => claimBid(w, { id: 'ask-rex-pm', bidId: 'bid-pm-priya', queuerId: 'rex', etaAt: sf('10:55'), at: sf('10:33') }));
  at('10:35', (w) =>
    postAsk(w, { id: 'ask-wei-pm', queuerId: 'wei', shopId: 'paper-moon-toys', itemId: 'plush-paper-moon', capacity: 1, feeCents: usd(15), clock: { stepCents: usd(1), intervalMinutes: 5, floorCents: usd(8) }, etaAt: sf('10:50'), createdAt: sf('10:35') }),
  );
  at('10:40', (w) => claimBid(w, { id: 'ask-jo-ll', bidId: 'bid-ll-leo', queuerId: 'jo', etaAt: sf('11:15'), at: sf('10:40') }));
  at('10:50', (w) => checkIn(w, 'claim-wei-pm', sf('10:48'), sf('10:50')));
  at('10:57', (w) => checkIn(w, 'claim-rex-pm', sf('10:56'), sf('10:57')));

  // ---- Little Lantern and Sugar Cloud: offers posted while the Paper Moon clock walks down.
  at('11:05', (w) =>
    postAsk(w, { id: 'ask-ava-ll', queuerId: 'ava', shopId: 'little-lantern-toys', itemId: 'plush-little-lantern', capacity: 3, feeCents: usd(8), clock: null, etaAt: sf('11:12'), createdAt: sf('11:05') }),
  );
  at('11:06', (w) =>
    postAsk(w, { id: 'ask-rin-sc', queuerId: 'rin', shopId: 'sugar-cloud-bakery', itemId: 'cake-sugar-cloud', capacity: 2, feeCents: usd(8.5), clock: null, etaAt: sf('11:12'), createdAt: sf('11:06') }),
  );
  at('11:11', (w) => checkIn(w, 'claim-ava-ll', sf('11:10'), sf('11:11')));
  at('11:12', (w) => checkIn(w, 'claim-rin-sc', sf('11:11'), sf('11:12')));
  // The 11:15 sweep: Noor's untouched hold is past its honor period and Venmo cannot be reauthorized.
  at('11:15', (w) => markRenewalRequired(w, 'bid-sc-noor', sf('11:15')));
  at('11:16', (w) => markBought(w, jobsOf(w, 'ask-rex-pm').map((j) => j.id), sf('11:16')));
  at('11:18', (w) => {
    const rex = jobsOf(w, 'ask-rex-pm')[0];
    if (rex) rejectProof(w, rex.id, sf('11:17'), sf('11:18'), "Another store's ID is on the QR, the receipt was printed before check-in, the line does not add up to the total and the item photo matches an older upload.");
  });
  at('11:20', (w) =>
    postAsk(w, { id: 'ask-lin-pm', queuerId: 'lin', shopId: 'paper-moon-toys', itemId: 'plush-paper-moon', capacity: 1, feeCents: usd(10), clock: null, etaAt: sf('11:30'), createdAt: sf('11:20') }),
  );
  at('11:30', (w) => checkIn(w, 'claim-lin-pm', sf('11:29'), sf('11:30')));

  // ---- Receipts: one per requester; proofs pass one by one.
  at('11:38', (w) => markBought(w, jobsOf(w, 'ask-wei-pm').map((j) => j.id), sf('11:38')));
  at('11:42', (w) => {
    const job = jobFor(w, 'ask-wei-pm', 'mia');
    if (job) passProof(w, job.id, sf('11:41'), sf('11:42'), 3400);
  });
  at('11:40', (w) => markBought(w, jobsOf(w, 'ask-ava-ll').map((j) => j.id), sf('11:40')));
  proofs('ask-ava-ll', '11:44', 2600);
  at('11:46', (w) => endVisit(w, 'claim-wei-pm', sf('11:46')));
  at('11:50', (w) => markBought(w, jobsOf(w, 'ask-lin-pm').map((j) => j.id), sf('11:50')));
  at('11:52', (w) => {
    const job = jobFor(w, 'ask-lin-pm', 'priya');
    if (job) passProof(w, job.id, sf('11:51'), sf('11:52'), 3400);
  });
  at('11:54', (w) => {
    endVisit(w, 'claim-lin-pm', sf('11:54'));
    endVisit(w, 'claim-ava-ll', sf('11:54'));
  });

  // ---- Lunch: Wei offers at Steam Lantern with a slow clock; Rin buys the cakes at Sugar Cloud.
  at('12:00', (w) =>
    postAsk(w, { id: 'ask-wei-sl', queuerId: 'wei', shopId: 'steam-lantern-ramen', itemId: 'ramen-steam-lantern', capacity: 2, feeCents: usd(9), clock: { stepCents: usd(1), intervalMinutes: 10, floorCents: usd(5) }, etaAt: sf('12:15'), createdAt: sf('12:00') }),
  );
  at('12:06', (w) => markBought(w, jobsOf(w, 'ask-rin-sc').map((j) => j.id), sf('12:06')));
  proofs('ask-rin-sc', '12:08', 3800);
  at('12:12', (w) => endVisit(w, 'claim-rin-sc', sf('12:12')));
  at('12:14', (w) => checkIn(w, 'claim-wei-sl', sf('12:13'), sf('12:14')));
  at('12:50', (w) => markBought(w, jobsOf(w, 'ask-wei-sl').map((j) => j.id), sf('12:50')));
  proofs('ask-wei-sl', '12:52', 1900);
  at('12:56', (w) => endVisit(w, 'claim-wei-sl', sf('12:56')));

  // ---- 14:00: parcels go out with tracking; final captures release what is left.
  at('14:00', (w) => {
    const mia = jobFor(w, 'ask-wei-pm', 'mia');
    if (mia) shipJob(w, mia.id, sf('14:00'), usd(8.75), 0, 'HPG000014US');
  });
  at('14:05', (w) => {
    const priya = jobFor(w, 'ask-lin-pm', 'priya');
    if (priya) shipJob(w, priya.id, sf('14:05'), usd(8.75), 0, 'HPG000015US');
  });
  return steps;
}

/** Jo's approved reschedule: lapse his claim now and let the rules re-offer Leo's plush. */
function approveJo(w: World, at: MarketMs): void {
  const claim = w.claims.find((c) => c.id === 'claim-jo-ll');
  if (!claim || claim.status !== 'awaiting_arrival') return;
  const failed = lapseClaim(w, claim.id, at);
  noteRequeue(w, failed, at, 'Jo could not reach Little Lantern Toys before his window closed (approved early by ops)');
}

/** Noor's approved reschedule: release Rin's two cakes from Noor's unusable hold to the next requests. */
function approveNoor(w: World, at: MarketMs): void {
  const job = w.jobs.find((j) => j.bidId === 'bid-sc-noor' && j.status !== 'failed');
  if (!job || !['claimed', 'checked_in', 'queueing'].includes(job.status)) return;
  failJob(w, job.id, at, 'hold_unavailable', "Noor's hold needs a new approval before Rin can buy.", { requeue: true, freeCapacity: true });
  const taken = w.matches.filter((m) => m.askId === job.askId && m.at === at && m.trigger === 'requeue');
  const ask = getAsk(w, job.askId);
  const names = taken.map((m) => w.bids.find((b) => b.id === m.bidId)?.requesterName ?? m.bidId);
  const fee = taken[0]?.feeCents ?? ask.feeCents;
  w.notes.push({
    id: `agent-noor-${at}`,
    bidId: job.bidId,
    at,
    kind: 'reassign',
    fromFeeCents: job.feeCents,
    toFeeCents: taken[0]?.feeCents ?? null,
    reason:
      names.length > 0
        ? `Noor A.'s Venmo hold could not be renewed, so ${ask.queuerName}'s ${job.qty} cakes went to ${names.join(' and ')} at ${formatUsd(fee, { exact: true })} each (approved by ops). Noor keeps her place once she approves a new hold.`
        : `Noor A.'s Venmo hold could not be renewed; ${ask.queuerName}'s ${job.qty} cakes went back to the line-up (approved by ops).`,
    ai: { provider: 'fake', model: 'rules', mode: 'fake', latencyMs: 0 },
  });
}

export interface Approvals {
  [proposalId: string]: MarketMs;
}

/**
 * The world at market time `t`. Deterministic: the same time and approvals
 * always give the same records, ids included.
 */
export function worldAt(t: MarketMs, approvals: Approvals = {}, moves: readonly ManualMove[] = []): World {
  const w = createWorld(DAY_START, CROWD, ['claim-jo-ll']);
  for (const spec of seedBids()) placeBid(w, spec);
  const steps = script();
  for (const move of moves) steps.push({ at: move.at, run: (x) => void moveJob(x, move) });
  const jo = approvals[PROPOSAL_JO];
  if (jo !== undefined) steps.push({ at: jo, run: (x) => approveJo(x, jo) });
  const noor = approvals[PROPOSAL_NOOR];
  if (noor !== undefined) steps.push({ at: noor, run: (x) => approveNoor(x, noor) });
  steps.sort((a, b) => a.at - b.at);

  for (const step of steps) {
    if (step.at > t) break;
    advance(w, step.at);
    step.run(w);
  }
  advance(w, t);
  w.now = t;
  return w;
}

/** Runs the time-driven rules (clock steps, lapsed windows) up to and including `to`. */
function advance(w: World, to: MarketMs): void {
  let guard = 0;
  for (;;) {
    const next = nextRuleTime(w, w.now);
    if (next === null || next > to) break;
    w.now = next;
    runRulesAt(w, next);
    if (++guard > 500) break;
  }
  w.now = Math.max(w.now, to);
}
