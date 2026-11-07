import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl';

/**
 * Our own soft, toy-like restyle of the free OpenFreeMap "liberty" base
 * style (OpenStreetMap data, no API key). Colours are set by what a layer
 * shows (its source layer and type), so the restyle survives upstream
 * changes to individual layer ids.
 */
export const BASE_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

export const MAP_COLORS = {
  ground: '#EEF4E6',
  block: '#E7EFDD',
  park: '#CFEBBF',
  wood: '#C2E4B3',
  sand: '#F6ECCB',
  water: '#B9DEF4',
  waterLine: '#A4D3EF',
  road: '#FFFFFF',
  roadCasing: '#DCD6EA',
  path: '#F5E9DA',
  rail: '#D6D1E4',
  label: '#7A7F99',
  labelHalo: '#FFFFFF',
  // Quiet, near-white blocks: the characters and glowing tasks carry the colour.
  buildings: ['#EEE7FB', '#FBEAE2', '#E5EFF9', '#F8F1DF', '#E8F4EC', '#F9E7EF'],
  sky: '#CFE8FF',
  horizon: '#FFF3F8',
};

/** Buildings are shortened so the city reads like a toy model and characters stay in view. */
export const BUILDING_HEIGHT_SCALE = 0.34;

const HIDE_SOURCE_LAYERS = new Set(['poi', 'housenumber', 'aerodrome_label', 'mountain_peak', 'boundary', 'aeroway']);

/**
 * English or Latin-script names only. The UI is English, so a street with no
 * English or Latin name stays unlabelled rather than showing another script.
 * (OpenMapTiles' `name_en` falls back to the native name, so it is not used.)
 */
const nameField: ExpressionSpecification = ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ''];

function buildingColor(): ExpressionSpecification {
  const n = MAP_COLORS.buildings.length;
  const pick: ExpressionSpecification = [
    '%',
    ['abs', ['round', ['*', ['+', ['coalesce', ['get', 'render_height'], 9], ['coalesce', ['get', 'render_min_height'], 0]], 7.31]]],
    n,
  ];
  const cases: (number | string)[] = [];
  MAP_COLORS.buildings.slice(0, n - 1).forEach((c, i) => cases.push(i, c));
  return ['match', pick, ...cases, MAP_COLORS.buildings[n - 1]] as unknown as ExpressionSpecification;
}

/** Multiplies the outputs of a zoom-interpolated width (or a plain number) by k. */
function scaleWidth(width: unknown, k: number): unknown {
  if (typeof width === 'number') return width * k;
  if (Array.isArray(width) && width[0] === 'interpolate') {
    return width.map((v, i) => (i >= 4 && i % 2 === 0 && typeof v === 'number' ? v * k : v));
  }
  return width;
}

function hidden(layer: LayerSpecification): LayerSpecification {
  return { ...layer, layout: { ...(layer.layout ?? {}), visibility: 'none' } } as LayerSpecification;
}

function restyle(layer: LayerSpecification): LayerSpecification {
  const src = 'source-layer' in layer ? layer['source-layer'] : undefined;
  const id = layer.id;

  if (layer.type === 'background') {
    return { ...layer, paint: { 'background-color': MAP_COLORS.ground } };
  }
  if (layer.type === 'raster' || layer.type === 'hillshade') return hidden(layer);
  if (src && HIDE_SOURCE_LAYERS.has(src)) return hidden(layer);

  if (layer.type === 'fill') {
    const paint: Record<string, unknown> = { 'fill-antialias': true };
    if (src === 'water') {
      paint['fill-color'] = MAP_COLORS.water;
    } else if (src === 'park') {
      paint['fill-color'] = MAP_COLORS.park;
    } else if (src === 'landcover') {
      paint['fill-color'] = [
        'match',
        ['get', 'class'],
        ['wood', 'forest'], MAP_COLORS.wood,
        ['sand', 'beach'], MAP_COLORS.sand,
        ['ice', 'glacier'], '#FFFFFF',
        MAP_COLORS.park,
      ];
      paint['fill-opacity'] = 0.9;
    } else if (src === 'landuse') {
      paint['fill-color'] = [
        'match',
        ['get', 'class'],
        ['park', 'grass', 'cemetery', 'pitch', 'playground', 'garden', 'stadium'], MAP_COLORS.park,
        ['school', 'university', 'college', 'hospital'], '#F4EDF8',
        MAP_COLORS.block,
      ];
      paint['fill-opacity'] = 0.75;
    } else if (src === 'building') {
      paint['fill-color'] = '#EADFF7';
      paint['fill-opacity'] = 0.9;
    } else if (src === 'transportation') {
      paint['fill-color'] = '#F7F4FB';
    } else {
      paint['fill-color'] = MAP_COLORS.block;
      paint['fill-opacity'] = 0.6;
    }
    return { ...layer, paint } as LayerSpecification;
  }

  if (layer.type === 'fill-extrusion') {
    return {
      ...layer,
      minzoom: 14,
      layout: { ...(layer.layout ?? {}), 'fill-extrusion-rounded-corner-distance': 2.4 },
      paint: {
        'fill-extrusion-color': buildingColor(),
        'fill-extrusion-height': ['*', ['coalesce', ['get', 'render_height'], 9], BUILDING_HEIGHT_SCALE],
        'fill-extrusion-base': ['*', ['coalesce', ['get', 'render_min_height'], 0], BUILDING_HEIGHT_SCALE],
        'fill-extrusion-opacity': 0.97,
        'fill-extrusion-vertical-gradient': true,
      },
    } as LayerSpecification;
  }

  if (layer.type === 'line') {
    const paint = { ...(layer.paint ?? {}) } as Record<string, unknown>;
    delete paint['line-pattern'];
    if (src === 'water' || src === 'waterway') {
      paint['line-color'] = MAP_COLORS.waterLine;
    } else if (src === 'park' || src === 'landuse' || src === 'landcover' || src === 'building') {
      return hidden(layer);
    } else if (src === 'transportation') {
      const isCasing = id.includes('casing');
      const isRail = id.includes('rail') || id.includes('transit');
      const isPath = id.includes('path') || id.includes('pedestrian') || id.includes('footway') || id.includes('cycleway');
      if (id.includes('tunnel') && !isCasing) {
        paint['line-color'] = '#F3F0F8';
        paint['line-opacity'] = 0.7;
      } else if (id.includes('tunnel')) {
        return hidden(layer);
      } else if (isRail) {
        if (id.includes('hatching')) return hidden(layer);
        paint['line-color'] = MAP_COLORS.rail;
      } else if (isPath) {
        paint['line-color'] = isCasing ? MAP_COLORS.roadCasing : MAP_COLORS.path;
        paint['line-width'] = scaleWidth(paint['line-width'], 1.4);
        delete paint['line-dasharray'];
      } else if (id.includes('ferry') || id.includes('aerialway')) {
        return hidden(layer);
      } else {
        // Wide, soft streets: they are where people walk in this game.
        paint['line-color'] = isCasing ? MAP_COLORS.roadCasing : MAP_COLORS.road;
        paint['line-width'] = scaleWidth(paint['line-width'], 1.7);
      }
    } else {
      paint['line-color'] = MAP_COLORS.roadCasing;
      paint['line-opacity'] = 0.6;
    }
    return { ...layer, paint } as LayerSpecification;
  }

  if (layer.type === 'symbol') {
    // Street and water names only. Place names (neighbourhoods, cities) are noise at
    // street level, can land on the player, and the top bar already names the area.
    const keep = src === 'transportation_name' || src === 'water_name';
    if (!keep || id.includes('shield')) return hidden(layer);
    return {
      ...layer,
      layout: { ...(layer.layout ?? {}), 'text-field': nameField },
      paint: {
        'text-color': src === 'water_name' ? '#5E9CC2' : MAP_COLORS.label,
        'text-halo-color': MAP_COLORS.labelHalo,
        'text-halo-width': 1.6,
        'text-halo-blur': 0.4,
      },
    } as LayerSpecification;
  }

  return layer;
}

export async function loadPastelStyle(url = BASE_STYLE_URL, signal?: AbortSignal): Promise<StyleSpecification> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Map style failed to load (${res.status}).`);
  const base = (await res.json()) as StyleSpecification;
  return pastelize(base);
}

export function pastelize(base: StyleSpecification): StyleSpecification {
  return {
    ...base,
    layers: base.layers.map(restyle),
    light: { anchor: 'viewport', color: '#FFFFFF', intensity: 0.3, position: [1.25, 205, 42] },
    sky: {
      'sky-color': MAP_COLORS.sky,
      'sky-horizon-blend': 0.6,
      'horizon-color': MAP_COLORS.horizon,
      'horizon-fog-blend': 0.7,
      'fog-color': '#F6F2FF',
      'fog-ground-blend': 0.4,
    },
  };
}
