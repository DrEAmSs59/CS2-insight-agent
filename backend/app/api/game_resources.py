"""User-managed game resources."""

from __future__ import annotations

import asyncio
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from ..env_utils import load_config, save_config
from ..skybox_resources import (
    MAX_VMAT_BYTES,
    MAX_VTEX_BYTES,
    SkyboxResourceConflict,
    SkyboxResourceError,
    create_custom_skybox,
    delete_custom_skybox,
    list_skybox_resources,
    rename_custom_skybox,
)


router = APIRouter(prefix="/api/game-resources", tags=["game-resources"])


class RenameSkyboxBody(BaseModel):
    display_name: str


async def _read_upload(file: UploadFile, limit: int) -> bytes:
    data = bytearray()
    while True:
        chunk = await file.read(min(1024 * 1024, limit + 1 - len(data)))
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > limit:
            raise HTTPException(413, f"文件 {file.filename or '<unknown>'} 超过大小限制。")
    return bytes(data)


def _resource_error(exc: SkyboxResourceError) -> HTTPException:
    return HTTPException(409 if isinstance(exc, SkyboxResourceConflict) else 422, str(exc))


@router.get("/skyboxes")
def get_skyboxes() -> dict:
    return {"items": list_skybox_resources()}


@router.post("/skyboxes", status_code=201)
async def upload_skybox(
    display_name: Annotated[str, Form()],
    material_file: Annotated[UploadFile, File()],
    texture_file: Annotated[UploadFile, File()],
) -> dict:
    material_name = material_file.filename or ""
    texture_name = texture_file.filename or ""
    if not material_name.lower().endswith(".vmat_c"):
        raise HTTPException(422, "材质文件必须使用 .vmat_c 扩展名。")
    if not texture_name.lower().endswith(".vtex_c"):
        raise HTTPException(422, "纹理文件必须使用 .vtex_c 扩展名。")
    material_bytes = await _read_upload(material_file, MAX_VMAT_BYTES)
    texture_bytes = await _read_upload(texture_file, MAX_VTEX_BYTES)
    try:
        return await asyncio.to_thread(
            create_custom_skybox,
            display_name=display_name,
            material_filename=material_name,
            material_bytes=material_bytes,
            texture_filename=texture_name,
            texture_bytes=texture_bytes,
        )
    except SkyboxResourceError as exc:
        raise _resource_error(exc) from exc


@router.patch("/skyboxes/{resource_id}")
def rename_skybox(resource_id: str, body: RenameSkyboxBody) -> dict:
    try:
        return rename_custom_skybox(resource_id, body.display_name)
    except SkyboxResourceError as exc:
        raise _resource_error(exc) from exc


@router.delete("/skyboxes/{resource_id}")
def delete_skybox(resource_id: str) -> dict:
    try:
        delete_custom_skybox(resource_id)
    except SkyboxResourceError as exc:
        raise _resource_error(exc) from exc
    cfg = load_config()
    reset = str(getattr(cfg, "recording_skybox", "default") or "default").lower() == resource_id.lower()
    if reset:
        cfg.recording_skybox = "default"
        save_config(cfg)
    return {"deleted": True, "id": resource_id.lower(), "recording_skybox_reset": reset}
