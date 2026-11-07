import type { AppConfig } from '@holdmyspot/shared';
import { CheckoutError, type ApprovalCallbacks, type CheckoutButton, type CheckoutFunding, type CheckoutService } from './types';

/**
 * PayPal's JS SDK v6 in the browser (docs/PAYPAL-MAPPING.md section 3), for a
 * server in sandbox mode. Every name below was checked against the script
 * PayPal serves at https://www.sandbox.paypal.com/web-sdk/v6/core (version
 * 6.72.0 on 2026-11-07) and PayPal's v6 samples:
 *
 *   paypal.createInstance({ clientId, components, pageType, locale, testBuyerCountry })
 *   instance.findEligibleMethods({ currencyCode }) -> isEligible(method), getDetails(method)
 *   instance.createPayPalOneTimePaymentSession / createVenmoOneTimePaymentSession /
 *            createPayLaterOneTimePaymentSession({ onApprove, onCancel, onError })
 *   session.start({ presentationMode: 'auto' }, orderPromise), session.cancel(), session.destroy()
 *   buttons: <paypal-button>, <venmo-button>, <paypal-pay-later-button> (see ui/PayPalButton.tsx)
 *
 * The browser gets only the client id from GET /api/config; the server keeps
 * the secret, creates the order and authorizes it.
 */

/** What the server's GET /api/config says about PayPal. */
export type PayPalSettings = AppConfig['paypal'];

// ---- the slice of the SDK this file uses ----------------------------------

export interface V6SessionOptions {
  onApprove(data: { orderId?: string; payerId?: string }): Promise<void>;
  onCancel(data?: { orderId?: string }): void;
  onError(error: unknown): void;
}

export interface V6Session {
  start(options: { presentationMode: 'auto' }, order: Promise<{ orderId: string }>): unknown;
  cancel?(): void;
  destroy?(): void;
}

export interface V6EligibleMethods {
  isEligible(method: string): boolean;
  getDetails?(method: string): { productCode?: string; countryCode?: string } | undefined;
}

export interface V6Instance {
  findEligibleMethods(options: { currencyCode: string }): Promise<V6EligibleMethods>;
  createPayPalOneTimePaymentSession?(options: V6SessionOptions): V6Session;
  createVenmoOneTimePaymentSession?(options: V6SessionOptions): V6Session;
  createPayLaterOneTimePaymentSession?(options: V6SessionOptions): V6Session;
}

export interface V6CreateInstanceOptions {
  clientId: string;
  components: string[];
  pageType: 'checkout';
  locale: string;
  testBuyerCountry?: string;
}

export interface V6Namespace {
  version?: string;
  createInstance(options: V6CreateInstanceOptions): Promise<V6Instance>;
}

export interface PayPalV6Deps {
  /** Loads a script once; resolves when it has run. */
  loadScript(url: string): Promise<void>;
  /** `window.paypal` once the script has run. */
  namespace(): V6Namespace | undefined;
  /** Runs `fn` a little later (tidying up a finished session). */
  later(fn: () => void): void;
  /** Rejects with SDK_TIMEOUT when PayPal's SDK does not answer in time, so the buttons never spin forever. */
  timeout<T>(p: Promise<T>): Promise<T>;
}

const FACTORY = {
  paypal: 'createPayPalOneTimePaymentSession',
  venmo: 'createVenmoOneTimePaymentSession',
  paylater: 'createPayLaterOneTimePaymentSession',
} as const satisfies Record<CheckoutFunding, keyof V6Instance>;

/** The order PayPal's buttons appear in. */
const BUTTON_ORDER: CheckoutFunding[] = ['paypal', 'venmo', 'paylater'];

const LABEL: Record<CheckoutFunding, string> = { paypal: 'PayPal', venmo: 'Venmo', paylater: 'Pay Later' };

// ---- one approval ---------------------------------------------------------

type Ending = { kind: 'cancelled' } | { kind: 'error'; error: CheckoutError };

/** One click on a button: ends exactly once, whatever PayPal and our server report, in whatever order. */
class Attempt {
  done = false;
  orderId: string | null = null;

  constructor(
    readonly funding: CheckoutFunding,
    private readonly callbacks: ApprovalCallbacks,
    private readonly onDone: (closeWindow: boolean) => void,
  ) {}

  async approve(data: { orderId?: string } | undefined): Promise<void> {
    if (this.done) return;
    const orderId = data?.orderId ?? this.orderId;
    if (!orderId) {
      this.end({ kind: 'error', error: new CheckoutError('NO_ORDER', 'PayPal approved without naming the order.', 'paypal') });
      return;
    }
    this.done = true;
    try {
      await this.callbacks.onApprove({ orderId, funding: this.funding });
    } catch {
      // The app shows its own message; nothing goes back into PayPal's window.
    } finally {
      this.onDone(false);
    }
  }

  end(ending: Ending, closeWindow = false): void {
    if (this.done) return;
    this.done = true;
    try {
      if (ending.kind === 'cancelled') this.callbacks.onCancel();
      else this.callbacks.onError(ending.error);
    } finally {
      this.onDone(closeWindow);
    }
  }
}

/** A session with its callbacks bound to whichever attempt it is running. A fresh one replaces it after each attempt. */
interface Slot {
  funding: CheckoutFunding;
  session: V6Session;
  attempt: Attempt | null;
}

// ---- errors ---------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** An error PayPal's SDK reported or threw. */
export function sdkError(err: unknown): CheckoutError {
  if (err instanceof CheckoutError) return err;
  const e = (err ?? {}) as { code?: unknown; name?: unknown; message?: unknown };
  const code = str(e.code) ?? (str(e.name) && e.name !== 'Error' ? String(e.name) : null) ?? 'PAYPAL_ERROR';
  const message = str(e.message) ?? (typeof err === 'string' ? err : 'PayPal stopped with an error.');
  return new CheckoutError(code, message, 'paypal');
}

/** Our server's answer when it could not create the order (an ApiError carries its plain-English message). */
export function orderError(err: unknown): CheckoutError {
  if (err instanceof CheckoutError) return err;
  const message = str((err as { message?: unknown } | null)?.message) ?? 'The server could not create the PayPal order.';
  return new CheckoutError('ORDER_FAILED', message, 'order');
}

function isEligible(methods: V6EligibleMethods, funding: CheckoutFunding): boolean {
  try {
    return methods.isEligible(funding) === true;
  } catch {
    return false;
  }
}

// ---- the adapter ----------------------------------------------------------

export class PayPalV6Checkout implements CheckoutService {
  readonly mode = 'paypal-v6' as const;
  readonly #settings: PayPalSettings;
  readonly #deps: PayPalV6Deps;
  #ready: Promise<CheckoutButton[]> | null = null;
  #instance: V6Instance | null = null;
  readonly #slots = new Map<CheckoutFunding, Slot>();
  #active: Attempt | null = null;

  constructor(settings: PayPalSettings, deps: PayPalV6Deps = browserDeps()) {
    this.#settings = settings;
    this.#deps = deps;
  }

  prepare(): Promise<CheckoutButton[]> {
    if (!this.#ready) {
      const ready = this.#load();
      this.#ready = ready;
      ready.catch(() => {
        if (this.#ready === ready) this.#ready = null; // the next prepare() tries again
      });
    }
    return this.#ready;
  }

  async #load(): Promise<CheckoutButton[]> {
    const { sdkUrl, clientId, testBuyerCountry, currency, components, funding } = this.#settings;
    if (!sdkUrl || !clientId) throw new CheckoutError('NOT_CONFIGURED', 'This server has no PayPal client id, so PayPal’s buttons cannot load.', 'paypal');
    try {
      await this.#deps.loadScript(sdkUrl);
    } catch (err) {
      throw new CheckoutError('SCRIPT_FAILED', str((err as Error | null)?.message) ?? 'PayPal’s script did not load.', 'paypal');
    }
    const ns = this.#deps.namespace();
    if (!ns || typeof ns.createInstance !== 'function') throw new CheckoutError('SDK_MISSING', 'PayPal’s script loaded but did not start.', 'paypal');
    let instance: V6Instance;
    let methods: V6EligibleMethods;
    try {
      instance = await this.#deps.timeout(
        ns.createInstance({
          clientId,
          components,
          pageType: 'checkout',
          locale: 'en-US',
          ...(testBuyerCountry ? { testBuyerCountry } : {}),
        }),
      );
      methods = await this.#deps.timeout(instance.findEligibleMethods({ currencyCode: currency }));
    } catch (err) {
      throw sdkError(err);
    }
    this.#instance = instance;
    const buttons: CheckoutButton[] = [];
    for (const f of BUTTON_ORDER) {
      if (!funding.includes(f) || typeof instance[FACTORY[f]] !== 'function' || !isEligible(methods, f)) continue;
      const button: CheckoutButton = { funding: f };
      if (f === 'paylater') {
        const details = methods.getDetails?.('paylater');
        if (details?.productCode) button.productCode = details.productCode;
        if (details?.countryCode) button.countryCode = details.countryCode;
      }
      this.#slots.set(f, this.#slot(f));
      buttons.push(button);
    }
    return buttons;
  }

  #slot(funding: CheckoutFunding): Slot {
    const instance = this.#instance!;
    const create = instance[FACTORY[funding]]!;
    const slot: Slot = { funding, attempt: null, session: { start: () => undefined } };
    slot.session = create.call(instance, {
      onApprove: (data) => (slot.attempt ? slot.attempt.approve(data) : Promise.resolve()),
      onCancel: () => slot.attempt?.end({ kind: 'cancelled' }),
      onError: (err) => slot.attempt?.end({ kind: 'error', error: sdkError(err) }),
    });
    return slot;
  }

  busy(): boolean {
    return this.#active !== null && !this.#active.done;
  }

  start(funding: CheckoutFunding, order: Promise<{ orderId: string }>, callbacks: ApprovalCallbacks): void {
    // Nobody may be left waiting on an order that fails while we refuse to start.
    order.catch(() => {});
    const slot = this.#slots.get(funding);
    if (!slot) {
      callbacks.onError(new CheckoutError('NOT_READY', `The ${LABEL[funding]} button is not ready yet. Try again in a moment.`, 'paypal'));
      return;
    }
    if (this.busy()) {
      callbacks.onError(new CheckoutError('BUSY', 'PayPal’s window is already open for another request. Finish or close it first.', 'paypal'));
      return;
    }
    const attempt = new Attempt(funding, callbacks, (closeWindow) => this.#retire(slot, attempt, closeWindow));
    slot.attempt = attempt;
    this.#active = attempt;
    // Registered before PayPal sees the order, so a refused order ends with our server's own words.
    order.then(
      (o) => {
        attempt.orderId = o.orderId;
      },
      (err) => attempt.end({ kind: 'error', error: orderError(err) }, true),
    );
    let started: unknown;
    try {
      started = slot.session.start({ presentationMode: 'auto' }, order);
    } catch (err) {
      attempt.end({ kind: 'error', error: sdkError(err) }, true);
      return;
    }
    Promise.resolve(started).catch((err: unknown) => attempt.end({ kind: 'error', error: sdkError(err) }, true));
  }

  cancel(): void {
    this.#active?.end({ kind: 'cancelled' }, true);
  }

  /** After an attempt: a fresh session for the next click, so a late callback from this one reaches nobody. */
  #retire(slot: Slot, attempt: Attempt, closeWindow: boolean): void {
    if (this.#active === attempt) this.#active = null;
    if (this.#slots.get(slot.funding) === slot && this.#instance) this.#slots.set(slot.funding, this.#slot(slot.funding));
    const old = slot.session;
    this.#deps.later(() => {
      try {
        if (closeWindow) old.cancel?.();
      } catch {
        /* already closed */
      }
      try {
        old.destroy?.();
      } catch {
        /* already gone */
      }
    });
  }
}

// ---- browser dependencies -------------------------------------------------

const scripts = new Map<string, Promise<void>>();

/** Adds a script tag once per URL; a failed load is forgotten so the next call tries again. */
export function loadScriptOnce(url: string, timeoutMs = 20_000): Promise<void> {
  const known = scripts.get(url);
  if (known) return known;
  const loading = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    let timer = 0;
    const fail = (message: string) => {
      window.clearTimeout(timer);
      el.remove();
      scripts.delete(url);
      reject(new Error(message));
    };
    timer = window.setTimeout(() => fail('PayPal’s script took too long to load.'), timeoutMs);
    el.src = url;
    el.async = true;
    el.onload = () => {
      window.clearTimeout(timer);
      resolve();
    };
    el.onerror = () => fail('PayPal’s script did not load (offline, or blocked by the browser).');
    document.head.appendChild(el);
  });
  scripts.set(url, loading);
  return loading;
}

/** Rejects with SDK_TIMEOUT after `ms`. */
export function timeoutAfter<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CheckoutError('SDK_TIMEOUT', 'PayPal did not answer in time.', 'paypal')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function browserDeps(): PayPalV6Deps {
  return {
    loadScript: (url) => loadScriptOnce(url),
    namespace: () => (window as unknown as { paypal?: V6Namespace }).paypal,
    later: (fn) => window.setTimeout(fn, 1000),
    timeout: (p) => timeoutAfter(p, 20_000),
  };
}
