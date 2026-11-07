import { useEffect, useRef } from 'react';
import { bestOffer, offerFeeAt } from '../domain/book';
import { rateText, reachOf } from '../domain/earning';
import { formatUsd } from '../domain/money';
import type { LabelSink, MapScene, ScreenRect } from '../map/mapScene';
import { useMarket } from '../state/market';
import { usePosition } from '../state/position';
import { useNow } from './hooks';

/** Height of the little tip under a ticket, in CSS pixels. */
const TIP = 9;
/** Labels pushed further than this to dodge a nearer one are hidden instead. */
const MAX_PUSH = 72;
/** A walker's tag may rise only a little (on a short stem) before it hides. */
const MAX_WALKER_PUSH = 34;

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Floating labels over task points, and the ask tag a walking queuer carries.
 * React renders the text; the map scene moves the elements every frame with
 * direct style writes (no re-render).
 *
 * Rules, so a label always reads as belonging to its thing:
 * - the tip points at the item even when the ticket is held inside the screen edge;
 * - a ticket pushed up to clear a nearer one keeps a thin stem down to its item;
 * - a label hides when its item leaves the screen or would sit under the top bar
 *   (with some slack, so a bobbing item cannot make it blink);
 * - while a sheet is open no labels show: the strip of map is short and the sheet
 *   already shows the same numbers.
 */
export function TaskLabels({ scene, onSelect, sheetPx }: { scene: MapScene | null; onSelect: (id: string) => void; sheetPx: number }) {
  const points = useMarket((s) => s.points);
  const bumps = useMarket((s) => s.bumps);
  const selectedId = useMarket((s) => s.selectedId);
  const now = useNow(500);
  const me = usePosition((s) => s.lngLat);
  const els = useRef(new Map<string, HTMLElement>());
  const box = useRef<HTMLDivElement>(null);
  const live = useRef({ selectedId, sheetPx });
  live.current = { selectedId, sheetPx };
  // The walker is the queuer who first posted the ask; after a handover the tag stays theirs.
  const walkerNames = useRef(new Map<string, string>());

  useEffect(() => {
    const container = box.current;
    if (!scene || !container) return;
    type Pending = { id: string; el: HTMLElement; ax: number; ay: number; scale: number; w: number; h: number; walker: boolean };
    const frame: Pending[] = [];
    let avoid: ScreenRect[] = [];
    const shown = new Map<string, boolean>();
    const written = new Map<string, string>();
    let width = 0;
    let height = 0;
    let safeTop = 0;

    const measure = () => {
      const r = container.getBoundingClientRect();
      width = r.width;
      height = r.height;
      const bar = container.parentElement?.querySelector('.topbar');
      safeTop = bar ? bar.getBoundingClientRect().bottom - r.top + 8 : 0;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);

    const setShown = (id: string, el: HTMLElement, on: boolean) => {
      if (shown.get(id) === on) return;
      shown.set(id, on);
      el.classList.toggle('is-shown', on);
    };

    const sink: LabelSink = {
      begin(rects) {
        avoid = rects;
      },
      place(id, a) {
        const el = els.current.get(id);
        if (!el) return;
        const { selectedId: sel, sheetPx: sheet } = live.current;
        const walker = id.startsWith('walker:');
        // With a sheet open the map is a short strip and the sheet shows the same numbers.
        const hiddenBySheet = !!sel;
        if (!a.visible || hiddenBySheet || a.y > height - sheet - 4 || a.scale < 0.05) {
          setShown(id, el, false);
          return;
        }
        // Reads only (no writes) until commit, so the browser lays out once per frame.
        const body = el.firstElementChild as HTMLElement | null;
        const w = (body?.offsetWidth ?? el.offsetWidth) * a.scale;
        const h = ((body?.offsetHeight ?? el.offsetHeight) + TIP) * a.scale;
        frame.push({ id, el, ax: a.x, ay: a.y, scale: a.scale, w, h, walker });
      },
      commit() {
        // Nearest labels (lowest on screen) keep their spot; walker tags give way to task labels.
        frame.sort((p, q) => Number(p.walker) - Number(q.walker) || q.ay - p.ay);
        // The player counts as already placed: labels step up instead of covering them.
        const placed: Array<{ x: number; w: number; top: number; bottom: number }> = avoid.map((r) => ({
          x: r.x + r.w / 2,
          w: r.w,
          top: r.y,
          bottom: r.y + r.h,
        }));
        for (const l of frame) {
          const x = clamp(l.ax, l.w / 2 + 6, width - l.w / 2 - 6);
          let bottom = l.ay;
          for (let pass = 0; pass < 6; pass++) {
            let moved = false;
            for (const r of placed) {
              const overlapX = Math.abs(x - r.x) < (l.w + r.w) / 2 + 4;
              const overlapY = bottom > r.top - 4 && bottom - l.h < r.bottom + 4;
              if (overlapX && overlapY) {
                bottom = r.top - 4;
                moved = true;
              }
            }
            if (!moved) break;
          }
          const push = l.ay - bottom;
          const top = bottom - l.h;
          const was = shown.get(l.id) ?? false;
          // Slack both ways, so an anchor sitting right at the edge cannot blink.
          const fits = was ? top > safeTop - 2 : top > safeTop + 6;
          // A walker's tag may only rise a little, and never when its stem would pass behind
          // another label (the walker is hidden there, so the tag would read as someone else's).
          const blocked =
            l.walker &&
            push > 0 &&
            placed.some((r) => Math.abs(l.ax - r.x) < r.w / 2 + 2 && l.ay > r.top - 2 && bottom < r.bottom + 2);
          if (!fits || blocked || push > (l.walker ? MAX_WALKER_PUSH : MAX_PUSH)) {
            setShown(l.id, l.el, false);
            continue;
          }
          placed.push({ x, w: l.w, top, bottom });
          setShown(l.id, l.el, true);
          const half = l.w / l.scale / 2;
          const tipX = clamp((l.ax - x) / l.scale, -(half - 16), half - 16);
          const style = `${tipX.toFixed(1)}|${(push / l.scale).toFixed(1)}`;
          if (written.get(l.id) !== style) {
            written.set(l.id, style);
            l.el.style.setProperty('--tip-x', `${tipX.toFixed(1)}px`);
            l.el.style.setProperty('--stem', `${(push / l.scale).toFixed(1)}px`);
          }
          l.el.style.transform = `translate3d(${x.toFixed(1)}px, ${l.ay.toFixed(1)}px, 0) translate(-50%, -100%) scale(${l.scale.toFixed(3)})`;
        }
        frame.length = 0;
      },
    };
    scene.setLabelSink(sink);
    return () => {
      ro.disconnect();
      scene.setLabelSink(null);
    };
  }, [scene]);

  const ref = (id: string) => (el: HTMLElement | null) => {
    if (el) els.current.set(id, el);
    else els.current.delete(id);
  };

  return (
    <div ref={box} className="labels" aria-label="Tasks nearby">
      {points.map((p) => {
        const r = reachOf(p, me, now);
        const selected = p.id === selectedId;
        const top = p.bestFeeCents;
        return (
          <button
            key={p.id}
            ref={ref(p.id)}
            type="button"
            className={`tlabel${selected ? ' is-selected' : ''}${r.claimable ? '' : ' is-blocked'}`}
            style={{ ['--hue' as string]: p.hue }}
            onClick={() => onSelect(p.id)}
            aria-label={`${p.itemShort}: ${p.bidCount} requests, top fee ${top !== null ? formatUsd(top) : 'none'}, ${rateText(r.centsPerHour)}`}
          >
            <span className="tlabel__ticket">
              <span className="tlabel__name">{p.itemShort}</span>
              <span className="tlabel__stats">
                <b key={bumps[p.id] ?? 0} className="tlabel__count">
                  {p.bidCount} {p.bidCount === 1 ? 'request' : 'requests'}
                </b>
                {' · '}top {top !== null ? formatUsd(top) : '–'}
                {r.centsPerHour !== null && (
                  <>
                    {' · '}
                    {rateText(r.centsPerHour)}
                  </>
                )}
              </span>
            </span>
            <span className="tlabel__tip" aria-hidden="true" />
            <span className="tlabel__stem" aria-hidden="true" />
          </button>
        );
      })}
      {points
        .filter((p) => scene !== null && p.id === scene.walkerTagPointId)
        .map((p) => {
          const walking = p.offers.find((o) => !o.checkedIn);
          if (!walkerNames.current.has(p.id) && walking) walkerNames.current.set(p.id, walking.queuerName);
          const name = walkerNames.current.get(p.id)!;
          const mine = p.offers.find((o) => o.queuerName === name);
          const asking = !!mine && mine.supply > 0;
          const offer = mine ?? bestOffer(p, now);
          return (
            <div key={`walker:${p.id}`} ref={ref(`walker:${p.id}`)} className="wtag" aria-hidden="true">
              <span className="wtag__bubble">
                <span className={`wtag__dot${asking ? '' : ' is-off'}`} />
                {asking && offer ? `${name} asks ${formatUsd(offerFeeAt(offer, now))} to queue` : `${name} is booked up`}
              </span>
              <span className="tlabel__tip wtag__tip" />
              <span className="tlabel__stem wtag__stem" />
            </div>
          );
        })}
    </div>
  );
}
