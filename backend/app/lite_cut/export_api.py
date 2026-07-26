"""LiteCut export preparation, execution and job-history routes."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..api_errors import error_detail
from ..env_utils import load_config
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


class LiteCutExportBody(BaseModel):
    project_id: int | None = None
    body: dict[str, Any] | None = None
    output_path: str

async def _prepare_lite_cut_export(body: LiteCutExportBody) -> dict[str, Any]:
    from ..env_utils import load_config
    from ..montage_errors import montage_detail_from_exception
    from ..video_composer import MontageComposerError, resolve_ffmpeg_binary
    from .timeline import _main_video_clips_sorted, _recorded_source_ids_for_export, _timeline_overlap_pair
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
        proj = await get_lite_cut_db().get_project(int(body.project_id))
        if not proj:
            raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
        project_body = proj.get("body") if isinstance(proj.get("body"), dict) else None
    elif body.body is not None:
        project_body = body.body

    if not project_body:
        raise HTTPException(400, error_detail("LITECUT_EXPORT_NO_BODY"))
    # Direct export bodies and stored projects pass through the same schema
    # boundary so malformed numbers/IDs cannot bypass create/update validation.
    project_body = normalize_project_body(project_body)

    clips = _main_video_clips_sorted(project_body)
    if not clips:
        raise HTTPException(400, error_detail("MONTAGE_NO_CLIPS"))
    overlap = _timeline_overlap_pair(clips)
    if overlap is not None:
        raise HTTPException(
            422,
            error_detail(
                "LITECUT_TIMELINE_OVERLAP",
                previous_clip_id=overlap[0],
                clip_id=overlap[1],
            ),
        )

    source_ids = _recorded_source_ids_for_export(project_body)
    rows = await get_montage_db().get_recorded_clips_by_ids(source_ids) if source_ids else {}
    clip_paths: dict[int, Path] = {}
    for sid in source_ids:
        row = rows.get(sid)
        if not row:
            raise HTTPException(400, error_detail("MONTAGE_CLIP_NOT_FOUND", id=str(sid)))
        clip_paths[sid] = Path(str(row["output_path"]))

    requested_encoder = resolve_lite_cut_encoder(project_body, cfg.montage_encoder)
    reserved_paths = [
        job.output_path
        for job in export_jobs.values()
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
    from .render_pipeline import export_lite_cut_project
    from .export_preflight import remove_partial_output, validate_export_output

    db = get_lite_cut_db()
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
    from .render_pipeline import export_lite_cut_project
    from .export_preflight import remove_partial_output, validate_export_output

    prepared = await _prepare_lite_cut_export(body)
    if body.project_id is not None:
        project = await get_lite_cut_db().get_project(int(body.project_id))
        if project:
            await get_lite_cut_db().create_project_snapshot(
                int(body.project_id), name=str(project.get("name") or ""), body=prepared["project_body"], reason="before_export"
            )
    export_id = await get_lite_cut_db().create_export(
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
        await get_lite_cut_db().update_export(
            export_id, status="error", error_msg=str(detail.get("code") or "MONTAGE_EXPORT_FAILED")
        )
        raise HTTPException(400, detail) from e

    await get_lite_cut_db().update_export(export_id, status="done", error_msg="", output_path=str(out))
    return {"export_id": export_id, "status": "done", "output_path": str(out)}


@router.post("/export/start")
async def start_lite_cut_export(body: LiteCutExportBody):
    prepared = await _prepare_lite_cut_export(body)
    if body.project_id is not None:
        project = await get_lite_cut_db().get_project(int(body.project_id))
        if project:
            await get_lite_cut_db().create_project_snapshot(
                int(body.project_id), name=str(project.get("name") or ""), body=prepared["project_body"], reason="before_export"
            )
    export_id = await get_lite_cut_db().create_export(
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
    export_jobs[export_id] = job
    job.task = asyncio.create_task(_run_lite_cut_export_job(job, prepared))
    return export_job_snapshot(job)


@router.get("/exports")
async def list_lite_cut_exports(
    project_id: int | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
):
    rows = await get_lite_cut_db().list_exports(project_id=project_id, limit=limit, offset=offset)
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
    row = await get_lite_cut_db().get_export(int(export_id))
    if not row:
        raise HTTPException(404, error_detail("LITECUT_EXPORT_NOT_FOUND"))
    return export_row_snapshot(row)


@router.post("/exports/{export_id}/cancel")
async def cancel_lite_cut_export(export_id: int):
    job = export_jobs.get(int(export_id))
    if not job:
        row = await get_lite_cut_db().get_export(int(export_id))
        if not row:
            raise HTTPException(404, error_detail("LITECUT_EXPORT_NOT_FOUND"))
        raise HTTPException(409, error_detail("LITECUT_EXPORT_NOT_ACTIVE"))
    if job.status in {"done", "error", "cancelled"}:
        return export_job_snapshot(job)
    job.cancel_event.set()
    job.status = "cancelling"
    job.stage = "cancelling"
    await get_lite_cut_db().update_export(job.export_id, status="cancelling", output_path=job.output_path)
    return export_job_snapshot(job)
