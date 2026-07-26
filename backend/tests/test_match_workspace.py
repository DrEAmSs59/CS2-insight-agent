from __future__ import annotations

from dataclasses import dataclass

from app import native_table as pd

from app.parser.match_workspace import (
    _build_round_windows,
    _enrich_grenade_events,
    _extract_grenade_trajectories,
    _player_stats,
    build_match_workspace,
)


def test_final_round_window_keeps_visible_result_tail_until_demo_end():
    windows = _build_round_windows(
        round_freeze_end_ticks={1: 100},
        round_freeze_start_ticks={1: 50},
        round_end_tick_map={1: 500},
        re_df=pd.DataFrame(),
        match_start_tick=1,
        tick_rate=64,
        demo_end_tick=620,
    )

    assert windows[0]["round_end_tick"] == 500
    assert windows[0]["end_tick"] == 620
    assert windows[0]["record_end_tick"] == 620


@dataclass
class _SharedFacts:
    round_end_tick_map: dict[int, int]
    match_summary: tuple[int, int, str, int, str, str]
    demo_max_tick: int

    def roster_snapshot(self):
        return [
            {"name": "Alpha", "steamid64": "1", "team_num": 2},
            {"name": "Bravo", "steamid64": "2", "team_num": 3},
        ]


class _Parser:
    def parse_grenades(self):
        return pd.DataFrame([
            {"grenade_type": "CSmokeGrenadeProjectile", "grenade_entity_id": 7, "tick": 160, "x": 100.0, "y": 200.0, "z": 20.0, "steamid": "1", "name": "Alpha"},
            {"grenade_type": "CSmokeGrenadeProjectile", "grenade_entity_id": 7, "tick": 170, "x": 150.0, "y": 250.0, "z": 30.0, "steamid": "1", "name": "Alpha"},
            {"grenade_type": "CSmokeGrenadeProjectile", "grenade_entity_id": 7, "tick": 179, "x": 210.0, "y": 310.0, "z": 10.0, "steamid": "1", "name": "Alpha"},
        ])


class _SmokeWithStationaryTailParser:
    def parse_grenades(self):
        return pd.DataFrame([
            {"grenade_type": "CSmokeGrenadeProjectile", "grenade_entity_id": 9, "tick": 100, "x": 0.0, "y": 0.0, "steamid": "1", "name": "Alpha"},
            {"grenade_type": "CSmokeGrenadeProjectile", "grenade_entity_id": 9, "tick": 110, "x": 100.0, "y": 50.0, "steamid": "1", "name": "Alpha"},
            {"grenade_type": "CSmokeGrenadeProjectile", "grenade_entity_id": 9, "tick": 120, "x": 180.0, "y": 90.0, "steamid": "1", "name": "Alpha"},
            {"grenade_type": "CSmokeGrenadeProjectile", "grenade_entity_id": 9, "tick": 130, "x": 180.0, "y": 90.0, "steamid": "1", "name": "Alpha"},
            {"grenade_type": "CSmokeGrenadeProjectile", "grenade_entity_id": 9, "tick": 160, "x": 180.0, "y": 90.0, "steamid": "1", "name": "Alpha"},
        ])


def test_smoke_trajectory_discards_stationary_effect_tail():
    trajectories = _extract_grenade_trajectories(_SmokeWithStationaryTailParser(), 64)

    assert len(trajectories) == 1
    assert trajectories[0]["throw_tick"] == 100
    assert trajectories[0]["end_tick"] == 130
    assert [point["tick"] for point in trajectories[0]["points"]] == [100, 110, 120, 130]


def test_grenade_trajectory_never_matches_a_different_known_actor():
    events = {1: [{"type": "grenade", "kind": "烟雾弹", "tick": 200, "actor": "Alpha"}]}
    trajectories = [{
        "kind": "烟雾弹",
        "actor": "Bravo",
        "throw_tick": 100,
        "end_tick": 199,
        "points": [{"tick": 100, "x": 0.0, "y": 0.0}, {"tick": 199, "x": 10.0, "y": 10.0}],
    }]
    windows = [{"round_number": 1, "start_tick": 50, "end_tick": 300}]

    _enrich_grenade_events(events, trajectories, windows, 64)

    assert "trajectory" not in events[1][0]
    assert "throw_tick" not in events[1][0]


def test_build_match_workspace_reuses_shared_parse_for_all_views():
    deaths = pd.DataFrame([
        {
            "tick": 150,
            "total_rounds_played": 0,
            "attacker_name": "Alpha",
            "user_name": "Bravo",
            "weapon": "ak47",
            "headshot": True,
            "attacker_X": 100.0,
            "attacker_Y": 200.0,
            "attacker_Z": 50.0,
            "user_X": 300.0,
            "user_Y": 400.0,
            "user_Z": -25.0,
        },
        {
            "tick": 350,
            "total_rounds_played": 0,
            "attacker_name": "Bravo",
            "user_name": "Alpha",
            "weapon": "awp",
            "headshot": False,
        },
        {
            "tick": 510,
            "total_rounds_played": 0,
            "attacker_name": "Alpha",
            "user_name": "Bravo",
            "weapon": "glock",
            "headshot": False,
        },
    ])
    hurt = pd.DataFrame([
        {"tick": 149, "attacker_name": "Alpha", "user_name": "Bravo", "weapon": "ak47", "dmg_health": 120, "health": 0, "user_steamid": "2"},
        {"tick": 349, "attacker_name": "Bravo", "user_name": "Alpha", "weapon": "awp", "dmg_health": 100, "health": 0, "user_steamid": "1"},
    ])
    round_end = pd.DataFrame([
        {"tick": 250, "total_rounds_played": 1, "winner": 2, "reason": "TargetSaved"},
        {"tick": 500, "total_rounds_played": 2, "winner": 3, "reason": "TerroristsWin"},
    ])
    economy = pd.DataFrame([
        {"tick": 100, "name": "Alpha", "current_equip_value": 800, "cash_spent_this_round": 800, "start_balance": 800},
        {"tick": 100, "name": "Bravo", "current_equip_value": 800, "cash_spent_this_round": 800, "start_balance": 800},
        {"tick": 300, "name": "Alpha", "current_equip_value": 3000, "cash_spent_this_round": 3000, "start_balance": 3500},
        {"tick": 300, "name": "Bravo", "current_equip_value": 1500, "cash_spent_this_round": 1500, "start_balance": 2000},
    ])
    grenade = pd.DataFrame([
        {"tick": 180, "total_rounds_played": 0, "user_name": "Alpha", "user_X": 210.0, "user_Y": 310.0, "user_Z": 10.0},
    ])
    shared_events = {
        "events": deaths,
        "hurt_df": hurt,
        "fire_df": pd.DataFrame([
            {
                "tick": 175,
                "total_rounds_played": 0,
                "user_name": "Alpha",
                "weapon": "ak47",
                "user_X": 180.0,
                "user_Y": 280.0,
                "user_Z": 45.0,
                "user_yaw": 45.0,
                "user_pitch": -2.0,
            },
            {
                "tick": 176,
                "total_rounds_played": 0,
                "user_name": "Alpha",
                "weapon": "smokegrenade",
            },
        ]),
        "planted_df": pd.DataFrame([{
            "tick": 200,
            "total_rounds_played": 0,
            "user_name": "Alpha",
            "user_last_place_name": "BombsiteB",
            "user_X": 333.0,
            "user_Y": 444.0,
            "site": 485,
        }]),
        "defused_df": pd.DataFrame(),
        "bomb_exploded_df": pd.DataFrame([
            {"tick": 220, "total_rounds_played": 0, "user_name": "Alpha"},
            {"tick": 230, "total_rounds_played": 0, "user_name": "Alpha"},
        ]),
        "bomb_dropped_df": pd.DataFrame(),
        "bomb_pickup_df": pd.DataFrame([{
            "tick": 90,
            "total_rounds_played": 0,
            "user_name": "Alpha",
            "user_X": 120.0,
            "user_Y": 220.0,
        }]),
        "nade_batch": {"smokegrenade_detonate": grenade},
        "re_df_cached": round_end,
        "round_freeze_end_ticks_shared": {1: 100, 2: 300},
        "round_freeze_start_ticks_shared": {1: 50, 2: 260},
        "tick_to_round_shared": {100: 1, 300: 2},
        "economy_ticks_df": economy,
        "economy_map_shared": {1: {2: 4000, 3: 4000}, 2: {2: 15000, 3: 8000}},
        "name_to_final_team_shared": {"alpha": 2, "bravo": 3},
        "group_side_by_round_shared": {1: {2: 2, 3: 3}, 13: {2: 3, 3: 2}},
    }
    facts = _SharedFacts(
        round_end_tick_map={1: 250, 2: 500},
        match_summary=(1, 1, "2026-07-22", 5, "Alpha Team", "Bravo Team"),
        demo_max_tick=500,
    )

    result = build_match_workspace(
        map_name="de_mirage",
        tick_rate=64,
        match_start_tick=1,
        shared_events=shared_events,
        shared_facts=facts,
        player_results={"Alpha": {}, "Bravo": {}},
        parser=_Parser(),
    )

    assert result["version"] == 1
    assert result["team_a_name"] == "Alpha Team"
    assert result["team_b_name"] == "Bravo Team"
    assert len(result["players"]) == 2
    assert {row["name"]: row["kills"] for row in result["players"]} == {"Alpha": 1, "Bravo": 1}
    assert len(result["rounds"]) == 2
    assert result["rounds"][0]["winner_team_key"] == "a"
    assert result["rounds"][1]["winner_team_key"] == "b"
    assert result["rounds"][0]["round_end_tick"] == 250
    assert result["rounds"][0]["end_tick"] == 259
    assert result["rounds"][0]["team_a_score_after"] == 1
    assert result["rounds"][1]["team_b_score_after"] == 1
    kill = next(event for event in result["rounds"][0]["events"] if event["type"] == "kill")
    assert kill["actor_x"] == 100.0
    assert kill["actor_z"] == 50.0
    assert kill["target_z"] == -25.0
    smoke = next(event for event in result["rounds"][0]["events"] if event["type"] == "grenade")
    assert smoke["kind"] == "烟雾弹"
    assert smoke["x"] == 210.0
    assert smoke["y"] == 310.0
    assert smoke["z"] == 10.0
    assert smoke["throw_tick"] == 160
    assert len(smoke["trajectory"]) == 3
    assert [point["z"] for point in smoke["trajectory"]] == [20.0, 30.0, 10.0]
    plant = next(event for event in result["rounds"][0]["events"] if event["type"] == "plant")
    assert plant["site"] == "B"
    assert plant["x"] == 333.0
    assert plant["y"] == 444.0
    assert result["rounds"][0]["bomb_initial_carrier"] == "Alpha"
    assert result["rounds"][0]["site"] == "B"
    assert result["rounds"][0]["team_a_economy"] == "pistol"
    assert len([event for event in result["rounds"][0]["events"] if event["type"] == "explode"]) == 1
    assert not any(event.get("tick") == 510 for round_data in result["rounds"] for event in round_data["events"])
    assert result["rounds"][1]["events"][0]["actor"] == "Bravo"
    assert result["rounds"][0]["shots"] == [{
        "tick": 175,
        "actor": "Alpha",
        "weapon": "ak47",
        "yaw": 45.0,
        "pitch": -2.0,
        "x": 180.0,
        "y": 280.0,
        "z": 45.0,
    }]
    by_name = {row["name"]: row for row in result["players"]}
    # Overkill 120 on full HP still counts as 100 → ADR 50.0 across 2 rounds.
    assert by_name["Alpha"]["adr"] == 50.0
    assert by_name["Bravo"]["adr"] == 50.0
    assert "Alpha Team" in result["rounds"][0]["headline"]
    assert "A 队" not in result["rounds"][0]["headline"]
    assert "clutch_attempts" in by_name["Alpha"]
    assert "clutch_wins" in by_name["Alpha"]
    assert "rating" not in by_name["Alpha"]
    assert "rating" not in by_name["Bravo"]
    assert "mvp_player" not in result["summary"]
    assert "mvp_kills" not in result["summary"]
    assert "mvp_adr" not in result["summary"]
    assert "rating" not in result["derived_fields"]
    assert "mvp_player" not in result["derived_fields"]
    assert result["phase_meta"] == {
        "halftime_round": 13,
        "regulation_end_round": 24,
    }
    for round_data in result["rounds"]:
        assert isinstance(round_data["special_events"], list)


def test_player_stats_records_clutch_max_opponents_and_multikill():
    """Clutch uses max opponents when solo; 4+ kills emit multikill."""
    roster = [
        {"name": "Alice", "steamid64": "1", "team_num": 2},
        {"name": "Bob", "steamid64": "2", "team_num": 2},
        {"name": "Carl", "steamid64": "3", "team_num": 2},
        {"name": "Dan", "steamid64": "4", "team_num": 2},
        {"name": "Eve", "steamid64": "5", "team_num": 3},
        {"name": "Frank", "steamid64": "6", "team_num": 3},
        {"name": "Gina", "steamid64": "7", "team_num": 3},
        {"name": "Hank", "steamid64": "8", "team_num": 3},
    ]
    player_team = {
        "alice": "a", "bob": "a", "carl": "a", "dan": "a",
        "eve": "b", "frank": "b", "gina": "b", "hank": "b",
    }
    # Round 1: teammates die → Alice 1v4; she then gets 4 kills and wins.
    events_by_round = {
        1: [
            {"type": "kill", "actor": "Eve", "target": "Bob", "assister": "", "headshot": False, "weapon": "ak47"},
            {"type": "kill", "actor": "Eve", "target": "Carl", "assister": "", "headshot": False, "weapon": "ak47"},
            {"type": "kill", "actor": "Eve", "target": "Dan", "assister": "", "headshot": False, "weapon": "ak47"},
            {"type": "kill", "actor": "Alice", "target": "Eve", "assister": "", "headshot": True, "weapon": "ak47"},
            {"type": "kill", "actor": "Alice", "target": "Frank", "assister": "", "headshot": False, "weapon": "ak47"},
            {"type": "kill", "actor": "Alice", "target": "Gina", "assister": "", "headshot": False, "weapon": "ak47"},
            {"type": "kill", "actor": "Alice", "target": "Hank", "assister": "", "headshot": False, "weapon": "ak47"},
        ],
    }
    stats, special_events_by_round = _player_stats(
        roster=roster,
        player_results={},
        events_by_round=events_by_round,
        hurt_df=pd.DataFrame(),
        player_team=player_team,
        round_numbers=[1],
        economy_rows_by_player={},
        windows=[{"round_number": 1, "freeze_end_tick": 100, "end_tick": 500}],
        round_winner_team={1: "a"},
    )

    events = special_events_by_round[1]
    clutch = next(e for e in events if e["type"] == "clutch" and e["player"] == "Alice")
    assert clutch == {
        "type": "clutch",
        "player": "Alice",
        "team_key": "a",
        "opponents": 4,
        "won": True,
    }
    multikill = next(e for e in events if e["type"] == "multikill" and e["player"] == "Alice")
    assert multikill == {
        "type": "multikill",
        "player": "Alice",
        "team_key": "a",
        "kills": 4,
    }
    by_name = {row["name"]: row for row in stats}
    assert "rating" not in by_name["Alice"]
    assert by_name["Alice"]["clutch_wins"] == 1
    assert by_name["Alice"]["four_kill_rounds"] == 1
