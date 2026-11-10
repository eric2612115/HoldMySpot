import { PHOTO_STAMP_PNG_KEY, photoStampText } from '@holdmyspot/shared';
import { describe, expect, it } from 'vitest';
import { stampFontPx, stampPhoto, stampedCode } from './stamp';

// vitest runs in Node; the web app's types are the browser's, so the file reader comes in untyped.
const fsModule = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: URL): Uint8Array };

function pngWithText(keyword: string, value: string, textAfterImage = false): Uint8Array {
  const body = new TextEncoder().encode(`${keyword}\0${value}`);
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    return out;
  };
  const text = chunk('tEXt', body);
  const image = chunk('IDAT', new Uint8Array(1));
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), ...(textAfterImage ? [image, text] : [text, image]), chunk('IEND', new Uint8Array(0))];
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return all;
}

describe('the app stamp', () => {
  it('reads as code, time, shop', () => {
    expect(photoStampText('K7MX4', '10:50', 'Paper Moon Toys')).toBe('K7MX4 · 10:50 · Paper Moon Toys');
  });

  it('finds the tag a rendered photo carries, and nothing on a plain file', () => {
    expect(stampedCode(pngWithText(PHOTO_STAMP_PNG_KEY, 'K7MX4'))).toBe('K7MX4');
    expect(stampedCode(pngWithText('Software', 'other'))).toBeNull();
    expect(stampedCode(new Uint8Array([255, 216, 255, 224]))).toBeNull();
  });

  it('finds the tag after the image data too, as in the demo line photo, so that photo is sent unchanged', () => {
    expect(stampedCode(pngWithText(PHOTO_STAMP_PNG_KEY, 'K7MX4', true))).toBe('K7MX4');
    const line = readFileSync(new URL('../../../../server/fixtures/proofs/checkin-paper-moon-wei/line.png', import.meta.url));
    expect(stampedCode(line)).toBe('M4RT7');
  });

  it("serves the demo line photo as the sample, byte for byte, and sends it unchanged on Wei's demo visit", async () => {
    const fixture = readFileSync(new URL('../../../../server/fixtures/proofs/checkin-paper-moon-wei/line.png', import.meta.url));
    const sample = readFileSync(new URL('../../../public/samples/line.png', import.meta.url));
    expect(sample.length === fixture.length && sample.every((b, i) => b === fixture[i])).toBe(true);
    const file = new File([new Uint8Array(sample)], 'sample-line.png', { type: 'image/png' });
    expect(await stampPhoto(file, { code: 'M4RT7', hhmm: '10:30', shopName: 'Paper Moon Toys' })).toBe(file);
  });

  it('stays legible and inside narrow photos', () => {
    expect(stampFontPx(1000, 750, 32)).toBe(30);
    expect(stampFontPx(3024, 4032, 32)).toBe(96);
    const narrow = stampFontPx(480, 1000, 40);
    expect(narrow * 40 * 0.62).toBeLessThanOrEqual(480 * 0.92);
  });
});
