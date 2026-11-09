import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { ContractError } from './contract.ts';
import type { Cents, CityId, Destination, FeeClock, FulfilmentMode, Item, ProofCheckCode, Shop } from './contract.ts';
import { compatible, matchBook, sortAsks, sortBids } from './matching.ts';
import type { BookAsk, BookBid, BookContext, Fill } from './matching.ts';
import {
  PAYPAL_PRICING,
  assertCaptureWithinLimit,
  bidLimitCents,
  captureCapCents,
  grossUpCapture,
  jobCaps,
  jobSettlement,
  maxFeeWithinLimitCents,
  paypalCaptureFeeCents,
  payoutsForCapture,
  platformFeeCents,
  receiptCapture,
  shippingCapture,
} from './money.ts';
import type { PayPalPricing, PayoutPart } from './money.ts';
import { epochToZonedLocal, evaluatePurchase, zonedLocalToEpoch } from './proofs.ts';
import type { PurchaseContext, PurchaseReading } from './proofs.ts';
import { SEED_SHOPS } from './seed.ts';
import { askFeeAt, clockProblem, fillPriceForMax, ladder, maxSteps, nextDropAt, priceAt, reachesAt } from './stepdown.ts';
import type { StepDownSchedule } from './stepdown.ts';

/**
 * Property tests of the shared money and market rules (P1 to P4, P6 to P8 of
 * the test plan; P5, idempotency, needs the server and lives in
 * server/test/engine.property.test.ts with the end-to-end versions of the
 * others). Each property is checked on cases fast-check generates, not on
 * hand-picked numbers: any quantity, caps, fees, receipts, shipping, splits of
 * a request into jobs and job outcomes, any order book, any fee clock.
 *
 * `npm test` runs a fixed seed, so every run checks the same cases.
 * HMS_PROPERTY_SEED=random (or a number) and HMS_PROPERTY_RUNS=<n> search
 * further, for example:
 *   cd shared && HMS_PROPERTY_SEED=random HMS_PROPERTY_RUNS=20000 node --test src/money.property.test.ts
 * A failure prints fast-check's shrunk counterexample and the command that
 * replays exactly that case.
 */

const FILE = 'src/money.property.test.ts';
const SEED = process.env.HMS_PROPERTY_SEED === 'random' ? Math.floor(Math.random() * 2 ** 31) : Number(process.env.HMS_PROPERTY_SEED ?? 20261112);
// A search on another seed says which one it ran, so a passing log can be repeated (CI keeps it).
if (process.env.HMS_PROPERTY_SEED) console.log(`Property seed: ${SEED}`);
const RUNS = Number(process.env.HMS_PROPERTY_RUNS ?? 0);
const runs = (n: number) => (Number.isInteger(RUNS) && RUNS > 0 ? RUNS : n);

/** Checks a property; on failure throws fast-check's report (shrunk counterexample, seed, path) and a replay command. */
function holds<Ts>(name: string, property: fc.IProperty<Ts>, numRuns: number): void {
  const out = fc.check(property, { numRuns, seed: SEED, path: process.env.HMS_PROPERTY_PATH || undefined, includeErrorInReport: true });
  if (!out.failed) return;
  const replay = `cd shared && HMS_PROPERTY_SEED=${out.seed} HMS_PROPERTY_PATH=${out.counterexamplePath ?? ''} node --test --test-name-pattern="${name}" ${FILE}`;
  throw new Error(`${name}: ${fc.defaultReportMessage(out) ?? 'failed'}\nReplay this case: ${replay}`);
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** PayPal's rate as the sandbox charged it on 11-07, written out here as the oracle: 3.49% to the cent + $0.49 per capture, $0.25 per payout item. */
const paypalFeeOracle = (captureCents: number) => (captureCents > 0 ? Math.round((captureCents * 349) / 10_000) + 49 : 0);
const PAYOUT_ITEM_FEE = 25;

// ---------------------------------------------------------------------------
// One request (bid), any split into jobs, any outcome per job
// ---------------------------------------------------------------------------

interface Bid {
  mode: FulfilmentMode;
  qty: number;
  retailCapCents: Cents;
  maxFeeCents: Cents;
  shippingBudgetCents: Cents;
}

/**
 * What happens to one matched job. `rejected` (a hard check failed) and
 * `not_bought` (sold out, no-show, cancelled, queuer withdrew) end before any
 * capture, so the units go back to the request; the others capture.
 */
type Outcome = 'completed' | 'rejected' | 'not_bought' | 'not_shipped' | 'shipping_declined';

interface Attempt {
  qty: number;
  /** The matched fee as a share of the request's max fee (in 1/10000): the book never fills above the max (P6). */
  feeShare: number;
  outcome: Outcome;
  /** The receipt, shipping and duty as a share of the job's caps (in 1/1000): up to twice the cap, so clamping is exercised. */
  receiptPermille: number;
  shippingPermille: number;
  dutyPermille: number;
}

interface SimJob {
  qty: number;
  feeCents: Cents;
  outcome: Outcome;
  captures: Cents[];
  processingCents: Cents;
  refundedCents: Cents;
  payouts: PayoutPart[];
}

const bidArb: fc.Arbitrary<Bid> = fc.constantFrom<FulfilmentMode>('ship', 'local').chain((mode) =>
  fc.record({
    mode: fc.constant(mode),
    qty: fc.integer({ min: 1, max: 6 }),
    retailCapCents: fc.integer({ min: 1, max: 60_000 }),
    maxFeeCents: fc.integer({ min: 1, max: 30_000 }),
    shippingBudgetCents: mode === 'ship' ? fc.integer({ min: 1, max: 30_000 }) : fc.constant(0),
  }),
);

const attemptArb: fc.Arbitrary<Attempt> = fc.record({
  qty: fc.integer({ min: 1, max: 6 }),
  feeShare: fc.integer({ min: 0, max: 10_000 }),
  outcome: fc.constantFrom<Outcome>('completed', 'rejected', 'not_bought', 'not_shipped', 'shipping_declined'),
  receiptPermille: fc.integer({ min: 0, max: 2_000 }),
  shippingPermille: fc.integer({ min: 0, max: 2_000 }),
  dutyPermille: fc.integer({ min: 0, max: 500 }),
});

const share = (cents: number, permille: number) => Math.floor((cents * permille) / 1000);

/**
 * Runs the server's money steps with the shared rules: the units of a job that
 * ends before purchase go back to the request and can be matched again; every
 * capture is what receiptCapture / shippingCapture return for the job's caps;
 * every payout is payoutsForCapture's, and only positive payouts are sent (as
 * the server does); a job not shipped in time is refunded in full.
 */
function simulate(bid: Bid, attempts: readonly Attempt[]): { limitCents: Cents; jobs: SimJob[] } {
  const limitCents = bidLimitCents(bid, bid.mode);
  const jobs: SimJob[] = [];
  let left = bid.qty;
  for (const a of attempts) {
    if (left === 0) break;
    const qty = Math.min(a.qty, left);
    const feeCents = Math.max(1, Math.floor((bid.maxFeeCents * a.feeShare) / 10_000));
    const caps = jobCaps(bid, { qty, feeCents }, bid.mode);
    const outcome: Outcome = bid.mode === 'local' && (a.outcome === 'not_shipped' || a.outcome === 'shipping_declined') ? 'completed' : a.outcome;
    const job: SimJob = { qty, feeCents, outcome, captures: [], processingCents: 0, refundedCents: 0, payouts: [] };
    jobs.push(job);
    if (outcome === 'rejected' || outcome === 'not_bought') continue;
    left -= qty;
    // A receipt passes only with a price for the item: the rules send a $0 reading to a person, whose
    // pass charges the shop price (D-135; checked below in "P3 every forgery"). So at least 1 cent.
    const receipt = Math.max(1, share(caps.retailCents, a.receiptPermille));
    if (bid.mode === 'local') {
      const c = receiptCapture(caps, receipt, 'local');
      assert.ok(c.amountCents <= captureCapCents(caps, 'local', 'handover'), 'a handover capture fits its job cap');
      job.captures.push(c.amountCents);
      job.processingCents += c.processingCents;
      job.payouts.push(...payoutsForCapture('local', 'handover', { retailCents: c.retailCents, feeCents: c.feeCents, shippingCents: 0 }));
    } else {
      const c1 = receiptCapture(caps, receipt, 'ship');
      assert.ok(c1.amountCents <= captureCapCents(caps, 'ship', 'receipt'), 'a receipt capture fits its job cap');
      job.captures.push(c1.amountCents);
      job.processingCents += c1.processingCents;
      job.payouts.push(...payoutsForCapture('ship', 'receipt', { retailCents: c1.retailCents, feeCents: c1.feeCents, shippingCents: 0 }));
      if (outcome === 'not_shipped') {
        job.refundedCents = c1.amountCents;
      } else {
        const c2 = shippingCapture(caps, share(caps.shippingCents, a.shippingPermille), share(caps.shippingCents, a.dutyPermille));
        assert.ok(c2.amountCents <= captureCapCents(caps, 'ship', 'shipping'), 'a shipping capture fits its job cap');
        // A declined shipping capture takes nothing; the queuer is still paid back the shop price.
        const shipped = outcome === 'shipping_declined' ? 0 : c2.shippingCents;
        if (outcome !== 'shipping_declined' && c2.amountCents > 0) {
          job.captures.push(c2.amountCents);
          job.processingCents += c2.processingCents;
        }
        job.payouts.push(...payoutsForCapture('ship', 'shipping', { retailCents: c1.retailCents, feeCents: 0, shippingCents: shipped }));
      }
    }
    job.payouts = job.payouts.filter((p) => p.amountCents > 0);
  }
  return { limitCents, jobs };
}

/** PayPal's fees on a job, from the oracle: every capture, every payout item sent. */
const paypalFees = (j: SimJob) => sum(j.captures.map(paypalFeeOracle)) + PAYOUT_ITEM_FEE * j.payouts.length;

describe('P1, P2, P4: one request, any split into jobs, any outcome per job (shared rules)', () => {
  const n = runs(2000);

  it(`P1 every captured cent goes to the queuer, to PayPal or to HoldMySpot's 10%, each share from its own rule, and the processing line is PayPal's fee (${n} runs)`, () => {
    holds(
      'P1 every captured cent goes to the queuer',
      fc.property(bidArb, fc.array(attemptArb, { minLength: 1, maxLength: 8 }), (bid, attempts) => {
        // What the hold releases is not checked here: PayPal releases what is not captured, so it is
        // limit - captured by definition. The server days check that PayPal closed every authorization
        // (captured or voided) and that its captures equal the server's (server/test/engine.property.test.ts).
        const { jobs } = simulate(bid, attempts);
        for (const j of jobs) {
          const cap = sum(j.captures);
          const paid = sum(j.payouts.map((p) => p.amountCents));
          const cut = sum(j.payouts.map((p) => p.platformFeeCents));
          for (const x of [...j.captures, ...j.payouts.map((p) => p.amountCents), cut, j.refundedCents]) {
            assert.ok(Number.isInteger(x) && x >= 0, `whole, non-negative cents: ${x}`);
          }
          if (j.outcome === 'not_shipped') {
            // Refunded in full: the requester gets every cent back; PayPal keeps its fees and the fee payout went out.
            assert.equal(j.refundedCents, cap);
          } else {
            // Each term from its own rule: captures from the capture rules, payouts and the 10% from the payout rule, fees from PayPal's rate.
            assert.equal(cap, paid + paypalFees(j) + cut, `captured ${cap} = paid out ${paid} + PayPal ${paypalFees(j)} + HoldMySpot ${cut}`);
            // The requester's processing line is exactly what PayPal charges.
            assert.equal(j.processingCents, paypalFees(j), 'processing at cost');
          }
        }
      }),
      n,
    );
  });

  it(`P2 the captures of any split never pass the hold, receipts and labels above the caps included (${n} runs)`, () => {
    holds(
      'P2 the captures of any split never pass the hold',
      fc.property(bidArb, fc.array(attemptArb, { minLength: 1, maxLength: 8 }), (bid, attempts) => {
        const { limitCents, jobs } = simulate(bid, attempts);
        const captured = sum(jobs.flatMap((j) => j.captures));
        assert.ok(captured <= limitCents, `captured ${captured} of a ${limitCents} hold`);
        // The server's own check agrees, capture by capture, and leaves exactly what is not captured.
        let done = 0;
        for (const c of jobs.flatMap((j) => j.captures)) {
          const left = assertCaptureWithinLimit({ limitCents, capturedCents: done, status: done === 0 ? 'held' : 'partially_captured' }, c);
          done += c;
          assert.equal(left, limitCents - done);
        }
      }),
      n,
    );
  });

  // "A rejected receipt moves $0" is checked on the server days (server/test/engine.property.test.ts),
  // where the server's own code decides the capture; this simulation skips the capture for a rejected
  // or unbought job by construction, so it cannot test that.

  it(`P4 every completed job leaves HoldMySpot exactly floor(10% of the queue fee); a refund after the fee payout costs it that payout and PayPal's fees, no more (${n} runs)`, () => {
    holds(
      'P4 every completed job leaves HoldMySpot exactly 10%',
      fc.property(bidArb, fc.array(attemptArb, { minLength: 1, maxLength: 8 }), (bid, attempts) => {
        for (const j of simulate(bid, attempts).jobs) {
          const s = jobSettlement({
            capturedCents: sum(j.captures),
            refundedCents: j.refundedCents,
            paidOutCents: sum(j.payouts.map((p) => p.amountCents)),
            processingCents: j.processingCents,
            paypalFeesCents: paypalFees(j),
          });
          if (j.outcome === 'not_shipped') {
            // Refunded after the fee payout: HoldMySpot covers that payout and PayPal's fees, and no more.
            assert.equal(s.chargedCents, 0);
            assert.equal(s.platformCents, -(s.paidOutCents + s.paypalFeesCents));
            continue;
          }
          const expected = j.captures.length === 0 ? 0 : platformFeeCents(j.qty * j.feeCents);
          assert.equal(s.platformCents, expected, `HoldMySpot keeps ${s.platformCents}, 10% of ${j.qty} x ${j.feeCents} is ${expected}`);
          assert.ok(s.platformCents >= 0);
          assert.equal(s.processingVarianceCents, 0);
        }
      }),
      n,
    );
  });

  it(`P2 the limit check refuses every capture past 100% of the hold, whatever PayPal's 115% would allow (${n} runs)`, () => {
    holds(
      'P2 the limit check refuses every capture past 100%',
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.array(fc.integer({ min: 1, max: 1_200_000 }), { maxLength: 12 }), (limitCents, tries) => {
        let captured = 0;
        for (const amount of tries) {
          const hold = { limitCents, capturedCents: captured, status: captured === 0 ? ('held' as const) : ('partially_captured' as const) };
          let accepted = true;
          try {
            assertCaptureWithinLimit(hold, amount);
          } catch (err) {
            assert.ok(err instanceof ContractError && err.code === 'OVER_LIMIT', String(err));
            accepted = false;
          }
          assert.equal(accepted, captured + amount <= limitCents, `capture ${amount} with ${captured} of ${limitCents} captured`);
          if (accepted) captured += amount;
          assert.ok(captured <= limitCents);
        }
      }),
      n,
    );
  });
});

// ---------------------------------------------------------------------------
// P3: the receipt rules. Any forgery fails a hard check, and a failed hard check always fails.
// ---------------------------------------------------------------------------

type Forgery =
  | 'code_missing'
  | 'code_wrong'
  | 'other_shop'
  | 'qr_total'
  | 'qr_number'
  | 'printed_before_check_in'
  | 'printed_after_upload'
  | 'totals_off'
  | 'line_off'
  | 'recycled_photo'
  | 'wrong_quantity';
type SoftIssue = 'above_cap' | 'zero_price' | 'other_line' | 'generator_metadata';

const HARD_CHECK: Record<Forgery, ProofCheckCode> = {
  code_missing: 'code_visible',
  code_wrong: 'code_visible',
  other_shop: 'shop_match',
  qr_total: 'qr_matches_print',
  qr_number: 'qr_matches_print',
  printed_before_check_in: 'time_window',
  printed_after_upload: 'time_window',
  totals_off: 'totals_add_up',
  line_off: 'totals_add_up',
  recycled_photo: 'duplicate_photo',
  wrong_quantity: 'qty_within_limit',
};
const SOFT_CHECK: Record<SoftIssue, ProofCheckCode> = {
  above_cap: 'within_retail_cap',
  zero_price: 'within_retail_cap',
  other_line: 'item_match',
  generator_metadata: 'generator_metadata',
};

const SHOP_ITEMS: { shop: Shop; item: Item }[] = SEED_SHOPS.flatMap((shop) => shop.items.map((item) => ({ shop, item })));

interface ReceiptCase {
  shop: Shop;
  item: Item;
  qty: number;
  forgeries: Forgery[];
  soft: SoftIssue[];
  shiftMinutes: number;
  offCents: number;
}

const receiptCaseArb: fc.Arbitrary<ReceiptCase> = fc
  .record({
    pick: fc.integer({ min: 0, max: SHOP_ITEMS.length - 1 }),
    qtyShare: fc.integer({ min: 0, max: 1000 }),
    forgeries: fc.oneof(
      { weight: 1, arbitrary: fc.constant<Forgery[]>([]) },
      { weight: 2, arbitrary: fc.subarray<Forgery>(Object.keys(HARD_CHECK) as Forgery[], { minLength: 1, maxLength: 3 }) },
    ),
    soft: fc.oneof({ weight: 1, arbitrary: fc.constant<SoftIssue[]>([]) }, { weight: 1, arbitrary: fc.subarray<SoftIssue>(Object.keys(SOFT_CHECK) as SoftIssue[], { minLength: 1, maxLength: 2 }) }),
    shiftMinutes: fc.integer({ min: 2, max: 90 }),
    offCents: fc.integer({ min: 2, max: 5_000 }),
  })
  .map(({ pick, qtyShare, ...rest }) => {
    const { shop, item } = SHOP_ITEMS[pick]!;
    const qty = 1 + Math.floor(((item.perPersonLimit - 1) * qtyShare) / 1000);
    return { shop, item, qty, ...rest };
  });

/**
 * Each shop's clock on 2026-11-12, worked out once (Intl time zones are slow to build): every
 * seed shop is open from 11:30 to 15:00, so the queuer checks in at 13:00, buys at 13:50 and
 * uploads at 14:00 local time. No daylight-saving change falls on that day.
 */
const SHOP_DAY = new Map(
  SEED_SHOPS.map((shop) => {
    const day = epochToZonedLocal(Date.parse('2026-11-12T20:00:00Z'), shop.timezone).slice(0, 10);
    const uploadedAt = zonedLocalToEpoch(`${day} 14:00`, shop.timezone)!;
    const offsetMs = Date.parse(`${day}T14:00:00Z`) - uploadedAt;
    return [shop.id, { uploadedAt, offsetMs }];
  }),
);
const localTime = (epoch: number, offsetMs: number) => new Date(epoch + offsetMs).toISOString().slice(0, 16).replace('T', ' ');

/** A genuine receipt for the job, then each forgery and soft issue applied on top. */
function receiptFor(c: ReceiptCase): { reading: PurchaseReading; ctx: PurchaseContext } {
  const { shop, item, qty } = c;
  const { uploadedAt, offsetMs } = SHOP_DAY.get(shop.id)!;
  const checkedInAt = uploadedAt - 60 * 60_000;
  const proofCode = 'K7M3P';
  const retailCapCents = item.retailCents * qty;
  let printedAt = uploadedAt - 10 * 60_000;
  if (c.forgeries.includes('printed_before_check_in')) printedAt = checkedInAt - 5 * 60_000 - c.shiftMinutes * 60_000;
  if (c.forgeries.includes('printed_after_upload')) printedAt = uploadedAt + c.shiftMinutes * 60_000;
  const issuedAtLocal = localTime(printedAt, offsetMs);
  const units = c.forgeries.includes('wrong_quantity') ? qty + 1 + (c.shiftMinutes % 3) : qty;
  const unitMinor = c.soft.includes('zero_price') ? 0 : c.soft.includes('above_cap') ? item.retail.minor + 1 + c.offCents : item.retail.minor;
  const lines = [{ name: item.receiptAliases[0] ?? item.name, qty: units, unitMinor, totalMinor: unitMinor * units }];
  if (c.soft.includes('other_line')) lines.push({ name: 'GIFT BAG', qty: 1, unitMinor: 150, totalMinor: 150 });
  if (c.forgeries.includes('line_off')) lines[0] = { ...lines[0]!, totalMinor: lines[0]!.totalMinor + c.offCents };
  const lineSum = sum(lines.map((l) => l.totalMinor));
  const totalMinor = c.forgeries.includes('totals_off') ? lineSum + c.offCents : lineSum;
  const qrStyle = shop.receipt.sellerTaxId !== null;
  const otherShop = c.forgeries.includes('other_shop');
  const seller = qrStyle ? (otherShop ? '99999999' : shop.receipt.sellerTaxId) : null;
  const invoiceNumber = 'LLT-20261112-0042';
  const reading: PurchaseReading = {
    printedName: !qrStyle && otherShop ? 'SOMEWHERE ELSE TRADING' : shop.receipt.printedName,
    sellerTaxId: seller,
    invoiceNumber,
    issuedAtLocal,
    currency: item.retail.currency,
    lines,
    totalMinor,
    qr: qrStyle
      ? {
          invoiceNumber: c.forgeries.includes('qr_number') ? 'LLT-20261112-9999' : invoiceNumber,
          issuedDate: issuedAtLocal.slice(0, 10),
          sellerTaxId: seller,
          totalMinor: c.forgeries.includes('qr_total') ? totalMinor + c.offCents : totalMinor,
        }
      : null,
    itemPhoto: { codeSeen: c.forgeries.includes('code_missing') ? null : c.forgeries.includes('code_wrong') ? 'H4T9X' : proofCode, unitsVisible: units },
    anomalies: [],
    generatorMetadata: c.soft.includes('generator_metadata'),
  };
  const ctx: PurchaseContext = {
    shop,
    item,
    job: { qty, proofCode, retailCapCents, twdPerUsd: null },
    checkedInAt,
    uploadedAt,
    duplicateOf: c.forgeries.includes('recycled_photo') ? 'file_0007' : null,
  };
  return { reading, ctx };
}

describe('P3: the receipt rules (shared/src/proofs.ts)', () => {
  const n = runs(500);
  it(`P3 every forgery fails its hard check and fails the receipt; soft issues go to a person; a clean receipt passes (${n} runs)`, () => {
    holds(
      'P3 every forgery fails its hard check',
      fc.property(receiptCaseArb, (c) => {
        const { reading, ctx } = receiptFor(c);
        const v = evaluatePurchase(reading, ctx);
        const failed = new Set(v.checks.filter((x) => !x.ok).map((x) => x.code));
        const hardFailed = v.checks.some((x) => !x.ok && x.weight === 'hard');
        const qrStyle = c.shop.receipt.sellerTaxId !== null;
        // The QR forgeries only exist on shops that print a QR.
        const forgeries = c.forgeries.filter((f) => qrStyle || (f !== 'qr_total' && f !== 'qr_number'));
        for (const f of forgeries) assert.ok(failed.has(HARD_CHECK[f]), `${f} must fail ${HARD_CHECK[f]}; failed: ${[...failed].join(', ')}`);
        // The verdict follows the weights: any hard failure fails, else any failure goes to a person, else it passes.
        assert.equal(v.status, hardFailed ? 'failed' : failed.size > 0 ? 'needs_review' : 'passed');
        if (forgeries.length > 0) assert.equal(v.status, 'failed', 'a forgery is never passed or left for review');
        if (forgeries.length === 0) {
          for (const s of c.soft) assert.ok(failed.has(SOFT_CHECK[s]), `${s} must flag ${SOFT_CHECK[s]}`);
          assert.equal(v.status, c.soft.length > 0 ? 'needs_review' : 'passed');
        }
      }),
      n,
    );
  });

  it(`P3 listed price: a real receipt reprinted above the item's listed price, within the requester's cap and its QR regenerated to match, goes to a person and is never passed (${n} runs)`, () => {
    holds(
      'P3 listed price: a reprint above the listing',
      fc.property(receiptCaseArb, fc.integer({ min: 1, max: 3_000 }), fc.integer({ min: 1, max: 1_000 }), (c, headroom, share) => {
        const { reading, ctx } = receiptFor({ ...c, forgeries: [], soft: [] });
        const units = reading.lines[0]!.qty;
        // The requester's cap per unit, above the listed price; the reprint raises the unit price toward it.
        const capUnit = c.item.retail.minor + headroom;
        const unit = c.item.retail.minor + Math.max(1, Math.floor((headroom * share) / 1000));
        const total = unit * units;
        const reprint: PurchaseReading = {
          ...reading,
          lines: [{ ...reading.lines[0]!, unitMinor: unit, totalMinor: total }],
          totalMinor: total,
          qr: reading.qr ? { ...reading.qr, totalMinor: total } : null,
        };
        const v = evaluatePurchase(reprint, { ...ctx, job: { ...ctx.job, retailCapCents: capUnit * units } });
        // The reprint agrees with itself (lines, total, QR) and stays under the cap; only the listing catches it (D-151).
        assert.equal(v.status, 'needs_review');
        assert.deepEqual(v.checks.filter((x) => !x.ok).map((x) => x.code), ['listed_price']);
      }),
      n,
    );
  });

  it(`P3 scope: a receipt reprinted at a higher price that stays at or under the listed price (or, for an item with no listed price, under the cap) passes every check; the charge is the reprint's, never above the listing or the cap (${n} runs)`, () => {
    holds(
      'P3 scope: a reprinted receipt under the listing',
      fc.property(receiptCaseArb, fc.integer({ min: 1, max: 3_000 }), fc.integer({ min: 1, max: 1_000 }), fc.boolean(), (c, headroom, share, listed) => {
        const { reading, ctx } = receiptFor({ ...c, forgeries: [], soft: [] });
        const units = reading.lines[0]!.qty;
        // What the queuer really paid: below the listing (a sale or a discount); the reprint shows a higher price.
        const listUnit = c.item.retail.minor;
        if (listUnit < 2) return;
        const paidUnit = Math.max(1, listUnit - Math.max(1, Math.floor((listUnit * share) / 2000)));
        const capUnit = listUnit + headroom;
        const ceilingUnit = listed ? listUnit : capUnit;
        const unit = paidUnit + Math.max(1, Math.floor(((ceilingUnit - paidUnit) * share) / 1000));
        const total = unit * units;
        const reprint: PurchaseReading = {
          ...reading,
          lines: [{ ...reading.lines[0]!, unitMinor: unit, totalMinor: total }],
          totalMinor: total,
          qr: reading.qr ? { ...reading.qr, totalMinor: total } : null,
        };
        const item = listed ? ctx.item : { receiptAliases: ctx.item.receiptAliases, perPersonLimit: ctx.item.perPersonLimit };
        const v = evaluatePurchase(reprint, { ...ctx, item, job: { ...ctx.job, retailCapCents: capUnit * units } });
        // Every check compares the receipt with itself, the job, the shop's ID, the clock, the cap or the listing; none
        // with what the shop really charged, and the receipt QR is plain text anyone can regenerate.
        assert.equal(v.status, 'passed', `failed: ${v.checks.filter((x) => !x.ok).map((x) => x.code).join(', ')}`);
        assert.equal(v.retailCents, total, 'the reprinted price is read');
        assert.ok(total > paidUnit * units, 'above what the shop charged');
        // The bound: the capture charges the reprint's price, never more than the listing (or the cap without one).
        const caps = jobCaps({ qty: units, retailCapCents: capUnit, shippingBudgetCents: 0 }, { qty: units, feeCents: 1000 }, 'local');
        const capture = receiptCapture(caps, v.retailCents!, 'local');
        assert.equal(capture.retailCents, total);
        assert.ok(capture.retailCents <= ceilingUnit * units, listed ? 'never above the listed price' : 'never above the cap');
      }),
      n,
    );
  });
});

// ---------------------------------------------------------------------------
// P6: the fee clock and the order book
// ---------------------------------------------------------------------------

const scheduleArb: fc.Arbitrary<StepDownSchedule> = fc
  .record({
    floorCents: fc.integer({ min: 1, max: 20_000 }),
    span: fc.integer({ min: 0, max: 20_000 }),
    stepCents: fc.integer({ min: 1, max: 5_000 }),
    intervalMs: fc.integer({ min: 60_000, max: 3_600_000 }),
    startsAt: fc.integer({ min: 0, max: 10 * 86_400_000 }),
  })
  .map(({ floorCents, span, ...rest }) => ({ ...rest, floorCents, openCents: floorCents + span }));

describe('P6: the fee clock (shared/src/stepdown.ts)', () => {
  const n = runs(2000);
  it(`P6 the step-down never rises, never goes below its floor or above its opening fee, and drops only by whole steps (${n} runs)`, () => {
    holds(
      'P6 the step-down never rises',
      fc.property(
        scheduleArb.chain((s) =>
          fc.tuple(
            fc.constant(s),
            fc.array(fc.oneof(fc.integer({ min: -s.intervalMs, max: (maxSteps(s) + 1) * s.intervalMs }), fc.integer({ min: -86_400_000, max: 20 * 86_400_000 })), {
              minLength: 2,
              maxLength: 12,
            }),
          ),
        ),
        ([s, offsets]) => {
        assert.equal(clockProblem(s.openCents, s), null, 'the generated clock is one a queuer may post');
        const times = offsets.map((o) => s.startsAt + o).sort((a, b) => a - b);
        let prev = Number.POSITIVE_INFINITY;
        for (const t of times) {
          const p = priceAt(s, t);
          assert.ok(p <= prev, `price rose from ${prev} to ${p}`);
          assert.ok(p >= s.floorCents && p <= s.openCents, `${p} outside ${s.floorCents}..${s.openCents}`);
          if (t < s.startsAt + s.intervalMs) assert.equal(p, s.openCents, 'no drop before the first interval');
          assert.ok(p === s.floorCents || (s.openCents - p) % s.stepCents === 0, 'above the floor, every price is the opening fee minus whole steps');
          const next = nextDropAt(s, t);
          if (next === null) assert.equal(p, s.floorCents);
          else {
            assert.ok(next > t && priceAt(s, next) < p && priceAt(s, next - 1) === p, 'the next drop is the next change');
          }
          prev = p;
        }
        const steps = ladder(s);
        assert.equal(steps.length, maxSteps(s) + 1);
        assert.equal(steps.at(-1)!.priceCents, s.floorCents);
        for (let i = 1; i < steps.length; i++) assert.ok(steps[i]!.priceCents < steps[i - 1]!.priceCents);
      }),
      n,
    );
  });

  it(`P6 a resting max fills at the first step at or below it, never above it, never below the floor (${n} runs)`, () => {
    holds(
      'P6 a resting max fills at the first step at or below it',
      fc.property(scheduleArb, fc.integer({ min: 0, max: 45_000 }), (s, max) => {
        const fill = fillPriceForMax(s, max);
        const at = reachesAt(s, max);
        if (max < s.floorCents) {
          assert.equal(fill, null);
          return;
        }
        assert.ok(fill !== null && at !== null);
        assert.ok(fill <= max && fill >= s.floorCents);
        assert.equal(fill, priceAt(s, at));
        if (at > s.startsAt) assert.ok(priceAt(s, at - 1) > max, 'not a step later than needed');
      }),
      n,
    );
  });

  it(`P6 before check-in the clock has not started: the fee stays at the opening fee at any time (${n} runs)`, () => {
    holds(
      'P6 before check-in the fee stays',
      fc.property(fc.integer({ min: 1, max: 30_000 }), scheduleArb, fc.integer({ min: 0, max: 30 * 86_400_000 }), (fee, s, t) => {
        const clock: FeeClock = { stepCents: s.stepCents, intervalMs: s.intervalMs, floorCents: Math.min(s.floorCents, fee), startsAt: null };
        assert.equal(askFeeAt({ feeCents: fee, clock }, t), fee);
        assert.equal(askFeeAt({ feeCents: fee, clock: null }, t), fee);
      }),
      n,
    );
  });
});

const NOW = 1_000_000_000;
const HOUR = 3_600_000;

/** Mostly `usual`, sometimes `edge`: books where most orders can trade, with every reason not to trade still in the mix. */
const mostly = <T,>(usual: fc.Arbitrary<T>, edge: fc.Arbitrary<T>) => fc.oneof({ weight: 6, arbitrary: usual }, { weight: 1, arbitrary: edge });

const destinationArb: fc.Arbitrary<Destination> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<Destination>({ mode: 'ship', country: 'US', region: 'NY', city: 'New York', postalCode: null }) },
  { weight: 2, arbitrary: mostly(fc.constant<CityId>('sf'), fc.constant<CityId>('nyc')).map((cityId): Destination => ({ mode: 'local', cityId })) },
);

// Requesters and queuers are different people, except "x", who is both (a self-match the book must refuse).
const bookBidArb = (id: string): fc.Arbitrary<BookBid> =>
  fc.record({
    id: fc.constant(id),
    requesterId: mostly(fc.constantFrom('r1', 'r2', 'r3'), fc.constant('x')),
    maxFeeCents: fc.integer({ min: 300, max: 3_000 }),
    remainingQty: mostly(fc.integer({ min: 1, max: 4 }), fc.constant(0)),
    destination: destinationArb,
    deadlineAt: mostly(fc.integer({ min: NOW + 1, max: NOW + 3 * HOUR }), fc.integer({ min: NOW - HOUR, max: NOW })),
    pricedAt: fc.integer({ min: NOW - 2 * HOUR, max: NOW }),
    matchable: mostly(fc.constant(true), fc.constant(false)),
  });

const bookAskArb = (id: string, bidIds: string[]): fc.Arbitrary<BookAsk> =>
  fc
    .record({
      id: fc.constant(id),
      queuerId: mostly(fc.constantFrom('q1', 'q2', 'q3'), fc.constant('x')),
      feeCents: fc.integer({ min: 100, max: 2_500 }),
      clock: fc.option(
        fc.record({
          stepCents: fc.integer({ min: 1, max: 500 }),
          intervalMs: fc.integer({ min: 60_000, max: 1_800_000 }),
          floorShare: fc.integer({ min: 0, max: 1000 }),
          startsAt: fc.option(mostly(fc.integer({ min: NOW - 2 * HOUR, max: NOW }), fc.integer({ min: NOW + 1, max: NOW + HOUR })), { freq: 4 }),
        }),
      ),
      remainingCapacity: mostly(fc.integer({ min: 1, max: 4 }), fc.constant(0)),
      modes: mostly(fc.constant<FulfilmentMode[]>(['ship', 'local']), fc.constantFrom<FulfilmentMode[]>(['ship'], ['local'])),
      etaAt: mostly(fc.integer({ min: NOW - HOUR, max: NOW + HOUR }), fc.integer({ min: NOW + HOUR, max: NOW + 4 * HOUR })),
      windowEndsAt: fc.option(mostly(fc.integer({ min: NOW, max: NOW + HOUR }), fc.integer({ min: NOW - HOUR, max: NOW - 1 }))),
      pricedAt: fc.integer({ min: NOW - 2 * HOUR, max: NOW }),
      matchable: mostly(fc.constant(true), fc.constant(false)),
      targetBidId: bidIds.length > 0 ? mostly(fc.constant<string | null>(null), fc.constantFrom<string | null>(...bidIds)) : fc.constant(null),
    })
    .map(({ clock, feeCents, ...rest }): BookAsk => ({
      ...rest,
      feeCents,
      clock: clock ? { stepCents: clock.stepCents, intervalMs: clock.intervalMs, floorCents: Math.max(1, Math.floor((feeCents * clock.floorShare) / 1000)), startsAt: clock.startsAt } : null,
    }));

const bookArb = fc
  .record({ bids: mostly(fc.integer({ min: 1, max: 6 }), fc.constant(0)), asks: mostly(fc.integer({ min: 1, max: 6 }), fc.constant(0)) })
  .chain(({ bids, asks }) => {
    const bidIds = Array.from({ length: bids }, (_, i) => `bid${i}`);
    return fc.record({
      bids: fc.tuple(...bidIds.map((id) => bookBidArb(id))),
      asks: fc.tuple(...Array.from({ length: asks }, (_, i) => bookAskArb(`ask${i}`, bidIds))),
      shopCityId: mostly(fc.constant<CityId>('sf'), fc.constant<CityId>('nyc')),
    });
  });

describe('P6: the order book (shared/src/matching.ts)', () => {
  const n = runs(1000);
  it(`P6 every fill is at the ask's clock price now, at or under the bid's max, between compatible orders, within quantities (${n} runs)`, (t) => {
    const seen = { books: 0, filled: 0, fills: 0, belowOpening: 0 };
    holds(
      'P6 every fill is at the ask clock price',
      fc.property(bookArb, ({ bids, asks, shopCityId }) => {
        const ctx: BookContext = { shopCityId, now: NOW };
        const fills = matchBook(bids, asks, ctx);
        seen.books++;
        seen.fills += fills.length;
        if (fills.length > 0) seen.filled++;
        seen.belowOpening += fills.filter((f) => f.feeCents < asks.find((a) => a.id === f.askId)!.feeCents).length;
        const bidOf = new Map(bids.map((b) => [b.id, b]));
        const askOf = new Map(asks.map((a) => [a.id, a]));
        for (const f of fills) {
          const bid = bidOf.get(f.bidId)!;
          const ask = askOf.get(f.askId)!;
          assert.ok(bid.matchable && ask.matchable && f.qty > 0 && f.at === NOW);
          assert.equal(f.feeCents, askFeeAt(ask, NOW), 'execution at the ask clock price now');
          assert.ok(f.feeCents <= bid.maxFeeCents, `filled at ${f.feeCents} above the max ${bid.maxFeeCents}`);
          if (ask.clock) assert.ok(f.feeCents >= Math.min(ask.clock.floorCents, ask.feeCents), 'never below the floor');
          assert.ok(compatible(bid, ask, ctx), 'mode, city, ETA, deadline, window, self-match and claim target');
        }
        for (const b of bids) assert.ok(sum(fills.filter((f) => f.bidId === b.id).map((f) => f.qty)) <= Math.max(0, b.remainingQty));
        for (const a of asks) assert.ok(sum(fills.filter((f) => f.askId === a.id).map((f) => f.qty)) <= Math.max(0, a.remainingCapacity));
      }),
      n,
    );
    t.diagnostic(`${seen.books} books (shrinking included): ${seen.filled} with fills, ${seen.fills} fills, ${seen.belowOpening} at a clock price below the opening fee`);
  });

  it(`P6 price-time priority holds and no trade is left on the table (${n} runs)`, () => {
    holds(
      'P6 price-time priority holds',
      fc.property(bookArb, ({ bids, asks, shopCityId }) => {
        const ctx: BookContext = { shopCityId, now: NOW };
        const fills = matchBook(bids, asks, ctx);
        const live = (b: BookBid) => b.matchable && b.remainingQty > 0;
        const open = (a: BookAsk) => a.matchable && a.remainingCapacity > 0;
        const bidLeft = (b: BookBid) => b.remainingQty - sum(fills.filter((f) => f.bidId === b.id).map((f) => f.qty));
        const askLeft = (a: BookAsk) => a.remainingCapacity - sum(fills.filter((f) => f.askId === a.id).map((f) => f.qty));
        const canTrade = (b: BookBid, a: BookAsk) => live(b) && open(a) && askFeeAt(a, NOW) <= b.maxFeeCents && compatible(b, a, ctx);
        const bidOrder = sortBids(bids.filter(live)).map((b) => b.id);
        const askOrder = sortAsks(asks.filter(open), NOW).map((a) => a.id);
        for (const f of fills) {
          const ask = asks.find((a) => a.id === f.askId)!;
          const bid = bids.find((b) => b.id === f.bidId)!;
          // No bid ahead of this one (higher max, or same max and earlier) that could take this ask was left short.
          for (const ahead of bids.filter((b) => bidOrder.indexOf(b.id) >= 0 && bidOrder.indexOf(b.id) < bidOrder.indexOf(f.bidId))) {
            if (canTrade(ahead, ask)) assert.equal(bidLeft(ahead), 0, `${ahead.id} is ahead of ${f.bidId} for ${f.askId} but was left short`);
          }
          // No cheaper (or same fee, earlier) ask this bid could take was left with capacity.
          for (const better of asks.filter((a) => askOrder.indexOf(a.id) >= 0 && askOrder.indexOf(a.id) < askOrder.indexOf(f.askId))) {
            if (canTrade(bid, better)) assert.equal(askLeft(better), 0, `${f.bidId} took ${f.askId} while ${better.id} had room`);
          }
        }
        // Nothing crossable is left: every bid with units left has no open, compatible ask at or under its max with room.
        for (const b of bids) {
          if (bidLeft(b) <= 0) continue;
          for (const a of asks) if (canTrade(b, a)) assert.equal(askLeft(a), 0, `${b.id} and ${a.id} could still trade`);
        }
      }),
      n,
    );
  });

  it(`P6 the result does not depend on the order the book lists its orders in (${n} runs)`, () => {
    holds(
      'P6 the result does not depend on the order',
      fc.property(
        bookArb.chain((book) => fc.record({ book: fc.constant(book), bids: fc.shuffledSubarray(book.bids, { minLength: book.bids.length }), asks: fc.shuffledSubarray(book.asks, { minLength: book.asks.length }) })),
        ({ book, bids, asks }) => {
          const ctx: BookContext = { shopCityId: book.shopCityId, now: NOW };
          const strip = (fs: Fill[]) => fs.map((f) => `${f.bidId}<${f.askId}:${f.qty}@${f.feeCents}`);
          assert.deepEqual(strip(matchBook(bids, asks, ctx)), strip(matchBook(book.bids, book.asks, ctx)));
        },
      ),
      n,
    );
  });
});

// ---------------------------------------------------------------------------
// P7 (shared part): an amended max fee never needs a bigger hold
// ---------------------------------------------------------------------------

describe('P7: the bidding agent ceiling (shared/src/money.ts)', () => {
  const n = runs(1000);
  it(`P7 the highest max fee a hold covers fits that hold, and one cent more does not (${n} runs)`, () => {
    holds(
      'P7 the highest max fee a hold covers',
      fc.property(bidArb, fc.integer({ min: 0, max: 2_000 }), (bid, permille) => {
        const hold = share(bidLimitCents(bid, bid.mode), permille);
        const fee = maxFeeWithinLimitCents(bid, hold, bid.mode);
        if (fee === null) {
          assert.ok(bidLimitCents({ ...bid, maxFeeCents: 0 }, bid.mode) > hold);
          return;
        }
        assert.ok(bidLimitCents({ ...bid, maxFeeCents: fee }, bid.mode) <= hold, 'the agent ceiling fits the hold');
        assert.ok(bidLimitCents({ ...bid, maxFeeCents: fee + 1 }, bid.mode) > hold, 'and is the highest that does');
      }),
      n,
    );
  });
});

// ---------------------------------------------------------------------------
// P8: gross-up
// ---------------------------------------------------------------------------

const pricingArb: fc.Arbitrary<PayPalPricing> = fc.record({
  captureBps: fc.integer({ min: 0, max: 9_999 }),
  captureFixedCents: fc.integer({ min: 0, max: 300 }),
  payoutItemCents: fc.integer({ min: 0, max: 300 }),
});

describe('P8: gross-up to the cent (shared/src/money.ts)', () => {
  const n = runs(5000);
  it(`P8 each capture nets exactly its base plus its payout fees after PayPal's fee, and one cent less would not (${n} runs)`, () => {
    holds(
      'P8 each capture nets exactly its base',
      fc.property(fc.integer({ min: 0, max: 50_000_000 }), fc.integer({ min: 0, max: 6 }), (base, items) => {
        const g = grossUpCapture(base, items);
        const need = base + items * PAYPAL_PRICING.payoutItemCents;
        const net = (c: number) => c - paypalCaptureFeeCents(c);
        if (need === 0) {
          assert.equal(g.amountCents, 0);
          return;
        }
        assert.equal(net(g.amountCents), need, `net of ${g.amountCents}`);
        assert.ok(net(g.amountCents - 1) < need, `${g.amountCents - 1} would not cover ${need}`);
        assert.equal(g.processingCents, g.captureFeeCents + g.payoutFeesCents);
        assert.equal(g.amountCents, base + g.processingCents);
        // The shared fee schedule is PayPal's recorded rate, checked against the oracle written out above.
        assert.equal(g.captureFeeCents, paypalFeeOracle(g.amountCents));
      }),
      n,
    );
  });

  it(`P8 the gross-up is exact for any percentage below 100% and any fixed fees, not only PayPal's current ones (${n} runs)`, () => {
    holds(
      'P8 the gross-up is exact for any pricing',
      fc.property(fc.integer({ min: 0, max: 5_000_000 }), fc.integer({ min: 0, max: 6 }), pricingArb, (base, items, pricing) => {
        const g = grossUpCapture(base, items, pricing);
        const need = base + items * pricing.payoutItemCents;
        const net = (c: number) => c - paypalCaptureFeeCents(c, pricing);
        if (need === 0) {
          assert.equal(g.amountCents, 0);
          return;
        }
        assert.equal(net(g.amountCents), need);
        assert.ok(net(g.amountCents - 1) < need);
      }),
      n,
    );
  });
});
