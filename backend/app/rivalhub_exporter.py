"""Assemble a RivalHub demo export zip from parsed event data."""

from __future__ import annotations

import io
import json
import math
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .demo_parse_isolation import run_parse_worker
from .file_hash import file_md5_hex, file_sha256_hex

SCHEMA_VERSION = "cs2-demo-format/2.0"
EXPORTER_NAME = "CS2 Insight Agent"


# ── public API ───────────────────────────────────────────────────────────────

def export_demo(dem_path: str) -> bytes:
    """Parse dem_path and return RivalHub zip as bytes. May raise IsolatedParseError."""
    path = Path(dem_path)
    try:
        demo_hash: str | None = file_sha256_hex(path)
    except Exception:
        demo_hash = None
    raw: dict[str, Any] = run_parse_worker("rivalhub_export", dem_path=dem_path)
    return _assemble_zip(raw, dem_path, demo_hash)


# ── zip assembly ─────────────────────────────────────────────────────────────

def _assemble_zip(raw: dict[str, Any], dem_path: str, demo_hash: str | None) -> bytes:
    players      = _build_players(raw)
    team_map     = _build_team_map(players)
    rounds, side_map = _build_rounds(raw, team_map)
    match_json   = _build_match(raw, rounds)
    kills        = _build_kills(raw, team_map, side_map)
    blinds_json  = _build_blinds(raw, team_map, side_map)
    player_stats = _build_player_stats(raw, team_map, side_map, rounds,
                                       kills_list=kills, blinds_list=blinds_json)
    damages      = _build_damages(raw, team_map, side_map)
    bombs        = _build_bombs(raw, team_map, side_map)
    grenades     = _build_grenades(raw, team_map, side_map)
    shots        = _build_shots(raw, team_map, side_map)
    positions    = _build_positions(raw, team_map, side_map)
    economies    = _build_economies(raw, team_map, side_map, rounds)
    clutches     = _build_clutches(kills, rounds, team_map)
    manifest     = _build_manifest(raw, dem_path, demo_hash, shots, positions)

    files: dict[str, Any] = {
        "manifest.json":         manifest,
        "match.json":            match_json,
        "players.json":          players,
        "player-stats.json":     player_stats,
        "rounds.json":           rounds,
        "kills.json":            kills,
        "damages.json":          damages,
        "blinds.json":           blinds_json,
        "bombs.json":            bombs,
        "grenades.json":         grenades,
        "player-economies.json": economies,
        "clutches.json":         clutches,
    }
    if shots:
        files["shots.json"] = shots
    if positions:
        files["positions-1s.json"] = positions

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, json.dumps(_json_safe(data), ensure_ascii=False))
    return buf.getvalue()


# ── helper primitives ─────────────────────────────────────────────────────────

def _safe_float(val, default: float = 0.0) -> float:
    """Convert val to float, returning default for NaN/inf/None."""
    if val is None:
        return default
    try:
        f = float(val)
        return default if (math.isnan(f) or math.isinf(f)) else f
    except (TypeError, ValueError):
        return default


def _safe_float_nullable(val) -> float | None:
    """Convert val to float, returning None for NaN/inf/None."""
    if val is None:
        return None
    try:
        f = float(val)
        return None if (math.isnan(f) or math.isinf(f)) else f
    except (TypeError, ValueError):
        return None


def _json_safe(obj):
    """Recursively replace float NaN/inf with None for JSON compliance."""
    if isinstance(obj, float):
        return None if (math.isnan(obj) or math.isinf(obj)) else obj
    if isinstance(obj, list):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    return obj


def _sid(val) -> str | None:
    s = str(val or "").strip()
    return s if s and s not in ("0", "nan", "None") else None


_STEAMID_RE = re.compile(r"^\d{17}$")


def _is_valid_steamid(s) -> bool:
    r"""Return True if s is a string matching ^\d{17}$."""
    return isinstance(s, str) and bool(_STEAMID_RE.match(s))


def _is_valid_side(s) -> bool:
    return s in ("t", "ct")


def _is_valid_teamkey(s) -> bool:
    return s in ("teamA", "teamB")


def _pos(row: dict, xk="X", yk="Y", zk="Z") -> dict:
    """Non-nullable vec3: NaN/missing → 0.0."""
    return {
        "x": _safe_float(row.get(xk) if row.get(xk) is not None else row.get(xk.lower())),
        "y": _safe_float(row.get(yk) if row.get(yk) is not None else row.get(yk.lower())),
        "z": _safe_float(row.get(zk) if row.get(zk) is not None else row.get(zk.lower())),
    }


def _pos_nullable(row: dict, xk="X", yk="Y", zk="Z") -> dict | None:
    """Nullable vec3: returns None if all three are NaN/missing."""
    xv = _safe_float_nullable(row.get(xk) if row.get(xk) is not None else row.get(xk.lower()))
    yv = _safe_float_nullable(row.get(yk) if row.get(yk) is not None else row.get(yk.lower()))
    zv = _safe_float_nullable(row.get(zk) if row.get(zk) is not None else row.get(zk.lower()))
    if xv is None and yv is None and zv is None:
        return None
    return {"x": xv if xv is not None else 0.0,
            "y": yv if yv is not None else 0.0,
            "z": zv if zv is not None else 0.0}


def _b(val) -> bool:
    if isinstance(val, bool):
        return val
    try:
        return int(val or 0) != 0
    except (TypeError, ValueError):
        return False


def _rn(row: dict) -> int:
    return int(row.get("total_rounds_played") or 0)


def _event_steamid(row: dict) -> str | None:
    """Steam64 from demoparser2 player extras (not raw userid entity slot)."""
    return _sid(
        row.get("user_steamid")
        or row.get("steamid")
        or row.get("attacker_steamid")
    )


# ── Schema-strict enum mappings ───────────────────────────────────────────────

_END_REASON_ENUM = {"t_win", "ct_win", "target_bombed", "bomb_defused", "time_ran_out"}

_HITGROUP_ENUM = {"generic", "head", "chest", "stomach", "left_arm", "right_arm",
                  "left_leg", "right_leg", "gear", "neck"}

_HITGROUP_MAP = {
    "head": "head", "chest": "chest", "stomach": "stomach",
    "leftarm": "left_arm", "left arm": "left_arm", "left_arm": "left_arm",
    "rightarm": "right_arm", "right arm": "right_arm", "right_arm": "right_arm",
    "leftleg": "left_leg", "left leg": "left_leg", "left_leg": "left_leg",
    "rightleg": "right_leg", "right leg": "right_leg", "right_leg": "right_leg",
    "gear": "gear", "neck": "neck", "generic": "generic",
}

_BOMB_TYPE_MAP = {
    "plant": "plant_begin", "plant_begin": "plant_begin",
    "planted": "planted",
    "defuse": "defuse_begin", "defuse_begin": "defuse_begin",
    "defused": "defused", "defuse_complete": "defused",
    "explode": "exploded", "exploded": "exploded",
    "dropped": "dropped", "picked_up": "picked_up",
}

_GRENADE_TYPE_ENUM = {"flashbang", "smoke", "molotov", "incendiary", "hegrenade", "decoy"}
_GRENADE_WEAPON_TO_TYPE = {
    "smokegrenade": "smoke", "flashbang": "flashbang",
    "hegrenade": "hegrenade", "molotov": "molotov",
    "incgrenade": "incendiary", "decoy": "decoy",
}


def _normalize_hitgroup(raw: str) -> str:
    """Map demoparser2 hitgroup string to hitgroupSchema enum value; fallback 'generic'."""
    return _HITGROUP_MAP.get(str(raw or "").lower().strip(), "generic")


_ROUND_END_REASON_MAP = {
    1: "target_bombed",
    7: "bomb_defused",
    8: "ct_win",
    9: "t_win",
    12: "time_ran_out",
}

_ROUND_END_REASON_STR_MAP = {
    "t_killed": "ct_win",
    "ct_killed": "t_win",
    "t_eliminated": "ct_win",
    "ct_eliminated": "t_win",
    "bomb_exploded": "target_bombed",
    "target_bombed": "target_bombed",
    "bomb_defused": "bomb_defused",
    "draw": "time_ran_out",
    "round_draw": "time_ran_out",
}


def _normalize_round_end_reason(raw: Any) -> str:
    """Map demoparser2 round_end.reason (int or str) to v2 endReason enum; fallback 'time_ran_out'."""
    if raw is None or raw == "":
        return "time_ran_out"
    if isinstance(raw, bool):
        return "time_ran_out"
    if isinstance(raw, (int, float)):
        result = _ROUND_END_REASON_MAP.get(int(raw))
        return result if result in _END_REASON_ENUM else "time_ran_out"
    text = str(raw).strip()
    if not text:
        return "time_ran_out"
    key = text.lower().replace(" ", "_")
    if key in _ROUND_END_REASON_STR_MAP:
        mapped = _ROUND_END_REASON_STR_MAP[key]
        return mapped if mapped in _END_REASON_ENUM else "time_ran_out"
    if key in _END_REASON_ENUM:
        return key
    try:
        code = int(text)
        result = _ROUND_END_REASON_MAP.get(code)
        return result if result in _END_REASON_ENUM else "time_ran_out"
    except ValueError:
        return "time_ran_out"


def _weapon_to_grenade_type(weapon: str) -> str | None:
    return _GRENADE_WEAPON_TO_TYPE.get(str(weapon or "").strip().lower())


# ── players ───────────────────────────────────────────────────────────────────

def _build_players(raw: dict) -> list[dict]:
    team_num_to_key = {2: "teamA", 3: "teamB"}
    seen: set[str] = set()
    out: list[dict] = []
    for r in raw.get("player_info", []):
        sid = _sid(r.get("steamid"))
        if not sid or sid in seen:
            continue
        if not _is_valid_steamid(sid):
            continue
        seen.add(sid)
        tnum = int(r.get("team_num") or 0)
        team_key = team_num_to_key.get(tnum)
        if not team_key:
            continue
        out.append({
            "steamId64": sid,
            "name": str(r.get("name") or sid),
            "teamKey": team_key,
        })
    return out


def _build_team_map(players: list[dict]) -> dict[str, str]:
    """steamId64 -> teamKey"""
    return {p["steamId64"]: p["teamKey"] for p in players}


# ── rounds ────────────────────────────────────────────────────────────────────

def _build_rounds(
    raw: dict, team_map: dict[str, str]
) -> tuple[list[dict], dict[tuple[int, str], str]]:
    """
    Returns (rounds_list, side_map).
    side_map[(roundNumber, teamKey)] = "t" | "ct"

    Note: total_rounds_played at round_freeze_end/round_start equals N-1 for
    round N (rounds completed so far), so we store at actual_round = n + 1.
    total_rounds_played at round_end equals N (the round that just completed).
    """
    freeze_tick: dict[int, int] = {}
    for r in raw.get("round_freeze_ends", []):
        n = _rn(r)
        t = int(r.get("tick") or 0)
        actual_round = n + 1
        if actual_round > 0 and t > 0:
            freeze_tick[actual_round] = t

    start_tick: dict[int, int] = {}
    for r in raw.get("round_starts", []):
        n = _rn(r)
        t = int(r.get("tick") or 0)
        actual_round = n + 1
        if actual_round > 0 and actual_round not in start_tick:
            start_tick[actual_round] = t

    team_a_score = 0
    team_b_score = 0
    out: list[dict] = []
    side_map: dict[tuple[int, str], str] = {}

    round_ends_sorted = sorted(
        raw.get("round_ends", []),
        key=lambda r: _rn(r)
    )
    all_round_nums = [_rn(r) for r in round_ends_sorted if _rn(r) > 0]
    half = max(all_round_nums) // 2 if all_round_nums else 12

    for r in round_ends_sorted:
        n = _rn(r)
        if n <= 0:
            continue

        end_tick = int(r.get("tick") or 0)
        s_tick = start_tick.get(n, 0)
        fz_tick = freeze_tick.get(n, 0)

        # v2: startTick, freezeEndTick, endTick must all be >= 1
        if s_tick <= 0 or fz_tick <= 0 or end_tick <= 0:
            # Still populate side_map so events can reference the round
            team_a_side = "t" if n <= half else "ct"
            team_b_side = "ct" if n <= half else "t"
            if n > half * 2:
                ot_round = n - half * 2
                ot_half = ((ot_round - 1) // 3) % 2
                team_a_side = "t" if ot_half == 0 else "ct"
                team_b_side = "ct" if ot_half == 0 else "t"
            side_map[(n, "teamA")] = team_a_side
            side_map[(n, "teamB")] = team_b_side

            winner_raw = str(r.get("winner") or "").lower()
            if winner_raw in ("t", "2"):
                winner_key = "teamA" if team_a_side == "t" else "teamB"
            elif winner_raw in ("ct", "3"):
                winner_key = "teamA" if team_a_side == "ct" else "teamB"
            else:
                winner_key = None

            if winner_key == "teamA":
                team_a_score += 1
            elif winner_key == "teamB":
                team_b_score += 1
            continue

        team_a_side = "t" if n <= half else "ct"
        team_b_side = "ct" if n <= half else "t"
        if n > half * 2:
            ot_round = n - half * 2
            ot_half = ((ot_round - 1) // 3) % 2
            team_a_side = "t" if ot_half == 0 else "ct"
            team_b_side = "ct" if ot_half == 0 else "t"

        winner_raw = str(r.get("winner") or "").lower()
        if winner_raw in ("t", "2"):
            winner_side = "t"
            winner_key = "teamA" if team_a_side == "t" else "teamB"
        elif winner_raw in ("ct", "3"):
            winner_side = "ct"
            winner_key = "teamA" if team_a_side == "ct" else "teamB"
        else:
            winner_side = None
            winner_key = None

        # v2: winnerTeamKey and winnerSide must be valid
        if not winner_key or not winner_side:
            side_map[(n, "teamA")] = team_a_side
            side_map[(n, "teamB")] = team_b_side
            # still track score even if we skip the round
            continue

        end_reason = _normalize_round_end_reason(r.get("reason"))

        side_map[(n, "teamA")] = team_a_side
        side_map[(n, "teamB")] = team_b_side

        out.append({
            "roundNumber": n,
            "startTick": s_tick,
            "freezeEndTick": fz_tick,
            "endTick": end_tick,
            "teamASide": team_a_side,
            "teamBSide": team_b_side,
            "teamAScoreBefore": team_a_score,
            "teamBScoreBefore": team_b_score,
            "teamAEconomy": None,   # filled by _build_economies
            "teamBEconomy": None,
            "winnerTeamKey": winner_key,
            "winnerSide": winner_side,
            "endReason": end_reason,
        })

        if winner_key == "teamA":
            team_a_score += 1
        elif winner_key == "teamB":
            team_b_score += 1

    # Final pass: replace any None economy with "semi"
    for rd in out:
        if rd["teamAEconomy"] is None:
            rd["teamAEconomy"] = "semi"
        if rd["teamBEconomy"] is None:
            rd["teamBEconomy"] = "semi"

    return out, side_map


# ── match ─────────────────────────────────────────────────────────────────────

def _build_match(raw: dict, rounds: list[dict]) -> dict:
    hdr = raw.get("header", {})
    team_a_score = sum(1 for r in rounds if r["winnerTeamKey"] == "teamA")
    team_b_score = sum(1 for r in rounds if r["winnerTeamKey"] == "teamB")
    team_a_name_raw = raw.get("team_a_name") or str(hdr.get("team_name_t") or "")
    team_b_name_raw = raw.get("team_b_name") or str(hdr.get("team_name_ct") or "")
    team_a_name: str | None = team_a_name_raw.strip() or None
    team_b_name: str | None = team_b_name_raw.strip() or None

    # prefer header playback_time; fall back to last round end tick / tickrate
    header_duration = _safe_float(hdr.get("playback_time"), default=0.0)
    if not header_duration:
        last_tick = max((r["endTick"] for r in rounds if r.get("endTick")), default=0)
        tickrate = max(int(raw.get("tickrate") or 64), 1)
        header_duration = round(last_tick / tickrate, 1)
    # v2: durationSeconds must be > 0
    if not header_duration or header_duration <= 0:
        header_duration = 1.0

    server_name = str(hdr.get("server_name") or "").strip() or None

    return {
        "mapName": str(hdr.get("map_name") or "unknown"),
        "tickrate": raw.get("tickrate", 64),
        "durationSeconds": header_duration,
        "serverName": server_name,
        "source": "demo",
        "teamA": {"teamKey": "teamA", "name": team_a_name, "score": team_a_score},
        "teamB": {"teamKey": "teamB", "name": team_b_name, "score": team_b_score},
    }


# ── kills ─────────────────────────────────────────────────────────────────────

def _build_kills(raw: dict, team_map: dict, side_map: dict) -> list[dict]:
    out = []
    for r in raw.get("deaths", []):
        n = _rn(r)
        if n <= 0:
            continue

        victim_sid = _sid(r.get("user_steamid"))
        # v2: victimSteamId64 must pass _is_valid_steamid
        if not _is_valid_steamid(victim_sid):
            continue

        victim_key = team_map.get(victim_sid, "unknown")
        # v2: victimTeamKey must be "teamA" or "teamB"
        if not _is_valid_teamkey(victim_key):
            continue

        victim_side = side_map.get((n, victim_key), "unknown")
        # v2: victimSide must be "t" or "ct"
        if not _is_valid_side(victim_side):
            continue

        weapon = str(r.get("weapon") or "")
        if not weapon:
            continue

        killer_sid = _sid(r.get("attacker_steamid"))
        assist_sid = _sid(r.get("assister_steamid"))
        flash_assist = _b(r.get("assistedflash"))

        killer_key_raw = team_map.get(killer_sid or "", "unknown") if killer_sid else None
        killer_key: str | None = killer_key_raw if _is_valid_teamkey(killer_key_raw or "") else None
        killer_sid = killer_sid if _is_valid_steamid(killer_sid) else None

        killer_side_raw = side_map.get((n, killer_key), "unknown") if killer_key else None
        killer_side: str | None = killer_side_raw if _is_valid_side(killer_side_raw or "") else None

        assist_sid = assist_sid if _is_valid_steamid(assist_sid) else None

        flash_assister_sid_raw = _sid(r.get("assister_steamid")) if flash_assist else None
        flash_assister_sid: str | None = (
            flash_assister_sid_raw if _is_valid_steamid(flash_assister_sid_raw) else None
        )

        killer_active = str(r.get("attacker_active_weapon") or "") or None
        victim_active = str(r.get("user_active_weapon") or "") or None

        out.append({
            "roundNumber": n,
            "tick": int(r.get("tick") or 0),
            "killerSteamId64": killer_sid,
            "victimSteamId64": victim_sid,
            "assisterSteamId64": assist_sid,
            "flashAssisterSteamId64": flash_assister_sid,
            "killerTeamKey": killer_key,
            "victimTeamKey": victim_key,
            "killerSide": killer_side,
            "victimSide": victim_side,
            "weapon": weapon,
            "killerActiveWeapon": killer_active,
            "victimActiveWeapon": victim_active,
            "headshot": _b(r.get("headshot")),
            "flashAssist": flash_assist,
            "tradeKill": False,
            "tradeDeath": False,
            "throughSmoke": _b(r.get("thrusmoke")),
            "noScope": _b(r.get("noscope")),
            "penetratedObjects": int(r.get("penetrated_objects") or r.get("penetrated") or 0),
            "killerPosition": _pos_nullable(r, "attacker_X", "attacker_Y", "attacker_Z"),
            "victimPosition": _pos(r, "user_X", "user_Y", "user_Z"),
        })
    _annotate_trades(out)
    return out


def _annotate_trades(kills: list[dict], trade_window_ticks: int = 384) -> None:
    """Mark tradeKill / tradeDeath within a rolling 6-second window (384 ticks at 64hz)."""
    for i, kill in enumerate(kills):
        if kill["killerSteamId64"] is None:
            continue
        for j in range(i - 1, max(i - 20, -1), -1):
            prev = kills[j]
            if kill["tick"] - prev["tick"] > trade_window_ticks:
                break
            if prev["killerSteamId64"] == kill["victimSteamId64"]:
                kills[i]["tradeKill"] = True
                kills[j]["tradeDeath"] = True
                break


# ── damages ───────────────────────────────────────────────────────────────────

def _build_damages(raw: dict, team_map: dict, side_map: dict) -> list[dict]:
    out = []
    for r in raw.get("hurts", []):
        n = _rn(r)
        if n <= 0:
            continue

        vic_sid = _sid(r.get("user_steamid"))
        if not _is_valid_steamid(vic_sid):
            continue

        vic_key = team_map.get(vic_sid, "unknown")
        if not _is_valid_teamkey(vic_key):
            continue

        vic_side = side_map.get((n, vic_key), "unknown")
        if not _is_valid_side(vic_side):
            continue

        weapon = str(r.get("weapon") or "")
        if not weapon:
            continue

        atk_sid = _sid(r.get("attacker_steamid"))
        atk_key_raw = team_map.get(atk_sid or "", "unknown") if atk_sid else None
        atk_key: str | None = atk_key_raw if _is_valid_teamkey(atk_key_raw or "") else None
        atk_sid = atk_sid if _is_valid_steamid(atk_sid) else None
        atk_side_raw = side_map.get((n, atk_key), "unknown") if atk_key else None
        atk_side: str | None = atk_side_raw if _is_valid_side(atk_side_raw or "") else None

        raw_dmg = int(r.get("dmg_health") or 0)
        health_after = min(int(r.get("health") or 0), 100)
        health_before = min(health_after + raw_dmg, 100)
        armor_after = min(int(r.get("armor") or 0), 100)
        armor_before = min(armor_after + int(r.get("dmg_armor") or 0), 100)

        out.append({
            "roundNumber": n,
            "tick": int(r.get("tick") or 0),
            "attackerSteamId64": atk_sid,
            "victimSteamId64": vic_sid,
            "attackerTeamKey": atk_key,
            "victimTeamKey": vic_key,
            "attackerSide": atk_side,
            "victimSide": vic_side,
            "weapon": weapon,
            "hitgroup": _normalize_hitgroup(r.get("hitgroup")),
            "healthDamage": min(raw_dmg, health_before),
            "healthDamageRaw": raw_dmg,
            "armorDamage": int(r.get("dmg_armor") or 0),
            "victimHealthBefore": health_before,
            "victimHealthAfter": health_after,
            "victimArmorBefore": armor_before,
            "victimArmorAfter": armor_after,
            "attackerPosition": _pos_nullable(r, "attacker_X", "attacker_Y", "attacker_Z"),
            "victimPosition": _pos(r, "user_X", "user_Y", "user_Z"),
        })
    return out


# ── blinds ────────────────────────────────────────────────────────────────────

def _build_blinds(raw: dict, team_map: dict, side_map: dict) -> list[dict]:
    out = []
    for r in raw.get("blinds", []):
        n = _rn(r)
        if n <= 0:
            continue

        flasher_sid = _sid(r.get("attacker_steamid"))
        if not _is_valid_steamid(flasher_sid):
            continue

        flashed_sid = _sid(r.get("user_steamid"))
        if not _is_valid_steamid(flashed_sid):
            continue

        flasher_key = team_map.get(flasher_sid, "unknown")
        if not _is_valid_teamkey(flasher_key):
            continue

        flashed_key = team_map.get(flashed_sid, "unknown")
        if not _is_valid_teamkey(flashed_key):
            continue

        flasher_side = side_map.get((n, flasher_key), "unknown")
        if not _is_valid_side(flasher_side):
            continue

        flashed_side = side_map.get((n, flashed_key), "unknown")
        if not _is_valid_side(flashed_side):
            continue

        dur = _safe_float(r.get("blind_duration") or r.get("duration"), default=0.0)
        dur = min(dur, 6.0)  # clamp to max 6.0

        out.append({
            "roundNumber": n,
            "tick": int(r.get("tick") or 0),
            "flashId": None,
            "flasherSteamId64": flasher_sid,
            "flashedSteamId64": flashed_sid,
            "flasherTeamKey": flasher_key,
            "flashedTeamKey": flashed_key,
            "flasherSide": flasher_side,
            "flashedSide": flashed_side,
            "durationSeconds": round(dur, 3),
        })
    return out


# ── bombs ─────────────────────────────────────────────────────────────────────

def _build_bombs(raw: dict, team_map: dict, side_map: dict) -> list[dict]:
    out = []
    for ev_type, rows_key in [
        ("plant", "bomb_planted"),
        ("planted", "bomb_planted"),   # map same events with both semantics
        ("defuse", "bomb_defused"),
        ("defused", "bomb_defused"),
        ("explode", "bomb_exploded"),
    ]:
        # avoid double-processing — only process each event source once
        pass

    # Process each event source once with the correct v2 type
    event_sources = [
        ("bomb_planted",  "planted"),
        ("bomb_defused",  "defused"),
        ("bomb_exploded", "exploded"),
    ]

    for rows_key, ev_type in event_sources:
        v2_type = _BOMB_TYPE_MAP.get(ev_type)
        if v2_type is None:
            continue
        for r in raw.get(rows_key, []):
            n = _rn(r)
            if n <= 0:
                continue
            # v2: roundNumber >= 1 (already checked via n > 0)
            actor_sid = _sid(r.get("user_steamid") or r.get("steamid") or r.get("userid"))
            actor_key_raw = team_map.get(actor_sid or "", "unknown") if actor_sid else None
            actor_key: str | None = actor_key_raw if _is_valid_teamkey(actor_key_raw or "") else None
            actor_sid = actor_sid if _is_valid_steamid(actor_sid) else None
            actor_side_raw = side_map.get((n, actor_key), "unknown") if actor_key else None
            actor_side: str | None = actor_side_raw if _is_valid_side(actor_side_raw or "") else None
            raw_site = r.get("site")
            site_id = str(raw_site).strip() if raw_site is not None else None
            # Normalize site to "a" or "b" if possible
            site: str | None = None
            if site_id:
                sl = site_id.lower()
                if sl == "a" or sl == "433":
                    site = "b"  # CS2 site 433 is typically B
                elif sl == "b" or sl == "434":
                    site = "a"  # CS2 site 434 is typically A
                elif sl in ("a", "b"):
                    site = sl
            out.append({
                "roundNumber": n,
                "tick": int(r.get("tick") or 0),
                "type": v2_type,
                "site": site,
                "siteId": site_id,
                "actorSteamId64": actor_sid,
                "actorTeamKey": actor_key,
                "actorSide": actor_side,
                "position": _pos(r),
            })
    out.sort(key=lambda x: (x["roundNumber"], x["tick"]))
    return out


# ── grenades ─────────────────────────────────────────────────────────────────

def _build_grenades(raw: dict, team_map: dict, side_map: dict) -> list[dict]:
    throws: list[dict] = []
    for r in raw.get("grenade_throws", []):
        if _rn(r) <= 0:
            continue
        gtype = _weapon_to_grenade_type(str(r.get("weapon") or ""))
        if not gtype:
            continue
        throws.append({
            "rn": _rn(r),
            "tick": int(r.get("tick") or 0),
            "gtype": gtype,
            "sid": _event_steamid(r),
            "pos": _pos(r),
        })
    throws.sort(key=lambda t: t["tick"])

    def _match_throw(round_num: int, gtype: str, effect_tick: int, thrower_sid: str | None) -> dict | None:
        pool = [
            t for t in throws
            if t["rn"] == round_num
            and t["gtype"] == gtype
            and t["tick"] <= effect_tick
            and (thrower_sid is None or t["sid"] == thrower_sid)
        ]
        if not pool:
            return None
        return max(pool, key=lambda t: t["tick"])

    out = []
    for r in raw.get("grenade_detonations", []):
        n = _rn(r)
        if n <= 0:
            continue
        tick = int(r.get("tick") or 0)
        gtype = str(r.get("_grenade_type") or "")

        # v2: grenade type must be in enum
        if gtype not in _GRENADE_TYPE_ENUM:
            continue

        thrower_sid = _event_steamid(r)
        matched = _match_throw(n, gtype, tick, thrower_sid)
        if matched:
            thrower_sid = thrower_sid or matched["sid"]
            throw_pos = matched["pos"]
            throw_tick = matched["tick"]
        else:
            throw_pos = _pos(r)
            throw_tick = tick

        # v2: throwTick and effectTick must be >= 1
        if throw_tick <= 0 or tick <= 0:
            continue

        # v2: throwerSteamId64 must pass _is_valid_steamid
        if not _is_valid_steamid(thrower_sid):
            continue

        thrower_key = team_map.get(thrower_sid, "unknown")
        # v2: throwerTeamKey must be "teamA" or "teamB"
        if not _is_valid_teamkey(thrower_key):
            continue

        thrower_side = side_map.get((n, thrower_key), "unknown")
        # v2: throwerSide must be "t" or "ct"
        if not _is_valid_side(thrower_side):
            continue

        out.append({
            "roundNumber": n,
            "grenadeId": None,
            "throwTick": throw_tick,
            "effectTick": tick,
            "destroyTick": None,
            "grenade": gtype,
            "throwerSteamId64": thrower_sid,
            "throwerTeamKey": thrower_key,
            "throwerSide": thrower_side,
            "throwPosition": throw_pos,
            "effectPosition": _pos(r),
        })
    return out


# ── shots ─────────────────────────────────────────────────────────────────────

def _build_shots(raw: dict, team_map: dict, side_map: dict) -> list[dict]:
    out = []
    for r in raw.get("fires", []):
        n = _rn(r)
        if n <= 0:
            continue

        sid = _sid(r.get("user_steamid") or r.get("steamid") or r.get("userid"))
        if not _is_valid_steamid(sid):
            continue

        key = team_map.get(sid, "unknown")
        if not _is_valid_teamkey(key):
            continue

        side = side_map.get((n, key), "unknown")
        if not _is_valid_side(side):
            continue

        weapon = str(r.get("weapon") or "")
        if not weapon:
            continue

        out.append({
            "roundNumber": n,
            "tick": int(r.get("tick") or 0),
            "steamId64": sid,
            "teamKey": key,
            "side": side,
            "weapon": weapon,
            "position": _pos(r),
            "velocity": _pos(r, "user_vel_X", "user_vel_Y", "user_vel_Z"),
            "yaw": _safe_float(r.get("yaw"), default=0.0),
            "pitch": _safe_float(r.get("pitch"), default=0.0),
        })
    return out


# ── positions-1s ─────────────────────────────────────────────────────────────

def _build_positions(raw: dict, team_map: dict, side_map: dict) -> list[dict]:
    tick_to_round = _build_tick_to_round(raw)

    out = []
    for r in raw.get("positions_raw", []):
        tick = int(r.get("tick") or 0)
        n = tick_to_round.get(tick, 0)
        if n <= 0:
            continue
        sid = _sid(r.get("steamid"))
        if not sid:
            continue
        key = team_map.get(sid, "unknown")
        side = side_map.get((n, key), "unknown")
        out.append({
            "roundNumber": n,
            "tick": tick,
            "steamId64": sid,
            "teamKey": key,
            "side": side,
            "alive": int(r.get("health") or 0) > 0,
            "position": _pos(r),
            "yaw": _safe_float(r.get("yaw"), default=0.0),
            "pitch": _safe_float(r.get("pitch"), default=0.0),
            "health": int(r.get("health") or 0),
            "armor": int(r.get("armor") or 0),
            "money": int(r.get("current_equip_value") or 0),
            "activeWeapon": str(r.get("active_weapon") or "") or None,
            "flashDurationRemaining": _safe_float(r.get("flash_duration"), default=0.0),
            "hasBomb": _b(r.get("has_c4")),
            "hasDefuseKit": _b(r.get("has_defuser")),
        })
    return out


def _build_tick_to_round(raw: dict) -> dict[int, int]:
    """Map each sample tick to the round it belongs to."""
    # total_rounds_played at round_freeze_end = N-1 for round N → store at actual_round = N
    freeze_by_round: dict[int, int] = {}
    for r in raw.get("round_freeze_ends", []):
        n = _rn(r)
        t = int(r.get("tick") or 0)
        actual_round = n + 1
        if actual_round > 0 and t > 0:
            freeze_by_round[actual_round] = t

    # total_rounds_played at round_end = N for round N → correct as-is
    intervals: list[tuple[int, int, int]] = []
    for r in raw.get("round_ends", []):
        n = _rn(r)
        end_t = int(r.get("tick") or 0)
        start_t = freeze_by_round.get(n, 0)
        if start_t > 0 and end_t > start_t:
            intervals.append((start_t, end_t, n))

    mapping: dict[int, int] = {}
    for tick in raw.get("sample_ticks", []):
        for start_t, end_t, n in intervals:
            if start_t <= tick < end_t:
                mapping[tick] = n
                break
    return mapping


# ── economies ─────────────────────────────────────────────────────────────────

_ECO_ORDER = ["pistol", "eco", "semi", "force", "full"]


def _economy_type(money_spent: int, start_money: int, equipment_value: int,
                  round_number: int, total_rounds: int) -> str:
    half = total_rounds // 2 + 1
    if round_number == 1 or round_number == half:
        return "pistol"
    if equipment_value >= 4000:
        return "full"
    if money_spent < 1000 and equipment_value < 2000:
        return "eco"
    if start_money > 0 and money_spent / start_money > 0.75:
        return "force"
    return "semi"


def _team_economy_vote(types: list[str]) -> str:
    if not types:
        return "semi"
    counts = {t: types.count(t) for t in _ECO_ORDER}
    max_count = max(counts.values())
    for t in _ECO_ORDER:
        if counts[t] == max_count:
            return t
    return "semi"


def _build_economies(
    raw: dict, team_map: dict, side_map: dict, rounds: list[dict]
) -> list[dict]:
    # total_rounds_played at round_freeze_end = N-1 for round N → actual_round = N
    freeze_tick_to_round: dict[int, int] = {}
    for r in raw.get("round_freeze_ends", []):
        n = _rn(r)
        t = int(r.get("tick") or 0)
        actual_round = n + 1
        if actual_round > 0 and t > 0:
            freeze_tick_to_round[t] = actual_round

    total_rounds = len(rounds)
    out = []
    team_round_types: dict[tuple[int, str], list[str]] = {}

    for r in raw.get("economy_raw", []):
        tick = int(r.get("tick") or 0)
        n = freeze_tick_to_round.get(tick, 0)
        if n <= 0:
            continue
        sid = _sid(r.get("steamid"))
        if not _is_valid_steamid(sid):
            continue
        key = team_map.get(sid, "unknown")
        if not _is_valid_teamkey(key):
            continue
        side = side_map.get((n, key), "unknown")
        if not _is_valid_side(side):
            continue

        spent = int(r.get("cash_spent_this_round") or 0)
        equip = int(r.get("current_equip_value") or 0)
        start_money = int(r.get("start_balance") or 0)
        eco_type = _economy_type(spent, start_money, equip, n, total_rounds)

        has_armor = bool(int(r.get("armor") or 0) > 0)
        has_helmet = bool(_b(r.get("helmet")))
        has_defuse = bool(_b(r.get("has_defuser")))

        out.append({
            "roundNumber": n,
            "steamId64": sid,
            "teamKey": key,
            "side": side,
            "startMoney": start_money,
            "moneySpent": spent,
            "equipmentValue": equip,
            "type": eco_type,
            "hasArmor": has_armor,
            "hasHelmet": has_helmet,
            "hasDefuseKit": has_defuse,
            "primaryWeapon": None,
            "secondaryWeapon": None,
            "grenadeCount": 0,
        })
        team_round_types.setdefault((n, key), []).append(eco_type)

    round_by_number = {r["roundNumber"]: r for r in rounds}
    for (rn, key), types in team_round_types.items():
        rd = round_by_number.get(rn)
        if rd is None:
            continue
        vote = _team_economy_vote(types)
        if key == "teamA":
            rd["teamAEconomy"] = vote
        elif key == "teamB":
            rd["teamBEconomy"] = vote

    # Final pass: replace any None economy with "semi"
    for rd in rounds:
        if rd["teamAEconomy"] is None:
            rd["teamAEconomy"] = "semi"
        if rd["teamBEconomy"] is None:
            rd["teamBEconomy"] = "semi"

    return out


# ── player-stats ──────────────────────────────────────────────────────────────

def _build_player_stats(
    raw: dict, team_map: dict, side_map: dict, rounds: list[dict],
    kills_list: list[dict] | None = None,
    blinds_list: list[dict] | None = None,
) -> list[dict]:
    total_rounds = len(rounds)
    kills_by = _kills_per_round_per_player(raw.get("deaths", []))
    stats: dict[str, dict] = {}

    def _get(sid: str) -> dict:
        if sid not in stats:
            stats[sid] = {
                "steamId64": sid,
                "teamKey": team_map.get(sid, "unknown"),
                "rounds": total_rounds,
                "kills": 0, "deaths": 0, "assists": 0,
                "damageHealth": 0, "damageArmor": 0,
                "utilityDamage": 0,
                "headshotCount": 0,
                "firstKillCount": 0, "firstDeathCount": 0,
                "tradeKillCount": 0, "tradeDeathCount": 0,
                "noScopeKillCount": 0,
                "wallbangKillCount": 0,
                "collateralKillCount": 0,
                "bombPlantCount": 0, "bombDefuseCount": 0,
                "oneKillCount": 0, "twoKillCount": 0, "threeKillCount": 0,
                "fourKillCount": 0, "fiveKillCount": 0,
                "vsOneCount": 0, "vsOneWonCount": 0, "vsOneLostCount": 0,
                "vsTwoCount": 0, "vsTwoWonCount": 0, "vsTwoLostCount": 0,
                "vsThreeCount": 0, "vsThreeWonCount": 0, "vsThreeLostCount": 0,
                "vsFourCount": 0, "vsFourWonCount": 0, "vsFourLostCount": 0,
                "vsFiveCount": 0, "vsFiveWonCount": 0, "vsFiveLostCount": 0,
                "kast_rounds": 0,
                "flashAssistCount": 0,
                "enemyFlashDurationSeconds": 0.0,
                "teamFlashDurationSeconds": 0.0,
                "combatDeathCount": 0,
                "bombDeathCount": 0,
                "_rounds_with_kill": set(),
                "_rounds_with_death": set(),
                "_rounds_with_assist": set(),
                "_rounds_survived": set(),
                "_rounds_traded": set(),
            }
        return stats[sid]

    # kills / deaths — official rounds only
    for r in raw.get("deaths", []):
        n = _rn(r)
        if n <= 0:
            continue
        killer = _sid(r.get("attacker_steamid"))
        victim = _sid(r.get("user_steamid"))
        assist = _sid(r.get("assister_steamid"))
        if killer and killer == victim:
            killer = None  # suicide

        if victim:
            v = _get(victim)
            v["deaths"] += 1
            v["_rounds_with_death"].add(n)
            # combatDeathCount vs bombDeathCount
            if killer:
                v["combatDeathCount"] += 1
            else:
                v["bombDeathCount"] += 1
        if killer:
            k = _get(killer)
            k["kills"] += 1
            k["_rounds_with_kill"].add(n)
            if _b(r.get("headshot")):
                k["headshotCount"] += 1
        if assist:
            a = _get(assist)
            a["assists"] += 1
            a["_rounds_with_assist"].add(n)

    # trade annotations + no-scope kills
    if kills_list is None:
        kills_list = _build_kills(raw, team_map, side_map)
    for k in kills_list:
        if k["tradeKill"] and k["killerSteamId64"]:
            _get(k["killerSteamId64"])["tradeKillCount"] += 1
        if k["tradeDeath"] and k["victimSteamId64"]:
            _get(k["victimSteamId64"])["tradeDeathCount"] += 1
        if k["noScope"] and k["killerSteamId64"]:
            _get(k["killerSteamId64"])["noScopeKillCount"] += 1
        if k.get("penetratedObjects", 0) and k["killerSteamId64"]:
            _get(k["killerSteamId64"])["wallbangKillCount"] += 1

    # flashAssistCount from kills_list
    for k in (kills_list or []):
        if k.get("flashAssist") and k.get("assisterSteamId64"):
            _get(k["assisterSteamId64"])["flashAssistCount"] += 1

    # bomb plant / defuse — official rounds only
    for r in raw.get("bomb_planted", []):
        if _rn(r) <= 0:
            continue
        sid = _sid(r.get("user_steamid") or r.get("steamid") or r.get("userid"))
        if sid:
            _get(sid)["bombPlantCount"] += 1
    for r in raw.get("bomb_defused", []):
        if _rn(r) <= 0:
            continue
        sid = _sid(r.get("user_steamid") or r.get("steamid") or r.get("userid"))
        if sid:
            _get(sid)["bombDefuseCount"] += 1

    # first kill / first death per round — official rounds only
    first_kills: dict[int, str] = {}
    first_deaths: dict[int, str] = {}
    for r in sorted(raw.get("deaths", []), key=lambda x: int(x.get("tick") or 0)):
        n = _rn(r)
        if n <= 0:
            continue
        killer = _sid(r.get("attacker_steamid"))
        victim = _sid(r.get("user_steamid"))
        if killer and n not in first_kills:
            first_kills[n] = killer
        if victim and n not in first_deaths:
            first_deaths[n] = victim
    for sid in first_kills.values():
        _get(sid)["firstKillCount"] += 1
    for sid in first_deaths.values():
        _get(sid)["firstDeathCount"] += 1

    # multi-kill counts
    for sid, kpr in kills_by.items():
        for n, count in kpr.items():
            s = _get(sid)
            if count == 1: s["oneKillCount"] += 1
            elif count == 2: s["twoKillCount"] += 1
            elif count == 3: s["threeKillCount"] += 1
            elif count == 4: s["fourKillCount"] += 1
            elif count >= 5: s["fiveKillCount"] += 1

    # damages — official rounds, anti-enemy only (exclude self-damage and team damage)
    util_weapons = {"hegrenade", "molotov", "incgrenade", "flashbang", "smokegrenade", "decoy",
                    "inferno"}
    for r in raw.get("hurts", []):
        n = _rn(r)
        if n <= 0:
            continue
        atk = _sid(r.get("attacker_steamid"))
        vic = _sid(r.get("user_steamid"))
        if not atk or atk == vic:
            continue
        atk_team = team_map.get(atk, "unknown")
        vic_team = team_map.get(vic or "", "unknown")
        if atk_team == "unknown" or atk_team == vic_team:
            continue
        s = _get(atk)
        dmg_h = int(r.get("dmg_health") or 0)
        dmg_a = int(r.get("dmg_armor") or 0)
        s["damageHealth"] += dmg_h
        s["damageArmor"] += dmg_a
        if str(r.get("weapon") or "").lower() in util_weapons:
            s["utilityDamage"] += dmg_h

    # flash duration from blinds_list
    for blind in (blinds_list or []):
        flasher = blind.get("flasherSteamId64")
        flashed = blind.get("flashedSteamId64")
        dur = float(blind.get("durationSeconds") or 0)
        if not flasher or not flashed:
            continue
        flasher_team = team_map.get(flasher)
        flashed_team = team_map.get(flashed)
        if flasher_team and flashed_team:
            if flasher_team != flashed_team:
                _get(flasher)["enemyFlashDurationSeconds"] += dur
            else:
                _get(flasher)["teamFlashDurationSeconds"] += dur

    # survived rounds (not in deaths)
    all_sids = set(stats.keys())
    all_rounds = {r["roundNumber"] for r in rounds}
    for sid in all_sids:
        s = stats[sid]
        s["_rounds_survived"] = all_rounds - s["_rounds_with_death"]

    # KAST
    for sid in all_sids:
        s = stats[sid]
        kast = (
            s["_rounds_with_kill"]
            | s["_rounds_with_assist"]
            | s["_rounds_survived"]
            | s["_rounds_traded"]
        )
        s["kast_rounds"] = len(kast & all_rounds)

    # clutches
    clutches = _build_clutches(kills_list, rounds, team_map)
    for c in clutches:
        sid = c["clutcherSteamId64"]
        s = _get(sid)
        n_opp = c["opponentCount"]
        won = c["won"]
        key_prefix = ["", "vsOne", "vsTwo", "vsThree", "vsFour", "vsFive"][min(n_opp, 5)]
        s[f"{key_prefix}Count"] += 1
        if won:
            s[f"{key_prefix}WonCount"] += 1
        else:
            s[f"{key_prefix}LostCount"] += 1

    out = []
    for sid, s in stats.items():
        adr = round(s["damageHealth"] / max(total_rounds, 1), 2)
        kast_pct = round(s["kast_rounds"] / max(total_rounds, 1) * 100, 1)
        ud_per_round = round(s["utilityDamage"] / max(total_rounds, 1), 2)

        row = {k: v for k, v in s.items() if not k.startswith("_")}
        row["adr"] = adr
        row["kast"] = kast_pct
        row["averageUtilityDamagePerRound"] = ud_per_round
        # round flash durations for cleanliness
        row["enemyFlashDurationSeconds"] = round(row["enemyFlashDurationSeconds"], 3)
        row["teamFlashDurationSeconds"] = round(row["teamFlashDurationSeconds"], 3)
        out.append(row)

    return out


def _kills_per_round_per_player(deaths: list[dict]) -> dict[str, dict[int, int]]:
    """Returns {steamId64: {roundNumber: kill_count}} for official rounds only."""
    result: dict[str, dict[int, int]] = {}
    for r in deaths:
        n = _rn(r)
        if n <= 0:
            continue
        killer = _sid(r.get("attacker_steamid"))
        victim = _sid(r.get("user_steamid"))
        if not killer or killer == victim:
            continue
        result.setdefault(killer, {})
        result[killer][n] = result[killer].get(n, 0) + 1
    return result


# ── clutches ──────────────────────────────────────────────────────────────────

def _build_clutches(
    kills: list[dict], rounds: list[dict], team_map: dict
) -> list[dict]:
    """Detect 1vN situations: one alive player vs N enemies at some point in the round."""
    out: list[dict] = []
    rounds_by_n = {r["roundNumber"]: r for r in rounds}

    kills_by_round: dict[int, list[dict]] = {}
    for k in kills:
        kills_by_round.setdefault(k["roundNumber"], []).append(k)

    for rn, rnd in rounds_by_n.items():
        rnd_kills = sorted(kills_by_round.get(rn, []), key=lambda x: x["tick"])
        if not rnd_kills:
            continue

        alive: dict[str, set[str]] = {"teamA": set(), "teamB": set()}
        for sid, tk in team_map.items():
            if tk in alive:
                alive[tk].add(sid)

        clutch_detected: dict[str, bool] = {}

        dead: set[str] = set()
        for k in rnd_kills:
            victim = k["victimSteamId64"]
            if victim:
                dead.add(victim)

            a_alive = alive["teamA"] - dead
            b_alive = alive["teamB"] - dead

            if len(a_alive) == 1 and len(b_alive) >= 1:
                sid = next(iter(a_alive))
                if sid not in clutch_detected:
                    # v2: clutcherSteamId64 must pass _is_valid_steamid
                    if not _is_valid_steamid(sid):
                        clutch_detected[sid] = True
                        continue
                    clutch_side = rnd["teamASide"]
                    if not _is_valid_side(clutch_side):
                        clutch_detected[sid] = True
                        continue
                    clutch_detected[sid] = True
                    n_opp = len(b_alive)
                    remaining_kills = sum(
                        1 for kk in rnd_kills
                        if kk["tick"] >= k["tick"] and kk["killerSteamId64"] == sid
                    )
                    won = rnd["winnerTeamKey"] == "teamA"
                    survived = sid not in dead
                    out.append({
                        "roundNumber": rn,
                        "tick": k["tick"],
                        "clutcherSteamId64": sid,
                        "clutcherTeamKey": "teamA",
                        "clutcherSide": clutch_side,
                        "opponentCount": n_opp,
                        "won": won,
                        "survived": survived,
                        "killCount": remaining_kills,
                    })

            if len(b_alive) == 1 and len(a_alive) >= 1:
                sid = next(iter(b_alive))
                if sid not in clutch_detected:
                    if not _is_valid_steamid(sid):
                        clutch_detected[sid] = True
                        continue
                    clutch_side = rnd["teamBSide"]
                    if not _is_valid_side(clutch_side):
                        clutch_detected[sid] = True
                        continue
                    clutch_detected[sid] = True
                    n_opp = len(a_alive)
                    remaining_kills = sum(
                        1 for kk in rnd_kills
                        if kk["tick"] >= k["tick"] and kk["killerSteamId64"] == sid
                    )
                    won = rnd["winnerTeamKey"] == "teamB"
                    survived = sid not in dead
                    out.append({
                        "roundNumber": rn,
                        "tick": k["tick"],
                        "clutcherSteamId64": sid,
                        "clutcherTeamKey": "teamB",
                        "clutcherSide": clutch_side,
                        "opponentCount": n_opp,
                        "won": won,
                        "survived": survived,
                        "killCount": remaining_kills,
                    })

    return out


# ── manifest ──────────────────────────────────────────────────────────────────

def _build_manifest(
    raw: dict, dem_path: str, demo_hash: str | None,
    shots: list | None = None, positions: list | None = None,
) -> dict:
    try:
        from . import __version__ as _ver
    except ImportError:
        _ver = "unknown"
    # v2: version must be non-empty string; "unknown" is OK but "0.0.0" is cleaner
    exporter_version = _ver if _ver and _ver != "unknown" else "0.0.0"
    hdr = raw.get("header", {})

    files_map: dict[str, str] = {
        "match": "match.json",
        "players": "players.json",
        "rounds": "rounds.json",
        "playerStats": "player-stats.json",
        "playerEconomies": "player-economies.json",
        "kills": "kills.json",
        "damages": "damages.json",
        "blinds": "blinds.json",
        "bombs": "bombs.json",
        "grenades": "grenades.json",
        "clutches": "clutches.json",
    }
    if shots:
        files_map["shots"] = "shots.json"
    if positions:
        files_map["positions1s"] = "positions-1s.json"

    return {
        "schemaVersion": SCHEMA_VERSION,
        "exporter": {"name": EXPORTER_NAME, "version": exporter_version},
        "parser": {"name": "demoparser2", "version": "unknown"},
        "demo": {
            "hash": demo_hash,
            "sourceFileName": Path(dem_path).name,
        },
        "mapName": str(hdr.get("map_name") or "unknown"),
        "tickrate": raw.get("tickrate", 64),
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "files": files_map,
    }
