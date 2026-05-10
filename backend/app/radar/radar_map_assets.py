"""Bundled CS2 radar PNG + ``map-data.json`` shipped under ``backend/assets/bundled_radar_maps``.

数据来源与更新方式：与历史上 ``python -m awpy get maps`` 写入 ``~/.awpy/maps`` 的文件一致；
可使用 ``backend/scripts/vendor_bundled_radar_maps.py`` 从本机该目录同步到仓库。
"""

from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger(__name__)


def _backend_dir() -> Path:
    return Path(__file__).resolve().parents[2]


def bundled_radar_maps_dir() -> Path:
    return _backend_dir() / "assets" / "bundled_radar_maps"


@lru_cache(maxsize=1)
def _loaded_map_data() -> dict[str, dict]:
    path = bundled_radar_maps_dir() / "map-data.json"
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        logger.warning("Could not read bundled map-data.json: %s", e)
        return {}
    if not isinstance(raw, dict):
        return {}
    return raw


def lookup_map_data(map_key: str) -> dict:
    """Return map metadata (``pos_x``, ``pos_y``, ``scale``, …) for ``map_key``."""
    data = _loaded_map_data()
    if not data:
        meta = bundled_radar_maps_dir() / "map-data.json"
        raise KeyError(f"bundled MAP_DATA empty or missing: {meta}")

    key = map_key.strip()
    if key in data:
        return dict(data[key])
    lk = key.lower()
    if lk in data:
        return dict(data[lk])
    for k, v in data.items():
        if str(k).lower() == lk:
            return dict(v)
    raise KeyError(
        f"Map {map_key!r} not in bundled map-data.json; "
        f"sample keys: {list(data.keys())[:12]}"
    )


def resolve_map_png_path(map_key: str) -> Path:
    """Resolve vendored radar PNG path (``{{map}}.png`` or ``{{map}}_radar.png``)."""
    root = bundled_radar_maps_dir()
    mk = map_key.strip()
    candidates = [
        root / f"{mk}.png",
        root / f"{mk.lower()}.png",
        root / f"{mk}_radar.png",
        root / f"{mk.lower()}_radar.png",
    ]
    seen: set[Path] = set()
    for c in candidates:
        if c in seen:
            continue
        seen.add(c)
        if c.is_file():
            return c
    raise FileNotFoundError(f"No bundled radar PNG for {map_key!r} under {root}")


def warn_if_bundle_incomplete() -> None:
    """Best-effort notice when assets ship without PNG/json."""
    d = bundled_radar_maps_dir()
    if not (d / "map-data.json").is_file():
        logger.warning("Bundled radar maps missing map-data.json: %s", d)
        return
    if not any(d.glob("*.png")):
        logger.warning("Bundled radar maps directory has no PNG files: %s", d)
