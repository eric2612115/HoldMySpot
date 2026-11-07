import * as THREE from 'three';
import type { Vec2 } from '../../map/roadGraph';

/** Expanding rings where the player tapped, then a soft pulsing target until arrival. */
export class TapMarker {
  readonly root = new THREE.Group();
  private readonly rings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
  private readonly target: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  private t = -1;
  private active = false;

  constructor(color = '#6C5CE7') {
    for (let i = 0; i < 2; i++) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.85, 1, 48),
        new THREE.MeshBasicMaterial({ color: '#FFFFFF', transparent: true, opacity: 0, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 6;
      this.rings.push(ring);
      this.root.add(ring);
    }
    this.target = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 1, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.target.rotation.x = -Math.PI / 2;
    this.target.renderOrder = 6;
    this.root.add(this.target);
    this.root.visible = false;
  }

  show(p: Vec2) {
    this.root.position.set(p.x, 0.3, p.z);
    this.root.visible = true;
    this.t = 0;
    this.active = true;
  }

  hide() {
    this.active = false;
  }

  update(dt: number) {
    if (this.t < 0) return;
    this.t += dt;
    this.rings.forEach((ring, i) => {
      const k = Math.min(1, Math.max(0, (this.t - i * 0.12) / 0.6));
      ring.scale.setScalar(2 + k * 9);
      ring.material.opacity = (1 - k) * 0.9;
    });
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 6);
    const fade = this.active ? Math.min(1, this.t / 0.2) : Math.max(0, this.target.material.opacity - dt * 3);
    this.target.material.opacity = this.active ? 0.55 + pulse * 0.25 : fade;
    this.target.scale.setScalar(3.2 + pulse * 0.6);
    if (!this.active && this.target.material.opacity <= 0 && this.t > 0.8) {
      this.root.visible = false;
      this.t = -1;
    }
  }
}

/** Dots along the planned walk; they pop away as the player passes them. */
export class PathDots {
  readonly mesh: THREE.InstancedMesh;
  private readonly max: number;
  private points: Array<{ p: Vec2; at: number; life: number }> = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  private readonly s = new THREE.Vector3();
  private readonly v = new THREE.Vector3();

  constructor(max = 120) {
    this.max = max;
    this.mesh = new THREE.InstancedMesh(
      new THREE.CircleGeometry(1, 20),
      new THREE.MeshBasicMaterial({ color: '#6C5CE7', transparent: true, opacity: 0.8, depthWrite: false }),
      max,
    );
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  /** Places dots every `spacing` metres. `at` is each dot's distance along the walk. */
  set(path: Vec2[], spacing = 6) {
    this.points = [];
    let carried = spacing * 0.6;
    let along = 0;
    for (let i = 1; i < path.length && this.points.length < this.max; i++) {
      const a = path[i - 1];
      const b = path[i];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      let d = carried;
      while (d < len && this.points.length < this.max) {
        const k = d / len;
        this.points.push({ p: { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k }, at: along + d, life: 0 });
        d += spacing;
      }
      carried = d - len;
      along += len;
    }
  }

  clear() {
    this.points = [];
    this.mesh.count = 0;
  }

  /** `walked` is how far along the path the player is. */
  update(dt: number, walked: number) {
    let n = 0;
    for (const dot of this.points) {
      const gone = walked >= dot.at;
      dot.life = Math.min(1, dot.life + dt * 5);
      const appear = Math.min(1, Math.max(0, dot.life * 3 - dot.at / 120));
      const size = gone ? Math.max(0, 1 - (walked - dot.at) / 4) : appear;
      if (size <= 0.01) continue;
      this.s.setScalar(size * 1.35);
      this.v.set(dot.p.x, 0.35, dot.p.z);
      this.m.compose(this.v, this.q, this.s);
      this.mesh.setMatrixAt(n++, this.m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
