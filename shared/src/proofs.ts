import type {
  Cents,
  Item,
  LocalCurrency,
  LocalMoney,
  MarketMs,
  ProofCheck,
  ProofCheckCode,
  ReceiptFields,
  Shop,
} from './contract.ts';
import { localToUsdCents } from './money.ts';

/**
 * Proof rules from docs/AI-SERVICES.md sections 4.1 and 4.2: a model (or a
 * fixture) reads photos; these pure functions decide. Hard failures fail a
 * proof, soft failures send it to a person, and the money amounts come from
 * code. Both the in-process fake and the real AI services use these rules.
 */

/** What a vision model read from a line photo (`check_in_photo` schema). */
export interface LinePhotoReading {
  lineVisible: boolean | null;
  peopleAhead: number | null;
  codeSeen: string | null;
  storefrontText: string | null;
}

/** What a vision model read from the receipt and item photos (`purchase_proof` schema), plus the decoded QR. */
export interface PurchaseReading {
  printedName: string | null;
  sellerTaxId: string | null;
  invoiceNumber: string | null;
  /** "YYYY-MM-DD HH:MM" as printed, in the shop's local time. */
  issuedAtLocal: string | null;
  currency: LocalCurrency | null;
  lines: { name: string; qty: number; unitMinor: number; totalMinor: number }[];
  totalMinor: number | null;
  /** Decoded receipt QR (store ID, receipt number, date and total); issuedDate is "YYYY-MM-DD". */
  qr: { invoiceNumber: string | null; issuedDate: string | null; sellerTaxId: string | null; totalMinor: number | null } | null;
  itemPhoto: { codeSeen: string | null; unitsVisible: number | null };
  anomalies: string[];
  /** C2PA or EXIF software metadata of an image generator was found. */
  generatorMetadata: boolean;
}

export type VerdictStatus = 'passed' | 'failed' | 'needs_review';

export interface CheckInVerdict {
  status: VerdictStatus;
  checks: ProofCheck[];
  peopleAhead: number | null;
  summary: string;
}

export interface PurchaseVerdict {
  status: VerdictStatus;
  checks: ProofCheck[];
  receipt: ReceiptFields;
  receiptTotal: LocalMoney | null;
  /** Retail of this item's lines in USD at the job's locked rate, before the cap. Null when it cannot be read. */
  retailCents: Cents | null;
  summary: string;
}

export interface CheckInContext {
  /** The claim's one-time code. */
  code: string;
  geofence: { ok: boolean; distanceM: number; radiusM: number };
  /** File id of an earlier upload this photo duplicates, if any. */
  duplicateOf: string | null;
}

export interface PurchaseContext {
  shop: Pick<Shop, 'name' | 'timezone' | 'hours' | 'receipt'>;
  item: Pick<Item, 'receiptAliases' | 'perPersonLimit'>;
  job: { qty: number; proofCode: string; retailCapCents: Cents; twdPerUsd: number | null };
  /** When the queuer's claim checked in. */
  checkedInAt: MarketMs | null;
  /** When the photos were submitted. */
  uploadedAt: MarketMs;
  duplicateOf: string | null;
}

/** Minutes of slack before check-in that a printed receipt time may show. */
export const RECEIPT_TIME_SLACK_MS = 5 * 60_000;
/** Two dHashes closer than this (bits) are the same photo. */
export const DUPLICATE_HAMMING_MAX = 6;

const CHECK_LABELS: Record<ProofCheckCode, string> = {
  geofence: 'location',
  line_visible: 'line',
  code_visible: 'one-time code',
  shop_match: 'shop',
  time_window: 'printed time',
  item_match: 'item lines',
  qty_within_limit: 'quantity',
  totals_add_up: 'totals',
  qr_matches_print: 'QR versus print',
  within_retail_cap: 'retail cap',
  duplicate_photo: 'recycled photo',
  generator_metadata: 'image metadata',
};

export function checkLabel(code: ProofCheckCode): string {
  return CHECK_LABELS[code];
}

/** Any hard failure fails; any soft failure needs review; otherwise passed. */
export function verdictStatus(checks: readonly ProofCheck[]): VerdictStatus {
  if (checks.some((c) => !c.ok && c.weight === 'hard')) return 'failed';
  if (checks.some((c) => !c.ok)) return 'needs_review';
  return 'passed';
}

/**
 * Alphabet of one-time codes (check-in, proof): no characters that are easy
 * to confuse when handwritten or read from a photo. Same alphabet and folding
 * as server/src/ai/codes.ts.
 */
export const ONE_TIME_CODE_ALPHABET = '23456789ACEFHJKMNPRTWXY';

const CODE_FOLD: Readonly<Record<string, string>> = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', G: '6', B: '8', U: 'V' };

/** Upper-cases a code, keeps letters and digits, and folds look-alikes (O/Q/D to 0, I/L to 1, Z to 2, S to 5, G to 6, B to 8, U to V). */
export function normalizeCode(code: string | null | undefined): string {
  if (!code) return '';
  let out = '';
  for (const ch of code.toUpperCase()) {
    if (!/[A-Z0-9]/.test(ch)) continue;
    out += CODE_FOLD[ch] ?? ch;
  }
  return out;
}

/** Bits that differ between two 64-bit hashes written as 16 hex characters. */
export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let bits = 0;
  for (let i = 0; i < a.length; i++) {
    let x = Number.parseInt(a[i]!, 16) ^ Number.parseInt(b[i]!, 16);
    while (x) {
      bits += x & 1;
      x >>= 1;
    }
  }
  return bits;
}

function tzOffsetMs(timeZone: string, epoch: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(epoch));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(epoch / 1000) * 1000;
}

/** "YYYY-MM-DD HH:MM" in a time zone to epoch milliseconds, or null when it does not parse. */
export function zonedLocalToEpoch(local: string, timeZone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const first = guess - tzOffsetMs(timeZone, guess);
  const second = guess - tzOffsetMs(timeZone, first);
  return second;
}

/** Epoch milliseconds to "YYYY-MM-DD HH:MM" in a time zone. */
export function epochToZonedLocal(epoch: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(epoch));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

const squash = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function lineMatchesItem(name: string, aliases: readonly string[]): boolean {
  const n = squash(name);
  return n.length > 0 && aliases.some((a) => {
    const s = squash(a);
    return n === s || n.includes(s) || s.includes(n);
  });
}

function check(code: ProofCheckCode, weight: 'hard' | 'soft', ok: boolean, detail: string): ProofCheck {
  return { code, weight, ok, detail };
}

function failureSummary(prefix: string, checks: readonly ProofCheck[]): string {
  const failed = checks.filter((c) => !c.ok);
  const names = failed.map((c) => checkLabel(c.code)).join(', ');
  return `${prefix} ${failed.length} check${failed.length === 1 ? '' : 's'}: ${names}.`;
}

/** Rules for the line photo at check-in (docs/AI-SERVICES.md 4.1). */
export function evaluateCheckIn(reading: LinePhotoReading, ctx: CheckInContext): CheckInVerdict {
  const codeOk = normalizeCode(reading.codeSeen) !== '' && normalizeCode(reading.codeSeen) === normalizeCode(ctx.code);
  const checks: ProofCheck[] = [
    check(
      'geofence',
      'hard',
      ctx.geofence.ok,
      ctx.geofence.ok
        ? `Checked in ${ctx.geofence.distanceM} m from the shop (limit ${ctx.geofence.radiusM} m).`
        : `Checked in ${ctx.geofence.distanceM} m from the shop, outside the ${ctx.geofence.radiusM} m limit.`,
    ),
    check('code_visible', 'hard', codeOk, codeOk ? 'The one-time code is visible in the photo.' : 'The one-time code was not found in the photo.'),
    check(
      'line_visible',
      'soft',
      reading.lineVisible === true,
      reading.lineVisible === true ? 'A line of people is visible.' : 'No line of people could be seen.',
    ),
    check(
      'duplicate_photo',
      'hard',
      ctx.duplicateOf === null,
      ctx.duplicateOf === null ? 'The photo is new.' : 'The photo matches an earlier upload.',
    ),
  ];
  const status = verdictStatus(checks);
  const people = reading.peopleAhead;
  const summary =
    status === 'passed'
      ? people === null
        ? 'Line photo shows the code and the line.'
        : `Line photo shows the code and about ${people} people ahead.`
      : status === 'failed'
        ? failureSummary('Line photo failed', checks)
        : failureSummary('Line photo needs a person to check', checks);
  return { status, checks, peopleAhead: people, summary };
}

function withinHours(localTime: string, hours: { opens: string; closes: string }): boolean {
  const hhmm = localTime.slice(11, 16);
  return hhmm >= hours.opens && hhmm <= hours.closes;
}

/** Rules for the receipt and item photo (docs/AI-SERVICES.md 4.2). */
export function evaluatePurchase(reading: PurchaseReading, ctx: PurchaseContext): PurchaseVerdict {
  const { shop, item, job } = ctx;
  const checks: ProofCheck[] = [];
  // Shops that print a receipt QR are matched on the store ID it carries; others on the printed name.
  const qrStyle = shop.receipt.sellerTaxId !== null;

  // code_visible (hard)
  const seen = normalizeCode(reading.itemPhoto.codeSeen);
  const codeOk = seen !== '' && seen === normalizeCode(job.proofCode);
  checks.push(
    check('code_visible', 'hard', codeOk, codeOk ? 'The job code is visible next to the item.' : 'The job code was not found next to the item.'),
  );

  // shop_match (hard)
  if (qrStyle) {
    const seller = reading.qr?.sellerTaxId ?? reading.sellerTaxId;
    const ok = seller !== null && seller === shop.receipt.sellerTaxId;
    checks.push(
      check(
        'shop_match',
        'hard',
        ok,
        ok
          ? `Store ID ${seller} matches ${shop.name}.`
          : seller === null
            ? 'No store ID could be read.'
            : `Store ID ${seller} is not ${shop.name}'s.`,
      ),
    );
  } else {
    const ok = squash(reading.printedName).includes(squash(shop.receipt.printedName)) && squash(shop.receipt.printedName) !== '';
    checks.push(
      check('shop_match', 'hard', ok, ok ? `Printed name matches ${shop.name}.` : `The printed name does not match ${shop.name}.`),
    );
  }

  // qr_matches_print (hard, receipts with a QR)
  if (qrStyle) {
    const qr = reading.qr;
    const printedDate = reading.issuedAtLocal?.slice(0, 10) ?? null;
    const ok =
      qr !== null &&
      qr.invoiceNumber !== null &&
      qr.invoiceNumber === reading.invoiceNumber &&
      qr.issuedDate !== null &&
      qr.issuedDate === printedDate &&
      qr.totalMinor !== null &&
      qr.totalMinor === reading.totalMinor;
    checks.push(
      check(
        'qr_matches_print',
        'hard',
        ok,
        qr === null ? 'No receipt QR could be read.' : ok ? 'QR receipt number, date and total match the print.' : 'The QR does not match the printed receipt.',
      ),
    );
  }

  // time_window (hard)
  const printedAt = reading.issuedAtLocal ? zonedLocalToEpoch(reading.issuedAtLocal, shop.timezone) : null;
  let timeOk = false;
  let timeDetail = 'No printed time could be read.';
  if (printedAt !== null && reading.issuedAtLocal) {
    const afterCheckIn = ctx.checkedInAt !== null && printedAt >= ctx.checkedInAt - RECEIPT_TIME_SLACK_MS;
    const beforeUpload = printedAt <= ctx.uploadedAt;
    const inHours = withinHours(reading.issuedAtLocal, shop.hours);
    timeOk = afterCheckIn && beforeUpload && inHours;
    const hhmm = reading.issuedAtLocal.slice(11, 16);
    timeDetail = timeOk
      ? `Printed at ${hhmm}, after check-in and within shop hours.`
      : !afterCheckIn
        ? `Printed at ${hhmm}, before the queuer checked in.`
        : !beforeUpload
          ? `Printed at ${hhmm}, after the photo was uploaded.`
          : `Printed at ${hhmm}, outside shop hours (${shop.hours.opens} to ${shop.hours.closes}).`;
  }
  checks.push(check('time_window', 'hard', timeOk, timeDetail));

  // totals_add_up (hard)
  const lineSum = reading.lines.reduce((s, l) => s + l.totalMinor, 0);
  const linesConsistent = reading.lines.every((l) => Math.abs(l.qty * l.unitMinor - l.totalMinor) <= 1);
  const totalsOk = reading.totalMinor !== null && reading.lines.length > 0 && Math.abs(lineSum - reading.totalMinor) <= 1 && linesConsistent;
  checks.push(
    check(
      'totals_add_up',
      'hard',
      totalsOk,
      totalsOk
        ? 'The lines add up to the total.'
        : reading.totalMinor === null
          ? 'No total could be read.'
          : `The lines add up to ${lineSum}, but the total says ${reading.totalMinor}.`,
    ),
  );

  // duplicate_photo (hard)
  checks.push(
    check(
      'duplicate_photo',
      'hard',
      ctx.duplicateOf === null,
      ctx.duplicateOf === null ? 'The photos are new.' : 'The item photo matches an older upload.',
    ),
  );

  // qty_within_limit (hard)
  const matching = reading.lines.filter((l) => lineMatchesItem(l.name, item.receiptAliases));
  const units = (matching.length > 0 ? matching : reading.lines).reduce((s, l) => s + l.qty, 0);
  const qtyOk = units === job.qty && units <= item.perPersonLimit;
  checks.push(
    check(
      'qty_within_limit',
      'hard',
      qtyOk,
      qtyOk ? `${units} unit${units === 1 ? '' : 's'} bought, as matched.` : `${units} units on the receipt; the job is for ${job.qty}.`,
    ),
  );

  // item_match (soft)
  const itemOk = reading.lines.length > 0 && matching.length === reading.lines.length;
  checks.push(
    check(
      'item_match',
      'soft',
      itemOk,
      itemOk ? 'Every line is the requested item.' : matching.length === 0 ? 'No line matches the requested item.' : 'The receipt has unrelated lines.',
    ),
  );

  // Amounts: this item's lines in USD at the locked rate, before the cap.
  const currency = reading.currency;
  const itemMinor = matching.length > 0 ? matching.reduce((s, l) => s + l.totalMinor, 0) : reading.totalMinor;
  let retailCents: Cents | null = null;
  if (currency !== null && itemMinor !== null) {
    if (currency === 'USD') retailCents = itemMinor;
    else if (job.twdPerUsd !== null) retailCents = localToUsdCents({ currency, minor: itemMinor }, job.twdPerUsd);
  }

  // within_retail_cap (soft). A $0 item amount is read as no amount: a person checks it, and a
  // pass charges the shop price (D-135), so a passed receipt always pays the queuer back.
  const capOk = retailCents !== null && retailCents > 0 && retailCents <= job.retailCapCents;
  checks.push(
    check(
      'within_retail_cap',
      'soft',
      capOk,
      retailCents === null
        ? 'The retail amount could not be read.'
        : retailCents <= 0
          ? 'The receipt shows no price for the item.'
          : capOk
            ? 'Retail is within the cap.'
            : 'Retail is above the cap; only the cap can be charged.',
    ),
  );

  // generator_metadata (soft)
  checks.push(
    check(
      'generator_metadata',
      'soft',
      !reading.generatorMetadata,
      reading.generatorMetadata ? 'Image-generator metadata was found.' : 'No image-generator metadata.',
    ),
  );

  const status = verdictStatus(checks);
  const receiptTotal: LocalMoney | null = currency !== null && reading.totalMinor !== null ? { currency, minor: reading.totalMinor } : null;
  const receipt: ReceiptFields = {
    printedName: reading.printedName,
    sellerTaxId: reading.sellerTaxId,
    invoiceNumber: reading.invoiceNumber,
    issuedAt: printedAt !== null ? new Date(printedAt).toISOString() : null,
    currency,
    lines: reading.lines.map((l) => ({
      name: l.name,
      qty: l.qty,
      unit: { currency: currency ?? 'USD', minor: l.unitMinor },
      total: { currency: currency ?? 'USD', minor: l.totalMinor },
    })),
    total: receiptTotal,
    qr: reading.qr
      ? { invoiceNumber: reading.qr.invoiceNumber, issuedDate: reading.qr.issuedDate, sellerTaxId: reading.qr.sellerTaxId, total: reading.qr.totalMinor }
      : null,
    codeSeen: reading.itemPhoto.codeSeen,
  };
  const hhmm = reading.issuedAtLocal?.slice(11, 16) ?? null;
  const summary =
    status === 'passed'
      ? `Receipt matches ${shop.name}${hhmm ? ` at ${hhmm}` : ''}.`
      : status === 'failed'
        ? failureSummary('Receipt failed', checks)
        : failureSummary('Receipt needs a person to check', checks);
  return { status, checks, receipt, receiptTotal, retailCents, summary };
}
