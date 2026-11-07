import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { formatUsd, type Cents } from '../../domain/money';
import type { TaskPoint } from '../../domain/types';
import { useMarket } from '../../state/market';
import { mmss, useNow } from '../hooks';
import { ItemIcon } from '../ItemIcon';
import { useQueuerPhone } from '../queuer/phone';
import { DemoClock } from './DemoClock';
import { useBookFeed } from './feed';
import { askRows, bidLevels, ladderPrices, meetingOf, nextStepAt, rowOf, spreadOf, TRIGGER_TEXT, type AskRow, type BidLevel, type TapeRow } from './model';
import { useBook } from './store';
import './book.css';

/** Height of one price row of the ladder, in CSS pixels. */
const ROW = 34;
/** Offers drawn on the ladder, each in its own lane; the rest are counted below it. */
const LANES = 2;
/** How long a match stays on the ladder before both sides leave. */
const FLASH_MS = 3000;

const usd = (c: Cents) => formatUsd(c, { exact: true });
const clockTime = (t: number, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(t);
const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;

interface Flash {
  id: string;
  feeCents: Cents;
  /** The request level it met (as drawn just before), or null. */
  bid: BidLevel | null;
  /** The offer that met it (as drawn just before), or null when it was never on this screen. */
  ask: AskRow | null;
  /** The offer's lane on the ladder. */
  lane: number;
  queuerName: string | null;
  mine: boolean;
  /** The ladder rows as drawn just before: they stay while the two sides meet and leave. */
  prices: Cents[];
}

/** Mounted once on the map page: the open item's order book over everything but PayPal's sheet. */
export function OrderBookLayer() {
  const itemId = useBook((s) => s.itemId);
  const close = useBook((s) => s.close);
  const point = useMarket((s) => (itemId ? (s.points.find((p) => p.id === itemId) ?? null) : null));
  const loaded = useMarket((s) => s.points.length > 0);

  useEffect(() => {
    if (!itemId) return;
    // Capture phase: Escape closes the book only, not the sheet it was opened from.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [itemId, close]);

  // A `?book=` link to an item this city does not have closes quietly once the market is in.
  useEffect(() => {
    if (itemId && loaded && !point) close();
  }, [itemId, loaded, point, close]);

  if (!itemId || !point) return null;
  return <OrderBook key={point.id} point={point} onClose={close} />;
}

function OrderBook({ point, onClose }: { point: TaskPoint; onClose: () => void }) {
  const now = useNow(200);
  const order = useMarket((s) => s.orders[point.id]);
  const persona = useMarket((s) => s.persona);
  const queuerPhone = useQueuerPhone();
  const tz = point.shop.timezone;

  const myMax = !queuerPhone && order?.status === 'resting' ? (order.maxFeeCents ?? null) : null;
  const levels = bidLevels(point, myMax);
  const allAsks = askRows(point, now);
  const asks = allAsks.slice(0, LANES);
  const spread = spreadOf(levels, allAsks);
  const best = allAsks[0];
  const meeting = meetingOf(best, spread.bidCents);
  const myAsk = (a: AskRow) => queuerPhone && persona !== null && a.queuerName === persona.queuerName;

  // A match: hold both sides on the ladder as they were drawn, joined, then let them go.
  const drawn = useRef<{ levels: BidLevel[]; asks: AskRow[]; prices: Cents[] }>({ levels, asks: allAsks, prices: [] });
  const [flash, setFlash] = useState<Flash | null>(null);
  const flashTimer = useRef(0);
  const onLive = useCallback(
    (row: TapeRow) => {
      const before = drawn.current;
      const lane = before.asks.slice(0, LANES).findIndex((a) => a.askId === row.askId);
      const ask = before.asks.find((a) => a.askId === row.askId) ?? null;
      // Price priority: the best request at or above the fee fills first.
      const bid = before.levels.find((l) => l.feeCents >= row.feeCents) ?? null;
      const mine = !!order?.bidId && order.bidId === row.bidId;
      setFlash({ id: row.id, feeCents: row.feeCents, bid, ask, lane: Math.max(0, lane), queuerName: row.queuerName ?? ask?.queuerName ?? null, mine, prices: before.prices });
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS);
    },
    [order?.bidId],
  );
  const tape = useBookFeed(point, onLive);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  const keep = flash ? [...flash.prices, flash.feeCents, ...(flash.bid ? [flash.bid.feeCents] : []), ...(flash.ask ? [flash.ask.feeNowCents] : [])] : [];
  const prices = ladderPrices(levels, asks, keep);
  useEffect(() => {
    drawn.current = { levels, asks: allAsks, prices };
  });
  const y = (cents: Cents) => rowOf(prices, cents) * ROW;
  const mostQty = Math.max(1, ...levels.map((l) => l.qty), flash?.bid?.qty ?? 1);
  const bidRow = spread.bidCents !== null ? rowOf(prices, spread.bidCents) : null;
  const askRow = best && asks.includes(best) ? rowOf(prices, best.feeNowCents) : null;
  const shownCount = levels.reduce((s, l) => s + l.count, 0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.focus(), []);

  const ladderStyle = { height: Math.max(1, prices.length) * ROW, ['--lanes' as string]: Math.max(1, asks.length), ['--hue' as string]: point.hue } as CSSProperties;

  return (
    <div ref={box} className="obook" role="dialog" aria-modal="true" aria-label={`Order book: ${point.itemName}`} tabIndex={-1}>
      <header className="obook__head">
        <button type="button" className="obook__back" onClick={onClose} aria-label="Back to the map">
          <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
            <path d="M8 2L2 8l6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="obook__icon">
          <ItemIcon look={point.look} size={34} />
        </div>
        <div className="obook__title">
          <span className="obook__kicker">Order book</span>
          <h2>{point.itemName}</h2>
          <p>{point.shop.name}</p>
        </div>
        <button type="button" className="close-button" onClick={onClose} aria-label="Close the order book">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <div className="obook__body">
        <p className="obook__lede">Requests wait at their max fee, each one a PayPal hold. Offers step down after check-in until they meet one.</p>

        <section className="obook-sum" aria-label="Best request, spread and best offer">
          <div className="obook-sum__cell is-bid">
            <span className="obook-sum__label">Best request</span>
            <strong>{spread.bidCents !== null ? usd(spread.bidCents) : 'None yet'}</strong>
            <span className="obook-sum__sub">
              {levels[0] ? `${levels[0].count} waiting${levels[0].heldCents !== null ? ` · ${usd(levels[0].heldCents)} held` : ''}` : 'Nobody is asking'}
            </span>
          </div>
          <div className={`obook-sum__cell is-mid${spread.crossed ? ' is-crossed' : ''}`}>
            <span className="obook-sum__label">Spread</span>
            <strong key={spread.spreadCents ?? 'none'}>{spread.spreadCents === null ? '–' : spread.crossed ? 'Met' : usd(spread.spreadCents)}</strong>
            <span className="obook-sum__sub">{spread.spreadCents === null ? 'one side empty' : spread.crossed ? 'matching' : 'gap to close'}</span>
          </div>
          <div className="obook-sum__cell is-ask">
            <span className="obook-sum__label">Best offer</span>
            <strong>{best ? usd(best.feeNowCents) : 'None yet'}</strong>
            <span className="obook-sum__sub">
              {best ? `${myAsk(best) ? 'You' : best.queuerName}${best.running ? ', stepping down' : best.clock ? ', on the way' : ', fixed'}` : 'No queuer offered'}
            </span>
          </div>
        </section>

        <div className="obook-cols" aria-hidden="true">
          <span>Requests · held</span>
          <span>Fee</span>
          <span>Offers · step-down</span>
        </div>

        {prices.length === 0 ? (
          <p className="obook__empty">Nobody has asked or offered yet. The first request lights up this book.</p>
        ) : (
          <div className={`obook-ladder${asks.length > 1 ? ' is-lanes' : ''}`} style={ladderStyle} role="list" aria-label="The book by fee">
            {bidRow !== null && askRow !== null && askRow < bidRow && (
              <>
                <div className="obook-spread" style={{ top: askRow * ROW + ROW / 2, height: (bidRow - askRow) * ROW }} aria-hidden="true" />
                {/* On the best offer's row, where no request rests (requests sit at or below the best one). */}
                <span className="obook-spread__tag" style={{ transform: `translateY(${askRow * ROW}px)` }} aria-hidden="true">
                  <svg width="8" height="12" viewBox="0 0 8 12" aria-hidden="true">
                    <path d="M4 1v10M1.5 3.5L4 1l2.5 2.5M1.5 8.5L4 11l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  spread {usd(spread.spreadCents ?? 0)}
                </span>
              </>
            )}

            {prices.map((p, i) => {
              const isBid = p === spread.bidCents;
              const isAsk = best !== undefined && p === best.feeNowCents;
              return (
                <div key={p} className={`obook-row${isBid ? ' is-bid' : ''}${isAsk ? ' is-ask' : ''}`} style={{ transform: `translateY(${i * ROW}px)` }} aria-hidden="true">
                  <span className="obook-row__price">{usd(p)}</span>
                </div>
              );
            })}

            {levels.map((l) => (
              <div
                key={l.feeCents}
                className={`obook-bid${l.best ? ' is-best' : ''}${l.mine ? ' is-mine' : ''}`}
                style={{ transform: `translateY(${y(l.feeCents)}px)`, ['--w' as string]: `${Math.max(34, (l.qty / mostQty) * 100)}%` }}
                role="listitem"
                aria-label={`${l.count} ${l.count === 1 ? 'request' : 'requests'} at ${usd(l.feeCents)}${l.heldCents !== null ? `, ${usd(l.heldCents)} held` : ''}`}
              >
                <span className="obook-bid__bar">
                  <b>{l.heldCents !== null ? `${usd(l.heldCents)} held` : `${l.qty} ${l.qty === 1 ? 'unit' : 'units'}`}</b>
                  <small>
                    {l.mine ? 'yours · ' : ''}
                    {l.count} {l.count === 1 ? 'request' : 'requests'}
                  </small>
                </span>
              </div>
            ))}

            {asks.map((a, lane) => (
              <AskLane key={a.askId} ask={a} lane={lane} prices={prices} now={now} you={myAsk(a)} />
            ))}

            {flash && <FlashBand flash={flash} prices={prices} mostQty={mostQty} />}
          </div>
        )}

        {(allAsks.length > LANES || point.bidCount > shownCount) && (
          <p className="obook__more">
            {point.bidCount > shownCount ? `${point.bidCount - shownCount} more ${point.bidCount - shownCount === 1 ? 'request rests' : 'requests rest'} at lower fees. ` : ''}
            {allAsks.length > LANES ? `${allAsks.length - LANES} more ${allAsks.length - LANES === 1 ? 'offer' : 'offers'} above.` : ''}
          </p>
        )}

        <ScheduleNote best={best} meeting={meeting} bidCents={spread.bidCents} now={now} tz={tz} you={best ? myAsk(best) : false} />

        <section className="obook-tape" aria-label="Recent matches">
          <h3>Recent matches</h3>
          {tape.length === 0 ? (
            <p className="obook-tape__none">No match on this book yet.</p>
          ) : (
            <ol>
              {tape.slice(0, 4).map((r) => (
                <li key={r.id} className={flash?.id === r.id ? 'is-new' : undefined}>
                  <span className="obook-tape__time">{clockTime(r.at, tz)}</span>
                  <span className="obook-tape__fee">{usd(r.feeCents)}</span>
                  <span className="obook-tape__what">
                    <b>{r.queuerName ?? 'A queuer'}</b>
                    {r.qty > 1 ? ` ×${r.qty}` : ''} · {r.trigger ? TRIGGER_TEXT[r.trigger] : 'an offer met a request'}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <DemoClock timeZone={tz} nextBookStepAt={nextStepAt(allAsks)} />
    </div>
  );
}

/** One offer on the ladder: its path from the opening fee down to the floor, and its chip at the fee now. */
function AskLane({ ask, lane, prices, now, you }: { ask: AskRow; lane: number; prices: readonly Cents[]; now: number; you: boolean }) {
  const row = rowOf(prices, ask.feeNowCents);
  const steps = (ask.steps ?? []).filter((s) => prices.includes(s.priceCents));
  const top = rowOf(prices, ask.openCents);
  const bottom = ask.clock ? rowOf(prices, ask.clock.floorCents) : top;
  const laneStyle = { ['--lane' as string]: lane } as CSSProperties;
  const name = you ? 'You' : ask.queuerName;
  const ring = ask.progress ?? (ask.atFloor ? 1 : 0);
  const C = 2 * Math.PI * 7;

  return (
    <>
      {ask.clock && bottom > top && (
        <div className="obook-path" style={{ ...laneStyle, top: top * ROW + ROW / 2, height: (bottom - top) * ROW }} aria-hidden="true">
          <span className="obook-path__done" style={{ height: Math.max(0, row - top) * ROW }} />
        </div>
      )}
      {steps.map((s) => {
        const r = rowOf(prices, s.priceCents);
        const state = s.priceCents > ask.feeNowCents ? 'is-past' : s.priceCents < ask.feeNowCents ? 'is-next' : 'is-now';
        const floor = ask.clock !== null && s.priceCents === ask.clock.floorCents;
        return (
          <span key={s.index} className={`obook-step ${state}${floor ? ' is-floor' : ''}`} style={{ ...laneStyle, top: r * ROW + ROW / 2 }} aria-hidden="true">
            {floor && <em>floor</em>}
          </span>
        );
      })}
      <div
        className={`obook-ask${ask.best ? ' is-best' : ''}${ask.running ? ' is-running' : ''}${you ? ' is-you' : ''}`}
        style={{ ...laneStyle, transform: `translateY(${row * ROW}px)` }}
        role="listitem"
        aria-label={`${name}: ${usd(ask.feeNowCents)}${ask.nextAt !== null && ask.nextFeeCents !== null ? `, ${usd(ask.nextFeeCents)} in ${mmss(ask.nextAt - now)}` : ''}`}
      >
        <span className="obook-ask__chip">
          <svg className="obook-ask__ring" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <circle cx="9" cy="9" r="7" className="obook-ask__ring-bg" />
            <circle cx="9" cy="9" r="7" className="obook-ask__ring-fg" strokeDasharray={`${(C * ring).toFixed(2)} ${C.toFixed(2)}`} transform="rotate(-90 9 9)" />
          </svg>
          <span className="obook-ask__text">
            <span className="obook-ask__line">
              <b>{name}</b>
              <strong key={ask.feeNowCents}>{usd(ask.feeNowCents)}</strong>
            </span>
            <small>
              {ask.running && ask.nextAt !== null && ask.nextFeeCents !== null
                ? `${usd(ask.nextFeeCents)} in ${mmss(ask.nextAt - now)}`
                : ask.atFloor
                  ? 'at its floor'
                  : ask.clock
                    ? 'steps after check-in'
                    : 'fixed fee'}
            </small>
          </span>
        </span>
      </div>
    </>
  );
}

/** A match: the request and the offer, joined at the fee it filled at, then both leave the book. */
function FlashBand({ flash, prices, mostQty }: { flash: Flash; prices: readonly Cents[]; mostQty: number }) {
  const at = rowOf(prices, flash.feeCents);
  const bidAt = flash.bid ? rowOf(prices, flash.bid.feeCents) : at;
  // The offer lands on the fee it filled at, sliding from where it was last drawn (the clock may step and fill at once).
  const askFrom = flash.ask ? (rowOf(prices, flash.ask.feeNowCents) - at) * ROW : 0;
  const top = Math.min(at, bidAt);
  const bottom = Math.max(at, bidAt);
  const timing = { ['--delay' as string]: askFrom !== 0 ? '0.5s' : '0s' } as CSSProperties;
  return (
    <div className="obook-flash" role="status" aria-live="polite" style={timing}>
      <div className="obook-flash__band" style={{ top: top * ROW + 2, height: (bottom - top + 1) * ROW - 4 }} />
      {flash.bid && (
        <div
          className="obook-bid is-ghost"
          style={{ transform: `translateY(${bidAt * ROW}px)`, ['--w' as string]: `${Math.max(34, (flash.bid.qty / mostQty) * 100)}%` }}
          aria-hidden="true"
        >
          <span className="obook-bid__bar">
            <b>{flash.bid.heldCents !== null ? `${usd(flash.bid.heldCents)} held` : 'request'}</b>
            <small>{flash.mine ? 'yours' : 'request'}</small>
          </span>
        </div>
      )}
      {flash.ask && (
        <div
          className="obook-ask is-ghost"
          style={{ ['--lane' as string]: flash.lane, ['--from' as string]: `${askFrom}px`, transform: `translateY(${at * ROW}px)` } as CSSProperties}
          aria-hidden="true"
        >
          <span className="obook-ask__chip">
            <span className="obook-ask__text">
              <span className="obook-ask__line">
                <b>{flash.queuerName ?? flash.ask.queuerName}</b>
                <strong>{usd(flash.feeCents)}</strong>
              </span>
              <small>offer taken</small>
            </span>
          </span>
        </div>
      )}
      <span className="obook-flash__pill" style={{ top: top * ROW + 2 }}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M2.5 7.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Matched {usd(flash.feeCents)}
      </span>
      <span className="visually-hidden">
        {flash.mine ? 'Your request matched' : 'A request matched'} {flash.queuerName ? `${flash.queuerName}'s offer` : 'an offer'} at {usd(flash.feeCents)}.
      </span>
    </div>
  );
}

/** The best offer's step-down in words: its schedule, the next drop, and when it meets the best request. */
function ScheduleNote({
  best,
  meeting,
  bidCents,
  now,
  tz,
  you,
}: {
  best: AskRow | undefined;
  meeting: ReturnType<typeof meetingOf>;
  bidCents: Cents | null;
  now: number;
  tz: string;
  you: boolean;
}) {
  if (!best) {
    return <p className="obook-note">No offer yet. Requests rest here, each held by PayPal, until a queuer&rsquo;s fee reaches them.</p>;
  }
  const who = you ? 'Your' : `${best.queuerName}'s`;
  if (!best.clock) {
    return (
      <p className="obook-note">
        {who} fee is a fixed {usd(best.feeNowCents)}
        {bidCents !== null && bidCents < best.feeNowCents ? `, ${usd(best.feeNowCents - bidCents)} above the best request.` : '.'}
      </p>
    );
  }
  const c = best.clock;
  const rule = `drops ${usd(c.stepCents)} every ${minutes(c.intervalMs)} to a floor of ${usd(c.floorCents)}`;
  const meet =
    meeting && bidCents !== null
      ? meeting.at !== null
        ? ` It meets the best request (${usd(bidCents)}) at ${clockTime(meeting.at, tz)}, ${meeting.feeCents === bidCents ? 'at that fee' : `at ${usd(meeting.feeCents)}`}.`
        : ` It would meet the best request (${usd(bidCents)}) ${minutes(meeting.afterStartMs)} after check-in.`
      : bidCents !== null && bidCents < c.floorCents
        ? ` Its floor stays above the best request (${usd(bidCents)}).`
        : '';
  if (!best.running) {
    return (
      <p className="obook-note">
        {who} fee opens at {usd(best.openCents)} and {rule}, starting when {you ? 'you check' : `${best.queuerName} checks`} in (due {clockTime(best.etaAt, tz)}).{meet}
      </p>
    );
  }
  return (
    <p className="obook-note">
      {who} fee opened at {usd(best.openCents)} and {rule}.{' '}
      {best.nextAt !== null && best.nextFeeCents !== null ? (
        <b>
          Next: {usd(best.nextFeeCents)} in {mmss(best.nextAt - now)}.
        </b>
      ) : (
        <b>It is at its floor.</b>
      )}
      {meet}
    </p>
  );
}
