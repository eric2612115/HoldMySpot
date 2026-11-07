import type { AgentAction, MarketMs } from '@holdmyspot/shared';
import type { Proposal } from '../data/backend.ts';
import { clockText, relativeText } from '../data/time.ts';

interface Props {
  proposals: Proposal[];
  notes: AgentAction[];
  now: MarketMs;
  serverMode: boolean;
  onApprove(id: string): void;
  onShow(queuerId: string, shopId: string): void;
}

function stampText(p: Proposal): string {
  return p.ai.provider === 'fake' ? 'Checked by rules (fake mode)' : `Checked by AI and rules, ${p.ai.provider} ${p.ai.model}`;
}

export function ReschedulerPanel({ proposals, notes, now, serverMode, onApprove, onShow }: Props) {
  const open = proposals.filter((p) => p.status === 'open');
  const closed = proposals.filter((p) => p.status !== 'open');
  return (
    <section className="rescheduler" aria-label="Rescheduler">
      <header className="rescheduler-head">
        <span className="agent-dot" aria-hidden="true">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 5.5h8l-2-2M13.5 10.5h-8l2 2" />
          </svg>
        </span>
        <h2>Rescheduler</h2>
        <span className="stamp">{open.length > 0 ? `${open.length} waiting for you` : 'All work on plan'}</span>
      </header>
      <div className="rescheduler-body">
        {serverMode && (
          <p className="empty">The server applies re-offers on its own. Proposals with approval need a reassign route in the contract; until then they run on the mock.</p>
        )}
        {open.map((p) => (
          <article key={p.id} className={`proposal is-open${p.severity === 'critical' ? ' is-critical' : ''}`}>
            <div className="proposal-top">
              <h3>{p.title}</h3>
              <span className="proposal-when">{relativeText(p.raisedAt, now)}</span>
            </div>
            <p>{p.summary}</p>
            <ul>
              {p.facts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <div className="proposal-actions">
              {p.moves.length > 0 && (
                <button type="button" className="btn primary" onClick={() => onApprove(p.id)}>
                  Approve move
                </button>
              )}
              <button type="button" className="btn" onClick={() => onShow(p.queuerId, p.shopId)}>
                Show on map
              </button>
            </div>
            <p className="rules-act">
              {p.rulesActAt ? `If nobody approves, the rules act at ${clockText(p.rulesActAt)}.` : 'The rules will not move this on their own.'} {stampText(p)}.
            </p>
          </article>
        ))}
        {closed.map((p) => (
          <article key={p.id} className={`proposal${p.severity === 'critical' ? ' is-critical' : ''}`}>
            <div className="proposal-top">
              <h3>{p.title}</h3>
              <span className="proposal-when">{p.approvedAt ? `approved ${clockText(p.approvedAt)}` : 'by the rules'}</span>
            </div>
            <div className="proposal-done">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2.5 7.5l3 3 6-7" />
              </svg>
              {p.status === 'approved' ? 'Moved after your approval' : p.kind === 'payment_failed' ? 'Nobody approved: the capture failed' : 'The rules moved it when the window closed'}
            </div>
          </article>
        ))}
        {open.length === 0 && closed.length === 0 && !serverMode && <p className="empty">Nothing to move. Every queuer is on plan.</p>}
        {notes.length > 0 && (
          <>
            <h3 className="feed-title">Moves today</h3>
            <ol className="feed">
              {notes.map((n) => (
                <li key={n.id}>
                  <time>{clockText(n.at)}</time>
                  <span>{n.reason}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </section>
  );
}
