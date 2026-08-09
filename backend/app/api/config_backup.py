"""CS2 user-config backup recovery routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..cs2_config_backup import (
    build_config_backup_status_payload,
    is_cs2_running,
    is_restore_required,
    open_backup_directory,
    restore_latest_user_config_backup,
)

router = APIRouter(prefix="/api/config-backup", tags=["config-backup"])


@router.get("/status")
def config_backup_status():
    return build_config_backup_status_payload()


@router.post("/restore")
def config_backup_restore():
    if not is_restore_required():
        return {"ok": True, "code": "CONFIG_RESTORE_NOT_NEEDED", "restored": 0}
    if is_cs2_running():
        raise HTTPException(status_code=409, detail={"code": "CS2_RUNNING"})
    result = restore_latest_user_config_backup()
    if result.get("code") == "CS2_RUNNING":
        raise HTTPException(status_code=409, detail={"code": "CS2_RUNNING"})
    if result.get("ok"):
        return {"ok": True, "code": "CONFIG_RESTORE_OK", "restored": result.get("restored", 0)}
    return {
        "ok": False,
        "code": "CONFIG_RESTORE_PARTIAL",
        "failed": result.get("failed") or [],
    }


@router.post("/open-dir")
def config_backup_open_dir():
    return open_backup_directory()
