import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { TileProps } from './format';

// Low-poly street furniture, one merged geometry per kind (vertex colours), drawn as instances per tile.

function colored(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(hex);
  const n = geo.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  geo.deleteAttribute('uv');
  return geo;
}

function merge(parts: THREE.BufferGeometry[]) {
  const g = mergeGeometries(parts, false)!;
  g.computeBoundingSphere();
  return g;
}

/** NYC cobra-head street light: tall pole, curved arm over the road (+Z), lamp head at the end */
function lampGeometry() {
  const green = 0x3d4a3f, grey = 0x9aa0a4;
  return merge([
    colored(new THREE.CylinderGeometry(0.09, 0.14, 8.6, 7).translate(0, 4.3, 0), green),
    colored(new THREE.CylinderGeometry(0.22, 0.26, 0.9, 7).translate(0, 0.45, 0), green), // base
    colored(new THREE.BoxGeometry(0.12, 0.12, 2.6).translate(0, 8.5, 1.2), green), // arm
    colored(new THREE.BoxGeometry(0.42, 0.18, 0.9).translate(0, 8.42, 2.55), grey), // head
    colored(new THREE.BoxGeometry(0.34, 0.04, 0.7).translate(0, 8.31, 2.55), 0xfff2c8), // lens
  ]);
}

/** traffic signal: pole, mast arm across the road (+Z), two signal heads hanging off it */
function signalGeometry() {
  const dark = 0x2b2f33, yellow = 0xd9a400;
  const head = (z: number) => [
    colored(new THREE.BoxGeometry(0.36, 1.05, 0.34).translate(0, 5.25, z), yellow),
    colored(new THREE.BoxGeometry(0.2, 0.2, 0.05).translate(0, 5.6, z - 0.19), 0xb3261e),
    colored(new THREE.BoxGeometry(0.2, 0.2, 0.05).translate(0, 5.25, z - 0.19), 0x6b5200),
    colored(new THREE.BoxGeometry(0.2, 0.2, 0.05).translate(0, 4.9, z - 0.19), 0x1d6b2a),
  ];
  return merge([
    colored(new THREE.CylinderGeometry(0.12, 0.16, 6.2, 7).translate(0, 3.1, 0), dark),
    colored(new THREE.BoxGeometry(0.14, 0.14, 6.0).translate(0, 5.95, 3.0), dark),
    ...head(3.4),
    ...head(5.6),
    // pedestrian signal box on the pole
    colored(new THREE.BoxGeometry(0.34, 0.34, 0.3).translate(0, 2.6, -0.25), dark),
  ]);
}

/** street tree: trunk and a lumpy crown (per-instance tint comes from instanceColor) */
function treeGeometry() {
  const crown = new THREE.IcosahedronGeometry(2.3, 1);
  const pos = crown.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = 1 + 0.18 * Math.sin(x * 2.1 + z * 1.7) * Math.cos(y * 2.3);
    pos.setXYZ(i, x * k, y * k * 0.85, z * k);
  }
  crown.computeVertexNormals();
  return merge([
    colored(new THREE.CylinderGeometry(0.16, 0.24, 3.4, 6).translate(0, 1.7, 0), 0x4a3b2c),
    colored(crown.translate(0, 4.6, 0), 0xffffff), // tinted green per instance
  ]);
}

/** the classic wooden rooftop water tank: legs, staves, conical roof */
function tankGeometry() {
  const wood = 0x6d5a45, dark = 0x3a3530;
  const legs: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[-1.3, -1.3], [1.3, -1.3], [1.3, 1.3], [-1.3, 1.3]])
    legs.push(colored(new THREE.BoxGeometry(0.18, 3.0, 0.18).translate(x, 1.5, z), dark));
  return merge([
    ...legs,
    colored(new THREE.BoxGeometry(3.2, 0.2, 3.2).translate(0, 3.0, 0), dark),
    colored(new THREE.CylinderGeometry(1.9, 2.0, 4.2, 14, 1, true).translate(0, 5.2, 0), wood),
    colored(new THREE.CylinderGeometry(1.95, 1.95, 0.12, 14).translate(0, 4.2, 0), dark), // hoop
    colored(new THREE.CylinderGeometry(1.95, 1.95, 0.12, 14).translate(0, 6.2, 0), dark),
    colored(new THREE.ConeGeometry(2.15, 1.5, 14).translate(0, 8.05, 0), dark),
  ]);
}

function boxGeometry() {
  return merge([
    colored(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), 0x8f9496),
    colored(new THREE.BoxGeometry(0.9, 0.06, 0.9).translate(0, 1.02, 0), 0x5e6366),
  ]);
}

let shared: {
  lamp: THREE.BufferGeometry;
  signal: THREE.BufferGeometry;
  tree: THREE.BufferGeometry;
  tank: THREE.BufferGeometry;
  box: THREE.BufferGeometry;
  mat: THREE.MeshStandardMaterial;
  treeMat: THREE.MeshStandardMaterial;
} | null = null;

export function propAssets() {
  if (!shared) {
    shared = {
      lamp: lampGeometry(),
      signal: signalGeometry(),
      tree: treeGeometry(),
      tank: tankGeometry(),
      box: boxGeometry(),
      mat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.1 }),
      treeMat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, flatShading: true }),
    };
  }
  return shared;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _c = new THREE.Color();

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, count: number, name: string) {
  const m = new THREE.InstancedMesh(geo, mat, count);
  m.name = name;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** a group of instanced meshes for one tile's props */
export function buildProps(p: TileProps, ground = 0.06): THREE.Group {
  const a = propAssets();
  const g = new THREE.Group();
  g.name = 'Props';
  const place = (m: THREE.InstancedMesh, i: number, x: number, y: number, z: number, yaw: number, sx = 1, sy = sx, sz = sx) => {
    _q.setFromAxisAngle(_up, yaw);
    m.setMatrixAt(i, _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz)));
  };
  if (p.lamp?.length) {
    const n = p.lamp.length / 3;
    const m = instanced(a.lamp, a.mat, n, 'Lamps');
    for (let i = 0; i < n; i++) place(m, i, p.lamp[i * 3], ground, p.lamp[i * 3 + 1], p.lamp[i * 3 + 2]);
    g.add(m);
  }
  if (p.signal?.length) {
    const n = p.signal.length / 3;
    const m = instanced(a.signal, a.mat, n, 'Signals');
    for (let i = 0; i < n; i++) place(m, i, p.signal[i * 3], ground, p.signal[i * 3 + 1], p.signal[i * 3 + 2]);
    g.add(m);
  }
  if (p.tree?.length) {
    const n = p.tree.length / 3;
    const m = instanced(a.tree, a.treeMat, n, 'Trees');
    for (let i = 0; i < n; i++) {
      const x = p.tree[i * 3], z = p.tree[i * 3 + 1], s = p.tree[i * 3 + 2];
      const h = Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
      place(m, i, x, 0, z, h * 6.28, s, s * (0.9 + h * 0.3), s);
      _c.setHSL(0.24 + h * 0.08, 0.38 + h * 0.2, 0.2 + h * 0.1);
      m.setColorAt(i, _c);
    }
    g.add(m);
  }
  if (p.tank?.length) {
    const n = p.tank.length / 5;
    const m = instanced(a.tank, a.mat, n, 'WaterTowers');
    for (let i = 0; i < n; i++) {
      const o = i * 5;
      place(m, i, p.tank[o], p.tank[o + 2], p.tank[o + 1], p.tank[o + 4], p.tank[o + 3]);
    }
    g.add(m);
  }
  if (p.box?.length) {
    const n = p.box.length / 7;
    const m = instanced(a.box, a.mat, n, 'RoofBoxes');
    for (let i = 0; i < n; i++) {
      const o = i * 7;
      place(m, i, p.box[o], p.box[o + 2], p.box[o + 1], p.box[o + 6], p.box[o + 3], p.box[o + 4], p.box[o + 5]);
    }
    g.add(m);
  }
  for (const c of g.children) {
    const m = c as THREE.InstancedMesh;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
  }
  return g;
}
