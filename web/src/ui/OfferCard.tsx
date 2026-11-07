import { askSchedule, bidDisclosures, fillPriceForMax, nextDropAt, nextPriceAfter, reachesAt } from '@holdmyspot/shared';
import type { CheckoutFunding, StepDownSchedule } from '@holdmyspot/shared';
import { useState } from 'react';
import { bestOffer, holdFor, offerFeeAt, retailCapFor, supplyLabel } from '../domain/book';
import { formatUsd, type Cents } from '../domain/money';
import type { FeeOffer, TaskPoint } from '../domain/types';
import { isOpenOrder, useMarket, type UserOrder } from '../state/market';
import { clock } from '../state/services';
import { BookGlyph } from './book/BookStrip';
import { openBook } from './book/store';
import { mmss, useNow } from './hooks';
import { PayPalButton, PayPalSdkButtons } from './PayPalButton';
import { PriceStairs } from './PriceStairs';

/**
 * The queue fee of the best offer at a shop: a queuer's fee, fixed or stepping
 * down on a clock (open, step, interval, floor) that starts when the queuer
 * checks in. A requester books it now, or sets a max fee that rests as a
 * PayPal hold until an offer reaches it. The item is paid at the shop price
 * from the receipt; nothing here sells an item already in hand.
 */

function minutesWord(ms: number) {
  return `${Math.max(1, Math.round(ms / 60_000))} min`;
}

const clockTime = (t: number, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(t);

/** The schedule to draw: the running clock, or a preview from the ETA before check-in. */
function scheduleOf(offer: FeeOffer): { schedule: StepDownSchedule; preview: boolean } | null {
  if (!offer.clock) return null;
  const running = askSchedule(offer);
  if (running) return { schedule: running, preview: false };
  return {
    schedule: { openCents: offer.feeCents, stepCents: offer.clock.stepCents, intervalMs: offer.clock.intervalMs, floorCents: offer.clock.floorCents, startsAt: offer.etaAt },
    preview: true,
  };
}

/** The bid form's two required sentences (docs/DOMAIN.md section 9) for one unit at `feeCents`. */
function disclosuresFor(point: TaskPoint, feeCents: Cents, shippingCents: Cents): string[] {
  return bidDisclosures({ qty: 1, retailCapCents: retailCapFor(point.retailCents), maxFeeCents: feeCents, shippingBudgetCents: shippingCents, mode: shippingCents > 0 ? 'ship' : 'local' });
}

function Disclosures({ lines }: { lines: string[] }) {
  return (
    <div className="disclose">
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </div>
  );
}

/** What the card says when no offer is open: sold out, nobody offered yet, or every queuer here is booked. */
function noOfferNote(point: TaskPoint, order: UserOrder | undefined): string {
  if (point.status === 'sold_out') return `${point.shop.name} has sold out of the ${point.itemShort}.`;
  const inLine = point.queue.queuers;
  const mine = order && (order.status === 'booked' || order.status === 'settling' || order.status === 'bought' || order.status === 'filled') ? order.queuerName : undefined;
  if (mine) return `${mine} took your request. No other offer is open right now.`;
  if (inLine.length > 0 || point.offers.length > 0) {
    const who = inLine.length === 0 ? 'Every queuer here' : inLine.length === 1 ? inLine[0] : `${inLine.slice(0, -1).join(', ')} and ${inLine[inLine.length - 1]}`;
    return `${who} ${inLine.length === 1 ? 'is' : 'are'} fully booked. Set your max fee: the next offer that reaches it takes your request.`;
  }
  return 'No queuer has offered yet. Set your max fee: the first offer that reaches it takes your request.';
}

/** Requests that fill before the viewer's: a higher max fee, or the same placed earlier. */
function bidsAhead(point: TaskPoint, bidId: string | undefined): number | null {
  const mine = point.bids.find((b) => b.id === bidId);
  if (!mine) return null;
  return point.bids.filter((b) => b.id !== mine.id && (b.feeCents > mine.feeCents || (b.feeCents === mine.feeCents && b.placedAt < mine.placedAt))).length;
}

export function OfferCard({ point, blockedReason }: { point: TaskPoint; blockedReason: string | null }) {
  const now = useNow(200);
  const order = useMarket((s) => s.orders[point.id]);
  const requestNow = useMarket((s) => s.requestNow);
  const setMax = useMarket((s) => s.setMax);
  const cancelMax = useMarket((s) => s.cancelMax);
  const clearOrder = useMarket((s) => s.clearOrder);
  const payWith = useMarket((s) => s.payWith);
  const cancelApproval = useMarket((s) => s.cancelApproval);
  // A server in sandbox mode: PayPal's own buttons replace the placeholder ones (fake mode keeps the Simulated PayPal sheet).
  const sandbox = useMarket((s) => s.backend === 'server' && s.serverMode === 'sandbox');
  const [picking, setPicking] = useState(false);

  const offer = bestOffer(point, now);
  const fee = offer ? offerFeeAt(offer, now) : null;
  const sched = offer ? scheduleOf(offer) : null;
  const nextAt = offer && sched && !sched.preview ? nextDropAt(sched.schedule, now) : null;
  const nextFee = offer && sched && !sched.preview ? nextPriceAfter(sched.schedule, now) : null;
  const approvingMax = order?.kind === 'max' && order.status === 'approving';
  const showPicker = (picking && isOpenOrder(order) && order?.status !== 'filled') || approvingMax;
  const tz = point.shop.timezone;

  return (
    <section className="auction" style={{ ['--hue' as string]: point.hue }} aria-labelledby={`offer-${point.id}`}>
      <header className="auction__head">
        <h3 id={`offer-${point.id}`}>{offer ? (offer.clock ? (sched?.preview ? 'Queue fee, steps down after check-in' : 'Queue fee, stepping down') : 'Queue fee, fixed') : 'Queue fee'}</h3>
        {offer && <span className={`supply${offer.supply <= 0 ? ' is-out' : ''}`}>{supplyLabel(offer.supply)}</span>}
      </header>
      <p className="auction__note">{offer ? offer.note : noOfferNote(point, order)}</p>

      {offer && fee !== null && (
        <>
          <div className="auction__numbers">
            <div className="auction__price">
              <span key={`${offer.askId}-${fee}`} className="auction__big">
                {formatUsd(fee)}
              </span>
              <span className="auction__caption">{sched?.preview ? `${offer.queuerName}'s opening fee` : `${offer.queuerName}'s fee now`}</span>
            </div>
            <div className="auction__timer" aria-live="off">
              {sched && !sched.preview && nextAt !== null && (
                <>
                  <span className="auction__caption">next drop in</span>
                  <span className="auction__clock">{mmss(nextAt - now)}</span>
                  {nextFee !== null && <span className="auction__caption">to {formatUsd(nextFee)}</span>}
                </>
              )}
              {sched && !sched.preview && nextAt === null && (
                <>
                  <span className="auction__caption">at the floor</span>
                  <span className="auction__clock">{formatUsd(sched.schedule.floorCents)}</span>
                </>
              )}
              {sched?.preview && (
                <>
                  <span className="auction__caption">clock starts</span>
                  <span className="auction__clock">at check-in</span>
                  <span className="auction__caption">arriving {clockTime(offer.etaAt, tz)}</span>
                </>
              )}
              {!sched && (
                <>
                  <span className="auction__caption">{offer.checkedIn ? 'in line now' : 'on the way'}</span>
                  <span className="auction__clock">{offer.checkedIn ? 'fixed' : clockTime(offer.etaAt, tz)}</span>
                </>
              )}
            </div>
          </div>
          {sched && <PriceStairs schedule={sched.schedule} now={now} hue={point.hue} preview={sched.preview} maxCents={order?.status === 'resting' ? order.maxFeeCents : undefined} />}
          {sched && (
            <button type="button" className="text-button auction__book" onClick={() => openBook(point.id, 'sheet')}>
              <BookGlyph /> Watch it step down against every request
            </button>
          )}
          <p className="auction__rule">
            {sched
              ? `Opens at ${formatUsd(sched.schedule.openCents)}, drops ${formatUsd(sched.schedule.stepCents)} every ${minutesWord(sched.schedule.intervalMs)}, never below ${formatUsd(sched.schedule.floorCents)}. ${sched.preview ? `The clock starts when ${offer.queuerName} checks in.` : `It started when ${offer.queuerName} checked in.`}`
              : `${offer.queuerName} asks a fixed ${formatUsd(fee)} per ${point.kind === 'ramen' ? 'bowl' : point.kind}.`}{' '}
            You also pay the {point.itemShort} at the shop price, {formatUsd(point.retailCents)}, from the receipt.
          </p>
        </>
      )}

      {blockedReason ? (
        <>
          {/* A sell-out blocks new requests, but the viewer's own request still says where it stands (D-116). */}
          {order && <OrderNote point={point} order={order} offer={offer} now={now} onCancel={() => void cancelMax(point.id)} />}
          <p className="auction__fine">{blockedReason}</p>
        </>
      ) : showPicker ? (
        <MaxPicker
          point={point}
          offerFee={fee}
          offer={offer}
          busy={approvingMax}
          sandbox={sandbox}
          onCancel={() => setPicking(false)}
          onConfirm={(cents) => {
            setPicking(false);
            void setMax(point.id, cents);
          }}
          onPay={(cents, funding) => {
            setPicking(false);
            payWith(point.id, { kind: 'max', maxFeeCents: cents }, funding);
          }}
          onStopWaiting={() => cancelApproval(point.id)}
        />
      ) : (
        <ActionZone
          point={point}
          offer={offer}
          fee={fee}
          order={order}
          now={now}
          sandbox={sandbox}
          onBook={() => void requestNow(point.id)}
          onPayNow={(funding) => payWith(point.id, { kind: 'now' }, funding)}
          onStopWaiting={() => cancelApproval(point.id)}
          onPick={() => setPicking(true)}
          onCancel={() => void cancelMax(point.id)}
          onAgain={() => clearOrder(point.id)}
        />
      )}
    </section>
  );
}

function ActionZone({
  point,
  offer,
  fee,
  order,
  now,
  sandbox,
  onBook,
  onPayNow,
  onStopWaiting,
  onPick,
  onCancel,
  onAgain,
}: {
  point: TaskPoint;
  offer: FeeOffer | null;
  fee: Cents | null;
  order: UserOrder | undefined;
  now: number;
  /** PayPal's own buttons (server in sandbox mode) instead of the placeholder. */
  sandbox: boolean;
  onBook: () => void;
  /** Sandbox: called inside the click on PayPal's button. */
  onPayNow: (funding: CheckoutFunding) => void;
  onStopWaiting: () => void;
  onPick: () => void;
  onCancel: () => void;
  onAgain: () => void;
}) {
  const status = order?.status;
  const full = !offer || offer.supply <= 0;

  if (status === 'resting' || status === 'booked' || status === 'settling' || status === 'bought') return <OrderStatus point={point} order={order!} offer={offer} now={now} onCancel={onCancel} />;

  if (status === 'filled') {
    const charged = formatUsd(order?.chargedCents ?? 0, { exact: true });
    return (
      <div className="auction__actions">
        <PayPalButton state="done" label={`Paid ${charged} with PayPal`} onClick={() => {}} />
        <OrderStatus point={point} order={order!} offer={offer} now={now} onCancel={onCancel} />
        <button type="button" className="text-button auction__again" onClick={onAgain}>
          Ask for another
        </button>
      </div>
    );
  }

  // A request in flight: the button keeps its place and says what PayPal is doing.
  const inFlight = status === 'approving' || status === 'releasing';
  const waitingLabel = status === 'approving' ? 'Waiting for PayPal approval' : 'Releasing your hold';
  const shipping = useMarket.getState().shippingFor(point.id);
  const holdCents = order?.holdCents ?? holdFor(point, fee ?? point.minFeeCents, 1, shipping);

  return (
    <div className="auction__actions">
      {status === 'error' && <p className="auction__error">{order?.message}</p>}
      {(status === 'released' || status === 'missed') && <p className="auction__done">{closedText(order!)}</p>}
      {offer && fee !== null && sandbox && (
        <PayPalSdkButtons
          lead={`Book ${offer.queuerName} now for ${formatUsd(fee)} with`}
          waiting={status === 'approving' && order?.kind === 'now'}
          disabled={full || inFlight}
          onPay={onPayNow}
          onStopWaiting={onStopWaiting}
        />
      )}
      {offer && fee !== null && !sandbox && (
        <PayPalButton state={inFlight && order?.kind === 'now' ? 'waiting' : 'ready'} waitingLabel={waitingLabel} disabled={full || inFlight} label={`Book ${offer.queuerName} now for ${formatUsd(fee)}`} onClick={onBook} />
      )}
      <button type="button" className={offer ? 'ghost-button' : 'pp-button is-ready'} disabled={inFlight} onClick={onPick}>
        Set my max fee
      </button>
      {inFlight ? (
        <p className="auction__fine">PayPal holds up to {formatUsd(holdCents, { exact: true })}. You are charged from the receipt, with processing at cost; the rest is released.</p>
      ) : offer && fee !== null ? (
        <>
          <p className="auction__fine">First to accept wins while spots last.</p>
          <Disclosures lines={disclosuresFor(point, fee, shipping)} />
        </>
      ) : (
        <p className="auction__fine">
          PayPal holds the shop price cap, your max fee{shipping > 0 ? ', a shipping budget' : ''} and processing at cost. Nothing is charged until a queuer&rsquo;s receipt is checked.
        </p>
      )}
    </div>
  );
}

/** The line under a request that closed without a charge: why, and what went back. */
function closedText(order: UserOrder): string {
  const why = order.status === 'missed' ? `${order.queuerName ?? 'The queuer'} was fully booked while PayPal was approving. ` : order.message ? `${order.message} ` : 'Cancelled. ';
  return `${why}${(order.releasedCents ?? 0) > 0 ? `${formatUsd(order.releasedCents ?? 0, { exact: true })} went back to you.` : ''}`.trim();
}

/** The viewer's own request where new requests are blocked (a sell-out): its card or its closing line, no buttons. */
function OrderNote({ point, order, offer, now, onCancel }: { point: TaskPoint; order: UserOrder; offer: FeeOffer | null; now: number; onCancel: () => void }) {
  if (order.status === 'released' || order.status === 'missed') return <p className="auction__done">{closedText(order)}</p>;
  if (order.status === 'error') return order.message ? <p className="auction__error">{order.message}</p> : null;
  return <OrderStatus point={point} order={order} offer={offer} now={now} onCancel={onCancel} />;
}

function OrderStatus({ point, order, offer, now, onCancel }: { point: TaskPoint; order: UserOrder; offer: FeeOffer | null; now: number; onCancel: () => void }) {
  const queuer = order.queuerName ?? offer?.queuerName ?? 'A queuer';
  if (order.status === 'resting' && order.maxFeeCents !== undefined) {
    const sched = offer ? scheduleOf(offer) : null;
    const fill = sched ? fillPriceForMax(sched.schedule, order.maxFeeCents) : null;
    const at = sched ? reachesAt(sched.schedule, order.maxFeeCents) : null;
    const eta = at !== null && sched && !sched.preview ? Math.max(0, at - now) : null;
    const ahead = bidsAhead(point, order.bidId);
    return (
      <div className="order is-resting">
        <div className="order__row">
          <span className="state-chip is-held">Held</span>
          <strong>{formatUsd(order.holdCents ?? 0, { exact: true })}</strong>
          <span className="order__muted">your max fee {formatUsd(order.maxFeeCents)}</span>
        </div>
        <p>
          {fill !== null && offer
            ? `${offer.queuerName}'s fee reaches yours at ${formatUsd(fill)}${eta !== null && eta > 0 ? ` in about ${minutesWord(eta)}` : sched?.preview ? ' after check-in' : ''}. `
            : 'You are booked automatically when an offer reaches your max fee. '}
          {ahead === null ? '' : ahead === 0 ? 'Yours is the best request in the book.' : `${ahead} ${ahead === 1 ? 'request is' : 'requests are'} ahead of you.`}
          {order.mode === 'ship' ? ' Shipped to you; shipping is charged at cost.' : ''}
        </p>
        <button type="button" className="text-button" onClick={onCancel}>
          Cancel and release the hold
        </button>
      </div>
    );
  }
  if (order.status === 'booked' || order.status === 'settling') {
    const eta = order.receiptAt ? Math.max(0, order.receiptAt - now) : null;
    return (
      <div className="order is-booked">
        <div className="order__row">
          <span className="state-chip is-held">Held</span>
          <strong>{formatUsd(order.holdCents ?? 0, { exact: true })}</strong>
          <span className="order__muted">{order.status === 'settling' ? 'receipt being checked' : 'not charged yet'}</span>
        </div>
        <p>
          {queuer} is queueing for you{order.fillFeeCents !== undefined ? ` for a ${formatUsd(order.fillFeeCents)} fee` : ''}. You are charged the shop price from the receipt, the fee and processing at cost
          {eta !== null ? `, in about ${minutesWord(eta)}` : ' once the receipt is checked'}.
        </p>
      </div>
    );
  }
  if (order.status === 'bought') {
    // The receipt passed but the hold is still open (D-115): a shipped errand's receipt is captured and the
    // rest waits for tracking; a local errand is charged only at the handover code.
    const charged = order.chargedCents ?? 0;
    const held = Math.max(0, (order.holdCents ?? 0) - charged - (order.releasedCents ?? 0));
    return (
      <div className="order is-booked">
        <div className="order__row">
          {charged > 0 && (
            <>
              <span className="state-chip is-captured">Captured</span>
              <strong>{formatUsd(charged, { exact: true })}</strong>
            </>
          )}
          <span className="state-chip is-held">Held</span>
          <strong>{formatUsd(held, { exact: true })}</strong>
        </div>
        <p>
          {order.mode === 'ship'
            ? `${queuer} bought your ${point.itemShort}. Receipt checked: you paid the shop price, the fee and processing at cost. ${formatUsd(held, { exact: true })} stays held until ${queuer} adds tracking; then shipping is charged at cost and the rest is released.`
            : `${queuer} bought your ${point.itemShort}. Receipt checked. You are charged when you give ${queuer} your handover code: the shop price, the fee and processing at cost; the rest of the hold is released.`}
        </p>
      </div>
    );
  }
  if (order.status === 'filled') {
    return (
      <div className="order is-filled">
        <div className="order__row">
          <span className="state-chip is-captured">Captured</span>
          <strong>{formatUsd(order.chargedCents ?? 0, { exact: true })}</strong>
          {(order.releasedCents ?? 0) > 0 && (
            <>
              <span className="state-chip is-released">Released</span>
              <strong>{formatUsd(order.releasedCents ?? 0, { exact: true })}</strong>
            </>
          )}
        </div>
        <p>
          {queuer} bought your {point.itemShort} and was paid out. Receipt checked. You paid the shop price{order.mode === 'ship' ? ', shipping' : ''} and processing at cost, plus the fee; Money lists every line.
        </p>
      </div>
    );
  }
  return null;
}

function MaxPicker({
  point,
  offerFee,
  offer,
  busy,
  sandbox,
  onCancel,
  onConfirm,
  onPay,
  onStopWaiting,
}: {
  point: TaskPoint;
  offerFee: Cents | null;
  offer: FeeOffer | null;
  busy: boolean;
  /** PayPal's own buttons (server in sandbox mode) instead of the placeholder. */
  sandbox: boolean;
  onCancel: () => void;
  onConfirm: (c: Cents) => void;
  /** Sandbox: called inside the click on PayPal's button. */
  onPay: (c: Cents, funding: CheckoutFunding) => void;
  onStopWaiting: () => void;
}) {
  const unit = 100; // whole dollars
  const lo = Math.ceil(point.minFeeCents / unit) * unit;
  const hi = Math.max(lo, offerFee !== null ? offerFee - unit : Math.max(2500, (point.bestFeeCents ?? 0) + 800));
  const suggested = offerFee !== null ? offerFee - 3 * unit : (point.bestFeeCents ?? lo) + unit;
  const [value, setValue] = useState(() => Math.min(hi, Math.max(lo, suggested)));
  const v = Math.min(hi, Math.max(lo, value));
  const sched = offer ? scheduleOf(offer) : null;
  const at = sched ? reachesAt(sched.schedule, v) : null;
  const shipping = useMarket.getState().shippingFor(point.id);
  const hold = holdFor(point, v, 1, shipping);
  const nudge = (d: number) => setValue((x) => Math.min(hi, Math.max(lo, x + d)));

  return (
    <div className="picker">
      <div className="picker__row">
        <button type="button" className="round-button" onClick={() => nudge(-unit)} aria-label="Lower my max fee" disabled={busy}>
          −
        </button>
        <div className="picker__value">
          <span className="picker__big">{formatUsd(v)}</span>
          <span className="auction__caption">my max fee</span>
        </div>
        <button type="button" className="round-button" onClick={() => nudge(unit)} aria-label="Raise my max fee" disabled={busy}>
          +
        </button>
      </div>
      <input
        className="picker__range"
        type="range"
        min={lo}
        max={hi}
        step={unit}
        value={v}
        disabled={busy}
        onChange={(e) => setValue(Number(e.target.value))}
        aria-label="My max fee"
      />
      <p className="picker__explain">
        The request rests until an offer reaches {formatUsd(v)}
        {at !== null && sched && !sched.preview ? `, in about ${minutesWord(Math.max(0, at - clock.now()))}` : ''}. The hold covers the {point.itemShort} at up to{' '}
        {formatUsd(retailCapFor(point.retailCents))}, up to {formatUsd(v)} for the queuer{shipping > 0 ? `, up to ${formatUsd(shipping)} for shipping` : ''} and up to{' '}
        {formatUsd(hold - (retailCapFor(point.retailCents) + v) - shipping, { exact: true })} for processing and payouts at cost.
      </p>
      <Disclosures lines={disclosuresFor(point, v, shipping)} />
      {sandbox ? (
        <PayPalSdkButtons lead={`Hold ${formatUsd(hold)} with`} waiting={busy} onPay={(funding) => onPay(v, funding)} onStopWaiting={onStopWaiting} />
      ) : (
        <PayPalButton state={busy ? 'waiting' : 'ready'} label={`Hold ${formatUsd(hold)} with PayPal`} onClick={() => onConfirm(v)} />
      )}
      <button type="button" className="text-button" onClick={onCancel} disabled={busy}>
        Not now
      </button>
    </div>
  );
}
