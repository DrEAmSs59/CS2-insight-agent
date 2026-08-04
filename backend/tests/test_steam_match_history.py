import asyncio
import bz2
import sys
import time
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.steam_match_history import (
    _animated_avatar_url_from_profile_html,
    _official_steam_avatar_url,
    _steam_public_profile_cache,
    _decompress_bz2_atomic,
    fetch_public_player_summaries,
    is_demo_expired,
    demo_expires_at_iso,
    map_enum_to_name,
    game_type_to_mode,
    calc_rating,
    build_demo_url,
    parse_match_row,
)
from app import main
from app.env_utils import AppConfig


def test_official_steam_avatar_url_accepts_only_https_steam_cdn():
    avatar = "https://avatars.cloudflare.steamstatic.com/abc_full.jpg"
    assert _official_steam_avatar_url(avatar) == avatar
    animated = (
        "https://shared.fastly.steamstatic.com/community_assets/images/items/2928650/"
        "119373dde20ed21e9e784e98323cfd6ee4ef264d.gif"
    )
    assert _official_steam_avatar_url(animated) == animated
    assert _official_steam_avatar_url("//avatars.steamstatic.com/abc.jpg") == "https://avatars.steamstatic.com/abc.jpg"
    assert _official_steam_avatar_url("http://avatars.steamstatic.com/abc.jpg") == ""
    assert _official_steam_avatar_url("https://example.com/abc.jpg") == ""


def test_animated_avatar_url_is_scoped_to_profile_avatar_container():
    animated = (
        "https://shared.fastly.steamstatic.com/community_assets/images/items/2928650/"
        "119373dde20ed21e9e784e98323cfd6ee4ef264d.gif"
    )
    html = f"""
        <img src="https://shared.fastly.steamstatic.com/unrelated.gif">
        <div class="playerAvatarAutoSizeInner">
            <picture>
                <source media="(prefers-reduced-motion: reduce)"
                        srcset="https://shared.fastly.steamstatic.com/community_assets/images/items/2928650/static.jpg">
                <img srcset="{animated}">
            </picture>
        </div>
    """

    assert _animated_avatar_url_from_profile_html(html) == animated


def test_public_player_summary_prefers_profile_animated_avatar(monkeypatch):
    steam_id = "76561197996678278"
    static = "https://avatars.fastly.steamstatic.com/static_full.jpg"
    animated = (
        "https://shared.fastly.steamstatic.com/community_assets/images/items/2928650/"
        "119373dde20ed21e9e784e98323cfd6ee4ef264d.gif"
    )
    requested_urls: list[str] = []

    class FakeResponse:
        def __init__(self, *, payload=None, text=""):
            self._payload = payload
            self.text = text

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, _exc_type, _exc, _traceback):
            return None

        async def get(self, url, **_kwargs):
            requested_urls.append(url)
            if "/miniprofile/" in url:
                return FakeResponse(payload={"persona_name": "TeSeS", "avatar_url": static})
            return FakeResponse(
                text=(
                    '<div class="playerAvatarAutoSizeInner"><picture>'
                    '<source media="(prefers-reduced-motion: reduce)" '
                    'srcset="https://shared.fastly.steamstatic.com/static.jpg">'
                    f'<img srcset="{animated}"></picture></div>'
                )
            )

    monkeypatch.setattr("app.steam_match_history.httpx.AsyncClient", lambda **_kwargs: FakeClient())
    _steam_public_profile_cache.clear()

    result = asyncio.run(fetch_public_player_summaries([steam_id]))

    assert result == [{"steamid": steam_id, "personaname": "TeSeS", "avatarfull": animated}]
    assert requested_urls == [
        "https://steamcommunity.com/miniprofile/36412550/json",
        f"https://steamcommunity.com/profiles/{steam_id}/",
    ]


def test_player_avatar_route_is_disabled_without_network_opt_in(monkeypatch):
    public_lookup = AsyncMock(side_effect=AssertionError("disabled setting must not make a request"))
    monkeypatch.setattr(main, "load_config", lambda: AppConfig(steam_cdn_assets_enabled=False))
    monkeypatch.setattr(main, "fetch_public_player_summaries", public_lookup)

    result = asyncio.run(main.get_steam_player_avatars("76561198000000001"))

    assert result == {"enabled": False, "avatars": {}}
    public_lookup.assert_not_awaited()


def test_player_avatar_route_filters_ids_and_non_steam_urls(monkeypatch):
    steam_id = "76561198000000001"
    public_lookup = AsyncMock(return_value=[
        {"steamid": steam_id, "avatarfull": "https://avatars.cloudflare.steamstatic.com/abc_full.jpg"},
        {"steamid": "76561198000000002", "avatarfull": "https://example.com/not-steam.jpg"},
    ])
    monkeypatch.setattr(main, "load_config", lambda: AppConfig(steam_cdn_assets_enabled=True))
    monkeypatch.setattr(main, "fetch_public_player_summaries", public_lookup)

    result = asyncio.run(main.get_steam_player_avatars(f"bad,{steam_id},{steam_id}"))

    assert result == {
        "enabled": True,
        "avatars": {steam_id: "https://avatars.cloudflare.steamstatic.com/abc_full.jpg"},
    }
    public_lookup.assert_awaited_once_with([steam_id])


def test_decompress_bz2_publishes_complete_demo_atomically(tmp_path: Path):
    compressed = tmp_path / "match.dem.bz2"
    compressed.write_bytes(bz2.compress(b"complete-demo"))
    destination = tmp_path / "match.dem"

    _decompress_bz2_atomic(compressed, destination)

    assert destination.read_bytes() == b"complete-demo"
    assert not list(tmp_path.glob(".match.dem.*.partial"))


def test_decompress_bz2_failure_preserves_existing_demo(tmp_path: Path):
    compressed = tmp_path / "broken.dem.bz2"
    compressed.write_bytes(b"not-bzip2")
    destination = tmp_path / "broken.dem"
    destination.write_bytes(b"known-good-demo")

    with pytest.raises(OSError):
        _decompress_bz2_atomic(compressed, destination)

    assert destination.read_bytes() == b"known-good-demo"
    assert not list(tmp_path.glob(".broken.dem.*.partial"))


def test_decompress_bz2_publishes_complete_demo_atomically(tmp_path: Path):
    compressed = tmp_path / "match.dem.bz2"
    compressed.write_bytes(bz2.compress(b"complete-demo"))
    destination = tmp_path / "match.dem"

    _decompress_bz2_atomic(compressed, destination)

    assert destination.read_bytes() == b"complete-demo"
    assert not list(tmp_path.glob(".match.dem.*.partial"))


def test_decompress_bz2_failure_preserves_existing_demo(tmp_path: Path):
    compressed = tmp_path / "broken.dem.bz2"
    compressed.write_bytes(b"not-bzip2")
    destination = tmp_path / "broken.dem"
    destination.write_bytes(b"known-good-demo")

    with pytest.raises(OSError):
        _decompress_bz2_atomic(compressed, destination)

    assert destination.read_bytes() == b"known-good-demo"
    assert not list(tmp_path.glob(".broken.dem.*.partial"))

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


def test_parse_match_row_rounds_strip_delta():
    """rounds_strip should encode per-round win/loss, not cumulative score."""
    # Round 1: own wins (1-0), Round 2: opp wins (1-1), Round 3: own wins (2-1)
    raw_match = {
        "matchid": "111",
        "matchtime": int(time.time()) - 3600,
        "watchablematchinfo": {"game_type": 2048},
        "roundstatsall": [
            {"reservation_id": "1", "map": 6, "num_rounds": 1, "match_duration": 90,
             "team_scores": [1, 0], "kills": [1], "assists": [0], "deaths": [0],
             "enemy_headshots": [0], "enemy_kills": [1], "mvps": [0]},
            {"reservation_id": "2", "map": 6, "num_rounds": 2, "match_duration": 180,
             "team_scores": [1, 1], "kills": [0], "assists": [0], "deaths": [1],
             "enemy_headshots": [0], "enemy_kills": [0], "mvps": [0]},
            {"reservation_id": "3", "map": 6, "num_rounds": 3, "match_duration": 270,
             "team_scores": [2, 1], "kills": [1], "assists": [0], "deaths": [0],
             "enemy_headshots": [1], "enemy_kills": [1], "mvps": [1]},
        ],
    }
    result = parse_match_row(raw_match, player_index=0)
    rounds = result["rounds"]
    assert rounds[0] is True,  "Round 1: own scored (delta 1-0) → True"
    assert rounds[1] is False, "Round 2: opp scored (delta 0-1) → False"
    assert rounds[2] is True,  "Round 3: own scored (delta 1-0) → True"
    assert rounds[3] is None,  "Round 4+: not played → None"
    assert len(rounds) == 24,  "Always padded to 24"
