[out:json][timeout:120];
area["name"="Manhattan"]["boundary"="administrative"]->.m;
node["highway"="traffic_signals"](area.m);
out;
