import type { AgentAction, CheckoutFunding, FulfilmentMode, LedgerKind, LedgerStatus } from '@holdmyspot/shared';
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
  | 'bought' // receipt checked: shipped, the rest stays held until tracking; local, held until the handover code (D-115)
  | 'releasing' // giving the hold back
  | 'filled' // the last capture is in and the hold is closed
  | 'released' // cancelled by the requester or closed by a sell-out, hold released
  | 'missed' // the offer filled up while PayPal was approving, hold released
  | 'error';

/** The bidding agent on one request, when the requester turned it on (D-158). */
export interface OrderAgent {
  status: 'active' | 'paused' | 'done';
  /** The most it may set: what PayPal's hold covers per unit. */
  ceilingCents: Cents;
  actions: AgentAction[];
}

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
  /** Server driver: where the queuer's job for this request is (claimed, checked_in, queueing, bought, ...). */
  jobStatus?: string;
  chargedCents?: Cents;
  releasedCents?: Cents;
  /** In-browser market: when the queuer's receipt comes in (market clock). */
  receiptAt?: number;
  message?: string;
  /** Set only when the requester turned the agent on. */
  agent?: OrderAgent;
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

/** Whose phone a toast belongs to: the requester's, the queuer's, or whichever phone is on screen. */
export type ToastAudience = 'requester' | 'queuer' | 'any';

export interface Toast {
  id: number;
  text: string;
  tone: 'money' | 'info' | 'win';
  audience: ToastAudience;
}

/**
 * The toasts the phone on screen shows (D-132): a requester's money news never shows on the
 * queuer's phone and the other way round; the in-browser market and screen-wide notes use "any".
 */
export function toastsFor(toasts: readonly Toast[], phone: 'requester' | 'queuer'): Toast[] {
  return toasts.filter((t) => t.audience === 'any' || t.audience === phone);
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

/** Sandbox only: PayPal's own buttons (JS SDK v6), as far as they have loaded. */
export interface PayPalButtons {
  status: 'off' | 'loading' | 'ready' | 'failed';
  /** The eligible buttons the server allows, in order (PayPal first; Venmo only when eligible). */
  buttons: { funding: CheckoutFunding; productCode?: string; countryCode?: string }[];
  message: string | null;
}

/** What a click on PayPal's button asks for: book the best offer now, or rest at a max fee. */
export type BidChoice = { kind: 'now' } | { kind: 'max'; maxFeeCents: Cents; agent?: boolean };

export interface MarketDriver {
  requestNow(pointId: string): Promise<void>;
  setMax(pointId: string, maxFeeCents: Cents, agent?: boolean): Promise<void>;
  cancelMax(pointId: string): Promise<void>;
  take(pointId: string): Promise<void>;
  /** The viewer answered the Simulated PayPal sheet. */
  approve(ok: boolean): void;
  /** The shipping budget a request by the viewer adds to the hold (0 for a local errand). */
  shippingFor?(pointId: string): Cents;
  /** Sandbox: a click on one of PayPal's own buttons. Opens PayPal's window inside that click. */
  payWith?(pointId: string, choice: BidChoice, funding: CheckoutFunding): void;
  /** Sandbox: stop waiting for PayPal's approval of this point's request. */
  cancelApproval?(pointId: string): void;
  /** Sandbox: load PayPal's buttons again after a failure. */
  loadPayPal?(): void;
}

export interface MarketState {
  backend: 'connecting' | 'mock' | 'server';
  /** Server runtime mode: fake (Simulated PayPal) or sandbox. Null in the in-browser market. */
  serverMode: 'fake' | 'sandbox' | null;
  /**
   * Zero-key server (simulated PayPal, no live model): a photo with no recorded reading gets the
   * simulated reading the queuer picks on the phone (D-128).
   */
  simulatedReadings: boolean;
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
  /** Server mode: what the requester persona was charged (captures less refunds, succeeded). */
  chargedCents: Cents;
  toasts: Toast[];
  /** Increments when a point's book changes (a new request or a fill), so its label and item can bounce. */
  bumps: Record<string, number>;
  /** Increments when the viewer wins something, so the characters can hop. */
  celebration: Celebration;
  checkout: Checkout | null;
  /** Sandbox: PayPal's own buttons for the bid confirm step. */
  paypalButtons: PayPalButtons;
  /** Server mode: queuers the server walks over (queuer.moved, synthetic demo walks), by user id. */
  walkers: Record<string, { lngLat: [number, number]; at: number } | undefined>;
  driver: MarketDriver | null;

  select(id: string | null): void;
  requestNow(pointId: string): Promise<void>;
  setMax(pointId: string, maxFeeCents: Cents, agent?: boolean): Promise<void>;
  cancelMax(pointId: string): Promise<void>;
  take(pointId: string): Promise<void>;
  approveCheckout(ok: boolean): void;
  /** Sandbox: a click on one of PayPal's own buttons (call it inside the click). */
  payWith(pointId: string, choice: BidChoice, funding: CheckoutFunding): void;
  /** Sandbox: stop waiting for PayPal's approval. */
  cancelApproval(pointId: string): void;
  /** Sandbox: load PayPal's buttons again. */
  loadPayPal(): void;
  /** The shipping budget a request by the viewer adds to the hold (0 for a local errand). */
  shippingFor(pointId: string): Cents;
  /** Clears a finished order so the viewer can ask again. */
  clearOrder(pointId: string): void;
  toast(text: string, tone?: Toast['tone'], audience?: ToastAudience): void;
  dismissToast(id: number): void;
  bump(pointId: string): void;
  celebrate(pointId: string | null): void;
}

let toastSeq = 0;
/** Before a new toast for `audience`: keep the newest earlier toast that the same phone shows, and every toast for the other phone. */
function keepLatest(toasts: readonly Toast[], audience: ToastAudience): Toast[] {
  const shownWith = (t: Toast) => audience === 'any' || t.audience === 'any' || t.audience === audience;
  const same = toasts.filter(shownWith).slice(-1);
  return toasts.filter((t) => !shownWith(t) || same.includes(t));
}
const FINISHED: OrderStatus[] = ['released', 'missed', 'error', 'filled'];

/** Orders that are finished (or never started) leave the buttons free. */
export function isOpenOrder(order: UserOrder | undefined): boolean {
  return !order || FINISHED.includes(order.status);
}

export const useMarket = create<MarketState>()((set, get) => ({
  backend: 'connecting',
  serverMode: null,
  simulatedReadings: false,
  persona: null,
  points: [],
  selectedId: null,
  orders: {},
  taken: {},
  activity: [],
  heldCents: 0,
  paidOutCents: 0,
  chargedCents: 0,
  toasts: [],
  bumps: {},
  celebration: { n: 0, pointId: null },
  checkout: null,
  paypalButtons: { status: 'off', buttons: [], message: null },
  walkers: {},
  driver: null,

  select(id) {
    set({ selectedId: id });
  },
  async requestNow(pointId) {
    await get().driver?.requestNow(pointId);
  },
  async setMax(pointId, maxFeeCents, agent) {
    await get().driver?.setMax(pointId, maxFeeCents, agent);
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
  payWith(pointId, choice, funding) {
    get().driver?.payWith?.(pointId, choice, funding);
  },
  cancelApproval(pointId) {
    get().driver?.cancelApproval?.(pointId);
  },
  loadPayPal() {
    get().driver?.loadPayPal?.();
  },
  shippingFor(pointId) {
    return get().driver?.shippingFor?.(pointId) ?? 0;
  },
  clearOrder(pointId) {
    if (!isOpenOrder(get().orders[pointId])) return;
    set((s) => ({ orders: { ...s.orders, [pointId]: undefined } }));
  },
  toast(text, tone = 'info', audience = 'any') {
    const id = ++toastSeq;
    // The latest one of each audience stays, so a toast for the other phone never pushes this phone's out.
    set((s) => ({ toasts: [...keepLatest(s.toasts, audience), { id, text, tone, audience }] }));
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
