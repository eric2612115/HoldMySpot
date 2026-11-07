import { describe, expect, it } from 'vitest';
import { BLINK, BlinkClock, JOINTS, REST, angles, blend, hopAt, idle, raiseFreeArms, stand, walk, withHold, type Hold, type Pose } from './cozyPose';

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

describe('the cozy cast poses (the film walk, idle and holds)', () => {
  it('walks in a loop: a phase and the same phase a full turn later give the same pose', () => {
    for (const phase of [0, 0.4, 1.3, 2.9, 4.1]) {
      const a = walk(phase);
      const b = walk(phase + Math.PI * 2);
      for (const j of JOINTS) for (let k = 0; k < 3; k++) expect(close(angles(a, j)[k], angles(b, j)[k], 1e-6), `${j} at ${phase}`).toBe(true);
      expect(close(a.hipsY ?? 0, b.hipsY ?? 0, 1e-9)).toBe(true);
    }
  });

  it('swings the legs and arms in opposition, one stride per half turn', () => {
    const p = walk(Math.PI / 2);
    expect(angles(p, 'legL')[0]).toBeCloseTo(-0.52);
    expect(angles(p, 'legR')[0]).toBeCloseTo(0.52);
    // The arm on the side of the leading leg swings back.
    expect(Math.sign(angles(p, 'shoulderL')[0])).toBe(-Math.sign(angles(p, 'legL')[0]));
    const q = walk((3 * Math.PI) / 2);
    expect(angles(q, 'legL')[0]).toBeCloseTo(0.52);
  });

  it('blends idle into walking joint by joint, from exactly one to exactly the other', () => {
    const a = idle(3.2, 4);
    const b = walk(1.1);
    const at0 = blend(a, b, 0);
    const at1 = blend(a, b, 1);
    for (const j of JOINTS) {
      for (let k = 0; k < 3; k++) {
        expect(close(angles(at0, j)[k], angles(a, j)[k]), j).toBe(true);
        expect(close(angles(at1, j)[k], angles(b, j)[k]), j).toBe(true);
      }
    }
  });

  it('falls back to the rest pose for joints a pose leaves out', () => {
    const empty: Pose = {};
    expect(angles(empty, 'shoulderL')).toEqual(REST.shoulderL);
    expect(angles(empty, 'neck')).toEqual([0, 0, 0]);
  });

  it('keeps idle a gentle breath around standing (no joint more than 0.1 rad from stand)', () => {
    const s = stand();
    for (let t = 0; t < 20; t += 0.37) {
      const p = idle(t, 3);
      for (const j of JOINTS) {
        if (j === 'tail') continue;
        for (let k = 0; k < 3; k++) expect(Math.abs(angles(p, j)[k] - angles(s, j)[k]), `${j} at ${t}`).toBeLessThan(0.1);
      }
    }
  });

  it('keeps a holding arm on its prop while walking, and bows the head only as far as asked', () => {
    const hold: Hold = {
      joints: { shoulderR: { r: [-0.9, 0.1, -0.3] }, elbowR: { r: [-1.4, 0, 0] }, wristR: { r: [0, 0.4, 0] }, neck: { r: [0.12, 0, 0] }, head: { r: [0.2, 0, 0] } },
      arms: ['R'],
    };
    for (const phase of [0, 1, 2, 3]) {
      const p = withHold(walk(phase), hold, 0.35);
      expect(p.shoulderR).toEqual([-0.9, 0.1, -0.3]);
      expect(p.elbowR).toEqual([-1.4, 0, 0]);
      // The free arm still swings with the walk.
      expect(p.shoulderL).toEqual(walk(phase).shoulderL);
      expect(angles(p, 'head')[0]).toBeCloseTo(angles(walk(phase), 'head')[0] + 0.2 * 0.35);
    }
    const flat = withHold(stand(), hold, 0);
    expect(angles(flat, 'neck')).toEqual([0, 0, 0]);
  });

  it('raises only the free arms on a hop', () => {
    const p = raiseFreeArms(stand(), ['R'], 1);
    expect(angles(p, 'shoulderL')[0]).toBeCloseTo(-2.3);
    expect(angles(p, 'shoulderR')).toEqual(angles(stand(), 'shoulderR'));
    expect(raiseFreeArms(stand(), [], 0)).toEqual(stand());
  });

  it('hops off the ground and lands again, squashing only on take-off', () => {
    expect(hopAt(0).air).toBeCloseTo(0);
    expect(hopAt(1).air).toBeCloseTo(0);
    expect(hopAt(0.5).air).toBeCloseTo(1);
    expect(hopAt(0.05).squash).toBeLessThan(1);
    expect(hopAt(0.5).squash).toBe(1);
  });

  it('blinks briefly every 2 to 5.5 seconds', () => {
    const clock = new BlinkClock(7);
    const dt = 1 / 120;
    const starts: number[] = [];
    let was = false;
    let shutFor = 0;
    for (let t = 0; t < 90; t += dt) {
      const shut = clock.shut(t);
      if (shut && !was) starts.push(t);
      shutFor = shut ? shutFor + dt : 0;
      expect(shutFor).toBeLessThanOrEqual(BLINK + dt * 1.5);
      was = shut;
    }
    expect(starts.length).toBeGreaterThan(12);
    for (let i = 1; i < starts.length; i++) {
      const gap = starts[i]! - starts[i - 1]!;
      expect(gap).toBeGreaterThan(2);
      expect(gap).toBeLessThan(5.5 + BLINK + 0.05);
    }
  });
});
