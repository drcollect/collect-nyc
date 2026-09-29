import * as THREE from 'three';
import { RAPIER, G_ARENA, G_CAR, G_DEBRIS, G_WALL, GROUPS_DEBRIS, groups } from '../physics/world';
import type { Car } from '../car/car';
import type { Effects } from '../fx/particles';
import type { City, BreakKind, PropRef } from './city';
import { propAssets } from './props';

// Street props you can knock over. Lamps, signals and trees stand as cheap instances until a car touches one;
// then that instance is hidden and a real rigid body takes its place, gets the hit, and tumbles.

interface Kind {
  mass: number;
  /** trunk/pole half extents (the collider), and how high its centre sits */
  half: [number, number, number];
  cy: number;
  /** fraction of the car's speed lost on the hit */
  slow: number;
  /** car-body radius the hit is detected at, beyond the car's own size */
  reach: number;
}

const KINDS: Record<BreakKind, Kind> = {
  lamp: { mass: 140, half: [0.14, 4.3, 0.14], cy: 4.3, slow: 0.1, reach: 0.25 },
  signal: { mass: 220, half: [0.16, 3.1, 0.16], cy: 3.1, slow: 0.14, reach: 0.3 },
  tree: { mass: 420, half: [0.26, 1.8, 0.26], cy: 1.8, slow: 0.26, reach: 0.35 },
};

const MIN_SPEED = 3.5; // m/s: slower than this and props are just pushed on (they stay put)
const LIFETIME = 25;
const MAX_ACTIVE = 40;
/** ignore cars for a moment after breaking off, so the body doesn't explode out of the car overlapping it */
const GRACE = 1.0;

interface Falling {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  mesh: THREE.InstancedMesh;
  age: number;
  solid: boolean;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _c = new THREE.Color();
const _f = new THREE.Vector3();
const _l = new THREE.Vector3();
const _o = new THREE.Vector3();

export class Breakables {
  readonly group = new THREE.Group();
  private falling: Falling[] = [];
  private near: PropRef[] = [];
  /** called for each hit: position, strength 0..1, kind (the game plays sounds and shakes the camera) */
  onHit: ((p: THREE.Vector3, strength: number, kind: BreakKind, car: Car) => void) | null = null;
  count = 0;

  constructor(
    private world: RAPIER.World,
    private city: City,
    private fx: Effects,
  ) {
    this.group.name = 'Breakables';
  }

  /** once per rendered frame: look for cars touching props, then keep the fallen ones in sync */
  update(dt: number, cars: Car[]) {
    for (const car of cars) this.checkCar(car);
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i];
      f.age += dt;
      if (!f.solid && f.age > GRACE) {
        f.collider.setCollisionGroups(GROUPS_DEBRIS);
        f.solid = true;
      }
      const t = f.body.translation(), r = f.body.rotation();
      f.mesh.position.set(t.x, t.y, t.z);
      f.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      // sink out of sight at the end of its life
      if (f.age > LIFETIME - 2) f.mesh.position.y -= (f.age - (LIFETIME - 2)) * 1.2;
      if (f.age > LIFETIME || t.y < -20) this.remove(i);
    }
  }

  private checkCar(car: Car) {
    const v = car.velocity;
    const speed = Math.hypot(v.x, v.z);
    if (speed < MIN_SPEED) return;
    const p = car.curPos;
    const size = car.template.size;
    const reachMax = Math.max(size.x, size.z) / 2 + 0.6;
    const props = this.city.propsNear(p.x, p.z, reachMax + speed * 0.05, this.near);
    if (!props.length) return;
    // test in car space against the body's footprint (a box), grown by each prop's own reach
    _q.copy(car.curQuat).invert();
    for (const pr of props) {
      _v.set(pr.x - p.x, 0, pr.z - p.z).applyQuaternion(_q);
      const k = KINDS[pr.kind];
      const hx = size.x / 2 + k.reach, hz = size.z / 2 + k.reach;
      if (Math.abs(_v.x) > hx || Math.abs(_v.z) > hz) continue;
      this.knock(pr, car, speed, _v.x >= 0 ? 1 : -1);
    }
  }

  /** side: which side of the car's centre line the prop was on (+1 = car's left) */
  private knock(pr: PropRef, car: Car, speed: number, side: number) {
    pr.hide();
    this.count++;
    const k = KINDS[pr.kind];
    const a = propAssets();
    const isTree = pr.kind === 'tree';
    const scale = isTree ? pr.a : 1;
    const yaw = isTree ? Math.abs(Math.sin(pr.x * 12.9898 + pr.z * 78.233) * 43758.5453) % 1 * 6.28 : pr.a;

    // the visible piece: one instance of the same model, keeping a tree's own green
    const geo = pr.kind === 'lamp' ? a.lamp : pr.kind === 'signal' ? a.signal : a.tree;
    const mesh = new THREE.InstancedMesh(geo, isTree ? a.treeMat : a.mat, 1);
    mesh.castShadow = true;
    mesh.setMatrixAt(0, _m.compose(_p.set(0, 0, 0), _q.setFromAxisAngle(_up, yaw), _s.setScalar(scale)));
    if (isTree) {
      const h = Math.abs(Math.sin(pr.x * 12.9898 + pr.z * 78.233) * 43758.5453) % 1;
      mesh.setMatrixAt(0, _m.compose(_p.set(0, 0, 0), _q.setFromAxisAngle(_up, yaw), _s.set(scale, scale * (0.9 + h * 0.3), scale)));
      mesh.setColorAt(0, _c.setHSL(0.24 + h * 0.08, 0.38 + h * 0.2, 0.2 + h * 0.1));
    }
    mesh.frustumCulled = false;
    this.group.add(mesh);

    // the body: a pole standing on the pavement, origin at its base
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pr.x, 0.06, pr.z)
        .setLinearDamping(0.15)
        .setAngularDamping(0.4)
        .setCcdEnabled(true),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(k.half[0] * scale, k.half[1] * scale, k.half[2] * scale)
        .setTranslation(0, k.cy * scale, 0)
        .setMass(k.mass * scale)
        .setFriction(0.8)
        .setRestitution(0.1)
        // ground and walls only at first; cars once it's clear of the one that hit it
        .setCollisionGroups(groups(G_DEBRIS, G_ARENA | G_WALL | G_DEBRIS)),
      body,
    );
    // the hit: thrown forward and out to the side it was on, so it clears the car's line instead of being
    // bulldozed ahead of it; pushed low on the pole, so it topples
    const v = car.velocity;
    const fwd = car.forward(_f).setY(0).normalize();
    const left = _l.set(fwd.z, 0, -fwd.x); // car-space +X in world terms
    const out = _o.copy(fwd).multiplyScalar(0.55).addScaledVector(left, side * 0.85).multiplyScalar(speed);
    const m = k.mass * scale;
    body.applyImpulseAtPoint(
      { x: out.x * m, y: m * (1.4 + speed * 0.06), z: out.z * m },
      { x: pr.x, y: 0.06 + (isTree ? 1.2 : 0.9) * scale, z: pr.z },
      true,
    );
    body.applyTorqueImpulse({ x: (Math.random() - 0.5) * 80, y: (Math.random() - 0.5) * 60, z: (Math.random() - 0.5) * 80 }, true);
    this.falling.push({ body, collider, mesh, age: 0, solid: false });
    if (this.falling.length > MAX_ACTIVE) this.remove(0);

    // the car pays for it: a share of its speed
    const lv = car.body.linvel();
    const keep = 1 - k.slow * Math.min(1, (k.mass * scale) / 300);
    car.body.setLinvel({ x: lv.x * keep, y: lv.y, z: lv.z * keep }, true);

    // effects
    const at = _p.set(pr.x, 1.0, pr.z);
    const strength = Math.min(1, speed / 25) * (isTree ? 1 : 0.8);
    if (isTree) {
      this.fx.chunks(at.clone().setY(3.5 * scale), new THREE.Vector3(v.x * 0.2, 2.5, v.z * 0.2), 14, 0x3f6b2a);
      this.fx.chunks(at.clone(), new THREE.Vector3(v.x * 0.15, 1.5, v.z * 0.15), 6, 0x4a3b2c);
    } else {
      this.fx.sparks(at.clone(), new THREE.Vector3(v.x, 4, v.z).normalize(), 18 + Math.round(strength * 30), 6 + strength * 6);
    }
    this.onHit?.(at.clone(), strength, pr.kind, car);
  }

  private remove(i: number) {
    const f = this.falling[i];
    this.world.removeRigidBody(f.body);
    this.group.remove(f.mesh);
    f.mesh.dispose();
    this.falling.splice(i, 1);
  }

  clear() {
    while (this.falling.length) this.remove(this.falling.length - 1);
  }
}
