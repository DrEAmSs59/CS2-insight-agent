import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import demo_playback_compat as compat
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


def _append_bits(bits: list[int], value: int, count: int) -> None:
    bits.extend((value >> index) & 1 for index in range(count))


def _append_ubitvar(bits: list[int], value: int) -> None:
    if value < 16:
        _append_bits(bits, value, 6)
    elif value < 256:
        _append_bits(bits, (value & 0x0F) | 0x10, 6)
        _append_bits(bits, value >> 4, 4)
    else:
        raise AssertionError(f"unsupported ubitvar in test fixture: {value}")


def _bits_to_bytes(bits: list[int]) -> bytes:
    out = bytearray((len(bits) + 7) // 8)
    for index, bit in enumerate(bits):
        if bit:
            out[index >> 3] |= 1 << (index & 7)
    return bytes(out)


def _packet_data(messages: list[tuple[int, bytes]]) -> bytes:
    bits: list[int] = []
    for message_type, payload in messages:
        _append_ubitvar(bits, message_type)
        for byte in compat._encode_varint(len(payload)):
            _append_bits(bits, byte, 8)
        for byte in payload:
            _append_bits(bits, byte, 8)
    return _bits_to_bytes(bits)


def _packet_proto(packet_data: bytes) -> bytes:
    return b"\x1a" + compat._encode_varint(len(packet_data)) + packet_data


def _full_packet_proto(packet_proto: bytes) -> bytes:
    string_table = b"opaque-string-table"
    return (
        b"\x0a"
        + compat._encode_varint(len(string_table))
        + string_table
        + b"\x12"
        + compat._encode_varint(len(packet_proto))
        + packet_proto
    )


def _frame(command: int, tick: int, payload: bytes, *, compressed: bool = False) -> bytes:
    raw_command = command | (64 if compressed else 0)
    stored = compat._snappy_compress(payload) if compressed else payload
    return (
        compat._encode_varint(raw_command)
        + compat._encode_varint(tick)
        + compat._encode_varint(len(stored))
        + stored
    )


def _write_demo(tmp_path: Path, frames: list[bytes], name: str = "match.dem") -> Path:
    path = tmp_path / name
    path.write_bytes(b"PBDEMS2\x00" + (0).to_bytes(8, "little") + b"".join(frames))
    return path


def test_detect_player_keyboard_input_finds_svc_usercmds_in_packet(tmp_path, monkeypatch):
    def boom(_path):
        raise AssertionError("must not extract the full UserCmd report")

    monkeypatch.setattr(input_track, "load_input_report", boom)
    demo = _write_demo(
        tmp_path,
        [_frame(7, 42, _packet_proto(_packet_data([(76, b"cmd")])))],
    )
    assert input_track.detect_player_keyboard_input(demo_path=demo) is True


def test_detect_player_keyboard_input_finds_outer_dem_usercmd(tmp_path, monkeypatch):
    monkeypatch.setattr(
        input_track,
        "load_input_report",
        lambda _path: (_ for _ in ()).throw(AssertionError("must not extract")),
    )
    demo = _write_demo(tmp_path, [_frame(12, 8, b"usercmd-bytes")])
    assert input_track.detect_player_keyboard_input(demo_path=demo) is True


def test_detect_player_keyboard_input_finds_compressed_and_full_packet_carriers(tmp_path):
    compressed = _write_demo(
        tmp_path,
        [_frame(8, 1, _packet_proto(_packet_data([(76, b"cmd")])), compressed=True)],
        name="compressed.dem",
    )
    full_packet = _write_demo(
        tmp_path,
        [_frame(13, 2, _full_packet_proto(_packet_proto(_packet_data([(76, b"cmd")]))))],
        name="full.dem",
    )
    assert input_track.detect_player_keyboard_input(demo_path=compressed) is True
    assert input_track.detect_player_keyboard_input(demo_path=full_packet) is True


def test_detect_player_keyboard_input_is_false_without_input_carriers(tmp_path, monkeypatch):
    monkeypatch.setattr(
        input_track,
        "load_input_report",
        lambda _path: (_ for _ in ()).throw(AssertionError("must not extract")),
    )
    demo = _write_demo(
        tmp_path,
        [
            _frame(7, 1, _packet_proto(_packet_data([(8, b"tick")]))),
            _frame(0, 2, b"stop"),
        ],
    )
    assert input_track.detect_player_keyboard_input(demo_path=demo) is False


def test_detect_player_keyboard_input_returns_unknown_for_unreadable_demos(tmp_path):
    missing = tmp_path / "missing.dem"
    invalid = tmp_path / "invalid.dem"
    invalid.write_bytes(b"not-a-demo")
    assert input_track.detect_player_keyboard_input(demo_path=missing) is None
    assert input_track.detect_player_keyboard_input(demo_path=invalid) is None


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
