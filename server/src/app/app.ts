import { randomUUID } from 'node:crypto';
import { ContractError, ONE_TIME_CODE_ALPHABET } from '@holdmyspot/shared';
import type { MarketRules, ServerEventData, ServerEventType } from '@holdmyspot/shared';
import { MarketClock } from '../clock.ts';
import type { ServerConfig } from '../config.ts';
import { Database } from '../db/database.ts';
import { Store } from '../db/store.ts';
import { FakeAi } from '../fakes/ai.ts';
import { FakePayPal } from '../fakes/paypal.ts';
import type { AiPort } from '../ports/ai.ts';
import type { PaymentsPort } from '../ports/payments.ts';
import { runScoped } from '../ports/runscope.ts';
import { EventBus, type Audience } from '../realtime/bus.ts';
import { deriveCode, deriveDigits, newCodeSecret } from '../util/codes.ts';
import { Semaphore, Serial } from '../util/serial.ts';

/** Who is looking: a persona, ops (sees everything), or an anonymous map viewer. */
export interface Viewer {
  userId: string | null;
  ops: boolean;
}

export const OPS_VIEWER: Viewer = { userId: null, ops: true };

export type Adapter = 'fake' | 'sandbox';

export interface AppOptions {
  config: ServerConfig;
  clock?: MarketClock;
  ai?: AiPort;
  sandboxPayPal?: PaymentsPort | null;
  log?: (line: string) => void;
}

/**
 * The market kernel. Everything that changes state runs through `exec`
 * (one command at a time), writes inside `tx` (one SQLite transaction whose
 * events are delivered after commit), and reads time from `now()` (the
 * market clock, or the exact due time while scheduled work runs).
 */
export class App {
  readonly config: ServerConfig;
  readonly rules: MarketRules;
  readonly db: Database;
  readonly store: Store;
  readonly bus: EventBus;
  readonly clock: MarketClock;
  readonly fakePayPal: FakePayPal;
  sandboxPayPal: PaymentsPort | null;
  ai: AiPort;
  readonly log: (line: string) => void;
  bootId: string;
  readonly startedAt: number;
  /** Demo director, attached by the composition root when demo mode is on. */
  director: { nextDue(): { at: number; run: () => Promise<void>; key: string } | null } | null = null;

  readonly #serial = new Serial();
  readonly #background = new Set<Promise<void>>();
  readonly aiQueue = new Semaphore(2);
  #pinned: number | null = null;

  constructor(opts: AppOptions) {
    this.config = opts.config;
    this.rules = opts.config.rules;
    this.log = opts.log ?? (() => undefined);
    this.db = new Database(opts.config.dbPath);
    this.store = new Store(this.db);
    this.bus = new EventBus(this.db);
    const persisted = this.#persistedClock();
    this.clock =
      opts.clock ??
      new MarketClock({
        marketStart: persisted ?? opts.config.marketStart ?? Date.now(),
        speed: opts.config.clockSpeed,
      });
    this.fakePayPal = new FakePayPal(this.db, () => this.now(), opts.config.fakeFail);
    this.sandboxPayPal = opts.sandboxPayPal ?? null;
    this.ai = opts.ai ?? new FakeAi();
    this.bootId = randomUUID();
    this.startedAt = Date.now();
  }

  #persistedClock(): number | null {
    const raw = this.db.getMeta('clock');
    if (!raw) return null;
    const saved = JSON.parse(raw) as { marketNow: number };
    // Real-time markets catch up with the wall clock; demo markets resume where they stopped.
    if (this.config.marketStart === null && this.config.clockSpeed === 1 && !this.config.demo) return Math.max(saved.marketNow, Date.now());
    return saved.marketNow;
  }

  saveClock(): void {
    this.db.setMeta('clock', JSON.stringify(this.clock.state()));
  }

  /** Market time: the pinned due time while scheduled work runs, else the clock. */
  now(): number {
    return this.#pinned ?? this.clock.now();
  }

  /** Runs `fn` with `now()` fixed at `t` (scheduled work runs at its exact due time). */
  async atTime<T>(t: number, fn: () => Promise<T>): Promise<T> {
    const before = this.#pinned;
    this.#pinned = t;
    try {
      return await fn();
    } finally {
      this.#pinned = before;
    }
  }

  get pinned(): boolean {
    return this.#pinned !== null;
  }

  /** Serializes commands: matching, money calls and status changes never interleave. */
  exec<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.#serial.run(fn);
  }

  /** One SQLite transaction; events recorded inside are delivered after commit. */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn, { commit: () => this.bus.flush(), rollback: () => this.bus.discard() });
  }

  emit<T extends ServerEventType>(type: T, data: ServerEventData[T], audience: Audience): void {
    if (!this.db.inTransaction) {
      this.tx(() => this.emit(type, data, audience));
      return;
    }
    this.bus.record(type, this.now(), audience, data);
  }

  /** Starts async work outside the command queue (AI checks). `idle()` waits for all of it. */
  background(name: string, fn: () => Promise<void>): void {
    const p: Promise<void> = fn()
      .catch((err: unknown) => this.log(`background ${name} failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => this.#background.delete(p));
    this.#background.add(p);
  }

  async idle(): Promise<void> {
    while (this.#background.size > 0) await Promise.allSettled([...this.#background]);
    // Let commands queued by finished background work run too.
    await this.exec(() => undefined);
    if (this.#background.size > 0) await this.idle();
  }

  payments(adapter: Adapter): PaymentsPort {
    if (adapter === 'sandbox') {
      if (!this.sandboxPayPal) throw new ContractError('PAYPAL_UNAVAILABLE', 'The PayPal sandbox adapter is not loaded.');
      if (this.#scoped?.port !== this.sandboxPayPal) this.#scoped = { port: this.sandboxPayPal, scoped: runScoped(this.sandboxPayPal, () => this.paypalRun()) };
      return this.#scoped.scoped;
    }
    return this.fakePayPal;
  }

  #scoped: { port: PaymentsPort; scoped: PaymentsPort } | null = null;

  /**
   * This market run's id for PayPal (ports/runscope.ts): set on first use and
   * forgotten at a reset (the meta table is emptied), so every run sends
   * PayPal request ids and invoice ids it has never seen.
   */
  paypalRun(): string {
    let run = this.db.getMeta('paypal-run');
    if (!run) {
      run = Date.now().toString(36);
      this.db.setMeta('paypal-run', run);
    }
    return run;
  }

  /** Persona bids use the sandbox in sandbox mode; seeded crowd bids always use the fake. */
  adapterFor(opts: { crowd: boolean }): Adapter {
    return this.config.mode === 'sandbox' && this.sandboxPayPal && !opts.crowd ? 'sandbox' : 'fake';
  }

  /** Next sequential id for a prefix, for example bid_0001 (kept in the database). */
  nextId(prefix: string): string {
    const key = `seq:${prefix}`;
    const n = Number(this.db.getMeta(key) ?? '0') + 1;
    this.db.setMeta(key, String(n));
    return `${prefix}_${String(n).padStart(4, '0')}`;
  }

  #codeSecret(): string {
    let secret = this.db.getMeta('code-secret');
    if (!secret) {
      secret = this.config.deterministic ? `seed:${this.config.seed}` : newCodeSecret();
      this.db.setMeta('code-secret', secret);
    }
    return secret;
  }

  /**
   * A one-time code for a record (check-in, proof). `subject` names who and
   * where (`<queuerId>@<shopId>` for a check-in, `<requesterId>><queuerId>@<shopId>`
   * for a proof): a code pinned for that subject is used once instead.
   */
  code(kind: 'checkin' | 'proof', id: string, subject?: string): string {
    if (subject !== undefined && this.config.deterministic) {
      const pins = this.#pins();
      const key = `${kind}:${subject}`;
      const pinned = pins[key];
      if (pinned) {
        delete pins[key];
        this.db.setMeta('code-pins', JSON.stringify(pins));
        return pinned;
      }
    }
    return deriveCode(this.#codeSecret(), `${kind}:${id}`);
  }

  #pins(): Record<string, string> {
    const raw = this.db.getMeta('code-pins');
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  }

  /**
   * Demo staging only (deterministic markets: demo mode and tests). Pins the
   * code the next record for `subject` gets, so a pre-rendered photo that
   * shows that code matches (docs/DECISIONS.md D-48). Refused otherwise:
   * live markets always derive codes from their own secret.
   */
  pinCode(kind: 'checkin' | 'proof', subject: string, code: string): void {
    if (!this.config.deterministic) throw new ContractError('FORBIDDEN', 'Codes can only be pinned in a deterministic demo or test market.');
    if (code.length !== 5 || [...code].some((ch) => !ONE_TIME_CODE_ALPHABET.includes(ch))) throw new ContractError('BAD_REQUEST', `Not a one-time code: ${code}.`);
    const pins = this.#pins();
    pins[`${kind}:${subject}`] = code;
    this.db.setMeta('code-pins', JSON.stringify(pins));
  }

  /** A numeric code for a record (handover). */
  digits(kind: string, id: string): string {
    return deriveDigits(this.#codeSecret(), `${kind}:${id}`);
  }

  close(): void {
    this.saveClock();
    this.db.close();
  }
}
