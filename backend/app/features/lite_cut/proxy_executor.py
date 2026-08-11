"""Side-effect executor for one LiteCut browser-preview proxy attempt."""

from __future__ import annotations

import logging
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

logger = logging.getLogger(__name__)


def _row_requires_or_has_preview_proxy(row: dict[str, Any]) -> bool:
    from .assets import (
        alpha_preview_proxy_path_for_asset,
        asset_needs_browser_proxy,
        preview_proxy_path_for_asset,
    )

    source = Path(str(row.get("file_path") or ""))
    if not source.is_file():
        return False
    if preview_proxy_path_for_asset(source).is_file() or alpha_preview_proxy_path_for_asset(source).is_file():
        return True
    return asset_needs_browser_proxy(source, duration_sec=row.get("duration_sec"))


def proxy_cache_inventory(asset_rows: list[dict[str, Any]]) -> dict[str, Any]:
    from .assets import (
        alpha_preview_proxy_path_for_asset,
        lite_cut_assets_dir,
        preview_proxy_path_for_asset,
    )

    used = 0
    files = 0
    ready = 0
    for row in asset_rows:
        source = Path(str(row.get("file_path") or ""))
        for candidate in (preview_proxy_path_for_asset(source), alpha_preview_proxy_path_for_asset(source)):
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
    from .assets import asset_companion_paths

    source = Path(str(row.get("file_path") or ""))
    for candidate in asset_companion_paths(source):
        if ".preview" in candidate.name:
            candidate.unlink(missing_ok=True)


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
