import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { params } from '../../state/services';
import { openActiveErrand } from './store';

/**
 * The phone on the hosted judge's page (D-163): "Try to break it" arms the proof card with sample
 * photos and a fake-receipt reading through a message from the page (same origin only), and the
 * card offers a real model read when the service has a key and this market still has reads.
 */

export const useBreakArmed = create<{ armed: boolean }>()(() => ({ armed: false }));

if (typeof window !== 'undefined' && params.hosted) {
  window.addEventListener('message', (e: MessageEvent<{ type?: string }>) => {
    if (e.origin !== window.location.origin || e.data?.type !== 'hms:break') return;
    useBreakArmed.setState({ armed: true });
    void openActiveErrand();
  });
}

export async function samplePhoto(kind: 'receipt' | 'item'): Promise<File> {
  const res = await fetch(`/ops/people/${kind}.jpg`);
  if (!res.ok) throw new Error('The sample photo could not be loaded.');
  return new File([await res.blob()], `sample-${kind}.jpg`, { type: 'image/jpeg' });
}

/** Real model reads left for this market on the hosted site; 0 everywhere else. */
export function useModelReads(): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!params.hosted) return;
    let off = false;
    fetch('/api/hosted/info')
      .then((r) => r.json() as Promise<{ ai?: { readsLeft?: number } }>)
      .then((i) => {
        if (!off) setLeft(i.ai?.readsLeft ?? 0);
      })
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, []);
  return left;
}
