"""LiteCut project CRUD, snapshots and recovery-aware deletion routes."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..api_errors import error_detail
from ..file_quarantine import QuarantineBatch, quarantine_files
from .models import LiteCutProjectCreate, LiteCutProjectPatch
from .proxy_api import _stop_preview_proxy_job
from .runtime import get_lite_cut_db, normalize_project_body

router = APIRouter(prefix="/api/lite-cut", tags=["lite-cut-projects"])


def _preset_asset_warnings(project_body: dict[str, Any]) -> list[dict[str, str]]:
    warnings: list[dict[str, str]] = []
    audio = project_body.get("audio") if isinstance(project_body.get("audio"), dict) else {}
    bgm = audio.get("bgm") if isinstance(audio.get("bgm"), dict) else None
    bgm_path = str(bgm.get("path") or "").strip() if bgm else ""
    if bgm_path and not Path(bgm_path).expanduser().is_file():
        warnings.append({"kind": "bgm", "path": bgm_path, "message": "BGM file is unavailable. Select a replacement in the Audio panel."})
    for overlay in project_body.get("overlays") or []:
        if not isinstance(overlay, dict):
            continue
        text = overlay.get("text") if isinstance(overlay.get("text"), dict) else {}
        font_path = str(text.get("font_file") or "").strip()
        if font_path and not Path(font_path).expanduser().is_file():
            warnings.append({"kind": "font", "path": font_path, "message": "Font file is unavailable. Select a replacement in the Text panel."})
    return warnings


async def _delete_project_asset_files(project_id: int) -> None:
    from .assets import delete_asset_file_bundle

    assets = await get_lite_cut_db().list_project_assets(project_id)
    for asset in assets:
        await _stop_preview_proxy_job(int(asset["id"]))
    await asyncio.gather(*[
        asyncio.to_thread(delete_asset_file_bundle, str(asset.get("file_path") or ""))
        for asset in assets
        if asset.get("file_path")
    ])


async def _quarantine_project_asset_files(project_ids: list[int]) -> QuarantineBatch:
    from .assets import asset_file_bundle_paths

    assets: list[dict[str, Any]] = []
    for project_id in project_ids:
        assets.extend(await get_lite_cut_db().list_project_assets(project_id))
    for asset in assets:
        await _stop_preview_proxy_job(int(asset["id"]))
    bundle_paths: list[Path] = []
    for asset in assets:
        raw_path = str(asset.get("file_path") or "")
        if raw_path:
            bundle_paths.extend(await asyncio.to_thread(asset_file_bundle_paths, raw_path))
    return await asyncio.to_thread(quarantine_files, bundle_paths, "lite-cut")


@router.get("/projects")
async def list_lite_cut_projects(
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    items = await get_lite_cut_db().list_projects(limit=limit, offset=offset)
    return {"items": items, "limit": limit, "offset": offset}


@router.post("/projects")
async def create_lite_cut_project(body: LiteCutProjectCreate):
    project_body = normalize_project_body(body.body)
    pid = await get_lite_cut_db().create_project(name=body.name.strip(), body=project_body)
    item = await get_lite_cut_db().get_project(pid)
    if not item:
        raise HTTPException(500, error_detail("LITECUT_PROJECT_SAVE_FAILED"))
    return item


@router.get("/projects/{project_id}")
async def get_lite_cut_project(project_id: int):
    item = await get_lite_cut_db().get_project(project_id)
    if not item:
        raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
    return item


@router.patch("/projects/{project_id}")
async def patch_lite_cut_project(project_id: int, body: LiteCutProjectPatch):
    if body.name is None and body.body is None:
        raise HTTPException(400, error_detail("LITECUT_PROJECT_NOTHING_TO_UPDATE"))
    previous = await get_lite_cut_db().get_project(project_id)
    if not previous:
        raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
    try:
        if body.body is not None:
            normalized = normalize_project_body(body.body)
            # A snapshot is intentionally written before the project row so a
            # completed autosave always has a matching recovery point.
            await get_lite_cut_db().create_project_snapshot(
                project_id,
                name=body.name.strip() if body.name is not None else str(previous.get("name") or ""),
                body=normalized,
                reason="save",
            )
            await get_lite_cut_db().update_project(
                project_id,
                name=body.name.strip() if body.name is not None else None,
                body=normalized,
            )
        elif body.name is not None:
            await get_lite_cut_db().update_project(project_id, name=body.name.strip())
    except ValueError as e:
        if str(e) == "project not found":
            raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND")) from e
        raise HTTPException(400, error_detail("LITECUT_PROJECT_SAVE_FAILED")) from e
    item = await get_lite_cut_db().get_project(project_id)
    if not item:
        raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
    return item


@router.get("/projects/{project_id}/snapshots")
async def list_lite_cut_project_snapshots(project_id: int):
    if not await get_lite_cut_db().get_project(project_id):
        raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
    return {"items": await get_lite_cut_db().list_project_snapshots(project_id)}


@router.post("/projects/{project_id}/snapshots/{snapshot_id}/restore")
async def restore_lite_cut_project_snapshot(project_id: int, snapshot_id: int):
    current = await get_lite_cut_db().get_project(project_id)
    if not current:
        raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
    snapshot = await get_lite_cut_db().get_project_snapshot(project_id, snapshot_id)
    if not snapshot:
        raise HTTPException(404, "snapshot not found")
    # Preserve the state being replaced as a separate rollback point.
    await get_lite_cut_db().create_project_snapshot(
        project_id, name=str(current.get("name") or ""), body=current["body"], reason="before_restore"
    )
    restored = normalize_project_body(snapshot["body"])
    await get_lite_cut_db().update_project(project_id, body=restored)
    item = await get_lite_cut_db().get_project(project_id)
    if not item:
        raise HTTPException(500, error_detail("LITECUT_PROJECT_SAVE_FAILED"))
    return item

@router.delete("/projects/{project_id}")
async def delete_lite_cut_project(project_id: int):
    if not await get_lite_cut_db().get_project(project_id):
        raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
    try:
        quarantined = await _quarantine_project_asset_files([project_id])
    except OSError as exc:
        raise HTTPException(409, f"Project assets could not be moved to the recovery area: {exc}") from exc
    try:
        ok = await get_lite_cut_db().delete_project(project_id)
        if not ok:
            raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
    except Exception:
        await asyncio.to_thread(quarantined.restore)
        raise
    return {
        "deleted": True,
        "id": project_id,
        "recovery_directory": str(quarantined.directory) if quarantined.files else None,
    }


class LiteCutProjectBatchDeleteBody(BaseModel):
    ids: list[int]


@router.post("/projects/batch-delete")
async def batch_delete_lite_cut_projects(body: LiteCutProjectBatchDeleteBody):
    ids = sorted({int(value) for value in body.ids if int(value) > 0})
    if not ids or len(ids) > 500:
        raise HTTPException(400, "project ids must contain 1 to 500 items")
    try:
        quarantined = await _quarantine_project_asset_files(ids)
    except OSError as exc:
        raise HTTPException(409, f"Project assets could not be moved to the recovery area: {exc}") from exc
    try:
        deleted_ids = await get_lite_cut_db().delete_projects(ids)
    except Exception:
        await asyncio.to_thread(quarantined.restore)
        raise
    return {
        "deleted": len(deleted_ids),
        "ids": deleted_ids,
        "recovery_directory": str(quarantined.directory) if quarantined.files else None,
    }
