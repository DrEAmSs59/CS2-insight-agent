"""Canonical visual-material migration and capability helpers."""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Iterable

from .effect_contract import load_effect_contract


_VISUAL_MATERIAL_CONTRACT = load_effect_contract()["visual_material"]
VISUAL_MATERIAL_LIMITS: dict[str, Any] = dict(_VISUAL_MATERIAL_CONTRACT["limits"])
VISUAL_MATERIAL_DEFAULTS: dict[str, Any] = dict(_VISUAL_MATERIAL_CONTRACT["defaults"])
VISUAL_CONTENT_FIT_VALUES = frozenset(str(value) for value in _VISUAL_MATERIAL_CONTRACT["content_fit_values"])
VISUAL_CROP_POSITION_MIN = float(VISUAL_MATERIAL_LIMITS["crop_position_min"])
VISUAL_CROP_POSITION_MAX = float(VISUAL_MATERIAL_LIMITS["crop_position_max"])
VISUAL_CROP_SIZE_MIN = float(VISUAL_MATERIAL_LIMITS["crop_size_min"])
VISUAL_CROP_SIZE_MAX = float(VISUAL_MATERIAL_LIMITS["crop_size_max"])
VISUAL_SPEED_DEFAULT = float(VISUAL_MATERIAL_DEFAULTS["speed"])
VISUAL_SPEED_MIN = float(VISUAL_MATERIAL_LIMITS["speed_min"])
VISUAL_SPEED_MAX = float(VISUAL_MATERIAL_LIMITS["speed_max"])
VISUAL_FREEZE_DEFAULT_SEC = float(VISUAL_MATERIAL_DEFAULTS["freeze_frame_sec"])
VISUAL_FREEZE_MIN_SEC = float(VISUAL_MATERIAL_LIMITS["freeze_min_sec"])
VISUAL_FREEZE_MAX_SEC = float(VISUAL_MATERIAL_LIMITS["freeze_max_sec"])
VISUAL_COLOR_DEFAULT = float(VISUAL_MATERIAL_DEFAULTS["color_adjustment"])
VISUAL_COLOR_MIN = float(VISUAL_MATERIAL_LIMITS["color_adjustment_min"])
VISUAL_COLOR_MAX = float(VISUAL_MATERIAL_LIMITS["color_adjustment_max"])


def _visual_nodes(body: dict[str, Any]) -> Iterable[dict[str, Any]]:
    for track in body.get("tracks") or []:
        if not isinstance(track, dict) or track.get("type") != "video":
            continue
        for clip in track.get("clips") or []:
            if isinstance(clip, dict):
                yield clip
    for overlay in body.get("overlays") or []:
        if isinstance(overlay, dict):
            yield overlay


def visual_material_kind(node: dict[str, Any], *, timeline_clip: bool = False) -> str:
    if timeline_clip:
        return "video_clip"
    if str(node.get("type") or "").lower() == "text":
        return "text_overlay"
    meta = node.get("meta") if isinstance(node.get("meta"), dict) else {}
    kind = str(meta.get("kind") or node.get("type") or "").lower()
    animated = bool(meta.get("is_looping_animation")) or kind in {
        "video", "webm", "gif", "animated_webp",
    }
    return "animated_overlay" if animated else "image_overlay"


def visual_material_capabilities(kind: str) -> frozenset[str]:
    section = load_effect_contract().get("visual_material") or {}
    values = (section.get("capabilities") or {}).get(str(kind)) or []
    return frozenset(str(value) for value in values)


def normalized_visual_material_project(raw_body: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """Normalize canonical visual fields before schema validation."""
    body = deepcopy(raw_body)
    changed = False
    for node in _visual_nodes(body):
        crop = node.get("crop") if isinstance(node.get("crop"), dict) else None
        if crop:
            crop_defaults = VISUAL_MATERIAL_DEFAULTS["crop"]
            for axis in ("width", "height"):
                try:
                    value = float(crop.get(axis, crop_defaults[axis]))
                except (TypeError, ValueError):
                    value = float(crop_defaults[axis])
                normalized = max(VISUAL_CROP_SIZE_MIN, min(VISUAL_CROP_SIZE_MAX, value))
                if crop.get(axis) != normalized:
                    crop[axis] = normalized
                    changed = True
            for axis, size_axis in (("x", "width"), ("y", "height")):
                try:
                    value = float(crop.get(axis, crop_defaults[axis]))
                except (TypeError, ValueError):
                    value = float(crop_defaults[axis])
                normalized = max(VISUAL_CROP_POSITION_MIN, min(VISUAL_CROP_POSITION_MAX - float(crop[size_axis]), value))
                if crop.get(axis) != normalized:
                    crop[axis] = normalized
                    changed = True
    return body, changed


__all__ = [
    "VISUAL_COLOR_DEFAULT",
    "VISUAL_COLOR_MAX",
    "VISUAL_COLOR_MIN",
    "VISUAL_CONTENT_FIT_VALUES",
    "VISUAL_CROP_POSITION_MAX",
    "VISUAL_CROP_POSITION_MIN",
    "VISUAL_CROP_SIZE_MAX",
    "VISUAL_CROP_SIZE_MIN",
    "VISUAL_FREEZE_DEFAULT_SEC",
    "VISUAL_FREEZE_MAX_SEC",
    "VISUAL_FREEZE_MIN_SEC",
    "VISUAL_MATERIAL_LIMITS",
    "VISUAL_MATERIAL_DEFAULTS",
    "VISUAL_SPEED_DEFAULT",
    "VISUAL_SPEED_MAX",
    "VISUAL_SPEED_MIN",
    "normalized_visual_material_project",
    "visual_material_capabilities",
    "visual_material_kind",
]
