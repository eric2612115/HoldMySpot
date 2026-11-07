import { formatUsd, money, type Cents } from '../../domain/money';
import {
  PaymentError,
  type Activity,
  type ActivityKind,
  type Hold,
  type PaymentsService,
  type Payout,
  type PayoutInput,
  type PlaceHoldInput,
} from './types';

export interface MockPaymentsOptions {
  /** Simulated network and approval time in ms. Use 0 in tests. */
  latencyMs?: number;
  now?: () => number;
}

/**
 * In-browser stand-in for PayPal. It enforces the same rules the real
 * integration must follow: you cannot capture more than was held, a final
 * capture releases the rest, and a released hold cannot be captured.
 */
export class MockPaymentsService implements PaymentsService {
  readonly mode = 'mock' as const;
  private readonly latencyMs: number;
  private readonly now: () => number;
  private holdsById = new Map<string, Hold>();
  private log: Activity[] = [];
  private listeners = new Set<() => void>();
  private seq = 0;

  constructor(opts: MockPaymentsOptions = {}) {
    this.latencyMs = opts.latencyMs ?? 650;
    this.now = opts.now ?? (() => Date.now());
  }

  async placeHold(input: PlaceHoldInput): Promise<Hold> {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new PaymentError('INVALID_AMOUNT', 'A hold needs a positive amount in whole cents.');
    }
    await this.wait();
    const hold: Hold = {
      id: this.id('AUTH'),
      reference: input.reference,
      description: input.description,
      amount: money(input.amountCents),
      capturedCents: 0,
      releasedCents: 0,
      status: 'held',
      createdAt: this.now(),
    };
    this.holdsById.set(hold.id, hold);
    this.record('held', input.amountCents, `Held on your PayPal for ${input.description}. Not charged yet.`, { holdId: hold.id });
    return { ...hold };
  }

  async capture(holdId: string, amountCents: Cents, opts: { description: string; final: boolean }): Promise<Hold> {
    const hold = this.open(holdId);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new PaymentError('INVALID_AMOUNT', 'A capture needs a positive amount in whole cents.');
    }
    const remaining = this.remaining(hold);
    if (amountCents > remaining) {
      throw new PaymentError(
        'OVER_CAPTURE',
        `Cannot capture ${formatUsd(amountCents, { exact: true })}: only ${formatUsd(remaining, { exact: true })} is held.`,
      );
    }
    await this.wait();
    this.open(holdId); // still open after the round trip?
    hold.capturedCents += amountCents;
    const left = this.remaining(hold);
    const released = opts.final ? left : 0;
    hold.releasedCents += released;
    hold.status = opts.final || this.remaining(hold) === 0 ? 'captured' : 'partially_captured';
    this.record('captured', amountCents, `Charged for ${opts.description}.`, { holdId });
    if (released > 0) {
      this.record('released', released, `Back to you: the rest of the hold for ${hold.description}.`, { holdId });
    }
    return { ...hold };
  }

  async release(holdId: string, opts: { description: string }): Promise<Hold> {
    const hold = this.open(holdId);
    await this.wait();
    this.open(holdId);
    const left = this.remaining(hold);
    hold.releasedCents += left;
    hold.status = 'released';
    if (left > 0) this.record('released', left, `Back to you: ${opts.description}.`, { holdId });
    this.emit();
    return { ...hold };
  }

  async payout(input: PayoutInput): Promise<Payout> {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new PaymentError('INVALID_AMOUNT', 'A payout needs a positive amount in whole cents.');
    }
    await this.wait();
    const payout: Payout = {
      id: this.id('PAYOUT'),
      recipient: input.recipient,
      amount: money(input.amountCents),
      note: input.note,
      reference: input.reference,
      createdAt: this.now(),
    };
    this.record('paid_out', input.amountCents, `Paid out to ${input.recipient} for ${input.note}.`, { payoutId: payout.id });
    return payout;
  }

  activity(): Activity[] {
    return this.log;
  }

  holds(): Hold[] {
    return [...this.holdsById.values()].map((h) => ({ ...h }));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private open(holdId: string): Hold {
    const hold = this.holdsById.get(holdId);
    if (!hold) throw new PaymentError('HOLD_NOT_FOUND', `No hold with id ${holdId}.`);
    if (hold.status === 'captured' || hold.status === 'released') {
      throw new PaymentError('HOLD_CLOSED', 'This hold is already closed.');
    }
    return hold;
  }

  private remaining(hold: Hold): Cents {
    return hold.amount.cents - hold.capturedCents - hold.releasedCents;
  }

  private record(kind: ActivityKind, cents: Cents, text: string, ids: { holdId?: string; payoutId?: string }) {
    // A new array each time, so React can tell the activity changed.
    this.log = [{ id: this.id('ACT'), kind, amount: money(cents), text, at: this.now(), ...ids }, ...this.log];
    this.emit();
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(4, '0')}`;
  }

  private wait(): Promise<void> {
    if (this.latencyMs <= 0) return Promise.resolve();
    const jitter = this.latencyMs * (0.75 + Math.random() * 0.5);
    return new Promise((r) => setTimeout(r, jitter));
  }
}
