"""LiteCut FastAPI router — /api/lite-cut/*"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import json
import logging
import mimetypes
import shutil
import tempfile
import threading
import uuid
import zipfile
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..api_errors import error_detail
from ..env_utils import get_data_dir, load_config, resolve_config_path, save_config
from ..montage_db import MontageDB
from .db import LiteCutDB
from .models import (
    LiteCutPresetCreate,
    LiteCutPresetPatch,
    LiteCutProjectCreate,
    LiteCutProjectPatch,
    PresetApplyRequest,
    empty_project,
)
from .preset_apply import apply_preset_to_project, parse_project_body

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/lite-cut", tags=["lite-cut"])

_lite_cut_db: Optional[LiteCutDB] = None
_montage_db: Optional[MontageDB] = None
_export_jobs: dict[int, "LiteCutExportJob"] = {}
_preview_proxy_jobs: dict[int, "LiteCutPreviewProxyJob"] = {}
_storage_migration_jobs: dict[str, "LiteCutStorageMigrationJob"] = {}
_portable_package_jobs: dict[str, "LiteCutPortablePackageJob"] = {}
_preview_proxy_slots: asyncio.Semaphore | None = None
_preview_proxy_slots_loop: asyncio.AbstractEventLoop | None = None
_LITE_CUT_ENCODERS = {"auto", "h264_nvenc", "h264_qsv", "h264_amf", "libx264"}


def _resolve_lite_cut_encoder(project_body: dict[str, Any], configured_encoder: str | None) -> str:
    requested = str((project_body.get("output") or {}).get("encoder") or "").strip().lower()
    if requested in _LITE_CUT_ENCODERS:
        return requested
    configured = str(configured_encoder or "auto").strip().lower()
    return configured if configured in _LITE_CUT_ENCODERS else "auto"


@dataclass
class LiteCutExportJob:
    export_id: int
    project_id: int | None
    status: str = "queued"
    progress: float = 0.0
    stage: str = "queued"
    output_path: str = ""
    error: str = ""
    cancel_event: threading.Event = field(default_factory=threading.Event)
    task: asyncio.Task | None = None


@dataclass
class LiteCutPreviewProxyJob:
    asset_id: int
    status: str = "queued"
    has_alpha: bool | None = None
    error: str = ""
    cancel_event: threading.Event = field(default_factory=threading.Event)
    task: asyncio.Task | None = None


@dataclass
class LiteCutStorageMigrationJob:
    job_id: str
    source: Path
    target: Path
    target_existed: bool
    status: str = "queued"
    stage: str = "queued"
    progress: float = 0.0
    total_bytes: int = 0
    copied_bytes: int = 0
    total_files: int = 0
    copied_files: int = 0
    error: str = ""
    warning: str = ""
    failed_files: list[str] = field(default_factory=list)
    updated: dict[str, int] = field(default_factory=dict)
    cancel_event: threading.Event = field(default_factory=threading.Event)
    task: asyncio.Task | None = None


@dataclass
class LiteCutPortablePackageJob:
    job_id: str
    project_id: int
    filename: str
    destination: Path | None = None
    status: str = "queued"
    stage: str = "queued"
    progress: float = 0.0
    total_bytes: int = 0
    completed_bytes: int = 0
    total_files: int = 0
    completed_files: int = 0
    package_path: str = ""
    saved_path: str = ""
    error: str = ""
    cancel_event: threading.Event = field(default_factory=threading.Event)
    task: asyncio.Task | None = None


def _preview_proxy_job_snapshot(job: LiteCutPreviewProxyJob) -> dict[str, Any]:
    return {
        "preview_proxy_required": True,
        "preview_proxy_status": job.status,
        "preview_proxy_error": job.error,
        "preview_proxy_version": job.status,
        "has_alpha": bool(job.has_alpha),
    }


def _get_preview_proxy_slots() -> asyncio.Semaphore:
    global _preview_proxy_slots, _preview_proxy_slots_loop
    loop = asyncio.get_running_loop()
    if _preview_proxy_slots is None or _preview_proxy_slots_loop is not loop:
        _preview_proxy_slots = asyncio.Semaphore(2)
        _preview_proxy_slots_loop = loop
    return _preview_proxy_slots


def _create_preview_proxy_sync(job: LiteCutPreviewProxyJob, row: dict[str, Any]) -> tuple[Path | None, bool]:
    from ..env_utils import load_config
    from ..montage_encoder import h264_encode_cli_args
    from ..video_composer import resolve_ffmpeg_binary, resolve_h264_codec_name
    from .assets import create_browser_preview_proxy, ensure_alpha_mov_preview_proxy

    source = Path(str(row.get("file_path") or ""))
    if job.cancel_event.is_set():
        return None, bool(job.has_alpha)
    ffmpeg_bin = resolve_ffmpeg_binary(load_config().ffmpeg_path)
    if source.suffix.lower() == ".mov" and job.has_alpha is not False:
        alpha_proxy = ensure_alpha_mov_preview_proxy(
            source,
            ffmpeg_bin=ffmpeg_bin,
            duration_sec=row.get("duration_sec"),
            cancel_event=job.cancel_event,
            max_edge=max(360, min(2160, int(getattr(load_config(), "lite_cut_proxy_resolution", 720) or 720))),
        )
        if alpha_proxy:
            return alpha_proxy, True
        if job.has_alpha is True or job.cancel_event.is_set():
            return None, bool(job.has_alpha)
    video_encode_quality = h264_encode_cli_args(resolve_h264_codec_name(ffmpeg_bin, "auto"), "fast")
    proxy = create_browser_preview_proxy(
        source,
        ffmpeg_bin=ffmpeg_bin,
        video_encode_quality=video_encode_quality,
        duration_sec=row.get("duration_sec"),
        cancel_event=job.cancel_event,
        max_edge=max(360, min(2160, int(getattr(load_config(), "lite_cut_proxy_resolution", 720) or 720))),
    )
    return proxy, False


async def _run_preview_proxy_job(job: LiteCutPreviewProxyJob, row: dict[str, Any]) -> None:
    try:
        async with _get_preview_proxy_slots():
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
            await _get_lite_cut_db().update_asset_kind(job.asset_id, "video", row.get("mime_type") or "video/quicktime")
    except Exception as exc:
        if job.cancel_event.is_set():
            job.status = "cancelled"
            return
        job.status = "failed"
        job.error = str(exc) or "代理生成失败，请重试"
        logger.warning("LiteCut background preview proxy failed for asset %s", job.asset_id, exc_info=True)


def _start_preview_proxy_job(row: dict[str, Any], *, has_alpha: bool | None = None, force: bool = False) -> LiteCutPreviewProxyJob:
    asset_id = int(row["id"])
    current = _preview_proxy_jobs.get(asset_id)
    if current and not force:
        return current
    if current and current.task and not current.task.done():
        return current
    job = LiteCutPreviewProxyJob(asset_id=asset_id, has_alpha=has_alpha)
    _preview_proxy_jobs[asset_id] = job
    job.task = asyncio.create_task(_run_preview_proxy_job(job, dict(row)))
    return job


def _decorate_asset_preview_state(
    row: dict[str, Any],
    *,
    schedule: bool = True,
    has_alpha: bool | None = None,
) -> dict[str, Any]:
    from .assets import alpha_preview_proxy_path_for_asset, asset_needs_browser_proxy, preview_proxy_path_for_asset

    source = Path(str(row.get("file_path") or ""))
    if not asset_needs_browser_proxy(source):
        row.update({
            "preview_proxy_required": False,
            "preview_proxy_status": "not_needed",
            "preview_proxy_error": "",
            "preview_proxy_version": "source",
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
            "has_alpha": alpha_proxy.is_file(),
        })
        return row
    job = _preview_proxy_jobs.get(int(row["id"]))
    if job is None and schedule and source.is_file():
        job = _start_preview_proxy_job(row, has_alpha=has_alpha)
    if job is not None:
        row.update(_preview_proxy_job_snapshot(job))
    else:
        row.update({
            "preview_proxy_required": True,
            "preview_proxy_status": "failed" if source.is_file() else "missing",
            "preview_proxy_error": "代理生成失败，请重试" if source.is_file() else "素材文件不存在",
            "preview_proxy_version": "unavailable",
            "has_alpha": bool(has_alpha),
        })
    return row


async def _stop_preview_proxy_job(asset_id: int) -> None:
    job = _preview_proxy_jobs.get(int(asset_id))
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
            _preview_proxy_jobs.pop(int(asset_id), None)
            return
        try:
            await asyncio.wait_for(asyncio.shield(job.task), timeout=10)
        except asyncio.TimeoutError as exc:
            raise HTTPException(409, "素材代理仍在停止中，请稍后重试") from exc
    _preview_proxy_jobs.pop(int(asset_id), None)


def _export_job_snapshot(job: LiteCutExportJob) -> dict[str, Any]:
    return {
        "export_id": job.export_id,
        "project_id": job.project_id,
        "status": job.status,
        "progress": max(0.0, min(1.0, float(job.progress or 0.0))),
        "stage": job.stage,
        "output_path": job.output_path,
        "error": job.error,
    }


def _export_row_snapshot(row: dict[str, Any]) -> dict[str, Any]:
    status = str(row.get("status") or "unknown")
    return {
        "export_id": int(row["id"]),
        "project_id": row.get("project_id"),
        "status": status,
        "progress": 1.0 if status == "done" else 0.0,
        "stage": status,
        "output_path": row.get("output_path") or "",
        "error": row.get("error_msg") or "",
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def _get_lite_cut_db() -> LiteCutDB:
    global _lite_cut_db
    if _lite_cut_db is None:
        db_path = resolve_config_path().parent / "cs2-insight.db"
        _lite_cut_db = LiteCutDB(db_path)
    return _lite_cut_db


def _get_montage_db() -> MontageDB:
    global _montage_db
    if _montage_db is None:
        db_path = resolve_config_path().parent / "cs2-insight.db"
        _montage_db = MontageDB(db_path)
    return _montage_db


def _normalize_project_body(raw: dict[str, Any] | None) -> dict[str, Any]:
    return parse_project_body(raw).model_dump(mode="json")


def _directory_size(path: Path) -> int:
    total = 0
    if not path.is_dir():
        return total
    for item in path.rglob("*"):
        if item.is_file():
            try:
                total += item.stat().st_size
            except OSError:
                pass
    return total


def _storage_migration_snapshot(job: LiteCutStorageMigrationJob) -> dict[str, Any]:
    return {
        "job_id": job.job_id,
        "status": job.status,
        "stage": job.stage,
        "progress": max(0.0, min(1.0, float(job.progress))),
        "path": str(job.target if job.status == "done" else job.source),
        "source_path": str(job.source),
        "target_path": str(job.target),
        "size_bytes": job.total_bytes,
        "total_bytes": job.total_bytes,
        "copied_bytes": job.copied_bytes,
        "total_files": job.total_files,
        "copied_files": job.copied_files,
        "failed_files": list(job.failed_files[-50:]),
        "error": job.error,
        "warning": job.warning,
        "updated": dict(job.updated),
        "migrated": job.status == "done",
    }


def _copy_storage_tree_with_progress(job: LiteCutStorageMigrationJob) -> list[tuple[Path, Path, int]]:
    source = job.source
    target = job.target
    target.mkdir(parents=True, exist_ok=True)
    probe = target / ".litecut-write-test"
    probe.write_bytes(b"ok")
    probe.unlink()
    files: list[tuple[Path, Path, int]] = []
    if source.is_dir():
        for item in source.rglob("*"):
            if item.is_file():
                size = int(item.stat().st_size)
                files.append((item, target / item.relative_to(source), size))
    job.total_files = len(files)
    job.total_bytes = sum(size for _, _, size in files)
    free = shutil.disk_usage(target).free
    if job.total_bytes > 0 and free < job.total_bytes:
        raise OSError(f"目标磁盘空间不足：需要至少 {job.total_bytes} 字节，当前可用 {free} 字节")
    job.status = "running"
    job.stage = "copying"
    chunk_size = 8 * 1024 * 1024
    for source_file, target_file, _size in files:
        if job.cancel_event.is_set():
            raise InterruptedError("迁移已取消")
        try:
            target_file.parent.mkdir(parents=True, exist_ok=True)
            with source_file.open("rb") as reader, target_file.open("wb") as writer:
                while chunk := reader.read(chunk_size):
                    if job.cancel_event.is_set():
                        raise InterruptedError("迁移已取消")
                    writer.write(chunk)
                    job.copied_bytes += len(chunk)
                    job.progress = 0.85 * job.copied_bytes / max(1, job.total_bytes)
            shutil.copystat(source_file, target_file)
            job.copied_files += 1
        except InterruptedError:
            raise
        except OSError:
            job.failed_files.append(str(source_file))
            raise
    return files


def _verify_storage_copy(job: LiteCutStorageMigrationJob, files: list[tuple[Path, Path, int]]) -> None:
    job.stage = "verifying"
    for index, (source_file, target_file, expected_size) in enumerate(files):
        if job.cancel_event.is_set():
            raise InterruptedError("迁移已取消")
        try:
            if not target_file.is_file() or target_file.stat().st_size != expected_size:
                raise OSError("目标文件大小不一致")
            with target_file.open("rb") as stream:
                stream.read(1)
        except OSError:
            job.failed_files.append(str(source_file))
            raise
        job.progress = 0.85 + 0.1 * (index + 1) / max(1, len(files))


def _cleanup_migration_target(job: LiteCutStorageMigrationJob) -> None:
    shutil.rmtree(job.target, ignore_errors=True)
    if job.target_existed:
        job.target.mkdir(parents=True, exist_ok=True)


async def _run_storage_migration(job: LiteCutStorageMigrationJob) -> None:
    paths_switched = False
    try:
        files = await asyncio.to_thread(_copy_storage_tree_with_progress, job)
        await asyncio.to_thread(_verify_storage_copy, job, files)
        if job.cancel_event.is_set():
            raise InterruptedError("迁移已取消")
        job.stage = "updating"
        job.progress = 0.96
        job.updated = await _get_lite_cut_db().migrate_asset_storage_paths(job.source, job.target)
        paths_switched = True
        cfg = load_config()
        cfg.lite_cut_assets_dir = str(job.target)
        save_config(cfg)
        job.stage = "cleaning"
        job.progress = 0.98
        try:
            if job.source.is_dir():
                await asyncio.to_thread(shutil.rmtree, job.source)
        except OSError as exc:
            job.warning = f"新目录已启用，但旧目录暂时无法删除：{exc}"
            logger.warning("Could not remove old LiteCut storage %s: %s", job.source, exc)
        job.status = "done"
        job.stage = "done"
        job.progress = 1.0
    except InterruptedError:
        job.status = "cancelled"
        job.stage = "cancelled"
        job.error = "迁移已取消，仍在使用原目录"
        await asyncio.to_thread(_cleanup_migration_target, job)
    except Exception as exc:
        if paths_switched:
            try:
                await _get_lite_cut_db().migrate_asset_storage_paths(job.target, job.source)
                cfg = load_config()
                cfg.lite_cut_assets_dir = str(job.source)
                save_config(cfg)
            except Exception:
                logger.exception("LiteCut storage migration rollback failed")
        await asyncio.to_thread(_cleanup_migration_target, job)
        job.status = "failed"
        job.stage = "failed"
        job.error = str(exc) or "迁移失败"
        logger.warning("LiteCut storage migration failed", exc_info=True)


class LiteCutStorageMoveBody(BaseModel):
    destination: str = Field(min_length=1, max_length=2048)


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

    assets = await _get_lite_cut_db().list_assets(limit=1000)
    snapshot = await asyncio.to_thread(_proxy_cache_snapshot, assets)
    root = lite_cut_assets_dir().resolve()
    orphan_bytes = 0
    orphan_files = 0
    known_sources = {str(Path(str(row.get("file_path") or "")).resolve()) for row in assets if row.get("file_path")}
    for candidate in root.rglob("*.preview*"):
        if not candidate.is_file():
            continue
        stem = candidate.name.split(".preview", 1)[0]
        source_exists = any(Path(source).stem == stem and Path(source).parent == candidate.parent for source in known_sources)
        if not source_exists:
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

    all_assets = await _get_lite_cut_db().list_assets(limit=1000)
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
    from .assets import lite_cut_assets_dir

    assets = await _get_lite_cut_db().list_assets(limit=1000)
    roots = {Path(str(row.get("file_path") or "")).resolve() for row in assets if row.get("file_path")}
    root = lite_cut_assets_dir().resolve()
    removed_bytes = 0
    removed_files = 0
    for candidate in root.rglob("*.preview*"):
        if not candidate.is_file():
            continue
        base = candidate.name.split(".preview", 1)[0]
        keep = any(source.parent == candidate.parent and source.stem == base for source in roots)
        if keep:
            continue
        try:
            removed_bytes += candidate.stat().st_size
            candidate.unlink()
            removed_files += 1
        except OSError:
            pass
    return {"removed_files": removed_files, "removed_bytes": removed_bytes}


@router.get("/storage")
async def get_lite_cut_storage():
    from .assets import lite_cut_assets_dir

    current = lite_cut_assets_dir().resolve()
    default = (get_data_dir() / "lite_cut_assets").resolve()
    size = await asyncio.to_thread(_directory_size, current)
    return {
        "path": str(current),
        "default_path": str(default),
        "custom": current != default,
        "size_bytes": size,
    }


@router.post("/storage/migrate")
async def migrate_lite_cut_storage(body: LiteCutStorageMoveBody):
    from .assets import lite_cut_assets_dir

    if any(job.status in {"queued", "running"} for job in _preview_proxy_jobs.values()):
        raise HTTPException(409, "LiteCut 正在生成预览代理，请完成后再迁移素材目录")
    if any(job.status in {"queued", "running", "cancelling"} for job in _export_jobs.values()):
        raise HTTPException(409, "LiteCut 正在导出，请等待导出结束后再迁移素材目录。")
    if any(job.status in {"queued", "running", "cancelling"} for job in _storage_migration_jobs.values()):
        raise HTTPException(409, "LiteCut 素材目录正在迁移，请等待当前任务结束")

    source = lite_cut_assets_dir().resolve()
    try:
        target = Path(body.destination.strip().strip('"')).expanduser().resolve(strict=False)
    except OSError as exc:
        raise HTTPException(400, f"目标目录无效：{exc}") from exc
    if target == source:
        size = await asyncio.to_thread(_directory_size, source)
        return {
            "job_id": "",
            "status": "done",
            "stage": "done",
            "progress": 1.0,
            "path": str(source),
            "migrated": False,
            "size_bytes": size,
            "total_bytes": size,
            "copied_bytes": size,
        }
    try:
        target.relative_to(source)
        raise HTTPException(400, "新目录不能位于当前 LiteCut 素材目录内部。")
    except ValueError:
        pass
    try:
        source.relative_to(target)
        raise HTTPException(400, "新目录不能是当前 LiteCut 素材目录的上级目录。")
    except ValueError:
        pass

    target_existed = target.exists()
    if target_existed:
        try:
            if any(target.iterdir()):
                raise HTTPException(409, "目标目录不是空文件夹，请新建或选择一个空文件夹。")
        except OSError as exc:
            raise HTTPException(400, f"无法读取目标目录：{exc}") from exc

    job = LiteCutStorageMigrationJob(
        job_id=uuid.uuid4().hex,
        source=source,
        target=target,
        target_existed=target_existed,
    )
    _storage_migration_jobs[job.job_id] = job
    job.task = asyncio.create_task(_run_storage_migration(job))
    return _storage_migration_snapshot(job)


@router.get("/storage/migrate/{job_id}")
async def get_lite_cut_storage_migration(job_id: str):
    job = _storage_migration_jobs.get(str(job_id))
    if not job:
        raise HTTPException(404, "素材目录迁移任务不存在")
    return _storage_migration_snapshot(job)


@router.delete("/storage/migrate/{job_id}")
async def cancel_lite_cut_storage_migration(job_id: str):
    job = _storage_migration_jobs.get(str(job_id))
    if not job:
        raise HTTPException(404, "素材目录迁移任务不存在")
    if job.status not in {"queued", "running"}:
        return _storage_migration_snapshot(job)
    if job.stage in {"updating", "cleaning"}:
        raise HTTPException(409, "工程路径已经开始切换，当前阶段不能取消")
    job.cancel_event.set()
    job.status = "cancelling"
    job.stage = "cancelling"
    return _storage_migration_snapshot(job)


def _preset_asset_warnings(project_body: dict[str, Any]) -> list[dict[str, str]]:
    warnings: list[dict[str, str]] = []
    audio = project_body.get("audio") if isinstance(project_body.get("audio"), dict) else {}
    bgm = audio.get("bgm") if isinstance(audio.get("bgm"), dict) else None
    bgm_path = str(bgm.get("path") or "").strip() if bgm else ""
    if bgm_path and not Path(bgm_path).expanduser().is_file():
        warnings.append({"kind": "bgm", "path": bgm_path, "message": "BGM file is unavailable. Select a replacement in the Audio panel."})
    for overlay in project_body.get("overlays") or []:
        if not isinstance(overlay, dict):
            continue
        text = overlay.get("text") if isinstance(overlay.get("text"), dict) else {}
        font_path = str(text.get("font_file") or "").strip()
        if font_path and not Path(font_path).expanduser().is_file():
            warnings.append({"kind": "font", "path": font_path, "message": "Font file is unavailable. Select a replacement in the Text panel."})
    return warnings


async def _delete_project_asset_files(project_id: int) -> None:
    from .assets import delete_asset_file_bundle

    assets = await _get_lite_cut_db().list_project_assets(project_id)
    for asset in assets:
        await _stop_preview_proxy_job(int(asset["id"]))
    await asyncio.gather(*[
        asyncio.to_thread(delete_asset_file_bundle, str(asset.get("file_path") or ""))
        for asset in assets
        if asset.get("file_path")
    ])


@router.get("/projects")
async def list_lite_cut_projects(
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    items = await _get_lite_cut_db().list_projects(limit=limit, offset=offset)
    return {"items": items, "limit": limit, "offset": offset}


@router.post("/projects")
async def create_lite_cut_project(body: LiteCutProjectCreate):
    project_body = _normalize_project_body(body.body)
    pid = await _get_lite_cut_db().create_project(name=body.name.strip(), body=project_body)
    item = await _get_lite_cut_db().get_project(pid)
    if not item:
        raise HTTPException(500, error_detail("LITECUT_PROJECT_SAVE_FAILED"))
    return item


@router.get("/projects/{project_id}")
async def get_lite_cut_project(project_id: int):
    item = await _get_lite_cut_db().get_project(project_id)
    if not item:
        raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
    return item


@router.patch("/projects/{project_id}")
async def patch_lite_cut_project(project_id: int, body: LiteCutProjectPatch):
    if body.name is None and body.body is None:
        raise HTTPException(400, error_detail("LITECUT_PROJECT_NOTHING_TO_UPDATE"))
    previous = await _get_lite_cut_db().get_project(project_id)
    if not previous:
        raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
    try:
        if body.body is not None:
            normalized = _normalize_project_body(body.body)
            # A snapshot is intentionally written before the project row so a
            # completed autosave always has a matching recovery point.
            await _get_lite_cut_db().create_project_snapshot(
                project_id,
                name=body.name.strip() if body.name is not None else str(previous.get("name") or ""),
                body=normalized,
                reason="save",
            )
            await _get_lite_cut_db().update_project(
                project_id,
                name=body.name.strip() if body.name is not None else None,
                body=normalized,
            )
        elif body.name is not None:
            await _get_lite_cut_db().update_project(project_id, name=body.name.strip())
    except ValueError as e:
        if str(e) == "project not found":
            raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND")) from e
        raise HTTPException(400, error_detail("LITECUT_PROJECT_SAVE_FAILED")) from e
    item = await _get_lite_cut_db().get_project(project_id)
    if not item:
        raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
    return item


@router.get("/projects/{project_id}/snapshots")
async def list_lite_cut_project_snapshots(project_id: int):
    if not await _get_lite_cut_db().get_project(project_id):
        raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
    return {"items": await _get_lite_cut_db().list_project_snapshots(project_id)}


@router.post("/projects/{project_id}/snapshots/{snapshot_id}/restore")
async def restore_lite_cut_project_snapshot(project_id: int, snapshot_id: int):
    current = await _get_lite_cut_db().get_project(project_id)
    if not current:
        raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
    snapshot = await _get_lite_cut_db().get_project_snapshot(project_id, snapshot_id)
    if not snapshot:
        raise HTTPException(404, "snapshot not found")
    # Preserve the state being replaced as a separate rollback point.
    await _get_lite_cut_db().create_project_snapshot(
        project_id, name=str(current.get("name") or ""), body=current["body"], reason="before_restore"
    )
    restored = _normalize_project_body(snapshot["body"])
    await _get_lite_cut_db().update_project(project_id, body=restored)
    item = await _get_lite_cut_db().get_project(project_id)
    if not item:
        raise HTTPException(500, error_detail("LITECUT_PROJECT_SAVE_FAILED"))
    return item


def _body_file_paths(value: Any) -> set[Path]:
    """Find real file references in a project without guessing at directory fields."""
    paths: set[Path] = set()
    if isinstance(value, dict):
        for item in value.values():
            paths.update(_body_file_paths(item))
    elif isinstance(value, list):
        for item in value:
            paths.update(_body_file_paths(item))
    elif isinstance(value, str) and value.strip():
        try:
            path = Path(value).expanduser()
            if path.is_file():
                paths.add(path.resolve())
        except OSError:
            pass
    return paths


def _replace_portable_references(value: Any, path_map: dict[str, str], asset_id_map: dict[int, int], *, key: str = "") -> Any:
    if isinstance(value, dict):
        return {name: _replace_portable_references(item, path_map, asset_id_map, key=name) for name, item in value.items()}
    if isinstance(value, list):
        return [_replace_portable_references(item, path_map, asset_id_map, key=key) for item in value]
    if isinstance(value, str):
        return path_map.get(value, value)
    # Asset ids appear in clip metadata / BGM. Do not replace generic numeric
    # values such as timeline offsets.
    if isinstance(value, int) and key in {"asset_id", "source_id"}:
        return asset_id_map.get(value, value)
    return value


def _portable_package_path(
    project: dict[str, Any],
    assets: list[dict[str, Any]],
    *,
    on_progress: Callable[[str, int, int, int, int], None] | None = None,
    on_output: Callable[[Path], None] | None = None,
    cancel_event: threading.Event | None = None,
) -> Path:
    """Create a self-contained archive. The generated zip is safe to send as a normal download."""
    package_dir = get_data_dir() / "lite_cut_packages"
    package_dir.mkdir(parents=True, exist_ok=True)
    safe_name = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in str(project.get("name") or "LiteCut"))[:80] or "LiteCut"
    output = package_dir / f"{safe_name}-{uuid.uuid4().hex[:8]}.litecut.zip"
    if on_output:
        on_output(output)
    source_rows = {str(Path(str(row.get("file_path") or "")).resolve()): row for row in assets if row.get("file_path")}
    paths = set(source_rows)
    paths.update(str(path) for path in _body_file_paths(project.get("body") or {}))
    source_paths = [Path(raw_path) for raw_path in sorted(paths) if Path(raw_path).is_file()]
    total_bytes = sum(path.stat().st_size for path in source_paths)
    if on_progress:
        on_progress("preparing", 0, total_bytes, 0, len(source_paths))
    if cancel_event is not None and cancel_event.is_set():
        raise InterruptedError("portable package cancelled")
    manifest_files: list[dict[str, Any]] = []
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        completed_bytes = 0
        for index, source in enumerate(source_paths):
            if cancel_event is not None and cancel_event.is_set():
                raise InterruptedError("portable package cancelled")
            raw_path = str(source)
            suffix = source.suffix.lower()
            archive_name = f"assets/{index:04d}_{uuid.uuid4().hex[:8]}{suffix}"
            archive.write(source, archive_name)
            row = source_rows.get(raw_path) or {}
            manifest_files.append({
                "archive_path": archive_name,
                "original_path": raw_path,
                "asset_id": row.get("id"),
                "name": row.get("name") or source.name,
                "kind": row.get("kind"),
                "mime_type": row.get("mime_type") or mimetypes.guess_type(source.name)[0],
                "duration_sec": row.get("duration_sec"),
                "width": row.get("width"),
                "height": row.get("height"),
            })
            completed_bytes += source.stat().st_size
            if on_progress:
                on_progress("compressing", completed_bytes, total_bytes, index + 1, len(source_paths))
            if cancel_event is not None and cancel_event.is_set():
                raise InterruptedError("portable package cancelled")
        archive.writestr("project.json", json.dumps({
            "format": "litecut-portable-project",
            "version": 1,
            "name": project.get("name") or "LiteCut Project",
            "body": project.get("body") or {},
            "files": manifest_files,
        }, ensure_ascii=False, indent=2))
    return output


def _portable_package_snapshot(job: LiteCutPortablePackageJob) -> dict[str, Any]:
    return {
        "job_id": job.job_id,
        "project_id": job.project_id,
        "status": job.status,
        "stage": job.stage,
        "progress": max(0.0, min(1.0, job.progress)),
        "total_bytes": job.total_bytes,
        "completed_bytes": job.completed_bytes,
        "total_files": job.total_files,
        "completed_files": job.completed_files,
        "filename": job.filename,
        "saved_path": job.saved_path,
        "download_url": f"/api/lite-cut/portable-package/jobs/{job.job_id}/download" if job.status == "done" and job.package_path else "",
        "error": job.error,
    }


def _run_portable_package(job: LiteCutPortablePackageJob, project: dict[str, Any], assets: list[dict[str, Any]]) -> None:
    def report(stage: str, copied_bytes: int, total_bytes: int, copied_files: int, total_files: int) -> None:
        job.stage = stage
        job.total_bytes = total_bytes
        job.completed_bytes = copied_bytes
        job.total_files = total_files
        job.completed_files = copied_files
        job.progress = 0.95 * copied_bytes / max(1, total_bytes)

    try:
        job.status = "running"
        job.stage = "preparing"
        package = _portable_package_path(
            project, assets, on_progress=report, cancel_event=job.cancel_event,
            on_output=lambda output: setattr(job, "package_path", str(output)),
        )
        job.package_path = str(package)
        job.progress = 0.96
        if job.cancel_event.is_set():
            raise InterruptedError("portable package cancelled")
        if job.destination is not None:
            job.stage = "saving"
            job.destination.mkdir(parents=True, exist_ok=True)
            target = job.destination / job.filename
            if target.exists():
                target = target.with_name(f"{target.stem}_{uuid.uuid4().hex[:6]}{target.suffix}")
            shutil.copy2(package, target)
            job.saved_path = str(target)
        if job.cancel_event.is_set():
            raise InterruptedError("portable package cancelled")
        job.status = "done"
        job.stage = "done"
        job.progress = 1.0
    except InterruptedError:
        job.status = "cancelled"
        job.stage = "cancelled"
        job.error = ""
        if job.package_path:
            Path(job.package_path).unlink(missing_ok=True)
            job.package_path = ""
    except Exception as exc:
        job.status = "error"
        job.stage = "error"
        job.error = str(exc) or "便携工程包生成失败"
        logger.warning("LiteCut portable package failed", exc_info=True)


class LiteCutPortablePackageStartBody(BaseModel):
    destination: str = Field(default="", max_length=2048)


@router.post("/projects/{project_id}/portable-package/start")
async def start_lite_cut_portable_package(project_id: int, body: LiteCutPortablePackageStartBody):
    project = await _get_lite_cut_db().get_project(project_id)
    if not project:
        raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
    destination: Path | None = None
    if body.destination.strip():
        try:
            destination = Path(body.destination.strip().strip('"')).expanduser().resolve(strict=False)
            destination.mkdir(parents=True, exist_ok=True)
            if not destination.is_dir():
                raise OSError("destination is not a directory")
        except OSError as exc:
            raise HTTPException(400, f"导出位置不可用：{exc}") from exc
    assets = await _get_lite_cut_db().list_project_assets(project_id)
    safe_name = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in str(project.get("name") or "LiteCut"))[:80] or "LiteCut"
    job = LiteCutPortablePackageJob(
        job_id=uuid.uuid4().hex,
        project_id=project_id,
        filename=f"{safe_name}.litecut.zip",
        destination=destination,
    )
    _portable_package_jobs[job.job_id] = job
    job.task = asyncio.create_task(asyncio.to_thread(_run_portable_package, job, project, assets))
    return _portable_package_snapshot(job)


@router.get("/portable-package/jobs/{job_id}")
async def get_lite_cut_portable_package_job(job_id: str):
    job = _portable_package_jobs.get(str(job_id))
    if not job:
        raise HTTPException(404, "便携工程包任务不存在或已过期")
    return _portable_package_snapshot(job)


@router.delete("/portable-package/jobs/{job_id}")
async def cancel_lite_cut_portable_package_job(job_id: str):
    job = _portable_package_jobs.get(str(job_id))
    if not job:
        raise HTTPException(404, "便携工程包任务不存在或已过期")
    if job.status in {"done", "error", "cancelled"}:
        return _portable_package_snapshot(job)
    job.cancel_event.set()
    job.status = "cancelling"
    job.stage = "cancelling"
    return _portable_package_snapshot(job)


@router.get("/portable-package/jobs/{job_id}/download")
async def download_lite_cut_portable_package_job(job_id: str):
    job = _portable_package_jobs.get(str(job_id))
    if not job:
        raise HTTPException(404, "便携工程包任务不存在或已过期")
    if job.status != "done" or not job.package_path:
        raise HTTPException(409, "便携工程包尚未准备完成")
    return FileResponse(job.package_path, media_type="application/zip", filename=job.filename)


@router.get("/projects/{project_id}/portable-package")
async def download_lite_cut_portable_package(project_id: int):
    project = await _get_lite_cut_db().get_project(project_id)
    if not project:
        raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
    assets = await _get_lite_cut_db().list_project_assets(project_id)
    package = await asyncio.to_thread(_portable_package_path, project, assets)
    filename = f"{str(project.get('name') or 'LiteCut').strip() or 'LiteCut'}.litecut.zip"
    return FileResponse(package, media_type="application/zip", filename=filename)


async def _rollback_portable_import(project_id: int | None, destination: Path | None) -> None:
    """Remove every artifact created by a failed portable-project import."""
    if project_id is None:
        return
    try:
        await _delete_project_asset_files(project_id)
    except Exception:
        logger.warning("Failed to remove imported LiteCut asset records during rollback", exc_info=True)
    try:
        await _get_lite_cut_db().delete_project(project_id)
    except Exception:
        logger.warning("Failed to remove imported LiteCut project during rollback", exc_info=True)
    if destination is not None:
        await asyncio.to_thread(shutil.rmtree, destination, True)


@router.post("/projects/portable-import")
async def import_lite_cut_portable_package(file: UploadFile = File(...)):
    from .assets import asset_kind_for_path, stable_project_asset_directory, validate_asset_filename

    if not str(file.filename or "").lower().endswith(".zip"):
        raise HTTPException(400, "请选择 LiteCut 便携工程包（.zip）")
    package_dir = get_data_dir() / "lite_cut_packages"
    package_dir.mkdir(parents=True, exist_ok=True)
    temp_path: Path | None = None
    project_id: int | None = None
    destination: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(prefix="litecut-import-", suffix=".zip", dir=package_dir, delete=False) as temp:
            temp_path = Path(temp.name)
            total = 0
            while chunk := await file.read(8 * 1024 * 1024):
                total += len(chunk)
                if total > 20 * 1024 * 1024 * 1024:
                    raise HTTPException(400, "便携工程包不能超过 20GB")
                temp.write(chunk)
        with zipfile.ZipFile(temp_path) as archive:
            total_unpacked = sum(info.file_size for info in archive.infolist() if not info.is_dir())
            if total_unpacked > 20 * 1024 * 1024 * 1024:
                raise HTTPException(400, "便携工程包解压后的素材不能超过 20GB")
            try:
                raw_project = json.loads(archive.read("project.json").decode("utf-8"))
            except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise HTTPException(400, "无效的 LiteCut 便携工程包") from exc
            if raw_project.get("format") != "litecut-portable-project" or not isinstance(raw_project.get("body"), dict):
                raise HTTPException(400, "不支持的 LiteCut 便携工程包")
            name = str(raw_project.get("name") or "Imported LiteCut Project").strip()[:240] or "Imported LiteCut Project"
            project_id = await _get_lite_cut_db().create_project(name=name, body=_normalize_project_body(raw_project["body"]))
            project = await _get_lite_cut_db().get_project(project_id)
            if not project:
                raise HTTPException(500, error_detail("LITECUT_PROJECT_SAVE_FAILED"))
            destination = stable_project_asset_directory(project_id, str(project.get("name") or name))
            path_map: dict[str, str] = {}
            asset_id_map: dict[int, int] = {}
            for item in raw_project.get("files") or []:
                if not isinstance(item, dict):
                    continue
                member = str(item.get("archive_path") or "")
                if not member.startswith("assets/") or ".." in Path(member).parts:
                    raise HTTPException(400, "工程包包含不安全的素材路径")
                info = archive.getinfo(member)
                if info.is_dir() or info.file_size > 20 * 1024 * 1024 * 1024:
                    raise HTTPException(400, "工程包素材无效")
                original_name = validate_asset_filename(str(item.get("name") or Path(member).name))
                destination_file = destination / f"{Path(original_name).stem}_{uuid.uuid4().hex[:10]}{Path(original_name).suffix.lower()}"
                inferred_kind = asset_kind_for_path(destination_file)
                if inferred_kind == "file":
                    raise HTTPException(400, f"工程包包含不支持的素材类型：{destination_file.suffix or '(none)'}")
                with archive.open(info) as reader, destination_file.open("wb") as writer:
                    shutil.copyfileobj(reader, writer, length=8 * 1024 * 1024)
                old_path = str(item.get("original_path") or "")
                if old_path:
                    path_map[old_path] = str(destination_file)
                old_asset_id = item.get("asset_id")
                new_asset_id = await _get_lite_cut_db().create_asset(
                    name=original_name,
                    kind=str(item.get("kind") or inferred_kind),
                    mime_type=item.get("mime_type") or mimetypes.guess_type(destination_file.name)[0],
                    file_path=str(destination_file),
                    duration_sec=item.get("duration_sec"),
                    width=item.get("width"), height=item.get("height"), project_id=project_id,
                )
                if isinstance(old_asset_id, int):
                    asset_id_map[old_asset_id] = new_asset_id
            imported_body = _replace_portable_references(raw_project["body"], path_map, asset_id_map)
            await _get_lite_cut_db().update_project(project_id, body=_normalize_project_body(imported_body))
        item = await _get_lite_cut_db().get_project(project_id)
        return item
    except zipfile.BadZipFile as exc:
        await _rollback_portable_import(project_id, destination)
        raise HTTPException(400, "无效的 LiteCut 便携工程包") from exc
    except Exception:
        await _rollback_portable_import(project_id, destination)
        raise
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


@router.delete("/projects/{project_id}")
async def delete_lite_cut_project(project_id: int):
    if not await _get_lite_cut_db().get_project(project_id):
        raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
    await _delete_project_asset_files(project_id)
    ok = await _get_lite_cut_db().delete_project(project_id)
    if not ok:
        raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
    return {"deleted": True, "id": project_id}


class LiteCutProjectBatchDeleteBody(BaseModel):
    ids: list[int]


@router.post("/projects/batch-delete")
async def batch_delete_lite_cut_projects(body: LiteCutProjectBatchDeleteBody):
    ids = sorted({int(value) for value in body.ids if int(value) > 0})
    if not ids or len(ids) > 500:
        raise HTTPException(400, "project ids must contain 1 to 500 items")
    for project_id in ids:
        await _delete_project_asset_files(project_id)
    deleted_ids = await _get_lite_cut_db().delete_projects(ids)
    return {"deleted": len(deleted_ids), "ids": deleted_ids}


@router.get("/presets")
async def list_lite_cut_presets(
    kind: str | None = Query(default=None),
    tag: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    items = await _get_lite_cut_db().list_presets(kind=kind, tag=tag, limit=limit, offset=offset)
    return {"items": items, "limit": limit, "offset": offset}


@router.post("/presets")
async def create_lite_cut_preset(body: LiteCutPresetCreate):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, error_detail("LITECUT_PRESET_NAME_REQUIRED"))
    pid = await _get_lite_cut_db().create_preset(
        name=name,
        kind=body.kind,
        body=body.body,
        tags=body.tags,
        source_project_id=body.source_project_id,
    )
    item = await _get_lite_cut_db().get_preset(pid)
    if not item:
        raise HTTPException(500, error_detail("LITECUT_PRESET_SAVE_FAILED"))
    return item


@router.get("/presets/{preset_id}")
async def get_lite_cut_preset(preset_id: int):
    item = await _get_lite_cut_db().get_preset(preset_id)
    if not item:
        raise HTTPException(404, error_detail("LITECUT_PRESET_NOT_FOUND"))
    return item


@router.patch("/presets/{preset_id}")
async def patch_lite_cut_preset(preset_id: int, body: LiteCutPresetPatch):
    if body.name is None and body.tags is None:
        raise HTTPException(400, error_detail("LITECUT_PRESET_NOTHING_TO_UPDATE"))
    try:
        await _get_lite_cut_db().update_preset(
            preset_id,
            name=body.name.strip() if body.name is not None else None,
            tags=body.tags,
        )
    except ValueError as e:
        if str(e) == "preset not found":
            raise HTTPException(404, error_detail("LITECUT_PRESET_NOT_FOUND")) from e
        raise HTTPException(400, error_detail("LITECUT_PRESET_SAVE_FAILED")) from e
    item = await _get_lite_cut_db().get_preset(preset_id)
    if not item:
        raise HTTPException(404, error_detail("LITECUT_PRESET_NOT_FOUND"))
    return item


@router.delete("/presets/{preset_id}")
async def delete_lite_cut_preset(preset_id: int):
    ok = await _get_lite_cut_db().delete_preset(preset_id)
    if not ok:
        raise HTTPException(404, error_detail("LITECUT_PRESET_NOT_FOUND"))
    return {"deleted": True, "id": preset_id}


@router.post("/presets/{preset_id}/apply")
async def apply_lite_cut_preset(preset_id: int, body: PresetApplyRequest):
    """Apply a saved LiteCut preset to the requested project or body."""
    preset = await _get_lite_cut_db().get_preset(preset_id)
    if not preset:
        raise HTTPException(404, error_detail("LITECUT_PRESET_NOT_FOUND"))

    project_raw: dict[str, Any] | None = None
    if body.project_id is not None:
        proj = await _get_lite_cut_db().get_project(int(body.project_id))
        if not proj:
            raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
        project_raw = proj.get("body") if isinstance(proj.get("body"), dict) else empty_project().model_dump()
    elif body.project_body is not None:
        project_raw = body.project_body
    else:
        project_raw = empty_project().model_dump()

    try:
        updated = apply_preset_to_project(
            project_raw,
            str(preset["kind"]),
            preset.get("body") if isinstance(preset.get("body"), dict) else {},
            clip_ids=body.clip_ids,
            scope=body.scope,
            include=body.include or None,
        )
    except ValueError as e:
        raise HTTPException(400, error_detail("LITECUT_PRESET_APPLY_FAILED", reason=str(e))) from e

    if body.project_id is not None:
        await _get_lite_cut_db().update_project(
            int(body.project_id),
            body=updated.model_dump(mode="json"),
        )
        await _get_lite_cut_db().touch_preset_applied(preset_id)

    output_body = updated.model_dump(mode="json")
    return {"project_body": output_body, "preset_id": preset_id, "warnings": _preset_asset_warnings(output_body)}


class LiteCutExportBody(BaseModel):
    project_id: int | None = None
    body: dict[str, Any] | None = None
    output_path: str


class LiteCutAssetValidationBody(BaseModel):
    body: dict[str, Any]


@router.post("/assets/validate")
async def validate_lite_cut_assets(body: LiteCutAssetValidationBody):
    """Report media references that cannot be resolved on this machine."""
    from .composer import _missing_file_assets_for_export, _recorded_source_ids_for_export

    project_body = _normalize_project_body(body.body)
    missing = _missing_file_assets_for_export(project_body)
    source_ids = _recorded_source_ids_for_export(project_body)
    if source_ids:
        rows = await _get_montage_db().get_recorded_clips_by_ids(source_ids)
        for source_id in source_ids:
            row = rows.get(source_id)
            raw_path = str(row.get("output_path") or "").strip() if row else ""
            path = Path(raw_path).expanduser() if raw_path else None
            if row is None or path is None or not path.is_file():
                missing.append(
                    {
                        "kind": "recording",
                        "name": path.name if path else f"Insight recording #{source_id}",
                        "path": raw_path,
                        "source_id": source_id,
                    }
                )
    return {"items": missing}


async def _prepare_lite_cut_export(body: LiteCutExportBody) -> dict[str, Any]:
    from ..env_utils import load_config
    from ..montage_errors import montage_detail_from_exception
    from ..video_composer import MontageComposerError, resolve_ffmpeg_binary
    from .composer import _main_video_clips_sorted, _recorded_source_ids_for_export
    from .export_preflight import (
        ensure_ffmpeg_runnable,
        ensure_files_readable,
        ensure_output_space,
        estimate_required_space,
        project_file_paths,
        unique_output_path,
    )

    cfg = load_config()
    try:
        ffmpeg_bin = resolve_ffmpeg_binary(cfg.ffmpeg_path)
    except MontageComposerError as e:
        raise HTTPException(400, montage_detail_from_exception(e)) from e

    project_body: dict[str, Any] | None = None
    if body.project_id is not None:
        proj = await _get_lite_cut_db().get_project(int(body.project_id))
        if not proj:
            raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
        project_body = proj.get("body") if isinstance(proj.get("body"), dict) else None
    elif body.body is not None:
        project_body = body.body

    if not project_body:
        raise HTTPException(400, error_detail("LITECUT_EXPORT_NO_BODY"))

    clips = _main_video_clips_sorted(project_body)
    if not clips:
        raise HTTPException(400, error_detail("MONTAGE_NO_CLIPS"))

    source_ids = _recorded_source_ids_for_export(project_body)
    rows = await _get_montage_db().get_recorded_clips_by_ids(source_ids) if source_ids else {}
    clip_paths: dict[int, Path] = {}
    for sid in source_ids:
        row = rows.get(sid)
        if not row:
            raise HTTPException(400, error_detail("MONTAGE_CLIP_NOT_FOUND", id=str(sid)))
        clip_paths[sid] = Path(str(row["output_path"]))

    requested_encoder = _resolve_lite_cut_encoder(project_body, cfg.montage_encoder)
    reserved_paths = [
        job.output_path
        for job in _export_jobs.values()
        if job.status in {"queued", "running", "cancelling"} and job.output_path
    ]
    try:
        output_path = await asyncio.to_thread(unique_output_path, body.output_path, reserved=reserved_paths)
        await asyncio.to_thread(ensure_ffmpeg_runnable, ffmpeg_bin)
        source_paths = project_file_paths(project_body, clip_paths.values())
        source_bytes = await asyncio.to_thread(ensure_files_readable, source_paths)
        required_bytes = estimate_required_space(project_body, source_bytes)
        await asyncio.to_thread(ensure_output_space, output_path, required_bytes)
    except MontageComposerError as e:
        raise HTTPException(400, montage_detail_from_exception(e)) from e

    return {
        "ffmpeg_bin": ffmpeg_bin,
        "project_body": project_body,
        "clip_paths": clip_paths,
        "output_path": str(output_path),
        "montage_encoder": requested_encoder,
    }


async def _run_lite_cut_export_job(job: LiteCutExportJob, prepared: dict[str, Any]) -> None:
    from ..montage_errors import montage_detail_from_exception
    from ..video_composer import MontageComposerError
    from .composer import export_lite_cut_project
    from .export_preflight import remove_partial_output, validate_export_output

    db = _get_lite_cut_db()
    job.status = "running"
    job.stage = "starting"
    job.progress = max(job.progress, 0.01)
    await db.update_export(job.export_id, status="running", output_path=job.output_path)

    def on_progress(progress: float, stage: str) -> None:
        job.progress = max(job.progress, max(0.0, min(1.0, float(progress or 0.0))))
        job.stage = str(stage or job.stage or "running")

    try:
        out = await asyncio.to_thread(
            export_lite_cut_project,
            ffmpeg_bin=prepared["ffmpeg_bin"],
            project_body=prepared["project_body"],
            clip_path_by_id=prepared["clip_paths"],
            output_path_str=prepared["output_path"],
            montage_encoder=prepared["montage_encoder"],
            progress_callback=on_progress,
            cancel_event=job.cancel_event,
        )
        await asyncio.to_thread(validate_export_output, prepared["ffmpeg_bin"], out)
    except MontageComposerError as e:
        await asyncio.to_thread(remove_partial_output, job.output_path)
        if e.code == "MONTAGE_EXPORT_CANCELLED" or job.cancel_event.is_set():
            job.status = "cancelled"
            job.stage = "cancelled"
            job.error = ""
            await db.update_export(job.export_id, status="cancelled", error_msg="", output_path=job.output_path)
            return
        detail = montage_detail_from_exception(e)
        code = str(detail.get("code") or "MONTAGE_EXPORT_FAILED")
        job.status = "error"
        job.stage = "error"
        job.error = code
        await db.update_export(job.export_id, status="error", error_msg=code, output_path=job.output_path)
        return
    except Exception as e:
        await asyncio.to_thread(remove_partial_output, job.output_path)
        logger.exception("lite_cut background export failed")
        code = "MONTAGE_EXPORT_FAILED"
        job.status = "error"
        job.stage = "error"
        job.error = code
        await db.update_export(job.export_id, status="error", error_msg=code, output_path=job.output_path)
        return

    job.status = "done"
    job.stage = "done"
    job.progress = 1.0
    job.output_path = str(out)
    job.error = ""
    await db.update_export(job.export_id, status="done", error_msg="", output_path=str(out))


@router.post("/export")
async def lite_cut_export(body: LiteCutExportBody):
    from ..montage_errors import montage_detail_from_exception
    from ..video_composer import MontageComposerError
    from .composer import export_lite_cut_project
    from .export_preflight import remove_partial_output, validate_export_output

    prepared = await _prepare_lite_cut_export(body)
    if body.project_id is not None:
        project = await _get_lite_cut_db().get_project(int(body.project_id))
        if project:
            await _get_lite_cut_db().create_project_snapshot(
                int(body.project_id), name=str(project.get("name") or ""), body=prepared["project_body"], reason="before_export"
            )
    export_id = await _get_lite_cut_db().create_export(
        project_id=int(body.project_id) if body.project_id is not None else None,
        body=prepared["project_body"],
        status="running",
        output_path=prepared["output_path"],
    )

    try:
        out = await asyncio.to_thread(
            export_lite_cut_project,
            ffmpeg_bin=prepared["ffmpeg_bin"],
            project_body=prepared["project_body"],
            clip_path_by_id=prepared["clip_paths"],
            output_path_str=prepared["output_path"],
            montage_encoder=prepared["montage_encoder"],
        )
        await asyncio.to_thread(validate_export_output, prepared["ffmpeg_bin"], out)
    except MontageComposerError as e:
        await asyncio.to_thread(remove_partial_output, prepared["output_path"])
        detail = montage_detail_from_exception(e)
        await _get_lite_cut_db().update_export(
            export_id, status="error", error_msg=str(detail.get("code") or "MONTAGE_EXPORT_FAILED")
        )
        raise HTTPException(400, detail) from e

    await _get_lite_cut_db().update_export(export_id, status="done", error_msg="", output_path=str(out))
    return {"export_id": export_id, "status": "done", "output_path": str(out)}


@router.post("/export/start")
async def start_lite_cut_export(body: LiteCutExportBody):
    prepared = await _prepare_lite_cut_export(body)
    if body.project_id is not None:
        project = await _get_lite_cut_db().get_project(int(body.project_id))
        if project:
            await _get_lite_cut_db().create_project_snapshot(
                int(body.project_id), name=str(project.get("name") or ""), body=prepared["project_body"], reason="before_export"
            )
    export_id = await _get_lite_cut_db().create_export(
        project_id=int(body.project_id) if body.project_id is not None else None,
        body=prepared["project_body"],
        status="queued",
        output_path=prepared["output_path"],
    )
    job = LiteCutExportJob(
        export_id=export_id,
        project_id=int(body.project_id) if body.project_id is not None else None,
        output_path=prepared["output_path"],
    )
    _export_jobs[export_id] = job
    job.task = asyncio.create_task(_run_lite_cut_export_job(job, prepared))
    return _export_job_snapshot(job)


@router.get("/exports")
async def list_lite_cut_exports(
    project_id: int | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
):
    rows = await _get_lite_cut_db().list_exports(project_id=project_id, limit=limit, offset=offset)
    items: list[dict[str, Any]] = []
    for row in rows:
        job = _export_jobs.get(int(row["id"]))
        if job:
            items.append(_export_job_snapshot(job))
        else:
            items.append(_export_row_snapshot(row))
    return {"items": items, "limit": limit, "offset": offset}


@router.get("/exports/{export_id}")
async def get_lite_cut_export(export_id: int):
    job = _export_jobs.get(int(export_id))
    if job:
        return _export_job_snapshot(job)
    row = await _get_lite_cut_db().get_export(int(export_id))
    if not row:
        raise HTTPException(404, error_detail("LITECUT_EXPORT_NOT_FOUND"))
    return _export_row_snapshot(row)


@router.post("/exports/{export_id}/cancel")
async def cancel_lite_cut_export(export_id: int):
    job = _export_jobs.get(int(export_id))
    if not job:
        row = await _get_lite_cut_db().get_export(int(export_id))
        if not row:
            raise HTTPException(404, error_detail("LITECUT_EXPORT_NOT_FOUND"))
        raise HTTPException(409, error_detail("LITECUT_EXPORT_NOT_ACTIVE"))
    if job.status in {"done", "error", "cancelled"}:
        return _export_job_snapshot(job)
    job.cancel_event.set()
    job.status = "cancelling"
    job.stage = "cancelling"
    await _get_lite_cut_db().update_export(job.export_id, status="cancelling", output_path=job.output_path)
    return _export_job_snapshot(job)


@router.get("/assets")
async def list_lite_cut_assets(
    project_id: int | None = Query(default=None),
    limit: int = Query(default=500, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    items = await _get_lite_cut_db().list_assets(project_id=project_id, limit=limit, offset=offset)
    from .assets import probe_image_dimensions
    for item in items:
        if item.get("kind") != "image" or (item.get("width") and item.get("height")):
            continue
        dimensions = await asyncio.to_thread(probe_image_dimensions, Path(str(item.get("file_path") or "")))
        if dimensions:
            item["width"], item["height"] = dimensions
            await _get_lite_cut_db().update_asset_dimensions(int(item["id"]), *dimensions)
    for item in items:
        _decorate_asset_preview_state(item)
    return {"items": items, "limit": limit, "offset": offset}


@router.post("/assets/upload")
async def upload_lite_cut_asset(
    file: UploadFile = File(...),
    project_id: int | None = Query(default=None),
    client_duration_sec: float | None = Query(default=None, ge=0),
):
    from pathlib import Path

    from .assets import probe_image_dimensions, save_uploaded_asset, stable_project_asset_directory

    project = None
    if project_id is not None:
        proj = await _get_lite_cut_db().get_project(int(project_id))
        if not proj:
            raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
        project = proj

    destination_dir = None
    if project is not None and project_id is not None:
        existing_assets = await _get_lite_cut_db().list_project_assets(int(project_id))
        destination_dir = stable_project_asset_directory(
            int(project_id),
            str(project.get("name") or "未命名工程"),
            [str(item.get("file_path") or "") for item in existing_assets],
        )
    dest, kind, mime = await save_uploaded_asset(
        file,
        project_name=project.get("name") if project else None,
        destination_dir=destination_dir,
    )
    duration_sec = None
    media_info: dict[str, Any] = {}
    if kind == "image":
        dimensions = probe_image_dimensions(dest)
        if dimensions:
            media_info["width"], media_info["height"] = dimensions
    if kind in {"video", "webm", "audio", "image"} or dest.suffix.lower() == ".gif":
        try:
            from ..env_utils import load_config
            from ..video_composer import probe_video_audio_summary, resolve_ffmpeg_binary, resolve_ffprobe_binary

            cfg = load_config()
            ffmpeg_bin = resolve_ffmpeg_binary(cfg.ffmpeg_path)
            ffprobe = resolve_ffprobe_binary(ffmpeg_bin)
            info = probe_video_audio_summary(dest, ffprobe)
            media_info = info
            duration = float(info.get("duration") or 0)
            if duration > 0:
                duration_sec = duration
        except Exception:
            duration_sec = None
    if duration_sec is None and client_duration_sec is not None and client_duration_sec > 0:
        # ffprobe may be unavailable (e.g. dev setups without bundled ffmpeg);
        # trust the browser-side metadata probe so clips get a real trim range.
        duration_sec = float(client_duration_sec)
    asset_id = await _get_lite_cut_db().create_asset(
        name=Path(file.filename or dest.name).name,
        kind=kind,
        file_path=str(dest),
        mime_type=mime or None,
        duration_sec=duration_sec,
        width=int(media_info.get("width") or 0) or None,
        height=int(media_info.get("height") or 0) or None,
        project_id=int(project_id) if project_id is not None else None,
    )
    item = await _get_lite_cut_db().get_asset(asset_id)
    if not item:
        raise HTTPException(500, error_detail("LITECUT_ASSET_SAVE_FAILED"))
    alpha_hint = bool(media_info.get("has_alpha")) if "has_alpha" in media_info else None
    return _decorate_asset_preview_state(item, has_alpha=alpha_hint)


@router.get("/assets/{asset_id}/metadata")
async def get_lite_cut_asset_metadata(asset_id: int):
    """Return source-media facts used by the inspector's read-only summary."""
    row = await _get_lite_cut_db().get_asset(int(asset_id))
    if not row:
        raise HTTPException(404, error_detail("LITECUT_ASSET_NOT_FOUND"))

    from pathlib import Path

    from .assets import probe_image_dimensions, validate_stored_asset_path

    path = validate_stored_asset_path(str(row["file_path"]))
    kind = str(row.get("kind") or "file").lower()
    result: dict[str, Any] = {
        "id": int(row["id"]),
        "kind": kind,
        "name": row.get("name") or path.name,
        "extension": path.suffix.lstrip(".").upper(),
        "mime_type": row.get("mime_type"),
        "duration_sec": row.get("duration_sec"),
        "width": row.get("width"),
        "height": row.get("height"),
        "fps": None,
        "codec_name": None,
        "has_audio": None,
    }
    if kind == "image":
        dimensions = await asyncio.to_thread(probe_image_dimensions, path)
        if dimensions:
            result["width"], result["height"] = dimensions
        return result

    try:
        from ..env_utils import load_config
        from ..video_composer import probe_video_audio_summary, resolve_ffmpeg_binary, resolve_ffprobe_binary

        ffmpeg_bin = resolve_ffmpeg_binary(load_config().ffmpeg_path)
        info = await asyncio.to_thread(probe_video_audio_summary, path, resolve_ffprobe_binary(ffmpeg_bin))
        result.update({
            "duration_sec": info.get("duration") or result["duration_sec"],
            "width": info.get("width") if kind not in {"audio"} else None,
            "height": info.get("height") if kind not in {"audio"} else None,
            "fps": info.get("fps") if kind not in {"audio"} else None,
            "codec_name": info.get("codec_name") or None,
            "has_audio": bool(info.get("has_audio")),
        })
    except Exception:
        logger.warning("LiteCut asset metadata probe failed for %s", path.name, exc_info=True)
    return result


@router.get("/assets/{asset_id}/waveform")
async def get_lite_cut_asset_waveform(
    asset_id: int,
    buckets: int = Query(default=72, ge=8, le=512),
    start_sec: float = Query(default=0, ge=0),
    end_sec: float | None = Query(default=None, ge=0),
):
    row = await _get_lite_cut_db().get_asset(int(asset_id))
    if not row:
        raise HTTPException(404, error_detail("LITECUT_ASSET_NOT_FOUND"))
    from ..video_composer import resolve_ffmpeg_binary
    from .assets import validate_stored_asset_path
    from .waveform import load_or_create_waveform_cache, waveform_view

    path = validate_stored_asset_path(str(row["file_path"]))
    try:
        payload, cached = await asyncio.to_thread(
            load_or_create_waveform_cache,
            path,
            ffmpeg_bin=resolve_ffmpeg_binary(load_config().ffmpeg_path),
            duration_sec=row.get("duration_sec"),
        )
    except Exception as exc:
        logger.warning("LiteCut waveform generation failed for %s", path.name, exc_info=True)
        raise HTTPException(422, str(exc) or "无法生成素材波形") from exc
    return {**waveform_view(payload, start_sec=start_sec, end_sec=end_sec, buckets=buckets), "cached": cached}


@router.get("/fonts/{font_name}")
async def stream_lite_cut_builtin_font(font_name: str):
    allowed = {
        "Rajdhani-Bold.ttf": "Rajdhani-Bold.ttf",
        "Rajdhani-SemiBold.ttf": "Rajdhani-SemiBold.ttf",
        "NotoSansSC-Bold.ttf": "NotoSansSC-Bold.ttf",
        "NotoSansSC-Medium.ttf": "NotoSansSC-Medium.ttf",
    }
    safe_name = allowed.get(font_name)
    if not safe_name:
        raise HTTPException(404, "font not found")
    path = Path(__file__).resolve().parents[2] / "assets" / "fonts" / safe_name
    return FileResponse(path, media_type="font/ttf", filename=safe_name)


@router.get("/assets/{asset_id}/stream")
async def stream_lite_cut_asset(asset_id: int, request: Request):
    from .assets import asset_stream_path, validate_stored_asset_path
    from .stream import stream_file_with_range

    row = await _get_lite_cut_db().get_asset(int(asset_id))
    if not row:
        raise HTTPException(404, error_detail("LITECUT_ASSET_NOT_FOUND"))
    path = validate_stored_asset_path(str(row["file_path"]))
    if str(row.get("kind") or "").lower() == "font":
        font_mime = {
            ".ttf": "font/ttf",
            ".otf": "font/otf",
            ".woff": "font/woff",
            ".woff2": "font/woff2",
        }.get(path.suffix.lower(), "application/font-sfnt")
        return FileResponse(path, media_type=font_mime, headers={"Cache-Control": "no-cache"})
    state = _decorate_asset_preview_state(row)
    if state.get("preview_proxy_required") and state.get("preview_proxy_status") != "ready":
        status = str(state.get("preview_proxy_status") or "queued")
        job = _preview_proxy_jobs.get(int(asset_id))
        if status in {"queued", "running"} and job and job.task:
            # Existing timeline clips may request the stream before the media
            # bin has polled the new state. Waiting here keeps that preview
            # request usable without blocking unrelated API work.
            await asyncio.shield(job.task)
            state = _decorate_asset_preview_state(row, schedule=False)
            status = str(state.get("preview_proxy_status") or "failed")
            if status == "ready":
                return await stream_file_with_range(asset_stream_path(path), request)
        if status in {"failed", "missing"}:
            raise HTTPException(422, state.get("preview_proxy_error") or "预览代理生成失败")
        raise HTTPException(425, "预览代理正在后台生成")
    return await stream_file_with_range(asset_stream_path(path), request)


@router.post("/assets/{asset_id}/proxy/retry")
async def retry_lite_cut_asset_preview_proxy(asset_id: int):
    row = await _get_lite_cut_db().get_asset(int(asset_id))
    if not row:
        raise HTTPException(404, error_detail("LITECUT_ASSET_NOT_FOUND"))
    state = _decorate_asset_preview_state(dict(row), schedule=False)
    if not state.get("preview_proxy_required"):
        return state
    await _stop_preview_proxy_job(int(asset_id))
    job = _start_preview_proxy_job(row, force=True)
    row.update(_preview_proxy_job_snapshot(job))
    return row


@router.delete("/assets/{asset_id}")
async def delete_lite_cut_asset(asset_id: int):
    from pathlib import Path

    from .assets import delete_asset_file_bundle

    row = await _get_lite_cut_db().get_asset(int(asset_id))
    if not row:
        raise HTTPException(404, error_detail("LITECUT_ASSET_NOT_FOUND"))
    await _stop_preview_proxy_job(int(asset_id))
    await asyncio.to_thread(delete_asset_file_bundle, str(row["file_path"]))
    ok = await _get_lite_cut_db().delete_asset(int(asset_id))
    if not ok:
        raise HTTPException(404, error_detail("LITECUT_ASSET_NOT_FOUND"))
    return {"deleted": True, "id": asset_id}
