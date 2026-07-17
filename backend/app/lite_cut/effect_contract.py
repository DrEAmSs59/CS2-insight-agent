"""Shared LiteCut preview/export effect contract."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any


def effect_contract_path() -> Path:
    return Path(__file__).resolve().parents[3] / "data" / "lite_cut_effect_contract.json"


@lru_cache(maxsize=1)
def load_effect_contract() -> dict[str, Any]:
    path = effect_contract_path()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"LiteCut effect contract could not be loaded: {path}") from exc
    if not isinstance(payload, dict) or int(payload.get("schema_version") or 0) < 1:
        raise RuntimeError(f"LiteCut effect contract has an invalid schema: {path}")
    return payload


def filter_preset_ffmpeg_map() -> dict[str, str]:
    return {
        str(preset["id"]): str(preset.get("ffmpeg") or "")
        for preset in load_effect_contract().get("filter_presets", [])
        if isinstance(preset, dict) and preset.get("id") not in (None, "", "none")
    }


def normalize_video_layer_transform(transform: Any) -> dict[str, float]:
    source = transform if isinstance(transform, dict) else {}
    limits = load_effect_contract()["transform_limits"]

    def finite(key: str, fallback: float) -> float:
        try:
            value = float(source.get(key, fallback))
        except (TypeError, ValueError):
            return fallback
        return value if value == value and value not in (float("inf"), float("-inf")) else fallback

    def clamp(value: float, minimum: str, maximum: str) -> float:
        return max(float(limits[minimum]), min(float(limits[maximum]), value))

    return {
        "x": clamp(finite("x", 0.5), "position_min", "position_max"),
        "y": clamp(finite("y", 0.5), "position_min", "position_max"),
        "width": clamp(finite("width", 1.0), "size_min", "size_max"),
        "height": clamp(finite("height", 1.0), "size_min", "size_max"),
        "scale": clamp(finite("scale", 1.0), "scale_min", "scale_max"),
        "rotation": clamp(finite("rotation", 0.0), "rotation_min", "rotation_max"),
        "opacity": clamp(finite("opacity", 1.0), "opacity_min", "opacity_max"),
    }
