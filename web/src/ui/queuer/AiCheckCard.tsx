import type { CheckView } from './logic';

/**
 * What the AI read and what the rules decided, in rows a person can check:
 * pass or fail, the provider stamp, each fact with a tick or a cross, and
 * the reasons for every flag (docs/DOMAIN.md section 9).
 */
export function AiCheckCard({ view, kind }: { view: CheckView | null; kind: 'line' | 'purchase' }) {
  if (!view || view.status === 'verifying') {
    return (
      <section className="q-ai is-verifying" aria-live="polite">
        <header className="q-ai__head">
          <span className="spinner" aria-hidden="true" />
          <div>
            <h4>{kind === 'line' ? 'Checking the line photo' : 'Checking the receipt and the item photo'}</h4>
            <p>AI reads the photo; fixed rules decide. Nothing is charged while it runs.</p>
          </div>
        </header>
      </section>
    );
  }
  const tone = view.status === 'passed' ? 'is-passed' : view.status === 'failed' ? 'is-failed' : 'is-review';
  return (
    <section className={`q-ai ${tone}`} aria-live="polite" data-check={view.status}>
      <header className="q-ai__head is-result">
        <span className="q-ai__badge">{view.status === 'passed' ? 'Pass' : view.status === 'failed' ? 'Fail' : 'Review'}</span>
        <h4>{kind === 'line' ? `Line photo: ${view.title.toLowerCase()}` : `Receipt check: ${view.title.toLowerCase()}`}</h4>
      </header>
      <p className="q-ai__summary">{view.summary}</p>
      <ul className="q-ai__rows">
        {view.rows.map((r) => (
          <li key={r.label} className={r.ok === false ? 'is-bad' : r.ok ? 'is-ok' : undefined}>
            <span className="q-ai__mark" aria-label={r.ok === false ? 'flagged' : r.ok ? 'matched' : 'not checked'}>
              {r.ok === false ? '✕' : r.ok ? '✓' : '·'}
            </span>
            <span className="q-ai__label">{r.label}</span>
            <span className="q-ai__value">{r.value}</span>
          </li>
        ))}
      </ul>
      {view.flags.length > 0 && (
        <div className="q-ai__flags">
          <h5>{view.flags.length === 1 ? 'Flag' : `${view.flags.length} flags`}</h5>
          <ul>
            {view.flags.map((f) => (
              <li key={f.label + f.detail}>
                <b>{f.label}</b> {f.detail}
                {!f.hard && <em> (sent to a person)</em>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="q-ai__stamp">{view.stamp}</p>
    </section>
  );
}
