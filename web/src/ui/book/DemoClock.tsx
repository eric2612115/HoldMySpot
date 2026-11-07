import type { ClockState, DemoClockRequest, DemoState } from '@holdmyspot/shared';
import { useEffect, useState } from 'react';
import { api } from '../../services/api';
import { useMarket } from '../../state/market';
import { clock } from '../../state/services';
import { useNow } from '../hooks';

const timeOf = (t: number, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(t);
const shortTime = (t: number, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(t);

/**
 * Demo mode only (the server's demo routes): the market clock, Run and Pause,
 * and "Next step", which jumps the clock to this book's next fee-clock drop
 * while an offer's clock runs, else to the demo day's next scripted moment,
 * so a step-down can be shown without waiting. Uses POST /api/demo/clock; the
 * server runs everything that falls due on the way, in time order.
 */
export function DemoClock({ timeZone, nextBookStepAt }: { timeZone: string; nextBookStepAt: number | null }) {
  const backend = useMarket((s) => s.backend);
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<DemoState | null>(null);
  const [clockState, setClockState] = useState<ClockState | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow(250);

  // Demo routes exist only when the server runs with HMS_DEMO=1; ask once, then follow them while the book is open.
  useEffect(() => {
    if (backend !== 'server') return;
    let gone = false;
    let timer = 0;
    const poll = async () => {
      try {
        const [s, c] = await Promise.all([api('GET /api/demo/state', {}, null), api('GET /api/clock', {}, null)]);
        if (gone) return;
        setState(s);
        setClockState(c);
      } catch {
        /* Next poll. */
      }
    };
    api('GET /api/config', {}, null)
      .then((config) => {
        if (gone || !config.demo.enabled) return;
        setEnabled(true);
        void poll();
        timer = window.setInterval(() => void poll(), 700);
      })
      .catch(() => undefined);
    return () => {
      gone = true;
      window.clearInterval(timer);
    };
  }, [backend]);

  if (!enabled || !state) return null;

  const send = async (body: DemoClockRequest) => {
    setBusy(true);
    try {
      const c = await api('POST /api/demo/clock', {}, body);
      clock.follow(c);
      setClockState(c);
      setState(await api('GET /api/demo/state', {}, null));
    } catch {
      /* The clock stays where it was. */
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setBusy(true);
    try {
      // Starts the demo day from its first moment, with the clock held still: Next step walks it.
      await api('POST /api/demo/start', {}, { scriptId: state.scriptId ?? 'hero', speed: null });
      const c = await api('POST /api/demo/clock', {}, { paused: true });
      clock.follow(c);
      setClockState(c);
      setState(await api('GET /api/demo/state', {}, null));
    } catch {
      /* Try again. */
    } finally {
      setBusy(false);
    }
  };

  // While a clock runs here, each press is one step of this book's auction; scripted moments on the way still run.
  const scripted = state.status === 'running' && state.nextStepAt !== null && state.nextStepAt > now ? state.nextStepAt : null;
  const target = nextBookStepAt !== null && nextBookStepAt > now ? nextBookStepAt : scripted;
  const paused = clockState?.paused ?? true;
  const speed = clockState?.speed ?? 60;

  return (
    <div className="obook-demo" role="group" aria-label="Demo clock">
      <div className="obook-demo__time">
        <span className="obook-demo__label">Demo clock</span>
        <span className="obook-demo__now">
          {timeOf(now, timeZone)}
          <small>{state.status === 'idle' ? 'not started' : paused ? 'paused' : `${speed}× speed`}</small>
        </span>
      </div>
      {state.status === 'idle' ? (
        <button type="button" className="obook-demo__btn is-primary" disabled={busy} onClick={() => void start()}>
          Start the demo day
        </button>
      ) : (
        <>
          <button
            type="button"
            className="obook-demo__btn"
            disabled={busy}
            onClick={() => void send(paused ? { paused: false, ...(speed < 60 ? { speed: 60 } : {}) } : { paused: true })}
            aria-label={paused ? 'Run the market clock' : 'Pause the market clock'}
          >
            {paused ? (
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2.5 1.5v9l8-4.5z" fill="currentColor" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2.5 1.5h2.6v9H2.5zM6.9 1.5h2.6v9H6.9z" fill="currentColor" />
              </svg>
            )}
            {paused ? `Run ${Math.max(60, speed)}×` : 'Pause'}
          </button>
          <button type="button" className="obook-demo__btn is-primary" disabled={busy || target === null} onClick={() => target !== null && void send({ jumpTo: target })}>
            <svg width="13" height="12" viewBox="0 0 13 12" aria-hidden="true">
              <path d="M1.5 1.5v9l6-4.5zM7.5 1.5v9" fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            </svg>
            <span>
              Next step
              <small>{target !== null ? `to ${shortTime(target, timeZone)}` : state.status === 'finished' ? 'none left' : 'one moment'}</small>
            </span>
          </button>
        </>
      )}
    </div>
  );
}
