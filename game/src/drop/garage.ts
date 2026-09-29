import * as THREE from 'three';
import { RAPIER, createWorld } from '../physics/world';
import { Car, type CarHost } from '../car/car';
import type { CarTemplate } from '../car/carAsset';
import { Effects } from '../fx/particles';
import { Skidmarks } from '../fx/skidmarks';
import { DebrisManager } from '../fx/debris';
import { makeConcrete } from '../render/textures';
import { DEMO_PRICE, TOTAL, dropPool, liveOdds, loadState, pull, saveState, type Car as DropCar, type DropState, type Pull } from './drop01';
import { DropCard } from './dropCard';
import { carIdOf, liveryOf } from './looks';

// The Collect Garage: Collect Car · Drop 01 simulated in 3D (the same drop as Ocean Drive's garage: see
// drop01.ts). Pay the demo price, the randomness comes in, the edition is assigned,
// the roller door goes up on your car in its tier's light, and the card shows its look, ratings and proof.

type Phase = 'idle' | 'closing' | 'paying' | 'entropy' | 'assign' | 'opening' | 'show';
const DUR: Record<Phase, number> = { idle: 0, closing: 1.2, paying: 0.9, entropy: 2.4, assign: 1.2, opening: 3.0, show: 0 };

const DOOR_W = 7.6, DOOR_H = 4.2, DOOR_Z = 4.2;
const ed = (n: number) => `#${String(n).padStart(4, '0')}`;
const smooth = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export interface GarageSounds {
  ui(kind: 'countdown' | 'go' | 'select' | 'back' | 'points' | 'wreck' | 'lose' | 'win'): void;
}

export class Garage {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  readonly card = new DropCard();
  sounds: GarageSounds | null = null;
  /** called with the edition the player wants to drive */
  onDrive: ((car: DropCar) => void) | null = null;
  state: DropState = loadState();
  private pool = dropPool();
  private world: RAPIER.World;
  private host: CarHost;
  private shown: Car | null = null;
  private showing: { car: DropCar; pull: Pull | null } | null = null;
  private pending: { car: DropCar; pull: Pull } | null = null;
  private phase: Phase = 'idle';
  private phaseT = 0;
  private revealed = false;
  private lookY = 2.9;
  private ringMat!: THREE.MeshBasicMaterial;
  private ttHeight = 0;
  private t = 0;
  private turntable = new THREE.Group();
  private door: THREE.Mesh;
  private tierLights: THREE.PointLight[] = [];
  private strips: THREE.MeshBasicMaterial;
  private board: { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D; tex: THREE.CanvasTexture; last: string };
  private promptEl: HTMLDivElement;
  private tierColor = new THREE.Color(1, 1, 1);

  constructor(
    env: THREE.Texture,
    private templates: Map<string, CarTemplate>,
  ) {
    this.world = createWorld();
    this.host = {
      world: this.world,
      fx: new Effects(),
      skids: new Skidmarks(16),
      debris: new DebrisManager(this.world, 1),
      sound: null,
      groundHeight: () => 0,
      now: () => this.t,
    };
    const s = this.scene;
    s.environment = env;
    s.environmentIntensity = 0.12; // the city's sky is far too bright for a closed garage
    s.background = new THREE.Color(0x0a0b0e);

    // the room: polished concrete floor, three walls, a ceiling with light strips; the front is the door
    const conc = makeConcrete(512, 7);
    conc.repeat.set(4, 4);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ map: conc, color: 0x3a3937, roughness: 0.38, metalness: 0.1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    s.add(floor);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.9 });
    const room = new THREE.Mesh(new THREE.BoxGeometry(12, 5.2, 10), wallMat);
    room.geometry.translate(0, 2.6, -0.8);
    (room.material as THREE.MeshStandardMaterial).side = THREE.BackSide;
    s.add(room);
    // front wall with the door opening, seen from the street side
    const front = new THREE.Group();
    const frontMat = new THREE.MeshStandardMaterial({ color: 0x2a2c31, roughness: 0.7, metalness: 0.2 });
    const side = (w: number, x: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 5.2, 0.3), frontMat);
      m.position.set(x, 2.6, DOOR_Z + 0.2);
      front.add(m);
    };
    side((12 - DOOR_W) / 2, -(DOOR_W / 2 + (12 - DOOR_W) / 4));
    side((12 - DOOR_W) / 2, DOOR_W / 2 + (12 - DOOR_W) / 4);
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W, 5.2 - DOOR_H, 0.3), frontMat);
    lintel.position.set(0, DOOR_H + (5.2 - DOOR_H) / 2, DOOR_Z + 0.2);
    front.add(lintel);
    s.add(front);
    // the roller door: horizontal ribs drawn into a canvas
    const dc = document.createElement('canvas');
    dc.width = 64;
    dc.height = 512;
    const dg = dc.getContext('2d')!;
    for (let y = 0; y < 512; y += 16) {
      const grd = dg.createLinearGradient(0, y, 0, y + 16);
      grd.addColorStop(0, '#9aa0a8');
      grd.addColorStop(0.5, '#c4c9cf');
      grd.addColorStop(1, '#6d737b');
      dg.fillStyle = grd;
      dg.fillRect(0, y, 64, 16);
    }
    const doorTex = new THREE.CanvasTexture(dc);
    doorTex.colorSpace = THREE.SRGBColorSpace;
    this.door = new THREE.Mesh(new THREE.PlaneGeometry(DOOR_W, DOOR_H), new THREE.MeshStandardMaterial({ map: doorTex, metalness: 0.7, roughness: 0.35 }));
    this.door.position.set(0, DOOR_H / 2, DOOR_Z + 0.05);
    s.add(this.door);
    // the board above the door
    const bc = document.createElement('canvas');
    bc.width = 1024;
    bc.height = 192;
    const btex = new THREE.CanvasTexture(bc);
    btex.colorSpace = THREE.SRGBColorSpace;
    this.board = { canvas: bc, g: bc.getContext('2d')!, tex: btex, last: '' };
    const board = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 1.35), new THREE.MeshBasicMaterial({ map: btex, toneMapped: false }));
    board.position.set(0, DOOR_H + 0.55, DOOR_Z + 0.37);
    s.add(board);
    // ceiling light strips (they take the tier colour on the reveal)
    this.strips = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.2, 2.3), toneMapped: false });
    for (const x of [-3, 0, 3]) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.06, 7.5), this.strips);
      strip.position.set(x, 5.12, -0.8);
      s.add(strip);
    }
    // turntable: a raised platform with a grooved, marked top (so you can see it turn), a lit edge ring in the
    // tier colour, and a fixed collar around the base
    const tc = document.createElement('canvas');
    tc.width = tc.height = 1024;
    const tg = tc.getContext('2d')!;
    tg.fillStyle = '#26282d';
    tg.fillRect(0, 0, 1024, 1024);
    tg.translate(512, 512);
    for (let r = 40; r < 505; r += 14) {
      tg.strokeStyle = r % 56 === 40 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.35)';
      tg.lineWidth = 3;
      tg.beginPath();
      tg.arc(0, 0, r, 0, Math.PI * 2);
      tg.stroke();
    }
    for (let k = 0; k < 24; k++) {
      tg.rotate((Math.PI * 2) / 24);
      tg.fillStyle = k % 6 === 0 ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.12)';
      tg.fillRect(430, -3, k % 6 === 0 ? 70 : 40, 6);
    }
    tg.fillStyle = 'rgba(255,255,255,0.8)';
    tg.font = '700 44px Helvetica, Arial, sans-serif';
    tg.textAlign = 'center';
    for (let k = 0; k < 4; k++) {
      tg.rotate(Math.PI / 2);
      tg.fillText('COLLECT', 0, -380);
    }
    const topTex = new THREE.CanvasTexture(tc);
    topTex.colorSpace = THREE.SRGBColorSpace;
    topTex.anisotropy = 8;
    const TT_H = 0.26, TT_R = 3.4;
    const ttSide = new THREE.MeshStandardMaterial({ color: 0x1c1d21, roughness: 0.35, metalness: 0.8 });
    const top = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.4, metalness: 0.55 });
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(TT_R, TT_R + 0.05, TT_H, 96), [ttSide, top, ttSide]);
    plate.position.y = TT_H / 2;
    plate.receiveShadow = true;
    plate.castShadow = true;
    this.turntable.add(plate);
    this.ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.6, 1.6), toneMapped: false });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(TT_R + 0.04, 0.035, 8, 128), this.ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = TT_H + 0.005;
    this.turntable.add(ring);
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(TT_R + 0.35, TT_R + 0.45, 0.1, 96, 1, true), ttSide);
    collar.position.set(0, 0.05, -0.8);
    s.add(collar);
    const collarTop = new THREE.Mesh(new THREE.RingGeometry(TT_R + 0.08, TT_R + 0.36, 96).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x111215, roughness: 0.6, metalness: 0.4 }));
    collarTop.position.set(0, 0.1, -0.8);
    s.add(collarTop);
    this.ttHeight = TT_H;
    this.turntable.position.z = -0.8;
    s.add(this.turntable);
    // lights: a key spot over the car, the strips' tier-coloured glow, a street-side fill
    const key = new THREE.SpotLight(0xfff1dc, 260, 25, 0.7, 0.6, 2);
    key.position.set(1.8, 5, 1.5);
    key.target.position.set(0, 0.4, -0.8);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0002;
    s.add(key, key.target);
    for (const x of [-4.5, 4.5]) {
      const l = new THREE.PointLight(0xffffff, 0, 16, 2);
      l.position.set(x, 3.2, -2);
      this.tierLights.push(l);
      s.add(l);
    }
    const fill = new THREE.SpotLight(0x9ab6ff, 70, 30, 0.9, 0.9, 2);
    fill.position.set(-2, 3, 9);
    fill.target.position.set(0, 1, 0);
    s.add(fill, fill.target, new THREE.HemisphereLight(0x3a4252, 0x15120e, 0.45));

    this.promptEl = document.createElement('div');
    this.promptEl.style.cssText =
      'position:fixed;left:50%;bottom:48px;transform:translateX(-50%);z-index:7;display:none;background:rgba(10,14,18,.8);border:1px solid rgba(255,255,255,.3);border-radius:6px;padding:10px 18px;color:#fff;font:15px Helvetica,Arial,sans-serif;letter-spacing:1px;text-align:center';
    document.getElementById('ui')!.appendChild(this.promptEl);
    this.drawBoard();
  }

  get busy() {
    return this.phase !== 'idle' && this.phase !== 'show';
  }

  /** entering from the street: the door is down, the last pull (if any) behind it */
  enter() {
    this.promptEl.style.display = 'block';
    this.phase = 'idle';
    this.phaseT = 0;
    this.door.position.y = DOOR_H / 2;
    this.door.scale.y = 1;
    this.card.show(false);
    this.setTierLight(null);
  }

  leave() {
    this.promptEl.style.display = 'none';
    this.card.show(false);
  }

  /** E: pay and pull (or pull again) */
  payAndPull() {
    if (this.busy || this.state.pool.length === 0) return;
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const p = pull(this.state, bytes)!;
    saveState(this.state);
    this.pending = { car: this.pool[p.edition - 1], pull: p };
    this.card.show(false);
    this.go(this.phase === 'show' ? 'closing' : 'paying');
    if (this.phase === 'paying') this.sounds?.ui('select');
  }

  /** D: drive the car on the turntable */
  drive() {
    if (this.phase === 'show' && this.showing) this.onDrive?.(this.showing.car);
  }

  /** start the drop over (demo): every edition back in the pool */
  reset() {
    if (this.busy) return;
    this.state = { pool: Array.from({ length: TOTAL }, (_, i) => i + 1), pulls: [] };
    saveState(this.state);
    this.drawBoard(true);
  }

  private go(p: Phase) {
    this.phase = p;
    this.phaseT = 0;
  }

  private setTierLight(color: string | null) {
    const c = color ? new THREE.Color(color) : new THREE.Color(1, 1, 1);
    this.tierColor.copy(c);
    for (const l of this.tierLights) {
      l.color.copy(c);
      l.intensity = color ? 60 : 0;
    }
    this.strips.color.copy(color ? c.clone().multiplyScalar(2.6) : new THREE.Color(2.2, 2.2, 2.3));
    this.ringMat.color.copy(color ? c.clone().multiplyScalar(2.2) : new THREE.Color(1.6, 1.6, 1.6));
  }

  private showCar(car: DropCar) {
    const tmpl = this.templates.get(carIdOf(car));
    if (!tmpl) return;
    if (this.shown) {
      this.turntable.remove(this.shown.root);
      this.shown.dispose();
    }
    const liv = liveryOf(car);
    this.shown = new Car(
      this.host,
      { index: 0, template: tmpl, ...liv, number: car.edition % 100, helmet: '#f2f2f2', isPlayer: true, driverName: 'You', wear: 0, toughnessMul: 1 },
      { position: new THREE.Vector3(0, 0, 0), yaw: 0 },
    );
    this.shown.body.setEnabled(false);
    this.turntable.add(this.shown.root);
  }

  private keysLine() {
    return `E&nbsp; pull again · ${DEMO_PRICE}<br>D&nbsp; drive this car in the city · Esc&nbsp; back to the street`;
  }

  private showCard() {
    if (!this.showing) return;
    const odds = liveOdds(this.state, this.pool);
    this.card.set(this.showing.car, this.showing.pull, odds, this.state.pool.length, this.keysLine());
    this.card.show(true);
  }

  private drawBoard(force = false) {
    const b = this.board;
    const g = b.g;
    const W = b.canvas.width, H = b.canvas.height;
    let line1 = 'COLLECT CAR · DROP 01';
    let line2 = `${this.state.pool.length.toLocaleString('en-US')} OF ${TOTAL.toLocaleString('en-US')} LEFT · ${DEMO_PRICE.toUpperCase()}`;
    let color = '#f2f4f8';
    const p = this.pending;
    if (this.phase === 'paying') line2 = 'PAYMENT RECEIVED';
    else if (this.phase === 'entropy') {
      // the randomness scrolling in: the real bytes, revealed a little more each frame
      const hex = p ? p.pull.bytes : '';
      const k = Math.floor(clamp01(this.phaseT / DUR.entropy) * 32);
      let s = hex.slice(0, k);
      for (let i = k; i < 32; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)];
      line2 = s.toUpperCase();
    } else if ((this.phase === 'assign' || this.phase === 'opening' || this.phase === 'show') && (p || this.showing)) {
      const c = (p ?? this.showing)!.car;
      const revealed = this.phase === 'show' || (this.phase === 'opening' && this.phaseT > DUR.opening * 0.35);
      line1 = `EDITION ${ed(c.edition)}`;
      line2 = revealed ? `${c.tier.name.toUpperCase()} · ${c.tier.bodyName.toUpperCase()} · ${c.serial} OF ${c.tier.count}` : 'ASSIGNED · LOOK UP';
      if (revealed) color = c.tier.color;
    } else if (this.state.pool.length === 0) line2 = 'SOLD OUT';
    const key = `${line1}|${line2}|${color}`;
    if (!force && key === b.last) return;
    b.last = key;
    g.fillStyle = '#07080a';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.strokeRect(6, 6, W - 12, H - 12);
    g.textAlign = 'center';
    g.fillStyle = '#ffffff';
    g.font = '700 58px Helvetica, Arial, sans-serif';
    g.fillText(line1, W / 2, 82);
    g.fillStyle = color;
    g.font = `600 ${line2.length > 40 ? 30 : 38}px ui-monospace, Menlo, monospace`;
    g.fillText(line2, W / 2, 150);
    b.tex.needsUpdate = true;
  }

  update(dt: number, aspect: number) {
    this.t += dt;
    this.phaseT += dt;
    const p = this.pending;
    switch (this.phase) {
      case 'closing': {
        const k = smooth(clamp01(this.phaseT / DUR.closing));
        this.setDoor(1 - k);
        if (this.phaseT >= DUR.closing) {
          this.setTierLight(null);
          this.go('paying');
          this.sounds?.ui('select');
        }
        break;
      }
      case 'paying':
        this.setDoor(0);
        if (this.phaseT >= DUR.paying) {
          this.go('entropy');
          this.sounds?.ui('countdown');
        }
        break;
      case 'entropy':
        if (this.phaseT >= DUR.entropy) {
          this.go('assign');
          this.sounds?.ui('points');
          if (p) this.showCar(p.car);
        }
        break;
      case 'assign':
        if (this.phaseT >= DUR.assign) {
          this.revealed = false;
          this.go('opening');
          this.sounds?.ui('go');
        }
        break;
      case 'opening': {
        const k = smooth(clamp01(this.phaseT / DUR.opening));
        this.setDoor(k);
        if (p && !this.revealed && this.phaseT > DUR.opening * 0.35) {
          this.revealed = true;
          this.showing = { car: p.car, pull: p.pull };
          this.setTierLight(p.car.tier.color);
          this.sounds?.ui(p.car.tier.id === 'secret' || p.car.tier.id === 'ultra' ? 'win' : 'points');
        }
        if (this.phaseT >= DUR.opening) {
          this.go('show');
          this.pending = null;
          this.showCard();
        }
        break;
      }
      default:
        break;
    }
    // a secret rare keeps the lights pulsing
    if (this.showing?.car.tier.id === 'secret' && (this.phase === 'show' || this.phase === 'opening')) {
      const f = 1 + 0.5 * Math.max(0, Math.sin(this.t * 7));
      for (const l of this.tierLights) l.intensity = 60 * f;
    }
    this.drawBoard();
    this.promptEl.innerHTML =
      this.state.pool.length === 0 && !this.busy
        ? 'Drop 01 is sold out · <b>R</b> start the drop over (demo) · <b>Esc</b> back to the street'
        : this.phase === 'idle'
          ? `<b>E</b> pay ${DEMO_PRICE} and pull a car · <b>Esc</b> back to the street`
          : this.phase === 'show'
            ? `<b>E</b> pull again · <b>D</b> drive it · <b>Esc</b> street`
            : '';
    this.promptEl.style.display = this.promptEl.innerHTML ? 'block' : 'none';

    // the car turns slowly; keep its wheels at rest
    this.turntable.rotation.y += dt * 0.42;
    if (this.shown) {
      this.shown.root.position.set(0, this.ttHeight, 0);
      this.shown.root.quaternion.identity();
      for (let i = 0; i < this.shown.wheelPivots.length; i++) this.shown.wheelPivots[i].position.copy(this.shown.template.wheels[i].center);
    }
    // camera: outside, at the door; it eases in once the door is open
    const open = this.door.scale.y < 0.5 ? 1 : 0;
    const d = open ? 8.2 : 15;
    this.camera.aspect = aspect;
    const k = 1 - Math.exp(-dt * 1.5);
    const cz = THREE.MathUtils.lerp(this.camera.position.z || d, d, k);
    this.lookY = THREE.MathUtils.lerp(this.lookY, open ? 0.8 : 2.9, k);
    this.camera.position.set(-1.2, 1.9, cz);
    this.camera.lookAt(0, this.lookY, -0.8);
    this.camera.updateProjectionMatrix();
  }

  /** 0 = shut, 1 = rolled up */
  private setDoor(open: number) {
    const k = Math.max(0.02, 1 - open);
    this.door.scale.y = k;
    this.door.position.y = DOOR_H - (DOOR_H * k) / 2;
  }

  /** the edition the player last drove from the garage, if any */
  static editionCar(edition: number): DropCar | null {
    return dropPool()[edition - 1] ?? null;
  }

  /** editions pulled in this browser, newest first */
  pulled(): DropCar[] {
    return this.state.pulls
      .slice()
      .reverse()
      .map((p) => this.pool[p.edition - 1]);
  }
}
