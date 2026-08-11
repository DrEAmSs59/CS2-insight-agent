"""LiteCut export preparation, execution and job-history routes."""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ...api_errors import error_detail
from ...env_utils import load_config
from ...video_export_log import (
    current_video_export_context,
    current_video_export_session_id,
    export_event,
    set_video_export_database_id,
    video_export_endpoint,
    video_export_session,
)
from .dependencies import build_lite_cut_services
from .export_executor import execute_prepared_export, remove_partial_export
from .service_http import service_call
from .runtime import (
    LiteCutExportJob,
    export_job_snapshot,
    export_jobs,
    export_row_snapshot,
    get_lite_cut_db,
    get_montage_db,
    normalize_project_body,
    resolve_lite_cut_encoder,
)

router = APIRouter(prefix="/api/lite-cut", tags=["lite-cut-exports"])
logger = logging.getLogger(__name__)


def _services():
    return build_lite_cut_services(get_lite_cut_db())


class LiteCutExportBody(BaseModel):
    project_id: int | None = None
    body: dict[str, Any] | None = None
    output_path: str

async def _prepare_lite_cut_export(body: LiteCutExportBody) -> dict[str, Any]:
    from .export_executor import prepare_export

    return await prepare_export(
        body,
        projects=_services().projects,
        montage_db=get_montage_db(),
        active_jobs=export_jobs,
        resolve_encoder=resolve_lite_cut_encoder,
    )


async def _run_lite_cut_export_job(job: LiteCutExportJob, prepared: dict[str, Any]) -> None:
    session_id = str(prepared.get("video_export_session_id") or "") or None
    with video_export_session(
        "lite_cut",
        session_id=session_id,
        database_export_id=job.export_id,
        phase="background",
        metadata={"project_id": job.project_id},
        started_monotonic=prepared.get("video_export_started_monotonic"),
    ):
        export_event(
            "background_job_started",
            status="running",
            output_name=Path(job.output_path).name,
            requested_encoder=prepared.get("montage_encoder"),
        )
        await _run_lite_cut_export_job_in_session(job, prepared)


async def _run_lite_cut_export_job_in_session(job: LiteCutExportJob, prepared: dict[str, Any]) -> None:
    from ...montage_errors import montage_detail_from_exception
    from ...video_composer import MontageComposerError

    exports = _services().exports
    job.status = "running"
    job.stage = "starting"
    job.progress = max(job.progress, 0.01)
    job.started_at_monotonic = time.monotonic()
    job.stage_started_at_monotonic = job.started_at_monotonic
    await exports.update(job.export_id, status="running", output_path=job.output_path)

    def on_progress(progress: float, stage: str, detail: dict[str, Any] | None = None) -> None:
        next_progress = max(0.0, min(1.0, float(progress or 0.0)))
        next_stage = str(stage or job.stage or "running")
        if next_stage != job.stage:
            job.stage_started_at_monotonic = time.monotonic()
            job.stage_progress = None
            job.processed_frames = None
            job.total_frames = None
        # A full encoder retry starts the render from the beginning. Reflect
        # that reset instead of leaving the UI stuck at 99–100% while x264 runs.
        if next_stage.startswith("fallback_"):
            job.progress = next_progress
        else:
            job.progress = max(job.progress, next_progress)
        job.stage = next_stage
        if isinstance(detail, dict):
            raw_stage_progress = detail.get("stage_progress")
            if raw_stage_progress is not None:
                job.stage_progress = max(0.0, min(1.0, float(raw_stage_progress)))
            if detail.get("processed_frames") is not None:
                job.processed_frames = max(0, int(detail["processed_frames"]))
            if detail.get("total_frames") is not None:
                job.total_frames = max(0, int(detail["total_frames"]))

    try:
        out = await execute_prepared_export(
            prepared,
            progress_callback=on_progress,
            cancel_event=job.cancel_event,
        )
    except MontageComposerError as e:
        await remove_partial_export(job.output_path)
        if e.code == "MONTAGE_EXPORT_CANCELLED" or job.cancel_event.is_set():
            job.status = "cancelled"
            job.stage = "cancelled"
            job.error = ""
            await exports.update(job.export_id, status="cancelled", error_msg="", output_path=job.output_path)
            export_event("pipeline_cancelled", status="cancelled", error_code=e.code)
            logger.info(
                "video export summary feature=lite_cut export_id=%s status=cancelled",
                job.export_id,
            )
            return
        detail = montage_detail_from_exception(e)
        code = str(detail.get("code") or "MONTAGE_EXPORT_FAILED")
        job.status = "error"
        job.stage = "error"
        job.error = code
        await exports.update(job.export_id, status="error", error_msg=code, output_path=job.output_path)
        export_event(
            "pipeline_failed",
            level=logging.ERROR,
            status="error",
            error_code=code,
            failure_domain=detail.get("failure_domain"),
            encoder=detail.get("encoder"),
            branch=detail.get("branch"),
        )
        logger.error(
            "video export summary feature=lite_cut export_id=%s status=error code=%s",
            job.export_id,
            code,
        )
        return
    except Exception as e:
        await remove_partial_export(job.output_path)
        logger.exception("lite_cut background export failed")
        code = "MONTAGE_EXPORT_FAILED"
        job.status = "error"
        job.stage = "error"
        job.error = code
        await exports.update(job.export_id, status="error", error_msg=code, output_path=job.output_path)
        export_event(
            "pipeline_failed",
            level=logging.ERROR,
            status="error",
            error_code=code,
            error_type=type(e).__name__,
        )
        return

    job.status = "done"
    job.stage = "done"
    job.progress = 1.0
    job.output_path = str(out)
    job.error = ""
    await exports.update(job.export_id, status="done", error_msg="", output_path=str(out))
    export_event(
        "pipeline_completed",
        status="done",
        output_name=Path(str(out)).name,
    )
    logger.info(
        "video export summary feature=lite_cut export_id=%s status=done output=%s",
        job.export_id,
        Path(str(out)).name,
    )


@router.post("/export")
@video_export_endpoint("lite_cut")
async def lite_cut_export(body: LiteCutExportBody):
    from ...montage_errors import montage_detail_from_exception
    from ...video_composer import MontageComposerError

    prepared = await _prepare_lite_cut_export(body)
    if body.project_id is not None:
        project = await _services().projects.get(int(body.project_id))
        if project:
            await service_call(_services().snapshots.create(int(body.project_id), reason="before_export"))
    export_id = await _services().exports.create(
        project_id=int(body.project_id) if body.project_id is not None else None,
        body=prepared["project_body"],
        status="running",
        output_path=prepared["output_path"],
    )
    set_video_export_database_id(export_id)
    export_event(
        "pipeline_started",
        database_export_id=export_id,
        project_id=body.project_id,
        output_name=Path(prepared["output_path"]).name,
        requested_encoder=prepared["montage_encoder"],
        framemeld_enabled=bool(
            (prepared["project_body"].get("output") or {}).get("framemeld_enabled")
        ),
    )

    try:
        out = await execute_prepared_export(prepared)
    except MontageComposerError as e:
        await remove_partial_export(prepared["output_path"])
        detail = montage_detail_from_exception(e)
        await _services().exports.update(
            export_id, status="error", error_msg=str(detail.get("code") or "MONTAGE_EXPORT_FAILED")
        )
        error_code = str(detail.get("code") or "MONTAGE_EXPORT_FAILED")
        export_event(
            "pipeline_failed",
            level=logging.ERROR,
            status="error",
            error_code=error_code,
            failure_domain=detail.get("failure_domain"),
            encoder=detail.get("encoder"),
            branch=detail.get("branch"),
        )
        logger.error(
            "video export summary feature=lite_cut export_id=%s status=error code=%s",
            export_id,
            error_code,
        )
        raise HTTPException(400, detail) from e

    await _services().exports.update(export_id, status="done", error_msg="", output_path=str(out))
    export_event(
        "pipeline_completed",
        status="done",
        output_name=Path(str(out)).name,
    )
    logger.info(
        "video export summary feature=lite_cut export_id=%s status=done output=%s",
        export_id,
        Path(str(out)).name,
    )
    return {"export_id": export_id, "status": "done", "output_path": str(out)}


@router.post("/export/start")
@video_export_endpoint("lite_cut")
async def start_lite_cut_export(body: LiteCutExportBody):
    prepared = await _prepare_lite_cut_export(body)
    if body.project_id is not None:
        project = await _services().projects.get(int(body.project_id))
        if project:
            await service_call(_services().snapshots.create(int(body.project_id), reason="before_export"))
    export_id = await _services().exports.create(
        project_id=int(body.project_id) if body.project_id is not None else None,
        body=prepared["project_body"],
        status="queued",
        output_path=prepared["output_path"],
    )
    set_video_export_database_id(export_id)
    prepared["video_export_session_id"] = current_video_export_session_id()
    current_context = current_video_export_context()
    if current_context is not None:
        prepared["video_export_started_monotonic"] = current_context.started_monotonic
    export_event(
        "background_job_queued",
        status="queued",
        database_export_id=export_id,
        project_id=body.project_id,
        output_name=Path(prepared["output_path"]).name,
        requested_encoder=prepared["montage_encoder"],
    )
    job = LiteCutExportJob(
        export_id=export_id,
        project_id=int(body.project_id) if body.project_id is not None else None,
        output_path=prepared["output_path"],
    )
    export_jobs[export_id] = job
    job.task = asyncio.create_task(_run_lite_cut_export_job(job, prepared))
    return export_job_snapshot(job)


@router.get("/exports")
async def list_lite_cut_exports(
    project_id: int | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
):
    result = await _services().exports.list(project_id=project_id, limit=limit, offset=offset)
    rows = result["items"]
    items: list[dict[str, Any]] = []
    for row in rows:
        job = export_jobs.get(int(row["id"]))
        if job:
            items.append(export_job_snapshot(job))
        else:
            items.append(export_row_snapshot(row))
    return {"items": items, "limit": limit, "offset": offset}


@router.get("/exports/{export_id}")
async def get_lite_cut_export(export_id: int):
    job = export_jobs.get(int(export_id))
    if job:
        return export_job_snapshot(job)
    row = await service_call(_services().exports.get(int(export_id)))
    return export_row_snapshot(row)


@router.post("/exports/{export_id}/cancel")
async def cancel_lite_cut_export(export_id: int):
    job = export_jobs.get(int(export_id))
    if not job:
        await service_call(_services().exports.get(int(export_id)))
        raise HTTPException(409, error_detail("LITECUT_EXPORT_NOT_ACTIVE"))
    if job.status in {"done", "error", "cancelled"}:
        return export_job_snapshot(job)
    job.cancel_event.set()
    job.status = "cancelling"
    job.stage = "cancelling"
    await _services().exports.update(job.export_id, status="cancelling", output_path=job.output_path)
    return export_job_snapshot(job)
