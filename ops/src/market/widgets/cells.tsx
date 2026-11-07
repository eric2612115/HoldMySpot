import type { AgWidgetField } from 'ag-studio';
import type { HmsFieldContext } from '../studioData.ts';

/**
 * Cell renderers for AG Studio's grid and pivot table widgets (their
 * `createCellRenderer` option, React components with ag-studio-react): money events and statuses as the same
 * coloured pills the queuer board uses, and PayPal ids in a fixed-width face.
 * Fields opt in through their `context` (studioData.ts).
 */

const TONE: Record<string, string> = {
  held: 'held',
  renewed: 'grape',
  captured: 'captured',
  released: 'released',
  'paid out': 'paid',
  refunded: 'hot',
  succeeded: 'captured',
  pending: 'held',
  failed: 'hot',
  partially_captured: 'captured',
  voided: 'released',
  expired: 'released',
  open: 'grape',
  partially_matched: 'grape',
  matched: 'captured',
  filled: 'captured',
  lapsed: 'hot',
  unclaimed: 'held',
  returned: 'hot',
  paypal: 'paid',
  venmo: 'sky',
  verified: 'captured',
  shipped: 'paid',
  'in line': 'grape',
  'on the way': 'held',
  'paid out ': 'paid',
};

interface CellParams {
  value?: unknown;
  valueFormatted?: string | null;
}

function toneOf(raw: string): string {
  const text = raw.replace(/_/g, ' ');
  return TONE[raw.toLowerCase()] ?? TONE[text.toLowerCase()] ?? 'quiet';
}

/** A pill, as the React component AG Studio's React grid renders (text stays text, never HTML). */
export function Pill({ value, valueFormatted }: CellParams) {
  const raw = valueFormatted ?? (value === null || value === undefined ? '' : String(value));
  if (!raw) return null;
  const text = raw.replace(/_/g, ' ');
  return <span className={`hms-cell-pill tone-${toneOf(raw)}`}>{text.charAt(0).toUpperCase() + text.slice(1)}</span>;
}

export function PayPalId({ value }: CellParams) {
  return value ? <span className="hms-cell-paypal">{String(value)}</span> : <span className="hms-cell-none">none</span>;
}

export function createCellRenderer(field: AgWidgetField): typeof Pill | typeof PayPalId | undefined {
  const ctx = field.context as HmsFieldContext | undefined;
  if (ctx?.cell === 'pill') return Pill;
  if (ctx?.cell === 'paypal') return PayPalId;
  return undefined;
}
