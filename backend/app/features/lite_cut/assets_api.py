"""LiteCut asset validation, upload, metadata, streaming and deletion routes."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ...api_errors import error_detail
from .asset_executor import (
    attach_video_facts as _attach_video_fps,
    build_asset_waveform,
    linked_asset_identity_matches,
    probe_asset_metadata,
    probe_linked_asset,
    quarantine_asset_files,
    save_and_probe_upload,
)
from .proxy_api import (
    _decorate_asset_preview_state,
    _segment_preview_snapshot,
    _start_segment_preview_job,
    _stop_preview_proxy_job,
)
from .dependencies import build_lite_cut_services
from .service_http import service_call
from .text_layout import builtin_text_font_path_for_filename
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


class LiteCutAssetLinkBody(BaseModel):
    project_id: int | None = None
    paths: list[str] = Field(min_length=1, max_length=100)


class LiteCutAssetRelinkBody(BaseModel):
    path: str = Field(min_length=1, max_length=32767)


class LiteCutRecordedAssetLinkBody(BaseModel):
    project_id: int
    recording_id: int


class LiteCutPreviewRequestBody(BaseModel):
    time_sec: float = Field(ge=0)
    look_ahead_sec: float = Field(default=12, ge=0, le=30)
    priority: str = Field(default="interactive", pattern="^(interactive|prefetch)$")
    retry: bool = False


def _decorate_asset_source_state(item: dict[str, Any]) -> dict[str, Any]:
    from .assets import asset_source_status

    item["asset_registered"] = item.get("id") is not None
    item["source_status"] = asset_source_status(item)
    # A changed source must be explicitly relinked so derived metadata and
    # waveform caches cannot be mistaken for the new file contents.
    item["source_available"] = item["source_status"] == "available"
    return item


async def _persist_asset_media_metadata(item: dict[str, Any]) -> None:
    await service_call(_services().assets.update_media_metadata(
        int(item["id"]),
        fps=float(item.get("fps") or 0) or None,
        codec_name=str(item.get("codec_name") or "") or None,
        audio_codec_name=str(item.get("audio_codec_name") or ""),
        pixel_format=str(item.get("pixel_format") or ""),
        has_alpha=item.get("has_alpha") if item.get("has_alpha") is not None else None,
        is_looping_animation=bool(item.get("is_looping_animation")),
    ))


async def _ensure_asset_preview_metadata(row: dict[str, Any]) -> dict[str, Any]:
    if str(row.get("kind") or "").lower() not in {"video", "webm"}:
        return row
    if row.get("has_alpha") is not None and row.get("codec_name"):
        return row
    enriched = (await _attach_video_fps([row]))[0]
    if enriched.get("id") is not None:
        await _persist_asset_media_metadata(enriched)
    return enriched


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
    for item in items:
        _decorate_asset_source_state(item)
    from .media_policy import webp_is_animated
    for item in items:
        path = Path(str(item.get("file_path") or ""))
        if str(item.get("kind") or "").lower() == "image" and path.suffix.lower() == ".webp" and webp_is_animated(path):
            item["kind"] = "video"
            item["is_looping_animation"] = True
            await service_call(services.assets.update_kind(int(item["id"]), "video", item.get("mime_type")))
    from .assets import probe_image_dimensions
    for item in items:
        if item.get("kind") != "image" or (item.get("width") and item.get("height")):
            continue
        dimensions = await asyncio.to_thread(probe_image_dimensions, Path(str(item.get("file_path") or "")))
        if dimensions:
            item["width"], item["height"] = dimensions
            await services.assets.update_dimensions(int(item["id"]), *dimensions)
    missing_metadata_ids = {
        int(item["id"])
        for item in items
        if str(item.get("kind") or "").lower() in {"video", "webm"}
        and (item.get("has_alpha") is None or not item.get("codec_name"))
    }
    items = await _attach_video_fps(items)
    for item in items:
        if int(item.get("id") or 0) in missing_metadata_ids:
            await _persist_asset_media_metadata(item)
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


@router.post("/assets/link")
async def link_lite_cut_assets(body: LiteCutAssetLinkBody):
    """Register user-selected absolute paths without copying source bytes."""
    if body.project_id is not None:
        project = await _services().projects.get(int(body.project_id))
        if not project:
            raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))

    # Validate/probe the complete selection first so one bad path does not
    # leave a partially registered batch behind.
    probed = [await probe_linked_asset(raw_path) for raw_path in body.paths]
    items: list[dict[str, Any]] = []
    for facts in probed:
        path = facts.pop("path")
        item = await service_call(_services().assets.create(
            name=facts["name"],
            kind=facts["kind"],
            file_path=str(path),
            mime_type=facts["mime_type"],
            duration_sec=facts["duration_sec"],
            width=facts["width"],
            height=facts["height"],
            project_id=int(body.project_id) if body.project_id is not None else None,
            storage_mode="link",
            original_path=str(path),
            managed_path=None,
            size_bytes=facts["size_bytes"],
            mtime_ns=facts["mtime_ns"],
            fingerprint=facts["fingerprint"],
            source_status=facts["source_status"],
            metadata_status=facts["metadata_status"],
            fps=facts["fps"],
            codec_name=facts["codec_name"],
            audio_codec_name=facts["audio_codec_name"],
            pixel_format=facts["pixel_format"],
            has_alpha=facts["has_alpha"],
            is_looping_animation=facts["is_looping_animation"],
        ))
        _decorate_asset_source_state(item)
        items.append(_decorate_asset_preview_state(
            {**item, "fps": facts["fps"]},
            has_alpha=facts["has_alpha"],
            video_codec=facts["codec_name"],
            audio_codec=facts["audio_codec_name"],
            pixel_format=facts["pixel_format"],
            source_fps=facts["fps"],
        ))
    return {"items": items}


def _recording_origin_metadata(row: dict[str, Any]) -> dict[str, Any]:
    fields = {
        "clip_id", "demo_filename", "player_name", "map_name", "map", "round",
        "category", "workbench_clip_kind", "context_tags", "ai_score", "ai_comment",
        "ai_commentary", "recording_perspective", "start_tick", "end_tick", "created_at",
    }
    return {key: row[key] for key in fields if key in row and row[key] is not None}


def _asset_kinds_match(expected: str, actual: str) -> bool:
    left = str(expected or "file").lower()
    right = str(actual or "file").lower()
    if left in {"video", "webm"} and right in {"video", "webm"}:
        return True
    return left == right


@router.post("/assets/link-recording")
async def link_lite_cut_recording(body: LiteCutRecordedAssetLinkBody):
    """Link one Insight recording into a project without copying its media."""
    services = _services()
    project = await services.projects.get(int(body.project_id))
    if not project:
        raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
    recording_id = int(body.recording_id)
    recordings = await get_montage_db().get_recorded_clips_by_ids([recording_id])
    recording = recordings.get(recording_id)
    if not recording:
        raise HTTPException(404, error_detail("MONTAGE_CLIP_NOT_FOUND", id=str(recording_id)))
    facts = await probe_linked_asset(str(recording.get("output_path") or ""))
    path = facts.pop("path")

    existing = next((
        item for item in await services.assets.list_for_project(int(body.project_id))
        if str(item.get("origin_type") or "") == "insight_recording"
        and str(item.get("origin_ref") or "") == str(recording_id)
    ), None)
    if existing:
        if not linked_asset_identity_matches(existing.get("fingerprint"), facts.get("fingerprint")):
            raise HTTPException(409, {"code": "LITECUT_ASSET_IDENTITY_MISMATCH", "reason": "Insight recording content does not match the project asset"})
        item = await service_call(services.assets.update_source(
            int(existing["id"]),
            name=facts["name"], kind=facts["kind"], mime_type=facts["mime_type"],
            file_path=str(path), storage_mode="link", original_path=str(path), managed_path=None,
            size_bytes=facts["size_bytes"], mtime_ns=facts["mtime_ns"], fingerprint=facts["fingerprint"],
            source_status="available", metadata_status=facts["metadata_status"],
            duration_sec=facts["duration_sec"], width=facts["width"], height=facts["height"],
            fps=facts["fps"], codec_name=facts["codec_name"], audio_codec_name=facts["audio_codec_name"],
            pixel_format=facts["pixel_format"], has_alpha=facts["has_alpha"],
            is_looping_animation=facts["is_looping_animation"],
        ))
    else:
        item = await service_call(services.assets.create(
            project_id=int(body.project_id),
            origin_type="insight_recording",
            origin_ref=str(recording_id),
            origin_metadata=_recording_origin_metadata(recording),
            name=Path(str(recording.get("output_path") or facts["name"])).name,
            kind=facts["kind"], mime_type=facts["mime_type"], file_path=str(path),
            storage_mode="link", original_path=str(path), managed_path=None,
            size_bytes=facts["size_bytes"], mtime_ns=facts["mtime_ns"], fingerprint=facts["fingerprint"],
            source_status="available", metadata_status=facts["metadata_status"],
            duration_sec=facts["duration_sec"], width=facts["width"], height=facts["height"],
            fps=facts["fps"], codec_name=facts["codec_name"], audio_codec_name=facts["audio_codec_name"],
            pixel_format=facts["pixel_format"], has_alpha=facts["has_alpha"],
            is_looping_animation=facts["is_looping_animation"],
        ))
    _decorate_asset_source_state(item)
    return _decorate_asset_preview_state(
        {**item, "fps": facts["fps"]},
        has_alpha=facts["has_alpha"], video_codec=facts["codec_name"],
        audio_codec=facts["audio_codec_name"], pixel_format=facts["pixel_format"],
        source_fps=facts["fps"],
    )


@router.post("/assets/generated")
async def create_lite_cut_generated_asset(
    file: UploadFile = File(...),
    project_id: int | None = Query(default=None),
    client_duration_sec: float | None = Query(default=None, ge=0),
):
    """Persist media created inside LiteCut, currently browser-recorded voiceover.

    External user files must use ``/assets/link`` so their bytes are never
    copied into project storage.
    """
    from pathlib import Path

    from .assets import stable_project_asset_directory

    if not str(file.content_type or "").lower().startswith("audio/"):
        raise HTTPException(400, "generated asset endpoint only accepts recorded audio")

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
        storage_mode="managed",
        managed_path=str(dest),
        size_bytes=dest.stat().st_size,
        mtime_ns=dest.stat().st_mtime_ns,
        fps=media_info.get("fps") if kind in {"video", "webm"} else None,
        codec_name=str(media_info.get("codec_name") or "") or None,
        audio_codec_name=str(media_info.get("audio_codec_name") or ""),
        pixel_format=str(media_info.get("pixel_format") or ""),
        has_alpha=bool(media_info.get("has_alpha")) if "has_alpha" in media_info else None,
        is_looping_animation=False,
    ))
    alpha_hint = bool(media_info.get("has_alpha")) if "has_alpha" in media_info else None
    return _decorate_asset_preview_state(
        _decorate_asset_source_state({**item, "fps": media_info.get("fps") if kind in {"video", "webm"} else None}),
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
    path = builtin_text_font_path_for_filename(font_name)
    if path is None:
        raise HTTPException(404, "font not found")
    media_type = "font/collection" if path.suffix.lower() == ".ttc" else "font/ttf"
    return FileResponse(path, media_type=media_type, filename=path.name)


@router.get("/assets/{asset_id}/stream")
async def stream_lite_cut_asset(asset_id: int, request: Request):
    from .assets import asset_source_path, asset_source_status
    from .stream import stream_file_with_range

    row = await service_call(_services().assets.get(int(asset_id)))
    source_status = asset_source_status(row)
    if source_status == "missing":
        raise HTTPException(404, "素材原文件不存在，请重新链接")
    if source_status == "changed":
        raise HTTPException(409, "素材原文件已发生变化，请重新链接以刷新缓存")
    path = asset_source_path(row)
    if str(row.get("kind") or "").lower() == "font":
        font_mime = {
            ".ttf": "font/ttf",
            ".otf": "font/otf",
            ".woff": "font/woff",
            ".woff2": "font/woff2",
        }.get(path.suffix.lower(), "application/font-sfnt")
        return FileResponse(path, media_type=font_mime, headers={"Cache-Control": "no-cache"})
    return await stream_file_with_range(
        path,
        request,
    )


@router.get("/assets/{asset_id}/preview/audio")
async def stream_lite_cut_audio_preview(asset_id: int, request: Request):
    from ...env_utils import load_config
    from ...video_composer import resolve_ffmpeg_binary
    from .assets import asset_source_path, asset_source_status, create_audio_preview_proxy
    from .stream import stream_file_with_range

    row = await service_call(_services().assets.get(int(asset_id)))
    if str(row.get("kind") or "").lower() not in {"video", "webm"}:
        raise HTTPException(400, "only video assets support full audio preview")
    source_status = asset_source_status(row)
    if source_status == "missing":
        raise HTTPException(404, "素材原文件不存在，请重新链接")
    if source_status == "changed":
        raise HTTPException(409, "素材原文件已发生变化，请重新链接")
    row = await _ensure_asset_preview_metadata(row)
    segment_directory, _max_edge = await _segment_preview_context(row)
    output = segment_directory.parent / "preview-audio-v1.m4a"
    source = asset_source_path(row)
    ffmpeg_bin = resolve_ffmpeg_binary(load_config().ffmpeg_path)
    preview = await asyncio.to_thread(
        create_audio_preview_proxy,
        source,
        ffmpeg_bin=ffmpeg_bin,
        output_path=output,
        audio_codec=str(row.get("audio_codec_name") or ""),
    )
    if preview is None or not preview.is_file():
        raise HTTPException(422, "素材没有可用于预览的音轨")
    return await stream_file_with_range(preview, request)


async def _segment_preview_context(row: dict[str, Any]):
    from ...env_utils import load_config
    from .assets import stable_project_asset_directory
    from .proxy_executor import preview_segment_cache_directory

    project_id = int(row.get("project_id") or 0)
    if project_id <= 0:
        raise HTTPException(409, "分段预览需要素材属于当前工程")
    services = _services()
    project = await service_call(services.projects.get(project_id))
    project_assets = await service_call(services.assets.list_for_project(project_id))
    managed_paths = [
        str(item.get("managed_path") or item.get("file_path") or "")
        for item in project_assets
        if str(item.get("storage_mode") or "managed").lower() != "link"
    ]
    project_directory = stable_project_asset_directory(
        project_id,
        str(project.get("name") or "未命名工程"),
        managed_paths,
    )
    cfg = load_config()
    max_edge = max(360, min(2160, int(getattr(cfg, "lite_cut_proxy_resolution", 720) or 720)))
    return preview_segment_cache_directory(row, project_directory, max_edge=max_edge), max_edge


@router.post("/assets/{asset_id}/preview/request")
async def request_lite_cut_asset_preview(asset_id: int, body: LiteCutPreviewRequestBody):
    from .assets import asset_source_status
    from .media_policy import SEGMENT_PREVIEW_ENCODE_SEC
    from .proxy_executor import preview_segment_index
    from .runtime import segment_preview_jobs

    row = await service_call(_services().assets.get(int(asset_id)))
    if str(row.get("kind") or "").lower() not in {"video", "webm"}:
        raise HTTPException(400, "only video assets support segmented preview")
    source_status = asset_source_status(row)
    if source_status == "missing":
        raise HTTPException(404, "素材原文件不存在，请重新链接")
    if source_status == "changed":
        raise HTTPException(409, "素材原文件已发生变化，请重新链接")
    row = await _ensure_asset_preview_metadata(row)
    cache_directory, max_edge = await _segment_preview_context(row)
    source_duration = max(0.0, float(row.get("duration_sec") or 0.0))
    requested_time = body.time_sec
    if source_duration > 0:
        requested_time = min(requested_time, max(0.0, source_duration - 0.001))
    job = _start_segment_preview_job(
        row,
        requested_time_sec=requested_time,
        look_ahead_sec=body.look_ahead_sec,
        cache_directory=cache_directory,
        max_edge=max_edge,
        priority=body.priority,
        force=body.retry,
    )
    requested_index = preview_segment_index(requested_time)
    snapshot = _segment_preview_snapshot(
        segment_preview_jobs.get(int(asset_id)) or job,
        requested_index=requested_index,
        cache_directory=cache_directory,
    )
    segment_start = requested_index * float(snapshot["segment_step_sec"])
    segment_end = segment_start + SEGMENT_PREVIEW_ENCODE_SEC
    if source_duration > 0:
        segment_end = min(segment_end, source_duration)
    snapshot.update({
        "asset_id": int(asset_id),
        "priority": body.priority,
        "segment_end_sec": segment_end,
        "playable_from": segment_start,
        "playable_to": segment_end if snapshot["status"] == "ready" else segment_start,
        "segment_url": (
            f"/api/lite-cut/assets/{int(asset_id)}/preview/segments/{requested_index}"
            f"?v={quote(str(row.get('fingerprint') or row.get('mtime_ns') or 'source'), safe='')}"
            if snapshot["status"] == "ready"
            else None
        ),
    })
    return snapshot


@router.get("/assets/{asset_id}/preview/segments/{segment_index}")
async def stream_lite_cut_preview_segment(asset_id: int, segment_index: int):
    from .proxy_executor import preview_segment_path

    if segment_index < 0:
        raise HTTPException(400, "invalid segment index")
    row = await service_call(_services().assets.get(int(asset_id)))
    cache_directory, _max_edge = await _segment_preview_context(row)
    path = preview_segment_path(cache_directory, segment_index)
    if not path.is_file() or path.stat().st_size <= 0:
        raise HTTPException(425, "预览分段正在生成", headers={"Retry-After": "1"})
    return FileResponse(
        path,
        media_type="video/webm" if path.suffix.lower() == ".webm" else "video/mp4",
        filename=path.name,
        headers={"Accept-Ranges": "bytes", "Cache-Control": "no-cache"},
    )


@router.post("/assets/{asset_id}/relink")
async def relink_lite_cut_asset(asset_id: int, body: LiteCutAssetRelinkBody):
    from .proxy_executor import remove_asset_preview_files, remove_segment_preview_files

    row = await service_call(_services().assets.get(int(asset_id)))
    facts = await probe_linked_asset(body.path)
    path = facts.pop("path")
    if not _asset_kinds_match(str(row.get("kind") or "file"), str(facts.get("kind") or "file")):
        raise HTTPException(409, {"code": "LITECUT_ASSET_TYPE_MISMATCH", "reason": "replacement media type does not match"})
    if not linked_asset_identity_matches(row.get("fingerprint"), facts.get("fingerprint")):
        raise HTTPException(409, {"code": "LITECUT_ASSET_IDENTITY_MISMATCH", "reason": "replacement file is not the same source media"})
    await _stop_preview_proxy_job(int(asset_id))
    await asyncio.to_thread(remove_asset_preview_files, row)
    await asyncio.to_thread(remove_segment_preview_files, row)
    item = await service_call(_services().assets.update_source(
        int(asset_id),
        name=facts["name"],
        kind=facts["kind"],
        mime_type=facts["mime_type"],
        file_path=str(path),
        storage_mode="link",
        original_path=str(path),
        managed_path=None,
        size_bytes=facts["size_bytes"],
        mtime_ns=facts["mtime_ns"],
        fingerprint=facts["fingerprint"],
        source_status=facts["source_status"],
        metadata_status=facts["metadata_status"],
        duration_sec=facts["duration_sec"],
        width=facts["width"],
        height=facts["height"],
        fps=facts["fps"],
        codec_name=facts["codec_name"],
        audio_codec_name=facts["audio_codec_name"],
        pixel_format=facts["pixel_format"],
        has_alpha=facts["has_alpha"],
        is_looping_animation=facts["is_looping_animation"],
    ))
    _decorate_asset_source_state(item)
    return _decorate_asset_preview_state(
        {**item, "fps": facts["fps"]},
        has_alpha=facts["has_alpha"],
        video_codec=facts["codec_name"],
        audio_codec=facts["audio_codec_name"],
        pixel_format=facts["pixel_format"],
        source_fps=facts["fps"],
    )


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
