import { useEffect, useLayoutEffect, useRef } from 'react';
import type { CheckoutFunding } from '@holdmyspot/shared';
import { useMarket, type PayPalButtons } from '../state/market';
import '../styles/paypal.css';

/**
 * Placeholder for the PayPal button in the in-browser market and in fake mode
 * (next to the "Simulated PayPal" sheet). It shows the states a request goes
 * through (ready, waiting for approval, done) without any PayPal artwork.
 */
export type PayPalButtonState = 'ready' | 'waiting' | 'done';

export function PayPalButton({
  state,
  label,
  waitingLabel = 'Waiting for PayPal approval',
  onClick,
  disabled,
}: {
  state: PayPalButtonState;
  label: string;
  waitingLabel?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`pp-button is-${state}`}
      onClick={onClick}
      disabled={disabled || state !== 'ready'}
      aria-busy={state === 'waiting'}
      aria-live="polite"
    >
      {state === 'waiting' && <span className="spinner" aria-hidden="true" />}
      {state === 'done' && (
        <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      <span>{state === 'waiting' ? waitingLabel : label}</span>
    </button>
  );
}

/** PayPal's web components from the JS SDK v6, one per button. */
const SDK_TAG: Record<CheckoutFunding, string> = {
  paypal: 'paypal-button',
  venmo: 'venmo-button',
  paylater: 'paypal-pay-later-button',
};

type SdkButtonSpec = PayPalButtons['buttons'][number];

/**
 * One of PayPal's own buttons, exactly as PayPal's SDK draws it (we never draw
 * PayPal or Venmo artwork). The click handler runs inside the native click, so
 * PayPal's window may open from it.
 */
function SdkButton({ spec, disabled, onClick }: { spec: SdkButtonSpec; disabled: boolean; onClick: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const element = useRef<HTMLElement | null>(null);
  const latest = useRef({ onClick, disabled });
  useLayoutEffect(() => {
    latest.current = { onClick, disabled };
  });

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const el = document.createElement(SDK_TAG[spec.funding]);
    if (spec.productCode) Object.assign(el, { productCode: spec.productCode });
    if (spec.countryCode) Object.assign(el, { countryCode: spec.countryCode });
    el.toggleAttribute('disabled', latest.current.disabled);
    const onElementClick = () => {
      if (!latest.current.disabled) latest.current.onClick();
    };
    el.addEventListener('click', onElementClick);
    parent.appendChild(el);
    element.current = el;
    return () => {
      el.removeEventListener('click', onElementClick);
      el.remove();
      element.current = null;
    };
  }, [spec.funding, spec.productCode, spec.countryCode]);

  useEffect(() => {
    element.current?.toggleAttribute('disabled', disabled);
  }, [disabled]);

  return <div ref={host} className={`ppx__button is-${spec.funding}`} />;
}

/**
 * Sandbox mode's approval step: PayPal's own buttons (PayPal, and Venmo only
 * when PayPal says it is eligible), our one-line summary above them, and a
 * plain waiting state with a way out while PayPal's window is open.
 */
export function PayPalSdkButtons({
  lead,
  waiting,
  disabled = false,
  onPay,
  onStopWaiting,
}: {
  /** Our sentence above PayPal's buttons, for example "Hold $60.00 with". */
  lead: string;
  /** A request of this card waits for PayPal's approval. */
  waiting: boolean;
  disabled?: boolean;
  /** Called inside the click on PayPal's button. */
  onPay: (funding: CheckoutFunding) => void;
  onStopWaiting: () => void;
}) {
  const state = useMarket((s) => s.paypalButtons);
  const retry = useMarket((s) => s.loadPayPal);

  if (waiting) {
    return (
      <div className="ppx is-waiting" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <div className="ppx__wait">
          <strong>Waiting for PayPal approval</strong>
          <span>Finish in PayPal’s window. Nothing is held until you approve there.</span>
        </div>
        <button type="button" className="text-button" onClick={onStopWaiting}>
          Stop
        </button>
      </div>
    );
  }
  if (state.status === 'failed') {
    return (
      <div className="ppx is-failed" role="alert">
        <p>PayPal’s buttons did not load. {state.message}</p>
        <button type="button" className="text-button" onClick={retry}>
          Try again
        </button>
      </div>
    );
  }
  if (state.status !== 'ready') {
    return (
      <div className="ppx is-loading" role="status">
        <span className="spinner" aria-hidden="true" />
        <span>Loading PayPal…</span>
      </div>
    );
  }
  const names = state.buttons.map((b) => (b.funding === 'paypal' ? 'PayPal' : b.funding === 'venmo' ? 'Venmo' : 'Pay Later'));
  return (
    <div className="ppx" role="group" aria-label={`${lead} ${names.join(' or ')}`}>
      <p className="ppx__lead">{lead}</p>
      {state.buttons.map((b) => (
        <SdkButton key={b.funding} spec={b} disabled={disabled} onClick={() => onPay(b.funding)} />
      ))}
      <p className="ppx__note">PayPal sandbox: no real money. PayPal opens its own window to approve the hold.</p>
    </div>
  );
}
