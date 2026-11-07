/** The intro's fine print from the server's own mode (GET /api/config), never a fixed "Simulated PayPal". */
export function introFine(backend: 'connecting' | 'mock' | 'server', mode: 'fake' | 'sandbox' | null): string {
  if (backend === 'mock') return 'Prototype. No HoldMySpot server answered, so this is the in-browser market with a simulated PayPal.';
  if (backend === 'server' && mode === 'sandbox') return 'Prototype. Talks to the HoldMySpot server on the real PayPal sandbox: no real money.';
  if (backend === 'server') return 'Prototype. Talks to the HoldMySpot server with a simulated PayPal: no network, no keys, no real money.';
  return 'Prototype. Connecting to the HoldMySpot server; without one it runs an in-browser market.';
}

/**
 * The money chip shows the money of the phone on screen (D-132): the requester's hold, else what she
 * was charged; the queuer's payouts. The in-browser market has one phone and keeps its own words.
 */
export function chipValue(v: {
  persona: boolean;
  phone: 'requester' | 'queuer';
  held: number;
  charged: number;
  paidOut: number;
  latest: 'held' | 'renewed' | 'captured' | 'released' | 'paid_out' | 'refunded' | null;
}): string {
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  if (v.persona && v.phone === 'queuer') return v.paidOut > 0 ? `Paid ${usd(v.paidOut)}` : 'No payout yet';
  if (v.held > 0) return `${usd(v.held)} held`;
  if (v.persona) return v.charged > 0 ? `Charged ${usd(v.charged)}` : v.latest === 'released' ? 'Released' : 'Nothing held';
  const words: Record<string, string> = { held: 'Held', renewed: 'Renewed', captured: 'Captured', released: 'Released', paid_out: 'Paid out', refunded: 'Refunded' };
  return v.latest ? (words[v.latest] ?? 'Nothing held') : 'Nothing held';
}
