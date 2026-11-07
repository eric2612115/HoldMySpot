import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import * as THREE from 'three';
import type { CityConfig } from '../config/cities';
import type { TaskPoint } from '../domain/types';
import { Chibi } from '../three/characters/chibi';
import { castSpec, QUEUER_VARIANTS } from '../three/characters/presets';
import { PathDots, TapMarker } from '../three/effects/effects';
import { TaskBeacon } from '../three/items/beacon';
import { createOutlineSettings } from '../three/materials/toon';
import { createProp, type PropName } from '../three/props/kaykit';
import { bearingAxes, LocalFrame } from './geo';
import { buildRoadGraph, findWalk, pathLength, snapToGraph, type RoadGraph, type Vec2 } from './roadGraph';

/** Character height is about 2 units, so this makes people about 20 m tall: big enough to read on a phone. */
const CHAR_SCALE = 10;
const BEACON_SCALE = 8.5;
const WALK_SPEED = 15; // metres per second, at map scale
const GRAPH_RADIUS = 750;
const WALKABLE = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'living_street', 'pedestrian', 'track']);
const WALKABLE_PATHS = new Set(['pedestrian', 'path', 'living_street']);
/**
 * Where a queue line starts (metres from the item, along the street) and how
 * far apart people stand. A line that runs toward the camera starts further
 * out, so the people in it never stand in front of the item.
 */
const LINE_START = 13;
const LINE_START_NEAR = 26;
const LINE_GAP = 7.5;
const LINE_SIDE = 6;
/** Items stand on the sidewalk next to their line, so people walking the street pass beside them. */
const SHOP_SIDE = 6.5;
/** Layer for the player's see-through silhouette. */
const XRAY_LAYER = 1;
/** Shops further than this from the start get no 3D model until the camera flies there. */
const NEAR_RADIUS = 900;
/** Below this zoom the 3D layer is not drawn (the overview shows dots instead). */
const MIN_3D_ZOOM = 15;
/** Street-view zoom limits; the overview opens the map out to OVERVIEW_MIN_ZOOM. */
const STREET_MIN_ZOOM = 16.2;
const OVERVIEW_MIN_ZOOM = 10.5;

/** 0 when nobody is asking, 1 when demand is very high: more requests and a higher top fee glow brighter. */
export function demandOf(p: Pick<TaskPoint, 'bidCount' | 'bestFeeCents'>): number {
  const count = Math.min(1, p.bidCount / 12);
  const fee = Math.min(1, (p.bestFeeCents ?? 0) / 1500);
  return Math.max(0, Math.min(1, count * 0.7 + fee * 0.3));
}

/** The camera: following the player in the tilted street view, flying, or the top-down overview. */
export type CameraMode = 'street' | 'flying' | 'overview';

/** A label anchor in CSS pixels of the map container. */
export interface LabelAnchor {
  x: number;
  y: number;
  /** Shrinks far labels a little. */
  scale: number;
  /** False when the thing it points at is off screen or not shown yet. */
  visible: boolean;
}

export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LabelSink {
  /** Called first each frame with things labels must not cover (the player). */
  begin?(avoid: ScreenRect[]): void;
  place(id: string, anchor: LabelAnchor): void;
  /** Called once per frame after every label was placed. */
  commit?(): void;
}

export interface MapSceneEvents {
  onSelect(pointId: string): void;
  onReady(): void;
  onWalk?(): void;
  /** The camera changed mode (street, flying, overview). */
  onCamera?(mode: CameraMode): void;
  /** The player moved (walked or was placed), as [lng, lat]. */
  onPlayerMoved?(lngLat: [number, number]): void;
}

interface Npc {
  id: string;
  chibi: Chibi;
  pos: Vec2;
  path: Vec2[] | null;
  pathIdx: number;
  home: Vec2;
  wait: number;
  /** queue: stands in a line; wander: walks the streets; server: walks where the server says (queuer.moved). */
  mode: 'queue' | 'wander' | 'server';
  speed: number;
  pointId?: string;
  tagPointId?: string;
  /** A walker who shuttles between two spots instead of wandering. */
  patrol?: [Vec2, Vec2];
  /** A server walker standing in a shop's line: the way the line faces once they arrive. */
  lineDir?: Vec2;
  /** A server walker passing the player steps to this side of them (1 right, -1 left on screen). */
  dodge?: 1 | -1;
  /** A server walker's place in a shop's line (0 at the front), so people near the player step aside to alternate sides. */
  lineIndex?: number;
  /** Where the walker is drawn (eased, so stepping aside is a glide, not a jump). */
  shown?: Vec2;
}

interface QueueLine {
  /** The point on the street centre in front of the shop. */
  origin: Vec2;
  /** Unit vector along the street, pointing from the item down the line. */
  dir: Vec2;
  /** Unit vector across the street, toward the sidewalk the line stands on. */
  side: Vec2;
  /** Metres from the item to the first person. */
  start: number;
  /** The next free spot at the back of the line. */
  end: Vec2;
}

interface PlacedBeacon {
  beacon: TaskBeacon;
  pos: Vec2;
  line: QueueLine;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return !!el.closest('input, textarea, select, [contenteditable="true"], [role="slider"], .sheet, .money');
}

export class MapScene implements CustomLayerInterface {
  readonly id = 'holdmyspot-3d';
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  private map: MapLibreMap | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly frame: LocalFrame;
  private readonly outline = createOutlineSettings(0.05);
  private readonly mvp = new THREE.Matrix4();
  private readonly cameraPos = new THREE.Vector3();
  private readonly tmp4 = new THREE.Vector4();
  /**
   * The player's see-through silhouette. Drawn before the scene, against the
   * map's buildings only, so it shows exactly where a building hides the
   * player (and never where the player's own parts overlap).
   */
  private readonly xray = new THREE.MeshBasicMaterial({
    color: '#A79BF7',
    depthFunc: THREE.GreaterDepth,
    depthWrite: false,
  });

  readonly player: Chibi;
  private readonly youRing: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private playerPos: Vec2 = { x: 0, z: 0 };
  private path: Vec2[] | null = null;
  private pathIdx = 0;
  private walked = 0;
  private walkTime = 0;
  private pathTotal = 0;
  private idleFor = 0;
  /** Set by "Walk there": on arrival, stand in line facing the shop. */
  private joinLine: Vec2 | null = null;
  private inLine = false;
  private graph: RoadGraph | null = null;
  private readonly beacons = new Map<string, PlacedBeacon>();
  private pointsById = new Map<string, TaskPoint>();
  private mode: CameraMode = 'street';
  /** Where the camera rests in the street view when nothing is selected (after flying to a far shop); null follows the player. */
  private anchor: Vec2 | null = null;
  private reported = { x: NaN, z: NaN, t: 0 };
  private readonly npcs: Npc[] = [];
  private readonly marker = new TapMarker();
  private readonly dots = new PathDots();
  private labels: LabelSink | null = null;
  private ready = false;

  // Camera state.
  private camCenter: Vec2 = { x: 0, z: 0 };
  private focus: Vec2 | null = null;
  private selectedId: string | null = null;
  private bearing: number;
  private pitch: number;
  private padTop = 0;
  private padBottom = 0;
  private sheetPx = 0;
  /** Zoom offset applied while a sheet is open (eased; the user's own zoom is kept). */
  private zoomShift = 0;
  private lastCam = { x: NaN, z: NaN, b: NaN, p: NaN, t: NaN, bo: NaN };

  // Input.
  private drag: { id: number; x0: number; y0: number; b0: number; p0: number; moved: boolean } | null = null;
  private pointers = new Set<number>();
  private keys = new Set<string>();
  /** A touch tap that opened a sheet: swallow its touchend so no click lands on the new sheet. */
  private swallowTouchEnd = false;

  private raf = 0;
  private last = performance.now();
  private readonly events: MapSceneEvents;
  private readonly city: CityConfig;
  private readonly rnd: () => number;

  constructor(city: CityConfig, events: MapSceneEvents) {
    this.city = city;
    this.events = events;
    this.frame = new LocalFrame(city.start);
    this.bearing = city.bearing;
    this.pitch = city.pitch;
    let seed = 7;
    this.rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };

    this.scene.add(new THREE.HemisphereLight('#FFFFFF', '#D9D2F2', 1.9));
    const sun = new THREE.DirectionalLight('#FFF8EE', 1.55);
    sun.position.set(-30, 90, 45);
    this.scene.add(sun, sun.target);

    this.player = new Chibi(castSpec('player'), this.outline);
    this.player.root.scale.setScalar(CHAR_SCALE);
    // A soft ring under the player, so you can always find yourself.
    this.youRing = new THREE.Mesh(
      new THREE.RingGeometry(0.62, 0.8, 48),
      new THREE.MeshBasicMaterial({ color: '#6C5CE7', transparent: true, opacity: 0.55, depthWrite: false }),
    );
    this.youRing.rotation.x = -Math.PI / 2;
    this.youRing.position.y = 0.02;
    this.youRing.renderOrder = 4;
    this.player.root.add(this.youRing);
    this.player.face(((180 - city.bearing) * Math.PI) / 180 + Math.PI, true);
    // The player's body also draws as a soft silhouette wherever a building hides it.
    this.player.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && (mesh.material instanceof THREE.MeshToonMaterial || mesh === this.youRing)) mesh.layers.enable(XRAY_LAYER);
    });
    this.scene.add(this.player.root, this.marker.root, this.dots.mesh);
  }

  // ------------------------------------------------------------ public API

  setLabelSink(sink: LabelSink | null) {
    this.labels = sink;
  }

  /** Places task points once the streets are known. Safe to call again with fresh data. */
  setPoints(points: TaskPoint[]) {
    this.pointsById = new Map(points.map((p) => [p.id, p]));
    if (!this.graph) {
      this.pendingPoints = points;
      return;
    }
    let i = 0;
    for (const p of points) {
      let placed = this.beacons.get(p.id);
      if (!placed) {
        const at = this.frame.toLocal(p.lngLat[0], p.lngLat[1]);
        // Far shops wait until the camera flies there; near ones pop in now, one after another.
        if (Math.hypot(at.x - this.playerPos.x, at.z - this.playerPos.z) > NEAR_RADIUS) continue;
        placed = this.placeBeacon(p, at, 0.35 + i * 0.22, i);
        i += 1;
      }
      placed.beacon.setDemand(demandOf(p));
    }
  }

  /** Creates the 3D beacon of a shop (with its line and props) at a local position, snapped to a street when one is near. */
  private placeBeacon(p: TaskPoint, at: Vec2, delay: number, index: number): PlacedBeacon {
    const beacon = new TaskBeacon(p.look, p.hue, this.outline);
    beacon.root.scale.setScalar(BEACON_SCALE);
    const snap = this.graph ? snapToGraph(this.graph, at) : null;
    const street = snap && snap.dist < 60 ? { ...snap.point } : at;
    const line = this.lineFor(street);
    const pos = { x: street.x + line.side.x * SHOP_SIDE, z: street.z + line.side.z * SHOP_SIDE };
    beacon.root.position.set(pos.x, 0, pos.z);
    beacon.appear(delay);
    this.scene.add(beacon.root);
    const placed = { beacon, pos, line };
    this.beacons.set(p.id, placed);
    this.spawnQueue(p, placed, index);
    this.decorate(p, line);
    beacon.setDemand(demandOf(p));
    return placed;
  }

  /** Makes sure a shop has its 3D beacon (far shops get one when the camera flies there). */
  private ensureBeacon(pointId: string): PlacedBeacon | null {
    const existing = this.beacons.get(pointId);
    if (existing) return existing;
    const p = this.pointsById.get(pointId);
    if (!p || !this.ready) return null;
    const at = this.frame.toLocal(p.lngLat[0], p.lngLat[1]);
    return this.placeBeacon(p, at, 0.1, this.beacons.size);
  }

  private pendingPoints: TaskPoint[] | null = null;

  bump(pointId: string) {
    this.beacons.get(pointId)?.beacon.bump();
  }

  /** Highlights a point and frames it above the bottom sheet (or returns to the player). */
  select(pointId: string | null, sheetHeightPx = 0) {
    if (pointId) this.ensureBeacon(pointId);
    for (const [id, b] of this.beacons) b.beacon.selected = id === pointId;
    const target = pointId ? this.beacons.get(pointId) : undefined;
    this.selectedId = target ? pointId : null;
    this.focus = target ? { ...target.pos } : null;
    this.sheetPx = target ? sheetHeightPx : 0;
    if (target) this.keys.clear();
  }

  /** Walks to the back of the point's queue line (not into the item) and stands in line. */
  walkToPoint(pointId: string) {
    const b = this.beacons.get(pointId);
    if (!b) return;
    this.walkTo({ ...b.line.end }, b);
  }

  /** Something was won: the people at that shop and the player hop, and the item bounces. */
  celebrate(pointId: string | null) {
    this.player.hop(2);
    if (!pointId) return;
    this.beacons.get(pointId)?.beacon.bump();
    for (const npc of this.npcs) if (npc.pointId === pointId) npc.chibi.hop(2);
  }

  /** Straight-line distance from the player to a task point, in metres. */
  distanceTo(pointId: string): number | null {
    const b = this.beacons.get(pointId);
    if (b) return Math.hypot(b.pos.x - this.playerPos.x, b.pos.z - this.playerPos.z);
    const p = this.pointsById.get(pointId);
    if (!p) return null;
    const at = this.frame.toLocal(p.lngLat[0], p.lngLat[1]);
    return Math.hypot(at.x - this.playerPos.x, at.z - this.playerPos.z);
  }

  /** The player's position as [lng, lat]. */
  playerLngLat(): [number, number] {
    return this.frame.toLngLat(this.playerPos.x, this.playerPos.z);
  }

  get cameraMode(): CameraMode {
    return this.mode;
  }

  /** Avatars of queuers the server walks over (demo walks, synthetic positions), by user id. */
  private readonly serverWalkers = new Map<string, Npc>();
  /** Server walkers who reached a shop's line, by task point, in the order they arrived. */
  private readonly lineWalkers = new Map<string, string[]>();

  /**
   * Follows the server's walking queuers (queuer.moved: synthetic demo walks).
   * Each avatar walks along the streets to the latest reported spot, and joins
   * the back of a shop's line when the spot is that shop. Avatars the server
   * no longer reports are taken off the map.
   */
  setServerWalkers(walkers: Record<string, { lngLat: [number, number] } | undefined>) {
    if (!this.ready || !this.graph) return;
    for (const [id, npc] of this.serverWalkers) {
      if (walkers[id]) continue;
      this.scene.remove(npc.chibi.root);
      this.serverWalkers.delete(id);
      this.npcs.splice(this.npcs.indexOf(npc), 1);
      for (const order of this.lineWalkers.values()) if (order.includes(id)) order.splice(order.indexOf(id), 1);
    }
    for (const [id, w] of Object.entries(walkers)) if (w) this.moveServerWalker(id, w.lngLat);
  }

  private moveServerWalker(userId: string, lngLat: [number, number]) {
    const graph = this.graph;
    if (!graph) return;
    const raw = this.frame.toLocal(lngLat[0], lngLat[1]);
    let npc = this.serverWalkers.get(userId);
    // Only the neighbourhood this view has streets for.
    if (Math.hypot(raw.x - graph.center.x, raw.z - graph.center.z) > GRAPH_RADIUS) {
      if (npc) npc.chibi.root.visible = false;
      return;
    }
    const snap = snapToGraph(graph, raw);
    let goal = snap && snap.dist < 60 ? { ...snap.point } : raw;
    let lineDir: Vec2 | undefined;
    let lineIndex: number | undefined;
    // At a shop: the back of its line, behind the people already in it.
    for (const [pid, b] of this.beacons) {
      if (Math.hypot(b.pos.x - raw.x, b.pos.z - raw.z) >= 45) continue;
      const order = this.lineWalkers.get(pid) ?? [];
      if (!order.includes(userId)) order.push(userId);
      this.lineWalkers.set(pid, order);
      const standing = this.npcs.filter((n) => n.mode === 'queue' && n.pointId === pid).length;
      lineIndex = standing + order.indexOf(userId);
      goal = this.lineSpot(b.line, lineIndex);
      lineDir = { x: -b.line.dir.x, z: -b.line.dir.z };
    }
    if (!npc) {
      const variant = QUEUER_VARIANTS[(this.serverWalkers.size + 2) % QUEUER_VARIANTS.length];
      const chibi = new Chibi({ ...castSpec('queuer', 70 + this.serverWalkers.size), ...variant, palette: { ...variant.palette } }, this.outline);
      chibi.root.scale.setScalar(CHAR_SCALE * 0.92);
      chibi.root.position.set(goal.x, 0, goal.z);
      this.scene.add(chibi.root);
      npc = { id: `server:${userId}`, chibi, pos: { ...goal }, path: null, pathIdx: 0, home: { ...goal }, wait: 0, mode: 'server', speed: 9 };
      this.serverWalkers.set(userId, npc);
      this.npcs.push(npc);
      return;
    }
    npc.chibi.root.visible = true;
    npc.lineDir = lineDir;
    npc.lineIndex = lineIndex;
    if (Math.hypot(goal.x - npc.pos.x, goal.z - npc.pos.z) < 1) return;
    npc.path = findWalk(graph, npc.pos, goal) ?? [npc.pos, goal];
    npc.pathIdx = 1;
    // Reach the new spot in about half a second: the server reports a walk every 30 market seconds.
    npc.speed = Math.max(9, pathLength(npc.path) / 0.55);
  }

  /**
   * Where a walker is drawn: never over the player. Characters are tall on this map, so
   * anyone within a few metres of the player along the view would cover them on screen; such a
   * walker steps to the side (the same side until they are past).
   */
  private clearOfPlayer(npc: Npc): Vec2 {
    const { forward, right } = bearingAxes(this.bearing);
    const dx = npc.pos.x - this.playerPos.x;
    const dz = npc.pos.z - this.playerPos.z;
    const f = dx * forward.x + dz * forward.z;
    const r = dx * right.x + dz * right.z;
    const half = 10;
    if (f < -10 || f > 34 || Math.abs(r) >= half) {
      npc.dodge = undefined;
      return npc.pos;
    }
    // People in a line near the player step aside to alternate sides, so they never stack up.
    if (npc.lineIndex !== undefined && !npc.path) npc.dodge = npc.lineIndex % 2 === 0 ? 1 : -1;
    else npc.dodge ??= r >= 0 ? 1 : -1;
    const shift = npc.dodge * half - r;
    return { x: npc.pos.x + right.x * shift, z: npc.pos.z + right.z * shift };
  }

  /** Draws a walker where clearOfPlayer says, easing toward it. */
  private placeWalker(npc: Npc, dt: number) {
    const target = this.clearOfPlayer(npc);
    const k = 1 - Math.exp(-dt * 8);
    const prev = npc.shown ?? target;
    npc.shown = { x: prev.x + (target.x - prev.x) * k, z: prev.z + (target.z - prev.z) * k };
    npc.chibi.root.position.set(npc.shown.x, 0, npc.shown.z);
  }

  /** The task point whose offer the walking queuer carries (the tag above their head), if any. */
  get walkerTagPointId(): string | null {
    return this.npcs.find((n) => n.tagPointId)?.tagPointId ?? null;
  }

  private setMode(mode: CameraMode) {
    if (this.mode === mode) return;
    this.mode = mode;
    const map = this.map;
    if (map) {
      if (mode === 'overview') {
        map.dragPan.enable();
        map.scrollZoom.enable();
        map.touchZoomRotate.enable();
        map.touchZoomRotate.disableRotation();
      } else if (mode === 'street') {
        map.dragPan.disable();
        map.scrollZoom.enable({ around: 'center' });
        map.touchZoomRotate.enable({ around: 'center' });
        map.touchZoomRotate.disableRotation();
      } else {
        // While flying, no gesture can stop the camera halfway: only a newer flight can.
        map.dragPan.disable();
        map.scrollZoom.disable();
        map.touchZoomRotate.disable();
      }
    }
    if (mode !== 'street') {
      this.drag = null;
      this.keys.clear();
    }
    this.events.onCamera?.(mode);
  }

  /** Counts camera flights, so a flight that a newer one interrupted never runs its landing. */
  private flight = 0;

  /**
   * Flies the camera and runs `landed` when it gets there. Starting a flight
   * while another is on its way cancels the older one's landing (MapLibre
   * ends the older flight with a moveend of its own, which is ignored here),
   * and a moveend in the middle of a flight (a resize) does not count as
   * arriving.
   */
  private fly(options: Omit<Parameters<MapLibreMap['flyTo']>[0], 'essential'> & { zoom: number; pitch: number; bearing: number }, landed: () => void) {
    const map = this.map;
    if (!map) return;
    const token = ++this.flight;
    this.setMode('flying');
    map.flyTo({ ...options, essential: true });
    // There: the flight's last frame put the camera on the target (a moveend mid-flight, from a resize, is not).
    const there = () => Math.abs(map.getZoom() - options.zoom) < 0.01 && Math.abs(map.getPitch() - options.pitch) < 0.1 && Math.abs(((map.getBearing() - options.bearing + 540) % 360) - 180) < 0.1;
    if (!map.isMoving()) {
      // Nothing to animate: already there.
      if (token === this.flight) landed();
      return;
    }
    const arrived = () => {
      if (token !== this.flight) {
        map.off('moveend', arrived);
        return;
      }
      if (map.isMoving() && !there()) return;
      map.off('moveend', arrived);
      landed();
    };
    map.on('moveend', arrived);
  }

  /**
   * The top-down overview: pitch 0, north up, zoomed out over every task point
   * of the city (and the player). The camera flies there smoothly.
   */
  showOverview(points: Array<{ lngLat: [number, number] }>, padding = { top: 160, bottom: 120, left: 36, right: 36 }) {
    const map = this.map;
    if (!map || !this.ready || this.mode === 'overview') return;
    this.focus = null;
    this.selectedId = null;
    for (const b of this.beacons.values()) b.beacon.selected = false;
    map.setMinZoom(OVERVIEW_MIN_ZOOM);
    const me = this.playerLngLat();
    // Fit every task point and the player, north up, in the screen minus the bars (MapLibre's
    // own fit would also subtract the street view's large top padding).
    const merc = (ll: [number, number]) => {
      const x = (ll[0] + 180) / 360;
      const s = Math.sin((ll[1] * Math.PI) / 180);
      return { x, y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) };
    };
    const all = [me, ...points.map((p) => p.lngLat)].map(merc);
    const x0 = Math.min(...all.map((p) => p.x));
    const x1 = Math.max(...all.map((p) => p.x));
    const y0 = Math.min(...all.map((p) => p.y));
    const y1 = Math.max(...all.map((p) => p.y));
    const el = map.getContainer();
    const availW = Math.max(120, el.clientWidth - padding.left - padding.right);
    const availH = Math.max(120, el.clientHeight - padding.top - padding.bottom);
    const fit = Math.min(Math.log2(availW / (Math.max(1e-9, x1 - x0) * 512)), Math.log2(availH / (Math.max(1e-9, y1 - y0) * 512)));
    const zoom = Math.max(OVERVIEW_MIN_ZOOM, Math.min(15.5, fit));
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2 + ((padding.top - padding.bottom) / 2) / (512 * 2 ** zoom);
    const center: [number, number] = [cx * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * cy))) * 180) / Math.PI];
    this.fly({ center, zoom, pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 1500, curve: 1.25 }, () => this.setMode('overview'));
  }

  /** Flies from wherever the camera is down into the tilted street view at a shop, and selects it. */
  flyToPoint(pointId: string, onLanded?: () => void) {
    const map = this.map;
    const p = this.pointsById.get(pointId);
    if (!map || !this.ready || !p) return;
    const at = this.frame.toLocal(p.lngLat[0], p.lngLat[1]);
    this.flyDown(at, () => {
      const b = this.ensureBeacon(pointId);
      if (b) this.anchor = { ...b.pos };
      onLanded?.();
    });
  }

  /** "Back to me": flies to the player's avatar from either view and follows it again. */
  flyHome() {
    const map = this.map;
    if (!map || !this.ready) return;
    this.anchor = null;
    this.focus = null;
    const here = this.frame.toLocal(...this.frame.toLngLat(this.camCenter.x, this.camCenter.z));
    const far = Math.hypot(here.x - this.playerPos.x, here.z - this.playerPos.z) > 350;
    if (this.mode === 'street' && !far) {
      this.player.hop(1);
      return;
    }
    this.flyDown({ ...this.playerPos }, () => this.player.hop(1));
  }

  /** Places the player at a new position (a GPS fix), snapped to a street. */
  placePlayer(lngLat: [number, number]) {
    if (!this.ready) return;
    const at = this.frame.toLocal(lngLat[0], lngLat[1]);
    if (this.graph && Math.hypot(at.x - this.graph.center.x, at.z - this.graph.center.z) > GRAPH_RADIUS - 120) {
      this.graph = this.readGraph(at) ?? this.graph;
    }
    const snap = this.graph ? snapToGraph(this.graph, at) : null;
    this.playerPos = snap && snap.dist < 80 ? { ...snap.point } : at;
    this.path = null;
    this.dots.clear();
    this.marker.hide();
    this.reportPlayer(true);
  }

  private flyDown(target: Vec2, landed: () => void) {
    const map = this.map;
    if (!map) return;
    const h = map.getContainer().clientHeight;
    map.setMinZoom(OVERVIEW_MIN_ZOOM);
    const options = {
      center: this.frame.toLngLat(target.x, target.z),
      zoom: this.city.zoom,
      pitch: this.pitch,
      bearing: this.bearing,
      padding: { top: h * 0.46, bottom: 0, left: 0, right: 0 },
      duration: 1900,
      curve: 1.3,
    };
    this.fly(options, () => {
      map.setMinZoom(STREET_MIN_ZOOM);
      this.camCenter = { ...target };
      this.padTop = h * 0.46;
      this.padBottom = 0;
      this.zoomShift = 0;
      this.lastCam = { x: NaN, z: NaN, b: NaN, p: NaN, t: NaN, bo: NaN };
      const far = this.graph && Math.hypot(target.x - this.graph.center.x, target.z - this.graph.center.z) > GRAPH_RADIUS - 150;
      if (far) {
        // New streets came into view: read them once the tiles are in.
        map.once('idle', () => {
          this.graph = this.readGraph(target) ?? this.graph;
        });
      }
      this.setMode('street');
      landed();
    });
  }

  private reportPlayer(force = false) {
    const now = performance.now();
    const r = this.reported;
    if (!force && (now - r.t < 400 || Math.hypot(this.playerPos.x - r.x, this.playerPos.z - r.z) < 3)) return;
    this.reported = { x: this.playerPos.x, z: this.playerPos.z, t: now };
    this.events.onPlayerMoved?.(this.playerLngLat());
  }

  // ------------------------------------------------------------ layer hooks

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
    const box = map.getCanvasContainer();
    box.addEventListener('pointerdown', this.onPointerDown);
    box.addEventListener('touchend', this.onTouchEnd, { passive: false });
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    window.addEventListener('blur', this.onBlur);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  onRemove() {
    cancelAnimationFrame(this.raf);
    const box = this.map?.getCanvasContainer();
    box?.removeEventListener('pointerdown', this.onPointerDown);
    box?.removeEventListener('touchend', this.onTouchEnd);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    window.removeEventListener('blur', this.onBlur);
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m) => m?.dispose());
      }
    });
    this.xray.dispose();
    this.renderer?.dispose();
    this.renderer = null;
    this.map = null;
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const renderer = this.renderer;
    const map = this.map;
    if (!renderer || !map) return;
    if (map.getZoom() < MIN_3D_ZOOM) {
      // The overview shows dots; nothing in 3D is big enough to read up there.
      this.placeLabels();
      return;
    }
    this.mvp.fromArray(args.defaultProjectionData.mainMatrix as ArrayLike<number> as number[]).multiply(this.frame.toMercator);
    this.camera.projectionMatrix.copy(this.mvp);
    this.camera.projectionMatrixInverse.copy(this.mvp).invert();
    // Camera position in local space: the point the projection sends to w = 0.
    this.tmp4.set(0, 0, 1, 0).applyMatrix4(this.camera.projectionMatrixInverse);
    if (Math.abs(this.tmp4.w) > 1e-12) this.cameraPos.set(this.tmp4.x / this.tmp4.w, this.tmp4.y / this.tmp4.w, this.tmp4.z / this.tmp4.w);

    const dpr = map.getPixelRatio();
    for (const { beacon } of this.beacons.values()) beacon.billboard(this.cameraPos, dpr);

    renderer.resetState();
    renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    // First pass: the player's silhouette wherever a building stands in front of it.
    this.scene.overrideMaterial = this.xray;
    this.camera.layers.set(XRAY_LAYER);
    renderer.render(this.scene, this.camera);
    this.camera.layers.set(0);
    this.scene.overrideMaterial = null;
    renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  // ------------------------------------------------------------ world setup

  /** Call when tiles for the view have loaded. Builds the street graph and places everything. */
  buildWorld(home: [number, number] = this.city.start) {
    const map = this.map;
    if (!map) return;
    const start = this.frame.toLocal(home[0], home[1]);
    this.graph = this.readGraph(start);
    const snap = this.graph ? snapToGraph(this.graph, start) : null;
    this.playerPos = snap && snap.dist < 120 ? { ...snap.point } : start;
    this.camCenter = { ...this.playerPos };
    this.player.root.position.set(this.playerPos.x, 0, this.playerPos.z);
    if (this.pendingPoints) {
      const pts = this.pendingPoints;
      this.pendingPoints = null;
      this.setPoints(pts);
    }
    this.spawnWalkers();
    this.ready = true;
    this.reportPlayer(true);
    this.events.onReady();
  }

  private readGraph(center: Vec2): RoadGraph | null {
    const map = this.map;
    if (!map) return null;
    const sourceId = Object.entries(map.getStyle().sources).find(([, s]) => s.type === 'vector')?.[0];
    if (!sourceId) return null;
    const lines: Vec2[][] = [];
    for (const f of map.querySourceFeatures(sourceId, { sourceLayer: 'transportation' })) {
      const props = f.properties ?? {};
      const cls = String(props.class ?? '');
      const sub = String(props.subclass ?? '');
      if (props.brunnel === 'tunnel') continue;
      if (!WALKABLE.has(cls) && !(cls === 'path' && WALKABLE_PATHS.has(sub))) continue;
      const g = f.geometry;
      const toLocal = (c: number[]) => this.frame.toLocal(c[0], c[1]);
      if (g.type === 'LineString') lines.push(g.coordinates.map(toLocal));
      else if (g.type === 'MultiLineString') for (const l of g.coordinates) lines.push(l.map(toLocal));
    }
    if (lines.length === 0) return null;
    const graph = buildRoadGraph(lines, center, GRAPH_RADIUS);
    return graph.edges.length > 0 ? graph : null;
  }

  /** Direction of the street at a point (unit vector), for lining people up. */
  private streetDir(p: Vec2): Vec2 {
    if (!this.graph) return { x: 1, z: 0 };
    const snap = snapToGraph(this.graph, p);
    if (!snap) return { x: 1, z: 0 };
    const e = this.graph.edges[snap.edge];
    const a = this.graph.nodes[e.a];
    const b = this.graph.nodes[e.b];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
  }

  /**
   * Which way a shop's line runs. Lines run toward the camera when the street
   * allows it, so the people in line stand in front of the item and its label
   * floats above them instead of over their faces. On a street across the
   * view, the line runs toward the middle of the screen.
   */
  private lineFor(pos: Vec2): QueueLine {
    let dir = this.streetDir(pos);
    const { forward, right } = bearingAxes(this.city.bearing);
    const along = dir.x * forward.x + dir.z * forward.z;
    if (Math.abs(along) > 0.4) {
      if (along > 0) dir = { x: -dir.x, z: -dir.z };
    } else {
      const toPlayer = (this.playerPos.x - pos.x) * right.x + (this.playerPos.z - pos.z) * right.z;
      const across = dir.x * right.x + dir.z * right.z;
      if (Math.sign(across) !== Math.sign(toPlayer || 1)) dir = { x: -dir.x, z: -dir.z };
    }
    // Stand on the sidewalk nearer the camera; on a street along the view, the
    // one away from the middle of the screen, so the line keeps clear of the player.
    let side = { x: -dir.z, z: dir.x };
    if (Math.abs(along) > 0.4) {
      const outward = (pos.x - this.playerPos.x) * right.x + (pos.z - this.playerPos.z) * right.z;
      if (Math.sign(side.x * right.x + side.z * right.z) !== Math.sign(outward || 1)) side = { x: -side.x, z: -side.z };
    } else if (side.x * forward.x + side.z * forward.z > 0) side = { x: -side.x, z: -side.z };
    const line: QueueLine = { origin: pos, dir, side, start: Math.abs(along) > 0.4 ? LINE_START_NEAR : LINE_START, end: pos };
    line.end = this.lineSpot(line, 0);
    return line;
  }

  private lineSpot(line: QueueLine, k: number): Vec2 {
    const along = line.start + k * LINE_GAP;
    const o = line.origin;
    return { x: o.x + line.dir.x * along + line.side.x * LINE_SIDE, z: o.z + line.dir.z * along + line.side.z * LINE_SIDE };
  }

  private spawnQueue(p: TaskPoint, placed: PlacedBeacon, index: number) {
    const { line } = placed;
    const names = p.queue.queuers.slice(0, 3);
    names.forEach((name, k) => {
      const variant = QUEUER_VARIANTS[(index + k) % QUEUER_VARIANTS.length];
      const spec = { ...castSpec('queuer', 10 + index * 3 + k), ...variant, palette: { ...variant.palette }, name };
      const chibi = new Chibi(spec, this.outline);
      chibi.root.scale.setScalar(CHAR_SCALE * 0.92);
      const npcPos = this.lineSpot(line, k);
      chibi.root.position.set(npcPos.x, 0, npcPos.z);
      chibi.faceTowards(-line.dir.x, -line.dir.z, true);
      this.scene.add(chibi.root);
      this.npcs.push({ id: `${p.id}:${name}`, chibi, pos: npcPos, path: null, pathIdx: 0, home: npcPos, wait: 1e9, mode: 'queue', speed: 0, pointId: p.id });
    });
    line.end = this.lineSpot(line, names.length);
  }

  /** People walking around; one carries an ask (a queuer offering to stand in line). */
  private spawnWalkers() {
    if (!this.graph) return;
    const near = [...this.beacons.keys()].map((id) => this.pointsById.get(id)).filter((p): p is TaskPoint => !!p);
    const asks = (near.find((p) => p.offers.some((o) => !o.checkedIn)) ?? near.find((p) => p.offers.length > 0 && p.id !== near[0]?.id))?.id;
    const looks: Array<{ role: 'passerby' | 'buyer'; tag?: string }> = [{ role: 'passerby', tag: asks }, { role: 'buyer' }];
    const { forward, right } = bearingAxes(this.city.bearing);
    const onStreet = ([r, f]: [number, number]): Vec2 => {
      const raw = { x: this.playerPos.x + right.x * r + forward.x * f, z: this.playerPos.z + right.z * r + forward.z * f };
      const snap = snapToGraph(this.graph!, raw);
      return snap ? { ...snap.point } : raw;
    };
    looks.forEach((look, i) => {
      const chibi = new Chibi(castSpec(look.role, 30 + i), this.outline);
      chibi.root.scale.setScalar(CHAR_SCALE * 0.95);
      // The queuer with an ask walks a set route back and forth, carrying the ask in
      // view; the other walker wanders the streets.
      const [a, b] = this.city.walkerRoute;
      const patrol: [Vec2, Vec2] | undefined = look.tag ? [onStreet(a), onStreet(b)] : undefined;
      // Start halfway along the route, in the clear between the labels.
      const pos = patrol ? onStreet([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]) : onStreet([-50, 140]);
      chibi.root.position.set(pos.x, 0, pos.z);
      this.scene.add(chibi.root);
      this.npcs.push({ id: `walker-${i}`, chibi, pos, path: null, pathIdx: 0, home: pos, wait: 0.5 + i, mode: 'wander', speed: 9, tagPointId: look.tag, patrol });
    });
  }

  private decorate(p: TaskPoint, line: QueueLine) {
    // Props stand on the far side of the item from the line, so nobody stands inside a bench.
    const pos = line.origin;
    const dir = { x: -line.dir.x, z: -line.dir.z };
    const side = line.side;
    const sets: Record<string, Array<[PropName, number, number, number]>> = {
      cake: [['table_round_A_small_decorated', 10, 12, 0], ['chair_A', 16, 12, 1.6], ['menu', 9, -12, 0]],
      plush: [['box_A', 9, 12, 0.4], ['box_B', 12, 13, 1.1], ['streetlight', 14, -14, 0]],
      ramen: [['crate_buns', 9, 12, 0.3], ['bench', 10, -13, 0], ['menu', 14, 13, 0.6]],
    };
    for (const [name, along, across, rot] of sets[p.kind] ?? []) {
      createProp(name)
        .then((prop) => {
          prop.position.set(pos.x + dir.x * along + side.x * across, 0, pos.z + dir.z * along + side.z * across);
          prop.rotation.y = Math.atan2(side.x, side.z) + rot;
          this.scene.add(prop);
        })
        .catch(() => {
          /* Props are decoration; the map works without them. */
        });
    }
  }

  // ------------------------------------------------------------ movement

  walkTo(target: Vec2, line?: PlacedBeacon) {
    if (!this.ready) return;
    // A tap right on a shop joins the back of its line instead of walking into the item.
    if (!line) {
      for (const b of this.beacons.values()) {
        if (Math.hypot(target.x - b.pos.x, target.z - b.pos.z) < 16) {
          line = b;
          target = { ...b.line.end };
          break;
        }
      }
    }
    const far = this.graph && Math.hypot(target.x - this.graph.center.x, target.z - this.graph.center.z) > GRAPH_RADIUS - 80;
    if (far) this.graph = this.readGraph(this.playerPos) ?? this.graph;
    const path = (this.graph && findWalk(this.graph, this.playerPos, target)) || [this.playerPos, target];
    // Joining a line, the last leg steps off the street centre onto the spot in line.
    // Any other walk ends on the street, never inside a building.
    const end = path[path.length - 1];
    if (line && Math.hypot(end.x - target.x, end.z - target.z) > 0.5) path.push({ ...target });
    this.path = path;
    this.pathIdx = 1;
    this.walked = 0;
    this.walkTime = 0;
    this.pathTotal = pathLength(path);
    this.joinLine = line ? { ...line.pos } : null;
    this.inLine = false;
    this.anchor = null;
    this.dots.set(path);
    this.marker.show(path[path.length - 1]);
    this.events.onWalk?.();
  }

  private stepPlayer(dt: number) {
    // Keyboard walking: move relative to the camera, then stay on the street.
    const kx = (this.keys.has('d') || this.keys.has('arrowright') ? 1 : 0) - (this.keys.has('a') || this.keys.has('arrowleft') ? 1 : 0);
    const kz = (this.keys.has('w') || this.keys.has('arrowup') ? 1 : 0) - (this.keys.has('s') || this.keys.has('arrowdown') ? 1 : 0);
    if ((kx || kz) && this.ready) {
      this.path = null;
      this.joinLine = null;
      this.inLine = false;
      this.dots.clear();
      this.marker.hide();
      const { forward, right } = bearingAxes(this.bearing);
      const len = Math.hypot(kx, kz);
      const dx = (right.x * kx + forward.x * kz) / len;
      const dz = (right.z * kx + forward.z * kz) / len;
      const next = { x: this.playerPos.x + dx * WALK_SPEED * dt, z: this.playerPos.z + dz * WALK_SPEED * dt };
      const snap = this.graph ? snapToGraph(this.graph, next) : null;
      const pos = snap && snap.dist < 12 ? snap.point : next;
      const mx = pos.x - this.playerPos.x;
      const mz = pos.z - this.playerPos.z;
      if (Math.hypot(mx, mz) > 0.01) this.player.faceTowards(mx, mz);
      this.playerPos = { ...pos };
      this.player.walking = Math.hypot(mx, mz) > 0.02;
      this.focus = null;
    } else if (this.path) {
      this.walkTime += dt;
      const left = this.pathTotal - this.walked;
      const ease = Math.min(1, this.walkTime / 0.3) * clamp(left / 10 + 0.35, 0.35, 1);
      let budget = WALK_SPEED * ease * dt;
      while (budget > 0 && this.path) {
        const target = this.path[this.pathIdx];
        const dx = target.x - this.playerPos.x;
        const dz = target.z - this.playerPos.z;
        const d = Math.hypot(dx, dz);
        if (d <= budget) {
          this.playerPos = { ...target };
          budget -= d;
          this.walked += d;
          this.pathIdx += 1;
          if (this.pathIdx >= this.path.length) this.arrive();
        } else {
          this.playerPos = { x: this.playerPos.x + (dx / d) * budget, z: this.playerPos.z + (dz / d) * budget };
          this.walked += budget;
          budget = 0;
          if (d > 0.4) this.player.faceTowards(dx, dz);
        }
      }
      this.player.walking = this.path !== null;
      this.player.walkRate = 0.75 + ease * 0.35;
    } else {
      this.player.walking = false;
    }
    // Standing still for a moment: turn round to face the camera, like a game
    // character waiting for you. Not while standing in a line.
    this.idleFor = this.player.walking ? 0 : this.idleFor + dt;
    if (!this.inLine && this.idleFor > 1.4 && this.idleFor - dt <= 1.4) {
      const { forward } = bearingAxes(this.bearing);
      this.player.faceTowards(-forward.x, -forward.z);
    }
    this.player.root.position.set(this.playerPos.x, 0, this.playerPos.z);
    this.dots.update(dt, this.path ? this.walked : 1e9);
    if (this.player.walking) {
      this.anchor = null;
      this.reportPlayer();
    }
  }

  private arrive() {
    this.path = null;
    this.marker.hide();
    if (this.joinLine) {
      this.player.faceTowards(this.joinLine.x - this.playerPos.x, this.joinLine.z - this.playerPos.z);
      this.inLine = true;
      this.joinLine = null;
    }
  }

  private stepNpcs(dt: number) {
    for (const npc of this.npcs) {
      if (npc.mode === 'server') {
        let budget = npc.speed * dt;
        while (budget > 0 && npc.path) {
          const t = npc.path[npc.pathIdx];
          const dx = t.x - npc.pos.x;
          const dz = t.z - npc.pos.z;
          const d = Math.hypot(dx, dz);
          if (d <= budget) {
            npc.pos = { ...t };
            budget -= d;
            npc.pathIdx += 1;
            if (npc.pathIdx >= npc.path.length) {
              npc.path = null;
              // In line: face the shop like everyone else in it.
              if (npc.lineDir) npc.chibi.faceTowards(npc.lineDir.x, npc.lineDir.z);
            }
          } else {
            npc.pos = { x: npc.pos.x + (dx / d) * budget, z: npc.pos.z + (dz / d) * budget };
            budget = 0;
            if (d > 0.4) npc.chibi.faceTowards(dx, dz);
          }
        }
        npc.chibi.walking = npc.path !== null;
        npc.chibi.walkRate = Math.min(2.2, 0.85 * Math.max(1, npc.speed / 9) ** 0.5);
        this.placeWalker(npc, dt);
      } else if (npc.mode === 'wander' && this.graph) {
        if (!npc.path) {
          npc.wait -= dt;
          if (npc.wait <= 0 && npc.patrol) {
            const [a, b] = npc.patrol;
            const goal = Math.hypot(npc.pos.x - a.x, npc.pos.z - a.z) < 4 ? b : a;
            npc.path = findWalk(this.graph, npc.pos, goal) ?? [npc.pos, goal];
            npc.pathIdx = 1;
            npc.wait = 2.5;
          } else if (npc.wait <= 0) {
            const nodes = this.graph.nodes;
            for (let tries = 0; tries < 12; tries++) {
              const n = nodes[Math.floor(this.rnd() * nodes.length)];
              const d = Math.hypot(n.x - npc.home.x, n.z - npc.home.z);
              if (d > 40 && d < 170) {
                npc.path = findWalk(this.graph, npc.pos, n);
                npc.pathIdx = 1;
                break;
              }
            }
            npc.wait = 1.5 + this.rnd() * 2.5;
          }
        } else {
          let budget = npc.speed * dt;
          while (budget > 0 && npc.path) {
            const t = npc.path[npc.pathIdx];
            const dx = t.x - npc.pos.x;
            const dz = t.z - npc.pos.z;
            const d = Math.hypot(dx, dz);
            if (d <= budget) {
              npc.pos = { ...t };
              budget -= d;
              npc.pathIdx += 1;
              if (npc.pathIdx >= npc.path.length) npc.path = null;
            } else {
              npc.pos = { x: npc.pos.x + (dx / d) * budget, z: npc.pos.z + (dz / d) * budget };
              budget = 0;
              if (d > 0.4) npc.chibi.faceTowards(dx, dz);
            }
          }
        }
        npc.chibi.walking = npc.path !== null;
        npc.chibi.walkRate = 0.85;
        this.placeWalker(npc, dt);
      }
      npc.chibi.update(dt);
    }
  }

  // ------------------------------------------------------------ camera

  private stepCamera(dt: number) {
    const map = this.map;
    if (!map || this.mode !== 'street') return;
    const desired = this.focus ?? this.anchor ?? this.playerPos;
    const rate = this.focus ? 4.5 : this.path || this.keys.size ? 9 : 6;
    const k = 1 - Math.exp(-dt * rate);
    this.camCenter = {
      x: this.camCenter.x + (desired.x - this.camCenter.x) * k,
      z: this.camCenter.z + (desired.z - this.camCenter.z) * k,
    };
    const h = map.getContainer().clientHeight;
    // Walking around, the player stands low on the screen with the street ahead in view.
    let wantTop = h * 0.46;
    let wantBottom = 0;
    if (this.focus) {
      // With the sheet open, stand the item near the bottom of the strip of map
      // above the sheet, so the item, its glow and its label fit under the top bar.
      const strip = Math.max(0, h - this.sheetPx);
      const ground = strip - Math.min(46, strip * 0.2);
      wantBottom = this.sheetPx;
      wantTop = Math.max(0, 2 * ground - strip);
    }
    const pk = 1 - Math.exp(-dt * 6);
    this.padTop += (wantTop - this.padTop) * pk;
    this.padBottom += (wantBottom - this.padBottom) * pk;
    // While a sheet is open, frame the shop at a fixed, slightly wider zoom (whatever the
    // player had zoomed to), so the shop and its whole line fit the strip under the top bar.
    const base = map.getZoom() - this.zoomShift;
    const shiftTo = this.focus ? Math.max(map.getMinZoom() - base, Math.min(0, this.city.zoom - base) - 0.4) : 0;
    const zoomStep = Math.abs(shiftTo - this.zoomShift) < 0.002 ? shiftTo - this.zoomShift : (shiftTo - this.zoomShift) * pk;
    this.zoomShift += zoomStep;

    const c = this.lastCam;
    const moved =
      zoomStep !== 0 ||
      Math.abs(c.x - this.camCenter.x) > 0.005 ||
      Math.abs(c.z - this.camCenter.z) > 0.005 ||
      c.b !== this.bearing ||
      c.p !== this.pitch ||
      Math.abs(c.t - this.padTop) > 0.25 ||
      Math.abs(c.bo - this.padBottom) > 0.25;
    if (!moved) return;
    this.lastCam = { x: this.camCenter.x, z: this.camCenter.z, b: this.bearing, p: this.pitch, t: this.padTop, bo: this.padBottom };
    map.jumpTo({
      center: this.frame.toLngLat(this.camCenter.x, this.camCenter.z),
      zoom: map.getZoom() + zoomStep,
      bearing: this.bearing,
      pitch: this.pitch,
      padding: { top: Math.max(0, this.padTop), bottom: Math.max(0, this.padBottom), left: 0, right: 0 },
    });
  }

  // ------------------------------------------------------------ frame loop

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    // rAF timestamps can be slightly older than performance.now(), so clamp at 0.
    const dt = clamp((now - this.last) / 1000, 0, 0.05);
    this.last = now;
    if (!this.map) return;
    this.stepPlayer(dt);
    this.player.update(dt);
    const pulse = 0.5 + 0.5 * Math.sin(now / 420);
    this.youRing.scale.setScalar(1 + pulse * 0.08);
    this.youRing.material.opacity = 0.38 + pulse * 0.22;
    this.stepNpcs(dt);
    for (const { beacon } of this.beacons.values()) beacon.update(dt);
    this.marker.update(dt);
    this.stepCamera(dt);
    this.map.triggerRepaint();
  };

  // ------------------------------------------------------------ labels and picking

  private project(x: number, y: number, z: number): { x: number; y: number; w: number } | null {
    const map = this.map;
    if (!map) return null;
    const v = this.tmp4.set(x, y, z, 1).applyMatrix4(this.mvp);
    if (v.w <= 0) return null;
    const canvas = map.getCanvas();
    return {
      x: ((v.x / v.w + 1) / 2) * canvas.clientWidth,
      y: ((1 - v.y / v.w) / 2) * canvas.clientHeight,
      w: v.w,
    };
  }

  private onScreen(s: { x: number; y: number } | null, margin = 0): boolean {
    const canvas = this.map?.getCanvas();
    if (!s || !canvas) return false;
    return s.x >= margin && s.x <= canvas.clientWidth - margin && s.y >= 0 && s.y <= canvas.clientHeight;
  }

  private placeLabels() {
    const sink = this.labels;
    if (!sink) return;
    if (this.mode !== 'street' || (this.map?.getZoom() ?? 0) < MIN_3D_ZOOM + 1.5) {
      sink.begin?.([]);
      for (const id of this.beacons.keys()) sink.place(id, { x: 0, y: 0, scale: 1, visible: false });
      for (const npc of this.npcs) if (npc.tagPointId) sink.place(`walker:${npc.tagPointId}`, { x: 0, y: 0, scale: 1, visible: false });
      sink.commit?.();
      return;
    }
    const feet = this.project(this.playerPos.x, 0, this.playerPos.z);
    const head = this.project(this.playerPos.x, 2.15 * CHAR_SCALE, this.playerPos.z);
    const ref = feet?.w ?? 1;
    const shrink = (w: number) => clamp(Math.pow(ref / w, 0.5), 0.86, 1);
    if (feet && head) {
      const tall = Math.max(1, feet.y - head.y);
      sink.begin?.([{ x: feet.x - tall * 0.42, y: head.y, w: tall * 0.84, h: tall }]);
    } else sink.begin?.([]);
    for (const [id, { beacon, pos }] of this.beacons) {
      // The anchor does not bob with the item, so labels stay steady.
      const s = this.project(pos.x, beacon.labelY * BEACON_SCALE, pos.z);
      const ground = this.project(pos.x, 0, pos.z);
      const visible = beacon.root.visible && this.onScreen(s, 2) && this.onScreen(ground, -40);
      sink.place(id, { x: s?.x ?? 0, y: s?.y ?? 0, scale: (s ? shrink(s.w) : 1) * beacon.popScale, visible });
    }
    for (const npc of this.npcs) {
      if (!npc.tagPointId) continue;
      // A walker's tag shows only while the walker is on screen, right above their head.
      const drawn = npc.chibi.root.position;
      const top = this.project(drawn.x, 2.08 * CHAR_SCALE, drawn.z);
      const base = this.project(drawn.x, 0, drawn.z);
      const visible = this.onScreen(top, 16) && this.onScreen(base, 16);
      sink.place(`walker:${npc.tagPointId}`, { x: top?.x ?? 0, y: top?.y ?? 0, scale: top ? shrink(top.w) : 1, visible });
    }
    sink.commit?.();
  }

  private hitBeacon(x: number, y: number): string | null {
    let best: { id: string; d: number } | null = null;
    for (const [id, { beacon, pos }] of this.beacons) {
      if (!beacon.root.visible) continue;
      const cy = beacon.itemAnchor.position.y * BEACON_SCALE;
      const c = this.project(pos.x, cy, pos.z);
      const t = this.project(pos.x, cy + 0.95 * BEACON_SCALE, pos.z);
      const g = this.project(pos.x, 0, pos.z);
      if (!c || !t || !g) continue;
      const r = Math.max(28, Math.hypot(t.x - c.x, t.y - c.y) * 1.25);
      const d = Math.min(Math.hypot(x - c.x, y - c.y), Math.hypot(x - g.x, y - g.y) * 1.4);
      if (d < r && (!best || d < best.d)) best = { id, d };
    }
    return best?.id ?? null;
  }

  private onPointerDown = (e: PointerEvent) => {
    this.pointers.add(e.pointerId);
    this.swallowTouchEnd = false;
    if (this.mode !== 'street') {
      this.drag = null;
      return;
    }
    if (this.pointers.size > 1) {
      this.drag = null;
      return;
    }
    if (e.button !== 0 || !this.map) return;
    this.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, b0: this.bearing, p0: this.pitch, moved: false };
  };

  private onPointerMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.moved && Math.hypot(dx, dy) > 7) d.moved = true;
    if (d.moved) {
      this.bearing = d.b0 - dx * 0.32;
      this.pitch = clamp(d.p0 - dy * 0.12, 45, 70);
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    if (d.moved || e.type === 'pointercancel' || !this.map) return;
    const rect = this.map.getCanvas().getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = this.hitBeacon(x, y);
    if (hit) {
      // The sheet opens right away; on touch, the click that follows must not land on it.
      if (e.pointerType !== 'mouse') this.swallowTouchEnd = true;
      this.events.onSelect(hit);
      return;
    }
    const ll = this.map.unproject([x, y]);
    const p = this.frame.toLocal(ll.lng, ll.lat);
    const dist = Math.hypot(p.x - this.playerPos.x, p.z - this.playerPos.z);
    if (dist > 600) return;
    this.focus = null;
    this.walkTo(p);
  };

  private onTouchEnd = (e: TouchEvent) => {
    if (!this.swallowTouchEnd) return;
    this.swallowTouchEnd = false;
    // Cancels the compatibility mouse events and the click for this tap.
    if (e.cancelable) e.preventDefault();
  };

  private onKey = (e: KeyboardEvent) => {
    if (this.mode !== 'street') return;
    const k = e.key.toLowerCase();
    if (!['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) return;
    if (e.type === 'keyup') {
      this.keys.delete(k);
      return;
    }
    // Keys belong to the sheet (or a form control) while one has focus or is open.
    if (this.selectedId || isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    this.keys.add(k);
  };

  private onBlur = () => {
    this.keys.clear();
  };
}
