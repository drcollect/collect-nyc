import type { RoadLine } from './format';

const CELL = 60;

export interface RoadHit {
  line: RoadLine;
  seg: number; // index of the segment's first point
  x: number; // closest point
  z: number;
  dist: number;
  dirX: number; // unit direction of the segment
  dirZ: number;
}

/** Street centre lines on a grid, for "which street am I on", spawn points and the minimap. */
export class RoadIndex {
  readonly lines: RoadLine[];
  private grid = new Map<number, number[]>(); // cell -> packed (line << 12 | seg)

  constructor(lines: RoadLine[]) {
    this.lines = lines;
    lines.forEach((l, li) => {
      for (let s = 0; s + 3 < l.p.length; s += 2) {
        const x0 = l.p[s], z0 = l.p[s + 1], x1 = l.p[s + 2], z1 = l.p[s + 3];
        const len = Math.hypot(x1 - x0, z1 - z0);
        const steps = Math.max(1, Math.ceil(len / (CELL / 2)));
        const seen = new Set<number>();
        for (let i = 0; i <= steps; i++) {
          const k = this.key(x0 + ((x1 - x0) * i) / steps, z0 + ((z1 - z0) * i) / steps);
          if (seen.has(k)) continue;
          seen.add(k);
          let arr = this.grid.get(k);
          if (!arr) this.grid.set(k, (arr = []));
          arr.push(li * 4096 + s / 2);
        }
      }
    });
  }

  private key(x: number, z: number) {
    return (Math.floor(x / CELL) + 1000) * 100000 + (Math.floor(z / CELL) + 1000);
  }

  nearest(x: number, z: number, filter?: (l: RoadLine) => boolean, maxDist = CELL * 2): RoadHit | null {
    let best: RoadHit | null = null;
    const r = Math.ceil(maxDist / CELL);
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        const arr = this.grid.get((cx + dx + 1000) * 100000 + (cz + dz + 1000));
        if (!arr) continue;
        for (const packed of arr) {
          const line = this.lines[Math.floor(packed / 4096)];
          if (filter && !filter(line)) continue;
          const s = (packed % 4096) * 2;
          const x0 = line.p[s], z0 = line.p[s + 1], x1 = line.p[s + 2], z1 = line.p[s + 3];
          const vx = x1 - x0, vz = z1 - z0;
          const L2 = vx * vx + vz * vz || 1e-9;
          const t = Math.max(0, Math.min(1, ((x - x0) * vx + (z - z0) * vz) / L2));
          const px = x0 + vx * t, pz = z0 + vz * t;
          const d = Math.hypot(x - px, z - pz);
          if (d <= maxDist && (!best || d < best.dist)) {
            const L = Math.sqrt(L2);
            best = { line, seg: s, x: px, z: pz, dist: d, dirX: vx / L, dirZ: vz / L };
          }
        }
      }
    return best;
  }

  /** A spot on a real street near (x, z), facing along it (the legal way on one-way streets). */
  spawnNear(x: number, z: number): { x: number; z: number; yaw: number; name: string } | null {
    const hit =
      this.nearest(x, z, (l) => ['primary', 'secondary', 'tertiary', 'trunk'].includes(l.c) && !l.b, 400) ?? this.nearest(x, z, undefined, 800);
    if (!hit) return null;
    // car nose is +Z in car space; yaw rotates +Z onto the street direction
    const yaw = Math.atan2(hit.dirX, hit.dirZ);
    // keep right of the centre line on two-way streets
    const off = hit.line.o ? 0 : Math.min(hit.line.w / 4, 3);
    return { x: hit.x - hit.dirZ * off, z: hit.z + hit.dirX * off, yaw, name: hit.line.n };
  }
}
