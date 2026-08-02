"""LiteCut preset CRUD and application routes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from ..api_errors import error_detail
from .models import (
    LiteCutPresetCreate,
    LiteCutPresetPatch,
    PresetApplyRequest,
    empty_project,
)
from .preset_apply import apply_preset_to_project
from .projects_api import _preset_asset_warnings
from .runtime import get_lite_cut_db

router = APIRouter(prefix="/api/lite-cut", tags=["lite-cut-presets"])


@router.get("/presets")
async def list_lite_cut_presets(
    kind: str | None = Query(default=None),
    tag: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    items = await get_lite_cut_db().list_presets(
        kind=kind, tag=tag, limit=limit, offset=offset
    )
    return {"items": items, "limit": limit, "offset": offset}


@router.post("/presets")
async def create_lite_cut_preset(body: LiteCutPresetCreate):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, error_detail("LITECUT_PRESET_NAME_REQUIRED"))
    preset_id = await get_lite_cut_db().create_preset(
        name=name,
        kind=body.kind,
        body=body.body,
        tags=body.tags,
        source_project_id=body.source_project_id,
    )
    item = await get_lite_cut_db().get_preset(preset_id)
    if not item:
        raise HTTPException(500, error_detail("LITECUT_PRESET_SAVE_FAILED"))
    return item


@router.get("/presets/{preset_id}")
async def get_lite_cut_preset(preset_id: int):
    item = await get_lite_cut_db().get_preset(preset_id)
    if not item:
        raise HTTPException(404, error_detail("LITECUT_PRESET_NOT_FOUND"))
    return item


@router.patch("/presets/{preset_id}")
async def patch_lite_cut_preset(preset_id: int, body: LiteCutPresetPatch):
    if body.name is None and body.tags is None:
        raise HTTPException(400, error_detail("LITECUT_PRESET_NOTHING_TO_UPDATE"))
    try:
        await get_lite_cut_db().update_preset(
            preset_id,
            name=body.name.strip() if body.name is not None else None,
            tags=body.tags,
        )
    except ValueError as exc:
        if str(exc) == "preset not found":
            raise HTTPException(404, error_detail("LITECUT_PRESET_NOT_FOUND")) from exc
        raise HTTPException(400, error_detail("LITECUT_PRESET_SAVE_FAILED")) from exc
    item = await get_lite_cut_db().get_preset(preset_id)
    if not item:
        raise HTTPException(404, error_detail("LITECUT_PRESET_NOT_FOUND"))
    return item


@router.delete("/presets/{preset_id}")
async def delete_lite_cut_preset(preset_id: int):
    if not await get_lite_cut_db().delete_preset(preset_id):
        raise HTTPException(404, error_detail("LITECUT_PRESET_NOT_FOUND"))
    return {"deleted": True, "id": preset_id}


@router.post("/presets/{preset_id}/apply")
async def apply_lite_cut_preset(preset_id: int, body: PresetApplyRequest):
    preset = await get_lite_cut_db().get_preset(preset_id)
    if not preset:
        raise HTTPException(404, error_detail("LITECUT_PRESET_NOT_FOUND"))

    project_raw: dict[str, Any] | None = None
    if body.project_id is not None:
        project = await get_lite_cut_db().get_project(int(body.project_id))
        if not project:
            raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
        project_raw = (
            project.get("body")
            if isinstance(project.get("body"), dict)
            else empty_project().model_dump()
        )
    elif body.project_body is not None:
        project_raw = body.project_body
    else:
        project_raw = empty_project().model_dump()

    try:
        updated = apply_preset_to_project(
            project_raw,
            str(preset["kind"]),
            preset.get("body") if isinstance(preset.get("body"), dict) else {},
            clip_ids=body.clip_ids,
            scope=body.scope,
            include=body.include or None,
        )
    except ValueError as exc:
        raise HTTPException(
            400,
            error_detail("LITECUT_PRESET_APPLY_FAILED", reason=str(exc)),
        ) from exc

    if body.project_id is not None:
        await get_lite_cut_db().update_project(
            int(body.project_id), body=updated.model_dump(mode="json")
        )
        await get_lite_cut_db().touch_preset_applied(preset_id)

    output_body = updated.model_dump(mode="json")
    return {
        "project_body": output_body,
        "preset_id": preset_id,
        "warnings": _preset_asset_warnings(output_body),
    }
