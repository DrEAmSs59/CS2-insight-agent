"""LiteCut asset-storage inspection and migration routes."""

from __future__ import annotations

import asyncio
import logging
import shutil
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..env_utils import get_data_dir, load_config, save_config
from .runtime import (
    LiteCutStorageMigrationJob,
    export_jobs,
    get_lite_cut_db,
    preview_proxy_jobs,
    storage_migration_jobs,
)

router = APIRouter(prefix="/api/lite-cut", tags=["lite-cut-storage"])
logger = logging.getLogger(__name__)


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
        job.updated = await get_lite_cut_db().migrate_asset_storage_paths(job.source, job.target)
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
                await get_lite_cut_db().migrate_asset_storage_paths(job.target, job.source)
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
