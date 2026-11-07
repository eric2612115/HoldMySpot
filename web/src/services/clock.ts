import type { ClockState } from '@holdmyspot/shared';

/**
 * The market clock. Fee clocks, countdowns and deadlines all read time from
 * here. In the in-browser market it runs from page load (`?speed=60`: five
 * minutes pass in five seconds); with the server it follows the server's
 * ClockState (its own speed, pauses and jumps). Money never depends on the
 * speed: amounts are the same at any speed.
 */
export interface MarketClock {
  readonly speed: number;
  now(): number;
  /** Follow the server's market clock from now on. */
  follow(state: ClockState): void;
}

export function createMarketClock(speed = 1, origin = Date.now()): MarketClock {
  const startedAt = performance.now();
  let server: ClockState | null = null;
  return {
    get speed() {
      return server ? server.speed : speed;
    },
    now: () => {
      if (server) return server.paused ? server.marketNow : server.marketNow + (Date.now() - server.realNow) * server.speed;
      return origin + (performance.now() - startedAt) * speed;
    },
    follow(state) {
      server = state;
    },
  };
}
