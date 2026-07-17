import pandas as pd

from app.parser import kill_track


def _event_tables() -> dict[str, pd.DataFrame]:
    deaths = pd.DataFrame(
        [
            {
                "tick": 90,
                "total_rounds_played": 0,
                "attacker_steamid": "9",
                "attacker_name": "Rival",
                "user_steamid": "1",
                "user_name": "Hero",
                "attackerteam": 3,
                "userteam": 2,
                "weapon": "ak47",
            },
            {
                "tick": 200,
                "total_rounds_played": 1,
                "attacker_steamid": "1",
                "attacker_name": "Hero",
                "user_steamid": "9",
                "user_name": "Rival",
                "attackerteam": 2,
                "userteam": 3,
                "weapon": "ak47",
                "headshot": True,
                "penetrated": 1,
            },
            {
                "tick": 250,
                "total_rounds_played": 1,
                "attacker_steamid": "1",
                "attacker_name": "Hero",
                "user_steamid": "10",
                "user_name": "Second",
                "attackerteam": 2,
                "userteam": 3,
                "weapon": "awp",
                "noscope": True,
                "attackerinair": True,
            },
        ]
    )
    hurts = pd.DataFrame(
        [{"tick": 200, "attacker_name": "Hero", "user_name": "Rival"}]
    )
    return {"deaths": deaths, "hurts": hurts}


def test_extract_kill_track_maps_tags_and_multikill_banner(monkeypatch):
    monkeypatch.setattr(kill_track, "_load_demo_tables", lambda _path: _event_tables())

    events = kill_track.extract_kill_track(
        "unused.dem",
        steamid="1",
        player_name="Hero",
        start_tick=180,
        end_tick=260,
    )

    assert [event["tick"] for event in events] == [200, 250]
    assert events[0]["icons"] == ["one_tap", "revenge", "first_blood", "wallbang"]
    assert events[0]["banner"] is None
    assert events[1]["icons"] == ["air_noscope"]
    assert events[1]["banner"] == "double"


def test_extract_kill_track_plays_1v2_to_1v1_before_the_final_kill(monkeypatch):
    monkeypatch.setattr(kill_track, "_load_demo_tables", lambda _path: _event_tables())

    events = kill_track.extract_kill_track(
        "unused.dem",
        player_name="Hero",
        start_tick=180,
        end_tick=260,
        context_tags=["🔥 1v2 史诗残局"],
        round_number=2,
    )

    assert [event["banner"] for event in events] == ["clutch_1v2_to_1v1", "double"]


def test_extract_kill_track_builds_full_1v5_countdown(monkeypatch):
    deaths = pd.DataFrame(
        [
            {
                "tick": 200 + idx * 50,
                "total_rounds_played": 1,
                "attacker_steamid": "1",
                "attacker_name": "Hero",
                "user_steamid": str(10 + idx),
                "user_name": f"Enemy{idx + 1}",
                "attackerteam": 2,
                "userteam": 3,
                "weapon": "ak47",
            }
            for idx in range(5)
        ]
    )
    monkeypatch.setattr(
        kill_track,
        "_load_demo_tables",
        lambda _path: {"deaths": deaths, "hurts": pd.DataFrame()},
    )

    events = kill_track.extract_kill_track(
        "unused.dem",
        player_name="Hero",
        start_tick=180,
        end_tick=420,
        context_tags=["🔥 1v5 史诗残局"],
        round_number=2,
    )

    assert [event["banner"] for event in events] == [
        "clutch_1v5_to_1v4",
        "clutch_1v4_to_1v3",
        "clutch_1v3_to_1v2",
        "clutch_1v2_to_1v1",
        "ace",
    ]
