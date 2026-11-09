import { PHOTO_STAMP_PNG_KEY, photoStampText } from '@holdmyspot/shared';

/** What the stamp says: the visit's code, the time and the shop (D-159). */
export interface StampInfo {
  code: string;
  hhmm: string;
  shopName: string;
}

const MAX_SIDE = 2400;

/**
 * The code a PNG says it already carries (the repo's rendered photos), or null. Reads every text chunk, before or
 * after the image data: the rendered fixtures carry theirs after it, and PNG allows both.
 */
export function stampedCode(bytes: Uint8Array): string | null {
  const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  if (SIGNATURE.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder('latin1');
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = text.decode(bytes.subarray(at + 4, at + 8));
    if (type === 'IEND') return null;
    if (type === 'tEXt') {
      const body = text.decode(bytes.subarray(at + 8, at + 8 + length));
      const nul = body.indexOf('\0');
      if (nul > 0 && body.slice(0, nul) === PHOTO_STAMP_PNG_KEY) return body.slice(nul + 1);
    }
    at += 12 + length;
  }
  return null;
}

/** Font size in pixels for a photo of this size: 4% of the shorter side, shrunk to fit, the same as the rendered fixtures. */
export function stampFontPx(width: number, height: number, textCharacters: number): number {
  const base = Math.round(Math.min(width, height) * 0.04);
  const fit = Math.floor((width * 0.92) / (textCharacters * 0.62));
  return Math.max(12, Math.min(base, fit, 96));
}

/**
 * Draws the stamp in the top-left corner, clear of the line and the counter, on a dark backing, and returns the stamped photo as a JPEG.
 * A file that already carries this visit's stamp is returned as it is (the demo's rendered photos, so their
 * recorded answers still match). The server never trusts this step: the model reads the code off the pixels.
 */
export async function stampPhoto(file: File, info: StampInfo): Promise<File> {
  if (stampedCode(new Uint8Array(await file.arrayBuffer())) === info.code) return file;
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('This photo format cannot be read here. Use a JPEG or PNG.');
  });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('The photo could not be prepared.');
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const text = photoStampText(info.code, info.hhmm, info.shopName);
  const font = stampFontPx(canvas.width, canvas.height, text.length);
  g.font = `600 ${font}px ui-monospace, Menlo, Consolas, monospace`;
  g.textBaseline = 'middle';
  const padX = Math.round(font * 0.6);
  const padY = Math.round(font * 0.35);
  const margin = Math.round(font / 2);
  const w = Math.ceil(g.measureText(text).width) + padX * 2;
  const h = font + padY * 2;
  const x = margin;
  const y = margin;
  g.fillStyle = 'rgba(10, 12, 22, 0.92)';
  g.beginPath();
  g.roundRect(x, y, w, h, Math.round(font * 0.3));
  g.fill();
  g.fillStyle = '#ffffff';
  g.fillText(text, x + padX, y + h / 2);

  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The photo could not be prepared.'))), 'image/jpeg', 0.9));
  return new File([blob], `stamped-${info.code}.jpg`, { type: 'image/jpeg' });
}
