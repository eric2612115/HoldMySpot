import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError, DUPLICATE_HAMMING_MAX, hammingHex } from '@holdmyspot/shared';
import type { FilePurpose, FileRef } from '@holdmyspot/shared';
import type { StoredFile } from '../db/store.ts';
import type { PhotoInput, PriorPhoto } from '../ports/ai.ts';
import { imageSize, sha256Hex, sniffImageType } from '../util/images.ts';
import type { App, Viewer } from './app.ts';

/** Photo uploads (docs/DECISIONS.md D-31): raw bytes in, sha256 and size out; served only to participants and ops. */

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;

/** Optional hook for a perceptual hash (the AI services provide one); null when not available. */
export type DHashFn = (bytes: Uint8Array, contentType: FileRef['contentType']) => Promise<string | null>;

export async function saveUpload(
  app: App,
  ownerId: string,
  purpose: FilePurpose,
  declaredType: string | undefined,
  bytes: Uint8Array,
  opts: { scenario?: string | null; historical?: boolean; dHash?: DHashFn | null; jobId?: string | null } = {},
): Promise<StoredFile> {
  if (bytes.byteLength === 0) throw new ContractError('BAD_REQUEST', 'The upload is empty.');
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new ContractError('BAD_REQUEST', 'Photos can be at most 8 MB.');
  const type = sniffImageType(bytes);
  if (!type) throw new ContractError('BAD_REQUEST', 'Only JPEG, PNG or WebP photos are accepted.');
  if (declaredType && declaredType.split(';')[0]!.trim() !== type) {
    throw new ContractError('BAD_REQUEST', `The photo is ${type}, not ${declaredType}.`);
  }
  const size = imageSize(bytes, type);
  const sha256 = sha256Hex(bytes);
  let dHash: string | null = null;
  if (opts.dHash) {
    try {
      dHash = await opts.dHash(bytes, type);
    } catch {
      dHash = null;
    }
  }
  return app.tx(() => {
    const id = app.nextId('file');
    const dir = app.config.uploadDir;
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.${EXT[type]}`);
    writeFileSync(path, bytes);
    const now = app.now();
    const ref: FileRef = {
      id,
      purpose,
      contentType: type,
      bytes: bytes.byteLength,
      sha256,
      dHash,
      width: size?.width ?? null,
      height: size?.height ?? null,
      url: `/api/files/${id}`,
      createdAt: now,
    };
    const file: StoredFile = {
      id,
      ref,
      ownerId,
      purpose,
      path,
      scenario: opts.scenario ?? null,
      jobId: opts.jobId ?? null,
      claimId: null,
      historical: opts.historical ?? false,
      createdAt: now,
    };
    app.store.files.insert(file);
    return file;
  });
}

/** A file the persona uploaded for this purpose and has not used elsewhere. */
export function ownFile(app: App, userId: string, fileId: string, purpose: FilePurpose, use: { claimId?: string; jobId?: string }): StoredFile {
  const f = app.store.files.must(fileId, 'file');
  if (f.ownerId !== userId) throw new ContractError('FORBIDDEN', 'That photo was uploaded by someone else.');
  if (f.purpose !== purpose) throw new ContractError('BAD_REQUEST', `That photo was uploaded as ${f.purpose}, not ${purpose}.`);
  if ((f.claimId && f.claimId !== use.claimId) || (f.jobId && f.jobId !== use.jobId)) {
    throw new ContractError('CONFLICT', 'That photo was already used for another check.');
  }
  return f;
}

export function canReadFile(app: App, viewer: Viewer, f: StoredFile): boolean {
  if (viewer.ops || viewer.userId === f.ownerId) return true;
  if (f.jobId) {
    const job = app.store.jobs.get(f.jobId);
    if (job && (job.requesterId === viewer.userId || job.queuerId === viewer.userId)) return true;
  }
  if (f.claimId) {
    const jobs = app.store.jobs.where('claim_id = ?', f.claimId);
    if (jobs.some((j) => j.requesterId === viewer.userId)) return true;
  }
  return false;
}

export function readStoredFile(f: StoredFile): Buffer {
  return readFileSync(f.path);
}

export function photoInput(f: StoredFile): PhotoInput {
  return {
    fileId: f.id,
    contentType: f.ref.contentType,
    path: f.path,
    sha256: f.ref.sha256,
    dHash: f.ref.dHash,
    scenario: f.scenario,
    bytes: async () => new Uint8Array(await readFile(f.path)),
  };
}

/** Earlier photos from other claims and jobs (and historical seed photos). */
export function priorPhotos(app: App, exclude: { claimId?: string | null; jobId?: string | null; before: number }): PriorPhoto[] {
  return app.store.files
    .all()
    .filter((f) => (f.historical || f.claimId !== null || f.jobId !== null) && f.createdAt <= exclude.before)
    .filter((f) => !(exclude.claimId && f.claimId === exclude.claimId) && !(exclude.jobId && f.jobId === exclude.jobId))
    .map((f) => ({ fileId: f.id, sha256: f.ref.sha256, dHash: f.ref.dHash, at: f.createdAt }));
}

/** The first earlier photo with the same bytes or a dHash within 6 bits, or null. */
export function duplicateOf(photo: Pick<PhotoInput, 'fileId' | 'sha256' | 'dHash'>, prior: readonly PriorPhoto[]): string | null {
  for (const p of prior) {
    if (p.fileId === photo.fileId) continue;
    if (p.sha256 === photo.sha256) return p.fileId;
    if (p.dHash && photo.dHash && hammingHex(p.dHash, photo.dHash) <= DUPLICATE_HAMMING_MAX) return p.fileId;
  }
  return null;
}
