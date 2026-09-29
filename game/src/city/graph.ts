import type { Manifest } from './format';

export interface GraphEdge {
  a: number;
  b: number;
  l: number; // length (m)
  c: string; // class
  n: string; // street name
  o: number; // 1 one-way a->b, -1 one-way b->a, 0 two-way
  w: number; // width (m)
  p: number[]; // polyline x,z,... from a to b
}

const CLASS_COST: Record<string, number> = {
  motorway: 0.7,
  trunk: 0.75,
  primary: 0.85,
  secondary: 0.95,
  tertiary: 1.05,
  residential: 1.35,
  unclassified: 1.4,
  living_street: 2.5,
  parkdrive: 1.0,
};

/** Min-heap of (cost, node) */
class Heap {
  private c: number[] = [];
  private n: number[] = [];
  get size() {
    return this.c.length;
  }
  push(cost: number, node: number) {
    const c = this.c, n = this.n;
    let i = c.length;
    c.push(cost);
    n.push(node);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (c[p] <= c[i]) break;
      [c[p], c[i]] = [c[i], c[p]];
      [n[p], n[i]] = [n[i], n[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const c = this.c, n = this.n;
    const top: [number, number] = [c[0], n[0]];
    const lc = c.pop()!, ln = n.pop()!;
    if (c.length) {
      c[0] = lc;
      n[0] = ln;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < c.length && c[l] < c[m]) m = l;
        if (r < c.length && c[r] < c[m]) m = r;
        if (m === i) break;
        [c[m], c[i]] = [c[i], c[m]];
        [n[m], n[i]] = [n[i], n[m]];
        i = m;
      }
    }
    return top;
  }
}

const CELL = 80;

/** The drivable street network (from scripts/build_tiles.py → graph.json). */
export class StreetGraph {
  readonly nodes: Float32Array; // x,z pairs
  readonly edges: GraphEdge[];
  readonly adj: number[][]; // node -> edge indices
  /** connected-component id per node; `main` is the big Manhattan one */
  readonly comp: Int32Array;
  readonly main: number;
  private grid = new Map<number, number[]>();

  constructor(data: { nodes: number[][]; edges: GraphEdge[] }) {
    const n = data.nodes.length;
    this.nodes = new Float32Array(n * 2);
    data.nodes.forEach(([x, z], i) => {
      this.nodes[i * 2] = x;
      this.nodes[i * 2 + 1] = z;
      const k = this.key(x, z);
      let a = this.grid.get(k);
      if (!a) this.grid.set(k, (a = []));
      a.push(i);
    });
    this.edges = data.edges;
    this.adj = Array.from({ length: n }, () => []);
    this.edges.forEach((e, i) => {
      this.adj[e.a].push(i);
      this.adj[e.b].push(i);
    });
    this.comp = new Int32Array(n).fill(-1);
    const sizes: number[] = [];
    for (let s = 0; s < n; s++) {
      if (this.comp[s] >= 0) continue;
      const id = sizes.length;
      let count = 0;
      const stack = [s];
      this.comp[s] = id;
      while (stack.length) {
        const u = stack.pop()!;
        count++;
        for (const ei of this.adj[u]) {
          const e = this.edges[ei];
          const v = e.a === u ? e.b : e.a;
          if (this.comp[v] < 0) {
            this.comp[v] = id;
            stack.push(v);
          }
        }
      }
      sizes.push(count);
    }
    this.main = sizes.indexOf(Math.max(...sizes));
  }

  private key(x: number, z: number) {
    return (Math.floor(x / CELL) + 1000) * 100000 + (Math.floor(z / CELL) + 1000);
  }

  x(i: number) {
    return this.nodes[i * 2];
  }
  z(i: number) {
    return this.nodes[i * 2 + 1];
  }

  /** nearest node of the main network (optionally only nodes on streets passing `onEdge`) */
  nearestNode(x: number, z: number, maxDist = 2000, onEdge?: (e: GraphEdge) => boolean): number {
    let best = -1, bd = Infinity;
    for (let r = 0; r * CELL <= maxDist + CELL; r++) {
      const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const arr = this.grid.get((cx + dx + 1000) * 100000 + (cz + dz + 1000));
          if (!arr) continue;
          for (const i of arr) {
            if (this.comp[i] !== this.main) continue;
            if (onEdge && !this.adj[i].some((ei) => onEdge(this.edges[ei]))) continue;
            const d = Math.hypot(this.x(i) - x, this.z(i) - z);
            if (d < bd) {
              bd = d;
              best = i;
            }
          }
        }
      if (best >= 0 && bd < r * CELL) break;
    }
    return best;
  }

  /**
   * Shortest route between two nodes as a polyline (x,z,...). Races ignore one-way rules (the streets are
   * empty), but prefer big roads and avoid sharp detours through side streets.
   */
  route(from: number, to: number): { points: number[]; edges: number[] } | null {
    const n = this.adj.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const heap = new Heap();
    dist[from] = 0;
    heap.push(0, from);
    while (heap.size) {
      const [d, u] = heap.pop();
      if (u === to) break;
      if (d > dist[u]) continue;
      for (const ei of this.adj[u]) {
        const e = this.edges[ei];
        const v = e.a === u ? e.b : e.a;
        const nd = d + e.l * (CLASS_COST[e.c] ?? 1.5) + 25; // + per-intersection cost: fewer, longer straights
        if (nd < dist[v]) {
          dist[v] = nd;
          prev[v] = ei;
          heap.push(nd, v);
        }
      }
    }
    if (!isFinite(dist[to])) return null;
    const edgesRev: number[] = [];
    for (let u = to; u !== from; ) {
      const ei = prev[u];
      edgesRev.push(ei);
      const e = this.edges[ei];
      u = e.a === u ? e.b : e.a;
    }
    const edges = edgesRev.reverse();
    const points: number[] = [this.x(from), this.z(from)];
    let at = from;
    for (const ei of edges) {
      const e = this.edges[ei];
      const p = e.p;
      const forward = e.a === at;
      const m = p.length / 2;
      for (let k = 1; k < m; k++) {
        const j = forward ? k : m - 1 - k;
        points.push(p[j * 2], p[j * 2 + 1]);
      }
      at = forward ? e.b : e.a;
    }
    return { points, edges };
  }

  /** a random node of the main network, optionally within a ring around a point */
  randomNode(rand: () => number, near?: { x: number; z: number; min: number; max: number }, filter?: (e: GraphEdge) => boolean): number {
    for (let tries = 0; tries < 400; tries++) {
      const i = Math.floor(rand() * this.adj.length);
      if (this.comp[i] !== this.main) continue;
      if (filter && !this.adj[i].some((ei) => filter(this.edges[ei]))) continue;
      if (near) {
        const d = Math.hypot(this.x(i) - near.x, this.z(i) - near.z);
        if (d < near.min || d > near.max) continue;
      }
      return i;
    }
    return this.nearestNode(near?.x ?? 0, near?.z ?? 0);
  }
}

/** lat/lon -> world metres, the same projection as scripts/build_tiles.py */
export function makeProjector(m: Manifest) {
  const { lat: lat0, lon: lon0, rotationDeg } = m.origin;
  const r = (lat0 * Math.PI) / 180;
  const mx = 111320 * Math.cos(r);
  const my = 111132.954 - 559.822 * Math.cos(2 * r) + 1.175 * Math.cos(4 * r);
  const c = Math.cos((rotationDeg * Math.PI) / 180), s = Math.sin((rotationDeg * Math.PI) / 180);
  return (lat: number, lon: number) => {
    const x = (lon - lon0) * mx, y = (lat - lat0) * my;
    return { x: x * c - y * s, z: -(x * s + y * c) };
  };
}
