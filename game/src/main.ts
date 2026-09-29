import * as THREE from 'three';
import { initPhysics, PHYS_DT } from './physics/world';
import { Input, emptyInput } from './core/input';
import { Renderer } from './render/renderer';
import { GameCamera } from './render/camera';
import { loadCarTemplates, type CarTemplate } from './car/carAsset';
import { CAR_SPECS } from './car/specs';
import type { Car } from './car/car';
import { City } from './city/city';
import { CitySky } from './city/sky';
import { FreeDrive } from './game/drive';
import { Drops, RARITY, type Drop } from './game/drops';
import { Beacon } from './game/markers';
import { Rivals } from './game/rivals';
import { Breakables } from './city/breakables';
import { Race, RACES, bestTimes, buildRoute, type RaceDef } from './game/race';
import type { Route } from './game/route';
import { CityRacer } from './ai/cityRacer';
import { CityHud, fmtTime, type HudInfo, type MapMarker } from './ui/cityHud';
import { DerbyAudio } from './audio/audio';
import { CollectionScreen } from './ui/collection';
import { Garage } from './drop/garage';
import { dropPool, type Car as DropCar } from './drop/drop01';
import { carIdOf, liveryOf } from './drop/looks';

type EngineVoice = ReturnType<DerbyAudio['createEngine']>;

/** Times Square: the world origin (see scripts/build_tiles.py) */
const START = new THREE.Vector3(0, 0, 0);

interface RaceStart {
  def: RaceDef;
  route: Route;
  beacon: Beacon;
  x: number;
  z: number;
  yaw: number;
}

class App {
  private renderer: Renderer;
  private input = new Input();
  private cam: GameCamera;
  private hud!: CityHud;
  private templates = new Map<string, CarTemplate>();
  private city!: City;
  private sky!: CitySky;
  drive!: FreeDrive;
  drops!: Drops;
  rivals!: Rivals;
  breakables!: Breakables;
  private collection!: CollectionScreen;
  garage!: Garage;
  private inGarage = false;
  private garageSpot!: { x: number; z: number; yaw: number; beacon: Beacon };
  race: Race | null = null;
  private starts: RaceStart[] = [];
  private startGroup = new THREE.Group();
  private nextStart = 0;
  private audio: DerbyAudio | null = null;
  private engines = new Map<Car, EngineVoice>();
  private muted = false;
  private acc = 0;
  private last = performance.now();
  private debug = false;
  private fps = { t: 0, n: 0, v: 0 };
  private loadingEl: HTMLDivElement;
  private waiting = true;
  private countShown = '';
  private target: Drop | null = null;
  /** dev: let the race AI drive the player's car (testing) */
  autopilot = false;
  private auto: CityRacer | null = null;
  /** dev: park the camera somewhere (set from the console / screenshot script) */
  fixedCam: { pos: [number, number, number]; look: [number, number, number]; fov?: number } | null = null;

  constructor() {
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    this.renderer = new Renderer(canvas);
    this.renderer.setQuality('high');
    this.renderer.setBloom(0.28, 0.35, 1.6);
    this.cam = new GameCamera(window.innerWidth / window.innerHeight);
    this.cam.camera.far = 7000;
    this.cam.camera.updateProjectionMatrix();
    this.loadingEl = document.createElement('div');
    this.loadingEl.style.cssText =
      'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;background:#0e1216;color:#fff;font:600 14px/1.6 Helvetica,Arial,sans-serif;letter-spacing:3px;z-index:5';
    this.loadingEl.innerHTML = '<div style="font-size:34px;letter-spacing:6px;font-weight:800">COLLECT NYC</div><div class="p">LOADING MANHATTAN…</div>';
    document.getElementById('ui')!.appendChild(this.loadingEl);
    window.addEventListener('resize', () => {
      this.renderer.resize(window.innerWidth, window.innerHeight);
      this.cam.setAspect(window.innerWidth / window.innerHeight);
    });
    this.input.onFirstGesture = () => void this.initAudio();
    window.addEventListener('keydown', (e) => this.onKey(e));
    (window as unknown as { __nyc: App }).__nyc = this;
  }

  private progress(text: string) {
    (this.loadingEl.querySelector('.p') as HTMLElement).textContent = text;
  }

  async boot() {
    await initPhysics();
    const world = FreeDrive.createWorld();
    this.city = new City(world);
    this.progress('LOADING MANHATTAN…');
    await this.city.init();
    this.progress('LOADING CARS…');
    this.templates = await loadCarTemplates();
    this.drive = new FreeDrive(this.city, world, this.templates);
    this.sky = new CitySky(this.drive.scene, this.renderer.renderer);
    // dev tuning: ?exp=0.8&env=0.3&sun=2.6&hemi=0.5
    const q = new URLSearchParams(location.search);
    const num = (k: string) => (q.has(k) ? Number(q.get(k)) : null);
    if (num('exp') != null) this.renderer.renderer.toneMappingExposure = num('exp')!;
    if (num('env') != null) this.drive.scene.environmentIntensity = num('env')!;
    if (num('sun') != null) this.sky.sun.intensity = num('sun')!;
    if (num('hemi') != null) this.sky.hemi.intensity = num('hemi')!;
    this.hud = new CityHud(document.getElementById('ui')!, this.city);
    this.collection = new CollectionScreen(document.getElementById('ui')!);

    // drops
    this.drops = new Drops(this.city.graph);
    this.drive.scene.add(this.drops.group);
    this.drops.onCollect = (d) => {
      const r = RARITY[d.rarity];
      const first = Object.values(this.drops.collection.counts).reduce((a, b) => a + b, 0) === 1;
      this.hud.toast(`${r.label} DROP`, `${d.item}  +${r.points}${first ? '  ·  press I for your collection' : ''}`, r.color, first ? 4 : 2.6);
      this.audio?.ui('points');
    };
    this.drops.onLost = (d) => {
      if (d === this.target) this.hud.toast('TOO LATE', `The ${RARITY[d.rarity].label.toLowerCase()} drop expired`, '#ff6b4a', 2.2);
    };
    this.drops.onClaimed = (d, by) => {
      const near = Math.hypot(d.x - this.drive.car.curPos.x, d.z - this.drive.car.curPos.z) < 1500;
      if (d === this.target || near) this.hud.toast(`${by.toUpperCase()} GOT IT`, `${RARITY[d.rarity].label.toLowerCase()} drop · ${d.item}`, '#ff6b4a', 2.4);
    };
    this.breakables = new Breakables(this.drive.world, this.city, this.drive.fx);
    this.drive.scene.add(this.breakables.group);
    this.breakables.onHit = (p, strength, kind, car) => {
      this.audio?.impact(p, strength * (kind === 'tree' ? 0.7 : 0.9), kind === 'tree' ? 'debris' : 'wall');
      if (car === this.drive.car) this.cam.shake(0.15 + strength * (kind === 'tree' ? 0.5 : 0.3));
    };
    this.rivals = new Rivals(this.drive, this.city.graph, this.drops);
    this.drive.scene.add(this.rivals.group);

    // race start markers
    for (const def of RACES) {
      const route = buildRoute(this.city.graph, def, this.city.project);
      if (!route) {
        console.warn('[race] no route for', def.id);
        continue;
      }
      const a = route.at(0);
      const beacon = new Beacon('#ffffff', 340, 2.6, 'flag');
      beacon.group.position.set(a.x + a.dz * 6, 0, a.z - a.dx * 6); // beside the road, not on the start line
      this.startGroup.add(beacon.group);
      this.starts.push({ def, route, beacon, x: a.x, z: a.z, yaw: Math.atan2(a.dx, a.dz) });
    }
    this.drive.scene.add(this.startGroup);

    // the Collect Garage (Drop 01), on 8th Avenue by Port Authority, a few blocks from the start
    this.garage = new Garage(this.sky.env, this.templates);
    this.garage.sounds = { ui: (k) => this.audio?.ui(k) };
    this.garage.onDrive = (car) => this.driveEdition(car);
    const gp = this.city.project(40.7566, -73.9905);
    const gs = this.city.roads.spawnNear(gp.x, gp.z)!;
    const gb = new Beacon('#F5B83D', 380, 3.0, 'gem');
    gb.group.position.set(gs.x - Math.cos(gs.yaw) * 7, 0, gs.z + Math.sin(gs.yaw) * 7);
    this.startGroup.add(gb.group);
    this.garageSpot = { x: gs.x, z: gs.z, yaw: gs.yaw, beacon: gb };

    const carId = CAR_SPECS.some((s) => s.id === q.get('car')) ? q.get('car')! : 'hypercar';
    const at = q.get('at')?.split(',').map(Number);
    const s = this.city.roads.spawnNear(at?.[0] ?? START.x, at?.[1] ?? START.z)!;
    // keep driving the Drop 01 edition from last time, unless the URL asks for a car
    const saved = q.get('car') ? null : this.savedEdition();
    this.spawnWhenReady(saved ? carIdOf(saved) : carId, new THREE.Vector3(s.x, 0.8, s.z), s.yaw, saved ? () => this.driveEdition(saved, false) : undefined);
    requestAnimationFrame((t) => this.loop(t));
  }

  /** Streams the tiles around a spot first, then puts the car there. */
  private spawnWhenReady(carId: string, pos: THREE.Vector3, yaw: number, then?: () => void) {
    this.waiting = true;
    const first = !this.drive.car;
    if (first) this.progress('LOADING STREETS…');
    const tick = () => {
      this.city.update(pos, new THREE.Vector3());
      if (!this.city.readyAround(pos)) return void setTimeout(tick, 50);
      if (first || this.drive.car.spec.id !== carId) this.setCar(carId, pos, yaw);
      else this.drive.car.teleport(pos, yaw);
      this.cam.snap();
      this.waiting = false;
      this.loadingEl.remove();
      then?.();
    };
    tick();
  }

  private setCar(id: string, pos: THREE.Vector3, yaw: number) {
    this.drive.spawn(id, pos, yaw);
    const spec = this.drive.car.spec;
    this.hud.setCar(spec.name, spec.style);
    this.cam.snap();
    try {
      localStorage.removeItem('cnyc.driving');
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------------------------------------
  // the Collect Garage

  private savedEdition(): DropCar | null {
    try {
      const n = Number(localStorage.getItem('cnyc.driving'));
      return n ? (dropPool()[n - 1] ?? null) : null;
    } catch {
      return null;
    }
  }

  /** put the player in a Drop 01 edition, in its look */
  private driveEdition(car: DropCar, fromGarage = true) {
    if (fromGarage) this.exitGarage();
    const c = this.drive.car;
    const pos = fromGarage ? new THREE.Vector3(this.garageSpot.x, 0.8, this.garageSpot.z) : c.curPos.clone().setY(0.8);
    const f = c.forward();
    const yaw = fromGarage ? this.garageSpot.yaw : Math.atan2(f.x, f.z);
    this.drive.spawn(carIdOf(car), pos, yaw, liveryOf(car), car.edition % 100);
    this.hud.setCar(`Collect Car #${String(car.edition).padStart(4, '0')}`, `${car.tier.name} · ${car.tier.bodyName}`);
    this.cam.snap();
    try {
      localStorage.setItem('cnyc.driving', String(car.edition));
    } catch {
      /* ignore */
    }
    if (fromGarage) this.hud.toast(`EDITION #${String(car.edition).padStart(4, '0')}`, `${car.tier.name} ${car.tier.bodyName} · ${car.looks.paint.name}`, car.tier.color, 3);
  }

  private garageNear() {
    const p = this.drive.car.curPos;
    return Math.hypot(this.garageSpot.x - p.x, this.garageSpot.z - p.z) < 24;
  }

  private enterGarage() {
    this.inGarage = true;
    this.hud.el.style.display = 'none';
    this.garage.enter();
    for (const v of this.engines.values()) v.dispose();
    this.engines.clear();
  }

  private exitGarage() {
    if (!this.inGarage) return;
    this.inGarage = false;
    this.garage.leave();
    this.hud.el.style.display = '';
    this.last = performance.now();
  }

  private async initAudio() {
    if (this.audio) return;
    const a = new DerbyAudio({ crowdBed: false, crowdReactsToImpacts: false });
    this.audio = a;
    await a.init();
    a.setMasterVolume(0.8);
    a.setMuted(this.muted);
    this.drive.sound = {
      impact: (p, s, k) => a.impact(p, s, k),
      glass: (p, s) => a.glass(p, s),
      partOff: (p) => a.partOff(p),
      wreck: (p) => a.wreck(p),
    };
  }

  /** one engine voice per car on the road */
  private syncEngines() {
    if (!this.audio?.ready) return;
    for (const [car, v] of this.engines)
      if (!this.drive.cars.includes(car)) {
        v.dispose();
        this.engines.delete(car);
      }
    for (const car of this.drive.cars) if (!this.engines.has(car)) this.engines.set(car, this.audio.createEngine(car.spec.engine, car === this.drive.car));
  }

  // ------------------------------------------------------------------------------------------------
  // races

  private startNear(): RaceStart | null {
    const p = this.drive.car.curPos;
    return this.starts.find((s) => Math.hypot(s.x - p.x, s.z - p.z) < 22) ?? null;
  }

  private startRace(st: RaceStart) {
    this.drops.enabled = false;
    this.rivals.clear();
    this.rivals.enabled = false;
    this.drive.clearOthers();
    this.startGroup.visible = false;
    this.target = null;
    // stream the start area first, then line everyone up
    this.spawnWhenReady(this.drive.car.spec.id, new THREE.Vector3(st.x, 0.8, st.z), st.yaw, () => {
      const race = new Race(st.def, st.route, this.drive);
      this.drive.scene.add(race.group);
      race.onCheckpoint = () => this.audio?.ui('points');
      this.race = race;
      this.cam.snap();
      this.hud.toast(st.def.name.toUpperCase(), `${(st.route.length / 1609.34).toFixed(1)} miles · ${race.checkpoints.length} checkpoints`, '#ffd23f', 2.8);
    });
  }

  private endRace() {
    const r = this.race;
    if (!r) return;
    this.drive.scene.remove(r.group);
    r.dispose();
    this.race = null;
    this.hud.results(null);
    this.hud.countdown(null);
    this.drops.enabled = true;
    this.rivals.enabled = true;
    this.startGroup.visible = true;
  }

  private showResults(r: Race) {
    const rows = r
      .standings()
      .map((x, i) => `<tr class="${x.ai ? '' : 'me'}"><td>${i + 1}</td><td>${x.name}</td><td>${x.car.spec.name}</td><td>${x.finish != null ? fmtTime(x.finish) : '—'}</td></tr>`)
      .join('');
    const place = r.standings().indexOf(r.player) + 1;
    const title = place === 1 ? 'YOU WIN' : `FINISHED ${place}${['ST', 'ND', 'RD'][place - 1] ?? 'TH'}`;
    this.hud.results(
      `<h2 style="color:${place === 1 ? '#7dff5a' : '#ffd23f'}">${title}</h2><div>${r.def.name} · ${fmtTime(r.player.finish ?? 0)}${r.newBest ? ' · <b style="color:#ffd23f">NEW BEST</b>' : r.best ? ` · best ${fmtTime(r.best)}` : ''}</div>
       <table>${rows}</table><p><kbd style="background:#fff;color:#111;border-radius:3px;padding:0 6px">E</kbd> back to free roam</p>`,
    );
  }

  // ------------------------------------------------------------------------------------------------

  private onKey(e: KeyboardEvent) {
    if (e.repeat || this.waiting || !this.drive?.car) return;
    if (this.inGarage) {
      if (e.code === 'KeyE') this.garage.payAndPull();
      else if (e.code === 'KeyD') this.garage.drive();
      else if (e.code === 'Escape') this.exitGarage();
      else if (e.code === 'KeyR' && this.garage.state.pool.length === 0) this.garage.reset();
      return;
    }
    if (this.collection.visible) {
      if (e.code === 'KeyI' || e.code === 'Escape') this.collection.close();
      return;
    }
    if (e.code === 'KeyI' && !this.race) {
      this.collection.open(this.drops.collection);
      return;
    }
    const n = Number(e.code.replace('Digit', ''));
    if (e.code.startsWith('Digit') && n >= 1 && n <= CAR_SPECS.length && !this.race) {
      const c = this.drive.car;
      const f = c.forward();
      this.setCar(CAR_SPECS[n - 1].id, c.curPos.clone().setY(0.8), Math.atan2(f.x, f.z));
    } else if (e.code === 'KeyF' && !this.race) this.drive.repair();
    else if (e.code === 'KeyH') this.hud.toggleHelp();
    else if (e.code === 'KeyE') {
      if (this.race?.phase === 'done') this.endRace();
      else if (!this.race) {
        if (this.garageNear()) return void this.enterGarage();
        const st = this.startNear();
        if (st) this.startRace(st);
      }
    } else if (e.code === 'KeyT' && !this.race && this.starts.length) {
      const st = this.starts[this.nextStart++ % this.starts.length];
      // pull up just before the start marker
      this.spawnWhenReady(this.drive.car.spec.id, new THREE.Vector3(st.x - Math.sin(st.yaw) * 14, 0.8, st.z - Math.cos(st.yaw) * 14), st.yaw);
    } else if (e.code === 'KeyG' && !this.race) {
      const g = this.garageSpot;
      this.spawnWhenReady(this.drive.car.spec.id, new THREE.Vector3(g.x - Math.sin(g.yaw) * 14, 0.8, g.z - Math.cos(g.yaw) * 14), g.yaw);
    } else if (e.code === 'Escape' && this.race) this.endRace();
  }

  private stepGame(dt: number, drv: ReturnType<Input['driver']>) {
    const d = this.drive;
    const r = this.race;
    if (r) r.step(dt);
    else this.rivals.step(dt);
    if (r && this.autopilot && r.phase === 'run') {
      if (!this.auto) this.auto = new CityRacer(r.route, 0.9, 0);
      drv = this.auto.update(dt, d.car);
      if (this.auto.wantsRespawn) {
        r.respawnPlayer();
        // start the autopilot again from where the race put the car back
        this.auto = new CityRacer(r.route, 0.9, 0);
        this.auto.t = Math.max(0, r.player.t - 4);
      }
    } else if (!r) this.auto = null;
    const input = r && r.phase === 'countdown' ? { ...emptyInput(), brake: 1 } : r && r.phase === 'done' ? { ...emptyInput(), brake: 0.5 } : drv;
    d.fixedStep(document.hidden ? emptyInput() : input);
  }

  private loop(now: number) {
    requestAnimationFrame((t) => this.loop(t));
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.inGarage) {
      // the city waits while you're in the garage
      this.garage.update(dt, window.innerWidth / window.innerHeight);
      this.garageSpot.beacon.update(dt);
      this.input.endFrame();
      this.renderer.render(this.garage.scene, this.garage.camera);
      return;
    }
    if (this.collection?.visible && this.drive?.car) {
      // paused: nothing moves and no clocks run while you look at your collection
      this.input.endFrame();
      this.renderer.render(this.drive.scene, this.cam.camera);
      return;
    }
    if (this.waiting || !this.drive.car) {
      this.input.endFrame();
      if (this.drive?.car) this.renderer.render(this.drive.scene, this.cam.camera);
      return;
    }
    const d = this.drive;
    const car = d.car;

    if (this.input.wasPressed('camera')) this.cam.cycle();
    if (this.input.wasPressed('reset')) {
      if (this.race) {
        if (this.race.phase === 'run') {
          this.race.respawnPlayer();
          this.cam.snap();
        }
      } else {
        // back on the nearest street, same car and damage
        const s = this.city.roads.spawnNear(car.curPos.x, car.curPos.z);
        if (s) car.teleport(new THREE.Vector3(s.x, 0.8, s.z), s.yaw);
      }
    }
    if (this.input.wasPressed('mute')) {
      this.muted = !this.muted;
      this.audio?.setMuted(this.muted);
    }
    if (this.input.wasPressed('debug')) this.debug = !this.debug;
    this.input.pollGamepad();
    const drv = this.input.driver(dt);

    this.acc += dt;
    let steps = 0;
    while (this.acc >= PHYS_DT && steps < 12) {
      this.stepGame(PHYS_DT, drv);
      this.acc -= PHYS_DT;
      steps++;
    }
    if (steps === 12) this.acc = 0;
    d.frame(dt, this.acc / PHYS_DT);
    this.breakables.update(dt, d.cars);
    for (const s of this.starts) s.beacon.update(dt);

    // modes
    const info: HudInfo = { markers: [] };
    const r = this.race;
    if (r) {
      r.update(dt);
      if (r.phase === 'countdown') {
        const n = Math.ceil(-r.clock);
        const txt = n > 0 ? String(n) : '';
        if (txt !== this.countShown) {
          this.countShown = txt;
          this.hud.countdown(txt || null);
          if (txt) this.audio?.ui('countdown');
        }
      } else if (r.phase === 'run' && r.clock < 1) {
        if (this.countShown !== 'GO') {
          this.countShown = 'GO';
          this.hud.countdown('GO!', '#7dff5a');
          this.audio?.ui('go');
        }
      } else if (this.countShown) {
        this.countShown = '';
        this.hud.countdown(null);
      }
      // keep the table live while the rivals cross the line
      if (r.phase === 'done' && this.hudResultsShown) {
        const sig = r.racers.map((x) => x.finish ?? '-').join();
        if (sig !== this.resultsSig) {
          this.resultsSig = sig;
          this.showResults(r);
        }
      }
      if (r.phase === 'done' && !this.hudResultsShown) {
        this.hudResultsShown = true;
        this.showResults(r);
        const place = r.standings().indexOf(r.player) + 1;
        this.audio?.ui(place <= 3 ? 'win' : 'lose');
      }
      if (r.phase !== 'done') this.hudResultsShown = false;
      const st = r.standings();
      const cp = r.nextCheckpoint();
      info.race = { pos: st.indexOf(r.player) + 1, of: st.length, cp: r.player.next, cps: r.checkpoints.length, time: r.clock, best: r.best };
      if (r.phase === 'run' && r.player.car.wrecked) info.prompt = '<kbd>R</kbd>Wrecked. Back on the route with a fresh car';
      if (r.phase !== 'done') info.objective = { x: cp.x, z: cp.z, color: '#ffd23f', label: r.player.next === r.checkpoints.length - 1 ? 'FINISH' : 'CHECKPOINT' };
      info.route = r.route.x.length ? this.routePoints(r) : null;
      info.markers!.push({ x: cp.x, z: cp.z, color: '#ffd23f', r: 6, shape: 'ring' });
      for (const x of r.racers) if (x.ai) info.markers!.push({ x: x.car.curPos.x, z: x.car.curPos.z, color: '#ff4a3a', r: 4 });
    } else {
      this.drops.update(dt, d.time, car.curPos);
      this.rivals.frame(dt, car);
      for (const rv of this.rivals.list) info.markers!.push({ x: rv.car.curPos.x, z: rv.car.curPos.z, color: rv.color, r: 4 });
      this.target = this.drops.target(car.curPos, d.time);
      const c = this.drops.collection;
      info.score = { points: c.points, items: Object.values(c.counts).reduce((a, b) => a + b, 0) };
      for (const x of this.drops.list) info.markers!.push({ x: x.x, z: x.z, color: RARITY[x.rarity].color, r: x === this.target ? 6 : 4.5 });
      for (const s of this.starts) info.markers!.push({ x: s.x, z: s.z, color: '#fff', r: 5, shape: 'flag' });
      const t = this.target;
      if (t) {
        const left = this.drops.timeLeft(t, d.time);
        const ch = this.rivals.chasing(t);
        const race = ch ? ` · ${ch.rival.name.toUpperCase()} ${ch.left > 1000 ? (ch.left / 1609.34).toFixed(1) + ' MI' : Math.round((ch.left * 3.28084) / 10) * 10 + ' FT'}` : '';
        info.objective = { x: t.x, z: t.z, color: RARITY[t.rarity].color, label: `${RARITY[t.rarity].label} DROP · ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}${race}` };
      }
      info.markers!.push({ x: this.garageSpot.x, z: this.garageSpot.z, color: '#F5B83D', r: 6, shape: 'ring' });
      const st = this.startNear();
      if (this.garageNear()) {
        const left = this.garage.state.pool.length;
        info.prompt = `<kbd>E</kbd><b>Collect Garage</b> · Car Drop 01 · ${left.toLocaleString('en-US')} of 1,000 left<br><span style="font-size:12px;opacity:.8">Pull a car ($99 demo price), watch the door go up, then drive it in the city.</span>`;
      } else if (st) {
        const best = bestTimes()[st.def.id];
        info.prompt = `<kbd>E</kbd><b>${st.def.name}</b> · ${(st.route.length / 1609.34).toFixed(1)} mi${best ? ` · best ${fmtTime(best)}` : ''}<br><span style="font-size:12px;opacity:.8">${st.def.blurb}</span>`;
      }
    }

    // camera
    if (d.playerHits > 0) {
      this.cam.shake(Math.min(1, d.playerHits * 1.4));
      d.playerHits = 0;
    }
    const tp = car.template;
    const bb = tp.bodyBox;
    const hoodEye = new THREE.Vector3(0, bb.min.y + (bb.max.y - bb.min.y) * 1.02, bb.min.z + (bb.max.z - bb.min.z) * 0.64);
    const bumperEye = new THREE.Vector3(0, Math.max(0.5, bb.min.y + 0.35), bb.max.z + 0.2);
    this.cam.update(
      dt,
      { pos: car.root.position, quat: car.root.quaternion, velocity: car.velocity, hoodEye, bumperEye, length: tp.size.z },
      this.input.lookBack,
      Infinity,
      (x, z) => this.city.heightAt(x, z),
      d.cars.slice(1).map((c) => c.root.position),
    );
    if (this.fixedCam) {
      const c = this.cam.camera;
      c.position.set(...this.fixedCam.pos);
      c.lookAt(...this.fixedCam.look);
      c.fov = this.fixedCam.fov ?? 60;
      c.updateProjectionMatrix();
    }
    const eye = this.cam.camera.position;
    for (const c of d.cars) c.root.visible = c === car || c.root.position.distanceTo(eye) > c.template.size.z * 0.62;
    d.fx.particles.setViewport(this.renderer.heightPx, this.cam.camera.fov);
    this.sky.follow(car.curPos, this.cam.camera.position);

    // audio
    this.syncEngines();
    if (this.audio?.ready) {
      const c = this.cam.camera;
      this.audio.setListener(c.position, new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion), new THREE.Vector3(0, 1, 0).applyQuaternion(c.quaternion));
      for (const [cc, v] of this.engines) {
        const veh = cc.vehicle;
        v.update({
          rpm: veh.rpm,
          throttle: veh.throttleOut,
          load: veh.throttleOut * (veh.groundedCount > 0 ? 1 : 0.2),
          position: cc.curPos,
          velocity: cc.velocity,
          damage: Math.max(cc.zones.front, (cc.zones.front + cc.zones.rear) / 2),
          dead: cc.wrecked,
        });
        let skid = 0;
        for (const w of veh.wheels) skid = Math.max(skid, w.grounded ? w.skid : 0);
        this.audio.skid(cc.index, cc.curPos, skid, 0.85); // asphalt
      }
    }

    this.hud.update(car, dt, this.cam.camera, info);
    this.fps.t += dt;
    this.fps.n++;
    if (this.fps.t > 0.5) {
      this.fps.v = Math.round(this.fps.n / this.fps.t);
      this.fps.t = this.fps.n = 0;
    }
    if (this.debug) {
      const s = this.city.stats, i = this.renderer.lastInfo.render, p = car.curPos;
      this.hud.debug(`${this.fps.v} fps · ${i.calls} calls · ${(i.triangles / 1e6).toFixed(2)}M tris · tiles ${s.loaded} (${s.loading} loading, ${s.colliders} solid) · x ${p.x.toFixed(0)} z ${p.z.toFixed(0)}`);
    } else this.hud.debug(null);
    this.renderer.render(d.scene, this.cam.camera);
    this.input.endFrame();
  }

  private hudResultsShown = false;
  private resultsSig = '';
  private routeCache: { race: Race; pts: number[] } | null = null;
  private routePoints(r: Race) {
    if (this.routeCache?.race !== r) {
      const pts: number[] = [];
      for (let i = 0; i < r.route.x.length; i++) pts.push(r.route.x[i], r.route.z[i]);
      this.routeCache = { race: r, pts };
    }
    return this.routeCache.pts;
  }
}

const app = new App();
app.boot().catch((e) => {
  console.error(e);
  document.getElementById('ui')!.innerHTML = `<div style="color:#f66;font:16px monospace;padding:20px">Failed to start: ${String(e)}</div>`;
});
