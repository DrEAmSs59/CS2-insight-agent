from __future__ import annotations

import json

from app import native_table as pd

from app.parser import replay_match_cache


def _workspace() -> dict:
    return {
        "map_name": "de_mirage",
        "tick_rate": 64,
        "players": [
            {"name": "Alpha", "team_key": "a", "steam_id64": "1"},
            {"name": "Bravo", "team_key": "b", "steam_id64": "2"},
        ],
        "rounds": [
            {
                "round_number": 1,
                "freeze_end_tick": 100,
                "end_tick": 164,
                "team_a_side": "T",
                "team_b_side": "CT",
                "shots": [{"tick": 132, "actor": "Alpha", "weapon": "ak47"}],
                "events": [
                    {"type": "grenade", "kind": "烟雾弹", "tick": 110, "actor": "Alpha", "x": 10, "y": 20}
                ],
            },
            {
                "round_number": 2,
                "freeze_end_tick": 200,
                "end_tick": 264,
                "team_a_side": "CT",
                "team_b_side": "T",
                "events": [
                    {"type": "grenade", "kind": "燃烧弹", "tick": 210, "actor": "Alpha", "x": 30, "y": 40}
                ],
            },
        ],
    }


def test_materializes_and_reads_parquet_through_rust_extension(monkeypatch, tmp_path):
    import demoparser2
    from app.parser import replay_effects

    demo_path = tmp_path / "match.dem"
    demo_path.write_bytes(b"demo")
    cache_root = tmp_path / "replay-match"
    monkeypatch.setattr(replay_match_cache, "_cache_root", lambda: cache_root)
    write_calls: list[dict] = []
    binary_calls: list[dict] = []
    row_groups: dict[int, list[int]] = {}

    class FakeDemoParser:
        def __init__(self, path):
            self.path = path

        def write_replay_parquet(self, output_path, wanted_props, ticks, round_numbers):
            write_calls.append(
                {
                    "output_path": output_path,
                    "wanted_props": list(wanted_props),
                    "ticks": list(ticks),
                    "round_numbers": list(round_numbers),
                }
            )
            path = replay_match_cache.Path(output_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"PAR1-rust-native-test")
            ordered_rounds: list[int] = []
            for tick, round_number in zip(ticks, round_numbers, strict=True):
                if round_number not in row_groups:
                    ordered_rounds.append(round_number)
                    row_groups[round_number] = []
                row_groups[round_number].append(tick)
            return {
                "row_groups": [
                    {
                        "round_number": round_number,
                        "row_group": index,
                        "rows": len(row_groups[round_number]),
                    }
                    for index, round_number in enumerate(ordered_rounds)
                ],
                "rows": len(ticks),
                "parquet_rows": len(ticks),
            }

        @staticmethod
        def read_replay_parquet_round(_path, row_group):
            round_number = sorted(row_groups)[row_group]
            rows = []
            for tick in row_groups[round_number]:
                rows.extend(
                    [
                        {
                            "round_number": round_number,
                            "tick": tick,
                            "steamid": 1,
                            "name": "Alpha",
                            "team_num": 2 if round_number == 1 else 3,
                            "X": float(tick),
                            "Y": 20.0,
                            "Z": 0.0,
                            "yaw": 90.0,
                            "is_alive": True,
                            "health": 100,
                            "armor": 100,
                            "has_helmet": True,
                            "balance": 2500,
                            "current_equip_value": 4700,
                            "inventory": '["AK-47","Smoke Grenade"]',
                            "active_weapon": 0,
                            "active_weapon_name": "AK-47",
                            "has_defuser": False,
                            "has_c4": round_number == 1,
                            "flash_duration": 0.0,
                            "player_color": "blue",
                        },
                        {
                            "round_number": round_number,
                            "tick": tick,
                            "steamid": 2,
                            "name": "Bravo",
                            "team_num": 3 if round_number == 1 else 2,
                            "X": float(tick + 1),
                            "Y": 21.0,
                            "Z": 0.0,
                            "yaw": 180.0,
                            "is_alive": True,
                            "health": 100,
                            "armor": 100,
                            "has_helmet": True,
                            "balance": 2000,
                            "current_equip_value": 4200,
                            "inventory": '["M4A1-S"]',
                            "active_weapon": 0,
                            "active_weapon_name": "M4A1-S",
                            "has_defuser": True,
                            "has_c4": False,
                            "flash_duration": 0.0,
                            "player_color": "green",
                        },
                    ]
                )
            return pd.DataFrame(rows)

        @staticmethod
        def read_replay_parquet_round_binary(
            parquet_path,
            row_group,
            sample_ticks,
            metadata_json,
        ):
            binary_calls.append({
                "parquet_path": parquet_path,
                "row_group": row_group,
                "sample_ticks": list(sample_ticks),
                "metadata": json.loads(metadata_json),
            })
            return b"CS2RPL01-binary-test"

    monkeypatch.setattr(demoparser2, "DemoParser", FakeDemoParser)
    monkeypatch.setattr(
        replay_effects,
        "extract_dynamic_effect_tracks",
        lambda *_args, **_kwargs: {
            "version": 1,
            "capabilities": {"smoke_voxels": True, "inferno_cells": True},
            "effects": [
                {
                    "id": "smoke:1",
                    "type": "smoke",
                    "start_tick": 110,
                    "end_tick": 150,
                    "thrower_name": "Alpha",
                    "samples": [{"tick": 110, "cells": [[10.0, 20.0, 0.0, 1.0]]}],
                },
                {
                    "id": "inferno:2",
                    "type": "inferno",
                    "start_tick": 210,
                    "end_tick": 250,
                    "thrower_name": "Alpha",
                    "samples": [{"tick": 210, "cells": [[30.0, 40.0, 0.0, 1.0]]}],
                },
            ],
            "warnings": [],
            "parse_ms": 1.25,
        },
    )

    result = replay_match_cache.materialize_match_replay_parquet_impl(
        demo_path=str(demo_path),
        workspace=_workspace(),
    )

    assert result["status"] == "materialized"
    assert result["rounds"] == 2
    assert len(write_calls) == 1
    assert "inventory" in write_calls[0]["wanted_props"]
    assert set(write_calls[0]["round_numbers"]) == {1, 2}
    assert next(cache_root.glob("*.parquet")).read_bytes() == b"PAR1-rust-native-test"

    round_one = replay_match_cache.load_match_replay_round(
        str(demo_path),
        start_tick=100,
        end_tick=164,
        fps=replay_match_cache.REPLAY_MATCH_FPS,
        tick_rate=64,
    )
    assert round_one is not None
    assert len(round_one["frames"]) == 32
    assert round_one["frames"][0]["players"][0]["name"] == "Alpha"
    assert round_one["frames"][0]["players"][0]["inventory"] == ["AK-47", "Smoke Grenade"]
    assert round_one["frames"][0]["players"][0]["is_teammate"] is True
    assert round_one["frames"][0]["players"][1]["is_teammate"] is False
    assert [shot for frame in round_one["frames"] for shot in frame.get("shots", [])] == [
        {"tick": 132, "actor": "Alpha", "weapon": "ak47"}
    ]
    assert round_one["effect_tracks"][0]["side"] == "T"

    round_two = replay_match_cache.load_match_replay_round(
        str(demo_path),
        start_tick=200,
        end_tick=264,
        fps=replay_match_cache.REPLAY_MATCH_FPS,
        tick_rate=64,
    )
    assert round_two is not None
    assert round_two["frames"][0]["players"][0]["team"] == "CT"
    assert round_two["frames"][0]["players"][0]["is_teammate"] is True
    assert round_two["effect_tracks"][0]["side"] == "CT"

    binary = replay_match_cache.load_match_replay_round_binary(
        str(demo_path),
        start_tick=100,
        end_tick=164,
        fps=replay_match_cache.REPLAY_MATCH_FPS,
        tick_rate=64,
    )
    assert binary == b"CS2RPL01-binary-test"
    assert binary_calls[0]["sample_ticks"] == write_calls[0]["ticks"][:32]
    assert binary_calls[0]["metadata"]["shots"] == [
        {"tick": 132, "actor": "Alpha", "weapon": "ak47"}
    ]
    assert binary_calls[0]["metadata"]["cache"]["frames"] == "parquet_binary_hit"
    assert binary_calls[0]["metadata"]["effects_pending"] is True

    again = replay_match_cache.materialize_match_replay_parquet_impl(
        demo_path=str(demo_path),
        workspace=_workspace(),
    )
    assert again["status"] == "parquet_hit"
    assert len(write_calls) == 1
