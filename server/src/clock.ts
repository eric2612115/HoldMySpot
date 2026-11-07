import { ContractError } from '@holdmyspot/shared';
import type { ClockState } from '@holdmyspot/shared';

/**
 * The market clock (docs/ARCHITECTURE.md section 8). The server owns market
 * time: speed 1 to 600, pause, and forward-only jumps, so ids and timestamps
 * stay monotonic. Clients compute now as marketNow + (Date.now() - realNow) *
 * speed unless paused. Money never depends on speed.
 */
export class MarketClock {
  #speed: number;
  #paused: boolean;
  #anchorMarket: number;
  #anchorReal: number;
  #last: number;
  readonly #realNow: () => number;

  constructor(opts: { marketStart: number; speed?: number; paused?: boolean; realNow?: () => number }) {
    this.#realNow = opts.realNow ?? Date.now;
    this.#speed = opts.speed ?? 1;
    this.#paused = opts.paused ?? false;
    this.#anchorMarket = Math.floor(opts.marketStart);
    this.#anchorReal = this.#realNow();
    this.#last = this.#anchorMarket;
  }

  realNow(): number {
    return this.#realNow();
  }

  /** Current market time in epoch ms; never goes backward. */
  now(): number {
    const t = this.#paused ? this.#anchorMarket : this.#anchorMarket + (this.#realNow() - this.#anchorReal) * this.#speed;
    const m = Math.max(Math.floor(t), this.#last);
    this.#last = m;
    return m;
  }

  get speed(): number {
    return this.#speed;
  }

  get paused(): boolean {
    return this.#paused;
  }

  state(): ClockState {
    const marketNow = this.now();
    return { speed: this.#speed, paused: this.#paused, marketNow, realNow: this.#realNow() };
  }

  #reanchor(): void {
    this.#anchorMarket = this.now();
    this.#anchorReal = this.#realNow();
  }

  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed < 1 || speed > 600) throw new ContractError('BAD_REQUEST', 'Clock speed must be between 1 and 600.');
    this.#reanchor();
    this.#speed = speed;
  }

  pause(): void {
    if (this.#paused) return;
    this.#reanchor();
    this.#paused = true;
  }

  resume(): void {
    if (!this.#paused) return;
    this.#anchorReal = this.#realNow();
    this.#paused = false;
  }

  /** Jumps forward to `t`. Jumping backward is refused. */
  jumpTo(t: number): void {
    const now = this.now();
    if (!Number.isFinite(t) || t < now) {
      throw new ContractError('BAD_REQUEST', 'The market clock only jumps forward.', { now, requested: t });
    }
    this.#anchorMarket = Math.floor(t);
    this.#anchorReal = this.#realNow();
    this.#last = this.#anchorMarket;
  }

  /** Starts a new market (demo reset only): the one place time may move backward. */
  reset(opts: { marketStart: number; speed?: number; paused?: boolean }): void {
    this.#anchorMarket = Math.floor(opts.marketStart);
    this.#anchorReal = this.#realNow();
    this.#last = this.#anchorMarket;
    if (opts.speed !== undefined) this.#speed = opts.speed;
    if (opts.paused !== undefined) this.#paused = opts.paused;
  }
}
