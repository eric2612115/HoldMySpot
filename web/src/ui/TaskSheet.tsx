import { DEFAULT_RULES, bidDisclosures } from '@holdmyspot/shared';
import { sortBids } from '../domain/book';
import { REASON_TEXT, distanceText, rateText, travelText, type Reach } from '../domain/earning';
import { formatUsd } from '../domain/money';
import type { TaskPoint } from '../domain/types';
import { useMarket, type Persona } from '../state/market';
import { ago, useNow } from './hooks';
import { ItemIcon } from './ItemIcon';
import { OfferCard } from './OfferCard';

const QUEUER_COLORS = ['#FF8FAB', '#57C4E5', '#FFD166', '#F28482'];

/** The ask form's platform-fee sentence (docs/DOMAIN.md section 9), the same words as the bid form's. */
const FEE_LINE = bidDisclosures({ qty: 1, retailCapCents: 0, maxFeeCents: 0, shippingBudgetCents: 0, mode: 'local' })[1]!;
const clockTime = (t: number, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(t);

function listNames(names: string[]) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Why the viewer cannot ask for this item (server persona in another city, local errand only), or null. */
function requestBlock(point: TaskPoint, persona: Persona | null): string | null {
  if (!persona) return null;
  const here = point.cityId === 'sf' ? 'San Francisco' : 'New York';
  if (!point.modes.includes('ship') && persona.requesterCity !== here) {
    return `${point.itemShort} is a local errand, so only requesters in ${here} can ask for it. You are signed in as ${persona.requesterName} in ${persona.requesterCity}.`;
  }
  return null;
}

export function TaskSheet({
  point,
  reach,
  onClose,
  onWalk,
  onTake,
}: {
  point: TaskPoint;
  reach: Reach | null;
  onClose: () => void;
  onWalk: () => void;
  onTake: () => void;
}) {
  const now = useNow(1000);
  const persona = useMarket((s) => s.persona);
  const taken = useMarket((s) => s.taken[point.id]);
  const bids = sortBids(point.bids);
  const most = Math.max(1, ...point.depth.map((l) => l.qty));
  const q = point.queue;
  const ships = point.modes.includes('ship');

  return (
    <article className="task" style={{ ['--hue' as string]: point.hue }}>
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

      {reach && (
        <section className={`earn${reach.claimable ? '' : ' is-blocked'}`} aria-label="For queuers">
          <div className="earn__stats">
            <div>
              <strong>{reach.feeCents !== null ? formatUsd(reach.feeCents) : '–'}</strong>
              <span>
                top fee · {point.bidCount} {point.bidCount === 1 ? 'request' : 'requests'}
              </span>
            </div>
            <div>
              <strong>{distanceText(reach.walkM)}</strong>
              <span>{travelText(reach)}</span>
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
          {reach.claimable ? (
            <div className="earn__take">
              <button type="button" className="take-button" onClick={onTake} disabled={taken?.status === 'posting' || taken?.status === 'taken'}>
                {taken?.status === 'taken'
                  ? taken.windowEndsAt
                    ? `Taken: check in by ${clockTime(taken.windowEndsAt, point.shop.timezone)}`
                    : 'Taken: walk over and check in'
                  : taken?.status === 'posting'
                    ? 'Posting your offer…'
                    : `Take it for a ${formatUsd(reach.feeCents ?? 0)} fee`}
              </button>
              <div className="disclose">
                <p>
                  You keep {formatUsd(reach.keepCents ?? 0, { exact: true })} of the {formatUsd(reach.feeCents ?? 0)} fee. {FEE_LINE}
                </p>
                <p>
                  Bound to this place: check in at the shop by {clockTime(reach.arriveAt + DEFAULT_RULES.arrivalGraceMinutes * 60_000, point.shop.timezone)} (your {travelText(reach)}, a minute to find the line and{' '}
                  {DEFAULT_RULES.arrivalGraceMinutes} minutes&rsquo; grace). The fee is paid after the receipt is checked.
                </p>
              </div>
            </div>
          ) : (
            <p className="earn__why">{reach.reason ? REASON_TEXT[reach.reason] : ''}</p>
          )}
        </section>
      )}

      <OfferCard point={point} blockedReason={requestBlock(point, persona)} />

      <section className="task__block">
        <div className="block-head">
          <h3>The line</h3>
          <button type="button" className="text-button" onClick={onWalk}>
            Walk there
          </button>
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
            <span className="line-info__unit">shop price</span>
          </div>
        </div>
        <div className="queuers">
          <div className="queuers__faces" aria-hidden="true">
            {q.queuers.map((n, i) => (
              <span key={n} style={{ background: QUEUER_COLORS[i % QUEUER_COLORS.length] }}>
                {n[0]}
              </span>
            ))}
          </div>
          <p>
            {q.queuers.length === 0
              ? 'No queuer in line yet. Requests are waiting for one.'
              : q.queuers.length === 1
                ? `${q.queuers[0]} is in line now.`
                : `${listNames(q.queuers)} are queueing together.`}
          </p>
        </div>
      </section>

      <section className="task__block">
        <div className="block-head">
          <h3>Requests</h3>
          <span className="block-head__meta">
            {point.bidCount} {point.bidCount === 1 ? 'request' : 'requests'}, {point.bidQty} {point.bidQty === 1 ? 'unit' : 'units'}
          </span>
        </div>
        <p className="task__explain">
          Every request is a PayPal hold for the shop price plus a queue fee{ships ? ' (and shipping when it ships)' : ''}, so it is real money waiting here, not a like.
        </p>
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
        {bids.length > 0 && (
          <ol className="bids">
            {bids.slice(0, 4).map((b) => (
              <li key={b.id} className={b.mine ? 'is-mine' : undefined}>
                <span className="bids__who">{b.mine ? 'You' : b.bidder}</span>
                <span className="bids__when">
                  {ago(now - b.placedAt)}
                  {b.mode === 'ship' ? ' · ships' : ''}
                </span>
                <span className="state-chip is-held">Held</span>
                <span className="bids__amount">
                  {formatUsd(b.feeCents)}
                  <small>max fee</small>
                </span>
              </li>
            ))}
          </ol>
        )}
        {bids.length > 4 && <p className="task__more">and {bids.length - 4} more</p>}
      </section>
    </article>
  );
}
