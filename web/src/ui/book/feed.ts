import type { Match } from '@holdmyspot/shared';
import { useEffect, useRef, useState } from 'react';
import type { TaskPoint } from '../../domain/types';
import { api } from '../../services/api';
import { useMarket } from '../../state/market';
import { onStreamEvent } from '../../state/serverMarket';
import { clock } from '../../state/services';
import { derivedFills, mergeTape, type TapeRow } from './model';

/**
 * The book's recent matches, kept live. With the server: the book's last
 * matches (GET /api/books/:shopId/:itemId), then every `match.created` on the
 * event stream the app already follows (no new stream). In the in-browser
 * market, a fill is an offer whose room went down. `onLive` hears each new
 * match while the book is open, before the book update that removes the two
 * sides, so the view can show them meeting.
 */
export function useBookFeed(point: TaskPoint, onLive: (row: TapeRow) => void): TapeRow[] {
  const backend = useMarket((s) => s.backend);
  const [tape, setTape] = useState<TapeRow[]>([]);
  const names = useRef(new Map<string, string>());
  const seen = useRef(new Set<string>());
  const live = useRef(onLive);
  live.current = onLive;
  const latest = useRef(point);
  latest.current = point;
  const { id: itemId } = point;
  const shopId = point.shop.id;

  useEffect(() => {
    if (backend !== 'server') return;
    let gone = false;
    let refetch = 0;
    const rowOf = (m: Match): TapeRow => ({
      id: m.id,
      feeCents: m.feeCents,
      qty: m.qty,
      at: m.at,
      queuerName: names.current.get(m.askId) ?? null,
      trigger: m.trigger,
      bidId: m.bidId,
      askId: m.askId,
    });
    const load = async () => {
      try {
        const r = await api('GET /api/books/:shopId/:itemId', { shopId, itemId }, null);
        if (gone) return;
        for (const a of r.asks) names.current.set(a.id, a.queuerName);
        for (const m of r.recentMatches) seen.current.add(m.id);
        setTape((t) => mergeTape(t, r.recentMatches.map(rowOf)));
      } catch {
        /* The stream still brings new matches. */
      }
    };
    const restart = () => {
      seen.current.clear();
      setTape([]);
      void load();
    };
    restart();
    const off = onStreamEvent((e) => {
      if (e.type === 'resync' || (e.type === 'hello' && e.who === 'requester')) {
        restart();
        return;
      }
      if (e.type !== 'match.created') return;
      const m = e.data as Match;
      // Both persona streams carry every match: show each once.
      if (m.itemId !== itemId || seen.current.has(m.id)) return;
      seen.current.add(m.id);
      for (const o of latest.current.offers) names.current.set(o.askId, o.queuerName);
      const row = rowOf(m);
      live.current(row);
      setTape((t) => mergeTape(t, [row]));
      // The ask may be new to this screen (a direct claim): its record names the queuer.
      window.clearTimeout(refetch);
      refetch = window.setTimeout(() => void load(), 500);
    });
    return () => {
      gone = true;
      window.clearTimeout(refetch);
      off();
    };
  }, [backend, itemId, shopId]);

  const before = useRef<TaskPoint | null>(null);
  useEffect(() => {
    if (backend !== 'mock') return;
    const prev = before.current;
    before.current = point;
    if (!prev || prev.id !== point.id) {
      setTape([]);
      return;
    }
    const fills = derivedFills(prev, point, clock.now());
    if (fills.length === 0) return;
    for (const f of fills) live.current(f);
    setTape((t) => mergeTape(t, fills));
  }, [backend, point]);

  return tape;
}
