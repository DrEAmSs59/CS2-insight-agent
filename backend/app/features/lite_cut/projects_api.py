"""Thin HTTP routes for LiteCut project use cases."""

from __future__ import annotations

from fastapi import APIRouter, Query
from pydantic import BaseModel

from .models import LiteCutProjectCreate, LiteCutProjectPatch
from .proxy_api import _stop_preview_proxy_job
from .repositories import DbProjectRepository
from .runtime import get_lite_cut_db
from .service_http import service_call
from .services import ProjectAssetStorage, ProjectService, preset_asset_warnings

router = APIRouter(prefix="/api/lite-cut", tags=["lite-cut-projects"])


def _project_service() -> ProjectService:
    projects = DbProjectRepository(get_lite_cut_db())
    return ProjectService(projects, ProjectAssetStorage(projects, _stop_preview_proxy_job))


# Compatibility facades for portable import and existing backend tests.
_preset_asset_warnings = preset_asset_warnings


async def _delete_project_asset_files(project_id: int) -> None:
    projects = DbProjectRepository(get_lite_cut_db())
    await ProjectAssetStorage(projects, _stop_preview_proxy_job).delete(project_id)


async def _quarantine_project_asset_files(project_ids: list[int]):
    projects = DbProjectRepository(get_lite_cut_db())
    return await ProjectAssetStorage(projects, _stop_preview_proxy_job).quarantine(project_ids)


@router.get("/projects")
async def list_lite_cut_projects(
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    return await service_call(_project_service().list(limit=limit, offset=offset))


@router.post("/projects")
async def create_lite_cut_project(body: LiteCutProjectCreate):
    return await service_call(_project_service().create(name=body.name, body=body.body))


@router.get("/projects/{project_id}")
async def get_lite_cut_project(project_id: int):
    return await service_call(_project_service().get(project_id))


@router.patch("/projects/{project_id}")
async def patch_lite_cut_project(project_id: int, body: LiteCutProjectPatch):
    return await service_call(_project_service().patch(project_id, name=body.name, body=body.body))


@router.get("/projects/{project_id}/snapshots")
async def list_lite_cut_project_snapshots(project_id: int):
    return await service_call(_project_service().list_snapshots(project_id))


@router.post("/projects/{project_id}/snapshots/{snapshot_id}/restore")
async def restore_lite_cut_project_snapshot(project_id: int, snapshot_id: int):
    return await service_call(_project_service().restore_snapshot(project_id, snapshot_id))


@router.delete("/projects/{project_id}")
async def delete_lite_cut_project(project_id: int):
    return await service_call(_project_service().delete(project_id))


class LiteCutProjectBatchDeleteBody(BaseModel):
    ids: list[int]


@router.post("/projects/batch-delete")
async def batch_delete_lite_cut_projects(body: LiteCutProjectBatchDeleteBody):
    return await service_call(_project_service().delete_many(body.ids))
