/**
 * Placeholder for the PayPal button. It shows the states the real one will
 * go through (ready, waiting for approval, done) without any PayPal artwork.
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
