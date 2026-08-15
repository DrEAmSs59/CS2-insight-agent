"""Filesystem executor for LiteCut asset-storage migration."""

from __future__ import annotations

import asyncio
import logging
import shutil
from pathlib import Path
from typing import Any, Callable

from .runtime import LiteCutStorageMigrationJob


def directory_size(path: Path) -> int:
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


def storage_migration_snapshot(job: LiteCutStorageMigrationJob) -> dict[str, Any]:
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


def copy_storage_tree_with_progress(job: LiteCutStorageMigrationJob) -> list[tuple[Path, Path, int]]:
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


def verify_storage_copy(job: LiteCutStorageMigrationJob, files: list[tuple[Path, Path, int]]) -> None:
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


def cleanup_migration_target(job: LiteCutStorageMigrationJob) -> None:
    shutil.rmtree(job.target, ignore_errors=True)
    if job.target_existed:
        job.target.mkdir(parents=True, exist_ok=True)


async def run_storage_migration(
    job: LiteCutStorageMigrationJob,
    *,
    db: Any,
    load_config: Callable[[], Any],
    save_config: Callable[[Any], Any],
    logger: logging.Logger,
) -> None:
    paths_switched = False
    try:
        files = await asyncio.to_thread(copy_storage_tree_with_progress, job)
        await asyncio.to_thread(verify_storage_copy, job, files)
        if job.cancel_event.is_set():
            raise InterruptedError("迁移已取消")
        job.stage = "updating"
        job.progress = 0.96
        job.updated = await db.migrate_asset_storage_paths(job.source, job.target)
        paths_switched = True
        config = load_config()
        config.lite_cut_assets_dir = str(job.target)
        save_config(config)
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
        await asyncio.to_thread(cleanup_migration_target, job)
    except Exception as exc:
        if paths_switched:
            try:
                await db.migrate_asset_storage_paths(job.target, job.source)
                config = load_config()
                config.lite_cut_assets_dir = str(job.source)
                save_config(config)
            except Exception:
                logger.exception("LiteCut storage migration rollback failed")
        await asyncio.to_thread(cleanup_migration_target, job)
        job.status = "failed"
        job.stage = "failed"
        job.error = str(exc) or "迁移失败"
        logger.warning("LiteCut storage migration failed", exc_info=True)
