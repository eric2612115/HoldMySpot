import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { decodePng, encodePng } from '../../src/ai/image.ts';
import type { RgbaImage } from '../../src/ai/image.ts';
import { DUPLICATE_DISTANCE, dHash, findDuplicates, hammingDistance, photoFacts } from '../../src/ai/phash.ts';
import { PROOFS_DIR, listCases } from '../../scripts/ai-fixtures/load.ts';
import { scene } from './helpers.ts';

const base = scene(240, 180, (x, y) => 40 + x * 0.6 + (Math.hypot(x - 80, y - 90) < 45 ? -35 : 0) + (y > 140 ? 50 : 0));

function brighter(img: RgbaImage, k: number): RgbaImage {
  return { ...img, data: Uint8Array.from(img.data, (v, i) => (i % 4 === 3 ? v : Math.min(255, Math.round(v * k)))) };
}

function halve(img: RgbaImage): RgbaImage {
  const w = img.width / 2;
  const h = img.height / 2;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        const s = [0, 1].flatMap((dy) => [0, 1].map((dx) => img.data[((2 * y + dy) * img.width + 2 * x + dx) * 4 + c] ?? 0));
        data[(y * w + x) * 4 + c] = Math.round(s.reduce((a, b) => a + b, 0) / 4);
      }
    }
  }
  return { width: w, height: h, data };
}

describe('dHash', () => {
  it('is 16 hex characters and stable for re-lit and resized copies', () => {
    const h = dHash(base);
    assert.match(h, /^[0-9a-f]{16}$/);
    assert.ok(hammingDistance(h, dHash(brighter(base, 1.08))) <= 2);
    assert.ok(hammingDistance(h, dHash(halve(base))) <= 4);
  });

  it('tells a different photo apart', () => {
    const other = scene(240, 180, (x, y) => 200 - x * 0.5 + (Math.hypot(x - 170, y - 60) < 40 ? -90 : 0));
    assert.ok(hammingDistance(dHash(base), dHash(other)) > DUPLICATE_DISTANCE);
  });

  it('counts differing bits', () => {
    assert.equal(hammingDistance('ffffffffffffffff', '0000000000000000'), 64);
    assert.equal(hammingDistance('f000000000000000', 'e000000000000000'), 1);
  });
});

describe('duplicate search', () => {
  const prior = [
    { fileId: 'f1', ownerId: 'job-a', sha256: 'aa', dHash: 'ffffffffffffffff' },
    { fileId: 'f2', ownerId: 'job-b', sha256: 'bb', dHash: 'fffffffffffffff0' },
    { fileId: 'f3', ownerId: 'job-c', sha256: 'cc', dHash: '0000000000000000' },
  ];

  it('finds exact copies and near copies of other owners, closest first', () => {
    const hits = findDuplicates({ sha256: 'zz', dHash: 'ffffffffffffffff' }, prior, 'job-x');
    assert.deepEqual(
      hits.map((h) => [h.fileId, h.distance]),
      [
        ['f1', 0],
        ['f2', 4],
      ],
    );
    assert.equal(findDuplicates({ sha256: 'cc', dHash: null }, prior, 'job-x')[0]?.exact, true);
  });

  it('ignores photos of the same job', () => {
    assert.deepEqual(findDuplicates({ sha256: 'aa', dHash: null }, prior, 'job-a'), []);
  });
});

describe('photo facts', () => {
  it('fills the FileRef fields for an upload', async () => {
    const f = await photoFacts(encodePng(base));
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.equal(f.dHash, dHash(base));
    assert.deepEqual([f.width, f.height, f.contentType], [240, 180, 'image/png']);
    assert.deepEqual(f.generator, []);
  });
});

describe('rendered fixtures', () => {
  it('keep re-used photos within the duplicate distance of their source and fresh photos clear of earlier uploads', () => {
    const history = new Map<string, string>();
    for (const id of ['lin-item-1111', 'jo-item-1110', 'ava-receipt-1111', 'rin-line-1111']) {
      history.set(id, dHash(decodePng(readFileSync(join(PROOFS_DIR, '_history', `${id}.png`)))));
    }
    let checked = 0;
    for (const lc of listCases()) {
      for (const file of Object.values(lc.data.files)) {
        const h = dHash(decodePng(readFileSync(join(lc.dir, file))));
        for (const [id, hh] of history) {
          const d = hammingDistance(h, hh);
          const reused = lc.data.reusedPhoto?.file === file && lc.data.reusedPhoto.from === id;
          if (reused) assert.ok(d <= DUPLICATE_DISTANCE, `${lc.data.id}/${file} should match ${id} (${d} bits)`);
          else assert.ok(d > DUPLICATE_DISTANCE, `${lc.data.id}/${file} is too close to ${id} (${d} bits)`);
          checked++;
        }
      }
    }
    assert.ok(checked >= 100);
  });
});
