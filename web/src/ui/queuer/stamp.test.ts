import { PHOTO_STAMP_PNG_KEY, photoStampText } from '@holdmyspot/shared';
import { describe, expect, it } from 'vitest';
import { stampFontPx, stampedCode } from './stamp';

function pngWithText(keyword: string, value: string): Uint8Array {
  const body = new TextEncoder().encode(`${keyword}\0${value}`);
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    return out;
  };
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('tEXt', body), chunk('IDAT', new Uint8Array(1))];
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

  it('stays legible and inside narrow photos', () => {
    expect(stampFontPx(1000, 750, 32)).toBe(30);
    expect(stampFontPx(3024, 4032, 32)).toBe(96);
    const narrow = stampFontPx(480, 1000, 40);
    expect(narrow * 40 * 0.62).toBeLessThanOrEqual(480 * 0.92);
  });
});
