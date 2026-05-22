"""Steam Web API proxy for CS2 official match history."""
from __future__ import annotations

import asyncio
import bz2
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

STEAM_API_BASE = "https://api.steampowered.com"
_MAP_NAMES: dict[int, str] = {
    0: "de_dust2",
    1: "de_inferno",
    2: "de_nuke",
    3: "de_vertigo",
    4: "de_ancient",
    5: "de_anubis",
    6: "de_mirage",
    7: "de_overpass",
    8: "de_train",
    9: "de_cache",
}
_DEMO_EXPIRY_SECS = 8 * 24 * 3600
_GAME_TYPE_PREMIER = 2048


# ---------- pure helpers ----------

def map_enum_to_name(enum_val: int) -> str:
    return _MAP_NAMES.get(enum_val, "unknown")


def game_type_to_mode(game_type: int) -> str:
    return "premier" if game_type == _GAME_TYPE_PREMIER else "competitive"


def is_demo_expired(match_time: int) -> bool:
    return (time.time() - match_time) > _DEMO_EXPIRY_SECS


def demo_expires_at_iso(match_time: int) -> str:
    ts = match_time + _DEMO_EXPIRY_SECS
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def calc_rating(kills: int, deaths: int, assists: int, rounds: int, damage: int) -> float:
    """Simplified HLTV Rating 2.0 approximation."""
    if rounds <= 0:
        return 0.0
    kpr = kills / rounds
    dpr = deaths / rounds
    apr = assists / rounds
    adr = damage / rounds
    impact = 2.13 * kpr + 0.42 * apr - 0.41
    return round(0.3591 * kpr - 0.5329 * dpr + 0.2372 * impact + 0.0032 * adr + 0.1587, 2)


def build_demo_url(match_id: str, reservation_id: str) -> str:
    try:
        # Valve routes demos across replay servers 131–140 by match_id modulo
        n = int(match_id) % 10 + 131
    except (ValueError, TypeError):
        n = 131
    return f"http://replay{n}.valve.net/730/{match_id}_{reservation_id}.dem.bz2"


def parse_match_row(raw: dict, player_index: int = 0) -> dict:
    """Transform a single Steam API match object into our frontend-ready dict."""
    match_id = str(raw.get("matchid", ""))
    match_time = int(raw.get("matchtime", 0))
    wmi = raw.get("watchablematchinfo") or {}
    game_type = int(wmi.get("game_type", 0))
    mode = game_type_to_mode(game_type)

    rounds_all = raw.get("roundstatsall") or []
    last = rounds_all[-1] if rounds_all else {}

    map_enum = int(last.get("map", -1))
    map_name = map_enum_to_name(map_enum)
    num_rounds = int(last.get("num_rounds") or 0)
    duration_sec = int(last.get("match_duration") or 0)
    team_scores = last.get("team_scores") or [0, 0]
    score_own = int(team_scores[0]) if team_scores else 0
    score_opp = int(team_scores[1]) if len(team_scores) > 1 else 0

    if score_own > score_opp:
        result = "win"
    elif score_own < score_opp:
        result = "loss"
    else:
        result = "tie"

    def _idx(lst: list, i: int, default=0):
        try:
            return lst[i] if lst else default
        except IndexError:
            return default

    kills = _idx(last.get("kills") or [], player_index)
    assists = _idx(last.get("assists") or [], player_index)
    deaths = _idx(last.get("deaths") or [], player_index)
    hs_kills = _idx(last.get("enemy_headshots") or [], player_index)
    enemy_kills = _idx(last.get("enemy_kills") or [], player_index)
    mvps = _idx(last.get("mvps") or [], player_index)
    damage_total = _idx(last.get("damage") or [], player_index, 0)

    hs_pct = round(hs_kills / kills * 100) if kills > 0 else 0
    adr = round(damage_total / num_rounds, 1) if num_rounds > 0 else 0.0
    rating = calc_rating(kills, deaths, assists, num_rounds, damage_total)

    reservation_id = str(last.get("reservation_id") or last.get("reservationid") or "")
    demo_url = build_demo_url(match_id, reservation_id) if reservation_id else None
    expired = is_demo_expired(match_time)

    played_at = datetime.fromtimestamp(match_time, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    rounds_strip: list[Optional[bool]] = []
    prev_own, prev_opp = 0, 0
    for r in rounds_all:
        ts = r.get("team_scores") or [0, 0]
        s_own = int(ts[0]) if ts else 0
        s_opp = int(ts[1]) if len(ts) > 1 else 0
        d_own = s_own - prev_own
        d_opp = s_opp - prev_opp
        if d_own > d_opp:
            rounds_strip.append(True)   # won this round
        elif d_own < d_opp:
            rounds_strip.append(False)  # lost this round
        else:
            rounds_strip.append(None)   # tie/no round
        prev_own, prev_opp = s_own, s_opp
    while len(rounds_strip) < 24:
        rounds_strip.append(None)
    rounds_strip = rounds_strip[:24]

    return {
        "match_id": match_id,
        "map": map_name,
        "mode": mode,
        "result": result,
        "score_own": score_own,
        "score_opp": score_opp,
        "duration_sec": duration_sec,
        "played_at": played_at,
        "rounds": rounds_strip,
        "kills": kills,
        "deaths": deaths,
        "assists": assists,
        "headshot_kills": hs_kills,
        "headshot_pct": hs_pct,
        "damage": damage_total,
        "adr": adr,
        "mvp_count": mvps,
        "rating": rating,
        "demo_url": demo_url,
        "demo_expired": expired,
        "demo_expires_at": demo_expires_at_iso(match_time) if demo_url else None,
        "demo_in_library": False,
    }


# ---------- async API calls ----------

async def fetch_match_history(api_key: str, steam_id64: str, count: int = 20) -> list[dict]:
    url = f"{STEAM_API_BASE}/ICSGOServers_730/GetMatchHistory/v001/"
    params = {"key": api_key, "steamid": steam_id64, "count": min(count, 100)}
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
    data = resp.json()
    result = data.get("result") or {}
    status = result.get("status")
    if status != 1:
        raise ValueError(f"Steam API status={status}")
    return result.get("matches") or []


async def fetch_player_summary(api_key: str, steam_id64: str) -> dict:
    url = f"{STEAM_API_BASE}/ISteamUser/GetPlayerSummaries/v002/"
    params = {"key": api_key, "steamids": steam_id64}
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
    players = resp.json().get("response", {}).get("players") or []
    return players[0] if players else {}


async def download_demo(demo_url: str, dest_dir: Path, filename: str) -> Path:
    """Download a .bz2 demo and decompress into dest_dir. Returns the .dem path."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    bz2_path = dest_dir / (filename + ".bz2")
    dem_path = dest_dir / filename

    if dem_path.exists():
        return dem_path

    async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
        async with client.stream("GET", demo_url) as resp:
            resp.raise_for_status()
            with open(bz2_path, "wb") as f:
                async for chunk in resp.aiter_bytes(chunk_size=65536):
                    f.write(chunk)

    # Stream decompress — avoids double-buffering full file in RAM
    with bz2.open(bz2_path, "rb") as src, open(dem_path, "wb") as dst:
        while chunk := src.read(65536):
            dst.write(chunk)
    bz2_path.unlink(missing_ok=True)
    return dem_path
