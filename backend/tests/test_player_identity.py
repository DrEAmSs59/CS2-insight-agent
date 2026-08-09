from __future__ import annotations

from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import native_table as pd
from app.features.demo_analysis.player_identity import PlayerIdentityRegistry
from app.features.demo_analysis.player_roster import get_player_list


SID_A = "76561198000000001"
SID_B = "76561198000000002"


def _same_name_player_info() -> pd.DataFrame:
    return pd.DataFrame([
        {"name": "same", "steamid": SID_A, "team_number": 2},
        {"name": "same", "steamid": SID_B, "team_number": 3},
    ])


def _same_name_deaths() -> pd.DataFrame:
    return pd.DataFrame([
        {
            "tick": 100,
            "total_rounds_played": 0,
            "attacker_name": "same",
            "attacker_steamid": SID_A,
            "attacker_user_id": 10,
            "attackerteam": 2,
            "user_name": "same",
            "user_steamid": SID_B,
            "user_user_id": 20,
            "userteam": 3,
        },
        {
            "tick": 200,
            "total_rounds_played": 0,
            "attacker_name": "same",
            "attacker_steamid": SID_B,
            "attacker_user_id": 20,
            "attackerteam": 3,
            "user_name": "same",
            "user_steamid": SID_A,
            "user_user_id": 10,
            "userteam": 2,
        },
    ])


def test_registry_qualifies_same_name_roles_by_xuid():
    events = _same_name_deaths()
    registry = PlayerIdentityRegistry.from_frames(
        player_info=_same_name_player_info(),
        death_events=events,
    )

    assert registry.has_name_collisions is True
    registry.canonicalize_frame(events)
    assert events["attacker_name"].tolist()[0] != events["user_name"].tolist()[0]
    assert events["attacker_name"].tolist()[0].endswith(SID_A[-8:])
    assert events["user_name"].tolist()[0].endswith(SID_B[-8:])

    resolved = registry.resolve_targets(["same"])
    assert [target.result_key for target in resolved] == [
        f"steamid:{SID_A}",
        f"steamid:{SID_B}",
    ]


class _RosterParser:
    def parse_ticks(self, _fields, *, ticks):
        tick = ticks[0]
        return pd.DataFrame([
            {
                "tick": tick,
                "name": "same",
                "steamid": SID_A,
                "user_id": 10,
                "team_num": 2,
                "player_color": "blue",
            },
            {
                "tick": tick,
                "name": "same",
                "steamid": SID_B,
                "user_id": 20,
                "team_num": 3,
                "player_color": "orange",
            },
        ])

    def parse_player_info(self):
        return _same_name_player_info()


def test_roster_stats_do_not_merge_same_nickname_players():
    rows = get_player_list(
        "same-name.dem",
        parser=_RosterParser(),
        match_start_tick=1,
        death_events=_same_name_deaths(),
        player_info_df=_same_name_player_info(),
    )

    assert len(rows) == 2
    by_key = {row["player_key"]: row for row in rows}
    assert set(by_key) == {f"steamid:{SID_A}", f"steamid:{SID_B}"}
    assert by_key[f"steamid:{SID_A}"]["name"] == "same"
    assert by_key[f"steamid:{SID_B}"]["name"] == "same"
    assert (by_key[f"steamid:{SID_A}"]["kills"], by_key[f"steamid:{SID_A}"]["deaths"]) == (1, 1)
    assert (by_key[f"steamid:{SID_B}"]["kills"], by_key[f"steamid:{SID_B}"]["deaths"]) == (1, 1)
    assert by_key[f"steamid:{SID_A}"]["team"] == 2
    assert by_key[f"steamid:{SID_B}"]["team"] == 3


def test_roster_drops_fake_steamid_placeholder_from_player_info():
    """Disconnect/GOTV slots often appear in parse_player_info with tiny fake ids."""
    player_info = pd.DataFrame([
        {"name": "real", "steamid": SID_A, "team_number": 2},
        {"name": "Crasswater", "steamid": "11", "team_number": 2},
    ])
    deaths = pd.DataFrame([
        {
            "tick": 100,
            "attacker_name": "real",
            "attacker_steamid": SID_A,
            "attacker_user_id": 10,
            "attackerteam": 2,
            "user_name": "enemy",
            "user_steamid": SID_B,
            "user_user_id": 20,
            "userteam": 3,
        },
    ])

    class Parser:
        def parse_ticks(self, _fields, *, ticks):
            tick = ticks[0]
            return pd.DataFrame([
                {
                    "tick": tick,
                    "name": "real",
                    "steamid": SID_A,
                    "user_id": 10,
                    "team_num": 2,
                    "player_color": "blue",
                },
            ])

        def parse_player_info(self):
            return player_info

    rows = get_player_list(
        "disconnect.dem",
        parser=Parser(),
        match_start_tick=1,
        death_events=deaths,
        player_info_df=player_info,
    )
    assert all(row["name"] != "Crasswater" for row in rows)
    assert all(
        not str(row.get("steam_id") or "").isdigit()
        or len(str(row.get("steam_id"))) >= 16
        for row in rows
    )
    assert any(row["player_key"] == f"steamid:{SID_A}" for row in rows)
