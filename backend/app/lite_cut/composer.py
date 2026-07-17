"""LiteCut v2 FFmpeg export — V1 main track + trim + xfade + eq."""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Optional

from .effect_contract import filter_preset_ffmpeg_map, normalize_video_layer_transform
from .ffmpeg_runtime import (
    ProgressCallback,
    emit_progress as _emit_progress,
    raise_if_cancelled as _raise_if_cancelled,
    run_ffmpeg_process as _run_ffmpeg_process,
)

from ..video_composer import (
    MontageComposerError,
    _clamp_xfade_duration,
    _concat_file_line,
    _is_hard_cut,
    _parse_transition_for_edge,
    _xfade_transition_name,
    h264_encode_cli_args,
    ffprobe_streams,
    probe_video_audio_summary,
    resolve_ffprobe_binary,
    resolve_h264_codec_name,
    validate_output_path,
)

logger = logging.getLogger(__name__)


def _ffmpeg_expr_time_variable(expression: str, variable: str = "T") -> str:
    """Translate filter expressions using ``t`` to filters that expose ``T``."""
    return re.sub(r"\bt\b", variable, str(expression))

_TRANSITION_MAP = {
    "cut": "cut",
    "none": "none",
    "fade": "fade",
    "flash": "flash",
    "flashwhite": "flash",
    "dip": "dip_black",
    "dip_black": "dip_black",
    "black": "dip_black",
    "zoom": "zoom",
    "wipe_l": "wipe_l",
    "wipe_r": "wipe_r",
    "slide_left": "slide_left",
    "slide_right": "slide_right",
    "slide_up": "slide_up",
    "slide_down": "slide_down",
    "blur": "blur",
    "glitch": "glitch",
    "spin": "spin",
}

_MAIN_VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
_AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}

_FILTER_PRESET_VF = filter_preset_ffmpeg_map()


def _map_transition_type(raw: str) -> str:
    t = str(raw or "cut").strip().lower()
    return _TRANSITION_MAP.get(t, "fade")


def _clip_duration_sec(clip: dict[str, Any]) -> float:
    trim_in = float(clip.get("trim_in") or 0)
    trim_out = clip.get("trim_out")
    if trim_out is not None:
        return max(0.1, float(trim_out) - trim_in)
    if clip.get("duration") is not None:
        return max(0.1, float(clip.get("duration") or 0) - trim_in)
    meta = clip.get("meta") if isinstance(clip.get("meta"), dict) else {}
    if meta.get("duration_sec") is not None:
        return max(0.1, float(meta["duration_sec"]) - trim_in)
    return 5.0


def _clip_speed(clip: dict[str, Any]) -> float:
    try:
        speed = float(clip.get("speed") or 1.0)
    except (TypeError, ValueError):
        speed = 1.0
    return max(0.25, min(4.0, speed))


def _clip_speed_keyframes(clip: dict[str, Any]) -> list[tuple[float, float]]:
    trim_in = max(0.0, float(clip.get("trim_in") or 0.0))
    trim_out = trim_in + _clip_duration_sec(clip)
    points: list[tuple[float, float]] = []
    for raw in clip.get("speed_keyframes") or []:
        if not isinstance(raw, dict):
            continue
        try:
            source_sec = max(trim_in, min(trim_out, float(raw.get("source_sec"))))
            speed = max(0.25, min(4.0, float(raw.get("speed"))))
        except (TypeError, ValueError):
            continue
        points.append((source_sec, speed))
    points.sort(key=lambda point: point[0])
    deduplicated: list[tuple[float, float]] = []
    for point in points:
        if deduplicated and abs(deduplicated[-1][0] - point[0]) <= 1e-6:
            deduplicated[-1] = point
        else:
            deduplicated.append(point)
    if len(deduplicated) < 2:
        return []
    if deduplicated[0][0] > trim_in + 1e-6:
        deduplicated.insert(0, (trim_in, _clip_speed(clip)))
    if deduplicated[-1][0] < trim_out - 1e-6:
        deduplicated.append((trim_out, deduplicated[-1][1]))
    return deduplicated


def _clip_speed_segments(clip: dict[str, Any]) -> list[tuple[float, float, float]]:
    trim_in = max(0.0, float(clip.get("trim_in") or 0.0))
    trim_out = trim_in + _clip_duration_sec(clip)
    points = _clip_speed_keyframes(clip)
    if not points:
        return [(trim_in, trim_out, _clip_speed(clip))]
    return [(left_t, right_t, speed) for (left_t, speed), (right_t, _) in zip(points[:-1], points[1:]) if right_t - left_t > 1e-6]


def _clip_has_speed_ramp(clip: dict[str, Any]) -> bool:
    return len(_clip_speed_keyframes(clip)) >= 2


def _clip_reverse(clip: dict[str, Any]) -> bool:
    return bool(clip.get("reverse"))


def _clip_freeze_frame_sec(clip: dict[str, Any]) -> float:
    try:
        freeze = float(clip.get("freeze_frame_sec") or 0.0)
    except (TypeError, ValueError):
        freeze = 0.0
    return max(0.0, min(30.0, freeze))


def _clip_preserve_pitch(clip: dict[str, Any]) -> bool:
    return clip.get("preserve_pitch") is not False


def _clip_canvas_fit(clip: dict[str, Any], fallback: str = "contain") -> str:
    raw = str(clip.get("canvas_fit") or "").strip().lower()
    if raw in {"contain", "cover", "blur"}:
        return raw
    fit = str(fallback or "contain").strip().lower()
    return fit if fit in {"contain", "cover", "blur"} else "contain"


def _clip_crop_filter(clip: dict[str, Any]) -> str:
    crop = clip.get("crop") if isinstance(clip.get("crop"), dict) else None
    if not crop:
        return ""
    try:
        width = float(crop.get("width", 1))
        height = float(crop.get("height", 1))
        x = float(crop.get("x", 0))
        y = float(crop.get("y", 0))
    except (TypeError, ValueError):
        return ""
    width = max(0.05, min(1.0, width))
    height = max(0.05, min(1.0, height))
    x = max(0.0, min(1.0 - width, x))
    y = max(0.0, min(1.0 - height, y))
    if width >= 0.9999 and height >= 0.9999:
        return ""
    return f"crop=iw*{width:.6f}:ih*{height:.6f}:iw*{x:.6f}:ih*{y:.6f}"


def _clip_volume(clip: dict[str, Any]) -> float:
    if clip.get("muted"):
        return 0.0
    try:
        volume = float(clip.get("volume") if clip.get("volume") is not None else 1.0)
    except (TypeError, ValueError):
        volume = 1.0
    return max(0.0, min(5.0, volume))


def _clip_audio_keyframes(clip: dict[str, Any]) -> list[tuple[float, float]]:
    duration = _clip_timeline_duration_sec(clip)
    points: list[tuple[float, float]] = []
    for keyframe in clip.get("audio_keyframes") or []:
        if not isinstance(keyframe, dict):
            continue
        try:
            time_sec = max(0.0, min(duration, float(keyframe.get("time_sec") or 0.0)))
            volume = max(0.0, min(5.0, float(keyframe.get("volume"))))
        except (TypeError, ValueError):
            continue
        points.append((time_sec, volume))
    points.sort(key=lambda point: point[0])
    deduplicated: list[tuple[float, float]] = []
    for point in points:
        if deduplicated and abs(deduplicated[-1][0] - point[0]) <= 1e-6:
            deduplicated[-1] = point
        else:
            deduplicated.append(point)
    return deduplicated


def _clip_volume_filter(clip: dict[str, Any]) -> str:
    if clip.get("muted"):
        return "volume=0.000000"
    points = _clip_audio_keyframes(clip)
    if not points:
        return f"volume={_clip_volume(clip):.6f}"
    expression = f"{points[-1][1]:.6f}"
    for index in range(len(points) - 1, 0, -1):
        start_time, start_volume = points[index - 1]
        end_time, end_volume = points[index]
        delta = max(0.0001, end_time - start_time)
        linear = f"{start_volume:.6f}+({end_volume:.6f}-{start_volume:.6f})*(t-{start_time:.6f})/{delta:.6f}"
        expression = f"if(lt(t\\,{end_time:.6f})\\,{linear}\\,{expression})"
    first_time, first_volume = points[0]
    if first_time > 1e-6:
        expression = f"if(lt(t\\,{first_time:.6f})\\,{first_volume:.6f}\\,{expression})"
    return f"volume='{expression}':eval=frame"


def _project_master_volume(body: dict[str, Any]) -> float:
    audio = body.get("audio") if isinstance(body.get("audio"), dict) else {}
    try:
        volume = float(audio.get("master_volume") if audio.get("master_volume") is not None else 1.0)
    except Exception:
        volume = 1.0
    return max(0.0, min(2.0, volume))


def _project_output_settings(body: dict[str, Any], ref: dict[str, Any]) -> tuple[int, int, float]:
    output = body.get("output") if isinstance(body.get("output"), dict) else {}

    def _int_setting(key: str, fallback: int, lo: int, hi: int) -> int:
        try:
            value = int(output.get(key) if output.get(key) is not None else fallback)
        except (TypeError, ValueError):
            value = fallback
        return max(lo, min(hi, value))

    def _fps_setting(fallback: float) -> float:
        try:
            value = float(output.get("fps") if output.get("fps") is not None else fallback)
        except (TypeError, ValueError):
            value = fallback
        return max(1.0, min(240.0, value))

    fallback_w = int(ref.get("width") or 1920)
    fallback_h = int(ref.get("height") or 1080)
    fallback_fps = float(ref.get("fps") or 60)
    width = _int_setting("width", fallback_w, 320, 7680)
    height = _int_setting("height", fallback_h, 180, 4320)
    fps = _fps_setting(fallback_fps)
    return width, height, fps


def _project_encoder_tier(body: dict[str, Any]) -> str:
    output = body.get("output") if isinstance(body.get("output"), dict) else {}
    return "fast" if str(output.get("encoder_tier") or "").strip().lower() == "fast" else "quality"


def _ffmpeg_color(value: Any) -> str:
    raw = str(value or "").strip()
    if raw.startswith("#"):
        raw = raw[1:]
    if len(raw) in (3, 6) and all(c in "0123456789abcdefABCDEF" for c in raw):
        if len(raw) == 3:
            raw = "".join(c * 2 for c in raw)
        return f"0x{raw.lower()}"
    return "black"


def _project_canvas_settings(body: dict[str, Any]) -> tuple[str, str, int]:
    output = body.get("output") if isinstance(body.get("output"), dict) else {}
    fit = str(output.get("canvas_fit") or "contain").strip().lower()
    if fit not in {"contain", "cover", "blur"}:
        fit = "contain"
    try:
        blur_amount = int(output.get("blur_amount") if output.get("blur_amount") is not None else 24)
    except (TypeError, ValueError):
        blur_amount = 24
    return fit, _ffmpeg_color(output.get("background_color")), max(4, min(80, blur_amount))


def _project_export_range(body: dict[str, Any]) -> tuple[float, Optional[float]]:
    output = body.get("output") if isinstance(body.get("output"), dict) else {}
    if str(output.get("range_mode") or "full").strip().lower() != "custom":
        return 0.0, None
    try:
        start_sec = float(output.get("range_start_sec") or 0.0)
    except (TypeError, ValueError):
        start_sec = 0.0
    start_sec = max(0.0, start_sec)

    end_sec: Optional[float] = None
    raw_end = output.get("range_end_sec")
    if raw_end is not None:
        try:
            parsed_end = float(raw_end)
            if parsed_end > start_sec + 0.05:
                end_sec = parsed_end
        except (TypeError, ValueError):
            end_sec = None
    if start_sec <= 0.0 and end_sec is None:
        return 0.0, None
    return start_sec, end_sec


def _clip_audio_fade(clip: dict[str, Any], key: str) -> float:
    try:
        fade = float(clip.get(key) or 0.0)
    except (TypeError, ValueError):
        fade = 0.0
    duration = _clip_duration_sec(clip)
    return max(0.0, min(duration, fade))


def _clip_visual_fade(clip: dict[str, Any], key: str) -> float:
    try:
        fade = float(clip.get(key) or 0.0)
    except (TypeError, ValueError):
        fade = 0.0
    duration = _clip_duration_sec(clip)
    return max(0.0, min(duration, fade))


def _clip_timeline_duration_sec(clip: dict[str, Any]) -> float:
    duration = sum((end - start) / speed for start, end, speed in _clip_speed_segments(clip))
    return max(0.1, duration) + _clip_freeze_frame_sec(clip)


def _clip_video_fade(clip: dict[str, Any], key: str) -> float:
    try:
        fade = float(clip.get(key) or 0.0)
    except (TypeError, ValueError):
        fade = 0.0
    return max(0.0, min(_clip_timeline_duration_sec(clip), fade))


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


def _track_main_video_clips(track: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        c
        for c in (track.get("clips") or [])
        if isinstance(c, dict) and (_is_recorded_timeline_clip(c) or _is_main_file_clip(c))
    ]


def _has_solo_audio_tracks(body: dict[str, Any]) -> bool:
    tracks = body.get("tracks") if isinstance(body.get("tracks"), list) else []
    return any(isinstance(track, dict) and track.get("type") == "audio" and track.get("solo") for track in tracks)


def _track_volume(track: dict[str, Any]) -> float:
    try:
        volume = float(track.get("volume") if track.get("volume") is not None else 1.0)
    except (TypeError, ValueError):
        volume = 1.0
    return max(0.0, min(2.0, volume))


def _clip_with_track_audio_gain(clip: dict[str, Any], track: dict[str, Any], *, force_muted: bool = False) -> dict[str, Any]:
    gain = _track_volume(track)
    out = {**clip, "volume": _clip_volume(clip) * gain}
    if force_muted or track.get("muted"):
        out["muted"] = True
    keyframes = clip.get("audio_keyframes")
    if isinstance(keyframes, list):
        scaled_keyframes: list[dict[str, Any]] = []
        for point in keyframes:
            if not isinstance(point, dict):
                continue
            try:
                volume = float(point.get("volume") or 0.0)
            except (TypeError, ValueError):
                volume = 0.0
            scaled_keyframes.append({**point, "volume": max(0.0, min(2.0, volume * gain))})
        out["audio_keyframes"] = scaled_keyframes
    return out


def _base_video_track_for_export(body: dict[str, Any]) -> tuple[str | None, list[dict[str, Any]]]:
    tracks = body.get("tracks") if isinstance(body.get("tracks"), list) else []
    for track in reversed(tracks):
        if not isinstance(track, dict) or track.get("hidden"):
            continue
        if track.get("type") not in (None, "video"):
            continue
        track_id = str(track.get("id") or "")
        clips = sorted(_track_main_video_clips(track), key=lambda c: float(c.get("timeline_start") or 0))
        if clips:
            clips = [
                _clip_with_track_audio_gain(c, track, force_muted=bool(track.get("muted") or _has_solo_audio_tracks(body)))
                if isinstance(c, dict)
                else c
                for c in clips
            ]
            return track_id, clips
    return None, []


def _main_video_clips_sorted(body: dict[str, Any]) -> list[dict[str, Any]]:
    return _base_video_track_for_export(body)[1]


def _overlay_track_clips(body: dict[str, Any], *, base_track_id: str | None = None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    tracks = body.get("tracks") if isinstance(body.get("tracks"), list) else []
    if base_track_id is None:
        base_track_id = _base_video_track_for_export(body)[0]
    base_index = next((index for index, track in enumerate(tracks) if isinstance(track, dict) and str(track.get("id") or "") == str(base_track_id or "")), len(tracks))
    # UI order is top-to-bottom. Composite tracks above the base from the
    # nearest bottom layer upward so index 0 is rendered last and stays on top.
    for track in reversed(tracks[:base_index]):
        if not isinstance(track, dict):
            continue
        if track.get("hidden"):
            continue
        ttype = track.get("type")
        if ttype not in (None, "video"):
            continue
        if ttype is None and str(track.get("id") or "") in ("overlay", "a1", "a2"):
            continue
        track_id = str(track.get("id") or "")
        for clip in sorted(track.get("clips") or [], key=lambda item: float(item.get("timeline_start") or 0) if isinstance(item, dict) else 0):
            if not isinstance(clip, dict):
                continue
            if _is_recorded_timeline_clip(clip) or _is_main_file_clip(clip):
                out.append(_timeline_video_layer_clip(clip, track_id=track_id))
            elif _is_file_overlay_clip(clip):
                out.append(clip)
    return out


def _timeline_video_layer_clip(clip: dict[str, Any], *, track_id: str) -> dict[str, Any]:
    out = {**clip}
    out["type"] = "file"
    out["source_track_id"] = track_id
    out["is_timeline_video_layer"] = True
    out["transform"] = out.get("transform") if isinstance(out.get("transform"), dict) else {
        "x": 0.5,
        "y": 0.5,
        "scale": 1.0,
        "rotation": 0.0,
        "width": 1.0,
        "height": 1.0,
        "opacity": 1.0,
    }
    return out


def _schema_overlay_clips(body: dict[str, Any]) -> list[dict[str, Any]]:
    """Preview 区叠层 (body.overlays) → 导出合成列表。"""
    out: list[dict[str, Any]] = []
    hidden_track_ids = {
        str(track.get("id"))
        for track in (body.get("overlay_tracks") or [])
        if isinstance(track, dict) and track.get("hidden")
    }
    for ov in body.get("overlays") or []:
        if not isinstance(ov, dict):
            continue
        meta = ov.get("meta") if isinstance(ov.get("meta"), dict) else {}
        if str(meta.get("overlay_track_id") or "ot1") in hidden_track_ids:
            continue
        if ov.get("type") == "text":
            dur = float(ov.get("duration") or 3)
            out.append(
                {
                    "type": "text",
                    "timeline_start": float(ov.get("timeline_start") or 0),
                    "trim_in": 0,
                    "trim_out": dur,
                    "duration": dur,
                    "fade_in_sec": float(ov.get("fade_in_sec") or 0),
                    "fade_out_sec": float(ov.get("fade_out_sec") or 0),
                    "transition_in": ov.get("transition_in") if isinstance(ov.get("transition_in"), dict) else None,
                    "transition_out": ov.get("transition_out") if isinstance(ov.get("transition_out"), dict) else None,
                    "transform": ov.get("transform") if isinstance(ov.get("transform"), dict) else None,
                    "keyframes": ov.get("keyframes") if isinstance(ov.get("keyframes"), list) else [],
                    "flip_horizontal": bool(ov.get("flip_horizontal")),
                    "flip_vertical": bool(ov.get("flip_vertical")),
                    "text": ov.get("text") if isinstance(ov.get("text"), dict) else {},
                    "meta": ov.get("meta") if isinstance(ov.get("meta"), dict) else {},
                }
            )
            continue
        path = str(ov.get("asset_path") or "").strip()
        if not path:
            continue
        dur = float(ov.get("duration") or 3)
        trim_in = max(0.0, float(ov.get("trim_in") or 0))
        out.append(
            {
                "type": "file",
                "file_path": path,
                "timeline_start": float(ov.get("timeline_start") or 0),
                "trim_in": trim_in,
                "trim_out": trim_in + dur,
                "duration": dur,
                "fade_in_sec": float(ov.get("fade_in_sec") or 0),
                "fade_out_sec": float(ov.get("fade_out_sec") or 0),
                "transition_in": ov.get("transition_in") if isinstance(ov.get("transition_in"), dict) else None,
                "transition_out": ov.get("transition_out") if isinstance(ov.get("transition_out"), dict) else None,
                "transform": ov.get("transform") if isinstance(ov.get("transform"), dict) else None,
                "keyframes": ov.get("keyframes") if isinstance(ov.get("keyframes"), list) else [],
                "flip_horizontal": bool(ov.get("flip_horizontal")),
                "flip_vertical": bool(ov.get("flip_vertical")),
                "meta": ov.get("meta") if isinstance(ov.get("meta"), dict) else {},
            }
        )
    return out


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
    rot_rad = rotation * 3.141592653589793 / 180.0
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
    if dynamic_rotation or abs(rotation) > 0.5:
        angle = f"({rotation_expr})*PI/180" if dynamic_rotation else f"{rot_rad:.6f}"
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
    elif opacity < 0.999:
        chain += f"{overlay_source}format=rgba,colorchannelmixer=aa={opacity:.6f}[ov];"
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
    position_x = f"main_w*({x_expr})-w/2" if dynamic_x else f"main_w*{tx:.6f}-w/2"
    position_y = f"main_h*({y_expr})-h/2" if dynamic_y else f"main_h*{ty:.6f}-h/2"
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


def _all_overlay_clips_for_export(body: dict[str, Any], *, base_track_id: str | None = None) -> list[dict[str, Any]]:
    merged = _overlay_track_clips(body, base_track_id=base_track_id) + _schema_overlay_clips(body)
    # Items are composited sequentially. Preserve bottom-to-top track order;
    # sorting globally by start time would let a lower track cover a higher one.
    return merged


def _missing_file_assets_for_export(body: dict[str, Any], *, base_track_id: str | None = None) -> list[dict[str, str]]:
    """List unavailable uploaded assets that would affect an export."""
    _base_track_id, base_clips = _base_video_track_for_export(body)
    effective_base_track_id = base_track_id if base_track_id is not None else _base_track_id
    candidates: list[tuple[str, str]] = [
        ("video", str(clip.get("file_path") or "").strip())
        for clip in base_clips
        if _is_main_file_clip(clip)
    ]
    for clip in _all_overlay_clips_for_export(body, base_track_id=effective_base_track_id):
        if clip.get("type") == "text":
            text = clip.get("text") if isinstance(clip.get("text"), dict) else {}
            candidates.append(("font", str(text.get("font_file") or "").strip()))
        else:
            candidates.append(("overlay", str(clip.get("file_path") or "").strip()))
    candidates.extend(("audio", str(clip.get("file_path") or "").strip()) for clip in _audio_track_clips_for_export(body))
    bgm = _project_bgm_clip_for_export(body)
    if bgm:
        candidates.append(("bgm", str(bgm.get("file_path") or "").strip()))

    missing: list[dict[str, str]] = []
    seen: set[str] = set()
    for kind, raw_path in candidates:
        if not raw_path:
            continue
        path = Path(raw_path).expanduser()
        key = str(path)
        if not path.is_file() and key not in seen:
            seen.add(key)
            missing.append({"kind": kind, "name": path.name or raw_path, "path": raw_path})
    return missing


def _first_missing_file_asset_for_export(body: dict[str, Any], *, base_track_id: str | None = None) -> str | None:
    missing = _missing_file_assets_for_export(body, base_track_id=base_track_id)
    return missing[0]["name"] if missing else None


def _recorded_source_ids_for_export(body: dict[str, Any]) -> list[int]:
    base_track_id, base_clips = _base_video_track_for_export(body)
    clips = base_clips + _overlay_track_clips(body, base_track_id=base_track_id)
    return sorted(
        {
            int(c["source_id"])
            for c in clips
            if c.get("source_id") is not None and c.get("source_type") != "file"
        }
    )


def _resolve_overlay_clip_paths(
    overlay_clips: list[dict[str, Any]],
    clip_path_by_id: dict[int, Path],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for clip in overlay_clips:
        if str(clip.get("file_path") or "").strip():
            out.append(clip)
            continue
        sid = clip.get("source_id")
        if sid is None:
            out.append(clip)
            continue
        path = clip_path_by_id.get(int(sid))
        if path is None:
            raise MontageComposerError("MONTAGE_CLIP_FILE_MISSING", name=str(sid))
        out.append({**clip, "file_path": str(path)})
    return out


def _webm_has_alpha(path: Path, ffprobe: Path) -> bool:
    if path.suffix.lower() != ".webm":
        return False
    try:
        data = ffprobe_streams(path, ffprobe)
    except Exception:
        return False
    for stream in data.get("streams") or []:
        if not isinstance(stream, dict) or str(stream.get("codec_type") or "") != "video":
            continue
        tags = stream.get("tags") if isinstance(stream.get("tags"), dict) else {}
        if str(tags.get("alpha_mode") or tags.get("ALPHA_MODE") or "").strip() == "1":
            return True
    return False


def _overlay_video_decoder_args(path: Path, ffprobe: Path) -> list[str]:
    # FFmpeg's native VP9 decoder can discard the alpha plane from WebM.
    return ["-c:v", "libvpx-vp9"] if _webm_has_alpha(path, ffprobe) else []


def _is_looping_animation_file(path: Path) -> bool:
    return path.suffix.lower() == ".gif"


def _composite_overlays_on_base(
    *,
    ffmpeg_bin: Path,
    ffprobe: Path,
    base_mp4: Path,
    overlay_clips: list[dict[str, Any]],
    out_mp4: Path,
    video_encode_quality: list[str],
    progress_callback: ProgressCallback | None = None,
    cancel_event: Any | None = None,
    progress_start: float = 0.70,
    progress_end: float = 0.84,
) -> None:
    """Burn V2–V5 file overlays onto V1 base (images + alpha-friendly video)."""
    import shutil

    if not overlay_clips:
        shutil.copy2(base_mp4, out_mp4)
        return

    current = base_mp4
    # Intermediate overlay passes belong beside the temporary base file, not
    # beside the user's final export.  Using out_mp4.parent leaked ov_step_*.mp4
    # into the chosen export directory whenever more than one overlay existed.
    work_dir = base_mp4.parent
    still_ext = {".png", ".jpg", ".jpeg", ".webp"}

    for i, clip in enumerate(overlay_clips):
        _raise_if_cancelled(cancel_event)
        staged_font_path: Path | None = None
        overlay_label = str(clip.get("file_path") or clip.get("type") or f"overlay-{i}")
        start = max(0.0, float(clip.get("timeline_start") or 0))
        clip_is_video_overlay = clip.get("type") != "text" and str(clip.get("file_path") or "").strip()
        source_dur = _clip_duration_sec(clip)
        dur = _clip_timeline_duration_sec(clip) if clip_is_video_overlay else source_dur
        end = start + dur
        is_last = i == len(overlay_clips) - 1
        step_out = out_mp4 if is_last else work_dir / f"ov_step_{i:03d}.mp4"

        base_info = probe_video_audio_summary(current, ffprobe)
        total = max(float(base_info.get("duration") or 0), end, 0.1)

        if clip.get("type") == "text":
            enable = f"between(t,{start:.4f},{end:.4f})"
            export_text_clip = clip
            text_config = clip.get("text") if isinstance(clip.get("text"), dict) else {}
            custom_font_file = str(text_config.get("font_file") or "").strip()
            if custom_font_file:
                try:
                    staged_font_path = _stage_custom_font_for_ffmpeg(custom_font_file)
                except (OSError, UnicodeError) as exc:
                    logger.error("lite_cut could not stage custom font for FFmpeg: %s", exc)
                    raise MontageComposerError("MONTAGE_EXPORT_FAILED") from exc
                export_text_clip = {
                    **clip,
                    "text": {**text_config, "font_file": str(staged_font_path)},
                }
            fc = _drawtext_filter_complex(text_clip=export_text_clip, enable_expr=enable, canvas_width=int(base_info.get("width") or 1920), canvas_height=int(base_info.get("height") or 1080))
            cmd = [
                str(ffmpeg_bin),
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(current),
                "-filter_complex",
                fc,
                "-map",
                "[vout]",
                "-map",
                "0:a?",
                *video_encode_quality,
                "-c:a",
                "copy",
                str(step_out),
            ]
        else:
            fp = Path(str(clip.get("file_path") or "")).expanduser().resolve()
            if not fp.is_file():
                logger.warning("lite_cut overlay missing: %s", fp)
                continue

            if fp.suffix.lower() in still_ext:
                tr = clip.get("transform") if isinstance(clip.get("transform"), dict) else {}
                tx, ty, size_frac, rotation = _overlay_layout_from_transform(tr)
                height_frac = _overlay_height_from_transform(tr)
                opacity = _overlay_opacity_from_transform(tr)
                enable = f"between(t,{start:.4f},{end:.4f})"
                fc = _overlay_filter_complex(
                    enable_expr=enable,
                    timeline_start=start,
                    duration=dur,
                    tx=tx,
                    ty=ty,
                    size_frac=size_frac,
                    height_frac=height_frac,
                    rotation=rotation,
                    opacity=opacity,
                    fade_in=_clip_visual_fade(clip, "fade_in_sec"),
                    fade_out=_clip_visual_fade(clip, "fade_out_sec"),
                    video_input=False,
                    flip_horizontal=bool(clip.get("flip_horizontal")),
                    flip_vertical=bool(clip.get("flip_vertical")),
                    keyframes=clip.get("keyframes"),
                    source_filters=[item for item in (_clip_crop_filter(clip), _eq_filter(clip.get("color") if isinstance(clip.get("color"), dict) else None)) if item],
                    reverse=_clip_reverse(clip),
                    freeze_frame_sec=_clip_freeze_frame_sec(clip),
                    canvas_width=int(base_info.get("width") or 1920),
                    canvas_height=int(base_info.get("height") or 1080),
                    transition_in=clip.get("transition_in"),
                    transition_out=clip.get("transition_out"),
                )
                cmd = [
                    str(ffmpeg_bin),
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    str(current),
                    "-loop",
                    "1",
                    "-framerate",
                    "60",
                    "-t",
                    f"{total:.4f}",
                    "-i",
                    str(fp),
                    "-filter_complex",
                    fc,
                    "-map",
                    "[vout]",
                    "-map",
                    "0:a?",
                    *video_encode_quality,
                    "-c:a",
                    "copy",
                    str(step_out),
                ]
            else:
                tr = clip.get("transform") if isinstance(clip.get("transform"), dict) else {}
                tx, ty, size_frac, rotation = _overlay_layout_from_transform(tr)
                height_frac = _overlay_height_from_transform(tr)
                opacity = _overlay_opacity_from_transform(tr)
                enable = f"between(t,{start:.4f},{end:.4f})"
                fc = _overlay_filter_complex(
                    enable_expr=enable,
                    timeline_start=start,
                    duration=dur,
                    tx=tx,
                    ty=ty,
                    size_frac=size_frac,
                    height_frac=height_frac,
                    rotation=rotation,
                    opacity=opacity,
                    fade_in=_clip_visual_fade(clip, "fade_in_sec"),
                    fade_out=_clip_visual_fade(clip, "fade_out_sec"),
                    video_input=True,
                    speed=_clip_speed(clip),
                    flip_horizontal=bool(clip.get("flip_horizontal")),
                    flip_vertical=bool(clip.get("flip_vertical")),
                    keyframes=clip.get("keyframes"),
                    source_filters=[item for item in (_clip_crop_filter(clip), _eq_filter(clip.get("color") if isinstance(clip.get("color"), dict) else None)) if item],
                    reverse=_clip_reverse(clip),
                    freeze_frame_sec=_clip_freeze_frame_sec(clip),
                    speed_segments=[(a - float(clip.get("trim_in") or 0), b - float(clip.get("trim_in") or 0), s) for a, b, s in _clip_speed_segments(clip)] if _clip_has_speed_ramp(clip) else None,
                    canvas_width=int(base_info.get("width") or 1920),
                    canvas_height=int(base_info.get("height") or 1080),
                    transition_in=clip.get("transition_in"),
                    transition_out=clip.get("transition_out"),
                )
                cmd = [
                    str(ffmpeg_bin),
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    str(current),
                    *_overlay_video_decoder_args(fp, ffprobe),
                    *( ["-stream_loop", "-1"] if _is_looping_animation_file(fp) else [] ),
                    "-ss",
                    f"{float(clip.get('trim_in') or 0):.4f}",
                    "-t",
                    f"{source_dur:.4f}",
                    "-i",
                    str(fp),
                    "-filter_complex",
                    fc,
                    "-map",
                    "[vout]",
                    "-map",
                    "0:a?",
                    *video_encode_quality,
                    "-c:a",
                    "copy",
                    str(step_out),
                ]

        previous = current
        try:
            r = _run_ffmpeg_process(cmd, timeout=3600, cancel_event=cancel_event)
        finally:
            if staged_font_path is not None:
                try:
                    staged_font_path.unlink(missing_ok=True)
                except OSError:
                    logger.debug("lite_cut could not remove staged custom font: %s", staged_font_path, exc_info=True)
        if r.returncode != 0:
            tail = (r.stderr or r.stdout or "").strip()[-600:]
            logger.error("lite_cut overlay composite failed %s: %s", overlay_label, tail)
            raise MontageComposerError("MONTAGE_EXPORT_FAILED")
        current = step_out
        if previous != base_mp4 and previous.parent == work_dir and previous.name.startswith("ov_step_"):
            try:
                previous.unlink(missing_ok=True)
            except OSError:
                logger.debug("lite_cut could not remove completed overlay step: %s", previous, exc_info=True)
        span = max(0.0, progress_end - progress_start)
        _emit_progress(
            progress_callback,
            progress_start + span * ((i + 1) / max(1, len(overlay_clips))),
            "overlays",
        )


def _is_file_overlay_clip(clip: dict[str, Any]) -> bool:
    return clip.get("source_type") == "file" and bool(str(clip.get("file_path") or "").strip())


def _is_main_file_clip(clip: dict[str, Any]) -> bool:
    if clip.get("source_type") != "file":
        return False
    path = str(clip.get("file_path") or "").strip()
    return bool(path) and Path(path).suffix.lower() in _MAIN_VIDEO_EXT


def _is_audio_file_clip(clip: dict[str, Any]) -> bool:
    if clip.get("source_type") != "file":
        return False
    path = str(clip.get("file_path") or "").strip()
    meta = clip.get("meta") if isinstance(clip.get("meta"), dict) else {}
    return bool(path) and (Path(path).suffix.lower() in _AUDIO_EXT or meta.get("kind") == "audio")


def _is_recorded_timeline_clip(clip: dict[str, Any]) -> bool:
    if _is_file_overlay_clip(clip):
        return False
    return clip.get("source_id") is not None


def _v1_clips_sorted(body: dict[str, Any]) -> list[dict[str, Any]]:
    tracks = body.get("tracks") if isinstance(body.get("tracks"), list) else []
    v1 = next((t for t in tracks if isinstance(t, dict) and t.get("id") == "v1"), None)
    if isinstance(v1, dict) and v1.get("hidden"):
        return []
    clips = list(v1.get("clips") or []) if isinstance(v1, dict) else []
    if isinstance(v1, dict):
        clips = [
            _clip_with_track_audio_gain(c, v1, force_muted=bool(v1.get("muted") or _has_solo_audio_tracks(body)))
            if isinstance(c, dict)
            else c
            for c in clips
        ]
    return sorted(clips, key=lambda c: float(c.get("timeline_start") or 0))


def _v1_recorded_clips_sorted(body: dict[str, Any]) -> list[dict[str, Any]]:
    """V1 主轨导出：仅 recorded_clip；file 贴纸走叠层合成。"""
    return [c for c in _v1_clips_sorted(body) if _is_recorded_timeline_clip(c)]


def _v1_main_clips_sorted(body: dict[str, Any]) -> list[dict[str, Any]]:
    return [c for c in _v1_clips_sorted(body) if _is_recorded_timeline_clip(c) or _is_main_file_clip(c)]


def _audio_track_clips_for_export(body: dict[str, Any]) -> list[dict[str, Any]]:
    tracks = body.get("tracks") if isinstance(body.get("tracks"), list) else []
    out: list[dict[str, Any]] = []
    solo_active = _has_solo_audio_tracks(body)
    for track in tracks:
        if (
            not isinstance(track, dict)
            or track.get("type") != "audio"
            or track.get("muted")
            or track.get("hidden")
            or (solo_active and not track.get("solo"))
        ):
            continue
        for clip in track.get("clips") or []:
            if isinstance(clip, dict) and _is_audio_file_clip(clip):
                out.append(_clip_with_track_audio_gain(clip, track))
    return sorted(out, key=lambda c: float(c.get("timeline_start") or 0))


def _video_layer_audio_clips_for_export(body: dict[str, Any], *, base_track_id: str | None = None) -> list[dict[str, Any]]:
    """Collect original audio from visible video layers above the base track."""
    tracks = body.get("tracks") if isinstance(body.get("tracks"), list) else []
    if base_track_id is None:
        base_track_id = _base_video_track_for_export(body)[0]
    solo_active = _has_solo_audio_tracks(body)
    base_index = next((index for index, track in enumerate(tracks) if isinstance(track, dict) and str(track.get("id") or "") == str(base_track_id or "")), len(tracks))
    out: list[dict[str, Any]] = []
    for track in tracks[:base_index]:
        if not isinstance(track, dict) or track.get("hidden"):
            continue
        ttype = track.get("type")
        if ttype not in (None, "video"):
            continue
        track_id = str(track.get("id") or "")
        if ttype is None and track_id in ("overlay", "a1", "a2"):
            continue
        for clip in track.get("clips") or []:
            if not isinstance(clip, dict) or not (_is_recorded_timeline_clip(clip) or _is_main_file_clip(clip)):
                continue
            out.append(_clip_with_track_audio_gain(clip, track, force_muted=solo_active))
    return sorted(out, key=lambda c: float(c.get("timeline_start") or 0))


def _resolve_audio_clip_paths(audio_clips: list[dict[str, Any]], clip_path_by_id: dict[int, Path]) -> list[dict[str, Any]]:
    """Resolve recorded layer sources to the same local file paths used for video export."""
    out: list[dict[str, Any]] = []
    for clip in audio_clips:
        raw_path = str(clip.get("file_path") or "").strip()
        if raw_path:
            out.append(clip)
            continue
        source_id = clip.get("source_id")
        if source_id is None:
            out.append(clip)
            continue
        path = clip_path_by_id.get(int(source_id))
        out.append({**clip, "file_path": str(path)} if path else clip)
    return out


def _project_bgm_clip_for_export(body: dict[str, Any]) -> dict[str, Any] | None:
    audio = body.get("audio") if isinstance(body.get("audio"), dict) else {}
    bgm = audio.get("bgm") if isinstance(audio.get("bgm"), dict) else None
    if not bgm:
        return None
    path = str(bgm.get("path") or "").strip()
    if not path:
        return None
    try:
        start_sec = max(0.0, float(bgm.get("start_sec") or 0))
    except (TypeError, ValueError):
        start_sec = 0.0
    try:
        duration_sec = float(bgm.get("duration_sec") or 0)
    except (TypeError, ValueError):
        duration_sec = 0.0
    clip: dict[str, Any] = {
        "id": "project-bgm",
        "source_type": "file",
        "file_path": path,
        "timeline_start": start_sec,
        "trim_in": 0,
        "volume": bgm.get("volume", 1.0),
        "fade_in_sec": bgm.get("fade_in_sec", 0.0),
        "fade_out_sec": bgm.get("fade_out_sec", 0.0),
        "meta": {
            "kind": "audio",
            "name": bgm.get("name") or Path(path).name,
            "project_bgm": True,
            "ducking_enabled": bool(bgm.get("ducking_enabled")),
            "ducking_volume": bgm.get("ducking_volume", 0.35),
        },
    }
    if bgm.get("asset_id") is not None:
        clip["meta"]["asset_id"] = bgm.get("asset_id")
    if duration_sec > 0:
        clip["meta"]["duration_sec"] = duration_sec
    return clip


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


def _mix_audio_tracks_on_base(
    *,
    ffmpeg_bin: Path,
    ffprobe: Path,
    base_mp4: Path,
    audio_clips: list[dict[str, Any]],
    out_mp4: Path,
    master_volume: float = 1.0,
    cancel_event: Any | None = None,
) -> None:
    _raise_if_cancelled(cancel_event)
    master_volume = max(0.0, min(2.0, float(master_volume)))
    base_info = probe_video_audio_summary(base_mp4, ffprobe)
    if not audio_clips and (not base_info.get("has_audio") or abs(master_volume - 1.0) <= 1e-6):
        import shutil

        shutil.copy2(base_mp4, out_mp4)
        return

    existing: list[tuple[dict[str, Any], Path]] = []
    for clip in audio_clips:
        fp = Path(str(clip.get("file_path") or "")).expanduser().resolve()
        if fp.is_file():
            existing.append((clip, fp))
        else:
            logger.warning("lite_cut audio missing: %s", fp)
    if not existing and (not base_info.get("has_audio") or abs(master_volume - 1.0) <= 1e-6):
        import shutil

        shutil.copy2(base_mp4, out_mp4)
        return

    filter_complex = _audio_mix_filter_complex(
        has_base_audio=bool(base_info.get("has_audio")),
        audio_clips=[clip for clip, _fp in existing],
        master_volume=master_volume,
    )
    if not filter_complex:
        import shutil

        shutil.copy2(base_mp4, out_mp4)
        return

    cmd = [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(base_mp4),
    ]
    for clip, fp in existing:
        # Keep source timing in the filter graph.  Passing -ss here as well
        # would make atrim (and speed-ramp segment ranges) apply to an already
        # trimmed input, shifting every non-zero trim_in clip a second time.
        cmd.extend(["-i", str(fp)])
    cmd.extend(
        [
            "-filter_complex",
            filter_complex,
            "-map",
            "0:v:0",
            "-map",
            "[mixa]",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-shortest",
            str(out_mp4),
        ]
    )
    r = _run_ffmpeg_process(cmd, timeout=3600, cancel_event=cancel_event)
    if r.returncode != 0:
        tail = (r.stderr or r.stdout or "").strip()[-600:]
        logger.error("lite_cut audio mix failed: %s", tail)
        raise MontageComposerError("MONTAGE_EXPORT_FAILED")


def _trim_final_export_range(
    *,
    ffmpeg_bin: Path,
    src_mp4: Path,
    out_mp4: Path,
    start_sec: float,
    end_sec: Optional[float],
    video_encode_quality: list[str],
    cancel_event: Any | None = None,
) -> None:
    _raise_if_cancelled(cancel_event)
    start_sec = max(0.0, float(start_sec or 0.0))
    duration = None
    if end_sec is not None:
        duration = max(0.05, float(end_sec) - start_sec)
    cmd = [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{start_sec:.6f}",
        "-i",
        str(src_mp4),
    ]
    if duration is not None:
        cmd.extend(["-t", f"{duration:.6f}"])
    cmd.extend(
        [
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            *video_encode_quality,
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            str(out_mp4),
        ]
    )
    r = _run_ffmpeg_process(cmd, timeout=3600, cancel_event=cancel_event)
    if r.returncode != 0:
        tail = (r.stderr or r.stdout or "").strip()[-600:]
        logger.error("lite_cut range trim failed: %s", tail)
        raise MontageComposerError("MONTAGE_EXPORT_FAILED")


def _build_transitions(clips: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for clip in clips:
        sid = clip.get("source_id")
        if sid is None:
            continue
        tr = clip.get("transition_out")
        if not isinstance(tr, dict):
            continue
        t_type = _map_transition_type(str(tr.get("type") or "cut"))
        try:
            d = float(tr.get("duration_sec", 0.4))
        except (TypeError, ValueError):
            d = 0.4
        out[str(int(sid))] = {"type": t_type, "duration": d}
    return out


def _build_positional_transitions(clips: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for i, clip in enumerate(clips[:-1]):
        incoming = clips[i + 1].get("transition_in")
        tr = incoming if isinstance(incoming, dict) else clip.get("transition_out")
        if not isinstance(tr, dict):
            continue
        t_type = _map_transition_type(str(tr.get("type") or "cut"))
        try:
            d = float(tr.get("duration_sec", 0.4))
        except (TypeError, ValueError):
            d = 0.4
        out[str(i)] = {"type": t_type, "duration": d}
    return out


def _timeline_gap_plan(clips: list[dict[str, Any]], epsilon: float = 0.001) -> list[tuple[int, float]] | None:
    """Return needed pre-clip gaps for a non-overlapping V1 timeline.

    ``None`` signals overlap, which keeps the existing transition compositor in charge.
    """
    cursor = 0.0
    gaps: list[tuple[int, float]] = []
    for index, clip in enumerate(clips):
        start = max(0.0, float(clip.get("timeline_start") or 0.0))
        if start < cursor - epsilon:
            return None
        if start > cursor + epsilon:
            gaps.append((index, start - cursor))
        cursor = max(cursor, start + _clip_timeline_duration_sec(clip))
    return gaps


def _has_soft_positional_transition(clips: list[dict[str, Any]], transitions: dict[str, Any], fps: float) -> bool:
    for index in range(max(0, len(clips) - 1)):
        t_type, duration = _parse_transition_for_edge(transitions, index)
        if not _is_hard_cut(t_type, duration, fps):
            return True
    return False


def _lite_cut_gap_to_ts(
    *,
    ffmpeg_bin: Path,
    out_ts: Path,
    duration: float,
    width: int,
    height: int,
    fps: float,
    background_color: str,
    video_encode_quality: list[str],
    cancel_event: Any | None = None,
) -> None:
    _raise_if_cancelled(cancel_event)
    safe_duration = max(0.02, float(duration))
    fps_s = f"{fps:.4f}".rstrip("0").rstrip(".")
    cmd = [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        f"color=c={background_color}:s={width}x{height}:r={fps_s}:d={safe_duration:.6f}",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-t",
        f"{safe_duration:.6f}",
        *video_encode_quality,
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-shortest",
        str(out_ts),
    ]
    result = _run_ffmpeg_process(cmd, timeout=3600, cancel_event=cancel_event)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip()[-600:]
        logger.error("lite_cut gap render failed: %s", tail)
        raise MontageComposerError("MONTAGE_EXPORT_FAILED")


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
        hold_filter = (
            f"[holdsrc]trim=start={max(0.0, previous_duration - frame):.6f}:end={previous_duration:.6f},"
            f"setpts=PTS-STARTPTS,loop=loop=-1:size=1:start=0,setpts=N/{fps_s}/TB,trim=duration={td:.6f}[hold]"
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


def _lite_cut_boundary_transition_to_ts(
    *,
    ffmpeg_bin: Path,
    ffprobe: Path,
    previous_ts: Path,
    next_ts: Path,
    transition_type: str,
    transition_duration: float,
    fps: float,
    out_ts: Path,
    video_encode_quality: list[str],
    cancel_event: Any | None = None,
) -> None:
    _raise_if_cancelled(cancel_event)
    previous_info = probe_video_audio_summary(previous_ts, ffprobe)
    next_info = probe_video_audio_summary(next_ts, ffprobe)
    previous_duration = max(0.1, float(previous_info.get("duration") or 0.1))
    next_duration = max(0.1, float(next_info.get("duration") or 0.1))
    filter_complex = _boundary_transition_filter_complex(
        transition_type=transition_type,
        duration=transition_duration,
        previous_duration=previous_duration,
        next_duration=next_duration,
        fps=fps,
        previous_has_audio=bool(previous_info.get("has_audio")),
        next_has_audio=bool(next_info.get("has_audio")),
    )
    cmd = [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(previous_ts),
        "-i",
        str(next_ts),
        "-filter_complex",
        filter_complex,
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        *video_encode_quality,
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-ac",
        "2",
        str(out_ts),
    ]
    result = _run_ffmpeg_process(cmd, timeout=7200, cancel_event=cancel_event)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip()[-900:]
        logger.error("lite_cut boundary transition failed: %s", tail)
        raise MontageComposerError("MONTAGE_TRANSITION_FAILED")


def _lite_cut_clip_to_ts(
    *,
    ffmpeg_bin: Path,
    src: Path,
    out_ts: Path,
    clip: dict[str, Any],
    width: int,
    height: int,
    fps: float,
    canvas_fit: str,
    background_color: str,
    blur_amount: int,
    video_encode_quality: list[str],
    transition_in_background: bool = False,
    transition_out_background: bool = False,
    cancel_event: Any | None = None,
) -> None:
    _raise_if_cancelled(cancel_event)
    trim_in = max(0.0, float(clip.get("trim_in") or 0))
    source_duration = _clip_duration_sec(clip)
    timeline_duration = _clip_timeline_duration_sec(clip)
    speed = _clip_speed(clip)
    preserve_pitch = _clip_preserve_pitch(clip)
    volume = _clip_volume(clip)
    ramped = _clip_has_speed_ramp(clip)
    visual_clip = {**clip, "speed": 1.0, "speed_keyframes": []} if ramped else clip
    vf = _clip_video_filter_chain(
        visual_clip,
        width=width,
        height=height,
        fps=fps,
        canvas_fit=canvas_fit,
        background_color=background_color,
        blur_amount=blur_amount,
        timeline_duration_override=timeline_duration if ramped else None,
    )
    af = _audio_filter_chain(
        1.0 if ramped else speed,
        volume,
        reverse=_clip_reverse(clip),
        preserve_pitch=preserve_pitch,
        volume_filter=_clip_volume_filter(clip),
        freeze_frame_sec=_clip_freeze_frame_sec(clip),
    )
    has_canvas_transform = isinstance(clip.get("transform"), dict) or transition_in_background or transition_out_background

    cmd = [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{trim_in:.6f}",
        "-t",
        f"{source_duration:.6f}",
        "-i",
        str(src),
    ]
    if ramped:
        graph_parts: list[str] = []
        video_labels: list[str] = []
        for index, (start, end, segment_speed) in enumerate(_clip_speed_segments(clip)):
            label = f"[rv{index}]"
            video_labels.append(label)
            graph_parts.append(
                f"[0:v]trim=start={start - trim_in:.6f}:end={end - trim_in:.6f},setpts=PTS-STARTPTS,setpts=PTS/{segment_speed:.6f}{label}"
            )
        graph_parts.append("".join(video_labels) + f"concat=n={len(video_labels)}:v=1:a=0[rampv]")
        if has_canvas_transform:
            graph_parts.append(_clip_canvas_transform_graph("[rampv]", "[vout]", clip=clip, fitted_filter=vf, width=width, height=height, fps=fps, duration=timeline_duration, background_color=background_color, transition_in_background=transition_in_background, transition_out_background=transition_out_background))
        else:
            graph_parts.append(f"[rampv]{vf}[vout]")
        has_audio = bool(probe_video_audio_summary(src, resolve_ffprobe_binary(ffmpeg_bin)).get("has_audio"))
        if has_audio:
            audio_labels: list[str] = []
            for index, (start, end, segment_speed) in enumerate(_clip_speed_segments(clip)):
                label = f"[ra{index}]"
                audio_labels.append(label)
                chain = [
                    f"atrim=start={start - trim_in:.6f}:end={end - trim_in:.6f}",
                    "asetpts=PTS-STARTPTS",
                    *(_atempo_chain(segment_speed) if preserve_pitch else _pitch_shift_speed_chain(segment_speed)),
                ]
                graph_parts.append(f"[0:a]{','.join(chain)}{label}")
            graph_parts.append("".join(audio_labels) + f"concat=n={len(audio_labels)}:v=0:a=1[rampa]")
            if af:
                graph_parts.append(f"[rampa]{af}[aout]")
            else:
                graph_parts.append("[rampa]anull[aout]")
        else:
            graph_parts.append(
                f"anullsrc=r=48000:cl=stereo,atrim=0:{timeline_duration:.6f},asetpts=PTS-STARTPTS[aout]"
            )
        cmd.extend(["-filter_complex", ";".join(graph_parts), "-map", "[vout]"])
        cmd.extend(["-map", "[aout]"])
    else:
        has_audio = bool(probe_video_audio_summary(src, resolve_ffprobe_binary(ffmpeg_bin)).get("has_audio"))
        if not has_audio:
            # Keep every normalized TS dual-stream so concat and cut-boundary
            # transitions work for recordings or uploads with no audio track.
            cmd.extend([
                "-f",
                "lavfi",
                "-t",
                f"{timeline_duration + 0.1:.6f}",
                "-i",
                "anullsrc=r=48000:cl=stereo",
            ])
        if has_canvas_transform:
            cmd.extend(["-filter_complex", _clip_canvas_transform_graph("[0:v]", "[vout]", clip=clip, fitted_filter=vf, width=width, height=height, fps=fps, duration=timeline_duration, background_color=background_color, transition_in_background=transition_in_background, transition_out_background=transition_out_background), "-map", "[vout]"])
        else:
            cmd.extend(["-vf", vf])
        if af and has_audio:
            cmd.extend(["-af", af])
        if has_canvas_transform and has_audio:
            cmd.extend(["-map", "0:a:0"])
        if not has_audio:
            cmd.extend([*([] if has_canvas_transform else ["-map", "0:v:0"]), "-map", "1:a:0"])
    cmd.extend([
        *video_encode_quality,
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-shortest",
        str(out_ts),
    ])
    r = _run_ffmpeg_process(cmd, timeout=3600, cancel_event=cancel_event)
    if r.returncode != 0:
        tail = (r.stderr or r.stdout or "").strip()[-600:]
        logger.error("lite_cut clip normalize failed %s: %s", src.name, tail)
        raise MontageComposerError("MONTAGE_CLIP_NORMALIZE_FAILED", name=src.name)


def compose_lite_cut_montage(
    *,
    ffmpeg_bin: Path,
    project_body: dict[str, Any],
    clip_path_by_id: dict[int, Path],
    output_path: Path,
    montage_encoder: str = "auto",
    progress_callback: ProgressCallback | None = None,
    cancel_event: Any | None = None,
) -> None:
    """Export LiteCut schema v2 body — V1 main track with trim, eq, and transitions."""
    _emit_progress(progress_callback, 0.02, "checking")
    _raise_if_cancelled(cancel_event)
    base_track_id, clips = _base_video_track_for_export(project_body)
    if not clips:
        raise MontageComposerError("MONTAGE_NO_CLIPS")
    missing_asset = _first_missing_file_asset_for_export(project_body, base_track_id=base_track_id)
    if missing_asset:
        raise MontageComposerError("MONTAGE_CLIP_FILE_MISSING", name=missing_asset)

    paths: list[Path] = []
    row_ids: list[int] = []
    for i, clip in enumerate(clips):
        if _is_main_file_clip(clip):
            p = Path(str(clip.get("file_path") or "")).expanduser().resolve()
            name = p.name or str(clip.get("file_path") or "uploaded")
        else:
            sid = clip.get("source_id")
            if sid is None:
                raise MontageComposerError("MONTAGE_CLIP_NOT_FOUND", id="?")
            cid = int(sid)
            p = clip_path_by_id.get(cid)
            name = str(sid)
        if p is None or not p.is_file():
            raise MontageComposerError("MONTAGE_CLIP_FILE_MISSING", name=name)
        paths.append(p)
        row_ids.append(i)

    transitions = _build_positional_transitions(clips)
    _codec = resolve_h264_codec_name(ffmpeg_bin, montage_encoder)
    video_encode_quality = h264_encode_cli_args(_codec, _project_encoder_tier(project_body))
    ffprobe = resolve_ffprobe_binary(ffmpeg_bin)

    ref = probe_video_audio_summary(paths[0], ffprobe)
    if int(ref["width"]) <= 0 or int(ref["height"]) <= 0:
        raise MontageComposerError("MONTAGE_FIRST_CLIP_NO_RESOLUTION")
    w, h, fps = _project_output_settings(project_body, ref)
    canvas_fit, background_color, blur_amount = _project_canvas_settings(project_body)
    range_start_sec, range_end_sec = _project_export_range(project_body)
    _emit_progress(progress_callback, 0.08, "normalizing")

    tmpdir = tempfile.mkdtemp(prefix="cs2_lite_cut_", dir=str(output_path.parent))
    try:
        normed: list[Path] = []
        for i, (clip, src) in enumerate(zip(clips, paths)):
            _raise_if_cancelled(cancel_event)
            out_ts = Path(tmpdir) / f"clip_{i:03d}.ts"
            _lite_cut_clip_to_ts(
                ffmpeg_bin=ffmpeg_bin,
                src=src,
                out_ts=out_ts,
                clip=clip,
                width=w,
                height=h,
                fps=fps,
                canvas_fit=canvas_fit,
                background_color=background_color,
                blur_amount=blur_amount,
                video_encode_quality=video_encode_quality,
                transition_in_background=i == 0,
                transition_out_background=i == len(clips) - 1,
                cancel_event=cancel_event,
            )
            normed.append(out_ts)
            _emit_progress(progress_callback, 0.10 + 0.35 * ((i + 1) / max(1, len(clips))), "normalizing")

        gap_plan = _timeline_gap_plan(clips)
        if gap_plan:
            gap_by_index = {index: duration for index, duration in gap_plan}
            timeline_paths: list[Path] = []
            timeline_row_ids: list[int | None] = []
            for index, clip_path in enumerate(normed):
                gap_duration = gap_by_index.get(index)
                if gap_duration is not None:
                    gap_ts = Path(tmpdir) / f"gap_{index:03d}.ts"
                    _lite_cut_gap_to_ts(
                        ffmpeg_bin=ffmpeg_bin,
                        out_ts=gap_ts,
                        duration=gap_duration,
                        width=w,
                        height=h,
                        fps=fps,
                        background_color=background_color,
                        video_encode_quality=video_encode_quality,
                        cancel_event=cancel_event,
                    )
                    timeline_paths.append(gap_ts)
                    timeline_row_ids.append(None)
                timeline_paths.append(clip_path)
                timeline_row_ids.append(row_ids[index])
            normed = timeline_paths
            row_ids = timeline_row_ids

        n_clips = len(normed)
        concat_paths: list[Path]
        if n_clips >= 2 and transitions:
            processed: list[Path] = []
            current = normed[0]
            current_row_id = row_ids[0]
            for index in range(1, n_clips):
                _raise_if_cancelled(cancel_event)
                next_row_id = row_ids[index]
                if current_row_id is None or next_row_id is None:
                    t_type, t_dur = "none", 0.0
                else:
                    t_type, t_dur = _parse_transition_for_edge(transitions, current_row_id)
                if _is_hard_cut(t_type, t_dur, fps):
                    processed.append(current)
                    current = normed[index]
                else:
                    transition_ts = Path(tmpdir) / f"transition_{index:03d}.ts"
                    _lite_cut_boundary_transition_to_ts(
                        ffmpeg_bin=ffmpeg_bin,
                        ffprobe=ffprobe,
                        previous_ts=current,
                        next_ts=normed[index],
                        transition_type=t_type,
                        transition_duration=t_dur,
                        fps=fps,
                        out_ts=transition_ts,
                        video_encode_quality=video_encode_quality,
                        cancel_event=cancel_event,
                    )
                    current = transition_ts
                current_row_id = next_row_id
                _emit_progress(progress_callback, 0.48 + 0.10 * (index / max(1, n_clips - 1)), "transitions")
            processed.append(current)
            concat_paths = processed
        else:
            concat_paths = normed
            _emit_progress(progress_callback, 0.58, "transitions")

        _raise_if_cancelled(cancel_event)
        concat_list = Path(tmpdir) / "concat.txt"
        concat_list.write_text("\n".join(_concat_file_line(p) for p in concat_paths) + "\n", encoding="utf-8")
        _emit_progress(progress_callback, 0.62, "concat")

        cmd_concat = [
            str(ffmpeg_bin),
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_list),
            "-c",
            "copy",
            str(output_path),
        ]
        r = _run_ffmpeg_process(cmd_concat, timeout=3600, cancel_event=cancel_event)
        if r.returncode != 0:
            tail = (r.stderr or r.stdout or "").strip()[-600:]
            logger.error("lite_cut concat failed: %s", tail)
            raise MontageComposerError("MONTAGE_EXPORT_FAILED")
        _emit_progress(progress_callback, 0.68, "concat")

        overlay_clips = _resolve_overlay_clip_paths(
            _all_overlay_clips_for_export(project_body, base_track_id=base_track_id),
            clip_path_by_id,
        )
        if overlay_clips:
            _raise_if_cancelled(cancel_event)
            v1_base = Path(tmpdir) / "v1_concat.mp4"
            import shutil

            shutil.move(str(output_path), str(v1_base))
            _composite_overlays_on_base(
                ffmpeg_bin=ffmpeg_bin,
                ffprobe=ffprobe,
                base_mp4=v1_base,
                overlay_clips=overlay_clips,
                out_mp4=output_path,
                video_encode_quality=video_encode_quality,
                progress_callback=progress_callback,
                cancel_event=cancel_event,
                progress_start=0.70,
                progress_end=0.84,
            )
        else:
            _emit_progress(progress_callback, 0.84, "overlays")

        audio_clips = [
            *_audio_track_clips_for_export(project_body),
            *_video_layer_audio_clips_for_export(project_body, base_track_id=base_track_id),
        ]
        audio_clips = _resolve_audio_clip_paths(audio_clips, clip_path_by_id)
        bgm_clip = _project_bgm_clip_for_export(project_body)
        if bgm_clip and not _has_solo_audio_tracks(project_body):
            audio_clips = [*audio_clips, bgm_clip]
        master_volume = _project_master_volume(project_body)
        if audio_clips or abs(master_volume - 1.0) > 1e-6:
            _raise_if_cancelled(cancel_event)
            _emit_progress(progress_callback, 0.88, "audio")
            audio_base = Path(tmpdir) / "visual_base.mp4"
            import shutil

            shutil.move(str(output_path), str(audio_base))
            _mix_audio_tracks_on_base(
                ffmpeg_bin=ffmpeg_bin,
                ffprobe=ffprobe,
                base_mp4=audio_base,
                audio_clips=audio_clips,
                out_mp4=output_path,
                master_volume=master_volume,
                cancel_event=cancel_event,
            )
            _emit_progress(progress_callback, 0.96, "audio")
        else:
            _emit_progress(progress_callback, 0.96, "audio")
        if range_start_sec > 0.0 or range_end_sec is not None:
            _raise_if_cancelled(cancel_event)
            _emit_progress(progress_callback, 0.98, "range")
            range_base = Path(tmpdir) / "full_range_base.mp4"
            import shutil

            shutil.move(str(output_path), str(range_base))
            _trim_final_export_range(
                ffmpeg_bin=ffmpeg_bin,
                src_mp4=range_base,
                out_mp4=output_path,
                start_sec=range_start_sec,
                end_sec=range_end_sec,
                video_encode_quality=video_encode_quality,
                cancel_event=cancel_event,
            )
        _raise_if_cancelled(cancel_event)
        _emit_progress(progress_callback, 1.0, "done")
    finally:
        import shutil

        shutil.rmtree(tmpdir, ignore_errors=True)


def export_lite_cut_project(
    *,
    ffmpeg_bin: Path,
    project_body: dict[str, Any],
    clip_path_by_id: dict[int, Path],
    output_path_str: str,
    montage_encoder: str = "auto",
    progress_callback: ProgressCallback | None = None,
    cancel_event: Any | None = None,
) -> Path:
    out = validate_output_path(output_path_str)
    try:
        compose_lite_cut_montage(
            ffmpeg_bin=ffmpeg_bin,
            project_body=project_body,
            clip_path_by_id=clip_path_by_id,
            output_path=out,
            montage_encoder=montage_encoder,
            progress_callback=progress_callback,
            cancel_event=cancel_event,
        )
    except BaseException:
        try:
            out.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return out
