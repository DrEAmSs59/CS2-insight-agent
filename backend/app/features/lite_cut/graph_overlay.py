"""Image and overlay-video material preparation for the scene compositor."""

from __future__ import annotations

from typing import Any

from .graph_scene import _scene_composite_filter_complex
from .scene_transform import OVERLAY_SCENE_DEFAULTS


def _overlay_filter_complex(
    *,
    enable_expr: str,
    timeline_start: float,
    duration: float,
    transform: Any,
    video_input: bool,
    content_fit: str = "fill",
    blur_amount: int = 24,
    speed: float = 1.0,
    flip_horizontal: bool = False,
    flip_vertical: bool = False,
    keyframes: Any = None,
    source_filters: list[str] | None = None,
    reverse: bool = False,
    freeze_frame_sec: float = 0.0,
    speed_segments: list[tuple[float, float, float]] | None = None,
    canvas_width: int = 1920,
    canvas_height: int = 1080,
    transition_events: Any = None,
) -> str:
    """Prepare a file material, then use the same scene transform as all visuals."""
    del video_input  # Input timing differs by call site, geometry never does.
    start = max(0.0, float(timeline_start))
    overlay_speed = max(0.25, min(4.0, float(speed or 1.0)))
    filters = [str(item) for item in (source_filters or []) if str(item).strip()]
    if reverse:
        filters.append("reverse")
    filters.append("format=rgba")
    input_chain = ",".join(filters)
    freeze = max(0.0, min(30.0, float(freeze_frame_sec or 0.0)))
    events = [item for item in transition_events if isinstance(item, dict)] if isinstance(transition_events, list) else []
    authored_end = start + max(0.0, float(duration))
    render_start = min([start, *(float(item.get("start_sec") or start) for item in events)])
    render_end = max([authored_end, *(float(item.get("end_sec") or authored_end) for item in events)])
    pre_roll = max(0.0, start - render_start)
    post_roll = max(0.0, render_end - authored_end) + freeze
    hold_filter = ""
    if pre_roll > 0.000001 or post_roll > 0.000001:
        hold_filter = f",tpad=start_mode=clone:start_duration={pre_roll:.9f}:stop_mode=clone:stop_duration={post_roll:.9f}"
    valid_segments = [(a, b, s) for a, b, s in (speed_segments or []) if b - a > 0.000001]

    if valid_segments:
        labels: list[str] = []
        parts: list[str] = []
        for index, (segment_start, segment_end, segment_speed) in enumerate(valid_segments):
            label = f"[scene_segment_{index}]"
            labels.append(label)
            parts.append(
                f"[1:v]trim=start={segment_start:.9f}:end={segment_end:.9f},"
                f"setpts=PTS-STARTPTS,setpts=PTS/{segment_speed:.9f}{label}"
            )
        parts.append("".join(labels) + f"concat=n={len(labels)}:v=1:a=0[scene_ramp]")
        parts.append(
            f"[scene_ramp]{input_chain}{hold_filter},setpts=PTS-STARTPTS+{render_start:.9f}/TB[scene_material]"
        )
        material_graph = ";".join(parts)
    elif abs(overlay_speed - 1.0) > 0.000001:
        material_graph = (
            f"[1:v]{input_chain},setpts=(PTS-STARTPTS)/{overlay_speed:.9f}{hold_filter},"
            f"setpts=PTS-STARTPTS+{render_start:.9f}/TB[scene_material]"
        )
    else:
        material_graph = (
            f"[1:v]{input_chain}{hold_filter},setpts=PTS-STARTPTS+{render_start:.9f}/TB[scene_material]"
        )

    return _scene_composite_filter_complex(
        material_graph=material_graph,
        material_label="[scene_material]",
        transform=transform,
        keyframes=keyframes,
        enable_expr=enable_expr,
        timeline_start=start,
        duration=duration,
        canvas_width=canvas_width,
        canvas_height=canvas_height,
        content_fit=content_fit,
        blur_amount=blur_amount,
        defaults=OVERLAY_SCENE_DEFAULTS,
        flip_horizontal=flip_horizontal,
        flip_vertical=flip_vertical,
        transition_events=events,
    )
