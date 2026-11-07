/**
 * Poses for the cozy cast as plain data: joint name to Euler angles (radians),
 * the same joints and the same angles the film poses, so a walk on the map is
 * the film's bouncy walk. Pure functions, no three.js objects.
 */

export type R3 = [number, number, number];

export const JOINTS = [
  'hips',
  'spine',
  'neck',
  'head',
  'shoulderL',
  'elbowL',
  'wristL',
  'shoulderR',
  'elbowR',
  'wristR',
  'legL',
  'kneeL',
  'ankleL',
  'legR',
  'kneeR',
  'ankleR',
  'tail',
  'pony0',
  'pony1',
] as const;
export type Joint = (typeof JOINTS)[number];

export type Pose = Partial<Record<Joint, R3>> & {
  /** Hips up or down from rest, in figure units (the figure is about 1 tall). */
  hipsY?: number;
};

/** What a joint does when a pose leaves it out (the film's rest: arms a little out, elbows soft). */
export const REST: Partial<Record<Joint, R3>> = {
  shoulderL: [0.04, 0, 0.26],
  elbowL: [-0.2, 0, 0],
  shoulderR: [0.04, 0, -0.26],
  elbowR: [-0.2, 0, 0],
  legL: [0, 0, 0.02],
  ankleL: [0, 0.1, 0],
  legR: [0, 0, -0.02],
  ankleR: [0, -0.1, 0],
};

const ZERO: R3 = [0, 0, 0];

/** A joint's angles in a pose, falling back to the rest pose. */
export function angles(p: Pose, j: Joint): R3 {
  return p[j] ?? REST[j] ?? ZERO;
}

const add = (a: R3 | undefined, b: R3): R3 => (a ? [a[0] + b[0], a[1] + b[1], a[2] + b[2]] : b);

/** Relaxed standing: arms soft at the sides with a slight bend. */
export function stand(): Pose {
  return {
    shoulderL: [0.06, 0, 0.24],
    shoulderR: [0.06, 0, -0.24],
    elbowL: [-0.26, 0, 0],
    elbowR: [-0.26, 0, 0],
    wristL: [0, 0.25, -0.12],
    wristR: [0, -0.25, 0.12],
    legL: [0, 0, 0.035],
    legR: [0, 0, -0.035],
    ankleL: [0, 0.16, -0.035],
    ankleR: [0, -0.16, 0.035],
  };
}

/** Standing that breathes (t in seconds; the seed staggers a crowd): a slow bob, a weight shift, a drifting head tilt. */
export function idle(t: number, seed = 0): Pose {
  const b = Math.sin((t + seed * 0.7) * Math.PI * 2 * 0.28);
  const w = Math.sin((t + seed * 1.3) * Math.PI * 2 * 0.11);
  const h = Math.sin((t + seed * 0.4) * Math.PI * 2 * 0.07 + 1.1);
  const base = stand();
  return {
    ...base,
    hipsY: 0.003 * b - 0.002 * Math.abs(w),
    hips: [0, 0.03 * w, 0.025 * w],
    spine: [0.012 * b, -0.02 * w, -0.03 * w],
    neck: [0.01 * b, 0.05 * h, 0],
    head: [0.02 * h, 0.06 * h, 0.05 * h + 0.02 * w],
    shoulderL: add(base.shoulderL, [0.03 * b, 0, 0.02 * b]),
    shoulderR: add(base.shoulderR, [0.03 * b, 0, -0.02 * b]),
    legL: add(base.legL, [0, 0, -0.025 * w]),
    legR: add(base.legR, [0, 0, -0.025 * w]),
    kneeL: [Math.max(0, 0.06 * w), 0, 0],
    kneeR: [Math.max(0, -0.06 * w), 0, 0],
    tail: [0.05 * b, 0.3 * Math.sin((t + seed) * Math.PI * 2 * 0.4), 0],
    pony0: [0.03 * b, 0.05 * h, 0.03 * w],
    pony1: [0.03 * b, 0.05 * h, 0.03 * w],
  };
}

/** The film's bouncy walk: phase in radians, one stride per PI. */
export function walk(phase: number, o: { stride?: number; arms?: number; bounce?: number; lean?: number } = {}): Pose {
  const A = o.stride ?? 0.52;
  const S = o.arms ?? 0.55;
  const B = o.bounce ?? 0.02;
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  const legL = -A * s;
  const legR = A * s;
  // How far back each leg is (1 = trailing fully): the trailing foot peels off heel first.
  const backL = Math.max(0, legL / A);
  const backR = Math.max(0, legR / A);
  const kneeL = 0.08 + 1.05 * Math.max(0, c) ** 1.2 + 0.28 * backL;
  const kneeR = 0.08 + 1.05 * Math.max(0, -c) ** 1.2 + 0.28 * backR;
  const ankleL = -(legL + kneeL) * 0.9 + 0.55 * backL;
  const ankleR = -(legR + kneeR) * 0.9 + 0.55 * backR;
  const pony: R3 = [0.12 * Math.cos(2 * phase - 0.9), -0.16 * s, 0.1 * Math.sin(phase - 0.6)];
  return {
    hipsY: B * Math.cos(2 * phase) - 0.004,
    hips: [0, 0.09 * s, 0.025 * c],
    spine: [o.lean ?? 0.05, -0.13 * s, -0.02 * c],
    neck: [0, 0.04 * s, 0],
    head: [0.035 * Math.cos(2 * phase + 0.7), 0.02 * s, 0.03 * c],
    legL: [legL, 0, 0.03],
    kneeL: [kneeL, 0, 0],
    ankleL: [ankleL, 0.08, 0],
    legR: [legR, 0, -0.03],
    kneeR: [kneeR, 0, 0],
    ankleR: [ankleR, -0.08, 0],
    shoulderL: [S * s, 0, 0.24],
    elbowL: [-0.3 - 0.25 * Math.max(0, -s), 0, 0],
    shoulderR: [-S * s, 0, -0.24],
    elbowR: [-0.3 - 0.25 * Math.max(0, s), 0, 0],
    tail: [0.1 * Math.cos(2 * phase), 0.25 * s, 0.05 * c],
    pony0: pony,
    pony1: pony,
  };
}

/** Blends two poses joint by joint (k = 0 gives a, 1 gives b); joints left out fall back to rest first. */
export function blend(a: Pose, b: Pose, k: number): Pose {
  const out: Pose = { hipsY: (a.hipsY ?? 0) + ((b.hipsY ?? 0) - (a.hipsY ?? 0)) * k };
  for (const j of JOINTS) {
    if (!a[j] && !b[j]) continue;
    const x = angles(a, j);
    const y = angles(b, j);
    out[j] = [x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k];
  }
  return out;
}

/** How a held prop holds the arms (and bows the head to read a phone), as the bake stored it per model. */
export interface Hold {
  /** Local rotations of the holding arm's joints, and of the neck and head for a phone read. */
  joints: Partial<Record<Joint, { r: R3; t?: R3 }>>;
  /** Arms that hold something: they keep the hold pose while walking. */
  arms: Array<'L' | 'R'>;
}

/**
 * Puts the hold on top of a pose: holding arms take the hold's angles as they
 * are (so the hands stay on the prop whatever the walk does), the neck and
 * head add the reading bow, scaled by `bow` (0 keeps the face up).
 */
export function withHold(p: Pose, hold: Hold, bow: number): Pose {
  const out: Pose = { ...p };
  for (const [j, h] of Object.entries(hold.joints) as Array<[Joint, { r: R3 }]>) {
    if (j === 'neck' || j === 'head') {
      const a = angles(p, j);
      out[j] = [a[0] + h.r[0] * bow, a[1] + h.r[1] * bow, a[2] + h.r[2] * bow];
    } else out[j] = [h.r[0], h.r[1], h.r[2]];
  }
  return out;
}

/** Raises the free arms for a hop (arms 0..1); an arm that holds something stays on it. */
export function raiseFreeArms(p: Pose, held: ReadonlyArray<'L' | 'R'>, arms: number): Pose {
  if (arms <= 0) return p;
  const out: Pose = { ...p };
  for (const side of ['L', 'R'] as const) {
    if (held.includes(side)) continue;
    const s = side === 'L' ? 1 : -1;
    const sh = angles(p, `shoulder${side}`);
    out[`shoulder${side}`] = [sh[0] + (-2.3 - sh[0]) * arms, sh[1], sh[2] + s * 0.35 * arms];
    const el = angles(p, `elbow${side}`);
    out[`elbow${side}`] = [el[0] * (1 - arms), el[1], el[2]];
  }
  return out;
}

/** One celebration hop at k in 0..1: how high the body is (0 to 1) and how far free arms are raised (0 to 1). */
export function hopAt(k: number): { air: number; squash: number; arms: number } {
  const t = Math.min(1, Math.max(0, k));
  const air = Math.sin(t * Math.PI);
  // A quick squash on take-off, then back to round.
  const squash = t < 0.12 ? 1 - t * 1.2 : 1;
  return { air, squash, arms: Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5) * (1 - Math.max(0, t - 0.75) * 4) };
}

/**
 * Blinks: the next one after 2 to 5.5 s (from a seeded generator), each lasting
 * `BLINK` seconds. Returns whether the eyes are shut at time t, given the
 * schedule so far; call it with increasing t.
 */
export const BLINK = 0.13;
export class BlinkClock {
  private next: number;
  private rnd: () => number;
  constructor(seed: number) {
    let s = (seed * 9301 + 49297) % 233280;
    this.rnd = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
    this.next = 1 + this.rnd() * 3;
  }
  shut(t: number): boolean {
    if (t >= this.next + BLINK) this.next = t + 2 + this.rnd() * 3.5;
    return t >= this.next && t < this.next + BLINK;
  }
}
