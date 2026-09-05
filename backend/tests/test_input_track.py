import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import input_command
from app.features.demo_analysis import input_track


def _b36(value: int) -> str:
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    if value == 0:
        return "0"
    out = ""
    while value:
        value, digit = divmod(value, 36)
        out = alphabet[digit] + out
    return out


def _encoded(*changes: tuple[int, int]) -> str:
    previous = 0
    tokens = []
    for tick, mask in changes:
        tokens.append(f"{_b36(tick - previous)}.{_b36(mask)}")
        previous = tick
    return ",".join(tokens)


def _report() -> dict:
    return {
        "format_version": 3,
        "button_updates": 10,
        "player_identity_updates": [
            {
                "demo_tick": 0xFFFFFFFF,
                "player_slot": 12,
                "xuid": 76561198386265483,
                "steamid": 76561198386265483,
                "name": "donk",
            }
        ],
        "tracks": [
            {
                "slot": 12,
                "changes": 5,
                # compact bit 4 = jump; compact bit 0 = W
                "encoded": _encoded((100, 0), (101, 1 << 4), (102, 0), (103, 1), (105, 0)),
            }
        ],
    }


def test_exact_track_binds_userinfo_slot_by_steamid():
    track = input_command.extract_player_input_track(
        _report(),
        steamid="76561198386265483",
        player_name="wrong-name",
        start_tick=100,
        end_tick=105,
    )
    assert [row["tick"] for row in track] == list(range(100, 106))
    assert [row["jump"] for row in track] == [False, True, False, False, False, False]
    assert [row["W"] for row in track] == [False, False, False, True, True, False]


def test_exact_track_can_bind_userinfo_slot_by_name():
    track = input_command.extract_player_input_track(
        _report(),
        steamid=None,
        player_name="DONK",
        start_tick=101,
        end_tick=103,
    )
    assert track[0]["jump"] is True
    assert track[-1]["W"] is True


def test_exact_track_exposes_in_use_without_changing_obs_key_set():
    report = _report()
    report["tracks"] = [
        {
            "slot": 12,
            "changes": 2,
            "encoded": _encoded((100, 1 << 10), (101, 0)),
        }
    ]
    track = input_command.extract_player_input_track(
        report,
        steamid=76561198386265483,
        player_name=None,
        start_tick=100,
        end_tick=101,
    )

    assert track[0]["use"] is True
    assert track[1]["use"] is False
    assert "use" not in input_track.KEYS


def test_exact_track_exposes_inspect_without_changing_obs_key_set():
    report = _report()
    report["format_version"] = 6
    report["tracks"] = [
        {
            "slot": 12,
            "changes": 2,
            "encoded": _encoded((100, 1 << 11), (101, 0)),
        }
    ]
    track = input_command.extract_player_input_track(
        report,
        steamid=76561198386265483,
        player_name=None,
        start_tick=100,
        end_tick=101,
    )

    assert track[0]["inspect"] is True
    assert track[1]["inspect"] is False
    assert "inspect" not in input_track.KEYS


def test_exact_track_exposes_scoreboard_without_changing_obs_key_set():
    report = _report()
    report["format_version"] = 7
    report["tracks"] = [
        {
            "slot": 12,
            "changes": 2,
            "encoded": _encoded((100, 1 << 12), (101, 0)),
        }
    ]
    track = input_command.extract_player_input_track(
        report,
        steamid=76561198386265483,
        player_name=None,
        start_tick=100,
        end_tick=101,
    )

    assert track[0]["scoreboard"] is True
    assert track[1]["scoreboard"] is False
    assert "scoreboard" not in input_track.KEYS


def test_downsampling_ors_short_press_into_output_bucket():
    track = input_command.extract_player_input_track(
        _report(),
        steamid=76561198386265483,
        player_name=None,
        start_tick=100,
        end_tick=110,
        max_frames=2,
    )
    assert [row["tick"] for row in track] == [100, 106]
    assert track[0]["jump"] is True
    assert track[0]["W"] is True
    assert not any(track[1][key] for key in input_track.KEYS)


def test_identity_timeline_clips_track_to_matching_player_interval():
    report = _report()
    report["player_identity_updates"].append(
        {
            "demo_tick": 104,
            "player_slot": 12,
            "xuid": 999,
            "steamid": 999,
            "name": "replacement",
        }
    )
    track = input_command.extract_player_input_track(
        report,
        steamid=76561198386265483,
        player_name=None,
        start_tick=100,
        end_tick=105,
    )
    assert track[3]["W"] is True
    assert track[4]["W"] is False


def test_missing_userinfo_identity_is_an_error():
    with pytest.raises(input_command.InputCommandError, match="no userinfo slot"):
        input_command.extract_player_input_track(
            _report(),
            steamid=42,
            player_name=None,
            start_tick=100,
            end_tick=105,
        )


def test_matched_identity_without_button_track_is_an_error():
    report = _report()
    report["tracks"] = []
    with pytest.raises(input_command.InputCommandError, match="no button track"):
        input_command.extract_player_input_track(
            report,
            steamid=76561198386265483,
            player_name=None,
            start_tick=100,
            end_tick=105,
        )


def test_detect_player_keyboard_input_uses_native_report_when_path_is_available(monkeypatch):
    monkeypatch.setattr(input_track, "load_input_report", lambda _path: _report())
    assert input_track.detect_player_keyboard_input(
        demo_path="match.dem",
    ) is True


def test_detect_player_keyboard_input_returns_unknown_without_native_report(monkeypatch):
    def fail_native_report(_path):
        raise input_track.InputCommandError("native decoder unavailable")

    monkeypatch.setattr(input_track, "load_input_report", fail_native_report)

    assert input_track.detect_player_keyboard_input(demo_path="match.dem") is None


def test_prepared_batch_loads_native_report_once(monkeypatch):
    demo = "shared.dem"
    calls = 0

    def load(_path):
        nonlocal calls
        calls += 1
        return _report()

    monkeypatch.setattr(input_track, "load_input_report", load)
    prepared = input_track.prepare_input_track_batch(demo, [(100, 102), (103, 105)])
    first = input_track.extract_input_track(
        demo,
        steamid=76561198386265483,
        start_tick=100,
        end_tick=102,
        prepared=prepared,
    )
    second = input_track.extract_input_track(
        demo,
        steamid=76561198386265483,
        start_tick=103,
        end_tick=105,
        prepared=prepared,
    )
    assert calls == 1
    assert first[1]["jump"] is True
    assert second[0]["W"] is True


def test_invalid_prepared_window_is_rejected(monkeypatch):
    monkeypatch.setattr(input_track, "load_input_report", lambda _path: _report())
    with pytest.raises(ValueError, match="Invalid input-track tick window"):
        input_track.prepare_input_track_batch("missing.dem", [(20, 10)])
