import { describe, expect, it } from 'vitest';
import { JAPANTOWN, findShop } from '@holdmyspot/shared';
import type { AskTask, Claim, Job, Payout, Proof } from '@holdmyspot/shared';
import {
  activeClaimId,
  buildErrand,
  clockText,
  countText,
  currentJob,
  durationText,
  errandFinePrint,
  errandStage,
  etaChoices,
  failureText,
  fenceOf,
  isStale,
  jobStage,
  keptFeeCents,
  lineCheckView,
  liveFee,
  offerProblem,
  payoutSummary,
  perHourText,
  purchaseCheckView,
  realizedPerHour,
  stepIndex,
  timeSpentMs,
  type Errand,
} from './logic';

const sf = (hhmm: string) => Date.parse(`2026-11-12T${hhmm}:00-08:00`);
const shop = findShop('paper-moon-toys')!;

function claim(over: Partial<Claim> = {}): Claim {
  return {
    id: 'clm_0001',
    askId: 'ask_0001',
    queuerId: 'wei',
    queuerName: 'Wei',
    shopId: shop.id,
    windowStartsAt: sf('10:31'),
    windowEndsAt: sf('10:44'),
    status: 'awaiting_arrival',
    checkInCode: 'M4RT7',
    arrival: null,
    linePhotoProofId: null,
    checkedInAt: null,
    createdAt: sf('10:31'),
    updatedAt: sf('10:31'),
    ...over,
  };
}

function ask(over: Partial<AskTask> = {}): AskTask {
  return {
    id: 'ask_0001',
    queuerId: 'wei',
    queuerName: 'Wei',
    shopId: shop.id,
    itemId: 'plush-paper-moon',
    claimId: 'clm_0001',
    origin: 'post',
    targetBidId: null,
    capacity: 1,
    remainingCapacity: 0,
    modes: ['local', 'ship'],
    feeCents: 1200,
    clock: null,
    etaAt: sf('10:34'),
    status: 'filled',
    createdAt: sf('10:31'),
    pricedAt: sf('10:31'),
    updatedAt: sf('10:31'),
    ...over,
  };
}

function job(over: Partial<Job> = {}): Job {
  return {
    id: 'job_0001',
    matchId: 'mch_0001',
    bidId: 'bid_0013',
    askId: 'ask_0001',
    claimId: 'clm_0001',
    requesterId: 'mia',
    requesterName: 'Mia R.',
    queuerId: 'wei',
    queuerName: 'Wei',
    shopId: shop.id,
    itemId: 'plush-paper-moon',
    qty: 1,
    feeCents: 1200,
    mode: 'ship',
    status: 'claimed',
    failure: null,
    proofCode: 'K7MX4',
    handoverCode: null,
    fx: null,
    caps: { retailCents: 3600, feeCents: 1200, shippingCents: 1200 },
    amounts: { retailCents: null, shippingCents: null, capturedCents: 0, refundedCents: 0, paidOutCents: 0 },
    shipment: null,
    history: [{ status: 'claimed', at: sf('10:31') }],
    disputed: false,
    createdAt: sf('10:31'),
    updatedAt: sf('10:31'),
    ...over,
  };
}

function proof(over: Partial<Proof> = {}): Proof {
  return {
    id: 'prf_0002',
    kind: 'purchase',
    claimId: 'clm_0001',
    jobId: 'job_0001',
    fileIds: ['file_0002', 'file_0003'],
    status: 'verifying',
    checks: [],
    receipt: null,
    amounts: null,
    peopleAhead: null,
    summary: 'Checking the receipt and the item photo.',
    ai: { provider: 'muse', model: 'muse-spark-1.3', mode: 'replay', latencyMs: 2 },
    decidedBy: null,
    createdAt: sf('11:42'),
    decidedAt: null,
    ...over,
  };
}

function payout(over: Partial<Payout> = {}): Payout {
  return {
    id: 'po_0001',
    recipient: 'Wei',
    recipientUserId: 'wei',
    receiverEmail: null,
    amount: { currency: 'USD', cents: 1080 },
    note: 'Queue fee',
    reference: 'job_0001',
    purpose: 'fee',
    platformFeeCents: 120,
    status: 'succeeded',
    paypalBatchId: 'B1',
    paypalItemId: 'I1',
    createdAt: sf('11:42'),
    updatedAt: sf('11:42'),
    ...over,
  };
}

const errand = (over: Partial<Errand> = {}): Errand => ({ claim: claim(), ask: ask(), jobs: [job()], lineProof: null, purchaseProofs: {}, payouts: {}, ...over });

describe('errand steps', () => {
  it('walks the hero job from the arrival window to the payout', () => {
    expect(errandStage(errand())).toBe('arrival');
    const checking = errand({ claim: claim({ status: 'arrived' }), lineProof: proof({ kind: 'check_in', jobId: null, status: 'verifying' }) });
    expect(errandStage(checking)).toBe('checking');
    const inLine = errand({ claim: claim({ status: 'checked_in', checkedInAt: sf('10:33') }), jobs: [job({ status: 'queueing' })] });
    expect(errandStage(inLine)).toBe('in_line');
    expect(errandStage({ ...inLine, jobs: [job({ status: 'bought' })] })).toBe('proof');
    expect(errandStage({ ...inLine, jobs: [job({ status: 'proof_submitted' })], purchaseProofs: { job_0001: proof() } })).toBe('verifying');
    expect(errandStage({ ...inLine, claim: claim({ status: 'done' }), jobs: [job({ status: 'verified' })] })).toBe('finish');
    expect(errandStage({ ...inLine, claim: claim({ status: 'done' }), jobs: [job({ status: 'shipped' })] })).toBe('paid');
    expect(stepIndex('arrival')).toBe(0);
    expect(stepIndex('in_line')).toBe(2);
    expect(stepIndex('paid')).toBe(5);
  });

  it('shows a failed line photo as the arrival step again, so the queuer can retake it', () => {
    const failed = errand({ claim: claim({ status: 'arrived' }), lineProof: proof({ kind: 'check_in', status: 'failed' }) });
    expect(errandStage(failed)).toBe('arrival');
  });

  it('keeps a checked-in offer without a match in line, waiting for its fee to meet a request', () => {
    expect(errandStage(errand({ claim: claim({ status: 'checked_in' }), jobs: [] }))).toBe('waiting');
    expect(errandStage(errand({ claim: claim({ status: 'done' }), jobs: [] }))).toBe('ended');
  });

  it('ends a rejected receipt, a sell-out and a lapse with their own step', () => {
    const done = claim({ status: 'done' });
    expect(errandStage(errand({ claim: done, jobs: [job({ status: 'failed', failure: { reason: 'proof_rejected', at: 0, detail: '' } })] }))).toBe('rejected');
    expect(errandStage(errand({ claim: done, jobs: [job({ status: 'failed', failure: { reason: 'sold_out', at: 0, detail: '' } })] }))).toBe('sold_out');
    expect(errandStage(errand({ claim: claim({ status: 'lapsed' }) }))).toBe('lapsed');
    expect(jobStage(job({ status: 'proof_submitted' }), proof({ status: 'needs_review' }))).toBe('review');
  });

  it('puts a visit together from the records: latest checks, payouts per job, the live visit first', () => {
    const records = {
      claims: { clm_0001: claim({ status: 'done' }), clm_0002: claim({ id: 'clm_0002', askId: 'ask_0002', createdAt: sf('11:44'), status: 'checked_in' }) },
      asks: { ask_0001: ask() },
      jobs: { job_0001: job({ status: 'shipped' }) },
      proofs: {
        prf_0001: proof({ id: 'prf_0001', kind: 'check_in', jobId: null, status: 'passed', createdAt: sf('10:32') }),
        prf_0002: proof({ id: 'prf_0002', status: 'failed', createdAt: sf('11:40') }),
        prf_0003: proof({ id: 'prf_0003', status: 'passed', createdAt: sf('11:42') }),
      },
      payouts: { po_0001: payout(), po_0002: payout({ id: 'po_0002', purpose: 'reimbursement', createdAt: sf('11:45') }), po_0009: payout({ id: 'po_0009', reference: 'job_0009' }) },
    };
    const e = buildErrand(records, 'clm_0001')!;
    expect(e.ask?.id).toBe('ask_0001');
    expect(e.lineProof?.id).toBe('prf_0001');
    expect(e.purchaseProofs.job_0001?.id).toBe('prf_0003');
    expect(e.payouts.job_0001?.map((p) => p.id)).toEqual(['po_0001', 'po_0002']);
    expect(errandStage(e)).toBe('paid');
    expect(buildErrand(records, 'clm_0404')).toBeNull();
    expect(activeClaimId(records)).toBe('clm_0002');
    // A visit is done once everything is bought, but a verified job still waits for its tracking.
    const shipping = { ...records, claims: { clm_0001: claim({ status: 'done' }) }, jobs: { job_0001: job({ status: 'verified' }) } };
    expect(activeClaimId(shipping)).toBe('clm_0001');
    expect(activeClaimId({ ...records, claims: { clm_0001: claim({ status: 'done' }) } })).toBeNull();
  });

  it('never lets a late HTTP answer roll back what the stream already brought', () => {
    const passed = proof({ kind: 'check_in', status: 'passed', createdAt: sf('10:32'), decidedAt: sf('10:32') });
    const verifying = proof({ kind: 'check_in', status: 'verifying', createdAt: sf('10:32') });
    expect(isStale('proof', passed, verifying)).toBe(true);
    expect(isStale('proof', verifying, passed)).toBe(false);
    expect(isStale('claim', claim({ status: 'checked_in', updatedAt: sf('10:32') }), claim({ status: 'arrived', updatedAt: sf('10:32') }))).toBe(true);
    expect(isStale('job', job({ status: 'queueing', updatedAt: sf('10:32') }), job({ status: 'checked_in', updatedAt: sf('10:31') }))).toBe(true);
    // An offer can go back to open after a failed job: the later copy wins.
    expect(isStale('ask', ask({ status: 'filled', updatedAt: sf('10:40') }), ask({ status: 'open', updatedAt: sf('10:50') }))).toBe(false);
    expect(isStale('payout', undefined, payout())).toBe(false);
  });

  it('works on the job furthest behind when one visit has several', () => {
    const jobs = [job({ id: 'job_0002', status: 'verified' }), job({ id: 'job_0003', status: 'queueing' })];
    expect(currentJob({ jobs, purchaseProofs: {} })?.id).toBe('job_0003');
  });
});

describe('place, time and fee', () => {
  it('measures the geofence from where the queuer stands', () => {
    expect(fenceOf(shop.lngLat, shop)).toEqual({ distanceM: 0, inside: true });
    const start = fenceOf(JAPANTOWN, shop);
    expect(start.inside).toBe(true);
    expect(fenceOf([shop.lngLat[0] + 0.003, shop.lngLat[1]], shop).inside).toBe(false);
  });

  it('formats countdowns and durations', () => {
    expect(clockText(9 * 60_000 + 5_000)).toBe('9:05');
    expect(clockText(3_723_000)).toBe('1:02:03');
    expect(clockText(-5000)).toBe('0:00');
    expect(countText(11 * 60_000 + 57_000)).toBe('11m 57s');
    expect(countText(68 * 60_000)).toBe('1h 08m');
    expect(durationText(70 * 60_000)).toBe('1 h 10 min');
    expect(durationText(12 * 60_000)).toBe('12 min');
  });

  it('runs the fee clock only after check-in, down to its floor', () => {
    const clocked = ask({ feeCents: 1500, clock: { stepCents: 100, intervalMs: 5 * 60_000, floorCents: 800, startsAt: null } });
    expect(liveFee(clocked, sf('11:00'))).toMatchObject({ feeCents: 1500, running: false, waiting: true });
    const running = ask({ feeCents: 1500, clock: { stepCents: 100, intervalMs: 5 * 60_000, floorCents: 800, startsAt: sf('10:50') } });
    expect(liveFee(running, sf('11:05'))).toMatchObject({ feeCents: 1200, running: true, nextAt: sf('11:10'), nextCents: 1100 });
    expect(liveFee(running, sf('13:00'))).toMatchObject({ feeCents: 800, nextAt: null });
    expect(liveFee(ask(), sf('11:00'))).toMatchObject({ feeCents: 1200, running: false, waiting: false });
  });

  it('offers ETAs from the honest trip up to the server latest, and checks the offer like the server', () => {
    const now = sf('10:31');
    const eta = etaChoices(now, JAPANTOWN, shop.lngLat, 1);
    expect(eta[0]).toBe(now + 2 * 60_000);
    expect(eta.every((t) => t <= now + 30 * 60_000)).toBe(true);
    const item = { minFeeCents: 500, perPersonLimit: 1 };
    expect(offerProblem({ feeCents: 1500, clock: { stepCents: 100, intervalMs: 300_000, floorCents: 800 }, etaAt: eta[0]!, capacity: 1 }, item)).toBeNull();
    expect(offerProblem({ feeCents: 400, clock: null, etaAt: eta[0]!, capacity: 1 }, item)).toMatch(/at least \$5\.00/);
    expect(offerProblem({ feeCents: 1500, clock: { stepCents: 100, intervalMs: 300_000, floorCents: 400 }, etaAt: eta[0]!, capacity: 1 }, item)).toMatch(/floor/);
    expect(offerProblem({ feeCents: 1500, clock: null, etaAt: eta[0]!, capacity: 2 }, item)).toMatch(/1 to 1/);
  });
});

describe('money for the queuer', () => {
  it('keeps the fee minus 10%, pays retail and shipping back at cost, and works out $/hour from take to buy', () => {
    const j = job({
      status: 'shipped',
      history: [
        { status: 'claimed', at: sf('10:31') },
        { status: 'queueing', at: sf('10:33') },
        { status: 'bought', at: sf('11:41') },
      ],
    });
    expect(keptFeeCents(j)).toBe(1080);
    const spent = timeSpentMs(claim({ createdAt: sf('10:31') }), j);
    expect(spent).toBe(70 * 60_000);
    expect(realizedPerHour(1080, spent)).toBe(926);
    expect(perHourText(926)).toBe('$9.26/h');
    const sum = payoutSummary([payout({ id: 'po_0002', purpose: 'reimbursement', amount: { currency: 'USD', cents: 4275 }, createdAt: sf('11:45') }), payout()]);
    expect(sum.paidCents).toBe(5355);
    expect(sum.lines.map((l) => l.cents)).toEqual([1080, 4275]);
    expect(payoutSummary([payout({ status: 'pending' })])).toMatchObject({ paidCents: 0, pendingCents: 1080 });
  });

  it('says $0 moved for a rejected receipt and a released hold for a sell-out', () => {
    expect(failureText(job({ failure: { reason: 'proof_rejected', at: 0, detail: '' }, requesterName: 'Priya K.' }))).toMatch(/\$0 moved.*Priya K\./);
    expect(failureText(job({ failure: { reason: 'sold_out', at: 0, detail: '' } }))).toMatch(/Every open request for it closed.*released those holds/);
  });
});

describe('the AI check as rows', () => {
  it('reads a passed receipt: store, time, items, totals, code and the capture', () => {
    const p = proof({
      status: 'passed',
      summary: 'Receipt matches Paper Moon Toys at 11:41.',
      checks: [
        { code: 'code_visible', ok: true, weight: 'hard', detail: 'The job code is visible next to the item.' },
        { code: 'shop_match', ok: true, weight: 'hard', detail: 'Store ID 41500017 matches Paper Moon Toys.' },
        { code: 'time_window', ok: true, weight: 'hard', detail: 'Printed at 11:41, after check-in and within shop hours.' },
        { code: 'totals_add_up', ok: true, weight: 'hard', detail: 'The lines add up to the total.' },
        { code: 'within_retail_cap', ok: true, weight: 'soft', detail: 'Retail is within the cap.' },
      ],
      receipt: {
        printedName: 'PAPER MOON TOYS',
        sellerTaxId: '41500017',
        invoiceNumber: 'PM11120412',
        issuedAt: new Date(sf('11:41')).toISOString(),
        currency: 'USD',
        lines: [{ name: 'MOCHI BUNNY PLUSH SAKURA', qty: 1, unit: { currency: 'USD', minor: 3400 }, total: { currency: 'USD', minor: 3400 } }],
        total: { currency: 'USD', minor: 3400 },
        qr: { invoiceNumber: 'PM11120412', issuedDate: '2026-11-12', sellerTaxId: '41500017', total: 3400 },
        codeSeen: 'K7MX4',
      },
      amounts: { receiptTotal: { currency: 'USD', minor: 3400 }, fxTwdPerUsd: null, retailCents: 3400, captureCents: 4869, processingCents: 269 },
    });
    const v = purchaseCheckView(p, job(), shop, sf('10:33'));
    expect(v.title).toBe('Passed');
    expect(v.stamp).toBe('Checked by AI and rules · muse muse-spark-1.3 (replay of a saved answer)');
    const by = Object.fromEntries(v.rows.map((r) => [r.label, r]));
    expect(by.Store?.value).toBe('PAPER MOON TOYS · store ID 41500017');
    expect(by.Time?.value).toBe('printed 11:41 AM, check-in 10:33 AM');
    expect(by.Items?.value).toBe('1 × MOCHI BUNNY PLUSH SAKURA $34.00');
    expect(by.Money?.value).toBe('shop price $34.00 (cap $36.00) + fee $12.00 + processing $2.69 at cost = $48.69');
    expect(v.flags).toEqual([]);
  });

  it('lists the reasons a fake receipt failed and moves nothing', () => {
    const p = proof({
      status: 'failed',
      checks: [
        { code: 'code_visible', ok: true, weight: 'hard', detail: 'The job code is visible next to the item.' },
        { code: 'shop_match', ok: false, weight: 'hard', detail: "Store ID 41500093 is not Paper Moon Toys's." },
        { code: 'time_window', ok: false, weight: 'hard', detail: 'Printed at 10:41, before the queuer checked in.' },
        { code: 'item_match', ok: true, weight: 'soft', detail: 'Every line is the requested item.' },
        { code: 'totals_add_up', ok: false, weight: 'hard', detail: 'The lines add up to 3400, but the total says 3600.' },
        { code: 'duplicate_photo', ok: false, weight: 'hard', detail: 'The item photo matches an older upload.' },
      ],
    });
    const v = purchaseCheckView(p, job(), shop, sf('11:47'));
    expect(v.title).toBe('Failed');
    expect(v.flags.map((f) => f.label)).toEqual(['shop', 'printed time', 'totals', 'recycled photo']);
    expect(v.rows.find((r) => r.label === 'Money')).toMatchObject({ value: '$0 moved: nothing captured', ok: null });
    expect(v.rows.find((r) => r.label === 'Store')?.ok).toBe(false);
  });

  it('reads the line photo: code, distance, people ahead, new photo', () => {
    const p = proof({
      kind: 'check_in',
      jobId: null,
      status: 'passed',
      peopleAhead: 40,
      checks: [
        { code: 'geofence', ok: true, weight: 'hard', detail: 'Checked in 12 m from the shop (limit 80 m).' },
        { code: 'code_visible', ok: true, weight: 'hard', detail: 'The one-time code is visible in the photo.' },
        { code: 'line_visible', ok: true, weight: 'soft', detail: 'A line of people is visible.' },
        { code: 'duplicate_photo', ok: true, weight: 'hard', detail: 'The photo is new.' },
      ],
    });
    const v = lineCheckView(p, claim({ arrival: { at: sf('10:32'), lngLat: shop.lngLat, accuracyM: 8, distanceM: 12 } }));
    expect(v.rows.map((r) => r.value)).toEqual(['M4RT7', '12 m from the shop', 'about 40 people ahead', 'new']);
    expect(v.rows.every((r) => r.ok)).toBe(true);
  });
});

describe('the errand sheet fine print', () => {
  it('names the PayPal the server runs: the sandbox on a sandbox server, never "Simulated PayPal" there', () => {
    expect(errandFinePrint('PayPal sandbox: no real money')).toBe('PayPal sandbox: no real money, US dollars throughout. Your codes are shown only on this phone.');
    expect(errandFinePrint('Simulated PayPal')).toBe('Simulated PayPal, US dollars throughout. Your codes are shown only on this phone.');
  });
});
