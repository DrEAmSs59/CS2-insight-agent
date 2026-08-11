"""LiteCut browser-preview proxy jobs and cache management."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ...env_utils import load_config, save_config
from .dependencies import build_lite_cut_services
from .proxy_executor import (
    _row_requires_or_has_preview_proxy,
    cleanup_orphan_preview_files,
    proxy_cache_inventory,
    remove_asset_preview_files,
)
from .runtime import (
    LiteCutPreviewProxyJob,
    get_lite_cut_db,
    get_preview_proxy_slots,
    preview_proxy_jobs,
)

router = APIRouter(prefix="/api/lite-cut", tags=["lite-cut-proxy"])
logger = logging.getLogger(__name__)


def _services():
    return build_lite_cut_services(get_lite_cut_db())


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
    from .assets import alpha_preview_proxy_path_for_asset, asset_needs_browser_proxy, preview_proxy_path_for_asset

    source = Path(str(row.get("file_path") or ""))
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
    if not asset_needs_browser_proxy(
        source,
        video_codec=video_codec,
        duration_sec=row.get("duration_sec"),
        fps=source_fps,
    ):
        row.update({
            "preview_proxy_required": False,
            "preview_proxy_status": "not_needed",
            "preview_proxy_error": "",
            "preview_proxy_version": "source",
            "preview_proxy_mode": "direct",
            "has_alpha": bool(has_alpha),
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
            source_fps=source_fps,
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
