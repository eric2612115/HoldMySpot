import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { ContractError, askFeeAt, evaluatePurchase, jobSettlement, platformFeeCents } from '@holdmyspot/shared';
import type { BidTask, CheckoutFunding, Destination, FulfilmentMode, LngLat } from '@holdmyspot/shared';
import { checkIn, createAsk, withdrawAsk } from '../src/app/asks.ts';
import { amendBid, authorizeBid, cancelBid, claimBid, createBid } from '../src/app/bids.ts';
import { addShipment, handover, markBought, reportSoldOut, reviewProof, submitProof } from '../src/app/jobs.ts';
import { committedCents } from '../src/app/market.ts';
import { loadRequest, recoverPending } from '../src/app/money.ts';
import { applyOpsMoves } from '../src/app/opsAgents.ts';
import { FakeAi } from '../src/fakes/ai.ts';
import { purchaseReading } from '../src/fakes/scenarios.ts';
import { PAYOUT_ITEM_FEE_CENTS, captureFeeCents } from '../src/paypal/emulator.ts';
import type { EmulatorState } from '../src/paypal/emulator.ts';
import { unexpectedResponse } from '../src/paypal/errors.ts';
import type { PurchaseProofInput, PurchaseProofResult } from '../src/ports/ai.ts';
import { PayPalCallError } from '../src/ports/payments.ts';
import { DAY, ITEM, MIN, NY_SHIP, SHOP, persona, testServer, upload, type TestServer } from './helpers.ts';

/**
 * Property tests of the server's money and market code on the offline PayPal
 * emulator (the sandbox REST client answered in process). fast-check generates
 * whole market days: one or two requests (quantity 1 to 3, any retail cap, max
 * fee, shipping budget, local errand or shipped), two or three queuer offers
 * (fixed fee or a fee clock, half of the clocks opening above most max fees),
 * and up to 24 events, each chosen among what the
 * market allows at that moment: check-ins (also from too far away or with a
 * failed line photo), purchases, receipts (genuine at any amount, above the
 * cap, or forged in each of the ways the rules know), ops reviews, tracking,
 * handovers (also with a wrong code), sell-outs, cancellations, amendments,
 * withdrawals, direct claims, ops reassignments and time passing. Any event's
 * PayPal money calls can lose, refuse or garble PayPal's answer; then the
 * server may restart on the same database, the recovery sweep runs, and the
 * person may try again or give up. Then 31 days pass, so every deadline,
 * shipping window and hold expiry runs. After every event and at the end:
 *
 * P1 PayPal ends every authorization CAPTURED, VOIDED or EXPIRED (its own lapse
 *    on day 29, which the server records as an expiry), so nothing stays held;
 *    its captures of each hold equal the server's, and HoldMySpot's records of
 *    every job agree with PayPal's to the cent (captures, refunds, payouts, fees).
 * P2 no hold's captures ever pass 100% of it at PayPal, although the emulator
 *    accepts 115%; the jobs a request backs never need more than its hold.
 * P3 every capture at PayPal belongs to a job whose receipt passed the rules or
 *    was approved by a person (checked after every event), and a job whose
 *    receipt fails a hard check captures, pays and keeps $0.
 * P4 every completed job leaves HoldMySpot exactly floor(10% x queue fee); a
 *    job that captured nothing leaves everyone $0; a job refunded after its fee
 *    payout costs HoldMySpot that payout and PayPal's fees, no more.
 * P5 the same day with and without PayPal failures ends with the same PayPal
 *    objects and amounts: a resend never charges, pays or refunds twice.
 * P6 every match is at the offer's clock price at that moment (the opening fee
 *    until a passed check-in), at or under the request's max fee.
 * P7 no reassignment (the rescheduler's moves, checked by the server) puts a
 *    job above the request's max fee or its hold.
 * Payouts never exceed captures, and nothing is left pending after recovery.
 *
 * `npm test` runs a fixed seed. For a deeper search:
 *   cd server && HMS_PROPERTY_SEED=random HMS_PROPERTY_RUNS=1000 node --test test/engine.property.test.ts
 * A failure prints the shrunk market day and the command that replays it.
 */

const FILE = 'test/engine.property.test.ts';
/** `npm test -- --quick` leaves these out (the full run, and CI, keep them; D-149). */
const QUICK = process.env.HMS_TEST_QUICK === '1' ? 'skipped by npm test -- --quick' : false;
const SEED = process.env.HMS_PROPERTY_SEED === 'random' ? Math.floor(Math.random() * 2 ** 31) : Number(process.env.HMS_PROPERTY_SEED ?? 20261112);
// A search on another seed says which one it ran, so a passing log can be repeated (CI keeps it).
if (process.env.HMS_PROPERTY_SEED) console.log(`Property seed: ${SEED}`);
const RUNS = Number(process.env.HMS_PROPERTY_RUNS ?? 0);
const runs = (n: number) => (Number.isInteger(RUNS) && RUNS > 0 ? RUNS : n);

async function holds<Ts>(name: string, property: fc.IAsyncProperty<Ts>, numRuns: number): Promise<void> {
  const out = await fc.check(property, { numRuns, seed: SEED, path: process.env.HMS_PROPERTY_PATH || undefined, includeErrorInReport: true });
  if (!out.failed) return;
  const replay = `cd server && HMS_PROPERTY_SEED=${out.seed} HMS_PROPERTY_PATH=${out.counterexamplePath ?? ''} node --test --test-name-pattern="${name}" ${FILE}`;
  throw new Error(`${name}: ${(await fc.asyncDefaultReportMessage(out)) ?? 'failed'}\nReplay this case: ${replay}`);
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const share = (cents: number, permille: number) => Math.floor((cents * permille) / 1000);
const START = Date.parse('2026-11-12T11:30:00-08:00');

// ---------------------------------------------------------------------------
// The generated market day
// ---------------------------------------------------------------------------

type ProofKind =
  | 'genuine'
  | 'over_cap'
  | 'fake_receipt'
  | 'wrong_seller'
  | 'time_before_checkin'
  | 'totals_off'
  | 'no_code'
  | 'unreadable'
  | 'generated'
  | 'recycled';
type Effect = 'lost' | 'outage' | 'unreadable';
type FaultOp = 'capture' | 'payout' | 'void' | 'refund';

interface Fault {
  /** Which PayPal money calls fail: any (capture, payout, void, refund), or only one kind. */
  only: FaultOp | null;
  /** What happens to the next such calls during this event, in order (later calls go through). */
  effects: Effect[];
  /** Recovery: the server restarts on the same database (its boot sweep resends) before the sweep. */
  restart: boolean;
  /** The person whose command met the failure tries again (or gives up, and only the sweep resends). */
  retry: boolean;
}

/**
 * One event. The driver lists every action the market allows at that moment
 * (check in a queuer on the way, buy, send a receipt, review one, add tracking,
 * hand over, report a sell-out, cancel, amend, claim directly, withdraw, move a
 * job to another offer, or let time pass) and `pick` chooses one by weight; x,
 * y and flag are that action's numbers. Every event does something, and
 * fast-check can still shrink a day event by event.
 */
interface Step {
  pick: number;
  x: number;
  y: number;
  flag: boolean;
  fault: Fault | null;
}

interface BidSpec {
  mode: FulfilmentMode;
  qty: number;
  capExtraCents: number;
  maxFeeCents: number;
  shippingBudgetCents: number;
  deadlineHours: number;
  funding: CheckoutFunding;
}

interface AskSpec {
  capacity: number;
  feeCents: number;
  /** A fee clock opens $8 above `feeCents`, above most requests' max fees, so its steps have requests to reach. */
  openAbove: boolean;
  clock: { stepCents: number; intervalMinutes: number; floorShare: number } | null;
  modes: FulfilmentMode[];
  etaInMin: number;
}

interface Day {
  bids: BidSpec[];
  asks: AskSpec[];
  /** Which goes first at the opening: the requests, or the offers. */
  asksFirst: boolean;
  steps: Step[];
}

const effectArb = fc.constantFrom<Effect>('lost', 'outage', 'unreadable');
const faultArb: fc.Arbitrary<Fault> = fc.record({
  only: fc.oneof({ weight: 4, arbitrary: fc.constant(null) }, { weight: 1, arbitrary: fc.constantFrom<FaultOp>('capture', 'payout', 'void', 'refund') }),
  effects: fc.array(effectArb, { minLength: 1, maxLength: 3 }),
  restart: fc.oneof({ weight: 2, arbitrary: fc.constant(false) }, { weight: 1, arbitrary: fc.constant(true) }),
  retry: fc.boolean(),
});

/** `faultWeight` in 10: how many events in ten meet a PayPal failure. */
const stepArb = (faultWeight: number): fc.Arbitrary<Step> =>
  fc.record({
    pick: fc.nat(9_999),
    x: fc.nat(1_000),
    y: fc.nat(1_000),
    flag: fc.boolean(),
    fault: fc.oneof({ weight: 10 - faultWeight, arbitrary: fc.constant(null) }, { weight: faultWeight, arbitrary: faultArb }),
  });

const bidSpecArb: fc.Arbitrary<BidSpec> = fc.constantFrom<FulfilmentMode>('ship', 'local').chain((mode) =>
  fc.record({
    mode: fc.constant(mode),
    qty: fc.integer({ min: 1, max: 3 }),
    capExtraCents: fc.integer({ min: 0, max: 3_000 }),
    maxFeeCents: fc.integer({ min: 800, max: 3_000 }),
    shippingBudgetCents: mode === 'ship' ? fc.integer({ min: 1, max: 5_000 }) : fc.constant(0),
    deadlineHours: fc.integer({ min: 2, max: 120 }),
    funding: fc.constantFrom<CheckoutFunding>('paypal', 'paypal', 'venmo'),
  }),
);

const askSpecArb: fc.Arbitrary<AskSpec> = fc.record({
  capacity: fc.integer({ min: 1, max: 3 }),
  feeCents: fc.integer({ min: 500, max: 2_800 }),
  openAbove: fc.boolean(),
  clock: fc.option(fc.record({ stepCents: fc.integer({ min: 25, max: 500 }), intervalMinutes: fc.integer({ min: 1, max: 15 }), floorShare: fc.integer({ min: 0, max: 1000 }) })),
  modes: fc.constantFrom<FulfilmentMode[]>(['ship'], ['local'], ['ship', 'local'], ['ship', 'local']),
  etaInMin: fc.integer({ min: 10, max: 20 }),
});

const dayArb = (o: { faultWeight: number; minFaults?: number }): fc.Arbitrary<Day> =>
  fc
    .record({
      bids: fc.array(bidSpecArb, { minLength: 1, maxLength: 2 }),
      // Two or three offers, so ops reassignments have somewhere to move a job.
      asks: fc.array(askSpecArb, { minLength: 2, maxLength: 3 }),
      asksFirst: fc.boolean(),
      steps: fc.array(stepArb(o.faultWeight), { minLength: 1, maxLength: 24, size: 'max' }),
    })
    .filter((d) => d.steps.filter((s) => s.fault !== null).length >= (o.minFaults ?? 0));

// ---------------------------------------------------------------------------
// Running a day on the server
// ---------------------------------------------------------------------------

const REQUESTERS: Record<FulfilmentMode, string[]> = { ship: ['mia', 'jun'], local: ['sam', 'noor'] };
const QUEUERS = ['wei', 'lin', 'rin'];
const SF_LOCAL: Destination = { mode: 'local', cityId: 'sf' };
const FAR: LngLat = [SHOP.lngLat[0] + 0.02, SHOP.lngLat[1]];
const METHOD: Record<FaultOp, string> = { capture: 'captureAuthorization', payout: 'createPayout', void: 'voidAuthorization', refund: 'refundCapture' };

/** The fake AI, with a genuine receipt's amount set per job: any amount, from $0 to well above the cap. */
class ReceiptAi extends FakeAi {
  readonly amounts = new Map<string, number>();

  override async purchaseProof(input: PurchaseProofInput): Promise<PurchaseProofResult> {
    const scenarios = [...new Set([input.receipt.scenario, input.itemPhoto.scenario].filter((s): s is string => s !== null))];
    const amount = this.amounts.get(input.job.id);
    if (amount === undefined || scenarios.some((s) => s !== 'genuine')) return super.purchaseProof(input);
    const read = purchaseReading(scenarios, input);
    const qty = read.lines[0]?.qty ?? input.job.qty;
    const lines = read.lines.map((l, i) => (i === 0 ? { ...l, unitMinor: Math.round(amount / qty), totalMinor: amount } : l));
    const reading = { ...read, lines, totalMinor: amount, qr: read.qr ? { ...read.qr, totalMinor: amount } : null };
    const verdict = evaluatePurchase(reading, {
      shop: input.shop,
      item: input.item,
      job: { qty: input.job.qty, proofCode: input.job.proofCode ?? '', retailCapCents: input.job.caps.retailCents, twdPerUsd: input.job.fx?.twdPerUsd ?? null },
      checkedInAt: input.checkedInAt,
      uploadedAt: input.uploadedAt,
      duplicateOf: input.duplicateOf,
    });
    return { ...verdict, ai: { ...this.info, latencyMs: 0, simulated: 'genuine' } };
  }
}

const outage = () =>
  new PayPalCallError('PayPal outage (property test)', { code: 'PAYPAL_UNAVAILABLE', paypalName: 'SERVICE_UNAVAILABLE', issue: null, httpStatus: 503, debugId: null, retryable: true });

type Real = (...args: unknown[]) => Promise<unknown>;

/**
 * What the generated days exercised, printed with each test so a passing run shows it was not vacuous;
 * `npm test -- --json` keeps it in docs/evidence/tests.json (the "coverage" diagnostic) and README's
 * evidence table reports it next to the case counts.
 */
const SEEN = {
  days: 0,
  checkIns: 0,
  matches: 0,
  clockFills: 0,
  completed: 0,
  rejected: 0,
  refunded: 0,
  captures: 0,
  payouts: 0,
  failures: 0,
  restarts: 0,
  flaggedPayouts: 0,
  reassigned: 0,
  expiredHolds: 0,
};
const seenText = () =>
  `${SEEN.days} days: ${SEEN.checkIns} passed check-ins, ${SEEN.matches} matches (${SEEN.clockFills} below the opening fee), ${SEEN.completed} completed jobs, ` +
  `${SEEN.rejected} receipts failing a hard check, ${SEEN.refunded} refunded jobs, ${SEEN.captures} captures, ${SEEN.payouts} payouts, ` +
  `${SEEN.failures} PayPal failures injected, ${SEEN.restarts} restarts, ${SEEN.flaggedPayouts} payouts kept for reconciliation, ${SEEN.reassigned} reassignments, ` +
  `${SEEN.expiredHolds} holds left to lapse on day 29`;

/** A market on the emulator that can restart on its own database file. */
class Market {
  s!: TestServer;
  readonly ai = new ReceiptAi();
  readonly dir: string;
  readonly dbPath: string;
  readonly uploads: string;
  /** Labels of item photos already uploaded, for recycled photos. */
  readonly labels: string[] = [];
  /** Each match's request max fee right after the event that made it. */
  readonly maxAtMatch = new Map<string, number>();
  /** What happened, event by event, for failure messages. */
  readonly log: string[] = [];

  constructor(file: boolean) {
    this.dir = mkdtempSync(join(tmpdir(), 'hms-prop-'));
    this.dbPath = file ? join(this.dir, 'market.sqlite') : ':memory:';
    this.uploads = join(this.dir, 'uploads');
  }

  get app() {
    return this.s.app;
  }

  async open(start: number): Promise<void> {
    this.s = await testServer({ dbPath: this.dbPath, start, env: { HMS_UPLOAD_DIR: this.uploads } });
    this.s.app.ai = this.ai;
  }

  /** Stops the server and starts a new one on the same database; its boot resends what is pending. */
  async restart(): Promise<void> {
    SEEN.restarts++;
    const now = this.app.now();
    await this.app.idle();
    await this.s.close();
    rmSync(this.s.dir, { recursive: true, force: true });
    await this.open(now);
  }

  async close(): Promise<void> {
    await this.s.done();
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** Runs a command; the rules refusing it is a normal outcome. */
  async run(fn: () => unknown): Promise<void> {
    try {
      await this.app.exec(async () => fn());
    } catch (err) {
      if (!(err instanceof ContractError)) throw err;
    }
    await this.app.idle();
  }

  /**
   * Scripts the next PayPal money calls on the emulator: `outage` fails before PayPal sees the call,
   * `lost` lets PayPal do it and loses the answer, `unreadable` lets PayPal do it and garbles the
   * answer. Returns the undo and the failures that happened.
   */
  trip(fault: Fault): { undo: () => void; hits: string[] } {
    const fake = this.app.fakePayPal as unknown as Record<string, unknown>;
    const ops = fault.only ? [fault.only] : (Object.keys(METHOD) as FaultOp[]);
    const queue = [...fault.effects];
    const hits: string[] = [];
    for (const op of ops) {
      const real = (fake[METHOD[op]] as Real).bind(this.app.fakePayPal);
      fake[METHOD[op]] = async (...args: unknown[]) => {
        const effect = queue.shift();
        if (effect === undefined) return real(...args);
        SEEN.failures++;
        hits.push(`${op} ${effect}`);
        if (effect === 'outage') throw outage();
        await real(...args);
        if (effect === 'lost') throw outage();
        throw unexpectedResponse('property-test', 'an answer that cannot be read', 'debug-property');
      };
    }
    const undo = () => {
      for (const op of ops) delete fake[METHOD[op]];
    };
    return { undo, hits };
  }

  emulator(): EmulatorState {
    const row = this.app.db.prepare("SELECT doc FROM fake_paypal WHERE kind = 'emulator' AND id = 'state'").get() as { doc: string } | undefined;
    return row ? (JSON.parse(row.doc) as EmulatorState) : ({ captures: {}, payoutItems: {}, authorizations: {}, orders: {}, refunds: {} } as unknown as EmulatorState);
  }
}

const byId = <T extends { id: string }>(xs: T[]) => xs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const OTHER_PROOFS: ProofKind[] = ['over_cap', 'fake_receipt', 'wrong_seller', 'time_before_checkin', 'totals_off', 'no_code', 'unreadable', 'generated', 'recycled'];
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

async function openDay(m: Market, day: Day): Promise<void> {
  const app = m.app;
  const bids = async () => {
    for (const [i, b] of day.bids.entries()) {
      const requester = REQUESTERS[b.mode][i]!;
      await m.run(async () => {
        const created = await createBid(app, persona(app, requester), {
          shopId: SHOP.id,
          itemId: ITEM,
          qty: b.qty,
          retailCapCents: 2600 + b.capExtraCents,
          maxFeeCents: b.maxFeeCents,
          shippingBudgetCents: b.shippingBudgetCents,
          destination: b.mode === 'ship' ? NY_SHIP : SF_LOCAL,
          deadlineAt: app.now() + b.deadlineHours * 60 * MIN,
          funding: b.funding,
          agent: null,
        });
        await app.fakePayPal.approveOrder(created.checkout.orderId, b.funding, 'approve');
        await authorizeBid(app, { userId: requester, ops: false }, created.bid.id, created.checkout.orderId);
      });
    }
  };
  const asks = async () => {
    for (const [i, a] of day.asks.entries()) {
      const u = persona(app, QUEUERS[i]!);
      const open = a.clock && a.openAbove ? a.feeCents + 800 : a.feeCents;
      const floor = Math.max(500, share(a.feeCents, a.clock?.floorShare ?? 0));
      await m.run(() =>
        createAsk(app, u, {
          shopId: SHOP.id,
          itemId: ITEM,
          capacity: a.capacity,
          modes: a.modes,
          feeCents: open,
          clock: a.clock ? { stepCents: a.clock.stepCents, intervalMs: a.clock.intervalMinutes * MIN, floorCents: Math.min(floor, open) } : null,
          etaAt: app.now() + a.etaInMin * MIN,
          from: { lngLat: u.home!, accuracyM: 10 },
        }),
      );
    }
  };
  if (day.asksFirst) {
    await asks();
    await bids();
  } else {
    await bids();
    await asks();
  }
}

/** One event: the action, then recovery from any PayPal failure it met. */
async function play(m: Market, step: Step, n: number): Promise<string> {
  const tripped = step.fault ? m.trip(step.fault) : null;
  let done: { label: string; retry: (() => Promise<void>) | null };
  try {
    done = await act(m, step, n);
  } finally {
    tripped?.undo();
  }
  if (!step.fault) return done.label;
  if (step.fault.restart) await m.restart();
  // The sweeper resends what is pending with the same keys until nothing is left.
  for (let i = 0; i < 4; i++) await m.run(() => recoverPending(m.app));
  // The person whose command met the outage may try again (the app says so), or give up.
  const retried = step.fault.retry && done.retry !== null;
  if (retried) await done.retry!();
  const failures = tripped && tripped.hits.length > 0 ? `PayPal: ${tripped.hits.join(', ')}; ` : '';
  return `${done.label} [${failures}${step.fault.restart ? 'restart, ' : ''}sweep${retried ? ', retry' : ''}]`;
}

interface Choice {
  weight: number;
  label: string;
  run: () => Promise<(() => Promise<void>) | null | void>;
}

/** Lists what the market allows now and runs the action `step.pick` chooses. */
async function act(m: Market, step: Step, n: number): Promise<{ label: string; retry: (() => Promise<void>) | null }> {
  const app = m.app;
  const { x, y, flag } = step;
  const jobs = byId(app.store.jobs.all());
  const asks = byId(app.store.asks.all());
  const bids = byId(app.store.bids.all());
  const name = (userId: string) => persona(app, userId).displayName;
  const choices: Choice[] = [];

  const minutes = x < 700 ? 1 + (x % 45) : x < 950 ? 60 + (x % 12) * 30 : 24 * 60 * (1 + (x % 3));
  choices.push({ weight: 6, label: `${minutes} minutes pass`, run: () => m.s.at(app.now() + minutes * MIN) });

  for (const ask of asks) {
    const claim = app.store.claims.must(ask.claimId);
    if (claim.status !== 'awaiting_arrival' && claim.status !== 'arrived') continue;
    const how = y < 800 ? 'ok' : y < 900 ? 'far' : 'no_code';
    choices.push({
      weight: 16,
      label: `${name(ask.queuerId)} checks in for ${ask.id} (${how})`,
      run: async () => {
        const photo = await upload(app, ask.queuerId, 'line_photo', how === 'no_code' ? 'no_code' : 'line_ok', `line-${n}-${ask.id}`);
        await m.run(() => checkIn(app, persona(app, ask.queuerId), ask.claimId, { lngLat: how === 'far' ? FAR : SHOP.lngLat, accuracyM: 8, photoFileId: photo.id }));
      },
    });
  }
  for (const job of jobs) {
    const who = persona(app, job.queuerId);
    if (job.status === 'queueing') choices.push({ weight: 6, label: `${who.displayName} buys ${job.id}`, run: () => m.run(() => markBought(app, who, job.id)) });
    if (job.status === 'queueing' || job.status === 'bought') {
      const kind = y < 550 ? 'genuine' : OTHER_PROOFS[Math.min(OTHER_PROOFS.length - 1, Math.floor((y - 550) / 50))]!;
      // Mostly 40% to 100% of the cap; one receipt in seven anything from $0 to 150% of it.
      const amount = share(job.caps.retailCents, x < 850 ? 400 + Math.floor((x * 600) / 850) : (x - 850) * 10);
      choices.push({
        weight: 12,
        label: `${who.displayName} sends the receipt for ${job.id}: ${kind === 'genuine' ? `genuine, ${usd(amount)} (cap ${usd(job.caps.retailCents)})` : kind}`,
        run: async () => {
          const scenario = kind === 'recycled' ? 'genuine' : kind;
          if (kind === 'genuine') m.ai.amounts.set(job.id, amount);
          const r = await upload(app, job.queuerId, 'receipt', scenario, `receipt-${n}-${job.id}`);
          const label = kind === 'recycled' && m.labels.length > 0 ? m.labels[0]! : `item-${n}-${job.id}`;
          m.labels.push(label);
          const p = await upload(app, job.queuerId, 'item_photo', scenario, label);
          await m.run(() => submitProof(app, who, job.id, { receiptFileId: r.id, itemFileId: p.id }));
        },
      });
    }
    if (job.status === 'verified' && job.mode === 'ship') {
      const shipping = share(job.caps.shippingCents, Math.floor((x * 3) / 2));
      const duty = share(job.caps.shippingCents, Math.floor((y * 3) / 10));
      // m.app, not app: a retry may run on the server that restarted.
      const send = (scale: number) =>
        m.run(() =>
          addShipment(m.app, who, job.id, { carrierName: 'Harbor Parcel Ground', trackingNumber: `HPG-${job.id}`, shippingCostCents: shipping * scale, dutyPaidCents: duty, labelFileId: null }),
        );
      choices.push({
        weight: 12,
        label: `${who.displayName} adds tracking for ${job.id}: label ${usd(shipping)}, duty ${usd(duty)} (cap ${usd(job.caps.shippingCents)})`,
        run: async () => {
          await send(1);
          // A retry may carry other numbers; PayPal was already asked for the first ones.
          return () => send(flag ? 2 : 1);
        },
      });
    }
    if (job.status === 'verified' && job.mode === 'local') {
      const right = y < 850;
      const code = right ? job.handoverCode! : job.handoverCode === '0000' ? '1111' : '0000';
      choices.push({
        weight: 12,
        label: `${who.displayName} hands over ${job.id} (${right ? 'right' : 'wrong'} code)`,
        run: async () => {
          await m.run(() => handover(m.app, who, job.id, code));
          return () => m.run(() => handover(m.app, who, job.id, job.handoverCode!));
        },
      });
    }
    if (app.store.claims.must(job.claimId).status === 'checked_in') {
      choices.push({ weight: 1, label: `${who.displayName} reports the plush sold out (${job.id})`, run: () => m.run(() => reportSoldOut(app, who, job.id, null)) });
    }
    if (job.status === 'claimed' || job.status === 'checked_in' || job.status === 'queueing') {
      const target = asks.length > 0 ? asks[y % asks.length]! : null;
      if (target && target.id !== job.askId) {
        choices.push({
          weight: 10,
          label: `ops moves ${job.id} to ${target.queuerName}'s ${target.id}`,
          run: () => m.run(() => applyOpsMoves(app, { moves: [{ kind: 'reassign', jobId: job.id, toAskId: target.id }], reason: 'Property test move', proposalId: null, ai: null })),
        });
      }
    }
  }
  for (const proof of byId(app.store.proofs.where("kind = 'purchase' AND status = 'needs_review'"))) {
    choices.push({ weight: 8, label: `ops ${flag ? 'passes' : 'fails'} the receipt of ${proof.jobId}`, run: () => m.run(() => reviewProof(app, proof.id, { decision: flag ? 'pass' : 'fail', note: 'property test' })) });
  }
  for (const bid of bids) {
    if (!['open', 'partially_matched', 'matched'].includes(bid.status)) continue;
    const requester = { userId: bid.requesterId, ops: false };
    choices.push({ weight: 1, label: `${bid.requesterName} cancels ${bid.id}`, run: () => m.run(() => cancelBid(app, requester, bid.id)) });
    const qty = bid.qty + (x % 3) - 1;
    const fee = Math.max(500, share(bid.maxFeeCents, 300 + Math.floor((y * 13) / 10)));
    choices.push({ weight: 1, label: `${bid.requesterName} amends ${bid.id} to ${qty} at most ${usd(fee)}`, run: () => m.run(() => amendBid(app, requester, bid.id, { qty, maxFeeCents: fee })) });
    const u = persona(app, flag ? 'ava' : 'jo');
    const take = 1 + (x % 3);
    choices.push({
      weight: 2,
      label: `${u.displayName} claims ${take} of ${bid.id} directly`,
      run: () => m.run(() => claimBid(app, u, bid.id, { qty: take, etaAt: app.now() + 25 * MIN, modes: [bid.destination.mode], from: { lngLat: u.home!, accuracyM: 10 } })),
    });
  }
  for (const ask of asks) {
    if (ask.status === 'open' && ask.origin === 'post') choices.push({ weight: 2, label: `${name(ask.queuerId)} withdraws ${ask.id}`, run: () => m.run(() => withdrawAsk(app, persona(app, ask.queuerId), ask.id)) });
  }

  const total = sum(choices.map((c) => c.weight));
  let at = (step.pick / 10_000) * total;
  const choice = choices.find((c) => (at -= c.weight) < 0) ?? choices[0]!;
  const retry = await choice.run();
  return { label: choice.label, retry: typeof retry === 'function' ? retry : null };
}

// ---------------------------------------------------------------------------
// What must hold
// ---------------------------------------------------------------------------

/** Payout records whose batch PayPal already had when it was resent: never sent again, kept pending for reconciliation by hand. */
function flaggedPayouts(app: TestServer['app']): Set<string> {
  const out = new Set<string>();
  for (const e of app.store.ledger.where("kind = 'paid_out' AND status = 'pending'")) {
    const req = loadRequest(app, e.id);
    if (req?.op === 'payout' && req.duplicate) out.add(req.payoutId);
  }
  return out;
}

/**
 * A payout item's status as PayPal will settle it: the emulator settles an item when it is read,
 * and one whose answer was lost is never read again, so it can still say PENDING with its outcome.
 */
const settled = (it: EmulatorState['payoutItems'][string]) => (it.status === 'PENDING' && it.outcome ? it.outcome : it.status);

interface PayPalJob {
  capturedCents: number;
  refundedCents: number;
  paidOutCents: number;
  feesCents: number;
  captures: number;
}

/** PayPal's side of each job, from the emulator's own records: captures by invoice, payout items by sender item id. */
function paypalJobs(m: Market): Map<string, PayPalJob> {
  const st = m.emulator();
  const out = new Map<string, PayPalJob>();
  const of = (jobId: string) => {
    let j = out.get(jobId);
    if (!j) out.set(jobId, (j = { capturedCents: 0, refundedCents: 0, paidOutCents: 0, feesCents: 0, captures: 0 }));
    return j;
  };
  for (const c of Object.values(st.captures)) {
    if (c.status === 'DECLINED' || c.status === 'FAILED') continue;
    const jobId = /(job_\d+)-[RSH]$/.exec(c.invoiceId ?? '')?.[1];
    assert.ok(jobId, `capture ${c.id} has no job invoice (${c.invoiceId})`);
    const j = of(jobId);
    j.capturedCents += c.amountCents;
    j.refundedCents += c.refundedCents;
    j.feesCents += captureFeeCents(c.amountCents);
    j.captures += 1;
  }
  const payouts = new Map(m.app.store.payouts.all().map((p) => [p.id, p]));
  for (const it of Object.values(st.payoutItems)) {
    if (settled(it) !== 'SUCCESS') continue;
    const p = payouts.get(it.senderItemId);
    assert.ok(p, `payout item ${it.id} matches no payout record`);
    const j = of(p.reference);
    j.paidOutCents += it.amountCents;
    j.feesCents += PAYOUT_ITEM_FEE_CENTS;
  }
  return out;
}

/** After every event: P2, P6, P7, payouts within captures, no double objects, whole cents, nothing left pending. */
function checkNow(m: Market, label: string): void {
  const app = m.app;
  const st = m.emulator();
  const ctx = (what: string) => `${label}: ${what}`;
  // P2: per hold, PayPal's captures never pass 100% of it (the emulator would allow 115%), and our records match PayPal's.
  for (const bid of app.store.bids.all()) {
    if (!bid.holdId || !bid.paypalOrderId) continue;
    const hold = app.store.holds.must(bid.holdId);
    const order = st.orders[bid.paypalOrderId];
    const auths = order ? order.authorizationIds.map((id) => st.authorizations[id]!).filter(Boolean) : [];
    const captured = sum(auths.flatMap((a) => a.captureIds.map((id) => st.captures[id]!)).filter((c) => c.status !== 'DECLINED' && c.status !== 'FAILED').map((c) => c.amountCents));
    assert.ok(captured <= hold.amount.cents, ctx(`PayPal captured ${captured} on a ${hold.amount.cents} hold (${bid.id})`));
    assert.equal(hold.capturedCents, captured, ctx(`hold ${hold.id} records ${hold.capturedCents} captured, PayPal ${captured}`));
    assert.ok(hold.capturedCents + hold.releasedCents <= hold.amount.cents, ctx(`hold ${hold.id} captured + released passes the amount`));
    // P7: the jobs this request backs never need more than its hold.
    if (hold.status === 'held' || hold.status === 'partially_captured') {
      const committed = committedCents(app, bid.id);
      assert.ok(committed <= hold.amount.cents, ctx(`${bid.id}'s jobs may take ${committed} of a ${hold.amount.cents} hold`));
    }
  }
  // Payouts never above captures, per job; one capture per part, one payout per purpose.
  const flagged = flaggedPayouts(app);
  for (const [jobId, j] of paypalJobs(m)) assert.ok(j.paidOutCents <= j.capturedCents, ctx(`${jobId} paid ${j.paidOutCents} out of ${j.capturedCents} captured`));
  const invoices = Object.values(st.captures).map((c) => c.invoiceId);
  assert.equal(new Set(invoices).size, invoices.length, ctx('two captures for one part of a job'));
  const records = new Map(app.store.payouts.all().map((p) => [p.id, p]));
  const purposes = Object.values(st.payoutItems).map((it) => {
    const p = records.get(it.senderItemId);
    return `${p?.reference}:${p?.purpose}`;
  });
  assert.equal(new Set(purposes).size, purposes.length, ctx(`two payouts for one purpose: ${purposes.join(', ')}`));
  // P3: PayPal holds a capture only for a job whose receipt passed the rules or a person approved it.
  for (const c of Object.values(st.captures)) {
    if (c.status === 'DECLINED' || c.status === 'FAILED') continue;
    const jobId = /(job_\d+)-[RSH]$/.exec(c.invoiceId ?? '')?.[1] ?? null;
    const proofs = jobId ? app.store.proofs.where("job_id = ? AND kind = 'purchase'", jobId) : [];
    const passed = proofs.some((p) => p.status === 'passed' && (p.decidedBy === 'ai_rules' || p.decidedBy === 'ops'));
    assert.ok(passed, ctx(`PayPal capture ${c.id} (${c.invoiceId}) belongs to no job with a passed or approved receipt (${proofs.map((p) => `${p.status} by ${p.decidedBy}`).join(', ') || 'no receipt'})`));
  }
  // P6: every match at the offer's clock price then, at or under the max fee the request had then; clocks start only at a passed check-in.
  for (const match of app.store.matches.all()) {
    const ask = app.store.asks.must(match.askId);
    if (!m.maxAtMatch.has(match.id)) m.maxAtMatch.set(match.id, app.store.bids.must(match.bidId).maxFeeCents);
    assert.equal(match.feeCents, askFeeAt(ask, match.at), ctx(`match ${match.id} at ${match.feeCents}, the offer's clock said ${askFeeAt(ask, match.at)}`));
    assert.ok(match.feeCents <= m.maxAtMatch.get(match.id)!, ctx(`match ${match.id} at ${match.feeCents} above the max fee ${m.maxAtMatch.get(match.id)}`));
    assert.ok(match.feeCents >= 500, ctx('below the item minimum'));
  }
  for (const ask of app.store.asks.all()) {
    if (!ask.clock || ask.clock.startsAt === null) continue;
    const claim = app.store.claims.must(ask.claimId);
    const proof = claim.linePhotoProofId ? app.store.proofs.get(claim.linePhotoProofId) : null;
    assert.ok(proof?.status === 'passed' && claim.checkedInAt === ask.clock.startsAt, ctx(`${ask.id}'s fee clock started without a passed check-in`));
  }
  // Whole, non-negative cents everywhere.
  const money = [
    ...app.store.holds.all().flatMap((h) => [h.amount.cents, h.capturedCents, h.releasedCents, h.refundedCents]),
    ...app.store.jobs.all().flatMap((j) => [j.amounts.capturedCents, j.amounts.refundedCents, j.amounts.paidOutCents, j.amounts.processingCents ?? 0, j.amounts.paypalFeesCents ?? 0]),
    ...app.store.ledger.all().map((e) => e.amount.cents),
    ...app.store.payouts.all().map((p) => p.amount.cents),
  ];
  for (const c of money) assert.ok(Number.isInteger(c) && c >= 0, ctx(`not whole, non-negative cents: ${c}`));
  // Recovery leaves nothing in flight, except a payout PayPal already had (kept for reconciliation, never resent).
  const pending = app.store.ledger.where("status = 'pending'").filter((e) => !(e.payoutId && flagged.has(e.payoutId)));
  assert.deepEqual(pending.map((e) => e.idempotencyKey), [], ctx('money calls left pending after recovery'));
}

/** After the day and 31 more days: P1, P3, P4, and every hold closed. */
function checkEnd(m: Market): void {
  const app = m.app;
  const flagged = flaggedPayouts(app);
  const paypal = paypalJobs(m);
  const st = m.emulator();
  for (const hold of app.store.holds.all()) {
    if (hold.authorizationId === null) continue;
    // P1: nothing stays held; captured + released = held, and the ledger says the same.
    assert.ok(hold.status === 'captured' || hold.status === 'released', `hold ${hold.id} still ${hold.status} after 31 days`);
    // PayPal's side, not the server's arithmetic: the hold's authorization is closed, CAPTURED by a final
    // capture, VOIDED, or EXPIRED on day 29 (the emulator applies a lapse when the authorization is next
    // read, so an open one past its expiry is read as EXPIRED here). Either way PayPal releases what was
    // not captured; checkNow compares the captures.
    const auth = st.authorizations[hold.authorizationId];
    assert.ok(auth, `hold ${hold.id}: PayPal has no authorization ${hold.authorizationId}`);
    const lapsed = (auth.status === 'CREATED' || auth.status === 'PARTIALLY_CAPTURED') && app.now() >= auth.expiresAt;
    const status = lapsed ? 'EXPIRED' : auth.status;
    assert.ok(status === 'CAPTURED' || status === 'VOIDED' || status === 'EXPIRED', `hold ${hold.id} is ${hold.status}, but PayPal's authorization ${auth.id} is ${auth.status}`);
    assert.equal(status === 'CAPTURED', hold.status === 'captured', `hold ${hold.id} is ${hold.status}, PayPal's authorization ${status}`);
    if (status === 'EXPIRED') {
      assert.ok(app.store.ledger.first('idempotency_key = ?', `expire:${hold.id}`), `hold ${hold.id}: PayPal's authorization lapsed, but the server recorded no expiry`);
      SEEN.expiredHolds++;
    }
    assert.equal(hold.capturedCents + hold.releasedCents, hold.amount.cents, `hold ${hold.id}: ${hold.capturedCents} + ${hold.releasedCents} != ${hold.amount.cents}`);
    const entries = app.store.ledger.where("hold_id = ? AND status = 'succeeded'", hold.id);
    // A void of a renewal PayPal confirmed late releases that second authorization, not this hold's money.
    const released = entries.filter((e) => {
      const req = loadRequest(app, e.id);
      return e.kind === 'released' && !(req?.op === 'void' && req.stray);
    });
    assert.equal(sum(entries.filter((e) => e.kind === 'captured').map((e) => e.amount.cents)), hold.capturedCents, `ledger captures of ${hold.id}`);
    assert.equal(sum(released.map((e) => e.amount.cents)), hold.releasedCents, `ledger releases of ${hold.id}`);
  }
  for (const job of app.store.jobs.all()) {
    const pp = paypal.get(job.id) ?? { capturedCents: 0, refundedCents: 0, paidOutCents: 0, feesCents: 0, captures: 0 };
    const own = app.store.payouts.where('job_id = ?', job.id).filter((p) => flagged.has(p.id));
    const flaggedCents = sum(own.map((p) => p.amount.cents));
    const a = job.amounts;
    // P1: our books agree with PayPal's, to the cent.
    assert.equal(a.capturedCents, pp.capturedCents, `${job.id} captured`);
    assert.equal(a.refundedCents, pp.refundedCents, `${job.id} refunded`);
    assert.equal(a.paidOutCents + flaggedCents, pp.paidOutCents, `${job.id} paid out`);
    assert.equal((a.paypalFeesCents ?? 0) + PAYOUT_ITEM_FEE_CENTS * own.length, pp.feesCents, `${job.id} PayPal fees`);
    const s = jobSettlement(a);
    // HoldMySpot's share once the flagged payouts are reconciled.
    const platform = s.platformCents - flaggedCents - PAYOUT_ITEM_FEE_CENTS * own.length;
    const proofs = app.store.proofs.where("job_id = ? AND kind = 'purchase'", job.id);
    const rejected = proofs.some((p) => p.status === 'failed' && p.checks.some((c) => !c.ok && c.weight === 'hard'));
    if (rejected || pp.captures === 0) {
      // P3 and P4: no capture, no payout, no PayPal fee, no share.
      assert.deepEqual([pp.capturedCents, pp.paidOutCents, pp.feesCents, platform], [0, 0, 0, 0], `${job.id} moved money without a passed receipt`);
      continue;
    }
    if (pp.refundedCents > 0) {
      // Refunded after the fee payout (no tracking in time): HoldMySpot covers that payout and PayPal's fees, no more.
      assert.equal(pp.refundedCents, pp.capturedCents, `${job.id} refunded in part`);
      assert.equal(platform, -(pp.paidOutCents + pp.feesCents), `${job.id} refund cost HoldMySpot ${-platform}`);
      continue;
    }
    // P4: a completed job leaves exactly 10% of its queue fee, and the processing line is PayPal's fees to the cent.
    if (job.status === 'delivered' || job.status === 'shipped') {
      assert.equal(platform, platformFeeCents(job.qty * job.feeCents), `${job.id} left HoldMySpot ${platform}, 10% of ${job.qty} x ${job.feeCents} is ${platformFeeCents(job.qty * job.feeCents)}`);
      assert.equal(a.processingCents ?? 0, (a.paypalFeesCents ?? 0) + PAYOUT_ITEM_FEE_CENTS * own.length, `${job.id} processing is not PayPal's fees`);
    }
    assert.ok(platform >= 0, `${job.id} left HoldMySpot ${platform}`);
  }
}

function tally(m: Market): void {
  const app = m.app;
  const st = m.emulator();
  SEEN.days++;
  SEEN.checkIns += app.store.proofs.where("kind = 'check_in' AND status = 'passed'").length;
  for (const match of app.store.matches.all()) {
    SEEN.matches++;
    if (match.feeCents < app.store.asks.must(match.askId).feeCents) SEEN.clockFills++;
    if (match.trigger === 'requeue' && app.store.agentActions.where('bid_id = ?', match.bidId).some((x) => x.kind === 'reassign')) SEEN.reassigned++;
  }
  for (const job of app.store.jobs.all()) {
    if ((job.status === 'delivered' || job.status === 'shipped') && job.amounts.refundedCents === 0) SEEN.completed++;
    if (job.amounts.refundedCents > 0) SEEN.refunded++;
    if (app.store.proofs.where("job_id = ? AND kind = 'purchase'", job.id).some((p) => p.status === 'failed' && p.checks.some((c) => !c.ok && c.weight === 'hard'))) SEEN.rejected++;
  }
  SEEN.captures += Object.values(st.captures).length;
  SEEN.payouts += Object.values(st.payoutItems).length;
  SEEN.flaggedPayouts += flaggedPayouts(app).size;
}

/** PayPal's side of the day, keyed by what each object is for (ids can differ between runs). */
function fingerprint(m: Market): Record<string, string[]> {
  const st = m.emulator();
  const app = m.app;
  const bidOfOrder = new Map(app.store.bids.all().map((b: BidTask) => [b.paypalOrderId, b.id]));
  const records = new Map(app.store.payouts.all().map((p) => [p.id, p]));
  const captureJob = new Map(Object.values(st.captures).map((c) => [c.id, c.invoiceId]));
  return {
    captures: Object.values(st.captures).map((c) => `${c.invoiceId} ${c.amountCents} ${c.status} refunded ${c.refundedCents} final ${c.finalCapture}`).sort(),
    payouts: Object.values(st.payoutItems).map((it) => {
      const p = records.get(it.senderItemId);
      return `${p?.reference} ${p?.purpose} ${it.amountCents} ${settled(it)}`;
    }).sort(),
    authorizations: Object.values(st.authorizations).map((a) => `${bidOfOrder.get(a.orderId)} ${a.amountCents} ${a.status} ${a.parentId ? 'renewal' : 'first'} captures ${a.captureIds.length}`).sort(),
    refunds: Object.values(st.refunds).map((r) => `${captureJob.get(r.captureId)} ${r.amountCents}`).sort(),
    holds: app.store.holds.all().map((h) => `${h.reference} ${h.status} ${h.capturedCents}/${h.releasedCents}/${h.amount.cents}`).sort(),
  };
}

function describeOpening(m: Market): string {
  const app = m.app;
  const bids = app.store.bids.all().map((b) => `${b.requesterName} ${b.id} ${b.qty} x (cap ${usd(b.retailCapCents)} + max fee ${usd(b.maxFeeCents)}${b.shippingBudgetCents ? ` + shipping ${usd(b.shippingBudgetCents)}` : ''}) ${b.destination.mode}, hold ${usd(b.limitCents)}`);
  const asks = app.store.asks.all().map((a) => `${a.queuerName} ${a.id} ${a.capacity} at ${usd(a.feeCents)}${a.clock ? ` stepping ${usd(a.clock.stepCents)} every ${a.clock.intervalMs / MIN} min to ${usd(a.clock.floorCents)}` : ''} (${a.modes.join('/')})`);
  const matches = app.store.matches.all().map((x) => `${x.bidId}<${x.askId} ${x.qty} at ${usd(x.feeCents)}`);
  return [...bids, ...asks, `matches: ${matches.join(', ') || 'none'}`].join('; ');
}

async function runDay(day: Day, o: { faults: boolean }): Promise<Market> {
  const m = new Market(day.steps.some((s) => s.fault?.restart));
  await m.open(START);
  try {
    await openDay(m, day);
    m.log.push(`opening: ${describeOpening(m)}`);
    checkNow(m, 'opening');
    for (const [n, step] of day.steps.entries()) {
      const label = await play(m, o.faults ? step : { ...step, fault: step.fault ? { ...step.fault, effects: [] } : null }, n);
      m.log.push(`${n}. ${label}`);
      checkNow(m, `after event ${n} (${label})`);
    }
    await m.s.at(m.app.now() + 31 * DAY);
    await m.run(() => recoverPending(m.app));
    checkNow(m, '31 days later');
    checkEnd(m);
    tally(m);
    if (process.env.HMS_PROPERTY_LOG) console.log(`${m.log.join('\n')}\n---`);
    return m;
  } catch (err) {
    await m.close();
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`${why}\nThe day, as played${o.faults ? '' : ' without PayPal failures'}:\n  ${m.log.join('\n  ')}`, { cause: err });
  }
}

describe('market days on the PayPal emulator (P1-P4, P6, P7)', { skip: QUICK }, () => {
  const n = runs(120);
  it(`P1-P4 P6 P7: any day of requests, offers, receipts and PayPal failures keeps every money and market rule (${n} runs)`, async (t) => {
    Object.keys(SEEN).forEach((k) => (SEEN[k as keyof typeof SEEN] = 0));
    await holds(
      'P1-P4 P6 P7: any day',
      fc.asyncProperty(dayArb({ faultWeight: 3 }), async (day) => {
        const m = await runDay(day, { faults: true });
        await m.close();
      }),
      n,
    );
    t.diagnostic(seenText());
    t.diagnostic(`coverage ${JSON.stringify(SEEN)}`);
  });
});

describe('PayPal failures change nothing (P5)', { skip: QUICK }, () => {
  const n = runs(60);
  it(`P5 the same day with lost, dropped and garbled PayPal answers ends with the same PayPal objects and amounts (${n} runs)`, async (t) => {
    Object.keys(SEEN).forEach((k) => (SEEN[k as keyof typeof SEEN] = 0));
    await holds(
      'P5 the same day with lost',
      fc.asyncProperty(dayArb({ faultWeight: 4, minFaults: 1 }), async (day) => {
        const clean = await runDay(day, { faults: false });
        const a = fingerprint(clean);
        await clean.close();
        const faulty = await runDay(day, { faults: true });
        const b = fingerprint(faulty);
        await faulty.close();
        assert.deepEqual(b, a, 'with PayPal failures and recovery, PayPal ends with different objects or amounts');
      }),
      n,
    );
    t.diagnostic(`both runs of each: ${seenText()}`);
    t.diagnostic(`coverage ${JSON.stringify(SEEN)}`);
  });
});
