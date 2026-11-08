import { DEFAULT_RULES, findShop, formatUsd } from '@holdmyspot/shared';
import type { Job } from '@holdmyspot/shared';
import { useState, type ReactNode } from 'react';
import { distanceText, reachOf, travelText } from '../../domain/earning';
import type { TaskPoint } from '../../domain/types';
import type { MapScene } from '../../map/mapScene';
import { usePosition } from '../../state/position';
import { clock, params } from '../../state/services';
import { useModeBanner } from '../MoneyPanel';
import { useNow } from '../hooks';
import { PriceStairs } from '../PriceStairs';
import { AiCheckCard } from './AiCheckCard';
import {
  countText,
  currentJob,
  durationText,
  failureText,
  fenceOf,
  keptFeeCents,
  lineCheckView,
  liveFee,
  payoutSummary,
  perHourText,
  purchaseCheckView,
  realizedPerHour,
  timeIn,
  timeSpentMs,
  type Errand,
} from './logic';
import { PhotoField } from './PhotoField';
import type { StampInfo } from './stamp';
import { LINE_READINGS, RECEIPT_READINGS, SimulatedReading, useSimulatedReadings } from './SimulatedReading';
import { queuerActions, useQueuer } from './store';

/** The cards of the errand sheet, one per step (see ErrandSheet.tsx). */

interface CardProps {
  errand: Errand;
  point: TaskPoint;
}

const units = (job: Pick<Job, 'qty'>, point: TaskPoint) => `${job.qty} × ${point.itemShort}`;
const where = (job: Pick<Job, 'mode'>) => (job.mode === 'ship' ? 'shipped to the requester' : 'handed over in person');

function useBusy(label: string): boolean {
  return useQueuer((s) => s.busy === label);
}

function JobLine({ job, point }: { job: Job; point: TaskPoint }) {
  return (
    <div className="q-job">
      <span className="q-job__who">For {job.requesterName}</span>
      <span className="q-job__what">
        {units(job, point)}, {where(job)}
      </span>
      <span className="q-job__fee">
        {formatUsd(job.feeCents * job.qty, { exact: true })}
        <small>fee</small>
      </span>
    </div>
  );
}

/** The stamp for a photo taken now at this shop; null when the code is not known (the photo then fails its check). */
function stampOf(code: string | null | undefined, point: TaskPoint): StampInfo | null {
  if (!code) return null;
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: point.shop.timezone, hour: '2-digit', minute: '2-digit' }).format(clock.now());
  return { code, hhmm, shopName: point.shop.name };
}

function Code({ code, children }: { code: string | null; children: ReactNode }) {
  return (
    <div className="q-code">
      <span className="q-code__value" aria-label={`Code ${code ?? 'not available'}`}>
        {code ?? '·····'}
      </span>
      <span className="q-code__text">{children}</span>
    </div>
  );
}

// ---- 1. Arrive and check in ----------------------------------------------------

export function ArrivalCard({ errand, point, scene }: CardProps & { scene: MapScene | null }) {
  const now = useNow(500);
  const me = usePosition((s) => s.lngLat);
  const [photo, setPhoto] = useState<File | null>(null);
  const simulated = useSimulatedReadings();
  const [reading, setReading] = useState('line_ok');
  const checking = useBusy('Checking in');
  const { claim, ask, jobs, lineProof } = errand;
  const shop = findShop(point.shop.id);
  const fence = shop ? fenceOf(me, shop) : { distanceM: 0, inside: true };
  const reach = reachOf(point, me, now);
  const left = claim.windowEndsAt - now;
  const tz = point.shop.timezone;
  const failed = lineProof && lineProof.status === 'failed' ? lineProof : null;
  const fee = ask ? liveFee(ask, now) : null;

  return (
    <div className="q-card">
      <div className="q-clock">
        <div>
          <span className={`q-clock__big${left < 3 * 60_000 ? ' is-late' : ''}`} data-countdown>
            {countText(left)}
          </span>
          <span className="q-clock__caption">{left > 0 ? `left to check in, by ${timeIn(claim.windowEndsAt, tz)}` : 'The arrival window has ended'}</span>
        </div>
        <div className="q-clock__side">
          <strong>{fence.inside ? 'At the shop' : travelText(reach)}</strong>
          <span>{fence.inside ? `${fence.distanceM} m away, inside the ${shop?.geofenceMeters ?? DEFAULT_RULES.geofenceMeters} m check-in area` : `${distanceText(reach.walkM)} to go`}</span>
        </div>
      </div>

      {jobs.length > 0 ? (
        jobs.map((j) => <JobLine key={j.id} job={j} point={point} />)
      ) : (
        <p className="q-note">
          Your offer is up at {formatUsd(fee?.feeCents ?? ask?.feeCents ?? 0)}
          {fee?.waiting ? '; it starts stepping down when you check in' : ''}. No request has met it yet.
        </p>
      )}

      {!fence.inside && (
        <button type="button" className="ghost-button q-walk" onClick={() => scene?.walkToPoint(point.id)}>
          {params.demo || usePosition.getState().source === 'demo' ? 'Walk there (demo walk on the map)' : 'Show me the way'}
        </button>
      )}

      <Code code={claim.checkInCode}>This one-time code ties your photo to this visit. Just photograph the line: the app adds the code, the time and the shop to the photo, and it only counts if the check passes.</Code>

      {failed && <AiCheckCard view={lineCheckView(failed, claim)} kind="line" />}

      <PhotoField name="line" label={failed ? 'A new photo of the line' : 'Photo of the line'} hint="The line and the shop front. The app stamps your code on it." file={photo} onFile={setPhoto} disabled={checking} stamp={stampOf(claim.checkInCode, point)} />
      {simulated && <SimulatedReading name="line" options={LINE_READINGS} value={reading} onChange={setReading} disabled={checking} />}
      <button
        type="button"
        className="take-button"
        disabled={!photo || !fence.inside || checking || left <= 0}
        onClick={() => {
          if (photo) void queuerActions.checkIn(claim, photo, simulated ? reading : null).then((out) => out && setPhoto(null));
        }}
      >
        {checking ? 'Checking in…' : fence.inside ? 'Check in with this photo' : `Check in within ${shop?.geofenceMeters ?? 80} m of the shop`}
      </button>
      {jobs.length === 0 && ask && (
        <button type="button" className="text-button q-quiet" onClick={() => void queuerActions.withdraw(ask)}>
          Cancel this visit
        </button>
      )}
    </div>
  );
}

// ---- 2. The line photo is being checked ----------------------------------------

export function CheckingCard({ errand }: CardProps) {
  const { claim, lineProof } = errand;
  return (
    <div className="q-card">
      <AiCheckCard view={lineProof && lineProof.status !== 'verifying' ? lineCheckView(lineProof, claim) : null} kind="line" />
      <p className="q-note">Stay in the line. The fee clock starts the moment the photo passes.</p>
    </div>
  );
}

// ---- 3. In line ----------------------------------------------------------------------

function QueueTimer({ errand, point }: CardProps) {
  const now = useNow(500);
  const { claim, lineProof } = errand;
  const since = claim.checkedInAt ?? claim.updatedAt;
  return (
    <div className="q-clock">
      <div>
        <span className="q-clock__big is-run" data-queue-timer>
          {countText(now - since)}
        </span>
        <span className="q-clock__caption">in line since {timeIn(since, point.shop.timezone)}</span>
      </div>
      <div className="q-clock__side">
        <strong>{lineProof?.peopleAhead != null ? `~${lineProof.peopleAhead} ahead` : `~${point.queue.minutes} min`}</strong>
        <span>{lineProof?.peopleAhead != null ? 'at check-in, from your photo' : 'usual wait'}</span>
      </div>
    </div>
  );
}

function FeeClockCard({ errand, point }: CardProps) {
  const now = useNow(500);
  const ask = errand.ask;
  if (!ask) return null;
  const fee = liveFee(ask, now);
  const open = ask.status === 'open' && ask.remainingCapacity > 0;
  if (!fee.schedule) {
    return (
      <p className="q-note">
        {open ? `Your offer stays at ${formatUsd(fee.feeCents)} until a request meets it.` : `Fixed fee ${formatUsd(ask.feeCents)}, set when you took the task.`}
      </p>
    );
  }
  return (
    <div className="q-feeclock">
      <div className="q-feeclock__row">
        <span>
          <strong>{formatUsd(fee.feeCents)}</strong> your fee now
        </span>
        <span>{fee.nextAt !== null && fee.nextCents !== null ? `${formatUsd(fee.nextCents)} in ${countText(fee.nextAt - now)}` : 'at the floor'}</span>
      </div>
      <PriceStairs schedule={fee.schedule} now={now} hue={point.hue} />
      <p className="q-note">{open ? 'The first request at or above this fee is yours.' : 'Matched: each request keeps the fee it met.'}</p>
    </div>
  );
}

export function WaitingCard({ errand, point }: CardProps) {
  const ending = useBusy('Ending the visit');
  return (
    <div className="q-card">
      <QueueTimer errand={errand} point={point} />
      <FeeClockCard errand={errand} point={point} />
      <button type="button" className="text-button q-quiet" disabled={ending} onClick={() => void queuerActions.endVisit(errand.claim)}>
        {ending ? 'Ending…' : 'End my visit'}
      </button>
    </div>
  );
}

export function InLineCard({ errand, point }: CardProps) {
  const job = currentJob(errand)!;
  const buying = useBusy('Marking it bought');
  const reporting = useBusy('Reporting the sell-out');
  const [soldOut, setSoldOut] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  return (
    <div className="q-card">
      <QueueTimer errand={errand} point={point} />
      {errand.lineProof?.status === 'passed' && <AiCheckCard view={lineCheckView(errand.lineProof, errand.claim)} kind="line" />}
      <JobLine job={job} point={point} />
      <FeeClockCard errand={errand} point={point} />
      <Code code={job.proofCode}>
        At the counter, pay the shop price (up to {formatUsd(job.caps.retailCents, { exact: true })} is paid back at cost). Then photograph the {point.itemShort} and the receipt. The app stamps this code on the {point.itemShort}'s photo; you write nothing.
      </Code>
      {!soldOut ? (
        <div className="q-actions">
          <button type="button" className="take-button" disabled={buying || reporting} onClick={() => void queuerActions.bought(job)}>
            {buying ? 'Saving…' : 'Bought'}
          </button>
          <button type="button" className="ghost-button q-danger" disabled={buying || reporting} onClick={() => setSoldOut(true)}>
            Sold out
          </button>
        </div>
      ) : (
        <div className="q-soldout">
          <p>
            <b>Report {point.itemShort} sold out?</b> Your job ends and nothing is charged or paid for this visit; the request goes back on the book. When a second queuer in line reports it too, every request not yet bought closes and PayPal releases its hold.
          </p>
          <PhotoField name="sold-out" label="Photo of the sign (optional)" hint="A sold-out sign or the empty shelf." file={photo} onFile={setPhoto} disabled={reporting} />
          <div className="q-actions">
            <button type="button" className="take-button q-danger-fill" disabled={reporting} onClick={() => void queuerActions.soldOut(job, photo)}>
              {reporting ? 'Reporting…' : 'Report sold out'}
            </button>
            <button type="button" className="ghost-button" disabled={reporting} onClick={() => setSoldOut(false)}>
              Back to the line
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- 4. Proof ---------------------------------------------------------------------------

export function ProofCard({ errand, point }: CardProps) {
  const job = currentJob(errand)!;
  const sending = useBusy('Sending the photos');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [item, setItem] = useState<File | null>(null);
  const simulated = useSimulatedReadings();
  const [reading, setReading] = useState('genuine');
  return (
    <div className="q-card">
      <JobLine job={job} point={point} />
      <p className="q-lead">
        Show what you bought. {simulated ? 'The rules check' : 'The AI reads'} the store, the time, the items and the totals; fixed rules decide. PayPal charges nothing until it passes.
      </p>
      <PhotoField name="receipt" label="The receipt" hint="Flat, the whole receipt, QR included." file={receipt} onFile={setReceipt} disabled={sending} />
      <PhotoField name="item" label={`The ${point.itemShort}`} hint="Just the item. The app stamps your code on it." file={item} onFile={setItem} disabled={sending} stamp={stampOf(job.proofCode, point)} />
      {simulated && <SimulatedReading name="receipt" options={RECEIPT_READINGS} value={reading} onChange={setReading} disabled={sending} />}
      <button type="button" className="take-button" disabled={!receipt || !item || sending} onClick={() => receipt && item && void queuerActions.proof(job, receipt, item, simulated ? reading : null)}>
        {sending ? 'Sending…' : 'Send for checking'}
      </button>
    </div>
  );
}

export function VerifyingCard({ errand, point }: CardProps) {
  const job = currentJob(errand)!;
  const proof = errand.purchaseProofs[job.id];
  const shop = findShop(point.shop.id)!;
  return (
    <div className="q-card">
      <JobLine job={job} point={point} />
      <AiCheckCard view={proof && proof.status !== 'verifying' ? purchaseCheckView(proof, job, shop, errand.claim.checkedInAt) : null} kind="purchase" />
    </div>
  );
}

// ---- 5. Finish: ship or hand over ---------------------------------------------------

function ShipForm({ job }: { job: Job }) {
  const sending = useBusy('Adding tracking');
  const [carrier, setCarrier] = useState('Harbor Parcel Ground');
  const [tracking, setTracking] = useState('');
  const [cost, setCost] = useState('');
  const cents = Math.round(Number(cost.replace(/[^0-9.]/g, '')) * 100);
  const ok = carrier.trim() !== '' && tracking.trim() !== '' && Number.isFinite(cents) && cents >= 0 && cost.trim() !== '';
  return (
    <form
      className="q-ship"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) void queuerActions.ship(job, { carrierName: carrier.trim(), trackingNumber: tracking.trim(), shippingCostCents: cents, dutyPaidCents: 0 });
      }}
    >
      <h4>Ship it</h4>
      <label>
        <span>Carrier</span>
        <input name="carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} autoComplete="off" />
      </label>
      <label>
        <span>Tracking number</span>
        <input name="tracking" value={tracking} onChange={(e) => setTracking(e.target.value)} autoComplete="off" placeholder="From the label" />
      </label>
      <label>
        <span>Label cost (USD)</span>
        <input name="cost" value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" placeholder="8.75" />
      </label>
      <p className="q-note">Shipping is paid back as you declare it, up to {formatUsd(job.caps.shippingCents, { exact: true })}. The tracking number goes to PayPal before the last capture.</p>
      <button type="submit" className="take-button" disabled={!ok || sending}>
        {sending ? 'Adding tracking…' : 'Add tracking'}
      </button>
    </form>
  );
}

function HandoverForm({ job, point }: { job: Job; point: TaskPoint }) {
  const sending = useBusy('Checking the code');
  const [code, setCode] = useState('');
  return (
    <form
      className="q-ship"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.trim()) void queuerActions.handover(job, code.trim());
      }}
    >
      <h4>Hand it over</h4>
      <p className="q-note">
        Meet {job.requesterName} and give them the {point.itemShort}. Their phone shows a 4-digit handover code; typing it here is their OK to charge.
      </p>
      <label>
        <span>Handover code</span>
        <input name="handover" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6} placeholder="4 digits" autoComplete="off" />
      </label>
      <button type="submit" className="take-button" disabled={!code.trim() || sending}>
        {sending ? 'Checking…' : 'Confirm the handover'}
      </button>
    </form>
  );
}

function CaptureNote({ errand, job }: { errand: Errand; job: Job }) {
  const proof = errand.purchaseProofs[job.id];
  const sum = payoutSummary(errand.payouts[job.id] ?? []);
  const capture = proof?.amounts?.captureCents ?? null;
  if (job.mode !== 'ship') {
    return (
      <p className="q-money">
        Receipt passed. At the handover PayPal captures {capture !== null ? formatUsd(capture, { exact: true }) : 'the amount'} from {job.requesterName}&rsquo;s hold (the shop price, your fee and processing at cost), then pays you by Payouts.
      </p>
    );
  }
  return (
    <p className="q-money">
      PayPal captured {capture !== null ? formatUsd(capture, { exact: true }) : 'the receipt'} from {job.requesterName}&rsquo;s hold into HoldMySpot&rsquo;s PayPal balance (the shop price, your fee and processing at cost).{' '}
      {sum.paidCents > 0 ? `Paid ${formatUsd(sum.paidCents, { exact: true })} to you by PayPal Payouts.` : sum.pendingCents > 0 ? 'Your fee payout is on its way.' : ''} The shop price comes back with shipping.
    </p>
  );
}

export function FinishCard({ errand, point }: CardProps) {
  const job = currentJob(errand)!;
  const proof = errand.purchaseProofs[job.id];
  const shop = findShop(point.shop.id)!;
  return (
    <div className="q-card">
      {proof && <AiCheckCard view={purchaseCheckView(proof, job, shop, errand.claim.checkedInAt)} kind="purchase" />}
      <CaptureNote errand={errand} job={job} />
      {job.mode === 'ship' ? <ShipForm job={job} /> : <HandoverForm job={job} point={point} />}
    </div>
  );
}

// ---- 6. Paid, or how it ended -----------------------------------------------------

export function PayoutCard({ errand, point }: CardProps) {
  const job = currentJob(errand)!;
  const sum = payoutSummary(errand.payouts[job.id] ?? []);
  const kept = keptFeeCents(job);
  const spent = timeSpentMs(errand.claim, job);
  const rate = realizedPerHour(kept, spent);
  const banner = useModeBanner();
  return (
    <div className="q-card">
      <section className="q-pay" aria-live="polite">
        <span className="q-pay__brand">PayPal Payouts · US dollars · {banner}</span>
        <h4 className="q-pay__big" data-paid={sum.paidCents}>
          Paid {formatUsd(sum.paidCents, { exact: true })}
        </h4>
        <p className="q-pay__by">by PayPal Payouts to {job.queuerName}</p>
        <ul className="q-pay__lines">
          {sum.lines.map((l) => (
            <li key={l.id}>
              <span>{l.label}</span>
              <b>{formatUsd(l.cents, { exact: true })}</b>
              {l.status !== 'succeeded' && <em>{l.status === 'pending' ? 'on its way' : l.status}</em>}
            </li>
          ))}
        </ul>
        <div className="q-pay__stats">
          <div>
            <strong>{formatUsd(kept, { exact: true })}</strong>
            <span>fee you keep</span>
          </div>
          <div>
            <strong>{spent !== null ? durationText(spent) : '–'}</strong>
            <span>take to buy</span>
          </div>
          <div>
            <strong>{perHourText(rate)}</strong>
            <span>realized</span>
          </div>
        </div>
        {job.shipment && (
          <p className="q-note">
            {job.shipment.carrierName} {job.shipment.trackingNumber}. {job.mode === 'ship' ? `Shipping ${formatUsd(job.amounts.shippingCents ?? 0, { exact: true })}, as declared.` : ''}
          </p>
        )}
        <p className="q-note">
          The shop price from the receipt{job.mode === 'ship' ? ' and the shipping you declared' : ''} for {job.requesterName}&rsquo;s {point.itemShort} {job.mode === 'ship' ? 'were' : 'was'} paid back with no markup; HoldMySpot kept 10% of the fee.{' '}
          {job.requesterName} paid processing and payouts at cost, so none of it came out of your pay.
        </p>
      </section>
      <button type="button" className="ghost-button" onClick={() => queuerActions.dismiss()}>
        Done
      </button>
    </div>
  );
}

export function OutcomeCard({ errand, point, stage }: CardProps & { stage: 'rejected' | 'sold_out' | 'lapsed' | 'cancelled' | 'ended' }) {
  const job = currentJob(errand);
  const proof = job ? errand.purchaseProofs[job.id] : undefined;
  const shop = findShop(point.shop.id)!;
  const title =
    stage === 'rejected' ? 'Receipt rejected: $0 moved' : stage === 'sold_out' ? 'Sold out: holds released' : stage === 'lapsed' ? 'The arrival window ended' : stage === 'cancelled' ? 'Visit cancelled' : 'Visit ended';
  return (
    <div className="q-card">
      <div className={`q-outcome is-${stage}`} data-outcome={stage}>
        <h4>{title}</h4>
        <p>{job ? failureText(job) : stage === 'cancelled' ? 'You cancelled before any request matched. Nothing was charged.' : 'Nothing was charged.'}</p>
        {stage === 'rejected' && job && (
          <p className="q-outcome__money">
            Captured {formatUsd(job.amounts.capturedCents, { exact: true })} · paid out {formatUsd(job.amounts.paidOutCents, { exact: true })}
          </p>
        )}
      </div>
      {stage === 'rejected' && proof && <AiCheckCard view={purchaseCheckView(proof, job!, shop, errand.claim.checkedInAt)} kind="purchase" />}
      <button type="button" className="ghost-button" onClick={() => queuerActions.dismiss()}>
        Back to the map
      </button>
    </div>
  );
}
