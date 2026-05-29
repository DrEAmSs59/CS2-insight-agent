"""Assemble a RivalHub demo export zip from parsed event data."""

from __future__ import annotations

import io
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .demo_parse_isolation import run_parse_worker
from .file_hash import file_md5_hex

SCHEMA_VERSION = "rivalhub-demo-export/1"
EXPORTER_NAME = "CS2 Insight Agent"


# ── public API ───────────────────────────────────────────────────────────────

def export_demo(dem_path: str) -> bytes:
    """Parse dem_path and return RivalHub zip as bytes. May raise IsolatedParseError."""
    path = Path(dem_path)
    demo_hash = file_md5_hex(path)
    raw: dict[str, Any] = run_parse_worker("rivalhub_export", dem_path=dem_path)
    return _assemble_zip(raw, dem_path, demo_hash)


# ── zip assembly ─────────────────────────────────────────────────────────────

def _assemble_zip(raw: dict[str, Any], dem_path: str, demo_hash: str) -> bytes:
    players     = _build_players(raw)
    team_map    = _build_team_map(players)         # steamId64 -> teamKey
    rounds, side_map = _build_rounds(raw, team_map) # side_map: (roundNumber, teamKey) -> side
    match_json  = _build_match(raw, rounds)
    player_stats = _build_player_stats(raw, team_map, side_map, rounds)
    kills       = _build_kills(raw, team_map, side_map)
    damages     = _build_damages(raw, team_map, side_map)
    blinds_json = _build_blinds(raw, team_map, side_map)
    bombs       = _build_bombs(raw, team_map, side_map)
    grenades    = _build_grenades(raw, team_map, side_map)
    shots       = _build_shots(raw, team_map, side_map)
    positions   = _build_positions(raw, team_map, side_map)
    economies   = _build_economies(raw, team_map, side_map, rounds)
    clutches    = _build_clutches(kills, rounds, team_map)
    manifest    = _build_manifest(raw, dem_path, demo_hash)

    files = {
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
        "shots.json":            shots,
        "positions-1s.json":     positions,
        "player-economies.json": economies,
        "clutches.json":         clutches,
    }

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, json.dumps(data, ensure_ascii=False))
    return buf.getvalue()


# ── helper primitives ─────────────────────────────────────────────────────────

def _sid(val) -> str | None:
    s = str(val or "").strip()
    return s if s and s not in ("0", "nan", "None") else None


def _pos(row: dict, xk="X", yk="Y", zk="Z") -> dict:
    return {
        "x": float(row.get(xk) or row.get(xk.lower()) or 0),
        "y": float(row.get(yk) or row.get(yk.lower()) or 0),
        "z": float(row.get(zk) or row.get(zk.lower()) or 0),
    }


def _b(val) -> bool:
    if isinstance(val, bool):
        return val
    try:
        return int(val or 0) != 0
    except (TypeError, ValueError):
        return False


def _rn(row: dict) -> int:
    return int(row.get("total_rounds_played") or 0)


# ── players ───────────────────────────────────────────────────────────────────

def _build_players(raw: dict) -> list[dict]:
    team_num_to_key = {2: "teamA", 3: "teamB"}
    seen: set[str] = set()
    out: list[dict] = []
    for r in raw.get("player_info", []):
        sid = _sid(r.get("steamid"))
        if not sid or sid in seen:
            continue
        seen.add(sid)
        tnum = int(r.get("team_num") or 0)
        out.append({
            "steamId64": sid,
            "name": str(r.get("name") or ""),
            "teamKey": team_num_to_key.get(tnum, "unknown"),
        })
    return out


def _build_team_map(players: list[dict]) -> dict[str, str]:
    """steamId64 -> teamKey"""
    return {p["steamId64"]: p["teamKey"] for p in players}


# ── rounds ────────────────────────────────────────────────────────────────────

_ROUND_END_REASON_MAP = {
    1: "target_bombed",
    7: "bomb_defused",
    8: "ct_win",       # T eliminated
    9: "t_win",        # CT eliminated
    12: "round_draw",
}


def _build_rounds(
    raw: dict, team_map: dict[str, str]
) -> tuple[list[dict], dict[tuple[int, str], str]]:
    """
    Returns (rounds_list, side_map).
    side_map[(roundNumber, teamKey)] = "t" | "ct"
    """
    # index freeze_end and round_start ticks by round number
    freeze_tick: dict[int, int] = {}
    for r in raw.get("round_freeze_ends", []):
        n = _rn(r)
        if n > 0:
            freeze_tick[n] = int(r.get("tick") or 0)

    start_tick: dict[int, int] = {}
    for r in raw.get("round_starts", []):
        n = _rn(r)
        if n > 0 and n not in start_tick:
            start_tick[n] = int(r.get("tick") or 0)

    team_a_score = 0
    team_b_score = 0
    out: list[dict] = []
    side_map: dict[tuple[int, str], str] = {}

    for r in raw.get("round_ends", []):
        n = _rn(r)
        if n <= 0:
            continue

        end_tick = int(r.get("tick") or 0)
        # side: teamA starts T (team_num 2)
        # halftime is round 13 (MR12), or 16 (MR15), switch sides then
        team_a_side = "t" if n <= 12 else "ct"
        team_b_side = "ct" if n <= 12 else "t"

        winner_raw = str(r.get("winner") or "").lower()
        # winner is "t" or "ct" or "2" / "3"
        if winner_raw in ("t", "2"):
            winner_side = "t"
            winner_key = "teamA" if team_a_side == "t" else "teamB"
        elif winner_raw in ("ct", "3"):
            winner_side = "ct"
            winner_key = "teamA" if team_a_side == "ct" else "teamB"
        else:
            winner_side = "unknown"
            winner_key = "unknown"

        reason_code = int(r.get("reason") or 0)
        end_reason = _ROUND_END_REASON_MAP.get(reason_code, str(reason_code))

        side_map[(n, "teamA")] = team_a_side
        side_map[(n, "teamB")] = team_b_side

        out.append({
            "roundNumber": n,
            "startTick": start_tick.get(n, 0),
            "freezeEndTick": freeze_tick.get(n, 0),
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

    return out, side_map


# ── match ─────────────────────────────────────────────────────────────────────

def _build_match(raw: dict, rounds: list[dict]) -> dict:
    hdr = raw.get("header", {})
    team_a_score = sum(1 for r in rounds if r["winnerTeamKey"] == "teamA")
    team_b_score = sum(1 for r in rounds if r["winnerTeamKey"] == "teamB")
    return {
        "mapName": str(hdr.get("map_name") or "unknown"),
        "tickrate": raw.get("tickrate", 64),
        "durationSeconds": float(hdr.get("playback_time") or 0),
        "serverName": str(hdr.get("server_name") or ""),
        "source": "demo",
        "teamA": {"teamKey": "teamA", "name": str(hdr.get("team_name_t") or "Team A"), "score": team_a_score},
        "teamB": {"teamKey": "teamB", "name": str(hdr.get("team_name_ct") or "Team B"), "score": team_b_score},
    }


# ── kills ─────────────────────────────────────────────────────────────────────

def _build_kills(raw: dict, team_map: dict, side_map: dict) -> list[dict]:
    out = []
    for r in raw.get("deaths", []):
        n = _rn(r)
        killer_sid = _sid(r.get("attacker_steamid"))
        victim_sid = _sid(r.get("user_steamid"))
        assist_sid = _sid(r.get("assister_steamid"))
        killer_key = team_map.get(killer_sid or "", "unknown") if killer_sid else None
        victim_key = team_map.get(victim_sid or "", "unknown")
        out.append({
            "roundNumber": n,
            "tick": int(r.get("tick") or 0),
            "killerSteamId64": killer_sid,
            "victimSteamId64": victim_sid,
            "assisterSteamId64": assist_sid,
            "killerTeamKey": killer_key,
            "victimTeamKey": victim_key,
            "killerSide": side_map.get((n, killer_key), "unknown") if killer_key else "unknown",
            "victimSide": side_map.get((n, victim_key), "unknown"),
            "weapon": str(r.get("weapon") or ""),
            "headshot": _b(r.get("headshot")),
            "flashAssist": _b(r.get("assistedflash")),
            "tradeKill": False,       # computed below
            "tradeDeath": False,      # computed below
            "throughSmoke": _b(r.get("thrusmoke")),
            "noScope": _b(r.get("noscope")),
            "penetratedObjects": int(r.get("penetrated_objects") or r.get("penetrated") or 0),
            "killerPosition": _pos(r, "attacker_X", "attacker_Y", "attacker_Z"),
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
            # kill.killerSteamId64 died in prev → trade kill
            if prev["victimSteamId64"] == kill["killerSteamId64"]:
                kills[i]["tradeKill"] = True
                kills[j]["tradeDeath"] = True
                break


# ── damages ───────────────────────────────────────────────────────────────────

def _build_damages(raw: dict, team_map: dict, side_map: dict) -> list[dict]:
    out = []
    for r in raw.get("hurts", []):
        n = _rn(r)
        atk_sid = _sid(r.get("attacker_steamid"))
        vic_sid = _sid(r.get("user_steamid"))
        atk_key = team_map.get(atk_sid or "", "unknown") if atk_sid else None
        vic_key = team_map.get(vic_sid or "", "unknown")
        health_before = int(r.get("health") or 0) + int(r.get("dmg_health") or 0)
        armor_before  = int(r.get("armor") or 0) + int(r.get("dmg_armor") or 0)
        out.append({
            "roundNumber": n,
            "tick": int(r.get("tick") or 0),
            "attackerSteamId64": atk_sid,
            "victimSteamId64": vic_sid,
            "attackerTeamKey": atk_key,
            "victimTeamKey": vic_key,
            "attackerSide": side_map.get((n, atk_key), "unknown") if atk_key else "unknown",
            "victimSide": side_map.get((n, vic_key), "unknown"),
            "weapon": str(r.get("weapon") or ""),
            "hitgroup": str(r.get("hitgroup") or ""),
            "healthDamage": int(r.get("dmg_health") or 0),
            "armorDamage": int(r.get("dmg_armor") or 0),
            "victimHealthBefore": health_before,
            "victimHealthAfter": int(r.get("health") or 0),
            "victimArmorBefore": armor_before,
            "victimArmorAfter": int(r.get("armor") or 0),
        })
    return out


# ── blinds ────────────────────────────────────────────────────────────────────

def _build_blinds(raw: dict, team_map: dict, side_map: dict) -> list[dict]:
    out = []
    for r in raw.get("blinds", []):
        n = _rn(r)
        flasher_sid = _sid(r.get("attacker_steamid"))
        flashed_sid = _sid(r.get("user_steamid"))
        flasher_key = team_map.get(flasher_sid or "", "unknown") if flasher_sid else None
        flashed_key = team_map.get(flashed_sid or "", "unknown")
        dur = float(r.get("blind_duration") or r.get("duration") or 0)
        out.append({
            "roundNumber": n,
            "tick": int(r.get("tick") or 0),
            "flasherSteamId64": flasher_sid,
            "flashedSteamId64": flashed_sid,
            "flasherTeamKey": flasher_key,
            "flashedTeamKey": flashed_key,
            "flasherSide": side_map.get((n, flasher_key), "unknown") if flasher_key else "unknown",
            "flashedSide": side_map.get((n, flashed_key), "unknown"),
            "durationSeconds": round(dur, 3),
        })
    return out


# ── bombs ─────────────────────────────────────────────────────────────────────

def _build_bombs(raw: dict, team_map: dict, side_map: dict) -> list[dict]:
    out = []
    for ev_type, rows_key in [("plant", "bomb_planted"), ("defuse", "bomb_defused"), ("explode", "bomb_exploded")]:
        for r in raw.get(rows_key, []):
            n = _rn(r)
            actor_sid = _sid(r.get("steamid") or r.get("userid"))
            actor_key = team_map.get(actor_sid or "", "unknown") if actor_sid else None
            out.append({
                "roundNumber": n,
                "tick": int(r.get("tick") or 0),
                "type": ev_type,
                "site": str(r.get("site") or "").lower() or None,
                "actorSteamId64": actor_sid,
                "actorTeamKey": actor_key,
                "actorSide": side_map.get((n, actor_key), "unknown") if actor_key else "unknown",
                "position": _pos(r),
            })
    out.sort(key=lambda x: (x["roundNumber"], x["tick"]))
    return out


# ── grenades ─────────────────────────────────────────────────────────────────

def _build_grenades(raw: dict, team_map: dict, side_map: dict) -> list[dict]:
    # build throw-time positions from grenade_throws (keyed by userid + tick proximity)
    throw_pos_by_sid: dict[str, list[dict]] = {}
    for r in raw.get("grenade_throws", []):
        sid = _sid(r.get("steamid") or r.get("userid"))
        if sid:
            throw_pos_by_sid.setdefault(sid, []).append({
                "tick": int(r.get("tick") or 0),
                "pos": _pos(r),
                "weapon": str(r.get("weapon") or ""),
                "rn": _rn(r),
            })

    out = []
    for r in raw.get("grenade_detonations", []):
        n = _rn(r)
        thrower_sid = _sid(r.get("steamid") or r.get("userid"))
        thrower_key = team_map.get(thrower_sid or "", "unknown") if thrower_sid else None
        tick = int(r.get("tick") or 0)
        gtype = str(r.get("_grenade_type") or "unknown")

        # find best matching throw event for this player
        throw_pos = {"x": 0.0, "y": 0.0, "z": 0.0}
        throw_tick = tick
        if thrower_sid and thrower_sid in throw_pos_by_sid:
            candidates = [
                t for t in throw_pos_by_sid[thrower_sid]
                if t["rn"] == n and t["tick"] <= tick
            ]
            if candidates:
                best = max(candidates, key=lambda x: x["tick"])
                throw_pos = best["pos"]
                throw_tick = best["tick"]

        out.append({
            "roundNumber": n,
            "throwTick": throw_tick,
            "effectTick": tick,
            "grenade": gtype,
            "throwerSteamId64": thrower_sid,
            "throwerTeamKey": thrower_key,
            "throwerSide": side_map.get((n, thrower_key), "unknown") if thrower_key else "unknown",
            "throwPosition": throw_pos,
            "effectPosition": _pos(r),
        })
    return out


# ── shots ─────────────────────────────────────────────────────────────────────

def _build_shots(raw: dict, team_map: dict, side_map: dict) -> list[dict]:
    out = []
    for r in raw.get("fires", []):
        n = _rn(r)
        sid = _sid(r.get("steamid") or r.get("userid"))
        key = team_map.get(sid or "", "unknown") if sid else None
        out.append({
            "roundNumber": n,
            "tick": int(r.get("tick") or 0),
            "steamId64": sid,
            "teamKey": key,
            "side": side_map.get((n, key), "unknown") if key else "unknown",
            "weapon": str(r.get("weapon") or ""),
            "position": _pos(r),
            "yaw": float(r.get("yaw") or 0),
            "pitch": float(r.get("pitch") or 0),
        })
    return out


# ── positions-1s ─────────────────────────────────────────────────────────────

def _build_positions(raw: dict, team_map: dict, side_map: dict) -> list[dict]:
    # build tick -> round_number lookup
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
        out.append({
            "roundNumber": n,
            "tick": tick,
            "steamId64": sid,
            "teamKey": key,
            "side": side_map.get((n, key), "unknown"),
            "alive": int(r.get("health") or 0) > 0,
            "position": _pos(r),
            "yaw": float(r.get("yaw") or 0),
            "pitch": float(r.get("pitch") or 0),
            "health": int(r.get("health") or 0),
            "armor": int(r.get("armor") or 0),
            "money": int(r.get("current_equip_value") or 0),
            "activeWeapon": str(r.get("active_weapon") or ""),
            "flashDurationRemaining": float(r.get("flash_duration") or 0),
            "hasBomb": _b(r.get("has_c4")),
            "hasDefuseKit": _b(r.get("has_defuser")),
        })
    return out


def _build_tick_to_round(raw: dict) -> dict[int, int]:
    """Map each sample tick to the round it belongs to."""
    # Build intervals: (freeze_end_tick, round_end_tick) -> round_number
    freeze_by_round: dict[int, int] = {}
    for r in raw.get("round_freeze_ends", []):
        n = _rn(r)
        t = int(r.get("tick") or 0)
        if n > 0 and t > 0:
            freeze_by_round[n] = t

    intervals: list[tuple[int, int, int]] = []  # (start, end, round_num)
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

_ECO_TYPES = [
    (0, 1999, "eco"),
    (2000, 4999, "force"),
    (5000, 10000, "full_buy"),
]


def _economy_type(spent: int, round_number: int, total_rounds: int) -> str:
    half = total_rounds // 2 + 1
    if round_number == 1 or round_number == half:
        return "pistol"
    for lo, hi, label in _ECO_TYPES:
        if lo <= spent <= hi:
            return label
    return "full_buy"


def _build_economies(
    raw: dict, team_map: dict, side_map: dict, rounds: list[dict]
) -> list[dict]:
    # index freeze_end tick -> round_number
    freeze_tick_to_round: dict[int, int] = {}
    for r in raw.get("round_freeze_ends", []):
        n = _rn(r)
        t = int(r.get("tick") or 0)
        if n > 0 and t > 0:
            freeze_tick_to_round[t] = n

    total_rounds = len(rounds)
    out = []
    for r in raw.get("economy_raw", []):
        tick = int(r.get("tick") or 0)
        n = freeze_tick_to_round.get(tick, 0)
        if n <= 0:
            continue
        sid = _sid(r.get("steamid"))
        if not sid:
            continue
        key = team_map.get(sid, "unknown")
        spent = int(r.get("cash_spent_this_round") or 0)
        equip = int(r.get("current_equip_value") or 0)
        start_money = int(r.get("starting_money") or 0)
        out.append({
            "roundNumber": n,
            "steamId64": sid,
            "teamKey": key,
            "side": side_map.get((n, key), "unknown"),
            "startMoney": start_money,
            "moneySpent": spent,
            "equipmentValue": equip,
            "type": _economy_type(spent, n, total_rounds),
        })
    return out


# ── player-stats ──────────────────────────────────────────────────────────────

def _build_player_stats(
    raw: dict, team_map: dict, side_map: dict, rounds: list[dict]
) -> list[dict]:
    total_rounds = len(rounds)
    kills_by = _kills_per_round_per_player(raw.get("deaths", []))
    stats: dict[str, dict] = {}

    def _get(sid: str) -> dict:
        if sid not in stats:
            stats[sid] = {
                "steamId64": sid,
                "teamKey": team_map.get(sid, "unknown"),
                "kills": 0, "deaths": 0, "assists": 0,
                "damageHealth": 0, "damageArmor": 0,
                "utilityDamage": 0,
                "headshotCount": 0,
                "firstKillCount": 0, "firstDeathCount": 0,
                "tradeKillCount": 0, "tradeDeathCount": 0,
                "oneKillCount": 0, "twoKillCount": 0, "threeKillCount": 0,
                "fourKillCount": 0, "fiveKillCount": 0,
                "vsOneCount": 0, "vsOneWonCount": 0, "vsOneLostCount": 0,
                "vsTwoCount": 0, "vsTwoWonCount": 0, "vsTwoLostCount": 0,
                "vsThreeCount": 0, "vsThreeWonCount": 0, "vsThreeLostCount": 0,
                "vsFourCount": 0, "vsFourWonCount": 0, "vsFourLostCount": 0,
                "vsFiveCount": 0, "vsFiveWonCount": 0, "vsFiveLostCount": 0,
                "kast_rounds": 0,
                "_rounds_with_kill": set(),
                "_rounds_with_death": set(),
                "_rounds_with_assist": set(),
                "_rounds_survived": set(),
                "_rounds_traded": set(),
            }
        return stats[sid]

    # kills / deaths
    for r in raw.get("deaths", []):
        n = _rn(r)
        killer = _sid(r.get("attacker_steamid"))
        victim = _sid(r.get("user_steamid"))
        assist = _sid(r.get("assister_steamid"))
        if killer and killer == victim:
            killer = None  # suicide

        if victim:
            v = _get(victim)
            v["deaths"] += 1
            v["_rounds_with_death"].add(n)
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

    # trade annotations (re-use kill list built above)
    kills_list = _build_kills(raw, team_map, side_map)
    for k in kills_list:
        if k["tradeKill"] and k["killerSteamId64"]:
            _get(k["killerSteamId64"])["tradeKillCount"] += 1
        if k["tradeDeath"] and k["victimSteamId64"]:
            _get(k["victimSteamId64"])["tradeDeathCount"] += 1

    # first kill / first death per round
    first_kills: dict[int, str] = {}
    first_deaths: dict[int, str] = {}
    for r in sorted(raw.get("deaths", []), key=lambda x: int(x.get("tick") or 0)):
        n = _rn(r)
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

    # damages
    util_weapons = {"hegrenade", "molotov", "incgrenade", "flashbang", "smokegrenade", "decoy"}
    for r in raw.get("hurts", []):
        atk = _sid(r.get("attacker_steamid"))
        if not atk:
            continue
        s = _get(atk)
        dmg_h = int(r.get("dmg_health") or 0)
        dmg_a = int(r.get("dmg_armor") or 0)
        s["damageHealth"] += dmg_h
        s["damageArmor"] += dmg_a
        if str(r.get("weapon") or "").lower() in util_weapons:
            s["utilityDamage"] += dmg_h

    # survived rounds (not in deaths)
    all_sids = set(stats.keys())
    all_rounds = {r["roundNumber"] for r in rounds}
    for sid in all_sids:
        s = stats[sid]
        s["_rounds_survived"] = all_rounds - s["_rounds_with_death"]

    # KAST: rounds with Kill / Assist / Survived / Traded
    for sid in all_sids:
        s = stats[sid]
        kast = (
            s["_rounds_with_kill"]
            | s["_rounds_with_assist"]
            | s["_rounds_survived"]
            | s["_rounds_traded"]
        )
        s["kast_rounds"] = len(kast & all_rounds)

    # clutches (use pre-built clutch list)
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

        # clean internal tracking fields
        row = {k: v for k, v in s.items() if not k.startswith("_")}
        row["adr"] = adr
        row["kast"] = kast_pct
        row["averageUtilityDamagePerRound"] = ud_per_round
        out.append(row)

    return out


def _kills_per_round_per_player(deaths: list[dict]) -> dict[str, dict[int, int]]:
    """Returns {steamId64: {roundNumber: kill_count}}"""
    result: dict[str, dict[int, int]] = {}
    for r in deaths:
        killer = _sid(r.get("attacker_steamid"))
        victim = _sid(r.get("user_steamid"))
        if not killer or killer == victim:
            continue
        n = _rn(r)
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

    # group kills by round
    kills_by_round: dict[int, list[dict]] = {}
    for k in kills:
        kills_by_round.setdefault(k["roundNumber"], []).append(k)

    for rn, rnd in rounds_by_n.items():
        rnd_kills = sorted(kills_by_round.get(rn, []), key=lambda x: x["tick"])
        if not rnd_kills:
            continue

        # simulate alive counts: start with 5 per team
        alive: dict[str, set[str]] = {"teamA": set(), "teamB": set()}
        # pre-populate from players actually seen in this round
        seen_sids: set[str] = set()
        for k in rnd_kills:
            if k["killerSteamId64"]:
                seen_sids.add(k["killerSteamId64"])
            if k["victimSteamId64"]:
                seen_sids.add(k["victimSteamId64"])
        for sid in seen_sids:
            tk = team_map.get(sid, "unknown")
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

            # check 1vN for teamA
            if len(a_alive) == 1 and len(b_alive) >= 1:
                sid = next(iter(a_alive))
                if sid not in clutch_detected:
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
                        "clutcherSide": rnd["teamASide"],
                        "opponentCount": n_opp,
                        "won": won,
                        "survived": survived,
                        "killCount": remaining_kills,
                    })

            # check 1vN for teamB
            if len(b_alive) == 1 and len(a_alive) >= 1:
                sid = next(iter(b_alive))
                if sid not in clutch_detected:
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
                        "clutcherSide": rnd["teamBSide"],
                        "opponentCount": n_opp,
                        "won": won,
                        "survived": survived,
                        "killCount": remaining_kills,
                    })

    return out


# ── manifest ──────────────────────────────────────────────────────────────────

def _build_manifest(raw: dict, dem_path: str, demo_hash: str) -> dict:
    try:
        from . import __version__ as _ver
    except ImportError:
        _ver = "unknown"
    hdr = raw.get("header", {})
    return {
        "schemaVersion": SCHEMA_VERSION,
        "exporter": {"name": EXPORTER_NAME, "version": _ver},
        "parser": {"name": "demoparser2", "version": "unknown"},
        "demo": {
            "hash": demo_hash,
            "sourceFileName": Path(dem_path).name,
        },
        "mapName": str(hdr.get("map_name") or "unknown"),
        "tickrate": raw.get("tickrate", 64),
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "files": {
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
            "shots": "shots.json",
            "positions1s": "positions-1s.json",
            "clutches": "clutches.json",
        },
    }
