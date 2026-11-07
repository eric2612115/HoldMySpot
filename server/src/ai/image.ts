import { createHash } from 'node:crypto';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

/**
 * Image helpers for proof photos, with no native dependencies:
 * - PNG decode (all colour types and bit depths, Adam7) and encode in pure TypeScript;
 * - JPEG decode through the pure-JavaScript `jpeg-js` package, loaded on first use;
 * - WebP is accepted for upload but not decoded (perceptual checks then fall
 *   back to exact SHA-256 matches, and the result says so);
 * - size sniffing without decoding, and a scan for image-generator metadata
 *   (C2PA manifests, IPTC "trained algorithmic media", generator text fields).
 */

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** 8-bit RGBA pixels, row-major, `width * height * 4` bytes. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

const MAX_PIXELS = 60_000_000;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let s = '';
  for (let i = start; i < start + length && i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0);
  return s;
}

function u32be(b: Uint8Array, o: number): number {
  return (((b[o] ?? 0) << 24) >>> 0) + ((b[o + 1] ?? 0) << 16) + ((b[o + 2] ?? 0) << 8) + (b[o + 3] ?? 0);
}

function u16be(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
}

function u16le(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
}

function u24le(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);
}

function u32le(b: Uint8Array, o: number): number {
  return (u24le(b, o) + (b[o + 3] ?? 0) * 0x1000000) >>> 0;
}

export function sniffImageType(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

export interface PngChunk {
  type: string;
  data: Uint8Array;
}

export function readPngChunks(bytes: Uint8Array): PngChunk[] {
  if (sniffImageType(bytes) !== 'image/png') throw new Error('Not a PNG file.');
  const chunks: PngChunk[] = [];
  let off = 8;
  while (off + 12 <= bytes.length) {
    const len = u32be(bytes, off);
    const type = ascii(bytes, off + 4, 4);
    const start = off + 8;
    const end = start + len;
    if (end + 4 > bytes.length) break;
    chunks.push({ type, data: bytes.subarray(start, end) });
    off = end + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

const PNG_CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  const chunks = readPngChunks(bytes);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr || ihdr.data.length < 13) throw new Error('PNG has no IHDR chunk.');
  const width = u32be(ihdr.data, 0);
  const height = u32be(ihdr.data, 4);
  const depth = ihdr.data[8] ?? 0;
  const colorType = ihdr.data[9] ?? 0;
  const interlace = ihdr.data[12] ?? 0;
  const channels = PNG_CHANNELS[colorType];
  if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}.`);
  if (width === 0 || height === 0 || width * height > MAX_PIXELS) throw new Error('PNG size is out of range.');
  if (![1, 2, 4, 8, 16].includes(depth) || (depth < 8 && channels !== 1) || (colorType === 3 && depth > 8)) {
    throw new Error(`Unsupported PNG bit depth ${depth} for colour type ${colorType}.`);
  }
  const palette = chunks.find((c) => c.type === 'PLTE')?.data ?? null;
  const trns = chunks.find((c) => c.type === 'tRNS')?.data ?? null;
  if (colorType === 3 && !palette) throw new Error('Palette PNG has no PLTE chunk.');
  const idatParts = chunks.filter((c) => c.type === 'IDAT').map((c) => c.data);
  const raw = inflateSync(Buffer.concat(idatParts));

  const out = new Uint8Array(width * height * 4);
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const maxValue = (1 << Math.min(depth, 8)) - 1;

  const writePixel = (line: Uint8Array, x: number, dst: number) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 255;
    const sample = (i: number): number => {
      if (depth === 8) return line[x * channels + i] ?? 0;
      if (depth === 16) return line[(x * channels + i) * 2] ?? 0;
      const bit = x * depth;
      const byte = line[bit >> 3] ?? 0;
      return (byte >> (8 - depth - (bit & 7))) & maxValue;
    };
    switch (colorType) {
      case 0: {
        const v = sample(0);
        const grey = depth < 8 ? Math.round((v * 255) / maxValue) : v;
        r = g = b = grey;
        if (trns && trns.length >= 2 && depth <= 8 && u16be(trns, 0) === v) a = 0;
        break;
      }
      case 2:
        r = sample(0);
        g = sample(1);
        b = sample(2);
        if (trns && trns.length >= 6 && depth === 8 && u16be(trns, 0) === r && u16be(trns, 2) === g && u16be(trns, 4) === b) a = 0;
        break;
      case 3: {
        const idx = sample(0);
        r = palette?.[idx * 3] ?? 0;
        g = palette?.[idx * 3 + 1] ?? 0;
        b = palette?.[idx * 3 + 2] ?? 0;
        a = trns && idx < trns.length ? (trns[idx] ?? 255) : 255;
        break;
      }
      case 4:
        r = g = b = sample(0);
        a = sample(1);
        break;
      default:
        r = sample(0);
        g = sample(1);
        b = sample(2);
        a = sample(3);
    }
    out[dst] = r;
    out[dst + 1] = g;
    out[dst + 2] = b;
    out[dst + 3] = a;
  };

  let offset = 0;
  const decodePass = (pw: number, ph: number, place: (x: number, y: number) => number) => {
    if (pw === 0 || ph === 0) return;
    const stride = Math.ceil((pw * bitsPerPixel) / 8);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < ph; y++) {
      const filter = raw[offset] ?? 0;
      const line = Uint8Array.from(raw.subarray(offset + 1, offset + 1 + stride));
      if (line.length < stride) throw new Error('PNG data is truncated.');
      offset += 1 + stride;
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? (line[i - bpp] ?? 0) : 0;
        const up = prev[i] ?? 0;
        const upLeft = i >= bpp ? (prev[i - bpp] ?? 0) : 0;
        const cur = line[i] ?? 0;
        switch (filter) {
          case 0:
            break;
          case 1:
            line[i] = (cur + left) & 0xff;
            break;
          case 2:
            line[i] = (cur + up) & 0xff;
            break;
          case 3:
            line[i] = (cur + ((left + up) >> 1)) & 0xff;
            break;
          case 4:
            line[i] = (cur + paeth(left, up, upLeft)) & 0xff;
            break;
          default:
            throw new Error(`Unknown PNG filter ${filter}.`);
        }
      }
      for (let x = 0; x < pw; x++) writePixel(line, x, place(x, y) * 4);
      prev = line;
    }
  };

  if (interlace === 0) {
    decodePass(width, height, (x, y) => y * width + x);
  } else {
    for (const [x0, y0, dx, dy] of ADAM7) {
      const pw = Math.ceil((width - x0) / dx);
      const ph = Math.ceil((height - y0) / dy);
      decodePass(Math.max(0, pw), Math.max(0, ph), (x, y) => (y0 + y * dy) * width + (x0 + x * dx));
    }
  }
  return { width, height, data: out };
}

function chunkBytes(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)) >>> 0);
  return out;
}

/**
 * Encodes 8-bit RGBA pixels as a PNG (tests and the fixture renderer).
 * Lossless; drops the alpha channel when every pixel is opaque, and picks
 * each row's filter by the usual minimum-sum heuristic.
 */
export function encodePng(img: RgbaImage, extraChunks: PngChunk[] = []): Uint8Array {
  const { width, height, data } = img;
  if (data.length !== width * height * 4) throw new Error('Pixel buffer does not match the size.');
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const channels = opaque ? 3 : 4;
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  let prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) cur[x * channels + c] = data[(y * width + x) * 4 + c] ?? 0;
    }
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = candidates[f] as Uint8Array;
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? (cur[i - channels] ?? 0) : 0;
        const up = prev[i] ?? 0;
        const upLeft = i >= channels ? (prev[i - channels] ?? 0) : 0;
        const v = cur[i] ?? 0;
        const predicted = f === 0 ? 0 : f === 1 ? left : f === 2 ? up : f === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
        const b = (v - predicted) & 0xff;
        out[i] = b;
        score += b < 128 ? b : 256 - b;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    raw[y * (stride + 1)] = best;
    raw.set(candidates[best] as Uint8Array, y * (stride + 1) + 1);
    prev = Uint8Array.from(cur);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunkBytes('IHDR', ihdr),
    ...extraChunks.map((c) => chunkBytes(c.type, c.data)),
    chunkBytes('IDAT', deflateSync(raw, { level: 9 })),
    chunkBytes('IEND', new Uint8Array(0)),
  ];
  return Uint8Array.from(Buffer.concat(parts));
}

/** Inserts extra chunks (for example text metadata) into an existing PNG, just before IEND. */
export function insertPngChunks(png: Uint8Array, chunks: PngChunk[]): Uint8Array {
  const existing = readPngChunks(png).filter((c) => c.type !== 'IEND');
  const parts = [png.subarray(0, 8), ...existing.map((c) => chunkBytes(c.type, c.data)), ...chunks.map((c) => chunkBytes(c.type, c.data)), chunkBytes('IEND', new Uint8Array(0))];
  return Uint8Array.from(Buffer.concat(parts));
}

/** A PNG tEXt chunk (Latin-1). */
export function pngTextChunk(keyword: string, text: string): PngChunk {
  return { type: 'tEXt', data: Uint8Array.from(Buffer.from(`${keyword}\0${text}`, 'latin1')) };
}

/** An uncompressed PNG iTXt chunk (UTF-8), the container PNG uses for XMP. */
export function pngITextChunk(keyword: string, text: string): PngChunk {
  return {
    type: 'iTXt',
    data: Uint8Array.from(Buffer.concat([Buffer.from(`${keyword}\0\0\0\0\0`, 'latin1'), Buffer.from(text, 'utf8')])),
  };
}

// ---------------------------------------------------------------------------
// JPEG (jpeg-js, optional) and the generic entry point
// ---------------------------------------------------------------------------

type JpegModule = typeof import('jpeg-js');
let jpegModule: Promise<JpegModule | null> | null = null;

function loadJpeg(): Promise<JpegModule | null> {
  jpegModule ??= import('jpeg-js').then(
    (m) => m,
    () => null,
  );
  return jpegModule;
}

/** Decodes PNG or JPEG bytes to RGBA. Returns null for WebP, unknown formats or broken files. */
export async function decodeImage(bytes: Uint8Array): Promise<RgbaImage | null> {
  const type = sniffImageType(bytes);
  try {
    if (type === 'image/png') return decodePng(bytes);
    if (type === 'image/jpeg') {
      const jpeg = await loadJpeg();
      if (!jpeg) return null;
      const d = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 60, maxMemoryUsageInMB: 1024 });
      return { width: d.width, height: d.height, data: d.data };
    }
  } catch {
    return null;
  }
  return null;
}

/** EXIF orientation of a JPEG (1 when absent): 3 = upside down, 6 = rotate 90 clockwise, 8 = rotate 90 counter-clockwise. */
export function jpegOrientation(bytes: Uint8Array): number {
  let off = 2;
  while (off + 4 < bytes.length && bytes[off] === 0xff) {
    const marker = bytes[off + 1] ?? 0;
    if (marker === 0xda || marker === 0xd9) break;
    const len = u16be(bytes, off + 2);
    if (marker === 0xe1 && ascii(bytes, off + 4, 6) === 'Exif\0\0') {
      const tiff = bytes.subarray(off + 10, off + 2 + len);
      const le = ascii(tiff, 0, 2) === 'II';
      const r16 = (o: number) => (le ? u16le(tiff, o) : u16be(tiff, o));
      const ifd = le ? u32le(tiff, 4) : u32be(tiff, 4);
      const count = r16(ifd);
      for (let i = 0; i < count; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > tiff.length) break;
        if (r16(e) === 0x0112) return r16(e + 8);
      }
    }
    off += 2 + len;
  }
  return 1;
}

function rotate(img: RgbaImage, orientation: number): RgbaImage {
  if (orientation !== 3 && orientation !== 6 && orientation !== 8) return img;
  const { width: w, height: h, data } = img;
  const turn = orientation !== 3;
  const out = new Uint8Array(data.length);
  const ow = turn ? h : w;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [nx, ny] = orientation === 3 ? [w - 1 - x, h - 1 - y] : orientation === 6 ? [h - 1 - y, x] : [y, w - 1 - x];
      out.set(data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (ny * ow + nx) * 4);
    }
  }
  return { width: ow, height: turn ? w : h, data: out };
}

/** Area-average downscale so the longer side is at most `maxSide`. */
export function shrinkToFit(img: RgbaImage, maxSide: number): RgbaImage {
  const scale = Math.max(img.width, img.height) / maxSide;
  if (scale <= 1) return img;
  const w = Math.max(1, Math.round(img.width / scale));
  const h = Math.max(1, Math.round(img.height / scale));
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w));
      const sum = [0, 0, 0, 0];
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * img.width + sx) * 4;
          for (let c = 0; c < 4; c++) sum[c] = (sum[c] ?? 0) + (img.data[i + c] ?? 0);
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      for (let c = 0; c < 4; c++) data[(y * w + x) * 4 + c] = Math.round((sum[c] ?? 0) / n);
    }
  }
  return { width: w, height: h, data };
}

/**
 * The photo as sent to a model. Most uploads go as they are. A photo above
 * `maxBytes` (model APIs cap each image at about 5 MB) is turned upright from
 * its EXIF orientation, shrunk to 1600 px on the longer side and re-encoded
 * as JPEG. Hashes and QR reading always use the original bytes.
 */
export async function imageForModel(bytes: Uint8Array, opts: { maxBytes?: number; maxSide?: number } = {}): Promise<{ mime: ImageMime; bytes: Uint8Array }> {
  const mime = sniffImageType(bytes);
  if (!mime) throw new Error('Not a JPEG, PNG or WebP image.');
  if (bytes.length <= (opts.maxBytes ?? 4_500_000)) return { mime, bytes };
  const pixels = await decodeImage(bytes);
  const jpeg = await loadJpeg();
  if (!pixels || !jpeg) return { mime, bytes };
  const upright = mime === 'image/jpeg' ? rotate(pixels, jpegOrientation(bytes)) : pixels;
  const small = shrinkToFit(upright, opts.maxSide ?? 1600);
  const out = jpeg.encode({ width: small.width, height: small.height, data: Buffer.from(small.data) }, 85);
  return { mime: 'image/jpeg', bytes: new Uint8Array(out.data) };
}

/** Width and height from the file header, without decoding pixels. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const type = sniffImageType(bytes);
  if (type === 'image/png') {
    if (bytes.length < 24) return null;
    return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }
  if (type === 'image/jpeg') {
    let off = 2;
    while (off + 9 < bytes.length) {
      if (bytes[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = bytes[off + 1] ?? 0;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
        off += marker === 0xff ? 1 : 2;
        continue;
      }
      const len = u16be(bytes, off + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: u16be(bytes, off + 5), width: u16be(bytes, off + 7) };
      }
      off += 2 + len;
    }
    return null;
  }
  if (type === 'image/webp') {
    const kind = ascii(bytes, 12, 4);
    if (kind === 'VP8X' && bytes.length >= 30) return { width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) };
    if (kind === 'VP8L' && bytes.length >= 25) {
      const b0 = bytes[21] ?? 0;
      const b1 = bytes[22] ?? 0;
      const b2 = bytes[23] ?? 0;
      const b3 = bytes[24] ?? 0;
      return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
    }
    if (kind === 'VP8 ' && bytes.length >= 30) return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Image-generator metadata (a weak signal: screenshots and re-saves strip it)
// ---------------------------------------------------------------------------

const XMP_MARKERS: readonly { re: RegExp; label: string }[] = [
  { re: /trainedAlgorithmicMedia/i, label: 'IPTC source type: made by a trained algorithm' },
  { re: /c2pa/i, label: 'C2PA content credentials' },
];
/** PNG text keys that image-generation tools write (prompt and settings dumps). */
const GENERATOR_TEXT_KEYS = new Set(['parameters', 'prompt', 'workflow', 'negative_prompt', 'sd-metadata', 'generation_data', 'invokeai_metadata']);
/** Generic words in a Software or Creator field that name an image generator. */
const GENERATOR_WORDS = /\b(diffusion|generative|ai[- ]?generated|text[- ]to[- ]image|image generator|generated by ai)\b/i;

function xmpMarkers(text: string): string[] {
  return XMP_MARKERS.filter((m) => m.re.test(text)).map((m) => m.label);
}

function exifSoftware(tiff: Uint8Array): string | null {
  if (tiff.length < 8) return null;
  const le = ascii(tiff, 0, 2) === 'II';
  const r16 = (o: number) => (le ? u16le(tiff, o) : u16be(tiff, o));
  const r32 = (o: number) => (le ? (u16le(tiff, o) | (u16le(tiff, o + 2) << 16)) >>> 0 : u32be(tiff, o));
  const ifd = r32(4);
  if (ifd + 2 > tiff.length) return null;
  const count = r16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > tiff.length) break;
    if (r16(e) !== 0x0131) continue;
    const n = r32(e + 4);
    const start = n > 4 ? r32(e + 8) : e + 8;
    return ascii(tiff, start, Math.min(n, 200)).replace(/\0+$/, '');
  }
  return null;
}

/**
 * Looks for image-generator metadata in PNG, JPEG or WebP bytes. Returns one
 * plain label per finding, empty when none.
 */
export function generatorMetadata(bytes: Uint8Array): string[] {
  const found = new Set<string>();
  const type = sniffImageType(bytes);
  const software = (value: string | null) => {
    if (value && GENERATOR_WORDS.test(value)) found.add('Software field names an image generator');
  };
  try {
    if (type === 'image/png') {
      for (const c of readPngChunks(bytes)) {
        if (c.type === 'caBX') found.add('C2PA content credentials');
        if (c.type !== 'tEXt' && c.type !== 'zTXt' && c.type !== 'iTXt') continue;
        const nul = c.data.indexOf(0);
        if (nul < 0) continue;
        const keyword = ascii(c.data, 0, nul);
        let text = '';
        if (c.type === 'tEXt') text = Buffer.from(c.data.subarray(nul + 1)).toString('latin1');
        else if (c.type === 'zTXt') text = inflateSync(c.data.subarray(nul + 2)).toString('latin1');
        else {
          const compressed = c.data[nul + 1] === 1;
          let p = nul + 3;
          p = c.data.indexOf(0, p) + 1; // language tag
          p = c.data.indexOf(0, p) + 1; // translated keyword
          const body = c.data.subarray(p);
          text = (compressed ? inflateSync(body) : Buffer.from(body)).toString('utf8');
        }
        if (GENERATOR_TEXT_KEYS.has(keyword.toLowerCase())) found.add(`PNG text field "${keyword}" of the kind image generators write`);
        if (/^(software|creator|source)$/i.test(keyword)) software(text);
        for (const label of xmpMarkers(text)) found.add(label);
      }
    } else if (type === 'image/jpeg') {
      let off = 2;
      while (off + 4 < bytes.length && bytes[off] === 0xff) {
        const marker = bytes[off + 1] ?? 0;
        if (marker === 0xda || marker === 0xd9) break;
        const len = u16be(bytes, off + 2);
        const seg = bytes.subarray(off + 4, off + 2 + len);
        if (marker === 0xe1 && ascii(seg, 0, 6) === 'Exif\0\0') software(exifSoftware(seg.subarray(6)));
        if (marker === 0xe1 && ascii(seg, 0, 28) === 'http://ns.adobe.com/xap/1.0/') {
          for (const label of xmpMarkers(Buffer.from(seg).toString('utf8'))) found.add(label);
        }
        if (marker === 0xeb && /jumb|c2pa/.test(ascii(seg, 0, Math.min(seg.length, 64)))) found.add('C2PA content credentials');
        off += 2 + len;
      }
    } else if (type === 'image/webp') {
      let off = 12;
      while (off + 8 <= bytes.length) {
        const id = ascii(bytes, off, 4);
        const len = u32le(bytes, off + 4);
        const body = bytes.subarray(off + 8, off + 8 + len);
        if (id === 'XMP ') for (const label of xmpMarkers(Buffer.from(body).toString('utf8'))) found.add(label);
        if (id === 'EXIF') software(exifSoftware(ascii(body, 0, 6) === 'Exif\0\0' ? body.subarray(6) : body));
        off += 8 + len + (len % 2);
      }
    }
  } catch {
    // A malformed container is not evidence either way.
  }
  if (found.size === 0) {
    // Unknown container layouts: look for the standard markers in the raw bytes,
    // with patterns long enough not to appear by chance in compressed pixels.
    const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 512 * 1024))).toString('latin1');
    if (/trainedAlgorithmicMedia/.test(head)) found.add('IPTC source type: made by a trained algorithm');
    if (/urn:c2pa|c2pa\.(claim|assertions|signature|actions|hash)/i.test(head)) found.add('C2PA content credentials');
  }
  return [...found];
}
