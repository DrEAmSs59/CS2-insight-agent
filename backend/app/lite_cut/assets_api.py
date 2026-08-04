"""LiteCut asset validation, upload, metadata, streaming and deletion routes."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..api_errors import error_detail
from ..env_utils import load_config
from ..file_quarantine import quarantine_files
from .proxy_api import (
    _decorate_asset_preview_state,
    _preview_proxy_job_snapshot,
    _start_preview_proxy_job,
    _stop_preview_proxy_job,
)
from .runtime import (
    get_lite_cut_db,
    get_montage_db,
    normalize_project_body,
)

router = APIRouter(prefix="/api/lite-cut", tags=["lite-cut-assets"])
logger = logging.getLogger(__name__)


async def _attach_video_fps(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Add source FPS to video assets for the media bin and export checks."""
    video_items = [item for item in items if str(item.get("kind") or "").lower() in {"video", "webm"}]
    if not video_items:
        return items
    try:
        from ..video_composer import probe_video_audio_summary, resolve_ffmpeg_binary, resolve_ffprobe_binary

        ffprobe = resolve_ffprobe_binary(resolve_ffmpeg_binary(load_config().ffmpeg_path))
    except Exception:
        logger.debug("Unable to prepare ffprobe for LiteCut asset FPS labels", exc_info=True)
        return items

    semaphore = asyncio.Semaphore(8)

    async def enrich(item: dict[str, Any]) -> dict[str, Any]:
        path = Path(str(item.get("file_path") or ""))
        if not path.is_file():
            return item
        async with semaphore:
            try:
                info = await asyncio.to_thread(
                    probe_video_audio_summary,
                    path,
                    ffprobe,
                    "lite_cut_asset_fps_probe",
                    "lite_cut_asset",
                )
                fps = float(info.get("fps") or 0)
                if fps > 0:
                    return {**item, "fps": fps}
            except Exception:
                logger.debug("Unable to probe LiteCut asset FPS: %s", path, exc_info=True)
        return item

    enriched = await asyncio.gather(*(enrich(item) for item in video_items))
    by_id = {int(item["id"]): item for item in enriched if item.get("id") is not None}
    return [by_id.get(int(item["id"]), item) if item.get("id") is not None else item for item in items]


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
    items = await get_lite_cut_db().list_assets(project_id=project_id, limit=limit, offset=offset)
    from .assets import probe_image_dimensions
    for item in items:
        if item.get("kind") != "image" or (item.get("width") and item.get("height")):
            continue
        dimensions = await asyncio.to_thread(probe_image_dimensions, Path(str(item.get("file_path") or "")))
        if dimensions:
            item["width"], item["height"] = dimensions
            await get_lite_cut_db().update_asset_dimensions(int(item["id"]), *dimensions)
    for item in items:
        _decorate_asset_preview_state(item)
    items = await _attach_video_fps(items)
    return {"items": items, "limit": limit, "offset": offset}


@router.post("/assets/upload")
async def upload_lite_cut_asset(
    file: UploadFile = File(...),
    project_id: int | None = Query(default=None),
    client_duration_sec: float | None = Query(default=None, ge=0),
):
    from pathlib import Path

    from .assets import probe_image_dimensions, save_uploaded_asset, stable_project_asset_directory

    project = None
    if project_id is not None:
        proj = await get_lite_cut_db().get_project(int(project_id))
        if not proj:
            raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
        project = proj

    destination_dir = None
    if project is not None and project_id is not None:
        existing_assets = await get_lite_cut_db().list_project_assets(int(project_id))
        destination_dir = stable_project_asset_directory(
            int(project_id),
            str(project.get("name") or "未命名工程"),
            [str(item.get("file_path") or "") for item in existing_assets],
        )
    dest, kind, mime = await save_uploaded_asset(
        file,
        project_name=project.get("name") if project else None,
        destination_dir=destination_dir,
    )
    duration_sec = None
    media_info: dict[str, Any] = {}
    if kind == "image":
        dimensions = probe_image_dimensions(dest)
        if dimensions:
            media_info["width"], media_info["height"] = dimensions
    if kind in {"video", "webm", "audio", "image"} or dest.suffix.lower() == ".gif":
        try:
            from ..env_utils import load_config
            from ..video_composer import probe_video_audio_summary, resolve_ffmpeg_binary, resolve_ffprobe_binary

            cfg = load_config()
            ffmpeg_bin = resolve_ffmpeg_binary(cfg.ffmpeg_path)
            ffprobe = resolve_ffprobe_binary(ffmpeg_bin)
            info = probe_video_audio_summary(dest, ffprobe)
            media_info = info
            duration = float(info.get("duration") or 0)
            if duration > 0:
                duration_sec = duration
        except Exception:
            duration_sec = None
    if duration_sec is None and client_duration_sec is not None and client_duration_sec > 0:
        # ffprobe may be unavailable (e.g. dev setups without bundled ffmpeg);
        # trust the browser-side metadata probe so clips get a real trim range.
        duration_sec = float(client_duration_sec)
    asset_id = await get_lite_cut_db().create_asset(
        name=Path(file.filename or dest.name).name,
        kind=kind,
        file_path=str(dest),
        mime_type=mime or None,
        duration_sec=duration_sec,
        width=int(media_info.get("width") or 0) or None,
        height=int(media_info.get("height") or 0) or None,
        project_id=int(project_id) if project_id is not None else None,
    )
    item = await get_lite_cut_db().get_asset(asset_id)
    if not item:
        raise HTTPException(500, error_detail("LITECUT_ASSET_SAVE_FAILED"))
    alpha_hint = bool(media_info.get("has_alpha")) if "has_alpha" in media_info else None
    return _decorate_asset_preview_state(
        {**item, "fps": media_info.get("fps") if kind in {"video", "webm"} else None},
        has_alpha=alpha_hint,
        video_codec=str(media_info.get("codec_name") or "") or None,
        audio_codec=str(media_info.get("audio_codec_name") or ""),
        pixel_format=str(media_info.get("pixel_format") or ""),
    )


@router.get("/assets/{asset_id}/metadata")
async def get_lite_cut_asset_metadata(asset_id: int):
    """Return source-media facts used by the inspector's read-only summary."""
    row = await get_lite_cut_db().get_asset(int(asset_id))
    if not row:
        raise HTTPException(404, error_detail("LITECUT_ASSET_NOT_FOUND"))

    from pathlib import Path

    from .assets import probe_image_dimensions, validate_stored_asset_path

    path = validate_stored_asset_path(str(row["file_path"]))
    kind = str(row.get("kind") or "file").lower()
    result: dict[str, Any] = {
        "id": int(row["id"]),
        "kind": kind,
        "name": row.get("name") or path.name,
        "extension": path.suffix.lstrip(".").upper(),
        "mime_type": row.get("mime_type"),
        "duration_sec": row.get("duration_sec"),
        "width": row.get("width"),
        "height": row.get("height"),
        "fps": None,
        "codec_name": None,
        "has_audio": None,
    }
    if kind == "image":
        dimensions = await asyncio.to_thread(probe_image_dimensions, path)
        if dimensions:
            result["width"], result["height"] = dimensions
        return result

    try:
        from ..env_utils import load_config
        from ..video_composer import probe_video_audio_summary, resolve_ffmpeg_binary, resolve_ffprobe_binary

        ffmpeg_bin = resolve_ffmpeg_binary(load_config().ffmpeg_path)
        info = await asyncio.to_thread(probe_video_audio_summary, path, resolve_ffprobe_binary(ffmpeg_bin))
        result.update({
            "duration_sec": info.get("duration") or result["duration_sec"],
            "width": info.get("width") if kind not in {"audio"} else None,
            "height": info.get("height") if kind not in {"audio"} else None,
            "fps": info.get("fps") if kind not in {"audio"} else None,
            "codec_name": info.get("codec_name") or None,
            "has_audio": bool(info.get("has_audio")),
        })
    except Exception:
        logger.warning("LiteCut asset metadata probe failed for %s", path.name, exc_info=True)
    return result


@router.get("/assets/{asset_id}/waveform")
async def get_lite_cut_asset_waveform(
    asset_id: int,
    buckets: int = Query(default=72, ge=8, le=512),
    start_sec: float = Query(default=0, ge=0),
    end_sec: float | None = Query(default=None, ge=0),
):
    row = await get_lite_cut_db().get_asset(int(asset_id))
    if not row:
        raise HTTPException(404, error_detail("LITECUT_ASSET_NOT_FOUND"))
    from ..video_composer import resolve_ffmpeg_binary
    from .assets import validate_stored_asset_path
    from .waveform import load_or_create_waveform_cache, waveform_view

    path = validate_stored_asset_path(str(row["file_path"]))
    try:
        payload, cached = await asyncio.to_thread(
            load_or_create_waveform_cache,
            path,
            ffmpeg_bin=resolve_ffmpeg_binary(load_config().ffmpeg_path),
            duration_sec=row.get("duration_sec"),
        )
    except Exception as exc:
        logger.warning("LiteCut waveform generation failed for %s", path.name, exc_info=True)
        raise HTTPException(422, str(exc) or "无法生成素材波形") from exc
    return {**waveform_view(payload, start_sec=start_sec, end_sec=end_sec, buckets=buckets), "cached": cached}


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
    path = Path(__file__).resolve().parents[2] / "assets" / "fonts" / safe_name
    return FileResponse(path, media_type="font/ttf", filename=safe_name)


@router.get("/assets/{asset_id}/stream")
async def stream_lite_cut_asset(asset_id: int, request: Request):
    from .assets import asset_stream_path, validate_stored_asset_path
    from .stream import stream_file_with_range

    row = await get_lite_cut_db().get_asset(int(asset_id))
    if not row:
        raise HTTPException(404, error_detail("LITECUT_ASSET_NOT_FOUND"))
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
    return await stream_file_with_range(asset_stream_path(path), request)


@router.post("/assets/{asset_id}/proxy/retry")
async def retry_lite_cut_asset_preview_proxy(asset_id: int):
    row = await get_lite_cut_db().get_asset(int(asset_id))
    if not row:
        raise HTTPException(404, error_detail("LITECUT_ASSET_NOT_FOUND"))
    state = _decorate_asset_preview_state(dict(row), schedule=False)
    if not state.get("preview_proxy_required"):
        return state
    await _stop_preview_proxy_job(int(asset_id))
    job = _start_preview_proxy_job(row, force=True)
    row.update(_preview_proxy_job_snapshot(job))
    return row


@router.delete("/assets/{asset_id}")
async def delete_lite_cut_asset(asset_id: int):
    from .assets import asset_file_bundle_paths

    row = await get_lite_cut_db().get_asset(int(asset_id))
    if not row:
        raise HTTPException(404, error_detail("LITECUT_ASSET_NOT_FOUND"))
    await _stop_preview_proxy_job(int(asset_id))
    paths = await asyncio.to_thread(asset_file_bundle_paths, str(row["file_path"]))
    try:
        quarantined = await asyncio.to_thread(quarantine_files, paths, "lite-cut")
    except OSError as exc:
        raise HTTPException(409, f"Asset files could not be moved to the recovery area: {exc}") from exc
    try:
        ok = await get_lite_cut_db().delete_asset(int(asset_id))
        if not ok:
            raise HTTPException(404, error_detail("LITECUT_ASSET_NOT_FOUND"))
    except Exception:
        await asyncio.to_thread(quarantined.restore)
        raise
    return {
        "deleted": True,
        "id": asset_id,
        "recovery_directory": str(quarantined.directory) if quarantined.files else None,
    }
