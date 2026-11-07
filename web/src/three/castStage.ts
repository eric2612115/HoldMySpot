import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LOOK_AROUND, type ChibiPalette } from './characters/chibi';
import { CozyPerson, type Person } from './characters/cozy';
import type { PersonLook } from './characters/presets';
import { createOutlineSettings, toon } from './materials/toon';

export type Motion = 'idle' | 'walk';

export interface StageMember {
  id: string;
  look: PersonLook;
}

/** Rows of member ids, front row first: one arrangement for wide screens and one for phones. */
export interface StageLayout {
  wide: string[][];
  narrow: string[][];
}

const GAP_WIDE = 1.8;
const GAP_NARROW = 1.62;
const ROW_DEPTH = 2.2;
/** Each row further back stands this much higher, like a group photo on steps. */
const RISE = 0.42;
/** Group view: the camera looks down a little, so back rows show over front rows. */
const GROUP_DIR = new THREE.Vector3(0, 0.36, 1).normalize();
/** Close-up: three-quarter front from the character's left, where the tails are. */
const CLOSE_DIR = new THREE.Vector3(0.5, 0.2, 1).normalize();
/** In a close-up the head turns toward the camera (up to this far) and looks around less; the body keeps its angle. */
const CLOSE_LOOK_MAX = 0.45;
const CLOSE_LOOK_AROUND = 0.08;
const SPOT_COLORS = ['#E2DBFF', '#FFE0EA', '#D7F1EA', '#FFEBCB'];

type Fly = { from: THREE.Vector3; fromTarget: THREE.Vector3; to: THREE.Vector3; toTarget: THREE.Vector3; t: number };

/**
 * The /characters stage: everyone in a group photo on low steps, with orbit
 * controls. Focusing a member flies the camera to a close-up of them alone;
 * focusing nobody returns to the group.
 */
export class CastStage {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
  private readonly controls: OrbitControls;
  private readonly outline = createOutlineSettings(0.032);
  private readonly cast = new Map<string, Person>();
  private readonly spots = new Map<string, THREE.Mesh>();
  private readonly ground = new THREE.Group();
  private readonly layoutRows: StageLayout;
  private narrow: boolean | null = null;
  /** Members standing in the current layout. */
  private readonly placed = new Set<string>();
  private focused: string | null = null;
  private fly: Fly | null = null;
  private readonly ro: ResizeObserver;
  private readonly timer = new THREE.Timer();
  private readonly host: HTMLElement;
  private readonly raycaster = new THREE.Raycaster();
  private down: { x: number; y: number } | null = null;
  private userMoved = false;
  private readonly onPick?: (id: string) => void;

  constructor(host: HTMLElement, members: StageMember[], layout: StageLayout, onPick?: (id: string) => void) {
    this.host = host;
    this.layoutRows = layout;
    this.onPick = onPick;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    host.appendChild(this.renderer.domElement);
    const touch = window.matchMedia('(pointer: coarse)').matches;
    this.renderer.domElement.setAttribute('aria-label', `The cast, humans and animal-people. Tap someone to meet them; drag to orbit, ${touch ? 'pinch' : 'scroll'} to zoom.`);

    this.camera.position.set(0, 3.1, 12);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.0, 0);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 3;
    this.controls.minPolarAngle = 0.35;
    this.controls.maxPolarAngle = 1.5;
    this.controls.update();
    this.controls.addEventListener('start', () => {
      this.userMoved = true;
      this.fly = null;
    });

    this.scene.add(new THREE.HemisphereLight('#FFFFFF', '#D9D2F2', 1.9));
    const sun = new THREE.DirectionalLight('#FFF8EE', 1.6);
    sun.position.set(-4, 9, 7);
    this.scene.add(sun);
    this.scene.add(this.ground);

    const view = { value: this.camera.position };
    members.forEach((m, i) => {
      // The film's proportions and faces, with the knit and fabric weaves for close-ups.
      const person = new CozyPerson(m.look.model, m.look, { mode: 'stage', seed: i + 1, view, outline: this.outline, name: m.id });
      person.root.userData.memberId = m.id;
      this.scene.add(person.root);
      this.cast.set(m.id, person);
      const spot = new THREE.Mesh(new THREE.CircleGeometry(0.72, 40), toon(SPOT_COLORS[i % SPOT_COLORS.length]));
      spot.rotation.x = -Math.PI / 2;
      this.scene.add(spot);
      this.spots.set(m.id, spot);
    });

    this.timer.connect(document);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.renderer.domElement.addEventListener('pointerdown', this.onDown);
    this.renderer.domElement.addEventListener('pointerup', this.onUp);
    this.resize();
    this.renderer.setAnimationLoop(this.frame);
  }

  setMotion(id: string, motion: Motion) {
    const c = this.cast.get(id);
    if (!c) return;
    c.walking = motion === 'walk';
    // Walking in place reads best from three-quarter view.
    c.face(motion === 'walk' ? 0.62 : 0);
    this.aim(c, this.focused === id);
  }

  /** A close-up turns the face toward the camera, so the body (and the tail) keep their angle. */
  private aim(c: Person, focused: boolean) {
    let d = Math.atan2(CLOSE_DIR.x, CLOSE_DIR.z) - c.facing;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    c.lookYaw = focused ? THREE.MathUtils.clamp(d, -CLOSE_LOOK_MAX, CLOSE_LOOK_MAX) : 0;
    c.lookAround = focused ? CLOSE_LOOK_AROUND : LOOK_AROUND;
  }

  setPalette(id: string, p: ChibiPalette) {
    this.cast.get(id)?.setPalette(p);
  }

  hop(id: string) {
    this.cast.get(id)?.hop(2);
  }

  /** Flies to a close-up of one member (alone on the stage), or back to the group with null. */
  focus(id: string | null) {
    const next = id && this.placed.has(id) ? id : null;
    this.focused = next;
    for (const [mid, c] of this.cast) {
      const show = this.placed.has(mid) && (next === null || mid === next);
      c.root.visible = show;
      this.spots.get(mid)!.visible = show;
      this.aim(c, mid === next);
    }
    this.userMoved = false;
    this.frameView(true);
  }

  // ------------------------------------------------------------ layout

  /** Places everyone in rows (front row nearest), rows further back a step higher, and builds the steps. */
  private layout(narrow: boolean) {
    this.narrow = narrow;
    const rows = (narrow ? this.layoutRows.narrow : this.layoutRows.wide).map((r) => r.filter((id) => this.cast.has(id)));
    const gap = narrow ? GAP_NARROW : GAP_WIDE;
    const placed = this.placed;
    placed.clear();
    let widest = 0;
    rows.forEach((row, k) => {
      const z = ((rows.length - 1) / 2 - k) * ROW_DEPTH;
      const y = k * RISE;
      // Every other row sits half a gap over, so faces show between the heads in front.
      const shift = k % 2 === 1 ? gap / 2 : 0;
      row.forEach((id, i) => {
        const x = (i - (row.length - 1) / 2) * gap + shift;
        this.cast.get(id)!.root.position.set(x, y, z);
        this.spots.get(id)!.position.set(x, y + 0.006, z);
        placed.add(id);
      });
      widest = Math.max(widest, (row.length - 1) * gap + Math.abs(shift) * 2);
    });
    for (const [id, c] of this.cast) {
      c.root.visible = placed.has(id) && (this.focused === null || this.focused === id);
      this.spots.get(id)!.visible = c.root.visible;
    }

    // The stage: a round floor and one low step per row behind the front.
    this.ground.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });
    this.ground.clear();
    const depth = rows.length * ROW_DEPTH;
    const halfW = widest / 2 + 1.4;
    const radius = Math.max(halfW, depth / 2 + 1.2);
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius + 0.15, 0.3, 72), toon('#F3F7EC'));
    floor.position.y = -0.15;
    floor.scale.z = Math.min(1, (depth / 2 + 1.6) / radius);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(radius + 0.07, 0.09, 8, 96), toon('#CFEBBF'));
    rim.rotation.x = Math.PI / 2;
    rim.scale.y = floor.scale.z;
    this.ground.add(floor, rim);
    rows.forEach((_, k) => {
      if (k === 0) return;
      const z = ((rows.length - 1) / 2 - k) * ROW_DEPTH;
      const step = new THREE.Mesh(new THREE.BoxGeometry(widest + 2.2, k * RISE, ROW_DEPTH), toon(k % 2 ? '#EAF3E2' : '#F1F6EA'));
      step.position.set(0, (k * RISE) / 2, z);
      this.ground.add(step);
    });
  }

  /** The members in view now: everyone, or the focused one. */
  private inView(): Person[] {
    const c = this.focused ? this.cast.get(this.focused) : null;
    return c ? [c] : [...this.cast.values()].filter((x) => x.root.visible);
  }

  /**
   * Fits the members' boxes to the screen from direction `dir`: the distance at which every
   * corner fits, with the target nudged so the group sits in the middle of the frame
   * (perspective otherwise leaves the near row low and empty sky on top).
   */
  private fit(start: THREE.Vector3, dir: THREE.Vector3, chibis: Person[], below = 0): { target: THREE.Vector3; dist: number } {
    const pts: THREE.Vector3[] = [];
    for (const c of chibis) {
      const p = c.root.position;
      for (const dx of [-0.75, 0.75]) for (const dy of [-below, 2.45]) for (const dz of [-0.7, 0.45]) pts.push(new THREE.Vector3(p.x + dx, p.y + dy, p.z + dz));
    }
    const cam = this.camera.clone();
    const v = new THREE.Vector3();
    const place = (target: THREE.Vector3, d: number) => {
      cam.position.copy(target).addScaledVector(dir, d);
      cam.lookAt(target);
      cam.updateMatrixWorld();
    };
    const fits = (target: THREE.Vector3, d: number) => {
      place(target, d);
      return pts.every((q) => {
        v.copy(q).project(cam);
        return Math.abs(v.x) < 0.94 && Math.abs(v.y) < 0.9 && v.z < 1;
      });
    };
    const distance = (target: THREE.Vector3) => {
      let lo = 2;
      let hi = 80;
      for (let i = 0; i < 28; i++) {
        const mid = (lo + hi) / 2;
        if (fits(target, mid)) hi = mid;
        else lo = mid;
      }
      return hi;
    };
    const target = start.clone();
    let dist = distance(target);
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(dir, -dir.y).normalize();
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    for (let i = 0; i < 3; i++) {
      place(target, dist);
      let lo = Infinity;
      let hi = -Infinity;
      for (const q of pts) {
        v.copy(q).project(cam);
        lo = Math.min(lo, v.y);
        hi = Math.max(hi, v.y);
      }
      target.addScaledVector(up, ((lo + hi) / 2) * dist * halfHeight);
      dist = distance(target);
    }
    return { target, dist };
  }

  /** Points the camera at the group or the focused member; `animate` flies there. */
  private frameView(animate: boolean) {
    const chibis = this.inView();
    if (chibis.length === 0) return;
    const box = new THREE.Box3();
    for (const c of chibis) box.expandByPoint(c.root.position);
    const centre = box.getCenter(new THREE.Vector3());
    // A close-up keeps room under the feet for the card that names the person.
    const below = this.focused ? 0.6 : 0;
    const dir = this.focused ? CLOSE_DIR : GROUP_DIR;
    const { target, dist } = this.fit(new THREE.Vector3(centre.x, centre.y + (2.45 - below) / 2, centre.z), dir, chibis, below);
    this.controls.maxDistance = Math.max(18, dist * 1.6);
    const to = target.clone().addScaledVector(dir, dist);
    if (animate) this.fly = { from: this.camera.position.clone(), fromTarget: this.controls.target.clone(), to, toTarget: target, t: 0 };
    else {
      this.fly = null;
      this.camera.position.copy(to);
      this.controls.target.copy(target);
    }
  }

  private resize() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const narrow = w / h < 1.3;
    if (narrow !== this.narrow) this.layout(narrow);
    if (!this.userMoved) this.frameView(false);
  }

  // ------------------------------------------------------------ picking

  private onDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY };
  };

  /** A tap (not a drag) on someone meets them. */
  private onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || !this.onPick) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
    const roots = this.inView().map((c) => c.root);
    for (const hit of this.raycaster.intersectObjects(roots, true)) {
      let o: THREE.Object3D | null = hit.object;
      while (o && o.userData.memberId === undefined) o = o.parent;
      if (o) {
        this.onPick(o.userData.memberId as string);
        return;
      }
    }
  };

  // ------------------------------------------------------------ loop

  private frame = () => {
    this.timer.update();
    const dt = this.timer.getDelta();
    for (const c of this.cast.values()) if (c.root.visible) c.update(dt);
    if (this.fly) {
      const f = this.fly;
      f.t = Math.min(1, f.t + dt / 0.9);
      const k = 1 - Math.pow(1 - f.t, 3);
      this.camera.position.lerpVectors(f.from, f.to, k);
      this.controls.target.lerpVectors(f.fromTarget, f.toTarget, k);
      if (f.t >= 1) this.fly = null;
    }
    this.controls.update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.ro.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.onDown);
    this.renderer.domElement.removeEventListener('pointerup', this.onUp);
    this.controls.dispose();
    for (const c of this.cast.values()) c.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.timer.dispose();
  }
}
