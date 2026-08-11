"""LiteCut asset-storage inspection and migration routes."""

from __future__ import annotations

import asyncio
import logging
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ...env_utils import get_data_dir, load_config, save_config
from .runtime import (
    LiteCutStorageMigrationJob,
    export_jobs,
    get_lite_cut_db,
    preview_proxy_jobs,
    storage_migration_jobs,
)
from . import storage_service as _storage_service

router = APIRouter(prefix="/api/lite-cut", tags=["lite-cut-storage"])
logger = logging.getLogger(__name__)


shutil = _storage_service.shutil  # compatibility for fault-injection tests
_directory_size = _storage_service.directory_size
_storage_migration_snapshot = _storage_service.storage_migration_snapshot
_copy_storage_tree_with_progress = _storage_service.copy_storage_tree_with_progress
_verify_storage_copy = _storage_service.verify_storage_copy
_cleanup_migration_target = _storage_service.cleanup_migration_target


async def _run_storage_migration(job: LiteCutStorageMigrationJob) -> None:
    await _storage_service.run_storage_migration(
        job,
        db=get_lite_cut_db(),
        load_config=load_config,
        save_config=save_config,
        logger=logger,
    )

class LiteCutStorageMoveBody(BaseModel):
    destination: str = Field(min_length=1, max_length=2048)

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

    if any(job.status in {"queued", "running"} for job in preview_proxy_jobs.values()):
        raise HTTPException(409, "LiteCut 正在生成预览代理，请完成后再迁移素材目录")
    if any(job.status in {"queued", "running", "cancelling"} for job in export_jobs.values()):
        raise HTTPException(409, "LiteCut 正在导出，请等待导出结束后再迁移素材目录。")
    if any(job.status in {"queued", "running", "cancelling"} for job in storage_migration_jobs.values()):
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
    storage_migration_jobs[job.job_id] = job
    job.task = asyncio.create_task(_run_storage_migration(job))
    return _storage_migration_snapshot(job)


@router.get("/storage/migrate/{job_id}")
async def get_lite_cut_storage_migration(job_id: str):
    job = storage_migration_jobs.get(str(job_id))
    if not job:
        raise HTTPException(404, "素材目录迁移任务不存在")
    return _storage_migration_snapshot(job)


@router.delete("/storage/migrate/{job_id}")
async def cancel_lite_cut_storage_migration(job_id: str):
    job = storage_migration_jobs.get(str(job_id))
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
