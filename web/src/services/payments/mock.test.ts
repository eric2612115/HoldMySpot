import { describe, expect, it } from 'vitest';
import { usd } from '../../domain/money';
import { MockPaymentsService } from './mock';
import { PaymentError } from './types';

const make = () => new MockPaymentsService({ latencyMs: 0, now: () => 1_000 });

describe('mock payments', () => {
  it('holds, captures the fill price and releases the rest', async () => {
    const p = make();
    const hold = await p.placeHold({ amountCents: usd(222), reference: 'sale-1', description: 'Mochi Bunny plush (your max)' });
    expect(hold.status).toBe('held');

    const done = await p.capture(hold.id, usd(220), { description: 'Mochi Bunny plush at $220', final: true });
    expect(done.status).toBe('captured');
    expect(done.capturedCents).toBe(usd(220));
    expect(done.releasedCents).toBe(usd(2));

    const kinds = p.activity().map((a) => a.kind);
    expect(kinds).toEqual(['released', 'captured', 'held']);
  });

  it('never captures more than was held', async () => {
    const p = make();
    const hold = await p.placeHold({ amountCents: usd(50), reference: 'r', description: 'x' });
    await expect(p.capture(hold.id, usd(51), { description: 'x', final: true })).rejects.toBeInstanceOf(PaymentError);
  });

  it('cannot capture a released hold', async () => {
    const p = make();
    const hold = await p.placeHold({ amountCents: usd(50), reference: 'r', description: 'x' });
    const released = await p.release(hold.id, { description: 'sold out' });
    expect(released.status).toBe('released');
    expect(released.releasedCents).toBe(usd(50));
    await expect(p.capture(hold.id, usd(10), { description: 'x', final: true })).rejects.toMatchObject({ code: 'HOLD_CLOSED' });
  });

  it('allows partial captures before a final one', async () => {
    const p = make();
    const hold = await p.placeHold({ amountCents: usd(60), reference: 'r', description: 'cake and fee' });
    const first = await p.capture(hold.id, usd(36.5), { description: 'cake at shop price', final: false });
    expect(first.status).toBe('partially_captured');
    const second = await p.capture(hold.id, usd(14), { description: 'queue fee', final: true });
    expect(second.status).toBe('captured');
    expect(second.releasedCents).toBe(usd(9.5));
  });

  it('records payouts and notifies subscribers', async () => {
    const p = make();
    let calls = 0;
    const off = p.subscribe(() => (calls += 1));
    await p.payout({ recipient: 'Dana', amountCents: usd(220), note: 'Mochi Bunny plush and the queue fee', reference: 'sale-1' });
    off();
    expect(calls).toBeGreaterThan(0);
    expect(p.activity()[0]).toMatchObject({ kind: 'paid_out', amount: { cents: usd(220), currency: 'USD' } });
  });

  it('rejects amounts that are not whole cents', async () => {
    const p = make();
    await expect(p.placeHold({ amountCents: 10.5, reference: 'r', description: 'x' })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
  });
});
