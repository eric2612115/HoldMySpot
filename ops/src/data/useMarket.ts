import { useCallback, useEffect, useRef, useState } from 'react';
import type { MarketMs } from '@holdmyspot/shared';
import { pickBackend } from './backend.ts';
import type { MarketSnapshot, OpsBackend, Proposal } from './backend.ts';
import { MINUTE } from './time.ts';

export interface Market {
  backend: OpsBackend;
  snapshot: MarketSnapshot;
  at: MarketMs;
  playing: boolean;
  setAt(at: MarketMs): void;
  togglePlay(): void;
  /** Applies one option of a rescheduler proposal (its chosen one when `optionId` is null); resolves to what happened. */
  approve(proposal: Proposal, optionId: string | null): Promise<string>;
  move(jobId: string, toQueuerId: string): Promise<string | null>;
  /** Bumps on every applied change so views can animate what moved. */
  revision: number;
}

/** Demo speed: one market minute per real second (the hero script runs at 60). */
const TICK_MS = 1000;
/** Server mode: how often the console reads the live market. */
const POLL_MS = 1500;

export function useMarket(): Market | { error: string } | null {
  const [backend, setBackend] = useState<OpsBackend | null>(null);
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [at, setAtState] = useState<MarketMs | null>(null);
  const [playing, setPlaying] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  useEffect(() => {
    let live = true;
    pickBackend()
      .then((b) => {
        if (!live) return;
        setBackend(b);
        setAtState(b.initialAt());
      })
      .catch((e: unknown) => setError(String(e)));
    return () => {
      live = false;
    };
  }, []);

  const load = useCallback(
    async (b: OpsBackend, t: MarketMs) => {
      const id = ++request.current;
      try {
        const s = await b.snapshot(t);
        if (id === request.current) setSnapshot(s);
      } catch (e) {
        setError(String(e));
      }
    },
    [],
  );

  useEffect(() => {
    if (backend && at !== null) void load(backend, at);
  }, [backend, at, revision, load]);

  const live = backend?.kind === 'server';

  // The replay moves its own clock; a live server moves on its own, so the console polls it.
  useEffect(() => {
    if (!playing || live) return;
    const timer = setInterval(() => setAtState((t) => (t === null ? t : t + MINUTE)), TICK_MS);
    return () => clearInterval(timer);
  }, [playing, live]);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setRevision((r) => r + 1), POLL_MS);
    return () => clearInterval(timer);
  }, [live]);

  const setAt = useCallback((t: MarketMs) => setAtState(t), []);
  const serverRunning = live && snapshot !== null && !snapshot.config.clock.paused;
  const togglePlay = useCallback(() => {
    if (backend?.setRunning) {
      backend
        .setRunning(!serverRunning)
        .then(() => setRevision((r) => r + 1))
        .catch((e: unknown) => setError(String(e)));
      return;
    }
    setPlaying((p) => !p);
  }, [backend, serverRunning]);

  const approve = useCallback(
    async (proposal: Proposal, optionId: string | null) => {
      if (!backend || at === null) return 'Not ready.';
      const note = await backend.approve(proposal, optionId, live && snapshot ? snapshot.at : at);
      setRevision((r) => r + 1);
      return note;
    },
    [backend, at, live, snapshot],
  );

  const move = useCallback(
    async (jobId: string, toQueuerId: string) => {
      if (!backend || at === null) return 'Not ready.';
      const problem = await backend.move(jobId, toQueuerId, live && snapshot ? snapshot.at : at);
      setRevision((r) => r + 1);
      return problem;
    },
    [backend, at, live, snapshot],
  );

  if (error) return { error };
  if (!backend || !snapshot || at === null) return null;
  // Live: the server's market time and clock state; replay: the console's own.
  return { backend, snapshot, at: live ? snapshot.at : at, playing: live ? serverRunning : playing, setAt, togglePlay, approve, move, revision };
}
