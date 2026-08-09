"""Library-backed multi-player demo analysis workflow."""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException

from ...api_errors import error_detail
from ...databases import demo_db
from ...demo_db import utc_now_iso
from ...demo_library_hub import demo_library_hub
from ..demo_library.roster import get_or_index_demo_roster
from .inspection import demo_failure_code

logger = logging.getLogger(__name__)

async def run_library_demo_analyze(
    demo_id: int,
    dem_path: str | Path,
    target_players: list[str],
    freeze_to_death_rounds: Optional[list[int]] = None,
    locale: str = "zh",
) -> dict:
    # Working-cache path is for file I/O; demo_files.path remains the DB join key.
    working_path = os.fspath(dem_path)
    row = await demo_db.get_demo_by_id(demo_id)
    library_path = str(row.get("path") or "").strip() if row else ""
    if not library_path:
        library_path = working_path
    target_players = list(
        dict.fromkeys(
            str(player).strip()
            for player in target_players
            if str(player).strip()
        )
    )
    if not target_players:
        raise HTTPException(400, "target_players 不能为空")
    # 列表筛选 / PlayerSelect 依赖 demo_player_stats；缓存命中时不再重复扫描 Demo。
    idx = await get_or_index_demo_roster(demo_id, library_path)
    if idx.get("error"):
        logger.warning(
            "index_demo_player_stats before library analyze demo_id=%s: %s",
            demo_id,
            idx.get("error"),
        )
    await demo_db.update_status(library_path, "parsing", error_msg=None, parsed_at=None)
    players_out: dict = {}
    analysis_workspace = None
    try:
        from ...demo_parse_isolation import analyze_multi_isolated

        batch_result = await asyncio.to_thread(
            analyze_multi_isolated,
            working_path,
            target_players,
            freeze_to_death_rounds,
        )
        analysis_workspace = batch_result.pop("__analysis_workspace__", None)
        players_out = {p: v for p, v in batch_result.items() if isinstance(v, dict)}
        missing = [p for p in target_players if p not in players_out]
        if missing:
            logger.warning(
                "analyze_multi_isolated missing players demo_id=%s missing=%s",
                demo_id, missing,
            )
    except Exception as e:
        code = demo_failure_code(e, "analysis")
        logger.error("Library demo parse failed demo_id=%s path=%s: %s", demo_id, working_path, e)
        await demo_db.update_status(library_path, "error", error_msg=code, parsed_at=None)
        await demo_library_hub.notify("parse_error")
        raise HTTPException(500, error_detail(code)) from e

    if not players_out:
        code = "DEMO_ANALYSIS_EMPTY"
        await demo_db.update_status(library_path, "error", error_msg=code, parsed_at=None)
        await demo_library_hub.notify("parse_error")
        raise HTTPException(500, error_detail(code))

    first_player = next(
        (player for player in target_players if player in players_out),
        next(iter(players_out)),
    )
    first_pdata = players_out[first_player]
    players_payload = {p: dict(v) for p, v in players_out.items() if isinstance(v, dict)}
    analyzed_targets = [p for p in target_players if p in players_payload]
    analyzed_targets.extend(p for p in players_payload if p not in analyzed_targets)
    composite: dict[str, Any] = {
        "players": players_payload,
        "analysis_workspace": analysis_workspace if isinstance(analysis_workspace, dict) else None,
        "analyzed_target_players": analyzed_targets,
        "auto_target_player": first_player,
        # 兼容仍读取「顶层 clips / match_meta」的旧逻辑（列表、SSE、部分 UI）
        "clips": first_pdata.get("clips") or [],
        "match_meta": first_pdata.get("match_meta"),
        "timeline": first_pdata.get("timeline"),
        "round_timeline": first_pdata.get("round_timeline"),
    }
    try:
        # save_result replaces the previous snapshot transactionally; the old
        # result remains readable until the new parse is complete.
        await demo_db.save_result(
            library_path,
            composite,
            timeline_results=players_out,
        )
        await demo_db.update_status(library_path, "done", error_msg=None, parsed_at=utc_now_iso())
    except Exception as e:
        code = demo_failure_code(e, "save")
        logger.exception("Library demo result commit failed demo_id=%s path=%s", demo_id, library_path)
        await demo_db.update_status(library_path, "error", error_msg=code, parsed_at=None)
        await demo_library_hub.notify("parse_error")
        raise HTTPException(500, error_detail(code)) from e
    await demo_library_hub.notify("analyzed")
    return {
        "players": players_out,
        "analysis_workspace": analysis_workspace if isinstance(analysis_workspace, dict) else None,
        "demo_path": library_path,
    }
