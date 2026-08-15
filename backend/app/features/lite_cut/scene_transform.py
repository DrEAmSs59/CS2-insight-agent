"""Canonical scene-node transform shared by every LiteCut visual renderer."""

from __future__ import annotations

import math
import re
from typing import Any

from .effect_contract import load_effect_contract


_SCENE_TRANSFORM_CONTRACT = load_effect_contract()["scene_transform"]
SCENE_TRANSFORM_LIMITS: dict[str, Any] = dict(_SCENE_TRANSFORM_CONTRACT["limits"])


VIDEO_SCENE_DEFAULTS = dict(_SCENE_TRANSFORM_CONTRACT["defaults"]["video"])
OVERLAY_SCENE_DEFAULTS = dict(_SCENE_TRANSFORM_CONTRACT["defaults"]["overlay"])


def normalize_scene_transform(
    transform: Any,
    defaults: dict[str, float] | None = None,
) -> dict[str, float]:
    source = transform if isinstance(transform, dict) else {}
    fallback = defaults or VIDEO_SCENE_DEFAULTS
    limits = SCENE_TRANSFORM_LIMITS

    def finite(key: str) -> float:
        try:
            value = float(source.get(key, fallback[key]))
        except (KeyError, TypeError, ValueError):
            return float(fallback[key])
        return value if math.isfinite(value) else float(fallback[key])

    def bounded(key: str, minimum: str, maximum: str) -> float:
        return max(float(limits[minimum]), min(float(limits[maximum]), finite(key)))

    return {
        "x": bounded("x", "position_min", "position_max"),
        "y": bounded("y", "position_min", "position_max"),
        "width": bounded("width", "size_min", "size_max"),
        "height": bounded("height", "size_min", "size_max"),
        "scale": bounded("scale", "scale_min", "scale_max"),
        "rotation": bounded("rotation", "rotation_min", "rotation_max"),
        "opacity": bounded("opacity", "opacity_min", "opacity_max"),
    }


def scene_transform_pixels(
    transform: Any,
    canvas_width: int,
    canvas_height: int,
    *,
    defaults: dict[str, float] | None = None,
) -> dict[str, float]:
    normalized = normalize_scene_transform(transform, defaults)
    width = max(1, int(canvas_width))
    height = max(1, int(canvas_height))
    return {
        "x": normalized["x"] * width,
        "y": normalized["y"] * height,
        "width": normalized["width"] * width,
        "height": normalized["height"] * height,
        "rendered_width": normalized["width"] * normalized["scale"] * width,
        "rendered_height": normalized["height"] * normalized["scale"] * height,
    }


def ffmpeg_expr_time_variable(expression: str, variable: str = "T") -> str:
    return re.sub(r"\bt\b", variable, str(expression))


def scene_keyframe_expr(
    keyframes: Any,
    field: str,
    fallback: float,
    timeline_start: float,
    duration: float,
    *,
    defaults: dict[str, float] | None = None,
) -> tuple[str, bool]:
    """Return the exact linear interpolation expression used by preview."""
    if not isinstance(keyframes, list) or duration <= 0:
        return f"{fallback:.9f}", False
    values: list[tuple[float, float]] = []
    for item in keyframes:
        if not isinstance(item, dict) or not isinstance(item.get("transform"), dict):
            continue
        try:
            relative = max(0.0, min(duration, float(item.get("time_sec", 0))))
            transform = normalize_scene_transform(item["transform"], defaults)
            values.append((timeline_start + relative, transform[field]))
        except (KeyError, TypeError, ValueError):
            continue
    if not values:
        return f"{fallback:.9f}", False
    values.sort(key=lambda pair: pair[0])
    deduped: list[tuple[float, float]] = []
    for value in values:
        if deduped and abs(value[0] - deduped[-1][0]) < 1e-9:
            deduped[-1] = value
        else:
            deduped.append(value)
    if deduped[0][0] > timeline_start + 1e-9:
        deduped.insert(0, (timeline_start, deduped[0][1]))
    animated = any(abs(value - deduped[0][1]) > 1e-9 for _, value in deduped[1:])
    if len(deduped) == 1 or not animated:
        return f"{deduped[0][1]:.9f}", False
    expression = f"{deduped[-1][1]:.9f}"
    for (left_time, left_value), (right_time, right_value) in zip(
        reversed(deduped[:-1]),
        reversed(deduped[1:]),
    ):
        span = max(0.000001, right_time - left_time)
        expression = (
            f"if(lt(t\\,{right_time:.9f})\\,{left_value:.9f}+"
            f"({right_value:.9f}-{left_value:.9f})*(t-{left_time:.9f})/{span:.9f}\\,{expression})"
        )
    return expression, True


def scene_transform_expressions(
    transform: Any,
    keyframes: Any,
    timeline_start: float,
    duration: float,
    *,
    defaults: dict[str, float] | None = None,
) -> tuple[dict[str, str], set[str]]:
    normalized = normalize_scene_transform(transform, defaults)
    base = {**normalized}
    expressions: dict[str, str] = {}
    animated: set[str] = set()
    for field in ("x", "y", "width", "height", "scale", "rotation", "opacity"):
        expression, is_animated = scene_keyframe_expr(
            keyframes,
            field,
            base[field],
            timeline_start,
            duration,
            defaults=defaults,
        )
        expressions[field] = expression
        if is_animated:
            animated.add(field)
    return expressions, animated
