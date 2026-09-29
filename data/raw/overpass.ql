[out:json][timeout:300];
area["name"="Manhattan"]["boundary"="administrative"]->.m;
(
  way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|residential|unclassified|living_street|service|pedestrian)$"](area.m);
  way["leisure"~"^(park|garden|pitch|playground)$"](area.m);
  relation["leisure"="park"](area.m);
  way["landuse"~"^(grass|recreation_ground|cemetery)$"](area.m);
  way["natural"~"^(water|coastline|wood)$"](area.m);
  relation["boundary"="administrative"]["name"="Manhattan"];
);
out geom;
