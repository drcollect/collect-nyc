"""Street and rooftop detail for the city tiles: lane markings, crosswalks, curbs, street lamps, traffic signals,
street and park trees, water towers and rooftop plant.

Everything is prepared once for the whole island (prepare()), then each tile takes its share (for_tile()).
Markings come back as flat strips for the tile's 'marks' mesh; props come back as compact number lists for the
tile header, which the game turns into instanced meshes.
"""
import json
import math
import os

import numpy as np
import shapely
from shapely.geometry import LineString, Point, box
from shapely.ops import unary_union
from shapely.strtree import STRtree

# marking kinds (flat-mesh colour ids, after the ground kinds 0..4 and the curb 5)
M_WHITE, M_YELLOW = 6, 7

MARKED = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified'}
LAMPED = {'primary', 'secondary', 'tertiary', 'residential', 'unclassified'}
LINE_W = 0.12
DASH, GAP = 3.0, 9.0
LAMP_SPACING = 38.0


def _hash(*v):
    h = 2166136261
    for x in v:
        h = ((h ^ (int(x) & 0xFFFFFFFF)) * 16777619) & 0xFFFFFFFF
    return h


def _offset(coords, d):
    """polyline offset by d metres to the left (plan coords, Y up)"""
    c = np.asarray(coords, float)
    if len(c) < 2:
        return c
    t = np.gradient(c, axis=0)
    n = np.column_stack((-t[:, 1], t[:, 0]))
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
    return c + n * d


def _lanes(t, w):
    try:
        n = int(float(str(t.get('lanes', '')).split(';')[0]))
    except ValueError:
        n = 0
    return n if n > 0 else max(1, round((w - 1.0) / 3.3))


class Details:
    def prepare(self, osm_path, trees_path, signals_path, project, road_width, land, buildings, green_parks, wood, plaza, pitch):
        d = json.load(open(osm_path))
        ways = []
        for el in d['elements']:
            t = el.get('tags', {})
            if el['type'] != 'way' or 'highway' not in t or t.get('area') == 'yes':
                continue
            if t.get('tunnel') in ('yes', 'building_passage') or t.get('covered') == 'yes':
                continue
            try:
                if float(t.get('layer', 0)) < 0:
                    continue
            except ValueError:
                pass
            base = t['highway'].replace('_link', '')
            if base not in MARKED:
                continue
            xy = project([(q['lon'], q['lat']) for q in el['geometry']])
            if len(xy) < 2:
                continue
            ways.append((el, t, base, xy, road_width(t)))

        # intersections: OSM nodes shared by two or more drivable ways, with the widest road meeting there
        use, widest, pos = {}, {}, {}
        for el, t, base, xy, w in ways:
            for i, n in enumerate(el['nodes']):
                use[n] = use.get(n, 0) + (1 if i in (0, len(el['nodes']) - 1) else 2)
                widest[n] = max(widest.get(n, 0), w)
                pos[n] = xy[i]
        inter = {n for n, k in use.items() if k >= 3}
        self.inter_pos = {n: pos[n] for n in inter}
        self.inter_r = {n: widest[n] / 2 + 1.5 for n in inter}
        circles = [Point(pos[n]).buffer(self.inter_r[n], quad_segs=4) for n in inter]
        clear = unary_union(circles) if circles else None
        land_p = shapely.prepared.prep(land)
        bld_tree = STRtree([b[0] for b in buildings])
        bld_geoms = [b[0] for b in buildings]

        def in_building(x, y):
            p = Point(x, y)
            return any(bld_geoms[i].contains(p) for i in bld_tree.query(p))

        # ---- lane markings: (plan coords, kind, dashed)
        marks = []
        for el, t, base, xy, w in ways:
            if t.get('bridge') == 'yes' and not land_p.contains(Point(xy[len(xy) // 2])):
                continue
            line = LineString(xy)
            if clear is not None:
                line = line.difference(clear)
            parts = [g for g in getattr(line, 'geoms', [line]) if isinstance(g, LineString) and g.length > 4]
            lanes = _lanes(t, w)
            oneway = t.get('oneway') in ('yes', '1', '-1') or base == 'motorway'
            usable = w - 1.0
            for part in parts:
                c = np.asarray(part.coords)
                if not oneway and base != 'residential':
                    # double yellow centre line
                    marks.append((_offset(c, 0.14), M_YELLOW, False))
                    marks.append((_offset(c, -0.14), M_YELLOW, False))
                    per_side = max(1, lanes // 2)
                    for k in range(1, per_side):
                        off = k * usable / 2 / per_side
                        marks.append((_offset(c, off), M_WHITE, True))
                        marks.append((_offset(c, -off), M_WHITE, True))
                elif not oneway:
                    marks.append((c, M_YELLOW, True))  # narrow two-way side street: a single dashed yellow
                else:
                    for k in range(1, lanes):
                        marks.append((_offset(c, -usable / 2 + k * usable / lanes), M_WHITE, True))
                    if base in ('motorway', 'trunk'):
                        marks.append((_offset(c, usable / 2), M_WHITE, False))
                        marks.append((_offset(c, -usable / 2), M_WHITE, False))
        self.marks = marks
        self.marks_tree = STRtree([LineString(m[0]) if len(m[0]) >= 2 else Point(0, 0) for m in marks])

        # ---- crosswalks: zebra bars across each street leaving an intersection. OSM ways usually run through
        # many intersections, so look at every node, in both directions along the way
        walks = []
        for el, t, base, xy, w in ways:
            if base in ('motorway', 'trunk'):
                continue
            nodes = el['nodes']
            for i, n in enumerate(nodes):
                if n not in inter:
                    continue
                for step in (1, -1):
                    leg = xy[i:] if step > 0 else xy[i::-1]
                    if len(leg) >= 2:
                        walks_leg(walks, leg, w, self.inter_r[n])
        self.walks = walks
        self.walks_xy = np.array([w[0] for w in walks]) if walks else np.zeros((0, 2))

        # ---- street lamps along both sides
        lamps = []
        for el, t, base, xy, w in ways:
            if base not in LAMPED:
                continue
            line = LineString(xy)
            if line.length < 20:
                continue
            for side in (1, -1):
                off = LineString(_offset(np.asarray(xy), side * (w / 2 + 0.9)))
                if off.length < 10:
                    continue
                s = (_hash(el['id'], side) % 1000) / 1000 * LAMP_SPACING
                while s < off.length:
                    p = off.interpolate(s)
                    q = off.interpolate(min(off.length, s + 1.0))
                    s += LAMP_SPACING
                    if clear is not None and clear.contains(p):
                        continue
                    if not land_p.contains(p) or in_building(p.x, p.y):
                        continue
                    # the arm reaches over the road. Yaw is in world terms (x, z = -plan y): rotating +Z by yaw
                    # gives the arm direction
                    dx, dy = q.x - p.x, q.y - p.y
                    ax, ay = (dy, -dx) if side > 0 else (-dy, dx)
                    lamps.append((p.x, p.y, math.atan2(ax, -ay)))
        self.lamps = np.array(lamps) if lamps else np.zeros((0, 3))

        # ---- traffic signals: a pole on the right-hand corner of each street leaving a signalised intersection
        sig_nodes = {e['id'] for e in json.load(open(signals_path))['elements']}
        sigs = []
        for el, t, base, xy, w in ways:
            if base in ('motorway', 'trunk'):
                continue
            nodes = el['nodes']
            for end in (0, len(nodes) - 1):
                n = nodes[end]
                if n not in sig_nodes:
                    continue
                c = xy if end == 0 else xy[::-1]
                p0, p1 = np.asarray(c[0]), np.asarray(c[1])
                dvec = p1 - p0
                L = np.linalg.norm(dvec)
                if L < 8:
                    continue
                dvec /= L
                right = np.array([dvec[1], -dvec[0]])
                r = self.inter_r.get(n, w / 2 + 1.5)
                p = p0 + dvec * (r + 1.0) + right * (w / 2 + 0.8)
                if in_building(p[0], p[1]):
                    continue
                # the mast arm points across the street (towards -right); world yaw as for lamps
                sigs.append((p[0], p[1], math.atan2(-right[0], right[1])))
        self.signals = np.array(sigs) if sigs else np.zeros((0, 3))

        # ---- trees: the street tree census, then woods and parks filled in
        trees = []
        for r in json.load(open(trees_path)):
            try:
                x, y = project([(float(r['longitude']), float(r['latitude']))])[0]
                dbh = float(r.get('tree_dbh') or 8)
            except (KeyError, ValueError):
                continue
            trees.append((x, y, float(np.clip(0.55 + dbh * 0.035, 0.6, 1.6))))
        avoid = unary_union([g for g in plaza] + [g for g in pitch])
        for polys, spacing in ((wood, 7.0), (green_parks, 15.0)):
            for g in polys:
                if g.area < 1500:
                    continue
                g = g.difference(avoid) if avoid is not None else g
                minx, miny, maxx, maxy = g.bounds
                gp = shapely.prepared.prep(g)
                xs = np.arange(minx, maxx, spacing)
                ys = np.arange(miny, maxy, spacing)
                for ix, x in enumerate(xs):
                    for iy, y in enumerate(ys):
                        h = _hash(int(x * 10), int(y * 10))
                        if (h & 3) == 0:
                            continue  # leave clearings
                        px = x + ((h >> 4) % 1000 / 1000 - 0.5) * spacing
                        py = y + ((h >> 14) % 1000 / 1000 - 0.5) * spacing
                        if gp.contains(Point(px, py)) and not in_building(px, py):
                            trees.append((px, py, 0.8 + ((h >> 24) % 100) / 100 * 0.8))
        self.trees = np.array(trees) if trees else np.zeros((0, 3))

        # ---- rooftops: water towers on mid-rise buildings, plant boxes on towers
        tanks, boxes = [], []
        for g, h, b in buildings:
            hv = _hash(b, 7)
            area = g.area
            if 14 <= h <= 95 and 120 <= area <= 4000 and hv % 100 < 38:
                c = g.representative_point()
                tanks.append((c.x, c.y, h, 0.8 + (hv >> 8) % 60 / 100, ((hv >> 16) % 628) / 100))
            elif h > 95 and area > 300:
                c = g.representative_point()
                n = 1 + hv % 3
                side = math.sqrt(area)
                for k in range(n):
                    hk = _hash(b, k)
                    sx = side * (0.15 + (hk % 100) / 500)
                    sz = side * (0.12 + ((hk >> 8) % 100) / 600)
                    ox = ((hk >> 16) % 100 / 100 - 0.5) * side * 0.3
                    oy = ((hk >> 24) % 100 / 100 - 0.5) * side * 0.3
                    p = Point(c.x + ox, c.y + oy)
                    if g.contains(p):
                        boxes.append((p.x, p.y, h, sx, 2.2 + (hk % 7) * 0.4, sz, ((hk >> 4) % 314) / 100))
        self.tanks = np.array(tanks) if tanks else np.zeros((0, 5))
        self.boxes = np.array(boxes) if boxes else np.zeros((0, 7))
        return {'marks': len(marks), 'crosswalk_bars': len(walks), 'lamps': len(lamps), 'signals': len(sigs),
                'trees': len(trees), 'water_towers': len(tanks), 'roof_boxes': len(boxes)}

    # ------------------------------------------------------------------ per tile
    @staticmethod
    def _in_cell(arr, cell):
        if not len(arr):
            return arr
        x0, y0, x1, y1 = cell.bounds
        m = (arr[:, 0] >= x0) & (arr[:, 0] < x1) & (arr[:, 1] >= y0) & (arr[:, 1] < y1)
        return arr[m]

    def for_tile(self, cell, roads):
        """-> (strips, props). strips: list of (quad corner arrays (n,4,2), kind); props: dict of number lists in
        WORLD coords (x, z = -plan y)."""
        strips = []
        for i in self.marks_tree.query(cell):
            coords, kind, dashed = self.marks[i]
            line = LineString(coords).intersection(cell)
            for part in getattr(line, 'geoms', [line]):
                if not isinstance(part, LineString) or part.length < 0.5:
                    continue
                quads = _strip_quads(np.asarray(part.coords), LINE_W, DASH if dashed else None, GAP)
                if len(quads):
                    strips.append((quads, kind))
        # crosswalk bars whose origin is in this tile
        if len(self.walks):
            x0, y0, x1, y1 = cell.bounds
            idx = np.nonzero((self.walks_xy[:, 0] >= x0) & (self.walks_xy[:, 0] < x1) & (self.walks_xy[:, 1] >= y0) & (self.walks_xy[:, 1] < y1))[0]
            q = []
            for i in idx:
                a, dv, pp, length, bw = self.walks[i]
                p0 = a - pp * bw / 2
                q.append([p0, p0 + dv * length, p0 + dv * length + pp * bw, p0 + pp * bw])
            if q:
                strips.append((np.array(q), M_WHITE))

        def world(arr, cols):
            out = arr.copy()
            out[:, 1] = -out[:, 1]  # plan y -> world z
            return [round(float(v), 2) for row in out[:, :cols] for v in row]

        lamps = self._in_cell(self.lamps, cell)
        sig = self._in_cell(self.signals, cell)
        trees = self._in_cell(self.trees, cell)
        tanks = self._in_cell(self.tanks, cell)
        boxes = self._in_cell(self.boxes, cell)
        props = {}
        if len(lamps):
            props['lamp'] = world(lamps, 3)
        if len(sig):
            props['signal'] = world(sig, 3)
        if len(trees):
            props['tree'] = world(trees, 3)
        if len(tanks):
            props['tank'] = world(tanks, 5)
        if len(boxes):
            props['box'] = world(boxes, 7)
        return strips, props


def walks_leg(walks, leg, w, r):
    """zebra bars across the street, just outside the intersection at leg[0], following the street's direction
    there (measured along the polyline: OSM often has a node a few metres from the junction)"""
    line = LineString(leg)
    if line.length < r + 6:
        return
    a = np.asarray(line.interpolate(r - 0.2).coords[0])
    b = np.asarray(line.interpolate(min(line.length, r + 3.0)).coords[0])
    dvec = b - a
    L = np.linalg.norm(dvec)
    if L < 1:
        return
    dvec /= L
    perp = np.array([-dvec[1], dvec[0]])
    half = (w - 0.6) / 2
    k = -half + 0.3
    while k < half - 0.2:
        walks.append((a + perp * k, dvec, perp, 3.0, 0.5))  # origin, along, across, length, bar width
        k += 1.1

def _strip_quads(c, width, dash, gap):
    """quads (n,4,2) covering a polyline with a strip of `width`, solid or dashed"""
    seg = np.diff(c, axis=0)
    L = np.hypot(seg[:, 0], seg[:, 1])
    keep = L > 1e-3
    c0, seg, L = c[:-1][keep], seg[keep], L[keep]
    if not len(L):
        return np.zeros((0, 4, 2))
    d = seg / L[:, None]
    n = np.column_stack((-d[:, 1], d[:, 0])) * width / 2
    quads = []
    if dash is None:
        for p, dd, nn, l in zip(c0, d, n, L):
            a, b = p, p + dd * l
            quads.append([a - nn, b - nn, b + nn, a + nn])
    else:
        period = dash + gap
        s0 = 0.0
        for p, dd, nn, l in zip(c0, d, n, L):
            # dashes run on the global distance along the line
            t = (-s0) % period
            while t < l:
                t1 = min(l, t + dash)
                if t1 - t > 0.3:
                    a, b = p + dd * t, p + dd * t1
                    quads.append([a - nn, b - nn, b + nn, a + nn])
                t += period
            s0 += l
    return np.array(quads) if quads else np.zeros((0, 4, 2))
