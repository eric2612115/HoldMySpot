import { formatUsd, type Cents } from '../domain/money';
import type { OrderAgent } from '../state/market';
import { agentRows } from './agentLogRows';

const STATUS: Record<OrderAgent['status'], string> = { active: 'Working', paused: 'Paused', done: 'Finished' };

/** The bidding agent at work on a held request: the fee it set, what it did and who decided each step (D-158). */
export function AgentLog({ agent, feeNowCents, timeZone }: { agent: OrderAgent; feeNowCents: Cents; timeZone: string }) {
  const rows = agentRows(agent.actions);
  const clock = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
  return (
    <section className="agent-log" aria-label="Fee agent" data-agent-status={agent.status}>
      <header className="agent-log__head">
        <strong>Fee agent at work</strong>
        <span className="agent-log__status">{STATUS[agent.status]}</span>
      </header>
      <div className="agent-log__now">
        <span className="agent-log__fee" data-agent-fee={feeNowCents}>
          {formatUsd(feeNowCents, { exact: true })}
        </span>
        <span className="auction__caption">fee it set now, never above {formatUsd(agent.ceilingCents, { exact: true })}</span>
      </div>
      {rows.length === 0 ? (
        <p className="agent-log__empty">Its first decision is on the way.</p>
      ) : (
        <ol className="agent-log__rows" aria-live="polite">
          {rows.map((r) => (
            <li key={r.id} className={r.refused ? 'is-refused' : undefined}>
              <div className="agent-log__row">
                <b>{r.title}</b>
                <time>{clock.format(r.at)}</time>
              </div>
              <p>{r.reason}</p>
              <p className="agent-log__who">{r.who}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
