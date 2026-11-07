import type { Cents, Item, LngLat, MarketMs, MarketRules, Shop } from '@holdmyspot/shared';
import type { LinePhotoReading, PurchaseReading } from '@holdmyspot/shared';
import type { AiKeyReport, AiProvider } from '@holdmyspot/shared/ports';
import type {
  AgentBookView,
  AiPort,
  AgentRunInput as PortAgentRunInput,
  AgentRunResult as PortAgentRunResult,
  CheckInPhotoInput,
  CheckInPhotoResult,
  PurchaseProofInput,
  PurchaseProofResult,
} from '../ports/ai.ts';
import type { ReceiptQr } from './qr.ts';
import type { CheckInExtraction, PurchaseExtraction } from './schemas.ts';

/**
 * Types of the AI module beyond the server's AiPort (server/src/ports/ai.ts).
 * The port's verdicts come from the shared rules; these extras say how sure
 * the pipeline is, why, and what was read, for ops and the eval.
 */

export interface PhotoReport {
  role: 'receipt' | 'item' | 'line';
  fileId: string | null;
  sha256: string;
  dHash: string | null;
  width: number | null;
  height: number | null;
  /** Image-generator metadata labels; empty when none. */
  generator: string[];
}

export interface ProofExtras {
  /** 0..1: how sure the pipeline is that `status` is right. */
  confidence: number;
  /** One sentence per failed check (hard first), or the main facts when it passed. */
  reasons: string[];
  photos: PhotoReport[];
  /** QR texts found on the receipt and the parsed store receipt QR (purchase proofs only). */
  qr: { texts: string[]; decoder: boolean; receiptQr: ReceiptQr | null } | null;
  /** The earlier photo this one duplicates, as found by the core or by our own dHash comparison. */
  duplicateOf: string | null;
}

/** `extraction`: what the model (or a fixture's truth) returned, before normalisation; null when the rules-only fake decided. */
export type PurchaseResult = PurchaseProofResult & ProofExtras & { extraction: PurchaseExtraction | null; reading: PurchaseReading | null };
export type CheckInResult = CheckInPhotoResult & ProofExtras & { extraction: CheckInExtraction | null; reading: LinePhotoReading | null };

// ---------------------------------------------------------------------------
// ETA
// ---------------------------------------------------------------------------

export interface EtaInput {
  from: LngLat;
  shop: Shop;
  item: Item;
  now: MarketMs;
  /** Expected wait in the line (from a fee estimate); defaults to the item's baseline. */
  waitMinutes?: number;
  /** Fee per unit the queuer would earn, for the earning rate. */
  feeCents?: Cents;
  qty?: number;
  rules?: Pick<MarketRules, 'travelMetersPerMinute' | 'maxTravelMinutes'>;
}

export interface EtaEstimate {
  distanceMeters: number;
  travelMinutes: number;
  /** Earliest honest arrival. */
  etaAt: MarketMs;
  waitMinutes: number;
  /** Arrival plus the expected wait. */
  doneAt: MarketMs;
  /** Within the travel range for asks and claims. */
  inRange: boolean;
  /** Fee for `qty` units per hour of travel plus waiting; null without a fee. */
  centsPerHour: Cents | null;
}

// ---------------------------------------------------------------------------
// Bidding agent (the shapes are the server port's, server/src/ports/ai.ts)
// ---------------------------------------------------------------------------

export type AgentBook = AgentBookView;
export type AgentRunInput = PortAgentRunInput;
export type AgentRunResult = PortAgentRunResult;
export type AgentDecision = AgentRunResult['decision'];

// ---------------------------------------------------------------------------
// The port with extras
// ---------------------------------------------------------------------------

/** The server's AiPort plus what the AI module adds (uploads, ETA, agent). */
export interface HmsAiPort extends AiPort {
  checkInPhoto(input: CheckInPhotoInput): Promise<CheckInResult>;
  purchaseProof(input: PurchaseProofInput): Promise<PurchaseResult>;
  readonly provider: AiProvider;
  readonly keyReport: AiKeyReport;
  /** One boot log line: key names and presence, provider, mode. */
  readonly bootLine: string;
  /** dHash for uploads (fits `saveUpload`'s `dHash` option): 16 hex characters, or null when the format cannot be decoded. */
  dHash(bytes: Uint8Array, contentType?: string): Promise<string | null>;
  /** Travel time, arrival, wait and earning rate for a queuer looking at a task. */
  eta(input: EtaInput): EtaEstimate;
  /** One run of the bidding agent for one bid. */
  biddingAgent(input: AgentRunInput): Promise<AgentRunResult>;
}
