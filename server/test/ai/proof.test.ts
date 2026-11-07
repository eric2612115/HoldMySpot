import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { receiptCapture } from '@holdmyspot/shared';
import { AiError } from '../../src/ai/errors.ts';
import { encodePng } from '../../src/ai/image.ts';
import { buildAiPort } from '../../src/ai/index.ts';
import { ownDuplicate, toLineReading, toPurchaseReading } from '../../src/ai/proof.ts';
import type { PurchaseExtraction } from '../../src/ai/schemas.ts';
import { checkInInput, listCases, loadHistory, purchaseInput } from '../../scripts/ai-fixtures/load.ts';
import type { LoadedCase } from '../../scripts/ai-fixtures/load.ts';
import { StubProvider, scene, tempDir } from './helpers.ts';

const rulesOnly = () => buildAiPort({ env: {}, secretsDir: tempDir(), aiProvider: 'fake' });
const byId = (id: string): LoadedCase => {
  const lc = listCases().find((c) => c.data.id === id);
  assert.ok(lc, `fixture ${id} exists`);
  return lc;
};

describe('reading normalisation', () => {
  it('puts what a model copied into the shape the shared rules compare', () => {
    const ex: PurchaseExtraction = {
      printedName: ' PAPER MOON TOYS ',
      sellerTaxId: 'Store 41500017',
      invoiceNumber: 'pm-1112 0412',
      issuedAtLocal: '2026/11/12 11:41:07',
      currency: 'USD',
      lines: [{ name: ' MOCHI BUNNY PLUSH SAKURA ', qty: 1, unitMinor: 3400, totalMinor: 3400 }],
      totalMinor: 3400,
      itemPhoto: { codeSeen: 'k7mx4', unitsVisible: 1 },
      anomalies: [],
    };
    const r = toPurchaseReading(ex, null, false);
    assert.equal(r.printedName, 'PAPER MOON TOYS');
    assert.equal(r.sellerTaxId, '41500017');
    assert.equal(r.invoiceNumber, 'PM11120412');
    assert.equal(r.issuedAtLocal, '2026-11-12 11:41');
    assert.equal(r.lines[0]?.name, 'MOCHI BUNNY PLUSH SAKURA');
    assert.equal(toPurchaseReading({ ...ex, issuedAtLocal: '12 Nov 2026' }, null, false).issuedAtLocal, null);
    assert.equal(toLineReading({ lineVisible: true, peopleAhead: 3, codeSeen: 'X', storefrontText: '  ' }).storefrontText, null);
  });

  it('finds an earlier copy by bytes or by dHash', () => {
    const facts = { sha256: 'abc', dHash: 'ffffffffffffffff' } as Parameters<typeof ownDuplicate>[0][number];
    assert.equal(ownDuplicate([facts], [{ fileId: 'old', sha256: 'abc', dHash: null, at: 0 }]), 'old');
    assert.equal(ownDuplicate([facts], [{ fileId: 'near', sha256: 'x', dHash: 'fffffffffffffff1', at: 0 }]), 'near');
    assert.equal(ownDuplicate([facts], [{ fileId: 'far', sha256: 'x', dHash: '0000000000000000', at: 0 }]), null);
  });
});

describe('proof pipeline on the rendered fixtures (rules-only reader)', async () => {
  const port = rulesOnly();
  const prior = await loadHistory();
  for (const lc of listCases()) {
    it(`${lc.data.id}: ${lc.data.expect.status}`, async () => {
      const c = lc.data;
      const v = c.kind === 'purchase' ? await port.purchaseProof(await purchaseInput(lc, prior)) : await port.checkInPhoto(await checkInInput(lc, prior));
      const hard = v.checks.filter((k) => !k.ok && k.weight === 'hard').map((k) => k.code).sort();
      const soft = v.checks.filter((k) => !k.ok && k.weight === 'soft').map((k) => k.code).sort();
      assert.equal(v.status, c.expect.status, v.summary);
      assert.deepEqual(hard, [...c.expect.hard].sort());
      assert.deepEqual(soft, [...c.expect.soft].sort());
      assert.deepEqual([v.ai.provider, v.ai.model, v.ai.mode], ['fake', 'rules-v1', 'fake']);
      assert.ok(v.confidence >= 0.5 && v.confidence <= 0.99);
      if (c.kind === 'purchase' && 'retailCents' in v && c.expect.retailCents !== undefined) {
        const input = await purchaseInput(lc, prior);
        assert.equal(v.retailCents, c.expect.retailCents);
        assert.equal(receiptCapture(input.job.caps, v.retailCents ?? 0).amountCents, c.expect.captureCents);
      }
    });
  }
});

describe('hero proofs', () => {
  it("Mia's receipt passes with the receipt QR read from the photo and a $46.00 capture", async () => {
    const v = await rulesOnly().purchaseProof(await purchaseInput(byId('paper-moon-mia-genuine'), await loadHistory()));
    assert.equal(v.status, 'passed');
    assert.equal(v.qr?.receiptQr?.invoiceNumber, 'PM11120412');
    assert.equal(v.retailCents, 3400);
    assert.ok(v.reasons.some((r) => r.includes('Capture $46.00')), v.reasons.join(' / '));
    assert.equal(v.photos.length, 2);
  });

  it("Rex's receipt fails four checks and points at the earlier upload", async () => {
    const v = await rulesOnly().purchaseProof(await purchaseInput(byId('paper-moon-rex-fake'), await loadHistory()));
    assert.equal(v.status, 'failed');
    assert.match(v.summary, /4 checks/);
    assert.equal(v.duplicateOf, 'jo-item-1110');
    assert.equal(v.confidence, 0.99);
  });

  it("keeps the core's duplicate finding when it has one", async () => {
    const input = await purchaseInput(byId('paper-moon-mia-genuine'), []);
    const v = await rulesOnly().purchaseProof({ ...input, duplicateOf: 'file-from-core' });
    assert.equal(v.duplicateOf, 'file-from-core');
    assert.equal(v.status, 'failed');
  });
});

describe('failures never pass a proof', () => {
  it('throws for a photo the rules-only reader does not know (the core then asks a person)', async () => {
    const input = await purchaseInput(byId('paper-moon-mia-genuine'), []);
    const stranger = encodePng(scene(20, 20, (x, y) => x * y));
    await assert.rejects(rulesOnly().purchaseProof({ ...input, itemPhoto: { ...input.itemPhoto, bytes: async () => stranger } }), (e: unknown) => e instanceof AiError && e.kind === 'no_truth');
  });

  it('passes a provider timeout up as an AI error', async () => {
    const failing = new StubProvider({
      json: () => {
        throw new AiError('timeout', 'slow');
      },
    });
    const port = buildAiPort({ env: {}, secretsDir: tempDir(), provider: failing });
    const lc = byId('checkin-paper-moon-wei');
    await assert.rejects(port.checkInPhoto(await checkInInput(lc, [])), (e: unknown) => e instanceof AiError && e.kind === 'timeout');
  });
});
