"""Side-effect executor for one LiteCut browser-preview proxy attempt."""

from __future__ import annotations

import logging
import re
import uuid
from pathlib import Path
from typing import Any

from ...env_utils import load_config
from ...montage_encoder import h264_encode_cli_args
from ...video_composer import (
    probe_video_audio_summary,
    resolve_ffmpeg_binary,
    resolve_ffprobe_binary,
    resolve_h264_codec_name,
)
from .runtime import LiteCutPreviewProxyJob
from .media_metadata import MediaMetadata
from .media_policy import (
    SEGMENT_PREVIEW_ALPHA_SCHEMA,
    SEGMENT_PREVIEW_ENCODE_SEC,
    SEGMENT_PREVIEW_SCHEMA,
    SEGMENT_PREVIEW_STEP_SEC,
    alpha_preview_segment_command,
    preview_segment_command,
)

logger = logging.getLogger(__name__)


def preview_segment_index(time_sec: float) -> int:
    return max(0, int(max(0.0, float(time_sec or 0.0)) // SEGMENT_PREVIEW_STEP_SEC))


def preview_segment_start(index: int) -> float:
    return max(0, int(index)) * SEGMENT_PREVIEW_STEP_SEC


def preview_segment_cache_directory(
    row: dict[str, Any],
    project_directory: Path,
    *,
    max_edge: int,
) -> Path:
    from .assets import lite_cut_assets_dir

    root = lite_cut_assets_dir().resolve()
    project_root = project_directory.expanduser().resolve()
    project_root.relative_to(root)
    fingerprint = re.sub(r"[^a-zA-Z0-9_-]+", "", str(row.get("fingerprint") or "source"))[:20] or "source"
    asset_id = max(0, int(row.get("id") or 0))
    edge = max(360, min(2160, int(max_edge or 720)))
    schema = SEGMENT_PREVIEW_ALPHA_SCHEMA if bool(row.get("has_alpha")) else SEGMENT_PREVIEW_SCHEMA
    return project_root / ".preview" / f"asset-{asset_id}-{fingerprint}" / f"{schema}-{edge}p"


def preview_segment_path(cache_directory: Path, index: int) -> Path:
    extension = ".webm" if cache_directory.name.startswith(f"{SEGMENT_PREVIEW_ALPHA_SCHEMA}-") else ".mp4"
    return cache_directory / f"segment-{max(0, int(index)):08d}{extension}"


def execute_preview_segment(
    job,
    row: dict[str, Any],
    *,
    segment_index: int,
    cache_directory: Path,
    max_edge: int,
) -> tuple[Path, float, str]:
    """Generate one short browser segment, preserving alpha when present."""
    from .assets import _run_proxy_process, asset_source_path

    source = asset_source_path(row)
    start_sec = preview_segment_start(segment_index)
    total_duration = max(0.0, float(row.get("duration_sec") or 0.0))
    segment_duration = SEGMENT_PREVIEW_ENCODE_SEC
    if total_duration > 0:
        segment_duration = min(segment_duration, total_duration - start_sec)
    if segment_duration <= 0.05:
        raise ValueError("preview segment is outside the source duration")

    cache_directory.mkdir(parents=True, exist_ok=True)
    output = preview_segment_path(cache_directory, segment_index)
    if output.is_file() and output.stat().st_size > 0:
        return output, segment_duration, "cached"

    cfg = load_config()
    ffmpeg_bin = resolve_ffmpeg_binary(cfg.ffmpeg_path)
    if bool(row.get("has_alpha")):
        temporary = output.with_name(f".{output.stem}.{uuid.uuid4().hex[:8]}.partial{output.suffix}")
        command = alpha_preview_segment_command(
            ffmpeg_bin=ffmpeg_bin,
            source=source,
            output=temporary,
            start_sec=start_sec,
            duration_sec=segment_duration,
            max_edge=max_edge,
        )
        try:
            result = _run_proxy_process(
                command,
                cancel_event=job.cancel_event,
                idle_priority=str(getattr(job, "priority", "interactive")) == "prefetch",
            )
            if result.returncode == 0 and temporary.is_file() and temporary.stat().st_size > 0:
                temporary.replace(output)
                return output, segment_duration, "libvpx-vp9-alpha"
            raise RuntimeError((result.stderr or "alpha preview segment generation failed")[-2000:])
        finally:
            temporary.unlink(missing_ok=True)

    preferred_codec = resolve_h264_codec_name(ffmpeg_bin, "auto")
    attempts = [preferred_codec]
    if preferred_codec != "libx264":
        attempts.append("libx264")
    last_error = "preview segment generation failed"
    for codec in attempts:
        if job.cancel_event.is_set():
            raise RuntimeError("cancelled")
        temporary = output.with_name(f".{output.stem}.{uuid.uuid4().hex[:8]}.partial{output.suffix}")
        command = preview_segment_command(
            ffmpeg_bin=ffmpeg_bin,
            source=source,
            output=temporary,
            start_sec=start_sec,
            duration_sec=segment_duration,
            video_encode_quality=h264_encode_cli_args(codec, "fast"),
            max_edge=max_edge,
        )
        try:
            result = _run_proxy_process(
                command,
                cancel_event=job.cancel_event,
                idle_priority=str(getattr(job, "priority", "interactive")) == "prefetch",
            )
            if result.returncode == 0 and temporary.is_file() and temporary.stat().st_size > 0:
                temporary.replace(output)
                return output, segment_duration, codec
            last_error = (result.stderr or last_error)[-2000:]
        finally:
            temporary.unlink(missing_ok=True)
        if job.cancel_event.is_set():
            raise RuntimeError("cancelled")
        logger.warning(
            "LiteCut segmented preview attempt failed asset=%s segment=%s encoder=%s: %s",
            row.get("id"),
            segment_index,
            codec,
            last_error,
        )
    raise RuntimeError(last_error)


def _row_requires_or_has_preview_proxy(row: dict[str, Any]) -> bool:
    from .assets import (
        asset_preview_paths,
        asset_needs_browser_proxy,
    )

    source = Path(str(row.get("file_path") or ""))
    if not source.is_file():
        return False
    normal_proxy, alpha_proxy = asset_preview_paths(row)
    if normal_proxy.is_file() or alpha_proxy.is_file():
        return True
    return asset_needs_browser_proxy(source, duration_sec=row.get("duration_sec"))


def proxy_cache_inventory(asset_rows: list[dict[str, Any]]) -> dict[str, Any]:
    from .assets import (
        asset_preview_paths,
        lite_cut_assets_dir,
    )

    used = 0
    files = 0
    ready = 0
    for row in asset_rows:
        source = Path(str(row.get("file_path") or ""))
        for candidate in asset_preview_paths(row):
            try:
                if candidate.is_file():
                    used += candidate.stat().st_size
                    files += 1
                    ready += 1
            except OSError:
                pass
    source_requirements = {
        (source.parent, source.stem): _row_requires_or_has_preview_proxy(row)
        for row in asset_rows
        if row.get("file_path")
        for source in [Path(str(row["file_path"])).resolve()]
    }
    orphan_bytes = 0
    orphan_files = 0
    for candidate in lite_cut_assets_dir().resolve().rglob("*.preview*"):
        if not candidate.is_file():
            continue
        stem = candidate.name.split(".preview", 1)[0]
        if source_requirements.get((candidate.parent, stem)) is not True:
            try:
                orphan_bytes += candidate.stat().st_size
                orphan_files += 1
            except OSError:
                pass
    return {
        "proxy_bytes": used,
        "proxy_files": files,
        "ready_assets": ready,
        "asset_count": len(asset_rows),
        "proxy_required_assets": sum(1 for row in asset_rows if _row_requires_or_has_preview_proxy(row)),
        "orphan_bytes": orphan_bytes,
        "orphan_files": orphan_files,
    }


def remove_asset_preview_files(row: dict[str, Any]) -> None:
    from .assets import asset_preview_paths

    for candidate in asset_preview_paths(row):
        candidate.unlink(missing_ok=True)


def remove_segment_preview_files(row: dict[str, Any]) -> None:
    """Remove only project-owned segmented derivatives, never the linked source."""
    from .assets import lite_cut_assets_dir

    root = lite_cut_assets_dir().resolve()
    asset_id = max(0, int(row.get("id") or 0))
    for directory in root.glob(f"*/.preview/asset-{asset_id}-*"):
        try:
            directory.resolve().relative_to(root)
        except (OSError, ValueError):
            continue
        files = sorted(
            (candidate for candidate in directory.rglob("*") if candidate.is_file()),
            key=lambda candidate: len(candidate.parts),
            reverse=True,
        )
        for candidate in files:
            candidate.unlink(missing_ok=True)
        directories = sorted(
            (candidate for candidate in directory.rglob("*") if candidate.is_dir()),
            key=lambda candidate: len(candidate.parts),
            reverse=True,
        )
        for candidate in [*directories, directory]:
            try:
                candidate.rmdir()
            except OSError:
                pass


def cleanup_orphan_preview_files(asset_rows: list[dict[str, Any]]) -> dict[str, int]:
    from .assets import lite_cut_assets_dir

    source_requirements = {
        (source.parent, source.stem): _row_requires_or_has_preview_proxy(row)
        for row in asset_rows
        if row.get("file_path")
        for source in [Path(str(row["file_path"])).resolve()]
    }
    removed_bytes = 0
    removed_files = 0
    for candidate in lite_cut_assets_dir().resolve().rglob("*.preview*"):
        if not candidate.is_file():
            continue
        base = candidate.name.split(".preview", 1)[0]
        if source_requirements.get((candidate.parent, base)) is True:
            continue
        try:
            removed_bytes += candidate.stat().st_size
            candidate.unlink()
            removed_files += 1
        except OSError:
            pass
    return {"removed_files": removed_files, "removed_bytes": removed_bytes}


def execute_preview_proxy(job: LiteCutPreviewProxyJob, row: dict[str, Any]) -> tuple[Path | None, bool]:
    # Resolve the executor dependency at call time so fault-injection tests and
    # request-scoped adapters can replace media operations without reloading
    # this module.
    from . import assets as asset_operations

    source = Path(str(row.get("file_path") or ""))
    normal_output, alpha_output = asset_operations.asset_preview_paths(row)
    if job.cancel_event.is_set():
        return None, bool(job.has_alpha)
    cfg = load_config()
    ffmpeg_bin = resolve_ffmpeg_binary(cfg.ffmpeg_path)
    max_edge = max(360, min(2160, int(getattr(cfg, "lite_cut_proxy_resolution", 720) or 720)))
    video_codec = str(job.video_codec or "").strip().lower()
    audio_codec = job.audio_codec
    pixel_format = job.pixel_format
    source_fps = job.source_fps
    if not video_codec or audio_codec is None or pixel_format is None or source_fps is None or (source.suffix.lower() == ".mov" and job.has_alpha is None):
        try:
            info = probe_video_audio_summary(source, resolve_ffprobe_binary(ffmpeg_bin))
            metadata = MediaMetadata.from_probe(info)
            video_codec = metadata.video_codec
            job.video_codec = video_codec or None
            audio_codec = metadata.audio_codec
            job.audio_codec = audio_codec
            pixel_format = metadata.pixel_format
            job.pixel_format = pixel_format
            source_fps = metadata.fps
            job.source_fps = source_fps
            if job.has_alpha is None and metadata.has_alpha is not None:
                job.has_alpha = metadata.has_alpha
        except Exception:
            logger.warning("LiteCut proxy media probe failed for %s", source.name, exc_info=True)
    if source.suffix.lower() == ".mov" and job.has_alpha is not False:
        job.mode = "alpha_transcode"
        alpha_proxy = asset_operations.ensure_alpha_mov_preview_proxy(
            source,
            ffmpeg_bin=ffmpeg_bin,
            output_path=alpha_output,
            duration_sec=row.get("duration_sec"),
            cancel_event=job.cancel_event,
            max_edge=max_edge,
            has_alpha=job.has_alpha,
        )
        if alpha_proxy:
            return alpha_proxy, True
        if job.has_alpha is True or job.cancel_event.is_set():
            return None, bool(job.has_alpha)
    performance_proxy = asset_operations.asset_exceeds_direct_preview_limits(
        source,
        duration_sec=row.get("duration_sec"),
        fps=source_fps,
    )
    proxy = asset_operations.create_browser_preview_proxy(
        source,
        ffmpeg_bin=ffmpeg_bin,
        output_path=normal_output,
        video_encode_quality=lambda: h264_encode_cli_args(resolve_h264_codec_name(ffmpeg_bin, "auto"), "fast"),
        duration_sec=row.get("duration_sec"),
        cancel_event=job.cancel_event,
        max_edge=max_edge,
        copy_video=(not performance_proxy and video_codec == "h264" and pixel_format in {"nv12", "yuv420p", "yuvj420p"}),
        copy_audio=audio_codec in {"", "aac"},
        force=True,
        on_mode_change=lambda mode: setattr(job, "mode", mode),
    )
    return proxy, False
