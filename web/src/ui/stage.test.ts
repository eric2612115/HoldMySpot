import { describe, expect, it } from 'vitest';
import { chipValue, introFine } from './stage';

describe("the desktop intro's fine print", () => {
  it('names the PayPal the server really runs (GET /api/config mode)', () => {
    expect(introFine('server', 'sandbox')).toBe('Prototype. Talks to the HoldMySpot server on the real PayPal sandbox: no real money.');
    expect(introFine('server', 'fake')).toMatch(/simulated PayPal/);
    expect(introFine('mock', null)).toMatch(/in-browser market/);
    expect(introFine('server', 'sandbox')).not.toMatch(/Simulated/i);
  });
});

describe('the money chip shows the money of the phone on screen (D-132)', () => {
  const day = { persona: true, held: 0, charged: 5826, paidOut: 5355, latest: 'paid_out' as const };
  it('says what Mia was charged on her phone, and what Wei was paid on his', () => {
    expect(chipValue({ ...day, phone: 'requester' })).toBe('Charged $58.26');
    expect(chipValue({ ...day, phone: 'queuer' })).toBe('Paid $53.55');
  });
  it("never shows Mia's hold on Wei's phone", () => {
    expect(chipValue({ ...day, held: 6318, phone: 'queuer' })).toBe('Paid $53.55');
    expect(chipValue({ ...day, held: 6318, paidOut: 0, phone: 'queuer' })).toBe('No payout yet');
    expect(chipValue({ ...day, held: 6318, phone: 'requester' })).toBe('$63.18 held');
  });
  it('keeps the in-browser market words', () => {
    expect(chipValue({ persona: false, phone: 'requester', held: 0, charged: 0, paidOut: 0, latest: 'captured' })).toBe('Captured');
    expect(chipValue({ persona: false, phone: 'requester', held: 0, charged: 0, paidOut: 0, latest: null })).toBe('Nothing held');
  });
  it('never says "Paid out" on a requester\'s phone or shows a hold on a queuer\'s, with or without a persona', () => {
    expect(chipValue({ persona: false, phone: 'requester', held: 0, charged: 5826, paidOut: 5355, latest: 'paid_out' })).toBe('Charged $58.26');
    expect(chipValue({ persona: false, phone: 'requester', held: 0, charged: 0, paidOut: 0, latest: 'paid_out' })).toBe('Captured');
    expect(chipValue({ persona: false, phone: 'queuer', held: 1501, charged: 0, paidOut: 0, latest: 'held' })).toBe('No payout yet');
    expect(chipValue({ persona: false, phone: 'queuer', held: 1501, charged: 0, paidOut: 1080, latest: 'paid_out' })).toBe('Paid $10.80');
  });
});
