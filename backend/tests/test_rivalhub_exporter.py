"""Tests for RivalHub export helpers (v2.0 schema)."""

import json
import math
from pathlib import Path

import pytest

from app.rivalhub_exporter import (
    SCHEMA_VERSION,
    _build_blinds,
    _build_bombs,
    _build_damages,
    _build_grenades,
    _build_kills,
    _build_player_stats,
    _build_rounds,
    _build_shots,
    _json_safe,
    _normalize_round_end_reason,
    _safe_float,
    _is_valid_steamid,
    _normalize_hitgroup,
)

# ── Spec schema path ──────────────────────────────────────────────────────────
_SPEC_DIR = Path(__file__).parent.parent.parent.parent / "cs2-demo-format" / "spec"
_HAS_SPEC = _SPEC_DIR.exists()

def _load_schema(key: str) -> dict | None:
    if not _HAS_SPEC:
        return None
    path = _SPEC_DIR / f"{key}.schema.json"
    return json.loads(path.read_text()) if path.exists() else None

def _validate(data, key: str):
    """Validate data against spec schema if available; skip otherwise."""
    schema = _load_schema(key)
    if schema is None:
        pytest.skip(f"spec schema not found: {key}")
    try:
        import jsonschema
    except ImportError:
        pytest.skip("jsonschema not installed")
    jsonschema.validate(data, schema)


# ── schema version ────────────────────────────────────────────────────────────

def test_schema_version_is_v2():
    assert SCHEMA_VERSION == "cs2-demo-format/2.0"


# ── _is_valid_steamid ─────────────────────────────────────────────────────────

def test_is_valid_steamid_valid():
    assert _is_valid_steamid("76561198000000001")

def test_is_valid_steamid_too_short():
    assert not _is_valid_steamid("7656119800000001")

def test_is_valid_steamid_none():
    assert not _is_valid_steamid(None)

def test_is_valid_steamid_letters():
    assert not _is_valid_steamid("7656119800000000X")


# ── _normalize_hitgroup ───────────────────────────────────────────────────────

def test_normalize_hitgroup_known():
    assert _normalize_hitgroup("head") == "head"
    assert _normalize_hitgroup("leftarm") == "left_arm"
    assert _normalize_hitgroup("rightleg") == "right_leg"
    assert _normalize_hitgroup("CHEST") == "chest"

def test_normalize_hitgroup_unknown_fallback():
    assert _normalize_hitgroup("unknown_part") == "generic"
    assert _normalize_hitgroup(None) == "generic"
    assert _normalize_hitgroup("") == "generic"


# ── _safe_float / _json_safe ──────────────────────────────────────────────────

def test_safe_float_nan_returns_default():
    # v2: default is 0.0 not None
    assert _safe_float(float("nan")) == 0.0

def test_safe_float_inf_returns_default():
    assert _safe_float(float("inf")) == 0.0
    assert _safe_float(float("-inf")) == 0.0

def test_safe_float_valid():
    assert _safe_float(3.14) == pytest.approx(3.14)
    assert _safe_float("1.5") == pytest.approx(1.5)
    assert _safe_float(None) == 0.0

def test_safe_float_custom_default():
    assert _safe_float(None, default=99.0) == 99.0
    assert _safe_float(float("nan"), default=5.0) == 5.0

def test_json_safe_replaces_nan():
    data = [{"x": float("nan"), "y": 1.0, "z": None}]
    result = _json_safe(data)
    assert result[0]["x"] is None
    assert result[0]["y"] == pytest.approx(1.0)
    json.dumps(result)

def test_json_safe_replaces_inf():
    data = {"v": float("inf")}
    result = _json_safe(data)
    assert result["v"] is None
    json.dumps(result)


# ── round end reason ──────────────────────────────────────────────────────────

def test_normalize_round_end_reason_string():
    assert _normalize_round_end_reason("t_killed") == "ct_win"
    assert _normalize_round_end_reason("ct_killed") == "t_win"
    assert _normalize_round_end_reason("bomb_exploded") == "target_bombed"

def test_normalize_round_end_reason_legacy_int():
    assert _normalize_round_end_reason(8) == "ct_win"
    assert _normalize_round_end_reason("9") == "t_win"

def test_normalize_round_end_reason_fallback_to_time_ran_out():
    # v2: unknown → "time_ran_out" instead of "unknown"
    assert _normalize_round_end_reason(None) == "time_ran_out"
    assert _normalize_round_end_reason("totally_unknown") == "time_ran_out"
    assert _normalize_round_end_reason("round_draw") == "time_ran_out"

def test_normalize_round_end_reason_v2_enum_values():
    valid = {"t_win", "ct_win", "target_bombed", "bomb_defused", "time_ran_out"}
    test_inputs = [None, "", "t_killed", "ct_killed", "bomb_exploded", "bomb_defused",
                   1, 7, 8, 9, 12, "unknown", "round_draw"]
    for inp in test_inputs:
        result = _normalize_round_end_reason(inp)
        assert result in valid, f"Input {inp!r} → {result!r} not in v2 enum"


# ── rounds ────────────────────────────────────────────────────────────────────

def _make_raw_rounds(n_rounds=3):
    """Minimal raw with total_rounds_played semantics: freeze_end/start use N-1, end uses N."""
    return {
        "round_ends": [
            {"total_rounds_played": n, "tick": n * 2000, "winner": "CT", "reason": "t_killed"}
            for n in range(1, n_rounds + 1)
        ],
        "round_starts": [
            {"total_rounds_played": n - 1, "tick": (n - 1) * 2000 + 100}
            for n in range(1, n_rounds + 1)
        ],
        "round_freeze_ends": [
            {"total_rounds_played": n - 1, "tick": (n - 1) * 2000 + 500}
            for n in range(1, n_rounds + 1)
        ],
    }

def test_build_rounds_accepts_demoparser2_string_reason():
    raw = {
        "round_ends": [{"total_rounds_played": 1, "tick": 1000, "winner": "CT", "reason": "t_killed"}],
        "round_starts": [{"total_rounds_played": 0, "tick": 100}],
        "round_freeze_ends": [{"total_rounds_played": 0, "tick": 500}],
    }
    rounds, _ = _build_rounds(raw, {})
    assert len(rounds) == 1
    assert rounds[0]["endReason"] == "ct_win"

def test_build_rounds_tick_ordering():
    """startTick <= freezeEndTick <= endTick for all rounds."""
    raw = _make_raw_rounds(5)
    rounds, _ = _build_rounds(raw, {})
    assert len(rounds) == 5
    for r in rounds:
        st = r["startTick"]
        ft = r["freezeEndTick"]
        et = r["endTick"]
        assert st >= 1, f"round {r['roundNumber']}: startTick={st} must be >= 1"
        assert ft >= 1, f"round {r['roundNumber']}: freezeEndTick={ft} must be >= 1"
        assert et >= 1, f"round {r['roundNumber']}: endTick={et} must be >= 1"
        assert st <= ft, f"round {r['roundNumber']}: startTick={st} > freezeEndTick={ft}"
        assert ft <= et, f"round {r['roundNumber']}: freezeEndTick={ft} > endTick={et}"

def test_build_rounds_warmup_excluded():
    """Rounds with total_rounds_played=0 must not appear in output."""
    raw = {
        "round_ends": [
            {"total_rounds_played": 0, "tick": 500, "winner": "CT", "reason": "t_killed"},
            {"total_rounds_played": 1, "tick": 2000, "winner": "CT", "reason": "t_killed"},
        ],
        "round_starts": [{"total_rounds_played": 0, "tick": 100}],
        "round_freeze_ends": [{"total_rounds_played": 0, "tick": 500}],
    }
    rounds, _ = _build_rounds(raw, {})
    assert all(r["roundNumber"] > 0 for r in rounds)

def test_build_rounds_economies_default_to_semi():
    """teamAEconomy / teamBEconomy must be 'semi' (not None) when no economy data."""
    raw = _make_raw_rounds(3)
    rounds, _ = _build_rounds(raw, {})
    for r in rounds:
        assert r["teamAEconomy"] == "semi", f"Expected 'semi', got {r['teamAEconomy']!r}"
        assert r["teamBEconomy"] == "semi", f"Expected 'semi', got {r['teamBEconomy']!r}"

def test_build_rounds_schema_valid():
    raw = _make_raw_rounds(3)
    rounds, _ = _build_rounds(raw, {})
    _validate(rounds, "rounds")


# ── kills ─────────────────────────────────────────────────────────────────────

def _make_deaths():
    return [
        {
            "total_rounds_played": 1, "tick": 500,
            "attacker_steamid": "76561198000000001",
            "user_steamid": "76561198000000002",
            "weapon": "ak47", "headshot": True,
            "assistedflash": False, "thrusmoke": False,
            "noscope": False, "penetrated_objects": 0,
            "attacker_X": 100.0, "attacker_Y": 200.0, "attacker_Z": 64.0,
            "user_X": 50.0, "user_Y": 75.0, "user_Z": 0.0,
            "attacker_active_weapon": "ak47",
            "user_active_weapon": "awp",
        },
        {
            "total_rounds_played": 0, "tick": 100,  # warmup — must be excluded
            "attacker_steamid": "76561198000000001",
            "user_steamid": "76561198000000003",
            "weapon": "glock", "headshot": False,
            "assistedflash": False, "thrusmoke": False,
            "noscope": False, "penetrated_objects": 0,
            "attacker_X": 0.0, "attacker_Y": 0.0, "attacker_Z": 0.0,
            "user_X": 0.0, "user_Y": 0.0, "user_Z": 0.0,
        },
    ]

def test_build_kills_filters_warmup():
    team_map = {"76561198000000001": "teamA", "76561198000000002": "teamB"}
    kills = _build_kills({"deaths": _make_deaths()}, team_map, {(1, "teamA"): "t", (1, "teamB"): "ct"})
    assert all(k["roundNumber"] > 0 for k in kills)
    assert len(kills) == 1

def test_build_kills_v2_non_nullable_victim_position():
    """victimPosition must be non-nullable vec3 in v2."""
    team_map = {"76561198000000001": "teamA", "76561198000000002": "teamB"}
    kills = _build_kills({"deaths": _make_deaths()}, team_map, {(1, "teamA"): "t", (1, "teamB"): "ct"})
    pos = kills[0]["victimPosition"]
    assert pos is not None
    assert isinstance(pos, dict)
    assert all(k in pos for k in ("x", "y", "z"))
    # All components must be numbers (not None) — NaN→0.0
    for comp in ("x", "y", "z"):
        assert isinstance(pos[comp], (int, float)), f"victimPosition.{comp} must be a number"

def test_build_kills_killer_position_nullable():
    """killerPosition should be nullable vec3 in v2."""
    team_map = {"76561198000000001": "teamA", "76561198000000002": "teamB"}
    # Make a death without attacker position
    deaths = [{
        "total_rounds_played": 1, "tick": 500,
        "attacker_steamid": "76561198000000001",
        "user_steamid": "76561198000000002",
        "weapon": "ak47", "headshot": True,
        "assistedflash": False, "thrusmoke": False,
        "noscope": False, "penetrated_objects": 0,
        # no attacker_X/Y/Z
        "user_X": 50.0, "user_Y": 75.0, "user_Z": 0.0,
    }]
    kills = _build_kills({"deaths": deaths}, team_map, {(1, "teamA"): "t", (1, "teamB"): "ct"})
    # killerPosition may be None or a dict
    pos = kills[0]["killerPosition"]
    assert pos is None or isinstance(pos, dict)

def test_build_kills_new_v2_fields():
    """v2 adds: flashAssisterSteamId64, killerActiveWeapon, victimActiveWeapon."""
    team_map = {"76561198000000001": "teamA", "76561198000000002": "teamB"}
    kills = _build_kills({"deaths": _make_deaths()}, team_map, {(1, "teamA"): "t", (1, "teamB"): "ct"})
    k = kills[0]
    assert "flashAssisterSteamId64" in k
    assert "killerActiveWeapon" in k
    assert "victimActiveWeapon" in k
    assert k["killerActiveWeapon"] == "ak47"
    assert k["victimActiveWeapon"] == "awp"

def test_build_kills_no_extra_fields():
    """No fields beyond what the v2 schema allows."""
    allowed = {
        "roundNumber", "tick", "killerSteamId64", "victimSteamId64", "assisterSteamId64",
        "flashAssisterSteamId64",
        "killerTeamKey", "victimTeamKey", "killerSide", "victimSide",
        "weapon", "killerActiveWeapon", "victimActiveWeapon",
        "headshot", "flashAssist", "tradeKill", "tradeDeath",
        "throughSmoke", "noScope", "penetratedObjects", "killerPosition", "victimPosition",
    }
    team_map = {"76561198000000001": "teamA", "76561198000000002": "teamB"}
    kills = _build_kills({"deaths": _make_deaths()}, team_map, {(1, "teamA"): "t", (1, "teamB"): "ct"})
    for k in kills:
        extra = set(k.keys()) - allowed
        assert not extra, f"Unexpected kill fields: {extra}"

def test_build_kills_filters_invalid_steamid():
    """Kills with invalid victimSteamId64 must be dropped."""
    deaths = [{
        "total_rounds_played": 1, "tick": 500,
        "attacker_steamid": "76561198000000001",
        "user_steamid": "invalid",  # not a valid steamid
        "weapon": "ak47", "headshot": False,
        "assistedflash": False, "thrusmoke": False,
        "noscope": False, "penetrated_objects": 0,
    }]
    team_map = {"76561198000000001": "teamA"}
    kills = _build_kills({"deaths": deaths}, team_map, {})
    assert kills == []

def test_build_kills_schema_valid():
    team_map = {"76561198000000001": "teamA", "76561198000000002": "teamB"}
    kills = _build_kills({"deaths": _make_deaths()}, team_map, {(1, "teamA"): "t", (1, "teamB"): "ct"})
    _validate(_json_safe(kills), "kills")


# ── damages ───────────────────────────────────────────────────────────────────

def test_build_damages_filters_warmup():
    team_map = {"76561198000000001": "teamA", "76561198000000002": "teamB"}
    side_map = {(1, "teamA"): "t", (1, "teamB"): "ct"}
    hurts = [
        # warmup round (total_rounds_played=0) — must be excluded
        {"total_rounds_played": 0, "tick": 50,
         "attacker_steamid": "76561198000000001", "user_steamid": "76561198000000002",
         "weapon": "glock", "hitgroup": "head", "dmg_health": 20, "dmg_armor": 5,
         "health": 80, "armor": 95},
        # official round — must be included
        {"total_rounds_played": 1, "tick": 500, "attacker_steamid": "76561198000000001",
         "user_steamid": "76561198000000002",
         "weapon": "ak47", "hitgroup": "chest", "dmg_health": 50, "dmg_armor": 10,
         "health": 50, "armor": 90},
    ]
    damages = _build_damages({"hurts": hurts}, team_map, side_map)
    assert all(d["roundNumber"] > 0 for d in damages)
    assert len(damages) == 1

def test_build_damages_v2_fields():
    """v2 adds: healthDamageRaw, hitgroup normalized, positions."""
    hurts = [{"total_rounds_played": 1, "tick": 500, "attacker_steamid": "76561198000000001",
              "user_steamid": "76561198000000002", "weapon": "ak47", "hitgroup": "leftarm",
              "dmg_health": 50, "dmg_armor": 10, "health": 50, "armor": 90,
              "attacker_X": 100.0, "attacker_Y": 200.0, "attacker_Z": 64.0,
              "user_X": 50.0, "user_Y": 75.0, "user_Z": 0.0}]
    damages = _build_damages({"hurts": hurts},
                             {"76561198000000001": "teamA", "76561198000000002": "teamB"},
                             {(1, "teamA"): "t", (1, "teamB"): "ct"})
    d = damages[0]
    assert "healthDamageRaw" in d
    assert d["healthDamageRaw"] == 50
    assert d["hitgroup"] == "left_arm"  # normalized
    assert "victimPosition" in d
    assert d["victimPosition"] is not None

def test_build_damages_no_extra_fields():
    allowed = {
        "roundNumber", "tick", "attackerSteamId64", "victimSteamId64",
        "attackerTeamKey", "victimTeamKey", "attackerSide", "victimSide",
        "weapon", "hitgroup",
        "healthDamage", "healthDamageRaw", "armorDamage",
        "victimHealthBefore", "victimHealthAfter", "victimArmorBefore", "victimArmorAfter",
        "attackerPosition", "victimPosition",
    }
    hurts = [{"total_rounds_played": 1, "tick": 500, "attacker_steamid": "76561198000000001",
              "user_steamid": "76561198000000002", "weapon": "ak47", "hitgroup": "chest",
              "dmg_health": 50, "dmg_armor": 10, "health": 50, "armor": 90}]
    damages = _build_damages({"hurts": hurts},
                             {"76561198000000001": "teamA", "76561198000000002": "teamB"},
                             {(1, "teamA"): "t", (1, "teamB"): "ct"})
    for d in damages:
        extra = set(d.keys()) - allowed
        assert not extra, f"Unexpected damage fields: {extra}"

def test_build_damages_health_clamped_to_100():
    """victimHealthBefore and victimHealthAfter must be clamped to max 100."""
    hurts = [{"total_rounds_played": 1, "tick": 500, "attacker_steamid": "76561198000000001",
              "user_steamid": "76561198000000002", "weapon": "ak47", "hitgroup": "chest",
              "dmg_health": 200, "dmg_armor": 0, "health": 0, "armor": 0}]
    damages = _build_damages({"hurts": hurts},
                             {"76561198000000001": "teamA", "76561198000000002": "teamB"},
                             {(1, "teamA"): "t", (1, "teamB"): "ct"})
    d = damages[0]
    assert d["victimHealthBefore"] <= 100
    assert d["victimHealthAfter"] <= 100

def test_build_damages_schema_valid():
    hurts = [{"total_rounds_played": 1, "tick": 500, "attacker_steamid": "76561198000000001",
              "user_steamid": "76561198000000002", "weapon": "ak47", "hitgroup": "chest",
              "dmg_health": 50, "dmg_armor": 10, "health": 50, "armor": 90,
              "attacker_X": 10.0, "attacker_Y": 20.0, "attacker_Z": 30.0,
              "user_X": 40.0, "user_Y": 50.0, "user_Z": 60.0}]
    damages = _build_damages({"hurts": hurts},
                             {"76561198000000001": "teamA", "76561198000000002": "teamB"},
                             {(1, "teamA"): "t", (1, "teamB"): "ct"})
    _validate(damages, "damages")


# ── blinds ────────────────────────────────────────────────────────────────────

def test_build_blinds_filters_invalid_steamids():
    """Blinds with invalid flasher/flashed steamids must be dropped."""
    blinds_raw = [
        {
            "total_rounds_played": 1, "tick": 500,
            "attacker_steamid": "76561198000000001",
            "user_steamid": "invalid",  # invalid
            "blind_duration": 2.5,
        }
    ]
    team_map = {"76561198000000001": "teamA"}
    result = _build_blinds({"blinds": blinds_raw}, team_map, {})
    assert result == []

def test_build_blinds_v2_fields():
    """v2 adds: flashId field."""
    blinds_raw = [
        {
            "total_rounds_played": 1, "tick": 500,
            "attacker_steamid": "76561198000000001",
            "user_steamid": "76561198000000002",
            "blind_duration": 2.5,
        }
    ]
    team_map = {"76561198000000001": "teamA", "76561198000000002": "teamB"}
    side_map = {(1, "teamA"): "t", (1, "teamB"): "ct"}
    result = _build_blinds({"blinds": blinds_raw}, team_map, side_map)
    assert len(result) == 1
    assert "flashId" in result[0]
    assert result[0]["flashId"] is None

def test_build_blinds_duration_clamped_to_6():
    blinds_raw = [
        {
            "total_rounds_played": 1, "tick": 500,
            "attacker_steamid": "76561198000000001",
            "user_steamid": "76561198000000002",
            "blind_duration": 10.0,  # over max
        }
    ]
    team_map = {"76561198000000001": "teamA", "76561198000000002": "teamB"}
    side_map = {(1, "teamA"): "t", (1, "teamB"): "ct"}
    result = _build_blinds({"blinds": blinds_raw}, team_map, side_map)
    assert result[0]["durationSeconds"] <= 6.0


# ── bombs ─────────────────────────────────────────────────────────────────────

def test_build_bombs_type_values():
    raw = {
        "bomb_planted":  [{"total_rounds_played": 1, "tick": 1000, "site": "434"}],
        "bomb_defused":  [{"total_rounds_played": 2, "tick": 2000, "site": "433"}],
        "bomb_exploded": [{"total_rounds_played": 3, "tick": 3000}],
    }
    bombs = _build_bombs(raw, {}, {})
    types = {b["type"] for b in bombs}
    assert types == {"planted", "defused", "exploded"}

def test_build_bombs_filters_warmup():
    raw = {
        "bomb_planted": [
            {"total_rounds_played": 0, "tick": 100, "site": "434"},  # warmup
            {"total_rounds_played": 1, "tick": 5000, "site": "434"},
        ],
        "bomb_defused": [], "bomb_exploded": [],
    }
    bombs = _build_bombs(raw, {}, {})
    assert all(b["roundNumber"] > 0 for b in bombs)
    assert len(bombs) == 1

def test_build_bombs_has_siteId_field():
    """v2 adds siteId field."""
    raw = {"bomb_planted": [{"total_rounds_played": 1, "tick": 1000, "site": "434"}],
           "bomb_defused": [], "bomb_exploded": []}
    bombs = _build_bombs(raw, {}, {})
    assert "siteId" in bombs[0], "siteId must be present in v2 bomb output"

def test_build_bombs_position_non_nullable():
    """v2: position must be non-nullable vec3."""
    raw = {"bomb_planted": [{"total_rounds_played": 1, "tick": 1000, "site": "434"}],
           "bomb_defused": [], "bomb_exploded": []}
    bombs = _build_bombs(raw, {}, {})
    pos = bombs[0]["position"]
    assert isinstance(pos, dict)
    assert all(k in pos for k in ("x", "y", "z"))

def test_build_bombs_schema_valid():
    raw = {
        "bomb_planted":  [{"total_rounds_played": 1, "tick": 1000, "site": "434"}],
        "bomb_defused":  [{"total_rounds_played": 2, "tick": 2500, "site": "433"}],
        "bomb_exploded": [{"total_rounds_played": 3, "tick": 3000}],
    }
    bombs = _build_bombs(raw, {}, {})
    _validate(bombs, "bombs")


# ── shots ─────────────────────────────────────────────────────────────────────

def test_build_shots_has_velocity_field():
    raw = {"fires": [{"total_rounds_played": 1, "tick": 100, "user_steamid": "76561198000000001",
                      "weapon": "ak47"}]}
    shots = _build_shots(raw, {"76561198000000001": "teamA"}, {(1, "teamA"): "t"})
    assert "velocity" in shots[0]

def test_build_shots_velocity_is_vec3():
    """v2: velocity must be a non-nullable vec3."""
    raw = {"fires": [{"total_rounds_played": 1, "tick": 100, "user_steamid": "76561198000000001",
                      "weapon": "ak47", "user_vel_X": 100.0, "user_vel_Y": 50.0, "user_vel_Z": 0.0}]}
    shots = _build_shots(raw, {"76561198000000001": "teamA"}, {(1, "teamA"): "t"})
    vel = shots[0]["velocity"]
    assert isinstance(vel, dict)
    assert all(k in vel for k in ("x", "y", "z"))
    assert vel["x"] == pytest.approx(100.0)

def test_build_shots_filters_invalid_steamid():
    """Shots with invalid steamId64 must be dropped."""
    raw = {"fires": [{"total_rounds_played": 1, "tick": 100, "steamid": "invalid",
                      "weapon": "ak47"}]}
    shots = _build_shots(raw, {}, {})
    assert shots == []

def test_build_shots_schema_valid():
    raw = {"fires": [{"total_rounds_played": 1, "tick": 100, "user_steamid": "76561198000000001",
                      "weapon": "ak47", "yaw": 90.0, "pitch": 5.0,
                      "X": 0.0, "Y": 0.0, "Z": 0.0,
                      "user_vel_X": 0.0, "user_vel_Y": 0.0, "user_vel_Z": 0.0}]}
    shots = _build_shots(raw, {"76561198000000001": "teamA"}, {(1, "teamA"): "t"})
    _validate(shots, "shots")


# ── grenades ─────────────────────────────────────────────────────────────────

def test_build_grenades_links_throw_to_detonation():
    raw = {
        "grenade_throws": [
            {"total_rounds_played": 1, "tick": 100, "weapon": "smokegrenade",
             "user_steamid": "76561198000000001", "X": 10.0, "Y": 20.0, "Z": 30.0}
        ],
        "grenade_detonations": [
            {"total_rounds_played": 1, "tick": 200, "_grenade_type": "smoke",
             "user_steamid": "76561198000000001", "X": 15.0, "Y": 25.0, "Z": 0.0}
        ],
    }
    team_map = {"76561198000000001": "teamA"}
    grenades = _build_grenades(raw, team_map, {(1, "teamA"): "t"})
    assert len(grenades) == 1
    g = grenades[0]
    assert g["throwerSteamId64"] == "76561198000000001"
    assert g["throwTick"] == 100
    assert g["throwPosition"] == {"x": 10.0, "y": 20.0, "z": 30.0}

def test_build_grenades_v2_fields():
    """v2 adds: grenadeId, destroyTick."""
    raw = {
        "grenade_throws": [
            {"total_rounds_played": 1, "tick": 100, "weapon": "smokegrenade",
             "user_steamid": "76561198000000001", "X": 10.0, "Y": 20.0, "Z": 30.0}
        ],
        "grenade_detonations": [
            {"total_rounds_played": 1, "tick": 200, "_grenade_type": "smoke",
             "user_steamid": "76561198000000001"}
        ],
    }
    team_map = {"76561198000000001": "teamA"}
    grenades = _build_grenades(raw, team_map, {(1, "teamA"): "t"})
    assert len(grenades) == 1
    g = grenades[0]
    assert "grenadeId" in g
    assert "destroyTick" in g
    assert g["grenadeId"] is None
    assert g["destroyTick"] is None

def test_build_grenades_skips_warmup_round_zero():
    raw = {
        "grenade_throws": [
            {"total_rounds_played": 0, "tick": 50, "weapon": "flashbang",
             "user_steamid": "76561198000000001", "X": 1.0, "Y": 2.0, "Z": 3.0}
        ],
        "grenade_detonations": [
            {"total_rounds_played": 0, "tick": 60, "_grenade_type": "flashbang"}
        ],
    }
    assert _build_grenades(raw, {}, {}) == []

def test_build_grenades_filters_invalid_steamid():
    """Grenades with invalid thrower steamid must be dropped."""
    raw = {
        "grenade_throws": [],
        "grenade_detonations": [
            {"total_rounds_played": 1, "tick": 200, "_grenade_type": "smoke",
             "user_steamid": "invalid"}
        ],
    }
    grenades = _build_grenades(raw, {}, {})
    assert grenades == []


# ── player stats ──────────────────────────────────────────────────────────────

def test_build_player_stats_includes_rounds():
    rounds = [{"roundNumber": i} for i in range(1, 23)]
    raw = {
        "deaths": [
            {"total_rounds_played": 1, "tick": 10,
             "attacker_steamid": "76561198000000001",
             "user_steamid": "76561198000000002"}
        ],
        "hurts": [],
    }
    team_map = {"76561198000000001": "teamA", "76561198000000002": "teamB"}
    stats = _build_player_stats(raw, team_map, {}, rounds, kills_list=[])
    by_sid = {s["steamId64"]: s for s in stats}
    assert by_sid["76561198000000001"]["rounds"] == 22
    assert by_sid["76561198000000002"]["rounds"] == 22

def test_build_player_stats_has_wallbang_and_collateral_fields():
    rounds = [{"roundNumber": 1}]
    raw2 = {
        "deaths": [{"total_rounds_played": 1, "tick": 10,
                    "attacker_steamid": "76561198000000001",
                    "user_steamid": "76561198000000002"}],
        "hurts": [],
    }
    team_map = {"76561198000000001": "teamA", "76561198000000002": "teamB"}
    stats2 = _build_player_stats(raw2, team_map, {}, rounds, kills_list=[])
    for s in stats2:
        assert "wallbangKillCount" in s
        assert "collateralKillCount" in s

def test_build_player_stats_has_v2_fields():
    """v2 adds: flashAssistCount, enemyFlashDurationSeconds, teamFlashDurationSeconds,
    combatDeathCount, bombDeathCount."""
    rounds = [{"roundNumber": 1}]
    raw = {
        "deaths": [{"total_rounds_played": 1, "tick": 10,
                    "attacker_steamid": "76561198000000001",
                    "user_steamid": "76561198000000002"}],
        "hurts": [],
    }
    team_map = {"76561198000000001": "teamA", "76561198000000002": "teamB"}
    stats = _build_player_stats(raw, team_map, {}, rounds, kills_list=[])
    for s in stats:
        assert "flashAssistCount" in s
        assert "enemyFlashDurationSeconds" in s
        assert "teamFlashDurationSeconds" in s
        assert "combatDeathCount" in s
        assert "bombDeathCount" in s

def test_build_player_stats_combat_vs_bomb_deaths():
    """combatDeathCount counts killer-caused deaths; bombDeathCount counts others."""
    rounds = [{"roundNumber": 1}]
    raw = {
        "deaths": [
            # combat death (attacker present)
            {"total_rounds_played": 1, "tick": 10,
             "attacker_steamid": "76561198000000001",
             "user_steamid": "76561198000000002"},
            # bomb death (no attacker)
            {"total_rounds_played": 1, "tick": 20,
             "attacker_steamid": None,
             "user_steamid": "76561198000000002"},
        ],
        "hurts": [],
    }
    team_map = {"76561198000000001": "teamA", "76561198000000002": "teamB"}
    stats = _build_player_stats(raw, team_map, {}, rounds, kills_list=[])
    by_sid = {s["steamId64"]: s for s in stats}
    assert by_sid["76561198000000002"]["combatDeathCount"] == 1
    assert by_sid["76561198000000002"]["bombDeathCount"] == 1

def test_build_player_stats_flash_durations_from_blinds():
    """enemyFlashDurationSeconds / teamFlashDurationSeconds computed from blinds_list."""
    rounds = [{"roundNumber": 1}]
    raw = {"deaths": [], "hurts": []}
    team_map = {"76561198000000001": "teamA", "76561198000000002": "teamB",
                "76561198000000003": "teamA"}
    # flasher=001(A), flashed=002(B) → enemy flash
    # flasher=001(A), flashed=003(A) → team flash
    blinds_list = [
        {"flasherSteamId64": "76561198000000001", "flashedSteamId64": "76561198000000002",
         "durationSeconds": 2.5},
        {"flasherSteamId64": "76561198000000001", "flashedSteamId64": "76561198000000003",
         "durationSeconds": 1.5},
    ]
    stats = _build_player_stats(raw, team_map, {}, rounds, kills_list=[], blinds_list=blinds_list)
    by_sid = {s["steamId64"]: s for s in stats}
    p = by_sid.get("76561198000000001")
    assert p is not None
    assert p["enemyFlashDurationSeconds"] == pytest.approx(2.5)
    assert p["teamFlashDurationSeconds"] == pytest.approx(1.5)

def test_build_player_stats_damage_excludes_warmup_and_team():
    """damageHealth must only count official-round anti-enemy hits."""
    rounds = [{"roundNumber": 1}]
    hurts = [
        # warmup — excluded
        {"total_rounds_played": 0, "tick": 50,
         "attacker_steamid": "76561198000000001", "user_steamid": "76561198000000002",
         "weapon": "ak47", "dmg_health": 100, "dmg_armor": 0, "health": 0, "armor": 0},
        # self-damage — excluded
        {"total_rounds_played": 1, "tick": 100,
         "attacker_steamid": "76561198000000001", "user_steamid": "76561198000000001",
         "weapon": "hegrenade", "dmg_health": 30, "dmg_armor": 0, "health": 70, "armor": 0},
        # team damage — excluded
        {"total_rounds_played": 1, "tick": 200,
         "attacker_steamid": "76561198000000001", "user_steamid": "76561198000000003",
         "weapon": "ak47", "dmg_health": 50, "dmg_armor": 0, "health": 50, "armor": 0},
        # valid enemy damage — counted
        {"total_rounds_played": 1, "tick": 300,
         "attacker_steamid": "76561198000000001", "user_steamid": "76561198000000002",
         "weapon": "ak47", "dmg_health": 80, "dmg_armor": 10, "health": 20, "armor": 90},
    ]
    team_map = {
        "76561198000000001": "teamA",
        "76561198000000002": "teamB",
        "76561198000000003": "teamA",  # teammate
    }
    stats = _build_player_stats({"deaths": [], "hurts": hurts}, team_map, {}, rounds, kills_list=[])
    by_sid = {s["steamId64"]: s for s in stats}
    assert by_sid["76561198000000001"]["damageHealth"] == 80

def test_build_player_stats_schema_valid():
    rounds = [{"roundNumber": i} for i in range(1, 4)]
    raw = {
        "deaths": [{"total_rounds_played": 1, "tick": 10,
                    "attacker_steamid": "76561198000000001",
                    "user_steamid": "76561198000000002"}],
        "hurts": [],
    }
    team_map = {"76561198000000001": "teamA", "76561198000000002": "teamB"}
    stats = _build_player_stats(raw, team_map, {}, rounds, kills_list=[])
    _validate(stats, "playerStats")
