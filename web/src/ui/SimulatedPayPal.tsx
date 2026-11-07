import { formatUsd } from '../domain/money';
import { useMarket } from '../state/market';

/**
 * Fake mode's stand-in for PayPal's approval window: the server created a real
 * PayPal-shaped order (intent AUTHORIZE) on its local stand-in, and this sheet
 * approves or cancels it. Plain words, no PayPal artwork. In the sandbox the
 * buyer approves in PayPal's own window instead.
 */
export function SimulatedPayPal() {
  const checkout = useMarket((s) => s.checkout);
  const approve = useMarket((s) => s.approveCheckout);
  return (
    <div className={`spp${checkout ? ' is-open' : ''}`} role="dialog" aria-modal="true" aria-label="Simulated PayPal" aria-hidden={!checkout}>
      <div className="spp__card">
        <p className="spp__brand">Simulated PayPal · no real money</p>
        <h2>Hold {checkout ? formatUsd(checkout.amountCents, { exact: true }) : ''}?</h2>
        <p className="spp__what">{checkout?.description}.</p>
        <ul className="spp__facts">
          {(checkout?.disclosures ?? []).map((d) => (
            <li key={d}>{d}</li>
          ))}
          <li>Held now, not charged: you are charged only after a queuer’s receipt is checked.</li>
          <li>Fake mode: no PayPal page. In the sandbox, PayPal’s own window opens here.</li>
        </ul>
        <button type="button" className="pp-button is-ready" onClick={() => approve(true)} disabled={!checkout}>
          <span>Approve the hold</span>
        </button>
        <button type="button" className="text-button" onClick={() => approve(false)} disabled={!checkout}>
          Cancel
        </button>
      </div>
    </div>
  );
}
