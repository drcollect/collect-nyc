import * as THREE from 'three';
import { RAPIER, GROUPS_ARENA, GROUPS_WALL } from '../physics/world';
import { fetchMeshes, type Manifest, type MeshData, type TileProps } from './format';
import { geometryFrom, makeBuildingMaterial, makeFarMaterial, makeFlatMaterial, makeWaterMaterial } from './materials';
import { RoadIndex } from './roads';
import { buildProps } from './props';
import { StreetGraph, makeProjector } from './graph';

const RENDER_R = 700; // full tiles within this distance of the focus (and of the look-ahead point)
const DROP_R = 900; // unloaded beyond this
const PHYS_R = 90; // tiles within this distance of the car get colliders
const MAX_LOADS = 6;
const GROUND_TOP = 0.03; // between the sidewalk (0) and the road surface (0.06)

interface Tile {
  key: number;
  ix: number;
  iz: number;
  state: 'loading' | 'ready' | 'failed';
  abort: AbortController;
  group?: THREE.Group;
  solid?: MeshData;
  collider?: RAPIER.Collider;
  props?: TileProps;
  propGroup?: THREE.Group;
  /** props knocked over while this tile is loaded ("kind:index") */
  knocked?: Set<string>;
}

export type BreakKind = 'lamp' | 'signal' | 'tree';
export interface PropRef {
  kind: BreakKind;
  x: number;
  z: number;
  /** yaw for lamps/signals, scale for trees */
  a: number;
  hide(): void;
}
const BREAK_MESH: Record<BreakKind, string> = { lamp: 'Lamps', signal: 'Signals', tree: 'Trees' };
const _hideM = new THREE.Matrix4().makeScale(0, 0, 0);

export class City {
  readonly group = new THREE.Group();
  manifest!: Manifest;
  roads!: RoadIndex;
  graph!: StreetGraph;
  /** lat/lon -> world */
  project!: (lat: number, lon: number) => { x: number; z: number };
  private tiles = new Map<number, Tile>();
  private exists = new Set<number>();
  private loading = 0;
  private flatMat = makeFlatMaterial();
  private buildMat = makeBuildingMaterial();
  private mask!: THREE.DataTexture;
  private maskData!: Uint8Array;
  private base: string;
  /** loaded tiles, for the debug readout */
  stats = { loaded: 0, colliders: 0, loading: 0 };

  constructor(private world: RAPIER.World, base = '/city/') {
    this.base = base;
    this.group.name = 'City';
  }

  async init(progress?: (f: number) => void) {
    this.manifest = await (await fetch(this.base + 'manifest.json')).json();
    const { nx, nz } = this.manifest.grid;
    for (const [ix, iz] of this.manifest.tiles) this.exists.add(iz * nx + ix);
    progress?.(0.2);
    const [far, island, roads, graph] = await Promise.all([
      fetchMeshes(this.base + 'far.bin'),
      fetchMeshes(this.base + 'island.bin'),
      fetch(this.base + 'roads.json').then((r) => r.json()),
      fetch(this.base + 'graph.json').then((r) => r.json()),
    ]);
    progress?.(0.8);
    this.roads = new RoadIndex(roads.roads);
    this.graph = new StreetGraph(graph);
    this.project = makeProjector(this.manifest);

    this.maskData = new Uint8Array(nx * nz);
    this.mask = new THREE.DataTexture(this.maskData, nx, nz, THREE.RedFormat, THREE.UnsignedByteType);
    this.mask.needsUpdate = true;
    const farMesh = new THREE.Mesh(geometryFrom(far.get('far')!), makeFarMaterial(this.mask, nx));
    farMesh.name = 'Skyline';
    farMesh.frustumCulled = false;
    const isl = new THREE.Mesh(geometryFrom(island.get('island')!), this.flatMat);
    isl.name = 'Island';
    isl.receiveShadow = true;
    const water = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000).rotateX(-Math.PI / 2), makeWaterMaterial());
    water.position.y = -0.7;
    water.name = 'Water';
    this.group.add(farMesh, isl, water);

    // one big ground slab under the whole island; walls and buildings come per tile
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(20000, 1, 20000).setTranslation(0, GROUND_TOP - 1, 0).setFriction(1).setCollisionGroups(GROUPS_ARENA),
      body,
    );
    progress?.(1);
  }

  private rectDist(ix: number, iz: number, x: number, z: number) {
    const { x0, z0 } = this.manifest.grid;
    const S = this.manifest.tileSize;
    const ax = x0 + ix * S, az = z0 + iz * S;
    const dx = Math.max(ax - x, 0, x - (ax + S));
    const dz = Math.max(az - z, 0, z - (az + S));
    return Math.hypot(dx, dz);
  }

  tileOf(x: number, z: number): [number, number] {
    const { x0, z0 } = this.manifest.grid;
    const S = this.manifest.tileSize;
    return [Math.floor((x - x0) / S), Math.floor((z - z0) / S)];
  }

  /** Load what's near `pos` (and near where the car will be shortly), drop what's far, keep colliders around the car. */
  update(pos: THREE.Vector3, vel: THREE.Vector3, others: THREE.Vector3[] = []) {
    const { nx, nz } = this.manifest.grid;
    const S = this.manifest.tileSize;
    const ahead = pos.clone().addScaledVector(vel, 3);
    const want: { key: number; ix: number; iz: number; d: number }[] = [];
    const r = Math.ceil(RENDER_R / S) + 1;
    for (const c of [pos, ahead]) {
      const [cx, cz] = this.tileOf(c.x, c.z);
      for (let iz = Math.max(0, cz - r); iz <= Math.min(nz - 1, cz + r); iz++)
        for (let ix = Math.max(0, cx - r); ix <= Math.min(nx - 1, cx + r); ix++) {
          const key = iz * nx + ix;
          if (!this.exists.has(key) || this.tiles.has(key)) continue;
          const d = Math.min(this.rectDist(ix, iz, pos.x, pos.z), this.rectDist(ix, iz, ahead.x, ahead.z));
          if (d < RENDER_R) want.push({ key, ix, iz, d });
        }
    }
    want.sort((a, b) => a.d - b.d);
    for (const w of want) {
      if (this.loading >= MAX_LOADS) break;
      if (this.tiles.has(w.key)) continue;
      this.load(w.key, w.ix, w.iz);
    }
    let maskDirty = false;
    let colliders = 0;
    for (const t of this.tiles.values()) {
      const d = Math.min(this.rectDist(t.ix, t.iz, pos.x, pos.z), this.rectDist(t.ix, t.iz, ahead.x, ahead.z));
      if (d > DROP_R) {
        this.drop(t);
        maskDirty = true;
        continue;
      }
      if (t.state !== 'ready') continue;
      const dOther = others.reduce((m, o) => Math.min(m, this.rectDist(t.ix, t.iz, o.x, o.z)), Infinity);
      const near = this.rectDist(t.ix, t.iz, pos.x, pos.z) < PHYS_R || this.rectDist(t.ix, t.iz, ahead.x, ahead.z) < PHYS_R * 0.5 || dOther < PHYS_R * 0.6;
      if (near && !t.collider && t.solid) this.addCollider(t);
      else if (!near && t.collider && Math.min(this.rectDist(t.ix, t.iz, pos.x, pos.z), dOther) > PHYS_R * 1.6) this.releaseCollider(t);
      if (t.collider) colliders++;
      if (this.maskData[t.key] !== 255) {
        this.maskData[t.key] = 255;
        maskDirty = true;
      }
    }
    if (maskDirty) this.mask.needsUpdate = true;
    this.stats.loaded = this.tiles.size;
    this.stats.colliders = colliders;
    this.stats.loading = this.loading;
  }

  /** true once the tiles around `pos` are drawn and solid (spawning waits for this) */
  readyAround(pos: THREE.Vector3) {
    const { nx } = this.manifest.grid;
    const [cx, cz] = this.tileOf(pos.x, pos.z);
    for (let iz = cz - 1; iz <= cz + 1; iz++)
      for (let ix = cx - 1; ix <= cx + 1; ix++) {
        const key = iz * nx + ix;
        if (!this.exists.has(key)) continue;
        const t = this.tiles.get(key);
        if (!t || t.state === 'loading') return false;
        if (this.rectDist(ix, iz, pos.x, pos.z) < PHYS_R && t.solid && !t.collider) return false;
      }
    return true;
  }

  private load(key: number, ix: number, iz: number) {
    const t: Tile = { key, ix, iz, state: 'loading', abort: new AbortController() };
    this.tiles.set(key, t);
    this.loading++;
    fetchMeshes(`${this.base}tiles/t_${ix}_${iz}.bin`, t.abort.signal)
      .then((meshes) => {
        if (this.tiles.get(key) !== t) return;
        const g = new THREE.Group();
        g.name = `Tile_${ix}_${iz}`;
        const flat = meshes.get('flat');
        if (flat) {
          const m = new THREE.Mesh(geometryFrom(flat), this.flatMat);
          m.receiveShadow = true;
          g.add(m);
        }
        const marks = meshes.get('marks');
        if (marks) {
          const m = new THREE.Mesh(geometryFrom(marks), this.flatMat);
          m.receiveShadow = true;
          m.renderOrder = 1;
          g.add(m);
        }
        if (meshes.props) {
          t.props = meshes.props;
          t.propGroup = buildProps(meshes.props);
          t.knocked = new Set();
          g.add(t.propGroup);
        }
        const solid = meshes.get('solid');
        if (solid) {
          const m = new THREE.Mesh(geometryFrom(solid), this.buildMat);
          m.castShadow = true;
          m.receiveShadow = true;
          g.add(m);
          t.solid = solid;
        }
        t.group = g;
        t.state = 'ready';
        this.group.add(g);
      })
      .catch((e) => {
        if (e?.name !== 'AbortError') {
          console.warn('[city] tile', ix, iz, e);
          t.state = 'failed';
        }
      })
      .finally(() => this.loading--);
  }

  private addCollider(t: Tile) {
    const d = t.solid!;
    const desc = RAPIER.ColliderDesc.trimesh(d.position, d.index, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
      .setFriction(0.35)
      .setRestitution(0.05)
      .setCollisionGroups(GROUPS_WALL)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS | RAPIER.ActiveEvents.COLLISION_EVENTS)
      .setContactForceEventThreshold(0);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    t.collider = this.world.createCollider(desc, body);
    this.wallHandles.add(t.collider.handle);
  }

  private releaseCollider(t: Tile) {
    if (!t.collider) return;
    this.wallHandles.delete(t.collider.handle);
    const b = t.collider.parent();
    if (b) this.world.removeRigidBody(b); // removes its collider too
    else this.world.removeCollider(t.collider, false);
    t.collider = undefined;
  }

  /** handles of building / shore colliders, so impacts can be classed as wall hits */
  readonly wallHandles = new Set<number>();

  private drop(t: Tile) {
    t.abort.abort();
    this.releaseCollider(t);
    if (t.group) {
      this.group.remove(t.group);
      // instanced props share their geometry across tiles; only the tile's own meshes are freed
      t.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh) m.geometry.dispose();
        if ((m as THREE.InstancedMesh).isInstancedMesh) (m as THREE.InstancedMesh).dispose();
      });
    }
    this.maskData[t.key] = 0;
    this.tiles.delete(t.key);
  }

  /** breakable street props within r metres of (x, z), in the loaded tiles */
  propsNear(x: number, z: number, r: number, out: PropRef[] = []): PropRef[] {
    out.length = 0;
    const { nx } = this.manifest.grid;
    const [cx, cz] = this.tileOf(x, z);
    for (let iz = cz - 1; iz <= cz + 1; iz++)
      for (let ix = cx - 1; ix <= cx + 1; ix++) {
        const t = this.tiles.get(iz * nx + ix);
        if (!t?.props || t.state !== 'ready' || this.rectDist(ix, iz, x, z) > r) continue;
        for (const kind of ['lamp', 'signal', 'tree'] as BreakKind[]) {
          const arr = t.props[kind];
          if (!arr) continue;
          for (let i = 0, n = arr.length / 3; i < n; i++) {
            const px = arr[i * 3], pz = arr[i * 3 + 1];
            if (Math.abs(px - x) > r || Math.abs(pz - z) > r) continue;
            const key = `${kind}:${i}`;
            if (t.knocked!.has(key)) continue;
            const tile = t;
            out.push({
              kind,
              x: px,
              z: pz,
              a: arr[i * 3 + 2],
              hide: () => {
                tile.knocked!.add(key);
                const m = tile.propGroup?.getObjectByName(BREAK_MESH[kind]) as THREE.InstancedMesh | undefined;
                if (m) {
                  m.setMatrixAt(i, _hideM);
                  m.instanceMatrix.needsUpdate = true;
                }
              },
            });
          }
        }
      }
    return out;
  }

  heightAt(_x: number, _z: number) {
    return 0;
  }
}
