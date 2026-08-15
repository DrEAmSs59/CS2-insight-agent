"""Main video-clip filter graph builders for LiteCut exports."""

from __future__ import annotations

from typing import Any, Optional

from .effect_contract import filter_preset_ffmpeg_map
from .timeline import _clip_crop_filter
from .timeline_math import (
    clip_freeze_frame_sec as _clip_freeze_frame_sec,
    clip_has_speed_ramp as _clip_has_speed_ramp,
    clip_reverse as _clip_reverse,
    clip_speed as _clip_speed,
)

_FILTER_PRESET_VF = filter_preset_ffmpeg_map()


def _user_eq_filter(color: dict[str, Any]) -> str:
    """Build the user brightness/contrast/saturation equalizer chain."""
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
    """Combine the selected filter preset and user color controls."""
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
    del width, height, canvas_fit, background_color, blur_amount, timeline_duration_override
    fps_s = f"{fps:.4f}".rstrip("0").rstrip(".")
    crop_filter = _clip_crop_filter(clip)
    vf_parts = ([crop_filter] if crop_filter else []) + [f"fps={fps_s}", "setsar=1", "format=rgba"]
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
    return ",".join(vf_parts)
