import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMarket } from '../state/market';
import { MAIN_STATES, STATE_WORDS, useModeBanner } from './MoneyPanel';
import { introFine } from './stage';

/**
 * On a phone the app fills the screen. On a desktop it sits in a phone
 * frame with a short note on each side, so judges see the real mobile layout.
 */
export function PhoneFrame({ children }: { children: ReactNode }) {
  const search = new URLSearchParams(window.location.search);
  const with_ = (key: string, value: string) => {
    const q = new URLSearchParams(search);
    q.set(key, value);
    return `/?${q.toString()}`;
  };
  const isNyc = search.get('city') === 'nyc';
  // The server owns the market clock, so the speed link only applies to the in-browser market.
  const backend = useMarket((s) => s.backend);
  const serverMode = useMarket((s) => s.serverMode);
  const banner = useModeBanner();

  return (
    <div className="stage">
      <aside className="stage__side stage__intro">
        <h1 className="wordmark">HoldMySpot</h1>
        <p className="stage__lede">A walking order book on the queue fee, for the lines everyone talks about.</p>
        <p className="stage__body">
          Requests light up the map before anyone queues: a limited cake, a one-per-customer plush drop, a famous ramen line. Each request is a PayPal hold. A queuer
          nearby offers to stand in line, their fee steps down after they check in, they buy at the shop price, and the checked receipt moves the money.
        </p>
        <nav className="stage__links" aria-label="Demo options">
          <a href={with_('view', 'overview')}>Open on the overview of every task</a>
          {backend === 'mock' && <a href={with_('speed', '60')}>Run the clock 60 times faster</a>}
          <a href={isNyc ? with_('city', 'sf') : with_('city', 'nyc')}>{isNyc ? 'Switch to San Francisco' : 'Switch to New York'}</a>
          <Link to={`/characters${window.location.search}`}>Meet the characters</Link>
        </nav>
        <p className="stage__fine">{introFine(backend, serverMode)}</p>
      </aside>

      <div className="phone">
        <div className="phone__screen">{children}</div>
      </div>

      <aside className="stage__side stage__money">
        <h2>How the money moves</h2>
        <ol className="flow">
          {MAIN_STATES.map((k) => (
            <li key={k}>
              <span className={`state-chip is-${k}`}>{STATE_WORDS[k].label}</span>
              <span>{STATE_WORDS[k].plain}</span>
            </li>
          ))}
        </ol>
        <p className="stage__fine">Every amount is in US dollars through PayPal. {banner === 'Simulated PayPal' ? 'Simulated PayPal: no real money moves in this build.' : `${banner}.`}</p>
      </aside>
    </div>
  );
}
