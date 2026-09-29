import * as THREE from 'three';
import type { City } from '../city/city';
import type { Car } from '../car/car';

const MAP_MPP = 4; // metres per pixel of the pre-drawn map
const VIEW = 220; // minimap size (css px)
const VIEW_M = 900; // metres across the minimap

const ROAD_STYLE: Record<string, [string, number]> = {
  motorway: ['#f2b14a', 3.2],
  trunk: ['#f2c86a', 3],
  primary: ['#e9e4d8', 2.6],
  secondary: ['#d8d3c7', 2.1],
  tertiary: ['#c7c2b6', 1.8],
  residential: ['#a9a59c', 1.4],
  unclassified: ['#a9a59c', 1.3],
  living_street: ['#99958d', 1.1],
};

export interface MapMarker {
  x: number;
  z: number;
  color: string;
  r?: number;
  shape?: 'dot' | 'flag' | 'ring';
}

export interface HudInfo {
  /** free-roam score line */
  score?: { points: number; items: number } | null;
  /** the thing to drive to: an arrow at the top of the screen */
  objective?: { x: number; z: number; color: string; label: string } | null;
  prompt?: string | null;
  race?: { pos: number; of: number; cp: number; cps: number; time: number; best: number | null } | null;
  markers?: MapMarker[];
  /** race route (x,z,...) drawn on the minimap */
  route?: number[] | null;
}

export const fmtTime = (t: number) => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

const _f = new THREE.Vector3();

export class CityHud {
  readonly el: HTMLDivElement;
  private q = <T extends HTMLElement>(sel: string) => this.el.querySelector(sel) as T;
  private miniCtx: CanvasRenderingContext2D;
  private map: HTMLCanvasElement;
  private mapX0 = 0;
  private mapZ0 = 0;
  private lastStreet = '';
  private streetT = 0;
  private toastT = 0;
  private lastScore = '';

  constructor(parent: HTMLElement, private city: City) {
    this.el = document.createElement('div');
    this.el.className = 'cnyc-hud';
    this.el.innerHTML = `
      <style>
        .cnyc-hud{position:absolute;inset:0;pointer-events:none;font-family:'Helvetica Neue',Arial,sans-serif;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.6)}
        .cnyc-speed{position:absolute;right:28px;bottom:22px;text-align:right}
        .cnyc-speed b{font-size:64px;font-weight:800;letter-spacing:-2px;line-height:1}
        .cnyc-unit{font-size:13px;opacity:.75;letter-spacing:2px}
        .cnyc-street{position:absolute;left:50%;top:22px;transform:translateX(-50%);font-size:22px;font-weight:700;letter-spacing:1px;white-space:nowrap;
          background:#0d6b3a;border:2px solid #fff;border-radius:4px;padding:4px 14px;text-shadow:none;transition:opacity .4s}
        .cnyc-car{position:absolute;left:24px;top:20px;font-size:13px;letter-spacing:2px;opacity:.9}
        .cnyc-car b{display:block;font-size:20px;letter-spacing:1px}
        .cnyc-dmg{margin-top:6px;width:140px;height:5px;background:rgba(255,255,255,.2);border-radius:3px;overflow:hidden}
        .cnyc-dmg i{display:block;height:100%;background:#7dff5a}
        .cnyc-score{margin-top:12px;font-size:13px;letter-spacing:2px}
        .cnyc-score b{font-size:26px;display:inline;letter-spacing:0;margin-right:6px;color:#ffd23f}
        .cnyc-mini{position:absolute;left:22px;bottom:22px;width:${VIEW}px;height:${VIEW}px;border-radius:50%;border:2px solid rgba(255,255,255,.8);
          box-shadow:0 2px 12px rgba(0,0,0,.5);background:#1c2630}
        .cnyc-help{position:absolute;right:24px;top:20px;font-size:12px;line-height:1.6;opacity:.8;text-align:right}
        .cnyc-credit{position:absolute;right:12px;bottom:4px;font-size:10px;opacity:.6;pointer-events:auto}
        .cnyc-credit a{color:#fff}
        .cnyc-debug{position:absolute;left:50%;bottom:8px;transform:translateX(-50%);font:12px monospace;color:#9f9;background:rgba(0,0,0,.55);padding:3px 8px;display:none}
        .cnyc-obj{position:absolute;left:50%;top:74px;transform:translateX(-50%);text-align:center;font-size:13px;letter-spacing:2px;font-weight:700}
        .cnyc-obj svg{display:block;margin:0 auto 2px;filter:drop-shadow(0 1px 3px rgba(0,0,0,.6))}
        .cnyc-obj span{display:block;font-size:12px;font-weight:600;opacity:.9}
        .cnyc-toast{position:absolute;left:50%;top:32%;transform:translate(-50%,-50%);text-align:center;transition:opacity .35s,transform .35s;opacity:0}
        .cnyc-toast b{display:block;font-size:44px;font-weight:900;letter-spacing:3px}
        .cnyc-toast span{font-size:17px;letter-spacing:2px;font-weight:600}
        .cnyc-prompt{position:absolute;left:50%;bottom:120px;transform:translateX(-50%);background:rgba(10,14,18,.78);border:1px solid rgba(255,255,255,.35);
          border-radius:6px;padding:10px 18px;font-size:15px;letter-spacing:1px;text-align:center;display:none;text-shadow:none;max-width:560px}
        .cnyc-prompt kbd{display:inline-block;background:#fff;color:#111;border-radius:3px;padding:0 7px;font:700 14px/22px Helvetica,Arial;margin-right:8px}
        .cnyc-race{position:absolute;right:28px;top:86px;text-align:right;display:none}
        .cnyc-race .pos{font-size:58px;font-weight:900;line-height:1}
        .cnyc-race .pos small{font-size:22px;opacity:.8}
        .cnyc-race .row{font-size:14px;letter-spacing:2px;margin-top:4px}
        .cnyc-count{position:absolute;left:50%;top:40%;transform:translate(-50%,-50%);font-size:150px;font-weight:900;display:none}
        .cnyc-results{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(10,14,18,.88);border:1px solid rgba(255,255,255,.3);
          border-radius:10px;padding:26px 34px;min-width:380px;display:none;text-shadow:none}
        .cnyc-results h2{margin:0 0 4px;font-size:30px;letter-spacing:3px}
        .cnyc-results table{width:100%;border-collapse:collapse;margin:14px 0;font-size:16px}
        .cnyc-results td{padding:5px 6px;border-bottom:1px solid rgba(255,255,255,.1)}
        .cnyc-results td:last-child{text-align:right;font-variant-numeric:tabular-nums}
        .cnyc-results tr.me td{color:#ffd23f;font-weight:700}
        .cnyc-results p{margin:6px 0 0;font-size:13px;opacity:.8;letter-spacing:1px}
      </style>
      <div class="cnyc-car"><b></b><span></span><div class="cnyc-dmg"><i></i></div><div class="cnyc-score"></div></div>
      <div class="cnyc-street"></div>
      <div class="cnyc-obj"><svg width="44" height="30" viewBox="0 0 44 30"><path d="M22 2 L40 28 L22 20 L4 28 Z" stroke="#08323a" stroke-width="2" /></svg><div class="t"></div><span></span></div>
      <canvas class="cnyc-mini"></canvas>
      <div class="cnyc-speed"><b>0</b><div class="cnyc-unit">MPH</div></div>
      <div class="cnyc-race"><div class="pos"></div><div class="row cp"></div><div class="row tm"></div><div class="row bt"></div></div>
      <div class="cnyc-toast"><b></b><span></span></div>
      <div class="cnyc-prompt"></div>
      <div class="cnyc-count"></div>
      <div class="cnyc-results"></div>
      <div class="cnyc-help">WASD / arrows drive · SPACE handbrake<br>C camera · R back on the street · F repair<br>1–5 change car · T next race · G garage · I collection<br>M mute · H help</div>
      <div class="cnyc-debug"></div>
      <div class="cnyc-credit">Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> · buildings, trees &amp; shoreline: NYC Open Data</div>`;
    parent.appendChild(this.el);
    const mini = this.q<HTMLCanvasElement>('.cnyc-mini');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    mini.width = mini.height = VIEW * dpr;
    this.miniCtx = mini.getContext('2d')!;
    this.miniCtx.scale(dpr, dpr);
    this.map = this.drawMap();
  }

  /** The whole island once, north up, into an offscreen canvas. */
  private drawMap() {
    const m = this.city.manifest;
    const { x0, z0, nx, nz } = m.grid;
    const S = m.tileSize;
    this.mapX0 = x0;
    this.mapZ0 = z0;
    const c = document.createElement('canvas');
    c.width = Math.ceil((nx * S) / MAP_MPP);
    c.height = Math.ceil((nz * S) / MAP_MPP);
    const g = c.getContext('2d')!;
    const px = (x: number) => (x - x0) / MAP_MPP, pz = (z: number) => (z - z0) / MAP_MPP;
    g.fillStyle = '#3b4148';
    for (const ring of m.outline) {
      g.beginPath();
      for (let i = 0; i < ring.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, px(ring[i]), pz(ring[i + 1]));
      g.closePath();
      g.fill();
    }
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const order = ['living_street', 'unclassified', 'residential', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway'];
    for (const cls of order) {
      const [col, w] = ROAD_STYLE[cls];
      g.strokeStyle = col;
      g.lineWidth = w;
      g.beginPath();
      for (const l of this.city.roads.lines) {
        if (l.c !== cls) continue;
        for (let i = 0; i < l.p.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, px(l.p[i]), pz(l.p[i + 1]));
      }
      g.stroke();
    }
    return c;
  }

  setCar(name: string, style: string) {
    this.q('.cnyc-car b').textContent = name.toUpperCase();
    this.q('.cnyc-car span').textContent = style.toUpperCase();
  }

  toggleHelp() {
    const h = this.q('.cnyc-help');
    h.style.display = h.style.display === 'none' ? '' : 'none';
  }

  debug(text: string | null) {
    const d = this.q('.cnyc-debug');
    d.style.display = text ? 'block' : 'none';
    if (text) d.textContent = text;
  }

  toast(title: string, sub: string, color = '#fff', seconds = 2.6) {
    const t = this.q('.cnyc-toast');
    this.q('.cnyc-toast b').textContent = title;
    this.q('.cnyc-toast b').style.color = color;
    this.q('.cnyc-toast span').textContent = sub;
    t.style.opacity = '1';
    t.style.transform = 'translate(-50%,-50%) scale(1)';
    this.toastT = seconds;
  }

  countdown(text: string | null, color = '#fff') {
    const c = this.q('.cnyc-count');
    c.style.display = text ? 'block' : 'none';
    if (text) {
      c.textContent = text;
      c.style.color = color;
    }
  }

  results(html: string | null) {
    const r = this.q('.cnyc-results');
    r.style.display = html ? 'block' : 'none';
    if (html) r.innerHTML = html;
  }

  update(car: Car, dt: number, camera: THREE.Camera, info: HudInfo) {
    const v = car.velocity;
    this.q('.cnyc-speed b').textContent = String(Math.round(Math.hypot(v.x, v.z) * 2.23694));
    const dmg = this.q('.cnyc-dmg i');
    dmg.style.width = `${Math.round(car.health * 100)}%`;
    dmg.style.background = car.health > 0.6 ? '#7dff5a' : car.health > 0.3 ? '#ffd23f' : '#ff4a3a';

    // score
    const sc = info.score ? `<b>${info.score.points.toLocaleString('en-US')}</b>COLLECTED · ${info.score.items} ITEM${info.score.items === 1 ? "" : "S"}` : '';
    if (sc !== this.lastScore) {
      this.q('.cnyc-score').innerHTML = sc;
      this.lastScore = sc;
    }

    // street sign: the named street under the car, shown for a while after it changes
    const p = car.curPos;
    const hit = this.city.roads.nearest(p.x, p.z, (l) => !!l.n, 25);
    const name = hit?.line.n ?? '';
    if (name && name !== this.lastStreet) {
      this.lastStreet = name;
      this.q('.cnyc-street').textContent = name;
      this.streetT = 4;
    }
    this.streetT -= dt;
    this.q('.cnyc-street').style.opacity = this.streetT > 0 && this.lastStreet ? '1' : '0';

    // objective arrow, relative to where the camera looks
    const obj = this.q('.cnyc-obj');
    if (info.objective) {
      camera.getWorldDirection(_f);
      const camYaw = Math.atan2(_f.x, _f.z);
      const toYaw = Math.atan2(info.objective.x - p.x, info.objective.z - p.z);
      const rel = -(toYaw - camYaw); // screen rotation, clockwise positive
      obj.style.display = 'block';
      const svg = obj.querySelector('svg')!;
      svg.style.transform = `rotate(${rel}rad)`;
      (svg.querySelector('path') as SVGPathElement).setAttribute('fill', info.objective.color);
      const d = Math.hypot(info.objective.x - p.x, info.objective.z - p.z);
      obj.querySelector('.t')!.textContent = d > 1000 ? `${(d / 1609.34).toFixed(1)} MI` : `${Math.round(d * 3.28084 / 10) * 10} FT`;
      (obj.querySelector('span') as HTMLElement).textContent = info.objective.label;
      (obj.querySelector('span') as HTMLElement).style.color = info.objective.color;
    } else obj.style.display = 'none';

    // prompt
    const pr = this.q('.cnyc-prompt');
    pr.style.display = info.prompt ? 'block' : 'none';
    if (info.prompt && pr.innerHTML !== info.prompt) pr.innerHTML = info.prompt;

    // race panel
    const rp = this.q('.cnyc-race');
    if (info.race) {
      const r = info.race;
      rp.style.display = 'block';
      const suf = ['ST', 'ND', 'RD'][r.pos - 1] ?? 'TH';
      this.q('.cnyc-race .pos').innerHTML = `${r.pos}<small>${suf} / ${r.of}</small>`;
      this.q('.cnyc-race .cp').textContent = `CHECKPOINT ${Math.min(r.cp + 1, r.cps)} / ${r.cps}`;
      this.q('.cnyc-race .tm').textContent = `TIME ${fmtTime(Math.max(0, r.time))}`;
      this.q('.cnyc-race .bt').textContent = r.best ? `BEST ${fmtTime(r.best)}` : '';
    } else rp.style.display = 'none';

    // toast fade
    if (this.toastT > 0) {
      this.toastT -= dt;
      if (this.toastT <= 0) {
        const t = this.q('.cnyc-toast');
        t.style.opacity = '0';
        t.style.transform = 'translate(-50%,-50%) scale(0.92)';
      }
    }

    this.drawMini(car, info);
  }

  private drawMini(car: Car, info: HudInfo) {
    const g = this.miniCtx;
    const p = car.curPos;
    const fwd = car.forward();
    const heading = Math.atan2(fwd.x, -fwd.z); // 0 = uptown (-z)
    const scale = VIEW / (VIEW_M / MAP_MPP);
    const mx = (x: number) => (x - this.mapX0) / MAP_MPP, mz = (z: number) => (z - this.mapZ0) / MAP_MPP;
    g.save();
    g.clearRect(0, 0, VIEW, VIEW);
    g.beginPath();
    g.arc(VIEW / 2, VIEW / 2, VIEW / 2, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#1c2a36';
    g.fillRect(0, 0, VIEW, VIEW);
    g.translate(VIEW / 2, VIEW / 2);
    g.rotate(-heading);
    g.scale(scale, scale);
    g.translate(-mx(p.x), -mz(p.z));
    g.drawImage(this.map, 0, 0);
    if (info.route) {
      g.strokeStyle = 'rgba(255,210,63,0.9)';
      g.lineWidth = 5 / scale;
      g.lineJoin = 'round';
      g.beginPath();
      const r = info.route;
      for (let i = 0; i < r.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, mx(r[i]), mz(r[i + 1]));
      g.stroke();
    }
    g.restore();

    // markers: clamped to the rim when off the map, so far-away drops still show their direction
    const c = Math.cos(-heading), s = Math.sin(-heading);
    const k = VIEW / VIEW_M;
    for (const m of info.markers ?? []) {
      const dx = m.x - p.x, dz = m.z - p.z;
      let sx = (dx * c - dz * s) * k, sy = (dx * s + dz * c) * k;
      const d = Math.hypot(sx, sy);
      const lim = VIEW / 2 - 9;
      const clamped = d > lim;
      if (clamped) {
        sx *= lim / d;
        sy *= lim / d;
      }
      g.save();
      g.translate(VIEW / 2 + sx, VIEW / 2 + sy);
      g.fillStyle = m.color;
      g.strokeStyle = 'rgba(0,0,0,.7)';
      g.lineWidth = 1.5;
      const r = (m.r ?? 5) * (clamped ? 0.8 : 1);
      if (m.shape === 'flag') {
        g.fillStyle = '#fff';
        g.fillRect(-r, -r, r * 2, r * 2);
        g.fillStyle = '#111';
        g.fillRect(-r, -r, r, r);
        g.fillRect(0, 0, r, r);
        g.strokeRect(-r, -r, r * 2, r * 2);
      } else if (m.shape === 'ring') {
        g.strokeStyle = m.color;
        g.lineWidth = 2.5;
        g.beginPath();
        g.arc(0, 0, r, 0, Math.PI * 2);
        g.stroke();
      } else {
        g.beginPath();
        g.arc(0, 0, r, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
      g.restore();
    }

    // player arrow
    g.save();
    g.translate(VIEW / 2, VIEW / 2);
    g.fillStyle = '#39e7ff';
    g.strokeStyle = '#08323a';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(0, -9);
    g.lineTo(6.5, 7);
    g.lineTo(0, 3.5);
    g.lineTo(-6.5, 7);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }
}
