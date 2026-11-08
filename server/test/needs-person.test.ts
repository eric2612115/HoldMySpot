import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { noteUsesOnlyFacts } from '@holdmyspot/shared';
import type { AiJsonRequest, AiJsonResult, AiProvider, DisputeResult } from '@holdmyspot/shared/ports';
import type { Dispute, Job } from '@holdmyspot/shared';
import { syncPayPal } from '../src/app/sync.ts';
import { disputeNote } from '../src/ai/notes.ts';
import { testServer, type TestServer } from './helpers.ts';

/**
 * The "Needs a person" page's server side (D-160, D-161): the scripted moment,
 * disputes from PayPal, evidence, accept and adjudicate, refund limits and the
 * AI's dispute note, which words facts and decides nothing.
 */

const END = Date.parse('2026-11-12T11:45:00-08:00');
type J = Record<string, unknown>;

function jobOf(s: TestServer, queuer: string, requester: string): Job {
  return s.app.store.jobs.where('queuer_id = ? AND requester_id = ?', queuer, requester).at(-1)!;
}
const openDisputes = (s: TestServer) => s.app.store.disputes.where("status != 'resolved'");
const ok = (r: { status: number }, what: string) => assert.equal(r.status, 200, what);
const receiptCase = (s: TestServer) => s.app.store.proofs.where("status = 'needs_review'");

async function scripted(): Promise<TestServer> {
  const s = await testServer({ demo: true, ai: 'real' });
  await s.director!.start('needs-person', null);
  s.app.clock.pause();
  await s.at(END);
  assert.equal(s.director!.state().status, 'finished');
  return s;
}

describe('the needs-person demo script', () => {
  let s: TestServer;
  before(async () => {
    s = await scripted();
  });
  after(() => s.done());

  it('leaves exactly one receipt to review, one refund request and one open dispute', () => {
    const proofs = receiptCase(s);
    assert.equal(proofs.length, 1);
    assert.equal(proofs[0]!.kind, 'purchase');
    assert.equal(proofs[0]!.jobId, jobOf(s, 'wei', 'mia').id);
    const refund = jobOf(s, 'dana', 'jun');
    assert.equal(refund.refundRequest?.closedAt, null);
    assert.ok(refund.amounts.capturedCents > 0);
    const open = openDisputes(s);
    assert.equal(open.length, 1);
    assert.equal(open[0]!.jobId, jobOf(s, 'mo', 'priya').id);
    assert.equal(open[0]!.status, 'waiting_for_seller');
  });

  it('flags the disputed job and emits dispute.updated with a stamped template draft', () => {
    const d = openDisputes(s)[0]!;
    assert.equal(jobOf(s, 'mo', 'priya').disputed, true);
    assert.ok(s.app.bus.after(0).some((e) => e.type === 'dispute.updated'));
    assert.ok(d.draft);
    assert.equal(d.draft.template, true);
    assert.equal(d.draft.templateReason, 'no_model');
    assert.match(`${d.draft.ai.provider}/${d.draft.ai.model}/${d.draft.ai.mode}`, /^fake\/rules-v1\/fake$/);
    assert.match(d.draft.text, /PayPal case/);
  });

  it('GET /api/ops/records and /api/ops/disputes carry the dispute', async () => {
    const records = await s.call('GET', '/api/ops/records');
    assert.equal((records.json as { disputes: Dispute[] }).disputes.length, 1);
    const list = await s.call('GET', '/api/ops/disputes');
    assert.equal((list.json as { disputes: Dispute[] }).disputes.length, 1);
  });
});

describe('a person decides a receipt, a refund and a dispute', () => {
  let s: TestServer;
  before(async () => {
    s = await scripted();
  });
  after(() => s.done());

  it('review: Pass captures through the existing route and the case closes', async () => {
    const proof = receiptCase(s)[0]!;
    const r = await s.call('POST', `/api/ops/proofs/${proof.id}/review`, { body: { decision: 'pass', note: 'Checked with the shop.' }, idem: 'rev-1' });
    ok(r, 'review');
    await s.app.idle();
    assert.equal(receiptCase(s).length, 0);
    assert.ok(jobOf(s, 'wei', 'mia').amounts.capturedCents > 0);
  });

  it('refund: refuses more than what is refundable, and a repeat with the same key moves money once', async () => {
    const job = jobOf(s, 'dana', 'jun');
    const refundable = job.amounts.capturedCents - job.amounts.refundedCents;
    const over = await s.call('POST', `/api/ops/jobs/${job.id}/refund`, { body: { amountCents: refundable + 1, reason: 'too much' }, idem: 'ref-over' });
    assert.equal(over.status, 400);
    assert.equal((over.json as { error: { code: string } }).error.code, 'INVALID_AMOUNT');
    assert.equal(s.app.store.jobs.must(job.id).amounts.refundedCents, 0);

    const body = { amountCents: 1000, reason: 'Crushed box' };
    const first = await s.call('POST', `/api/ops/jobs/${job.id}/refund`, { body, idem: 'ref-1' });
    ok(first, 'refund');
    const second = await s.call('POST', `/api/ops/jobs/${job.id}/refund`, { body, idem: 'ref-1' });
    ok(second, 'replay');
    const after = s.app.store.jobs.must(job.id);
    assert.equal(after.amounts.refundedCents, 1000);
    assert.equal(s.app.store.ledger.where("job_id = ? AND kind = 'refunded'", job.id).length, 1);
    assert.ok(after.refundRequest?.closedAt, 'the refund closes the request');

    const rest = refundable - 1000;
    const tooMuch = await s.call('POST', `/api/ops/jobs/${job.id}/refund`, { body: { amountCents: rest + 1, reason: 'again' }, idem: 'ref-2' });
    assert.equal(tooMuch.status, 400);
    assert.equal(s.app.store.jobs.must(job.id).amounts.refundedCents, 1000);
  });

  it('a job with an open dispute cannot be refunded (the same money could go back twice)', async () => {
    const job = jobOf(s, 'mo', 'priya');
    const r = await s.call('POST', `/api/ops/jobs/${job.id}/refund`, { body: { amountCents: 100, reason: 'duplicate' }, idem: 'ref-disputed' });
    assert.equal(r.status, 409);
    assert.equal(s.app.store.jobs.must(job.id).amounts.refundedCents, 0);
  });

  it('evidence: sends the note with the photos code attaches, once', async () => {
    const d = openDisputes(s)[0]!;
    const first = await s.call('POST', `/api/ops/disputes/${d.id}/evidence`, { body: { note: 'The cake was handed over in person.', includeTracking: true }, idem: 'ev-1' });
    ok(first, 'evidence');
    const sent = (first.json as { dispute: Dispute }).dispute;
    assert.equal(sent.evidenceSubmitted, true);
    assert.equal(sent.status, 'under_review');
    // The same key replays the answer; a new key is refused, so PayPal hears it once.
    const replay = await s.call('POST', `/api/ops/disputes/${d.id}/evidence`, { body: { note: 'The cake was handed over in person.', includeTracking: true }, idem: 'ev-1' });
    ok(replay, 'replay');
    const again = await s.call('POST', `/api/ops/disputes/${d.id}/evidence`, { body: { note: 'Again', includeTracking: true }, idem: 'ev-2' });
    assert.equal(again.status, 409);
  });

  it('adjudicate: settles once, and a buyer-favour outcome books the refund once', async () => {
    const d = openDisputes(s)[0]!;
    const job = jobOf(s, 'mo', 'priya');
    const first = await s.call('POST', `/api/ops/disputes/${d.id}/adjudicate`, { body: { outcome: 'buyer_favor' }, idem: 'adj-1' });
    ok(first, 'adjudicate');
    const again = await s.call('POST', `/api/ops/disputes/${d.id}/adjudicate`, { body: { outcome: 'seller_favor' }, idem: 'adj-2' });
    assert.equal(again.status, 409);
    await s.at(s.app.now() + 4 * 60_000);
    await syncPayPal(s.app);
    await s.app.idle();
    const after = s.app.store.disputes.must(d.id);
    assert.equal(after.status, 'resolved');
    assert.equal(after.outcome, 'buyer_favor');
    await syncPayPal(s.app);
    const j = s.app.store.jobs.must(job.id);
    assert.equal(j.amounts.refundedCents, d.amount.cents);
    assert.equal(s.app.store.ledger.where("job_id = ? AND kind = 'refunded'", job.id).length, 1);
    const left = j.amounts.capturedCents - j.amounts.refundedCents;
    assert.equal(left, 0);
    const overRefund = await s.call('POST', `/api/ops/jobs/${job.id}/refund`, { body: { amountCents: 1, reason: 'more' }, idem: 'ref-after' });
    assert.equal(overRefund.status, 400);
  });
});

describe('dispute accept and refund requests', () => {
  it('accept: PayPal returns the money, booked once; a second accept is refused', async () => {
    const s = await scripted();
    try {
      const d = openDisputes(s)[0]!;
      const r = await s.call('POST', `/api/ops/disputes/${d.id}/accept`, { body: { note: 'We accept.' }, idem: 'acc-1' });
      ok(r, 'accept');
      const again = await s.call('POST', `/api/ops/disputes/${d.id}/accept`, { body: { note: 'Twice' }, idem: 'acc-2' });
      assert.equal(again.status, 409);
      await syncPayPal(s.app);
      const job = s.app.store.jobs.must(d.jobId!);
      assert.equal(job.amounts.refundedCents, d.amount.cents);
      assert.equal(s.app.store.ledger.where("job_id = ? AND kind = 'refunded'", job.id).length, 1);
    } finally {
      await s.done();
    }
  });

  it('only the requester can ask for a refund; the operator can close it without moving money', async () => {
    const s = await scripted();
    try {
      const job = jobOf(s, 'dana', 'jun');
      const other = await s.call('POST', `/api/jobs/${job.id}/refund-request`, { as: 'priya', body: { reason: 'Not mine' }, idem: 'rq-other' });
      assert.equal(other.status, 403);
      const twice = await s.call('POST', `/api/jobs/${job.id}/refund-request`, { as: 'jun', body: { reason: 'Again' }, idem: 'rq-twice' });
      assert.equal(twice.status, 409);
      const closed = await s.call('POST', `/api/ops/jobs/${job.id}/refund-request/close`, { body: { note: 'The shop replaced it.' }, idem: 'rq-close' });
      ok(closed, 'close');
      const after = s.app.store.jobs.must(job.id);
      assert.ok(after.refundRequest?.closedAt);
      assert.equal(after.amounts.refundedCents, 0);
    } finally {
      await s.done();
    }
  });

  it('a resolved dispute cannot be answered, and an unknown one is 404', async () => {
    const s = await scripted();
    try {
      const d = openDisputes(s)[0]!;
      await s.call('POST', `/api/ops/disputes/${d.id}/accept`, { body: { note: 'Accept' }, idem: 'acc-res' });
      await syncPayPal(s.app);
      const late = await s.call('POST', `/api/ops/disputes/${d.id}/evidence`, { body: { note: 'Too late', includeTracking: true }, idem: 'ev-late' });
      assert.equal(late.status, 409);
      const none = await s.call('POST', '/api/ops/disputes/NOPE/accept', { body: { note: 'x' }, idem: 'acc-none' });
      assert.equal(none.status, 404);
    } finally {
      await s.done();
    }
  });

  it('a dispute with no job is still recorded, and a draft is written from what code knows', async () => {
    const s = await scripted();
    try {
      const fake = s.app.fakePayPal as unknown as { listDisputes: (since: number) => Promise<DisputeResult[]> };
      const real = fake.listDisputes.bind(s.app.fakePayPal);
      fake.listDisputes = async (since) => [
        ...(await real(since)),
        { disputeId: 'PP-OLD', captureIds: ['UNKNOWN'], invoiceIds: ['HMS-GATE-1'], reason: 'OTHER', status: 'OPEN', outcome: null, amountCents: 500, createdAt: s.app.now(), updatedAt: s.app.now() },
      ];
      await syncPayPal(s.app);
      const d = s.app.store.disputes.must('PP-OLD');
      assert.equal(d.jobId, null);
      assert.ok(d.draft);
      assert.match(d.draft.text, /\$5\.00/);
    } finally {
      await s.done();
    }
  });
});

describe('the AI dispute note (D-161)', () => {
  const facts = {
    disputeId: 'PP-1',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    amountCents: 4947,
    itemName: 'Strawberry shortcake',
    qty: 1,
    shopName: 'Petal & Crumb Bakery',
    receiptTotal: '$38.00',
    receiptNumber: 'R-77',
    receiptDate: '2026-11-12',
    tracking: null,
    handedOver: true,
    capturedCents: 4947,
    refundedCents: 0,
    attachments: ['receipt.png', 'item-photo.png'],
  };
  const provider = (answer: () => Promise<unknown>, mode: 'live' | 'fake' = 'live'): AiProvider =>
    ({
      id: 'muse',
      model: 'test-model',
      mode,
      vision: true,
      json: async <T>(_req: AiJsonRequest): Promise<AiJsonResult<T>> => ({ data: (await answer()) as T, stamp: { provider: 'muse', model: 'test-model', mode: 'live', latencyMs: 5 }, usage: null }),
      agent: async () => {
        throw new Error('not used');
      },
    }) as unknown as AiProvider;

  it('with no model, the template writes it and says so', async () => {
    const out = await disputeNote({ facts }, null);
    assert.equal(out.template, true);
    assert.equal(out.templateReason, 'no_model');
    assert.match(out.text, /\$49\.47/);
    assert.equal(out.ai.mode, 'fake');
  });

  it('a model note is stamped with provider, model and mode', async () => {
    const out = await disputeNote({ facts }, provider(async () => ({ sentences: ['The buyer reports non-delivery of $49.47.', 'The 1 cake was handed over in person.'] })));
    assert.equal(out.template, false);
    assert.equal(out.templateReason, null);
    assert.deepEqual([out.ai.provider, out.ai.model, out.ai.mode], ['muse', 'test-model', 'live']);
  });

  it('a provider error falls back to the template and says so', async () => {
    const out = await disputeNote({ facts }, provider(async () => { throw new Error('boom'); }));
    assert.equal(out.template, true);
    assert.equal(out.templateReason, 'provider_error');
  });

  it('a note with a number the facts do not hold is rejected', async () => {
    const out = await disputeNote({ facts }, provider(async () => ({ sentences: ['We will refund $99.99 today.'] })));
    assert.equal(out.template, true);
    assert.equal(out.templateReason, 'rejected');
    assert.equal(noteUsesOnlyFacts('A refund of $99.99', facts), false);
    assert.equal(noteUsesOnlyFacts('Captured $49.47, receipt R-77, 2026-11-12.', facts), true);
  });
});

export type { J };
