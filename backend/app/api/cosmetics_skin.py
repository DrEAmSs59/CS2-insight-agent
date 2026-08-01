# ---------------------------------------------------------------------------------------------
# Copyright (c) unicbm. All rights reserved.
# Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
# ---------------------------------------------------------------------------------------------

"""Cosmetics custom-plan HTTP routes: rewrite demo cache + persist display plan."""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..cosmetics_skin_plan import CosmeticsSkinPlanError, build_batch_and_plan
from ..databases import demo_db
from ..demo_cache import ensure_row_cached, file_md5
from ..demo_compat_service import ensure_demo_compatible
from ..skin_core_client import SkinCoreError, SkinCoreNotFound, run_rewrite_owned_batch

router = APIRouter(tags=["cosmetics-skin"])
logger = logging.getLogger(__name__)


class CustomSkinPlanBody(BaseModel):
    steamid: str = Field(..., min_length=1)
    replacements: dict[str, Any] = Field(..., min_length=1)


def _inventory_for_steamid(result: dict[str, Any] | None, steamid: str) -> list[dict[str, Any]]:
    if not isinstance(result, dict):
        return []
    workspace = result.get("analysis_workspace")
    if not isinstance(workspace, dict):
        return []
    cosmetics = workspace.get("cosmetics")
    if not isinstance(cosmetics, dict):
        return []
    players = cosmetics.get("players")
    if not isinstance(players, dict):
        return []
    rows = players.get(str(steamid))
    return list(rows) if isinstance(rows, list) else []


def _temp_output_path(cached_path: Path) -> Path:
    """Sibling temp dem in the cache directory (must not exist yet for skin-core)."""
    return cached_path.parent / f".{cached_path.stem}.skin-rewrite-{uuid.uuid4().hex}.dem"


def _cleanup_temp(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        logger.warning("Failed to remove skin rewrite temp: %s", path)


def _skin_core_failure_message(skin_result: Any) -> str:
    """Build a 502 detail from skin-core response fields (fail-closed messaging)."""
    if not isinstance(skin_result, dict):
        return "skin-core rewrite failed"
    message = (
        skin_result.get("error_message")
        or skin_result.get("error")
        or skin_result.get("message")
        or "skin-core rewrite failed"
    )
    text = str(message).strip() or "skin-core rewrite failed"
    error_code = skin_result.get("error_code")
    if error_code is not None and str(error_code).strip():
        return f"{error_code}: {text}"
    return text


@router.get("/api/demos/{demo_id}/cosmetics/custom-plan")
async def get_custom_skin_plan(
    demo_id: int,
    steamid: str = Query(..., min_length=1),
):
    """Return persisted plan for one demo+player, or ``{ok:true, plan:null}``."""
    row = await demo_db.get_demo_by_id(int(demo_id))
    if not row:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    stored = await demo_db.get_custom_skin_plan(str(row["path"]), str(steamid))
    if not stored:
        return {"ok": True, "plan": None}
    return {
        "ok": True,
        "plan": stored["plan_json"],
        "output_sha256": stored.get("output_sha256"),
    }


@router.post("/api/demos/{demo_id}/cosmetics/custom-plan")
async def post_custom_skin_plan(demo_id: int, body: CustomSkinPlanBody):
    """Rewrite the demo working cache for one player and upsert the display plan.

    Never mutates the library original ``path``. Does not re-analyze.
    """
    row = await demo_db.get_demo_by_id(int(demo_id))
    if not row:
        raise HTTPException(404, f"Demo not found: {demo_id}")

    original_path = str(row["path"])
    steamid = str(body.steamid).strip()
    if not steamid:
        raise HTTPException(400, "steamid is required")

    try:
        cached_path = await ensure_row_cached(demo_db, row)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc

    await asyncio.to_thread(ensure_demo_compatible, cached_path)

    result = await demo_db.get_result(original_path)
    inventory = _inventory_for_steamid(result, steamid)
    try:
        batch_items, plan_json = build_batch_and_plan(steamid, inventory, body.replacements)
    except CosmeticsSkinPlanError as exc:
        raise HTTPException(400, str(exc)) from exc

    temp_out = _temp_output_path(cached_path)
    replaced = False
    try:
        try:
            skin_result = await asyncio.to_thread(
                run_rewrite_owned_batch,
                input_dem=str(cached_path),
                output_dem=str(temp_out),
                steam_id64=steamid,
                items=batch_items,
                demoparser2_python=sys.executable,
            )
        except SkinCoreNotFound as exc:
            raise HTTPException(503, str(exc)) from exc
        except SkinCoreError as exc:
            raise HTTPException(502, str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 - surface unexpected launcher failures
            raise HTTPException(502, f"skin-core failed: {exc}") from exc

        if not isinstance(skin_result, dict) or skin_result.get("ok") is not True:
            raise HTTPException(502, _skin_core_failure_message(skin_result))

        if not temp_out.is_file():
            raise HTTPException(502, "skin-core produced no output demo")

        os.replace(temp_out, cached_path)
        replaced = True

        output_sha256 = str(
            skin_result.get("sha256") or skin_result.get("output_sha256") or ""
        ).strip() or None

        try:
            new_md5 = await asyncio.to_thread(file_md5, cached_path)
        except Exception:  # noqa: BLE001 - fingerprint update is best-effort
            logger.warning("Failed to hash rewritten cache for content_md5: %s", cached_path)
            new_md5 = None
        if new_md5:
            await demo_db.update_demo_content_md5(original_path, new_md5)

        await demo_db.upsert_custom_skin_plan(
            original_path,
            steamid,
            plan_json,
            output_sha256=output_sha256,
        )

        return {
            "ok": True,
            "demo_id": int(demo_id),
            "cached_path": str(cached_path),
            "output_sha256": output_sha256,
            "plan": plan_json,
        }
    finally:
        if not replaced:
            _cleanup_temp(temp_out)
