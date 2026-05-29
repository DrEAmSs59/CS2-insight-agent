"""demoparser2 extraction for RivalHub export. Runs inside a subprocess."""

from __future__ import annotations

from typing import Any

from demoparser2 import DemoParser  # type: ignore


_GRENADE_EVENTS = [
    ("smokegrenade_detonate", "smoke"),
    ("flashbang_detonate", "flashbang"),
    ("hegrenade_detonate", "hegrenade"),
    ("molotov_detonate", "molotov"),
    ("inferno_expire", "molotov"),
    ("decoy_detonate", "decoy"),
]


def _rows(result: Any) -> list[dict]:
    """Convert demoparser2 result (DataFrame or list) to list of dicts."""
    if result is None:
        return []
    if hasattr(result, "to_dict"):
        return result.to_dict(orient="records")
    return list(result)


def _safe_event(parser: DemoParser, event: str, other: list[str] | None = None) -> list[dict]:
    try:
        if other is not None:
            return _rows(parser.parse_event(event, other=other))
        return _rows(parser.parse_event(event))
    except Exception:
        return []


def parse_for_rivalhub(dem_path: str) -> dict[str, Any]:
    """Full event extraction. Returns a plain dict — all values must be JSON-serializable."""
    p = DemoParser(dem_path)

    # ── header ───────────────────────────────────────────────────
    try:
        header = dict(p.parse_header())
    except BaseException:
        header = {}

    try:
        tickrate = int(float(header.get("tick_rate") or 64))
    except (TypeError, ValueError):
        tickrate = 64

    # ── round boundaries ─────────────────────────────────────────
    round_starts   = _safe_event(p, "round_start",       ["total_rounds_played"])
    round_freeze_ends = _safe_event(p, "round_freeze_end", ["total_rounds_played"])
    round_ends     = _safe_event(p, "round_end",          ["winner", "reason", "total_rounds_played", "legacy"])

    # ── player deaths ────────────────────────────────────────────
    deaths = _safe_event(p, "player_death", other=[
        "headshot", "noscope", "thrusmoke", "penetrated", "penetrated_objects",
        "assistedflash", "attackerblind",
        "attacker_X", "attacker_Y", "attacker_Z",
        "user_X", "user_Y", "user_Z",
        "total_rounds_played",
    ])

    # ── damages ──────────────────────────────────────────────────
    hurts = _safe_event(p, "player_hurt", other=[
        "weapon", "hitgroup", "dmg_health", "dmg_armor", "health", "armor",
        "total_rounds_played",
    ])

    # ── shots ────────────────────────────────────────────────────
    fires = _safe_event(p, "weapon_fire", other=["weapon", "total_rounds_played"])

    # ── blinds ───────────────────────────────────────────────────
    blinds = _safe_event(p, "player_blind", other=["blind_duration", "total_rounds_played"])

    # ── bombs ────────────────────────────────────────────────────
    bomb_planted  = _safe_event(p, "bomb_planted",  other=["site", "total_rounds_played"])
    bomb_defused  = _safe_event(p, "bomb_defused",  other=["site", "total_rounds_played"])
    bomb_exploded = _safe_event(p, "bomb_exploded", other=["total_rounds_played"])

    # ── grenades ─────────────────────────────────────────────────
    grenade_throws = _safe_event(p, "grenade_thrown", other=["weapon", "total_rounds_played"])
    grenade_detonations: list[dict] = []
    for ev_name, gtype in _GRENADE_EVENTS:
        rows = _safe_event(p, ev_name, other=["total_rounds_played"])
        rows = [{**r, "_grenade_type": gtype} for r in rows]
        grenade_detonations.extend(rows)

    # ── player info at match start ───────────────────────────────
    announce_rows = _safe_event(p, "round_announce_match_start")
    if announce_rows:
        match_start_tick = int(announce_rows[0]["tick"])
    elif round_freeze_ends:
        match_start_tick = int(round_freeze_ends[0]["tick"])
    else:
        match_start_tick = 1

    try:
        player_info = _rows(p.parse_ticks(
            ["name", "steamid", "team_num", "team_name"],
            ticks=[match_start_tick],
        ))
    except BaseException:
        player_info = []

    # ── positions: ~1s sample during active play ─────────────────
    sample_ticks = _build_sample_ticks(round_ends, round_freeze_ends, tickrate)
    positions_raw: list[dict] = []
    if sample_ticks:
        try:
            positions_raw = _rows(p.parse_ticks(
                [
                    "steamid", "team_num", "X", "Y", "Z", "yaw", "pitch",
                    "health", "armor", "active_weapon", "flash_duration",
                    "current_equip_value", "has_defuser", "has_c4",
                ],
                ticks=sample_ticks,
            ))
        except BaseException:
            positions_raw = []

    # ── economy: player state at each freeze_end tick ────────────
    freeze_ticks = sorted({int(r["tick"]) for r in round_freeze_ends if r.get("tick")})
    economy_raw: list[dict] = []
    if freeze_ticks:
        economy_raw = _rows(p.parse_ticks(
            ["steamid", "team_num", "cash_spent_this_round", "current_equip_value", "starting_money"],
            ticks=freeze_ticks,
        ))

    return {
        "header": header,
        "tickrate": tickrate,
        "match_start_tick": match_start_tick,
        "player_info": player_info,
        "round_starts": round_starts,
        "round_freeze_ends": round_freeze_ends,
        "round_ends": round_ends,
        "deaths": deaths,
        "hurts": hurts,
        "fires": fires,
        "blinds": blinds,
        "bomb_planted": bomb_planted,
        "bomb_defused": bomb_defused,
        "bomb_exploded": bomb_exploded,
        "grenade_throws": grenade_throws,
        "grenade_detonations": grenade_detonations,
        "positions_raw": positions_raw,
        "sample_ticks": sample_ticks,
        "economy_raw": economy_raw,
        "freeze_ticks": freeze_ticks,
    }


def _build_sample_ticks(
    round_ends: list[dict],
    round_freeze_ends: list[dict],
    tickrate: int,
) -> list[int]:
    """Return sorted unique sample ticks at ~1s intervals within active play."""
    freeze_by_round: dict[int, int] = {}
    for r in round_freeze_ends:
        rn = int(r.get("total_rounds_played") or 0)
        t = int(r.get("tick") or 0)
        if rn > 0 and t > 0:
            freeze_by_round[rn] = t

    ticks: list[int] = []
    for r in round_ends:
        rn = int(r.get("total_rounds_played") or 0)
        end_t = int(r.get("tick") or 0)
        start_t = freeze_by_round.get(rn, 0)
        if start_t <= 0 or end_t <= start_t:
            continue
        t = start_t
        while t < end_t:
            ticks.append(t)
            t += tickrate
    return sorted(set(ticks))
