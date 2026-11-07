import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { encode as encodeJpeg } from 'jpeg-js';
import {
  decodeImage,
  decodePng,
  encodePng,
  generatorMetadata,
  imageForModel,
  imageSize,
  insertPngChunks,
  jpegOrientation,
  pngITextChunk,
  pngTextChunk,
  sniffImageType,
} from '../../src/ai/image.ts';
import { scene } from './helpers.ts';

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function rawPng(width: number, height: number, depth: number, colorType: number, rows: number[][], extra: Buffer[] = []): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  const raw = Buffer.from(rows.flatMap((r) => [0, ...r]));
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]),
  );
}

const XMP_AI = '<x:xmpmeta><rdf:Description Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/></x:xmpmeta>';

describe('PNG', () => {
  it('round-trips opaque pixels as RGB and keeps every value', () => {
    const img = scene(7, 5, (x, y) => x * 30 + y * 7);
    const png = encodePng(img);
    assert.equal(sniffImageType(png), 'image/png');
    assert.equal(png[25], 2, 'colour type 2 (RGB) when every pixel is opaque');
    assert.deepEqual(imageSize(png), { width: 7, height: 5 });
    assert.deepEqual(decodePng(png), img);
  });

  it('round-trips pixels with alpha as RGBA', () => {
    const img = scene(6, 4, (x, y) => 200 - x * 20 - y, 128);
    const png = encodePng(img);
    assert.equal(png[25], 6);
    assert.deepEqual(decodePng(png), img);
  });

  it('decodes palette images with transparency', () => {
    const plte = chunk('PLTE', Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255]));
    const trns = chunk('tRNS', Uint8Array.from([255, 0]));
    const img = decodePng(rawPng(3, 2, 8, 3, [[0, 1, 2], [2, 2, 0]], [plte, trns]));
    assert.deepEqual([...img.data.subarray(0, 12)], [255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 255]);
    assert.deepEqual([...img.data.subarray(12, 16)], [0, 0, 255, 255]);
  });

  it('decodes 1-bit grey scale', () => {
    const img = decodePng(rawPng(8, 1, 1, 0, [[0b10110000]]));
    const greys = [];
    for (let i = 0; i < 8; i++) greys.push(img.data[i * 4]);
    assert.deepEqual(greys, [255, 0, 255, 255, 0, 0, 0, 0]);
  });
});

describe('JPEG and WebP', () => {
  it('reads JPEG size and pixels through jpeg-js', async () => {
    const img = scene(16, 16, (x) => x * 15);
    const jpg = new Uint8Array(encodeJpeg({ width: 16, height: 16, data: Buffer.from(img.data) }, 90).data);
    assert.equal(sniffImageType(jpg), 'image/jpeg');
    assert.deepEqual(imageSize(jpg), { width: 16, height: 16 });
    const decoded = await decodeImage(jpg);
    assert.equal(decoded?.width, 16);
  });

  it('reads a WebP (VP8X) size but does not decode it', async () => {
    const b = Buffer.alloc(40);
    b.write('RIFF', 0, 'latin1');
    b.write('WEBP', 8, 'latin1');
    b.write('VP8X', 12, 'latin1');
    b.writeUIntLE(639, 24, 3);
    b.writeUIntLE(479, 27, 3);
    const webp = new Uint8Array(b);
    assert.equal(sniffImageType(webp), 'image/webp');
    assert.deepEqual(imageSize(webp), { width: 640, height: 480 });
    assert.equal(await decodeImage(webp), null);
  });
});

describe('image-generator metadata', () => {
  const plain = encodePng(scene(4, 4, () => 120));

  it('finds nothing in a plain photo', () => {
    assert.deepEqual(generatorMetadata(plain), []);
  });

  it('finds the IPTC source type in PNG XMP', () => {
    const tagged = insertPngChunks(plain, [pngITextChunk('XML:com.adobe.xmp', XMP_AI)]);
    assert.deepEqual(decodePng(tagged), decodePng(plain), 'metadata does not change the pixels');
    assert.match(generatorMetadata(tagged).join(), /trained algorithm/);
  });

  it('finds generator text fields and software names', () => {
    const tagged = insertPngChunks(plain, [pngTextChunk('parameters', 'steps: 30'), pngTextChunk('Software', 'Generic Diffusion Studio 2')]);
    const found = generatorMetadata(tagged).join(' | ');
    assert.match(found, /"parameters"/);
    assert.match(found, /Software field/);
  });

  it('finds C2PA credentials in JPEG XMP', () => {
    const jpg = Buffer.from(encodeJpeg({ width: 8, height: 8, data: Buffer.alloc(8 * 8 * 4, 128) }, 80).data);
    const xmp = Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from('<x:xmpmeta>c2pa.claim</x:xmpmeta>')]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(xmp.length + 2);
    const tagged = new Uint8Array(Buffer.concat([jpg.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, xmp, jpg.subarray(2)]));
    assert.deepEqual(generatorMetadata(tagged), ['C2PA content credentials']);
  });
});

describe('photos sent to a model', () => {
  const exifOrientation6 = Buffer.from([
    0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01,
    0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);

  it('sends ordinary photos unchanged', async () => {
    const png = encodePng(scene(40, 30, (x) => x * 5));
    const sent = await imageForModel(png);
    assert.equal(sent.mime, 'image/png');
    assert.equal(sent.bytes, png);
  });

  it('turns an oversized phone photo upright, shrinks it and re-encodes it as JPEG', async () => {
    const img = scene(120, 60, (x, y) => (x + y) % 255);
    const jpg = Buffer.from(encodeJpeg({ width: 120, height: 60, data: Buffer.from(img.data) }, 95).data);
    const tagged = new Uint8Array(Buffer.concat([jpg.subarray(0, 2), exifOrientation6, jpg.subarray(2)]));
    assert.equal(jpegOrientation(tagged), 6);
    const sent = await imageForModel(tagged, { maxBytes: 100, maxSide: 50 });
    assert.equal(sent.mime, 'image/jpeg');
    assert.deepEqual(imageSize(sent.bytes), { width: 25, height: 50 }, 'rotated a quarter turn, then shrunk');
  });
});
