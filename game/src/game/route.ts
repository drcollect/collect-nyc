/** A polyline on the ground with arc length, for race routes and the AI that follows them. */
export class Route {
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly s: Float64Array; // cumulative length at each point
  readonly length: number;

  constructor(points: number[]) {
    // drop near-duplicate points so directions stay stable
    const xs: number[] = [], zs: number[] = [];
    for (let i = 0; i < points.length; i += 2) {
      const x = points[i], z = points[i + 1];
      const n = xs.length;
      if (n && Math.hypot(x - xs[n - 1], z - zs[n - 1]) < 0.5) continue;
      xs.push(x);
      zs.push(z);
    }
    this.x = Float64Array.from(xs);
    this.z = Float64Array.from(zs);
    this.s = new Float64Array(xs.length);
    for (let i = 1; i < xs.length; i++) this.s[i] = this.s[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
    this.length = this.s[xs.length - 1];
  }

  /** index i such that s[i] <= t < s[i+1] */
  private seg(t: number) {
    let lo = 0, hi = this.s.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.s[m] <= t) lo = m;
      else hi = m;
    }
    return lo;
  }

  /** point and unit direction at arc length t */
  at(t: number, out = { x: 0, z: 0, dx: 0, dz: 1 }) {
    t = Math.max(0, Math.min(this.length, t));
    const i = Math.min(this.seg(t), this.s.length - 2);
    const L = this.s[i + 1] - this.s[i] || 1e-9;
    const f = (t - this.s[i]) / L;
    out.dx = (this.x[i + 1] - this.x[i]) / L;
    out.dz = (this.z[i + 1] - this.z[i]) / L;
    out.x = this.x[i] + (this.x[i + 1] - this.x[i]) * f;
    out.z = this.z[i] + (this.z[i + 1] - this.z[i]) * f;
    return out;
  }

  /** arc length of the closest point to (x, z), searching the window [from, to] */
  project(x: number, z: number, from = 0, to = this.length): { t: number; dist: number } {
    let best = { t: from, dist: Infinity };
    const i0 = this.seg(Math.max(0, from)), i1 = Math.min(this.s.length - 2, this.seg(Math.min(this.length, to)) + 1);
    for (let i = i0; i <= i1; i++) {
      const ax = this.x[i], az = this.z[i];
      const vx = this.x[i + 1] - ax, vz = this.z[i + 1] - az;
      const L2 = vx * vx + vz * vz || 1e-9;
      const f = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / L2));
      const d = Math.hypot(x - (ax + vx * f), z - (az + vz * f));
      if (d < best.dist) best = { t: this.s[i] + f * Math.sqrt(L2), dist: d };
    }
    return best;
  }

  /** the sharpest turn (radians of heading change) between t and t + ahead, and where it starts */
  turnAhead(t: number, ahead: number, step = 6): { angle: number; at: number } {
    const a = this.at(t), b = { x: 0, z: 0, dx: 0, dz: 1 };
    let worst = { angle: 0, at: t };
    const h0 = Math.atan2(a.dx, a.dz);
    for (let d = step; d <= ahead; d += step) {
      this.at(t + d, b);
      let dh = Math.atan2(b.dx, b.dz) - h0;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      if (Math.abs(dh) > Math.abs(worst.angle)) worst = { angle: dh, at: t + d };
    }
    return worst;
  }

  /** turn points: arc lengths where the heading changes by more than `minAngle` within ~30 m */
  corners(minAngle = 0.5): number[] {
    const out: number[] = [];
    let last = -Infinity;
    for (let t = 15; t < this.length - 15; t += 5) {
      const a = this.at(t - 15), b = this.at(t + 15);
      let dh = Math.atan2(b.dx, b.dz) - Math.atan2(a.dx, a.dz);
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      if (Math.abs(dh) > minAngle && t - last > 40) {
        out.push(t);
        last = t;
      }
    }
    return out;
  }
}
