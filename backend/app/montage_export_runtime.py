"""In-memory state for Montage Workbench background exports."""

from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class MontageExportJob:
    export_id: int
    project_id: int | None
    output_path: str
    status: str = "queued"
    progress: float = 0.0
    stage: str = "queued"
    error: str = ""
    started_at_monotonic: float = field(default_factory=time.monotonic)
    stage_started_at_monotonic: float = field(default_factory=time.monotonic)
    stage_progress: float | None = None
    encoder_warning: dict[str, Any] | None = None
    task: asyncio.Task | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event)


montage_export_jobs: dict[int, MontageExportJob] = {}


def montage_export_job_snapshot(job: MontageExportJob) -> dict[str, Any]:
    now = time.monotonic()
    elapsed_seconds = max(0.0, now - job.started_at_monotonic)
    stage_elapsed_seconds = max(0.0, now - job.stage_started_at_monotonic)
    estimated_remaining_seconds: float | None = None
    if job.stage_progress is not None and 0.005 < job.stage_progress < 1.0:
        estimated_remaining_seconds = stage_elapsed_seconds * (1.0 - job.stage_progress) / job.stage_progress
    elif 0.02 < job.progress < 0.99:
        estimated_remaining_seconds = elapsed_seconds * (1.0 - job.progress) / job.progress
    return {
        "export_id": job.export_id,
        "project_id": job.project_id,
        "status": job.status,
        "progress": max(0.0, min(1.0, float(job.progress or 0.0))),
        "stage": job.stage,
        "output_path": job.output_path,
        "error": job.error,
        "elapsed_seconds": elapsed_seconds,
        "encoder_warning": dict(job.encoder_warning) if job.encoder_warning else None,
        "estimated_remaining_seconds": estimated_remaining_seconds,
    }
