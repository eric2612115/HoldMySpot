import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { addOutline, blobShadow, inkFor, toon, type OutlineSettings } from '../materials/toon';
import { spherePatchGeometry, type PatchSpot } from './patches';

/**
 * Original chibi people built from primitives: a big round head, a small
 * body, simple friendly faces and everyday clothes. Everything here is
 * procedural, so the characters are fully ours.
 *
 * Animal-people share the same body, clothes, eyes and cheeks; only the head
 * changes (ears, muzzle and markings) and they get a tail. Their species reads
 * from the silhouette alone, from the front and from behind: long ears
 * (bunny), pointed ears and a thin tail curling out beside the shoulder (cat),
 * ears that flare from the crown, a round snout, a collar and a raised tail
 * (dog), tall dark-tipped ears and a brush tail with a pale tip (fox), ear
 * tufts and a tall tail arching over the head (squirrel), a domino mask and a
 * ringed tail (raccoon). Markings are soft-edged patches that hug the head
 * (patches.ts), never straight-edged bands.
 *
 * Units: the character is about 2 units tall with its feet at y = 0 and it
 * faces +z. Scale the root to place it in a scene.
 */

export interface ChibiPalette {
  /** Skin, or an animal-person's main fur. */
  skin: string;
  hair: string;
  top: string;
  bottom: string;
  shoes: string;
  accent: string;
}

export type PaletteSlot = keyof ChibiPalette;
export type HairStyle = 'tousled' | 'bun' | 'bob' | 'beanie';
export type TopStyle = 'hoodie' | 'tee' | 'jacket';
export type Accessory = 'backpack' | 'tote' | 'phone' | 'coffee' | 'none';
export type Species = 'human' | 'bunny' | 'cat' | 'dog' | 'fox' | 'squirrel' | 'raccoon';
export const ANIMAL_SPECIES: readonly Exclude<Species, 'human'>[] = ['bunny', 'cat', 'dog', 'fox', 'squirrel', 'raccoon'];

/** An animal-person's own colours. The main fur is `palette.skin`. */
export interface FurColours {
  /** Muzzle, inner ears, the fox's cheeks and tail tip, the raccoon's brows, the bunny's tail, blazes. */
  light: string;
  /** Markings: ear tips and tufts, floppy ears, the raccoon's mask and rings, dark paws, a calico's ginger. */
  mark: string;
  /** Calico cats only: the second patch colour. */
  mark2?: string;
  /**
   * Optional coat pattern on top of the species' own markings: calico (cats:
   * ginger over one eye, cocoa behind), points (cats: a mask centred on the
   * nose, ears, paws and tail tip), blaze (dogs: a pale stripe down the
   * forehead), dutch (bunnies: a pale blaze widening to the muzzle).
   */
  pattern?: 'calico' | 'points' | 'blaze' | 'dutch';
}

export interface ChibiSpec {
  name: string;
  /** Humans only; animal-people have fur instead. */
  hair: HairStyle;
  top: TopStyle;
  accessory: Accessory;
  palette: ChibiPalette;
  /** Small per-character differences so a crowd does not move in lockstep. */
  seed?: number;
  /** Human when left out. */
  species?: Species;
  /** Animal-people only (defaults are derived from the fur colour). */
  fur?: FurColours;
}

export type FurKey = 'light' | 'mark' | 'mark2';
type Part = { mesh: THREE.Mesh; slot: PaletteSlot | null; shell: THREE.Mesh | null };

export const HEAD_Y = 1.38;
export const HEAD_R = 0.5;
const HEAD_SCALE = new THREE.Vector3(1.06, 0.96, 1.0);
export const HEAD_SCALE_T: [number, number, number] = [HEAD_SCALE.x, HEAD_SCALE.y, HEAD_SCALE.z];
/** Where a tail starts: the back of the hips, in body space. */
export const TAIL_ROOT: [number, number, number] = [0, 0.56, -0.17];
/** How far the arms rest out from the body (radians), so hands clear the shirt. */
const ARM_SPREAD = 0.2;
/** A held arm's rest pose (raised forward a little). */
const HOLD_X = -0.55;
/** Markings sit this far above the head; eyes on a marking move out by as much. */
const MARK_LIFT = 0.006;

/** Tail motion limits, shared by update() and the test that keeps every tail clear of the head. */
export const TAIL_MOTION = {
  /** A dog's wag either way (radians): calm, then walking or happy. */
  wag: [0.3, 0.55] as const,
  /** Side-to-side sway when idle (cats swish more) and with the steps. */
  idleSway: { cat: 0.16, other: 0.1 },
  walkSway: 0.14,
  /** Up-and-down tilt: idle drift, and the dip on each step. */
  idleTilt: 0.04,
  walkDip: 0.07,
};

/** How far the head looks around when idle (radians). */
export const LOOK_AROUND = 0.28;

/** Head motion (radians) in update(): side tilt and nod, walking and idle. The head turns around the body's origin. */
export const HEAD_MOTION = { walkTilt: 0.05, idleTilt: 0.04, walkNod: 0.03, idleNod: 0.02 };

export interface TailShape {
  /** Control points from TAIL_ROOT, in body space. */
  points: Array<[number, number, number]>;
  radius: (t: number) => number;
  /** Colour bands along the tail: [from, to, fur key], crisp at both edges. */
  bands: Array<[number, number, FurKey]>;
  segments: number;
}

/** Point on the head surface for spherical angles (theta from the top, phi around; phi = PI/2 is the face). */
function headPoint(theta: number, phi: number, lift = 0): THREE.Vector3 {
  const r = HEAD_R + lift;
  return new THREE.Vector3(
    -r * Math.cos(phi) * Math.sin(theta) * HEAD_SCALE.x,
    r * Math.cos(theta) * HEAD_SCALE.y + HEAD_Y,
    r * Math.sin(phi) * Math.sin(theta) * HEAD_SCALE.z,
  );
}

/** A bushy tail's radius along its length: swells to `max` at `peak`, then closes in a rounded tip. */
function bushy(start: number, max: number, peak: number): (t: number) => number {
  return (t) => (t <= peak ? start + (max - start) * Math.sin(((t / peak) * Math.PI) / 2) : max * Math.sqrt(Math.max(0, 1 - ((t - peak) / (1 - peak)) ** 2)));
}

/** A thin tail: an even radius with a rounded tip. */
function slender(radius: number, taper = 0): (t: number) => number {
  return (t) => {
    const r = radius * (1 - taper * t);
    return t <= 0.88 ? r : r * Math.sqrt(Math.max(0, 1 - ((t - 0.88) / 0.12) ** 2));
  };
}

/**
 * Each species' tail (null for humans and the bunny's puff). Every tail first
 * leaves the hips straight back, so from behind it grows from the middle, and
 * none reaches into the head at any sway (chibi.test.ts checks this).
 */
export function tailShape(species: Species, pattern?: FurColours['pattern']): TailShape | null {
  switch (species) {
    case 'cat': {
      // Up the back, then the tip curls outward beside the shoulder.
      const tip: FurKey | null = pattern === 'calico' ? 'mark2' : pattern === 'points' ? 'mark' : null;
      return {
        points: [[0, 0, 0], [0.06, -0.04, -0.14], [0.2, 0.02, -0.26], [0.3, 0.2, -0.31], [0.38, 0.42, -0.33], [0.47, 0.55, -0.34], [0.57, 0.59, -0.32]],
        radius: slender(0.045),
        bands: tip ? [[0.72, 1, tip]] : [],
        segments: 22,
      };
    }
    case 'dog':
      // Back from the hips, then straight up with a pale tip, so it shows its length from behind
      // (the map's view of a line) instead of pointing at the camera. It wags from side to side.
      return { points: [[0, 0, 0], [0, 0.02, -0.2], [0, 0.14, -0.36], [0, 0.32, -0.44], [0, 0.5, -0.44]], radius: slender(0.06, 0.25), bands: [[0.72, 1, 'light']], segments: 18 };
    case 'fox':
      return {
        points: [[0, 0, 0], [0, -0.04, -0.2], [0.06, -0.1, -0.33], [0.2, -0.14, -0.44], [0.38, -0.08, -0.5], [0.52, 0.07, -0.5], [0.58, 0.2, -0.44]],
        radius: bushy(0.05, 0.16, 0.6),
        bands: [[0.78, 1, 'light']],
        segments: 24,
      };
    case 'squirrel':
      // The tail rises beside the head and arches over it, so it shows from the front too. No pale tip: that is the fox's.
      return {
        points: [[0, 0, 0], [0.1, 0.05, -0.18], [0.33, 0.3, -0.38], [0.54, 0.7, -0.48], [0.62, 1.1, -0.47], [0.53, 1.46, -0.38], [0.31, 1.64, -0.31], [0.1, 1.62, -0.31]],
        radius: bushy(0.05, 0.19, 0.5),
        bands: [],
        segments: 28,
      };
    case 'raccoon':
      // Down and back under the backpack, then sideways with four rings.
      return {
        points: [[0, 0, 0], [0, -0.1, -0.17], [0.05, -0.18, -0.3], [0.18, -0.22, -0.42], [0.34, -0.2, -0.5], [0.48, -0.1, -0.53], [0.56, 0.04, -0.52]],
        radius: bushy(0.055, 0.13, 0.5),
        bands: [[0.22, 0.32, 'mark'], [0.44, 0.54, 'mark'], [0.66, 0.76, 'mark'], [0.88, 1, 'mark']],
        segments: 24,
      };
    default:
      return null;
  }
}

/**
 * A tube along a curve whose radius follows `radius(t)`, coloured per vertex
 * in bands (a pale tip, rings). Each band edge gets two rings of vertices in
 * one place, one in each colour, so a band changes in a crisp step like the
 * cel shading. Normals lean along the curve where the radius changes, so the
 * outline shell also closes over the rounded tip. One mesh: a tail is one
 * draw call plus its outline.
 */
function tailGeometry(points: Array<[number, number, number]>, radius: (t: number) => number, bands: Array<[number, number, THREE.Color]>, base: THREE.Color, segments: number, radial = 10): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  const length = curve.getLength();
  const colourAt = (t: number) => {
    for (const [from, to, c] of bands) if (t >= from && (t < to || (to >= 1 && t <= 1))) return c;
    return base;
  };
  const edges = bands.flatMap(([from, to]) => [from, to]).filter((e) => e > 0 && e < 1);
  const rings: Array<{ t: number; colour: THREE.Color }> = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    if (!edges.some((e) => Math.abs(e - t) < 1e-9)) rings.push({ t, colour: colourAt(t) });
  }
  for (const e of edges) rings.push({ t: e, colour: colourAt(e - 1e-6) }, { t: e, colour: colourAt(e + 1e-6) });
  rings.sort((p, q) => p.t - q.t);

  // Parallel-transport frames, as three.js builds them for TubeGeometry.
  const n = rings.length;
  const T = rings.map((r) => curve.getTangentAt(r.t).normalize());
  const N: THREE.Vector3[] = [];
  const B: THREE.Vector3[] = [];
  const t0 = T[0]!;
  const ax = Math.abs(t0.x);
  const ay = Math.abs(t0.y);
  const az = Math.abs(t0.z);
  const axis = ax <= ay && ax <= az ? new THREE.Vector3(1, 0, 0) : ay <= az ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const tmp = new THREE.Vector3().crossVectors(t0, axis).normalize();
  N.push(new THREE.Vector3().crossVectors(t0, tmp));
  B.push(new THREE.Vector3().crossVectors(t0, N[0]!));
  const m = new THREE.Matrix4();
  for (let i = 1; i < n; i++) {
    const nn = N[i - 1]!.clone();
    const v = new THREE.Vector3().crossVectors(T[i - 1]!, T[i]!);
    if (v.length() > 1e-6) {
      v.normalize();
      nn.applyMatrix4(m.makeRotationAxis(v, Math.acos(THREE.MathUtils.clamp(T[i - 1]!.dot(T[i]!), -1, 1))));
    }
    N.push(nn);
    B.push(new THREE.Vector3().crossVectors(T[i]!, nn));
  }

  const count = n * (radial + 1);
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const h = 1e-3;
  for (let i = 0; i < n; i++) {
    const { t, colour } = rings[i]!;
    curve.getPointAt(t, c);
    const r = Math.max(0.0005, radius(t));
    const lo = Math.max(0, t - h);
    const hi = Math.min(1, t + h);
    const slope = THREE.MathUtils.clamp((radius(hi) - radius(lo)) / ((hi - lo) * length), -40, 40);
    for (let j = 0; j <= radial; j++) {
      const v = (j / radial) * Math.PI * 2;
      const sin = Math.sin(v);
      const cos = -Math.cos(v);
      dir.set(cos * N[i]!.x + sin * B[i]!.x, cos * N[i]!.y + sin * B[i]!.y, cos * N[i]!.z + sin * B[i]!.z).normalize();
      nrm.copy(dir).addScaledVector(T[i]!, -slope).normalize();
      const k = (i * (radial + 1) + j) * 3;
      pos[k] = c.x + dir.x * r;
      pos[k + 1] = c.y + dir.y * r;
      pos[k + 2] = c.z + dir.z * r;
      nor[k] = nrm.x;
      nor[k + 1] = nrm.y;
      nor[k + 2] = nrm.z;
      col[k] = colour.r;
      col[k + 1] = colour.g;
      col[k + 2] = colour.b;
    }
  }
  const idx: number[] = [];
  for (let i = 1; i < n; i++) {
    // The two rings of a band edge share a place: no strip between them.
    if (rings[i]!.t - rings[i - 1]!.t < 1e-9) continue;
    for (let j = 1; j <= radial; j++) {
      const a = (radial + 1) * (i - 1) + (j - 1);
      const b = (radial + 1) * i + (j - 1);
      const cc = (radial + 1) * i + j;
      const d = (radial + 1) * (i - 1) + j;
      idx.push(a, b, d, b, cc, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * A pointed ear with a rounded tip, base at y = 0 and tip at y = h. A sharp
 * apex would fray the outline shell (its normals fan out), so the tip is a
 * small dome a little wider than the outline.
 */
function earGeometry(r: number, h: number, tip = 0.035, segments = 14): THREE.BufferGeometry {
  const top = h - tip;
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 5; i++) {
    const y = (top * i) / 5;
    pts.push(new THREE.Vector2(tip + (r - tip) * (1 - y / top), y));
  }
  for (let i = 1; i <= 4; i++) {
    const a = (i / 4) * (Math.PI / 2);
    pts.push(new THREE.Vector2(tip * Math.cos(a), top + tip * Math.sin(a)));
  }
  return new THREE.LatheGeometry(pts, segments);
}

/** Thin flat strokes (whiskers) as one mesh: each stroke runs from `a` to `b` in head space. */
function strokeGeometry(strokes: Array<[THREE.Vector3, THREE.Vector3]>, width: number): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const [a, b] of strokes) {
    const d = b.clone().sub(a);
    const side = new THREE.Vector3(-d.y, d.x, 0).normalize().multiplyScalar(width / 2);
    const p = [a.clone().add(side), a.clone().sub(side), b.clone().add(side), b.clone().sub(side)];
    for (const i of [0, 1, 2, 2, 1, 3]) pos.push(p[i].x, p[i].y, p[i].z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return geo;
}

/** Fur colours when a spec gives none: a pale and a dark shade of the main fur. */
export function defaultFur(skin: string): FurColours {
  const base = new THREE.Color(skin);
  const light = base.clone().lerp(new THREE.Color('#FFF7EE'), 0.75);
  const mark = inkFor(base).lerp(base, 0.35);
  return { light: `#${light.getHexString()}`, mark: `#${mark.getHexString()}` };
}

export class Chibi {
  readonly root = new THREE.Group();
  readonly spec: ChibiSpec;
  readonly species: Species;
  /** Height of the top of the head, ears or tail in body units (for labels above the character). */
  readonly top: number;
  /** Set by whoever drives the character. */
  walking = false;
  /** 1 is a normal walk; higher plays the cycle faster. */
  walkRate = 1;
  /** A head turn on top of the idle look-around (radians; close-ups turn the face toward the camera). */
  lookYaw = 0;
  /** How far the head looks around when idle (radians). */
  lookAround = LOOK_AROUND;

  private readonly outline: OutlineSettings;
  private readonly mats = new Map<PaletteSlot, THREE.MeshToonMaterial>();
  private readonly furMats = new Map<FurKey, THREE.MeshToonMaterial>();
  private readonly parts: Part[] = [];
  private readonly body = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly armL = new THREE.Group();
  private readonly armR = new THREE.Group();
  private readonly legL = new THREE.Group();
  private readonly legR = new THREE.Group();
  private readonly eyes: THREE.Mesh[] = [];
  private readonly browMat: THREE.MeshBasicMaterial;
  private readonly torso: THREE.Object3D;
  /** A cup or phone in the left hand: kept upright against the body whatever the arm does. */
  private grip: THREE.Group | null = null;
  /** Animal-people: the tail (pivots at the hips) and ears that move. */
  private tail: THREE.Group | null = null;
  private readonly ears: Array<{ group: THREE.Group; side: number; x: number; z: number }> = [];
  private walkBlend = 0;
  private phase = 0;
  private blinkIn: number;
  private blinkT = -1;
  private hopT = -1;
  private hopsLeft = 0;
  private heading = 0;
  private targetHeading = 0;
  private shownLook = 0;
  private time = 0;
  private readonly rnd: () => number;

  constructor(spec: ChibiSpec, outline: OutlineSettings) {
    this.spec = spec;
    this.species = spec.species ?? 'human';
    this.outline = outline;
    let s = (spec.seed ?? 1) * 9301 + 49297;
    this.rnd = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
    this.blinkIn = 1 + this.rnd() * 3;
    this.time = this.rnd() * 10;

    for (const slot of Object.keys(spec.palette) as PaletteSlot[]) {
      this.mats.set(slot, toon(spec.palette[slot]));
    }
    this.browMat = new THREE.MeshBasicMaterial({ color: inkFor(new THREE.Color(spec.palette.hair)) });

    this.root.name = `chibi-${spec.name}`;
    this.root.add(blobShadow(0.62, 0.9));
    this.root.add(this.body);
    this.body.add(this.head);

    this.buildLegs();
    this.torso = this.buildTorso();
    this.buildArms();
    this.buildHead();
    if (this.species === 'human') this.buildHair();
    else this.buildAnimal();
    this.buildAccessory();

    this.root.updateMatrixWorld(true);
    this.top = new THREE.Box3().setFromObject(this.body).max.y;
  }

  // ---------------------------------------------------------------- build

  private mat(slot: PaletteSlot): THREE.MeshToonMaterial {
    return this.mats.get(slot)!;
  }

  /** An animal-person's fur colour (light, mark or the calico's second patch). */
  private furMat(key: FurKey): THREE.MeshToonMaterial {
    let m = this.furMats.get(key);
    if (!m) {
      const fur = { ...defaultFur(this.spec.palette.skin), ...this.spec.fur };
      m = toon(key === 'mark2' ? (fur.mark2 ?? fur.mark) : fur[key]);
      this.furMats.set(key, m);
    }
    return m;
  }

  private part(
    geometry: THREE.BufferGeometry,
    slot: PaletteSlot | THREE.Material,
    parent: THREE.Object3D,
    opts: { pos?: [number, number, number]; scale?: [number, number, number]; rot?: [number, number, number]; outline?: boolean } = {},
  ): THREE.Mesh {
    const material = typeof slot === 'string' ? this.mat(slot) : slot;
    const mesh = new THREE.Mesh(geometry, material);
    if (opts.pos) mesh.position.set(...opts.pos);
    if (opts.scale) mesh.scale.set(...opts.scale);
    if (opts.rot) mesh.rotation.set(...opts.rot);
    parent.add(mesh);
    const shell = opts.outline === false ? null : addOutline(mesh, this.outline);
    this.parts.push({ mesh, slot: typeof slot === 'string' ? slot : null, shell });
    return mesh;
  }

  private buildLegs() {
    for (const [leg, x] of [
      [this.legL, 0.115],
      [this.legR, -0.115],
    ] as const) {
      leg.position.set(x, 0.47, 0);
      this.body.add(leg);
      this.part(new THREE.CapsuleGeometry(0.098, 0.2, 6, 14), 'bottom', leg, { pos: [0, -0.18, 0] });
      this.part(new THREE.SphereGeometry(0.125, 18, 12), 'shoes', leg, { pos: [0, -0.4, 0.045], scale: [1, 0.62, 1.38] });
    }
  }

  private buildTorso(): THREE.Object3D {
    // Hips in the trouser colour.
    this.part(new THREE.SphereGeometry(0.245, 24, 14), 'bottom', this.body, { pos: [0, 0.53, 0], scale: [1.04, 0.56, 0.92] });
    // Shirt: a soft bell, wider at the hem.
    const profile = [
      [0.0, 0.0], [0.25, 0.0], [0.268, 0.05], [0.258, 0.16], [0.232, 0.28], [0.19, 0.38], [0.12, 0.44], [0.0, 0.47],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    const torso = this.part(new THREE.LatheGeometry(profile, 28), 'top', this.body, { pos: [0, 0.49, 0], scale: [1, 1, 0.9] });

    const top = this.spec.top;
    if (top === 'hoodie') {
      // Hood resting behind the neck, and two drawstrings.
      this.part(new THREE.TorusGeometry(0.17, 0.075, 10, 24), 'top', this.body, { pos: [0, 0.93, -0.1], rot: [Math.PI / 2.4, 0, 0], scale: [1.1, 1, 1] });
      const white = toon('#FFFFFF');
      for (const x of [0.06, -0.06]) {
        this.part(new THREE.CapsuleGeometry(0.014, 0.1, 4, 6), white, this.body, { pos: [x, 0.82, 0.215], rot: [0.12, 0, 0], outline: false });
      }
      // Front pocket.
      this.part(new THREE.CapsuleGeometry(0.045, 0.14, 4, 10), 'top', this.body, { pos: [0, 0.6, 0.238], rot: [0, 0, Math.PI / 2], scale: [1, 1, 0.3], outline: false });
    } else if (top === 'jacket') {
      // Open jacket: an inner shirt panel in the accent colour and a collar (a dog's own collar takes its place).
      this.part(new THREE.CapsuleGeometry(0.075, 0.24, 4, 10), 'accent', this.body, { pos: [0, 0.7, 0.2], scale: [1, 1, 0.55], outline: false });
      if (this.species !== 'dog') {
        for (const side of [1, -1]) {
          // Rounded, so the outline shell follows it instead of floating off a hard box edge.
          this.part(new RoundedBoxGeometry(0.12, 0.05, 0.1, 1, 0.02), 'top', this.body, { pos: [side * 0.09, 0.92, 0.12], rot: [0.5, 0, side * 0.5] });
        }
      }
    } else {
      // Tee: a small round chest badge in the accent colour.
      this.part(new THREE.CircleGeometry(0.05, 18), 'accent', this.body, { pos: [0.1, 0.78, 0.232], rot: [-0.08, 0.32, 0], outline: false });
    }
    return torso;
  }

  private buildArms() {
    const longSleeves = this.spec.top !== 'tee';
    // Foxes and raccoons have dark paws; a colour-point cat's paws match its points.
    const pointed = this.spec.fur?.pattern === 'points';
    const hand = this.species === 'fox' || this.species === 'raccoon' || pointed ? this.furMat('mark') : 'skin';
    for (const [arm, side] of [
      [this.armL, 1],
      [this.armR, -1],
    ] as const) {
      arm.position.set(side * 0.235, 0.86, 0);
      arm.rotation.z = side * ARM_SPREAD;
      this.body.add(arm);
      if (longSleeves) {
        this.part(new THREE.CapsuleGeometry(0.082, 0.2, 5, 12), 'top', arm, { pos: [0, -0.15, 0] });
      } else {
        this.part(new THREE.CapsuleGeometry(0.088, 0.06, 5, 12), 'top', arm, { pos: [0, -0.07, 0] });
        this.part(new THREE.CapsuleGeometry(0.066, 0.13, 5, 12), 'skin', arm, { pos: [0, -0.18, 0] });
      }
      // The hand sits a little out from the sleeve, so its outline does not draw a ring on the shirt.
      this.part(new THREE.SphereGeometry(0.083, 14, 10), hand, arm, { pos: [side * 0.02, -0.31, 0.01] });
    }
  }

  /** True when markings cover the eyes (they move out to sit on top). */
  private marksOverEyes(): boolean {
    const pattern = this.spec.fur?.pattern;
    return this.species === 'raccoon' || (this.species === 'cat' && (pattern === 'calico' || pattern === 'points'));
  }

  private buildHead() {
    const head = this.head;
    const human = this.species === 'human';
    this.part(new THREE.SphereGeometry(HEAD_R, 36, 26), 'skin', head, { pos: [0, HEAD_Y, 0], scale: HEAD_SCALE_T });
    // Ears (animal-people grow their own in buildAnimal).
    if (human) {
      for (const side of [1, -1]) {
        this.part(new THREE.SphereGeometry(0.085, 12, 10), 'skin', head, { pos: [side * 0.515, HEAD_Y - 0.03, 0.02], scale: [0.6, 1, 0.9] });
      }
    }

    // Eyes: tall dark ovals with a sparkle (a bigger one on a raccoon's mask, so they read on the dark).
    const eyeMat = new THREE.MeshBasicMaterial({ color: '#2B2340' });
    const shine = new THREE.MeshBasicMaterial({ color: '#FFFFFF' });
    const eyeLift = -0.012 + (this.marksOverEyes() ? MARK_LIFT : 0);
    const sparkle = this.species === 'raccoon' ? 0.032 : 0.024;
    for (const side of [1, -1]) {
      const p = headPoint(Math.PI * 0.53, Math.PI / 2 - side * 0.36, eyeLift);
      const eye = new THREE.Group();
      eye.position.copy(p);
      eye.lookAt(new THREE.Vector3(p.x * 1.6, HEAD_Y + (p.y - HEAD_Y) * 0.4, p.z * 3));
      const iris = this.part(new THREE.SphereGeometry(0.068, 16, 12), eyeMat, eye, { scale: [0.78, 1.18, 0.42], outline: false });
      this.part(new THREE.SphereGeometry(sparkle, 8, 6), shine, iris, { pos: [0.026, 0.032, 0.058], outline: false });
      head.add(eye);
      this.eyes.push(iris);
    }

    // Cheeks (a raccoon's sit below the mask).
    const blush = new THREE.MeshBasicMaterial({ color: '#FF9DB4', transparent: true, opacity: 0.7, depthWrite: false });
    const cheekTheta = Math.PI * (this.species === 'raccoon' ? 0.64 : 0.6);
    for (const side of [1, -1]) {
      const p = headPoint(cheekTheta, Math.PI / 2 - side * 0.58, 0.004 + (this.marksOverEyes() ? MARK_LIFT : 0));
      const cheek = this.part(new THREE.SphereGeometry(0.07, 14, 10), blush, head, { pos: p.toArray() as [number, number, number], scale: [1.15, 0.62, 0.25], outline: false });
      cheek.lookAt(p.clone().sub(new THREE.Vector3(0, HEAD_Y, 0)).multiplyScalar(3).add(new THREE.Vector3(0, HEAD_Y, 0)));
    }
    if (!human) return;

    // Small smile.
    const mouthMat = new THREE.MeshBasicMaterial({ color: '#5A2E3A' });
    const mp = headPoint(Math.PI * 0.64, Math.PI / 2, -0.004);
    const mouth = new THREE.Group();
    mouth.position.copy(mp);
    mouth.lookAt(new THREE.Vector3(0, HEAD_Y - 0.25, mp.z * 3));
    this.part(new THREE.TorusGeometry(0.042, 0.012, 6, 16, Math.PI), mouthMat, mouth, { rot: [0, 0, Math.PI], outline: false });
    head.add(mouth);

    // Brows in a darker hair tone.
    for (const side of [1, -1]) {
      const p = headPoint(Math.PI * 0.43, Math.PI / 2 - side * 0.36, -0.004);
      const brow = new THREE.Group();
      brow.position.copy(p);
      brow.lookAt(new THREE.Vector3(p.x * 1.5, p.y, p.z * 3));
      this.part(new THREE.CapsuleGeometry(0.013, 0.05, 3, 6), this.browMat, brow, { rot: [0, 0, Math.PI / 2 + side * 0.12], outline: false });
      head.add(brow);
    }
  }

  private hairCap(theta = Math.PI * 0.5, lift = 0.035) {
    return this.part(
      new THREE.SphereGeometry(HEAD_R + lift, 36, 20, 0, Math.PI * 2, 0, theta),
      'hair',
      this.head,
      { pos: [0, HEAD_Y, 0], scale: HEAD_SCALE_T },
    );
  }

  private hairBack(thetaStart: number, thetaLength: number, phiStart = Math.PI * 0.92, phiLength = Math.PI * 1.16, lift = 0.03) {
    return this.part(
      new THREE.SphereGeometry(HEAD_R + lift, 36, 14, phiStart, phiLength, thetaStart, thetaLength),
      'hair',
      this.head,
      { pos: [0, HEAD_Y, 0], scale: HEAD_SCALE_T },
    );
  }

  private tuft(theta: number, phi: number, size: number, stretch: [number, number, number] = [1, 0.72, 0.62], tilt = 0, outline = true) {
    const p = headPoint(theta, phi, 0.02);
    const mesh = this.part(new THREE.SphereGeometry(size, 16, 12), 'hair', this.head, {
      pos: p.toArray() as [number, number, number],
      scale: stretch,
      outline,
    });
    const out = p.clone().sub(new THREE.Vector3(0, HEAD_Y, 0)).multiplyScalar(4).add(new THREE.Vector3(0, HEAD_Y, 0));
    mesh.lookAt(out);
    mesh.rotateZ(tilt);
    return mesh;
  }

  private buildHair() {
    const h = this.spec.hair;
    if (h === 'beanie') {
      // Hair peeking out under the hat at the sides and back.
      this.hairBack(Math.PI * 0.36, Math.PI * 0.22, Math.PI * 1.02, Math.PI * 0.96, 0.03);
      // Beanie: sits high on the forehead and tips back, so the eyes stay clear.
      const hat = new THREE.Group();
      hat.position.set(0, HEAD_Y, 0);
      hat.rotation.x = -0.22;
      this.head.add(hat);
      this.part(new THREE.SphereGeometry(HEAD_R + 0.06, 36, 18, 0, Math.PI * 2, 0, Math.PI * 0.37), 'accent', hat, {
        pos: [0, 0.04, 0],
        scale: HEAD_SCALE_T,
      });
      this.part(new THREE.TorusGeometry(0.5, 0.072, 12, 40), 'accent', hat, { pos: [0, 0.25, 0], rot: [Math.PI / 2, 0, 0], scale: [1.06, 1.0, 1] });
      this.part(new THREE.SphereGeometry(0.115, 16, 12), 'accent', hat, { pos: [0, 0.6, 0] });
      return;
    }

    this.hairCap(Math.PI * 0.33);
    if (h === 'tousled') {
      this.hairBack(Math.PI * 0.3, Math.PI * 0.36);
      // [theta, phi, size, tilt, outline]: the two tufts beside the middle sit over their neighbours,
      // so a full outline would draw a ring on the hair; the neighbours' outlines frame them.
      const fringe: Array<[number, number, number, number, boolean]> = [
        [0.335, 0.5, 0.15, 0.2, true],
        [0.34, 0.33, 0.14, -0.35, false],
        [0.34, 0.67, 0.14, 0.4, false],
        [0.38, 0.18, 0.125, -0.6, true],
        [0.38, 0.82, 0.125, 0.6, true],
      ];
      for (const [t, ph, size, tilt, line] of fringe) this.tuft(Math.PI * t, Math.PI * ph, size, [1.08, 0.72, 0.6], tilt, line);
      this.tuft(Math.PI * 0.5, Math.PI * 0.03, 0.13, [0.75, 1.15, 0.6]);
      this.tuft(Math.PI * 0.5, Math.PI * 0.97, 0.13, [0.75, 1.15, 0.6]);
      // A little curl on top.
      this.part(new THREE.TorusGeometry(0.08, 0.027, 8, 16, Math.PI * 1.3), 'hair', this.head, { pos: [0.02, HEAD_Y + 0.56, 0.0], rot: [0, 0.4, 0.6] });
    } else if (h === 'bun') {
      this.hairBack(Math.PI * 0.3, Math.PI * 0.38);
      for (const [t, ph, tilt] of [
        [0.33, 0.4, -0.25],
        [0.33, 0.6, 0.25],
        [0.37, 0.22, -0.5],
        [0.37, 0.78, 0.5],
      ] as const) {
        this.tuft(Math.PI * t, Math.PI * ph, 0.14, [1.12, 0.62, 0.55], tilt);
      }
      this.part(new THREE.SphereGeometry(0.2, 20, 14), 'hair', this.head, { pos: [0, HEAD_Y + 0.5, -0.24] });
      this.part(new THREE.TorusGeometry(0.11, 0.032, 8, 20), 'accent', this.head, { pos: [0, HEAD_Y + 0.4, -0.17], rot: [Math.PI / 2 + 0.55, 0, 0] });
    } else if (h === 'bob') {
      // Rounded bob down to the jaw, open at the face, with a straight fringe.
      this.hairBack(Math.PI * 0.28, Math.PI * 0.5, Math.PI * 0.84, Math.PI * 1.32, 0.05);
      this.part(new THREE.SphereGeometry(HEAD_R + 0.055, 30, 8, Math.PI * 0.14, Math.PI * 0.72, Math.PI * 0.2, Math.PI * 0.17), 'hair', this.head, {
        pos: [0, HEAD_Y, 0],
        scale: HEAD_SCALE_T,
      });
      for (const side of [1, -1]) {
        this.part(new THREE.SphereGeometry(0.15, 16, 12), 'hair', this.head, { pos: [side * 0.45, HEAD_Y - 0.27, 0.03], scale: [0.72, 0.85, 1.25] });
      }
    }
  }

  // ---------------------------------------------------------- animal-people

  /** Markings in one fur colour: soft-edged spots hugging the head, one mesh (no outline: the head's frames them). */
  private markings(key: FurKey, spots: PatchSpot[]) {
    const geo = spherePatchGeometry(HEAD_R, HEAD_SCALE_T, spots.map((s) => ({ lift: MARK_LIFT, ...s })), [0, HEAD_Y, 0]);
    this.part(geo, this.furMat(key), this.head, { outline: false });
  }

  /** A mesh on the face, turned to look straight out from the head's centre. */
  private onFace(geometry: THREE.BufferGeometry, material: PaletteSlot | THREE.Material, at: [number, number, number], scale: [number, number, number], outline = false) {
    const mesh = this.part(geometry, material, this.head, { pos: at, scale, outline });
    mesh.lookAt(at[0] * 3, HEAD_Y + (at[1] - HEAD_Y) * 3, at[2] * 3);
    return mesh;
  }

  /** The small "w" smile under an animal's nose. */
  private animalMouth(at: [number, number, number], width = 0.03) {
    const mouthMat = new THREE.MeshBasicMaterial({ color: '#5A2E3A' });
    const mouth = new THREE.Group();
    mouth.position.set(...at);
    mouth.lookAt(at[0] * 3, HEAD_Y + (at[1] - HEAD_Y) * 3 - 0.3, at[2] * 3);
    for (const side of [1, -1]) {
      this.part(new THREE.TorusGeometry(width / 2, 0.009, 5, 10, Math.PI), mouthMat, mouth, { pos: [(side * width) / 2, 0, 0], rot: [0, 0, Math.PI], outline: false });
    }
    this.head.add(mouth);
  }

  /** An ear's pivot on the head: `tilt` leans it outward, `lean` back. Ears that move are kept for update(). */
  private earPivot(side: number, x: number, y: number, z: number, tilt: number, lean = 0): THREE.Group {
    const g = new THREE.Group();
    g.position.set(side * x, y, z);
    g.rotation.set(lean, 0, -side * tilt);
    this.head.add(g);
    this.ears.push({ group: g, side, x: lean, z: -side * tilt });
    return g;
  }

  private buildTail(shape: TailShape) {
    const fur = { ...defaultFur(this.spec.palette.skin), ...this.spec.fur };
    const colour = (key: FurKey | 'fur') => new THREE.Color(key === 'fur' ? this.spec.palette.skin : key === 'mark2' ? (fur.mark2 ?? fur.mark) : fur[key]);
    const base = colour('fur');
    const bands = shape.bands.map(([from, to, key]): [number, number, THREE.Color] => [from, to, colour(key)]);
    const geo = tailGeometry(shape.points, shape.radius, bands, base, shape.segments);
    const tail = new THREE.Group();
    tail.position.set(...TAIL_ROOT);
    this.body.add(tail);
    this.part(geo, toon('#FFFFFF', { vertexColors: true }), tail);
    // The outline follows the fur, not the white the vertex colours multiply.
    const shell = this.parts.at(-1)?.shell;
    if (shell) inkFor(base, (shell.material as THREE.MeshBasicMaterial).color);
    this.tail = tail;
  }

  private buildAnimal() {
    const sp = this.species;
    const light = this.furMat('light');
    const mark = this.furMat('mark');
    const dark = new THREE.MeshBasicMaterial({ color: '#3A2B33' });
    const pink = new THREE.MeshBasicMaterial({ color: '#F28CA8' });
    const pattern = this.spec.fur?.pattern;
    // A calico's ginger ear is on the same side as its ginger eye patch (the character's right).
    const earColour = (side: number): PaletteSlot | THREE.Material => {
      if (pattern === 'calico') return side > 0 ? this.furMat('mark2') : mark;
      if (pattern === 'points') return mark;
      return 'skin';
    };
    const shape = tailShape(sp, pattern);

    if (sp === 'bunny') {
      // Two long upright ears, leaning out into a soft V.
      for (const side of [1, -1]) {
        const g = this.earPivot(side, 0.17, HEAD_Y + 0.33, -0.03, 0.2, -0.12);
        this.part(new THREE.CapsuleGeometry(0.088, 0.42, 4, 12), 'skin', g, { pos: [0, 0.3, 0], scale: [1, 1, 0.6] });
        this.part(new THREE.CapsuleGeometry(0.046, 0.32, 3, 8), pink, g, { pos: [0, 0.31, 0.044], scale: [1, 1, 0.35], outline: false });
      }
      // A Dutch bunny: a pale blaze from the forehead, widening down to the muzzle.
      if (pattern === 'dutch') this.markings('light', [{ theta: Math.PI * 0.45, phi: Math.PI / 2, a: 0.45, b: 0.085, tilt: -Math.PI / 2, bulge: 0.9 }]);
      this.onFace(new THREE.SphereGeometry(0.085, 14, 10), light, [0, 1.205, 0.468], [1.45, 0.95, 0.5]);
      this.onFace(new THREE.SphereGeometry(0.026, 10, 8), pink, [0, 1.238, 0.505], [1.35, 0.9, 0.7]);
      this.animalMouth([0, 1.175, 0.5]);
      // A round puff of a tail.
      const tail = new THREE.Group();
      tail.position.set(...TAIL_ROOT);
      this.body.add(tail);
      this.part(new THREE.SphereGeometry(0.11, 14, 10), light, tail, { pos: [0, -0.03, -0.08] });
      this.tail = tail;
    } else if (sp === 'cat') {
      // Pointed ears, inner ears in pink.
      for (const side of [1, -1]) {
        const g = this.earPivot(side, 0.25, HEAD_Y + 0.33, 0, 0.3, -0.06);
        this.part(earGeometry(0.15, 0.3), earColour(side), g, { scale: [1, 1, 0.55] });
        this.part(new THREE.ConeGeometry(0.085, 0.18, 12), pink, g, { pos: [0, 0.12, 0.045], scale: [1, 1, 0.35], outline: false });
      }
      if (pattern === 'calico') {
        // Uneven on purpose: ginger over the right eye reaching toward the ginger ear and a ginger dot
        // behind; cocoa over the back of the head and a dot on the left cheek. Nothing sits like a bow.
        this.markings('mark', [
          { theta: Math.PI * 0.48, phi: Math.PI / 2 - 0.55, a: 0.44, b: 0.36, tilt: -0.25, bulge: -0.2 },
          { theta: Math.PI * 0.58, phi: Math.PI * 1.8, a: 0.2, b: 0.16 },
        ]);
        this.markings('mark2', [
          { theta: Math.PI * 0.33, phi: Math.PI * 1.25, a: 0.55, b: 0.42, tilt: 0.4 },
          { theta: Math.PI * 0.61, phi: Math.PI / 2 + 0.86, a: 0.13, b: 0.1 },
        ]);
      } else if (pattern === 'points') {
        // A colour-point mask centred on the nose, widest over the muzzle.
        this.markings('mark', [{ theta: Math.PI * 0.6, phi: Math.PI / 2, a: 0.4, b: 0.5, tilt: -Math.PI / 2, bulge: 0.2 }]);
      }
      // Whisker pads (in the mask's colour on a colour-point), a pink nose and whiskers.
      const pads = pattern === 'points' ? mark : light;
      for (const side of [1, -1]) this.onFace(new THREE.SphereGeometry(0.066, 12, 10), pads, [side * 0.05, 1.198, 0.466], [1.2, 0.9, 0.55]);
      this.onFace(new THREE.SphereGeometry(0.026, 10, 8), pink, [0, 1.238, 0.502], [1.4, 0.85, 0.7]);
      this.animalMouth([0, 1.168, 0.49], 0.026);
      const strokes: Array<[THREE.Vector3, THREE.Vector3]> = [];
      for (const side of [1, -1]) {
        for (const dy of [0.012, -0.022]) strokes.push([new THREE.Vector3(side * 0.1, 1.205 + dy, 0.47), new THREE.Vector3(side * 0.3, 1.215 + dy * 2.2, 0.405)]);
      }
      this.part(strokeGeometry(strokes, 0.01), new THREE.MeshBasicMaterial({ color: '#6B5B66', side: THREE.DoubleSide }), this.head, { outline: false });
    } else if (sp === 'dog') {
      // Floppy ears flaring from the crown's edge, so they break the head's outline from behind too.
      for (const side of [1, -1]) {
        const g = this.earPivot(side, 0.38, HEAD_Y + 0.34, 0, -0.5);
        this.part(new THREE.CapsuleGeometry(0.112, 0.3, 4, 12), mark, g, { pos: [0, -0.25, 0], scale: [0.6, 1, 1] });
      }
      if (pattern === 'blaze') this.markings('light', [{ theta: Math.PI * 0.36, phi: Math.PI / 2, a: 0.42, b: 0.1, tilt: -Math.PI / 2, bulge: 0.6 }]);
      // A round snout with a big nose.
      this.onFace(new THREE.SphereGeometry(0.15, 18, 12), light, [0, 1.19, 0.43], [1.25, 0.9, 1.0], true);
      this.onFace(new THREE.SphereGeometry(0.055, 12, 10), dark, [0, 1.255, 0.58], [1.35, 0.95, 0.9]);
      this.animalMouth([0, 1.14, 0.575], 0.034);
      // A collar in the accent colour with a round tag.
      this.part(new THREE.TorusGeometry(0.19, 0.038, 8, 28), 'accent', this.body, { pos: [0, 0.905, 0], rot: [Math.PI / 2, 0, 0], scale: [1, 0.92, 1] });
      this.part(new THREE.SphereGeometry(0.04, 12, 10), toon('#9FB3C8'), this.body, { pos: [0, 0.858, 0.205], scale: [1, 1, 0.45] });
    } else if (sp === 'fox') {
      // Tall ears with dark tips, pale cheeks rising to the outer eye corners (the orange runs down the nose) and a little pointed snout.
      for (const side of [1, -1]) {
        const g = this.earPivot(side, 0.25, HEAD_Y + 0.31, -0.02, 0.3, -0.06);
        this.part(earGeometry(0.175, 0.36), 'skin', g, { scale: [1, 1, 0.5] });
        // The dark tip: the ear's top part again, a hair larger (the ear is 0.089 wide at y = 0.2).
        this.part(earGeometry(0.095, 0.164, 0.041), mark, g, { pos: [0, 0.2, 0], scale: [1, 1, 0.53], outline: false });
        this.part(new THREE.ConeGeometry(0.1, 0.2, 12), light, g, { pos: [0, 0.13, 0.05], scale: [1, 1, 0.3], outline: false });
      }
      this.markings('light', [
        { theta: Math.PI * 0.65, phi: Math.PI / 2 + 0.4, a: 0.32, b: 0.19, tilt: 0.6 },
        { theta: Math.PI * 0.65, phi: Math.PI / 2 - 0.4, a: 0.32, b: 0.19, tilt: Math.PI - 0.6, lift: MARK_LIFT + 0.0002 },
        { theta: Math.PI * 0.76, phi: Math.PI / 2, a: 0.34, b: 0.2, lift: MARK_LIFT + 0.0004 },
      ]);
      this.onFace(new THREE.SphereGeometry(0.1, 16, 12), light, [0, 1.2, 0.47], [1.2, 0.85, 1.3]);
      this.onFace(new THREE.SphereGeometry(0.035, 10, 8), dark, [0, 1.228, 0.6], [1.25, 0.95, 0.9]);
      this.animalMouth([0, 1.15, 0.584], 0.026);
    } else if (sp === 'squirrel') {
      // Small round ears with tufts, and a tall curled tail rising beside the head.
      for (const side of [1, -1]) {
        const g = this.earPivot(side, 0.24, HEAD_Y + 0.36, -0.04, 0.22, -0.05);
        this.part(new THREE.SphereGeometry(0.1, 12, 10), 'skin', g, { pos: [0, 0.07, 0], scale: [0.8, 1.3, 0.5] });
        this.part(earGeometry(0.05, 0.15, 0.022, 8), mark, g, { pos: [0, 0.165, -0.005], scale: [1, 1, 0.6] });
        this.part(new THREE.SphereGeometry(0.055, 10, 8), light, g, { pos: [0, 0.07, 0.03], scale: [0.8, 1.2, 0.4], outline: false });
      }
      this.onFace(new THREE.SphereGeometry(0.09, 14, 10), light, [0, 1.2, 0.468], [1.4, 1.0, 0.55]);
      this.onFace(new THREE.SphereGeometry(0.028, 10, 8), dark, [0, 1.238, 0.508], [1.3, 0.9, 0.7]);
      this.animalMouth([0, 1.17, 0.502], 0.026);
    } else if (sp === 'raccoon') {
      // Round ears with pale rims; a domino mask (two lobes drooping toward the cheeks, joined over the
      // nose) and two pale brow spots: a rascal's face, not a blindfold.
      for (const side of [1, -1]) {
        const g = this.earPivot(side, 0.28, HEAD_Y + 0.31, -0.03, 0.42, -0.05);
        this.part(new THREE.SphereGeometry(0.13, 14, 10), light, g, { pos: [0, 0.08, 0], scale: [1, 0.95, 0.5] });
        this.part(new THREE.SphereGeometry(0.085, 12, 8), mark, g, { pos: [0, 0.075, 0.035], scale: [1, 0.95, 0.4], outline: false });
      }
      this.markings('mark', [
        { theta: Math.PI * 0.545, phi: Math.PI / 2 + 0.38, a: 0.29, b: 0.18, tilt: -0.35, bulge: 0.3 },
        { theta: Math.PI * 0.545, phi: Math.PI / 2 - 0.38, a: 0.29, b: 0.18, tilt: Math.PI + 0.35, bulge: 0.3, lift: MARK_LIFT + 0.0002 },
        { theta: Math.PI * 0.52, phi: Math.PI / 2, a: 0.14, b: 0.06, lift: MARK_LIFT + 0.0004 },
      ]);
      this.markings('light', [
        { theta: Math.PI * 0.415, phi: Math.PI / 2 + 0.34, a: 0.11, b: 0.065, tilt: 0.15 },
        { theta: Math.PI * 0.415, phi: Math.PI / 2 - 0.34, a: 0.11, b: 0.065, tilt: -0.15 },
      ]);
      this.onFace(new THREE.SphereGeometry(0.11, 14, 10), light, [0, 1.19, 0.468], [1.35, 0.95, 0.6]);
      this.onFace(new THREE.SphereGeometry(0.04, 10, 8), dark, [0, 1.238, 0.52], [1.3, 0.9, 0.8]);
      this.animalMouth([0, 1.158, 0.51], 0.03);
    }
    if (shape) this.buildTail(shape);
  }

  private buildAccessory() {
    const a = this.spec.accessory;
    if (a === 'backpack') {
      this.part(new THREE.CapsuleGeometry(0.17, 0.12, 6, 14), 'accent', this.body, { pos: [0, 0.72, -0.27], scale: [1.05, 1, 0.62] });
      this.part(new THREE.CapsuleGeometry(0.09, 0.05, 4, 10), 'accent', this.body, { pos: [0, 0.63, -0.37], rot: [0, 0, Math.PI / 2], scale: [1, 1, 0.6] });
      // Shoulder straps: two thin bands over the shoulders.
      for (const side of [1, -1]) {
        this.part(new THREE.CapsuleGeometry(0.03, 0.2, 4, 8), 'accent', this.body, { pos: [side * 0.15, 0.86, 0.02], rot: [0.35, 0, side * 0.08], scale: [1, 1, 0.5], outline: false });
      }
    } else if (a === 'tote') {
      const bag = new THREE.Group();
      bag.position.set(0.0, -0.05, 0.0);
      this.armR.add(bag);
      this.part(new RoundedBoxGeometry(0.26, 0.26, 0.08, 1, 0.03), 'accent', bag, { pos: [-0.1, -0.22, 0.02] });
      this.part(new THREE.TorusGeometry(0.11, 0.016, 6, 16, Math.PI), 'accent', bag, { pos: [-0.1, -0.09, 0.02], outline: false });
      this.armR.userData.holding = true;
    } else if (a === 'phone' || a === 'coffee') {
      // The grip sits at the hand and turns against the arm (update), so the cup or phone stays upright.
      const grip = new THREE.Group();
      grip.position.set(0.02, -0.31, 0.01);
      grip.rotation.order = 'ZYX';
      this.armL.add(grip);
      this.grip = grip;
      this.armL.userData.holding = true;
      if (a === 'phone') {
        // Held by its lower edge, screen tipped up toward the face.
        this.part(new RoundedBoxGeometry(0.1, 0.17, 0.025, 1, 0.01), toon('#3B3F5C'), grip, { pos: [0, -0.03, 0.124], rot: [-1.2, 0, 0] });
      } else {
        this.part(new THREE.CylinderGeometry(0.07, 0.055, 0.17, 16), toon('#FFFFFF'), grip, { pos: [0, -0.01, 0.075] });
        this.part(new THREE.CylinderGeometry(0.073, 0.073, 0.06, 16), 'accent', grip, { pos: [0, -0.01, 0.075], outline: false });
      }
    }
  }

  // ---------------------------------------------------------------- control

  setPalette(palette: Partial<ChibiPalette>) {
    for (const [slot, value] of Object.entries(palette) as [PaletteSlot, string][]) {
      if (!value) continue;
      this.spec.palette[slot] = value;
      this.mats.get(slot)?.color.set(value);
    }
    if (palette.hair) inkFor(new THREE.Color(palette.hair), this.browMat.color);
    for (const part of this.parts) {
      if (!part.slot || !part.shell || !(part.slot in palette)) continue;
      inkFor(this.mat(part.slot).color, (part.shell.material as THREE.MeshBasicMaterial).color);
    }
  }

  /** The direction the character is turning to face (radians around +y; 0 faces +z). */
  get facing(): number {
    return this.targetHeading;
  }

  /** Turn to face a direction (radians around +y; 0 faces +z). */
  face(angle: number, immediate = false) {
    this.targetHeading = angle;
    if (immediate) {
      this.heading = angle;
      this.root.rotation.y = angle;
    }
  }

  faceTowards(dx: number, dz: number, immediate = false) {
    if (Math.abs(dx) + Math.abs(dz) < 1e-6) return;
    this.face(Math.atan2(dx, dz), immediate);
  }

  /** A happy double hop. */
  hop(times = 2) {
    this.hopsLeft = times;
    this.hopT = 0;
  }

  update(dt: number) {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    const t = this.time;
    const holdL = !!this.armL.userData.holding;
    const holdR = !!this.armR.userData.holding;

    // Smoothly blend between idle and walk.
    const target = this.walking ? 1 : 0;
    this.walkBlend += (target - this.walkBlend) * Math.min(1, dt * 7);
    const w = this.walkBlend;
    const idle = 1 - w;
    this.phase += dt * Math.PI * 2 * 1.75 * this.walkRate * Math.max(w, 0.0001);

    // Turn toward the heading along the shortest arc.
    let d = this.targetHeading - this.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.heading += d * Math.min(1, dt * 10);
    this.root.rotation.y = this.heading;

    const swing = Math.sin(this.phase);
    const bounce = Math.abs(Math.cos(this.phase));

    // Legs and arms.
    this.legL.rotation.x = swing * 0.62 * w;
    this.legR.rotation.x = -swing * 0.62 * w;
    const sway = Math.sin(t * 1.6) * 0.05 * idle;
    const armSwing = swing * 0.72 * w;
    this.armL.rotation.x = holdL ? HOLD_X - armSwing * 0.25 : -armSwing + sway;
    this.armR.rotation.x = armSwing - sway;
    this.armL.rotation.z = ARM_SPREAD;
    this.armR.rotation.z = -ARM_SPREAD;

    // Body bob, lean and breathing.
    const breathe = Math.sin(t * 2.3);
    this.body.position.y = bounce * 0.065 * w + breathe * 0.006 * idle;
    this.body.rotation.x = 0.08 * w;
    this.body.rotation.z = swing * 0.035 * w + Math.sin(t * 0.8) * 0.018 * idle;
    this.torso.scale.y = 1 + breathe * 0.014 * idle;

    // Head: bob with the steps, look around a little when idle (around lookYaw).
    this.shownLook += (this.lookYaw - this.shownLook) * Math.min(1, dt * 5);
    this.head.rotation.z = -swing * HEAD_MOTION.walkTilt * w + Math.sin(t * 0.7 + 1) * HEAD_MOTION.idleTilt * idle;
    this.head.rotation.y = this.shownLook + Math.sin(t * 0.37) * this.lookAround * idle * (Math.sin(t * 0.11) > 0 ? 1 : 0.3);
    this.head.rotation.x = -HEAD_MOTION.walkNod * w + Math.sin(t * 1.1) * HEAD_MOTION.idleNod * idle;

    // Tails sway (a dog's wags), long ears bob with the steps, floppy ears flap outward.
    const happy = this.hopT >= 0 ? 1 : 0;
    if (this.tail) {
      const sp = this.species;
      const m = TAIL_MOTION;
      if (sp === 'dog') this.tail.rotation.y = Math.sin(t * (happy || w > 0.5 ? 16 : 7)) * (m.wag[0] + (m.wag[1] - m.wag[0]) * Math.max(w, happy));
      else if (sp !== 'bunny') {
        const amp = sp === 'cat' ? m.idleSway.cat : m.idleSway.other;
        this.tail.rotation.y = Math.sin(t * 1.5 + 0.7) * amp * idle + swing * m.walkSway * w;
        this.tail.rotation.x = Math.sin(t * 1.1) * m.idleTilt * idle - bounce * m.walkDip * w;
      }
    }
    for (const ear of this.ears) {
      if (this.species === 'bunny') ear.group.rotation.x = ear.x + Math.sin(t * 2.2 + ear.side) * 0.04 * idle - bounce * 0.12 * w;
      else if (this.species === 'dog') ear.group.rotation.z = ear.z + ear.side * (bounce * 0.2 * w + Math.sin(t * 1.9 + ear.side) * 0.03 * idle);
    }

    // Blinks.
    this.blinkIn -= dt;
    if (this.blinkIn <= 0 && this.blinkT < 0) {
      this.blinkT = 0;
      this.blinkIn = 2 + this.rnd() * 3.5;
    }
    let eyeY = 1;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const k = this.blinkT / 0.14;
      eyeY = k < 0.5 ? 1 - k * 1.8 : 0.1 + (k - 0.5) * 1.8;
      if (k >= 1) {
        this.blinkT = -1;
        eyeY = 1;
      }
    }
    for (const eye of this.eyes) eye.scale.y = 1.18 * Math.max(0.1, Math.min(1, eyeY));

    // Celebration hops: squash, jump, free arms up. A hand holding something only lifts a little.
    if (this.hopT >= 0) {
      this.hopT += dt / 0.48;
      const k = this.hopT;
      const air = Math.sin(Math.min(1, k) * Math.PI);
      this.body.position.y += air * 0.42;
      this.armL.rotation.x = holdL ? HOLD_X - 0.45 * air : -2.5 * air;
      this.armR.rotation.x = holdR ? -0.35 * air : -2.5 * air;
      this.armL.rotation.z = ARM_SPREAD + air * (holdL ? 0.12 : 0.5);
      this.armR.rotation.z = -ARM_SPREAD - air * (holdR ? 0.12 : 0.5);
      const squash = k < 0.12 ? 1 - k * 1.2 : 1;
      this.body.scale.set(2 - squash, squash, 2 - squash);
      if (k >= 1) {
        this.hopsLeft -= 1;
        this.hopT = this.hopsLeft > 0 ? 0 : -1;
        this.body.scale.set(1, 1, 1);
      }
    }

    // Keep a held cup or phone upright against the body: undo the arm's turn.
    if (this.grip) this.grip.rotation.set(-this.armL.rotation.x, 0, -this.armL.rotation.z);
  }

  dispose() {
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        const m = mesh.material as THREE.Material;
        m.dispose();
      }
    });
  }
}
