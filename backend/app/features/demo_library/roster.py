"""Versioned player-roster indexing for Demo Library entries."""

from __future__ import annotations

import asyncio
import logging
import os
import weakref
from pathlib import Path
from typing import Any, Optional

from ...databases import demo_db
from ...demo_library_hub import demo_library_hub

logger = logging.getLogger(__name__)
_demo_roster_locks: weakref.WeakValueDictionary[int, asyncio.Lock] = weakref.WeakValueDictionary()
_DEMO_ROSTER_CACHE_VERSION = 3

def _demo_roster_source_fingerprint(demo_path: str) -> tuple[str, int | None, int | None]:
    normalized_path = os.path.normcase(os.path.abspath(os.fspath(demo_path)))
    try:
        stat = Path(demo_path).stat()
        return normalized_path, int(stat.st_size), int(stat.st_mtime_ns)
    except OSError:
        return normalized_path, None, None


async def persist_ingested_demo(
    demo_id: int,
    demo_path: str,
    *,
    players: list[dict[str, Any]],
    meta: dict[str, Any],
    source: str | None,
    parsed_at: str,
) -> dict[str, Any]:
    """Persist metadata, roster rows/cache, and status in one transaction."""
    normalized_path, file_size, mtime_ns = _demo_roster_source_fingerprint(demo_path)
    await demo_db.persist_demo_ingest(
        demo_id,
        demo_path,
        meta=meta,
        source=source,
        players=players,
        roster_demo_path=normalized_path,
        roster_cache_version=_DEMO_ROSTER_CACHE_VERSION,
        source_file_size=file_size,
        source_mtime_ns=mtime_ns,
        parsed_at=parsed_at,
    )
    return {
        "indexed": True,
        "player_count": len(players),
        "players": players,
        "error": None,
    }


async def index_demo_player_stats(
    demo_id: int,
    demo_path: str,
    *,
    precomputed_players: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    from ...demo_parse_isolation import get_player_list_isolated

    normalized_path, file_size, mtime_ns = _demo_roster_source_fingerprint(demo_path)
    try:
        raw: Any = (
            precomputed_players
            if precomputed_players is not None
            else await asyncio.to_thread(get_player_list_isolated, demo_path)
        )
        if isinstance(raw, dict):
            players = raw.get("players") or raw.get("roster") or []
        elif isinstance(raw, list):
            players = raw
        else:
            players = []
        if isinstance(players, dict):
            players = list(players.values())
        if not isinstance(players, list):
            players = []
        await demo_db.replace_demo_player_stats(demo_id, demo_path, players)
        await demo_db.save_demo_roster_cache(
            demo_id,
            normalized_path,
            cache_version=_DEMO_ROSTER_CACHE_VERSION,
            source_file_size=file_size,
            source_mtime_ns=mtime_ns,
            state="ready" if players else "empty",
            row_count=len(players),
        )
        return {
            "indexed": True,
            "player_count": len(players),
            "players": players,
            "error": None,
        }
    except Exception as exc:
        logger.warning("Failed to index player stats for demo %s: %s", demo_id, exc)
        try:
            await demo_db.replace_demo_player_stats(demo_id, demo_path, [])
            await demo_db.save_demo_roster_cache(
                demo_id,
                normalized_path,
                cache_version=_DEMO_ROSTER_CACHE_VERSION,
                source_file_size=file_size,
                source_mtime_ns=mtime_ns,
                state="error",
                row_count=0,
                error_msg=str(exc),
            )
        except Exception:
            logger.exception("Failed to persist roster error state for demo %s", demo_id)
        return {
            "indexed": False,
            "player_count": 0,
            "players": [],
            "error": str(exc),
        }


def _roster_rows_for_api(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalize persisted player stats to the roster shape returned by demoparser."""

    out: list[dict[str, Any]] = []
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or raw.get("player_name") or "").strip()
        if not name:
            continue
        team = raw.get("team")
        if team is None:
            team = raw.get("team_number")
        try:
            team = int(team) if team is not None else 0
        except (TypeError, ValueError):
            team = 0
        raw_steam_id64 = raw.get("steam_id64") or raw.get("steamid64")
        raw_steam_id = raw.get("steam_id") or raw.get("steamid")
        steam_id64 = str(raw_steam_id64).strip() if raw_steam_id64 not in (None, "") else None
        steam_id = str(raw_steam_id).strip() if raw_steam_id not in (None, "") else None
        if steam_id64 is None and steam_id and steam_id.isdigit() and len(steam_id) >= 15:
            steam_id64 = steam_id
        if steam_id is None:
            steam_id = steam_id64
        account_id = raw.get("account_id")
        if account_id is None and steam_id64:
            try:
                derived = int(steam_id64) - 76561197960265728
                account_id = derived if derived >= 0 else None
            except (TypeError, ValueError):
                account_id = None
        user_id = raw.get("user_id")

        def integer(key: str) -> int:
            try:
                return int(raw.get(key) or 0)
            except (TypeError, ValueError):
                return 0

        kills = integer("kills")
        deaths = integer("deaths")
        assists = integer("assists")
        try:
            kd = float(raw.get("kd")) if raw.get("kd") is not None else kills / max(deaths, 1)
        except (TypeError, ValueError):
            kd = kills / max(deaths, 1)
        team_name = raw.get("team_name")
        out.append(
            {
                "name": name,
                "player_name": name,
                "player_key": (
                    f"steamid:{steam_id64}"
                    if steam_id64
                    else f"userid:{user_id}"
                    if user_id not in (None, "")
                    else f"name:{name.casefold()}"
                ),
                "team": team,
                "team_number": team,
                "team_name": str(team_name).strip() if team_name not in (None, "") else None,
                "player_color": str(raw.get("player_color") or "").strip().lower() or None,
                "steam_id": steam_id,
                "steam_id64": steam_id64,
                "steamid64": steam_id64,
                "account_id": str(account_id) if account_id not in (None, "") else None,
                "user_id": str(user_id) if user_id not in (None, "") else None,
                "kills": kills,
                "deaths": deaths,
                "assists": assists,
                "kd": round(kd, 3),
            }
        )
    return out


async def _read_valid_demo_roster_cache(
    demo_id: int,
    demo_path: str,
    *,
    cached_rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    metadata = await demo_db.get_demo_roster_cache(demo_id)
    if not metadata:
        return None
    normalized_path, file_size, mtime_ns = _demo_roster_source_fingerprint(demo_path)
    cached_path = os.path.normcase(os.path.abspath(str(metadata.get("demo_path") or "")))
    source_md5 = str(metadata.get("source_content_md5") or "").strip().lower()
    current_md5 = str(metadata.get("current_content_md5") or "").strip().lower()
    try:
        cache_version = int(metadata.get("cache_version"))
        cached_file_size = (
            int(metadata["source_file_size"])
            if metadata.get("source_file_size") is not None
            else None
        )
        cached_mtime_ns = (
            int(metadata["source_mtime_ns"])
            if metadata.get("source_mtime_ns") is not None
            else None
        )
        row_count = int(metadata.get("row_count") or 0)
    except (TypeError, ValueError):
        return None
    if (
        cache_version != _DEMO_ROSTER_CACHE_VERSION
        or cached_path != normalized_path
        or cached_file_size != file_size
        or cached_mtime_ns != mtime_ns
        or source_md5 != current_md5
    ):
        return None

    state = str(metadata.get("state") or "")
    if state == "empty" and row_count == 0:
        return {
            "players": [],
            "cache_hit": True,
            "indexed": True,
            "error": None,
        }
    if state == "error" and row_count == 0:
        return {
            "players": [],
            "cache_hit": True,
            "indexed": False,
            "error": str(metadata.get("error_msg") or "Demo 玩家名单解析失败"),
        }
    if state != "ready" or row_count <= 0:
        return None
    rows = cached_rows if cached_rows is not None else await demo_db.list_demo_player_stats(demo_id)
    players = _roster_rows_for_api(rows)
    if len(players) != row_count:
        return None
    return {
        "players": players,
        "cache_hit": True,
        "indexed": True,
        "error": None,
    }


async def get_or_index_demo_roster(
    demo_id: int,
    demo_path: str,
    *,
    parse_semaphore: asyncio.Semaphore | None = None,
    cached_rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Return a versioned roster cache, parsing the Demo once on a valid miss."""

    cached = await _read_valid_demo_roster_cache(
        demo_id,
        demo_path,
        cached_rows=cached_rows,
    )
    if cached is not None:
        return cached
    lock = _demo_roster_locks.get(demo_id)
    if lock is None:
        lock = asyncio.Lock()
        _demo_roster_locks[demo_id] = lock
    async with lock:
        # Recheck after acquiring the single-flight lock. Persisted empty and
        # error states stop concurrent waiters from serially repeating a parse.
        cached = await _read_valid_demo_roster_cache(demo_id, demo_path)
        if cached is not None:
            return cached
        if parse_semaphore is None:
            indexed = await index_demo_player_stats(demo_id, demo_path)
        else:
            async with parse_semaphore:
                indexed = await index_demo_player_stats(demo_id, demo_path)
        if indexed.get("indexed"):
            await demo_library_hub.notify("player_stats")
        return {
            "players": _roster_rows_for_api(indexed.get("players") or []),
            "cache_hit": False,
            "indexed": bool(indexed.get("indexed")),
            "error": indexed.get("error"),
        }
