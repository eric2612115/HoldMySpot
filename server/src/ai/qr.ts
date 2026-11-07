import type { RgbaImage } from './image.ts';

/**
 * QR reading for receipts.
 *
 * Our fictional shops that print a receipt QR (the toy shops) use one code in
 * a fixed text layout: the store ID, the receipt number, the date, the total
 * in minor units, the currency and the item lines, for example
 * `RCPT1|S:41500017|N:PM11120042|D:2026-11-12|T:3400|C:USD|I:MOCHI BUNNY PLUSH SAKURA*1*3400`.
 * The checks only rely on the store ID, receipt number, date and total.
 *
 * Decoding uses the pure-JavaScript `jsqr` package, loaded on first use.
 */

type JsQrFn = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' },
) => { data: string; location: Record<string, { x: number; y: number } | undefined> } | null;

let jsqr: Promise<JsQrFn | null> | null = null;

function loadJsQr(): Promise<JsQrFn | null> {
  jsqr ??= import('jsqr').then(
    (m) => {
      const d = (m as unknown as { default?: unknown }).default;
      if (typeof d === 'function') return d as JsQrFn;
      const inner = (d as { default?: unknown } | undefined)?.default;
      return typeof inner === 'function' ? (inner as JsQrFn) : null;
    },
    () => null,
  );
  return jsqr;
}

/** Whether a QR decoder is installed (the `jsqr` package). */
export async function qrDecoderAvailable(): Promise<boolean> {
  return (await loadJsQr()) !== null;
}

function crop(img: RgbaImage, x0: number, y0: number, w: number, h: number): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * img.width + x0) * 4;
    data.set(img.data.subarray(from, from + w * 4), y * w * 4);
  }
  return { width: w, height: h, data };
}

function shrink(img: RgbaImage, factor: number): RgbaImage {
  if (factor <= 1) return img;
  const w = Math.floor(img.width / factor);
  const h = Math.floor(img.height / factor);
  const data = new Uint8Array(w * h * 4);
  const n = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let dy = 0; dy < factor; dy++) {
          for (let dx = 0; dx < factor; dx++) s += img.data[((y * factor + dy) * img.width + (x * factor + dx)) * 4 + c] ?? 0;
        }
        data[(y * w + x) * 4 + c] = Math.round(s / n);
      }
    }
  }
  return { width: w, height: h, data };
}

/**
 * All QR codes found in a photo, as text (at most `max`). Each found code is
 * painted over and the search repeats, so both codes on a receipt are read.
 */
export async function readQrCodes(img: RgbaImage, max = 3): Promise<{ texts: string[]; decoder: boolean }> {
  const decode = await loadJsQr();
  if (!decode) return { texts: [], decoder: false };
  const longest = Math.max(img.width, img.height);
  const base = longest > 2400 ? shrink(img, Math.ceil(longest / 1600)) : img;
  // Two codes side by side can confuse the finder-pattern search, so the left
  // and right parts of the photo are also searched on their own.
  const part = Math.floor(base.width * 0.6);
  const halfW = Math.floor(base.width / 2);
  const regions: RgbaImage[] = [
    base,
    crop(base, 0, 0, part, base.height),
    crop(base, base.width - part, 0, part, base.height),
    crop(base, 0, 0, halfW, base.height),
    crop(base, halfW, 0, base.width - halfW, base.height),
  ];
  const texts: string[] = [];
  for (const region of regions) {
    const data = new Uint8ClampedArray(region.data);
    for (let attempt = 0; attempt < max; attempt++) {
      let code: ReturnType<JsQrFn> = null;
      try {
        code = decode(data, region.width, region.height, { inversionAttempts: 'dontInvert' });
      } catch {
        code = null;
      }
      if (!code || !code.data) break;
      if (!texts.includes(code.data)) texts.push(code.data);
      // Paint the found code white so the next pass finds the other one.
      const pts = Object.values(code.location).filter((p): p is { x: number; y: number } => !!p);
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const pad = Math.max(3, (Math.max(...xs) - Math.min(...xs)) * 0.04);
      const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad));
      const x1 = Math.min(region.width, Math.ceil(Math.max(...xs) + pad));
      const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
      const y1 = Math.min(region.height, Math.ceil(Math.max(...ys) + pad));
      for (let y = y0; y < y1; y++) data.fill(255, (y * region.width + x0) * 4, (y * region.width + x1) * 4);
    }
    if (texts.length >= 2 || texts.length >= max) break;
  }
  return { texts: texts.slice(0, max), decoder: true };
}

// ---------------------------------------------------------------------------
// Receipt QR payload
// ---------------------------------------------------------------------------

export interface ReceiptQrItem {
  name: string;
  qty: number;
  /** Unit price in minor units. */
  unitPrice: number;
}

export interface ReceiptQr {
  /** Receipt number without the dashes printed on paper. */
  invoiceNumber: string;
  /** ISO date. */
  issuedDate: string;
  /** Store ID, digits only. */
  sellerTaxId: string;
  /** Total in minor units of `currency`. */
  totalAmount: number;
  currency: string;
  items: ReceiptQrItem[];
}

const HEADER = 'RCPT1';

/** Finds the receipt code among the texts read from a photo and parses it. Null when none is valid. */
export function parseReceiptQr(texts: readonly string[]): ReceiptQr | null {
  for (const text of texts) {
    const parts = text.split('|');
    if (parts[0] !== HEADER) continue;
    const field = (k: string) => parts.find((p) => p.startsWith(`${k}:`))?.slice(k.length + 1) ?? null;
    const store = field('S');
    const number = field('N');
    const date = field('D');
    const total = Number(field('T'));
    if (!store || !/^\d+$/.test(store) || !number || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(total)) continue;
    const d = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) continue;
    const items: ReceiptQrItem[] = [];
    for (const p of parts.filter((x) => x.startsWith('I:'))) {
      const [name, qty, unit] = p.slice(2).split('*');
      if (name && Number.isFinite(Number(qty)) && Number.isFinite(Number(unit))) items.push({ name: name.trim(), qty: Number(qty), unitPrice: Number(unit) });
    }
    return { invoiceNumber: number, issuedDate: date, sellerTaxId: store, totalAmount: total, currency: field('C') ?? 'USD', items };
  }
  return null;
}

export interface ReceiptQrInput {
  /** As printed, dashes allowed; the code stores it without them. */
  invoiceNumber: string;
  /** ISO date, for example "2026-11-12". */
  issuedDate: string;
  totalAmount: number;
  sellerTaxId: string;
  currency?: string;
  items: ReceiptQrItem[];
}

/** Builds the receipt QR text for a fictional receipt (used by the fixture renderer and tests). */
export function buildReceiptQr(input: ReceiptQrInput): string {
  const lines = input.items.map((i) => `I:${i.name.replace(/[|*]/g, ' ')}*${i.qty}*${i.unitPrice}`);
  return [
    HEADER,
    `S:${input.sellerTaxId}`,
    `N:${input.invoiceNumber.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`,
    `D:${input.issuedDate}`,
    `T:${Math.round(input.totalAmount)}`,
    `C:${input.currency ?? 'USD'}`,
    ...lines,
  ].join('|');
}
