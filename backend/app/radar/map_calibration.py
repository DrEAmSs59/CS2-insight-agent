from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any


class RadarMapError(Exception):
    pass


ASSETS_DIR = Path(__file__).resolve().parents[2] / "assets" / "radar_maps"
CALIBRATION_PATH = ASSETS_DIR / "calibration.json"


@lru_cache(maxsize=1)
def load_calibrations() -> dict[str, Any]:
    if not CALIBRATION_PATH.exists():
        raise RadarMapError(f"缺少雷达地图校准文件: {CALIBRATION_PATH}")

    with CALIBRATION_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def get_map_calibration(map_name: str) -> dict[str, Any]:
    data = load_calibrations()
    key = map_name.lower()

    if key not in data:
        raise RadarMapError(f"暂不支持该地图的小地图覆盖: {map_name}")

    cfg = data[key]
    image = ASSETS_DIR / cfg["image"]

    if not image.exists():
        raise RadarMapError(f"缺少雷达底图: {image}")

    return {
        **cfg,
        "image_path": str(image),
    }


def world_to_radar_xy(world_x: float, world_y: float, cfg: dict[str, Any]) -> tuple[float, float]:
    """
    CS2 世界坐标 -> 原始雷达底图像素坐标。

    只负责投影到原始雷达底图坐标，不负责缩放到最终 overlay 画布。
    """
    pos_x = float(cfg["pos_x"])
    pos_y = float(cfg["pos_y"])
    scale = float(cfg["scale"])

    image_x = (float(world_x) - pos_x) / scale
    image_y = (pos_y - float(world_y)) / scale

    image_x += float(cfg.get("marker_offset_x", 0.0) or 0.0)
    image_y += float(cfg.get("marker_offset_y", 0.0) or 0.0)

    return image_x, image_y
