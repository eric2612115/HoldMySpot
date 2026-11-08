import type { ProofCheckCode } from '@holdmyspot/shared';

/** What a check used: code alone (hashes, the receipt QR, file metadata, location) or what the model read. */
export type Basis = 'code' | 'reading';

/**
 * Where a failed check got its answer. Code alone: a photo hash, file metadata,
 * the phone's location, or the store ID in the receipt QR (which the rules use
 * before any printed ID, `evaluatePurchase`). Everything else compares something
 * the model read. The ablation (server/scripts/ablation, D-140) and `npm run
 * attack` (scripts/attack.mjs, D-149) both label a failed check with this, so
 * "stopped by" in the attack table follows from the checks that failed.
 */
export function checkBasis(code: ProofCheckCode, qrStoreId: boolean): { basis: Basis; source: string } {
  const at = (basis: Basis, source: string) => ({ basis, source });
  switch (code) {
    case 'geofence':
      return at('code', "phone's location");
    case 'duplicate_photo':
      return at('code', 'photo hash');
    case 'generator_metadata':
      return at('code', 'file metadata');
    case 'shop_match':
      return qrStoreId ? at('code', 'receipt QR store ID') : at('reading', 'printed shop name or store ID');
    case 'qr_matches_print':
      return at('reading', 'printed receipt number, date and total against the QR');
    case 'time_window':
      return at('reading', 'printed time');
    case 'totals_add_up':
      return at('reading', 'lines and total');
    case 'qty_within_limit':
      return at('reading', 'quantity');
    case 'item_match':
      return at('reading', 'line names');
    case 'within_retail_cap':
    case 'listed_price':
      return at('reading', 'price');
    case 'code_visible':
      return at('reading', 'one-time code');
    case 'line_visible':
      return at('reading', 'line of people');
  }
}
