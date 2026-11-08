import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Dispute, Job, OpsRecords, Proof } from '@holdmyspot/shared';
import { sf } from '../data/time.ts';
import { emptyReplayState, peopleCasesAt } from '../data/mock/peopleDay.ts';
import { casesFromRecords, manualRefundCase, refundablePicks } from './cases.ts';

const job = (over: Partial<Job>): Job =>
  ({
    id: 'job-1',
    itemId: 'cake-petal-crumb',
    shopId: 'petal-crumb-bakery',
    qty: 1,
    mode: 'local',
    status: 'delivered',
    queuerId: 'dana',
    requesterId: 'jun',
    queuerName: 'Dana',
    requesterName: 'Jun L.',
    amounts: { retailCents: 3800, shippingCents: null, capturedCents: 4947, refundedCents: 0, paidOutCents: 0, processingCents: 247, paypalFeesCents: 0 },
    shipment: null,
    ...over,
  }) as unknown as Job;

const records = (o: Partial<OpsRecords>): OpsRecords => ({ jobs: [], proofs: [], disputes: [], ...o }) as unknown as OpsRecords;

const proof = (status: Proof['status']): Proof =>
  ({
    id: 'prf-1',
    kind: 'purchase',
    jobId: 'job-1',
    fileIds: ['f-r', 'f-i'],
    status,
    checks: [{ code: 'listed_price', ok: false, weight: 'soft', detail: 'The price is above the listed price.' }],
    receipt: null,
    amounts: { captureCents: 4800 },
    summary: 'Needs a person.',
    ai: { provider: 'fake', model: 'rules-v1', mode: 'fake', latencyMs: 0 },
  }) as unknown as Proof;

const dispute = (status: Dispute['status']): Dispute =>
  ({
    id: 'PP-1',
    jobId: 'job-1',
    captureId: 'C-1',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    status,
    outcome: null,
    amount: { currency: 'USD', cents: 4947 },
    evidenceSubmitted: false,
    draft: { text: 'Note', ai: { provider: 'fake', model: 'rules-v1', mode: 'fake', latencyMs: 0 }, template: true, templateReason: 'no_model', attachments: ['receipt.png'], at: 0 },
    decision: null,
  }) as unknown as Dispute;

describe('the cases of the "Needs a person" page', () => {
  it('one row per open case, with the reason in plain words', () => {
    const request = { reason: 'Crushed box', by: 'jun', at: 0, closedAt: null, closedNote: null };
    const rows = casesFromRecords(records({ jobs: [job({ refundRequest: request })], proofs: [proof('needs_review')], disputes: [dispute('waiting_for_seller')] }));
    assert.deepEqual(rows.map((r) => r.kind).sort(), ['dispute', 'receipt', 'refund']);
    assert.match(rows.find((r) => r.kind === 'receipt')!.why, /listed price/);
    assert.match(rows.find((r) => r.kind === 'refund')!.why, /Crushed box/);
    assert.match(rows.find((r) => r.kind === 'dispute')!.why, /did not arrive/);
  });

  it('a refund row is capped at what is left, and a job with nothing left has no row', () => {
    const request = { reason: 'Box', by: 'jun', at: 0, closedAt: null, closedNote: null };
    const part = job({ refundRequest: request, amounts: { retailCents: 3800, shippingCents: null, capturedCents: 4947, refundedCents: 1000, paidOutCents: 0, processingCents: 247, paypalFeesCents: 0 } });
    assert.equal(casesFromRecords(records({ jobs: [part] }))[0]!.refundableCents, 3947);
    const none = job({ refundRequest: request, amounts: { retailCents: 3800, shippingCents: null, capturedCents: 4947, refundedCents: 4947, paidOutCents: 0, processingCents: 247, paypalFeesCents: 0 } });
    assert.equal(casesFromRecords(records({ jobs: [none] })).length, 0);
  });

  it('closed and settled cases leave the page', () => {
    const closed = { reason: 'Box', by: 'jun', at: 0, closedAt: 5, closedNote: 'Done' };
    assert.equal(casesFromRecords(records({ jobs: [job({ refundRequest: closed })], proofs: [proof('passed')], disputes: [dispute('resolved')] })).length, 0);
  });

  it('a failed job with captured money reaches a person, and the template says so on a dispute', () => {
    const rows = casesFromRecords(records({ jobs: [job({ status: 'failed' })], disputes: [dispute('open')] }));
    assert.match(rows.find((r) => r.kind === 'refund')!.why, /automatic refund/);
    const d = rows.find((r) => r.kind === 'dispute')!;
    assert.equal(d.template, true);
    assert.match(d.templateWhy!, /template/);
  });

  it('the picker offers jobs with money left, not ones already on the page or disputed', () => {
    const j1 = job({ id: 'a' });
    const j2 = job({ id: 'b', refundRequest: { reason: 'x', by: 'jun', at: 0, closedAt: null, closedNote: null } });
    const j3 = job({ id: 'c' });
    const r = records({ jobs: [j1, j2, j3], disputes: [{ ...dispute('open'), jobId: 'c' }] });
    assert.deepEqual(refundablePicks(r, casesFromRecords(r)).map((p) => p.jobId), ['a']);
    assert.equal(manualRefundCase(j1).manual, true);
  });
});

describe('the replay moment', () => {
  it('shows exactly one row of each kind at 11:21, and none of them touch the hero day', () => {
    const rows = peopleCasesAt(sf('11:21'), emptyReplayState);
    assert.deepEqual(rows.map((r) => r.kind).sort(), ['dispute', 'receipt', 'refund']);
    assert.equal(rows.find((r) => r.kind === 'dispute')!.template, true);
  });

  it('a closed case stays closed and evidence sent shows on the row', () => {
    const state = { ...emptyReplayState, closed: new Set(['receipt:replay-receipt']), sent: new Set(['dispute:replay-dispute']) };
    const rows = peopleCasesAt(sf('11:21'), state);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.kind === 'dispute')!.evidenceSent, true);
  });
});
