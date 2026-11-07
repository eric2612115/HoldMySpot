import 'maplibre-gl/dist/maplibre-gl.css';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, LayerSpecification, StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { SEED_SHOPS, SEED_USERS } from '@holdmyspot/shared';
import type { LngLat } from '@holdmyspot/shared';
import { useEffect, useRef, useState } from 'react';
import type { QueuerRow } from './boardModel.ts';

// Vite moves MapLibre's module, so point MapLibre at its worker file explicitly.
maplibregl.setWorkerUrl(workerUrl);

/** Free OpenFreeMap tiles (OpenStreetMap data, no key), restyled to the app's soft palette. */
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
/** The Japantown shops the board follows (the others are out of the board's range). */
const BOARD_SHOP_IDS = ['paper-moon-toys', 'little-lantern-toys', 'sugar-cloud-bakery', 'steam-lantern-ramen'];
const BOARD_SHOPS = SEED_SHOPS.filter((s) => BOARD_SHOP_IDS.includes(s.id));

function restyle(style: StyleSpecification): StyleSpecification {
  const hide = new Set(['poi', 'housenumber', 'aerodrome_label', 'mountain_peak', 'aeroway']);
  const dropped = (layer: LayerSpecification) => {
    const src = 'source-layer' in layer ? layer['source-layer'] : undefined;
    return (
      layer.type === 'fill-extrusion' ||
      layer.id.includes('shield') ||
      (layer.type === 'symbol' && !['transportation_name', 'place', 'water_name'].includes(src ?? ''))
    );
  };
  const layers = style.layers.filter((l) => !dropped(l)).map((layer): LayerSpecification => {
    const src = 'source-layer' in layer ? layer['source-layer'] : undefined;
    const hidden = { ...layer, layout: { ...(layer.layout ?? {}), visibility: 'none' } } as LayerSpecification;
    if (layer.type === 'background') return { ...layer, paint: { 'background-color': '#EEF4E6' } };
    if (layer.type === 'fill-extrusion' || layer.type === 'raster' || layer.type === 'hillshade') return hidden;
    if (src && hide.has(src)) return hidden;
    if (layer.type === 'fill') {
      const color = src === 'water' ? '#B9DEF4' : src === 'park' ? '#CFEBBF' : src === 'building' ? '#F2EEF9' : src === 'landcover' ? '#D6EDC9' : '#E7EFDD';
      return { ...layer, paint: { 'fill-color': color, 'fill-opacity': 1, ...(src === 'building' ? { 'fill-outline-color': '#E4DDF3' } : {}) } } as LayerSpecification;
    }
    if (layer.type === 'line') {
      if (src === 'waterway') return { ...layer, paint: { ...(layer.paint ?? {}), 'line-color': '#A4D3EF' } } as LayerSpecification;
      if (src === 'transportation') {
        const casing = layer.id.includes('casing');
        const rail = layer.id.includes('rail') || layer.id.includes('transit');
        return { ...layer, paint: { ...(layer.paint ?? {}), 'line-color': rail ? '#D6D1E4' : casing ? '#DCD6EA' : '#FFFFFF' } } as LayerSpecification;
      }
      if (src === 'boundary') return hidden;
      return layer;
    }
    if (layer.type === 'symbol') {
      if (src === 'transportation_name' || src === 'place' || src === 'water_name') {
        // Latin-script names only, so every label on screen is English or romanized.
        // (name_en falls back to the local-script name in OpenMapTiles, so it is skipped.)
        const textField = ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ''];
        return {
          ...layer,
          layout: { ...(layer.layout ?? {}), 'text-field': textField },
          paint: { ...(layer.paint ?? {}), 'text-color': '#7A7F99', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.4 },
        } as LayerSpecification;
      }
      return hidden;
    }
    return layer;
  });
  return { ...style, layers };
}

function circle(center: LngLat, metres: number, steps = 48): { type: 'Polygon'; coordinates: [number, number][][] } {
  const coords: [number, number][] = [];
  const latR = metres / 111_320;
  const lngR = metres / (111_320 * Math.cos((center[1] * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    coords.push([center[0] + lngR * Math.cos(a), center[1] + latR * Math.sin(a)]);
  }
  return { type: 'Polygon', coordinates: [coords] };
}

interface Props {
  rows: QueuerRow[];
  positions: Record<string, LngLat>;
  selectedId: string | null;
  selectedShopId: string | null;
  onSelect(queuerId: string, shopId: string | null): void;
}

export function MapPanel({ rows, positions, selectedId, selectedShopId, onSelect }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const shopMarkers = useRef(new Map<string, { marker: maplibregl.Marker; el: HTMLDivElement }>());
  const queuerMarkers = useRef(new Map<string, { marker: maplibregl.Marker; el: HTMLDivElement }>());
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!host.current) return;
    let cancelled = false;
    let map: maplibregl.Map | null = null;
    fetch(STYLE_URL)
      .then((r) => r.json() as Promise<StyleSpecification>)
      .then((style) => {
        if (cancelled || !host.current) return;
        map = new maplibregl.Map({
          container: host.current,
          style: restyle(style),
          center: [-122.4318, 37.7845],
          zoom: 14.1,
          attributionControl: { compact: true },
          dragRotate: false,
          pitchWithRotate: false,
        });
        mapRef.current = map;
        map.on('load', () => {
          if (!map) return;
          map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          map.addSource('fence', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
          map.addLayer({ id: 'fence-fill', type: 'fill', source: 'fence', paint: { 'fill-color': '#5B4CF0', 'fill-opacity': 0.1 } });
          map.addLayer({ id: 'fence-line', type: 'line', source: 'fence', paint: { 'line-color': '#5B4CF0', 'line-width': 1.5, 'line-dasharray': [2, 2] } });
          map.addLayer({
            id: 'route-line',
            type: 'line',
            source: 'route',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': '#5B4CF0', 'line-width': 3, 'line-dasharray': [1.2, 1.6], 'line-opacity': 0.9 },
          });
          for (const shop of BOARD_SHOPS) {
            const el = document.createElement('div');
            el.className = 'map-shop';
            el.title = shop.name;
            el.style.setProperty('--accent', shop.accent ?? '#5b4cf0');
            el.innerHTML = '<i></i><b></b>';
            (el.querySelector('b') as HTMLElement).textContent = shop.name;
            const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(shop.lngLat).addTo(map);
            shopMarkers.current.set(shop.id, { marker, el });
          }
          setReady(true);
        });
      })
      .catch(() => {
        /* Offline: the panel keeps its plain background. */
      });
    return () => {
      cancelled = true;
      shopMarkers.current.clear();
      queuerMarkers.current.clear();
      map?.remove();
      mapRef.current = null;
    };
  }, []);

  // Queuer avatars at their synthetic demo positions.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const row of rows) {
      const pos = positions[row.id];
      if (!pos) continue;
      let entry = queuerMarkers.current.get(row.id);
      if (!entry) {
        const el = document.createElement('div');
        el.className = 'map-queuer';
        el.textContent = row.initial;
        el.title = row.name;
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const r = rowsRef.current.find((x) => x.id === row.id);
          onSelectRef.current(row.id, r?.shopId ?? null);
        });
        const marker = new maplibregl.Marker({ element: el }).setLngLat(pos).addTo(map);
        entry = { marker, el };
        queuerMarkers.current.set(row.id, entry);
      }
      entry.marker.setLngLat(pos);
      entry.el.style.setProperty('--accent', row.accent);
      entry.el.classList.toggle('is-selected', row.id === selectedId);
      entry.el.classList.toggle('is-alert', row.alert);
    }
  });

  // Selection: highlight the queuer and their shop, draw the walk and the geofence.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const [id, { el }] of shopMarkers.current) el.classList.toggle('is-selected', id === selectedShopId);
    const shop = BOARD_SHOPS.find((s) => s.id === selectedShopId);
    const pos = selectedId ? positions[selectedId] : undefined;
    const route = map.getSource('route') as GeoJSONSource | undefined;
    const fence = map.getSource('fence') as GeoJSONSource | undefined;
    route?.setData({
      type: 'FeatureCollection',
      features: shop && pos ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [pos, shop.lngLat] } }] : [],
    });
    fence?.setData({
      type: 'FeatureCollection',
      features: shop ? [{ type: 'Feature', properties: {}, geometry: circle(shop.lngLat, shop.geofenceMeters) }] : [],
    });
    const home = SEED_USERS.find((u) => u.id === selectedId)?.home ?? null;
    const pts: LngLat[] = [shop?.lngLat, pos, home].filter((p): p is LngLat => !!p);
    if (pts.length >= 2) {
      const bounds = pts.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
      map.fitBounds(bounds, { padding: { top: 70, bottom: 40, left: 50, right: 50 }, maxZoom: 16.2, duration: 700 });
    } else if (pts[0]) {
      map.easeTo({ center: pts[0], zoom: 15.6, duration: 700 });
    }
  }, [selectedId, selectedShopId, positions, ready]);

  const row = rows.find((r) => r.id === selectedId);
  const shop = BOARD_SHOPS.find((s) => s.id === selectedShopId);
  return (
    <section className="map-card" aria-label="Map of queuers and shops">
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
      <div className="map-caption">
        <span className="pill">
          {row ? (
            <>
              <strong>{row.name}</strong>
              {shop ? ` and ${shop.name}` : ''}
            </>
          ) : (
            'Pick a queuer'
          )}
        </span>
        <span className="pill is-synthetic">Demo walks, not live GPS</span>
      </div>
    </section>
  );
}
