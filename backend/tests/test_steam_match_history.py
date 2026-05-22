import sys, time
from pathlib import Path
from unittest.mock import AsyncMock, patch, MagicMock
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.steam_match_history import (
    is_demo_expired,
    demo_expires_at_iso,
    map_enum_to_name,
    game_type_to_mode,
    calc_rating,
    build_demo_url,
    parse_match_row,
)

def test_is_demo_expired_fresh():
    ts = int(time.time()) - 3 * 24 * 3600  # 3 days ago
    assert is_demo_expired(ts) is False

def test_is_demo_expired_old():
    ts = int(time.time()) - 9 * 24 * 3600  # 9 days ago
    assert is_demo_expired(ts) is True

def test_demo_expires_at_iso():
    ts = 1716217363
    result = demo_expires_at_iso(ts)
    assert result.endswith("Z")
    assert "2024" in result

def test_map_enum_to_name():
    assert map_enum_to_name(6) == "de_mirage"
    assert map_enum_to_name(0) == "de_dust2"
    assert map_enum_to_name(99) == "unknown"

def test_game_type_to_mode():
    assert game_type_to_mode(2048) == "premier"
    assert game_type_to_mode(8) == "competitive"
    assert game_type_to_mode(0) == "competitive"

def test_calc_rating_average_player():
    # 20 kills, 16 deaths, 4 assists over 22 rounds, 70 ADR
    r = calc_rating(kills=20, deaths=16, assists=4, rounds=22, damage=70 * 22)
    assert 0.6 < r < 1.5

def test_build_demo_url():
    url = build_demo_url("3733386468353335412", "12345678901234567")
    assert url.startswith("http://replay")
    assert ".valve.net/730/" in url
    assert url.endswith(".dem.bz2")

def test_parse_match_row_win():
    raw_match = {
        "matchid": "3733386468353335412",
        "matchtime": int(time.time()) - 3600,
        "watchablematchinfo": {"game_type": 2048},
        "roundstatsall": [{
            "reservation_id": "99999",
            "map": 6,
            "num_rounds": 22,
            "match_duration": 2280,
            "team_scores": [13, 9],
            "kills":   [24], "assists": [4], "deaths": [14],
            "enemy_headshots": [12], "enemy_kills": [20], "mvps": [4],
            "scores":  [50],
        }],
    }
    result = parse_match_row(raw_match, player_index=0)
    assert result["result"] == "win"
    assert result["map"] == "de_mirage"
    assert result["kills"] == 24
    assert result["mode"] == "premier"
    assert result["demo_expired"] is False
