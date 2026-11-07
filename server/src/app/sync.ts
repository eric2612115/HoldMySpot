import type { App } from './app.ts';
import { applyCapture, applyPayout, loadRequest, payoutsAfterCapture } from './money.ts';

/**
 * PayPal status sync by polling (docs/PAYPAL-MAPPING.md section 6): pending
 * captures and pending or unclaimed payouts are fetched again and mapped to
 * our records with the same functions the direct calls use. Webhooks, when
 * configured, feed the same mappers.
 */
export async function syncPayPal(app: App): Promise<number> {
  let changed = 0;
  for (const entry of app.store.ledger.where("kind = 'captured' AND status = 'pending'")) {
    const captureId = entry.paypal?.captureId;
    const req = loadRequest(app, entry.id);
    if (!captureId || req?.op !== 'capture') continue;
    try {
      const r = await app.payments(entry.mode).getCapture(captureId);
      if (r.status === 'PENDING') continue;
      const out = await app.exec(() => app.tx(() => applyCapture(app, entry.id, req, r)));
      if (out.completed) await app.exec(() => payoutsAfterCapture(app, req.jobId, req.part, req.parts));
      changed++;
    } catch (err) {
      app.log(`sync of capture ${captureId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const payout of app.store.payouts.where("status IN ('pending', 'unclaimed')")) {
    const entry = app.store.ledger.first("payout_id = ? AND kind = 'paid_out'", payout.id);
    if (!payout.paypalBatchId || !entry) continue;
    try {
      const r = await app.payments(entry.mode).getPayoutBatch(payout.paypalBatchId);
      const before = payout.status;
      const after = await app.exec(() => app.tx(() => applyPayout(app, entry.id, payout.id, r)));
      if (after.status !== entry.status || before !== app.store.payouts.must(payout.id).status) changed++;
    } catch (err) {
      app.log(`sync of payout batch ${payout.paypalBatchId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return changed;
}
