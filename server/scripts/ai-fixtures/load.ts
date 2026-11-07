import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_RULES, findItem, findShop, jobCaps } from '@holdmyspot/shared';
import type { Claim, FileRef, Item, Job, ProofCheckCode, Shop } from '@holdmyspot/shared';
import { SERVER_ROOT } from '../../src/ai/config.ts';
import { sniffImageType } from '../../src/ai/image.ts';
import { photoFacts } from '../../src/ai/phash.ts';
import type { CheckInExtraction, PurchaseExtraction } from '../../src/ai/schemas.ts';
import type { CheckInPhotoInput, PhotoInput, PriorPhoto, PurchaseProofInput } from '../../src/ports/ai.ts';

/**
 * Loads the rendered proof fixtures (server/fixtures/proofs) and builds the
 * inputs the server's AiPort takes, exactly as the core would: full Job and
 * Claim records, photo inputs with bytes on disk, and every earlier upload as
 * a prior photo. Used by scripts/ai-eval.ts and the AI tests.
 */

export const PROOFS_DIR = join(SERVER_ROOT, 'fixtures', 'proofs');

export interface CaseExpectation {
  status: 'passed' | 'failed' | 'needs_review';
  hard: ProofCheckCode[];
  soft: ProofCheckCode[];
  retailCents?: number;
  /** Shop price after the cap plus the matched fee; PayPal captures it with processing at cost on top (D-105). */
  captureCents?: number;
  peopleAhead?: number;
}

interface CaseFileBase {
  id: string;
  description: string;
  shopId: string;
  itemId: string;
  queuer: string;
  expect: CaseExpectation;
  /** A photo of this case that is an earlier upload re-used (with its code edited). */
  reusedPhoto: { file: string; from: string } | null;
}

export interface PurchaseCaseFile extends CaseFileBase {
  kind: 'purchase';
  job: { id: string; qty: number; proofCode: string; feeCents: number; retailCapCentsPerUnit: number; shippingCents: number; mode: 'ship' | 'local' };
  requester: string;
  checkedInAt: string;
  uploadedAt: string;
  files: { receipt: string; item: string };
}

export interface CheckInCaseFile extends CaseFileBase {
  kind: 'check_in';
  claim: { id: string; code: string };
  geofence: { ok: boolean; distanceM: number; radiusM: number };
  at: string;
  files: { line: string };
}

export type CaseFile = PurchaseCaseFile | CheckInCaseFile;

export interface LoadedCase {
  dir: string;
  data: CaseFile;
  truth: { purchase_proof?: PurchaseExtraction; check_in_photo?: CheckInExtraction };
}

export function listCases(dir: string = PROOFS_DIR): LoadedCase[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith('_') && existsSync(join(dir, name, 'case.json')))
    .sort()
    .map((name) => {
      const caseDir = join(dir, name);
      const data = JSON.parse(readFileSync(join(caseDir, 'case.json'), 'utf8')) as CaseFile;
      const truth = JSON.parse(readFileSync(join(caseDir, 'truth.json'), 'utf8')) as { outputs: LoadedCase['truth'] };
      return { dir: caseDir, data, truth: truth.outputs };
    });
}

export async function photoInput(file: string, fileId: string): Promise<PhotoInput> {
  const bytes = new Uint8Array(readFileSync(file));
  const facts = await photoFacts(bytes);
  return {
    fileId,
    contentType: (sniffImageType(bytes) ?? 'image/png') as FileRef['contentType'],
    path: file,
    sha256: facts.sha256,
    dHash: facts.dHash,
    scenario: null,
    bytes: async () => bytes,
  };
}

/** Every earlier upload in `_history`, as the core lists them (other jobs and claims). */
export async function loadHistory(dir: string = PROOFS_DIR): Promise<PriorPhoto[]> {
  const historyDir = join(dir, '_history');
  if (!existsSync(join(historyDir, 'history.json'))) return [];
  const list = JSON.parse(readFileSync(join(historyDir, 'history.json'), 'utf8')) as { id: string; file: string; uploadedAt: string }[];
  const out: PriorPhoto[] = [];
  for (const h of list) {
    const facts = await photoFacts(new Uint8Array(readFileSync(join(historyDir, h.file))));
    out.push({ fileId: h.id, sha256: facts.sha256, dHash: facts.dHash, at: Date.parse(h.uploadedAt) });
  }
  return out;
}

function shopItem(c: CaseFile): { shop: Shop; item: Item } {
  const shop = findShop(c.shopId);
  const item = findItem(c.itemId);
  if (!shop || !item) throw new Error(`Case ${c.id} names an unknown shop or item.`);
  return { shop, item };
}

function claimFor(c: CaseFile, opts: { id: string; code: string | null; checkedInAt: number; geofence?: { distanceM: number } }): Claim {
  const { shop } = shopItem(c);
  return {
    id: opts.id,
    askId: `ask-${opts.id}`,
    queuerId: c.queuer.toLowerCase(),
    queuerName: c.queuer,
    shopId: c.shopId,
    windowStartsAt: opts.checkedInAt - 20 * 60_000,
    windowEndsAt: opts.checkedInAt + 10 * 60_000,
    status: 'checked_in',
    checkInCode: opts.code,
    arrival: { at: opts.checkedInAt, lngLat: shop.lngLat, accuracyM: 12, distanceM: opts.geofence?.distanceM ?? 30 },
    linePhotoProofId: null,
    checkedInAt: opts.checkedInAt,
    createdAt: opts.checkedInAt - 40 * 60_000,
    updatedAt: opts.checkedInAt,
  };
}

export async function purchaseInput(lc: LoadedCase, prior: PriorPhoto[]): Promise<PurchaseProofInput> {
  const c = lc.data as PurchaseCaseFile;
  const { shop, item } = shopItem(c);
  const checkedInAt = Date.parse(c.checkedInAt);
  const uploadedAt = Date.parse(c.uploadedAt);
  const caps = jobCaps({ qty: c.job.qty, retailCapCents: c.job.retailCapCentsPerUnit, shippingBudgetCents: c.job.shippingCents }, { qty: c.job.qty, feeCents: c.job.feeCents });
  const claim = claimFor(c, { id: `claim-${c.job.id}`, code: null, checkedInAt });
  const job: Job = {
    id: c.job.id,
    matchId: `match-${c.job.id}`,
    bidId: `bid-${c.job.id}`,
    askId: claim.askId,
    claimId: claim.id,
    requesterId: c.requester.split(' ')[0]?.toLowerCase() ?? 'requester',
    requesterName: c.requester,
    queuerId: claim.queuerId,
    queuerName: c.queuer,
    shopId: c.shopId,
    itemId: c.itemId,
    qty: c.job.qty,
    feeCents: c.job.feeCents,
    mode: c.job.mode,
    status: 'proof_submitted',
    failure: null,
    proofCode: c.job.proofCode,
    handoverCode: null,
    fx: item.retail.currency === 'TWD' ? { twdPerUsd: DEFAULT_RULES.fxTwdPerUsd, lockedAt: checkedInAt } : null,
    caps,
    amounts: { retailCents: null, shippingCents: null, capturedCents: 0, refundedCents: 0, paidOutCents: 0 },
    shipment: null,
    history: [{ status: 'claimed', at: checkedInAt - 30 * 60_000 }],
    disputed: false,
    createdAt: checkedInAt - 30 * 60_000,
    updatedAt: uploadedAt,
  };
  return {
    job,
    claim,
    shop,
    item,
    receipt: await photoInput(join(lc.dir, c.files.receipt), `${c.id}-receipt`),
    itemPhoto: await photoInput(join(lc.dir, c.files.item), `${c.id}-item`),
    checkedInAt,
    uploadedAt,
    duplicateOf: null,
    priorPhotos: prior,
    now: uploadedAt,
  };
}

export async function checkInInput(lc: LoadedCase, prior: PriorPhoto[]): Promise<CheckInPhotoInput> {
  const c = lc.data as CheckInCaseFile;
  const { shop, item } = shopItem(c);
  const at = Date.parse(c.at);
  return {
    claim: { ...claimFor(c, { id: c.claim.id, code: c.claim.code, checkedInAt: at, geofence: c.geofence }), status: 'arrived', checkedInAt: null },
    shop,
    item,
    photo: await photoInput(join(lc.dir, c.files.line), `${c.id}-line`),
    geofence: c.geofence,
    duplicateOf: null,
    priorPhotos: prior,
    now: at,
  };
}
