"""Overlay transform and filter graph builders for LiteCut exports."""

from __future__ import annotations

import re
from typing import Any

from .timeline import _map_transition_type


def _ffmpeg_expr_time_variable(expression: str, variable: str = "T") -> str:
    """Translate filter expressions using ``t`` to filters that expose ``T``."""
    return re.sub(r"\bt\b", variable, str(expression))

def _overlay_layout_from_transform(tr: Any) -> tuple[float, float, float, float]:
    """Map the editor's centered transform coordinates into graph values."""
    data = tr if isinstance(tr, dict) else {}
    tx = float(data.get("x", 0.5))
    ty = float(data.get("y", 0.5))
    scale = float(data.get("scale", 0.38))
    width_frac = float(data.get("width", 0.33))
    rotation = float(data.get("rotation", 0))
    size_frac = max(0.01, min(10.0, width_frac * scale))
    return (
        max(0.0, min(1.0, tx)),
        max(0.0, min(1.0, ty)),
        size_frac,
        rotation,
    )

def _overlay_height_from_transform(tr: Any) -> float | None:
    """Return an explicit canvas-relative height when the editor stores one.

    Older projects only stored width, so ``None`` deliberately keeps the
    historical aspect-ratio-preserving export path for those projects.
    """
    data = tr if isinstance(tr, dict) else {}
    if "height" not in data:
        return None
    try:
        scale = float(data.get("scale", 1.0))
        height_frac = float(data.get("height", 1.0)) * scale
    except (TypeError, ValueError):
        return None
    return max(0.01, min(10.0, height_frac))

def _overlay_opacity_from_transform(tr: Any) -> float:
    data = tr if isinstance(tr, dict) else {}
    try:
        opacity = float(data.get("opacity", 1.0))
    except (TypeError, ValueError):
        opacity = 1.0
    return max(0.0, min(1.0, opacity))

def _overlay_keyframe_expr(keyframes: Any, field: str, fallback: float, timeline_start: float, duration: float) -> tuple[str, bool]:
    """Return a linear FFmpeg expression for a transform field and whether it animates."""
    if not isinstance(keyframes, list) or duration <= 0:
        return f"{fallback:.6f}", False
    values: list[tuple[float, float]] = []
    for item in keyframes:
        if not isinstance(item, dict) or not isinstance(item.get("transform"), dict):
            continue
        try:
            relative = max(0.0, min(duration, float(item.get("time_sec", 0))))
            tr = item["transform"]
            if field in {"size", "height_size"}:
                dimension = "height" if field == "height_size" else "width"
                default = fallback / max(0.01, float(tr.get("scale", 1.0)))
                value = float(tr.get(dimension, default)) * float(tr.get("scale", 1.0))
                value = max(0.01, min(10.0, value))
            elif field == "x" or field == "y":
                value = max(0.0, min(1.0, float(tr.get(field, fallback))))
            else:
                value = float(tr.get(field, fallback))
            values.append((timeline_start + relative, value))
        except (TypeError, ValueError):
            continue
    if not values:
        return f"{fallback:.6f}", False
    values.sort(key=lambda pair: pair[0])
    deduped: list[tuple[float, float]] = []
    for value in values:
        if deduped and abs(value[0] - deduped[-1][0]) < 1e-6:
            deduped[-1] = value
        else:
            deduped.append(value)
    # Preview holds the first keyframe value from the clip start; it does not
    # interpolate from the clip's base transform before that first keyframe.
    if deduped[0][0] > timeline_start + 1e-6:
        deduped.insert(0, (timeline_start, deduped[0][1]))
    animated = any(abs(value - deduped[0][1]) > 1e-7 for _, value in deduped[1:])
    if len(deduped) == 1 or not animated:
        return f"{deduped[0][1]:.6f}", False
    expr = f"{deduped[-1][1]:.6f}"
    for (left_t, left_value), (right_t, right_value) in zip(reversed(deduped[:-1]), reversed(deduped[1:])):
        span = max(0.0001, right_t - left_t)
        expr = (
            f"if(lt(t\\,{right_t:.6f})\\,{left_value:.6f}+({right_value:.6f}-{left_value:.6f})*"
            f"(t-{left_t:.6f})/{span:.6f}\\,{expr})"
        )
    return expr, True

def _overlay_filter_complex(
    *,
    enable_expr: str,
    timeline_start: float,
    duration: float,
    tx: float,
    ty: float,
    size_frac: float,
    rotation: float,
    height_frac: float | None = None,
    opacity: float = 1.0,
    fade_in: float = 0.0,
    fade_out: float = 0.0,
    video_input: bool,
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
    transition_in: Any = None,
    transition_out: Any = None,
) -> str:
    """Scale and position an overlay in canvas-relative editor coordinates."""
    start = max(0.0, float(timeline_start))
    dur = max(0.0, float(duration))
    fade_in = max(0.0, min(dur, float(fade_in)))
    fade_out = max(0.0, min(dur, float(fade_out)))
    overlay_speed = max(0.25, min(4.0, float(speed or 1.0)))
    input_filters = [str(item) for item in (source_filters or []) if str(item).strip()]
    if reverse:
        input_filters.append("reverse")
    input_filters.append("format=rgba")
    input_chain = ",".join(input_filters)
    freeze_frame_sec = max(0.0, min(30.0, float(freeze_frame_sec or 0.0)))
    freeze_filter = f",tpad=stop_mode=clone:stop_duration={freeze_frame_sec:.6f}" if freeze_frame_sec > 1e-6 else ""
    valid_segments = [(a, b, s) for a, b, s in (speed_segments or []) if b - a > 1e-6]
    if valid_segments:
        labels: list[str] = []
        ramp_parts: list[str] = []
        for index, (segment_start, segment_end, segment_speed) in enumerate(valid_segments):
            label = f"[ovs{index}]"
            labels.append(label)
            ramp_parts.append(
                f"[1:v]trim=start={segment_start:.6f}:end={segment_end:.6f},setpts=PTS-STARTPTS,setpts=PTS/{segment_speed:.6f}{label}"
            )
        ramp_parts.append("".join(labels) + f"concat=n={len(labels)}:v=1:a=0[ovramp]")
        src = f"{';'.join(ramp_parts)};[ovramp]{input_chain},setpts=PTS-STARTPTS+{start:.6f}/TB{freeze_filter}[ovin];[ovin]"
    elif abs(overlay_speed - 1.0) > 1e-6:
        src = f"[1:v]{input_chain},setpts=(PTS-STARTPTS)/{overlay_speed:.6f}+{start:.6f}/TB{freeze_filter}[ovin];[ovin]"
    else:
        src = f"[1:v]{input_chain},setpts=PTS-STARTPTS+{start:.6f}/TB{freeze_filter}[ovin];[ovin]"
    x_expr, dynamic_x = _overlay_keyframe_expr(keyframes, "x", tx, start, dur)
    y_expr, dynamic_y = _overlay_keyframe_expr(keyframes, "y", ty, start, dur)
    size_expr, dynamic_size = _overlay_keyframe_expr(keyframes, "size", size_frac, start, dur)
    height_expr = None
    dynamic_height = False
    if height_frac is not None:
        height_expr, dynamic_height = _overlay_keyframe_expr(keyframes, "height_size", height_frac, start, dur)
    rotation_expr, dynamic_rotation = _overlay_keyframe_expr(keyframes, "rotation", rotation, start, dur)
    opacity_expr, dynamic_opacity = _overlay_keyframe_expr(keyframes, "opacity", opacity, start, dur)
    tone_filters: list[str] = []
    wipe_masks: list[tuple[str, str]] = []
    transition_specs = [
        (transition_in if isinstance(transition_in, dict) else None, True),
        (transition_out if isinstance(transition_out, dict) else None, False),
    ]
    for spec, entering in transition_specs:
        if not spec:
            continue
        transition_type = _map_transition_type(str(spec.get("type") or "cut"))
        transition_duration = max(0.0, min(dur, float(spec.get("duration_sec") or 0)))
        if transition_type in {"cut", "none"} or transition_duration <= 1e-6:
            continue
        factor = (
            f"clip((t-{start:.6f})/{transition_duration:.6f}\\,0\\,1)"
            if entering
            else f"clip(({start + dur:.6f}-t)/{transition_duration:.6f}\\,0\\,1)"
        )
        geq_factor = (
            f"clip((T-{start:.6f})/{transition_duration:.6f}\\,0\\,1)"
            if entering
            else f"clip(({start + dur:.6f}-T)/{transition_duration:.6f}\\,0\\,1)"
        )
        if transition_type in {"fade", "flash", "dip_black", "zoom"}:
            if entering:
                fade_in = max(fade_in, transition_duration)
            else:
                fade_out = max(fade_out, transition_duration)
        midpoint = f"(1-abs(2*({factor})-1))"
        if transition_type == "flash":
            tone_filters.append(f"eq=brightness='0.85*{midpoint}':eval=frame")
        elif transition_type == "dip_black":
            tone_filters.append(f"eq=brightness='-0.95*{midpoint}':eval=frame")
        if transition_type == "zoom":
            size_expr = f"({size_expr})*(0.82+0.18*({factor}))"
            if height_expr is not None:
                height_expr = f"({height_expr})*(0.82+0.18*({factor}))"
            dynamic_size = True
        offset = f"(1-({factor}))"
        if transition_type == "wipe_l":
            wipe_masks.append(("right", geq_factor))
        elif transition_type == "wipe_r":
            wipe_masks.append(("left", geq_factor))
        elif transition_type == "slide_left":
            x_expr = f"({x_expr})+({offset})*({size_expr})"
            dynamic_x = True
        elif transition_type == "slide_right":
            x_expr = f"({x_expr})-({offset})*({size_expr})"
            dynamic_x = True
        elif transition_type == "slide_up":
            vertical_span = height_expr if height_expr is not None else size_expr
            y_expr = f"({y_expr})+({offset})*({vertical_span})"
            dynamic_y = True
        elif transition_type == "slide_down":
            vertical_span = height_expr if height_expr is not None else size_expr
            y_expr = f"({y_expr})-({offset})*({vertical_span})"
            dynamic_y = True
    scale_eval = ":eval=frame" if dynamic_size or dynamic_height else ""
    if height_expr is None:
        scale2ref = (
            f"{src}scale=w='{int(canvas_width)}*({size_expr})':h=-2{scale_eval}[ovraw];"
            f"[0:v]null[vbase];"
        )
    else:
        scale2ref = (
            f"{src}scale=w='{int(canvas_width)}*({size_expr})':h='{int(canvas_height)}*({height_expr})'"
            f"{scale_eval}[ovraw];[0:v]null[vbase];"
        )
    constant_rotation = float(rotation_expr) if not dynamic_rotation else rotation
    if dynamic_rotation or abs(constant_rotation) > 0.5:
        angle = (
            f"({rotation_expr})*PI/180"
            if dynamic_rotation
            else f"{constant_rotation * 3.141592653589793 / 180.0:.6f}"
        )
        chain = f"{scale2ref}[ovraw]rotate='{angle}':c=none:ow=rotw:oh=roth[ovbase];"
    else:
        chain = f"{scale2ref}[ovraw]null[ovbase];"
    overlay_source = "[ovbase]"
    flips = [name for enabled, name in ((flip_horizontal, "hflip"), (flip_vertical, "vflip")) if enabled]
    if flips:
        chain += f"{overlay_source}{','.join(flips)}[ovflip];"
        overlay_source = "[ovflip]"
    if wipe_masks:
        alpha_expr = "alpha(X,Y)"
        for direction, factor in wipe_masks:
            if direction == "left":
                alpha_expr += f"*lte(X/W\\,{factor})"
            else:
                alpha_expr += f"*gte(X/W\\,1-({factor}))"
        chain += (
            f"{overlay_source}format=rgba,geq="
            f"r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='{alpha_expr}'[ovwipe];"
        )
        overlay_source = "[ovwipe]"
    if tone_filters:
        chain += f"{overlay_source}{','.join(tone_filters)}[ovtone];"
        overlay_source = "[ovtone]"
    if dynamic_opacity:
        opacity_geq = _ffmpeg_expr_time_variable(opacity_expr)
        chain += (
            f"{overlay_source}format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':"
            f"a='alpha(X,Y)*({opacity_geq})'[ov];"
        )
    elif float(opacity_expr) < 0.999:
        chain += f"{overlay_source}format=rgba,colorchannelmixer=aa={float(opacity_expr):.6f}[ov];"
    else:
        chain += f"{overlay_source}format=rgba[ov];"
    overlay_label = "[ov]"
    if fade_in > 0:
        chain += f"{overlay_label}fade=t=in:st={start:.6f}:d={fade_in:.6f}:alpha=1[ovfi];"
        overlay_label = "[ovfi]"
    if fade_out > 0:
        out_start = max(start, start + dur - fade_out)
        chain += f"{overlay_label}fade=t=out:st={out_start:.6f}:d={fade_out:.6f}:alpha=1[ovfo];"
        overlay_label = "[ovfo]"
    position_x = f"main_w*({x_expr})-w/2" if dynamic_x else f"main_w*{float(x_expr):.6f}-w/2"
    position_y = f"main_h*({y_expr})-h/2" if dynamic_y else f"main_h*{float(y_expr):.6f}-h/2"
    return (
        f"{chain}"
        f"[vbase]{overlay_label}overlay=x='{position_x}':y='{position_y}'"
        f":enable='{enable_expr}'[vout]"
    )


