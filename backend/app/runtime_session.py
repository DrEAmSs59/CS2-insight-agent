"""Process-wide ownership guard for CS2/OBS mutating operations."""

from __future__ import annotations

from datetime import datetime, timezone
import threading
from typing import AsyncIterator
import uuid

from fastapi import HTTPException, Request


_claim_lock = threading.Lock()
_owner: dict[str, object] | None = None
_closing = False


async def runtime_session_dependency(request: Request) -> AsyncIterator[None]:
    global _owner
    claim = {
        "id": uuid.uuid4().hex,
        "operation": request.url.path,
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    with _claim_lock:
        if _closing:
            raise HTTPException(
                status_code=409,
                detail={"code": "APP_CLOSING", "message": "Insight is closing."},
            )
        if _owner is not None:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "RUNTIME_SESSION_BUSY",
                    "message": "Another CS2/OBS operation is already running.",
                    "owner": dict(_owner),
                },
            )
        _owner = claim
    try:
        yield
    finally:
        with _claim_lock:
            if _owner is not None and _owner.get("id") == claim["id"]:
                _owner = None


def runtime_session_state() -> dict[str, object]:
    with _claim_lock:
        return {"busy": _owner is not None, "owner": dict(_owner) if _owner else None}


def mark_runtime_cs2_launched(pid: int) -> None:
    """Record ownership only after Insight successfully creates a CS2 child.

    Keep this claim through the request's finally/restore path, including gaps
    between recording demos. A Steam launcher PID alone is not a reliable
    liveness check for the eventual cs2.exe.
    """
    with _claim_lock:
        if _owner is not None:
            _owner["cs2_launched"] = True
            _owner["cs2_pid"] = pid


def prepare_app_exit() -> dict[str, object]:
    """Reserve shutdown atomically against new recording/playback requests."""
    from .cs2_config_backup import is_cs2_running
    from .demo_playback_service import demo_playback_service

    global _closing
    with _claim_lock:
        # Playback outlives its HTTP request; its own session stays active until
        # player configs, gameinfo.gi, VPK and temporary files finish cleanup.
        owner = dict(_owner) if _owner else demo_playback_service.exit_blocker()
        if owner is None:
            _closing = True
            return {"allowed": True, "reason": None, "message": ""}

    # Do not infer ownership from the presence of an arbitrary cs2.exe. Only
    # query liveness once a successful Insight launch is associated with work
    # that still owns cleanup. Idle Insight never blocks a user's own CS2.
    running = bool(owner.get("cs2_launched") and is_cs2_running())
    return {
        "allowed": False,
        "reason": "managed_cs2_running" if running else "session_busy",
        "owner": owner,
        "message": (
            "Insight 启动的 CS2 仍在运行，暂时无法关闭 Insight。\n\n"
            "请先在 Insight 中停止录制，或关闭本次播放的 CS2，"
            "等待 gameinfo.gi、VPK 和玩家配置恢复后再关闭。"
            if running else
            "Insight 正在准备录制／播放或恢复游戏文件，暂时无法关闭。\n\n"
            "请等待操作完成；录制任务可先在 Insight 中停止，"
            "待 gameinfo.gi、VPK 和玩家配置恢复后再关闭。"
        ),
    }
