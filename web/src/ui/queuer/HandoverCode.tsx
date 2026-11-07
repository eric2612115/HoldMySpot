import { useMarket } from '../../state/market';
import { useQueuer } from './store';

/**
 * The requester's side of a local errand: once the queuer's receipt has
 * passed, the requester's phone shows the handover code. Saying it to the
 * queuer at the handover is the requester's OK for the one capture.
 */
export function HandoverCode() {
  const jobs = useQueuer((s) => s.requesterJobs);
  const selectedId = useMarket((s) => s.selectedId);
  const points = useMarket((s) => s.points);
  const ready = Object.values(jobs).filter((j) => j.mode === 'local' && j.status === 'verified' && j.handoverCode);
  if (ready.length === 0 || selectedId) return null;
  const job = ready[0]!;
  const item = points.find((p) => p.id === job.itemId);
  return (
    <section className="q-handover" aria-live="polite">
      <span className="q-handover__kicker">Handover · {item?.shop.name ?? 'the shop'}</span>
      <p>
        {job.queuerName} bought your {item?.itemShort ?? 'item'}. Say this code when you meet; it lets PayPal charge the receipt and the fee.
      </p>
      <span className="q-handover__code" data-handover-code>
        {job.handoverCode}
      </span>
    </section>
  );
}
