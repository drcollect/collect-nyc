import * as THREE from 'three';

let beamTex: THREE.Texture | null = null;
/** vertical fade: bright at the bottom, gone at the top; soft edges across */
function beamTexture() {
  if (beamTex) return beamTex;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const g = c.getContext('2d')!;
  const img = g.createImageData(64, 256);
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 64; x++) {
      const v = 1 - y / 255; // canvas y=0 is the top of the texture (v=1)
      const across = Math.sin((x / 63) * Math.PI);
      const a = Math.pow(1 - v, 1.6) * (0.35 + 0.65 * across);
      const i = (y * 64 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  g.putImageData(img, 0, 0);
  beamTex = new THREE.CanvasTexture(c);
  beamTex.colorSpace = THREE.SRGBColorSpace;
  return beamTex;
}

/** A light pillar you can see over the rooftops, with a pulsing ring on the street. */
export class Beacon {
  readonly group = new THREE.Group();
  private ring: THREE.Mesh;
  private beam: THREE.Mesh;
  private item: THREE.Object3D | null = null;
  private t = Math.random() * 10;

  constructor(color: THREE.ColorRepresentation, height = 260, radius = 2.2, item: 'gem' | 'flag' | null = 'gem') {
    const col = new THREE.Color(color);
    const beamMat = new THREE.MeshBasicMaterial({
      color: col,
      map: beamTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 20, 1, true).translate(0, height / 2, 0), beamMat);
    this.beam.renderOrder = 4;
    this.beam.frustumCulled = false;
    const ringMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(3.2, 3.8, 48).rotateX(-Math.PI / 2), ringMat);
    this.ring.position.y = 0.12;
    this.group.add(this.beam, this.ring);
    if (item === 'gem') {
      const m = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 1.6, metalness: 0.3, roughness: 0.2 });
      this.item = new THREE.Mesh(new THREE.OctahedronGeometry(0.85, 0), m);
      this.item.position.y = 1.8;
      this.group.add(this.item);
    } else if (item === 'flag') {
      this.item = checkeredFlag();
      this.item.position.y = 0;
      this.group.add(this.item);
    }
  }

  update(dt: number, urgency = 0) {
    this.t += dt;
    const pulse = (this.t * (1 + urgency * 2)) % 1;
    this.ring.scale.setScalar(1 + pulse * 1.6);
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - pulse);
    if (this.item && !(this.item instanceof THREE.Group)) {
      this.item.rotation.y += dt * 1.8;
      this.item.position.y = 1.8 + Math.sin(this.t * 2.2) * 0.25;
    }
    const flicker = urgency > 0.7 ? 0.55 + 0.45 * Math.abs(Math.sin(this.t * 9)) : 1;
    (this.beam.material as THREE.MeshBasicMaterial).opacity = flicker;
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    });
  }
}

function checkeredFlag(): THREE.Group {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 40;
  const g = c.getContext('2d')!;
  for (let y = 0; y < 5; y++) for (let x = 0; x < 8; x++) {
    g.fillStyle = (x + y) % 2 ? '#111' : '#fff';
    g.fillRect(x * 8, y * 8, 8, 8);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const grp = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 4.2, 8).translate(0, 2.1, 0), new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.8, roughness: 0.3 }));
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.1).translate(0.9, 3.6, 0), new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.8 }));
  grp.add(pole, flag);
  return grp;
}

/** A race checkpoint: a glowing arch across the street, facing along the route. */
export class Gate {
  readonly group = new THREE.Group();
  private mat: THREE.MeshBasicMaterial;
  private t = 0;

  constructor(x: number, z: number, dirX: number, dirZ: number, width: number, finish = false) {
    const half = THREE.MathUtils.clamp(width / 2 + 1.5, 5, 11);
    this.mat = new THREE.MeshBasicMaterial({ color: finish ? 0xffffff : 0xffd23f, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    // an arch: two posts and a half-torus across the top
    const h = 5.5;
    const post = new THREE.CylinderGeometry(0.28, 0.28, h, 10).translate(0, h / 2, 0);
    const l = new THREE.Mesh(post, this.mat);
    const r = new THREE.Mesh(post, this.mat);
    l.position.x = -half;
    r.position.x = half;
    const top = new THREE.Mesh(new THREE.TorusGeometry(half, 0.28, 8, 40, Math.PI), this.mat);
    top.position.y = h;
    top.scale.y = 0.35;
    // a floor strip marks the line
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, 1.2).rotateX(-Math.PI / 2), this.mat);
    strip.position.y = 0.1;
    this.group.add(l, r, top, strip);
    if (finish) {
      const c = document.createElement('canvas');
      c.width = 128;
      c.height = 16;
      const g = c.getContext('2d')!;
      for (let y = 0; y < 2; y++) for (let x = 0; x < 16; x++) {
        g.fillStyle = (x + y) % 2 ? '#111' : '#fff';
        g.fillRect(x * 8, y * 8, 8, 8);
      }
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, 1.2), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
      banner.position.y = h + 0.2;
      this.group.add(banner);
    }
    this.group.position.set(x, 0, z);
    // arch spans local X; face it across the route direction
    this.group.rotation.y = Math.atan2(dirX, dirZ);
  }

  setState(state: 'next' | 'later' | 'passed') {
    this.group.visible = state !== 'passed';
    this.mat.opacity = state === 'next' ? 0.95 : 0.25;
  }

  update(dt: number) {
    this.t += dt;
    if (this.mat.opacity > 0.5) this.mat.opacity = 0.75 + 0.2 * Math.sin(this.t * 6);
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.mat.dispose();
  }
}
