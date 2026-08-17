"""Filesystem and media-probe side effects for LiteCut asset use cases."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import mimetypes
from pathlib import Path
from typing import Any

from ...env_utils import load_config
from ...file_quarantine import quarantine_files

logger = logging.getLogger(__name__)
LINKED_ASSET_FINGERPRINT_PREFIX = "lc-content-v1:"


def _linked_asset_fingerprint(path: Path) -> tuple[int, int, str]:
    """Build a path/mtime-independent, bounded-cost content identity.

    The project-file workflow must recognize the same bytes after a file is
    copied to another computer.  File modification time therefore remains a
    local change detector, but is deliberately excluded from this identity.
    """
    stat = path.stat()
    digest = hashlib.sha256()
    digest.update(f"{stat.st_size}:".encode("ascii"))
    with path.open("rb") as source:
        digest.update(source.read(64 * 1024))
        if stat.st_size > 128 * 1024:
            source.seek(max(0, stat.st_size // 2 - 32 * 1024))
            digest.update(source.read(64 * 1024))
        if stat.st_size > 64 * 1024:
            source.seek(max(0, stat.st_size - 64 * 1024))
            digest.update(source.read(64 * 1024))
    return int(stat.st_size), int(stat.st_mtime_ns), f"{LINKED_ASSET_FINGERPRINT_PREFIX}{digest.hexdigest()}"


def linked_asset_identity_matches(expected: str | None, actual: str | None) -> bool:
    """Validate identities created by the linked-project contract.

    Unprefixed values belong to the retired link implementation and are not
    treated as a cross-machine content identity. They are refreshed on the next relink or
    project-file export instead of blocking existing local projects.
    """
    expected_value = str(expected or "")
    if not expected_value.startswith(LINKED_ASSET_FINGERPRINT_PREFIX):
        return True
    return expected_value == str(actual or "")


async def probe_linked_asset(raw_path: str) -> dict[str, Any]:
    """Validate and quickly probe an external file without copying it."""
    from .assets import asset_kind_for_path, probe_image_dimensions, validate_linked_asset_path

    path = validate_linked_asset_path(raw_path)
    size_bytes, mtime_ns, fingerprint = await asyncio.to_thread(_linked_asset_fingerprint, path)
    from .media_policy import probe_webp_container

    webp_facts = await asyncio.to_thread(probe_webp_container, path) if path.suffix.lower() == ".webp" else {}
    is_looping_animation = path.suffix.lower() == ".gif" or bool(webp_facts.get("animated"))
    kind = "video" if bool(webp_facts.get("animated")) else asset_kind_for_path(path)
    mime_type = mimetypes.guess_type(path.name)[0] or ("image/webp" if path.suffix.lower() == ".webp" else None)
    duration_sec = None
    media_info: dict[str, Any] = {}
    metadata_status = "ready"
    if kind == "image":
        dimensions = await asyncio.to_thread(probe_image_dimensions, path)
        if dimensions:
            media_info["width"], media_info["height"] = dimensions
    if kind in {"video", "webm", "audio"} or path.suffix.lower() == ".gif":
        try:
            from ...video_composer import probe_video_audio_summary, resolve_ffmpeg_binary, resolve_ffprobe_binary

            ffmpeg_bin = resolve_ffmpeg_binary(load_config().ffmpeg_path)
            media_info = await asyncio.to_thread(
                probe_video_audio_summary,
                path,
                resolve_ffprobe_binary(ffmpeg_bin),
            )
            duration = float(media_info.get("duration") or 0)
            duration_sec = duration if duration > 0 else None
        except Exception:
            metadata_status = "failed"
            logger.debug("Unable to probe linked LiteCut asset: %s", path.name, exc_info=True)
    if duration_sec is None:
        container_duration = float(webp_facts.get("duration_sec") or 0)
        duration_sec = container_duration if container_duration > 0 else None
    if not media_info.get("width") and webp_facts.get("width"):
        media_info["width"] = webp_facts["width"]
    if not media_info.get("height") and webp_facts.get("height"):
        media_info["height"] = webp_facts["height"]
    has_alpha = bool(media_info.get("has_alpha")) if "has_alpha" in media_info else None
    if webp_facts:
        has_alpha = bool(has_alpha or webp_facts.get("has_alpha"))
    return {
        "path": path,
        "name": path.name,
        "kind": kind,
        "mime_type": mime_type,
        "duration_sec": duration_sec,
        "width": int(media_info.get("width") or 0) or None,
        "height": int(media_info.get("height") or 0) or None,
        "fps": float(media_info.get("fps") or 0) or None,
        "codec_name": str(media_info.get("codec_name") or "") or None,
        "audio_codec_name": str(media_info.get("audio_codec_name") or ""),
        "pixel_format": str(media_info.get("pixel_format") or ""),
        "has_alpha": has_alpha,
        "is_looping_animation": is_looping_animation,
        "size_bytes": size_bytes,
        "mtime_ns": mtime_ns,
        "fingerprint": fingerprint,
        "source_status": "available",
        "metadata_status": metadata_status,
    }


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
        from .media_policy import is_looping_animation_path, probe_webp_container

        looping = is_looping_animation_path(path)
        if item.get("has_alpha") is not None and item.get("fps") is not None and item.get("codec_name"):
            return {**item, "is_looping_animation": looping}
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
                webp_facts = probe_webp_container(path) if path.suffix.lower() == ".webp" else {}
                has_alpha = bool(info.get("has_alpha")) if "has_alpha" in info else None
                if webp_facts:
                    has_alpha = bool(has_alpha or webp_facts.get("has_alpha"))
                return {
                    **item,
                    "fps": fps if fps > 0 else None,
                    "codec_name": str(info.get("codec_name") or "") or None,
                    "audio_codec_name": str(info.get("audio_codec_name") or ""),
                    "pixel_format": str(info.get("pixel_format") or ""),
                    "has_alpha": has_alpha,
                    "is_looping_animation": looping,
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
    from .assets import asset_source_path, probe_image_dimensions

    path = asset_source_path(row)
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
    from .assets import asset_source_path, asset_waveform_cache_path
    from .waveform import load_or_create_waveform_cache, waveform_view

    path = asset_source_path(row)
    payload, cached = await asyncio.to_thread(
        load_or_create_waveform_cache,
        path,
        ffmpeg_bin=resolve_ffmpeg_binary(load_config().ffmpeg_path),
        duration_sec=row.get("duration_sec"),
        cache_path=asset_waveform_cache_path(row),
    )
    return {**waveform_view(payload, start_sec=start_sec, end_sec=end_sec, buckets=buckets), "cached": cached}


async def build_asset_audio_preview(row: dict[str, Any], *, output_path: Path) -> Path | None:
    """Create the full-duration audio preview without leaking FFmpeg work into HTTP routes."""
    from ...video_composer import resolve_ffmpeg_binary
    from .assets import asset_source_path, create_audio_preview_proxy

    return await asyncio.to_thread(
        create_audio_preview_proxy,
        asset_source_path(row),
        ffmpeg_bin=resolve_ffmpeg_binary(load_config().ffmpeg_path),
        output_path=output_path,
        audio_codec=str(row.get("audio_codec_name") or ""),
    )


async def quarantine_asset_files(row: dict[str, Any]):
    from .assets import asset_row_bundle_paths

    paths = await asyncio.to_thread(asset_row_bundle_paths, row)
    return await asyncio.to_thread(quarantine_files, paths, "lite-cut")
