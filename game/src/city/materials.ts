import * as THREE from 'three';
import type { MeshData } from './format';

// Per-vertex "cdata" (u8 x4, not normalized, so the shader sees 0..255):
//   flat meshes:  kind (0 sidewalk/land, 1 park, 2 road, 3 plaza, 4 pitch), tint, 0, 255
//   solid meshes: kind (0 wall, 1 roof, 2 shore wall), variant, floors, 255
// uv: walls = (metres along the footprint, metres up); roofs and flats = plan metres.

const NOISE = /* glsl */ `
float cnHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float cnNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(cnHash(i), cnHash(i + vec2(1, 0)), u.x), mix(cnHash(i + vec2(0, 1)), cnHash(i + vec2(1, 1)), u.x), u.y);
}
`;

function hashStr(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

function patch(mat: THREE.MeshStandardMaterial, fragBody: string, extraVertex = '', extraVertexHead = '', uniforms: Record<string, THREE.IUniform> = {}) {
  // Three caches programs by onBeforeCompile's source text, which is the same closure for every material here
  const key = `cnyc:${hashStr(fragBody + extraVertex)}`;
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec4 cdata;\nvarying vec4 vData;\nvarying vec2 vFac;\nvarying vec3 vWorldP;\n${extraVertexHead}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\nvData = cdata;\nvFac = uv;\n${extraVertex}`,
      )
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\nvWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec4 vData;\nvarying vec2 vFac;\nvarying vec3 vWorldP;\n${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\nfloat cnRough = roughness; float cnMetal = metalness;\n${fragBody}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = cnRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = cnMetal;');
  };
}

/** ground, parks, streets */
export function makeFlatMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  patch(
    m,
    /* glsl */ `
    int kind = int(vData.x + 0.5);
    vec2 p = vWorldP.xz;
    float n = cnNoise(p * 0.35) * 0.6 + cnNoise(p * 2.1) * 0.4;
    float big = cnNoise(p * 0.02);
    vec3 c;
    if (kind == 2) {            // asphalt
      c = vec3(0.105, 0.108, 0.115) * (0.82 + 0.3 * n) * (0.9 + 0.2 * big);
      cnRough = 0.82 - 0.12 * n;
    } else if (kind == 1) {     // park
      c = mix(vec3(0.16, 0.25, 0.09), vec3(0.27, 0.36, 0.14), n) * (0.85 + 0.3 * big);
      cnRough = 0.95;
    } else if (kind == 4) {     // sports pitch
      c = vec3(0.2, 0.36, 0.15) * (0.9 + 0.15 * n);
      cnRough = 0.9;
    } else if (kind == 3) {     // plaza pavers
      vec2 g = abs(fract(p / 0.9) - 0.5);
      float joint = step(0.46, max(g.x, g.y));
      c = vec3(0.47, 0.44, 0.41) * (0.88 + 0.2 * n) * (1.0 - 0.25 * joint);
      cnRough = 0.8;
    } else if (kind == 5) {     // curb stone
      c = vec3(0.6, 0.59, 0.57) * (0.9 + 0.12 * n);
      cnRough = 0.85;
    } else if (kind == 6) {     // white road paint, a little worn
      c = vec3(0.78, 0.78, 0.76) * (0.82 + 0.18 * cnNoise(p * 1.7));
      cnRough = 0.6;
    } else if (kind == 7) {     // yellow road paint
      c = vec3(0.78, 0.58, 0.1) * (0.82 + 0.18 * cnNoise(p * 1.7));
      cnRough = 0.6;
    } else {                    // sidewalk / lots: concrete slabs
      vec2 g = abs(fract(p / 1.6) - 0.5);
      float joint = step(0.48, max(g.x, g.y));
      c = vec3(0.5, 0.49, 0.47) * (0.86 + 0.22 * n) * (1.0 - 0.2 * joint) * (0.92 + 0.12 * big);
      cnRough = 0.88;
    }
    diffuseColor.rgb = c;
  `,
  );
  m.polygonOffset = true;
  m.polygonOffsetFactor = 1;
  m.polygonOffsetUnits = 1;
  return m;
}

const BUILDING_FRAG = /* glsl */ `
  int kind = int(vData.x + 0.5);
  float variant = vData.y;
  float floors = vData.z;
  float r1 = fract(variant * 0.61803 + 0.137);
  float r2 = fract(variant * 0.41421 + 0.71);
  vec3 c;
  if (kind == 1) {                    // roof: tar / gravel, a few lighter membranes
    float n = cnNoise(vFac * 0.6);
    c = mix(vec3(0.2, 0.2, 0.21), vec3(0.42, 0.41, 0.39), step(0.72, r1)) * (0.85 + 0.25 * n);
    cnRough = 0.95;
  } else if (kind == 2) {             // shore wall
    c = vec3(0.46, 0.45, 0.43) * (0.85 + 0.2 * cnNoise(vFac * vec2(0.3, 2.0)));
    cnRough = 0.9;
  } else {
    // facade family: tall buildings are mostly glass or limestone, low ones brick and brownstone
    bool tall = floors > 18.0;
    bool glass = tall ? r1 < 0.55 : r1 < 0.08;
    vec3 wall;
    if (glass) wall = mix(vec3(0.34, 0.4, 0.45), vec3(0.55, 0.57, 0.58), r2);
    else if (tall || r1 < 0.3) wall = mix(vec3(0.62, 0.58, 0.5), vec3(0.74, 0.7, 0.62), r2);      // limestone / concrete
    else if (r1 < 0.62) wall = mix(vec3(0.45, 0.21, 0.15), vec3(0.58, 0.33, 0.24), r2);          // red brick
    else if (r1 < 0.82) wall = mix(vec3(0.33, 0.22, 0.17), vec3(0.45, 0.32, 0.25), r2);          // brownstone
    else wall = mix(vec3(0.6, 0.52, 0.42), vec3(0.72, 0.64, 0.52), r2);                            // tan brick

    float fh = glass ? 3.9 : 3.4;                         // floor height
    float sp = glass ? 1.5 : mix(1.9, 3.0, r2);            // window spacing
    float u = vFac.x, v = vFac.y;
    vec2 cell = vec2(u / sp, (v - 0.4) / fh);
    vec2 f = fract(cell);
    float frameX = glass ? 0.05 : 0.22, frameY0 = glass ? 0.06 : 0.28, frameY1 = glass ? 0.94 : 0.86;
    float win = step(frameX, f.x) * step(f.x, 1.0 - frameX) * step(frameY0, f.y) * step(f.y, frameY1);
    // far away the window grid is smaller than a pixel: fade it to its average so it doesn't shimmer
    vec2 fw = fwidth(cell);
    float blur = clamp(max(fw.x, fw.y) * 2.0 - 0.35, 0.0, 1.0);
    win = mix(win, (1.0 - 2.0 * frameX) * (frameY1 - frameY0), blur);
    float ground = step(v, 4.4);
    float topH = (floors + vData.w / 254.0) * 3.5;
    float cornice = step(topH - 1.1, v) * step(3.0, topH) * (glass ? 0.0 : 1.0);
    // shop fronts on the ground floor of non-glass buildings
    if (!glass && ground > 0.5) {
      float g = fract(u / 5.0);
      win = step(0.08, g) * step(g, 0.92) * step(0.5, v) * step(v, 3.6);
      wall *= 0.7;
    }
    // top band (parapet) is solid
    float wn = cnHash(floor(cell) + variant);
    vec3 glassC = mix(vec3(0.05, 0.07, 0.09), vec3(0.16, 0.2, 0.25), wn);
    float dirt = cnNoise(vec2(u * 0.15, v * 0.05)) * 0.2;
    win *= 1.0 - cornice;
    vec3 wallC = wall * (0.9 + 0.1 * cnNoise(vec2(u, v) * 0.4) - dirt * 0.5);
    // cornice: a lighter stone band with a dark shadow line under it
    wallC = mix(wallC, wall * 1.18 + 0.04, cornice);
    wallC *= 1.0 - 0.45 * step(topH - 1.3, v) * (1.0 - step(topH - 1.1, v)) * step(3.0, topH) * (glass ? 0.0 : 1.0);
    c = mix(wallC, glassC, win);
    cnRough = mix(0.85, 0.12, win);
    cnMetal = 0.0;
  }
  diffuseColor.rgb = c;
`;

export function makeBuildingMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, side: THREE.FrontSide });
  patch(m, BUILDING_FRAG);
  return m;
}

/** Whole-island skyline. Vertices of tiles that are loaded in full (mask = 255) collapse away. */
export function makeFarMaterial(mask: THREE.DataTexture, nx: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  patch(
    m,
    BUILDING_FRAG,
    /* glsl */ `
    int tid = int(tileId + 0.5);
    float hidden = texelFetch(uTileMask, ivec2(tid % ${nx}, tid / ${nx}), 0).r;
    if (hidden > 0.5) transformed = vec3(0.0, -1000.0, 0.0);
  `,
    'attribute float tileId;\nuniform sampler2D uTileMask;',
    { uTileMask: { value: mask } },
  );
  return m;
}

export function makeWaterMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x1d2a33, roughness: 0.12, metalness: 0.1 });
}

export function geometryFrom(d: MeshData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.position, 3));
  // Int8 normals are stored as xyz0; the shader's vec3 normal reads the first three components
  g.setAttribute('normal', new THREE.BufferAttribute(d.normal, 4, true));
  g.setAttribute('uv', new THREE.BufferAttribute(d.uv, 2));
  g.setAttribute('cdata', new THREE.BufferAttribute(d.color, 4, false));
  if (d.tile) g.setAttribute('tileId', new THREE.BufferAttribute(d.tile, 1, false));
  g.setIndex(new THREE.BufferAttribute(d.index, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}
