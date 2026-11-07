import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FilePurpose } from '@holdmyspot/shared';
import type { App } from '../app/app.ts';
import { saveUpload } from '../app/files.ts';
import { SERVER_ROOT } from '../config.ts';
import type { StoredFile } from '../db/store.ts';

/**
 * Rendered demo photos (server/fixtures/proofs, made by `npm run ai:render`)
 * for the demo director. Each case folder holds the photos, `truth.json`
 * (what a careful reader copies from them; the rules-only AI answers from it)
 * and `case.json` (the job or claim the photo was drawn for, with the
 * one-time code printed in it).
 *
 * A demo market pins those codes on the records the script creates
 * (App.pinCode, deterministic markets only), so the photo the queuer uploads
 * shows the code the server expects and the real AI services read it end to
 * end: hashes, receipt QR from pixels, duplicate checks, shared rules.
 * When a fixture is missing the director falls back to placeholder images
 * with a simulated scenario, so the script still runs.
 */

export function proofFixturesDir(): string {
  return resolve(process.env.HMS_AI_PROOF_FIXTURES_DIR?.trim() || join(SERVER_ROOT, 'fixtures', 'proofs'));
}

/** Bytes of `<case>/<file>` under the fixtures folder, or null when it is not there. */
export function fixtureBytes(relPath: string): Buffer | null {
  const path = join(proofFixturesDir(), relPath);
  return existsSync(path) ? readFileSync(path) : null;
}

interface FixtureCase {
  claim?: { code?: string };
  job?: { proofCode?: string };
}

/** The one-time code a fixture case was drawn with (check-in code or proof code), or null. */
export function fixtureCode(caseId: string): string | null {
  const path = join(proofFixturesDir(), caseId, 'case.json');
  if (!existsSync(path)) return null;
  try {
    const c = JSON.parse(readFileSync(path, 'utf8')) as FixtureCase;
    return c.claim?.code ?? c.job?.proofCode ?? null;
  } catch {
    return null;
  }
}

/**
 * Pins the code of a fixture case on the next record for `subject`
 * (`<queuerId>@<shopId>` for a check-in, `<requesterId>><queuerId>@<shopId>` for a proof).
 * Returns false when the fixture is missing (the record keeps its derived code).
 */
export function pinFixtureCode(app: App, kind: 'checkin' | 'proof', subject: string, caseId: string): boolean {
  const code = fixtureCode(caseId);
  if (!code) return false;
  app.pinCode(kind, subject, code);
  return true;
}

interface HistoryEntry {
  id: string;
  file: string;
  ownerId: string;
  purpose: FilePurpose;
  uploadedAt: string;
}

/**
 * Earlier uploads by other queuers (server/fixtures/proofs/_history), stored as
 * historical files at their original times, so duplicate checks have a past to
 * compare with. Owner ids like `job-h-jo` map to the persona `jo`.
 */
export async function stageHistory(app: App): Promise<number> {
  const listPath = join(proofFixturesDir(), '_history', 'history.json');
  if (!existsSync(listPath)) return 0;
  const entries = JSON.parse(readFileSync(listPath, 'utf8')) as HistoryEntry[];
  let n = 0;
  for (const e of entries) {
    const bytes = fixtureBytes(join('_history', e.file));
    const owner = /-h-([a-z]+)$/.exec(e.ownerId)?.[1];
    const at = Date.parse(e.uploadedAt);
    if (!bytes || !owner || !app.store.users.get(owner) || !Number.isFinite(at)) continue;
    await app.atTime(at, () => saveUpload(app, owner, e.purpose, 'image/png', bytes, { historical: true, dHash: uploadHash(app) }));
    n++;
  }
  return n;
}

/** The AI services' perceptual hash for uploads, when the loaded AI port has one. */
export function uploadHash(app: App): ((bytes: Uint8Array, type: string) => Promise<string | null>) | null {
  const ai = app.ai;
  return ai.dHash ? (bytes, type) => ai.dHash!(bytes, type) : null;
}

/** Uploads a rendered fixture photo when it exists, else `fallback()` (a placeholder). */
export async function uploadFixtureOr(
  app: App,
  ownerId: string,
  purpose: FilePurpose,
  relPath: string | null,
  scenario: string | null,
  fallback: () => Promise<StoredFile>,
  opts: { historical?: boolean } = {},
): Promise<StoredFile> {
  const bytes = relPath ? fixtureBytes(relPath) : null;
  if (!bytes) return fallback();
  return saveUpload(app, ownerId, purpose, 'image/png', bytes, { scenario, historical: opts.historical ?? false, dHash: uploadHash(app) });
}
