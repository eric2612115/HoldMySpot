import type { FulfilmentMode, LedgerKind, LedgerStatus } from '@holdmyspot/shared';
import { create } from 'zustand';
import type { Cents } from '../domain/money';
import type { TaskPoint } from '../domain/types';

/**
 * The app's market state. Two drivers fill it:
 * - the in-browser market (state/mockMarket.ts): its own books, crowd and payments mock;
 * - the HoldMySpot server (state/serverMarket.ts): shops and books over REST, then SSE,
 *   the persona's own requests and the real ledger (fake PayPal mode or the sandbox).
 * Screens only read this store and call its actions.
 */

export type OrderStatus =
  | 'approving' // waiting for PayPal approval and the hold
  | 'resting' // a max fee is held and waits in the book for an offer to reach it
  | 'booked' // a queuer is booked; waiting for the receipt
  | 'settling' // capturing and paying out
  | 'releasing' // giving the hold back
  | 'filled'
  | 'released' // cancelled by the requester, hold released
  | 'missed' // the offer filled up while PayPal was approving, hold released
  | 'error';

export interface UserOrder {
  pointId: string;
  /** now: at or above the best offer, fills at once. max: rests below it. */
  kind: 'now' | 'max';
  status: OrderStatus;
  mode: FulfilmentMode;
  /** The most the requester pays a queuer per unit. */
  maxFeeCents?: Cents;
  holdId?: string;
  holdCents?: Cents;
  bidId?: string;
  /** The fee it filled at (the offer's fee at that moment). */
  fillFeeCents?: Cents;
  queuerName?: string;
  chargedCents?: Cents;
  releasedCents?: Cents;
  /** In-browser market: when the queuer's receipt comes in (market clock). */
  receiptAt?: number;
  message?: string;
}

/** A task the viewer took as a queuer. */
export interface TakenTask {
  pointId: string;
  feeCents: Cents;
  status: 'posting' | 'taken' | 'error';
  at: number;
  /** When the arrival window ends: check in at the shop before then. */
  windowEndsAt?: number;
  message?: string;
}

/** One line of the money panel. Same words as the server's ledger. */
export interface ActivityRow {
  id: string;
  kind: LedgerKind;
  amountCents: Cents;
  text: string;
  at: number;
  status: LedgerStatus;
  bidId?: string | null;
  holdId?: string | null;
  /** Whose money line this is (server mode shows the requester's and the queuer's together). */
  who?: string;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'money' | 'info' | 'win';
}

export interface Celebration {
  n: number;
  pointId: string | null;
}

/** The "Simulated PayPal" sheet (server in fake mode): the buyer approves the hold here instead of PayPal's page. */
export interface Checkout {
  pointId: string;
  amountCents: Cents;
  description: string;
  /** The bid form's required sentences (docs/DOMAIN.md section 9), with this hold's numbers. */
  disclosures: string[];
}

export interface Persona {
  requesterId: string;
  requesterName: string;
  requesterCity: string;
  queuerId: string;
  queuerName: string;
}

export interface MarketDriver {
  requestNow(pointId: string): Promise<void>;
  setMax(pointId: string, maxFeeCents: Cents): Promise<void>;
  cancelMax(pointId: string): Promise<void>;
  take(pointId: string): Promise<void>;
  /** The viewer answered the Simulated PayPal sheet. */
  approve(ok: boolean): void;
  /** The shipping budget a request by the viewer adds to the hold (0 for a local errand). */
  shippingFor?(pointId: string): Cents;
}

export interface MarketState {
  backend: 'connecting' | 'mock' | 'server';
  /** Server runtime mode: fake (Simulated PayPal) or sandbox. Null in the in-browser market. */
  serverMode: 'fake' | 'sandbox' | null;
  persona: Persona | null;
  points: TaskPoint[];
  selectedId: string | null;
  orders: Record<string, UserOrder | undefined>;
  taken: Record<string, TakenTask | undefined>;
  activity: ActivityRow[];
  /** Total still held on the viewer's PayPal. */
  heldCents: Cents;
  /** Server mode: what PayPal Payouts sent to the queuer persona (succeeded). */
  paidOutCents: Cents;
  toasts: Toast[];
  /** Increments when a point's book changes (a new request or a fill), so its label and item can bounce. */
  bumps: Record<string, number>;
  /** Increments when the viewer wins something, so the characters can hop. */
  celebration: Celebration;
  checkout: Checkout | null;
  /** Server mode: queuers the server walks over (queuer.moved, synthetic demo walks), by user id. */
  walkers: Record<string, { lngLat: [number, number]; at: number } | undefined>;
  driver: MarketDriver | null;

  select(id: string | null): void;
  requestNow(pointId: string): Promise<void>;
  setMax(pointId: string, maxFeeCents: Cents): Promise<void>;
  cancelMax(pointId: string): Promise<void>;
  take(pointId: string): Promise<void>;
  approveCheckout(ok: boolean): void;
  /** The shipping budget a request by the viewer adds to the hold (0 for a local errand). */
  shippingFor(pointId: string): Cents;
  /** Clears a finished order so the viewer can ask again. */
  clearOrder(pointId: string): void;
  toast(text: string, tone?: Toast['tone']): void;
  dismissToast(id: number): void;
  bump(pointId: string): void;
  celebrate(pointId: string | null): void;
}

let toastSeq = 0;
const FINISHED: OrderStatus[] = ['released', 'missed', 'error', 'filled'];

/** Orders that are finished (or never started) leave the buttons free. */
export function isOpenOrder(order: UserOrder | undefined): boolean {
  return !order || FINISHED.includes(order.status);
}

export const useMarket = create<MarketState>()((set, get) => ({
  backend: 'connecting',
  serverMode: null,
  persona: null,
  points: [],
  selectedId: null,
  orders: {},
  taken: {},
  activity: [],
  heldCents: 0,
  paidOutCents: 0,
  toasts: [],
  bumps: {},
  celebration: { n: 0, pointId: null },
  checkout: null,
  walkers: {},
  driver: null,

  select(id) {
    set({ selectedId: id });
  },
  async requestNow(pointId) {
    await get().driver?.requestNow(pointId);
  },
  async setMax(pointId, maxFeeCents) {
    await get().driver?.setMax(pointId, maxFeeCents);
  },
  async cancelMax(pointId) {
    await get().driver?.cancelMax(pointId);
  },
  async take(pointId) {
    await get().driver?.take(pointId);
  },
  approveCheckout(ok) {
    get().driver?.approve(ok);
  },
  shippingFor(pointId) {
    return get().driver?.shippingFor?.(pointId) ?? 0;
  },
  clearOrder(pointId) {
    if (!isOpenOrder(get().orders[pointId])) return;
    set((s) => ({ orders: { ...s.orders, [pointId]: undefined } }));
  },
  toast(text, tone = 'info') {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-1), { id, text, tone }] }));
    window.setTimeout(() => get().dismissToast(id), 4600);
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  bump(pointId) {
    set((s) => ({ bumps: { ...s.bumps, [pointId]: (s.bumps[pointId] ?? 0) + 1 } }));
  },
  celebrate(pointId) {
    set((s) => ({ celebration: { n: s.celebration.n + 1, pointId } }));
  },
}));

/** Replaces one point in the store. */
export function patchPoint(pointId: string, fn: (p: TaskPoint) => TaskPoint): void {
  useMarket.setState((s) => ({ points: s.points.map((p) => (p.id === pointId ? fn(p) : p)) }));
}

export function patchOrder(pointId: string, patch: Partial<UserOrder>): void {
  useMarket.setState((s) => {
    const prev = s.orders[pointId];
    if (!prev) return {};
    return { orders: { ...s.orders, [pointId]: { ...prev, ...patch } } };
  });
}

export function setOrder(order: UserOrder): void {
  useMarket.setState((s) => ({ orders: { ...s.orders, [order.pointId]: order } }));
}
