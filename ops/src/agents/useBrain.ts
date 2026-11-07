import { useEffect, useState } from 'react';
import { OFFLINE, detectBrain } from './brain.ts';
import type { Brain } from './brain.ts';

/** Where the agents think, once the data backend is known (null until then). */
export function useBrain(backend: 'mock' | 'server' | undefined): Brain | null {
  const [brain, setBrain] = useState<Brain | null>(null);
  useEffect(() => {
    if (!backend) return;
    let live = true;
    detectBrain(backend)
      .then((b) => {
        if (live) setBrain(b);
      })
      .catch(() => {
        if (live) setBrain({ ...OFFLINE, reason: 'The agents could not reach the server, so they run offline.' });
      });
    return () => {
      live = false;
    };
  }, [backend]);
  return brain;
}
