import * as THREE from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { blobShadow, type OutlineSettings } from '../materials/toon';
import { FACE_CELLS, faceUrl, modelUrl, type CastMeta, type CastModel } from './castModels';
import { Chibi, LOOK_AROUND, type ChibiPalette, type Species } from './chibi';
import { castMaterial, type CastUniforms } from './cozyMaterial';
import { BlinkClock, JOINTS, angles, blend, hopAt, idle, raiseFreeArms, walk, withHold, type Hold, type Joint, type Pose } from './cozyPose';
import { specOf, type PersonLook } from './presets';

/**
 * A person of the cozy cast in a three.js scene: the baked plush model of the
 * film's character (castModels.ts), moved by the film's own poses (a bouncy
 * walk, breathing idle), blinking, hopping when something is won, and holding
 * their one prop. The same interface as the older procedural Chibi, so the map
 * and the characters page drive either.
 *
 * Units: about 2 tall with the feet at y = 0, facing +z, like the Chibi.
 *
 * Map mode simplifies for distance: a bigger head, the map's faces (no lashes)
 * and no fabric weave. Stage mode keeps the film's proportions and faces and
 * adds the knit and fabric weaves for close-ups.
 */

/** Model units (the film's figures are about 1 tall) to the app's character units (about 2 tall). */
export const APP_SCALE = 1.92;
/** How much bigger heads are on the map, so faces read from far. */
export const MAP_HEAD = 1.2;
/** How far a phone read bows the head on the map (1 is the film's full bow: the face would turn away from the camera). */
const MAP_BOW = 0.35;
const HOP_TIME = 0.48;
const HOP_HEIGHT = 0.42;

/** What both the cozy people and the older chibis offer the map and the stage. */
export interface Person {
  readonly root: THREE.Group;
  /** Top of the head, ears or tail in character units (for labels). */
  readonly top: number;
  walking: boolean;
  walkRate: number;
  lookYaw: number;
  lookAround: number;
  readonly facing: number;
  face(angle: number, immediate?: boolean): void;
  faceTowards(dx: number, dz: number, immediate?: boolean): void;
  hop(times?: number): void;
  update(dt: number): void;
  setPalette(palette: Partial<ChibiPalette>): void;
  dispose(): void;
}

interface Template {
  scene: THREE.Object3D;
  meta: CastMeta;
  /** Lowest point of the head below its centre (model units, negative), for growing the head upward. */
  headLow: number;
  /** Highest point of the head, ears and ponytails above the head centre. */
  headHigh: number;
}

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const templates = new Map<CastModel, Promise<Template>>();
const HEAD_GROUP = new Set(['head', 'earL', 'earR', 'pony0', 'pony1']);

/** Loads (once) a baked model. */
export function loadCastModel(model: CastModel): Promise<Template> {
  let p = templates.get(model);
  if (!p) {
    p = loader.loadAsync(modelUrl(model)).then((gltf) => {
      const node = gltf.scene.children[0];
      const meta = node.userData as CastMeta;
      let mesh: THREE.SkinnedMesh | null = null;
      node.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
      });
      if (!mesh) throw new Error(`cast model ${model}: no skinned mesh`);
      const m = mesh as THREE.SkinnedMesh;
      const geo = m.geometry;
      const data = geo.getAttribute('_data');
      if (data) {
        geo.setAttribute('castData', data);
        geo.deleteAttribute('_data');
      }
      // The head's reach, from the vertices that ride on the head and what hangs from it.
      const pos = geo.getAttribute('position');
      const skin = geo.getAttribute('skinIndex');
      const headBones = new Set(m.skeleton.bones.map((b, i) => (HEAD_GROUP.has(b.name) ? i : -1)).filter((i) => i >= 0));
      let low = 0;
      let high = 0;
      for (let i = 0; i < pos.count; i++) {
        if (!headBones.has(skin.getX(i))) continue;
        const y = pos.getY(i) * meta.dequant.half + meta.dequant.centre[1] - meta.headCenter[1];
        low = Math.min(low, y);
        high = Math.max(high, y);
      }
      m.frustumCulled = false;
      return { scene: node, meta, headLow: low, headHigh: high };
    });
    templates.set(model, p);
    // A failed load can be tried again later.
    p.catch(() => templates.delete(model));
  }
  return p;
}

const faceTextures = new Map<string, THREE.Texture>();
const textureLoader = new THREE.TextureLoader();

/** A model's face atlas (shared by everyone wearing that model). */
export function castFace(model: CastModel, set: 'stage' | 'map'): THREE.Texture {
  const key = `${model}:${set}`;
  let t = faceTextures.get(key);
  if (!t) {
    t = textureLoader.load(faceUrl(model, set));
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    faceTextures.set(key, t);
  }
  return t;
}

export interface CozyOptions {
  mode: 'map' | 'stage';
  /** Staggers idle motion and blinks in a crowd. */
  seed?: number;
  /** The camera's position in the scene's world, updated by the scene every frame (for the fabric sheen). */
  view: { value: THREE.Vector3 };
  /** Used only if the model cannot load: the older procedural chibi stands in, with this outline. */
  outline?: OutlineSettings;
  /** Live colours for a recolourable model (the player). */
  palette?: Partial<ChibiPalette>;
  /** For the fallback chibi's spec. */
  name?: string;
}

type Bones = Partial<Record<Joint, THREE.Bone>>;

export class CozyPerson implements Person {
  readonly root = new THREE.Group();
  readonly model: CastModel;
  readonly look: PersonLook;
  readonly species: Species;
  top = 2.05;
  walking = false;
  walkRate = 1;
  lookYaw = 0;
  lookAround = LOOK_AROUND;
  /** Resolves once the model is in the scene (or the fallback chibi stands in). */
  readonly ready: Promise<void>;

  private readonly opts: CozyOptions;
  private readonly body = new THREE.Group();
  private readonly shadow: THREE.Mesh;
  private material: (THREE.MeshLambertMaterial & { userData: { cast: CastUniforms } }) | null = null;
  private bones: Bones = {};
  private rest = new Map<Joint, THREE.Vector3>();
  private meta: CastMeta | null = null;
  private hold: Hold | null = null;
  private headLift = 0;
  private fallback: Chibi | null = null;
  private disposed = false;
  private readonly blinks: BlinkClock;
  private readonly seed: number;
  private walkBlend = 0;
  private phase = 0;
  private time: number;
  private heading = 0;
  private targetHeading = 0;
  private shownLook = 0;
  private hopT = -1;
  private hopsLeft = 0;
  private palette: Partial<ChibiPalette>;

  constructor(model: CastModel, look: PersonLook, opts: CozyOptions) {
    this.model = model;
    this.look = look;
    this.species = look.species;
    this.opts = opts;
    this.seed = opts.seed ?? 1;
    this.blinks = new BlinkClock(this.seed);
    this.time = ((this.seed * 7.31) % 10) + 0.5;
    this.palette = { ...(opts.palette ?? {}) };
    this.root.name = `cozy-${model}`;
    this.shadow = blobShadow(0.62, 0.9);
    this.root.add(this.shadow);
    this.body.scale.setScalar(APP_SCALE);
    this.root.add(this.body);
    this.ready = loadCastModel(model).then(
      (t) => this.attach(t),
      () => this.useFallback(),
    );
  }

  private attach(t: Template) {
    if (this.disposed) return;
    const mode = this.opts.mode;
    const node = cloneSkinned(t.scene);
    let mesh: THREE.SkinnedMesh | null = null;
    node.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
    });
    const m = mesh as unknown as THREE.SkinnedMesh;
    const meta = t.meta;
    const material = castMaterial({
      face: castFace(this.model, mode),
      faceCenter: new THREE.Vector3(...meta.headCenter),
      faceSpan: meta.faceSpan,
      dequant: meta.dequant,
      cells: FACE_CELLS.length,
      view: this.opts.view,
      weave: mode === 'stage',
    });
    (m.material as THREE.Material).dispose();
    m.material = material;
    m.frustumCulled = false;
    for (const j of JOINTS) {
      const b = node.getObjectByName(j) as THREE.Bone | undefined;
      if (!b) continue;
      const order = (b.userData.order as THREE.EulerOrder | undefined) ?? 'XYZ';
      b.rotation.order = order;
      this.bones[j] = b;
      this.rest.set(j, b.position.clone());
    }
    this.material = material;
    this.meta = meta;
    this.hold = { joints: meta.hold as Hold['joints'], arms: meta.heldArms };
    if (meta.tint) {
      this.palette = { hair: meta.tint.hair, top: meta.tint.top, bottom: meta.tint.bottom, ...this.palette };
      this.applyTints();
    }
    const headScale = mode === 'map' ? MAP_HEAD : 1;
    this.headLift = (headScale - 1) * -t.headLow;
    this.bones.head?.scale.setScalar(headScale);
    const headTop = meta.headCenter[1] + this.headLift + t.headHigh * headScale;
    this.top = Math.max(meta.height, headTop) * APP_SCALE;
    this.body.add(node);
    this.update(0);
  }

  private useFallback() {
    if (this.disposed) return;
    const chibi = new Chibi(specOf(this.look, this.opts.name ?? this.model, this.seed), this.opts.outline ?? { width: { value: 0.04 } });
    chibi.lookAround = this.lookAround;
    if (Object.keys(this.palette).length) chibi.setPalette(this.palette);
    this.fallback = chibi;
    this.body.scale.setScalar(1);
    this.body.add(chibi.root);
    const own = chibi.root.children.find((c) => c.name === 'blob-shadow');
    if (own) chibi.root.remove(own);
    this.top = chibi.top;
  }

  private applyTints() {
    const u = this.material?.userData.cast;
    if (!u || !this.meta?.tint) return;
    if (this.palette.hair) u.uTintHair.value.set(this.palette.hair);
    if (this.palette.top) u.uTintTop.value.set(this.palette.top);
    if (this.palette.bottom) u.uTintBottom.value.set(this.palette.bottom);
  }

  // ------------------------------------------------------------ control

  setPalette(palette: Partial<ChibiPalette>) {
    this.palette = { ...this.palette, ...palette };
    this.applyTints();
    this.fallback?.setPalette(palette);
  }

  get facing(): number {
    return this.targetHeading;
  }

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

  hop(times = 2) {
    this.hopsLeft = times;
    this.hopT = 0;
    this.fallback?.hop(times);
  }

  /** The pose this frame, before it goes onto the bones: idle and walk blended, then the hold. */
  poseAt(): Pose {
    const w = this.walkBlend;
    // Most of the time a person is only standing or only walking: skip the other pose.
    const p = w < 0.002 ? idle(this.time, this.seed) : w > 0.998 ? walk(this.phase) : blend(idle(this.time, this.seed), walk(this.phase), w);
    return this.hold ? withHold(p, this.hold, this.opts.mode === 'map' ? MAP_BOW : 0.8) : p;
  }

  update(dt: number) {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    const target = this.walking ? 1 : 0;
    this.walkBlend += (target - this.walkBlend) * Math.min(1, dt * 7);
    this.phase += dt * Math.PI * 2 * 1.3 * this.walkRate * Math.max(this.walkBlend, 0.0001);
    let d = this.targetHeading - this.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.heading += d * Math.min(1, dt * 10);
    this.root.rotation.y = this.heading;

    let air = 0;
    let squash = 1;
    let arms = 0;
    if (this.hopT >= 0) {
      this.hopT += dt / HOP_TIME;
      ({ air, squash, arms } = hopAt(this.hopT));
      if (this.hopT >= 1) {
        this.hopsLeft -= 1;
        this.hopT = this.hopsLeft > 0 ? 0 : -1;
      }
    }

    if (this.fallback) {
      this.fallback.walking = this.walking;
      this.fallback.walkRate = this.walkRate;
      this.fallback.lookYaw = this.lookYaw;
      this.fallback.lookAround = this.lookAround;
      this.fallback.update(dt);
      return;
    }
    const meta = this.meta;
    if (!meta || !this.material) return;

    // Free arms go up on a hop; a hand holding something stays on it.
    const p = raiseFreeArms(this.poseAt(), meta.heldArms, arms);
    // The head turns toward lookYaw and looks around a little when idle.
    this.shownLook += (this.lookYaw - this.shownLook) * Math.min(1, dt * 5);
    const idleK = 1 - this.walkBlend;
    const head = angles(p, 'head');
    p.head = [head[0], head[1] + this.shownLook + Math.sin(this.time * 0.37) * this.lookAround * idleK * (Math.sin(this.time * 0.11) > 0 ? 1 : 0.3), head[2]];

    const s = meta.scale;
    for (const j of JOINTS) {
      const b = this.bones[j];
      if (!b) continue;
      const a = angles(p, j);
      b.rotation.set(a[0], a[1], a[2]);
      const rest = this.rest.get(j)!;
      const hold = meta.hold[j];
      if (hold?.t) b.position.set(hold.t[0], hold.t[1], hold.t[2]);
      else b.position.copy(rest);
    }
    const hips = this.bones.hips;
    if (hips) hips.position.y = this.rest.get('hips')!.y + (p.hipsY ?? 0) * s;
    const headBone = this.bones.head;
    if (headBone) headBone.position.y += this.headLift;

    this.body.position.y = air * HOP_HEIGHT;
    this.body.scale.set(APP_SCALE * (2 - squash), APP_SCALE * squash, APP_SCALE * (2 - squash));

    // Face: happy on a hop, a blink now and then, neutral otherwise.
    const cell = this.hopT >= 0 ? 2 : this.blinks.shut(this.time) ? 1 : 0;
    this.material.userData.cast.uCell.value = cell;
  }

  dispose() {
    this.disposed = true;
    this.material?.dispose();
    (this.shadow.material as THREE.Material).dispose();
    this.shadow.geometry.dispose();
    this.fallback?.dispose();
    this.root.removeFromParent();
  }
}
