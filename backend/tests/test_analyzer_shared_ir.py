import inspect
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.parser import analyzer as analyzer_module
from app.parser.analyzer import DemoAnalyzer
from app.parser.parse_utils import _max_demo_tick
from app.parser.player_roster import (
    build_player_name_to_steam_id,
    build_player_name_to_user_id,
)
from app.parser.round_economy import build_round_scores


class _ParserMustNotRun:
    def __getattr__(self, name):
        raise AssertionError(f"unexpected native parser call: {name}")


def test_precomputed_frames_do_not_reparse_death_or_round_events():
    parser = _ParserMustNotRun()
    deaths = pd.DataFrame(
        [
            {
                "tick": 120,
                "user_name": "alpha",
                "user_user_id": 2,
                "user_steamid": "76561198000000001",
                "attacker_name": "bravo",
                "attacker_user_id": 7,
                "attacker_steamid": "76561198000000002",
            }
        ]
    )
    round_ends = pd.DataFrame(
        [
            {"tick": 100, "total_rounds_played": 1, "winner": "T"},
            {"tick": 200, "total_rounds_played": 2, "winner": "CT"},
        ]
    )

    assert build_player_name_to_user_id(
        parser, 0, death_events=deaths
    ) == {"alpha": 2, "bravo": 7}
    assert build_player_name_to_steam_id(
        parser, 0, death_events=deaths
    ) == {
        "alpha": 76561198000000001,
        "bravo": 76561198000000002,
    }
    assert _max_demo_tick(parser, round_ends, 0, death_df=deaths) == 200
    assert build_round_scores(parser, 0, re_df=round_ends) == {
        1: {2: 0, 3: 0},
        2: {2: 1, 3: 0},
        3: {2: 1, 3: 1},
    }


def test_empty_precomputed_frames_retry_legacy_event_paths():
    class Parser:
        def __init__(self):
            self.calls = []

        def parse_event(self, event_name, **_kwargs):
            self.calls.append(event_name)
            if event_name == "player_death":
                return pd.DataFrame(
                    [
                        {
                            "tick": 120,
                            "user_name": "alpha",
                            "user_user_id": 2,
                            "user_steamid": "76561198000000001",
                            "attacker_name": "bravo",
                            "attacker_user_id": 7,
                            "attacker_steamid": "76561198000000002",
                        }
                    ]
                )
            if event_name == "round_end":
                return pd.DataFrame(
                    [{"tick": 200, "total_rounds_played": 1, "winner": "T"}]
                )
            raise AssertionError(event_name)

    parser = Parser()
    empty = pd.DataFrame()

    assert build_player_name_to_user_id(parser, 0, death_events=empty) == {
        "alpha": 2,
        "bravo": 7,
    }
    assert build_player_name_to_steam_id(parser, 0, death_events=empty) == {
        "alpha": 76561198000000001,
        "bravo": 76561198000000002,
    }
    assert _max_demo_tick(parser, empty, 0, death_df=empty) == 120
    assert build_round_scores(parser, 0, re_df=empty) == {
        1: {2: 0, 3: 0},
        2: {2: 1, 3: 0},
    }
    assert parser.calls == [
        "player_death",
        "player_death",
        "player_death",
        "round_end",
    ]


def test_nonempty_but_unusable_precomputed_frames_retry_legacy_paths():
    class Parser:
        def __init__(self):
            self.calls = []

        def parse_event(self, event_name, **_kwargs):
            self.calls.append(event_name)
            if event_name == "player_death":
                return pd.DataFrame(
                    [
                        {
                            "tick": 120,
                            "user_name": "alpha",
                            "user_user_id": 2,
                            "user_steamid": "76561198000000001",
                            "attacker_name": "bravo",
                            "attacker_user_id": 7,
                            "attacker_steamid": "76561198000000002",
                        }
                    ]
                )
            if event_name == "round_end":
                return pd.DataFrame(
                    [{"tick": 200, "total_rounds_played": 1, "winner": "T"}]
                )
            raise AssertionError(event_name)

    parser = Parser()
    unusable_deaths = pd.DataFrame(
        [{"tick": 120, "user_name": "alpha", "attacker_name": "bravo"}]
    )
    unusable_rounds = pd.DataFrame(
        [{"tick": 200, "total_rounds_played": 1}]
    )

    assert build_player_name_to_user_id(
        parser,
        0,
        death_events=unusable_deaths,
    ) == {"alpha": 2, "bravo": 7}
    assert build_player_name_to_steam_id(
        parser,
        0,
        death_events=unusable_deaths,
    ) == {
        "alpha": 76561198000000001,
        "bravo": 76561198000000002,
    }
    assert build_round_scores(parser, 0, re_df=unusable_rounds) == {
        1: {2: 0, 3: 0},
        2: {2: 1, 3: 0},
    }
    assert build_round_scores(
        parser,
        50,
        re_df=pd.DataFrame([{"total_rounds_played": 1, "winner": "T"}]),
    ) == {
        1: {2: 0, 3: 0},
        2: {2: 1, 3: 0},
    }
    assert parser.calls == [
        "player_death",
        "player_death",
        "round_end",
        "round_end",
    ]


def test_multi_player_analysis_builds_shared_facts_once(monkeypatch):
    empty = pd.DataFrame()
    shared_events = {
        "events": empty,
        "fire_df": empty,
        "hurt_df": empty,
        "equip_df": empty,
        "pickup_df": empty,
        "planted_df": empty,
        "defused_df": empty,
        "bomb_exploded_df": empty,
        "begindefuse_df": empty,
        "nade_batch": {},
        "re_df_cached": empty,
        "win_panel_match_tick": 0,
        "blind_df": empty,
        "economy_map_shared": {},
        "round_freeze_end_ticks_shared": {},
        "round_freeze_start_ticks_shared": {},
        "tick_to_round_shared": {},
        "economy_ticks_df": empty,
        "freeze_end_df": empty,
        "round_start_df": empty,
        "match_start_df": empty,
        "steam_to_final_team_shared": {},
        "name_to_final_team_shared": {},
        "group_side_by_round_shared": {},
        "player_info_df": empty,
    }

    class _HeaderOnlyParser:
        def __init__(self):
            self.header_calls = 0

        def parse_header(self):
            self.header_calls += 1
            return {"map_name": "de_test"}

    parser = _HeaderOnlyParser()
    analyzer = object.__new__(DemoAnalyzer)
    analyzer.dem_path = Path("fixture.dem")
    analyzer.parser = parser

    facts = object()
    fact_builds = []
    finish_facts = []

    monkeypatch.setattr(analyzer_module, "_get_match_start_tick", lambda _parser: 1)
    monkeypatch.setattr(analyzer, "_parse_shared_events", lambda _tick: shared_events)

    def fake_build_facts(**kwargs):
        fact_builds.append(kwargs)
        return facts

    monkeypatch.setattr(analyzer, "_build_shared_demo_facts", fake_build_facts)
    monkeypatch.setattr(
        analyzer_module,
        "parse_spatial_snapshots",
        lambda _parser, _ticks: ({}, {}),
    )

    def fake_finish(**kwargs):
        finish_facts.append(kwargs["shared_facts"])
        return kwargs["target_player"]

    monkeypatch.setattr(analyzer, "_finish_single_player_analysis", fake_finish)

    players = [f"player-{index}" for index in range(10)]
    result = analyzer.analyze_multi_players(players)

    assert list(result) == players
    assert len(fact_builds) == 1
    assert fact_builds[0]["expected_players"] == players
    assert finish_facts == [facts] * 10
    assert parser.header_calls == 1


def test_shared_facts_materialize_event_indexes_and_copy_rosters(monkeypatch):
    analyzer = object.__new__(DemoAnalyzer)
    analyzer.dem_path = Path("fixture.dem")
    analyzer.parser = object()

    events = pd.DataFrame(
        [
            {
                "tick": 100,
                "attacker_name": "alpha",
                "user_name": "bravo",
                "assister_name": "charlie",
            },
            {
                "tick": 200,
                "attacker_name": "delta",
                "user_name": "alpha",
                "assister_name": pd.NA,
            },
            {
                "tick": 300,
                "attacker_name": "echo",
                "user_name": "foxtrot",
                "assister_name": "alpha",
            },
        ]
    )
    round_ends = pd.DataFrame(
        [
            {"tick": 150, "total_rounds_played": 1},
            {"tick": 250, "total_rounds_played": 2},
        ]
    )
    shared_events = {
        "events": events,
        "re_df_cached": round_ends,
        "blind_df": pd.DataFrame(
            [
                {"tick": 130, "user_name": "bravo", "blind_duration": 1.5},
                {"tick": 110, "user_name": "bravo", "blind_duration": 2.0},
            ]
        ),
        "nade_batch": {
            "hegrenade_detonate": pd.DataFrame(
                [{"tick": 210, "x": 20.0, "y": 30.0}]
            ),
            "smokegrenade_detonate": pd.DataFrame(
                [{"tick": 120, "X": 10.0, "Y": 15.0}]
            ),
        },
        "bomb_exploded_df": pd.DataFrame(
            [
                {"tick": 240, "total_rounds_played": 1},
                {"tick": 245, "total_rounds_played": 1},
            ]
        ),
        "name_to_final_team_shared": {"alpha": 2, "bravo": 3},
    }

    monkeypatch.setattr(
        analyzer,
        "_build_match_summary",
        lambda *_args, **_kwargs: (13, 9, "", 42, "A", "B"),
    )
    monkeypatch.setattr(analyzer_module, "_max_demo_tick", lambda *_args, **_kwargs: 999)
    monkeypatch.setattr(
        analyzer_module,
        "build_player_name_to_user_id",
        lambda *_args, **_kwargs: {"alpha": 1, "bravo": 2},
    )
    monkeypatch.setattr(
        analyzer_module,
        "build_player_name_to_spec_player_slot_dict",
        lambda *_args, **_kwargs: {"alpha": 1, "bravo": 2},
    )
    monkeypatch.setattr(
        analyzer_module,
        "build_player_name_to_steam_id",
        lambda *_args, **_kwargs: {"alpha": 76561198000000001},
    )
    monkeypatch.setattr(
        analyzer_module,
        "_build_all_players_roster",
        lambda *_args, **_kwargs: [
            {"name": "alpha", "steamid64": "76561198000000001", "team_num": 2}
        ],
    )
    monkeypatch.setattr(
        analyzer_module,
        "build_round_scores",
        lambda *_args, **_kwargs: {1: {2: 0, 3: 0}},
    )

    facts = analyzer._build_shared_demo_facts(
        match_start_tick=1,
        header={"server_name": "FACEIT"},
        shared_events=shared_events,
    )

    assert facts.match_summary == (13, 9, "", 42, "A", "B")
    assert facts.demo_max_tick == 999
    assert facts.server_name == "FACEIT"
    assert facts.victim_blind_index == {"bravo": [(110, 2.0), (130, 1.5)]}
    assert facts.grenade_detonate_points == [
        (120, 10.0, 15.0),
        (210, 20.0, 30.0),
    ]
    assert facts.bomb_explode_tick_map == {2: 240}
    assert facts.round_end_tick_map == {1: 150, 2: 250}
    assert facts.timeline_event_positions_by_player["alpha"] == (0, 1, 2)
    assert facts.timeline_event_positions_by_player["bravo"] == (0,)
    assert facts.timeline_event_positions_by_player["charlie"] == (0,)

    first_roster = facts.roster_snapshot()
    second_roster = facts.roster_snapshot()
    first_roster[0]["name"] = "mutated"
    assert second_roster[0]["name"] == "alpha"
    assert facts.all_players_roster[0]["name"] == "alpha"


def test_per_player_finish_path_has_no_native_parser_access():
    source = inspect.getsource(DemoAnalyzer._finish_single_player_analysis)
    assert "self.parser" not in source
