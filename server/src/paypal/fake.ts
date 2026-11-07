import type { CheckoutFunding } from '@holdmyspot/shared';
import type { FakePaymentsControls } from '../ports/payments.ts';
import { PayPalRestClient } from './client.ts';
import { SANDBOX_BASE_URL } from './constants.ts';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, PayPalEmulator, type EmShipTo, type EmulatorOptions, type EmulatorState } from './emulator.ts';
import { PayPalHttp } from './http.ts';
import type { RecordedResponse } from './types.ts';

/**
 * The fake adapter: the same REST client the sandbox uses, wired to the
 * in-process emulator instead of the network. Offline tests and the probe
 * script's `--fake` mode use it, so they exercise the sandbox code path
 * (request bodies, response mapping, retries, idempotency, error mapping).
 * It also implements FakePaymentsControls (server/src/ports/payments.ts), so
 * the server can use it for fake mode too and persist `exportState()`.
 */

export interface FakePayPalOptions extends EmulatorOptions {
  log?: ((line: string) => void) | null;
  onResponse?: (r: RecordedResponse) => void;
  invoicePrefix?: string;
}

export class FakePayPal extends PayPalRestClient implements FakePaymentsControls {
  readonly emulator: PayPalEmulator;

  constructor(options: FakePayPalOptions = {}) {
    const emulator = new PayPalEmulator(options);
    const http = new PayPalHttp({
      clientId: FAKE_CLIENT_ID,
      clientSecret: FAKE_CLIENT_SECRET,
      baseUrl: SANDBOX_BASE_URL,
      fetchImpl: emulator.fetch,
      timeoutMs: 5000,
      log: options.log ?? null,
      onResponse: options.onResponse ?? null,
      sleep: () => Promise.resolve(),
    });
    super({ mode: 'fake', http, webhookId: options.webhookId ?? null, invoicePrefix: options.invoicePrefix, now: options.now });
    this.emulator = emulator;
  }

  /** POST /api/fake/paypal/orders/:orderId/approve: the simulated buyer approves, cancels, or their funding is declined at authorize. */
  async approveOrder(orderId: string, funding: CheckoutFunding, outcome: 'approve' | 'cancel' | 'decline', shipTo?: EmShipTo | null): Promise<{ orderId: string; status: string }> {
    return this.emulator.approveOrder(orderId, funding, outcome, shipTo);
  }

  openDispute(captureId: string, opts?: { reason?: string; amountCents?: number }): string {
    return this.emulator.openDispute(captureId, opts);
  }

  claimPayoutItem(itemId: string): void {
    this.emulator.claimPayoutItem(itemId);
  }

  completePendingCapture(captureId: string): void {
    this.emulator.completePendingCapture(captureId);
  }

  exportState(): EmulatorState {
    return this.emulator.exportState();
  }
}

export function createFakePayPal(options: FakePayPalOptions = {}): FakePayPal {
  return new FakePayPal(options);
}
