import { evaluateCheckIn, evaluatePurchase, receiptCapture } from '@holdmyspot/shared';
import type { AiStamp, CheckInContext, LinePhotoReading, ProofCheck, ProofCheckCode, PurchaseContext, PurchaseReading, VerdictStatus } from '@holdmyspot/shared';
import type { AiImage, AiProvider } from '@holdmyspot/shared/ports';
import type { CheckInPhotoInput, PhotoInput, PriorPhoto, PurchaseProofInput } from '../ports/ai.ts';
import { AiError } from './errors.ts';
import { imageForModel, sniffImageType } from './image.ts';
import { findDuplicates, photoFacts } from './phash.ts';
import type { PhotoFacts } from './phash.ts';
import { CHECK_IN_PROMPT, CHECK_IN_SYSTEM, PURCHASE_PROMPT, PURCHASE_SYSTEM } from './prompts.ts';
import { parseReceiptQr, qrDecoderAvailable, readQrCodes } from './qr.ts';
import type { ReceiptQr } from './qr.ts';
import { fixtureKey } from './replay.ts';
import { CHECK_IN_SCHEMA, PURCHASE_PROOF_SCHEMA } from './schemas.ts';
import type { CheckInExtraction, JsonSchema, PurchaseExtraction } from './schemas.ts';
import { formatCents, formatLocal } from './text.ts';
import { parseLocalDateTime } from './time.ts';
import type { CheckInResult, PhotoReport, PurchaseResult } from './types.ts';

/**
 * Proof pipelines (docs/AI-SERVICES.md 4.1 and 4.2). Models read; the shared
 * rules (`evaluateCheckIn`, `evaluatePurchase` in @holdmyspot/shared) decide,
 * the same rules the server's rules-only fake uses.
 *
 * What this module adds around the rules:
 * - deterministic pre-steps: SHA-256, dHash, image-generator metadata, and
 *   the receipt QR decoded from the receipt pixels (jsQR);
 * - the model read (structured output, validated), normalised into the
 *   shared reading: receipt numbers without dashes, store IDs as digits,
 *   printed times as "YYYY-MM-DD HH:MM";
 * - its own duplicate comparison against earlier photos when the core did
 *   not find one (the core may not have dHashes for every upload);
 * - confidence and plain reasons for ops.
 *
 * A provider error, timeout or refusal is thrown as AiError; the core turns
 * it into `needs_review`, so it can never pass a proof.
 */

async function toAiImage(bytes: Uint8Array): Promise<AiImage> {
  if (!sniffImageType(bytes)) throw new AiError('unsupported', 'A photo is not a JPEG, PNG or WebP image.');
  const sent = await imageForModel(bytes);
  return { mime: sent.mime, base64: Buffer.from(sent.bytes).toString('base64') };
}

async function readPhotos<T>(
  provider: AiProvider,
  task: 'purchase_proof' | 'check_in_photo',
  photos: Uint8Array[],
  call: { system: string; prompt: string; schemaName: string; schema: JsonSchema; effort: 'low' | 'medium' | 'high' },
): Promise<{ data: T; stamp: AiStamp }> {
  const images = await Promise.all(photos.map(toAiImage));
  const res = await provider.json<T>({
    task,
    system: call.system,
    prompt: call.prompt,
    images,
    schemaName: call.schemaName,
    schema: call.schema,
    effort: call.effort,
    fixtureKey: fixtureKey({ task, schemaName: call.schemaName, system: call.system, prompt: call.prompt, images }),
  });
  return { data: res.data, stamp: res.stamp };
}

export function normalizeInvoiceNumber(s: string | null | undefined): string | null {
  const n = (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return n || null;
}

function digitsOnly(s: string | null | undefined): string | null {
  const d = (s ?? '').replace(/\D/g, '');
  return d || null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** The model's answer (plus QR and metadata) as the shared rules expect it. */
export function toPurchaseReading(ex: PurchaseExtraction, qr: ReceiptQr | null, generatorMetadata: boolean): PurchaseReading {
  const t = parseLocalDateTime(ex.issuedAtLocal);
  return {
    printedName: ex.printedName?.trim() || null,
    sellerTaxId: digitsOnly(ex.sellerTaxId),
    invoiceNumber: normalizeInvoiceNumber(ex.invoiceNumber),
    issuedAtLocal: t ? `${t.year}-${pad2(t.month)}-${pad2(t.day)} ${pad2(t.hour)}:${pad2(t.minute)}` : null,
    currency: ex.currency,
    lines: ex.lines.map((l) => ({ name: l.name.trim(), qty: l.qty, unitMinor: l.unitMinor, totalMinor: l.totalMinor })),
    totalMinor: ex.totalMinor,
    qr: qr ? { invoiceNumber: qr.invoiceNumber, issuedDate: qr.issuedDate, sellerTaxId: qr.sellerTaxId, totalMinor: qr.totalAmount } : null,
    itemPhoto: { codeSeen: ex.itemPhoto.codeSeen, unitsVisible: ex.itemPhoto.unitsVisible },
    anomalies: ex.anomalies,
    generatorMetadata,
  };
}

export function toLineReading(ex: CheckInExtraction): LinePhotoReading {
  return { lineVisible: ex.lineVisible, peopleAhead: ex.peopleAhead, codeSeen: ex.codeSeen, storefrontText: ex.storefrontText?.trim() || null };
}

/** The first earlier photo that is the same bytes or within 6 dHash bits of one of these, or null. */
export function ownDuplicate(photos: readonly PhotoFacts[], prior: readonly PriorPhoto[]): string | null {
  const refs = prior.map((p) => ({ fileId: p.fileId, ownerId: 'earlier', sha256: p.sha256, dHash: p.dHash }));
  for (const f of photos) {
    const hit = findDuplicates(f, refs, 'this')[0];
    if (hit) return hit.fileId;
  }
  return null;
}

/** Checks decided by hashes, QR data, metadata or arithmetic alone (not by what a model read). */
function basisOf(code: ProofCheckCode, reading: PurchaseReading | null): 'rule' | 'read' {
  if (code === 'geofence' || code === 'duplicate_photo' || code === 'generator_metadata' || code === 'within_retail_cap' || code === 'listed_price') return 'rule';
  if (code === 'shop_match' && reading?.qr?.sellerTaxId) return 'rule';
  return 'read';
}

export function confidenceOf(status: VerdictStatus, checks: readonly ProofCheck[], anomalies: number, reading: PurchaseReading | null): number {
  const failedHard = checks.filter((c) => !c.ok && c.weight === 'hard');
  const failedSoft = checks.filter((c) => !c.ok && c.weight === 'soft');
  let v: number;
  if (status === 'passed') v = 0.97 - 0.06 * anomalies;
  else if (status === 'failed') v = failedHard.some((c) => basisOf(c.code, reading) === 'rule') ? 0.99 : Math.min(0.95, 0.8 + 0.05 * (failedHard.length - 1));
  else v = failedSoft.every((c) => basisOf(c.code, reading) === 'rule') ? 0.9 : 0.6;
  return Math.round(Math.max(0.5, Math.min(0.99, v)) * 100) / 100;
}

export function reasonsOf(checks: readonly ProofCheck[], facts: string[]): string[] {
  const failed = checks.filter((c) => !c.ok).sort((a, b) => (a.weight === b.weight ? 0 : a.weight === 'hard' ? -1 : 1));
  return failed.length > 0 ? failed.map((c) => c.detail) : facts;
}

function report(role: PhotoReport['role'], fileId: string | null, f: PhotoFacts): PhotoReport {
  return { role, fileId, sha256: f.sha256, dHash: f.dHash, width: f.width, height: f.height, generator: f.generator };
}

async function bytesOf(p: PhotoInput): Promise<Uint8Array> {
  return p.bytes();
}

/**
 * What the shared rules compare a purchase reading with: the job, the shop and
 * item, the check-in and upload times, and the duplicate found by the
 * pre-steps. Exported so the ablation (server/scripts/ablation) can decide the
 * same proof again on another reading with exactly this context.
 */
export function purchaseContext(input: PurchaseProofInput, duplicateOf: string | null): PurchaseContext {
  const { job, shop, item } = input;
  return {
    shop,
    item,
    job: { qty: job.qty, proofCode: job.proofCode ?? '', retailCapCents: job.caps.retailCents, twdPerUsd: job.fx?.twdPerUsd ?? null },
    checkedInAt: input.checkedInAt,
    uploadedAt: input.uploadedAt,
    duplicateOf,
  };
}

/** What the shared rules compare a line-photo reading with (see purchaseContext). */
export function checkInContext(input: CheckInPhotoInput, duplicateOf: string | null): CheckInContext {
  return { code: input.claim.checkInCode ?? '', geofence: input.geofence, duplicateOf };
}

/** Receipt plus item photo: pre-steps, model read, shared rules. */
export async function purchaseProof(input: PurchaseProofInput, provider: AiProvider): Promise<PurchaseResult> {
  const [rb, ib] = await Promise.all([bytesOf(input.receipt), bytesOf(input.itemPhoto)]);
  const [rf, itf] = await Promise.all([photoFacts(rb), photoFacts(ib)]);
  const qr = rf.pixels ? await readQrCodes(rf.pixels) : { texts: [], decoder: await qrDecoderAvailable() };
  const receiptQr = parseReceiptQr(qr.texts);
  const read = await readPhotos<PurchaseExtraction>(provider, 'purchase_proof', [rb, ib], {
    system: PURCHASE_SYSTEM,
    prompt: PURCHASE_PROMPT,
    schemaName: 'purchase_proof',
    schema: PURCHASE_PROOF_SCHEMA,
    effort: 'medium',
  });
  const reading = toPurchaseReading(read.data, receiptQr, rf.generator.length + itf.generator.length > 0);
  const duplicateOf = input.duplicateOf ?? ownDuplicate([itf, rf], input.priorPhotos);
  const { job, shop, item } = input;
  const verdict = evaluatePurchase(reading, purchaseContext(input, duplicateOf));
  const facts: string[] = [];
  if (verdict.retailCents !== null && verdict.receiptTotal) {
    const at = reading.issuedAtLocal?.slice(11, 16) ?? '?';
    const rate = verdict.receiptTotal.currency === 'TWD' && job.fx ? ` at ${job.fx.twdPerUsd} TWD per USD` : '';
    facts.push(`Receipt from ${shop.name} at ${at}, total ${formatLocal(verdict.receiptTotal)}; the ${item.shortName.toLowerCase()} lines come to ${formatCents(verdict.retailCents)}${rate}.`);
    const cap = receiptCapture(job.caps, verdict.retailCents, job.mode);
    facts.push(`Capture ${formatCents(cap.amountCents)}: retail ${formatCents(cap.retailCents)}, fee ${formatCents(cap.feeCents)} and processing ${formatCents(cap.processingCents)} at cost.`);
  }
  if (receiptQr) facts.push(`Receipt QR ${receiptQr.invoiceNumber} from store ${receiptQr.sellerTaxId} was read from the photo.`);
  return {
    ...verdict,
    ai: read.stamp,
    confidence: confidenceOf(verdict.status, verdict.checks, reading.anomalies.length, reading),
    reasons: reasonsOf(verdict.checks, facts),
    photos: [report('receipt', input.receipt.fileId, rf), report('item', input.itemPhoto.fileId, itf)],
    extraction: read.data,
    qr: { texts: qr.texts, decoder: qr.decoder, receiptQr },
    duplicateOf,
    reading,
  };
}

/** Line photo at check-in: pre-steps, model read, shared rules. */
export async function checkInPhoto(input: CheckInPhotoInput, provider: AiProvider): Promise<CheckInResult> {
  const bytes = await bytesOf(input.photo);
  const f = await photoFacts(bytes);
  const read = await readPhotos<CheckInExtraction>(provider, 'check_in_photo', [bytes], {
    system: CHECK_IN_SYSTEM,
    prompt: CHECK_IN_PROMPT,
    schemaName: 'check_in_photo',
    schema: CHECK_IN_SCHEMA,
    effort: 'low',
  });
  const reading = toLineReading(read.data);
  const duplicateOf = input.duplicateOf ?? ownDuplicate([f], input.priorPhotos);
  const verdict = evaluateCheckIn(reading, checkInContext(input, duplicateOf));
  const facts = [verdict.summary];
  if (reading.storefrontText) facts.push(`Storefront reads "${reading.storefrontText}".`);
  return {
    ...verdict,
    ai: read.stamp,
    confidence: confidenceOf(verdict.status, verdict.checks, 0, null),
    reasons: reasonsOf(verdict.checks, facts),
    photos: [report('line', input.photo.fileId, f)],
    extraction: read.data,
    qr: null,
    duplicateOf,
    reading,
  };
}
