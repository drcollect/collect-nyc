import * as THREE from 'three';
import type { StreetGraph } from '../city/graph';
import type { Car } from '../car/car';
import { CAR_SPECS } from '../car/specs';
import { emptyInput } from '../core/input';
import { CityRacer } from '../ai/cityRacer';
import type { FreeDrive } from './drive';
import { RARITY, type Drop, type Drops } from './drops';
import { Route } from './route';

const CREW = [
  { name: 'Vega', skill: 0.6, color: '#ff4a3a' },
  { name: 'Okafor', skill: 0.48, color: '#ff8a1a' },
  { name: 'Brandt', skill: 0.54, color: '#ff3d8b' },
];

const PICKUP_R = 7;
const SPAWN_MIN = 350, SPAWN_MAX = 900;
const TOO_FAR = 3200; // a rival this far from the player is brought back closer
/** a new drop is yours alone for this long before the crew hears about it */
const HEAD_START = 10;

export interface Rival {
  name: string;
  color: string;
  skill: number;
  car: Car;
  ai: CityRacer | null;
  route: Route | null;
  target: Drop | null;
  tag: THREE.Sprite;
  wreckedFor: number;
  rethink: number;
  /** after a grab the rival just cruises for a while */
  restUntil: number;
}

function nameTag(name: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(10,12,16,0.78)';
  g.beginPath();
  g.roundRect(8, 10, 240, 44, 10);
  g.fill();
  g.fillStyle = color;
  g.fillRect(18, 22, 8, 20);
  g.fillStyle = '#fff';
  g.font = '700 26px Helvetica, Arial, sans-serif';
  g.textBaseline = 'middle';
  g.fillText(name.toUpperCase(), 36, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // constant size on screen and drawn over buildings, so you can see where the rivals are
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false, transparent: true }));
  s.scale.set(0.2, 0.05, 1);
  s.center.set(0.5, 0);
  s.renderOrder = 10;
  return s;
}

/**
 * A rival crew hunting the same drops as you, driving the real streets. Each rival picks a drop, routes to
 * it on the street graph and drives there; whoever gets there first takes it.
 */
export class Rivals {
  readonly group = new THREE.Group();
  readonly list: Rival[] = [];
  enabled = true;
  private spawnT = 1.5;

  constructor(
    private drive: FreeDrive,
    private graph: StreetGraph,
    private drops: Drops,
  ) {
    this.group.name = 'RivalTags';
    drops.onTaken = (d) => {
      for (const r of this.list) if (r.target === d) this.retarget(r, this.drive.car);
    };
  }

  /** the rival heading for a drop, and how far it still has to go (m) */
  chasing(d: Drop): { rival: Rival; left: number } | null {
    let best: { rival: Rival; left: number } | null = null;
    for (const r of this.list) {
      if (r.target !== d || !r.route || !r.ai) continue;
      const left = Math.max(0, r.route.length - r.ai.t);
      if (!best || left < best.left) best = { rival: r, left };
    }
    return best;
  }

  /** all rivals off the road (a race is starting) */
  clear() {
    for (const r of this.list) {
      this.group.remove(r.tag);
      r.tag.material.map?.dispose();
      r.tag.material.dispose();
    }
    this.list.length = 0; // the race clears the cars themselves
    this.spawnT = 4;
  }

  private spawnPoint(near: THREE.Vector3) {
    const n = this.graph.randomNode(Math.random, { x: near.x, z: near.z, min: SPAWN_MIN, max: SPAWN_MAX }, (e) => e.c !== 'motorway');
    const e = this.graph.edges[this.graph.adj[n][0]];
    const fwd = e.a === n;
    const p = e.p;
    const [x0, z0, x1, z1] = fwd ? [p[0], p[1], p[2], p[3]] : [p[p.length - 2], p[p.length - 1], p[p.length - 4], p[p.length - 3]];
    return { pos: new THREE.Vector3(x0, 0.8, z0), yaw: Math.atan2(x1 - x0, z1 - z0) };
  }

  private spawn(player: Car) {
    const who = CREW[this.list.length];
    const taken = new Set([player.spec.id, ...this.list.map((r) => r.car.spec.id)]);
    const spec = CAR_SPECS.find((s) => !taken.has(s.id)) ?? CAR_SPECS[0];
    const sp = this.spawnPoint(player.curPos);
    const car = this.drive.addCar({ id: spec.id, isPlayer: false, name: who.name, number: 10 + this.list.length }, sp.pos, sp.yaw);
    const tag = nameTag(who.name, who.color);
    this.group.add(tag);
    const r: Rival = { name: who.name, color: who.color, skill: who.skill, car, ai: null, route: null, target: null, tag, wreckedFor: 0, rethink: 0, restUntil: 0 };
    this.list.push(r);
    this.retarget(r, player);
  }

  /** drive somewhere nearby with no drop in mind */
  private cruise(r: Rival, player: Car) {
    const p = r.car.curPos;
    const to = this.graph.randomNode(Math.random, { x: player.curPos.x, z: player.curPos.z, min: 300, max: 1200 }, (e) => e.c !== 'motorway');
    const from = this.graph.nearestNode(p.x, p.z);
    const path = from >= 0 && to >= 0 && from !== to ? this.graph.route(from, to) : null;
    if (!path) return;
    r.route = new Route([p.x, p.z, ...path.points]);
    r.ai = new CityRacer(r.route, r.skill * 0.7, 0);
  }

  /** pick the drop that's worth most per metre for this rival, preferring ones nobody else is chasing */
  private retarget(r: Rival, player?: Car) {
    r.target = null;
    r.route = null;
    r.ai = null;
    r.rethink = 2 + Math.random() * 2;
    if (this.drive.time < r.restUntil) {
      if (player) this.cruise(r, player);
      return;
    }
    const p = r.car.curPos;
    let best: Drop | null = null, score = -1;
    for (const d of this.drops.list) {
      if (this.drive.time - d.born < HEAD_START) continue;
      const dist = Math.hypot(d.x - p.x, d.z - p.z);
      if (dist > 4000) continue;
      const others = this.list.some((o) => o !== r && o.target === d);
      const s = (RARITY[d.rarity].points / (dist + 250)) * (others ? 0.3 : 1);
      if (s > score) {
        score = s;
        best = d;
      }
    }
    if (!best) return;
    const from = this.graph.nearestNode(p.x, p.z), to = this.graph.nearestNode(best.x, best.z);
    if (from < 0 || to < 0) return;
    const path = from === to ? { points: [this.graph.x(from), this.graph.z(from)] } : this.graph.route(from, to);
    if (!path) return;
    // start from the car and end right on the drop
    const pts = [p.x, p.z, ...path.points, best.x, best.z];
    const route = new Route(pts);
    if (route.length < 2) return;
    r.target = best;
    r.route = route;
    r.ai = new CityRacer(route, r.skill, 0);
  }

  private respawn(r: Rival, player: Car) {
    const sp = this.spawnPoint(player.curPos);
    r.car = this.drive.replaceCar(r.car, sp.pos, sp.yaw);
    r.wreckedFor = 0;
    this.retarget(r, player);
  }

  /** once per physics step */
  step(dt: number) {
    if (!this.enabled) return;
    for (const r of this.list) {
      if (!r.ai || !r.route || r.car.wrecked) {
        this.drive.inputs.set(r.car, { ...emptyInput(), brake: 0.6 });
        continue;
      }
      let inp = r.ai.update(dt, r.car);
      // ease up for the last few metres so it doesn't fly past the drop into a wall
      const left = r.route.length - r.ai.t;
      if (left < 25) inp = { ...inp, throttle: Math.min(inp.throttle, 0.5) };
      if (r.ai.wantsRespawn) {
        r.ai.wantsRespawn = false;
        const at = r.route.at(Math.max(0, r.ai.t - 4));
        r.car.teleport(new THREE.Vector3(at.x, 0.8, at.z), Math.atan2(at.dx, at.dz));
      }
      this.drive.inputs.set(r.car, inp);
      const d = r.target;
      if (d && Math.hypot(d.x - r.car.curPos.x, d.z - r.car.curPos.z) < PICKUP_R) {
        r.restUntil = this.drive.time + 25 + Math.random() * 15;
        this.drops.claim(d, r.name); // retargets whoever was chasing it, this rival included (into a cruise)
      }
    }
  }

  /** once per frame: crew size, re-planning, name tags */
  frame(dt: number, player: Car) {
    this.group.visible = this.enabled;
    if (!this.enabled) return;
    this.spawnT -= dt;
    if (this.list.length < CREW.length && this.spawnT <= 0 && this.drops.list.length) {
      this.spawn(player);
      this.spawnT = 6;
    }
    for (const r of this.list) {
      r.wreckedFor = r.car.wrecked ? r.wreckedFor + dt : 0;
      const far = r.car.curPos.distanceTo(player.curPos) > TOO_FAR;
      if (r.wreckedFor > 3 || far) {
        this.respawn(r, player);
        continue;
      }
      r.rethink -= dt;
      const arrived = r.route && r.ai && r.ai.t >= r.route.length - 2;
      const resting = this.drive.time < r.restUntil;
      // hunting: re-plan when the drop is gone or reached; resting: pick a new cruise at the end of one, and
      // start hunting again as soon as the rest is over
      if ((!resting && (!r.target || !this.drops.list.includes(r.target))) || arrived || !r.route) {
        if (r.rethink <= 0) this.retarget(r, player);
      }
      r.tag.position.set(r.car.curPos.x, r.car.curPos.y + 2.4, r.car.curPos.z);
      r.tag.visible = r.car.curPos.distanceTo(player.curPos) < 1800;
    }
  }
}
