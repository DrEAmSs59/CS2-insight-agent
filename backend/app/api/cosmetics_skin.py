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

from ..api_errors import error_detail
from ..cosmetics_skin_plan import (
    CosmeticsSkinPlanError,
    build_batch_and_plan,
    build_batch_from_plan_json,
    filter_plan_by_succeeded_item_ids,
    map_item_statuses,
)
from ..databases import demo_db
from ..demo_cache import copy_original_to_temp_input, ensure_row_cached, file_md5
from ..demo_compat_service import ensure_demo_compatible
from ..skin_core_client import SkinCoreError, SkinCoreNotFound, run_rewrite_owned_batch

router = APIRouter(tags=["cosmetics-skin"])
logger = logging.getLogger(__name__)

_ERR_SKIN_CORE_UNAVAILABLE = "COSMETICS_SKIN_CORE_UNAVAILABLE"
_ERR_SKIN_REWRITE_FAILED = "COSMETICS_SKIN_REWRITE_FAILED"
_ERR_SKIN_ITEM_FAILED = "COSMETICS_SKIN_ITEM_FAILED"


class CustomSkinPlanBody(BaseModel):
    steamid: str = Field(..., min_length=1)
    replacements: dict[str, Any] = Field(..., min_length=1)
    # First-seen demo skins per slot (UI snapshots). Optional; used for plan display.
    originals: dict[str, Any] | None = None


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


def _run_one_owned_batch(
    *,
    input_dem: Path,
    output_dem: Path,
    steam_id64: str,
    items: list[dict[str, Any]],
) -> dict[str, Any]:
    """Invoke skin-core once; raise SkinCore* / Exception for the caller to map."""
    skin_result = run_rewrite_owned_batch(
        input_dem=str(input_dem),
        output_dem=str(output_dem),
        steam_id64=steam_id64,
        items=items,
        demoparser2_python=sys.executable,
    )
    if not isinstance(skin_result, dict):
        raise SkinCoreError("skin-core rewrite failed")
    return skin_result


def _map_skin_core_call_error(
    exc: Exception,
    *,
    demo_id: int,
    steamid: str,
    phase: str,
) -> HTTPException:
    logger.error(
        "skin-core call failed: demo_id=%s steamid=%s phase=%s",
        demo_id,
        steamid,
        phase,
        exc_info=(type(exc), exc, exc.__traceback__),
    )
    if isinstance(exc, SkinCoreNotFound):
        return HTTPException(503, error_detail(_ERR_SKIN_CORE_UNAVAILABLE))
    return HTTPException(502, error_detail(_ERR_SKIN_REWRITE_FAILED))


def _log_skin_core_result_failure(
    result: Any,
    *,
    demo_id: int,
    steamid: str,
    phase: str,
) -> None:
    logger.error(
        "skin-core returned failure: demo_id=%s steamid=%s phase=%s response=%r",
        demo_id,
        steamid,
        phase,
        result,
    )


def _sanitize_failed_item_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep item identity/display fields while removing skin-core internals."""
    sanitized: list[dict[str, Any]] = []
    for row in rows:
        public_row = dict(row)
        public_row.pop("error", None)
        public_row["error_code"] = _ERR_SKIN_ITEM_FAILED
        sanitized.append(public_row)
    return sanitized


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

    Always rebuilds from the library original so prior cache pollution cannot
    compound. Re-applies every other stored plan for this demo first, then the
    current player's batch — otherwise a second player's save would wipe the
    first player's demo edits.

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
        # Preserve any prior successful rewrite in cached_path until this POST succeeds.
        cached_path = await ensure_row_cached(demo_db, row)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc

    result = await demo_db.get_result(original_path)
    inventory = _inventory_for_steamid(result, steamid)
    # Load once before validation.  The current player's persisted plan is the
    # trusted T/CT provenance for owned entities whose observed side disappears
    # after the rewritten demo is analyzed again.
    stored_plans = await demo_db.list_custom_skin_plans_for_demo(original_path)
    trusted_plan: dict[str, Any] | None = None
    for stored in stored_plans:
        if str(stored.get("steamid") or "").strip() != steamid:
            continue
        candidate = stored.get("plan_json")
        if isinstance(candidate, dict):
            trusted_plan = candidate
        break
    try:
        batch_items, plan_json = build_batch_and_plan(
            steamid,
            inventory,
            body.replacements,
            originals=body.originals,
            trusted_plan=trusted_plan,
        )
    except CosmeticsSkinPlanError as exc:
        logger.warning(
            "cosmetics plan validation failed: demo_id=%s steamid=%s slots=%s error=%s",
            demo_id,
            steamid,
            sorted(str(key) for key in body.replacements),
            exc,
        )
        raise HTTPException(400, str(exc)) from exc

    # Other players' persisted plans must be re-applied onto the original before
    # this player's pass; skin-core accepts one steamid per call.
    prior_passes: list[tuple[str, list[dict[str, Any]]]] = []
    for stored in stored_plans:
        other_steamid = str(stored.get("steamid") or "").strip()
        if not other_steamid or other_steamid == steamid:
            continue
        other_plan = stored.get("plan_json")
        if not isinstance(other_plan, dict):
            continue
        other_inventory = _inventory_for_steamid(result, other_steamid)
        try:
            other_batch = build_batch_from_plan_json(other_plan, other_inventory)
        except CosmeticsSkinPlanError as exc:
            logger.error(
                "stored cosmetics plan could not be rebuilt: demo_id=%s steamid=%s",
                demo_id,
                other_steamid,
                exc_info=(type(exc), exc, exc.__traceback__),
            )
            raise HTTPException(500, error_detail(_ERR_SKIN_REWRITE_FAILED)) from exc
        if other_batch:
            prior_passes.append((other_steamid, other_batch))

    original = Path(original_path)
    temp_in: Path | None = None
    intermediate_temps: list[Path] = []
    temp_out = _temp_output_path(cached_path)
    replaced = False
    try:
        try:
            temp_in = await asyncio.to_thread(
                copy_original_to_temp_input,
                original,
                cached_path.parent,
            )
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc

        await asyncio.to_thread(ensure_demo_compatible, temp_in)

        current_input = temp_in
        for other_steamid, other_batch in prior_passes:
            prior_out = _temp_output_path(cached_path)
            intermediate_temps.append(prior_out)
            try:
                prior_result = await asyncio.to_thread(
                    _run_one_owned_batch,
                    input_dem=current_input,
                    output_dem=prior_out,
                    steam_id64=other_steamid,
                    items=other_batch,
                )
            except Exception as exc:
                raise _map_skin_core_call_error(
                    exc,
                    demo_id=int(demo_id),
                    steamid=other_steamid,
                    phase="reapply",
                ) from exc
            if prior_result.get("ok") is not True:
                _log_skin_core_result_failure(
                    prior_result,
                    demo_id=int(demo_id),
                    steamid=other_steamid,
                    phase="reapply",
                )
                raise HTTPException(502, error_detail(_ERR_SKIN_REWRITE_FAILED))
            if not prior_out.is_file():
                logger.error(
                    "skin-core produced no reapply output: demo_id=%s steamid=%s path=%s",
                    demo_id,
                    other_steamid,
                    prior_out,
                )
                raise HTTPException(502, error_detail(_ERR_SKIN_REWRITE_FAILED))
            if current_input is not temp_in:
                _cleanup_temp(current_input)
            current_input = prior_out

        try:
            skin_result = await asyncio.to_thread(
                _run_one_owned_batch,
                input_dem=current_input,
                output_dem=temp_out,
                steam_id64=steamid,
                items=batch_items,
            )
        except Exception as exc:
            raise _map_skin_core_call_error(
                exc,
                demo_id=int(demo_id),
                steamid=steamid,
                phase="rewrite",
            ) from exc

        succeeded_raw = skin_result.get("succeeded")
        failed_raw = skin_result.get("failed")
        succeeded_mapped = map_item_statuses(
            plan_json, succeeded_raw if isinstance(succeeded_raw, list) else []
        )
        failed_mapped = map_item_statuses(
            plan_json, failed_raw if isinstance(failed_raw, list) else []
        )
        failed_public = _sanitize_failed_item_rows(failed_mapped)
        if failed_mapped and skin_result.get("ok") is True:
            _log_skin_core_result_failure(
                skin_result,
                demo_id=int(demo_id),
                steamid=steamid,
                phase="rewrite-partial",
            )
        succeeded_ids = {
            str(row.get("item_id64") or "").strip()
            for row in (succeeded_raw if isinstance(succeeded_raw, list) else [])
            if isinstance(row, dict) and str(row.get("item_id64") or "").strip()
        }
        # Legacy responses without succeeded[]: treat full plan as succeeded when ok.
        if not succeeded_ids and skin_result.get("ok") is True:
            succeeded_ids = {
                str(item.get("item_id64") or "").strip()
                for item in batch_items
                if isinstance(item, dict) and str(item.get("item_id64") or "").strip()
            }
            if not succeeded_mapped:
                succeeded_mapped = map_item_statuses(
                    plan_json,
                    [
                        {
                            "item_id64": str(item.get("item_id64") or ""),
                            "definition_index": item.get("definition_index"),
                            "team": item.get("team"),
                        }
                        for item in batch_items
                        if isinstance(item, dict)
                    ],
                )

        filtered_plan = filter_plan_by_succeeded_item_ids(
            plan_json,
            succeeded_ids,
            succeeded_rows=succeeded_raw if isinstance(succeeded_raw, list) else [],
        )

        # Soft all-fail: structured failed[] with ok:false — do not replace cache.
        if skin_result.get("ok") is not True:
            _log_skin_core_result_failure(
                skin_result,
                demo_id=int(demo_id),
                steamid=steamid,
                phase="rewrite",
            )
            if failed_mapped or succeeded_mapped:
                return {
                    "ok": False,
                    "partial": False,
                    "demo_id": int(demo_id),
                    "plan": None,
                    "succeeded": succeeded_mapped,
                    "failed": failed_public,
                    "error_code": _ERR_SKIN_REWRITE_FAILED,
                }
            raise HTTPException(502, error_detail(_ERR_SKIN_REWRITE_FAILED))

        if not temp_out.is_file():
            logger.error(
                "skin-core reported success without output: demo_id=%s steamid=%s path=%s",
                demo_id,
                steamid,
                temp_out,
            )
            raise HTTPException(502, error_detail(_ERR_SKIN_REWRITE_FAILED))

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
            filtered_plan,
            output_sha256=output_sha256,
        )

        return {
            "ok": True,
            "partial": bool(failed_mapped),
            "demo_id": int(demo_id),
            "cached_path": str(cached_path),
            "output_sha256": output_sha256,
            "plan": filtered_plan,
            "succeeded": succeeded_mapped,
            "failed": failed_public,
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(
            "unexpected cosmetics rewrite failure: demo_id=%s steamid=%s",
            demo_id,
            steamid,
            exc_info=(type(exc), exc, exc.__traceback__),
        )
        raise HTTPException(500, error_detail(_ERR_SKIN_REWRITE_FAILED)) from exc
    finally:
        if temp_in is not None:
            _cleanup_temp(temp_in)
        for path in intermediate_temps:
            _cleanup_temp(path)
        if not replaced:
            _cleanup_temp(temp_out)
