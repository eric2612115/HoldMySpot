import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import { ABLATION_DOC, ABLATION_JSON, classify, modelFlags, runAblation, summarize } from '../scripts/ablation/ablate.ts';
import type { AblationResult } from '../scripts/ablation/ablate.ts';
import { parseAblationArgs } from '../scripts/ablation/cli.ts';
import { renderJson, renderMarkdown } from '../scripts/ablation/render.ts';

/**
 * docs/ABLATION.md and docs/evidence/ablation.json are written by
 * `npm run ablation` from the model's recorded answers (server/fixtures/ai).
 * This runs the same code offline and fails when either committed file is out
 * of date, so every number on the page is what the code computes today. It
 * also pins the claims the page makes, so claims.md can point at named tests.
 */

const lf = (s: string) => s.replace(/\r\n/g, '\n');

describe('ablation: which layer stops which fake (docs/ABLATION.md)', () => {
  let result: AblationResult;
  before(async () => {
    result = await runAblation();
  });

  it('docs/ABLATION.md and docs/evidence/ablation.json match a fresh run (npm run ablation rewrites them)', () => {
    assert.equal(lf(readFileSync(ABLATION_DOC, 'utf8')), renderMarkdown(result), 'docs/ABLATION.md is out of date: run npm run ablation');
    assert.equal(lf(readFileSync(ABLATION_JSON, 'utf8')), renderJson(result), 'docs/evidence/ablation.json is out of date: run npm run ablation');
  });

  it('decides every photo on a recorded model answer: no model is called and nothing falls back to the truth sidecar', () => {
    assert.ok(result.rows.length > 0);
    for (const r of result.rows) {
      assert.match(r.answer.stamp, /\/replay$/, r.id);
      assert.ok(r.answer.recording?.startsWith('server/fixtures/ai/'), r.id);
      assert.equal(r.answer.error, null, r.id);
    }
  });

  it('Rules + AI stops every fake, passes every genuine proof and sends every review case to a person, with the expected failed checks', () => {
    for (const r of result.rows) {
      assert.equal(r.rulesAndAi.status, r.expected.status, r.id);
      const failed = r.rulesAndAi.failed.map((f) => f.code).sort();
      assert.deepEqual(failed, [...r.expected.hard, ...r.expected.soft].sort(), r.id);
    }
    const s = summarize(result);
    assert.equal(s.rulesAndAi.fakesStopped, s.cases.fake);
    assert.equal(s.rulesAndAi.genuinePassed, s.cases.genuine);
    assert.equal(s.rulesAndAi.reviewStopped, s.cases.review);
  });

  it('the rules on the true reading (the truth sidecar as the reading) reach the same verdicts and failed checks as Rules + AI', () => {
    const s = summarize(result);
    assert.equal(s.agreement.verdicts, s.cases.total);
    assert.equal(s.agreement.failedChecks, s.cases.total);
  });

  it('neither layer alone stops every fake: the model without the job passes some, and some need a rule on the reading', () => {
    const s = summarize(result);
    assert.ok(s.aiOnly.fakesStopped < s.cases.fake, 'the model on its own lets a fake through');
    assert.ok(s.layers.readingOnly.length > 0, 'some fakes are stopped only by a rule applied to what the model read');
    assert.ok(s.layers.codeAlone.length > 0, 'some fakes are stopped by code that uses no reading');
    assert.deepEqual(s.layers.notStopped, []);
  });

  it('counts only what the model reported itself as a flag of the model alone', () => {
    const purchase = {
      printedName: 'PAPER MOON TOYS',
      sellerTaxId: '41500017',
      invoiceNumber: 'PM-1112-0412',
      issuedAtLocal: '2026-11-12 11:41',
      currency: 'USD' as const,
      lines: [{ name: 'MOCHI BUNNY PLUSH SAKURA', qty: 1, unitMinor: 3400, totalMinor: 3400 }],
      totalMinor: 3400,
      itemPhoto: { codeSeen: 'K7MX4', unitsVisible: 1 },
      anomalies: [],
    };
    assert.deepEqual(modelFlags('purchase', purchase), []);
    assert.deepEqual(modelFlags('purchase', { ...purchase, anomalies: [' digits misaligned '] }), ['anomaly: digits misaligned']);
    assert.deepEqual(modelFlags('purchase', { ...purchase, itemPhoto: { codeSeen: null, unitsVisible: 1 }, totalMinor: null }), [
      'no code seen next to the item',
      'no total or no lines read',
    ]);
    assert.deepEqual(modelFlags('check_in', { lineVisible: true, peopleAhead: 30, codeSeen: 'F2KX9', storefrontText: null }), []);
    assert.deepEqual(modelFlags('check_in', { lineVisible: false, peopleAhead: null, codeSeen: ' ', storefrontText: null }), ['no code seen', 'no line seen']);
  });

  it('keeps the committed page the recorded run: --check takes no live, partial or redirected run', () => {
    assert.deepEqual(parseAblationArgs([]), { check: false, live: false, provider: null, only: null, out: null, help: false });
    assert.equal(typeof parseAblationArgs(['--check']), 'object');
    for (const bad of [['--check', '--live'], ['--check', '--only', 'checkin-no-code'], ['--check', '--out', 'x'], ['--provider', 'muse'], ['--live', '--provider', 'gpt'], ['--only'], ['--nope']]) {
      assert.equal(typeof parseAblationArgs(bad), 'string', bad.join(' '));
    }
    const live = parseAblationArgs(['--live', '--provider', 'muse', '--only', 'a, b']);
    assert.ok(typeof live === 'object' && live.live && live.provider === 'muse');
    assert.deepEqual(typeof live === 'object' ? live.only : null, ['a', 'b']);
  });

  it('calls a check code alone only when it uses no reading (the QR store ID only when a QR was read)', () => {
    const basis = (code: Parameters<typeof classify>[0]['code'], qr = false) => classify({ code, weight: 'hard' }, qr).basis;
    assert.deepEqual(['duplicate_photo', 'generator_metadata', 'geofence'].map((c) => basis(c as 'geofence')), ['code', 'code', 'code']);
    assert.equal(basis('shop_match', true), 'code');
    assert.equal(basis('shop_match', false), 'reading');
    for (const c of ['code_visible', 'time_window', 'totals_add_up', 'qty_within_limit', 'qr_matches_print', 'item_match', 'within_retail_cap', 'line_visible'] as const) {
      assert.equal(basis(c, true), 'reading', c);
    }
  });
});
