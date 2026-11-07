import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ANIMAL_SPECIES, HEAD_MOTION, HEAD_R, HEAD_SCALE_T, HEAD_Y, TAIL_MOTION, TAIL_ROOT, tailShape, type Species } from './chibi';

/** The widest outline any scene draws (the map's). */
const OUTLINE = 0.05;
const SAMPLES = 80;

/**
 * Poses at the limits update() reaches, for idle (w = 0), walking (w = 1) and the blends between:
 * the tail's sway and tilt, the head's side tilt and nod (it turns around the body's origin).
 */
function poses(species: Species): Array<{ tail: THREE.Euler; head: THREE.Euler }> {
  const m = TAIL_MOTION;
  const h = HEAD_MOTION;
  const out: Array<{ tail: THREE.Euler; head: THREE.Euler }> = [];
  for (const w of [0, 0.25, 0.5, 0.75, 1]) {
    const idle = 1 - w;
    const sway = species === 'dog' ? m.wag[1] : (species === 'cat' ? m.idleSway.cat : m.idleSway.other) * idle + m.walkSway * w;
    const tilts = species === 'dog' ? [0] : [-m.idleTilt * idle - m.walkDip * w, 0, m.idleTilt * idle];
    const headTilt = h.idleTilt * idle + h.walkTilt * w;
    const nods = [-h.idleNod * idle - h.walkNod * w, h.idleNod * idle - h.walkNod * w];
    for (const yaw of [-sway, 0, sway])
      for (const pitch of tilts)
        for (const z of [-headTilt, 0, headTilt]) for (const x of nods) out.push({ tail: new THREE.Euler(pitch, yaw, 0), head: new THREE.Euler(x, 0, z) });
  }
  return out;
}

describe('tails stay clear of the head', () => {
  for (const species of ANIMAL_SPECIES) {
    const shape = tailShape(species);
    if (!shape) continue;
    it(`${species}: at every sway and head pose, idle or walking, the whole tail stays a tail radius plus an outline outside the head`, () => {
      const curve = new THREE.CatmullRomCurve3(shape.points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
      const [rx, ry, rz] = HEAD_SCALE_T.map((s) => s * HEAD_R) as [number, number, number];
      const root = new THREE.Vector3(...TAIL_ROOT);
      const inv = new THREE.Matrix4();
      const p = new THREE.Vector3();
      let worst = { k: Infinity, at: '' };
      for (const { tail, head } of poses(species)) {
        inv.makeRotationFromEuler(head).invert();
        for (let i = 0; i <= SAMPLES; i++) {
          const t = i / SAMPLES;
          curve.getPointAt(t, p).applyEuler(tail).add(root).applyMatrix4(inv);
          // Outside the head grown by the tail's radius and the outline: k >= 1.
          const m = shape.radius(t) + OUTLINE;
          const k = (p.x / (rx + m)) ** 2 + ((p.y - HEAD_Y) / (ry + m)) ** 2 + (p.z / (rz + m)) ** 2;
          if (k < worst.k) worst = { k, at: `t=${t.toFixed(2)} sway=${tail.y.toFixed(3)} tilt=${tail.x.toFixed(3)} head tilt=${head.z.toFixed(3)} nod=${head.x.toFixed(3)}` };
        }
      }
      expect(worst.k, worst.at).toBeGreaterThanOrEqual(1);
    });
  }

  it('gives every animal but the bunny a tail, and humans none', () => {
    expect(tailShape('human')).toBeNull();
    expect(tailShape('bunny')).toBeNull();
    for (const s of ANIMAL_SPECIES.filter((x) => x !== 'bunny')) expect(tailShape(s), s).not.toBeNull();
  });
});
