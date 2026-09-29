#!/bin/sh
# Downloads the Manhattan source data into data/raw/ (about 100 MB). Run from the project root.
set -e
cd "$(dirname "$0")/../data/raw"

echo "buildings (NYC Open Data 5zhs-2jue)…"
curl -sf -o buildings_manhattan.geojson "https://data.cityofnewyork.us/resource/5zhs-2jue.geojson?\$select=the_geom,bin,height_roof,ground_elevation,construction_year,name,feature_code&\$where=starts_with(base_bbl,'1')&\$limit=60000"

echo "shoreline (NYC Open Data gthc-hcne)…"
curl -sf -o manhattan_shore.geojson "https://data.cityofnewyork.us/resource/gthc-hcne.geojson?\$where=boroname='Manhattan'"

echo "street trees (NYC Open Data uvpi-gqnh)…"
curl -sf -o trees_manhattan.json "https://data.cityofnewyork.us/resource/uvpi-gqnh.json?\$select=latitude,longitude,tree_dbh,spc_common&\$where=boroname='Manhattan'%20AND%20status='Alive'&\$limit=100000"

echo "streets, parks and water (OpenStreetMap via Overpass)…"
curl -sf -A "CollectNYC" --data-urlencode data@overpass.ql -o osm_manhattan.json https://overpass-api.de/api/interpreter

echo "traffic signals (OpenStreetMap via Overpass)…"
curl -sf -A "CollectNYC" --data-urlencode data@overpass_signals.ql -o signals_manhattan.json https://overpass-api.de/api/interpreter

echo "done"
