import { useMemo } from 'react';
import type { AgWidgetParams } from 'ag-studio';
import { W } from '../../data/vocab.ts';
import { toGapRows } from './GapBoard.tsx';
import { money, num, str, useRows } from './useRows.ts';

const SLOTS = ['shop', 'bestBid', 'bestAsk', 'bidDepth', 'askDepth', 'askBy', 'askNote', 'nextStep', 'nextAsk'];

/**
 * Custom AG Studio widget that the market desk agent builds to answer
 * "which shop has the widest gap right now?": the answer in large type, the
 * reason in one sentence, and the runners-up.
 */
export function GapSpotlight(params: AgWidgetParams) {
  const { rows, slots } = useRows(params, SLOTS, ['shop', 'bestBid', 'bestAsk']);
  const keys = useMemo(() => Object.fromEntries(SLOTS.map((s) => [s, slots[s]?.key])), [slots]);
  const ranked = useMemo(() => (rows ? toGapRows(rows, keys) : []), [rows, keys]);
  const top = ranked[0];
  if (!top || top.gap === null) return <div className="hms-w hms-empty">No shop has both a {W.bid} and an {W.ask} right now.</div>;
  const raw = rows?.find((r) => keys.shop && str(r[keys.shop]) === top.shop) ?? {};
  const by = keys.askBy ? str(raw[keys.askBy]) : '';
  const note = keys.askNote ? str(raw[keys.askNote]) : '';
  const nextStep = keys.nextStep ? str(raw[keys.nextStep]) : '';
  const nextAsk = keys.nextAsk ? num(raw[keys.nextAsk]) : null;
  const others = ranked.slice(1, 4).filter((r) => r.gap !== null);
  const title = params.format?.title?.text;

  return (
    <div className="hms-w hms-spot" style={{ ['--accent' as string]: top.accent }}>
      <div className="hms-spot-main">
        {!title && <span className="hms-spot-label">The {W.widestSpread} right now</span>}
        <strong className="hms-spot-shop">{top.shop}</strong>
        <div className="hms-spot-figures">
          <span className="hms-spot-gap">{money(top.gap)}</span>
          <span className="hms-spot-pair">
            <span className="is-bid">{W.bestBid} {money(top.bid)}</span>
            <span className="is-ask">{W.bestAsk} {money(top.ask)}</span>
          </span>
        </div>
        <p>
          {by ? `${by}'s ${W.ask}` : `The ${W.bestAsk.toLowerCase()}`} is {money(top.ask)}
          {note ? ` (${note.charAt(0).toLowerCase()}${note.slice(1)})` : ''}. {top.bidQty} units wait, the top at {money(top.bid)}.
          {nextStep && nextAsk !== null ? ` Next step ${nextStep}: ${money(nextAsk)}.` : ''}
        </p>
      </div>
      {others.length > 0 && (
        <ol className="hms-spot-others">
          {others.map((r) => (
            <li key={r.shop} style={{ ['--accent' as string]: r.accent }}>
              <i />
              <span>{r.shop}</span>
              <b>{money(r.gap)}</b>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
