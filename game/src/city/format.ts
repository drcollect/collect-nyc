// Reader for the city files written by scripts/build_tiles.py.
// A file is gzip("CNYT" | u32 version | u32 jsonLen | json | blocks); json lists each mesh's blocks as [offset, length]
// relative to the end of the json.

export interface MeshData {
  name: string;
  count: number;
  triangles: number;
  position: Float32Array;
  uv: Float32Array;
  normal: Int8Array; // xyz0, normalized
  color: Uint8Array; // rgba: kind, variant, floors, 255
  index: Uint32Array;
  /** far skyline only: tile index per vertex (iz * nx + ix) */
  tile?: Uint16Array;
}

export interface Manifest {
  version: number;
  built: string;
  origin: { lat: number; lon: number; rotationDeg: number };
  tileSize: number;
  grid: { x0: number; z0: number; nx: number; nz: number };
  kinds: { flat: Record<string, number>; solid: Record<string, number> };
  tiles: [number, number, number][];
  outline: number[][];
  sources: string[];
}

export interface RoadLine {
  c: string; // class: primary, secondary, ...
  n: string; // name
  w: number; // width (m)
  o: number; // one-way
  b: number; // bridge
  p: number[]; // x0, z0, x1, z1, ...
}

async function inflate(res: Response): Promise<ArrayBuffer> {
  const buf = await res.arrayBuffer();
  const b = new Uint8Array(buf);
  // the host may already have decoded it (Content-Encoding) — only inflate real gzip
  if (b[0] !== 0x1f || b[1] !== 0x8b) return buf;
  const ds = new DecompressionStream('gzip');
  return new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
}

/** Per-tile street furniture, as flat number lists in world coords (see scripts/details.py). */
export interface TileProps {
  lamp?: number[]; // x, z, yaw
  signal?: number[]; // x, z, yaw
  tree?: number[]; // x, z, scale
  tank?: number[]; // x, z, roofY, scale, yaw
  box?: number[]; // x, z, roofY, sx, sy, sz, yaw
}

export type MeshSet = Map<string, MeshData> & { props?: TileProps };

export async function fetchMeshes(url: string, signal?: AbortSignal): Promise<MeshSet> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const buf = await inflate(res);
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'CNYT') throw new Error(`${url}: not a city file`);
  const jsonLen = dv.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, jsonLen)));
  const base = 12 + jsonLen;
  const out: MeshSet = new Map<string, MeshData>();
  out.props = header.props;
  for (const m of header.meshes) {
    const sl = <T>(C: { new (b: ArrayBuffer, o: number, n: number): T; BYTES_PER_ELEMENT: number }, r: [number, number]) =>
      new C(buf, base + r[0], r[1] / C.BYTES_PER_ELEMENT);
    out.set(m.name, {
      name: m.name,
      count: m.count,
      triangles: m.triangles,
      position: sl(Float32Array, m.position),
      uv: sl(Float32Array, m.uv),
      normal: sl(Int8Array, m.normal),
      color: sl(Uint8Array, m.color),
      index: sl(Uint32Array, m.index),
      tile: m.tile ? sl(Uint16Array, m.tile) : undefined,
    });
  }
  return out;
}
