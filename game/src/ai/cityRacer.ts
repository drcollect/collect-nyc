import * as THREE from 'three';
import type { Car } from '../car/car';
import type { DriverInput } from '../core/input';
import { clamp } from '../core/math';
import type { Route } from '../game/route';

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

/**
 * Follows a race route: pure-pursuit steering on a look-ahead point, a speed limit from the sharpest turn
 * coming up, and recovery when stuck against a wall. `skill` (0..1) scales pace and braking.
 */
export class CityRacer {
  /** progress along the route (m), only moves forward except by small amounts */
  t = 0;
  private stuck = 0;
  private reverseT = 0;
  /** set when the car should be put back on the route */
  wantsRespawn = false;

  constructor(
    private route: Route,
    readonly skill: number,
    private lane: number, // lateral offset (m) so cars don't all queue on the centre line
  ) {}

  update(dt: number, car: Car): DriverInput {
    const r = this.route;
    const p = car.curPos;
    const pr = r.project(p.x, p.z, this.t - 30, this.t + 120);
    if (pr.t > this.t) this.t = pr.t;
    const speed = Math.hypot(car.velocity.x, car.velocity.z);

    // way off the route (took a wrong turn, got knocked away): ask to be put back
    if (pr.dist > 45) this.wantsRespawn = true;

    // look-ahead point, shifted into this car's lane
    // shorter look-ahead into corners, so the car turns at the corner instead of cutting across the building on the inside
    const near = Math.abs(r.turnAhead(this.t, 40).angle);
    const look = (8 + speed * 0.5) * (1 - 0.45 * clamp(near / 1.2, 0, 1));
    const tgt = r.at(this.t + look);
    const lane = this.lane * clamp(1 - near / 1.2, 0, 1);
    _v.set(tgt.x - tgt.dz * lane - p.x, 0, tgt.z + tgt.dx * lane - p.z);
    _q.copy(car.curQuat).invert();
    _v.applyQuaternion(_q); // car space: nose +Z, left +X
    const ang = Math.atan2(_v.x, _v.z);
    const steerMax = car.spec.steerMax / (1 + speed / car.spec.steerFade);
    let steer = clamp(ang / Math.max(0.12, steerMax), -1, 1);

    // speed limit from the sharpest turn ahead: v = sqrt(a * R), with R estimated from the heading change
    const brakeDist = 20 + (speed * speed) / (2 * 7.5);
    const turn = r.turnAhead(this.t, Math.min(260, brakeDist + 30));
    const a = Math.abs(turn.angle);
    const latAcc = 9.81 * car.spec.grip * (0.62 + 0.25 * this.skill);
    const radius = a > 0.05 ? 26 / a : 1e4; // a 90-degree Manhattan corner ~ 17 m radius
    let vMax = Math.sqrt(latAcc * radius);
    // allowed speed now so we can still slow down for that corner
    const d = Math.max(0, turn.at - this.t - 12);
    vMax = Math.min(car.spec.topSpeed * (0.8 + 0.2 * this.skill), Math.sqrt(vMax * vMax + 2 * 7.5 * (0.8 + 0.3 * this.skill) * d));
    // don't overshoot the end of the route
    let throttle = 0, brake = 0;
    const err = vMax - speed;
    if (err > 1) throttle = clamp(0.4 + err * 0.12, 0, 1);
    else if (err < -1.5) brake = clamp(-err * 0.15, 0, 1);
    else throttle = 0.3;
    // ease off while steering hard
    if (Math.abs(steer) > 0.8 && speed > 12) throttle *= 0.5;

    // stuck against something: back out, then try again
    if (this.reverseT > 0) {
      this.reverseT -= dt;
      return { throttle: 0, brake: 1, steer: -steer, handbrake: false, horn: false };
    }
    if (speed < 1.5 && throttle > 0.3) this.stuck += dt;
    else this.stuck = Math.max(0, this.stuck - dt);
    if (this.stuck > 1.2) {
      this.stuck = 0;
      this.reverseT = 1.1;
      if (++this.unstickTries > 2) {
        this.wantsRespawn = true;
        this.unstickTries = 0;
      }
    }
    if (speed > 5) this.unstickTries = 0;
    return { throttle, brake, steer, handbrake: false, horn: false };
  }

  private unstickTries = 0;
}
