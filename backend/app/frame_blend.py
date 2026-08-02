"""Shared FFmpeg helpers for optional temporal frame blending."""

from __future__ import annotations

from pathlib import Path
from typing import Sequence


FRAME_BLEND_DEFAULT_FRAMES = 5
FRAME_BLEND_MIN_FRAMES = 2
FRAME_BLEND_MAX_FRAMES = 9
FRAME_BLEND_MIN_FPS = 1.0
FRAME_BLEND_MAX_FPS = 1000.0


def normalize_frame_blend_frames(enabled: bool, frames: object = FRAME_BLEND_DEFAULT_FRAMES) -> int:
    """Return 1 when disabled, otherwise a bounded tmix frame count."""
    if not enabled:
        return 1
    try:
        value = int(frames)
    except (TypeError, ValueError):
        value = FRAME_BLEND_DEFAULT_FRAMES
    return max(FRAME_BLEND_MIN_FRAMES, min(FRAME_BLEND_MAX_FRAMES, value))


def resolve_frame_blend_output_fps(
    working_fps: object,
    *,
    high_frame_downsample_enabled: bool = False,
    delivery_fps: object | None = None,
) -> float:
    """Return the delivery FPS only for a valid high-to-low frame downsample."""
    try:
        safe_working_fps = float(working_fps)
    except (TypeError, ValueError):
        safe_working_fps = 60.0
    safe_working_fps = max(FRAME_BLEND_MIN_FPS, min(FRAME_BLEND_MAX_FPS, safe_working_fps))
    if not high_frame_downsample_enabled:
        return safe_working_fps
    try:
        safe_delivery_fps = float(delivery_fps)
    except (TypeError, ValueError):
        return safe_working_fps
    safe_delivery_fps = max(FRAME_BLEND_MIN_FPS, min(FRAME_BLEND_MAX_FPS, safe_delivery_fps))
    return safe_delivery_fps if safe_delivery_fps < safe_working_fps else safe_working_fps


def build_frame_blend_filter(frames: int, fps: float) -> str:
    """Build the final video filter without synthesizing motion positions."""
    safe_frames = normalize_frame_blend_frames(True, frames)
    safe_fps = max(FRAME_BLEND_MIN_FPS, min(FRAME_BLEND_MAX_FPS, float(fps)))
    fps_s = f"{safe_fps:.4f}".rstrip("0").rstrip(".")
    weights = " ".join("1" for _ in range(safe_frames))
    return (
        f"tmix=frames={safe_frames}:weights='{weights}',"
        f"fps={fps_s},setsar=1,format=yuv420p"
    )


def build_frame_blend_command(
    *,
    ffmpeg_bin: Path,
    source_path: Path,
    output_path: Path,
    frames: int,
    fps: float,
    video_encode_args: Sequence[str],
) -> list[str]:
    """Build a final-pass command that blends video while stream-copying audio."""
    return [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source_path),
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-vf",
        build_frame_blend_filter(frames, fps),
        *video_encode_args,
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        str(output_path),
    ]
