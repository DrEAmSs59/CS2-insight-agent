from __future__ import annotations

import pandas as pd

from app.radar.radar_data_extractor import extract_radar_timeline_impl
from app.radar.radar_map_assets import lookup_map_data, resolve_map_png_path


class _FakeParser:
    def __init__(self, _path: str):
        pass

    def parse_ticks(self, _fields, *, ticks):
        return pd.DataFrame(
            [
                {
                    "tick": tick,
                    "steamid": 123,
                    "name": "Alpha",
                    "team_num": 2,
                    "is_alive": True,
                    "X": 100.0 + tick,
                    "Y": 200.0,
                    "Z": 0.0,
                    "yaw": 90.0,
                    "health": 100,
                    "armor": 100,
                    "has_helmet": True,
                    "balance": 2450,
                    "current_equip_value": 4700,
                    "inventory": ["Karambit", "AK-47", "C4 Explosive", "Smoke Grenade", "Flashbang", "Flashbang"],
                    "active_weapon_name": "ak47",
                    "has_defuser": False,
                }
                for tick in ticks
            ],
        )

    def parse_event(self, event_name, **_kwargs):
        assert event_name == "weapon_fire"
        return pd.DataFrame(
            [
                {
                    "tick": 132,
                    "user_name": "Alpha",
                    "weapon": "ak47",
                    "user_X": 232.0,
                    "user_Y": 200.0,
                    "user_yaw": 90.0,
                    "user_pitch": -2.0,
                },
                {
                    "tick": 140,
                    "user_name": "Alpha",
                    "weapon": "smokegrenade",
                    "user_X": 240.0,
                    "user_Y": 200.0,
                },
                {
                    "tick": 200,
                    "user_name": "Alpha",
                    "weapon": "ak47",
                },
            ],
        )


def test_replay_frames_include_bullet_shots_for_legacy_workspaces(monkeypatch):
    import demoparser2

    monkeypatch.setattr(demoparser2, "DemoParser", _FakeParser)
    frames = extract_radar_timeline_impl(
        demo_path="fixture.dem",
        map_name="de_dust2",
        pov_player_name=None,
        pov_steamid64=None,
        start_tick=100,
        end_tick=164,
        fps=8,
        duration_sec=1,
        demo_tick_rate=64,
        include_all_players=True,
    )

    shots = [shot for frame in frames for shot in frame.get("shots", [])]
    player = frames[0]["players"][0]
    assert player["armor"] == 100
    assert player["has_helmet"] is True
    assert player["money"] == 2450
    assert player["equipment_value"] == 4700
    assert player["has_c4"] is True
    assert player["inventory"] == [
        "Karambit",
        "AK-47",
        "C4 Explosive",
        "Smoke Grenade",
        "Flashbang",
        "Flashbang",
    ]
    assert shots == [
        {
            "tick": 132,
            "actor": "Alpha",
            "weapon": "ak47",
            "yaw": 90.0,
            "pitch": -2.0,
            "x": 232.0,
            "y": 200.0,
        },
    ]


def test_resolves_nuke_upper_and_lower_radar_layers():
    assert resolve_map_png_path("de_nuke").name == "de_nuke.png"
    assert resolve_map_png_path("de_nuke", layer="upper").name == "de_nuke.png"
    assert resolve_map_png_path("de_nuke", layer="lower").name == "de_nuke_lower.png"


def test_resolves_locally_extracted_cache_radar_and_calibration():
    assert resolve_map_png_path("de_cache").name == "de_cache.png"
    calibration = lookup_map_data("de_cache")
    assert {
        key: calibration[key]
        for key in (
            "pos_x",
            "pos_y",
            "scale",
            "rotate",
            "zoom",
            "lower_level_max_units",
        )
    } == {
        "pos_x": -2000,
        "pos_y": 3250,
        "scale": 5.5,
        "rotate": None,
        "zoom": None,
        "lower_level_max_units": -1000000.0,
    }
    assert calibration.get("transform_version", 1) >= 1
