import { HERO, SECONDS_PER_PERSON, epochToZonedLocal } from '@holdmyspot/shared';
import type { LinePhotoReading, PurchaseReading } from '@holdmyspot/shared';
import type { CheckInPhotoInput, PurchaseProofInput } from '../ports/ai.ts';

/**
 * Simulated photo readings for fake mode. A scenario name is attached to an
 * upload (`POST /api/files?fixture=...` in fake mode, or by the demo
 * director) and the fake AI returns what a model would have read from such a
 * photo. The shared rules then decide, exactly as with a real model. Without
 * a scenario this fake reads the photo as genuine; the server's AI services
 * send such an unknown photo to review instead (D-128). Every verdict's stamp
 * names its simulated reading (`ai.simulated`).
 */

export const CHECK_IN_SCENARIOS = ['line_ok', 'no_code', 'no_line', 'unreadable'] as const;
export const PURCHASE_SCENARIOS = [
  'genuine',
  'over_cap',
  'wrong_seller',
  'time_before_checkin',
  'totals_off',
  'fake_receipt',
  'no_code',
  'unreadable',
  'generated',
] as const;

export const ALL_SCENARIOS: readonly string[] = [...new Set<string>([...CHECK_IN_SCENARIOS, ...PURCHASE_SCENARIOS])];

export function lineReading(scenario: string | null, input: CheckInPhotoInput): LinePhotoReading {
  const people = Math.round((input.item.expectedWaitMinutes * 60) / SECONDS_PER_PERSON);
  const ok: LinePhotoReading = {
    lineVisible: true,
    peopleAhead: people,
    codeSeen: input.claim.checkInCode,
    storefrontText: input.shop.receipt.printedName,
  };
  switch (scenario) {
    case 'no_code':
      return { ...ok, codeSeen: null };
    case 'no_line':
      return { ...ok, lineVisible: false, peopleAhead: null };
    case 'unreadable':
      return { lineVisible: null, peopleAhead: null, codeSeen: null, storefrontText: null };
    default:
      return ok;
  }
}

function invoiceNumber(input: PurchaseProofInput): string {
  const prefix = input.shop.name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 3);
  const digits = input.job.id.replace(/\D/g, '').padStart(4, '0').slice(-4);
  return `${prefix}-${epochToZonedLocal(input.uploadedAt, input.shop.timezone).slice(0, 10).replace(/-/g, '')}-${digits}`;
}

export function purchaseReading(scenarios: readonly string[], input: PurchaseProofInput): PurchaseReading {
  const has = (s: string) => scenarios.includes(s);
  const { shop, item, job } = input;
  if (has('unreadable')) {
    return {
      printedName: null,
      sellerTaxId: null,
      invoiceNumber: null,
      issuedAtLocal: null,
      currency: null,
      lines: [],
      totalMinor: null,
      qr: null,
      itemPhoto: { codeSeen: null, unitsVisible: null },
      anomalies: ['The receipt is too blurry to read.'],
      generatorMetadata: false,
    };
  }
  const fake = has('fake_receipt');
  let printedAt = input.uploadedAt - 2 * 60_000;
  if (input.checkedInAt !== null && printedAt < input.checkedInAt) printedAt = input.checkedInAt;
  if (fake || has('time_before_checkin')) printedAt = (input.checkedInAt ?? input.uploadedAt) - 16 * 60_000;
  const issuedAtLocal = epochToZonedLocal(printedAt, shop.timezone);

  const qty = fake ? Math.max(1, job.qty) : job.qty;
  const unit = has('over_cap') ? Math.ceil(item.retail.minor * 1.2) : item.retail.minor;
  const lines = [{ name: item.receiptAliases[0] ?? item.name, qty, unitMinor: unit, totalMinor: unit * qty }];
  const lineSum = lines.reduce((s, l) => s + l.totalMinor, 0);
  const totalMinor = fake || has('totals_off') ? lineSum + (item.retail.currency === 'TWD' ? 40 : 400) : lineSum;
  const seller = shop.receipt.sellerTaxId === null ? null : fake || has('wrong_seller') ? HERO.fakeSellerTaxId : shop.receipt.sellerTaxId;
  const invoice = invoiceNumber(input);
  return {
    printedName: shop.receipt.printedName,
    sellerTaxId: seller,
    invoiceNumber: invoice,
    issuedAtLocal,
    currency: item.retail.currency,
    lines,
    totalMinor,
    qr: shop.receipt.sellerTaxId === null ? null : { invoiceNumber: invoice, issuedDate: issuedAtLocal.slice(0, 10), sellerTaxId: seller, totalMinor },
    itemPhoto: { codeSeen: has('no_code') ? null : job.proofCode, unitsVisible: qty },
    anomalies: fake ? ['The store ID in the QR is not the shop on the header.'] : [],
    generatorMetadata: has('generated'),
  };
}
