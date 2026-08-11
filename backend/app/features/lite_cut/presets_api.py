"""Thin HTTP routes for LiteCut preset use cases."""

from __future__ import annotations

from fastapi import APIRouter, Query

from .models import LiteCutPresetCreate, LiteCutPresetPatch, PresetApplyRequest
from .repositories import DbPresetRepository, DbProjectRepository
from .runtime import get_lite_cut_db
from .service_http import service_call
from .services import PresetService

router = APIRouter(prefix="/api/lite-cut", tags=["lite-cut-presets"])


def _preset_service() -> PresetService:
    db = get_lite_cut_db()
    return PresetService(DbPresetRepository(db), DbProjectRepository(db))


@router.get("/presets")
async def list_lite_cut_presets(
    kind: str | None = Query(default=None),
    tag: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    return await service_call(_preset_service().list(kind=kind, tag=tag, limit=limit, offset=offset))


@router.post("/presets")
async def create_lite_cut_preset(body: LiteCutPresetCreate):
    return await service_call(_preset_service().create(body))


@router.get("/presets/{preset_id}")
async def get_lite_cut_preset(preset_id: int):
    return await service_call(_preset_service().get(preset_id))


@router.patch("/presets/{preset_id}")
async def patch_lite_cut_preset(preset_id: int, body: LiteCutPresetPatch):
    return await service_call(_preset_service().patch(preset_id, body))


@router.delete("/presets/{preset_id}")
async def delete_lite_cut_preset(preset_id: int):
    return await service_call(_preset_service().delete(preset_id))


@router.post("/presets/{preset_id}/apply")
async def apply_lite_cut_preset(preset_id: int, body: PresetApplyRequest):
    return await service_call(_preset_service().apply(preset_id, body))
