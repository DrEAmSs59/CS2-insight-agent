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
SEGMENT_PREVIEW_LARGE_FILE_BYTES = 256 * 1024 * 1024
SEGMENT_PREVIEW_STEP_SEC = 4.0
SEGMENT_PREVIEW_ENCODE_SEC = 4.5
SEGMENT_PREVIEW_SCHEMA = "segment-v1"
SEGMENT_PREVIEW_ALPHA_SCHEMA = "segment-alpha-v1"


def probe_webp_container(path: Path) -> dict[str, object]:
    """Read WebP container facts that are needed before FFprobe dispatch.

    Static and animated WebP share the same extension.  Reading RIFF chunk
    headers lets LiteCut keep static WebP on the image path while routing ANIM
    and ANMF files through the controllable video-preview path.
    """
    facts: dict[str, object] = {
        "animated": False,
        "has_alpha": False,
        "duration_sec": None,
        "width": None,
        "height": None,
    }
    if path.suffix.lower() != ".webp":
        return facts
    frame_duration_ms = 0
    try:
        with path.open("rb") as source:
            header = source.read(12)
            if len(header) < 12 or header[:4] != b"RIFF" or header[8:12] != b"WEBP":
                return facts
            while True:
                chunk_header = source.read(8)
                if len(chunk_header) < 8:
                    break
                chunk_type = chunk_header[:4]
                chunk_size = int.from_bytes(chunk_header[4:8], "little")
                # All relevant facts live near the payload header; seek over
                # the remaining compressed frame bytes without loading them.
                payload = source.read(min(chunk_size, 64))
                if chunk_type == b"VP8X" and len(payload) >= 10:
                    flags = payload[0]
                    facts["animated"] = bool(flags & 0x02)
                    facts["has_alpha"] = bool(flags & 0x10)
                    facts["width"] = 1 + int.from_bytes(payload[4:7], "little")
                    facts["height"] = 1 + int.from_bytes(payload[7:10], "little")
                elif chunk_type in {b"ANIM", b"ANMF"}:
                    facts["animated"] = True
                    if chunk_type == b"ANMF" and len(payload) >= 16:
                        frame_duration_ms += int.from_bytes(payload[12:15], "little")
                        nested_type = payload[16:20]
                        if nested_type in {b"ALPH", b"VP8L"}:
                            facts["has_alpha"] = True
                elif chunk_type == b"ALPH":
                    facts["has_alpha"] = True
                elif chunk_type == b"VP8 " and len(payload) >= 10 and payload[3:6] == b"\x9d\x01\x2a":
                    facts["width"] = int.from_bytes(payload[6:8], "little") & 0x3FFF
                    facts["height"] = int.from_bytes(payload[8:10], "little") & 0x3FFF
                elif chunk_type == b"VP8L" and len(payload) >= 5 and payload[0] == 0x2F:
                    facts["width"] = 1 + payload[1] + ((payload[2] & 0x3F) << 8)
                    facts["height"] = 1 + ((payload[2] >> 6) | (payload[3] << 2) | ((payload[4] & 0x0F) << 10))
                    facts["has_alpha"] = True
                source.seek(chunk_size - len(payload) + (chunk_size & 1), 1)
    except OSError:
        return facts

    if frame_duration_ms > 0:
        facts["duration_sec"] = frame_duration_ms / 1000.0
    return facts


def webp_is_animated(path: Path) -> bool:
    return bool(probe_webp_container(path).get("animated"))


def is_looping_animation_path(path: Path) -> bool:
    suffix = path.suffix.lower()
    return suffix == ".gif" or (suffix == ".webp" and webp_is_animated(path))


def _preview_input_seek_args(source: Path, start_sec: float) -> list[str]:
    seek = f"{max(0.0, float(start_sec)):.6f}"
    # FFmpeg 9's webp_anim demuxer is sequential and produces no frames when
    # even a zero-second input seek is placed before ``-i``.  Output seeking
    # decodes forward and works for every animation frame.
    if source.suffix.lower() == ".webp":
        return ["-i", str(source), "-ss", seek]
    return ["-ss", seek, "-i", str(source)]


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


def asset_needs_segmented_preview(
    path: Path,
    *,
    kind: str | None = None,
    storage_mode: str | None = None,
    size_bytes: int | None = None,
    video_codec: str | None = None,
    duration_sec: float | None = None,
    fps: float | None = None,
) -> bool:
    """Select playhead-driven proxying without coupling it to timeline use."""
    if str(kind or "").lower() not in {"video", "webm"}:
        return False
    try:
        source_size = int(size_bytes) if size_bytes is not None else int(path.stat().st_size)
    except (OSError, TypeError, ValueError):
        source_size = 0
    return path.suffix.lower() == ".webp" or asset_needs_browser_proxy(
        path,
        video_codec=video_codec,
        duration_sec=duration_sec,
        fps=fps,
    ) or (
        str(storage_mode or "").lower() == "link"
        and source_size >= SEGMENT_PREVIEW_LARGE_FILE_BYTES
    )


def preview_segment_command(
    *,
    ffmpeg_bin: Path,
    source: Path,
    output: Path,
    start_sec: float,
    duration_sec: float,
    video_encode_quality: list[str],
    max_edge: int = 720,
) -> list[str]:
    """Build one independently playable, accurately sought MP4 preview window."""
    edge = max(360, min(2160, int(max_edge or 720)))
    return [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-abort_on",
        "empty_output",
        *_preview_input_seek_args(source, start_sec),
        "-t",
        f"{max(0.05, float(duration_sec)):.6f}",
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-vf",
        f"scale=w='if(gte(iw,ih),min({edge},iw),-2)':h='if(gte(iw,ih),-2,min({edge},ih))'",
        *video_encode_quality,
        "-fpsmax",
        "60",
        "-g",
        "30",
        "-force_key_frames",
        "expr:gte(t,n_forced*0.5)",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-af",
        "aresample=async=1:first_pts=0",
        "-avoid_negative_ts",
        "make_zero",
        "-movflags",
        "+faststart",
        str(output),
    ]


def alpha_preview_segment_command(
    *,
    ffmpeg_bin: Path,
    source: Path,
    output: Path,
    start_sec: float,
    duration_sec: float,
    max_edge: int = 720,
) -> list[str]:
    """Build one VP9 WebM preview window while preserving the alpha plane."""
    edge = max(360, min(2160, int(max_edge or 720)))
    return [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-abort_on",
        "empty_output",
        *_preview_input_seek_args(source, start_sec),
        "-t",
        f"{max(0.05, float(duration_sec)):.6f}",
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-vf",
        f"scale=w='if(gte(iw,ih),min({edge},iw),-2)':h='if(gte(iw,ih),-2,min({edge},ih))',format=yuva420p",
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuva420p",
        "-auto-alt-ref",
        "0",
        "-deadline",
        "realtime",
        "-cpu-used",
        "6",
        "-row-mt",
        "1",
        "-b:v",
        "0",
        "-crf",
        "30",
        "-fpsmax",
        "30",
        "-metadata:s:v:0",
        "alpha_mode=1",
        "-c:a",
        "libopus",
        "-b:a",
        "96k",
        "-avoid_negative_ts",
        "make_zero",
        str(output),
    ]


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
