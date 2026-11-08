/**
 * The fake receipts `npm run attack` (scripts/attack.mjs) sends, one fresh demo market each
 * (docs/DECISIONS.md D-138). Rex takes the requester's Mochi Bunny plush request at Paper Moon
 * Toys, checks in with his rendered line photo and sends the case's receipt and item photos
 * from server/fixtures/proofs. The hero script's setup pins each case's job code on its pair
 * (`pin`), so the photo shows the code the server expects and fails only on the defect it was
 * drawn with. None of these pairs (nor ATTACK_HANDOVER's) meet in the scripted day, where Rex
 * takes only Priya's request and Wei only Mia's.
 *
 * The wrong-code case needs no pin of its own: its sticky note shows another job's code (E2PW5),
 * and Rex takes Priya's request, whose code the hero script already pins for his fake receipt.
 *
 * Data only (no imports), so the attack script can read it before anything else is loaded.
 */

export interface AttackReceipt {
  /** Folder in server/fixtures/proofs. */
  caseId: string;
  requesterId: string;
  queuerId: string;
  /** Pin the case's job code (case.json `job.proofCode`) on this pair in a fresh demo market. */
  pin: boolean;
}

export const ATTACK_RECEIPTS: readonly AttackReceipt[] = [
  { caseId: 'paper-moon-recycled-photo', requesterId: 'leo', queuerId: 'rex', pin: true },
  { caseId: 'paper-moon-qr-wrong-store', requesterId: 'jun', queuerId: 'rex', pin: true },
  { caseId: 'paper-moon-time-before-checkin', requesterId: 'sam', queuerId: 'rex', pin: true },
  { caseId: 'paper-moon-totals-off', requesterId: 'noor', queuerId: 'rex', pin: true },
  { caseId: 'paper-moon-wrong-code', requesterId: 'priya', queuerId: 'rex', pin: false },
  { caseId: 'paper-moon-generator-metadata', requesterId: 'mia', queuerId: 'rex', pin: true },
];

/**
 * The attack's handover row: Wei does Sam's local errand with the hero's genuine photos (their code
 * pinned on this pair too), then tries to guess Sam's four-digit handover code.
 */
export const ATTACK_HANDOVER: AttackReceipt = { caseId: 'paper-moon-mia-genuine', requesterId: 'sam', queuerId: 'wei', pin: true };

/**
 * The layer that gave each refusal code the attack meets over the HTTP API (D-149): the attack labels
 * a row with the layer of the answer it got, not a label written next to the attempt, and
 * server/test/attack.test.ts compares that with the layer README names. Receipts are labelled from
 * their failed checks instead (`checkBasis`, server/src/ai/basis.ts), as the ablation does.
 *
 * - rules: shared/src/money.ts's caps (OVER_LIMIT), the geofence rule (OUTSIDE_GEOFENCE) and the
 *   handover-code lock (RATE_LIMITED).
 * - state machine: the request's, job's or call's state allows nothing more (INVALID_TRANSITION,
 *   CONFLICT, SOLD_OUT, and REPLAYED, an Idempotency-Key that answers with the first response).
 */
export const LAYER_OF_CODE: Readonly<Record<string, 'rules' | 'state machine'>> = {
  OVER_LIMIT: 'rules',
  OUTSIDE_GEOFENCE: 'rules',
  RATE_LIMITED: 'rules',
  INVALID_TRANSITION: 'state machine',
  CONFLICT: 'state machine',
  SOLD_OUT: 'state machine',
  REPLAYED: 'state machine',
};

/**
 * The attack's known limits (D-147): two attempts no layer stops, run so the table shows what they
 * do. Wei sends Mia's real receipt reprinted at her $36.00 cap with a matching QR
 * (server/fixtures/proofs/_reprint-at-cap, its code pinned on mia>wei by the hero setup like her
 * genuine one), and Rex checks in from home while his phone reports the shop's position, with his
 * rendered line photo (its code pinned on rex at Paper Moon Toys).
 */
export const ATTACK_LIMITS = { reprintCaseId: '_reprint-at-cap', reprintOf: 'paper-moon-mia-genuine', requesterId: 'mia', queuerId: 'wei', spooferId: 'rex' } as const;
