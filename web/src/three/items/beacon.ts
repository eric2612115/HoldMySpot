import * as THREE from 'three';
import type { ItemLook } from '../../domain/types';
import type { OutlineSettings } from '../materials/toon';
import { radialGlow, sparkle, verticalFade } from '../materials/textures';
import { createItemModel } from './models';

const MAX_SPARKLES = 28;

function easeOutBack(t: number) {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

/**
 * A task point on the map: the item floating over a glowing spot. The glow,
 * the light column, the pings and the sparkles all grow with demand.
 * Local units: the item is about one unit across.
 */
export class TaskBeacon {
  readonly root = new THREE.Group();
  readonly itemAnchor = new THREE.Group();
  /** Height (local units) where the floating label should sit. */
  readonly labelHeight = 2.45;
  selected = false;

  private readonly color: THREE.Color;
  private readonly item: THREE.Group;
  private readonly glow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private readonly pings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
  private readonly column: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  private readonly halo: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly sparkles: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly seeds: Float32Array;
  private demand = 0;
  private shownDemand = 0;
  /** Plush toys face the camera with a gentle sway instead of spinning (a face reads better than a back). */
  private readonly faces: boolean;
  private faceYaw = 0;
  private drop = 0;
  private pop = 0;
  private appearAt = Infinity;
  private bumpT = -1;
  private t = Math.random() * 10;

  constructor(look: ItemLook, hue: string, outline: OutlineSettings) {
    this.color = new THREE.Color(hue);
    this.faces = look === 'bunny' || look === 'cat' || look === 'otter' || look === 'pup';
    this.root.name = `beacon-${look}`;
    this.root.visible = false;

    const soft = (opacity: number, map?: THREE.Texture) =>
      new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity, depthWrite: false, ...(map ? { map } : {}) });

    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 4.2), soft(0.5, radialGlow()));
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.position.y = 0.02;
    this.glow.renderOrder = 1;
    this.root.add(this.glow);

    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.98, 1.12, 64), soft(0.9));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.04;
    this.ring.renderOrder = 2;
    this.root.add(this.ring);

    for (let i = 0; i < 2; i++) {
      const ping = new THREE.Mesh(new THREE.RingGeometry(0.94, 1.0, 64), soft(0));
      ping.rotation.x = -Math.PI / 2;
      ping.position.y = 0.03;
      ping.renderOrder = 2;
      this.pings.push(ping);
      this.root.add(ping);
    }

    const columnMat = soft(0.3, verticalFade());
    columnMat.side = THREE.DoubleSide;
    this.column = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.8, 3.6, 32, 1, true), columnMat);
    this.column.position.y = 1.8;
    this.column.renderOrder = 3;
    this.root.add(this.column);

    this.itemAnchor.position.y = 1.25;
    this.root.add(this.itemAnchor);

    // A camera-facing glow behind the item (a plain plane turned toward the
    // camera each frame; sprites do not billboard inside a map custom layer).
    this.halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), soft(0.55, radialGlow()));
    this.halo.renderOrder = 4;
    this.itemAnchor.add(this.halo);

    this.item = createItemModel(look, outline);
    this.item.scale.setScalar(1.05);
    this.itemAnchor.add(this.item);

    // Sparkles rising around the item.
    const pos = new Float32Array(MAX_SPARKLES * 3);
    this.seeds = new Float32Array(MAX_SPARKLES * 3);
    for (let i = 0; i < MAX_SPARKLES; i++) {
      this.seeds[i * 3] = Math.random() * Math.PI * 2;
      this.seeds[i * 3 + 1] = Math.random();
      this.seeds[i * 3 + 2] = 0.55 + Math.random() * 0.7;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.sparkles = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        map: sparkle(),
        color: new THREE.Color('#FFFFFF').lerp(this.color, 0.35),
        size: 9,
        sizeAttenuation: false,
        transparent: true,
        depthWrite: false,
        opacity: 0.95,
      }),
    );
    this.sparkles.frustumCulled = false;
    this.sparkles.renderOrder = 5;
    this.root.add(this.sparkles);
  }

  /** 0..1, from the number of bids. */
  setDemand(level: number) {
    this.demand = Math.max(0, Math.min(1, level));
  }

  /** Pop in after `delay` seconds. */
  appear(delay: number) {
    this.appearAt = this.t + delay;
  }

  /** A quick hop when a new bid lands. */
  bump() {
    this.bumpT = 0;
  }

  /** Item centre in local units, for hit tests. */
  get itemCenterY() {
    return this.itemAnchor.position.y;
  }

  /**
   * Where the floating label points, in local units. It follows the item's
   * drop-in but not its bob or hop, so the label stays steady.
   */
  get labelY() {
    return this.labelHeight + this.drop;
  }

  /** 0 to 1 while the item pops in, then 1. Labels pop with it. */
  get popScale() {
    return this.pop;
  }

  /**
   * Turns the halo toward the camera and sizes sparkles in device pixels.
   * Call right before rendering, with the camera position in world space.
   */
  billboard(cameraWorld: THREE.Vector3, pixelRatio = 1) {
    if (!this.root.visible) return;
    this.halo.lookAt(cameraWorld);
    this.faceYaw = Math.atan2(cameraWorld.x - this.root.position.x, cameraWorld.z - this.root.position.z);
    this.sparkles.material.size = (7 + this.shownDemand * 6) * pixelRatio;
  }

  update(dt: number) {
    this.t += dt;
    const since = this.t - this.appearAt;
    if (since < 0) {
      this.root.visible = false;
      this.pop = 0;
      return;
    }
    this.root.visible = true;
    const popK = Math.min(1, since / 0.7);
    const pop = popK >= 1 ? 1 : Math.max(0, easeOutBack(popK));
    this.pop = Math.min(1, pop);

    // Demand eases in, so new bids brighten the spot smoothly.
    this.shownDemand += (this.demand - this.shownDemand) * Math.min(1, dt * 2.5);
    const d = this.shownDemand;
    const sel = this.selected ? 1 : 0;

    // Floating item: drop in, bob, spin.
    const drop = (1 - Math.min(1, since / 0.45)) ** 2 * 2.4;
    this.drop = drop;
    let hop = 0;
    if (this.bumpT >= 0) {
      this.bumpT += dt / 0.5;
      hop = Math.sin(Math.min(1, this.bumpT) * Math.PI) * 0.35;
      if (this.bumpT >= 1) this.bumpT = -1;
    }
    this.itemAnchor.position.y = 1.25 + Math.sin(this.t * 2.1) * 0.08 + drop + hop;
    if (this.faces) this.item.rotation.y = this.faceYaw + Math.sin(this.t * (1.1 + sel * 0.8)) * (0.45 + sel * 0.25);
    else this.item.rotation.y += dt * (0.55 + d * 0.5 + sel * 0.8);
    this.itemAnchor.scale.setScalar(pop * (1 + sel * 0.12));

    // Ground glow and ring.
    const breathe = 0.5 + 0.5 * Math.sin(this.t * (1.6 + d * 2.2));
    this.glow.material.opacity = (0.18 + d * 0.5 + sel * 0.15) * (0.85 + breathe * 0.15) * pop;
    this.glow.scale.setScalar(0.75 + d * 0.55 + sel * 0.15);
    this.ring.material.opacity = (0.55 + d * 0.4) * pop;
    this.ring.scale.setScalar((0.82 + d * 0.3 + sel * 0.12) * pop);

    // Pings: expanding rings, faster and brighter when demand is high.
    const period = 2.6 - d * 1.3;
    this.pings.forEach((ping, i) => {
      const k = ((this.t / period + i * 0.5) % 1 + 1) % 1;
      ping.scale.setScalar(0.9 + k * (1.1 + d * 0.9));
      ping.material.opacity = (1 - k) ** 1.6 * (0.25 + d * 0.6) * pop;
    });

    // Light column.
    this.column.material.opacity = (0.06 + d * 0.24 + sel * 0.1) * pop;
    this.column.scale.set(0.8 + d * 0.3, 0.7 + d * 0.5, 0.8 + d * 0.3);
    this.column.position.y = 1.8 * this.column.scale.y;

    // Halo behind the item.
    const haloSize = (1.5 + d * 1.6 + sel * 0.4) * (0.94 + breathe * 0.06);
    this.halo.scale.set(haloSize, haloSize, 1);
    this.halo.material.opacity = 0.25 + d * 0.45;

    // Sparkles.
    const count = Math.round(4 + d * (MAX_SPARKLES - 4));
    const pos = this.sparkles.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < count; i++) {
      const a = this.seeds[i * 3];
      const off = this.seeds[i * 3 + 1];
      const r = this.seeds[i * 3 + 2];
      const k = (this.t * (0.22 + d * 0.25) + off) % 1;
      const ang = a + this.t * 0.4;
      pos.setXYZ(i, Math.cos(ang) * r * (1 - k * 0.3), 0.3 + k * 2.9, Math.sin(ang) * r * (1 - k * 0.3));
    }
    pos.needsUpdate = true;
    this.sparkles.geometry.setDrawRange(0, count);
    this.sparkles.material.opacity = 0.9 * pop;
  }
}
