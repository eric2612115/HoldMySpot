import { describe, expect, it, vi } from 'vitest';
import { PayPalV6Checkout, sdkError, timeoutAfter, type PayPalSettings, type PayPalV6Deps, type V6CreateInstanceOptions, type V6Session, type V6SessionOptions } from './paypalV6';
import { CheckoutError, type ApprovalCallbacks, type CheckoutFunding } from './types';

const SETTINGS: PayPalSettings = {
  clientId: 'test-client-id',
  sdkUrl: 'https://www.sandbox.paypal.com/web-sdk/v6/core',
  components: ['paypal-payments', 'venmo-payments'],
  currency: 'USD',
  testBuyerCountry: 'US',
  funding: ['paypal', 'venmo'],
};

interface FakeSession extends V6Session {
  options: V6SessionOptions;
  started: { options: unknown; order: Promise<{ orderId: string }> }[];
  cancelled: number;
  destroyed: number;
}

/** A stand-in for PayPal's SDK with the same names (paypal.createInstance and the rest). */
function fakeSdk(opts: { eligible?: Partial<Record<string, boolean>>; startThrows?: boolean; startRejects?: boolean; failCreate?: boolean } = {}) {
  const sessions: Record<string, FakeSession[]> = { paypal: [], venmo: [], paylater: [] };
  const created: V6CreateInstanceOptions[] = [];
  const eligibleAsked: unknown[] = [];
  const later: (() => void)[] = [];
  const factory = (funding: string) => (options: V6SessionOptions): V6Session => {
    const s: FakeSession = {
      options,
      started: [],
      cancelled: 0,
      destroyed: 0,
      start(o, order) {
        if (opts.startThrows) throw new Error('popup blocked');
        s.started.push({ options: o, order });
        return opts.startRejects ? Promise.reject(Object.assign(new Error('window failed'), { code: 'ERR_WINDOW' })) : Promise.resolve();
      },
      cancel() {
        s.cancelled += 1;
      },
      destroy() {
        s.destroyed += 1;
      },
    };
    sessions[funding]!.push(s);
    return s;
  };
  const eligible = { paypal: true, venmo: true, paylater: true, credit: false, ...opts.eligible };
  const deps: PayPalV6Deps = {
    loadScript: vi.fn(async () => {}),
    namespace: () => ({
      version: '6.72.0',
      async createInstance(o) {
        created.push(o);
        if (opts.failCreate) throw Object.assign(new Error('bad client id'), { code: 'INVALID_CLIENT' });
        return {
          async findEligibleMethods(q) {
            eligibleAsked.push(q);
            return {
              isEligible: (m: string) => eligible[m as keyof typeof eligible] === true,
              getDetails: (m: string) => (m === 'paylater' ? { productCode: 'PAYLATER', countryCode: 'US' } : undefined),
            };
          },
          createPayPalOneTimePaymentSession: factory('paypal'),
          createVenmoOneTimePaymentSession: factory('venmo'),
          createPayLaterOneTimePaymentSession: factory('paylater'),
        };
      },
    }),
    later: (fn) => later.push(fn),
    timeout: (p) => p,
  };
  return { deps, sessions, created, eligibleAsked, runLater: () => later.splice(0).forEach((fn) => fn()) };
}

function recorder() {
  const events: string[] = [];
  const callbacks: ApprovalCallbacks = {
    onApprove: vi.fn(async (d: { orderId: string; funding: CheckoutFunding }) => {
      events.push(`approve:${d.orderId}:${d.funding}`);
    }),
    onCancel: vi.fn(() => {
      events.push('cancel');
    }),
    onError: vi.fn((e: CheckoutError) => {
      events.push(`error:${e.source}:${e.code}:${e.message}`);
    }),
  };
  return { events, callbacks };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PayPal JS SDK v6 checkout', () => {
  it('loads the script once and creates the instance with what GET /api/config gives', async () => {
    const sdk = fakeSdk();
    const c = new PayPalV6Checkout(SETTINGS, sdk.deps);
    const [a, b] = await Promise.all([c.prepare(), c.prepare()]);
    expect(a).toEqual(b);
    expect(sdk.deps.loadScript).toHaveBeenCalledTimes(1);
    expect(sdk.deps.loadScript).toHaveBeenCalledWith(SETTINGS.sdkUrl);
    expect(sdk.created).toEqual([{ clientId: 'test-client-id', components: ['paypal-payments', 'venmo-payments'], pageType: 'checkout', locale: 'en-US', testBuyerCountry: 'US' }]);
    expect(sdk.eligibleAsked).toEqual([{ currencyCode: 'USD' }]);
  });

  it('shows PayPal first and Venmo only when PayPal says it is eligible', async () => {
    expect((await new PayPalV6Checkout(SETTINGS, fakeSdk().deps).prepare()).map((b) => b.funding)).toEqual(['paypal', 'venmo']);
    expect((await new PayPalV6Checkout(SETTINGS, fakeSdk({ eligible: { venmo: false } }).deps).prepare()).map((b) => b.funding)).toEqual(['paypal']);
  });

  it('offers Pay Later only when the server allows it, with the details PayPal gives', async () => {
    expect((await new PayPalV6Checkout(SETTINGS, fakeSdk().deps).prepare()).some((b) => b.funding === 'paylater')).toBe(false);
    const buttons = await new PayPalV6Checkout({ ...SETTINGS, funding: ['paypal', 'venmo', 'paylater'] }, fakeSdk().deps).prepare();
    expect(buttons.at(-1)).toEqual({ funding: 'paylater', productCode: 'PAYLATER', countryCode: 'US' });
  });

  it('a failed load is reported and the next prepare tries again', async () => {
    const sdk = fakeSdk({ failCreate: true });
    const c = new PayPalV6Checkout(SETTINGS, sdk.deps);
    await expect(c.prepare()).rejects.toMatchObject({ code: 'INVALID_CLIENT', source: 'paypal' });
    await expect(c.prepare()).rejects.toBeInstanceOf(CheckoutError);
    expect(sdk.created).toHaveLength(2);
  });

  it('refuses to load without a client id', async () => {
    await expect(new PayPalV6Checkout({ ...SETTINGS, clientId: null }, fakeSdk().deps).prepare()).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('starts PayPal inside the click (before any await) with the order promise, then hands over the approval', async () => {
    const sdk = fakeSdk();
    const c = new PayPalV6Checkout(SETTINGS, sdk.deps);
    await c.prepare();
    const { events, callbacks } = recorder();
    const order = Promise.resolve({ orderId: 'ORDER-1' });
    c.start('paypal', order, callbacks);
    const session = sdk.sessions.paypal![0]!;
    expect(session.started).toHaveLength(1); // synchronous: still inside the click
    expect(session.started[0]!.options).toEqual({ presentationMode: 'auto' });
    expect(c.busy()).toBe(true);
    await session.options.onApprove({ orderId: 'ORDER-1' });
    expect(events).toEqual(['approve:ORDER-1:paypal']);
    expect(c.busy()).toBe(false);
    // A late cancel from the same window reaches nobody.
    session.options.onCancel({ orderId: 'ORDER-1' });
    expect(events).toEqual(['approve:ORDER-1:paypal']);
  });

  it('uses the Venmo session for the Venmo button', async () => {
    const sdk = fakeSdk();
    const c = new PayPalV6Checkout(SETTINGS, sdk.deps);
    await c.prepare();
    const { events, callbacks } = recorder();
    c.start('venmo', Promise.resolve({ orderId: 'ORDER-V' }), callbacks);
    expect(sdk.sessions.paypal![0]!.started).toHaveLength(0);
    await sdk.sessions.venmo![0]!.options.onApprove({ orderId: 'ORDER-V' });
    expect(events).toEqual(['approve:ORDER-V:venmo']);
  });

  it('a closed window ends the attempt as cancelled, and the next click gets a fresh session', async () => {
    const sdk = fakeSdk();
    const c = new PayPalV6Checkout(SETTINGS, sdk.deps);
    await c.prepare();
    const first = recorder();
    c.start('paypal', Promise.resolve({ orderId: 'ORDER-1' }), first.callbacks);
    const old = sdk.sessions.paypal![0]!;
    old.options.onCancel({ orderId: 'ORDER-1' });
    old.options.onError(new Error('late'));
    expect(first.events).toEqual(['cancel']);
    expect(sdk.sessions.paypal).toHaveLength(2);
    sdk.runLater();
    expect(old.destroyed).toBe(1);
    expect(old.cancelled).toBe(0); // PayPal closed it itself
    const second = recorder();
    c.start('paypal', Promise.resolve({ orderId: 'ORDER-2' }), second.callbacks);
    expect(sdk.sessions.paypal![1]!.started).toHaveLength(1);
    await old.options.onApprove({ orderId: 'ORDER-1' }); // a stale window reaches nobody
    expect(second.events).toEqual([]);
  });

  it('an order our server refused ends with the server’s own words and closes PayPal’s window', async () => {
    const sdk = fakeSdk();
    const c = new PayPalV6Checkout(SETTINGS, sdk.deps);
    await c.prepare();
    const { events, callbacks } = recorder();
    const refused = Promise.reject(Object.assign(new Error('The queue fee must be at least $8.00 per unit.'), { code: 'FEE_BELOW_MINIMUM' }));
    c.start('paypal', refused, callbacks);
    await flush();
    sdk.sessions.paypal![0]!.options.onError(new Error('order promise rejected')); // PayPal reports it too
    expect(events).toEqual(['error:order:ORDER_FAILED:The queue fee must be at least $8.00 per unit.']);
    sdk.runLater();
    expect(sdk.sessions.paypal![0]!.cancelled).toBe(1);
  });

  it('reports PayPal’s errors with their code, whether reported, thrown or rejected', async () => {
    for (const mode of ['reported', 'thrown', 'rejected'] as const) {
      const sdk = fakeSdk({ startThrows: mode === 'thrown', startRejects: mode === 'rejected' });
      const c = new PayPalV6Checkout(SETTINGS, sdk.deps);
      await c.prepare();
      const { events, callbacks } = recorder();
      c.start('paypal', Promise.resolve({ orderId: 'ORDER-1' }), callbacks);
      if (mode === 'reported') sdk.sessions.paypal![0]!.options.onError(Object.assign(new Error('Instrument declined'), { code: 'INSTRUMENT_DECLINED', isRecoverable: true }));
      await flush();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatch(mode === 'reported' ? /^error:paypal:INSTRUMENT_DECLINED:/ : mode === 'thrown' ? /^error:paypal:PAYPAL_ERROR:popup blocked$/ : /^error:paypal:ERR_WINDOW:/);
      expect(c.busy()).toBe(false);
    }
  });

  it('cancel() stops the open approval and asks PayPal to close its window', async () => {
    const sdk = fakeSdk();
    const c = new PayPalV6Checkout(SETTINGS, sdk.deps);
    await c.prepare();
    const { events, callbacks } = recorder();
    c.start('paypal', Promise.resolve({ orderId: 'ORDER-1' }), callbacks);
    c.cancel();
    expect(events).toEqual(['cancel']);
    sdk.runLater();
    expect(sdk.sessions.paypal![0]!.cancelled).toBe(1);
    c.cancel(); // nothing open: nothing happens
    expect(events).toEqual(['cancel']);
  });

  it('one PayPal window at a time, and no button before PayPal is ready', async () => {
    const sdk = fakeSdk();
    const c = new PayPalV6Checkout(SETTINGS, sdk.deps);
    const early = recorder();
    c.start('paypal', Promise.resolve({ orderId: 'X' }), early.callbacks);
    expect(early.events[0]).toMatch(/^error:paypal:NOT_READY:/);
    await c.prepare();
    const first = recorder();
    const second = recorder();
    c.start('paypal', Promise.resolve({ orderId: 'A' }), first.callbacks);
    c.start('venmo', Promise.resolve({ orderId: 'B' }), second.callbacks);
    expect(second.events[0]).toMatch(/^error:paypal:BUSY:/);
    expect(first.events).toEqual([]);
  });

  it('maps unknown SDK errors and times out a silent SDK', async () => {
    expect(sdkError('boom')).toMatchObject({ code: 'PAYPAL_ERROR', message: 'boom' });
    expect(sdkError({ name: 'PayPalError', message: 'x' })).toMatchObject({ code: 'PayPalError' });
    vi.useFakeTimers();
    try {
      const never = new Promise<never>(() => {});
      const p = timeoutAfter(never, 1000);
      vi.advanceTimersByTime(1000);
      await expect(p).rejects.toMatchObject({ code: 'SDK_TIMEOUT' });
    } finally {
      vi.useRealTimers();
    }
  });
});
