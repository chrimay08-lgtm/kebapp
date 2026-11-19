"""Ritaglia le geometrie di linee.json sul confine comunale."""
import json

from shapely.geometry import LineString, shape

from prepara_dati import DATA_DIR
line_file = DATA_DIR / "linee.json"
boundary = shape(json.loads((DATA_DIR / "confine.json").read_text()))
source = json.loads(line_file.read_text())
sections = {}
for key, coordinates in source["shapes"].items():
    clipped = LineString([(lon, lat) for lat, lon in coordinates]).intersection(boundary)
    components = [clipped] if clipped.geom_type == "LineString" else getattr(clipped, "geoms", [])
    sections[key] = {
        f"{key}.{index}": [[lat, lon] for lon, lat in part.coords]
        for index, part in enumerate(components)
        if part.geom_type == "LineString" and not part.is_empty
    }

shapes = {}
routes = []
for route in source["routes"]:
    paths = {}
    for key in route["paths"]:
        paths.update(sections[key])
    if paths:
        shapes.update(paths)
        routes.append({**route, "paths": list(paths)})
line_file.write_text(json.dumps({"routes": routes, "shapes": shapes}, separators=(",", ":")))
