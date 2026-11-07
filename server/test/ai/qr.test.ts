import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import QRCode from 'qrcode';
import { decodePng } from '../../src/ai/image.ts';
import type { RgbaImage } from '../../src/ai/image.ts';
import { buildReceiptQr, parseReceiptQr, readQrCodes } from '../../src/ai/qr.ts';
import { PROOFS_DIR } from '../../scripts/ai-fixtures/load.ts';

const MIA = {
  invoiceNumber: 'PM-1112-0412',
  issuedDate: '2026-11-12',
  totalAmount: 3400,
  sellerTaxId: '41500017',
  items: [{ name: 'MOCHI BUNNY PLUSH SAKURA', qty: 1, unitPrice: 3400 }],
};

describe('receipt QR payload', () => {
  it('round-trips the store ID, receipt number, date, total and lines', () => {
    const text = buildReceiptQr(MIA);
    assert.ok(text.startsWith('RCPT1|S:41500017|N:PM11120412|D:2026-11-12|T:3400'), text);
    assert.deepEqual(parseReceiptQr(['https://example.test/menu', text]), {
      invoiceNumber: 'PM11120412',
      issuedDate: '2026-11-12',
      sellerTaxId: '41500017',
      totalAmount: 3400,
      currency: 'USD',
      items: [{ name: 'MOCHI BUNNY PLUSH SAKURA', qty: 1, unitPrice: 3400 }],
    });
  });

  it('keeps several lines', () => {
    const text = buildReceiptQr({ ...MIA, items: [...MIA.items, { name: 'GIFT BAG', qty: 1, unitPrice: 100 }] });
    assert.equal(parseReceiptQr([text])?.items.length, 2);
  });

  it('rejects codes that are not receipts or carry impossible dates', () => {
    assert.equal(parseReceiptQr(['https://example.test/menu']), null);
    assert.equal(parseReceiptQr([buildReceiptQr(MIA).replace('2026-11-12', '2026-13-32')]), null);
    assert.equal(parseReceiptQr([buildReceiptQr(MIA).replace('S:41500017', 'S:PM')]), null);
  });
});

async function qrImage(text: string): Promise<RgbaImage> {
  return decodePng(new Uint8Array(await QRCode.toBuffer(text, { type: 'png', errorCorrectionLevel: 'L', margin: 2, scale: 4 })));
}

function sideBySide(a: RgbaImage, b: RgbaImage, gap: number): RgbaImage {
  const width = a.width + gap + b.width;
  const height = Math.max(a.height, b.height);
  const data = new Uint8Array(width * height * 4).fill(255);
  for (const [img, x0] of [
    [a, 0],
    [b, a.width + gap],
  ] as const) {
    for (let y = 0; y < img.height; y++) data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), (y * width + x0) * 4);
  }
  return { width, height, data };
}

describe('QR reading', () => {
  it('reads two codes printed side by side', async () => {
    const left = buildReceiptQr(MIA);
    const right = buildReceiptQr({ ...MIA, invoiceNumber: 'PM-1112-0413' });
    const img = sideBySide(await qrImage(left), await qrImage(right), 40);
    const { texts, decoder } = await readQrCodes(img);
    assert.equal(decoder, true);
    assert.ok(texts.includes(left), 'left code');
    assert.ok(texts.includes(right), 'right code');
  });

  it('reads the receipt QR from a rendered, photographed receipt', async () => {
    const png = readFileSync(join(PROOFS_DIR, 'paper-moon-mia-genuine', 'receipt.png'));
    const e = parseReceiptQr((await readQrCodes(decodePng(png))).texts);
    assert.equal(e?.invoiceNumber, 'PM11120412');
    assert.equal(e?.sellerTaxId, '41500017');
    assert.equal(e?.totalAmount, 3400);
  });

  it('reads the forged store ID on the fake receipt', async () => {
    const png = readFileSync(join(PROOFS_DIR, 'paper-moon-rex-fake', 'receipt.png'));
    assert.equal(parseReceiptQr((await readQrCodes(decodePng(png))).texts)?.sellerTaxId, '41500093');
  });
});
