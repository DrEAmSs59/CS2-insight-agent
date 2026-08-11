"""Pure LiteCut media classification, preview policy and FFmpeg command plans."""

from __future__ import annotations

import math
from pathlib import Path

KIND_BY_EXTENSION = {
    ".webm": "webm", ".mp4": "video", ".mov": "video", ".m4v": "video",
    ".mkv": "video", ".avi": "video", ".mp3": "audio", ".wav": "audio",
    ".m4a": "audio", ".aac": "audio", ".ogg": "audio", ".flac": "audio",
    ".png": "image", ".gif": "video", ".jpg": "image", ".jpeg": "image",
    ".webp": "image", ".woff": "font", ".woff2": "font", ".ttf": "font",
    ".otf": "font",
}
BROWSER_PROXY_EXTENSIONS = frozenset({".avi", ".mkv", ".gif", ".mov"})
MP4_LIKE_EXTENSIONS = frozenset({".mp4", ".m4v"})
HEVC_SAMPLE_ENTRY_TAGS = (b"hvc1", b"hev1", b"dvhe", b"dvh1")
MP4_CODEC_SCAN_BYTES = 2 * 1024 * 1024
DIRECT_PREVIEW_MAX_FPS = 120.0
DIRECT_PREVIEW_MAX_BITRATE = 40_000_000.0


def asset_kind_for_path(path: Path) -> str:
    return KIND_BY_EXTENSION.get(path.suffix.lower(), "file")


def mp4_container_mentions_hevc(path: Path) -> bool:
    if path.suffix.lower() not in MP4_LIKE_EXTENSIONS:
        return False
    try:
        size = path.stat().st_size
        with path.open("rb") as source:
            chunks = [source.read(MP4_CODEC_SCAN_BYTES)]
            if size > MP4_CODEC_SCAN_BYTES:
                source.seek(max(0, size - MP4_CODEC_SCAN_BYTES))
                chunks.append(source.read(MP4_CODEC_SCAN_BYTES))
    except OSError:
        return False
    return any(tag in chunk for chunk in chunks for tag in HEVC_SAMPLE_ENTRY_TAGS)


def asset_exceeds_direct_preview_limits(path: Path, *, duration_sec: float | None = None, fps: float | None = None) -> bool:
    try:
        source_fps = float(fps or 0)
    except (TypeError, ValueError):
        source_fps = 0.0
    if math.isfinite(source_fps) and source_fps > DIRECT_PREVIEW_MAX_FPS:
        return True
    try:
        duration = float(duration_sec or 0)
    except (TypeError, ValueError):
        duration = 0.0
    if not math.isfinite(duration) or duration <= 0:
        return False
    try:
        bitrate = path.stat().st_size * 8.0 / duration
    except OSError:
        return False
    return bitrate > DIRECT_PREVIEW_MAX_BITRATE


def asset_needs_browser_proxy(
    path: Path,
    *,
    video_codec: str | None = None,
    duration_sec: float | None = None,
    fps: float | None = None,
) -> bool:
    extension = path.suffix.lower()
    if extension in BROWSER_PROXY_EXTENSIONS:
        return True
    if extension not in MP4_LIKE_EXTENSIONS:
        return False
    codec = str(video_codec or "").strip().lower()
    return (
        codec in {"hevc", "h265", "h.265"}
        or mp4_container_mentions_hevc(path)
        or asset_exceeds_direct_preview_limits(path, duration_sec=duration_sec, fps=fps)
    )


def preview_proxy_remux_command(
    *, ffmpeg_bin: Path, source: Path, output: Path,
    duration_sec: float | None = None, copy_audio: bool = False,
) -> list[str]:
    command = [str(ffmpeg_bin), "-y", "-hide_banner", "-loglevel", "error", "-i", str(source)]
    if duration_sec is not None and duration_sec > 0:
        command.extend(["-t", f"{float(duration_sec):.6f}"])
    command.extend([
        "-map", "0:v:0", "-map", "0:a?", "-c:v", "copy",
        "-c:a", "copy" if copy_audio else "aac",
    ])
    if not copy_audio:
        command.extend(["-b:a", "96k"])
    command.extend(["-movflags", "+faststart", "-avoid_negative_ts", "make_zero", str(output)])
    return command


def preview_proxy_command(
    *, ffmpeg_bin: Path, source: Path, output: Path, video_encode_quality: list[str],
    duration_sec: float | None = None, max_edge: int = 1280,
) -> list[str]:
    edge = max(360, min(2160, int(max_edge or 1280)))
    command = [str(ffmpeg_bin), "-y", "-hide_banner", "-loglevel", "error", "-i", str(source)]
    if duration_sec is not None and duration_sec > 0:
        command.extend(["-t", f"{float(duration_sec):.6f}"])
    command.extend([
        "-map", "0:v:0", "-map", "0:a?",
        "-vf", f"scale=w='if(gte(iw,ih),min({edge},iw),-2)':h='if(gte(iw,ih),-2,min({edge},ih))'",
        *video_encode_quality,
        "-fpsmax", "60", "-g", "30", "-force_key_frames", "expr:gte(t,n_forced*0.5)",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(output),
    ])
    return command


def alpha_preview_proxy_command(
    *, ffmpeg_bin: Path, source: Path, output: Path,
    duration_sec: float | None = None, max_edge: int = 1280,
) -> list[str]:
    edge = max(360, min(2160, int(max_edge or 1280)))
    command = [str(ffmpeg_bin), "-y", "-hide_banner", "-loglevel", "error", "-i", str(source)]
    if duration_sec is not None and duration_sec > 0:
        command.extend(["-t", f"{min(600.0, float(duration_sec)):.6f}"])
    command.extend([
        "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", f"scale=w='if(gte(iw,ih),min({edge},iw),-2)':h='if(gte(iw,ih),-2,min({edge},ih))',format=yuva420p",
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0",
        "-deadline", "good", "-cpu-used", "5", "-row-mt", "1", "-b:v", "0", "-crf", "28",
        "-fpsmax", "30", "-metadata:s:v:0", "alpha_mode=1", "-c:a", "libopus", "-b:a", "128k", str(output),
    ])
    return command
