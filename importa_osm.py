"""Estrae kebab e treni suburbani da un file OpenStreetMap .osm.pbf."""
import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

import osmium
from shapely import from_wkb
from shapely.geometry import Point, shape

from prepara_dati import DATA_DIR, save

FOOD = re.compile(r"kebab|döner|doner|shawarma", re.IGNORECASE)
SUBURBAN = re.compile(r"S\s*\d{1,2}", re.IGNORECASE)

def is_kebab(tags):
    return tags.get("amenity") in {"restaurant", "fast_food"} and any(
        FOOD.search(tags.get(key, "")) for key in ("name", "cuisine")
    )

def place(tags, point):
    return {
        "name": tags.get("name", "Kebab senza nome"),
        "address": tags.get("addr:full") or " ".join(
            tags[key] for key in ("addr:street", "addr:housenumber") if key in tags
        ),
        "point": [point.y, point.x],
    }

def is_milano(tags):
    return tags.get("boundary") == "administrative" and (
        tags.get("ref:ISTAT") == "015146" or
        (tags.get("admin_level") == "8" and tags.get("name") == "Milano")
    )

class Places(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.boundary = None
        self.entries = []
        self.factory = osmium.geom.WKBFactory()

    def node(self, node):
        if is_kebab(node.tags) and node.location.valid():
            self.entries.append(place(node.tags, Point(node.lon, node.lat)))

    def area(self, area):
        city = is_milano(area.tags)
        if not (city or is_kebab(area.tags)):
            return
        try:
            geometry = from_wkb(self.factory.create_multipolygon(area))
        except (RuntimeError, ValueError):
            return
        if city:
            self.boundary = geometry
        elif not geometry.is_empty:
            self.entries.append(place(area.tags, geometry.representative_point()))

class RailRelations(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.routes = defaultdict(lambda: {"name": "", "ways": set()})

    def relation(self, relation):
        tags = relation.tags
        ref = re.sub(r"\s+", "", tags.get("ref", "")).upper()
        if tags.get("route") not in {"train", "light_rail"} or not SUBURBAN.fullmatch(ref):
            return
        route = self.routes[ref]
        route["name"] = tags.get("name", "Treno suburbano")
        route["ways"].update(m.ref for m in relation.members if m.type == "w" and not m.role.startswith("platform"))

class RailGeometry(osmium.SimpleHandler):
    def __init__(self, way_ids):
        super().__init__()
        self.way_ids = way_ids
        self.paths = {}

    def way(self, way):
        if way.id not in self.way_ids or way.tags.get("railway") not in {"rail", "light_rail"}:
            return
        path = [[round(n.lat, 5), round(n.lon, 5)] for n in way.nodes if n.location.valid()]
        if len(path) > 1:
            self.paths[way.id] = path

def main(source, boundary_file):
    places = Places()
    places.apply_file(str(source), locations=True)
    if boundary_file:
        places.boundary = shape(json.loads(boundary_file.read_text(encoding="utf-8")))
    if places.boundary is None:
        raise ValueError("Nell'estratto manca il confine amministrativo del Comune di Milano.")
    boundary = places.boundary.buffer(0)
    unique = {}
    for item in places.entries:
        lat, lon = item["point"]
        if boundary.covers(Point(lon, lat)):
            key = (item["name"].casefold(), round(lat, 4), round(lon, 4))
            unique[key] = item
    save("kebab.json", sorted(unique.values(), key=lambda item: item["name"].casefold()))

    relations = RailRelations()
    relations.apply_file(str(source))
    geometry = RailGeometry({way for route in relations.routes.values() for way in route["ways"]})
    geometry.apply_file(str(source), locations=True)
    data = json.loads((DATA_DIR / "linee.json").read_text(encoding="utf-8"))
    data["routes"] = [route for route in data["routes"] if route["kind"] != "treno"]
    data["shapes"] = {key: path for key, path in data["shapes"].items() if not key.startswith("osm-")}
    for ref, route in sorted(relations.routes.items()):
        ways = sorted(route["ways"].intersection(geometry.paths))
        if not any(boundary.covers(Point(lon, lat)) for way in ways for lat, lon in geometry.paths[way]):
            continue
        paths = {f"osm-{way}": geometry.paths[way] for way in ways}
        data["shapes"].update(paths)
        data["routes"].append({"ref": ref, "name": route["name"], "kind": "treno", "paths": list(paths)})
    save("linee.json", data)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pbf", type=Path)
    parser.add_argument("--confine", type=Path, help="Geometria comunale GeoJSON alternativa")
    args = parser.parse_args()
    main(args.pbf, args.confine)
