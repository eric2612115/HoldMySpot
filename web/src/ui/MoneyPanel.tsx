import { DEFAULT_RULES, PROCESSING_LABEL, processingScheduleText } from '@holdmyspot/shared';
import type { LedgerKind } from '@holdmyspot/shared';
import { formatUsd } from '../domain/money';
import { useMarket } from '../state/market';
import { params } from '../state/services';
import { PersonaFace } from './queuer/faces';
import { usePhone } from './queuer/phone';
import { chipValue } from './stage';

/** The money states people see, in plain words. Same kinds as the server's ledger. */
export const STATE_WORDS: Record<LedgerKind, { label: string; plain: string }> = {
  held: { label: 'Held', plain: 'PayPal holds it on your account. Not charged yet.' },
  renewed: { label: 'Renewed', plain: 'A hold PayPal renewed after 3 days, same amount.' },
  captured: { label: 'Captured', plain: 'Charged: the receipt price and fee, or the shipping the queuer declared (up to your budget), plus processing at cost. It lands in HoldMySpot’s PayPal balance.' },
  released: { label: 'Released', plain: 'Back to you: the part of a hold you did not need.' },
  paid_out: { label: 'Paid out', plain: 'Sent from HoldMySpot’s PayPal balance to the queuer by PayPal Payouts.' },
  refunded: { label: 'Refunded', plain: 'Returned to you after a capture.' },
};

/** The four states the legend and the desktop notes explain. */
export const MAIN_STATES: LedgerKind[] = ['held', 'captured', 'released', 'paid_out'];

const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: params.city.timeZone });

/** The mode banner every screen carries (docs/DOMAIN.md section 9): no real money moves here. */
export function useModeBanner(): string {
  const serverMode = useMarket((s) => s.serverMode);
  return serverMode === 'sandbox' ? 'PayPal sandbox: no real money' : 'Simulated PayPal';
}

export function MoneyChip({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const held = useMarket((s) => s.heldCents);
  const charged = useMarket((s) => s.chargedCents);
  const paidOut = useMarket((s) => s.paidOutCents);
  const persona = useMarket((s) => s.persona);
  const latest = useMarket((s) => s.activity[0]);
  const phone = usePhone((s) => s.phone);
  const banner = useModeBanner();
  const value = chipValue({ persona: Boolean(persona), phone, held, charged, paidOut, latest: latest?.kind ?? null });
  return (
    <button
      type="button"
      className={`money-chip${open ? ' is-open' : ''}`}
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="money-panel"
      aria-label={`Money: ${value}. ${banner}.`}
    >
      <span className="money-chip__mode">{banner}</span>
      <span key={latest?.id ?? 'none'} className="money-chip__value">
        {value}
      </span>
    </button>
  );
}

export function MoneyPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const activity = useMarket((s) => s.activity);
  const held = useMarket((s) => s.heldCents);
  const paidOut = useMarket((s) => s.paidOutCents);
  const backend = useMarket((s) => s.backend);
  const serverMode = useMarket((s) => s.serverMode);
  const persona = useMarket((s) => s.persona);
  const source =
    backend === 'server'
      ? serverMode === 'sandbox'
        ? 'PayPal sandbox: no real money. Every line below is from the server’s ledger.'
        : 'Simulated PayPal: no real money. The server’s ledger, with the PayPal sandbox calls answered by a local stand-in.'
      : 'Simulated PayPal: no real money. This prototype simulates the payments in your browser, in US dollars.';
  return (
    <div id="money-panel" className={`money${open ? ' is-open' : ''}`} role="region" aria-label="Money" aria-hidden={!open}>
      <header className="money__head">
        <div>
          <h2>Money</h2>
          <p>{source}</p>
        </div>
        <button type="button" className="close-button" onClick={onClose} aria-label="Close money">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      <div className="money__totals">
        <div className="money__held">
          <span className="money__whom">
            {persona && <PersonaFace id={persona.requesterId} size={24} />}
            {persona ? `Held for ${persona.requesterName} right now` : 'Held right now'}
          </span>
          <strong>{formatUsd(held, { exact: true })}</strong>
        </div>
        {persona && (
          <div className="money__held is-paid">
            <span className="money__whom">
              <PersonaFace id={persona.queuerId} size={24} />
              {`Paid out to ${persona.queuerName}`}
            </span>
            <strong>{formatUsd(paidOut, { exact: true })}</strong>
          </div>
        )}
      </div>
      {persona && (
        <p className="money__who-note">
          {persona.requesterName} asks for things and pays; {persona.queuerName} queues and is paid. Both sides of every line are here.
        </p>
      )}
      <dl className="money__legend">
        {MAIN_STATES.map((k) => (
          <div key={k}>
            <dt>
              <span className={`state-chip is-${k}`}>{STATE_WORDS[k].label}</span>
            </dt>
            <dd>{STATE_WORDS[k].plain}</dd>
          </div>
        ))}
      </dl>
      <p className="money__who-note" data-processing-note>
        {PROCESSING_LABEL}: what taking the payment and paying the queuer costs ({processingScheduleText()}), passed through at cost. HoldMySpot keeps{' '}
        {DEFAULT_RULES.platformFeeBps / 100}% of the queue fee and nothing else.
      </p>
      {activity.length === 0 ? (
        <p className="money__empty">Nothing yet. When you ask for something, the hold shows up here.</p>
      ) : (
        <ol className="money__list">
          {activity.map((a) => (
            <li key={a.id} className={a.status !== 'succeeded' ? `is-${a.status}` : undefined}>
              <span className={`state-chip is-${a.kind}`}>{STATE_WORDS[a.kind].label}</span>
              <span className="money__text">
                {a.who && <span className="money__who">{a.who}</span>}
                {a.text}
                {a.status !== 'succeeded' && <em className="money__status">{a.status === 'pending' ? ' Waiting for PayPal.' : ' PayPal declined this step.'}</em>}
              </span>
              <span className="money__amount">{formatUsd(a.amountCents, { exact: true })}</span>
              <time className="money__time">{time.format(a.at)}</time>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
