import * as THREE from 'three';
import { RAPIER, createWorld, PHYS_DT } from '../physics/world';
import { Car, type CarHost, type SoundHooks } from '../car/car';
import type { CarTemplate } from '../car/carAsset';
import { defaultLivery, specById, type LiveryChoice } from '../car/specs';
import { Effects } from '../fx/particles';
import { Skidmarks } from '../fx/skidmarks';
import { DebrisManager } from '../fx/debris';
import { emptyInput, type DriverInput } from '../core/input';
import { clamp } from '../core/math';
import type { City } from '../city/city';

interface Pending {
  a: number; // collider handles, a < b
  b: number;
  impulse: number;
  vrel: number;
  point: THREE.Vector3;
  normal: THREE.Vector3; // summed, from a towards b
  weight: number;
  steps: number;
  idle: number;
  seen: boolean;
  /** force direction a -> b, for manifolds without solver contacts (common against trimesh walls) */
  fallback: THREE.Vector3;
  fallbackVrel: number;
}

export interface CarSetup {
  id: string;
  isPlayer: boolean;
  name: string;
  number: number;
  livery?: LiveryChoice;
}

const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
const _rel = new THREE.Vector3();

/** The world the cars drive in: physics, the streamed city, effects, crash damage. Modes (free roam, races) sit on top. */
export class FreeDrive {
  readonly scene = new THREE.Scene();
  readonly world: RAPIER.World;
  readonly fx = new Effects();
  readonly skids = new Skidmarks(6000);
  readonly debris: DebrisManager;
  /** cars[0] is always the player */
  readonly cars: Car[] = [];
  time = 0;
  sound: SoundHooks | null = null;
  /** strength of hard hits on the player since the camera last read it (for shake) */
  playerHits = 0;
  /** extra cars' inputs, set by the race each step */
  inputs = new Map<Car, DriverInput>();
  private host: CarHost;
  private queue = new RAPIER.EventQueue(true);
  private colliderCar = new Map<number, Car>();
  private pending = new Map<string, Pending>();
  /** dev readout */
  hitLog = { events: 0, resolved: 0, lastDv: 0, lastKind: '' };

  constructor(
    readonly city: City,
    world: RAPIER.World,
    private templates: Map<string, CarTemplate>,
  ) {
    this.world = world;
    this.debris = new DebrisManager(world);
    this.fx.dustTint.setRGB(0.55, 0.54, 0.52); // concrete dust, not dirt
    this.scene.add(city.group, this.fx.particles.group, this.skids.mesh, this.debris.group);
    this.host = {
      world,
      fx: this.fx,
      skids: this.skids,
      debris: this.debris,
      sound: {
        impact: (p, s, k) => this.sound?.impact(p, s, k),
        glass: (p, s) => this.sound?.glass(p, s),
        partOff: (p) => this.sound?.partOff(p),
        wreck: (p) => this.sound?.wreck(p),
      },
      groundHeight: (x, z) => city.heightAt(x, z),
      now: () => this.time,
    };
  }

  static createWorld() {
    return createWorld();
  }

  get car(): Car {
    return this.cars[0];
  }

  private makeCar(index: number, setup: CarSetup, pos: THREE.Vector3, yaw: number): Car {
    const tmpl = this.templates.get(setup.id)!;
    const liv = setup.livery ?? defaultLivery(specById(setup.id));
    const car = new Car(
      this.host,
      {
        index,
        template: tmpl,
        color: liv.color,
        accent: liv.accent,
        stripe: liv.stripe,
        stripeColor: liv.stripeColor,
        number: setup.number,
        helmet: '#e8e8e8',
        isPlayer: setup.isPlayer,
        driverName: setup.name,
        wear: 0,
        toughnessMul: 1,
      },
      { position: pos, yaw },
    );
    this.scene.add(car.root);
    for (const c of car.colliders) this.colliderCar.set(c.handle, car);
    return car;
  }

  private removeCar(car: Car) {
    this.scene.remove(car.root);
    for (const c of car.colliders) this.colliderCar.delete(c.handle);
    this.inputs.delete(car);
    car.dispose();
  }

  /** Put (or swap) the player's car at a spot. */
  /** the player's current car: model, look and number (resets and repairs keep them) */
  playerSetup: { id: string; livery?: LiveryChoice; number: number } = { id: 'hypercar', number: 1 };

  /** a fresh copy of the player's current car */
  respawnPlayer(pos: THREE.Vector3, yaw: number) {
    const p = this.playerSetup;
    this.spawn(p.id, pos, yaw, p.livery, p.number);
  }

  spawn(carId: string, pos: THREE.Vector3, yaw: number, livery?: LiveryChoice, number = 1) {
    this.playerSetup = { id: carId, livery, number };
    const old = this.cars[0];
    const car = this.makeCar(0, { id: carId, isPlayer: true, name: 'You', number, livery }, pos, yaw);
    if (old) this.removeCar(old);
    this.cars[0] = car;
  }

  /** Add a computer-driven car; returns it. */
  addCar(setup: CarSetup, pos: THREE.Vector3, yaw: number): Car {
    const car = this.makeCar(this.cars.length, setup, pos, yaw);
    this.cars.push(car);
    this.inputs.set(car, emptyInput());
    return car;
  }

  /** Swap a computer car for a fresh one of the same model (after a wreck); returns the new car. */
  replaceCar(old: Car, pos: THREE.Vector3, yaw: number): Car {
    const i = this.cars.indexOf(old);
    const car = this.makeCar(i, { id: old.spec.id, isPlayer: false, name: old.name, number: old.number }, pos, yaw);
    this.removeCar(old);
    this.cars[i] = car;
    this.inputs.set(car, emptyInput());
    return car;
  }

  /** Take one computer car off the road. */
  remove(car: Car) {
    const i = this.cars.indexOf(car);
    if (i <= 0) return;
    this.cars.splice(i, 1);
    this.removeCar(car);
  }

  /** Remove every car except the player's. */
  clearOthers() {
    for (const c of this.cars.splice(1)) this.removeCar(c);
  }

  fixedStep(input: DriverInput) {
    const dt = PHYS_DT;
    this.time += dt;
    for (const car of this.cars) {
      car.input = car === this.car ? input : (this.inputs.get(car) ?? emptyInput());
      car.fixedUpdate(dt);
    }
    this.world.step(this.queue);
    for (const car of this.cars) car.postStep();
    this.debris.postStep();
    this.collectImpacts(dt);
  }

  frame(dt: number, alpha: number) {
    for (const car of this.cars) car.render(alpha, dt);
    this.debris.update(dt, alpha);
    this.fx.particles.update(dt, (x, z) => this.city.heightAt(x, z));
    this.skids.flush();
    this.city.update(
      this.car.curPos,
      this.car.velocity,
      this.cars.slice(1).map((c) => c.curPos),
    );
  }

  /** a fresh, undamaged car on the nearest street */
  repair() {
    const p = this.car.curPos;
    const s = this.city.roads.spawnNear(p.x, p.z);
    if (s) this.respawnPlayer(new THREE.Vector3(s.x, 0.8, s.z), s.yaw);
  }

  private collectImpacts(dt: number) {
    const world = this.world;
    this.queue.drainContactForceEvents((e) => {
      const h1 = e.collider1(), h2 = e.collider2();
      const a = Math.min(h1, h2), b = Math.max(h1, h2);
      const ca = this.colliderCar.get(a), cb = this.colliderCar.get(b);
      if (!ca && !cb) return;
      if (ca && ca === cb) return;
      const key = `${a}:${b}`;
      let p = this.pending.get(key);
      if (!p) {
        p = { a, b, impulse: 0, vrel: -1, point: new THREE.Vector3(), normal: new THREE.Vector3(), weight: 0, steps: 0, idle: 0, seen: false, fallback: new THREE.Vector3(), fallbackVrel: -1 };
        this.pending.set(key, p);
      }
      const imp = e.totalForceMagnitude() * dt;
      this.hitLog.events++;
      p.impulse += imp;
      p.seen = true;
      // relative velocity of a against b, from before this step
      _rel.set(0, 0, 0);
      if (ca) _rel.add(ca.preVel);
      if (cb) _rel.sub(cb.preVel);
      const fd = e.maxForceDirection();
      _f.set(fd.x, fd.y, fd.z);
      // orient a -> b: between two cars by their positions; against the world by the closing velocity
      // (a car moving into a wall pushes along its velocity, so a -> b follows the relative velocity)
      if (ca && cb) {
        if (_f.dot(_v.copy(cb.curPos).sub(ca.curPos)) < 0) _f.negate();
      } else if (_f.dot(_rel) < 0) _f.negate();
      p.fallback.addScaledVector(_f, imp);
      if (p.fallbackVrel < 0 && _f.lengthSq() > 0) p.fallbackVrel = Math.max(0, _rel.dot(_f.normalize()));
      const c1 = world.getCollider(a), c2 = world.getCollider(b);
      if (!c1 || !c2) return;
      world.contactPair(c1, c2, (m, flipped) => {
        const nc = m.numSolverContacts();
        const nn = m.normal();
        const s = flipped ? -1 : 1; // a -> b
        p!.normal.x += nn.x * s * imp;
        p!.normal.y += nn.y * s * imp;
        p!.normal.z += nn.z * s * imp;
        for (let i = 0; i < nc; i++) {
          const sp = m.solverContactPoint(i);
          if (!sp) continue;
          p!.point.x += (sp.x * imp) / nc;
          p!.point.y += (sp.y * imp) / nc;
          p!.point.z += (sp.z * imp) / nc;
        }
        if (nc > 0) p!.weight += imp;
        if (p!.vrel < 0 && nc > 0) {
          const sp = m.solverContactPoint(0)!;
          const pt = new THREE.Vector3(sp.x, sp.y, sp.z);
          const n = new THREE.Vector3(nn.x * s, nn.y * s, nn.z * s);
          const va = ca ? ca.preVelocityAt(pt, new THREE.Vector3()) : new THREE.Vector3();
          const vb = cb ? cb.preVelocityAt(pt, new THREE.Vector3()) : new THREE.Vector3();
          p!.vrel = Math.max(0, va.sub(vb).dot(n));
        }
      });
    });
    this.queue.drainCollisionEvents(() => {});
    for (const [key, p] of this.pending) {
      if (!p.seen) p.idle++;
      p.seen = false;
      p.steps++;
      if (p.idle >= 2 || p.steps >= 8) {
        this.pending.delete(key);
        this.resolve(p);
      }
    }
  }

  private kindOf(handle: number): 'car' | 'wall' | 'ground' | 'debris' {
    if (this.colliderCar.has(handle)) return 'car';
    if (this.city.wallHandles.has(handle)) return 'wall';
    return this.world.getCollider(handle)?.parent()?.isFixed() ? 'ground' : 'debris';
  }

  private resolve(p: Pending) {
    const ca = this.colliderCar.get(p.a) ?? null, cb = this.colliderCar.get(p.b) ?? null;
    const ref = (ca ?? cb)!;
    let normal: THREE.Vector3, point: THREE.Vector3;
    if (p.weight > 0 && p.normal.lengthSq() > 1e-8) {
      normal = p.normal.clone().normalize();
      point = p.point.clone().divideScalar(p.weight);
    } else if (p.fallback.lengthSq() > 1e-8) {
      // no contact points: the hit is on the car's body surface along the force direction
      normal = p.fallback.clone().normalize();
      const dir = ca ? normal.clone() : normal.clone().negate(); // out of the reference car
      const h = ref.bodyHalf;
      const local = dir.applyQuaternion(ref.curQuat.clone().invert());
      const s = 1 / Math.max(Math.abs(local.x) / h.x, Math.abs(local.y) / h.y, Math.abs(local.z) / h.z, 1e-6);
      point = local.multiplyScalar(s).add(ref.bodyCenter).applyQuaternion(ref.curQuat).add(ref.curPos);
    } else return;
    const vrel = Math.max(0, p.vrel >= 0 ? p.vrel : p.fallbackVrel);
    const kindA = this.kindOf(p.b); // what a hit
    const kindB = this.kindOf(p.a);
    // buildings are everywhere in the city, so wall hits count for less than in the derby bowl
    const scale = (k: string) => (k === 'debris' ? 0.25 : k === 'ground' ? 0.55 : k === 'wall' ? 0.6 : 1);
    const mA = ca?.mass ?? 1e9, mB = cb?.mass ?? 1e9;
    // grinding along a building gives a stream of tiny hits; below this closing speed they only cost speed, not damage
    const MIN_WALL_DV = 1.2;
    const minFor = (k: string) => (k === 'wall' ? MIN_WALL_DV : 0);
    let maxDv = 0;
    if (ca && Math.min(p.impulse / mA, vrel * (mB / (mA + mB)) * 1.2 + 0.3) * scale(kindA) < minFor(kindA)) {
      Object.assign(this.hitLog, { resolved: this.hitLog.resolved + 1, lastDv: 0, lastKind: 'scrape' });
      return;
    }
    if (cb && Math.min(p.impulse / mB, vrel * (mA / (mA + mB)) * 1.2 + 0.3) * scale(kindB) < minFor(kindB)) {
      Object.assign(this.hitLog, { resolved: this.hitLog.resolved + 1, lastDv: 0, lastKind: 'scrape' });
      return;
    }
    if (ca) {
      const dv = Math.min(p.impulse / mA, vrel * (mB / (mA + mB)) * 1.2 + 0.3) * scale(kindA);
      maxDv = Math.max(maxDv, dv);
      ca.applyImpact({ pointWorld: point, dirWorld: normal.clone().negate(), impulse: p.impulse * scale(kindA), dv, otherCar: cb, kind: kindA });
      if (ca === this.car && dv > 1.5) this.playerHits += clamp(dv / 12, 0, 1);
    }
    if (cb) {
      const dv = Math.min(p.impulse / mB, vrel * (mA / (mA + mB)) * 1.2 + 0.3) * scale(kindB);
      maxDv = Math.max(maxDv, dv);
      cb.applyImpact({ pointWorld: point, dirWorld: normal.clone(), impulse: p.impulse * scale(kindB), dv, otherCar: ca, kind: kindB });
      if (cb === this.car && dv > 1.5) this.playerHits += clamp(dv / 12, 0, 1);
    }
    const kind = ca && cb ? 'car' : ca ? kindA : kindB;
    Object.assign(this.hitLog, { resolved: this.hitLog.resolved + 1, lastDv: +maxDv.toFixed(2), lastKind: kind });
    if (maxDv < 0.8 || kind === 'ground') return;
    const strength = clamp(maxDv / 12, 0, 1);
    this.fx.sparks(point, normal.clone().multiplyScalar(Math.random() < 0.5 ? 1 : -1).add(_v.set(0, 0.6, 0)), Math.round(6 + strength * 60), 5 + strength * 8);
    if (strength > 0.25) this.fx.chunks(point, _v.set(0, 1, 0), Math.round(strength * 10), 0x555555);
    this.sound?.impact(point, strength, kind);
  }

  dispose() {
    this.queue.free();
  }
}
