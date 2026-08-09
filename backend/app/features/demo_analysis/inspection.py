"""Demo path resolution and isolated metadata inspection."""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException

from ...databases import demo_db
from ...demo_cache import ensure_row_cached
from ...demo_paths import UPLOAD_DIR, resolve_demo_path, resolve_working_demo_path

logger = logging.getLogger(__name__)


def resolve_spectator_for_demo(demo_path: Path, requested: Optional[str]) -> Optional[str]:
    """Resolve a requested player name against the demo roster."""
    from ...demo_parse_isolation import get_player_list_isolated

    raw = (requested or "").strip()
    if not raw:
        return None
    lowered = raw.lower()
    roster = get_player_list_isolated(str(demo_path))
    names = [
        str(player["name"]).strip()
        for player in roster
        if player.get("name") and str(player["name"]).strip()
    ]
    if names:
        if raw in names:
            return raw
        for name in names:
            if name.lower() == lowered:
                logger.info("spectator 名称大小写归一: %r -> %r", raw, name)
                return name

        junk = frozenset({"error", "null", "undefined", "nan", "none", "true", "false"})
        if lowered in junk or "traceback" in lowered:
            logger.warning("忽略无效的 spectator 名称: %r", raw)
            return None
        logger.warning(
            "spectator 不在本 Demo 玩家名单中，将跳过 spec_player: %r（共 %d 名玩家）",
            raw,
            len(names),
        )
        return None

    logger.warning("本 Demo 未能生成玩家名单，仍使用 spectator: %r", raw)
    return raw


def resolve_uploaded_demo_path(path: str) -> Path:
    """Accept an absolute path or a filename relative to the upload directory."""
    return resolve_demo_path(path, upload_dir=UPLOAD_DIR)


async def resolve_uploaded_demo_path_async(path: str) -> Path:
    """Resolve a library demo through its working cache when available."""
    return await resolve_working_demo_path(path, demo_db=demo_db, upload_dir=UPLOAD_DIR)


async def library_working_demo_path(row: dict[str, Any]) -> Path:
    try:
        return await ensure_row_cached(demo_db, row)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc


def analyze_demo_sync(
    demo_path: str,
    target_player: str,
    freeze_to_death_rounds: Optional[list[int]] = None,
) -> dict:
    """Parse in a child process so a native parser crash cannot kill FastAPI."""
    from ...demo_parse_isolation import analyze_demo_isolated

    return analyze_demo_isolated(demo_path, target_player, freeze_to_death_rounds)


def demo_inspect_concurrency() -> int:
    try:
        configured = int(os.environ.get("CS2_INSIGHT_DEMO_INSPECT_CONCURRENCY", "2"))
    except ValueError:
        configured = 2
    return max(1, min(4, configured))


async def inspect_demo_meta(demo_path: Path) -> tuple[list[dict], dict]:
    from ...demo_parse_isolation import inspect_demo_isolated

    inspection = await asyncio.to_thread(inspect_demo_isolated, str(demo_path))
    players = inspection.get("players")
    match_meta = inspection.get("match_meta")
    if not isinstance(players, list) or not isinstance(match_meta, dict):
        raise ValueError("Demo inspection returned invalid metadata")
    return players, match_meta


def demo_failure_code(error: BaseException, phase: str) -> str:
    if isinstance(error, FileNotFoundError):
        return "DEMO_FILE_NOT_FOUND"
    text = str(error).casefold()
    if "not a .dem file" in text or "only .dem" in text:
        return "DEMO_INVALID_EXTENSION"
    if any(marker in text for marker in ("not found", "no such file", "找不到", "不存在")):
        return "DEMO_FILE_NOT_FOUND"
    if "timeout" in text or "timed out" in text or "超时" in text:
        return {
            "inspection": "DEMO_INSPECTION_TIMEOUT",
            "analysis": "DEMO_ANALYSIS_TIMEOUT",
        }.get(phase, "DEMO_PREPARE_FAILED")
    return {
        "prepare": "DEMO_PREPARE_FAILED",
        "inspection": "DEMO_INSPECTION_FAILED",
        "analysis": "DEMO_ANALYSIS_FAILED",
        "save": "DEMO_ANALYSIS_SAVE_FAILED",
    }.get(phase, "DEMO_ANALYSIS_FAILED")


def demo_failure_item(
    filename: str,
    error: BaseException,
    phase: str,
    *,
    demo_id: Optional[int] = None,
) -> dict:
    item = {
        "filename": str(filename or "Demo"),
        "code": demo_failure_code(error, phase),
    }
    if demo_id is not None:
        item["id"] = int(demo_id)
    return item


async def safe_upload_demo_meta(demo_path: Path) -> tuple[list[dict], dict, Optional[str]]:
    """Return metadata or a stable public error code while keeping a batch alive."""
    try:
        players, match_meta = await inspect_demo_meta(demo_path)
        if not players:
            logger.warning("Demo inspection returned no players for %s", demo_path)
            return [], match_meta, "DEMO_INSPECTION_FAILED"
        return players, match_meta, None
    except Exception as exc:  # noqa: BLE001
        logger.exception("Upload metadata inspection failed for %s: %s", demo_path, exc)
        return [], {}, demo_failure_code(exc, "inspection")
