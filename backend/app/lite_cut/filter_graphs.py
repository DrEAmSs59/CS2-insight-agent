"""Pure FFmpeg filter-graph builders used by LiteCut exports."""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path
from typing import Any, Optional

from .effect_contract import filter_preset_ffmpeg_map, normalize_video_layer_transform
from .timeline import (
    _clip_audio_fade,
    _clip_canvas_fit,
    _clip_crop_filter,
    _clip_duration_sec,
    _clip_freeze_frame_sec,
    _clip_has_speed_ramp,
    _clip_preserve_pitch,
    _clip_reverse,
    _clip_speed,
    _clip_speed_segments,
    _clip_timeline_duration_sec,
    _clip_video_fade,
    _clip_visual_fade,
    _clip_volume,
    _clip_volume_filter,
    _map_transition_type,
)
from ..video_composer import _xfade_transition_name

_FILTER_PRESET_VF = filter_preset_ffmpeg_map()


def _ffmpeg_expr_time_variable(expression: str, variable: str = "T") -> str:
    """Translate filter expressions using ``t`` to filters that expose ``T``."""
    return re.sub(r"\bt\b", variable, str(expression))


def _atempo_chain(speed: float) -> list[str]:
    remaining = max(0.25, min(4.0, float(speed or 1.0)))
    parts: list[str] = []
    while remaining > 2.0 + 1e-6:
        parts.append("atempo=2.000000")
        remaining /= 2.0
    while remaining < 0.5 - 1e-6:
        parts.append("atempo=0.500000")
        remaining /= 0.5
    parts.append(f"atempo={remaining:.6f}")
    return parts


def _pitch_shift_speed_chain(speed: float) -> list[str]:
    bounded = max(0.25, min(4.0, float(speed or 1.0)))
    return [
        "aresample=48000",
        f"asetrate={48000 * bounded:.6f}",
        "aresample=48000",
    ]


def _audio_filter_chain(speed: float, volume: float, reverse: bool = False, preserve_pitch: bool = True, volume_filter: str | None = None, freeze_frame_sec: float = 0.0) -> str:
    parts: list[str] = []
    if reverse:
        parts.append("areverse")
    if abs(speed - 1.0) > 1e-6:
        parts.extend(_atempo_chain(speed) if preserve_pitch else _pitch_shift_speed_chain(speed))
    if volume_filter:
        parts.append(volume_filter)
    elif abs(volume - 1.0) > 1e-6:
        parts.append(f"volume={volume:.6f}")
    if freeze_frame_sec > 1e-6:
        parts.append(f"apad=pad_dur={max(0.0, min(30.0, freeze_frame_sec)):.6f}")
    return ",".join(parts)


def _user_eq_filter(color: dict[str, Any]) -> str:
    """用户滑条（brightness/contrast/saturation）→ eq。"""
    try:
        b = 1.0 + float(color.get("brightness") or 0) / 100.0
        c = 1.0 + float(color.get("contrast") or 0) / 100.0
        s = 1.0 + float(color.get("saturation") or 0) / 100.0
    except (TypeError, ValueError):
        return ""
    if abs(b - 1) < 1e-6 and abs(c - 1) < 1e-6 and abs(s - 1) < 1e-6:
        return ""
    parts: list[str] = []
    # CSS preview brightness is an RGB multiplier, while FFmpeg eq brightness
    # is an additive offset. Use the same multiplier semantics as the preview
    # to avoid highlights being blown out on export.
    if abs(b - 1) >= 1e-6:
        parts.append(f"colorchannelmixer=rr={b:.4f}:gg={b:.4f}:bb={b:.4f}")
    if abs(c - 1) >= 1e-6 or abs(s - 1) >= 1e-6:
        parts.append(f"eq=contrast={c:.4f}:saturation={s:.4f}")
    return ",".join(parts)


def _build_color_vf(color: Optional[dict[str, Any]]) -> str:
    """滤镜预设 + 用户滑条，链式 vf。"""
    if not color or not isinstance(color, dict):
        return ""
    parts: list[str] = []
    preset = str(color.get("filter_preset") or "").strip().lower()
    if preset and preset not in ("none", ""):
        pvf = _FILTER_PRESET_VF.get(preset)
        if pvf:
            parts.append(pvf)
    user = _user_eq_filter(color)
    if user:
        parts.append(user)
    return ",".join(parts)


def _eq_filter(color: Optional[dict[str, Any]]) -> str:
    return _build_color_vf(color)


def _clip_video_filter_chain(
    clip: dict[str, Any],
    *,
    width: int,
    height: int,
    fps: float,
    canvas_fit: str = "contain",
    background_color: str = "black",
    blur_amount: int = 24,
    timeline_duration_override: float | None = None,
) -> str:
    speed = 1.0 if _clip_has_speed_ramp(clip) else _clip_speed(clip)
    timeline_duration = max(0.1, float(timeline_duration_override)) if timeline_duration_override is not None else _clip_timeline_duration_sec(clip)
    fade_in = _clip_video_fade(clip, "fade_in_sec")
    fade_out = _clip_video_fade(clip, "fade_out_sec")
    fps_s = f"{fps:.4f}".rstrip("0").rstrip(".")
    fit = _clip_canvas_fit(clip, canvas_fit)
    crop_filter = _clip_crop_filter(clip)
    if fit == "cover":
        vf_parts = ([crop_filter] if crop_filter else []) + [
            f"scale={width}:{height}:force_original_aspect_ratio=increase",
            f"crop={width}:{height}",
            f"fps={fps_s}",
            "setsar=1",
            "format=yuv420p",
        ]
    elif fit == "blur":
        sigma = max(4, min(80, int(blur_amount or 24)))
        vf_parts = ([crop_filter] if crop_filter else []) + [
            (
                f"split=2[fg][bg];"
                f"[bg]scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},gblur=sigma={sigma}[bgfit];"
                f"[fg]scale={width}:{height}:force_original_aspect_ratio=decrease[fgfit];"
                f"[bgfit][fgfit]overlay=(W-w)/2:(H-h)/2"
            ),
            f"fps={fps_s}",
            "setsar=1",
            "format=yuv420p",
        ]
    else:
        vf_parts = ([crop_filter] if crop_filter else []) + [
            f"scale={width}:{height}:force_original_aspect_ratio=decrease",
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color={background_color}",
            f"fps={fps_s}",
            "setsar=1",
            "format=yuv420p",
        ]
    if clip.get("flip_horizontal"):
        vf_parts.append("hflip")
    if clip.get("flip_vertical"):
        vf_parts.append("vflip")
    eq = _eq_filter(clip.get("color") if isinstance(clip.get("color"), dict) else None)
    if eq:
        vf_parts.append(eq)
    if _clip_reverse(clip):
        vf_parts.append("reverse")
    if abs(speed - 1.0) > 1e-6:
        vf_parts.append(f"setpts=PTS/{speed:.6f}")
    freeze_frame_sec = _clip_freeze_frame_sec(clip)
    if freeze_frame_sec > 1e-6:
        vf_parts.append(f"tpad=stop_mode=clone:stop_duration={freeze_frame_sec:.6f}")
    if fade_in > 0:
        vf_parts.append(f"fade=t=in:st=0:d={fade_in:.6f}")
    if fade_out > 0:
        vf_parts.append(f"fade=t=out:st={max(0.0, timeline_duration - fade_out):.6f}:d={fade_out:.6f}")
    return ",".join(vf_parts)


def _clip_canvas_transform_graph(
    input_label: str,
    output_label: str,
    *,
    clip: dict[str, Any],
    fitted_filter: str,
    width: int,
    height: int,
    fps: float,
    duration: float,
    background_color: str,
    transition_in_background: bool = False,
    transition_out_background: bool = False,
) -> str:
    """Place a normalized main-track clip using the editor's canvas coordinates."""
    tr = normalize_video_layer_transform(clip.get("transform"))
    tx = tr["x"]
    ty = tr["y"]
    scale = tr["scale"]
    width_frac = tr["width"] * scale
    height_frac = tr["height"] * scale
    rotation = tr["rotation"]
    opacity = tr["opacity"]
    keyframes = clip.get("keyframes")
    x_expr, dynamic_x = _overlay_keyframe_expr(keyframes, "x", tx, 0.0, duration)
    y_expr, dynamic_y = _overlay_keyframe_expr(keyframes, "y", ty, 0.0, duration)
    width_expr, dynamic_width = _overlay_keyframe_expr(keyframes, "size", width_frac, 0.0, duration)
    height_expr, dynamic_height = _overlay_keyframe_expr(keyframes, "height_size", height_frac, 0.0, duration)
    rotation_expr, dynamic_rotation = _overlay_keyframe_expr(keyframes, "rotation", rotation, 0.0, duration)
    opacity_expr, dynamic_opacity = _overlay_keyframe_expr(keyframes, "opacity", opacity, 0.0, duration)
    dynamic_transform = dynamic_x or dynamic_y or dynamic_width or dynamic_height or dynamic_rotation or dynamic_opacity
    fps_s = f"{fps:.4f}".rstrip("0").rstrip(".")
    if dynamic_width or dynamic_height:
        object_filters = (
            f"scale=w='max(2\\,trunc({width}*({width_expr})/2)*2)':"
            f"h='max(2\\,trunc({height}*({height_expr})/2)*2)':eval=frame,format=rgba"
        )
    else:
        target_w = max(2, int(round(width * float(width_expr) / 2) * 2))
        target_h = max(2, int(round(height * float(height_expr) / 2) * 2))
        object_filters = f"scale={target_w}:{target_h},format=rgba"
    if dynamic_opacity:
        opacity_geq = _ffmpeg_expr_time_variable(opacity_expr)
        object_filters += (
            ",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':"
            f"a='alpha(X,Y)*({opacity_geq})'"
        )
    else:
        object_filters += f",colorchannelmixer=aa={float(opacity_expr):.6f}"
    if dynamic_rotation:
        object_filters += (
            f",rotate=angle='({rotation_expr})*PI/180':c=none:"
            "ow='hypot(iw,ih)':oh='hypot(iw,ih)'"
        )
    elif abs(float(rotation_expr)) > 0.001:
        angle = float(rotation_expr) * 3.141592653589793 / 180.0
        object_filters += f",rotate={angle:.8f}:c=none:ow='rotw({angle:.8f})':oh='roth({angle:.8f})'"
    parts = [
        f"{input_label}{fitted_filter},{object_filters}[obj]",
        f"color=c={background_color}:s={width}x{height}:r={fps_s}:d={max(0.1, duration):.6f}[canvas]",
        (
            f"[canvas][obj]overlay=x='W*({x_expr})-w/2':y='H*({y_expr})-h/2':"
            f"eval={'frame' if dynamic_transform else 'init'}:shortest=1,format=yuv420p[scene]"
        ),
    ]
    parts.extend(_background_boundary_transition_parts(
        clip,
        scene_label="[scene]",
        output_label=output_label,
        width=width,
        height=height,
        fps=fps,
        duration=duration,
        background_color=background_color,
        apply_in=transition_in_background,
        apply_out=transition_out_background,
    ))
    return ";".join(parts)


def _background_boundary_transition_parts(
    clip: dict[str, Any],
    *,
    scene_label: str,
    output_label: str,
    width: int,
    height: int,
    fps: float,
    duration: float,
    background_color: str,
    apply_in: bool,
    apply_out: bool,
) -> list[str]:
    """Transition a first/last clip against the project canvas background."""
    total = max(0.1, float(duration))
    incoming = clip.get("transition_in") if isinstance(clip.get("transition_in"), dict) else None
    outgoing = clip.get("transition_out") if isinstance(clip.get("transition_out"), dict) else None
    in_type = _map_transition_type(str((incoming or {}).get("type") or "cut"))
    out_type = _map_transition_type(str((outgoing or {}).get("type") or "cut"))
    in_d = max(0.0, float((incoming or {}).get("duration_sec") or 0)) if apply_in and in_type not in {"cut", "none"} else 0.0
    out_d = max(0.0, float((outgoing or {}).get("duration_sec") or 0)) if apply_out and out_type not in {"cut", "none"} else 0.0
    if in_d + out_d > total * 0.9:
        factor = total * 0.9 / max(in_d + out_d, 1e-6)
        in_d *= factor
        out_d *= factor
    if in_d <= 1e-6 and out_d <= 1e-6:
        return [f"{scene_label}null{output_label}"]
    fps_s = f"{fps:.4f}".rstrip("0").rstrip(".")
    labels = []
    parts: list[str] = []
    split_count = (1 if in_d > 1e-6 else 0) + (1 if total - in_d - out_d > 1e-6 else 0) + (1 if out_d > 1e-6 else 0)
    split_labels = [f"[scene{i}]" for i in range(split_count)]
    parts.append(f"{scene_label}split={split_count}{''.join(split_labels)}")
    cursor = 0
    if in_d > 1e-6:
        source = split_labels[cursor]; cursor += 1
        parts.append(f"{source}trim=0:{in_d:.6f},setpts=PTS-STARTPTS,settb=AVTB[inclip]")
        parts.append(f"color=c={background_color}:s={width}x{height}:r={fps_s}:d={in_d:.6f},settb=AVTB[bg_in]")
        parts.append(f"[bg_in][inclip]xfade=transition={_xfade_transition_name(in_type)}:duration={in_d:.6f}:offset=0[vin]")
        labels.append("[vin]")
    middle = total - in_d - out_d
    if middle > 1e-6:
        source = split_labels[cursor]; cursor += 1
        parts.append(f"{source}trim=start={in_d:.6f}:end={total - out_d:.6f},setpts=PTS-STARTPTS[mid]")
        labels.append("[mid]")
    if out_d > 1e-6:
        source = split_labels[cursor]
        parts.append(f"{source}trim=start={total - out_d:.6f}:end={total:.6f},setpts=PTS-STARTPTS,settb=AVTB[outclip]")
        parts.append(f"color=c={background_color}:s={width}x{height}:r={fps_s}:d={out_d:.6f},settb=AVTB[bg_out]")
        parts.append(f"[outclip][bg_out]xfade=transition={_xfade_transition_name(out_type)}:duration={out_d:.6f}:offset=0[voutro]")
        labels.append("[voutro]")
    parts.append(f"{''.join(labels)}concat=n={len(labels)}:v=1:a=0,format=yuv420p{output_label}")
    return parts


def _overlay_layout_from_transform(tr: Any) -> tuple[float, float, float, float]:
    """与前端预览一致：中心锚点 (x,y)、宽度占比 width*scale、旋转角度。"""
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
            wipe_masks.append(("left", geq_factor))
        elif transition_type == "wipe_r":
            wipe_masks.append(("right", geq_factor))
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


def _default_text_font_file() -> str:
    font = Path(__file__).resolve().parents[2] / "assets" / "fonts" / "NotoSansSC-Bold.ttf"
    return str(font) if font.is_file() else ""


def _builtin_text_font_file(font_family: str) -> str:
    normalized_family = str(font_family or "").strip().lower()
    filename = {
        "noto sans sc": "NotoSansSC-Bold.ttf",
        "思源黑体 medium": "NotoSansSC-Medium.ttf",
        # Legacy projects using Rajdhani are intentionally rendered with the
        # stable Chinese fallback after Rajdhani was removed from LiteCut.
        "rajdhani bold": "NotoSansSC-Bold.ttf",
        "rajdhani": "NotoSansSC-Bold.ttf",
    }.get(normalized_family)
    system_filename = {
        "微软雅黑": "msyhbd.ttc",
        "impact": "impact.ttf",
    }.get(normalized_family)
    if system_filename:
        windows_font = Path(os.environ.get("WINDIR", r"C:\\Windows")) / "Fonts" / system_filename
        if windows_font.is_file():
            return str(windows_font)
    if not filename:
        return _default_text_font_file()
    path = Path(__file__).resolve().parents[2] / "assets" / "fonts" / filename
    return str(path) if path.is_file() else _default_text_font_file()


def _ascii_ffmpeg_font_cache_dir() -> Path:
    """Return a writable ASCII-only directory for FFmpeg drawtext fonts.

    Some Windows FFmpeg/fontconfig builds crash when ``fontfile`` contains a
    non-ASCII path, even though FreeType can read the same font.  LiteCut
    project directories commonly contain Chinese project names, so imported
    fonts must be staged outside the project directory for export.
    """
    candidates: list[Path] = []
    program_data = str(os.environ.get("PROGRAMDATA") or "").strip()
    if program_data:
        candidates.append(Path(program_data) / "CS2InsightAgent" / "FontCache")
    public_dir = str(os.environ.get("PUBLIC") or "").strip()
    if public_dir:
        candidates.append(Path(public_dir) / "Documents" / "CS2InsightAgent" / "FontCache")
    candidates.append(Path(tempfile.gettempdir()) / "cs2_insight_font_cache")

    for candidate in candidates:
        try:
            str(candidate).encode("ascii")
            candidate.mkdir(parents=True, exist_ok=True)
            probe_fd, probe_name = tempfile.mkstemp(prefix="write_", suffix=".tmp", dir=str(candidate))
            os.close(probe_fd)
            Path(probe_name).unlink(missing_ok=True)
            return candidate
        except (OSError, UnicodeEncodeError):
            continue
    raise OSError("No writable ASCII-only font cache directory is available")


def _stage_custom_font_for_ffmpeg(font_file: str, *, cache_dir: Path | None = None) -> Path:
    """Copy an imported font to an ASCII-only path understood by FFmpeg."""
    import shutil

    source = Path(str(font_file or "")).expanduser().resolve()
    if not source.is_file():
        raise FileNotFoundError(str(source))
    target_dir = Path(cache_dir) if cache_dir is not None else _ascii_ffmpeg_font_cache_dir()
    target_dir.mkdir(parents=True, exist_ok=True)
    str(target_dir).encode("ascii")
    suffix = source.suffix.lower() if source.suffix.lower() in {".ttf", ".otf", ".ttc", ".woff", ".woff2"} else ".ttf"
    fd, target_name = tempfile.mkstemp(prefix="litecut_font_", suffix=suffix, dir=str(target_dir))
    os.close(fd)
    target = Path(target_name)
    try:
        shutil.copy2(source, target)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return target


def _escape_drawtext_value(value: str) -> str:
    return (
        str(value or "")
        .replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace("%", "\\%")
        .replace("\n", "\\n")
    )


def _ffmpeg_filter_path(path: str) -> str:
    return str(path).replace("\\", "/").replace(":", "\\:")


def _text_style_drawtext_options(preset_id: str) -> list[str]:
    preset = str(preset_id or "plain").strip().lower()
    color = {
        "ace": "0xfbbf24",
        "clutch": "0x67e8f9",
        "creator": "0xfde047",
        "retro": "0xf0abfc",
        "bubble": "0x111827",
        "plain": "white",
        "large-title": "white",
        "namecard": "white",
    }.get(preset, "white")
    opts = [f"fontcolor={color}", "borderw=3", "bordercolor=black@0.72"]
    if preset == "bubble":
        opts.extend(["box=1", "boxcolor=white@0.95", "boxborderw=18"])
    return opts


def _drawtext_alpha_expr(text_clip: dict[str, Any], opacity: float) -> str | None:
    text = text_clip.get("text") if isinstance(text_clip.get("text"), dict) else {}
    start = max(0.0, float(text_clip.get("timeline_start") or 0))
    duration = _clip_duration_sec(text_clip)
    end = start + duration
    fade_in = _clip_visual_fade(text_clip, "fade_in_sec")
    fade_out = _clip_visual_fade(text_clip, "fade_out_sec")
    anim_dur = min(0.45, duration)
    if str(text.get("anim_in") or "").strip().lower() == "fade":
        fade_in = max(fade_in, anim_dur)
    if str(text.get("anim_out") or "").strip().lower() == "fade":
        fade_out = max(fade_out, anim_dur)
    # Text uses a drawtext-compatible version of clip transitions. Slides are
    # represented by the position expression below; all other transition
    # styles fade text so preview and export keep the same visible timing.
    transition_in = text_clip.get("transition_in") if isinstance(text_clip.get("transition_in"), dict) else None
    transition_out = text_clip.get("transition_out") if isinstance(text_clip.get("transition_out"), dict) else None
    slide_types = {"slide_left", "slide_right", "slide_up", "slide_down"}
    def transition_duration(spec: dict[str, Any] | None) -> float:
        try:
            return min(duration, max(0.0, float((spec or {}).get("duration_sec") or 0)))
        except (TypeError, ValueError):
            return 0.0

    if transition_in and _map_transition_type(str(transition_in.get("type") or "cut")) not in slide_types:
        fade_in = max(fade_in, transition_duration(transition_in))
    if transition_out and _map_transition_type(str(transition_out.get("type") or "cut")) not in slide_types:
        fade_out = max(fade_out, transition_duration(transition_out))
    if opacity >= 0.999 and fade_in <= 0 and fade_out <= 0:
        return None
    expr = f"{opacity:.6f}"
    if fade_in > 0:
        expr = f"if(lt(t\\,{start + fade_in:.6f})\\,{opacity:.6f}*(t-{start:.6f})/{fade_in:.6f}\\,{expr})"
    if fade_out > 0:
        out_start = max(start, end - fade_out)
        expr = f"if(gt(t\\,{out_start:.6f})\\,{opacity:.6f}*({end:.6f}-t)/{fade_out:.6f}\\,{expr})"
    return f"'{expr}'"


def _drawtext_position_expr(text_clip: dict[str, Any], tx: float, ty: float) -> tuple[str, str]:
    text = text_clip.get("text") if isinstance(text_clip.get("text"), dict) else {}
    start = max(0.0, float(text_clip.get("timeline_start") or 0))
    duration = _clip_duration_sec(text_clip)
    end = start + duration
    anim_dur = min(0.45, duration)
    x_expr = f"w*{tx:.6f}-text_w/2"
    y_expr = f"h*{ty:.6f}-text_h/2"
    if anim_dur <= 0:
        return x_expr, y_expr

    def apply_slide_in(expr: str, offset: str, anim: str, axis: str) -> str:
        if anim not in {"slide_left", "slide_right", "slide_up", "slide_down"}:
            return expr
        sign = 1 if anim in {"slide_left", "slide_up"} else -1
        moved = f"{expr}{'+' if sign > 0 else '-'}{offset}*(1-(t-{start:.6f})/{anim_dur:.6f})"
        return f"if(lt(t\\,{start + anim_dur:.6f})\\,{moved}\\,{expr})" if axis in anim else expr

    def apply_slide_out(expr: str, offset: str, anim: str, axis: str) -> str:
        if anim not in {"slide_left", "slide_right", "slide_up", "slide_down"}:
            return expr
        sign = -1 if anim in {"slide_left", "slide_up"} else 1
        out_start = max(start, end - anim_dur)
        moved = f"{expr}{'+' if sign > 0 else '-'}{offset}*((t-{out_start:.6f})/{anim_dur:.6f})"
        return f"if(gt(t\\,{out_start:.6f})\\,{moved}\\,{expr})" if axis in anim else expr

    anim_in = str(text.get("anim_in") or "").strip().lower()
    anim_out = str(text.get("anim_out") or "").strip().lower()
    x_expr = apply_slide_in(x_expr, "w*0.120000", anim_in, "left") if "left" in anim_in or "right" in anim_in else x_expr
    x_expr = apply_slide_in(x_expr, "w*0.120000", anim_in, "right") if "left" in anim_in or "right" in anim_in else x_expr
    y_expr = apply_slide_in(y_expr, "h*0.100000", anim_in, "up") if "up" in anim_in or "down" in anim_in else y_expr
    y_expr = apply_slide_in(y_expr, "h*0.100000", anim_in, "down") if "up" in anim_in or "down" in anim_in else y_expr
    x_expr = apply_slide_out(x_expr, "w*0.120000", anim_out, "left") if "left" in anim_out or "right" in anim_out else x_expr
    x_expr = apply_slide_out(x_expr, "w*0.120000", anim_out, "right") if "left" in anim_out or "right" in anim_out else x_expr
    y_expr = apply_slide_out(y_expr, "h*0.100000", anim_out, "up") if "up" in anim_out or "down" in anim_out else y_expr
    y_expr = apply_slide_out(y_expr, "h*0.100000", anim_out, "down") if "up" in anim_out or "down" in anim_out else y_expr

    def apply_transition_slide(expr: str, offset: str, spec: dict[str, Any] | None, axis: str, entering: bool) -> str:
        if not spec:
            return expr
        transition_type = _map_transition_type(str(spec.get("type") or "cut"))
        if axis not in transition_type or transition_type not in {"slide_left", "slide_right", "slide_up", "slide_down"}:
            return expr
        try:
            transition_duration = max(0.0, min(duration, float(spec.get("duration_sec") or 0)))
        except (TypeError, ValueError):
            transition_duration = 0.0
        if transition_duration <= 0:
            return expr
        # Incoming left/up transitions begin on the positive side; outgoing
        # transitions leave in their named direction. This mirrors
        # textTransitionPreviewVisual in the editor.
        if entering:
            sign = 1 if transition_type in {"slide_left", "slide_up"} else -1
            moved = f"{expr}{'+' if sign > 0 else '-'}{offset}*(1-(t-{start:.6f})/{transition_duration:.6f})"
            return f"if(lt(t\\,{start + transition_duration:.6f})\\,{moved}\\,{expr})"
        sign = -1 if transition_type in {"slide_left", "slide_up"} else 1
        out_start = max(start, end - transition_duration)
        moved = f"{expr}{'+' if sign > 0 else '-'}{offset}*((t-{out_start:.6f})/{transition_duration:.6f})"
        return f"if(gt(t\\,{out_start:.6f})\\,{moved}\\,{expr})"

    transition_in = text_clip.get("transition_in") if isinstance(text_clip.get("transition_in"), dict) else None
    transition_out = text_clip.get("transition_out") if isinstance(text_clip.get("transition_out"), dict) else None
    x_expr = apply_transition_slide(x_expr, "w*0.120000", transition_in, "left", True)
    x_expr = apply_transition_slide(x_expr, "w*0.120000", transition_in, "right", True)
    y_expr = apply_transition_slide(y_expr, "h*0.100000", transition_in, "up", True)
    y_expr = apply_transition_slide(y_expr, "h*0.100000", transition_in, "down", True)
    x_expr = apply_transition_slide(x_expr, "w*0.120000", transition_out, "left", False)
    x_expr = apply_transition_slide(x_expr, "w*0.120000", transition_out, "right", False)
    y_expr = apply_transition_slide(y_expr, "h*0.100000", transition_out, "up", False)
    y_expr = apply_transition_slide(y_expr, "h*0.100000", transition_out, "down", False)
    return x_expr, y_expr


def _drawtext_filter_complex(*, text_clip: dict[str, Any], enable_expr: str, canvas_width: int = 1920, canvas_height: int = 1080) -> str:
    text = text_clip.get("text") if isinstance(text_clip.get("text"), dict) else {}
    meta = text_clip.get("meta") if isinstance(text_clip.get("meta"), dict) else {}
    transform = text_clip.get("transform") if isinstance(text_clip.get("transform"), dict) else {}
    tx = max(0.0, min(1.0, float(transform.get("x", 0.5))))
    ty = max(0.0, min(1.0, float(transform.get("y", 0.22))))
    scale = max(0.1, min(4.0, float(transform.get("scale", 1.0))))
    box_height = max(0.02, min(10.0, float(transform.get("height", 0.18))))
    box_width = max(0.02, min(10.0, float(transform.get("width", 0.65))))
    base_font_size = float(text.get("font_size") or 64)
    content = _escape_drawtext_value(str(text.get("content") or meta.get("name") or "Text"))
    # font_size is stored in output-canvas pixels. The browser preview scales
    # those pixels with the canvas; export must use the exact same value.
    font_size = max(1, min(2000, int(round(base_font_size * scale))))
    preset_id = str(text.get("preset_id") or meta.get("textStyleId") or "plain")
    font_file = str(text.get("font_file") or "").strip() or _builtin_text_font_file(str(text.get("font_family") or ""))
    opacity = _overlay_opacity_from_transform(transform)
    x_expr, y_expr = _drawtext_position_expr(text_clip, tx, ty)
    opts = [
        f"text='{content}'",
        f"fontsize={font_size}",
        f"x='{x_expr}'",
        f"y='{y_expr}'",
        f"enable='{enable_expr}'",
        *_text_style_drawtext_options(preset_id),
    ]
    alpha_expr = _drawtext_alpha_expr(text_clip, opacity)
    if alpha_expr:
        opts.append(f"alpha={alpha_expr}")
    if font_file:
        opts.insert(0, f"fontfile='{_ffmpeg_filter_path(font_file)}'")
    return "[0:v]drawtext=" + ":".join(opts) + "[vout]"


def _audio_mix_filter_complex(
    *,
    has_base_audio: bool,
    audio_clips: list[dict[str, Any]],
    master_volume: float = 1.0,
) -> str:
    parts: list[str] = []
    foreground_labels: list[str] = []
    bgm_label: str | None = None
    bgm_duck_enabled = False
    bgm_duck_volume = 0.35

    def mix_labels(labels: list[str], output_label: str) -> None:
        if len(labels) == 1:
            parts.append(f"{labels[0]}anull{output_label}")
        else:
            parts.append("".join(labels) + f"amix=inputs={len(labels)}:duration=longest:dropout_transition=0{output_label}")

    if has_base_audio:
        parts.append("[0:a]asetpts=PTS-STARTPTS[basea]")
        foreground_labels.append("[basea]")
    for idx, clip in enumerate(audio_clips, start=1):
        delay_ms = max(0, int(round(float(clip.get("timeline_start") or 0) * 1000)))
        duration = _clip_timeline_duration_sec(clip)
        speed = _clip_speed(clip)
        preserve_pitch = _clip_preserve_pitch(clip)
        volume = _clip_volume(clip)
        fade_in = min(duration, _clip_audio_fade(clip, "fade_in_sec"))
        fade_out = min(duration, _clip_audio_fade(clip, "fade_out_sec"))
        label = f"[a{idx}]"
        chain: list[str]
        if _clip_has_speed_ramp(clip):
            segment_labels: list[str] = []
            for segment_index, (start, end, segment_speed) in enumerate(_clip_speed_segments(clip)):
                segment_label = f"[ars{idx}_{segment_index}]"
                segment_labels.append(segment_label)
                segment_chain = [
                    f"atrim=start={start:.6f}:end={end:.6f}",
                    "asetpts=PTS-STARTPTS",
                    *(_atempo_chain(segment_speed) if preserve_pitch else _pitch_shift_speed_chain(segment_speed)),
                ]
                parts.append(f"[{idx}:a]{','.join(segment_chain)}{segment_label}")
            ramp_label = f"[arr{idx}]"
            parts.append("".join(segment_labels) + f"concat=n={len(segment_labels)}:v=0:a=1{ramp_label}")
            chain = ["areverse"] if _clip_reverse(clip) else ["anull"]
            parts.append(f"{ramp_label}{','.join(chain)}[arp{idx}]")
            input_label = f"[arp{idx}]"
            chain = []
        else:
            input_label = f"[{idx}:a]"
            trim_in = max(0.0, float(clip.get("trim_in") or 0.0))
            trim_out = trim_in + _clip_duration_sec(clip)
            chain = [f"atrim=start={trim_in:.6f}:end={trim_out:.6f}", "asetpts=PTS-STARTPTS"]
            if _clip_reverse(clip):
                chain.append("areverse")
            if abs(speed - 1.0) > 1e-6:
                chain.extend(_atempo_chain(speed) if preserve_pitch else _pitch_shift_speed_chain(speed))
        chain.append(_clip_volume_filter(clip))
        if fade_in > 0:
            chain.append(f"afade=t=in:st=0:d={fade_in:.6f}")
        if fade_out > 0:
            start = max(0.0, duration - fade_out)
            chain.append(f"afade=t=out:st={start:.6f}:d={fade_out:.6f}")
        chain.append(f"adelay={delay_ms}:all=1")
        parts.append(f"{input_label}{','.join(chain)}{label}")
        meta = clip.get("meta") if isinstance(clip.get("meta"), dict) else {}
        if meta.get("project_bgm"):
            bgm_label = label
            bgm_duck_enabled = bool(meta.get("ducking_enabled"))
            try:
                bgm_duck_volume = max(0.05, min(1.0, float(meta.get("ducking_volume", 0.35))))
            except (TypeError, ValueError):
                bgm_duck_volume = 0.35
        else:
            foreground_labels.append(label)
    labels: list[str]
    if bgm_label and bgm_duck_enabled and foreground_labels:
        mix_labels(foreground_labels, "[duckside]")
        ratio = 1.0 + (1.0 - bgm_duck_volume) * 18.0
        parts.append(f"{bgm_label}[duckside]sidechaincompress=threshold=0.015:ratio={ratio:.6f}:attack=25:release=280[bgmduck]")
        labels = ["[duckside]", "[bgmduck]"]
    else:
        labels = [*foreground_labels, *([bgm_label] if bgm_label else [])]
    if not labels:
        return ""
    mix_label = "[premaster]"
    mix_labels(labels, mix_label)
    master = max(0.0, min(2.0, float(master_volume)))
    if abs(master - 1.0) > 1e-6:
        parts.append(f"{mix_label}volume={master:.6f}[mixa]")
    else:
        parts.append(f"{mix_label}anull[mixa]")
    return ";".join(parts)


def _boundary_transition_filter_complex(
    *,
    transition_type: str,
    duration: float,
    previous_duration: float,
    next_duration: float,
    fps: float,
    previous_has_audio: bool,
    next_has_audio: bool,
) -> str:
    """Render a visual transition at a cut while preserving timeline duration.

    The outgoing image is held for the transition duration; the incoming clip keeps
    its full timeline allocation, so overlays and independent audio remain aligned.
    """
    frame = 1.0 / max(fps, 24.0)
    # This compositor keeps the full timeline allocation of both clips: the
    # outgoing last frame is extended underneath the incoming clip. Unlike a
    # conventional overlapping xfade, the previous duration does not limit
    # the transition. Only the incoming material needs one frame left for its
    # tail, so a requested 1.5s transition remains exactly 1.5s when possible.
    max_duration = max(frame, next_duration - frame)
    td = max(frame, min(max(0.0, float(duration)), 1.5, max_duration))
    fps_s = f"{fps:.4f}".rstrip("0").rstrip(".")
    xname = "fade" if transition_type in {"cut", "fade"} else _xfade_transition_name(transition_type)
    half = td / 2.0
    phase_color = "black" if transition_type == "dip_black" else "white" if transition_type == "flash" else None
    phase_prefix = "dip" if transition_type == "dip_black" else "flash"
    if phase_color:
        hold_filter = (
            f"[holdsrc]trim=start={max(0.0, previous_duration - half):.6f}:end={previous_duration:.6f},"
            f"setpts=PTS-STARTPTS,fade=t=out:st=0:d={half:.6f}:color={phase_color}[{phase_prefix}out]"
        )
    else:
        # Container duration is often determined by audio and can extend past
        # the final video frame. A one-frame trim at ``duration - frame`` can
        # therefore be empty, making xfade fall through to an apparent hard
        # cut. Search a small tail window and reverse it so trim selects the
        # last video frame that actually exists, then hold that frame.
        hold_window = max(0.25, frame * 4.0)
        hold_start = max(0.0, previous_duration - hold_window)
        hold_filter = (
            f"[holdsrc]trim=start={hold_start:.6f}:end={previous_duration:.6f},"
            f"setpts=PTS-STARTPTS,reverse,trim=end_frame=1,setpts=PTS-STARTPTS,"
            f"loop=loop=-1:size=1:start=0,setpts=N/{fps_s}/TB,trim=duration={td:.6f}[hold]"
        )
    parts = [
        "[0:v]split=2[pvsrc][holdsrc]",
        "[1:v]split=2[nintrosrc][ntailsrc]",
        "[pvsrc]setpts=PTS-STARTPTS[pv]",
        hold_filter,
        f"[nintrosrc]trim=start=0:end={td:.6f},setpts=PTS-STARTPTS[nintro]",
    ]
    if phase_color:
        # FFmpeg's fadeblack/fadewhite variants do not reliably reach the
        # expected solid midpoint on every build. Split the transition into
        # two explicit halves so the boundary color and duration are stable.
        parts.extend([
            f"[nintro]trim=start={half:.6f}:end={td:.6f},setpts=PTS-STARTPTS,fade=t=in:st=0:d={half:.6f}:color={phase_color}[{phase_prefix}in]",
            f"[{phase_prefix}out][{phase_prefix}in]concat=n=2:v=1:a=0[xf]",
        ])
    else:
        parts.append(f"[hold][nintro]xfade=transition={xname}:duration={td:.6f}:offset=0[xf]")
    parts.extend([
        f"[ntailsrc]trim=start={td:.6f},setpts=PTS-STARTPTS[ntail]",
        "[pv][xf][ntail]concat=n=3:v=1:a=0[vout]",
    ])
    if previous_has_audio:
        parts.append("[0:a]asetpts=PTS-STARTPTS[pa]")
    else:
        parts.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{previous_duration:.6f},asetpts=PTS-STARTPTS[pa]")
    if next_has_audio:
        parts.append("[1:a]asetpts=PTS-STARTPTS[na]")
    else:
        parts.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{next_duration:.6f},asetpts=PTS-STARTPTS[na]")
    parts.append("[pa][na]concat=n=2:v=0:a=1[aout]")
    return ";".join(parts)
