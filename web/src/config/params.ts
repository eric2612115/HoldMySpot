import { CITIES, DEFAULT_CITY, isCityId, type CityConfig } from './cities';

export type BackendChoice = 'auto' | 'server' | 'mock';

export interface AppParams {
  city: CityConfig;
  /**
   * How fast the in-browser market's clock runs. `?speed=60` makes five minutes
   * pass in five seconds, for demos and recordings. Clamped to 1..600. With the
   * server, its own market clock rules instead.
   */
  speed: number;
  /** `?backend=`: the server (8796) when it answers, else the in-browser market (auto, the default). */
  backend: BackendChoice;
  /** `?as=`: the requester persona for server requests and money (default Mia). */
  as: string | null;
  /** `?queuer=`: the queuer persona for taking tasks on the server (default Wei). */
  queuer: string | null;
  /** `?demo=1`: never ask for the browser's location; the player stays at the fixed demo spot. */
  demo: boolean;
  /** `?hosted=1`: this phone sits on the hosted judge's page (sample photos, a real AI read when the service has a key). */
  hosted: boolean;
  /** `?solo=1`: this phone is one of two side by side on the judge's page, so it has no phone switch. */
  solo: boolean;
  /** `?view=overview`: open on the top-down overview. */
  overview: boolean;
}

function backendOf(value: string | null): BackendChoice {
  const env = (import.meta.env.VITE_BACKEND as string | undefined) ?? 'auto';
  const v = value ?? env;
  return v === 'server' || v === 'mock' ? v : 'auto';
}

export function readParams(search: string = window.location.search): AppParams {
  const q = new URLSearchParams(search);
  const cityParam = q.get('city');
  const city = isCityId(cityParam) ? CITIES[cityParam] : CITIES[DEFAULT_CITY];
  const rawSpeed = Number(q.get('speed') ?? '1');
  const speed = Number.isFinite(rawSpeed) ? Math.min(600, Math.max(1, rawSpeed)) : 1;
  const demo = q.has('demo') && q.get('demo') !== '0';
  return {
    city,
    speed,
    backend: city.id === 'taipei' ? 'mock' : backendOf(q.get('backend')),
    as: q.get('as'),
    queuer: q.get('queuer'),
    demo,
    hosted: q.get('hosted') === '1',
    solo: q.get('solo') === '1',
    overview: q.get('view') === 'overview',
  };
}
