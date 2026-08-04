"""Shared FFmpeg helpers for optional temporal frame blending."""

from __future__ import annotations

from pathlib import Path
from typing import Sequence


FRAME_BLEND_DEFAULT_FRAMES = 5
FRAME_BLEND_MIN_FRAMES = 2
FRAME_BLEND_MAX_FRAMES = 9
FRAME_BLEND_MIN_FPS = 1.0
FRAME_BLEND_MAX_FPS = 1000.0
FRAME_BLEND_FPS_MATCH_TOLERANCE = 0.5
FRAME_BLEND_MIN_SOURCE_FPS = 120.0
FRAME_BLEND_HERMITE_SHARPEN = "unsharp=5:5:0.3:5:5:0"


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


def _matches_frame_rate(actual: float, expected: float) -> bool:
    return abs(actual - expected) <= FRAME_BLEND_FPS_MATCH_TOLERANCE


def is_frame_blend_source_supported(source_fps: object | None) -> bool:
    """Frame blending starts at 120 FPS; 60 FPS sources stay untouched."""
    try:
        safe_source_fps = float(source_fps)
    except (TypeError, ValueError):
        return False
    return safe_source_fps >= FRAME_BLEND_MIN_SOURCE_FPS - FRAME_BLEND_FPS_MATCH_TOLERANCE


def build_frame_blend_filter(frames: int, fps: float, *, source_fps: object | None = None) -> str:
    """Build the final video filter.

    Any supported source at or above 120 FPS delivered at 60 FPS uses
    libplacebo's Hermite temporal mixer plus the same light sharpening used
    by the reference exports. This keeps intermediate rates such as 144,
    180, and 360 FPS on the same motion-blur path as 120/240 FPS.
    Sources below 120 FPS skip temporal blending. Other supported/manual
    frame-blend cases retain the legacy tmix path.
    """
    safe_frames = normalize_frame_blend_frames(True, frames)
    safe_fps = max(FRAME_BLEND_MIN_FPS, min(FRAME_BLEND_MAX_FPS, float(fps)))
    fps_s = f"{safe_fps:.4f}".rstrip("0").rstrip(".")
    if source_fps is not None and not is_frame_blend_source_supported(source_fps):
        return f"fps={fps_s},setsar=1,format=yuv420p"
    if (
        source_fps is not None
        and is_frame_blend_source_supported(source_fps)
        and _matches_frame_rate(safe_fps, 60.0)
    ):
        return (
            f"libplacebo=fps={fps_s}:frame_mixer=hermite:format=yuv420p,"
            f"{FRAME_BLEND_HERMITE_SHARPEN},setsar=1"
        )
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
    source_fps: object | None = None,
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
        build_frame_blend_filter(frames, fps, source_fps=source_fps),
        *video_encode_args,
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        str(output_path),
    ]
