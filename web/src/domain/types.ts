import type { CityId, FeeClock, FulfilmentMode, ItemKind, LngLat } from '@holdmyspot/shared';
import type { Cents } from './money';

export type { ItemKind };

/** Which 3D model and icon an item uses within its kind. */
export type ItemLook = 'bunny' | 'cat' | 'otter' | 'pup' | 'cake' | 'ramen';

export interface Shop {
  id: string;
  name: string;
  street: string;
  /** Local opening hours, "HH:MM". */
  hours: { opens: string; closes: string };
  timezone: string;
}

/**
 * A resting request on the queue fee. Every request is backed by a PayPal
 * hold, so it is real money, not a like. `feeCents` is the most the requester
 * pays a queuer per unit; the item itself is paid at the shop price.
 */
export interface Bid {
  id: string;
  bidder: string;
  feeCents: Cents;
  qty: number;
  placedAt: number;
  deadlineAt: number;
  mode: FulfilmentMode;
  mine?: boolean;
}

export interface QueueInfo {
  /** Estimated wait in the shop's line, in minutes. */
  minutes: number;
  peopleAhead: number | null;
  /** HoldMySpot queuers who are in this line right now. */
  queuers: string[];
}

/**
 * A queuer's offer to stand in line (an ask on the queue fee). The fee is
 * fixed, or steps down on a clock (open, step, interval, floor) that starts
 * only when the queuer checks in at the shop.
 */
export interface FeeOffer {
  askId: string;
  queuerName: string;
  /** Units the queuer can buy on this visit (at most the shop's per-person limit). */
  capacity: number;
  /** Units still open. */
  supply: number;
  /** The fixed fee, or the opening fee of the clock. */
  feeCents: Cents;
  clock: FeeClock | null;
  /** On the way (the clock waits) or in line (the clock runs). */
  checkedIn: boolean;
  etaAt: number;
  modes: FulfilmentMode[];
  /** One line of plain context with no counts. */
  note: string;
}

/** Depth of the resting requests by fee, best first. */
export interface DepthLevel {
  feeCents: Cents;
  qty: number;
  count: number;
}

export interface TaskPoint {
  /** The item id, also the book key on the server. */
  id: string;
  cityId: CityId | 'taipei';
  kind: ItemKind;
  look: ItemLook;
  itemName: string;
  /** Short name for labels on the map. */
  itemShort: string;
  shop: Shop;
  /** Shop price, paid at cost from the receipt. */
  retailCents: Cents;
  perPersonLimit: number;
  modes: FulfilmentMode[];
  /** Lowest fee per unit an offer or a request may name. */
  minFeeCents: Cents;
  /** Plain-language facts shown as small tags (rules that apply to this item). */
  tags: string[];
  /** Where the shop is. The 3D view snaps it to the nearest street. */
  lngLat: LngLat;
  queue: QueueInfo;
  /**
   * Single requests when they are known (the in-browser market). The server
   * keeps single requests private and sends depth only.
   */
  bids: Bid[];
  depth: DepthLevel[];
  bidCount: number;
  bidQty: number;
  /** The best max fee among resting requests, or null when nobody is asking. */
  bestFeeCents: Cents | null;
  /** The latest deadline among resting requests: a queuer arriving later can take none of them. */
  latestDeadlineAt: number | null;
  /** The cheapest offer now, then the others. */
  offers: FeeOffer[];
  /** Mock only: queuers waiting to post the next offer when the current one is used up. */
  next: Omit<FeeOffer, 'askId' | 'supply' | 'etaAt' | 'checkedIn'>[];
  /** Accent colour for this item's glow and tag. */
  hue: string;
  status: 'open' | 'sold_out' | 'closed';
}
