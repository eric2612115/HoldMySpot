import type { LngLat } from '@holdmyspot/shared';
import { create } from 'zustand';
import { params } from './services';

/**
 * Where the player is: the browser's location when the viewer allowed it,
 * else the city's fixed demo spot (always in demo mode). The 3D scene moves
 * the avatar from here and reports walks back, so distances, walking minutes
 * and earning rates are measured from the avatar.
 */
export type PositionSource = 'demo' | 'gps';

interface PositionState {
  lngLat: LngLat;
  source: PositionSource;
  /** Where "back to me" goes: the GPS fix or the demo spot (the avatar walks from there). */
  home: LngLat;
  set(lngLat: LngLat): void;
  setHome(home: LngLat, source: PositionSource): void;
}

export const usePosition = create<PositionState>()((set) => ({
  lngLat: params.city.start,
  source: 'demo',
  home: params.city.start,
  set(lngLat) {
    set({ lngLat });
  },
  setHome(home, source) {
    set({ home, source, lngLat: home });
  },
}));

export function playerLngLat(): LngLat {
  return usePosition.getState().lngLat;
}

/** Furthest a GPS fix may be from the city's demo spot and still count as "here" (beyond it the demo spot is used). */
export const NEAR_CITY_METERS = 25_000;
