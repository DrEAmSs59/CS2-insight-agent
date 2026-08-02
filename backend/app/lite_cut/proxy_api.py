"""LiteCut browser-preview proxy jobs and cache management."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..env_utils import load_config, save_config
from .runtime import (
    LiteCutPreviewProxyJob,
    get_lite_cut_db,
    get_preview_proxy_slots,
    preview_proxy_jobs,
)

router = APIRouter(prefix="/api/lite-cut", tags=["lite-cut-proxy"])
logger = logging.getLogger(__name__)


def _preview_proxy_job_snapshot(job: LiteCutPreviewProxyJob) -> dict[str, Any]:
    return {
        "preview_proxy_required": True,
        "preview_proxy_status": job.status,
        "preview_proxy_error": job.error,
        "preview_proxy_version": job.status,
        "preview_proxy_mode": job.mode,
        "has_alpha": bool(job.has_alpha),
    }


def _create_preview_proxy_sync(job: LiteCutPreviewProxyJob, row: dict[str, Any]) -> tuple[Path | None, bool]:
    from ..env_utils import load_config
    from ..montage_encoder import h264_encode_cli_args
    from ..video_composer import (
        probe_video_audio_summary,
        resolve_ffmpeg_binary,
        resolve_ffprobe_binary,
        resolve_h264_codec_name,
    )
    from .assets import create_browser_preview_proxy, ensure_alpha_mov_preview_proxy

    source = Path(str(row.get("file_path") or ""))
    if job.cancel_event.is_set():
        return None, bool(job.has_alpha)
    cfg = load_config()
    ffmpeg_bin = resolve_ffmpeg_binary(cfg.ffmpeg_path)
    max_edge = max(360, min(2160, int(getattr(cfg, "lite_cut_proxy_resolution", 720) or 720)))
    video_codec = str(job.video_codec or "").strip().lower()
    audio_codec = job.audio_codec
    pixel_format = job.pixel_format
    if not video_codec or audio_codec is None or pixel_format is None or (source.suffix.lower() == ".mov" and job.has_alpha is None):
        try:
            info = probe_video_audio_summary(source, resolve_ffprobe_binary(ffmpeg_bin))
            video_codec = str(info.get("codec_name") or "").strip().lower()
            job.video_codec = video_codec or None
            audio_codec = str(info.get("audio_codec_name") or "").strip().lower()
            job.audio_codec = audio_codec
            pixel_format = str(info.get("pixel_format") or "").strip().lower()
            job.pixel_format = pixel_format
            if job.has_alpha is None and "has_alpha" in info:
                job.has_alpha = bool(info.get("has_alpha"))
        except Exception:
            logger.warning("LiteCut proxy media probe failed for %s", source.name, exc_info=True)
    if source.suffix.lower() == ".mov" and job.has_alpha is not False:
        job.mode = "alpha_transcode"
        alpha_proxy = ensure_alpha_mov_preview_proxy(
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
    proxy = create_browser_preview_proxy(
        source,
        ffmpeg_bin=ffmpeg_bin,
        video_encode_quality=lambda: h264_encode_cli_args(
            resolve_h264_codec_name(ffmpeg_bin, "auto"),
            "fast",
        ),
        duration_sec=row.get("duration_sec"),
        cancel_event=job.cancel_event,
        max_edge=max_edge,
        copy_video=video_codec == "h264" and pixel_format in {"nv12", "yuv420p", "yuvj420p"},
        copy_audio=audio_codec in {"", "aac"},
        on_mode_change=lambda mode: setattr(job, "mode", mode),
    )
    return proxy, False


async def _run_preview_proxy_job(job: LiteCutPreviewProxyJob, row: dict[str, Any]) -> None:
    try:
        async with get_preview_proxy_slots():
            if job.cancel_event.is_set():
                job.status = "cancelled"
                return
            job.status = "running"
            proxy, has_alpha = await asyncio.to_thread(_create_preview_proxy_sync, job, row)
        job.has_alpha = has_alpha
        if job.cancel_event.is_set():
            job.status = "cancelled"
            return
        if not proxy or not proxy.is_file():
            job.status = "failed"
            job.error = "代理生成失败，请重试"
            return
        job.status = "ready"
        job.error = ""
        if has_alpha and row.get("kind") != "video":
            await get_lite_cut_db().update_asset_kind(job.asset_id, "video", row.get("mime_type") or "video/quicktime")
    except Exception as exc:
        if job.cancel_event.is_set():
            job.status = "cancelled"
            return
        job.status = "failed"
        job.error = str(exc) or "代理生成失败，请重试"
        logger.warning("LiteCut background preview proxy failed for asset %s", job.asset_id, exc_info=True)


def _start_preview_proxy_job(
    row: dict[str, Any],
    *,
    has_alpha: bool | None = None,
    video_codec: str | None = None,
    audio_codec: str | None = None,
    pixel_format: str | None = None,
    force: bool = False,
) -> LiteCutPreviewProxyJob:
    asset_id = int(row["id"])
    current = preview_proxy_jobs.get(asset_id)
    if current and not force:
        return current
    if current and current.task and not current.task.done():
        return current
    job = LiteCutPreviewProxyJob(
        asset_id=asset_id,
        has_alpha=has_alpha,
        video_codec=(str(video_codec).strip().lower() or None) if video_codec is not None else None,
        audio_codec=str(audio_codec).strip().lower() if audio_codec is not None else None,
        pixel_format=str(pixel_format).strip().lower() if pixel_format is not None else None,
    )
    preview_proxy_jobs[asset_id] = job
    job.task = asyncio.create_task(_run_preview_proxy_job(job, dict(row)))
    return job


def _decorate_asset_preview_state(
    row: dict[str, Any],
    *,
    schedule: bool = True,
    has_alpha: bool | None = None,
    video_codec: str | None = None,
    audio_codec: str | None = None,
    pixel_format: str | None = None,
) -> dict[str, Any]:
    from .assets import alpha_preview_proxy_path_for_asset, asset_needs_browser_proxy, preview_proxy_path_for_asset

    source = Path(str(row.get("file_path") or ""))
    if not asset_needs_browser_proxy(source, video_codec=video_codec):
        row.update({
            "preview_proxy_required": False,
            "preview_proxy_status": "not_needed",
            "preview_proxy_error": "",
            "preview_proxy_version": "source",
            "preview_proxy_mode": "direct",
            "has_alpha": bool(has_alpha),
        })
        return row
    alpha_proxy = alpha_preview_proxy_path_for_asset(source)
    normal_proxy = preview_proxy_path_for_asset(source)
    ready_proxy = alpha_proxy if alpha_proxy.is_file() else normal_proxy if normal_proxy.is_file() else None
    if ready_proxy:
        row.update({
            "preview_proxy_required": True,
            "preview_proxy_status": "ready",
            "preview_proxy_error": "",
            "preview_proxy_version": str(ready_proxy.stat().st_mtime_ns),
            "preview_proxy_mode": "ready",
            "has_alpha": alpha_proxy.is_file(),
        })
        return row
    job = preview_proxy_jobs.get(int(row["id"]))
    if job is None and schedule and source.is_file():
        job = _start_preview_proxy_job(
            row,
            has_alpha=has_alpha,
            video_codec=video_codec,
            audio_codec=audio_codec,
            pixel_format=pixel_format,
        )
    if job is not None:
        row.update(_preview_proxy_job_snapshot(job))
    else:
        row.update({
            "preview_proxy_required": True,
            "preview_proxy_status": "failed" if source.is_file() else "missing",
            "preview_proxy_error": "代理生成失败，请重试" if source.is_file() else "素材文件不存在",
            "preview_proxy_version": "unavailable",
            "preview_proxy_mode": "failed",
            "has_alpha": bool(has_alpha),
        })
    return row


async def _stop_preview_proxy_job(asset_id: int) -> None:
    job = preview_proxy_jobs.get(int(asset_id))
    if not job:
        return
    if job.task and not job.task.done():
        job.cancel_event.set()
        if job.status == "queued":
            job.task.cancel()
            try:
                await job.task
            except asyncio.CancelledError:
                pass
            preview_proxy_jobs.pop(int(asset_id), None)
            return
        try:
            await asyncio.wait_for(asyncio.shield(job.task), timeout=10)
        except asyncio.TimeoutError as exc:
            raise HTTPException(409, "素材代理仍在停止中，请稍后重试") from exc
    preview_proxy_jobs.pop(int(asset_id), None)

class LiteCutProxySettingsBody(BaseModel):
    resolution: int = Field(ge=360, le=2160)


class LiteCutProxyRegenerateBody(BaseModel):
    asset_ids: list[int] = Field(default_factory=list, max_length=1000)


def _proxy_cache_snapshot(asset_rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Return cache accounting without treating originals as disposable cache."""
    from .assets import alpha_preview_proxy_path_for_asset, preview_proxy_path_for_asset

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
    return {"proxy_bytes": used, "proxy_files": files, "ready_assets": ready}


@router.get("/proxy-cache")
async def get_lite_cut_proxy_cache():
    from .assets import asset_needs_browser_proxy, lite_cut_assets_dir

    assets = await get_lite_cut_db().list_assets(limit=1000)
    snapshot = await asyncio.to_thread(_proxy_cache_snapshot, assets)
    root = lite_cut_assets_dir().resolve()
    orphan_bytes = 0
    orphan_files = 0
    source_requirements = {
        (source.parent, source.stem): asset_needs_browser_proxy(source)
        for row in assets
        if row.get("file_path")
        for source in [Path(str(row["file_path"])).resolve()]
    }
    for candidate in root.rglob("*.preview*"):
        if not candidate.is_file():
            continue
        stem = candidate.name.split(".preview", 1)[0]
        if source_requirements.get((candidate.parent, stem)) is not True:
            try:
                orphan_bytes += candidate.stat().st_size
                orphan_files += 1
            except OSError:
                pass
    cfg = load_config()
    return {
        **snapshot,
        "asset_count": len(assets),
        "proxy_required_assets": sum(1 for row in assets if asset_needs_browser_proxy(Path(str(row.get("file_path") or "")))),
        "orphan_bytes": orphan_bytes,
        "orphan_files": orphan_files,
        "resolution": max(360, min(2160, int(getattr(cfg, "lite_cut_proxy_resolution", 720) or 720))),
    }


@router.patch("/proxy-cache/settings")
async def patch_lite_cut_proxy_settings(body: LiteCutProxySettingsBody):
    # Keep values codec-friendly: FFmpeg will make the computed other edge even.
    resolution = int(round(body.resolution / 2) * 2)
    cfg = load_config()
    cfg.lite_cut_proxy_resolution = resolution
    save_config(cfg)
    return {"resolution": resolution}


@router.post("/proxy-cache/regenerate")
async def regenerate_lite_cut_proxies(body: LiteCutProxyRegenerateBody):
    from .assets import asset_companion_paths, asset_needs_browser_proxy

    all_assets = await get_lite_cut_db().list_assets(limit=1000)
    wanted = {int(asset_id) for asset_id in body.asset_ids if int(asset_id) > 0}
    targets = [row for row in all_assets if (not wanted or int(row["id"]) in wanted) and asset_needs_browser_proxy(Path(str(row.get("file_path") or "")))]
    for row in targets:
        await _stop_preview_proxy_job(int(row["id"]))
        source = Path(str(row.get("file_path") or ""))
        for candidate in asset_companion_paths(source)[:5]:
            if ".preview" in candidate.name:
                await asyncio.to_thread(candidate.unlink, missing_ok=True)
        _start_preview_proxy_job(row, force=True)
    return {"queued": len(targets), "asset_ids": [int(row["id"]) for row in targets]}


@router.post("/proxy-cache/cleanup")
async def cleanup_lite_cut_proxy_cache():
    from .assets import asset_needs_browser_proxy, lite_cut_assets_dir

    assets = await get_lite_cut_db().list_assets(limit=1000)
    source_requirements = {
        (source.parent, source.stem): asset_needs_browser_proxy(source)
        for row in assets
        if row.get("file_path")
        for source in [Path(str(row["file_path"])).resolve()]
    }
    root = lite_cut_assets_dir().resolve()
    removed_bytes = 0
    removed_files = 0
    for candidate in root.rglob("*.preview*"):
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
