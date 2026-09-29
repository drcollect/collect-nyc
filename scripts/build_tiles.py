"""Build the Manhattan city tiles for the game.

Reads data/raw (NYC building footprints, NYC shoreline, OpenStreetMap streets/parks/water) and writes
game/public/city/:
  manifest.json      grid, projection, tile list
  tiles/t_<ix>_<iz>.bin   near tiles (250 m): flat mesh (ground/parks/roads) + solid mesh (buildings, shore wall)
  far.bin            whole-island skyline (simplified tall buildings), one mesh, tile index per vertex
  island.bin         whole-island ground (land + big parks), one flat mesh
  roads.json         simplified street polylines (minimap, routes, spawn points)

World frame (what the game sees): metres, +Y up, origin at Times Square, rotated 29 deg so the avenues
run along Z; uptown is -Z, the Hudson side is -X. Everything is flat (y = 0) in this first version.

Run:  uv run --python 3.12 --with shapely,numpy,mapbox_earcut scripts/build_tiles.py
"""
import gzip, json, math, os, struct, sys, time
from multiprocessing import get_context

import numpy as np
import mapbox_earcut as earcut
import shapely
from shapely.geometry import LineString, MultiPolygon, Polygon, box, shape, mapping
from shapely.ops import polygonize, unary_union
from shapely.strtree import STRtree
import shapely.prepared
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from details import Details  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'data', 'raw')
OUT = os.path.join(ROOT, 'game', 'public', 'city')

LAT0, LON0 = 40.758, -73.9855  # Times Square
ROT_DEG = 29.0
TILE = 250.0
FT = 0.3048

Y_LAND, Y_PARK, Y_ROAD = 0.0, 0.03, 0.06
SHORE_WALL_H = 1.1
FAR_MIN_H = 28.0

# flat kinds -> vertex colour (sRGB bytes; the shader treats them as material ids + tint)
KIND = {'land': 0, 'park': 1, 'road': 2, 'plaza': 3, 'pitch': 4, 'curb': 5, 'paint': 6, 'paint_yellow': 7}
# solid kinds
S_WALL, S_ROOF, S_SHORE = 0, 1, 2

# ---------------------------------------------------------------- projection
_mx = 111320.0 * math.cos(math.radians(LAT0))
_my = 111132.954 - 559.822 * math.cos(2 * math.radians(LAT0)) + 1.175 * math.cos(4 * math.radians(LAT0))
_c, _s = math.cos(math.radians(ROT_DEG)), math.sin(math.radians(ROT_DEG))


def project(coords):
    """lon/lat array (N,2) -> plan metres (N,2): X right (towards the East River), Y uptown."""
    a = np.asarray(coords, dtype=np.float64)
    x = (a[:, 0] - LON0) * _mx
    y = (a[:, 1] - LAT0) * _my
    return np.column_stack((x * _c - y * _s, x * _s + y * _c))


def proj_geom(g):
    return shapely.transform(g, lambda a: project(a))


# ---------------------------------------------------------------- load
def load_land():
    d = json.load(open(os.path.join(RAW, 'manhattan_shore.geojson')))
    g = proj_geom(shape(d['features'][0]['geometry']))
    return shapely.make_valid(g)


def osm_polys(el):
    """closed way or multipolygon relation -> shapely geometry (plan metres) or None"""
    if el['type'] == 'way':
        pts = el.get('geometry') or []
        if len(pts) < 4 or (pts[0]['lat'], pts[0]['lon']) != (pts[-1]['lat'], pts[-1]['lon']):
            return None
        p = Polygon(project([(q['lon'], q['lat']) for q in pts]))
        return shapely.make_valid(p) if not p.is_valid else p
    outer, inner = [], []
    for m in el.get('members', []):
        if m.get('type') != 'way' or not m.get('geometry'):
            continue
        ls = LineString(project([(q['lon'], q['lat']) for q in m['geometry']]))
        (inner if m.get('role') == 'inner' else outer).append(ls)
    if not outer:
        return None
    o = unary_union(list(polygonize(unary_union(outer))))
    if inner:
        o = o.difference(unary_union(list(polygonize(unary_union(inner)))))
    return o if not o.is_empty else None


ROAD_W = {
    'motorway': 7.5, 'trunk': 10, 'primary': 14, 'secondary': 12, 'tertiary': 10, 'residential': 9,
    'unclassified': 8, 'living_street': 6, 'service': 4.5, 'pedestrian': 5,
}
SKIP_SERVICE = {'parking_aisle', 'drive-through', 'driveway', 'emergency_access'}


def road_width(t):
    hw = t['highway']
    base = hw.replace('_link', '')
    try:
        lanes = float(str(t.get('lanes', '')).split(';')[0])
    except ValueError:
        lanes = 0
    if lanes > 0 and base != 'pedestrian':
        return min(lanes * 3.2 + 1.0, 26.0)
    if hw.endswith('_link'):
        return 6.5
    return ROAD_W.get(base, 8)


TREE_AREAS = {'wood': [], 'park': []}


def load_osm():
    d = json.load(open(os.path.join(RAW, 'osm_manhattan.json')))
    roads, road_lines, green, pitch, water, plaza = [], [], [], [], [], []
    for el in d['elements']:
        t = el.get('tags', {})
        if 'highway' in t and el['type'] == 'way':
            if t.get('tunnel') in ('yes', 'building_passage') or t.get('covered') == 'yes' or t.get('indoor') == 'yes':
                continue
            try:
                if float(t.get('layer', 0)) < 0:
                    continue
            except ValueError:
                pass
            if t['highway'] == 'service' and t.get('service') in SKIP_SERVICE:
                continue
            if t.get('area') == 'yes':
                p = osm_polys(el)
                if p is not None:
                    plaza.append(p)
                continue
            pts = project([(q['lon'], q['lat']) for q in el['geometry']])
            if len(pts) < 2:
                continue
            line = LineString(pts)
            w = road_width(t)
            geom = line.buffer(w / 2, quad_segs=3)
            (plaza if t['highway'] == 'pedestrian' else roads).append(geom)
            if t['highway'] not in ('pedestrian', 'service'):
                road_lines.append({
                    'c': t['highway'].replace('_link', ''), 'n': t.get('name', ''), 'w': round(w, 1),
                    'o': 1 if t.get('oneway') == 'yes' else 0, 'b': 1 if t.get('bridge') == 'yes' else 0,
                    'line': line,
                })
            continue
        tag = t.get('leisure') or t.get('landuse') or t.get('natural')
        if tag in ('park', 'garden', 'grass', 'recreation_ground', 'cemetery', 'wood', 'nature_reserve'):
            p = osm_polys(el)
            if p is not None:
                green.append(p)
                if tag == 'wood':
                    TREE_AREAS['wood'].append(p)
                elif tag == 'park':
                    TREE_AREAS['park'].append(p)
        elif tag == 'pitch':
            p = osm_polys(el)
            if p is not None:
                pitch.append(p)
        elif tag == 'water':
            p = osm_polys(el)
            if p is not None:
                water.append(p)
    return roads, road_lines, green, pitch, water, plaza


SKIP_FEATURE = {'2110', '1006'}  # skybridges and cantilevered parts would block the streets


def load_buildings():
    d = json.load(open(os.path.join(RAW, 'buildings_manhattan.geojson')))
    out = []
    for f in d['features']:
        p = f['properties']
        if p.get('feature_code') in SKIP_FEATURE or not f.get('geometry'):
            continue
        g = proj_geom(shape(f['geometry']))
        if not g.is_valid:
            g = shapely.make_valid(g)
        g = g.simplify(0.15)
        if g.is_empty or g.area < 4:
            continue
        try:
            h = float(p.get('height_roof') or 0) * FT
        except ValueError:
            h = 0
        if h < 3:
            h = 12.0 if h <= 0 else 3.0
        out.append((g, h, int(p.get('bin') or 0) & 0xFFFFFFFF))
    return out



LOW_BUILDING = 15.0  # m


def clear_highways(bld):
    """The FDR and the West Side Highway run under decks at street level and over sheds on viaducts. In the flat
    game those footprints would wall the road off, so cut the highways out of the footprints they cross."""
    d = json.load(open(os.path.join(RAW, 'osm_manhattan.json')))
    cuts, raised = [], []
    for el in d['elements']:
        t = el.get('tags', {})
        if el['type'] != 'way' or t.get('highway', '').replace('_link', '') not in ('motorway', 'trunk'):
            continue
        if t.get('tunnel') == 'yes' or t.get('covered') == 'yes':
            continue
        try:
            layer = float(t.get('layer', 0))
        except ValueError:
            layer = 0
        if layer < 0:
            continue
        line = LineString(project([(q['lon'], q['lat']) for q in el['geometry']]))
        cuts.append(line.buffer(road_width(t) / 2 + 1.0, cap_style='flat'))
        raised.append(bool(t.get('bridge')) or layer > 0)
    tree = STRtree(cuts)
    out, changed = [], 0
    for g, h, b in bld:
        # the game is flat, so a raised highway (a viaduct over sheds and depots) cuts through the low
        # buildings under it; a ground-level one cuts through anything
        hits = [cuts[i] for i in tree.query(g) if (not raised[i] or h < LOW_BUILDING) and cuts[i].intersects(g)]
        if hits:
            cut = g.difference(unary_union(hits))
            if abs(cut.area - g.area) > 5:
                changed += 1
                g = shapely.make_valid(cut)
                g = unary_union([p for p in polys_of(g) if p.area > 20]) if polys_of(g) else g
                if g.is_empty:
                    continue
        out.append((g, h, b))
    print(f'highways cut out of {changed} building footprints', flush=True)
    return out


# ---------------------------------------------------------------- mesh building
class Mesh:
    def __init__(self):
        self.pos, self.uv, self.nrm, self.col, self.idx = [], [], [], [], []
        self.n = 0

    def add(self, pos, uv, nrm, col, tris):
        """pos (k,3) world, uv (k,2), nrm (k,3), col (k,4) bytes, tris (m,3) local indices"""
        self.pos.append(np.asarray(pos, np.float32))
        self.uv.append(np.asarray(uv, np.float32))
        self.nrm.append(np.asarray(nrm, np.float32))
        self.col.append(np.asarray(col, np.uint8))
        self.idx.append(np.asarray(tris, np.uint32) + self.n)
        self.n += len(pos)

    def arrays(self):
        if not self.n:
            return None
        return (np.concatenate(self.pos), np.concatenate(self.uv), np.concatenate(self.nrm),
                np.concatenate(self.col), np.concatenate(self.idx).reshape(-1))


def polys_of(g):
    if g is None or g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    if isinstance(g, MultiPolygon):
        return list(g.geoms)
    if hasattr(g, 'geoms'):
        return [p for sub in g.geoms for p in polys_of(sub)]
    return []


def triangulate(poly):
    """plan polygon -> (verts (n,2), tris (m,3)) wound CCW seen from above (+Y world up)."""
    poly = shapely.geometry.polygon.orient(poly, 1.0)
    rings = [np.asarray(poly.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in poly.interiors]
    rings = [r for r in rings if len(r) >= 3]
    if not rings:
        return None, None
    verts = np.concatenate(rings)
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    tris = np.asarray(earcut.triangulate_float64(verts, ends), np.uint32).reshape(-1, 3)
    if not len(tris):
        return None, None
    return verts, tris


def to_world(v2, y):
    """plan (n,2) -> world (n,3): x = X, z = -Y"""
    return np.column_stack((v2[:, 0], np.full(len(v2), y), -v2[:, 1]))


def fix_winding(pos, tris, want_normal):
    a, b, c = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
    n = np.cross(b - a, c - a)
    flip = (n @ np.asarray(want_normal)) < 0
    tris = tris.copy()
    tris[flip] = tris[flip][:, [0, 2, 1]]
    return tris


def add_flat(mesh, poly, y, kind, tint=0):
    verts, tris = triangulate(poly)
    if verts is None:
        return
    pos = to_world(verts, y)
    tris = fix_winding(pos, tris, (0, 1, 0))
    k = len(pos)
    mesh.add(pos, verts, np.tile([0, 1, 0], (k, 1)), np.tile([kind, tint, 0, 255], (k, 1)), tris)


def add_quads(mesh, quads, y, kind):
    """flat quads (n,4,2) in plan coords, facing up"""
    n = len(quads)
    if not n:
        return
    pos = to_world(quads.reshape(-1, 2), y)
    base = np.arange(n, dtype=np.uint32) * 4
    tris = np.concatenate([np.column_stack((base, base + 1, base + 2)), np.column_stack((base, base + 2, base + 3))])
    tris = fix_winding(pos, tris, (0, 1, 0))
    mesh.add(pos, quads.reshape(-1, 2), np.tile([0, 1, 0], (n * 4, 1)), np.tile([kind, 0, 0, 255], (n * 4, 1)), tris)


def add_walls(mesh, ring_coords, h, kind, variant, outward_sign, y0=0.0):
    """vertical quads along a ring. outward_sign +1 for a CCW exterior, -1 for holes (also CCW-oriented here)."""
    c = np.asarray(ring_coords)
    if len(c) < 2:
        return
    p0, p1 = c[:-1], c[1:]
    d = p1 - p0
    L = np.hypot(d[:, 0], d[:, 1])
    keep = L > 0.05
    p0, p1, d, L = p0[keep], p1[keep], d[keep], L[keep]
    if not len(p0):
        return
    m = len(p0)
    nx, ny = d[:, 1] / L * outward_sign, -d[:, 0] / L * outward_sign
    u0 = np.concatenate(([0], np.cumsum(L)[:-1]))
    pos = np.empty((m * 4, 3))
    pos[0::4] = to_world(p0, y0)
    pos[1::4] = to_world(p1, y0)
    pos[2::4] = to_world(p1, y0 + h)
    pos[3::4] = to_world(p0, y0 + h)
    uv = np.empty((m * 4, 2))
    uv[0::4, 0], uv[1::4, 0], uv[2::4, 0], uv[3::4, 0] = u0, u0 + L, u0 + L, u0
    uv[0::4, 1], uv[1::4, 1], uv[2::4, 1], uv[3::4, 1] = 0, 0, h, h
    nrm = np.repeat(np.column_stack((nx, np.zeros(m), -ny)), 4, axis=0)
    base = np.arange(m, dtype=np.uint32) * 4
    tris = np.concatenate([np.column_stack((base, base + 1, base + 2)), np.column_stack((base, base + 2, base + 3))])
    # fix winding per quad against its normal
    a, b, cc = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
    fn = np.cross(b - a, cc - a)
    want = np.concatenate([nrm[base], nrm[base]])
    flip = np.einsum('ij,ij->i', fn, want) < 0
    tris[flip] = tris[flip][:, [0, 2, 1]]
    floors = min(int(h / 3.5), 255)
    frac = int(round(min(1.0, max(0.0, h / 3.5 - floors)) * 254))  # the shader rebuilds the exact height from these
    col = np.tile([kind, variant & 255, floors, frac], (m * 4, 1))
    mesh.add(pos, uv, nrm, col, tris)


def add_building(mesh, geom, h, variant):
    for poly in polys_of(geom):
        poly = shapely.geometry.polygon.orient(poly, 1.0)
        add_walls(mesh, poly.exterior.coords, h, S_WALL, variant, +1)
        for r in poly.interiors:
            add_walls(mesh, r.coords, h, S_WALL, variant, +1)  # oriented CW, so +1 still points into the courtyard
        verts, tris = triangulate(poly)
        if verts is None:
            continue
        pos = to_world(verts, h)
        tris = fix_winding(pos, tris, (0, 1, 0))
        k = len(pos)
        mesh.add(pos, verts, np.tile([0, 1, 0], (k, 1)), np.tile([S_ROOF, variant & 255, min(int(h / 3.5), 255), 255], (k, 1)), tris)


# ---------------------------------------------------------------- file format
# "CNYT" | u32 version | u32 json_len | json (padded to 4) | binary blocks (each 4-aligned)
# json: {"meshes": [{"name", "count", "index": [off,len], "position": [off,len], "uv", "normal", "color"}], ...}
def write_bin(path, meshes, extra=None, tile=None):
    blobs, header, off = [], {'meshes': []}, 0

    def put(arr):
        nonlocal off
        b = arr.tobytes()
        pad = (-len(b)) % 4
        blobs.append(b + b'\0' * pad)
        r = [off, len(b)]
        off += len(b) + pad
        return r

    for name, m in meshes:
        a = m.arrays() if isinstance(m, Mesh) else m
        if a is None:
            continue
        pos, uv, nrm, col, idx = a
        nrm8 = np.clip(np.round(nrm * 127), -127, 127).astype(np.int8)
        nrm8 = np.column_stack((nrm8, np.zeros(len(nrm8), np.int8)))
        header['meshes'].append({
            'name': name, 'count': int(len(pos)), 'triangles': int(len(idx) // 3),
            'position': put(pos.astype(np.float32)), 'uv': put(uv.astype(np.float32)),
            'normal': put(nrm8), 'color': put(col.astype(np.uint8)), 'index': put(idx.astype(np.uint32)),
        })
        if tile is not None:
            header['meshes'][-1]['tile'] = put(tile.astype(np.uint16))
    if extra:
        header.update(extra)
    js = json.dumps(header, separators=(',', ':')).encode()
    js += b' ' * ((-len(js)) % 4)
    raw = b'CNYT' + struct.pack('<II', 1, len(js)) + js + b''.join(blobs)
    with open(path, 'wb') as f:
        f.write(gzip.compress(raw, 6, mtime=0))
    return os.path.getsize(path)


# ---------------------------------------------------------------- per tile work (runs in workers)
G = {}


def build_tile(key):
    ix, iz = key
    gx0 = G['x0'] + ix * TILE
    gy1 = G['y1'] - iz * TILE  # plan Y of the tile's uptown edge (world z = -Y)
    cell = box(gx0, gy1 - TILE, gx0 + TILE, gy1)
    land = G['land'].intersection(cell)
    flat, solid = Mesh(), Mesh()

    def query(tree, geoms, g):
        return [geoms[i] for i in tree.query(g)]

    if not land.is_empty:
        green = unary_union(query(G['green_t'], G['green'], cell)).intersection(land) if True else None
        pitch = unary_union(query(G['pitch_t'], G['pitch'], cell)).intersection(land)
        plaza = unary_union(query(G['plaza_t'], G['plaza'], cell)).intersection(land)
        roads = unary_union(query(G['road_t'], G['roads'], cell)).intersection(land)
        for p in polys_of(land):
            add_flat(flat, p, Y_LAND, KIND['land'])
        for p in polys_of(green.difference(roads) if not roads.is_empty else green):
            add_flat(flat, p, Y_PARK, KIND['park'])
        for p in polys_of(pitch.difference(roads) if not roads.is_empty else pitch):
            add_flat(flat, p, Y_PARK + 0.005, KIND['pitch'])
        for p in polys_of(plaza.difference(roads) if not roads.is_empty else plaza):
            add_flat(flat, p, Y_PARK + 0.01, KIND['plaza'])
        for p in polys_of(roads):
            add_flat(flat, p, Y_ROAD, KIND['road'])
        # curb: a light strip along every road edge, on the sidewalk side
        if not roads.is_empty:
            curb = roads.buffer(0.35, quad_segs=2).difference(roads).intersection(land)
            for p in polys_of(curb):
                add_flat(flat, p, Y_ROAD + 0.004, KIND['curb'])
        # shore / lake wall: land boundary inside this cell
        edge = G['land'].boundary.intersection(cell)
        for ln in getattr(edge, 'geoms', [edge]):
            if isinstance(ln, LineString) and ln.length > 0.1:
                add_walls(solid, ln.coords, SHORE_WALL_H, S_SHORE, 0, +1, y0=-1.2)
    for i in G['bld_cell'].get(key, []):
        g, h, b = G['bld'][i]
        add_building(solid, g, h, (b * 2654435761) >> 24)
    marks, props = Mesh(), {}
    if not land.is_empty:
        strips, props = G['details'].for_tile(cell, None)
        for quads, kind in strips:
            add_quads(marks, quads, Y_ROAD + 0.012, kind)
    if not flat.n and not solid.n:
        return key, 0, 0
    path = os.path.join(OUT, 'tiles', f't_{ix}_{iz}.bin')
    size = write_bin(path, [('flat', flat), ('solid', solid), ('marks', marks)], extra={'props': props} if props else None)
    return key, size, int(sum(len(x) for x in solid.idx) // 3 + sum(len(x) for x in flat.idx) // 3)



# ---------------------------------------------------------------- street graph (routes, race AI)
PARK_DRIVES = {'East Drive', 'West Drive', 'Center Drive', 'Terrace Drive'}
GRAPH_CLASSES = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street'}


def build_graph(land):
    """Drivable street network split at shared OSM nodes: nodes = intersections and dead ends, edges = polylines."""
    d = json.load(open(os.path.join(RAW, 'osm_manhattan.json')))
    ways = []
    for el in d['elements']:
        t = el.get('tags', {})
        # Central Park's loop drives are car-free in real life (tagged pedestrian); the game races on them
        park_drive = t.get('name') in PARK_DRIVES and t.get('highway') in ('pedestrian', 'service', 'unclassified')
        if el['type'] != 'way' or (t.get('highway', '').replace('_link', '') not in GRAPH_CLASSES and not park_drive):
            continue
        # same rules as the drawn streets: no tunnels, nothing covered by a building (parts of the FDR run under
        # the East Side hospitals), nothing below ground
        if t.get('tunnel') in ('yes', 'building_passage') or t.get('covered') == 'yes' or t.get('indoor') == 'yes' or t.get('area') == 'yes':
            continue
        try:
            if float(t.get('layer', 0)) < 0:
                continue
        except ValueError:
            pass
        ways.append(el)
    use = {}
    for w in ways:
        for i, n in enumerate(w['nodes']):
            use[n] = use.get(n, 0) + (2 if i in (0, len(w['nodes']) - 1) else 1)
    land_near = shapely.prepared.prep(land.buffer(8))
    node_id, nodes, edges = {}, [], []

    def nid(osm, xy):
        if osm not in node_id:
            node_id[osm] = len(nodes)
            nodes.append([round(float(xy[0]), 1), round(float(-xy[1]), 1)])
        return node_id[osm]

    for w in ways:
        t = w['tags']
        xy = project([(q['lon'], q['lat']) for q in w['geometry']])
        inside = [land_near.contains(shapely.geometry.Point(p)) for p in xy]
        cls = 'parkdrive' if t.get('name') in PARK_DRIVES else t['highway'].replace('_link', '')
        one = 1 if t.get('oneway') in ('yes', '1') or t['highway'].startswith('motorway') else (-1 if t.get('oneway') == '-1' else 0)
        start = 0
        for i in range(1, len(xy)):
            split = use.get(w['nodes'][i], 0) >= 2 or i == len(xy) - 1
            if not split:
                continue
            seg = xy[start:i + 1]
            if all(inside[start:i + 1]) and len(seg) >= 2:
                L = float(np.sum(np.hypot(*np.diff(seg, axis=0).T)))
                if L > 0.5:
                    a, b = nid(w['nodes'][start], seg[0]), nid(w['nodes'][i], seg[-1])
                    if a != b:
                        edges.append({'a': a, 'b': b, 'l': round(L, 1), 'c': cls, 'n': t.get('name', ''), 'o': one,
                                      'w': round(road_width(t), 1),
                                      'p': [v for q in seg for v in (round(float(q[0]), 1), round(float(-q[1]), 1))]})
            start = i
    json.dump({'nodes': nodes, 'edges': edges}, open(os.path.join(OUT, 'graph.json'), 'w'), separators=(',', ':'))
    return len(nodes), len(edges)


# ---------------------------------------------------------------- main
def main():
    t0 = time.time()
    os.makedirs(os.path.join(OUT, 'tiles'), exist_ok=True)
    for f in os.listdir(os.path.join(OUT, 'tiles')):
        os.remove(os.path.join(OUT, 'tiles', f))

    land = load_land()
    water_osm = []
    roads, road_lines, green, pitch, water, plaza = load_osm()
    inland_water = unary_union([w for w in water if w.area > 400]).intersection(land)
    land = land.difference(inland_water)
    land = unary_union([p for p in polys_of(land) if p.area > 2000])  # drop specks and piers stubs
    bld = clear_highways(load_buildings())
    print(f'loaded in {time.time()-t0:.0f}s: {len(bld)} buildings, {len(roads)} road pieces, {len(green)} green, '
          f'{len(water)} water, land {land.area/1e6:.1f} km2', flush=True)

    minx, miny, maxx, maxy = land.bounds
    x0 = math.floor(minx / TILE) * TILE
    y1 = math.ceil(maxy / TILE) * TILE
    nx = int(math.ceil((maxx - x0) / TILE))
    nz = int(math.ceil((y1 - miny) / TILE))

    bld_cell = {}
    for i, (g, h, b) in enumerate(bld):
        c = g.representative_point()
        key = (int((c.x - x0) // TILE), int((y1 - c.y) // TILE))
        bld_cell.setdefault(key, []).append(i)

    det = Details()
    stats = det.prepare(os.path.join(RAW, 'osm_manhattan.json'), os.path.join(RAW, 'trees_manhattan.json'),
                        os.path.join(RAW, 'signals_manhattan.json'), project, road_width, land, bld,
                        TREE_AREAS['park'], TREE_AREAS['wood'], plaza, pitch)
    print(f'details in {time.time()-t0:.0f}s: {stats}', flush=True)
    G['details'] = det
    G.update(land=land, x0=x0, y1=y1, bld=bld, bld_cell=bld_cell,
             roads=roads, road_t=STRtree(roads), green=green, green_t=STRtree(green),
             pitch=pitch, pitch_t=STRtree(pitch), plaza=plaza, plaza_t=STRtree(plaza))
    land_prep = shapely.prepared.prep(land)
    keys = [(ix, iz) for iz in range(nz) for ix in range(nx)
            if (ix, iz) in bld_cell or land_prep.intersects(box(x0 + ix * TILE, y1 - (iz + 1) * TILE, x0 + (ix + 1) * TILE, y1 - iz * TILE))]
    print(f'grid {nx} x {nz}, {len(keys)} tiles to build', flush=True)

    tiles, total, tris = [], 0, 0
    with get_context('fork').Pool(max(1, os.cpu_count() - 1)) as pool:
        for n, (key, size, t) in enumerate(pool.imap_unordered(build_tile, keys, chunksize=4)):
            if size:
                tiles.append([key[0], key[1], size])
                total += size
                tris += t
            if n % 200 == 0:
                print(f'  {n}/{len(keys)} tiles, {total/1e6:.0f} MB', flush=True)
    tiles.sort(key=lambda t: (t[1], t[0]))

    # far skyline: tall buildings, simplified, with a per-vertex tile index (u16 'tile' block) so the game can hide the tiles it has loaded in full
    far = Mesh()
    far_tile = []
    for key, idxs in bld_cell.items():
        tid = key[1] * nx + key[0]
        for i in idxs:
            g, h, b = bld[i]
            if h < FAR_MIN_H:
                continue
            gs = g.simplify(4.0)
            if gs.is_empty:
                continue
            m = Mesh()
            add_building(m, gs, h, (b * 2654435761) >> 24)
            a = m.arrays()
            if a is None:
                continue
            pos, uv, nrm, col, idx = a
            far.add(pos, uv, nrm, col, idx.reshape(-1, 3))
            far_tile.append(np.full(len(pos), tid, np.uint16))
    far_size = write_bin(os.path.join(OUT, 'far.bin'), [('far', far)], tile=np.concatenate(far_tile))

    # island ground: land plus big parks, simplified
    isl = Mesh()
    ls = land.simplify(3)
    for p in polys_of(ls):
        add_flat(isl, p, -0.08, KIND['land'])
    big_green = unary_union([g for g in green if g.area > 3000]).intersection(ls).simplify(3)
    for p in polys_of(big_green):
        add_flat(isl, p, -0.05, KIND['park'])
    isl_size = write_bin(os.path.join(OUT, 'island.bin'), [('island', isl)])

    # roads for minimap / routes
    rl = []
    for r in road_lines:
        line = r['line'].intersection(land)
        for part in getattr(line, 'geoms', [line]):
            if not isinstance(part, LineString) or part.length < 5:
                continue
            c = np.asarray(part.simplify(1.0).coords)
            rl.append({'c': r['c'], 'n': r['n'], 'w': r['w'], 'o': r['o'], 'b': r['b'],
                       'p': [v for xy in c for v in (round(float(xy[0]), 1), round(float(-xy[1]), 1))]})
    json.dump({'roads': rl}, open(os.path.join(OUT, 'roads.json'), 'w'), separators=(',', ':'))

    # land outline for the minimap
    outline = [[v for xy in np.asarray(p.exterior.coords) for v in (round(float(xy[0]), 1), round(float(-xy[1]), 1))]
               for p in polys_of(land.simplify(4)) if p.area > 20000]

    manifest = {
        'version': 1, 'built': time.strftime('%Y-%m-%d %H:%M'),
        'origin': {'lat': LAT0, 'lon': LON0, 'rotationDeg': ROT_DEG, 'note': 'x = east-ish, z = downtown; uptown is -z'},
        'tileSize': TILE, 'grid': {'x0': x0, 'z0': -y1, 'nx': nx, 'nz': nz},
        'kinds': {'flat': KIND, 'solid': {'wall': S_WALL, 'roof': S_ROOF, 'shore': S_SHORE}},
        'tiles': tiles, 'far': far_size, 'island': isl_size, 'outline': outline,
        'sources': ['Building Footprints, NYC Open Data (DoITT), dataset 5zhs-2jue',
                    'Borough Boundaries, NYC Open Data (DCP), dataset gthc-hcne',
                    'Streets, parks and water (c) OpenStreetMap contributors, ODbL'],
    }
    json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), separators=(',', ':'))
    gn, ge = build_graph(land)
    print(f'street graph: {gn} nodes, {ge} edges')
    print(f'done in {time.time()-t0:.0f}s: {len(tiles)} tiles {total/1e6:.1f} MB, {tris/1e6:.2f} M tris; '
          f'far {far_size/1e6:.1f} MB ({far.n} verts), island {isl_size/1e6:.1f} MB, roads {len(rl)} lines')


if __name__ == '__main__':
    main()
