/**
 * A small walkable street graph built from the vector tiles on screen, so
 * the character walks along streets instead of through buildings.
 *
 * Tiles split streets at tile edges and may simplify away the vertex where
 * two streets cross, so the builder snaps shared vertices, finds crossings
 * and T-junctions geometrically, and splits segments there.
 * Coordinates are local metres (see LocalFrame).
 */

export interface Vec2 {
  x: number;
  z: number;
}

interface Edge {
  a: number;
  b: number;
  len: number;
}

export interface RoadGraph {
  nodes: Vec2[];
  edges: Edge[];
  adj: Array<Array<{ to: number; edge: number }>>;
  center: Vec2;
  radius: number;
}

export interface Snap {
  edge: number;
  t: number;
  point: Vec2;
  dist: number;
}

const SNAP = 0.75; // metres: vertices closer than this are one node
const key = (p: Vec2) => `${Math.round(p.x / SNAP)},${Math.round(p.z / SNAP)}`;

function dist(a: Vec2, b: Vec2) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): { t: number; point: Vec2; dist: number } {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
  const point = { x: a.x + dx * t, z: a.z + dz * t };
  return { t, point, dist: dist(p, point) };
}

export function buildRoadGraph(lines: Vec2[][], center: Vec2, radius: number): RoadGraph {
  // 1. Unique segments near the centre.
  type Seg = { a: Vec2; b: Vec2; cuts: number[] };
  const segs: Seg[] = [];
  const seen = new Set<string>();
  const r2 = (radius + 60) ** 2;
  const near = (p: Vec2) => (p.x - center.x) ** 2 + (p.z - center.z) ** 2 < r2;
  for (const line of lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i];
      const b = line[i + 1];
      if (!near(a) && !near(b)) continue;
      if (dist(a, b) < 0.2) continue;
      const ka = key(a);
      const kb = key(b);
      if (ka === kb) continue;
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      if (seen.has(k)) continue;
      seen.add(k);
      segs.push({ a, b, cuts: [] });
    }
  }

  // 2. Spatial hash for crossings and T-junctions.
  const CELL = 30;
  const grid = new Map<string, number[]>();
  segs.forEach((s, i) => {
    const x0 = Math.floor(Math.min(s.a.x, s.b.x) / CELL);
    const x1 = Math.floor(Math.max(s.a.x, s.b.x) / CELL);
    const z0 = Math.floor(Math.min(s.a.z, s.b.z) / CELL);
    const z1 = Math.floor(Math.max(s.a.z, s.b.z) / CELL);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const k = `${x},${z}`;
        const list = grid.get(k);
        if (list) list.push(i);
        else grid.set(k, [i]);
      }
    }
  });

  const checked = new Set<number>();
  for (const list of grid.values()) {
    for (let m = 0; m < list.length; m++) {
      for (let n = m + 1; n < list.length; n++) {
        const i = list[m];
        const j = list[n];
        const pairKey = i < j ? i * 1_000_003 + j : j * 1_000_003 + i;
        if (checked.has(pairKey)) continue;
        checked.add(pairKey);
        const s = segs[i];
        const u = segs[j];
        // Proper crossing.
        const d1x = s.b.x - s.a.x;
        const d1z = s.b.z - s.a.z;
        const d2x = u.b.x - u.a.x;
        const d2z = u.b.z - u.a.z;
        const den = d1x * d2z - d1z * d2x;
        if (Math.abs(den) > 1e-9) {
          const ox = u.a.x - s.a.x;
          const oz = u.a.z - s.a.z;
          const t = (ox * d2z - oz * d2x) / den;
          const w = (ox * d1z - oz * d1x) / den;
          if (t > 0.001 && t < 0.999 && w > 0.001 && w < 0.999) {
            s.cuts.push(t);
            u.cuts.push(w);
            continue;
          }
        }
        // T-junctions: an end of one segment lying on the other.
        for (const [p, other] of [
          [s.a, u],
          [s.b, u],
          [u.a, s],
          [u.b, s],
        ] as const) {
          const c = closestOnSegment(p, other.a, other.b);
          if (c.dist < 1.5 && c.t > 0.01 && c.t < 0.99) other.cuts.push(c.t);
        }
      }
    }
  }

  // 3. Nodes and edges.
  const nodes: Vec2[] = [];
  const index = new Map<string, number>();
  const nodeFor = (p: Vec2) => {
    const k = key(p);
    let id = index.get(k);
    if (id === undefined) {
      id = nodes.length;
      nodes.push({ x: p.x, z: p.z });
      index.set(k, id);
    }
    return id;
  };
  const edges: Edge[] = [];
  const edgeSeen = new Set<string>();
  for (const s of segs) {
    const ts = [0, ...s.cuts.sort((a, b) => a - b), 1];
    let prev = nodeFor(s.a);
    for (let k = 1; k < ts.length; k++) {
      const p = ts[k] === 1 ? s.b : { x: s.a.x + (s.b.x - s.a.x) * ts[k], z: s.a.z + (s.b.z - s.a.z) * ts[k] };
      const id = nodeFor(p);
      if (id !== prev) {
        const ek = prev < id ? `${prev}-${id}` : `${id}-${prev}`;
        if (!edgeSeen.has(ek)) {
          edgeSeen.add(ek);
          edges.push({ a: prev, b: id, len: dist(nodes[prev], nodes[id]) });
        }
      }
      prev = id;
    }
  }
  const adj: RoadGraph['adj'] = nodes.map(() => []);
  edges.forEach((e, i) => {
    adj[e.a].push({ to: e.b, edge: i });
    adj[e.b].push({ to: e.a, edge: i });
  });
  return { nodes, edges, adj, center, radius };
}

export function snapToGraph(g: RoadGraph, p: Vec2): Snap | null {
  let best: Snap | null = null;
  g.edges.forEach((e, i) => {
    const c = closestOnSegment(p, g.nodes[e.a], g.nodes[e.b]);
    if (!best || c.dist < best.dist) best = { edge: i, t: c.t, point: c.point, dist: c.dist };
  });
  return best;
}

/** Binary min-heap keyed by priority. */
class Heap {
  private items: Array<[number, number]> = [];
  get size() {
    return this.items.length;
  }
  push(node: number, pri: number) {
    const a = this.items;
    a.push([pri, node]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top[1];
  }
}

/**
 * Shortest walk along streets from `from` to `to`. Both ends are snapped
 * onto the nearest street. Returns the polyline to follow, or null if the
 * streets do not connect.
 */
export function findWalk(g: RoadGraph, from: Vec2, to: Vec2): Vec2[] | null {
  const s = snapToGraph(g, from);
  const t = snapToGraph(g, to);
  if (!s || !t) return null;
  if (s.edge === t.edge) return [from, s.point, t.point];

  const START = -1;
  const GOAL = -2;
  const es = g.edges[s.edge];
  const et = g.edges[t.edge];
  const startLinks = [
    { to: es.a, cost: g.edges[s.edge].len * s.t },
    { to: es.b, cost: g.edges[s.edge].len * (1 - s.t) },
  ];
  const goalCost = new Map<number, number>([
    [et.a, et.len * t.t],
    [et.b, et.len * (1 - t.t)],
  ]);

  const gScore = new Map<number, number>();
  const came = new Map<number, number>();
  const heap = new Heap();
  const h = (n: number) => dist(g.nodes[n], t.point);
  for (const l of startLinks) {
    if ((gScore.get(l.to) ?? Infinity) > l.cost) {
      gScore.set(l.to, l.cost);
      came.set(l.to, START);
      heap.push(l.to, l.cost + h(l.to));
    }
  }
  let bestGoal = Infinity;
  let bestLast = -1;
  const closed = new Set<number>();
  while (heap.size > 0) {
    const n = heap.pop();
    if (closed.has(n)) continue;
    closed.add(n);
    const gn = gScore.get(n)!;
    if (gn >= bestGoal) break;
    const toGoal = goalCost.get(n);
    if (toGoal !== undefined && gn + toGoal < bestGoal) {
      bestGoal = gn + toGoal;
      bestLast = n;
    }
    for (const { to, edge } of g.adj[n]) {
      const cand = gn + g.edges[edge].len;
      if (cand < (gScore.get(to) ?? Infinity)) {
        gScore.set(to, cand);
        came.set(to, n);
        heap.push(to, cand + h(to));
      }
    }
  }
  if (bestLast < 0) return null;
  const chain: number[] = [];
  for (let n = bestLast; n !== START; n = came.get(n)!) chain.push(n);
  chain.reverse();
  void GOAL;
  return [from, s.point, ...chain.map((i) => g.nodes[i]), t.point];
}

/** Total length of a polyline in metres. */
export function pathLength(path: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += dist(path[i - 1], path[i]);
  return total;
}
