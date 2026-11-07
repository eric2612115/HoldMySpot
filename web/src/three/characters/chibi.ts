import * as THREE from 'three';
import { addOutline, blobShadow, inkFor, toon, type OutlineSettings } from '../materials/toon';

/**
 * Original chibi humans built from primitives: a big round head, a small
 * body, simple friendly faces and everyday clothes. Everything here is
 * procedural, so the characters are fully ours.
 *
 * Units: the character is about 2 units tall with its feet at y = 0 and it
 * faces +z. Scale the root to place it in a scene.
 */

export interface ChibiPalette {
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

export interface ChibiSpec {
  name: string;
  hair: HairStyle;
  top: TopStyle;
  accessory: Accessory;
  palette: ChibiPalette;
  /** Small per-character differences so a crowd does not move in lockstep. */
  seed?: number;
}

type Part = { mesh: THREE.Mesh; slot: PaletteSlot | null; shell: THREE.Mesh | null };

const HEAD_Y = 1.38;
const HEAD_R = 0.5;
const HEAD_SCALE = new THREE.Vector3(1.06, 0.96, 1.0);

/** Point on the head surface for spherical angles (theta from the top, phi around; phi = PI/2 is the face). */
function headPoint(theta: number, phi: number, lift = 0): THREE.Vector3 {
  const r = HEAD_R + lift;
  return new THREE.Vector3(
    -r * Math.cos(phi) * Math.sin(theta) * HEAD_SCALE.x,
    r * Math.cos(theta) * HEAD_SCALE.y + HEAD_Y,
    r * Math.sin(phi) * Math.sin(theta) * HEAD_SCALE.z,
  );
}

export class Chibi {
  readonly root = new THREE.Group();
  readonly spec: ChibiSpec;
  /** Set by whoever drives the character. */
  walking = false;
  /** 1 is a normal walk; higher plays the cycle faster. */
  walkRate = 1;

  private readonly outline: OutlineSettings;
  private readonly mats = new Map<PaletteSlot, THREE.MeshToonMaterial>();
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
  private walkBlend = 0;
  private phase = 0;
  private blinkIn: number;
  private blinkT = -1;
  private hopT = -1;
  private hopsLeft = 0;
  private heading = 0;
  private targetHeading = 0;
  private time = 0;
  private readonly rnd: () => number;

  constructor(spec: ChibiSpec, outline: OutlineSettings) {
    this.spec = spec;
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
    this.buildHair();
    this.buildAccessory();
  }

  // ---------------------------------------------------------------- build

  private mat(slot: PaletteSlot): THREE.MeshToonMaterial {
    return this.mats.get(slot)!;
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
      // Open jacket: an inner shirt panel in the accent colour and a collar.
      this.part(new THREE.CapsuleGeometry(0.075, 0.24, 4, 10), 'accent', this.body, { pos: [0, 0.7, 0.2], scale: [1, 1, 0.55], outline: false });
      for (const side of [1, -1]) {
        this.part(new THREE.BoxGeometry(0.12, 0.05, 0.1), 'top', this.body, { pos: [side * 0.09, 0.92, 0.12], rot: [0.5, 0, side * 0.5] });
      }
    } else {
      // Tee: a small round chest badge in the accent colour.
      this.part(new THREE.CircleGeometry(0.05, 18), 'accent', this.body, { pos: [0.1, 0.78, 0.232], rot: [-0.08, 0.32, 0], outline: false });
    }
    return torso;
  }

  private buildArms() {
    const longSleeves = this.spec.top !== 'tee';
    for (const [arm, side] of [
      [this.armL, 1],
      [this.armR, -1],
    ] as const) {
      arm.position.set(side * 0.235, 0.86, 0);
      arm.rotation.z = side * 0.16;
      this.body.add(arm);
      if (longSleeves) {
        this.part(new THREE.CapsuleGeometry(0.082, 0.2, 5, 12), 'top', arm, { pos: [0, -0.15, 0] });
      } else {
        this.part(new THREE.CapsuleGeometry(0.088, 0.06, 5, 12), 'top', arm, { pos: [0, -0.07, 0] });
        this.part(new THREE.CapsuleGeometry(0.066, 0.13, 5, 12), 'skin', arm, { pos: [0, -0.18, 0] });
      }
      this.part(new THREE.SphereGeometry(0.083, 14, 10), 'skin', arm, { pos: [0, -0.31, 0.01] });
    }
  }

  private buildHead() {
    const head = this.head;
    this.part(new THREE.SphereGeometry(HEAD_R, 36, 26), 'skin', head, { pos: [0, HEAD_Y, 0], scale: HEAD_SCALE.toArray() as [number, number, number] });
    // Ears.
    for (const side of [1, -1]) {
      this.part(new THREE.SphereGeometry(0.085, 12, 10), 'skin', head, { pos: [side * 0.515, HEAD_Y - 0.03, 0.02], scale: [0.6, 1, 0.9] });
    }

    // Eyes: tall dark ovals with a sparkle.
    const eyeMat = new THREE.MeshBasicMaterial({ color: '#2B2340' });
    const shine = new THREE.MeshBasicMaterial({ color: '#FFFFFF' });
    for (const side of [1, -1]) {
      const p = headPoint(Math.PI * 0.53, Math.PI / 2 - side * 0.36, -0.012);
      const eye = new THREE.Group();
      eye.position.copy(p);
      eye.lookAt(new THREE.Vector3(p.x * 1.6, HEAD_Y + (p.y - HEAD_Y) * 0.4, p.z * 3));
      const iris = this.part(new THREE.SphereGeometry(0.068, 16, 12), eyeMat, eye, { scale: [0.78, 1.18, 0.42], outline: false });
      this.part(new THREE.SphereGeometry(0.024, 8, 6), shine, iris, { pos: [0.026, 0.032, 0.058], outline: false });
      head.add(eye);
      this.eyes.push(iris);
    }

    // Cheeks.
    const blush = new THREE.MeshBasicMaterial({ color: '#FF9DB4', transparent: true, opacity: 0.7, depthWrite: false });
    for (const side of [1, -1]) {
      const p = headPoint(Math.PI * 0.6, Math.PI / 2 - side * 0.58, 0.004);
      const cheek = this.part(new THREE.SphereGeometry(0.07, 14, 10), blush, head, { pos: p.toArray() as [number, number, number], scale: [1.15, 0.62, 0.25], outline: false });
      cheek.lookAt(p.clone().sub(new THREE.Vector3(0, HEAD_Y, 0)).multiplyScalar(3).add(new THREE.Vector3(0, HEAD_Y, 0)));
    }

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
      { pos: [0, HEAD_Y, 0], scale: HEAD_SCALE.toArray() as [number, number, number] },
    );
  }

  private hairBack(thetaStart: number, thetaLength: number, phiStart = Math.PI * 0.92, phiLength = Math.PI * 1.16, lift = 0.03) {
    return this.part(
      new THREE.SphereGeometry(HEAD_R + lift, 36, 14, phiStart, phiLength, thetaStart, thetaLength),
      'hair',
      this.head,
      { pos: [0, HEAD_Y, 0], scale: HEAD_SCALE.toArray() as [number, number, number] },
    );
  }

  private tuft(theta: number, phi: number, size: number, stretch: [number, number, number] = [1, 0.72, 0.62], tilt = 0) {
    const p = headPoint(theta, phi, 0.02);
    const mesh = this.part(new THREE.SphereGeometry(size, 16, 12), 'hair', this.head, {
      pos: p.toArray() as [number, number, number],
      scale: stretch,
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
        scale: HEAD_SCALE.toArray() as [number, number, number],
      });
      this.part(new THREE.TorusGeometry(0.5, 0.072, 12, 40), 'accent', hat, { pos: [0, 0.25, 0], rot: [Math.PI / 2, 0, 0], scale: [1.06, 1.0, 1] });
      this.part(new THREE.SphereGeometry(0.115, 16, 12), 'accent', hat, { pos: [0, 0.6, 0] });
      return;
    }

    this.hairCap(Math.PI * 0.33);
    if (h === 'tousled') {
      this.hairBack(Math.PI * 0.3, Math.PI * 0.36);
      const fringe: Array<[number, number, number, number]> = [
        [0.335, 0.5, 0.15, 0.2],
        [0.34, 0.33, 0.14, -0.35],
        [0.34, 0.67, 0.14, 0.4],
        [0.38, 0.18, 0.125, -0.6],
        [0.38, 0.82, 0.125, 0.6],
      ];
      for (const [t, ph, size, tilt] of fringe) this.tuft(Math.PI * t, Math.PI * ph, size, [1.08, 0.72, 0.6], tilt);
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
        scale: HEAD_SCALE.toArray() as [number, number, number],
      });
      for (const side of [1, -1]) {
        this.part(new THREE.SphereGeometry(0.15, 16, 12), 'hair', this.head, { pos: [side * 0.45, HEAD_Y - 0.27, 0.03], scale: [0.72, 0.85, 1.25] });
      }
    }
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
      this.part(new THREE.BoxGeometry(0.26, 0.26, 0.08), 'accent', bag, { pos: [-0.1, -0.22, 0.02] });
      this.part(new THREE.TorusGeometry(0.11, 0.016, 6, 16, Math.PI), 'accent', bag, { pos: [-0.1, -0.09, 0.02], outline: false });
    } else if (a === 'phone') {
      const phone = toon('#3B3F5C');
      this.part(new THREE.BoxGeometry(0.1, 0.17, 0.025), phone, this.armL, { pos: [0.0, -0.36, 0.08], rot: [-0.9, 0, 0] });
      this.armL.userData.holding = true;
    } else if (a === 'coffee') {
      const cup = toon('#FFFFFF');
      this.part(new THREE.CylinderGeometry(0.07, 0.055, 0.17, 16), cup, this.armL, { pos: [0, -0.36, 0.07] });
      this.part(new THREE.CylinderGeometry(0.073, 0.073, 0.06, 16), 'accent', this.armL, { pos: [0, -0.36, 0.07], outline: false });
      this.armL.userData.holding = true;
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
    this.armL.rotation.x = this.armL.userData.holding ? -0.55 - armSwing * 0.25 : -armSwing + sway;
    this.armR.rotation.x = armSwing - sway;

    // Body bob, lean and breathing.
    const breathe = Math.sin(t * 2.3);
    this.body.position.y = bounce * 0.065 * w + breathe * 0.006 * idle;
    this.body.rotation.x = 0.08 * w;
    this.body.rotation.z = swing * 0.035 * w + Math.sin(t * 0.8) * 0.018 * idle;
    this.torso.scale.y = 1 + breathe * 0.014 * idle;

    // Head: bob with the steps, look around a little when idle.
    this.head.rotation.z = -swing * 0.05 * w + Math.sin(t * 0.7 + 1) * 0.04 * idle;
    this.head.rotation.y = Math.sin(t * 0.37) * 0.28 * idle * (Math.sin(t * 0.11) > 0 ? 1 : 0.3);
    this.head.rotation.x = -0.03 * w + Math.sin(t * 1.1) * 0.02 * idle;

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

    // Celebration hops: squash, jump, arms up.
    if (this.hopT >= 0) {
      this.hopT += dt / 0.48;
      const k = this.hopT;
      const air = Math.sin(Math.min(1, k) * Math.PI);
      this.body.position.y += air * 0.42;
      this.armL.rotation.x = -2.5 * air;
      this.armR.rotation.x = -2.5 * air;
      this.armL.rotation.z = 0.16 + air * 0.5;
      this.armR.rotation.z = -0.16 - air * 0.5;
      const squash = k < 0.12 ? 1 - k * 1.2 : 1;
      this.body.scale.set(2 - squash, squash, 2 - squash);
      if (k >= 1) {
        this.hopsLeft -= 1;
        this.hopT = this.hopsLeft > 0 ? 0 : -1;
        this.body.scale.set(1, 1, 1);
        this.armL.rotation.z = 0.16;
        this.armR.rotation.z = -0.16;
      }
    }
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
