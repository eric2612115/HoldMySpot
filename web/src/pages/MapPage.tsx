import { distanceMeters } from '@holdmyspot/shared';
import { Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '../map/setup';
import { reachOf } from '../domain/earning';
import { MapScene, type CameraMode } from '../map/mapScene';
import { loadPastelStyle } from '../map/pastelStyle';
import { bootMarket } from '../state/boot';
import { useLook } from '../state/look';
import { useMarket } from '../state/market';
import { NEAR_CITY_METERS, usePosition } from '../state/position';
import { clock, params } from '../state/services';
import { BottomSheet } from '../ui/BottomSheet';
import { Attribution, Hint, LoadingVeil, PlayerChip, Toasts } from '../ui/Chrome';
import { MapControls } from '../ui/MapControls';
import { MoneyChip, MoneyPanel } from '../ui/MoneyPanel';
import { Overview } from '../ui/Overview';
import { SimulatedPayPal } from '../ui/SimulatedPayPal';
import { TaskLabels } from '../ui/TaskLabels';
import { TaskSheet } from '../ui/TaskSheet';
import { useNow } from '../ui/hooks';

/** How long the first screen waits for tiles before it shows the map anyway. */
const IDLE_TIMEOUT_MS = 9000;

export function MapPage() {
  const city = params.city;
  const mapEl = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<MapScene | null>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [step, setStep] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [camera, setCamera] = useState<CameraMode>('street');
  const [overviewWanted, setOverviewWanted] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [moneyOpen, setMoneyOpen] = useState(false);
  const [hint, setHint] = useState(true);
  const [locating, setLocating] = useState(false);
  const [sheetPx, setSheetPx] = useState(0);
  const points = useMarket((s) => s.points);
  const selectedId = useMarket((s) => s.selectedId);
  const bumps = useMarket((s) => s.bumps);
  const celebration = useMarket((s) => s.celebration);
  const walkers = useMarket((s) => s.walkers);
  const select = useMarket((s) => s.select);
  const toast = useMarket((s) => s.toast);
  const take = useMarket((s) => s.take);
  const palette = useLook((s) => s.palette);
  const me = usePosition((s) => s.lngLat);
  const now = useNow(1000);
  const selected = points.find((p) => p.id === selectedId) ?? null;
  const reach = useMemo(() => (selected ? reachOf(selected, me, now) : null), [selected, me, now]);
  const overview = overviewWanted || camera === 'overview';

  useEffect(() => {
    void bootMarket(city, params);
  }, [city]);

  // The map and its 3D layer live for the whole page (a retry builds them again).
  useEffect(() => {
    const el = mapEl.current;
    if (!el) return;
    const ctrl = new AbortController();
    let m: MapLibreMap | null = null;
    let disposed = false;
    let idleTimer = 0;
    setStatus('loading');
    setStep(0);
    const sc = new MapScene(city, {
      onSelect: (id) => {
        setHint(false);
        setMoneyOpen(false);
        useMarket.getState().select(id);
      },
      onReady: () => {
        setStep(2);
        // Reveal only once the tiles in view are drawn, so the first screen is never a blank map.
        let tries = 0;
        const reveal = () => {
          if (disposed) return;
          if (m && !m.areTilesLoaded() && tries++ < 30) {
            window.setTimeout(reveal, 100);
            return;
          }
          requestAnimationFrame(() => requestAnimationFrame(() => !disposed && setStatus('ready')));
        };
        reveal();
      },
      onWalk: () => {
        setHint(false);
        useMarket.getState().select(null);
      },
      onCamera: (mode) => setCamera(mode),
      onPlayerMoved: (ll) => usePosition.getState().set(ll),
    });
    sc.player.setPalette(useLook.getState().palette);
    setScene(sc);

    (async () => {
      await Promise.all([
        document.fonts.load('600 16px "Fredoka Variable"'),
        document.fonts.load('700 200px "Fredoka Variable"'),
        document.fonts.load('500 16px "Figtree Variable"'),
      ]).catch(() => undefined);
      const style = await loadPastelStyle(undefined, ctrl.signal);
      if (disposed) return;
      setStep(1);
      m = new MapLibreMap({
        container: el,
        style,
        center: usePosition.getState().home,
        zoom: city.zoom,
        pitch: city.pitch,
        bearing: city.bearing,
        minZoom: 16.2,
        maxZoom: 19.2,
        maxPitch: 75,
        attributionControl: false,
        dragPan: false,
        dragRotate: false,
        keyboard: false,
        doubleClickZoom: false,
        boxZoom: false,
        touchPitch: false,
        canvasContextAttributes: { antialias: true },
        fadeDuration: 0,
      });
      m.scrollZoom.enable({ around: 'center' });
      m.touchZoomRotate.enable({ around: 'center' });
      m.touchZoomRotate.disableRotation();
      setMap(m);
      if (import.meta.env.DEV) Object.assign(window as object, { __map: m, __scene: sc, __market: useMarket, __clock: clock, __position: usePosition });
      m.on('load', () => {
        if (!m || disposed) return;
        m.addLayer(sc);
        let built = false;
        const build = () => {
          if (built || disposed) return;
          built = true;
          window.clearTimeout(idleTimer);
          sc.buildWorld(usePosition.getState().home);
        };
        m.once('idle', build);
        // A slow tile server must not leave the first screen waiting forever.
        idleTimer = window.setTimeout(build, IDLE_TIMEOUT_MS);
      });
      m.on('error', (e) => {
        // Tile hiccups are not fatal; only a missing style is.
        if (!m?.isStyleLoaded()) console.warn('Map error', e.error);
      });
      m.getCanvas().addEventListener('webglcontextlost', () => !disposed && setStatus('error'));
    })().catch((err: unknown) => {
      if (disposed) return;
      console.error(err);
      setStatus('error');
    });

    return () => {
      disposed = true;
      window.clearTimeout(idleTimer);
      ctrl.abort();
      m?.remove();
      setScene(null);
      setMap(null);
    };
  }, [city, attempt]);

  // Keep the 3D world in step with market data.
  useEffect(() => {
    scene?.setPoints(points);
  }, [scene, points, status]);

  const lastBumps = useRef<Record<string, number>>({});
  useEffect(() => {
    for (const [id, n] of Object.entries(bumps)) {
      if (lastBumps.current[id] !== n) scene?.bump(id);
    }
    lastBumps.current = { ...bumps };
  }, [scene, bumps]);

  useEffect(() => {
    if (celebration.n > 0) scene?.celebrate(celebration.pointId);
  }, [scene, celebration]);

  useEffect(() => {
    if (camera === 'street') scene?.select(selectedId, sheetPx);
  }, [scene, selectedId, sheetPx, camera]);

  useEffect(() => {
    scene?.player.setPalette(palette);
  }, [scene, palette]);

  // Queuers the server walks over (demo walks) walk on the 3D map too.
  useEffect(() => {
    if (status === 'ready') scene?.setServerWalkers(walkers);
  }, [scene, walkers, status]);

  // Counts camera moves the viewer asked for: a slow location fix never overrides a later tap.
  const camSeq = useRef(0);

  const openOverview = useCallback(() => {
    if (!scene) return;
    camSeq.current += 1;
    setHint(false);
    setMoneyOpen(false);
    select(null);
    setOverviewWanted(true);
    scene.showOverview(useMarket.getState().points);
  }, [scene, select]);

  // ?view=overview opens on the overview once the street view is ready.
  const openedOnce = useRef(false);
  useEffect(() => {
    if (status !== 'ready' || openedOnce.current || !params.overview || points.length === 0) return;
    openedOnce.current = true;
    window.setTimeout(openOverview, 600);
  }, [status, points.length, openOverview]);

  /** Every flight down into the street view goes through here, so the page and the camera agree on the view. */
  const flyStreet = (fly: () => void) => {
    camSeq.current += 1;
    setListOpen(false);
    setOverviewWanted(false);
    fly();
  };

  const toggleView = () => {
    if (!scene) return;
    if (overview) flyStreet(() => scene.flyHome());
    else openOverview();
  };

  const pick = (id: string) => {
    if (!scene) return;
    flyStreet(() => scene.flyToPoint(id, () => select(id)));
  };

  const locate = () => {
    if (!scene) return;
    const seq = ++camSeq.current;
    setMoneyOpen(false);
    select(null);
    const pos = usePosition.getState();
    const goHome = () => {
      setLocating(false);
      // A tap after this one (a dot, a row, the view switch) wins; the new position still counts.
      if (seq !== camSeq.current) return;
      flyStreet(() => scene.flyHome());
    };
    if (params.demo || !('geolocation' in navigator)) {
      goHome();
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (fix) => {
        const ll: [number, number] = [fix.coords.longitude, fix.coords.latitude];
        if (distanceMeters(ll, city.start) <= NEAR_CITY_METERS) {
          if (pos.source !== 'gps' || distanceMeters(ll, pos.home) > 30) {
            pos.setHome(ll, 'gps');
            scene.placePlayer(ll);
            toast('Using your location.', 'info');
          }
        } else if (pos.source !== 'demo') {
          pos.setHome(city.start, 'demo');
          scene.placePlayer(city.start);
        } else {
          toast(`You are outside ${city.name}, so the map stays on the demo spot in ${city.area}.`, 'info');
        }
        goHome();
      },
      () => {
        if (pos.source === 'demo') toast(`Location is off, so you stand at the demo spot in ${city.area}.`, 'info');
        goHome();
      },
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 30_000 },
    );
  };

  const close = useCallback(() => select(null), [select]);
  const onSheetHeight = useCallback((px: number) => setSheetPx(px), []);

  return (
    <div className={`map-page${overview ? ' is-overview' : ''}${listOpen && overview ? ' is-list-open' : ''}`}>
      <div ref={mapEl} className="map-canvas" />
      <div className={`sky-haze${selected ? ' is-dim' : ''}${overview ? ' is-off' : ''}`} aria-hidden="true" />
      <TaskLabels
        scene={scene}
        sheetPx={selected ? sheetPx : 0}
        onSelect={(id) => {
          setHint(false);
          setMoneyOpen(false);
          select(id);
        }}
      />
      <Overview map={map} active={overview && camera === 'overview'} points={points} listOpen={listOpen} onListOpen={setListOpen} onPick={pick} />

      <header className="topbar">
        <PlayerChip city={city} />
        <MoneyChip
          open={moneyOpen}
          onToggle={() => {
            // Money opens over the map, so a task sheet closes first.
            if (selected) {
              select(null);
              setMoneyOpen(true);
            } else setMoneyOpen((o) => !o);
          }}
        />
      </header>
      <MoneyPanel open={moneyOpen} onClose={() => setMoneyOpen(false)} />
      <MapControls overview={overview} locating={locating} hidden={!!selected || status !== 'ready' || listOpen || moneyOpen} onToggleView={toggleView} onLocate={locate} />
      <Toasts />
      <Hint visible={hint && status === 'ready' && !selected && !listOpen && !moneyOpen} overview={overview} />
      <Attribution />

      <BottomSheet open={!!selected} onClose={close} onHeight={onSheetHeight} label={selected ? selected.itemName : 'Task'}>
        {selected && (
          <TaskSheet
            point={selected}
            reach={reach}
            onClose={close}
            onWalk={() => {
              scene?.walkToPoint(selected.id);
              close();
            }}
            onTake={() => {
              void take(selected.id);
              scene?.walkToPoint(selected.id);
            }}
          />
        )}
      </BottomSheet>
      <SimulatedPayPal />
      <LoadingVeil state={status} step={step} onRetry={() => setAttempt((n) => n + 1)} />
    </div>
  );
}
