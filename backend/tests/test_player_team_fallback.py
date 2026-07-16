from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import Mock

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.parser.parse_utils import (
    PLAYER_CONTROLLER_TEAM_PROP,
    PLAYER_TEAM_PARSE_FIELDS,
    coalesce_player_team_num,
)
from app.parser.player_roster import (
    _build_all_players_roster,
    _build_tick_team_lookup,
    build_player_name_to_spec_player_slot_dict,
)
from app.parser.round_economy import (
    build_group_side_by_round,
    build_round_economy_shared,
    extract_target_team_map,
)
from app.parser.spatial_analysis import parse_spatial_snapshots
from app.parser.spatial_analysis import (
    _alive_mates_and_enemies,
    _victim_facing_attacker,
    enrich_kill_action_tags_spatial,
)


def test_coalesce_player_team_num_prefers_valid_alias_and_fills_from_controller():
    source = pd.DataFrame(
        {
            "name": ["missing", "valid", "invalid", "unknown"],
            "team_num": [float("nan"), 2, 0, float("nan")],
            PLAYER_CONTROLLER_TEAM_PROP: [3, 3, 2, 0],
        }
    )

    result = coalesce_player_team_num(source)

    assert result["team_num"].tolist()[:3] == [3.0, 2.0, 2.0]
    assert pd.isna(result.iloc[3]["team_num"])
    assert pd.isna(source.iloc[0]["team_num"]), "normalization must not mutate shared input"


def test_round_economy_recovers_all_players_without_an_extra_parse():
    parser = Mock()
    parser.parse_ticks.return_value = pd.DataFrame(
        [
            {
                "tick": 100,
                "name": "alpha",
                "team_num": float("nan"),
                PLAYER_CONTROLLER_TEAM_PROP: 2,
                "current_equip_value": 1000,
                "is_alive": True,
            },
            {
                "tick": 100,
                "name": "bravo",
                "team_num": 3,
                PLAYER_CONTROLLER_TEAM_PROP: 3,
                "current_equip_value": 2000,
                "is_alive": True,
            },
            {
                "tick": 200,
                "name": "alpha",
                "team_num": float("nan"),
                PLAYER_CONTROLLER_TEAM_PROP: 3,
                "current_equip_value": 3000,
                "is_alive": True,
            },
            {
                "tick": 200,
                "name": "bravo",
                "team_num": 2,
                PLAYER_CONTROLLER_TEAM_PROP: 2,
                "current_equip_value": 4000,
                "is_alive": True,
            },
        ]
    )
    freeze_end = pd.DataFrame(
        {"tick": [100, 200], "total_rounds_played": [0, 1]}
    )
    round_start = pd.DataFrame({"tick": [90, 150]})

    economy, _, _, tick_to_round, ticks_df = build_round_economy_shared(
        parser,
        freeze_end_df=freeze_end,
        round_start_df=round_start,
    )

    parser.parse_ticks.assert_called_once_with(
        PLAYER_TEAM_PARSE_FIELDS + [
            "current_equip_value", "is_alive", "name", "steamid", "user_id",
        ],
        ticks=[100, 200],
    )
    assert economy == {1: {2: 1000, 3: 2000}, 2: {2: 4000, 3: 3000}}
    assert extract_target_team_map(ticks_df, tick_to_round, "alpha") == {1: 2, 2: 3}


def test_round_economy_retries_missing_requested_ticks():
    parser = Mock()
    parser.parse_ticks.side_effect = [
        pd.DataFrame(
            [
                {
                    "tick": 100,
                    "name": "alpha",
                    "team_num": 2,
                    "current_equip_value": 1000,
                    "is_alive": True,
                }
            ]
        ),
        pd.DataFrame(
            [
                {
                    "tick": 200,
                    "name": "alpha",
                    "team_num": 3,
                    "current_equip_value": 2000,
                    "is_alive": True,
                }
            ]
        ),
    ]
    freeze_end = pd.DataFrame(
        {"tick": [100, 200], "total_rounds_played": [0, 1]}
    )

    economy, _, _, _, ticks_df = build_round_economy_shared(
        parser,
        freeze_end_df=freeze_end,
        round_start_df=pd.DataFrame({"tick": [90, 150]}),
    )

    assert parser.parse_ticks.call_count == 2
    assert parser.parse_ticks.call_args_list[1].kwargs["ticks"] == [200]
    assert set(ticks_df["tick"]) == {100, 200}
    assert economy == {1: {2: 1000, 3: 0}, 2: {2: 0, 3: 2000}}


def test_roster_and_tick_lookup_use_controller_team_fallback():
    rows = pd.DataFrame(
        [
            {
                "tick": 100,
                "name": f"player-{i}",
                "steamid": 76561198000000000 + i,
                "user_id": i + 1,
                "team_num": float("nan") if i in (0, 5) else (2 if i < 5 else 3),
                PLAYER_CONTROLLER_TEAM_PROP: 2 if i < 5 else 3,
            }
            for i in range(10)
        ]
    )
    roster_parser = Mock()
    roster_parser.parse_ticks.return_value = rows

    roster = _build_all_players_roster(
        roster_parser,
        100,
        {},
        {},
        name_to_team_pi={},
        player_ticks_df=rows,
    )

    roster_parser.parse_ticks.assert_not_called()
    assert len(roster) == 10
    assert [player["team_num"] for player in roster] == [2] * 5 + [3] * 5
    assert all(player["steamid64"] for player in roster)

    spec_parser = Mock()
    slots = build_player_name_to_spec_player_slot_dict(
        spec_parser,
        100,
        player_ticks_df=rows,
    )
    spec_parser.parse_ticks.assert_not_called()
    assert slots["player-0"] == 1
    assert slots["player-9"] == 10

    lookup_parser = Mock()
    lookup_parser.parse_ticks.return_value = rows
    lookup = _build_tick_team_lookup(lookup_parser, [100])
    assert lookup[100]["player-0"] == 2
    assert lookup[100]["player-5"] == 3


def test_spec_slot_does_not_reuse_a_snapshot_from_the_wrong_tick():
    shared = pd.DataFrame(
        {"tick": [100], "name": ["old-name"], "user_id": [1]}
    )
    parser = Mock()
    parser.parse_ticks.return_value = pd.DataFrame(
        {"tick": [200], "name": ["current-name"], "user_id": [7]}
    )

    slots = build_player_name_to_spec_player_slot_dict(
        parser,
        200,
        player_ticks_df=shared,
    )

    parser.parse_ticks.assert_called_once_with(["user_id", "name"], ticks=[200])
    assert slots == {"current-name": 7}


def test_group_side_reuses_materialized_player_ticks():
    parser = Mock()
    ticks_df = pd.DataFrame(
        [
            {
                "tick": 100,
                "steamid": 1,
                "team_num": float("nan"),
                PLAYER_CONTROLLER_TEAM_PROP: 2,
            },
            {
                "tick": 100,
                "steamid": 2,
                "team_num": 3,
                PLAYER_CONTROLLER_TEAM_PROP: 3,
            },
            {
                "tick": 200,
                "steamid": 1,
                "team_num": float("nan"),
                PLAYER_CONTROLLER_TEAM_PROP: 3,
            },
            {
                "tick": 200,
                "steamid": 2,
                "team_num": 2,
                PLAYER_CONTROLLER_TEAM_PROP: 2,
            },
        ]
    )

    result = build_group_side_by_round(
        parser,
        {1: 100, 2: 200},
        {"1": 2, "2": 3},
        player_ticks_df=ticks_df,
    )

    parser.parse_ticks.assert_not_called()
    assert result == {1: {2: 2, 3: 3}, 2: {2: 3, 3: 2}}


def test_partial_spec_snapshot_retries_and_merges_missing_player_ids():
    cached = pd.DataFrame(
        {
            "tick": [100, 100],
            "name": ["alpha", "bravo"],
            "user_id": [1, None],
        }
    )
    parser = Mock()
    parser.parse_ticks.return_value = pd.DataFrame(
        {
            "tick": [100, 100],
            "name": ["alpha", "bravo"],
            "user_id": [1, 2],
        }
    )

    slots = build_player_name_to_spec_player_slot_dict(
        parser,
        100,
        player_ticks_df=cached,
        expected_names={"alpha", "bravo"},
    )

    parser.parse_ticks.assert_called_once_with(["user_id", "name"], ticks=[100])
    assert slots == {"alpha": 1, "bravo": 2}


def test_partial_roster_snapshot_retries_and_keeps_all_expected_players():
    cached = pd.DataFrame(
        [
            {
                "tick": 100,
                "name": "alpha",
                "steamid": 1,
                "team_num": 2,
            }
        ]
    )
    parser = Mock()
    parser.parse_ticks.return_value = pd.DataFrame(
        [
            {
                "tick": 100,
                "name": "alpha",
                "steamid": 1,
                "team_num": 2,
            },
            {
                "tick": 100,
                "name": "bravo",
                "steamid": 2,
                "team_num": 3,
            },
        ]
    )

    roster = _build_all_players_roster(
        parser,
        100,
        {"alpha": 1, "bravo": 2},
        {"alpha": 1},
        name_to_team_pi={},
        player_ticks_df=cached,
    )

    parser.parse_ticks.assert_called_once()
    assert [player["name"] for player in roster] == ["alpha", "bravo"]
    assert [player["team_num"] for player in roster] == [2, 3]


def test_roster_repairs_expected_player_with_unusable_cached_team():
    rows = pd.DataFrame(
        [
            {
                "tick": 100,
                "name": f"player-{index}",
                "steamid": 76561198000000000 + index,
                "team_num": (
                    float("nan")
                    if index == 4
                    else (2 if index < 5 else 3)
                ),
                PLAYER_CONTROLLER_TEAM_PROP: (
                    float("nan")
                    if index == 4
                    else (2 if index < 5 else 3)
                ),
            }
            for index in range(10)
        ]
    )
    parser = Mock()
    parser.parse_ticks.return_value = rows
    names = {f"player-{index}" for index in range(10)}

    roster = _build_all_players_roster(
        parser,
        100,
        {name: index + 1 for index, name in enumerate(sorted(names))},
        {
            name: 76561198000000000 + index
            for index, name in enumerate(sorted(names))
        },
        name_to_team_pi={
            name: (2 if int(name.rsplit("-", 1)[1]) < 5 else 3)
            for name in names
        },
        player_ticks_df=rows,
        expected_names=names,
    )

    parser.parse_ticks.assert_called_once()
    assert len(roster) == 10
    assert {player["name"] for player in roster} == names
    repaired = next(player for player in roster if player["name"] == "player-4")
    assert repaired["team_num"] == 2


def test_group_side_retries_only_ticks_without_a_usable_observation():
    cached = pd.DataFrame(
        [
            {"tick": 100, "steamid": 1, "team_num": 2},
            {"tick": 100, "steamid": 2, "team_num": 3},
        ]
    )
    parser = Mock()
    parser.parse_ticks.return_value = pd.DataFrame(
        [
            {"tick": 200, "steamid": 1, "team_num": 3},
            {"tick": 200, "steamid": 2, "team_num": 2},
        ]
    )

    result = build_group_side_by_round(
        parser,
        {1: 100, 2: 200},
        {"1": 2, "2": 3},
        player_ticks_df=cached,
    )

    assert parser.parse_ticks.call_args.kwargs["ticks"] == [200]
    assert result == {1: {2: 2, 3: 3}, 2: {2: 3, 3: 2}}


def test_spatial_snapshot_uses_controller_team_for_alive_summary():
    parser = Mock()
    parser.parse_ticks.return_value = pd.DataFrame(
        [
            {
                "tick": 100,
                "name": "alpha",
                "is_alive": True,
                "X": 10.0,
                "Y": 20.0,
                "team_num": float("nan"),
                PLAYER_CONTROLLER_TEAM_PROP: 2,
            },
            {
                "tick": 100,
                "name": "bravo",
                "is_alive": True,
                "X": 30.0,
                "Y": 40.0,
                "team_num": 3,
                PLAYER_CONTROLLER_TEAM_PROP: 3,
            },
        ]
    )

    cache, alive = parse_spatial_snapshots(parser, [100])

    assert cache[100]["alpha"]["team_num"] == 2
    assert alive == {100: {2: frozenset({"alpha"}), 3: frozenset({"bravo"})}}
    assert _alive_mates_and_enemies(
        cache[100], "alpha", alive_by_team=alive[100],
    ) == (0, 1)


def test_controller_only_identity_makes_clutch_counts_unknown():
    parser = Mock()
    parser.parse_ticks.return_value = pd.DataFrame(
        [
            {
                "tick": 100,
                "name": "hero",
                "is_alive": True,
                "X": 10.0,
                "Y": 20.0,
                "team_num": 2,
                PLAYER_CONTROLLER_TEAM_PROP: 2,
            },
            {
                "tick": 100,
                "name": "unresolved-mate",
                "is_alive": False,
                "X": float("nan"),
                "Y": float("nan"),
                "team_num": float("nan"),
                PLAYER_CONTROLLER_TEAM_PROP: 2,
            },
            {
                "tick": 100,
                "name": "enemy",
                "is_alive": True,
                "X": 30.0,
                "Y": 40.0,
                "team_num": 3,
                PLAYER_CONTROLLER_TEAM_PROP: 3,
            },
        ]
    )

    cache, alive = parse_spatial_snapshots(parser, [100])

    assert cache[100]["unresolved-mate"]["_pawn_state_known"] is False
    assert _alive_mates_and_enemies(
        cache[100], "hero", alive_by_team=alive[100],
    ) is None
    assert _alive_mates_and_enemies(
        cache[100], "unresolved-mate", alive_by_team=alive[100],
    ) is None


def test_missing_spatial_data_does_not_become_backstab():
    tick = 100
    cache = {
        tick: {
            "hero": {"X": 10.0, "Y": 10.0, "yaw": 0.0},
            "unresolved": {
                "X": float("nan"),
                "Y": float("nan"),
                "yaw": float("nan"),
            },
        },
    }
    kills = {
        1: [{
            "tick": tick,
            "victim": "unresolved",
            "weapon": "ak47",
            "tags": [],
        }],
    }

    assert _victim_facing_attacker(cache[tick], "hero", "unresolved") is None
    enrich_kill_action_tags_spatial(kills, cache, "hero")
    assert "🔙 偷背身" not in kills[1][0]["tags"]

    missing_victim_kills = {
        1: [{
            "tick": tick,
            "victim": "not-in-snapshot",
            "weapon": "ak47",
            "tags": [],
        }],
    }
    assert _victim_facing_attacker(cache[tick], "hero", "not-in-snapshot") is None
    assert _victim_facing_attacker(cache[tick], "not-in-snapshot", "hero") is None
    enrich_kill_action_tags_spatial(missing_victim_kills, cache, "hero")
    assert "🔙 偷背身" not in missing_victim_kills[1][0]["tags"]
