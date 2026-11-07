import { decodeImage, generatorMetadata, imageSize, sha256Hex, sniffImageType } from './image.ts';
import type { RgbaImage } from './image.ts';

/**
 * Perceptual hashing for duplicate-photo checks.
 *
 * dHash: the photo is reduced to a 9 x 8 grid of average brightness, and each
 * of the 64 bits says whether a cell is darker than its right neighbour. A
 * re-saved, resized, slightly cropped or re-lit copy keeps most bits; a
 * different photo flips about half. Two photos within `DUPLICATE_DISTANCE`
 * bits (of 64) count as the same photo (docs/AI-SERVICES.md 4.2).
 */

export const DUPLICATE_DISTANCE = 6;

/** 64-bit difference hash as 16 lowercase hex characters (FileRef.dHash). */
export function dHash(img: RgbaImage): string {
  const W = 9;
  const H = 8;
  const sums = new Float64Array(W * H);
  const counts = new Float64Array(W * H);
  const { width, height, data } = img;
  for (let y = 0; y < height; y++) {
    const cy = Math.min(H - 1, Math.floor((y * H) / height));
    for (let x = 0; x < width; x++) {
      const cx = Math.min(W - 1, Math.floor((x * W) / width));
      const i = (y * width + x) * 4;
      const a = (data[i + 3] ?? 255) / 255;
      // Transparent pixels are composited over white.
      const luma = 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
      const cell = cy * W + cx;
      sums[cell] = (sums[cell] ?? 0) + luma * a + 255 * (1 - a);
      counts[cell] = (counts[cell] ?? 0) + 1;
    }
  }
  let hex = '';
  for (let y = 0; y < H; y++) {
    let nibble = 0;
    for (let x = 0; x < W - 1; x++) {
      const left = (sums[y * W + x] ?? 0) / Math.max(1, counts[y * W + x] ?? 0);
      const right = (sums[y * W + x + 1] ?? 0) / Math.max(1, counts[y * W + x + 1] ?? 0);
      nibble = (nibble << 1) | (left < right ? 1 : 0);
      if (x === 3 || x === 7) {
        hex += nibble.toString(16);
        nibble = 0;
      }
    }
  }
  return hex;
}

/** Number of differing bits between two 16-hex-character hashes. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) throw new Error('Hashes must have the same length.');
  let bits = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i] ?? '0', 16) ^ parseInt(b[i] ?? '0', 16);
    while (x) {
      bits += x & 1;
      x >>= 1;
    }
  }
  return bits;
}

/** What the server stores per upload (FileRef fields) plus what the proof checks need. */
export interface PhotoFacts {
  sha256: string;
  dHash: string | null;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp' | null;
  width: number | null;
  height: number | null;
  /** Image-generator metadata labels; empty when none was found. */
  generator: string[];
  /** Decoded pixels when the format could be decoded (kept for the QR reader). */
  pixels: RgbaImage | null;
}

/**
 * Hashes and inspects one uploaded photo. The upload route can call this to
 * fill FileRef.sha256, dHash, width and height; the proof checks reuse it.
 */
export async function photoFacts(bytes: Uint8Array): Promise<PhotoFacts> {
  const contentType = sniffImageType(bytes);
  const pixels = await decodeImage(bytes);
  const size = pixels ? { width: pixels.width, height: pixels.height } : imageSize(bytes);
  return {
    sha256: sha256Hex(bytes),
    dHash: pixels ? dHash(pixels) : null,
    contentType,
    width: size?.width ?? null,
    height: size?.height ?? null,
    generator: generatorMetadata(bytes),
    pixels,
  };
}

export interface PriorPhotoRef {
  fileId: string;
  /** The job or claim the earlier photo belongs to. */
  ownerId: string;
  sha256: string;
  dHash: string | null;
}

export interface DuplicateHit {
  fileId: string;
  ownerId: string;
  /** 0 for an exact copy. */
  distance: number;
  exact: boolean;
}

/** Earlier photos of other owners that match this one, closest first. */
export function findDuplicates(
  photo: { sha256: string; dHash: string | null },
  prior: readonly PriorPhotoRef[],
  ownerId: string,
  maxDistance: number = DUPLICATE_DISTANCE,
): DuplicateHit[] {
  const hits: DuplicateHit[] = [];
  for (const p of prior) {
    if (p.ownerId === ownerId) continue;
    if (p.sha256 === photo.sha256) {
      hits.push({ fileId: p.fileId, ownerId: p.ownerId, distance: 0, exact: true });
      continue;
    }
    if (photo.dHash && p.dHash && p.dHash.length === photo.dHash.length) {
      const d = hammingDistance(photo.dHash, p.dHash);
      if (d <= maxDistance) hits.push({ fileId: p.fileId, ownerId: p.ownerId, distance: d, exact: false });
    }
  }
  return hits.sort((a, b) => a.distance - b.distance);
}
