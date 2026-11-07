import { useEffect, useState } from 'react';
import type { AgWidgetField, AgWidgetParams } from 'ag-studio';

/** Mapped field keys a widget asked for, in order. */
export type Slots = Record<string, AgWidgetField | undefined>;

/**
 * Runs the widget's query through Studio's data engine (so page filters and
 * cross-filters apply) and keeps it fresh when the data changes.
 */
export function useRows(params: AgWidgetParams, slotNames: string[], required: string[]) {
  const { dataMapping, widgetApi } = params;
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);
  const [slots, setSlots] = useState<Slots>({});

  useEffect(() => {
    const mapping = (dataMapping ?? {}) as Record<string, AgWidgetField[] | undefined>;
    const found: Slots = {};
    for (const name of slotNames) found[name] = mapping[name]?.[0];
    setSlots(found);
    if (required.some((r) => !found[r])) {
      // Wait for the mapping (the market desk maps fields right after it adds the widget).
      setRows(null);
      return;
    }
    const fields = slotNames.map((n) => found[n]).filter((f): f is AgWidgetField => !!f);
    let live = true;
    widgetApi.setDisplayState('loading');
    widgetApi
      .getData(
        { fields },
        {
          crossFilter: 'filter',
          onDataUpdated: (res) => {
            if (live) setRows(res.results.rows);
          },
        },
      )
      .then((res) => {
        if (!live) return;
        setRows(res.results.rows);
        widgetApi.setDisplayState(res.results.rows.length ? 'displayed' : 'noData');
      })
      .catch(() => {
        if (live) widgetApi.setDisplayState('noData');
      });
    return () => {
      live = false;
    };
    // slotNames and required are constants per widget type.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataMapping, widgetApi]);

  return { rows, slots };
}

export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
export const money = (v: number | null) =>
  v === null ? '-' : v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
