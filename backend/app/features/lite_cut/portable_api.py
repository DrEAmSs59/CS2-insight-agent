"""LiteCut portable project HTTP routes.

Archive and filesystem work is owned by portable_executor; these handlers only
translate HTTP inputs and responses.
"""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ...env_utils import get_data_dir
from .dependencies import build_lite_cut_services
from .portable_executor import (
    _body_file_paths,
    _link_portable_clip_assets,
    _portable_package_path,
    _portable_package_snapshot,
    _replace_portable_references,
    _run_portable_package,
    import_portable_package,
    resolve_package_destination,
    rollback_portable_import,
)
from .projects_api import _delete_project_asset_files
from .runtime import LiteCutPortablePackageJob, get_lite_cut_db, portable_package_jobs
from .service_http import service_call

router = APIRouter(prefix="/api/lite-cut", tags=["lite-cut-portable"])


def _services():
    return build_lite_cut_services(get_lite_cut_db())


class LiteCutPortablePackageStartBody(BaseModel):
    destination: str = Field(default="", max_length=2048)


@router.post("/projects/{project_id}/portable-package/start")
async def start_lite_cut_portable_package(project_id: int, body: LiteCutPortablePackageStartBody):
    project, assets = await service_call(_services().portable.package_inputs(project_id))
    try:
        destination = resolve_package_destination(body.destination)
    except OSError as exc:
        raise HTTPException(400, f"导出位置不可用：{exc}") from exc
    safe_name = "".join(
        ch if ch.isalnum() or ch in "-_" else "-"
        for ch in str(project.get("name") or "LiteCut")
    )[:80] or "LiteCut"
    job = LiteCutPortablePackageJob(
        job_id=uuid.uuid4().hex,
        project_id=project_id,
        filename=f"{safe_name}.litecut.zip",
        destination=destination,
    )
    portable_package_jobs[job.job_id] = job
    job.task = asyncio.create_task(asyncio.to_thread(_run_portable_package, job, project, assets))
    return _portable_package_snapshot(job)


@router.get("/portable-package/jobs/{job_id}")
async def get_lite_cut_portable_package_job(job_id: str):
    job = portable_package_jobs.get(str(job_id))
    if not job:
        raise HTTPException(404, "便携工程包任务不存在或已过期")
    return _portable_package_snapshot(job)


@router.delete("/portable-package/jobs/{job_id}")
async def cancel_lite_cut_portable_package_job(job_id: str):
    job = portable_package_jobs.get(str(job_id))
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
    job = portable_package_jobs.get(str(job_id))
    if not job:
        raise HTTPException(404, "便携工程包任务不存在或已过期")
    if job.status != "done" or not job.package_path:
        raise HTTPException(409, "便携工程包尚未准备完成")
    return FileResponse(job.package_path, media_type="application/zip", filename=job.filename)


@router.get("/projects/{project_id}/portable-package")
async def download_lite_cut_portable_package(project_id: int):
    project, assets = await service_call(_services().portable.package_inputs(project_id))
    package = await asyncio.to_thread(_portable_package_path, project, assets)
    filename = f"{str(project.get('name') or 'LiteCut').strip() or 'LiteCut'}.litecut.zip"
    return FileResponse(package, media_type="application/zip", filename=filename)


async def _rollback_portable_import(project_id: int | None, destination: Path | None) -> None:
    await rollback_portable_import(
        project_id,
        destination,
        services=_services(),
        delete_project_asset_files=_delete_project_asset_files,
    )


@router.post("/projects/portable-import")
async def import_lite_cut_portable_package(file: UploadFile = File(...)):
    return await import_portable_package(
        file,
        services=_services(),
        data_dir=get_data_dir(),
        delete_project_asset_files=_delete_project_asset_files,
    )
