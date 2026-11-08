import type {
  AgentAction,
  AgentActionKind,
  AiMode,
  AiProviderId,
  AiStamp,
  BidTask,
  BookAsk,
  BookBid,
  BookSnapshot,
  Cents,
  CheckInVerdict,
  Claim,
  Destination,
  DisputeNoteFacts,
  FeeEstimate,
  FileId,
  Item,
  Job,
  MarketMs,
  MarketRules,
  OpsAgentTurnRequest,
  OpsAgentTurnResponse,
  PurchaseVerdict,
  ShippingEstimate,
  Shop,
} from '@holdmyspot/shared';
import type { ServerConfig } from '../config.ts';

/**
 * AiPort: the service-level AI boundary the market core calls. The core
 * never sees prompts, providers or keys; it hands over the photos and the
 * context the rules need, and gets back a verdict built with the shared
 * rules (`evaluateCheckIn`, `evaluatePurchase` in @holdmyspot/shared). The
 * capture amount is always recomputed by the core from `retailCents` and the
 * job's caps, so no model output becomes a charge by itself.
 *
 * Implementations:
 * - fake: server/src/fakes/ai.ts (rules plus simulated readings, no network);
 * - real: server/src/ai/ (built separately) exporting
 *   `createAiPort(options: AiPortOptions): Promise<AiPort>` from
 *   server/src/ai/index.ts, loaded by server/src/ports/load.ts.
 *
 * Errors and timeouts never pass a proof: the core turns them into
 * `needs_review` (docs/AI-SERVICES.md section 1).
 */

export interface PhotoInput {
  fileId: FileId;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  /** Absolute path of the bytes on disk. */
  path: string;
  sha256: string;
  dHash: string | null;
  /** Fake mode: a simulated reading name chosen at upload (see fakes/scenarios.ts); real providers ignore it. */
  scenario: string | null;
  bytes(): Promise<Uint8Array>;
}

export interface PriorPhoto {
  fileId: FileId;
  sha256: string;
  dHash: string | null;
  at: MarketMs;
}

export interface CheckInPhotoInput {
  claim: Claim;
  shop: Shop;
  item: Item;
  photo: PhotoInput;
  geofence: { ok: boolean; distanceM: number; radiusM: number };
  /** Set by the core when the photo has the same bytes (or a dHash within 6 bits) as an earlier photo of another claim or job. */
  duplicateOf: FileId | null;
  /** Earlier photos from other claims and jobs, for implementations that compare images themselves. */
  priorPhotos: PriorPhoto[];
  now: MarketMs;
}

export interface PurchaseProofInput {
  job: Job;
  claim: Claim;
  shop: Shop;
  item: Item;
  receipt: PhotoInput;
  itemPhoto: PhotoInput;
  checkedInAt: MarketMs | null;
  uploadedAt: MarketMs;
  duplicateOf: FileId | null;
  priorPhotos: PriorPhoto[];
  now: MarketMs;
}

export type CheckInPhotoResult = CheckInVerdict & { ai: AiStamp };
export type PurchaseProofResult = PurchaseVerdict & { ai: AiStamp };

export interface FeeEstimateInput {
  shop: Shop;
  item: Item;
  at: MarketMs;
  /** The latest passed line photo at this shop, if any. */
  latestLinePhoto: { peopleAhead: number | null; at: MarketMs } | null;
  rules: MarketRules;
}

export interface ShippingEstimateInput {
  item: Item;
  qty: number;
  destination: Destination;
}

export interface ReassignNoteInput {
  job: Job;
  reason: string;
  /** The ask that took the quantity, if one did. */
  takenBy: { queuerName: string; feeCents: number; etaAt: MarketMs } | null;
}

/** What the bidding agent sees of one book (same shapes the matcher uses). */
export interface AgentBookView {
  status: BookSnapshot['status'];
  bids: readonly BookBid[];
  asks: readonly BookAsk[];
  askNames?: Readonly<Record<string, string>>;
  /** Asks whose queuer has checked in (their fee clocks run). */
  checkedInAskIds?: readonly string[];
}

export interface AgentRunInput {
  bid: BidTask;
  item: Item;
  shop: Shop;
  now: MarketMs;
  book: AgentBookView;
  fee?: FeeEstimate | null;
  history?: readonly AgentAction[];
}

export interface AgentRunResult {
  /** Applied by the core through the same checks as PATCH /api/bids/:bidId (the PayPal hold is the mandate). */
  decision: { kind: AgentActionKind; fromFeeCents: Cents | null; toFeeCents: Cents | null; qty: number | null; reason: string };
  toolCalls: { name: string; input: unknown; output: unknown }[];
  refused: string[];
  /** The fee a refused action asked for, when it was above what the hold covers (D-158). */
  refusedFeeCents?: Cents | null;
  ceilingCents: Cents;
  /** When to run again; null stops the agent. */
  nextRunAt: MarketMs | null;
  decidedBy: 'policy' | 'model';
  ai: AiStamp;
}

/** The dispute note job (D-161): the model words code-supplied facts; template and stamp come back together. */
export interface DisputeNoteInput {
  facts: DisputeNoteFacts;
}

export interface DisputeNoteResult {
  text: string;
  ai: AiStamp;
  template: boolean;
  templateReason: 'no_model' | 'provider_error' | 'rejected' | null;
}

export interface AiPort {
  readonly info: { provider: AiProviderId; model: string; mode: AiMode };
  checkInPhoto(input: CheckInPhotoInput): Promise<CheckInPhotoResult>;
  purchaseProof(input: PurchaseProofInput): Promise<PurchaseProofResult>;
  feeEstimate(input: FeeEstimateInput): Promise<FeeEstimate>;
  shippingEstimate(input: ShippingEstimateInput): Promise<ShippingEstimate>;
  reassignNote?(input: ReassignNoteInput): Promise<string>;
  /** Optional: words a dispute note from facts code supplied; a template answers when no model can (D-161). */
  disputeNote?(input: DisputeNoteInput): Promise<DisputeNoteResult>;
  /** Optional 64-bit difference hash (16 hex characters) for uploads, used by duplicate-photo checks. */
  dHash?(bytes: Uint8Array, contentType?: string): Promise<string | null>;
  /** Optional: one run of the bidding agent for one bid (docs/AI-SERVICES.md 4.5). The core schedules runs and applies decisions. */
  biddingAgent?(input: AgentRunInput): Promise<AgentRunResult>;
  /** Optional: one model turn for an ops console agent (D-100); throws when no live model can answer. */
  opsAgentTurn?(input: OpsAgentTurnRequest): Promise<OpsAgentTurnResponse>;
}

export interface AiPortOptions {
  config: ServerConfig;
  /** Logs one line; never pass keys or prompts with personal data. */
  log: (line: string) => void;
}

export type AiPortFactory = (options: AiPortOptions) => Promise<AiPort>;
