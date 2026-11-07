import { DEFAULT_RULES, offsetLngLat } from '@holdmyspot/shared';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { REASON_TEXT, distanceText, rateText, reachOf, reachRadiusMeters, travelText, type Reach } from '../domain/earning';
import { formatUsd } from '../domain/money';
import type { ItemKind, TaskPoint } from '../domain/types';
import { useLook } from '../state/look';
import { usePosition } from '../state/position';
import { useNow } from './hooks';
import { ItemIcon, PlayerFace } from './ItemIcon';

/**
 * The top-down overview: every task point of the city as a dot weighted by
 * demand (size by requests, glow by the top fee), clustered when far out,
 * with filters (item type, fee, travel time) and a list sorted by what a
 * queuer would earn per hour. Tasks the viewer cannot take are greyed.
 */

type KindFilter = 'all' | ItemKind;
type SortKey = 'rate' | 'distance' | 'fee';

export interface OverviewFilters {
  kind: KindFilter;
  minFeeCents: number;
  maxMinutes: number | null;
}

export const NO_FILTERS: OverviewFilters = { kind: 'all', minFeeCents: 0, maxMinutes: null };

interface Row {
  p: TaskPoint;
  r: Reach;
}

interface Placed {
  key: string;
  /** Where the dot is drawn. */
  x: number;
  y: number;
  /** Where the task really is, when the dot had to step aside (it sat under the player or a control). */
  anchor: { x: number; y: number } | null;
  rows: Row[];
  /** Where the chip sits relative to the dot, or null when there is no room for it. */
  chip: 'above' | 'below' | 'right' | 'left' | null;
  /** A one-line chip (fee and rate) where the full one does not fit; zooming in makes room. */
  compact: boolean;
}

type Box = { x0: number; x1: number; y0: number; y1: number };

const KIND_LABEL: Record<KindFilter, string> = { all: 'Everything', cake: 'Cakes', plush: 'Plush', ramen: 'Ramen' };
const SHORT_REASON: Record<NonNullable<Reach['reason']>, string> = { too_far: 'too far', ends_before: 'ends too soon', closes_before: 'closes too soon', no_requests: 'no requests', sold_out: 'sold out' };
const hits = (a: Box, b: Box, pad = 3) => a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;
/** Directions a dot steps aside in, after the one straight away from what covers it. */
const COMPASS: [number, number][] = [
  [0.7071, -0.7071],
  [1, 0],
  [0, -1],
  [-0.7071, -0.7071],
  [-1, 0],
  [0.7071, 0.7071],
  [0, 1],
  [-0.7071, 0.7071],
];

function passes(row: Row, f: OverviewFilters): boolean {
  if (f.kind !== 'all' && row.p.kind !== f.kind) return false;
  if (f.minFeeCents > 0 && (row.r.feeCents ?? 0) < f.minFeeCents) return false;
  if (f.maxMinutes !== null && row.r.travelMin > f.maxMinutes) return false;
  return true;
}

/** Best first: claimable before greyed, then by the chosen key. */
export function sortRows(rows: Row[], key: SortKey): Row[] {
  return [...rows].sort((a, b) => {
    if (a.r.claimable !== b.r.claimable) return a.r.claimable ? -1 : 1;
    if (key === 'distance') return a.r.distanceM - b.r.distanceM;
    if (key === 'fee') return (b.r.feeCents ?? -1) - (a.r.feeCents ?? -1) || a.r.distanceM - b.r.distanceM;
    return (b.r.centsPerHour ?? -1) - (a.r.centsPerHour ?? -1) || a.r.distanceM - b.r.distanceM;
  });
}

/** The one-line chip: fee and rate (or why it cannot be taken), or the size of a cluster. */
function compactText(c: Pick<Placed, 'rows'>): string {
  if (c.rows.length > 1) return `${c.rows.length} tasks`;
  const { r } = c.rows[0]!;
  return `${r.feeCents !== null ? formatUsd(r.feeCents) : '–'} · ${r.claimable ? rateText(r.centsPerHour) : r.reason ? SHORT_REASON[r.reason] : ''}`;
}

/** Everything a chip shows, for screen readers (the chip itself is hidden from them). */
function dotLabel({ p, r }: Row): string {
  const fee = r.feeCents !== null ? `${formatUsd(r.feeCents)} top fee` : 'no fee yet';
  const facts = `${fee}, ${p.bidCount} ${p.bidCount === 1 ? 'request' : 'requests'}, ${distanceText(r.walkM)}, ${travelText(r)}, about ${r.queueMin} min in line`;
  return `${p.itemShort}, ${p.shop.name}: ${facts}, ${r.claimable ? `${rateText(r.centsPerHour)} estimated after the 10% fee` : r.reason ? REASON_TEXT[r.reason] : 'not available'}`;
}

/** Dot radius in pixels from the number of requests. */
function dotSize(row: Row): number {
  return Math.round(12 + Math.min(14, Math.sqrt(row.p.bidCount) * 3.4));
}

/** Glow strength 0..1 from the top fee. */
function glowOf(row: Row): number {
  return Math.min(1, (row.r.feeCents ?? 0) / 1500);
}

const sizeOf = (c: Pick<Placed, 'rows'>) => (c.rows.length > 1 ? 40 : dotSize(c.rows[0]!));

export function Overview({
  map,
  active,
  points,
  listOpen,
  onListOpen,
  onPick,
}: {
  map: MapLibreMap | null;
  active: boolean;
  points: TaskPoint[];
  listOpen: boolean;
  onListOpen: (open: boolean) => void;
  onPick: (id: string) => void;
}) {
  const now = useNow(1000);
  const me = usePosition((s) => s.lngLat);
  const palette = useLook((s) => s.palette);
  const [filters, setFilters] = useState<OverviewFilters>(NO_FILTERS);
  const [sort, setSort] = useState<SortKey>('rate');
  const [frame, setFrame] = useState(0);
  const filterBar = useRef<HTMLDivElement>(null);

  // A filter row too wide for the screen scrolls; it fades out on the right so that shows.
  useEffect(() => {
    const bar = filterBar.current;
    if (!bar) return;
    const check = () => {
      for (const row of Array.from(bar.children) as HTMLElement[]) row.classList.toggle('is-overflowing', row.scrollWidth > row.clientWidth + 1);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  const rows = useMemo(() => points.map((p) => ({ p, r: reachOf(p, me, now, DEFAULT_RULES) })), [points, me, now]);
  const shown = useMemo(() => rows.filter((row) => passes(row, filters)), [rows, filters]);
  const sorted = useMemo(() => sortRows(shown, sort), [shown, sort]);

  // Follow the camera: re-place the dots on every frame the map moves.
  useEffect(() => {
    if (!map || !active) return;
    let raf = 0;
    const onMove = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setFrame((n) => n + 1));
    };
    map.on('move', onMove);
    map.on('resize', onMove);
    onMove();
    return () => {
      cancelAnimationFrame(raf);
      map.off('move', onMove);
      map.off('resize', onMove);
    };
  }, [map, active]);

  // The list and the controls move after a render: measure them again once they have.
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => setFrame((n) => n + 1));
    const late = window.setTimeout(() => setFrame((n) => n + 1), 520);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(late);
    };
  }, [listOpen, active]);

  const placed = useMemo<{ dots: Placed[]; me: { x: number; y: number } | null; ring: number | null; label: { x: number; y: number } | null }>(() => {
    void frame;
    void listOpen;
    if (!map || !active) return { dots: [], me: null, ring: null, label: null };
    const box = map.getContainer();
    const w = box.clientWidth;
    const h = box.clientHeight;
    const meXY = map.project(me);
    const edge = map.project(offsetLngLat(me, reachRadiusMeters(DEFAULT_RULES.maxTravelMinutes), 0));
    const ring = Math.abs(edge.x - meXY.x);
    // Controls drawn over the map (the bottom buttons and the map credits): nothing should hide under them.
    const origin = box.getBoundingClientRect();
    const page = box.parentElement;
    const ui: Box[] = [];
    for (const sel of ['.attribution', '.ov-listbtn', '.map-controls:not(.is-hidden)']) {
      const el = page?.querySelector(sel);
      const rect = el?.getBoundingClientRect();
      if (rect && rect.width > 0) ui.push({ x0: rect.left - origin.left, x1: rect.right - origin.left, y0: rect.top - origin.top, y1: rect.bottom - origin.top });
    }
    const player: Box = { x0: meXY.x - 18, x1: meXY.x + 18, y0: meXY.y - 18, y1: meXY.y + 18 };
    const covers = [player, ...ui];
    // Greedy clustering in screen space, best earners first so they lead their cluster.
    const order = sortRows(shown, 'rate');
    const clusters: Placed[] = [];
    for (const row of order) {
      const xy = map.project(row.p.lngLat);
      if (xy.x < -60 || xy.x > w + 60 || xy.y < -60 || xy.y > h + 60) continue;
      const near = clusters.find((c) => Math.hypot(c.x - xy.x, c.y - xy.y) < 34);
      if (near) near.rows.push(row);
      else clusters.push({ key: row.p.id, x: xy.x, y: xy.y, anchor: null, rows: [row], chip: null, compact: false });
    }
    const dotBox = (c: Pick<Placed, 'x' | 'y' | 'rows'>): Box => {
      const r = sizeOf(c) / 2 + 2;
      return { x0: c.x - r, x1: c.x + r, y0: c.y - r, y1: c.y + r };
    };
    // A dot under the player or a control steps aside to the nearest free spot, keeping a thin line to where it is.
    for (const c of clusters) {
      const blocker = covers.find((o) => hits(dotBox(c), o, 2));
      if (!blocker) continue;
      const cx = (blocker.x0 + blocker.x1) / 2;
      const cy = (blocker.y0 + blocker.y1) / 2;
      const len = Math.hypot(c.x - cx, c.y - cy);
      const away: [number, number] | null = len > 4 ? [(c.x - cx) / len, (c.y - cy) / len] : null;
      const dirs = away ? [away, ...COMPASS] : COMPASS;
      const free = (x: number, y: number) => {
        const b = dotBox({ x, y, rows: c.rows });
        return b.x0 > 2 && b.x1 < w - 2 && !covers.some((o) => hits(b, o, 2)) && !clusters.some((o) => o !== c && hits(b, dotBox(o), 1));
      };
      search: for (let d = 6; d <= 160; d += 6) {
        for (const [dx, dy] of dirs) {
          const x = c.x + dx * d;
          const y = c.y + dy * d;
          if (free(x, y)) {
            c.anchor = { x: c.x, y: c.y };
            c.x = x;
            c.y = y;
            break search;
          }
        }
      }
    }
    // Chips only where they cover no other chip, dot, the player or a control: the best earners place theirs
    // first, above the dot when there is room, else below, right or left.
    const chips: Box[] = [];
    const sides = (c: Placed, cw: number, ch: number): [NonNullable<Placed['chip']>, Box][] => {
      const r = sizeOf(c) / 2;
      return [
        ['above', { x0: c.x - cw / 2, x1: c.x + cw / 2, y0: c.y - r - 6 - ch, y1: c.y - r - 6 }],
        ['below', { x0: c.x - cw / 2, x1: c.x + cw / 2, y0: c.y + r + 6, y1: c.y + r + 6 + ch }],
        ['right', { x0: c.x + r + 6, x1: c.x + r + 6 + cw, y0: c.y - ch / 2, y1: c.y + ch / 2 }],
        ['left', { x0: c.x - r - 6 - cw, x1: c.x - r - 6, y0: c.y - ch / 2, y1: c.y + ch / 2 }],
      ];
    };
    const tryPlace = (c: Placed, cw: number, ch: number): boolean => {
      const others = clusters.filter((o) => o !== c).map(dotBox);
      for (const [side, b] of sides(c, cw, ch)) {
        const inside = b.y0 > 150 && b.x0 > 2 && b.x1 < w - 2 && b.y1 < h - 96;
        if (inside && !chips.some((x) => hits(x, b)) && !others.some((x) => hits(x, b)) && !covers.some((x) => hits(x, b))) {
          chips.push(b);
          c.chip = side;
          return true;
        }
      }
      return false;
    };
    // Full chips first (best earners first), then one-line chips for the dots still without one.
    for (const c of clusters) tryPlace(c, c.rows.length > 1 ? 118 : 146, 40);
    for (const c of clusters) if (!c.chip) c.compact = tryPlace(c, Math.ceil(compactText(c).length * 6.4) + 16, 22);
    // The ring's label goes where it covers no dot and no chip: below the ring, else on its sides.
    const spots = [
      { x: meXY.x, y: meXY.y + ring + 16 },
      { x: meXY.x + ring * 0.71, y: meXY.y + ring * 0.71 + 14 },
      { x: meXY.x - ring * 0.71, y: meXY.y + ring * 0.71 + 14 },
      { x: meXY.x, y: meXY.y - ring - 8 },
    ];
    const label =
      spots.find((p) => {
        const b = { x0: p.x - 64, x1: p.x + 64, y0: p.y - 13, y1: p.y + 3 };
        const clear = !clusters.some((c) => hits(dotBox(c), b)) && !chips.some((x) => hits(x, b)) && !ui.some((x) => hits(x, b));
        return clear && b.x0 > 4 && b.x1 < w - 4 && b.y0 > 150 && b.y1 < h - 100;
      }) ?? null;
    return { dots: clusters, me: { x: meXY.x, y: meXY.y }, ring, label };
  }, [map, active, shown, me, frame, listOpen]);

  const zoomInto = (c: Placed) => {
    if (!map) return;
    const lngs = c.rows.map((r) => r.p.lngLat[0]);
    const lats = c.rows.map((r) => r.p.lngLat[1]);
    const cam = map.cameraForBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 120, maxZoom: 16 },
    );
    map.easeTo({ center: cam?.center, zoom: Math.min(16, Math.max(map.getZoom() + 1.5, cam?.zoom ?? 0)), duration: 700 });
  };

  // What the filters leave, as the list shows it.
  const claimable = shown.filter((r) => r.r.claimable).length;
  const filtered = filters.kind !== 'all' || filters.minFeeCents > 0 || filters.maxMinutes !== null;

  return (
    <div className={`ov${active ? ' is-active' : ''}`} aria-hidden={!active}>
      {active && placed.me && placed.ring !== null && (
        <svg className="ov__ring" width="100%" height="100%" aria-hidden="true">
          <circle cx={placed.me.x} cy={placed.me.y} r={placed.ring} />
          {placed.label && (
            <text x={placed.label.x} y={placed.label.y} textAnchor="middle">
              30 minutes from you
            </text>
          )}
          {placed.dots.map(
            (c) =>
              c.anchor && (
                <g key={c.key} className="ov__leader">
                  <line x1={c.anchor.x} y1={c.anchor.y} x2={c.x} y2={c.y} />
                  <circle cx={c.anchor.x} cy={c.anchor.y} r={3} />
                </g>
              ),
          )}
        </svg>
      )}
      {active && placed.me && (
        <div className="ov-me" style={{ transform: `translate3d(${placed.me.x.toFixed(1)}px, ${placed.me.y.toFixed(1)}px, 0)` }} aria-label="You are here">
          <PlayerFace hair={palette.hair} skin={palette.skin} top={palette.top} size={22} />
        </div>
      )}
      {active &&
        placed.dots.map((c) => {
          const lead = c.rows[0]!;
          const many = c.rows.length > 1;
          const ok = c.rows.some((r) => r.r.claimable);
          const size = sizeOf(c);
          const glow = glowOf(lead);
          const best = c.rows.reduce<number | null>((m, r) => (r.r.centsPerHour !== null && r.r.claimable && (m === null || r.r.centsPerHour > m) ? r.r.centsPerHour : m), null);
          return (
            <div key={c.key} className={`ov-dot${ok ? '' : ' is-blocked'}${many ? ' is-cluster' : ''}`} style={{ transform: `translate3d(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px, 0)`, ['--hue' as string]: lead.p.hue, ['--glow' as string]: String(glow), ['--r' as string]: `${size / 2}px` }}>
              {c.chip && (
                <button type="button" className={`ov-chip is-${c.chip}${c.compact ? ' is-compact' : ''}`} onClick={() => (many ? zoomInto(c) : onPick(lead.p.id))} tabIndex={-1} aria-hidden="true">
                  {c.compact ? (
                    <b>{compactText(c)}</b>
                  ) : many ? (
                    <>
                      <b>{c.rows.length} tasks</b>
                      <span>{best !== null ? `up to ${rateText(best)}` : 'none you can take'}</span>
                    </>
                  ) : (
                    <>
                      <b>
                        {lead.r.feeCents !== null ? formatUsd(lead.r.feeCents) : '–'} · {lead.p.bidCount} req · {lead.r.claimable ? rateText(lead.r.centsPerHour) : lead.r.reason ? SHORT_REASON[lead.r.reason] : ''}
                      </b>
                      <span>
                        {distanceText(lead.r.walkM)} · {lead.r.travelMin} min · {lead.r.queueMin} min line
                      </span>
                    </>
                  )}
                </button>
              )}
              <button
                type="button"
                className="ov-dot__disc"
                style={{ width: size, height: size }}
                onClick={() => (many ? zoomInto(c) : onPick(lead.p.id))}
                aria-label={many ? `${c.rows.length} tasks here, ${best !== null ? `up to ${rateText(best)}` : 'none you can take'}` : dotLabel(lead)}
                tabIndex={active ? 0 : -1}
              >
                <ItemIcon look={lead.p.look} size={Math.round(size * 0.82)} />
                {many && <span className="ov-dot__count">{c.rows.length}</span>}
              </button>
            </div>
          );
        })}

      <div className="ov-filters" role="toolbar" aria-label="Filter tasks" ref={filterBar}>
        <div className="ov-filters__row">
          {(['all', 'cake', 'plush', 'ramen'] as KindFilter[]).map((k) => (
            <button key={k} type="button" className={`ov-pill${filters.kind === k ? ' is-on' : ''}`} aria-pressed={filters.kind === k} onClick={() => setFilters((f) => ({ ...f, kind: k }))} tabIndex={active ? 0 : -1}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <div className="ov-filters__row">
          {[800, 1200].map((c) => (
            <button key={c} type="button" className={`ov-pill${filters.minFeeCents === c ? ' is-on' : ''}`} aria-pressed={filters.minFeeCents === c} onClick={() => setFilters((f) => ({ ...f, minFeeCents: f.minFeeCents === c ? 0 : c }))} tabIndex={active ? 0 : -1}>
              {formatUsd(c)}+ fee
            </button>
          ))}
          <span className="ov-filters__gap" aria-hidden="true" />
          {[10, 20, 30].map((m) => (
            <button key={m} type="button" className={`ov-pill${filters.maxMinutes === m ? ' is-on' : ''}`} aria-pressed={filters.maxMinutes === m} onClick={() => setFilters((f) => ({ ...f, maxMinutes: f.maxMinutes === m ? null : m }))} tabIndex={active ? 0 : -1}>
              ≤ {m} min
            </button>
          ))}
        </div>
      </div>

      <button type="button" className={`ov-listbtn${listOpen ? ' is-open' : ''}`} onClick={() => onListOpen(!listOpen)} tabIndex={active ? 0 : -1} aria-expanded={listOpen}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        {listOpen ? 'Map' : `List · ${claimable} you can take${filtered ? ' (filtered)' : ''}`}
      </button>

      <section className={`ov-list${listOpen && active ? ' is-open' : ''}`} aria-label="Tasks" aria-hidden={!(listOpen && active)}>
        <header className="ov-list__head">
          <h2>
            {shown.length} {shown.length === 1 ? 'task' : 'tasks'}
            <small>{claimable} you can take</small>
          </h2>
          <div className="ov-sort" role="radiogroup" aria-label="Sort by">
            {(
              [
                ['rate', '$/hour'],
                ['distance', 'Distance'],
                ['fee', 'Fee'],
              ] as [SortKey, string][]
            ).map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={sort === k} className={sort === k ? 'is-on' : undefined} onClick={() => setSort(k)}>
                {label}
              </button>
            ))}
          </div>
        </header>
        <p className="ov-list__note">$/hour: what you keep of the top fee after HoldMySpot’s 10%, over the trip and the line.</p>
        <ol className="ov-rows">
          {sorted.map(({ p, r }) => (
            <li key={p.id}>
              <button type="button" className={`ov-row${r.claimable ? '' : ' is-blocked'}`} style={{ ['--hue' as string]: p.hue }} onClick={() => onPick(p.id)}>
                <span className="ov-row__icon">
                  <ItemIcon look={p.look} size={36} />
                </span>
                <span className="ov-row__main">
                  <b>{p.itemShort}</b>
                  <span>{p.shop.name}</span>
                  <span className="ov-row__facts">
                    {r.feeCents !== null ? formatUsd(r.feeCents) : '–'} top fee · {p.bidCount} {p.bidCount === 1 ? 'request' : 'requests'}
                  </span>
                  <span className="ov-row__facts">
                    {distanceText(r.walkM)} · {travelText(r)} · ~{r.queueMin} min line
                  </span>
                  {!r.claimable && r.reason && <span className="ov-row__why">{REASON_TEXT[r.reason]}</span>}
                </span>
                <span className="ov-row__rate">
                  <b>{r.claimable ? rateText(r.centsPerHour) : '–'}</b>
                  <small>{r.claimable ? 'est.' : 'can’t take'}</small>
                </span>
              </button>
            </li>
          ))}
          {sorted.length === 0 && <li className="ov-rows__empty">No task matches these filters.</li>}
        </ol>
      </section>
    </div>
  );
}
