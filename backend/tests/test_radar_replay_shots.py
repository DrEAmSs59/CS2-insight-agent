from __future__ import annotations

import pandas as pd

from app.radar.radar_data_extractor import extract_radar_timeline_impl


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
                    "active_weapon_name": "ak47",
                    "has_defuser": False,
                    "has_c4": True,
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
