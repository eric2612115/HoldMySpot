import { createHmac, randomBytes } from 'node:crypto';
import { ONE_TIME_CODE_ALPHABET } from '@holdmyspot/shared';

/**
 * One-time codes: the claim's check-in code (in the line photo), the job's
 * proof code (next to the item) and the local handover code (requester).
 * Derived from a per-market secret, so a demo run with a fixed seed gives
 * the same codes every time while normal runs stay unpredictable.
 */

export function newCodeSecret(): string {
  return randomBytes(24).toString('hex');
}

function stream(secret: string, label: string): () => number {
  let counter = 0;
  let block = Buffer.alloc(0);
  let i = 0;
  return () => {
    if (i >= block.length) {
      block = createHmac('sha256', secret).update(`${label}:${counter++}`).digest();
      i = 0;
    }
    return block[i++] ?? 0;
  };
}

/** A code from the shared alphabet (no look-alike characters). */
export function deriveCode(secret: string, label: string, length = 5, alphabet = ONE_TIME_CODE_ALPHABET): string {
  const next = stream(secret, label);
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    const byte = next();
    if (byte < limit) out += alphabet[byte % alphabet.length];
  }
  return out;
}

/** A numeric code, for the handover code the requester reads out. */
export function deriveDigits(secret: string, label: string, length = 4): string {
  return deriveCode(secret, label, length, '0123456789');
}
