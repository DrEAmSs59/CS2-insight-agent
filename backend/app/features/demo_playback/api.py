"""HTTP boundary for managed CS2 demo playback."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Annotated, Any, Literal, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from ...api_errors import error_detail
from ...databases import demo_db
from ...demo_cache import ensure_row_cached
from ...demo_paths import UPLOAD_DIR, resolve_working_demo_path
from ...demo_playback_service import (
    DemoPlaybackBusyError,
    DemoPlaybackCs2RunningError,
    DemoPlaybackPovOptions,
    demo_playback_service,
)
from ...env_utils import ensure_cs2_path, load_config
from ...map_material_vpk import MapMaterialVpkError, normalize_map_material_id
from ...pov_hud_manager import PovHudError
from ...skybox_resources import list_skybox_resources
from ...skybox_vpk import SkyboxVpkError, normalize_skybox_id
from ...runtime_session import runtime_session_dependency

logger = logging.getLogger(__name__)
router = APIRouter(tags=["demo-playback"])


class DemoPlaybackPovBody(BaseModel):
    enabled: bool = False
    radar_mode: Literal[-1, 0] = 0
    teamcounter_numeric: bool = False
    skybox_id: str = Field(default="default", max_length=64)


class DemoPlaybackMapMaterialBody(BaseModel):
    id: str = Field(default="default", max_length=64)


class DemoPlaybackOptionsBody(BaseModel):
    pov_hud: DemoPlaybackPovBody = Field(default_factory=DemoPlaybackPovBody)
    map_material: DemoPlaybackMapMaterialBody = Field(
        default_factory=DemoPlaybackMapMaterialBody
    )


class DemoPlayByPathBody(DemoPlaybackOptionsBody):
    path: str = Field(..., min_length=1)


async def resolve_uploaded_demo_path_async(path: str) -> Path:
    return await resolve_working_demo_path(path, demo_db=demo_db, upload_dir=UPLOAD_DIR)


async def _library_working_demo_path(row: dict[str, Any]) -> Path:
    try:
        return await ensure_row_cached(demo_db, row)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc


def launch_cs2_play_demo(
    demo_path: Path,
    options: Optional[DemoPlaybackOptionsBody] = None,
) -> dict[str, Any]:
    """Launch managed direct playback; normal and POV modes require CS2 to be closed."""
    cfg = ensure_cs2_path(load_config())
    if not cfg.cs2_path or not Path(cfg.cs2_path).is_file():
        raise HTTPException(400, error_detail("DEMO_PLAYBACK_CS2_PATH_MISSING"))
    if not demo_path.is_file():
        raise HTTPException(
            422,
            error_detail("DEMO_PLAYBACK_DEMO_NOT_FOUND", path=str(demo_path)),
        )

    body = options or DemoPlaybackOptionsBody()
    pov = body.pov_hud
    try:
        skybox_id = normalize_skybox_id(pov.skybox_id) if pov.enabled else "default"
        map_material_id = (
            normalize_map_material_id(body.map_material.id)
            if pov.enabled
            else "default"
        )
        return demo_playback_service.launch(
            demo_path,
            cfg,
            DemoPlaybackPovOptions(
                enabled=bool(pov.enabled),
                radar_mode=int(pov.radar_mode),
                teamcounter_numeric=bool(pov.teamcounter_numeric),
                skybox_id=skybox_id,
                map_material_id=map_material_id,
            ),
        )
    except SkyboxVpkError as exc:
        raise HTTPException(422, str(exc)) from exc
    except MapMaterialVpkError as exc:
        raise HTTPException(422, str(exc)) from exc
    except DemoPlaybackCs2RunningError as exc:
        raise HTTPException(409, error_detail("DEMO_PLAYBACK_CS2_RUNNING")) from exc
    except DemoPlaybackBusyError as exc:
        raise HTTPException(409, error_detail("DEMO_PLAYBACK_BUSY")) from exc
    except PovHudError as exc:
        raise HTTPException(
            400,
            error_detail("DEMO_PLAYBACK_POV_FAILED", err=str(exc)),
        ) from exc
    except FileNotFoundError as exc:
        raise HTTPException(400, error_detail("DEMO_PLAYBACK_CS2_PATH_MISSING")) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to launch CS2 for direct playback")
        raise HTTPException(
            500,
            error_detail("DEMO_PLAYBACK_LAUNCH_FAILED", err=str(exc)),
        ) from exc


@router.get("/api/demo/playback/preflight")
async def demo_playback_preflight():
    cfg = ensure_cs2_path(load_config())
    result = await asyncio.to_thread(demo_playback_service.preflight, cfg)
    return {
        **result,
        "recording_skybox": str(getattr(cfg, "recording_skybox", "default") or "default"),
        "recording_map_material": str(
            getattr(cfg, "recording_map_material", "default") or "default"
        ),
        "skyboxes": await asyncio.to_thread(list_skybox_resources),
    }


@router.get("/api/demo/playback/status")
async def demo_playback_status(
    session_id: str = Query(..., min_length=1, max_length=128),
):
    return await asyncio.to_thread(demo_playback_service.session_status, session_id)


@router.post("/api/demo/play")
async def play_demo_by_path(
    body: DemoPlayByPathBody,
    _runtime_session: None = Depends(runtime_session_dependency),
):
    demo_path = await resolve_uploaded_demo_path_async(body.path)
    return await asyncio.to_thread(launch_cs2_play_demo, demo_path, body)


@router.post("/api/demos/{demo_id}/play")
async def play_demo_in_cs2(
    demo_id: int,
    body: Annotated[Optional[DemoPlaybackOptionsBody], Body()] = None,
    _runtime_session: None = Depends(runtime_session_dependency),
):
    row = await demo_db.get_demo_by_id(demo_id)
    if not row:
        raise HTTPException(404, f"Demo not found: {demo_id}")

    demo_path = await _library_working_demo_path(row)
    if not demo_path.is_file():
        raise HTTPException(422, "Demo 文件不存在于磁盘，无法播放。")
    return await asyncio.to_thread(launch_cs2_play_demo, demo_path, body)
