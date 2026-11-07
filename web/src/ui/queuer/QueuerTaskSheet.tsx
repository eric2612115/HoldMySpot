import { DEFAULT_RULES, bidDisclosures, fillPriceForMax, findShop, formatUsd, platformFeeCents, reachesAt } from '@holdmyspot/shared';
import { useMemo, useState } from 'react';
import { REASON_TEXT, distanceText, rateText, travelText, type Reach } from '../../domain/earning';
import type { TaskPoint } from '../../domain/types';
import { usePosition } from '../../state/position';
import { BookStrip } from '../book/BookStrip';
import { useNow } from '../hooks';
import { ItemIcon } from '../ItemIcon';
import { PriceStairs } from '../PriceStairs';
import { durationText, etaChoices, isLiveClaim, offerProblem, previewSchedule, timeIn, type OfferForm } from './logic';
import { queuerActions, useQueuer } from './store';

/**
 * A task on the queuer's phone: what it pays, how far it is, how long the
 * line is, and two ways in. "Take this task" offers to queue at the top
 * request's fee (it fills that request at once); "Offer my own fee" posts an
 * offer with an ETA, a fee and an optional step-down that starts at check-in.
 */

/** The ask form's platform-fee sentence (docs/DOMAIN.md section 9), the same words as the bid form's. */
const FEE_LINE = bidDisclosures({ qty: 1, retailCapCents: 0, maxFeeCents: 0, shippingBudgetCents: 0, mode: 'local' })[1]!;
const keep = (fee: number) => fee - platformFeeCents(fee, DEFAULT_RULES.platformFeeBps);

export function QueuerTaskSheet({ point, reach, onClose, onTaken }: { point: TaskPoint; reach: Reach | null; onClose: () => void; onTaken: () => void }) {
  const [offering, setOffering] = useState(false);
  const busy = useQueuer((s) => s.busy);
  const claims = useQueuer((s) => s.claims);
  const asks = useQueuer((s) => s.asks);
  const here = Object.values(claims).find((c) => isLiveClaim(c) && asks[c.askId]?.itemId === point.id);
  const tz = point.shop.timezone;
  const q = point.queue;
  const most = Math.max(1, ...point.depth.map((l) => l.qty));

  const take = async () => {
    if (!reach) return;
    const claim = await queuerActions.take(point, reach);
    if (claim) onTaken();
  };

  return (
    <article className="task q-task" style={{ ['--hue' as string]: point.hue }}>
      <header className="task__head">
        <div className="task__icon">
          <ItemIcon look={point.look} size={52} />
        </div>
        <div className="task__title">
          <h2>{point.itemName}</h2>
          <p className="task__shop">{point.shop.name}</p>
          <p>
            {point.shop.street}
            {reach && <>, {distanceText(reach.walkM)} away</>}
          </p>
        </div>
        <button type="button" className="close-button" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <ul className="tags">
        {point.tags.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>

      <BookStrip point={point} from="task" />

      {reach && (
        <section className={`earn${reach.claimable ? '' : ' is-blocked'}`} aria-label="What this task pays">
          <div className="earn__stats">
            <div>
              <strong>{reach.feeCents !== null ? formatUsd(reach.feeCents) : '–'}</strong>
              <span>
                top fee · {point.bidCount} {point.bidCount === 1 ? 'request' : 'requests'}
              </span>
            </div>
            <div>
              <strong>{reach.travelMin} min</strong>
              <span>{reach.travelMode === 'walk' ? 'walk' : 'by transit'}</span>
            </div>
            <div>
              <strong>~{reach.queueMin} min</strong>
              <span>in line</span>
            </div>
            <div className="earn__rate">
              <strong>{reach.claimable ? rateText(reach.centsPerHour) : '–'}</strong>
              <span>{reach.claimable ? 'you keep, est.' : 'can’t take it'}</span>
            </div>
          </div>
          {here ? (
            <div className="earn__take">
              <button
                type="button"
                className="take-button"
                onClick={() => {
                  queuerActions.open(here.id);
                  onClose();
                }}
              >
                Open my errand here
              </button>
              <p>You are on this errand: check in by {timeIn(here.windowEndsAt, tz)}.</p>
            </div>
          ) : reach.claimable ? (
            <div className="earn__take">
              <button type="button" className="take-button q-take" onClick={() => void take()} disabled={busy !== null}>
                {busy === 'Taking the task' ? 'Taking the task…' : 'Take this task'}
                <small>
                  {formatUsd(reach.feeCents ?? 0)} fee · you keep {formatUsd(reach.keepCents ?? 0, { exact: true })}
                </small>
              </button>
              <button type="button" className="ghost-button q-own" onClick={() => setOffering((o) => !o)} aria-expanded={offering}>
                {offering ? 'Close my offer' : 'Offer my own fee'}
              </button>
              {offering && <OfferFormCard point={point} reach={reach} onPosted={onTaken} />}
              <div className="disclose">
                <p>{FEE_LINE}</p>
                <p>
                  Bound to this place: check in at the shop by {timeIn(reach.arriveAt + DEFAULT_RULES.arrivalGraceMinutes * 60_000, tz)} ({travelText(reach)}, a minute to find
                  the line and {DEFAULT_RULES.arrivalGraceMinutes} minutes&rsquo; grace) with a photo of the line, or the task goes back to the book. You are paid by PayPal
                  Payouts after the receipt is checked.
                </p>
              </div>
            </div>
          ) : (
            <p className="earn__why">{reach.reason ? REASON_TEXT[reach.reason] : ''}</p>
          )}
        </section>
      )}

      <section className="task__block">
        <div className="block-head">
          <h3>The line</h3>
        </div>
        <div className="line-info">
          <div className="line-info__stat">
            <span className="line-info__big">{q.minutes}</span>
            <span className="line-info__unit">min wait</span>
          </div>
          <div className="line-info__stat">
            <span className="line-info__big">{q.peopleAhead ?? '–'}</span>
            <span className="line-info__unit">people in line</span>
          </div>
          <div className="line-info__stat">
            <span className="line-info__big">{formatUsd(point.retailCents)}</span>
            <span className="line-info__unit">shop price, paid back</span>
          </div>
        </div>
      </section>

      <section className="task__block">
        <div className="block-head">
          <h3>Requests waiting</h3>
          <span className="block-head__meta">
            {point.bidCount} {point.bidCount === 1 ? 'request' : 'requests'}, {point.bidQty} {point.bidQty === 1 ? 'unit' : 'units'}
          </span>
        </div>
        <p className="task__explain">Each one is a PayPal hold for the shop price plus a queue fee. The best fee fills first.</p>
        <div className="depth" aria-label="Requests by fee">
          {point.depth.map((l) => (
            <div key={l.feeCents} className="depth__row">
              <span className="depth__price">{formatUsd(l.feeCents)}</span>
              <span className="depth__bar">
                <span style={{ width: `${(l.qty / most) * 100}%` }} />
              </span>
              <span className="depth__count">{l.qty}</span>
            </div>
          ))}
        </div>
      </section>
    </article>
  );
}

const DOLLAR = 100;

function Stepper({ label, value, onChange, min, max, step, format }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step: number; format: (v: number) => string }) {
  return (
    <div className="q-stepper">
      <span className="q-stepper__label">{label}</span>
      <div className="q-stepper__row">
        <button type="button" className="round-button" onClick={() => onChange(Math.max(min, value - step))} disabled={value <= min} aria-label={`Lower ${label}`}>
          −
        </button>
        <strong>{format(value)}</strong>
        <button type="button" className="round-button" onClick={() => onChange(Math.min(max, value + step))} disabled={value >= max} aria-label={`Raise ${label}`}>
          +
        </button>
      </div>
    </div>
  );
}

function OfferFormCard({ point, reach, onPosted }: { point: TaskPoint; reach: Reach; onPosted: () => void }) {
  const now = useNow(1000);
  const busy = useQueuer((s) => s.busy);
  const shop = findShop(point.shop.id);
  const from = usePosition((s) => s.lngLat);
  const minFee = Math.ceil(point.minFeeCents / DOLLAR) * DOLLAR;
  const [fee, setFee] = useState(() => Math.max(minFee, (point.bestFeeCents ?? minFee) + 3 * DOLLAR));
  const [stepDown, setStepDown] = useState(true);
  const [stepCents, setStepCents] = useState(DOLLAR);
  const [intervalMin, setIntervalMin] = useState(5);
  const [floor, setFloor] = useState(() => Math.max(minFee, (point.bestFeeCents ?? minFee) - 4 * DOLLAR));
  const [etaIndex, setEtaIndex] = useState(0);
  const [capacity, setCapacity] = useState(1);
  const floorCents = Math.min(floor, fee);
  const etas = useMemo(() => (shop ? etaChoices(now, from, shop.lngLat, reach.travelMin) : [reach.arriveAt]), [now, from, shop, reach.travelMin, reach.arriveAt]);
  const etaAt = etas[Math.min(etaIndex, etas.length - 1)] ?? reach.arriveAt;
  const form: OfferForm = { feeCents: fee, clock: stepDown ? { stepCents, intervalMs: intervalMin * 60_000, floorCents } : null, etaAt, capacity };
  const problem = offerProblem(form, point);
  const schedule = previewSchedule(form, etaAt);
  const best = point.bestFeeCents;
  const meets = schedule && best !== null ? reachesAt(schedule, best) : null;
  const meetFee = schedule && best !== null ? fillPriceForMax(schedule, best) : null;
  const tz = point.shop.timezone;

  const post = async () => {
    if (problem) return;
    const claim = await queuerActions.offer(point, form, reach.travelMin);
    if (claim) onPosted();
  };

  return (
    <div className="q-form">
      <Stepper label="Opening fee" value={fee} min={minFee} max={6000} step={DOLLAR} onChange={setFee} format={(v) => formatUsd(v)} />
      <label className="q-toggle">
        <input type="checkbox" checked={stepDown} onChange={(e) => setStepDown(e.target.checked)} />
        <span>Step my fee down after I check in</span>
      </label>
      {stepDown && (
        <>
          <div className="q-form__rows">
            <Stepper label="Step down by" value={stepCents} min={50} max={300} step={50} onChange={setStepCents} format={(v) => formatUsd(v, { exact: v % 100 !== 0 })} />
            <Stepper label="Every" value={intervalMin} min={1} max={20} step={1} onChange={setIntervalMin} format={(v) => `${v} min`} />
            <Stepper label="Never below" value={floorCents} min={minFee} max={fee} step={DOLLAR} onChange={setFloor} format={(v) => formatUsd(v)} />
          </div>
          {schedule && <PriceStairs schedule={schedule} now={now} hue={point.hue} preview />}
          <p className="q-form__note">
            Opens at {formatUsd(fee)} when you check in, then {formatUsd(stepCents, { exact: stepCents % 100 !== 0 })} less every {intervalMin} min, never below {formatUsd(floorCents)}.{' '}
            {best !== null && meets !== null && meetFee !== null
              ? meets <= etaAt
                ? `The best request (${formatUsd(best)}) takes it at once.`
                : `The best request (${formatUsd(best)}) fills at ${formatUsd(meetFee)}, about ${durationText(meets - etaAt)} after check-in.`
              : best !== null
                ? `The best request (${formatUsd(best)}) is below your floor, so it will not fill.`
                : ''}
          </p>
        </>
      )}
      <div className="q-form__eta">
        <span className="q-stepper__label">I arrive by</span>
        <div className="q-chips" role="radiogroup" aria-label="Arrival time">
          {etas.map((t, i) => (
            <button key={t} type="button" role="radio" aria-checked={i === etaIndex} className={`q-chip${i === Math.min(etaIndex, etas.length - 1) ? ' is-on' : ''}`} onClick={() => setEtaIndex(i)}>
              {timeIn(t, tz)}
            </button>
          ))}
        </div>
        <p className="q-form__note">
          {travelText(reach)} from here. Check in by {timeIn(etaAt + DEFAULT_RULES.arrivalGraceMinutes * 60_000, tz)} or the offer lapses.
        </p>
      </div>
      {point.perPersonLimit > 1 && <Stepper label="I can buy" value={capacity} min={1} max={point.perPersonLimit} step={1} onChange={setCapacity} format={(v) => `${v} for others`} />}
      <p className="q-form__keep">
        You keep {formatUsd(keep(fee), { exact: true })} of a {formatUsd(fee)} fee{stepDown ? `, at least ${formatUsd(keep(floorCents), { exact: true })} at the floor` : ''}.
      </p>
      {problem && <p className="q-error">{problem}</p>}
      <button type="button" className="take-button" onClick={() => void post()} disabled={busy !== null || problem !== null}>
        {busy === 'Posting your offer' ? 'Posting…' : `Post my offer at ${formatUsd(fee)}`}
      </button>
    </div>
  );
}
