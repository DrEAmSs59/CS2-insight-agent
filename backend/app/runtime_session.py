"""Process-wide ownership guard for CS2/OBS mutating operations."""

from __future__ import annotations

from datetime import datetime, timezone
import threading
from typing import AsyncIterator
import uuid

from fastapi import HTTPException, Request


_claim_lock = threading.Lock()
_owner: dict[str, str] | None = None


async def runtime_session_dependency(request: Request) -> AsyncIterator[None]:
    global _owner
    claim = {
        "id": uuid.uuid4().hex,
        "operation": request.url.path,
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    with _claim_lock:
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
