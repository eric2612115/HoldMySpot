/**
 * Money is always US dollars, stored as integer cents.
 * Never use floating point dollars for arithmetic.
 */
export type Cents = number;

export interface Money {
  currency: 'USD';
  cents: Cents;
}

export const usd = (dollars: number): Cents => Math.round(dollars * 100);

export const money = (cents: Cents): Money => ({ currency: 'USD', cents });

const exact = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const whole = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/**
 * Formats cents as US dollars. By default whole-dollar amounts drop the
 * cents ("$245"), which reads better on the map; pass `exact` for money
 * screens where every cent is shown ("$245.00").
 */
export function formatUsd(cents: Cents, opts: { exact?: boolean } = {}): string {
  if (!opts.exact && cents % 100 === 0) return whole.format(cents / 100);
  return exact.format(cents / 100);
}

/** PayPal REST APIs take amounts as decimal strings, for example "245.00". */
export function toPayPalValue(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
