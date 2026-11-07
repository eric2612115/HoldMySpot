import { Link } from 'react-router-dom';
import type { CityConfig } from '../config/cities';
import { useLook } from '../state/look';
import { toastsFor, useMarket } from '../state/market';
import { PlayerFace } from './ItemIcon';
import { usePhone } from './queuer/phone';

export function PlayerChip({ city }: { city: CityConfig }) {
  // The same colours as the player on the map (set on the characters page).
  const palette = useLook((s) => s.palette);
  return (
    <Link to={`/characters${window.location.search}`} className="player-chip" aria-label="Your character">
      <PlayerFace hair={palette.hair} skin={palette.skin} top={palette.top} />
      <span className="player-chip__text">
        <strong>{city.name}</strong>
        <span>{city.area}</span>
      </span>
    </Link>
  );
}

/** The toasts of the phone on screen only (the requester's or the queuer's, D-132). */
export function Toasts() {
  const toasts = useMarket((s) => s.toasts);
  const dismiss = useMarket((s) => s.dismissToast);
  const phone = usePhone((s) => s.phone);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toastsFor(toasts, phone).map((t) => (
        <button key={t.id} type="button" className={`toast is-${t.tone}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </button>
      ))}
    </div>
  );
}

export function Hint({ visible, overview }: { visible: boolean; overview: boolean }) {
  return (
    <div className={`hint${visible ? ' is-visible' : ''}`} aria-hidden={!visible}>
      {overview ? 'Tap a dot to fly down to the shop.' : 'Tap to walk. Tap a glowing spot for its requests.'}
    </div>
  );
}

/** Map data credits, always visible. */
export function Attribution() {
  return (
    <div className="attribution">
      <a href="https://openfreemap.org" target="_blank" rel="noreferrer">
        OpenFreeMap
      </a>{' '}
      <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">
        © OpenMapTiles
      </a>{' '}
      Data from{' '}
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
        OpenStreetMap
      </a>
    </div>
  );
}

const STEPS = ['Drawing the streets', 'Finding what people are queueing for', 'Placing the shops and the lines'];

/**
 * Covers the map until the style, the tiles in view and the 3D world are all
 * there, so the first screen is never a blank map. Shows what it is doing,
 * and a retry when the map cannot load.
 */
export function LoadingVeil({ state, step, onRetry }: { state: 'loading' | 'ready' | 'error'; step: number; onRetry?: () => void }) {
  return (
    <div className={`veil${state === 'ready' ? ' is-gone' : ''}`} aria-hidden={state === 'ready'} role="status">
      {state === 'error' ? (
        <>
          <p>The map could not load. Check the connection and try again.</p>
          {onRetry && (
            <button type="button" className="ghost-button veil__retry" onClick={onRetry}>
              Try again
            </button>
          )}
        </>
      ) : (
        <>
          <svg className="veil__pin" width="64" height="72" viewBox="0 0 64 72" aria-hidden="true">
            <ellipse cx="32" cy="66" rx="16" ry="4" fill="rgba(35,30,90,0.12)" />
            <path d="M32 4c-12 0-21 9-21 21 0 15 21 37 21 37s21-22 21-37C53 13 44 4 32 4z" fill="#5B4CF0" />
            <circle cx="32" cy="25" r="9" fill="#FFFFFF" />
            <circle cx="32" cy="25" r="4.5" fill="#FF7BAC" />
          </svg>
          <span className="veil__dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <ol className="veil__steps">
            {STEPS.map((s, i) => (
              <li key={s} className={i < step ? 'is-done' : i === step ? 'is-now' : undefined}>
                {s}
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
