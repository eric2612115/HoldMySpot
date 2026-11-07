import { beforeEach, describe, expect, it } from 'vitest';
import { toastsFor, useMarket, type Toast } from './market';

// The store dismisses each toast with window.setTimeout; the tests run in Node.
Object.assign(globalThis, { window: { setTimeout: () => 0 } });

const t = (id: number, audience: Toast['audience']): Toast => ({ id, text: `toast ${id}`, tone: 'info', audience });

describe('toasts per phone (D-132)', () => {
  beforeEach(() => useMarket.setState({ toasts: [] }));

  it("shows the requester's toasts only on the requester's phone, and the queuer's only on the queuer's", () => {
    const all = [t(1, 'requester'), t(2, 'queuer'), t(3, 'any')];
    expect(toastsFor(all, 'requester').map((x) => x.id)).toEqual([1, 3]);
    expect(toastsFor(all, 'queuer').map((x) => x.id)).toEqual([2, 3]);
  });

  it("keeps Mia's money news off Wei's phone while both phones' toasts arrive", () => {
    const { toast } = useMarket.getState();
    toast('$63.70 held. A queuer takes it when an offer reaches your $12 fee.', 'money', 'requester');
    toast('You took a request at $12.00.', 'money', 'queuer');
    toast('Matched: Wei will queue for you for a $12 fee.', 'money', 'requester');
    const toasts = useMarket.getState().toasts;
    expect(toastsFor(toasts, 'queuer').map((x) => x.text)).toEqual(['You took a request at $12.00.']);
    expect(toastsFor(toasts, 'requester').map((x) => x.text)).toEqual([
      '$63.70 held. A queuer takes it when an offer reaches your $12 fee.',
      'Matched: Wei will queue for you for a $12 fee.',
    ]);
  });

  it('keeps at most the two newest toasts per phone', () => {
    const { toast } = useMarket.getState();
    for (const n of [1, 2, 3]) toast(`requester ${n}`, 'info', 'requester');
    toast('a note for every phone', 'info');
    const toasts = useMarket.getState().toasts;
    expect(toastsFor(toasts, 'requester').map((x) => x.text)).toEqual(['requester 3', 'a note for every phone']);
    expect(toastsFor(toasts, 'queuer').map((x) => x.text)).toEqual(['a note for every phone']);
  });

  it('defaults to every phone (the in-browser market has one phone)', () => {
    useMarket.getState().toast('Using your location.');
    expect(useMarket.getState().toasts[0]?.audience).toBe('any');
  });
});
