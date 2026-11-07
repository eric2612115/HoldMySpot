import '@bryntum/core-community/fontawesome/css/fontawesome.css';
import '@bryntum/core-community/fontawesome/css/solid.css';
import '@bryntum/scheduler-community/scheduler.css';
import '@bryntum/scheduler-community/svalbard-light.css';
import '../styles/board.css';
import { BryntumScheduler } from '@bryntum/scheduler-react-community';
import type { BryntumSchedulerProps } from '@bryntum/scheduler-react-community';
import { formatUsd } from '@holdmyspot/shared';
import type { MarketMs } from '@holdmyspot/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BoardBundle } from '../data/backend.ts';
import { MINUTE, clockText } from '../data/time.ts';
import { fromWall, toWall } from './boardModel.ts';
import type { BarRecord, QueuerRow } from './boardModel.ts';

interface Props {
  bars: BarRecord[];
  rows: QueuerRow[];
  bundle: BoardBundle;
  now: MarketMs;
  selectedId: string | null;
  onSelect(queuerId: string, shopId: string | null): void;
  validateMove(jobId: string, toQueuerId: string): string | null;
  onMove(jobId: string, toQueuerId: string): Promise<string | null>;
  /** A drop the rules refused: the validator's reason, for the same toast as a move. */
  onRefused?(reason: string): void;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Marker = { id: string; x: number; label: string; kind: 'now' | 'open'; side: 'right' | 'left' };

let measureCtx: CanvasRenderingContext2D | null = null;
/** Width of an opening label as drawn (.board-marker.is-open span), for laying the labels out. */
function labelWidth(text: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * 6.2 + 18;
  measureCtx.font = `700 10.5px ${getComputedStyle(document.body).fontFamily}`;
  return Math.ceil(measureCtx.measureText(text).width) + 18;
}

/**
 * Shop openings in the lane above the time axis: shops that open at the same
 * minute share one label, and a label that would run into the next one flips
 * to the left of its line.
 */
function layoutOpenings(items: { id: string; x: number; name: string }[], maxX: number): Marker[] {
  const groups: { id: string; x: number; names: string[] }[] = [];
  for (const it of [...items].sort((a, b) => a.x - b.x)) {
    const g = groups.find((x) => Math.abs(x.x - it.x) < 3);
    if (g) g.names.push(it.name);
    else groups.push({ id: it.id, x: it.x, names: [it.name] });
  }
  const placed: { x0: number; x1: number }[] = [];
  return groups.map((g) => {
    const label = g.names.length === 1 ? `${g.names[0]} opens` : `${g.names.slice(0, -1).join(', ')} and ${g.names[g.names.length - 1]} open`;
    const w = labelWidth(label);
    const right = { x0: g.x + 5, x1: g.x + 5 + w };
    const left = { x0: g.x - 5 - w, x1: g.x - 5 };
    const clear = (b: { x0: number; x1: number }) => !placed.some((p) => b.x0 < p.x1 + 8 && p.x0 < b.x1 + 8);
    // Look ahead: the next opening's line must stay readable too.
    const next = groups.find((o) => o.x > g.x + 3);
    const rightOk = clear(right) && (!next || right.x1 + 8 < next.x) && right.x1 <= maxX;
    const side = rightOk || !(clear(left) && left.x0 >= 0) ? 'right' : 'left';
    placed.push(side === 'right' ? right : left);
    return { id: g.id, x: g.x, label, kind: 'open' as const, side };
  });
}
const LANE_ORDER: Record<string, number> = { window: 0, line: 0, clock: 1, ship: 2, job: 3, ghost: 4 };

/** The staircase drawn on fee-clock bars: the fee walking down, one step per interval. */
function stairs(bar: BarRecord): string {
  const steps = bar.steps ?? [];
  if (steps.length === 0) return '';
  const n = steps.length;
  const pts: string[] = [];
  steps.forEach((s, i) => {
    const y = 13 + (i / Math.max(n - 1, 1)) * 9;
    const x = s.x * 100;
    const nextX = (steps[i + 1]?.x ?? 1) * 100;
    pts.push(`${x},${y}`, `${nextX},${y}`);
  });
  return `<svg class="hms-stairs" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts.join(' ')}" /></svg>`;
}

function barContent(bar: BarRecord) {
  const children: object[] = [];
  if (bar.tone === 'clock' && bar.steps) {
    children.push({ class: 'hms-stairs-wrap', html: stairs(bar) });
    children.push({
      class: 'hms-steps',
      children: bar.steps.map((s) => ({
        class: `hms-step is-${s.state}${s.x > 0.86 ? ' is-end' : ''}`,
        style: { left: `${s.x * 100}%` },
        text: s.label,
      })),
    });
    return children;
  }
  children.push({
    class: 'hms-bar-text',
    children: [
      { tag: 'strong', text: bar.title },
      bar.sub ? { tag: 'span', text: bar.sub } : null,
    ],
  });
  if (bar.chip) children.push({ class: `hms-chip tone-${bar.chip.tone}`, text: bar.chip.text });
  return children;
}

export function QueuerBoard({ bars, rows, bundle, now, selectedId, onSelect, validateMove, onMove, onRefused }: Props) {
  const ref = useRef<BryntumScheduler>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const barsById = useRef(new Map<string, BarRecord>());
  barsById.current = new Map(bars.map((b) => [b.id, b]));
  const rowsById = useRef(new Map<string, QueuerRow>());
  rowsById.current = new Map(rows.map((r) => [r.id, r]));
  const validateRef = useRef(validateMove);
  validateRef.current = validateMove;
  const moveRef = useRef(onMove);
  moveRef.current = onMove;
  const refusedRef = useRef(onRefused);
  refusedRef.current = onRefused;
  // The validator's last refusal, shown once the bar snaps back (the drag tooltip goes away with the drag).
  const refusal = useRef<string | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);

  const events = useMemo(
    () =>
      bars.map((b) => ({
        id: b.id,
        resourceId: b.resourceId,
        name: b.title,
        startDate: b.startDate,
        endDate: b.endDate,
        cls: b.cls,
        draggable: b.draggable,
        resizable: false,
      })),
    [bars],
  );
  const resources = useMemo(() => rows.map((r) => ({ id: r.id, name: r.name })), [rows]);

  const updateMarkers = useCallback(() => {
    const scheduler = ref.current?.instance;
    const shell = shellRef.current;
    if (!scheduler || !shell || scheduler.isDestroyed) return;
    const origin = shell.getBoundingClientRect().left;
    const area = scheduler.timeAxisSubGridElement?.getBoundingClientRect();
    const inView = (x: number) => !area || (x + origin >= area.left - 1 && x + origin <= area.right + 1);
    const items: Marker[] = [];
    const nowX = scheduler.getCoordinateFromDate(toWall(now), false);
    if (nowX > 0 && inView(nowX - origin)) items.push({ id: 'now', x: nowX - origin, label: clockText(now), kind: 'now', side: 'right' });
    const opens: { id: string; x: number; name: string }[] = [];
    for (const r of bundle.board.timeRanges) {
      const x = scheduler.getCoordinateFromDate(toWall(r.startDate), false);
      if (x > 0 && inView(x - origin)) opens.push({ id: r.id, x: x - origin, name: r.name.replace(/ opens?$/, '') });
    }
    setMarkers([...items, ...layoutOpenings(opens, area ? area.right - origin : shell.clientWidth)]);
  }, [now, bundle]);

  useLayoutEffect(() => {
    const id = requestAnimationFrame(updateMarkers);
    return () => cancelAnimationFrame(id);
  }, [updateMarkers, bars]);

  useEffect(() => {
    const onResize = () => updateMarkers();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [updateMarkers]);

  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const updateMarkersRef = useRef(updateMarkers);
  updateMarkersRef.current = updateMarkers;

  // Keep the market clock in view when it jumps.
  const scrollToNow = useCallback(
    (animate: boolean) => {
      const scheduler = ref.current?.instance;
      if (!scheduler || scheduler.isDestroyed) return;
      void scheduler.scrollToDate(toWall(now - 45 * MINUTE), { block: 'start', animate: animate ? 400 : false }).then(() => updateMarkersRef.current());
    },
    [now],
  );
  const scrollToNowRef = useRef(scrollToNow);
  scrollToNowRef.current = scrollToNow;
  const lastNow = useRef<MarketMs | null>(null);
  useEffect(() => {
    const first = lastNow.current === null;
    const jumped = !first && Math.abs(now - (lastNow.current ?? now)) > 20 * MINUTE;
    lastNow.current = now;
    if (first) requestAnimationFrame(() => scrollToNow(false));
    else if (jumped) scrollToNow(true);
  }, [now, scrollToNow]);

  useEffect(() => {
    const scheduler = ref.current?.instance;
    if (!scheduler || !selectedId) return;
    const record = scheduler.resourceStore.getById(selectedId);
    if (record && scheduler.selectedRecord !== record) scheduler.selectedRecord = record;
  }, [selectedId]);

  const config = useMemo<BryntumSchedulerProps>(
    () => ({
      startDate: toWall(bundle.board.from),
      endDate: toWall(bundle.board.to),
      visibleDate: { date: toWall(now - 45 * MINUTE), block: 'start' },
      viewPreset: {
        base: 'minuteAndHour',
        tickWidth: 88,
        displayDateFormat: 'HH:mm',
        timeResolution: { unit: 'minute', increment: 1 },
        headers: [
          { unit: 'hour', dateFormat: 'HH:mm' },
          { unit: 'minute', increment: 15, dateFormat: 'mm' },
        ],
      } as unknown as BryntumSchedulerProps['viewPreset'],
      rowHeight: 36,
      barMargin: 3,
      resourceMargin: 4,
      eventLayout: 'stack',
      eventStyle: 'filled',
      eventColor: null as unknown as BryntumSchedulerProps['eventColor'],
      zoomOnMouseWheel: false,
      zoomOnTimeAxisDoubleClick: false,
      overlappingEventSorter: (a, b) => {
        const ba = barsById.current.get(String(a.id));
        const bb = barsById.current.get(String(b.id));
        const la = LANE_ORDER[ba?.tone ?? 'job'] ?? 3;
        const lb = LANE_ORDER[bb?.tone ?? 'job'] ?? 3;
        return la - lb || (a.startDate as Date).getTime() - (b.startDate as Date).getTime();
      },
      columns: [
        {
          text: 'Queuer',
          field: 'name',
          width: 224,
          htmlEncode: false,
          renderer: ({ record }: { record: { id: string | number } }) => {
            const row = rowsById.current.get(String(record.id));
            if (!row) return '';
            return {
              class: `hms-who${row.alert ? ' has-alert' : ''}`,
              children: [
                { class: 'hms-avatar', style: { '--accent': row.accent }, text: row.initial },
                {
                  class: 'hms-who-text',
                  children: [
                    {
                      class: 'hms-who-name',
                      children: [
                        { tag: 'strong', text: row.name },
                        row.reliability !== null ? { tag: 'span', class: `hms-rel${row.reliability < 70 ? ' is-low' : ''}`, text: `${row.reliability}%`, dataset: { tip: 'Reliability' } } : null,
                        row.earnedCents > 0 ? { tag: 'span', class: 'hms-earned', text: `+${formatUsd(row.earnedCents, { exact: true })}` } : null,
                      ],
                    },
                    { class: 'hms-who-status', text: row.status },
                  ],
                },
              ],
            };
          },
        },
      ],
      eventRenderer: ({ eventRecord, renderData }) => {
        const bar = barsById.current.get(String(eventRecord.id));
        if (!bar) return eventRecord.name as string;
        if (renderData.width < 42 && bar.tone !== 'clock') return [] as never;
        renderData.style = { ...(typeof renderData.style === 'object' ? renderData.style : {}), '--progress': `${Math.round(bar.progress * 100)}%` } as Record<string, string>;
        return barContent(bar) as never;
      },
      columnLinesFeature: true,
      eventResizeFeature: false,
      eventEditFeature: false,
      eventDragCreateFeature: false,
      scheduleMenuFeature: false,
      timeAxisHeaderMenuFeature: false,
      cellMenuFeature: false,
      headerMenuFeature: false,
      eventMenuFeature: false,
      dependenciesFeature: false,
      scheduleTooltipFeature: false,
      eventTooltipFeature: {
        hoverDelay: 250,
        template: ({ eventRecord }: { eventRecord: { id: string | number } }) => {
          const bar = barsById.current.get(String(eventRecord.id));
          if (!bar) return '';
          const range = bar.startDate.getTime() === bar.endDate.getTime() ? clockText(fromWall(bar.startDate)) : `${clockText(fromWall(bar.startDate))} to ${clockText(fromWall(bar.endDate))}`;
          const steps = bar.steps?.map((s) => `<span class="${s.state === 'now' ? 'is-now' : ''}">${esc(s.label)} at ${clockText(s.at)}</span>`).join('') ?? '';
          return `<div class="hms-tip"><strong>${esc(bar.title)}</strong><span>${esc(range)}</span>${bar.sub ? `<span>${esc(bar.sub)}</span>` : ''}${steps ? `<div class="hms-tip-steps">${steps}</div>` : ''}${bar.draggable ? '<em>Drag to another queuer to move this job</em>' : ''}</div>`;
        },
      },
      eventDragFeature: {
        constrainDragToTimeSlot: true,
        showTooltip: true,
        validatorFn: ({ eventRecords, newResource }: { eventRecords: { id: string | number }[]; newResource: { id: string | number } }) => {
          const bar = barsById.current.get(String(eventRecords[0]?.id));
          if (!bar?.jobId) return { valid: false, message: 'Only jobs can move.' };
          if (String(newResource.id) === bar.resourceId) return true;
          const problem = validateRef.current(bar.jobId, String(newResource.id));
          const name = rowsById.current.get(String(newResource.id))?.name ?? String(newResource.id);
          refusal.current = problem;
          return problem ? { valid: false, message: problem } : { valid: true, message: `Moves to ${name} at that offer's fee now` };
        },
      },
      onAfterEventDrop: ({ valid }: { valid: boolean }) => {
        if (!valid && refusal.current) refusedRef.current?.(refusal.current);
        refusal.current = null;
      },
      onBeforeEventDropFinalize: ({ context }) => {
        const bar = barsById.current.get(String(context.eventRecord?.id ?? context.eventRecords[0]?.id));
        const target = String(context.newResource?.id ?? '');
        if (!bar?.jobId || !target || target === bar.resourceId) return;
        context.async = true;
        void moveRef.current(bar.jobId, target).then(() => context.finalize(false));
      },
      onEventClick: ({ eventRecord, resourceRecord }) => {
        const bar = barsById.current.get(String(eventRecord.id));
        onSelectRef.current(String(resourceRecord.id), bar?.shopId ?? null);
      },
      onCellClick: ({ record }: { record: { id: string | number } }) => {
        const row = rowsById.current.get(String(record.id));
        if (row) onSelectRef.current(row.id, row.shopId);
      },
      onPaint: ({ firstPaint }: { firstPaint: boolean }) => {
        if (firstPaint) scrollToNowRef.current(false);
      },
      onHorizontalScroll: () => updateMarkersRef.current(),
      onTimelineViewportResize: () => updateMarkersRef.current(),
    }),
    // The config is created once; live data flows through refs and the events/resources props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <div className="board-shell" ref={shellRef}>
      <BryntumScheduler ref={ref} {...config} resources={resources} events={events} />
      <div className="board-markers" aria-hidden="true">
        {markers.map((m) => (
          <div key={m.id} className={`board-marker is-${m.kind}${m.side === 'left' ? ' is-left' : ''}`} style={{ left: m.x }}>
            <span>{m.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
