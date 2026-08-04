"""Recorded-clip browsing, streaming, waveform and deletion routes."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from ..databases import montage_db
from ..env_utils import load_config
from ..lite_cut.stream import stream_file_with_range, validate_recorded_clip_path

router = APIRouter(tags=["recorded-clips"])


async def _attach_video_fps(rows: list[dict]) -> list[dict]:
    """Add the measured source FPS to material cards without decoding video."""
    if not rows:
        return rows
    try:
        from ..video_composer import probe_video_audio_summary, resolve_ffmpeg_binary, resolve_ffprobe_binary

        ffmpeg_bin = resolve_ffmpeg_binary(load_config().ffmpeg_path)
        ffprobe = resolve_ffprobe_binary(ffmpeg_bin)
    except Exception:
        logging.getLogger(__name__).debug("Unable to prepare ffprobe for material FPS labels", exc_info=True)
        return rows

    semaphore = asyncio.Semaphore(8)

    async def enrich(row: dict) -> dict:
        if row.get("fps") is not None:
            return row
        path = Path(str(row.get("output_path") or ""))
        if not path.is_file():
            return row
        async with semaphore:
            try:
                info = await asyncio.to_thread(
                    probe_video_audio_summary,
                    path,
                    ffprobe,
                    "montage_material_fps_probe",
                    "recorded_clip",
                )
                fps = float(info.get("fps") or 0)
                if fps > 0:
                    return {**row, "fps": fps}
            except Exception:
                logging.getLogger(__name__).debug("Unable to probe material FPS: %s", path, exc_info=True)
        return row

    return list(await asyncio.gather(*(enrich(row) for row in rows)))


@router.get("/api/recorded-clips")
async def list_recorded_clips(
    limit: int = Query(default=300, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    rows = await montage_db.list_recorded_clips(limit=limit, offset=offset)
    rows = await _attach_video_fps(rows)
    return {"items": rows, "limit": limit, "offset": offset}


class RecordedClipDurationPatch(BaseModel):
    duration_sec: float = Field(gt=0.05, le=86400)


@router.patch("/api/recorded-clips/{clip_id}/duration")
async def patch_recorded_clip_duration(clip_id: int, body: RecordedClipDurationPatch):
    """Store the duration measured by the browser from the completed media file."""
    updated = await montage_db.update_recorded_clip_duration(clip_id, body.duration_sec)
    if not updated:
        from ..api_errors import error_detail

        raise HTTPException(404, error_detail("MONTAGE_CLIP_NOT_FOUND", id=str(clip_id)))
    return {"id": int(clip_id), "duration_sec": float(body.duration_sec)}


@router.get("/api/recorded-clips/{clip_id}/stream")
async def stream_recorded_clip(clip_id: int, request: Request):
    """HTTP Range streaming for LiteCut / montage preview (<video> seek)."""
    rows = await montage_db.get_recorded_clips_by_ids([int(clip_id)])
    row = rows.get(int(clip_id))
    if not row:
        from ..api_errors import error_detail

        raise HTTPException(404, error_detail("MONTAGE_CLIP_NOT_FOUND", id=str(clip_id)))
    file_path = validate_recorded_clip_path(str(row.get("output_path") or ""))
    return await stream_file_with_range(file_path, request)


@router.get("/api/recorded-clips/{clip_id}/waveform")
async def get_recorded_clip_waveform(
    clip_id: int,
    buckets: int = Query(default=72, ge=8, le=512),
    start_sec: float = Query(default=0, ge=0),
    end_sec: float | None = Query(default=None, ge=0),
):
    rows = await montage_db.get_recorded_clips_by_ids([int(clip_id)])
    row = rows.get(int(clip_id))
    if not row:
        from ..api_errors import error_detail

        raise HTTPException(404, error_detail("MONTAGE_CLIP_NOT_FOUND", id=str(clip_id)))
    from ..lite_cut.waveform import load_or_create_waveform_cache, waveform_view
    from ..video_composer import resolve_ffmpeg_binary

    file_path = validate_recorded_clip_path(str(row.get("output_path") or ""))
    try:
        payload, cached = await asyncio.to_thread(
            load_or_create_waveform_cache,
            file_path,
            ffmpeg_bin=resolve_ffmpeg_binary(load_config().ffmpeg_path),
            duration_sec=row.get("duration_sec"),
        )
    except Exception as exc:
        logging.getLogger(__name__).warning("Recorded clip waveform generation failed for %s", file_path.name, exc_info=True)
        raise HTTPException(422, str(exc) or "无法生成素材波形") from exc
    return {**waveform_view(payload, start_sec=start_sec, end_sec=end_sec, buckets=buckets), "cached": cached}


@router.delete("/api/recorded-clips/{clip_id}")
async def delete_recorded_clip(clip_id: int):
    try:
        r = await montage_db.delete_recorded_clip(clip_id)
    except ValueError as e:
        raise HTTPException(500, str(e)) from e
    if r is None:
        from ..api_errors import error_detail

        raise HTTPException(404, error_detail("MONTAGE_CLIP_ALREADY_DELETED"))
    return r


class BatchDeleteRecordedClipsBody(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=500)


@router.post("/api/recorded-clips/batch-delete")
async def batch_delete_recorded_clips(body: BatchDeleteRecordedClipsBody):
    try:
        return await montage_db.delete_recorded_clips_batch(body.ids)
    except ValueError as e:
        raise HTTPException(500, str(e)) from e


@router.post("/api/recorded-clips/purge-missing")
async def purge_missing_recorded_clips():
    """删除 output_path 文件已不存在的孤儿记录，进入合集工作台时调用。"""
    return await montage_db.purge_missing_recorded_clips()
