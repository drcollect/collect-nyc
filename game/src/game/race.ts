import * as THREE from 'three';
import type { StreetGraph } from '../city/graph';
import type { Car } from '../car/car';
import { CAR_SPECS } from '../car/specs';
import { emptyInput } from '../core/input';
import { CityRacer } from '../ai/cityRacer';
import type { FreeDrive } from './drive';
import { Gate } from './markers';
import { Route } from './route';

export interface RaceDef {
  id: string;
  name: string;
  blurb: string;
  /** lat, lon of the places the route passes, in order; an optional street name pins the point to that street */
  via: ([number, number] | [number, number, string])[];
  loop: boolean;
}

export const RACES: RaceDef[] = [
  {
    id: 'midtown',
    name: 'Midtown Loop',
    blurb: 'Times Square, Columbus Circle, Grand Army Plaza, Grand Central, the Empire State and back.',
    via: [
      [40.758, -73.9855], // Times Square
      [40.7681, -73.9819], // Columbus Circle
      [40.7644, -73.973], // Grand Army Plaza
      [40.752, -73.9775], // Park Ave at Grand Central
      [40.7484, -73.9857], // 5th Ave at the Empire State
    ],
    loop: true,
  },
  {
    id: 'downtown',
    name: 'Downtown Dash',
    blurb: 'From Herald Square past the Flatiron, Union Square and Washington Square to City Hall.',
    via: [
      [40.7502, -73.9877], // Herald Square
      [40.7411, -73.9897], // Flatiron
      [40.7359, -73.9906], // Union Square
      [40.7308, -73.9973], // Washington Square
      [40.7127, -74.004], // City Hall
    ],
    loop: false,
  },
  {
    id: 'westside',
    name: 'West Side Highway',
    blurb: 'Flat out up the Hudson: Battery Park, the World Trade Center, Chelsea Piers, the Intrepid.',
    via: [
      [40.7045, -74.0155], // Battery Park
      [40.7127, -74.0134], // West St at the WTC
      [40.7465, -74.0085], // Chelsea Piers
      [40.7645, -73.9975], // Intrepid
    ],
    loop: false,
  },
  {
    id: 'centralpark',
    name: 'Central Park Loop',
    blurb: 'The six-mile park drive, closed to cars in real life: past the Mall, the Reservoir and Harlem Hill.',
    via: [
      [40.7668, -73.9755, 'Center Drive'], // south end, near Grand Army Plaza
      [40.7722, -73.9676, 'East Drive'], // 72nd St
      [40.784, -73.959, 'East Drive'], // Engineers' Gate, 90th
      [40.7925, -73.953, 'East Drive'], // 102nd
      [40.7985, -73.9555, 'West Drive'], // Harlem Hill
      [40.7945, -73.962, 'West Drive'], // 100th
      [40.781, -73.972, 'West Drive'], // 81st
      [40.7725, -73.978, 'West Drive'], // Tavern on the Green
    ],
    loop: true,
  },
  {
    id: 'fdr',
    name: 'FDR Drive',
    blurb: 'The East River expressway from the Seaport up past the UN to East Harlem. Top speed all the way.',
    via: [
      [40.7068, -74.0003, 'FDR Drive'], // South Street Seaport
      [40.719, -73.975, 'FDR Drive'], // Houston St
      [40.744, -73.971, 'FDR Drive'], // 34th St
      [40.7575, -73.9615, 'FDR Drive'], // Queensboro Bridge
      [40.7835, -73.9425, 'FDR Drive'], // 96th St
    ],
    loop: false,
  },
  {
    id: 'uptown',
    name: 'Uptown Run',
    blurb: 'From the Apollo on 125th Street up St. Nicholas and Broadway through Washington Heights to Inwood.',
    via: [
      [40.8101, -73.9501], // 125th St at the Apollo
      [40.8255, -73.9435, 'Saint Nicholas Avenue'],
      [40.8497, -73.938, 'Broadway'], // 181st St
      [40.8656, -73.927, 'Dyckman Street'], // Inwood
    ],
    loop: false,
  },
  {
    id: 'fidi',
    name: 'Financial District GP',
    blurb: 'A short, tight street circuit: Broadway, Battery Park, Water Street, the Seaport and City Hall.',
    via: [
      [40.7074, -74.0113, 'Broadway'], // Wall St
      [40.7042, -74.0143], // Bowling Green
      [40.7025, -74.0125], // Battery Park / State St
      [40.7045, -74.009, 'Water Street'],
      [40.7075, -74.0035], // Seaport
      [40.7098, -74.0075, 'Fulton Street'],
      [40.7125, -74.0072, 'Broadway'], // City Hall Park
    ],
    loop: true,
  },
];

const RIVALS = [
  { name: 'Vega', skill: 0.95 },
  { name: 'Okafor', skill: 0.82 },
  { name: 'Brandt', skill: 0.72 },
  { name: 'Moreau', skill: 0.6 },
];

export interface Racer {
  car: Car;
  name: string;
  ai: CityRacer | null;
  t: number; // progress along the route (m)
  next: number; // index of the next checkpoint
  finish: number | null; // race time at the finish line
  wreckedFor: number;
}

export type RacePhase = 'countdown' | 'run' | 'done';

const BEST_KEY = 'cnyc.best.v1';

export function bestTimes(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(BEST_KEY) ?? '{}');
  } catch {
    return {};
  }
}

/** Build the route of a race on the street graph. */
export function buildRoute(graph: StreetGraph, def: RaceDef, project: (lat: number, lon: number) => { x: number; z: number }): Route | null {
  const nodes = def.via.map(([la, lo, street]) => {
    const p = project(la, lo);
    return graph.nearestNode(p.x, p.z, 2000, street ? (e) => e.n === street : undefined);
  });
  if (def.loop) nodes.push(nodes[0]);
  const pts: number[] = [];
  for (let i = 0; i + 1 < nodes.length; i++) {
    const r = graph.route(nodes[i], nodes[i + 1]);
    if (!r) return null;
    pts.push(...(pts.length ? r.points.slice(2) : r.points));
  }
  return new Route(pts);
}

/** One race: grid, countdown, checkpoints, AI rivals in the other four cars, positions, results. */
export class Race {
  readonly group = new THREE.Group();
  readonly racers: Racer[] = [];
  readonly checkpoints: { t: number; x: number; z: number; gate: Gate }[] = [];
  phase: RacePhase = 'countdown';
  clock = -3; // counts up from -3; the start is at 0
  readonly best: number | null;
  newBest = false;
  onCheckpoint: (() => void) | null = null;

  constructor(
    readonly def: RaceDef,
    readonly route: Route,
    private drive: FreeDrive,
  ) {
    this.best = bestTimes()[def.id] ?? null;
    // checkpoints: after every corner and at least every ~220 m, the last one is the finish
    const marks = new Set<number>();
    for (const c of route.corners(0.6)) marks.add(Math.min(route.length - 10, c + 30));
    const ts = [...marks].sort((a, b) => a - b);
    const all: number[] = [];
    let last = 0;
    for (const t of [...ts, route.length]) {
      while (t - last > 260) {
        last += 220;
        all.push(last);
      }
      if (t - last > 60 || t === route.length) {
        all.push(t);
        last = t;
      }
    }
    all.forEach((t, i) => {
      const p = route.at(t);
      const finish = i === all.length - 1;
      const g = new Gate(p.x, p.z, p.dx, p.dz, 14, finish);
      this.group.add(g.group);
      this.checkpoints.push({ t, x: p.x, z: p.z, gate: g });
    });

    // grid: two by two behind the start line, the player at the back
    const player = drive.car;
    const others = CAR_SPECS.filter((s) => s.id !== player.spec.id);
    const slot = (i: number) => {
      const row = Math.floor(i / 2), side = i % 2 ? -1 : 1;
      const s = route.at(0);
      const back = 6 + row * 9;
      return {
        pos: new THREE.Vector3(s.x - s.dx * back - s.dz * side * 2.6, 0.8, s.z - s.dz * back + s.dx * side * 2.6),
        yaw: Math.atan2(s.dx, s.dz),
      };
    };
    others.forEach((spec, i) => {
      const sl = slot(i);
      const who = RIVALS[i % RIVALS.length];
      const car = drive.addCar({ id: spec.id, isPlayer: false, name: who.name, number: i + 2 }, sl.pos, sl.yaw);
      this.racers.push({ car, name: who.name, ai: new CityRacer(route, who.skill, (i % 2 ? -1 : 1) * 2.2), t: 0, next: 0, finish: null, wreckedFor: 0 });
    });
    const ps = slot(others.length);
    player.teleport(ps.pos, ps.yaw);
    this.racers.unshift({ car: player, name: 'You', ai: null, t: 0, next: 0, finish: null, wreckedFor: 0 });
    this.refreshGates();
  }

  get player() {
    return this.racers[0];
  }

  /** positions: finished first (by time), then by progress */
  standings(): Racer[] {
    return this.racers.slice().sort((a, b) => {
      if (a.finish != null || b.finish != null) return (a.finish ?? Infinity) - (b.finish ?? Infinity);
      return b.t - a.t;
    });
  }

  private refreshGates() {
    const n = this.player.next;
    this.checkpoints.forEach((c, i) => c.gate.setState(i < n ? 'passed' : i === n ? 'next' : i < n + 3 ? 'later' : 'passed'));
  }

  /** once per physics step, before the world steps */
  step(dt: number) {
    if (this.phase === 'countdown') {
      this.clock += dt;
      for (const r of this.racers) if (r.ai) this.drive.inputs.set(r.car, { ...emptyInput(), brake: 1 });
      if (this.clock >= 0) this.phase = 'run';
      return;
    }
    this.clock += dt;
    for (const r of this.racers) {
      const p = r.car.curPos;
      if (r.ai) {
        if (r.finish != null) {
          this.drive.inputs.set(r.car, { ...emptyInput(), brake: 0.6 });
          continue;
        }
        // a wrecked rival is back in the race after a moment, in a fresh car
        r.wreckedFor = r.car.wrecked ? r.wreckedFor + dt : 0;
        if (r.wreckedFor > 2.5) {
          const at = this.route.at(Math.max(0, r.t - 4));
          r.car = this.drive.replaceCar(r.car, new THREE.Vector3(at.x, 0.8, at.z), Math.atan2(at.dx, at.dz));
          r.wreckedFor = 0;
        }
        const inp = r.ai.update(dt, r.car);
        if (r.ai.wantsRespawn) {
          r.ai.wantsRespawn = false;
          this.putBack(r);
        }
        this.drive.inputs.set(r.car, inp);
        r.t = r.ai.t;
      } else {
        const pr = this.route.project(p.x, p.z, r.t - 40, r.t + 90);
        if (pr.dist < 40 && pr.t > r.t) r.t = pr.t;
      }
      // checkpoints: reached along the route, and actually near it
      while (r.finish == null && r.next < this.checkpoints.length && r.t >= this.checkpoints[r.next].t - 6) {
        r.next++;
        if (r === this.player) {
          this.refreshGates();
          this.onCheckpoint?.();
        }
        if (r.next === this.checkpoints.length) r.finish = this.clock;
      }
    }
    if (this.phase === 'run' && this.player.finish != null) {
      this.phase = 'done';
      const b = bestTimes();
      if (!b[this.def.id] || this.player.finish < b[this.def.id]) {
        b[this.def.id] = this.player.finish;
        this.newBest = true;
        try {
          localStorage.setItem(BEST_KEY, JSON.stringify(b));
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** the player's reset: a fresh car of the same model back on the route */
  respawnPlayer() {
    const r = this.player;
    const at = this.route.at(Math.max(0, r.t - 4));
    this.drive.respawnPlayer(new THREE.Vector3(at.x, 0.8, at.z), Math.atan2(at.dx, at.dz));
    r.car = this.drive.car;
  }

  /** back on the route where this racer got to, facing the right way */
  putBack(r: Racer) {
    const at = this.route.at(Math.max(0, r.t - 4));
    r.car.teleport(new THREE.Vector3(at.x, 0.8, at.z), Math.atan2(at.dx, at.dz));
  }

  update(dt: number) {
    for (const c of this.checkpoints) c.gate.update(dt);
  }

  nextCheckpoint() {
    return this.checkpoints[Math.min(this.player.next, this.checkpoints.length - 1)];
  }

  dispose() {
    for (const c of this.checkpoints) c.gate.dispose();
    this.drive.clearOthers();
  }
}
