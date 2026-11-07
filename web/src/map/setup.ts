import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

/**
 * MapLibre finds its worker next to its own module by default. Bundlers
 * move that module, so point MapLibre at the worker file explicitly.
 */
setWorkerUrl(workerUrl);
