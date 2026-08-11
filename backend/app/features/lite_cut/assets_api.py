"""LiteCut asset validation, upload, metadata, streaming and deletion routes."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ...api_errors import error_detail
from .asset_executor import (
    attach_video_facts as _attach_video_fps,
    build_asset_waveform,
    probe_asset_metadata,
    quarantine_asset_files,
    save_and_probe_upload,
)
from .proxy_api import (
    _decorate_asset_preview_state,
    _preview_proxy_job_snapshot,
    _start_preview_proxy_job,
    _stop_preview_proxy_job,
)
from .dependencies import build_lite_cut_services
from .service_http import service_call
from .runtime import (
    get_lite_cut_db,
    get_montage_db,
    normalize_project_body,
)

router = APIRouter(prefix="/api/lite-cut", tags=["lite-cut-assets"])
logger = logging.getLogger(__name__)


def _services():
    return build_lite_cut_services(get_lite_cut_db())


class LiteCutAssetValidationBody(BaseModel):
    body: dict[str, Any]


@router.post("/assets/validate")
async def validate_lite_cut_assets(body: LiteCutAssetValidationBody):
    """Report media references that cannot be resolved on this machine."""
    from .timeline import _missing_file_assets_for_export, _recorded_source_ids_for_export

    project_body = normalize_project_body(body.body)
    missing = _missing_file_assets_for_export(project_body)
    source_ids = _recorded_source_ids_for_export(project_body)
    if source_ids:
        rows = await get_montage_db().get_recorded_clips_by_ids(source_ids)
        for source_id in source_ids:
            row = rows.get(source_id)
            raw_path = str(row.get("output_path") or "").strip() if row else ""
            path = Path(raw_path).expanduser() if raw_path else None
            if row is None or path is None or not path.is_file():
                missing.append(
                    {
                        "kind": "recording",
                        "name": path.name if path else f"Insight recording #{source_id}",
                        "path": raw_path,
                        "source_id": source_id,
                    }
                )
    return {"items": missing}

@router.get("/assets")
async def list_lite_cut_assets(
    project_id: int | None = Query(default=None),
    limit: int = Query(default=500, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    services = _services()
    result = await service_call(services.assets.list(project_id=project_id, limit=limit, offset=offset))
    items = result["items"]
    from .assets import probe_image_dimensions
    for item in items:
        if item.get("kind") != "image" or (item.get("width") and item.get("height")):
            continue
        dimensions = await asyncio.to_thread(probe_image_dimensions, Path(str(item.get("file_path") or "")))
        if dimensions:
            item["width"], item["height"] = dimensions
            await services.assets.update_dimensions(int(item["id"]), *dimensions)
    items = await _attach_video_fps(items)
    for item in items:
        _decorate_asset_preview_state(
            item,
            has_alpha=item.get("has_alpha"),
            video_codec=item.get("codec_name"),
            audio_codec=item.get("audio_codec_name"),
            pixel_format=item.get("pixel_format"),
            source_fps=item.get("fps"),
        )
    return {"items": items, "limit": limit, "offset": offset}


@router.post("/assets/upload")
async def upload_lite_cut_asset(
    file: UploadFile = File(...),
    project_id: int | None = Query(default=None),
    client_duration_sec: float | None = Query(default=None, ge=0),
):
    from pathlib import Path

    from .assets import stable_project_asset_directory

    project = None
    if project_id is not None:
        proj = await _services().projects.get(int(project_id))
        if not proj:
            raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
        project = proj

    destination_dir = None
    if project is not None and project_id is not None:
        existing_assets = await _services().assets.list_for_project(int(project_id))
        destination_dir = stable_project_asset_directory(
            int(project_id),
            str(project.get("name") or "未命名工程"),
            [str(item.get("file_path") or "") for item in existing_assets],
        )
    dest, kind, mime, duration_sec, media_info = await save_and_probe_upload(
        file,
        project_name=project.get("name") if project else None,
        destination_dir=destination_dir,
        client_duration_sec=client_duration_sec,
    )
    item = await service_call(_services().assets.create(
        name=Path(file.filename or dest.name).name,
        kind=kind,
        file_path=str(dest),
        mime_type=mime or None,
        duration_sec=duration_sec,
        width=int(media_info.get("width") or 0) or None,
        height=int(media_info.get("height") or 0) or None,
        project_id=int(project_id) if project_id is not None else None,
    ))
    alpha_hint = bool(media_info.get("has_alpha")) if "has_alpha" in media_info else None
    return _decorate_asset_preview_state(
        {**item, "fps": media_info.get("fps") if kind in {"video", "webm"} else None},
        has_alpha=alpha_hint,
        video_codec=str(media_info.get("codec_name") or "") or None,
        audio_codec=str(media_info.get("audio_codec_name") or ""),
        pixel_format=str(media_info.get("pixel_format") or ""),
        source_fps=media_info.get("fps"),
    )


@router.get("/assets/{asset_id}/metadata")
async def get_lite_cut_asset_metadata(asset_id: int):
    """Return source-media facts used by the inspector's read-only summary."""
    row = await service_call(_services().assets.get(int(asset_id)))

    return await probe_asset_metadata(row)


@router.get("/assets/{asset_id}/waveform")
async def get_lite_cut_asset_waveform(
    asset_id: int,
    buckets: int = Query(default=72, ge=8, le=512),
    start_sec: float = Query(default=0, ge=0),
    end_sec: float | None = Query(default=None, ge=0),
):
    row = await service_call(_services().assets.get(int(asset_id)))
    try:
        return await build_asset_waveform(
            row,
            buckets=buckets,
            start_sec=start_sec,
            end_sec=end_sec,
        )
    except Exception as exc:
        logger.warning("LiteCut waveform generation failed for asset %s", asset_id, exc_info=True)
        raise HTTPException(422, str(exc) or "无法生成素材波形") from exc


@router.get("/fonts/{font_name}")
async def stream_lite_cut_builtin_font(font_name: str):
    allowed = {
        "Rajdhani-Bold.ttf": "Rajdhani-Bold.ttf",
        "Rajdhani-SemiBold.ttf": "Rajdhani-SemiBold.ttf",
        "NotoSansSC-Bold.ttf": "NotoSansSC-Bold.ttf",
        "NotoSansSC-Medium.ttf": "NotoSansSC-Medium.ttf",
    }
    safe_name = allowed.get(font_name)
    if not safe_name:
        raise HTTPException(404, "font not found")
    path = Path(__file__).resolve().parents[3] / "assets" / "fonts" / safe_name
    return FileResponse(path, media_type="font/ttf", filename=safe_name)


@router.get("/assets/{asset_id}/stream")
async def stream_lite_cut_asset(asset_id: int, request: Request):
    from .assets import asset_stream_path, validate_stored_asset_path
    from .stream import stream_file_with_range

    row = await service_call(_services().assets.get(int(asset_id)))
    path = validate_stored_asset_path(str(row["file_path"]))
    if str(row.get("kind") or "").lower() == "font":
        font_mime = {
            ".ttf": "font/ttf",
            ".otf": "font/otf",
            ".woff": "font/woff",
            ".woff2": "font/woff2",
        }.get(path.suffix.lower(), "application/font-sfnt")
        return FileResponse(path, media_type=font_mime, headers={"Cache-Control": "no-cache"})
    state = _decorate_asset_preview_state(row)
    if state.get("preview_proxy_required") and state.get("preview_proxy_status") != "ready":
        status = str(state.get("preview_proxy_status") or "queued")
        if status in {"failed", "missing"}:
            raise HTTPException(422, state.get("preview_proxy_error") or "预览代理生成失败")
        # Never pin a video request to a minutes-long FFmpeg job. The editor
        # polls asset state and replaces the cache-busted URL when ready.
        raise HTTPException(425, "预览代理正在后台生成", headers={"Retry-After": "1"})
    return await stream_file_with_range(
        asset_stream_path(path, duration_sec=row.get("duration_sec")),
        request,
    )


@router.post("/assets/{asset_id}/proxy/retry")
async def retry_lite_cut_asset_preview_proxy(asset_id: int):
    row = await service_call(_services().assets.get(int(asset_id)))
    state = _decorate_asset_preview_state(dict(row), schedule=False)
    if not state.get("preview_proxy_required"):
        return state
    await _stop_preview_proxy_job(int(asset_id))
    job = _start_preview_proxy_job(row, force=True)
    row.update(_preview_proxy_job_snapshot(job))
    return row


@router.delete("/assets/{asset_id}")
async def delete_lite_cut_asset(asset_id: int):
    row = await service_call(_services().assets.get(int(asset_id)))
    await _stop_preview_proxy_job(int(asset_id))
    try:
        quarantined = await quarantine_asset_files(row)
    except OSError as exc:
        raise HTTPException(409, f"Asset files could not be moved to the recovery area: {exc}") from exc
    try:
        await service_call(_services().assets.delete_record(int(asset_id)))
    except Exception:
        await asyncio.to_thread(quarantined.restore)
        raise
    return {
        "deleted": True,
        "id": asset_id,
        "recovery_directory": str(quarantined.directory) if quarantined.files else None,
    }
