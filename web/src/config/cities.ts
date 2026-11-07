import { JAPANTOWN, JAPANTOWN_GRID_BEARING, SOHO } from '@holdmyspot/shared';

export type CityId = 'sf' | 'nyc' | 'taipei';

export interface CityConfig {
  id: CityId;
  name: string;
  /** Neighbourhood shown in the top bar. */
  area: string;
  /**
   * The fixed demo position, [lng, lat]: where the player stands in demo mode or
   * when the browser's location is off. Snapped to the nearest street once tiles load.
   */
  start: [number, number];
  /** Map camera. Bearing lines the local street grid up with the screen. */
  bearing: number;
  pitch: number;
  zoom: number;
  /** The overview's zoom (top-down, every task point of the city). */
  overviewZoom: number;
  /**
   * Where the queuer who carries an offer walks back and forth, as [right, forward]
   * metres from the start (snapped to streets). Chosen so the walker and the offer
   * stay on screen between the task labels. The walker starts halfway along and
   * heads for the first point.
   */
  walkerRoute: [[number, number], [number, number]];
  /** Local time zone: clocks and times on screen follow the city, not the viewer's computer. */
  timeZone: string;
  /** Not linked anywhere: reachable only with ?city=. */
  hidden?: boolean;
}

export const CITIES: Record<CityId, CityConfig> = {
  sf: {
    id: 'sf',
    name: 'San Francisco',
    area: 'Japantown',
    start: JAPANTOWN,
    bearing: JAPANTOWN_GRID_BEARING,
    pitch: 63,
    zoom: 18.2,
    overviewZoom: 12.6,
    timeZone: 'America/Los_Angeles',
    walkerRoute: [
      [-4, 232],
      [-2, 112],
    ],
  },
  nyc: {
    id: 'nyc',
    name: 'New York',
    area: 'SoHo and the Lower East Side',
    start: SOHO,
    bearing: 29,
    pitch: 63,
    zoom: 18.2,
    overviewZoom: 15.2,
    timeZone: 'America/New_York',
    walkerRoute: [
      [-3, 90],
      [-8, 240],
    ],
  },
  taipei: {
    id: 'taipei',
    name: 'Taipei',
    area: 'Ximending',
    start: [121.50705, 25.04335],
    bearing: 14,
    pitch: 63,
    zoom: 18.2,
    overviewZoom: 15.4,
    timeZone: 'Asia/Taipei',
    walkerRoute: [
      [15, 180],
      [14, 70],
    ],
    hidden: true,
  },
};

export const DEFAULT_CITY: CityId = 'sf';

export function isCityId(value: string | null): value is CityId {
  return value === 'sf' || value === 'nyc' || value === 'taipei';
}
