import type {
  AgentAction,
  AskTask,
  BidTask,
  CityId,
  Claim,
  ClaimId,
  Dispute,
  FileId,
  FilePurpose,
  FileRef,
  Hold,
  ItemId,
  Job,
  JobId,
  LedgerEntry,
  Match,
  Payout,
  Proof,
  ShopId,
  User,
  UserId,
} from '@holdmyspot/shared';
import { Database, DocTable } from './database.ts';

/** Per-book state the contract does not carry: sold-out flag and the last fee-clock pass. */
export interface BookState {
  /** The item id: one book per shop item. */
  id: ItemId;
  shopId: ShopId;
  cityId: CityId;
  status: 'open' | 'sold_out' | 'closed';
  /** Market time of the last fee-clock matching pass. */
  lastClockRunAt: number | null;
  soldOutAt: number | null;
}

export interface UserDoc {
  id: UserId;
  user: User;
  /** Seeded crowd bidders: real records, not selectable personas. */
  crowd: boolean;
  /** Payout receiver in fake mode (sandbox mode pays PAYPAL_TW_PAYOUT_EMAIL). */
  payoutEmail: string | null;
}

export interface StoredFile {
  id: FileId;
  ref: FileRef;
  ownerId: UserId;
  purpose: FilePurpose;
  /** Absolute path of the bytes on disk. */
  path: string;
  /** Fake mode: the simulated reading the in-process fake AI returns for this photo. */
  scenario: string | null;
  jobId: JobId | null;
  claimId: ClaimId | null;
  /** Historical seed photos have no job in this market but still count for duplicate checks. */
  historical: boolean;
  createdAt: number;
}

export class Store {
  readonly db: Database;
  readonly users: DocTable<UserDoc>;
  readonly books: DocTable<BookState>;
  readonly bids: DocTable<BidTask>;
  readonly holds: DocTable<Hold>;
  readonly asks: DocTable<AskTask>;
  readonly claims: DocTable<Claim>;
  readonly matches: DocTable<Match>;
  readonly jobs: DocTable<Job>;
  readonly proofs: DocTable<Proof>;
  readonly ledger: DocTable<LedgerEntry>;
  readonly payouts: DocTable<Payout>;
  readonly disputes: DocTable<Dispute>;
  readonly agentActions: DocTable<AgentAction>;
  readonly files: DocTable<StoredFile>;

  constructor(db: Database) {
    this.db = db;
    this.users = new DocTable<UserDoc>(db, 'users', [{ name: 'crowd', get: (d) => d.crowd }]);
    this.books = new DocTable<BookState>(db, 'books', [
      { name: 'shop_id', get: (d) => d.shopId },
      { name: 'status', get: (d) => d.status },
    ]);
    this.bids = new DocTable<BidTask>(db, 'bids', [
      { name: 'status', get: (d) => d.status },
      { name: 'item_id', get: (d) => d.itemId },
      { name: 'shop_id', get: (d) => d.shopId },
      { name: 'requester_id', get: (d) => d.requesterId },
    ]);
    this.holds = new DocTable<Hold>(db, 'holds', [
      { name: 'status', get: (d) => d.status },
      { name: 'bid_id', get: (d) => d.reference },
      { name: 'adapter', get: (d) => (d.clockBasis === 'real' ? 'sandbox' : 'fake') },
    ]);
    this.asks = new DocTable<AskTask>(db, 'asks', [
      { name: 'status', get: (d) => d.status },
      { name: 'item_id', get: (d) => d.itemId },
      { name: 'shop_id', get: (d) => d.shopId },
      { name: 'queuer_id', get: (d) => d.queuerId },
      { name: 'claim_id', get: (d) => d.claimId },
    ]);
    this.claims = new DocTable<Claim>(db, 'claims', [
      { name: 'status', get: (d) => d.status },
      { name: 'ask_id', get: (d) => d.askId },
      { name: 'queuer_id', get: (d) => d.queuerId },
      { name: 'shop_id', get: (d) => d.shopId },
    ]);
    this.matches = new DocTable<Match>(db, 'matches', [
      { name: 'item_id', get: (d) => d.itemId },
      { name: 'bid_id', get: (d) => d.bidId },
      { name: 'ask_id', get: (d) => d.askId },
      { name: 'at', get: (d) => d.at },
    ]);
    this.jobs = new DocTable<Job>(db, 'jobs', [
      { name: 'status', get: (d) => d.status },
      { name: 'bid_id', get: (d) => d.bidId },
      { name: 'ask_id', get: (d) => d.askId },
      { name: 'claim_id', get: (d) => d.claimId },
      { name: 'item_id', get: (d) => d.itemId },
      { name: 'requester_id', get: (d) => d.requesterId },
      { name: 'queuer_id', get: (d) => d.queuerId },
    ]);
    this.proofs = new DocTable<Proof>(db, 'proofs', [
      { name: 'status', get: (d) => d.status },
      { name: 'kind', get: (d) => d.kind },
      { name: 'claim_id', get: (d) => d.claimId },
      { name: 'job_id', get: (d) => d.jobId },
    ]);
    this.ledger = new DocTable<LedgerEntry>(db, 'ledger', [
      { name: 'kind', get: (d) => d.kind },
      { name: 'status', get: (d) => d.status },
      { name: 'user_id', get: (d) => d.userId },
      { name: 'hold_id', get: (d) => d.holdId },
      { name: 'bid_id', get: (d) => d.bidId },
      { name: 'job_id', get: (d) => d.jobId },
      { name: 'payout_id', get: (d) => d.payoutId },
      { name: 'idempotency_key', get: (d) => d.idempotencyKey, unique: true },
    ]);
    this.payouts = new DocTable<Payout>(db, 'payouts', [
      { name: 'status', get: (d) => d.status },
      { name: 'job_id', get: (d) => d.reference },
      { name: 'recipient_user_id', get: (d) => d.recipientUserId },
    ]);
    this.disputes = new DocTable<Dispute>(db, 'disputes', [
      { name: 'status', get: (d) => d.status },
      { name: 'job_id', get: (d) => d.jobId },
    ]);
    this.agentActions = new DocTable<AgentAction>(db, 'agent_actions', [{ name: 'bid_id', get: (d) => d.bidId }]);
    this.files = new DocTable<StoredFile>(db, 'files', [
      { name: 'owner_id', get: (d) => d.ownerId },
      { name: 'purpose', get: (d) => d.purpose },
      { name: 'sha256', get: (d) => d.ref.sha256 },
      { name: 'job_id', get: (d) => d.jobId },
      { name: 'claim_id', get: (d) => d.claimId },
    ]);
  }

  /** Empties every market table (demo reset). The events sequence keeps counting. */
  clearAll(): void {
    for (const t of [
      this.users,
      this.books,
      this.bids,
      this.holds,
      this.asks,
      this.claims,
      this.matches,
      this.jobs,
      this.proofs,
      this.ledger,
      this.payouts,
      this.disputes,
      this.agentActions,
      this.files,
    ]) {
      t.clear();
    }
    this.db.exec(
      'DELETE FROM ledger_requests; DELETE FROM idempotency; DELETE FROM fake_paypal; DELETE FROM paypal_sync; DELETE FROM webhook_events; DELETE FROM ai_calls; DELETE FROM meta;',
    );
  }
}
