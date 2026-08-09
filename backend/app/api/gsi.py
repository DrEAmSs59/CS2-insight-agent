"""Game State Integration readiness routes."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Body

from ..gsi_ready import gsi_status, notify_gsi_payload

router = APIRouter(prefix="/api/gsi", tags=["gsi"])


@router.post("/cs2")
async def cs2_gsi(payload: Optional[dict] = Body(default=None)):
    """Receive the CS2 GSI heartbeat used by the recording startup gate."""
    ready = notify_gsi_payload(payload or {})
    return {"ok": True, "ready": ready}


@router.get("/status")
def cs2_gsi_status():
    return gsi_status()
