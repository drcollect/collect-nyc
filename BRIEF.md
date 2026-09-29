# Collect NYC — brief (draft, 2026-09-27)

## Checked first: spiderbench (github.com/xikhar/spiderbench)

- **What it is:** a Spider-Man-style web-swinging game for the browser (Three.js), written by Claude. ~26k lines of city code in `src/world/`.
- **Its New York is not real map data.** It is a *procedural, Manhattan-style* island: a hand-authored grid in metres, with Broadway and the angled Village and Financial District streets drawn as polylines (`layout.js`), plus procedurally generated buildings, rooftops, Times Square, Grand Central, bridges, traffic and pedestrians.
- **We can't use it.** Its license is "view-only": it forbids using any part of it "in any product, service, game or other distributed work" and forbids redistributing it without written permission. Reading it and running it locally is allowed. A clone sits in `~/blender/_reference/spiderbench` so we can learn from the approach, but no code or assets are copied from it.

## Better source: real NYC map data

- **Buildings:** NYC Open Data "Building Footprints" (dataset `5zhs-2jue`, checked 2026-09-27): every building as a polygon with `height_roof` and `ground_elevation` (in feet), plus `construction_year` and `bin`. Manhattan (`base_bbl` starting with 1) has **45,195 buildings**; the tallest is 1,550 ft. That is enough to extrude a real Manhattan skyline.
- **Streets:** NYC's LION street centreline, or OpenStreetMap (ODbL: needs attribution, and derived databases must stay open).
- **Optional detail:** the city's 3D building model (CityGML), for landmark shapes.
- **Scale:** Manhattan is ~21 × 3.7 km with ~45k buildings. For the browser we'd start with one zone, e.g. Midtown to Lower Manhattan, split into streamed tiles with LOD. Hero landmarks such as the Empire State or Flatiron could be modelled properly in Blender.

## Game ideas for the five cars

Each car can suit a part of the city:

| Car | Strength | Fits |
|---|---|---|
| Hypercar | acceleration, grip | Midtown sprints through traffic |
| 80s wedge | drift, style | the tight Village and SoHo streets |
| Rally-raid | rough terrain, jumps | Central Park paths, stairs, construction sites |
| Endurance | high-speed stability, night | West Side Highway / FDR Drive at night |
| Streamliner | top speed | long straight avenues, bridge runs |

1. **Open-world Collect hunt:** free-roam Manhattan with timed "drops" (collectibles) spawning around the city; race rival AI to them. Fits the Collect brand best.
2. **Street races:** checkpoint races on real routes (Times Square → Brooklyn Bridge, FDR sprint, Central Park loop) against AI in the other four cars.
3. **Pursuit / getaway:** outrun police through real streets; each car escapes differently.
4. **Stunt / drift sessions:** score runs in set zones (gymkhana style).

These combine well: a free-roam hub (1) with races (2) as events.

## Decided (2026-09-27)

- **Game:** free-roam Manhattan hub with timed Collect drops, plus checkpoint races on real routes as events.
- **Map:** all of Manhattan from the first version, so tile streaming and LOD are needed from day one.
- **Streets:** empty at first, no traffic or pedestrians (2026-09-27).
- **Hosting:** Vercel. The city is pre-cut into static tiles at build time (glTF/Draco or a custom binary per tile, several LOD levels) and served from Vercel's CDN, so no tile server is needed. The game streams in tiles around the car. If the tiles get too big for a deploy, they move to Vercel Blob. Sign-in the same way as Demolition Derby.

## Open decisions

- (none right now)

## Status (2026-09-27)

**City:** the whole island is drivable. The tile builder streams 1,148 tiles around the car, with building collisions, the far skyline, the street name and a minimap. Wall crashes dent the car.

**Gameplay (first version):**
- **Collect drops:** five drops are live around the island at any time, spawning 250 m to 3 km from the car. Each has a rarity (common 100 points / 4 min, rare 250 / 3 min, epic 600 / 2 min 10 s, legendary 1,500 / 1 min 35 s) and a clock; when the clock runs out a rival crew takes it. Each is marked by a coloured light beam over the rooftops. Drive through one to collect it and reveal an item (car culture and New York, e.g. "Yellow Cab Livery", "Empire Gold Livery"). An arrow at the top points to the best-value drop you can still reach in time. Points and items are saved in the browser.
- **Collection screen (I):** every item grouped by rarity. Found items show their count and points; the rest are locked "? ? ?" cards. It also shows total points, items found (of 21) and drops picked up. The game pauses while it's open, and it's disabled during races.
- **Rival crew:** three rivals (Vega, Okafor, Brandt) in the other Collect cars drive the real streets to the drops, routed on the street graph. Whoever gets there first takes it. Each has a name tag you can see through buildings and a dot on the minimap, and the target label shows how far the nearest rival still has to drive. A new drop is yours alone for 10 seconds, and after a grab a rival cruises for 25–40 s before hunting again (about 1 grab a minute if you do nothing). You can ram them; a wrecked rival comes back elsewhere.
- **Races:** seven routes on real streets, found on the street graph (`graph.json`, 8,087 intersections), with a white beam and a checkered flag at each start. Stop there and press E. You start at the back of a five-car grid; the other four Collect cars are AI rivals (Vega, Okafor, Brandt, Moreau) with different skill. There are gates every ~220 m and after each corner, plus a countdown, position, timer, best time, live results and a route on the minimap. R puts you back on the route in a fresh car; a wrecked rival comes back too. Esc abandons a race.
  - Midtown Loop (4.0 mi): Times Square, Columbus Circle, Grand Army Plaza, Grand Central, the Empire State and back.
  - Downtown Dash (3.4 mi): Herald Square, the Flatiron, Union Square, Washington Square, City Hall.
  - West Side Highway (4.5 mi): Battery Park, the WTC, Chelsea Piers, the Intrepid.
  - Central Park Loop (6.4 mi, loop): the park drive (East, West and Center Drive). It's car-free in real life and tagged pedestrian in OSM, so the builder adds those drives to the street graph as class `parkdrive`.
  - FDR Drive (7.2 mi): South Street Seaport to 96th St along the East River. It cuts over to York Avenue where the FDR is a tunnel.
  - Uptown Run (4.5 mi): the Apollo on 125th St, St. Nicholas Ave, Broadway through Washington Heights, Dyckman St in Inwood.
  - Financial District GP (2.2 mi, loop): Broadway at Wall St, Bowling Green, Battery Park, Water St, the Seaport, City Hall.
  Route points can be pinned to a named street (`[lat, lon, 'FDR Drive']`) so they don't snap to a parallel avenue.

**City detail (2026-09-28):** lane markings (double yellow centre lines, white lane dashes, highway edge lines), 164k crosswalk bars at intersections, curbs, 40k street lamps, 4.6k traffic-signal poles at real signalised intersections, 194k trees (the real street trees plus park woodland), 10k rooftop water towers, rooftop plant on towers, and cornices on masonry buildings. The sky was dimmed and the bloom softened, because the physical sky was bright enough to haze the whole city.

**Breakables (2026-09-28):** lamps, traffic signals and trees are knocked over by any car. The hit prop becomes a Rapier rigid body, thrown forward and out to its side, and it ignores cars for its first second so it clears your line; the car loses 10–26% of its speed depending on what it hit, with sparks or leaves, an impact sound and camera shake. Up to 40 fallen props at once, each cleared after 25 s; a tile's props stand again when the tile reloads.

**Not yet:** landmarks, terrain height, bridges, traffic, rival cars in free roam, a car picker screen.

**Online:** https://collect-nyc-chi.vercel.app, behind sign-in from 27 September 2026, public since 28 September 2026.

## Next steps

1. Race and drop feel: more races.
2. Look: road markings, curbs, better facades, night mode.
