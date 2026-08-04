"""Steam Web API proxy for CS2 official match history."""
from __future__ import annotations

import asyncio
import bz2
import logging
import os
import time
import uuid
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import httpx

logger = logging.getLogger(__name__)

STEAM_API_BASE = "https://api.steampowered.com"
STEAM_COMMUNITY_BASE = "https://steamcommunity.com"
STEAM_ID64_ACCOUNT_BASE = 76561197960265728
_STEAM_AVATAR_CACHE_TTL_SECS = 24 * 3600
_STEAM_AVATAR_FAILURE_TTL_SECS = 10 * 60
_steam_public_profile_cache: dict[str, tuple[float, dict | None]] = {}
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


async def fetch_player_summaries(api_key: str, steam_ids64: list[str]) -> list[dict]:
    steam_ids = [str(value).strip() for value in steam_ids64 if str(value).strip()][:100]
    if not steam_ids:
        return []
    url = f"{STEAM_API_BASE}/ISteamUser/GetPlayerSummaries/v002/"
    params = {"key": api_key, "steamids": ",".join(steam_ids)}
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
    return resp.json().get("response", {}).get("players") or []


async def fetch_player_summary(api_key: str, steam_id64: str) -> dict:
    players = await fetch_player_summaries(api_key, [steam_id64])
    return players[0] if players else {}


def _official_steam_avatar_url(value: object) -> str:
    """Return only Steam-owned avatar CDN URLs supplied by Steam public pages."""
    url = str(value or "").strip()
    if url.startswith("//"):
        url = f"https:{url}"
    try:
        parsed = urlparse(url)
    except ValueError:
        return ""
    host = (parsed.hostname or "").lower()
    allowed = (
        host == "steamcdn-a.akamaihd.net"
        or host.endswith(".steamstatic.com")
        or host == "avatars.cloudflare.steamstatic.com"
    )
    return url if parsed.scheme == "https" and allowed else ""


def _official_steam_animated_avatar_url(value: object) -> str:
    url = _official_steam_avatar_url(value)
    if not url:
        return ""
    return url if urlparse(url).path.lower().endswith(".gif") else ""


def _animated_avatar_url_from_image_attributes(attributes: dict[str, str | None]) -> str:
    for attribute in ("src", "data-src", "srcset", "data-srcset"):
        for source in str(attributes.get(attribute) or "").split(","):
            candidate = source.strip().split(maxsplit=1)[0] if source.strip() else ""
            animated_url = _official_steam_animated_avatar_url(candidate)
            if animated_url:
                return animated_url
    return ""


class _SteamProfileAnimatedAvatarParser(HTMLParser):
    """Extract the animated avatar nested inside Steam's profile avatar container."""

    _VOID_TAGS = {
        "area", "base", "br", "col", "embed", "hr", "img",
        "input", "link", "meta", "source", "track", "wbr",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.avatar_url = ""
        self._container_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        classes = str(attributes.get("class") or "").split()
        if self._container_depth == 0 and "playerAvatarAutoSizeInner" in classes:
            self._container_depth = 1
        elif self._container_depth and tag not in self._VOID_TAGS:
            self._container_depth += 1

        if self._container_depth and tag == "img" and not self.avatar_url:
            self.avatar_url = _animated_avatar_url_from_image_attributes(attributes)

    def handle_endtag(self, _tag: str) -> None:
        if self._container_depth:
            self._container_depth -= 1


def _animated_avatar_url_from_profile_html(profile_html: str) -> str:
    parser = _SteamProfileAnimatedAvatarParser()
    parser.feed(str(profile_html or ""))
    parser.close()
    return parser.avatar_url


async def fetch_public_player_summaries(steam_ids64: list[str]) -> list[dict]:
    """Resolve public static or animated avatars without requiring a Steam Web API key."""
    steam_ids = list(dict.fromkeys(
        str(value).strip()
        for value in steam_ids64
        if str(value).strip().isdigit() and 15 <= len(str(value).strip()) <= 20
    ))[:10]
    if not steam_ids:
        return []

    now = time.monotonic()
    resolved: dict[str, dict] = {}
    missing: list[str] = []
    for steam_id in steam_ids:
        cached = _steam_public_profile_cache.get(steam_id)
        if cached and cached[0] > now:
            if cached[1]:
                resolved[steam_id] = cached[1]
        else:
            missing.append(steam_id)

    fetched: list[tuple[str, dict | None]] = []
    if missing:
        headers = {
            "Accept": "application/json",
            "User-Agent": "CS2-Insight-Agent/2.4 Steam-avatar-resolver",
        }
        client = httpx.AsyncClient(timeout=8.0, follow_redirects=True, headers=headers)

        async def fetch_one(steam_id64: str) -> tuple[str, dict | None]:
            try:
                account_id = int(steam_id64) - STEAM_ID64_ACCOUNT_BASE
                if account_id < 0:
                    return steam_id64, None
            except (TypeError, ValueError):
                return steam_id64, None

            payload: dict = {}
            try:
                response = await client.get(f"{STEAM_COMMUNITY_BASE}/miniprofile/{account_id}/json")
                response.raise_for_status()
                decoded = response.json()
                if isinstance(decoded, dict):
                    payload = decoded
            except (httpx.HTTPError, TypeError, ValueError):
                logger.debug("Public Steam mini-profile unavailable for %s", steam_id64, exc_info=True)

            avatar_url = _official_steam_avatar_url(
                payload.get("avatar_url") or payload.get("avatarfull")
            )
            if not _official_steam_animated_avatar_url(avatar_url):
                try:
                    profile_response = await client.get(
                        f"{STEAM_COMMUNITY_BASE}/profiles/{steam_id64}/",
                        headers={"Accept": "text/html,application/xhtml+xml"},
                    )
                    profile_response.raise_for_status()
                    animated_url = _animated_avatar_url_from_profile_html(profile_response.text)
                    if animated_url:
                        avatar_url = animated_url
                except httpx.HTTPError:
                    logger.debug("Public Steam profile unavailable for %s", steam_id64, exc_info=True)

            if not avatar_url:
                return steam_id64, None
            return steam_id64, {
                "steamid": steam_id64,
                "personaname": str(payload.get("persona_name") or payload.get("personaname") or ""),
                "avatarfull": avatar_url,
            }

        async with client:
            fetched = await asyncio.gather(*(fetch_one(steam_id) for steam_id in missing))

    for steam_id, player in fetched:
        ttl = _STEAM_AVATAR_CACHE_TTL_SECS if player else _STEAM_AVATAR_FAILURE_TTL_SECS
        _steam_public_profile_cache[steam_id] = (now + ttl, player)
        if player:
            resolved[steam_id] = player
    return [resolved[steam_id] for steam_id in steam_ids if steam_id in resolved]


def _decompress_bz2_atomic(compressed_path: Path, destination: Path) -> None:
    """Decompress into a sibling temporary file and publish only on success."""
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.partial")
    try:
        with bz2.open(compressed_path, "rb") as source, temporary.open("wb") as target:
            while chunk := source.read(1024 * 1024):
                target.write(chunk)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def _decompress_download(compressed_path: Path, destination: Path) -> None:
    """Finish one downloaded archive and always retire its temporary source."""
    try:
        _decompress_bz2_atomic(compressed_path, destination)
    finally:
        compressed_path.unlink(missing_ok=True)


async def download_demo(demo_url: str, dest_dir: Path, filename: str) -> Path:
    """Download a .bz2 demo and decompress into dest_dir. Returns the .dem path."""
    dest_dir.mkdir(parents=True, exist_ok=True)
    dem_path = dest_dir / filename

    if dem_path.exists():
        return dem_path

    compressed_path = dest_dir / f".{filename}.{uuid.uuid4().hex}.bz2.partial"
    try:
        async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
            async with client.stream("GET", demo_url) as resp:
                resp.raise_for_status()
                with compressed_path.open("wb") as writer:
                    async for chunk in resp.aiter_bytes(chunk_size=1024 * 1024):
                        await asyncio.to_thread(writer.write, chunk)
                    await asyncio.to_thread(writer.flush)
                    await asyncio.to_thread(os.fsync, writer.fileno())

        await asyncio.to_thread(_decompress_download, compressed_path, dem_path)
        return dem_path
    finally:
        try:
            compressed_path.unlink(missing_ok=True)
        except OSError:
            # Cancellation cannot stop an already-running worker thread. That
            # worker owns the same cleanup after it closes the archive.
            logger.debug("deferred compressed demo cleanup: %s", compressed_path)
