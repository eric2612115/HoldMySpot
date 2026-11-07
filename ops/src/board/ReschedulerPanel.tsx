import { useState } from 'react';
import type { AgentAction, MarketMs } from '@holdmyspot/shared';
import type { Brain } from '../agents/brain.ts';
import { modelLabel } from '../agents/brain.ts';
import type { Proposal, ProposalOption } from '../agents/rescheduler.ts';
import { clockText, relativeText } from '../data/time.ts';

interface Props {
  proposals: Proposal[];
  notes: AgentAction[];
  now: MarketMs;
  brain: Brain;
  agentError: string | null;
  onApprove(proposal: Proposal, optionId: string): void;
  onShow(queuerId: string, shopId: string): void;
  /** Hovering an option draws its dry run on the board; null goes back to the chosen one. */
  onPreview(proposalId: string, optionId: string | null): void;
}

const KIND_ICON: Record<ProposalOption['kind'], string> = {
  reassign: 'M2.5 5.5h8l-2-2M13.5 10.5h-8l2 2',
  extend: 'M8 3.5v4.5l3 2M2.8 8a5.2 5.2 0 1 0 10.4 0 5.2 5.2 0 0 0-10.4 0',
  release: 'M3 8h7M7.5 5l3 3-3 3M13 3v10',
  release_job: 'M3 8h10M8 3v10',
};

function Icon({ kind }: { kind: ProposalOption['kind'] }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={KIND_ICON[kind]} />
    </svg>
  );
}

function deciderText(p: Proposal): string {
  if (p.decidedBy === 'model') return `Chosen by ${modelLabel(p.ai.provider, p.ai.model)} on the server's AI port; every option was built and checked by the market rules.`;
  return 'Chosen by the rules (no model): every option is checked by the market rules.';
}

function OpenCard({ p, now, onApprove, onShow, onPreview }: { p: Proposal; now: MarketMs } & Pick<Props, 'onApprove' | 'onShow' | 'onPreview'>) {
  const [picked, setPicked] = useState<string | null>(null);
  const selected = p.options.find((o) => o.id === (picked ?? p.chosenId)) ?? p.options[0];
  return (
    <article className={`proposal is-open${p.severity === 'critical' ? ' is-critical' : ''}`} data-decided-by={p.decidedBy} data-thinking={p.thinking ? 'true' : undefined}>
      <div className="proposal-top">
        <h3>{p.title}</h3>
        <span className="proposal-when">{relativeText(p.raisedAt, now)}</span>
      </div>
      <p className="proposal-problem">{p.problem}</p>
      <div className={`proposal-pick is-${p.decidedBy}`}>
        <span className="pick-tag">{p.thinking ? 'Asking the model' : p.decidedBy === 'model' ? 'Agent pick' : 'Rules pick'}</span>
        <p>{p.thinking ? 'The model is weighing the options; the rules’ pick shows until it answers.' : p.summary}</p>
      </div>
      <div className="proposal-options" role="radiogroup" aria-label="Options">
        {p.options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={o.id === selected?.id}
            className={`option is-${o.kind}${o.id === p.chosenId ? ' is-chosen' : ''}`}
            title={o.detail}
            onClick={() => {
              setPicked(o.id);
              onPreview(p.id, o.id);
            }}
            onMouseEnter={() => onPreview(p.id, o.id)}
            onMouseLeave={() => onPreview(p.id, picked)}
          >
            <Icon kind={o.kind} />
            {o.label}
          </button>
        ))}
      </div>
      {selected && selected.id !== p.chosenId && <p className="option-detail">{selected.detail}</p>}
      <ul>
        {p.facts.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <div className="proposal-actions">
        {selected && (
          <button type="button" className="btn primary" onClick={() => onApprove(p, selected.id)}>
            Approve: {selected.label}
          </button>
        )}
        <button type="button" className="btn" onClick={() => onShow(p.queuerId, p.shopId)}>
          Show on map
        </button>
      </div>
      <p className="rules-act">
        {p.rulesActAt ? `If nobody approves, the rules act at ${clockText(p.rulesActAt)}.` : 'The rules will not move this on their own.'} {deciderText(p)}
      </p>
    </article>
  );
}

export function ReschedulerPanel({ proposals, notes, now, brain, agentError, onApprove, onShow, onPreview }: Props) {
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
      <div className={`agent-strip is-${brain.kind}`} title={brain.reason || undefined}>
        <span className="agent-strip-dot" aria-hidden="true" />
        {brain.kind === 'model' ? (
          <span>
            <b>Agent:</b> {brain.label} picks a move; the rules build and check every option.
          </span>
        ) : (
          <span>
            <b>Rules only:</b> no AI model on this console. {brain.reason}
          </span>
        )}
      </div>
      <div className="rescheduler-body">
        {agentError && <p className="agent-error">The model did not answer ({agentError}); the rules' picks stand.</p>}
        {open.map((p) => (
          <OpenCard key={`${p.id}-open`} p={p} now={now} onApprove={onApprove} onShow={onShow} onPreview={onPreview} />
        ))}
        {closed.map((p) => (
          <article key={`${p.id}-${p.status}`} className={`proposal${p.severity === 'critical' ? ' is-critical' : ''}`}>
            <div className="proposal-top">
              <h3>{p.title}</h3>
              <span className="proposal-when">{p.approvedAt ? `approved ${clockText(p.approvedAt)}` : 'by the rules'}</span>
            </div>
            <div className="proposal-done">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2.5 7.5l3 3 6-7" />
              </svg>
              {p.status === 'approved' ? `Approved: ${p.outcome ?? 'moved'}` : (p.outcome ?? 'Settled by the rules')}
            </div>
          </article>
        ))}
        {open.length === 0 && closed.length === 0 && <p className="empty">Nothing to move. Every queuer is on plan.</p>}
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
