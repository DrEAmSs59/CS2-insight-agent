"""Filesystem and media-probe side effects for LiteCut asset use cases."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from ...env_utils import load_config
from ...file_quarantine import quarantine_files

logger = logging.getLogger(__name__)


async def attach_video_facts(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Add probed video facts used by labels and preview-proxy selection."""
    video_items = [item for item in items if str(item.get("kind") or "").lower() in {"video", "webm"}]
    if not video_items:
        return items
    try:
        from ...video_composer import probe_video_audio_summary, resolve_ffmpeg_binary, resolve_ffprobe_binary

        ffprobe = resolve_ffprobe_binary(resolve_ffmpeg_binary(load_config().ffmpeg_path))
    except Exception:
        logger.debug("Unable to prepare ffprobe for LiteCut asset labels", exc_info=True)
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
                return {
                    **item,
                    "fps": fps if fps > 0 else None,
                    "codec_name": str(info.get("codec_name") or "") or None,
                    "audio_codec_name": str(info.get("audio_codec_name") or ""),
                    "pixel_format": str(info.get("pixel_format") or ""),
                    "has_alpha": bool(info.get("has_alpha")) if "has_alpha" in info else None,
                }
            except Exception:
                logger.debug("Unable to probe LiteCut asset: %s", path, exc_info=True)
                return item

    enriched = await asyncio.gather(*(enrich(item) for item in video_items))
    by_id = {int(item["id"]): item for item in enriched if item.get("id") is not None}
    return [by_id.get(int(item["id"]), item) if item.get("id") is not None else item for item in items]


async def save_and_probe_upload(
    file,
    *,
    project_name: str | None,
    destination_dir: Path | None,
    client_duration_sec: float | None,
) -> tuple[Path, str, str, float | None, dict[str, Any]]:
    from .assets import probe_image_dimensions, save_uploaded_asset

    dest, kind, mime = await save_uploaded_asset(
        file,
        project_name=project_name,
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
            from ...video_composer import probe_video_audio_summary, resolve_ffmpeg_binary, resolve_ffprobe_binary

            ffmpeg_bin = resolve_ffmpeg_binary(load_config().ffmpeg_path)
            media_info = probe_video_audio_summary(dest, resolve_ffprobe_binary(ffmpeg_bin))
            duration = float(media_info.get("duration") or 0)
            if duration > 0:
                duration_sec = duration
        except Exception:
            logger.debug("Unable to probe uploaded LiteCut asset: %s", dest, exc_info=True)
    if duration_sec is None and client_duration_sec is not None and client_duration_sec > 0:
        duration_sec = float(client_duration_sec)
    return dest, kind, mime, duration_sec, media_info


async def probe_asset_metadata(row: dict[str, Any]) -> dict[str, Any]:
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
        from ...video_composer import probe_video_audio_summary, resolve_ffmpeg_binary, resolve_ffprobe_binary

        ffmpeg_bin = resolve_ffmpeg_binary(load_config().ffmpeg_path)
        info = await asyncio.to_thread(probe_video_audio_summary, path, resolve_ffprobe_binary(ffmpeg_bin))
        result.update({
            "duration_sec": info.get("duration") or result["duration_sec"],
            "width": info.get("width") if kind != "audio" else None,
            "height": info.get("height") if kind != "audio" else None,
            "fps": info.get("fps") if kind != "audio" else None,
            "codec_name": info.get("codec_name") or None,
            "has_audio": bool(info.get("has_audio")),
        })
    except Exception:
        logger.warning("LiteCut asset metadata probe failed for %s", path.name, exc_info=True)
    return result


async def build_asset_waveform(
    row: dict[str, Any],
    *,
    buckets: int,
    start_sec: float,
    end_sec: float | None,
) -> dict[str, Any]:
    from ...video_composer import resolve_ffmpeg_binary
    from .assets import validate_stored_asset_path
    from .waveform import load_or_create_waveform_cache, waveform_view

    path = validate_stored_asset_path(str(row["file_path"]))
    payload, cached = await asyncio.to_thread(
        load_or_create_waveform_cache,
        path,
        ffmpeg_bin=resolve_ffmpeg_binary(load_config().ffmpeg_path),
        duration_sec=row.get("duration_sec"),
    )
    return {**waveform_view(payload, start_sec=start_sec, end_sec=end_sec, buckets=buckets), "cached": cached}


async def quarantine_asset_files(row: dict[str, Any]):
    from .assets import asset_file_bundle_paths

    paths = await asyncio.to_thread(asset_file_bundle_paths, str(row["file_path"]))
    return await asyncio.to_thread(quarantine_files, paths, "lite-cut")
