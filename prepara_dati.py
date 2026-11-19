"""Genera i file JSON per la mappa da un archivio GTFS e una risposta Overpass."""
import argparse
import csv
import io
import json
import zipfile
from collections import defaultdict
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_DIR / ("dist/data" if (PROJECT_DIR / "dist").is_dir() else "data")

def rows(archive, name):
    with archive.open(name + ".txt") as source:
        yield from csv.DictReader(io.TextIOWrapper(source, encoding="utf-8-sig"))

def transit(path):
    with zipfile.ZipFile(path) as archive:
        routes = list(rows(archive, "routes"))
        route_shapes = defaultdict(set)
        for trip in rows(archive, "trips"):
            if trip["shape_id"]:
                route_shapes[trip["route_id"]].add(trip["shape_id"])
        shapes = defaultdict(list)
        for row in rows(archive, "shapes"):
            shapes[row["shape_id"]].append((
                int(row["shape_pt_sequence"]),
                round(float(row["shape_pt_lat"]), 5),
                round(float(row["shape_pt_lon"]), 5),
            ))
    geometries = {
        key: [[lat, lon] for _, lat, lon in sorted(points)]
        for key, points in shapes.items() if len(points) >= 2
    }
    types = {"0": "tram", "1": "metro", "2": "treno", "3": "bus", "11": "filobus", "800": "filobus"}
    data = []
    for route in routes:
        route_id = route["route_id"]
        kind = types.get(route["route_type"], "altro")
        ref = route["route_short_name"] or route_id
        if kind == "metro" and ref.isdecimal():
            ref = "M" + ref
        if kind == "bus" and ref in {"90", "91", "92", "93"}:
            kind = "filobus"
        paths = sorted(route_shapes[route_id].intersection(geometries))
        data.append({"ref": ref, "name": route["route_long_name"], "kind": kind, "paths": paths})
    used = {key for route in data for key in route["paths"]}
    return {"routes": data, "shapes": {key: geometries[key] for key in sorted(used)}}

def restaurants(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("remark"):
        raise ValueError(data["remark"])
    places = []
    for item in data["elements"]:
        tags = item.get("tags", {})
        point = item.get("center", item)
        if "lat" not in point or "lon" not in point:
            continue
        places.append({
            "name": tags.get("name") or "Kebab senza nome",
            "address": tags.get("addr:full") or " ".join(
                value for key in ("addr:street", "addr:housenumber") if (value := tags.get(key))
            ),
            "point": [point["lat"], point["lon"]],
        })
    return sorted(places, key=lambda place: place["name"].casefold())

def save(name, data):
    (DATA_DIR / name).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gtfs", type=Path)
    parser.add_argument("--overpass", type=Path)
    args = parser.parse_args()
    if not (args.gtfs or args.overpass):
        parser.error("Indica almeno una fonte.")
    if args.gtfs:
        save("linee.json", transit(args.gtfs))
    if args.overpass:
        save("kebab.json", restaurants(args.overpass))
