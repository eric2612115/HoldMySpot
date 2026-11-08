import assert from 'node:assert/strict';
import { test } from 'node:test';
import fc from 'fast-check';
import { JOB_BEFORE_PURCHASE, askFeeAt } from '@holdmyspot/shared';
import type { Job, MarketMs, UserId } from '@holdmyspot/shared';
import { MINUTE, sf } from '../data/time.ts';
import {
  RULES_STAMP,
  applyOpsMove,
  checkIn,
  createWorld,
  getAsk,
  getBid,
  getHold,
  markRenewalRequired,
  nextRuleTime,
  opsMoveProblem,
  placeBid,
  postAsk,
  runRulesAt,
} from '../data/mock/world.ts';
import type { World } from '../data/mock/world.ts';
import { findProblems } from './rescheduler.ts';

/**
 * P7 for the rescheduler itself (D-101, D-134): on generated mornings at
 * Little Lantern Toys (one to three requests, one to four queuer offers with
 * fixed fees or fee clocks, queuers who stall on the way, holds that can no
 * longer pay), every option the rescheduler lists is a move the rules accept
 * now, and applying it never puts a job on another shop or item, past an
 * offer's room, above the request's max fee or past the request's PayPal hold.
 * The server checks each approved move again (server/test/engine.property.test.ts).
 *
 * `npm test` runs a fixed seed; HMS_PROPERTY_SEED=random and HMS_PROPERTY_RUNS=<n> search further:
 *   cd ops && HMS_PROPERTY_SEED=random HMS_PROPERTY_RUNS=5000 node --test src/agents/rescheduler.property.test.ts
 */

const FILE = 'src/agents/rescheduler.property.test.ts';
const SEED = process.env.HMS_PROPERTY_SEED === 'random' ? Math.floor(Math.random() * 2 ** 31) : Number(process.env.HMS_PROPERTY_SEED ?? 20261112);
// A search on another seed says which one it ran, so a passing log can be repeated (CI keeps it).
if (process.env.HMS_PROPERTY_SEED) console.log(`Property seed: ${SEED}`);
const RUNS = Number(process.env.HMS_PROPERTY_RUNS ?? 0);
const runs = (n: number) => (Number.isInteger(RUNS) && RUNS > 0 ? RUNS : n);

const START = sf('10:30');
const SHOP = 'little-lantern-toys';
const ITEM = 'plush-little-lantern';
const QUEUERS: UserId[] = ['wei', 'lin', 'rin', 'ava', 'jo'];
const REQUESTERS = { ship: ['mia', 'jun', 'priya'], local: ['sam', 'noor', 'leo'] } as const;

interface Morning {
  bids: { mode: 'ship' | 'local'; qty: number; capExtra: number; maxFee: number; budget: number; renewalAfter: number | null }[];
  asks: { capacity: number; fee: number; clock: { step: number; interval: number; floorShare: number } | null; postAfter: number; eta: number; stalled: boolean; checksIn: boolean }[];
  probeAfter: number;
}

const morningArb: fc.Arbitrary<Morning> = fc.record({
  bids: fc.array(
    fc.record({
      mode: fc.constantFrom<'ship' | 'local'>('ship', 'local'),
      qty: fc.integer({ min: 1, max: 3 }),
      capExtra: fc.integer({ min: 0, max: 2_400 }),
      maxFee: fc.integer({ min: 500, max: 2_500 }),
      budget: fc.integer({ min: 1, max: 3_000 }),
      renewalAfter: fc.option(fc.integer({ min: 0, max: 60 }), { freq: 3 }),
    }),
    { minLength: 1, maxLength: 3 },
  ),
  asks: fc.array(
    fc.record({
      capacity: fc.integer({ min: 1, max: 3 }),
      fee: fc.integer({ min: 500, max: 2_500 }),
      clock: fc.option(fc.record({ step: fc.integer({ min: 25, max: 300 }), interval: fc.integer({ min: 1, max: 10 }), floorShare: fc.integer({ min: 0, max: 1000 }) })),
      postAfter: fc.integer({ min: 0, max: 30 }),
      eta: fc.integer({ min: 10, max: 30 }),
      stalled: fc.boolean(),
      checksIn: fc.boolean(),
    }),
    { minLength: 1, maxLength: QUEUERS.length },
  ),
  probeAfter: fc.integer({ min: 5, max: 70 }),
});

/** Builds the morning in time order, running the market's own rules (clock steps, lapses) in between. */
function build(m: Morning): { w: World; t: MarketMs } {
  const askIds = m.asks.map((_, i) => `ask-${QUEUERS[i]}`);
  const w = createWorld(START, [], askIds.filter((_, i) => m.asks[i]!.stalled).map((id) => `claim-${id.replace(/^ask-/, '')}`));
  const events: { at: MarketMs; run: () => void }[] = [];
  m.bids.forEach((b, i) => {
    events.push({
      at: START,
      run: () =>
        placeBid(w, {
          id: `bid-${i}`,
          requesterId: REQUESTERS[b.mode][i]!,
          shopId: SHOP,
          itemId: ITEM,
          qty: b.qty,
          retailCapCents: 2600 + b.capExtra,
          maxFeeCents: b.maxFee,
          shippingBudgetCents: b.mode === 'ship' ? b.budget : 0,
          createdAt: START,
          deadlineAt: START + 6 * 60 * MINUTE,
          mode: b.mode,
        }),
    });
    if (b.renewalAfter !== null) events.push({ at: START + b.renewalAfter * MINUTE, run: () => markRenewalRequired(w, `bid-${i}`, START + b.renewalAfter! * MINUTE) });
  });
  m.asks.forEach((a, i) => {
    const postedAt = START + a.postAfter * MINUTE;
    const etaAt = postedAt + a.eta * MINUTE;
    events.push({
      at: postedAt,
      run: () =>
        postAsk(w, {
          id: askIds[i]!,
          queuerId: QUEUERS[i]!,
          shopId: SHOP,
          itemId: ITEM,
          capacity: a.capacity,
          feeCents: a.fee,
          clock: a.clock ? { stepCents: a.clock.step, intervalMinutes: a.clock.interval, floorCents: Math.max(500, Math.min(a.fee, Math.floor((a.fee * a.clock.floorShare) / 1000))) } : null,
          etaAt,
          createdAt: postedAt,
        }),
    });
    if (a.checksIn && !a.stalled) {
      events.push({
        at: etaAt,
        run: () => {
          const claim = w.claims.find((c) => c.askId === askIds[i]);
          if (claim && (claim.status === 'awaiting_arrival' || claim.status === 'arrived')) checkIn(w, claim.id, etaAt, etaAt + MINUTE);
        },
      });
    }
  });
  const t = START + m.probeAfter * MINUTE;
  let now = START;
  const rulesUntil = (until: MarketMs) => {
    for (let next = nextRuleTime(w, now); next !== null && next <= until; next = nextRuleTime(w, now)) {
      runRulesAt(w, next);
      now = next;
    }
  };
  for (const e of events.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)) {
    rulesUntil(e.at - 1);
    now = Math.max(now, e.at);
    e.run();
  }
  rulesUntil(t);
  return { w, t };
}

const MAY_CAPTURE: readonly Job['status'][] = [...JOB_BEFORE_PURCHASE, 'bought', 'proof_submitted', 'verified'];

/** What a request's jobs may still take from its hold: captured money, plus the full caps of jobs that may still capture. */
function committed(w: World, bidId: string): number {
  let total = 0;
  for (const j of w.jobs.filter((x) => x.bidId === bidId)) {
    const caps = j.caps.retailCents + j.caps.feeCents + j.caps.shippingCents + (j.caps.processingCents ?? 0);
    total += MAY_CAPTURE.includes(j.status) ? Math.max(j.amounts.capturedCents, caps) : j.amounts.capturedCents;
  }
  return total;
}

test(`P7 every option the rescheduler lists is allowed now and keeps each job on its shop and item, inside the offer's room, at or under the max fee and inside the hold (${runs(2000)} runs)`, (t) => {
  const seen = { mornings: 0, problems: 0, options: 0, reassignments: 0, movedJobs: 0 };
  const out = fc.check(
    fc.property(morningArb, (m) => {
      const { w, t: at } = build(m);
      seen.mornings++;
      for (const p of findProblems(w, at)) {
        seen.problems++;
        for (const o of p.options) {
          seen.options++;
          if (o.kind === 'reassign') seen.reassignments++;
          for (const move of o.moves) assert.equal(opsMoveProblem(w, move, at), null, `${p.id} / ${o.id}: the rules refuse ${JSON.stringify(move)}`);
          const copy = structuredClone(w);
          const known = new Set(w.jobs.map((j) => j.id));
          for (const move of o.moves) assert.ok(applyOpsMove(copy, { at, proposalId: p.id, move, reason: 'property test', label: o.label, ai: RULES_STAMP }), `${p.id} / ${o.id} did not apply`);
          for (const job of copy.jobs.filter((j) => !known.has(j.id))) {
            seen.movedJobs++;
            const bid = getBid(copy, job.bidId);
            const ask = getAsk(copy, job.askId);
            assert.equal(ask.shopId, bid.shopId, `${o.id}: another shop`);
            assert.equal(ask.itemId, bid.itemId, `${o.id}: another item`);
            assert.ok(ask.remainingCapacity >= 0, `${o.id}: ${ask.id} over its room`);
            assert.equal(job.feeCents, askFeeAt(ask, at), `${o.id}: not the offer's fee now`);
            assert.ok(job.feeCents <= bid.maxFeeCents, `${o.id}: ${job.feeCents} above ${bid.requesterName}'s max fee ${bid.maxFeeCents}`);
          }
          for (const bid of copy.bids) {
            const hold = getHold(copy, bid.holdId!);
            assert.ok(committed(copy, bid.id) <= hold.amount.cents, `${o.id}: ${bid.id}'s jobs may take ${committed(copy, bid.id)} of a ${hold.amount.cents} hold`);
          }
        }
      }
    }),
    { numRuns: runs(2000), seed: SEED, path: process.env.HMS_PROPERTY_PATH || undefined, includeErrorInReport: true },
  );
  if (out.failed) {
    const replay = `cd ops && HMS_PROPERTY_SEED=${out.seed} HMS_PROPERTY_PATH=${out.counterexamplePath ?? ''} node --test ${FILE}`;
    throw new Error(`P7: ${fc.defaultReportMessage(out) ?? 'failed'}\nReplay this case: ${replay}`);
  }
  t.diagnostic(`${seen.mornings} mornings (shrinking included): ${seen.problems} problems, ${seen.options} options (${seen.reassignments} reassignments), ${seen.movedJobs} jobs placed by a dry run`);
});
