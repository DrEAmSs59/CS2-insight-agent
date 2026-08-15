"""Montage export history CRUD routes."""

from __future__ import annotations

import os

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..databases import montage_db
from ..montage_export_runtime import montage_export_job_snapshot, montage_export_jobs

router = APIRouter(tags=["montage-exports"])


@router.get("/api/montage/exports")
async def list_montage_exports(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    status: str | None = Query(None),
):
    items, total = await montage_db.list_exports(limit=limit, offset=offset, status=status or None)
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.get("/api/montage/exports/{export_id}")
async def get_montage_export(export_id: int):
    job = montage_export_jobs.get(int(export_id))
    if job is not None:
        return montage_export_job_snapshot(job)
    row = await montage_db.get_export(export_id)
    if not row:
        raise HTTPException(404, "导出记录不存在")
    return row


@router.post("/api/montage/exports/{export_id}/cancel")
async def cancel_montage_export(export_id: int):
    job = montage_export_jobs.get(int(export_id))
    if job is None:
        row = await montage_db.get_export(export_id)
        if not row:
            raise HTTPException(404, "导出记录不存在")
        raise HTTPException(409, "导出任务已不在运行")
    if job.status in {"done", "error", "cancelled"}:
        return montage_export_job_snapshot(job)
    job.cancel_event.set()
    job.status = "cancelling"
    job.stage = "cancelling"
    await montage_db.update_export(
        job.export_id,
        status="cancelling",
        output_path=job.output_path,
    )
    return montage_export_job_snapshot(job)


class RenameExportBody(BaseModel):
    name: str = Field(..., max_length=200)


@router.patch("/api/montage/exports/{export_id}")
async def rename_montage_export(export_id: int, body: RenameExportBody):
    await montage_db.rename_export(export_id, body.name)
    return {"ok": True}


@router.delete("/api/montage/exports/{export_id}")
async def delete_montage_export(
    export_id: int,
    delete_file: bool = Query(False),
):
    job = montage_export_jobs.get(int(export_id))
    if job is not None and job.status in {"queued", "running", "cancelling"}:
        raise HTTPException(409, "导出任务仍在运行，完成后才能删除")
    output_path = await montage_db.delete_export(export_id)
    if output_path is None:
        raise HTTPException(404, "导出记录不存在")
    file_deleted = False
    if delete_file and output_path:
        try:
            os.remove(output_path)
            file_deleted = True
        except FileNotFoundError:
            file_deleted = False
        except OSError as e:
            raise HTTPException(400, f"文件删除失败：{e}") from e
    montage_export_jobs.pop(int(export_id), None)
    return {"ok": True, "file_deleted": file_deleted}


class BatchDeleteExportsBody(BaseModel):
    ids: list[int] = Field(..., min_length=1)
    delete_files: bool = False


@router.post("/api/montage/exports/batch-delete")
async def batch_delete_montage_exports(body: BatchDeleteExportsBody):
    active_ids = [
        int(export_id)
        for export_id in body.ids
        if montage_export_jobs.get(int(export_id)) is not None
        and montage_export_jobs[int(export_id)].status in {"queued", "running", "cancelling"}
    ]
    if active_ids:
        raise HTTPException(409, "选中的导出任务仍在运行，完成后才能删除")
    paths = await montage_db.delete_exports_batch(body.ids)
    file_results: dict[str, str] = {}
    if body.delete_files:
        for p in paths:
            if not p:
                continue
            try:
                os.remove(p)
                file_results[p] = "deleted"
            except FileNotFoundError:
                file_results[p] = "not_found"
            except OSError as e:
                file_results[p] = f"error: {e}"
    for export_id in body.ids:
        montage_export_jobs.pop(int(export_id), None)
    return {"ok": True, "deleted_count": len(paths), "file_results": file_results}
