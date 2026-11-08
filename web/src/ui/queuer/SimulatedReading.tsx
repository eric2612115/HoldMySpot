import { useMarket } from '../../state/market';

/**
 * The zero-key demo has no AI model for the queuer's own photos (D-128). The 21 demo photos in
 * server/fixtures/proofs replay a real model's recorded answers; any other photo gets the simulated
 * reading picked here (`?fixture=` on the upload), and the shared rules decide exactly as with a
 * model. The result card then says "Simulated reading, no AI". Hidden with a live model or PayPal's sandbox.
 */

export interface ReadingOption {
  id: string;
  label: string;
}

/** Hosted site only: no simulated reading, so the server sends the photo to the real model. */
export const MODEL_READING = 'model';

export const LINE_READINGS: readonly ReadingOption[] = [
  { id: 'line_ok', label: 'Line and code' },
  { id: 'no_code', label: 'No code' },
  { id: 'no_line', label: 'No line' },
];

export const RECEIPT_READINGS: readonly ReadingOption[] = [
  { id: 'genuine', label: 'Genuine' },
  { id: 'fake_receipt', label: 'Fake receipt' },
  { id: 'totals_off', label: 'Totals off' },
  { id: 'no_code', label: 'No job code' },
];

/** True when the phone offers a simulated reading (zero-key server: simulated PayPal and no live model). */
export function useSimulatedReadings(): boolean {
  return useMarket((s) => s.backend === 'server' && s.simulatedReadings);
}

export function SimulatedReading({
  name,
  options,
  value,
  onChange,
  disabled,
  modelReads = 0,
}: {
  name: string;
  options: readonly ReadingOption[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** Hosted site with a key: real model reads left for this market (0 hides the choice; D-163). */
  modelReads?: number;
}) {
  const shown = modelReads > 0 ? [...options, { id: MODEL_READING, label: 'Real AI read' }] : options;
  return (
    <fieldset className="q-sim" disabled={disabled}>
      <legend>{modelReads > 0 ? 'Read my photo as' : 'No AI model in this demo. Read my photo as'}</legend>
      <div className="q-sim__options">
        {shown.map((o) => (
          <label key={o.id} className={`q-sim__option${value === o.id ? ' is-on' : ''}`}>
            <input type="radio" name={`sim-${name}`} value={o.id} checked={value === o.id} onChange={() => onChange(o.id)} data-reading={`${name}-${o.id}`} />
            {o.label}
          </label>
        ))}
      </div>
      <p className="q-sim__note">A simulated reading, then the same rules as with a model. The demo photos in server/fixtures/proofs replay a real model's answers instead.</p>
    </fieldset>
  );
}
