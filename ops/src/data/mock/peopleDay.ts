import { disputeNoteTemplate } from '@holdmyspot/shared';
import type { MarketMs } from '@holdmyspot/shared';
import { sf } from '../time.ts';
import type { PeopleCase, RefundablePick } from '../../people/cases.ts';

/**
 * The replay's "Needs a person" cases (D-158): three side errands that are not
 * part of the hero day's world, so its money does not change. Nothing here calls
 * PayPal or a model; the buttons record the outcome in this browser only.
 */

const RECEIPT_ID = 'receipt:replay-receipt';
const REFUND_ID = 'refund:replay-refund';
const DISPUTE_ID = 'dispute:replay-dispute';

export const PEOPLE_MOMENT = '11:21';

const CASES: { appearsAt: MarketMs; row: PeopleCase }[] = [
  {
    appearsAt: sf('11:12'),
    row: {
      id: REFUND_ID,
      kind: 'refund',
      kindLabel: 'Refund',
      who: 'Jun L.',
      what: '1 x Strawberry shortcake',
      amountText: '$49.47 refundable of $49.47 captured',
      why: 'Jun L. asks for money back: "The cake box was crushed at the handover; the top layer is ruined."',
      aiNote: null,
      aiStamp: null,
      template: false,
      templateWhy: null,
      photos: [],
      attachments: [],
      jobId: 'replay-job-refund',
      refundableCents: 4947,
    },
  },
  {
    appearsAt: sf('11:16'),
    row: {
      id: DISPUTE_ID,
      kind: 'dispute',
      kindLabel: 'Dispute',
      who: 'Priya K., with Mo',
      what: '1 x Strawberry shortcake',
      amountText: '$49.47 in dispute',
      why: 'PayPal case PP-R-REPLAY-1: the buyer says the item did not arrive. PayPal is waiting for our answer.',
      aiNote: disputeNoteTemplate({
        disputeId: 'PP-R-REPLAY-1',
        reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        amountCents: 4947,
        itemName: 'Strawberry shortcake',
        qty: 1,
        shopName: 'Petal & Crumb Bakery',
        receiptTotal: '$38.00',
        receiptNumber: null,
        receiptDate: '2026-11-12',
        tracking: null,
        handedOver: true,
        capturedCents: 4947,
        refundedCents: 0,
        attachments: ['receipt.png', 'item-photo.png'],
      }),
      aiStamp: 'fake/rules-v1/fake',
      template: true,
      templateWhy: 'Written from the template: no AI model in this replay.',
      photos: [],
      attachments: ['receipt.png', 'item-photo.png'],
      disputeId: 'PP-R-REPLAY-1',
      jobId: 'replay-job-dispute',
      evidenceSent: false,
      decided: null,
      hasTracking: false,
    },
  },
  {
    appearsAt: sf('11:20'),
    row: {
      id: RECEIPT_ID,
      kind: 'receipt',
      kindLabel: 'Receipt to review',
      who: 'Ava for Leo M.',
      what: '1 x Mochi Bunny plush',
      amountText: '$48.00 if it passes',
      why: 'Listed price: the receipt says $36.00; the plush is listed at $34.00.',
      aiNote: 'Read PAPER MOON TOYS, $36.00. The lines add up and the receipt QR matches the print; the price is above what the shop lists.',
      aiStamp: 'fake/rules-v1/fake (simulated reading, no AI)',
      template: false,
      templateWhy: null,
      photos: [
        { label: 'Receipt', url: 'people/receipt.jpg' },
        { label: 'Item', url: 'people/item.jpg' },
      ],
      attachments: [],
      proofId: 'replay-proof',
      jobId: 'replay-job-receipt',
    },
  },
];

/** What a person did on this page during the replay. */
export interface PeopleReplayState {
  closed: ReadonlySet<string>;
  sent: ReadonlySet<string>;
  decided: ReadonlyMap<string, string>;
  /** Refunds taken in the replay, by job. */
  refunded: ReadonlyMap<string, number>;
}

export const emptyReplayState: PeopleReplayState = { closed: new Set(), sent: new Set(), decided: new Map(), refunded: new Map() };

export function peopleCasesAt(at: MarketMs, state: PeopleReplayState): PeopleCase[] {
  return CASES.filter((c) => c.appearsAt <= at && !state.closed.has(c.row.id)).map((c) =>
    c.row.kind === 'dispute' ? { ...c.row, evidenceSent: state.sent.has(c.row.id), decided: state.decided.get(c.row.id) ?? null } : c.row,
  );
}

/** The replay has no other jobs to refund: the three cases are all it holds. */
export const replayRefundablePicks: RefundablePick[] = [];
