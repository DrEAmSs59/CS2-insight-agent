"""Steam match-history HTTP boundary."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import httpx
from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel

from ...databases import demo_db
from ...env_utils import load_config
from ...steam_match_history import (
    _official_steam_avatar_url,
    download_demo,
    fetch_match_history,
    fetch_player_summaries,
    fetch_player_summary,
    fetch_public_player_summaries,
    game_type_to_mode,
    parse_match_row,
)
from ..demo_library.ingestion import enqueue_demo_path

logger = logging.getLogger(__name__)
router = APIRouter(tags=["match-history"])


class MatchHistoryDownloadBody(BaseModel):
    demo_url: str
    match_id: str
    filename: str


@router.get("/api/match-history/matches")
async def get_match_history():
    cfg = load_config()
    if not cfg.steam_api_key or not cfg.steam_id64:
        raise HTTPException(400, "Steam API Key 和 SteamID64 未配置，请先保存凭据")

    try:
        raw_matches, player = await asyncio.gather(
            fetch_match_history(cfg.steam_api_key, cfg.steam_id64, cfg.match_count),
            fetch_player_summary(cfg.steam_api_key, cfg.steam_id64),
        )
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        if status == 403:
            raise HTTPException(403, "Steam API Key 无效，请检查凭据") from exc
        if status == 429:
            raise HTTPException(429, "Steam API 请求频率超限，请稍后再试") from exc
        raise HTTPException(502, f"Steam API 返回 {status}") from exc
    except httpx.RequestError as exc:
        raise HTTPException(502, f"无法连接 Steam API: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(502, str(exc)) from exc

    parsed_rows: list[tuple[dict, str]] = []
    for match in raw_matches:
        watchable_info = match.get("watchablematchinfo") or {}
        mode = game_type_to_mode(int(watchable_info.get("game_type", 0)))
        if mode != cfg.match_mode:
            continue
        try:
            row = parse_match_row(match, player_index=0)
        except Exception:
            logger.exception("Failed to parse match %s", match.get("matchid"))
            continue
        demo_name = f"match730_{row['match_id']}.dem"
        parsed_rows.append((row, demo_name))

    existing_filenames = await demo_db.find_existing_filenames(
        demo_name for _, demo_name in parsed_rows
    )
    rows = []
    for row, demo_name in parsed_rows:
        row["demo_in_library"] = demo_name in existing_filenames
        rows.append(row)

    wins = sum(1 for row in rows if row["result"] == "win")
    losses = sum(1 for row in rows if row["result"] == "loss")
    total_kills = sum(row["kills"] for row in rows)
    total_deaths = sum(row["deaths"] for row in rows)
    total_hs = sum(row["headshot_kills"] for row in rows)
    total_damage = sum(row["damage"] for row in rows)
    total_rounds = sum(row["score_own"] + row["score_opp"] for row in rows)

    return {
        "player": {
            "name": player.get("personaname", ""),
            "avatar": player.get("avatarfull", ""),
            "steam_id64": cfg.steam_id64,
        },
        "stats_summary": {
            "wins": wins,
            "losses": losses,
            "avg_kd": round(total_kills / total_deaths, 2) if total_deaths else 0.0,
            "headshot_pct": round(total_hs / total_kills * 100) if total_kills else 0,
            "avg_adr": round(total_damage / total_rounds, 1) if total_rounds else 0.0,
            "rating": round(sum(row["rating"] for row in rows) / len(rows), 2) if rows else 0.0,
        },
        "matches": rows,
        "total": len(rows),
    }


@router.post("/api/match-history/test-connection")
async def test_steam_connection(body: dict = Body(...)):
    api_key = str(body.get("steam_api_key") or "").strip()
    steam_id64 = str(body.get("steam_id64") or "").strip()
    if not api_key or not steam_id64:
        raise HTTPException(400, "steam_api_key 和 steam_id64 不能为空")
    try:
        player = await fetch_player_summary(api_key, steam_id64)
    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        raise HTTPException(status, f"Steam API 返回 {status}") from exc
    except httpx.RequestError as exc:
        raise HTTPException(502, f"无法连接 Steam: {exc}") from exc
    if not player:
        raise HTTPException(404, "未找到该 SteamID 的玩家信息，请检查 SteamID64")
    return {
        "ok": True,
        "name": player.get("personaname", ""),
        "avatar": player.get("avatarfull", ""),
    }


@router.get("/api/steam/player-avatars")
async def get_steam_player_avatars(
    steam_ids: str = Query("", max_length=220),
):
    """Resolve optional Steam CDN avatars for one demo roster."""
    cfg = load_config()
    if not cfg.steam_cdn_assets_enabled:
        return {"enabled": False, "avatars": {}}

    unique_ids: list[str] = []
    for raw in steam_ids.split(","):
        value = raw.strip()
        if not value.isdigit() or not 15 <= len(value) <= 20 or value in unique_ids:
            continue
        unique_ids.append(value)
        if len(unique_ids) >= 10:
            break
    if not unique_ids:
        return {"enabled": True, "avatars": {}}

    players: list[dict] = []
    try:
        players = await fetch_public_player_summaries(unique_ids)
    except httpx.HTTPError as exc:
        logger.info("Public Steam avatar lookup unavailable: %s", exc)

    resolved_ids = {str(player.get("steamid") or "") for player in players}
    missing_ids = [steam_id for steam_id in unique_ids if steam_id not in resolved_ids]
    if missing_ids and cfg.steam_api_key:
        try:
            players.extend(await fetch_player_summaries(cfg.steam_api_key, missing_ids))
        except (httpx.HTTPError, ValueError) as exc:
            logger.info("Steam Web API avatar lookup unavailable: %s", exc)

    avatars: dict[str, str] = {}
    for player in players:
        steam_id = str(player.get("steamid") or "")
        avatar_url = _official_steam_avatar_url(player.get("avatarfull"))
        if steam_id in unique_ids and avatar_url:
            avatars[steam_id] = avatar_url
    return {"enabled": True, "avatars": avatars}


@router.post("/api/match-history/download")
async def download_match_demo(body: MatchHistoryDownloadBody):
    cfg = load_config()
    watch_paths = [path for path in cfg.demo_watch_paths if path.strip()]
    if not watch_paths:
        raise HTTPException(400, "未配置 Demo 库监听目录，请先在「Demo 库」设置监听路径")

    destination_dir = Path(watch_paths[0])
    requested_filename = Path(body.filename).name.strip()
    if not requested_filename or requested_filename in {".", ".."}:
        raise HTTPException(400, "Demo 文件名无效")
    filename = (
        requested_filename
        if requested_filename.lower().endswith(".dem")
        else requested_filename + ".dem"
    )
    try:
        demo_path = await download_demo(body.demo_url, destination_dir, filename)
    except httpx.HTTPStatusError as exc:
        raise HTTPException(502, f"下载失败，HTTP {exc.response.status_code}") from exc
    except httpx.RequestError as exc:
        raise HTTPException(502, f"下载超时或网络错误: {exc}") from exc
    except OSError as exc:
        raise HTTPException(500, f"文件写入失败: {exc}") from exc
    except Exception as exc:
        raise HTTPException(500, f"解压失败: {exc}") from exc

    await enqueue_demo_path(demo_path)
    return {"ok": True, "path": str(demo_path), "filename": filename}
