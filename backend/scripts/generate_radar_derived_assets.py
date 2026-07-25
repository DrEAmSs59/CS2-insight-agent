"""Generate utility masks + content_rect metadata from bundled radar PNGs.

Usage::

    cd backend
    python scripts/generate_radar_derived_assets.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.radar.radar_derived_assets import (  # noqa: E402
    estimate_content_rect,
    generate_utility_mask,
)
from app.radar.radar_map_assets import bundled_radar_maps_dir  # noqa: E402


def _map_key_from_upper_stem(stem: str) -> str | None:
    """Return map-data key for an upper radar stem, or None for lower/mask files."""
    if stem.endswith("_utility_mask"):
        return None
    if stem.endswith("_lower"):
        return None
    return stem


def generate_all(*, maps_dir: Path | None = None) -> int:
    root = maps_dir or bundled_radar_maps_dir()
    meta_path = root / "map-data.json"
    if not meta_path.is_file():
        print(f"Missing {meta_path}", file=sys.stderr)
        return 1

    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        print(f"Could not read map-data.json: {e}", file=sys.stderr)
        return 1
    if not isinstance(data, dict):
        print("map-data.json root must be an object", file=sys.stderr)
        return 1

    pngs = sorted(p for p in root.glob("*.png") if not p.name.endswith("_utility_mask.png"))
    if not pngs:
        print(f"No radar PNGs under {root}", file=sys.stderr)
        return 1

    mask_count = 0
    for png in pngs:
        out = root / f"{png.stem}_utility_mask.png"
        generate_utility_mask(png, out)
        mask_count += 1
        print(f"mask: {out.name}")

    updated = 0
    for png in pngs:
        map_key = _map_key_from_upper_stem(png.stem)
        if map_key is None:
            continue
        entry = data.get(map_key)
        if not isinstance(entry, dict):
            # Try case-insensitive match in existing keys.
            matched = None
            for k, v in data.items():
                if str(k).lower() == map_key.lower() and isinstance(v, dict):
                    matched = k
                    entry = v
                    break
            if matched is None:
                continue
            map_key = matched
        rect = estimate_content_rect(png, luminance_threshold=18, pad=8)
        entry.update(rect)
        entry["transform_version"] = 3
        data[map_key] = entry
        updated += 1
        print(f"content_rect: {map_key} -> {rect}")

    meta_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {mask_count} masks; updated {updated} map-data entries → {meta_path}")
    return 0


def main() -> int:
    return generate_all()


if __name__ == "__main__":
    raise SystemExit(main())
