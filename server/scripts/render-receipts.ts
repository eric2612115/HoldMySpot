/**
 * Renders the synthetic proof fixtures (fictional receipts, item photos and
 * line photos) to PNG with Chromium, and writes each case's truth.json and
 * case.json next to its photos in server/fixtures/proofs.
 *
 *   npm run ai:render
 *
 * Needs a Chromium for playwright-core (`npx playwright-core install
 * chromium`), or Google Chrome (used as a fallback), or HMS_CHROME_PATH.
 * The PNGs are committed; re-rendering changes their bytes, so replay
 * fixtures recorded from the old images stop matching (re-record them).
 *
 * After rendering it checks the fixtures themselves: every receipt QR must
 * decode to the intended fields, every re-used photo must stay within the
 * duplicate distance of its source, and every fresh photo must stay clear of
 * all others.
 *
 *   npm run ai:render -- --only reprint-at-cap
 *
 * renders only the named attack cases (ATTACK_CASES, the known limits that
 * `npm run attack` shows, D-147) into their `_` folders and leaves every other
 * photo as it is, so the recorded model answers keep matching.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { SERVER_ROOT } from '../src/ai/config.ts';
import { decodePng, encodePng, insertPngChunks, pngITextChunk, pngTextChunk } from '../src/ai/image.ts';
import { DUPLICATE_DISTANCE, dHash, hammingDistance } from '../src/ai/phash.ts';
import { parseReceiptQr, readQrCodes } from '../src/ai/qr.ts';
import type { PurchaseExtraction, CheckInExtraction } from '../src/ai/schemas.ts';
import { ATTACK_CASES, CHECK_IN_CASES, HISTORY, PURCHASE_CASES } from './ai-fixtures/cases.ts';
import type { AttackCase, ItemPhotoSpec, LinePhotoSpec, PhotoSpec, ReceiptSpec, Tweak } from './ai-fixtures/cases.ts';
import { SIZES, itemHtml, lineHtml, receiptHtml } from './ai-fixtures/html.ts';

const OUT = process.env.HMS_AI_PROOF_FIXTURES_DIR ?? join(SERVER_ROOT, 'fixtures', 'proofs');
/** Cases whose photos the hero demo uploads in one run. */
const HERO_CASES = ['paper-moon-mia-genuine', 'paper-moon-priya-genuine', 'paper-moon-rex-fake', 'checkin-paper-moon-wei', 'checkin-paper-moon-rex'];

async function launch(): Promise<Browser> {
  const executablePath = process.env.HMS_CHROME_PATH;
  try {
    return await chromium.launch(executablePath ? { executablePath } : {});
  } catch {
    return chromium.launch({ channel: 'chrome' });
  }
}

async function shoot(page: Page, html: string, size: { width: number; height: number }): Promise<Uint8Array> {
  await page.setViewportSize(size);
  await page.setContent(html, { waitUntil: 'load' });
  // A string expression: this package type-checks without the DOM library.
  await page.evaluate('document.fonts.ready.then(() => true)');
  const shot = new Uint8Array(await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' }));
  // Re-encode losslessly with per-row filters and maximum compression (about 10% smaller).
  return encodePng(decodePng(shot));
}

async function render(page: Page, spec: PhotoSpec, tweak: Tweak | null = null): Promise<Uint8Array> {
  if (spec.kind === 'receipt') return shoot(page, await receiptHtml(spec, tweak), SIZES.receipt);
  if (spec.kind === 'item') return shoot(page, itemHtml(spec, tweak), SIZES.item);
  return shoot(page, lineHtml(spec, tweak), SIZES.line);
}

function purchaseTruth(r: ReceiptSpec, code: string, units: number): PurchaseExtraction {
  return {
    printedName: r.printedName,
    sellerTaxId: r.sellerTaxId,
    invoiceNumber: r.invoiceNumber,
    issuedAtLocal: r.issuedLocal.slice(0, 16),
    currency: r.currency,
    lines: r.lines.map((l) => ({ name: l.name, qty: l.qty, unitMinor: l.unit, totalMinor: l.total ?? l.qty * l.unit })),
    totalMinor: r.total,
    itemPhoto: { codeSeen: code, unitsVisible: units },
    anomalies: [],
  };
}

function lineTruth(s: LinePhotoSpec): CheckInExtraction {
  return { lineVisible: s.people > 0, peopleAhead: s.people > 0 ? s.people : null, codeSeen: s.code, storefrontText: s.storefront };
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

function fresh(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

/** Checks that a rendered receipt's QR decodes to the fields the case drew into it. */
async function qrProblem(id: string, receipt: Uint8Array, want: ReceiptSpec['qr']): Promise<string | null> {
  if (!want) return null;
  const qr = await readQrCodes(decodePng(receipt));
  const e = parseReceiptQr(qr.texts);
  if (!e) return `${id}: the receipt QR did not decode (${qr.texts.length} codes read).`;
  if (e.invoiceNumber !== want.invoiceNumber || e.sellerTaxId !== want.sellerTaxId || e.totalAmount !== want.total || e.issuedDate !== want.issuedDate) {
    return `${id}: the receipt QR decoded to other fields (${JSON.stringify(e)}).`;
  }
  return null;
}

/** An attack-only case (D-147): its receipt rendered, its item photo copied from the case it names. */
async function renderAttackCase(page: Page, c: AttackCase): Promise<{ problems: string[]; receiptHash: string }> {
  const dir = join(OUT, c.folder);
  fresh(dir);
  const receipt = await render(page, c.receipt);
  const item = readFileSync(join(OUT, c.item.sameAs, 'item.png'));
  writeFileSync(join(dir, 'receipt.png'), receipt);
  writeFileSync(join(dir, 'item.png'), item);
  writeFileSync(join(dir, 'truth.json'), json({ images: ['receipt.png', 'item.png'], outputs: { purchase_proof: purchaseTruth(c.receipt, c.item.code, c.item.units) } }));
  const { receipt: _r, item: _i, folder: _f, ...rest } = c;
  writeFileSync(join(dir, 'case.json'), json({ ...rest, files: { receipt: 'receipt.png', item: 'item.png' }, itemSameAs: c.item.sameAs, reusedPhoto: null }));
  const problem = await qrProblem(c.id, receipt, c.receipt.qr);
  return { problems: problem ? [problem] : [], receiptHash: dHash(decodePng(receipt)) };
}

interface Shot {
  label: string;
  hash: string;
  recycledOf: string | null;
}

async function main(): Promise<void> {
  const at = process.argv.indexOf('--only');
  const only = at >= 0 ? (process.argv[at + 1] ?? '').split(',').map((x) => x.trim()).filter(Boolean) : null;
  if (only) {
    const unknown = only.filter((id) => !ATTACK_CASES.some((c) => c.id === id));
    if (unknown.length > 0 || only.length === 0) {
      console.error(`--only takes attack cases (${ATTACK_CASES.map((c) => c.id).join(', ')}); the eval photos are rendered together, so their recorded answers keep matching. Unknown: ${unknown.join(', ') || '(none given)'}.`);
      process.exitCode = 2;
      return;
    }
    const browser = await launch();
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const problems: string[] = [];
    for (const c of ATTACK_CASES.filter((x) => only.includes(x.id))) {
      const out = await renderAttackCase(page, c);
      problems.push(...out.problems);
      console.log(`  ${out.receiptHash}  ${c.folder}/receipt  (item photo: ${c.item.sameAs}/item.png)`);
    }
    await browser.close();
    console.log(`Rendered ${only.length} attack case(s) into ${OUT}; every other photo is unchanged.`);
    for (const p of problems) console.error(`  - ${p}`);
    if (problems.length > 0) process.exitCode = 1;
    return;
  }
  const browser = await launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const problems: string[] = [];
  const shots: Shot[] = [];
  const hashOf = (png: Uint8Array) => dHash(decodePng(png));

  // Earlier uploads.
  const historyDir = join(OUT, '_history');
  fresh(historyDir);
  const historyPng = new Map<string, Uint8Array>();
  for (const h of HISTORY) {
    const png = await render(page, h.spec);
    historyPng.set(h.id, png);
    writeFileSync(join(historyDir, `${h.id}.png`), png);
    shots.push({ label: `_history/${h.id}`, hash: hashOf(png), recycledOf: null });
  }
  writeFileSync(
    join(historyDir, 'history.json'),
    json(HISTORY.map((h) => ({ id: h.id, file: `${h.id}.png`, ownerId: h.ownerId, purpose: h.purpose, uploadedAt: h.uploadedAt }))),
  );

  const recycled = async (from: string, code: string, tweak: Tweak): Promise<{ png: Uint8Array; units: number }> => {
    const h = HISTORY.find((x) => x.id === from);
    if (!h) throw new Error(`No history photo ${from}.`);
    const spec = { ...h.spec, code } as ItemPhotoSpec | LinePhotoSpec;
    const png = await render(page, spec, tweak);
    const d = hammingDistance(hashOf(png), hashOf(historyPng.get(from) ?? new Uint8Array()));
    if (d > DUPLICATE_DISTANCE) problems.push(`${from} re-used: ${d} bits from its source (must be at most ${DUPLICATE_DISTANCE}).`);
    return { png, units: spec.kind === 'item' ? spec.units : 0 };
  };

  for (const c of PURCHASE_CASES) {
    const dir = join(OUT, c.id);
    fresh(dir);
    let receipt = await render(page, c.receipt);
    if (c.generatorMetadata) {
      const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/></rdf:RDF></x:xmpmeta>`;
      receipt = insertPngChunks(receipt, [pngITextChunk('XML:com.adobe.xmp', xmp), pngTextChunk('Software', 'Generic Diffusion Studio 2')]);
    }
    let item: Uint8Array;
    let code: string;
    let units: number;
    if ('recycledFrom' in c.item) {
      const r = await recycled(c.item.recycledFrom, c.item.code, c.item.tweak);
      item = r.png;
      code = c.item.code;
      units = r.units;
      shots.push({ label: `${c.id}/item`, hash: hashOf(item), recycledOf: c.item.recycledFrom });
    } else {
      item = await render(page, c.item);
      code = c.item.code;
      units = c.item.units;
      shots.push({ label: `${c.id}/item`, hash: hashOf(item), recycledOf: null });
    }
    shots.push({ label: `${c.id}/receipt`, hash: hashOf(receipt), recycledOf: null });
    writeFileSync(join(dir, 'receipt.png'), receipt);
    writeFileSync(join(dir, 'item.png'), item);
    writeFileSync(join(dir, 'truth.json'), json({ images: ['receipt.png', 'item.png'], outputs: { purchase_proof: purchaseTruth(c.receipt, code, units) } }));
    const { receipt: _r, item: _i, ...rest } = c;
    const reused = 'recycledFrom' in c.item ? c.item.recycledFrom : null;
    writeFileSync(join(dir, 'case.json'), json({ ...rest, files: { receipt: 'receipt.png', item: 'item.png' }, reusedPhoto: reused ? { file: 'item.png', from: reused } : null }));

    const qrIssue = await qrProblem(c.id, receipt, c.receipt.qr);
    if (qrIssue) problems.push(qrIssue);
  }

  for (const c of CHECK_IN_CASES) {
    const dir = join(OUT, c.id);
    fresh(dir);
    let line: Uint8Array;
    let truth: CheckInExtraction;
    if ('recycledFrom' in c.photo) {
      const src = HISTORY.find((h) => h.id === (c.photo as { recycledFrom: string }).recycledFrom)?.spec as LinePhotoSpec;
      line = (await recycled(c.photo.recycledFrom, c.photo.code, c.photo.tweak)).png;
      truth = lineTruth({ ...src, code: c.photo.code });
      shots.push({ label: `${c.id}/line`, hash: hashOf(line), recycledOf: c.photo.recycledFrom });
    } else {
      line = await render(page, c.photo);
      truth = lineTruth(c.photo);
      shots.push({ label: `${c.id}/line`, hash: hashOf(line), recycledOf: null });
    }
    writeFileSync(join(dir, 'line.png'), line);
    writeFileSync(join(dir, 'truth.json'), json({ images: ['line.png'], outputs: { check_in_photo: truth } }));
    const { photo: _p, ...rest } = c;
    const reused = 'recycledFrom' in c.photo ? c.photo.recycledFrom : null;
    writeFileSync(join(dir, 'case.json'), json({ ...rest, files: { line: 'line.png' }, reusedPhoto: reused ? { file: 'line.png', from: reused } : null }));
  }
  // The attack-only known limits (D-147), after the cases whose item photos they copy.
  for (const c of ATTACK_CASES) problems.push(...(await renderAttackCase(page, c)).problems);
  await browser.close();

  // Every fresh photo must stay clear of the earlier uploads (the eval compares
  // each case against them), and the hero photos must stay clear of each other
  // (the demo uploads them one after another). Re-used photos only match their
  // source. Other pairs are reported: photos of the same product on similar
  // backgrounds can come close under a 64-bit hash.
  let closest = 64;
  let closestPair = '';
  for (let i = 0; i < shots.length; i++) {
    for (let j = i + 1; j < shots.length; j++) {
      const a = shots[i]!;
      const b = shots[j]!;
      const related = (x: Shot, y: Shot) => x.recycledOf !== null && `_history/${x.recycledOf}` === y.label;
      if (related(a, b) || related(b, a)) continue;
      const d = hammingDistance(a.hash, b.hash);
      if (d < closest) {
        closest = d;
        closestPair = `${a.label} and ${b.label}`;
      }
      const history = a.label.startsWith('_history/') || b.label.startsWith('_history/');
      const hero = HERO_CASES.some((h) => a.label.startsWith(`${h}/`)) && HERO_CASES.some((h) => b.label.startsWith(`${h}/`));
      if ((history || hero) && d <= DUPLICATE_DISTANCE) problems.push(`${a.label} and ${b.label} are only ${d} bits apart.`);
    }
  }
  const files = shots.length;
  console.log(`Rendered ${files} photos for ${PURCHASE_CASES.length + CHECK_IN_CASES.length} cases into ${OUT}.`);
  console.log(`Closest pair of unrelated photos: ${closest} of 64 bits apart (${closestPair}); duplicates are ${DUPLICATE_DISTANCE} or fewer.`);
  for (const s of shots) console.log(`  ${s.hash}  ${s.label}${s.recycledOf ? `  (re-used ${s.recycledOf})` : ''}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} fixture problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
  }
}

await main();
