import * as THREE from 'three';

/**
 * Soft-edged markings that hug a sphere (a head, a plush's tummy): ellipses
 * and teardrops laid on the surface, so a raccoon's mask or a calico's patch
 * has a rounded edge instead of the straight edges of a sphere segment.
 *
 * Angles follow Chibi's headPoint: theta from the top, phi around the
 * vertical (phi = PI/2 faces +z; smaller phi turns toward -x, the
 * character's right).
 */
export interface PatchSpot {
  theta: number;
  phi: number;
  /** Half-length along the major axis and half-width, in radians of arc. */
  a: number;
  b: number;
  /** Turns the major axis from "toward larger phi" (0) toward "up" (PI/2). */
  tilt?: number;
  /** Widens the end the major axis points to (0 is an ellipse, 0.4 a soft teardrop). */
  bulge?: number;
  /** Height above the surface, in the sphere's units before scaling. */
  lift?: number;
}

const RINGS = 4;
const STEPS = 28;

/**
 * One geometry holding every spot (one draw call per colour). `radius` and
 * `scale` describe the sphere the spots lie on, centred at `centre`.
 * Overlapping spots of one colour should get slightly different lifts.
 */
export function spherePatchGeometry(
  radius: number,
  scale: [number, number, number],
  spots: PatchSpot[],
  centre: [number, number, number] = [0, 0, 0],
): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  const d = new THREE.Vector3();
  const east = new THREE.Vector3();
  const up = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const n = new THREE.Vector3();
  const [sx, sy, sz] = scale;
  for (const s of spots) {
    const { theta, phi, a, b, tilt = 0, bulge = 0, lift = 0.006 } = s;
    d.set(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
    east.set(Math.sin(phi), 0, Math.cos(phi));
    up.crossVectors(d, east);
    const r = radius + lift;
    const base = pos.length / 3;
    // Walks `rho` radians from the spot's centre in direction (u, v) on the sphere.
    const vertex = (u: number, v: number) => {
      const rho = Math.hypot(u, v);
      dir.copy(d);
      if (rho > 1e-9) dir.multiplyScalar(Math.cos(rho)).addScaledVector(east, (u / rho) * Math.sin(rho)).addScaledVector(up, (v / rho) * Math.sin(rho));
      pos.push(centre[0] + dir.x * r * sx, centre[1] + dir.y * r * sy, centre[2] + dir.z * r * sz);
      n.set(dir.x / sx, dir.y / sy, dir.z / sz).normalize();
      nor.push(n.x, n.y, n.z);
    };
    vertex(0, 0);
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    for (let k = 1; k <= RINGS; k++) {
      const f = k / RINGS;
      for (let j = 0; j < STEPS; j++) {
        const ang = (j / STEPS) * Math.PI * 2;
        const ex = a * f * Math.cos(ang);
        const ey = b * f * Math.sin(ang) * (1 + bulge * Math.cos(ang));
        vertex(ex * ct - ey * st, ex * st + ey * ct);
      }
    }
    const ring = (k: number, j: number) => base + 1 + (k - 1) * STEPS + (j % STEPS);
    for (let j = 0; j < STEPS; j++) idx.push(base, ring(1, j), ring(1, j + 1));
    for (let k = 1; k < RINGS; k++) {
      for (let j = 0; j < STEPS; j++) {
        idx.push(ring(k, j), ring(k + 1, j), ring(k + 1, j + 1));
        idx.push(ring(k, j), ring(k + 1, j + 1), ring(k, j + 1));
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}
