import { HEADERS } from '@holdmyspot/shared';
import type { FilePurpose, FileRef } from '@holdmyspot/shared';
import { ApiError } from '../../services/api';

/**
 * Photo uploads: `POST /api/files?purpose=` with the raw bytes (docs/API.md).
 * A JPEG, PNG or WebP is sent exactly as taken, so the server's hashes (and
 * the duplicate check) see the real file. Anything else (a HEIC from a phone
 * camera) or anything over the 8 MB limit is redrawn as a JPEG first.
 */

const BASE = ((import.meta.env.VITE_HMS_API as string | undefined) ?? '').replace(/\/$/, '');
const SENDABLE = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 8 * 1024 * 1024;

async function asJpeg(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('This photo format cannot be read here. Use a JPEG or PNG.');
  });
  const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The photo could not be prepared.'))), 'image/jpeg', 0.88));
}

/**
 * `scenario` (zero-key demo only): the simulated reading the server's rules-only reader gives a photo
 * it has no recording for (`?fixture=`, D-128). The phone sends the one the queuer picked.
 */
export async function uploadPhoto(as: string, purpose: FilePurpose, file: Blob, scenario: string | null = null): Promise<FileRef> {
  const body = SENDABLE.includes(file.type) && file.size <= MAX_BYTES ? file : await asJpeg(file);
  const fixture = scenario ? `&fixture=${encodeURIComponent(scenario)}` : '';
  const res = await fetch(`${BASE}/api/files?purpose=${encodeURIComponent(purpose)}${fixture}`, {
    method: 'POST',
    headers: { 'content-type': body.type, [HEADERS.persona]: as },
    body,
  });
  if (!res.ok) {
    let parsed = null;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    throw new ApiError(res.status, parsed);
  }
  return ((await res.json()) as { file: FileRef }).file;
}
