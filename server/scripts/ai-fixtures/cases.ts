import type { ProofCheckCode } from '@holdmyspot/shared';

/**
 * Synthetic proof fixtures: fictional receipts, item photos and line photos,
 * rendered by scripts/render-receipts.ts into server/fixtures/proofs. Each
 * case says what a careful reader would copy from its photos (the truth) and
 * what the shared rules must decide (the expectation). Every shop, person,
 * code, store ID and receipt number here is made up; store IDs come from the
 * seed. All shops are in San Francisco or New York and print US dollars.
 */

export interface PhotoLook {
  /** Surface under the subject. */
  background: 'wood' | 'slate' | 'linen' | 'marble' | 'steel';
  /** Degrees. */
  rotate: number;
  tiltX: number;
  tiltY: number;
  /** Offset of the subject from the centre, in pixels. */
  x: number;
  y: number;
  scale: number;
  /** 0.8 (dim) to 1.2 (bright). */
  light: number;
  /** Light comes from this side. */
  lightFrom: 'left' | 'right' | 'top';
}

export interface ReceiptLineSpec {
  name: string;
  qty: number;
  /** Unit price in US cents. */
  unit: number;
  /** Line total as printed; defaults to qty x unit. */
  total?: number;
}

export interface ReceiptSpec {
  kind: 'receipt';
  shopId: string;
  printedName: string;
  address: string;
  /** Printed store ID (shops with a receipt QR), or null. */
  sellerTaxId: string | null;
  /** As printed: "PM-1112-0412" (receipts with a QR) or "#4417". */
  invoiceNumber: string;
  /** Printed local time "YYYY-MM-DD HH:MM:SS". */
  issuedLocal: string;
  currency: 'USD';
  lines: ReceiptLineSpec[];
  /** Printed grand total, minor units. */
  total: number;
  /** What the QR code says (may differ from the print in fraud cases); null: no QR. */
  qr: { invoiceNumber: string; issuedDate: string; total: number; sellerTaxId: string } | null;
  payment: string;
  look: PhotoLook;
}

export interface ItemPhotoSpec {
  kind: 'item';
  itemId: string;
  units: number;
  /** Code written on the sticky note. */
  code: string;
  layout: 'row' | 'stack' | 'pair';
  look: PhotoLook;
  /** Sticky note position relative to the items: 1 = right, -1 = left. */
  noteSide: 1 | -1;
  noteRotate: number;
}

export interface LinePhotoSpec {
  kind: 'line';
  storefront: string;
  /** People visible in the line ahead of the photographer. */
  people: number;
  /** Code on the card held up in the photo; null: no card. */
  code: string | null;
  shutter: boolean;
  seed: number;
  /** Where the line runs: from the shop door on this side toward the camera. */
  doorSide: 'left' | 'right';
  light: number;
  /** Palette of the facade. */
  facade: 'cream' | 'brick' | 'teal';
}

export type PhotoSpec = ReceiptSpec | ItemPhotoSpec | LinePhotoSpec;

export interface HistoryPhoto {
  id: string;
  /** The job or claim it belongs to. */
  ownerId: string;
  purpose: 'line_photo' | 'receipt' | 'item_photo';
  uploadedAt: string;
  spec: PhotoSpec;
}

export interface Expectation {
  status: 'passed' | 'failed' | 'needs_review';
  /** Hard checks that must fail (exactly these). */
  hard: ProofCheckCode[];
  /** Soft checks that must fail (exactly these). */
  soft: ProofCheckCode[];
  retailCents?: number;
  /** Shop price after the cap plus the matched fee; PayPal captures it with processing at cost on top (D-105). */
  captureCents?: number;
  peopleAhead?: number;
}

export interface PurchaseCase {
  kind: 'purchase';
  id: string;
  description: string;
  shopId: string;
  itemId: string;
  job: { id: string; qty: number; proofCode: string; feeCents: number; retailCapCentsPerUnit: number; shippingCents: number; mode: 'ship' | 'local' };
  queuer: string;
  requester: string;
  checkedInAt: string;
  uploadedAt: string;
  receipt: ReceiptSpec;
  /** Either a fresh photo, or an earlier upload re-used with the code changed. */
  item: ItemPhotoSpec | { recycledFrom: string; code: string; tweak: Tweak };
  /** Write image-generator metadata into the receipt PNG. */
  generatorMetadata?: boolean;
  expect: Expectation;
}

export interface CheckInCase {
  kind: 'check_in';
  id: string;
  description: string;
  shopId: string;
  itemId: string;
  claim: { id: string; code: string };
  queuer: string;
  geofence: { ok: boolean; distanceM: number; radiusM: number };
  at: string;
  photo: LinePhotoSpec | { recycledFrom: string; code: string; tweak: Tweak };
  expect: Expectation;
}

/** Small edits that keep a re-used photo perceptually the same. */
export interface Tweak {
  brightness: number;
  scale: number;
  dx: number;
  dy: number;
}

export type FixtureCase = PurchaseCase | CheckInCase;

const look = (l: Partial<PhotoLook>): PhotoLook => ({
  background: 'wood',
  rotate: 0,
  tiltX: 0,
  tiltY: 0,
  x: 0,
  y: 0,
  scale: 1,
  light: 1,
  lightFrom: 'left',
  ...l,
});

const MOON = { shopId: 'paper-moon-toys', printedName: 'PAPER MOON TOYS', address: 'Buchanan St, San Francisco', store: '41500017' } as const;
const BUNNY_LINE = 'MOCHI BUNNY PLUSH SAKURA';
const BUNNY = 3400;
const HERO_DAY = '2026-11-12';
/** San Francisco local time on the hero day (PST). */
const sf = (hhmmss: string, day = HERO_DAY) => `${day}T${hhmmss}-08:00`;

function moonReceipt(p: {
  invoice: string;
  time: string;
  lines: ReceiptLineSpec[];
  total?: number;
  qr?: Partial<NonNullable<ReceiptSpec['qr']>> | null;
  look: Partial<PhotoLook>;
  day?: string;
}): ReceiptSpec {
  const day = p.day ?? HERO_DAY;
  const total = p.total ?? p.lines.reduce((s, l) => s + (l.total ?? l.qty * l.unit), 0);
  return {
    kind: 'receipt',
    shopId: MOON.shopId,
    printedName: MOON.printedName,
    address: MOON.address,
    sellerTaxId: MOON.store,
    invoiceNumber: p.invoice,
    issuedLocal: `${day} ${p.time}`,
    currency: 'USD',
    lines: p.lines,
    total,
    qr:
      p.qr === null
        ? null
        : { invoiceNumber: p.invoice.replace(/-/g, ''), issuedDate: day, total, sellerTaxId: MOON.store, ...(p.qr ?? {}) },
    payment: 'Card **** 4821',
    look: look(p.look),
  };
}

function bunnies(units: number, code: string, l: Partial<PhotoLook>, layout: ItemPhotoSpec['layout'] = 'row', noteSide: 1 | -1 = 1, noteRotate = -4, itemId = 'plush-paper-moon'): ItemPhotoSpec {
  return { kind: 'item', itemId, units, code, layout, look: look(l), noteSide, noteRotate };
}

// ---------------------------------------------------------------------------
// Earlier uploads (other jobs and claims), for duplicate checks
// ---------------------------------------------------------------------------

export const HISTORY: HistoryPhoto[] = [
  {
    id: 'lin-item-1111',
    ownerId: 'job-h-lin',
    purpose: 'item_photo',
    uploadedAt: sf('11:52:00', '2026-11-11'),
    spec: bunnies(1, 'P5JA3', { background: 'linen', rotate: 2, x: -40, y: 10, scale: 1.05, light: 1.05, lightFrom: 'right' }, 'row', -1, 5),
  },
  {
    id: 'jo-item-1110',
    ownerId: 'job-h-jo',
    purpose: 'item_photo',
    uploadedAt: sf('11:38:00', '2026-11-10'),
    spec: bunnies(1, 'T7CN4', { background: 'steel', rotate: -6, tiltX: 8, x: 30, y: -20, scale: 0.95, light: 0.95, lightFrom: 'top' }, 'row', 1, 7),
  },
  {
    id: 'ava-receipt-1111',
    ownerId: 'job-h-ava',
    purpose: 'receipt',
    uploadedAt: sf('11:31:00', '2026-11-11'),
    spec: moonReceipt({
      day: '2026-11-11',
      invoice: 'PM-1111-0377',
      time: '11:29:30',
      lines: [{ name: BUNNY_LINE, qty: 1, unit: BUNNY }],
      look: { background: 'marble', rotate: 4, tiltX: 6, x: 20, y: 10, scale: 0.96, light: 1.08, lightFrom: 'right' },
    }),
  },
  {
    id: 'rin-line-1111',
    ownerId: 'claim-h-rin',
    purpose: 'line_photo',
    uploadedAt: sf('10:40:00', '2026-11-11'),
    spec: { kind: 'line', storefront: 'PAPER MOON TOYS', people: 35, code: 'K2XE9', shutter: false, seed: 11, doorSide: 'left', light: 1.05, facade: 'cream' },
  },
];

// ---------------------------------------------------------------------------
// Purchase proofs
// ---------------------------------------------------------------------------

const PM = { shopId: MOON.shopId, itemId: 'plush-paper-moon' } as const;
const shipJob = (id: string, code: string, feeCents: number, capPerUnit = 3600) => ({
  id,
  qty: 1,
  proofCode: code,
  feeCents,
  retailCapCentsPerUnit: capPerUnit,
  shippingCents: 1200,
  mode: 'ship' as const,
});

export const PURCHASE_CASES: PurchaseCase[] = [
  {
    kind: 'purchase',
    id: 'paper-moon-mia-genuine',
    description: "Hero: Wei's receipt for Mia's plush; passes, $34.00; shop price and fee $46.00.",
    ...PM,
    job: shipJob('job-mia', 'K7MX4', 1200),
    queuer: 'Wei',
    requester: 'Mia R.',
    checkedInAt: sf('10:50:00'),
    uploadedAt: sf('11:42:00'),
    receipt: moonReceipt({ invoice: 'PM-1112-0412', time: '11:41:07', lines: [{ name: BUNNY_LINE, qty: 1, unit: BUNNY }], look: { background: 'wood', rotate: -2.5, tiltX: 7, x: -10, y: 5, scale: 1, light: 1, lightFrom: 'left' } }),
    item: bunnies(1, 'K7MX4', { background: 'wood', rotate: -3, tiltX: 10, x: 10, y: 15, scale: 1, light: 1.02, lightFrom: 'left' }, 'row', 1, -5),
    expect: { status: 'passed', hard: [], soft: [], retailCents: 3400, captureCents: 4600 },
  },
  {
    kind: 'purchase',
    id: 'paper-moon-priya-genuine',
    description: "Hero: Lin's receipt for Priya's re-offered plush at $10; passes; shop price and fee $44.00.",
    ...PM,
    job: shipJob('job-priya', 'T3HW8', 1000),
    queuer: 'Lin',
    requester: 'Priya K.',
    checkedInAt: sf('11:30:00'),
    uploadedAt: sf('11:52:00'),
    receipt: moonReceipt({ invoice: 'PM-1112-0431', time: '11:50:52', lines: [{ name: BUNNY_LINE, qty: 1, unit: BUNNY }], look: { background: 'slate', rotate: 3, tiltX: 4, tiltY: -5, x: 15, y: -10, scale: 0.97, light: 0.95, lightFrom: 'right' } }),
    item: bunnies(1, 'T3HW8', { background: 'slate', rotate: 5, tiltX: 5, x: -60, y: -10, scale: 1.1, light: 0.95, lightFrom: 'right' }, 'row', 1, 6),
    expect: { status: 'passed', hard: [], soft: [], retailCents: 3400, captureCents: 4400 },
  },
  {
    kind: 'purchase',
    id: 'paper-moon-qr-wrong-store',
    description: 'The QR code carries another store ID than Paper Moon: shop_match fails.',
    ...PM,
    job: shipJob('job-c3', 'H4NP7', 1300),
    queuer: 'Ava',
    requester: 'Jun L.',
    checkedInAt: sf('10:52:00'),
    uploadedAt: sf('11:50:00'),
    receipt: moonReceipt({ invoice: 'PM-1112-0429', time: '11:47:30', lines: [{ name: BUNNY_LINE, qty: 1, unit: BUNNY }], qr: { sellerTaxId: '41500085' }, look: { background: 'linen', rotate: 1.5, tiltX: 9, x: 0, y: 0, scale: 1.02, light: 1.06, lightFrom: 'top' } }),
    item: bunnies(1, 'H4NP7', { background: 'linen', rotate: 8, tiltX: 12, x: 40, y: 20, scale: 0.92, light: 1.08, lightFrom: 'top' }, 'row', -1, 3),
    expect: { status: 'failed', hard: ['shop_match'], soft: [] },
  },
  {
    kind: 'purchase',
    id: 'paper-moon-time-before-checkin',
    description: 'Printed 10:31, before the check-in at 10:50 and before opening: time_window fails.',
    ...PM,
    job: shipJob('job-c4', 'R8EF2', 1400),
    queuer: 'Lin',
    requester: 'Sam W.',
    checkedInAt: sf('10:50:00'),
    uploadedAt: sf('11:39:00'),
    receipt: moonReceipt({ invoice: 'PM-1112-0398', time: '10:31:44', lines: [{ name: BUNNY_LINE, qty: 1, unit: BUNNY }], look: { background: 'slate', rotate: -7, tiltX: 5, tiltY: 4, x: 70, y: 30, scale: 0.9, light: 1.1, lightFrom: 'left' } }),
    item: bunnies(1, 'R8EF2', { background: 'marble', rotate: -8, tiltX: 6, x: 50, y: 0, scale: 1.05, light: 1.1, lightFrom: 'left' }, 'row', -1, -7),
    expect: { status: 'failed', hard: ['time_window'], soft: [] },
  },
  {
    kind: 'purchase',
    id: 'paper-moon-totals-off',
    description: 'The line says $34.00 but the printed total (and its QR) say $36.00: totals_add_up fails.',
    ...PM,
    job: shipJob('job-c5', 'W2CK9', 1200),
    queuer: 'Jo',
    requester: 'Noor A.',
    checkedInAt: sf('10:49:00'),
    uploadedAt: sf('11:55:00'),
    receipt: moonReceipt({ invoice: 'PM-1112-0436', time: '11:52:10', lines: [{ name: BUNNY_LINE, qty: 1, unit: BUNNY }], total: 3600, look: { background: 'steel', rotate: 2, tiltX: 8, x: -20, y: 0, scale: 1, light: 0.98, lightFrom: 'right' } }),
    item: bunnies(1, 'W2CK9', { background: 'marble', rotate: 7, tiltX: 12, x: -80, y: 30, scale: 1.08, light: 1.06, lightFrom: 'left' }, 'row', -1, 9),
    expect: { status: 'failed', hard: ['totals_add_up'], soft: [] },
  },
  {
    kind: 'purchase',
    id: 'paper-moon-recycled-photo',
    description: "The item photo is Lin's photo from 11-11 with the code edited: duplicate_photo fails.",
    ...PM,
    job: shipJob('job-c6', 'N6TY4', 1100),
    queuer: 'Rin',
    requester: 'Leo M.',
    checkedInAt: sf('10:55:00'),
    uploadedAt: sf('11:58:00'),
    receipt: moonReceipt({ invoice: 'PM-1112-0441', time: '11:55:41', lines: [{ name: BUNNY_LINE, qty: 1, unit: BUNNY }], look: { background: 'wood', rotate: 5, tiltX: 3, x: 10, y: -15, scale: 0.95, light: 1.04, lightFrom: 'top' } }),
    item: { recycledFrom: 'lin-item-1111', code: 'N6TY4', tweak: { brightness: 1.04, scale: 1.02, dx: 6, dy: -4 } },
    expect: { status: 'failed', hard: ['duplicate_photo'], soft: [] },
  },
  {
    kind: 'purchase',
    id: 'paper-moon-over-cap',
    description: 'The shop charged $38.00; above the $36.00 retail cap: needs review (only the cap can be charged).',
    ...PM,
    job: shipJob('job-c7', 'F9RM6', 1200),
    queuer: 'Wei',
    requester: 'Mia R.',
    checkedInAt: sf('10:50:00'),
    uploadedAt: sf('12:05:00'),
    receipt: moonReceipt({ invoice: 'PM-1112-0452', time: '12:02:18', lines: [{ name: BUNNY_LINE, qty: 1, unit: 3800 }], look: { background: 'linen', rotate: -1, tiltX: 6, tiltY: 5, x: 5, y: 10, scale: 1.03, light: 0.92, lightFrom: 'left' } }),
    item: bunnies(1, 'F9RM6', { background: 'linen', rotate: 3, tiltX: 8, x: -30, y: -20, scale: 1.08, light: 0.92, lightFrom: 'left' }, 'row', 1, -2),
    expect: { status: 'needs_review', hard: [], soft: ['within_retail_cap'], retailCents: 3800, captureCents: 4800 },
  },
  {
    kind: 'purchase',
    id: 'petal-crumb-shortcake-usd',
    description: 'New York errand: receipt without a QR, printed name matches; shop price and fee $47.00.',
    shopId: 'petal-crumb-bakery',
    itemId: 'cake-petal-crumb',
    job: { id: 'job-dana', qty: 1, proofCode: 'X4KE7', feeCents: 900, retailCapCentsPerUnit: 4000, shippingCents: 0, mode: 'local' },
    queuer: 'Dana',
    requester: 'Jun L.',
    checkedInAt: '2026-11-11T14:20:00-05:00',
    uploadedAt: '2026-11-11T15:16:00-05:00',
    receipt: {
      kind: 'receipt',
      shopId: 'petal-crumb-bakery',
      printedName: 'PETAL & CRUMB BAKERY',
      address: 'Elizabeth St, New York',
      sellerTaxId: null,
      invoiceNumber: '#4417',
      issuedLocal: '2026-11-11 15:12:40',
      currency: 'USD',
      lines: [{ name: 'STRAWBERRY SHORTCAKE', qty: 1, unit: 3800 }],
      total: 3800,
      qr: null,
      payment: 'Card **** 4821',
      look: look({ background: 'marble', rotate: -3, tiltX: 6, x: 0, y: 0, scale: 1, light: 1.05, lightFrom: 'right' }),
    },
    item: { kind: 'item', itemId: 'cake-petal-crumb', units: 1, code: 'X4KE7', layout: 'row', look: look({ background: 'marble', rotate: 2, tiltX: 10, x: -20, y: 10, scale: 1, light: 1.05, lightFrom: 'right' }), noteSide: 1, noteRotate: -6 },
    expect: { status: 'passed', hard: [], soft: [], retailCents: 3800, captureCents: 4700 },
  },
  {
    kind: 'purchase',
    id: 'paper-moon-rex-fake',
    description: "Hero: Rex's fake receipt: another store on the QR, printed before his check-in, the line does not add up to the total, recycled item photo. Nothing is captured.",
    ...PM,
    job: shipJob('job-rex', 'C8MR2', 1100),
    queuer: 'Rex',
    requester: 'Priya K.',
    checkedInAt: sf('10:57:00'),
    uploadedAt: sf('11:18:00'),
    receipt: moonReceipt({
      invoice: 'PM-1112-0384',
      time: '10:41:15',
      lines: [{ name: BUNNY_LINE, qty: 1, unit: BUNNY }],
      total: 3600,
      qr: { sellerTaxId: '41500093' },
      look: { background: 'slate', rotate: -5, tiltX: 10, tiltY: 3, x: 20, y: -5, scale: 0.97, light: 0.9, lightFrom: 'top' },
    }),
    item: { recycledFrom: 'jo-item-1110', code: 'C8MR2', tweak: { brightness: 0.93, scale: 1.05, dx: -12, dy: 9 } },
    expect: { status: 'failed', hard: ['shop_match', 'time_window', 'totals_add_up', 'duplicate_photo'], soft: [] },
  },
  {
    kind: 'purchase',
    id: 'paper-moon-wrong-code',
    description: "The sticky note shows another job's code: code_visible fails.",
    ...PM,
    job: shipJob('job-c10', 'J3RA8', 1200),
    queuer: 'Ava',
    requester: 'Sam W.',
    checkedInAt: sf('10:52:00'),
    uploadedAt: sf('12:11:00'),
    receipt: moonReceipt({ invoice: 'PM-1112-0460', time: '12:08:03', lines: [{ name: BUNNY_LINE, qty: 1, unit: BUNNY }], look: { background: 'wood', rotate: -6, tiltX: 4, x: -15, y: 20, scale: 0.99, light: 1.12, lightFrom: 'right' } }),
    item: bunnies(1, 'E2PW5', { background: 'wood', rotate: -10, tiltX: 7, x: 70, y: 25, scale: 0.98, light: 1.12, lightFrom: 'right' }, 'row', -1, 4),
    expect: { status: 'failed', hard: ['code_visible'], soft: [] },
  },
  {
    kind: 'purchase',
    id: 'paper-moon-qr-print-mismatch',
    description: 'The printed receipt number was edited (the QR says PM-1112-0414): qr_matches_print fails.',
    ...PM,
    job: shipJob('job-c11', 'M5XC6', 1250),
    queuer: 'Lin',
    requester: 'Leo M.',
    checkedInAt: sf('10:50:00'),
    uploadedAt: sf('12:15:00'),
    receipt: moonReceipt({ invoice: 'PM-1112-0444', time: '12:12:27', lines: [{ name: BUNNY_LINE, qty: 1, unit: BUNNY }], qr: { invoiceNumber: 'PM11120414' }, look: { background: 'steel', rotate: 3.5, tiltX: 5, tiltY: -4, x: 0, y: -10, scale: 1.01, light: 1, lightFrom: 'left' } }),
    item: bunnies(1, 'M5XC6', { background: 'linen', rotate: 9, tiltX: 4, x: -110, y: 40, scale: 1.12, light: 1.06, lightFrom: 'right' }, 'row', 1, -8),
    expect: { status: 'failed', hard: ['qr_matches_print'], soft: [] },
  },
  {
    kind: 'purchase',
    id: 'little-lantern-qty-short',
    description: 'Little Lantern Toys: the job is for 2 Lucky Cat plush but the receipt shows 1: qty_within_limit fails.',
    shopId: 'little-lantern-toys',
    itemId: 'plush-little-lantern',
    job: { id: 'job-c12', qty: 2, proofCode: 'A7PN3', feeCents: 600, retailCapCentsPerUnit: 2800, shippingCents: 1300, mode: 'ship' },
    queuer: 'Jo',
    requester: 'Noor A.',
    checkedInAt: sf('11:04:00'),
    uploadedAt: sf('12:20:00'),
    receipt: {
      kind: 'receipt',
      shopId: 'little-lantern-toys',
      printedName: 'LITTLE LANTERN TOYS',
      address: 'Bush St, San Francisco',
      sellerTaxId: '41500028',
      invoiceNumber: 'LL-1112-0907',
      issuedLocal: `${HERO_DAY} 12:17:55`,
      currency: 'USD',
      lines: [{ name: 'LUCKY CAT PLUSH', qty: 1, unit: 2600 }],
      total: 2600,
      qr: { invoiceNumber: 'LL11120907', issuedDate: HERO_DAY, total: 2600, sellerTaxId: '41500028' },
      payment: 'Card **** 4821',
      look: look({ background: 'wood', rotate: 6, tiltX: 7, x: -70, y: -25, scale: 0.88, light: 0.96, lightFrom: 'top' }),
    },
    item: { kind: 'item', itemId: 'plush-little-lantern', units: 1, code: 'A7PN3', layout: 'row', look: look({ background: 'marble', rotate: -5, tiltX: 11, x: 20, y: -30, scale: 1.06, light: 0.96, lightFrom: 'top' }), noteSide: 1, noteRotate: 2 },
    expect: { status: 'failed', hard: ['qty_within_limit'], soft: [] },
  },
  {
    kind: 'purchase',
    id: 'little-lantern-2plush-genuine',
    description: 'Little Lantern Toys, two Lucky Cat plush at the shop price; passes, $52.00; shop price and fees $64.00.',
    shopId: 'little-lantern-toys',
    itemId: 'plush-little-lantern',
    job: { id: 'job-c13', qty: 2, proofCode: 'A9HT6', feeCents: 600, retailCapCentsPerUnit: 2800, shippingCents: 1300, mode: 'ship' },
    queuer: 'Rin',
    requester: 'Sam W.',
    checkedInAt: sf('11:05:00'),
    uploadedAt: sf('11:35:00'),
    receipt: {
      kind: 'receipt',
      shopId: 'little-lantern-toys',
      printedName: 'LITTLE LANTERN TOYS',
      address: 'Bush St, San Francisco',
      sellerTaxId: '41500028',
      invoiceNumber: 'LL-1112-0883',
      issuedLocal: `${HERO_DAY} 11:32:09`,
      currency: 'USD',
      lines: [{ name: 'LUCKY CAT PLUSH', qty: 2, unit: 2600 }],
      total: 5200,
      qr: { invoiceNumber: 'LL11120883', issuedDate: HERO_DAY, total: 5200, sellerTaxId: '41500028' },
      payment: 'Debit card **** 0617',
      look: look({ background: 'steel', rotate: -2, tiltX: 6, x: 10, y: 0, scale: 1, light: 1.04, lightFrom: 'right' }),
    },
    item: { kind: 'item', itemId: 'plush-little-lantern', units: 2, code: 'A9HT6', layout: 'pair', look: look({ background: 'steel', rotate: 6, tiltX: 9, x: 0, y: 10, scale: 1.05, light: 1.04, lightFrom: 'right' }), noteSide: -1, noteRotate: 5 },
    expect: { status: 'passed', hard: [], soft: [], retailCents: 5200, captureCents: 6400 },
  },
  {
    kind: 'purchase',
    id: 'steam-lantern-extra-line',
    description: 'Steam Lantern Ramen: two takeout bowls plus an iced tea on the same receipt: item_match needs review.',
    shopId: 'steam-lantern-ramen',
    itemId: 'ramen-steam-lantern',
    job: { id: 'job-c14', qty: 2, proofCode: 'Y5NC3', feeCents: 500, retailCapCentsPerUnit: 2000, shippingCents: 0, mode: 'local' },
    queuer: 'Ava',
    requester: 'Leo M.',
    checkedInAt: sf('11:20:00'),
    uploadedAt: sf('12:08:00'),
    receipt: {
      kind: 'receipt',
      shopId: 'steam-lantern-ramen',
      printedName: 'STEAM LANTERN RAMEN',
      address: 'Sutter St, San Francisco',
      sellerTaxId: null,
      invoiceNumber: '#2291',
      issuedLocal: `${HERO_DAY} 12:05:36`,
      currency: 'USD',
      lines: [
        { name: 'BLACK GARLIC TONKOTSU TO GO', qty: 2, unit: 1900 },
        { name: 'ICED BARLEY TEA', qty: 1, unit: 350 },
      ],
      total: 4150,
      qr: null,
      payment: 'Card **** 4821',
      look: look({ background: 'wood', rotate: 4, tiltX: 8, x: -10, y: 10, scale: 0.99, light: 0.97, lightFrom: 'left' }),
    },
    item: { kind: 'item', itemId: 'ramen-steam-lantern', units: 2, code: 'Y5NC3', layout: 'pair', look: look({ background: 'wood', rotate: -4, tiltX: 6, x: 30, y: 0, scale: 1, light: 0.97, lightFrom: 'left' }), noteSide: 1, noteRotate: -3 },
    expect: { status: 'needs_review', hard: [], soft: ['item_match'], retailCents: 3800, captureCents: 4800 },
  },
  {
    kind: 'purchase',
    id: 'sugar-cloud-cake-genuine',
    description: 'Sugar Cloud Bakery errand in San Francisco: receipt without a QR; passes; shop price and fee $47.00.',
    shopId: 'sugar-cloud-bakery',
    itemId: 'cake-sugar-cloud',
    job: { id: 'job-c16', qty: 1, proofCode: 'P3WN7', feeCents: 900, retailCapCentsPerUnit: 4000, shippingCents: 0, mode: 'local' },
    queuer: 'Jo',
    requester: 'Noor A.',
    checkedInAt: sf('09:40:00'),
    uploadedAt: sf('10:24:00'),
    receipt: {
      kind: 'receipt',
      shopId: 'sugar-cloud-bakery',
      printedName: 'SUGAR CLOUD BAKERY',
      address: 'Buchanan St, San Francisco',
      sellerTaxId: null,
      invoiceNumber: '#1180',
      issuedLocal: `${HERO_DAY} 10:21:12`,
      currency: 'USD',
      lines: [{ name: 'STRAWBERRY CLOUD CAKE', qty: 1, unit: 3800 }],
      total: 3800,
      qr: null,
      payment: 'Card **** 4821',
      look: look({ background: 'linen', rotate: -2, tiltX: 5, x: 10, y: 5, scale: 1, light: 1.02, lightFrom: 'left' }),
    },
    item: { kind: 'item', itemId: 'cake-sugar-cloud', units: 1, code: 'P3WN7', layout: 'row', look: look({ background: 'linen', rotate: 3, tiltX: 9, x: -15, y: 10, scale: 1, light: 1.02, lightFrom: 'left' }), noteSide: 1, noteRotate: -5 },
    expect: { status: 'passed', hard: [], soft: [], retailCents: 3800, captureCents: 4700 },
  },
  {
    kind: 'purchase',
    id: 'paper-moon-generator-metadata',
    description: 'A clean-looking receipt whose file says it was made by an image generator: needs review.',
    ...PM,
    job: shipJob('job-c15', 'E6WK8', 1200),
    queuer: 'Rin',
    requester: 'Jun L.',
    checkedInAt: sf('10:55:00'),
    uploadedAt: sf('12:31:00'),
    receipt: moonReceipt({ invoice: 'PM-1112-0471', time: '12:28:49', lines: [{ name: BUNNY_LINE, qty: 1, unit: BUNNY }], look: { background: 'slate', rotate: -1.5, tiltX: 5, tiltY: 6, x: -5, y: -5, scale: 1.02, light: 1.03, lightFrom: 'right' } }),
    item: bunnies(1, 'E6WK8', { background: 'slate', rotate: 1, tiltX: 13, x: 10, y: 5, scale: 0.94, light: 1.03, lightFrom: 'right' }, 'row', -1, -6),
    generatorMetadata: true,
    expect: { status: 'needs_review', hard: [], soft: ['generator_metadata'], retailCents: 3400, captureCents: 4600 },
  },
];

// ---------------------------------------------------------------------------
// Check-in line photos
// ---------------------------------------------------------------------------

const PM_CHECKIN = { shopId: MOON.shopId, itemId: 'plush-paper-moon' } as const;

export const CHECK_IN_CASES: CheckInCase[] = [
  {
    kind: 'check_in',
    id: 'checkin-paper-moon-wei',
    description: "Hero: Wei's line photo with his check-in code and about 40 people ahead; passes.",
    ...PM_CHECKIN,
    claim: { id: 'claim-wei', code: 'M4RT7' },
    queuer: 'Wei',
    geofence: { ok: true, distanceM: 34, radiusM: 80 },
    at: sf('10:50:00'),
    photo: { kind: 'line', storefront: 'PAPER MOON TOYS', people: 40, code: 'M4RT7', shutter: false, seed: 3, doorSide: 'right', light: 1, facade: 'cream' },
    expect: { status: 'passed', hard: [], soft: [], peopleAhead: 40 },
  },
  {
    kind: 'check_in',
    id: 'checkin-paper-moon-rex',
    description: "Hero: Rex's line photo with his code; passes (his receipt is the fake one).",
    ...PM_CHECKIN,
    claim: { id: 'claim-rex', code: 'F2KX9' },
    queuer: 'Rex',
    geofence: { ok: true, distanceM: 52, radiusM: 80 },
    at: sf('10:57:00'),
    photo: { kind: 'line', storefront: 'PAPER MOON TOYS', people: 46, code: 'F2KX9', shutter: false, seed: 7, doorSide: 'left', light: 0.95, facade: 'brick' },
    expect: { status: 'passed', hard: [], soft: [], peopleAhead: 46 },
  },
  {
    kind: 'check_in',
    id: 'checkin-no-code',
    description: 'A line photo without the check-in code: code_visible fails.',
    ...PM_CHECKIN,
    claim: { id: 'claim-c18', code: 'H9TE4' },
    queuer: 'Jo',
    geofence: { ok: true, distanceM: 41, radiusM: 80 },
    at: sf('10:53:00'),
    photo: { kind: 'line', storefront: 'PAPER MOON TOYS', people: 38, code: null, shutter: false, seed: 19, doorSide: 'right', light: 1.08, facade: 'teal' },
    expect: { status: 'failed', hard: ['code_visible'], soft: [] },
  },
  {
    kind: 'check_in',
    id: 'checkin-no-line',
    description: 'The code is visible but there is no line (shutter down): line_visible needs review.',
    ...PM_CHECKIN,
    claim: { id: 'claim-c19', code: 'H7AW3' },
    queuer: 'Ava',
    geofence: { ok: true, distanceM: 20, radiusM: 80 },
    at: sf('09:40:00'),
    photo: { kind: 'line', storefront: 'PAPER MOON TOYS', people: 0, code: 'H7AW3', shutter: true, seed: 23, doorSide: 'left', light: 0.9, facade: 'cream' },
    expect: { status: 'needs_review', hard: [], soft: ['line_visible'] },
  },
  {
    kind: 'check_in',
    id: 'checkin-recycled',
    description: "Rin's line photo from 11-11 with a new code edited in: duplicate_photo fails.",
    ...PM_CHECKIN,
    claim: { id: 'claim-c20', code: 'P8EM2' },
    queuer: 'Rin',
    geofence: { ok: true, distanceM: 47, radiusM: 80 },
    at: sf('10:46:00'),
    photo: { recycledFrom: 'rin-line-1111', code: 'P8EM2', tweak: { brightness: 1.07, scale: 1.03, dx: 8, dy: 6 } },
    expect: { status: 'failed', hard: ['duplicate_photo'], soft: [] },
  },
];

export const ALL_CASES: FixtureCase[] = [...PURCHASE_CASES, ...CHECK_IN_CASES];
