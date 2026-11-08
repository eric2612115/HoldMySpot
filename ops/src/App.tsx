import { lazy, Suspense, useEffect, useState } from 'react';
import type { Brain } from './agents/brain.ts';
import { useBrain } from './agents/useBrain.ts';
import { BoardView } from './board/BoardView.tsx';
import { useMarket } from './data/useMarket.ts';
import type { Market } from './data/useMarket.ts';
import { clockText, dayText } from './data/time.ts';

// AG Studio is large; it loads only when the market view opens.
const MarketView = lazy(() => import('./market/MarketView.tsx'));
const PeopleView = lazy(() => import('./people/PeopleView.tsx'));

type ViewId = 'board' | 'market' | 'people';

function viewFromHash(): ViewId {
  if (location.hash.startsWith('#/people')) return 'people';
  return location.hash.startsWith('#/market') ? 'market' : 'board';
}

export function App() {
  const market = useMarket();
  const brain = useBrain(market && !('error' in market) ? market.backend.kind : undefined);
  const [view, setView] = useState<ViewId>(viewFromHash);

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (market === null) return <div className="boot">Opening the console</div>;
  if ('error' in market) return <div className="boot">The console could not load its data: {market.error}</div>;
  if (brain === null) return <div className="boot">Opening the console</div>;

  return (
    <div className="shell">
      <TopBar market={market} view={view} brain={brain} />
      <main className="view">
        {view === 'board' && <BoardView market={market} brain={brain} />}
        {view === 'market' && (
          <Suspense fallback={<div className="boot">Loading the market dashboard</div>}>
            <MarketView market={market} brain={brain} />
          </Suspense>
        )}
        {view === 'people' && (
          <Suspense fallback={<div className="boot">Loading the cases</div>}>
            <PeopleView market={market} />
          </Suspense>
        )}
      </main>
    </div>
  );
}

function TopBar({ market, view, brain }: { market: Market; view: ViewId; brain: Brain }) {
  const { snapshot, at, backend } = market;
  const mode = snapshot.config.mode;
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
            <path d="M3 15V3h3.2v4.6h5.6V3H15v12h-3.2v-4.6H6.2V15z" />
          </svg>
        </span>
        HoldMySpot
        <small>Ops</small>
      </div>
      <nav className="views" aria-label="Views">
        <a href="#/board" aria-current={view === 'board' ? 'page' : undefined}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M2 4h7M2 8h11M2 12h5" />
          </svg>
          Queuer board
        </a>
        <a href="#/market" aria-current={view === 'market' ? 'page' : undefined}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M2.5 13.5v-4M6.2 13.5V5M9.8 13.5V8M13.5 13.5V2.5" />
          </svg>
          Market
        </a>
        <a href="#/people" aria-current={view === 'people' ? 'page' : undefined}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="8" cy="5" r="2.6" />
            <path d="M3 14c.5-3 2.4-4.6 5-4.6s4.5 1.6 5 4.6" />
          </svg>
          Needs a person
        </a>
      </nav>
      <div className="spacer" />
      <div className="clock">
        <div className="clock-time">
          <strong>{clockText(at)}</strong>
          <span>
            {dayText(at)}, San Francisco{backend.kind === 'server' ? ', live server' : ''}
          </span>
        </div>
        {backend.moments.length > 0 && (
          <div className="moments" role="group" aria-label="Jump to a moment">
            {backend.moments.map((m) => (
              <button key={m.id} type="button" aria-pressed={Math.abs(m.at - at) < 30_000} onClick={() => market.setAt(m.at)}>
                {m.label}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="play"
          onClick={market.togglePlay}
          aria-label={
            backend.kind === 'server'
              ? market.playing
                ? "Pause the server's demo clock"
                : "Resume the server's demo clock"
              : market.playing
                ? 'Pause the market clock'
                : 'Run the market clock 60 times faster'
          }
        >
          {market.playing ? (
            <svg viewBox="0 0 14 14" fill="currentColor">
              <rect x="2.5" y="2" width="3.2" height="10" rx="1" />
              <rect x="8.3" y="2" width="3.2" height="10" rx="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 14 14" fill="currentColor">
              <path d="M3.5 2.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L4.4 1.7a.6.6 0 0 0-.9.5z" />
            </svg>
          )}
        </button>
      </div>
      <div className="status-pills">
        <div className="mode-banner" data-mode={mode} title={snapshot.config.modeReason}>
          {mode === 'sandbox' ? 'PayPal sandbox: no real money' : 'Simulated PayPal'}
        </div>
        <div className="agents-pill" data-kind={brain.kind} title={brain.reason || `Each agent turn is answered by ${brain.label}.`}>
          <span aria-hidden="true" />
          {brain.kind === 'model' ? `Agents: ${brain.label.replace(/ on the server$/, '')}` : 'Agents: rules only (no model key)'}
        </div>
      </div>
    </header>
  );
}
