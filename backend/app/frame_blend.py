"""Shared final-pass helpers for the required custom Blur FFmpeg runtime."""

from __future__ import annotations

import subprocess
from functools import lru_cache
from pathlib import Path
from typing import Sequence


FRAME_BLEND_DEFAULT_FRAMES = 5
FRAME_BLEND_MIN_FRAMES = 2
FRAME_BLEND_MAX_FRAMES = 9
FRAME_BLEND_MIN_FPS = 1.0
FRAME_BLEND_MAX_FPS = 1000.0
FRAME_BLEND_MIN_SOURCE_FPS = 1.0
BLUR_RUNTIME_HELP_MARKER = "FFmpeg Insight headless Blur mode"


def normalize_frame_blend_frames(enabled: bool, frames: object = FRAME_BLEND_DEFAULT_FRAMES) -> int:
    """Preserve the existing project setting as an enabled/disabled marker."""
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


def is_frame_blend_source_supported(source_fps: object | None) -> bool:
    """The custom Blur route accepts every known positive source frame rate."""
    try:
        safe_source_fps = float(source_fps)
    except (TypeError, ValueError):
        return False
    return safe_source_fps >= FRAME_BLEND_MIN_SOURCE_FPS


@lru_cache(maxsize=16)
def _supports_blur_pipeline_cached(path: str, modified_ns: int) -> bool:
    del modified_ns
    try:
        result = subprocess.run(
            [path, "-blur", "--help"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    output = "\n".join(part for part in (result.stdout, result.stderr) if part)
    return result.returncode == 0 and BLUR_RUNTIME_HELP_MARKER in output


def supports_blur_pipeline(ffmpeg_bin: Path) -> bool:
    """Return whether ``ffmpeg_bin`` exposes the custom ``-blur`` route."""

    resolved = Path(ffmpeg_bin).resolve()
    try:
        modified_ns = resolved.stat().st_mtime_ns
    except OSError:
        modified_ns = 0
    return _supports_blur_pipeline_cached(str(resolved), modified_ns)


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
    """Build the required custom Blur final pass.

    The completed edit is a single input at this point, so the dedicated Blur
    route can safely own interpolation, duplicate repair and Vegas-weighted
    motion blur without having to understand the editor's multi-input graph.
    """

    # ``frames`` and ``source_fps`` remain in the API so existing saved project
    # schemas and call sites stay compatible. The custom runtime owns its
    # interpolation target and Vegas weighting policy.
    del frames, source_fps

    options = [str(item) for item in video_encode_args]

    def value_after(*names: str) -> str | None:
        for name in names:
            try:
                index = options.index(name)
            except ValueError:
                continue
            if index + 1 < len(options):
                return options[index + 1]
        return None

    codec = value_after("-c:v", "-codec:v", "-vcodec") or "h264"
    quality = value_after("-cq", "-crf", "-global_quality", "-qp_i", "-qp_p") or "20"
    encoder_device = value_after("-gpu")
    delivery_fps = max(1, int(round(float(fps))))

    command = [
        str(ffmpeg_bin),
        "-blur",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source_path),
        "--performance-mode",
        "balanced",
        "--blur-output-fps",
        str(delivery_fps),
        "--weighting",
        "vegas",
        "--blur-amount",
        "1",
        "--blur-gamma",
        "1",
        "--deduplicate-method",
        "rife",
        "-c:v",
        codec,
        "-cq",
        quality,
    ]
    if encoder_device is not None and codec.casefold().endswith("_nvenc"):
        command.extend(["-gpu", encoder_device])
    command.extend(["-c:a", "copy", str(output_path)])
    return command
