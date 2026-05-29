"""Tests for RivalHub export helpers."""

from app.rivalhub_exporter import (
    SCHEMA_VERSION,
    _build_grenades,
    _build_player_stats,
    _build_rounds,
    _normalize_round_end_reason,
)


def test_schema_version_is_cs2_demo_format():
    assert SCHEMA_VERSION == "cs2-demo-format/1.0"


def test_normalize_round_end_reason_string():
    assert _normalize_round_end_reason("t_killed") == "ct_win"
    assert _normalize_round_end_reason("ct_killed") == "t_win"
    assert _normalize_round_end_reason("bomb_exploded") == "target_bombed"


def test_normalize_round_end_reason_legacy_int():
    assert _normalize_round_end_reason(8) == "ct_win"
    assert _normalize_round_end_reason("9") == "t_win"


def test_build_rounds_accepts_demoparser2_string_reason():
    raw = {
        "round_ends": [
            {
                "total_rounds_played": 1,
                "tick": 1000,
                "winner": "CT",
                "reason": "t_killed",
            }
        ],
        "round_starts": [],
        "round_freeze_ends": [],
    }
    team_map = {"1": "teamA"}
    rounds, _ = _build_rounds(raw, team_map)
    assert len(rounds) == 1
    assert rounds[0]["endReason"] == "ct_win"


def test_build_grenades_links_throw_to_detonation():
    raw = {
        "grenade_throws": [
            {
                "total_rounds_played": 1,
                "tick": 100,
                "weapon": "smokegrenade",
                "user_steamid": "76561198000000001",
                "X": 10.0,
                "Y": 20.0,
                "Z": 30.0,
            }
        ],
        "grenade_detonations": [
            {
                "total_rounds_played": 1,
                "tick": 200,
                "_grenade_type": "smoke",
            }
        ],
    }
    team_map = {"76561198000000001": "teamA"}
    side_map = {(1, "teamA"): "t"}
    grenades = _build_grenades(raw, team_map, side_map)
    assert len(grenades) == 1
    g = grenades[0]
    assert g["throwerSteamId64"] == "76561198000000001"
    assert g["throwTick"] == 100
    assert g["throwPosition"] == {"x": 10.0, "y": 20.0, "z": 30.0}


def test_build_grenades_skips_warmup_round_zero():
    raw = {
        "grenade_throws": [
            {
                "total_rounds_played": 0,
                "tick": 50,
                "weapon": "flashbang",
                "user_steamid": "76561198000000001",
                "X": 1.0,
                "Y": 2.0,
                "Z": 3.0,
            }
        ],
        "grenade_detonations": [
            {"total_rounds_played": 0, "tick": 60, "_grenade_type": "flashbang"},
        ],
    }
    assert _build_grenades(raw, {}, {}) == []


def test_build_player_stats_includes_rounds():
    rounds = [{"roundNumber": i} for i in range(1, 23)]
    raw = {
        "deaths": [
            {
                "total_rounds_played": 1,
                "tick": 10,
                "attacker_steamid": "76561198000000001",
                "user_steamid": "76561198000000002",
            }
        ],
        "hurts": [],
    }
    team_map = {
        "76561198000000001": "teamA",
        "76561198000000002": "teamB",
    }
    stats = _build_player_stats(raw, team_map, {}, rounds, kills_list=[])
    by_sid = {s["steamId64"]: s for s in stats}
    assert by_sid["76561198000000001"]["rounds"] == 22
    assert by_sid["76561198000000002"]["rounds"] == 22
