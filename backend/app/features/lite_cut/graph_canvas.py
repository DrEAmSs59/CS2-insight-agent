"""Main-track material composition through the canonical scene compositor."""

from __future__ import annotations

from typing import Any

from .graph_scene import _scene_composite_filter_complex
from .scene_transform import VIDEO_SCENE_DEFAULTS


def _clip_canvas_transform_graph(
    input_label: str,
    output_label: str,
    *,
    clip: dict[str, Any],
    source_filter: str,
    content_fit: str,
    width: int,
    height: int,
    fps: float,
    duration: float,
    background_color: str,
    blur_amount: int = 24,
) -> str:
    """Render a main video as a scene node, identically to upper layers."""
    fps_value = f"{fps:.9f}".rstrip("0").rstrip(".")
    material_filter = str(source_filter or "format=rgba").strip(",")
    material_graph = f"{input_label}{material_filter}[scene_material]"
    canvas_graph = (
        f"color=c={background_color}:s={int(width)}x{int(height)}:r={fps_value}:"
        f"d={max(0.1, duration):.9f},format=rgba[scene_canvas]"
    )
    scene_graph = _scene_composite_filter_complex(
        material_graph=material_graph,
        material_label="[scene_material]",
        transform=clip.get("transform"),
        keyframes=clip.get("keyframes"),
        enable_expr=f"between(t,0,{max(0.0, duration):.9f})",
        timeline_start=0.0,
        duration=duration,
        canvas_width=width,
        canvas_height=height,
        content_fit=content_fit,
        blur_amount=blur_amount,
        base_label="[scene_canvas]",
        output_label="[scene_composited]",
        defaults=VIDEO_SCENE_DEFAULTS,
        flip_horizontal=bool(clip.get("flip_horizontal")),
        flip_vertical=bool(clip.get("flip_vertical")),
        transition_events=clip.get("_transition_events") if isinstance(clip.get("_transition_events"), list) else [],
    )
    return f"{canvas_graph};{scene_graph};[scene_composited]format=yuv420p{output_label}"
