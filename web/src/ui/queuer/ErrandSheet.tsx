import { formatUsd } from '@holdmyspot/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TaskPoint } from '../../domain/types';
import type { MapScene } from '../../map/mapScene';
import { useMarket } from '../../state/market';
import { BottomSheet } from '../BottomSheet';
import { useNow } from '../hooks';
import { ItemIcon } from '../ItemIcon';
import { ArrivalCard, CheckingCard, FinishCard, InLineCard, OutcomeCard, PayoutCard, ProofCard, VerifyingCard, WaitingCard } from './ErrandCards';
import { ERRAND_STEPS, buildErrand, countText, currentJob, errandStage, isFinished, payoutSummary, stepIndex, timeIn, type Errand, type ErrandStage } from './logic';
import { queuerActions, useQueuer } from './store';

/**
 * The queuer's errand on their phone: a sheet with the step they are on
 * (arrive, check in, in line, proof, finish, paid) and, when it is closed, a
 * pill at the bottom of the map with the countdown or the queue timer.
 */

function useErrand(): Errand | null {
  const focusId = useQueuer((s) => s.focusId);
  const claims = useQueuer((s) => s.claims);
  const asks = useQueuer((s) => s.asks);
  const jobs = useQueuer((s) => s.jobs);
  const proofs = useQueuer((s) => s.proofs);
  const payouts = useQueuer((s) => s.payouts);
  return useMemo(() => (focusId ? buildErrand({ claims, asks, jobs, proofs, payouts }, focusId) : null), [focusId, claims, asks, jobs, proofs, payouts]);
}

function Steps({ stage }: { stage: ErrandStage }) {
  const at = stepIndex(stage);
  const bad = stage === 'rejected' || stage === 'sold_out' || stage === 'lapsed' || stage === 'cancelled';
  return (
    <ol className="q-steps" aria-label="Errand steps">
      {ERRAND_STEPS.map((label, i) => (
        <li key={label} className={i < at || (stage === 'paid' && i === at) ? 'is-done' : i === at ? (bad ? 'is-bad' : 'is-now') : undefined} aria-current={i === at ? 'step' : undefined}>
          <span className="q-steps__dot" />
          <span className="q-steps__label">{label}</span>
        </li>
      ))}
    </ol>
  );
}

const HEADLINES: Record<ErrandStage, string> = {
  arrival: 'Head to the shop',
  checking: 'Checking your line photo',
  waiting: 'In line, waiting for a request',
  in_line: 'In line',
  proof: 'Upload the proof',
  verifying: 'Checking the receipt',
  finish: 'Finish the job',
  paid: 'Paid',
  rejected: 'Receipt rejected',
  sold_out: 'Sold out',
  lapsed: 'Window ended',
  cancelled: 'Cancelled',
  ended: 'Visit over',
};

function Body({ errand, point, stage, scene }: { errand: Errand; point: TaskPoint; stage: ErrandStage; scene: MapScene | null }) {
  switch (stage) {
    case 'arrival':
      return <ArrivalCard errand={errand} point={point} scene={scene} />;
    case 'checking':
      return <CheckingCard errand={errand} point={point} />;
    case 'waiting':
      return <WaitingCard errand={errand} point={point} />;
    case 'in_line':
      return <InLineCard errand={errand} point={point} />;
    case 'proof':
      return <ProofCard errand={errand} point={point} />;
    case 'verifying':
      return <VerifyingCard errand={errand} point={point} />;
    case 'finish':
      return <FinishCard errand={errand} point={point} />;
    case 'paid':
      return <PayoutCard errand={errand} point={point} />;
    default:
      return <OutcomeCard errand={errand} point={point} stage={stage} />;
  }
}

/** One short line for the pill: what to do now, and the clock that matters. */
function pillText(errand: Errand, stage: ErrandStage, now: number, tz: string): { text: string; clock: string | null } {
  const job = currentJob(errand);
  switch (stage) {
    case 'arrival':
      return { text: `Check in by ${timeIn(errand.claim.windowEndsAt, tz)}`, clock: countText(errand.claim.windowEndsAt - now) };
    case 'checking':
      return { text: 'Checking your line photo', clock: null };
    case 'waiting':
    case 'in_line':
      return { text: job ? `In line for ${job.requesterName}` : 'In line, waiting for a request', clock: countText(now - (errand.claim.checkedInAt ?? now)) };
    case 'proof':
      return { text: 'Upload the receipt', clock: null };
    case 'verifying':
      return { text: 'Checking the receipt', clock: null };
    case 'finish':
      return { text: job?.mode === 'ship' ? 'Receipt passed: add tracking' : 'Receipt passed: hand it over', clock: null };
    case 'paid':
      return { text: `Paid ${formatUsd(job ? payoutSummary(errand.payouts[job.id] ?? []).paidCents : 0, { exact: true })} by PayPal`, clock: null };
    case 'rejected':
      return { text: 'Receipt rejected: $0 moved', clock: null };
    default:
      return { text: HEADLINES[stage], clock: null };
  }
}

function Pill({ errand, point, stage, onOpen }: { errand: Errand; point: TaskPoint; stage: ErrandStage; onOpen: () => void }) {
  const now = useNow(500);
  const { text, clock } = pillText(errand, stage, now, point.shop.timezone);
  return (
    <button type="button" className={`q-pill is-${stage}`} onClick={onOpen} style={{ ['--hue' as string]: point.hue }} aria-label={`Your errand at ${point.shop.name}: ${text}`}>
      <span className="q-pill__icon">
        <ItemIcon look={point.look} size={30} />
      </span>
      <span className="q-pill__text">
        <b>{point.shop.name}</b>
        <span>{text}</span>
      </span>
      {clock && <span className="q-pill__clock">{clock}</span>}
    </button>
  );
}

export function ErrandSheet({ scene }: { scene: MapScene | null }) {
  const errand = useErrand();
  const sheetOpen = useQueuer((s) => s.sheetOpen);
  const error = useQueuer((s) => s.error);
  const busy = useQueuer((s) => s.busy);
  const selectedId = useMarket((s) => s.selectedId);
  const points = useMarket((s) => s.points);
  const point = errand?.ask ? (points.find((p) => p.id === errand.ask!.itemId) ?? null) : null;
  const stage = errand ? errandStage(errand) : null;
  const open = !!errand && !!point && sheetOpen && !selectedId;
  const [px, setPx] = useState(0);
  const onHeight = useCallback((h: number) => setPx(h), []);
  const close = useCallback(() => queuerActions.close(), []);

  // Frame the shop (and the walk to it) in the strip of map above the sheet.
  const framed = useRef(false);
  const pointId = point?.id ?? null;
  useEffect(() => {
    if (!scene || !pointId) return;
    if (open) {
      const t = window.setTimeout(() => {
        scene.select(pointId, px);
        framed.current = true;
      }, 0);
      return () => window.clearTimeout(t);
    }
    if (framed.current && !useMarket.getState().selectedId) scene.select(null);
    framed.current = false;
  }, [scene, open, px, pointId]);
  // Leaving the queuer's phone hands the camera back to the map.
  useEffect(
    () => () => {
      if (framed.current && !useMarket.getState().selectedId) scene?.select(null);
    },
    [scene],
  );

  if (!errand || !point || !stage) return null;
  return (
    <>
      {!sheetOpen && !selectedId && <Pill errand={errand} point={point} stage={stage} onOpen={() => queuerActions.open(errand.claim.id)} />}
      <BottomSheet open={open} onClose={close} onHeight={onHeight} label="Your errand">
        <article className="q-errand" style={{ ['--hue' as string]: point.hue }} data-stage={stage}>
          <header className="q-errand__head">
            <div className="task__icon">
              <ItemIcon look={point.look} size={44} />
            </div>
            <div className="q-errand__title">
              <span className="q-errand__kicker">Your errand · {point.shop.name}</span>
              <h2>{HEADLINES[stage]}</h2>
              <p>{point.itemName}</p>
            </div>
            <button type="button" className="close-button" onClick={close} aria-label="Back to the map">
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M2 5l5 5 5-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            </button>
          </header>
          <Steps stage={stage} />
          {error && !busy && <p className="q-error">{error}</p>}
          <Body errand={errand} point={point} stage={stage} scene={scene} />
          {!isFinished(stage) && <p className="q-fine">Simulated PayPal and US dollars throughout. Your codes are shown only on this phone.</p>}
        </article>
      </BottomSheet>
    </>
  );
}
