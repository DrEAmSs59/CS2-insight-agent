"""HTTP endpoints for lightweight, link-only LiteCut project files."""

from __future__ import annotations

import asyncio
import os
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .dependencies import build_lite_cut_services
from .project_file import (
    PROJECT_FILE_MAX_BYTES,
    LiteCutProjectFileError,
    build_linked_project_document,
    decode_linked_project_document,
    encode_linked_project_document,
    import_linked_project_document,
)
from .runtime import get_lite_cut_db, get_montage_db
from .service_http import service_call
from .timeline import _recorded_source_ids_for_export


router = APIRouter(prefix="/api/lite-cut", tags=["lite-cut-project-files"])


class LiteCutProjectFileExportBody(BaseModel):
    destination: str = Field(default="", max_length=2048)


def _services():
    return build_lite_cut_services(get_lite_cut_db())


def _project_filename(name: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in str(name or "LiteCut"))[:80] or "LiteCut"
    return f"{safe}.litecut"


def _destination_directory(raw: str) -> Path | None:
    value = str(raw or "").strip()
    if not value:
        return None
    destination = Path(value.strip('"')).expanduser().resolve(strict=False)
    destination.mkdir(parents=True, exist_ok=True)
    if not destination.is_dir():
        raise OSError("destination is not a directory")
    return destination


async def _project_document(project_id: int) -> tuple[dict, bytes]:
    services = _services()
    project = await service_call(services.projects.get(int(project_id)))
    if not project:
        raise HTTPException(404, "LiteCut project not found")
    assets = await services.assets.list_for_project(int(project_id))
    known_ids = {int(item["id"]) for item in assets if item.get("id") is not None}
    referenced_ids: set[int] = set()
    body = project.get("body") if isinstance(project.get("body"), dict) else {}
    for track in body.get("tracks") or []:
        for clip in track.get("clips") or []:
            value = (clip.get("meta") or {}).get("asset_id")
            if value is not None:
                referenced_ids.add(int(value))
    for overlay in body.get("overlays") or []:
        value = (overlay.get("meta") or {}).get("asset_id")
        if value is not None:
            referenced_ids.add(int(value))
    bgm_id = (((body.get("audio") or {}).get("bgm") or {}).get("asset_id"))
    if bgm_id is not None:
        referenced_ids.add(int(bgm_id))
    for asset_id in sorted(referenced_ids - known_ids):
        try:
            assets.append(await services.assets.get(asset_id))
        except Exception:
            # A stale local DB id must not prevent the project structure from
            # being saved; its explicit path is captured as an offline link.
            pass
    source_ids = _recorded_source_ids_for_export(body)
    recordings = await get_montage_db().get_recorded_clips_by_ids(source_ids) if source_ids else {}
    document = await asyncio.to_thread(build_linked_project_document, project, assets, recordings)
    return document, encode_linked_project_document(document)


@router.post("/projects/{project_id}/project-file/export")
async def export_lite_cut_project_file(project_id: int, body: LiteCutProjectFileExportBody):
    document, payload = await _project_document(project_id)
    filename = _project_filename(str(document.get("name") or "LiteCut"))
    try:
        destination = _destination_directory(body.destination)
    except OSError as exc:
        raise HTTPException(400, f"Project-file destination is unavailable: {exc}") from exc
    saved_path = ""
    if destination is not None:
        target = destination / filename
        if target.exists():
            target = target.with_name(f"{target.stem}_{uuid.uuid4().hex[:6]}{target.suffix}")
        partial = target.with_name(f".{target.name}.{uuid.uuid4().hex}.partial")
        try:
            partial.write_bytes(payload)
            os.replace(partial, target)
        finally:
            partial.unlink(missing_ok=True)
        saved_path = str(target)
    offline_count = sum(
        1 for item in document.get("assets") or []
        if not Path(str((item.get("source") or {}).get("original_path") or "")).is_file()
    )
    return {
        "filename": filename,
        "saved_path": saved_path,
        "download_url": f"/api/lite-cut/projects/{int(project_id)}/project-file",
        "file_size": len(payload),
        "asset_count": len(document.get("assets") or []),
        "offline_asset_count": offline_count,
    }


@router.get("/projects/{project_id}/project-file")
async def download_lite_cut_project_file(project_id: int):
    document, payload = await _project_document(project_id)
    filename = _project_filename(str(document.get("name") or "LiteCut"))
    return Response(
        content=payload,
        media_type="application/vnd.litecut.project+json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/projects/project-file/import")
async def import_lite_cut_project_file(file: UploadFile = File(...)):
    if not str(file.filename or "").lower().endswith(".litecut"):
        raise HTTPException(400, "Please select a .litecut project file")
    payload = bytearray()
    while chunk := await file.read(1024 * 1024):
        payload.extend(chunk)
        if len(payload) > PROJECT_FILE_MAX_BYTES:
            raise HTTPException(400, "LiteCut project file exceeds 16 MB")
    try:
        document = decode_linked_project_document(bytes(payload))
        return await import_linked_project_document(document, _services())
    except (LiteCutProjectFileError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc


__all__ = ["router"]
