"""LiteCut export preflight and render-process executor boundary."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from ...api_errors import error_detail
from ...env_utils import load_config
from ...montage_errors import montage_detail_from_exception
from ...video_composer import MontageComposerError, resolve_ffmpeg_binary
from .export_plan import build_lite_cut_export_plan
from .export_preflight import (
    ensure_ffmpeg_runnable,
    ensure_files_readable,
    ensure_output_space,
    estimate_required_space,
    project_file_paths,
    remove_partial_output,
    unique_output_path,
)
from .runtime import normalize_project_body
from .timeline import _timeline_overlap_pair


async def prepare_export(
    body,
    *,
    projects,
    montage_db,
    active_jobs,
    resolve_encoder,
) -> dict[str, Any]:
    cfg = load_config()
    try:
        ffmpeg_bin = resolve_ffmpeg_binary(cfg.ffmpeg_path)
    except MontageComposerError as exc:
        raise HTTPException(400, montage_detail_from_exception(exc)) from exc

    project_body: dict[str, Any] | None = None
    if body.project_id is not None:
        project = await projects.get(int(body.project_id))
        if not project:
            raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
        project_body = project.get("body") if isinstance(project.get("body"), dict) else None
    elif body.body is not None:
        project_body = body.body
    if not project_body:
        raise HTTPException(400, error_detail("LITECUT_EXPORT_NO_BODY"))
    project_body = normalize_project_body(project_body)

    export_plan = build_lite_cut_export_plan(project_body)
    clips = list(export_plan.base_clips)
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

    source_ids = list(export_plan.recorded_source_ids)
    rows = await montage_db.get_recorded_clips_by_ids(source_ids) if source_ids else {}
    clip_paths: dict[int, Path] = {}
    for source_id in source_ids:
        row = rows.get(source_id)
        if not row:
            raise HTTPException(400, error_detail("MONTAGE_CLIP_NOT_FOUND", id=str(source_id)))
        clip_paths[source_id] = Path(str(row["output_path"]))

    requested_encoder = resolve_encoder(project_body, cfg.montage_encoder)
    reserved_paths = [
        job.output_path
        for job in active_jobs.values()
        if job.status in {"queued", "running", "cancelling"} and job.output_path
    ]
    try:
        output_path = await asyncio.to_thread(unique_output_path, body.output_path, reserved=reserved_paths)
        await asyncio.to_thread(ensure_ffmpeg_runnable, ffmpeg_bin)
        source_paths = project_file_paths(project_body, clip_paths.values())
        source_bytes = await asyncio.to_thread(ensure_files_readable, source_paths)
        required_bytes = estimate_required_space(project_body, source_bytes)
        await asyncio.to_thread(ensure_output_space, output_path, required_bytes)
    except MontageComposerError as exc:
        raise HTTPException(400, montage_detail_from_exception(exc)) from exc

    return {
        "ffmpeg_bin": ffmpeg_bin,
        "project_body": project_body,
        "clip_paths": clip_paths,
        "output_path": str(output_path),
        "montage_encoder": requested_encoder,
    }


async def execute_prepared_export(
    prepared: dict[str, Any],
    *,
    progress_callback=None,
    cancel_event=None,
) -> Path:
    from .render_pipeline import export_lite_cut_project

    return await asyncio.to_thread(
        export_lite_cut_project,
        ffmpeg_bin=prepared["ffmpeg_bin"],
        project_body=prepared["project_body"],
        clip_path_by_id=prepared["clip_paths"],
        output_path_str=prepared["output_path"],
        montage_encoder=prepared["montage_encoder"],
        progress_callback=progress_callback,
        cancel_event=cancel_event,
    )


async def remove_partial_export(output_path: str) -> None:
    await asyncio.to_thread(remove_partial_output, output_path)
