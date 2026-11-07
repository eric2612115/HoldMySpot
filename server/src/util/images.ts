import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

/** Image helpers that need no native code: size from headers, hashes, placeholder images. */

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Detects the type from the first bytes (the Content-Type header is not trusted alone). */
export function sniffImageType(b: Uint8Array): ImageType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

/** Width and height from the image header, or null when the header is not understood. */
export function imageSize(b: Uint8Array, type: ImageType): { width: number; height: number } | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    if (type === 'image/png') {
      if (b.length < 24) return null;
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (type === 'image/jpeg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1]!;
        const len = view.getUint16(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
        }
        i += 2 + len;
      }
      return null;
    }
    const chunk = String.fromCharCode(...b.slice(12, 16));
    if (chunk === 'VP8X') return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    if (chunk === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  } catch {
    return null;
  }
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * A small valid PNG whose bytes depend only on `label`: used for demo and
 * test photos when no rendered fixture image exists. Same label, same bytes
 * (so a "recycled" photo is literally the same file).
 */
export function placeholderPng(label: string, size = 16): Buffer {
  const seed = createHash('sha256').update(label).digest();
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const k = (x + y * 3) % seed.length;
      raw[row + 1 + x * 3] = (seed[k]! + x * 9) & 0xff;
      raw[row + 2 + x * 3] = (seed[(k + 7) % seed.length]! + y * 11) & 0xff;
      raw[row + 3 + x * 3] = seed[(k + 13) % seed.length]!;
    }
  }
  const text = Buffer.from(`Comment\0HoldMySpot placeholder: ${label}`, 'latin1');
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', text),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
