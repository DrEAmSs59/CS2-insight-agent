"""LiteCut browser-preview proxy jobs and cache management."""

from __future__ import annotations

import asyncio
import logging
import math
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ...env_utils import load_config, save_config
from .dependencies import build_lite_cut_services
from .proxy_executor import (
    _row_requires_or_has_preview_proxy,
    cleanup_orphan_preview_files,
    execute_preview_segment,
    preview_segment_index,
    preview_segment_path,
    proxy_cache_inventory,
    remove_asset_preview_files,
)
from .media_policy import SEGMENT_PREVIEW_STEP_SEC
from .runtime import (
    LiteCutPreviewProxyJob,
    LiteCutSegmentPreviewJob,
    get_lite_cut_db,
    get_preview_proxy_slots,
    get_segment_preview_slots,
    preview_proxy_jobs,
    segment_preview_jobs,
)

router = APIRouter(prefix="/api/lite-cut", tags=["lite-cut-proxy"])
logger = logging.getLogger(__name__)


def _services():
    return build_lite_cut_services(get_lite_cut_db())


def _segment_preview_snapshot(
    job: LiteCutSegmentPreviewJob | None,
    *,
    requested_index: int,
    cache_directory: Path,
) -> dict[str, Any]:
    requested_path = preview_segment_path(cache_directory, requested_index)
    requested_ready = requested_path.is_file() and requested_path.stat().st_size > 0
    job_tracks_requested = bool(job is not None and requested_index in job.segment_indexes)
    status = "ready" if requested_ready else str(job.status if job_tracks_requested else "idle")
    return {
        "status": status,
        "request_id": job.request_id if job is not None else None,
        "requested_segment": requested_index,
        "segment_start_sec": requested_index * SEGMENT_PREVIEW_STEP_SEC,
        "segment_step_sec": SEGMENT_PREVIEW_STEP_SEC,
        "ready_segments": sorted(set(job.ready_segments if job is not None else []) | ({requested_index} if requested_ready else set())),
        "active_segment": job.active_segment if job is not None else None,
        "encoder": job.encoder if job is not None else "",
        "error": job.error if job is not None else "",
    }


async def _run_segment_preview_job(
    job: LiteCutSegmentPreviewJob,
    row: dict[str, Any],
    *,
    max_edge: int,
) -> None:
    try:
        async with get_segment_preview_slots():
            job.status = "running"
            for segment_index in job.segment_indexes:
                if job.cancel_event.is_set():
                    job.status = "cancelled"
                    return
                path = preview_segment_path(job.cache_directory, segment_index)
                if path.is_file() and path.stat().st_size > 0:
                    if segment_index not in job.ready_segments:
                        job.ready_segments.append(segment_index)
                    job.status = "partial"
                    continue
                job.active_segment = segment_index
                _path, _duration, encoder = await asyncio.to_thread(
                    execute_preview_segment,
                    job,
                    row,
                    segment_index=segment_index,
                    cache_directory=job.cache_directory,
                    max_edge=max_edge,
                )
                job.encoder = encoder
                if segment_index not in job.ready_segments:
                    job.ready_segments.append(segment_index)
                job.status = "partial"
            job.active_segment = None
            job.status = "ready"
    except Exception as exc:
        if job.cancel_event.is_set() or str(exc) == "cancelled":
            job.status = "cancelled"
            return
        job.status = "failed"
        job.error = str(exc) or "分段预览生成失败"
        logger.warning("LiteCut segmented preview failed for asset %s", job.asset_id, exc_info=True)


def _start_segment_preview_job(
    row: dict[str, Any],
    *,
    requested_time_sec: float,
    look_ahead_sec: float,
    cache_directory: Path,
    max_edge: int,
    priority: str = "interactive",
    force: bool = False,
) -> LiteCutSegmentPreviewJob:
    asset_id = int(row["id"])
    requested_priority = "prefetch" if str(priority).lower() == "prefetch" else "interactive"
    requested_index = preview_segment_index(requested_time_sec)
    source_duration = max(0.0, float(row.get("duration_sec") or 0.0))
    if source_duration > 0:
        requested_index = min(
            requested_index,
            max(0, int(math.ceil(source_duration / SEGMENT_PREVIEW_STEP_SEC)) - 1),
        )
    segment_count = max(1, min(8, int(math.ceil(max(0.0, look_ahead_sec) / SEGMENT_PREVIEW_STEP_SEC)) + 1))
    last_index = requested_index + segment_count - 1
    if source_duration > 0:
        last_index = min(
            last_index,
            max(0, int(math.ceil(source_duration / SEGMENT_PREVIEW_STEP_SEC)) - 1),
        )
    segment_indexes = tuple(range(requested_index, last_index + 1))
    current = segment_preview_jobs.get(asset_id)
    requested_path = preview_segment_path(cache_directory, requested_index)
    requested_ready = requested_path.is_file() and requested_path.stat().st_size > 0
    current_running = bool(current is not None and current.task is not None and not current.task.done())
    same_cache = bool(current is not None and current.cache_directory == cache_directory)
    # Idle full-source completion may inspect the next missing segment while
    # the foreground window is still encoding. It must wait rather than cancel
    # the playhead-driven job.
    if (
        current_running
        and same_cache
        and requested_priority == "prefetch"
        and current.priority == "interactive"
    ):
        return current
    promote_prefetch = bool(
        current_running
        and same_cache
        and requested_priority == "interactive"
        and current.priority == "prefetch"
        and not requested_ready
    )
    if (
        current is not None
        and current.task is not None
        and current.task.done()
        and current.status == "failed"
        and not force
        and current.cache_directory == cache_directory
        and current.segment_indexes[0] == requested_index
    ):
        # Let the polling client observe a terminal failure instead of
        # spawning the same doomed FFmpeg command every 250 ms. A seek to a
        # different segment replaces this job and permits a later retry.
        return current
    if (
        current is not None
        and current.task is not None
        and not current.task.done()
        and not promote_prefetch
        and requested_index in current.segment_indexes
        and current.cache_directory == cache_directory
        and (
            requested_ready
            or current.active_segment == requested_index
            or current.segment_indexes[0] == requested_index
        )
    ):
        return current
    if current is not None and current.task is not None and not current.task.done():
        current.cancel_event.set()
    job = LiteCutSegmentPreviewJob(
        asset_id=asset_id,
        request_id=uuid.uuid4().hex,
        segment_indexes=segment_indexes,
        cache_directory=cache_directory,
        priority=requested_priority,
    )
    segment_preview_jobs[asset_id] = job
    job.task = asyncio.create_task(_run_segment_preview_job(job, dict(row), max_edge=max_edge))
    return job


async def _stop_segment_preview_job(asset_id: int) -> None:
    job = segment_preview_jobs.get(int(asset_id))
    if job is None:
        return
    job.cancel_event.set()
    if job.task is not None and not job.task.done():
        try:
            await asyncio.wait_for(asyncio.shield(job.task), timeout=5)
        except asyncio.TimeoutError:
            pass
    segment_preview_jobs.pop(int(asset_id), None)


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
    from .proxy_executor import execute_preview_proxy

    return execute_preview_proxy(job, row)


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
            await _services().assets.update_kind(job.asset_id, "video", row.get("mime_type") or "video/quicktime")
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
    source_fps: float | None = None,
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
        source_fps=float(source_fps) if source_fps is not None else None,
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
    source_fps: float | None = None,
) -> dict[str, Any]:
    """Expose direct vs playhead-driven proxy policy without scheduling work."""
    from .media_policy import asset_needs_segmented_preview, is_looping_animation_path

    _ = (schedule, audio_codec, pixel_format)
    source = Path(str(row.get("original_path") or row.get("file_path") or ""))
    segmented = asset_needs_segmented_preview(
        source,
        kind=str(row.get("kind") or ""),
        storage_mode=str(row.get("storage_mode") or ""),
        size_bytes=row.get("size_bytes"),
        video_codec=video_codec,
        duration_sec=row.get("duration_sec"),
        fps=source_fps,
    )
    source_version = row.get("mtime_ns") or row.get("fingerprint") or "source"
    row.update({
        "preview_proxy_required": segmented,
        "preview_proxy_status": "idle" if segmented else "not_needed",
        "preview_proxy_error": "",
        "preview_proxy_version": f"source-{source_version}",
        "preview_proxy_mode": "segmented" if segmented else "direct",
        "preview_segment_step_sec": SEGMENT_PREVIEW_STEP_SEC if segmented else None,
        "has_alpha": bool(has_alpha) if has_alpha is not None else bool(row.get("has_alpha")),
        "is_looping_animation": bool(row.get("is_looping_animation")) or is_looping_animation_path(source),
    })
    return row


async def _stop_preview_proxy_job(asset_id: int) -> None:
    await _stop_segment_preview_job(asset_id)
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


@router.get("/proxy-cache")
async def get_lite_cut_proxy_cache():
    assets = (await _services().assets.list(project_id=None, limit=1000, offset=0))["items"]
    snapshot = await asyncio.to_thread(proxy_cache_inventory, assets)
    cfg = load_config()
    return {
        **snapshot,
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
    all_assets = (await _services().assets.list(project_id=None, limit=1000, offset=0))["items"]
    wanted = {int(asset_id) for asset_id in body.asset_ids if int(asset_id) > 0}
    targets = [
        row
        for row in all_assets
        if (not wanted or int(row["id"]) in wanted)
        and _row_requires_or_has_preview_proxy(row)
    ]
    for row in targets:
        await _stop_preview_proxy_job(int(row["id"]))
        await asyncio.to_thread(remove_asset_preview_files, row)
        _start_preview_proxy_job(row, force=True)
    return {"queued": len(targets), "asset_ids": [int(row["id"]) for row in targets]}


@router.post("/proxy-cache/cleanup")
async def cleanup_lite_cut_proxy_cache():
    assets = (await _services().assets.list(project_id=None, limit=1000, offset=0))["items"]
    return await asyncio.to_thread(cleanup_orphan_preview_files, assets)
