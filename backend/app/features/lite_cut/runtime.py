"""Shared LiteCut database handles and background-job state."""

from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException
from pydantic import ValidationError

from ...env_utils import resolve_config_path
from ...montage_db import MontageDB
from .db import LiteCutDB
from .preset_apply import parse_project_body

LITE_CUT_ENCODERS = {"auto", "h264_nvenc", "h264_qsv", "h264_amf", "libx264"}


@dataclass
class LiteCutExportJob:
    export_id: int
    project_id: int | None
    status: str = "queued"
    progress: float = 0.0
    stage: str = "queued"
    output_path: str = ""
    error: str = ""
    started_at_monotonic: float = field(default_factory=time.monotonic)
    stage_started_at_monotonic: float = field(default_factory=time.monotonic)
    stage_progress: float | None = None
    processed_frames: int | None = None
    total_frames: int | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event)
    task: asyncio.Task | None = None


@dataclass
class LiteCutPreviewProxyJob:
    asset_id: int
    status: str = "queued"
    has_alpha: bool | None = None
    video_codec: str | None = None
    audio_codec: str | None = None
    pixel_format: str | None = None
    source_fps: float | None = None
    mode: str = "queued"
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


lite_cut_db: Optional[LiteCutDB] = None
montage_db: Optional[MontageDB] = None
export_jobs: dict[int, LiteCutExportJob] = {}
preview_proxy_jobs: dict[int, LiteCutPreviewProxyJob] = {}
storage_migration_jobs: dict[str, LiteCutStorageMigrationJob] = {}
portable_package_jobs: dict[str, LiteCutPortablePackageJob] = {}
preview_proxy_slots: asyncio.Semaphore | None = None
preview_proxy_slots_loop: asyncio.AbstractEventLoop | None = None


def get_lite_cut_db() -> LiteCutDB:
    global lite_cut_db
    if lite_cut_db is None:
        db_path = resolve_config_path().parent / "cs2-insight.db"
        lite_cut_db = LiteCutDB(db_path)
    return lite_cut_db


def get_montage_db() -> MontageDB:
    global montage_db
    if montage_db is None:
        db_path = resolve_config_path().parent / "cs2-insight.db"
        montage_db = MontageDB(db_path)
    return montage_db


def get_preview_proxy_slots() -> asyncio.Semaphore:
    global preview_proxy_slots, preview_proxy_slots_loop
    loop = asyncio.get_running_loop()
    if preview_proxy_slots is None or preview_proxy_slots_loop is not loop:
        preview_proxy_slots = asyncio.Semaphore(2)
        preview_proxy_slots_loop = loop
    return preview_proxy_slots


async def shutdown_lite_cut_jobs(timeout_sec: float = 10.0) -> bool:
    """Cancel all owned jobs and wait briefly for cooperative cleanup."""
    jobs = [
        *export_jobs.values(),
        *preview_proxy_jobs.values(),
        *storage_migration_jobs.values(),
        *portable_package_jobs.values(),
    ]
    active = [job for job in jobs if job.task is not None and not job.task.done()]
    for job in active:
        job.cancel_event.set()
    if not active:
        return True
    _done, pending = await asyncio.wait(
        [job.task for job in active if job.task is not None],
        timeout=max(0.0, timeout_sec),
    )
    return not pending


def resolve_lite_cut_encoder(
    project_body: dict[str, Any],
    configured_encoder: str | None,
) -> str:
    requested = str((project_body.get("output") or {}).get("encoder") or "").strip().lower()
    if requested in LITE_CUT_ENCODERS:
        return requested
    configured = str(configured_encoder or "auto").strip().lower()
    return configured if configured in LITE_CUT_ENCODERS else "auto"


def normalize_project_body(raw: dict[str, Any] | None) -> dict[str, Any]:
    try:
        return parse_project_body(raw).model_dump(mode="json")
    except ValidationError as exc:
        raise HTTPException(
            422,
            {"code": "LITECUT_PROJECT_INVALID", "message": str(exc)},
        ) from exc


def export_job_snapshot(job: LiteCutExportJob) -> dict[str, Any]:
    now = time.monotonic()
    elapsed_seconds = max(0.0, now - job.started_at_monotonic)
    stage_elapsed_seconds = max(0.0, now - job.stage_started_at_monotonic)
    estimated_remaining_seconds: float | None = None
    if job.stage_progress is not None and 0.005 < job.stage_progress < 1.0:
        estimated_remaining_seconds = stage_elapsed_seconds * (1.0 - job.stage_progress) / job.stage_progress
    return {
        "export_id": job.export_id,
        "project_id": job.project_id,
        "status": job.status,
        "progress": max(0.0, min(1.0, float(job.progress or 0.0))),
        "stage": job.stage,
        "output_path": job.output_path,
        "error": job.error,
        "elapsed_seconds": elapsed_seconds,
        "stage_progress": job.stage_progress,
        "processed_frames": job.processed_frames,
        "total_frames": job.total_frames,
        "estimated_remaining_seconds": estimated_remaining_seconds,
    }


def export_row_snapshot(row: dict[str, Any]) -> dict[str, Any]:
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
