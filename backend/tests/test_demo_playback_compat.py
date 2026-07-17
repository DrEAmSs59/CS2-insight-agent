from __future__ import annotations

from pathlib import Path

import pytest

from app import demo_playback_compat as compat


def _append_bits(bits: list[int], value: int, count: int) -> None:
    bits.extend((value >> index) & 1 for index in range(count))


def _append_ubitvar(bits: list[int], value: int) -> None:
    if value < 16:
        _append_bits(bits, value, 6)
    elif value < 256:
        _append_bits(bits, (value & 0x0F) | 0x10, 6)
        _append_bits(bits, value >> 4, 4)
    elif value < 4096:
        _append_bits(bits, (value & 0x0F) | 0x20, 6)
        _append_bits(bits, value >> 4, 8)
    else:
        _append_bits(bits, (value & 0x0F) | 0x30, 6)
        _append_bits(bits, value >> 4, 28)


def _bits_to_bytes(bits: list[int], *, residual: list[int] | None = None) -> bytes:
    all_bits = [*bits, *(residual or [])]
    out = bytearray((len(all_bits) + 7) // 8)
    for index, bit in enumerate(all_bits):
        if bit:
            out[index >> 3] |= 1 << (index & 7)
    return bytes(out)


def _packet_data(messages: list[tuple[int, bytes]], *, residual=None) -> bytes:
    bits: list[int] = []
    for message_type, payload in messages:
        _append_ubitvar(bits, message_type)
        for byte in compat._encode_varint(len(payload)):
            _append_bits(bits, byte, 8)
        for byte in payload:
            _append_bits(bits, byte, 8)
    return _bits_to_bytes(bits, residual=residual)


def _remove_decals_payload(target_entity: int) -> bytes:
    nested = b"\x08" + compat._encode_varint(target_entity)
    return b"\x08\x01\x12" + compat._encode_varint(len(nested)) + nested


def _packet_proto(packet_data: bytes) -> bytes:
    # Unknown fields around field 3 must remain byte-identical.
    return (
        b"\x08\x07"
        + b"\x1a"
        + compat._encode_varint(len(packet_data))
        + packet_data
        + b"\x2d\x11\x22\x33\x44"
    )


def _full_packet_proto(packet_proto: bytes) -> bytes:
    string_table = b"opaque-string-table"
    return (
        b"\x0a"
        + compat._encode_varint(len(string_table))
        + string_table
        + b"\x12"
        + compat._encode_varint(len(packet_proto))
        + packet_proto
        + b"\x18\x01"
    )


def _frame(command: int, tick: int, payload: bytes, *, compressed=False) -> bytes:
    raw_command = command | (64 if compressed else 0)
    stored = compat._snappy_compress(payload) if compressed else payload
    return (
        compat._encode_varint(raw_command)
        + compat._encode_varint(tick)
        + compat._encode_varint(len(stored))
        + stored
    )


def _demo(
    packet_payload: bytes,
    *,
    command: int = 7,
    compressed: bool = False,
    zero_offsets: bool = False,
) -> bytes:
    frames = [
        _frame(command, 42, packet_payload, compressed=compressed),
        _frame(0, 43, b"stop"),
        _frame(2, 44, b"file-info"),
        _frame(15, 45, b"spawn-groups"),
    ]
    positions: list[int] = []
    pos = 16
    for frame in frames:
        positions.append(pos)
        pos += len(frame)
    offset_a = 0 if zero_offsets else positions[2]
    offset_b = 0 if zero_offsets else positions[3]
    return (
        b"PBDEMS2\x00"
        + offset_a.to_bytes(4, "little")
        + offset_b.to_bytes(4, "little")
        + b"".join(frames)
    )


def _write(path: Path, data: bytes) -> Path:
    path.write_bytes(data)
    return path


def _read_varint_at(data: bytes, pos: int) -> tuple[int, int]:
    value, end, _raw = compat._read_varint_bytes(
        data, pos, max_bits=32, context="test"
    )
    return value, end


def _command_at(data: bytes, offset: int) -> int:
    value, _end = _read_varint_at(data, offset)
    return value & ~64


def _first_packet_proto(data: bytes) -> bytes:
    pos = 16
    raw_command, pos = _read_varint_at(data, pos)
    _tick, pos = _read_varint_at(data, pos)
    size, pos = _read_varint_at(data, pos)
    payload = data[pos : pos + size]
    return compat._snappy_decompress(payload) if raw_command & 64 else payload


@pytest.mark.parametrize("compressed", [False, True])
def test_repairs_unaligned_207_138_76_and_remaps_header(tmp_path: Path, compressed: bool):
    old = _packet_data(
        [
            (207, b"first-message"),
            (138, _remove_decals_payload(20_000_000)),  # 9-byte payload
            (76, b"real-next-message"),
        ],
        # Preserve a non-zero residual bit while keeping the parser's documented
        # total residual (explicit bit plus byte padding) at <= 8 bits.
        residual=[1],
    )
    source = _write(tmp_path / "source.dem", _demo(_packet_proto(old), compressed=compressed))
    destination = tmp_path / "playback.dem"
    original = source.read_bytes()

    report = compat.prepare_cs2_playback_demo(source, destination)

    assert report.outcome == "repaired"
    assert report.removed_messages == 1
    assert report.changed_frames == 1
    assert report.first_tick == report.last_tick == 42
    assert report.remaining_selected_messages == 0
    assert compat.scan_demo_legacy_type138(destination).selected_messages == 0

    repaired = destination.read_bytes()
    old_file_info = int.from_bytes(original[8:12], "little")
    old_spawn_groups = int.from_bytes(original[12:16], "little")
    new_file_info = int.from_bytes(repaired[8:12], "little")
    new_spawn_groups = int.from_bytes(repaired[12:16], "little")
    assert _command_at(original, old_file_info) == 2
    assert _command_at(original, old_spawn_groups) == 15
    assert _command_at(repaired, new_file_info) == 2
    assert _command_at(repaired, new_spawn_groups) == 15
    assert (new_file_info, new_spawn_groups) != (old_file_info, old_spawn_groups)

    # The packet wrapper's unknown prefix/suffix survive surgical field replacement.
    packet_proto = _first_packet_proto(repaired)
    assert packet_proto.startswith(b"\x08\x07\x1a")
    assert packet_proto.endswith(b"\x2d\x11\x22\x33\x44")


def test_removes_multiple_8_and_9_byte_payloads_from_one_packet(tmp_path: Path):
    payload8 = _remove_decals_payload(300_000)
    payload9 = _remove_decals_payload(20_000_000)
    assert len(payload8) == 8
    assert len(payload9) == 9
    packet_data = _packet_data(
        [(138, payload8), (207, b"keep"), (138, payload9), (76, b"also-keep")]
    )
    source = _write(tmp_path / "source.dem", _demo(_packet_proto(packet_data), compressed=True))

    report = compat.prepare_cs2_playback_demo(source, tmp_path / "playback.dem")

    assert report.removed_messages == 2
    assert report.changed_frames == 1
    assert report.max_per_frame == 2


def test_accepts_strict_schema_with_non_sample_payload_length(tmp_path: Path):
    payload = _remove_decals_payload(7)
    assert len(payload) == 6
    packet_data = _packet_data([(138, payload), (76, b"kept")])
    source = _write(tmp_path / "source.dem", _demo(_packet_proto(packet_data)))

    report = compat.prepare_cs2_playback_demo(source, tmp_path / "playback.dem")

    assert report.outcome == "repaired"
    assert report.removed_messages == 1


@pytest.mark.parametrize("command", [8, 13])
def test_repairs_signon_and_full_packet(tmp_path: Path, command: int):
    packet_data = _packet_data([(207, b"a"), (138, _remove_decals_payload(300_000))])
    packet = _packet_proto(packet_data)
    outer = _full_packet_proto(packet) if command == 13 else packet
    source = _write(tmp_path / "source.dem", _demo(outer, command=command, compressed=True))

    report = compat.prepare_cs2_playback_demo(source, tmp_path / "playback.dem")

    assert report.removed_messages == 1
    assert compat.scan_demo_legacy_type138(tmp_path / "playback.dem").selected_messages == 0


def test_clean_demo_is_byte_identical_and_second_pass_is_noop(tmp_path: Path):
    packet_data = _packet_data([(207, b"no legacy message"), (76, b"next")])
    source_bytes = _demo(_packet_proto(packet_data), compressed=True)
    source = _write(tmp_path / "source.dem", source_bytes)
    first = tmp_path / "first.dem"
    second = tmp_path / "second.dem"

    first_report = compat.prepare_cs2_playback_demo(source, first)
    second_report = compat.prepare_cs2_playback_demo(first, second)

    assert first_report.outcome == "clean"
    assert second_report.outcome == "clean"
    assert first.read_bytes() == source_bytes
    assert second.read_bytes() == source_bytes


def test_repaired_demo_second_pass_is_clean_and_byte_identical(tmp_path: Path):
    packet_data = _packet_data([(138, _remove_decals_payload(300_000)), (76, b"next")])
    source = _write(tmp_path / "source.dem", _demo(_packet_proto(packet_data), compressed=True))
    repaired = tmp_path / "repaired.dem"
    second = tmp_path / "second.dem"

    assert compat.prepare_cs2_playback_demo(source, repaired).outcome == "repaired"
    assert compat.prepare_cs2_playback_demo(repaired, second).outcome == "clean"
    assert second.read_bytes() == repaired.read_bytes()


def test_zero_header_offsets_are_preserved(tmp_path: Path):
    packet_data = _packet_data([(138, _remove_decals_payload(300_000)), (76, b"next")])
    source = _write(
        tmp_path / "source.dem",
        _demo(_packet_proto(packet_data), compressed=True, zero_offsets=True),
    )
    destination = tmp_path / "playback.dem"

    compat.prepare_cs2_playback_demo(source, destination)

    assert destination.read_bytes()[8:16] == b"\x00" * 8


@pytest.mark.parametrize(
    "bad_payload",
    [
        b"\x08\x00\x12\x02\x08\x01",  # remove_decals is false
        b"\x08\x01\x12\x02\x08\x01\x18\x01",  # trailing unknown field
        b"\x12\x02\x08\x01\x08\x01",  # reordered fields
    ],
)
def test_unexpected_type138_payload_fails_closed_and_leaves_no_output(
    tmp_path: Path, bad_payload: bytes
):
    packet_data = _packet_data([(138, bad_payload), (76, b"next")])
    source = _write(tmp_path / "source.dem", _demo(_packet_proto(packet_data)))
    destination = tmp_path / "playback.dem"

    with pytest.raises(compat.DemoPlaybackCompatibilityError):
        compat.prepare_cs2_playback_demo(source, destination)

    assert not destination.exists()
    assert not list(tmp_path.glob(".playback.dem.*.tmp"))


def test_duplicate_packet_data_field_fails_closed(tmp_path: Path):
    packet_data = _packet_data([(76, b"clean")])
    field = b"\x1a" + compat._encode_varint(len(packet_data)) + packet_data
    source = _write(tmp_path / "source.dem", _demo(field + field))

    with pytest.raises(compat.DemoPlaybackCompatibilityError, match="repeated"):
        compat.prepare_cs2_playback_demo(source, tmp_path / "playback.dem")


def test_truncated_outer_frame_fails_closed(tmp_path: Path):
    source = _write(
        tmp_path / "source.dem",
        b"PBDEMS2\x00" + b"\x00" * 8 + compat._encode_varint(7) + b"\x01\x10abc",
    )
    destination = tmp_path / "playback.dem"

    with pytest.raises(compat.DemoPlaybackCompatibilityError, match="truncated"):
        compat.prepare_cs2_playback_demo(source, destination)
    assert not destination.exists()


def test_snappy_declared_size_limit_is_checked_before_decompression(tmp_path: Path):
    bomb = compat._encode_varint(compat._MAX_SNAPPY_DECOMPRESSED_SIZE + 1)
    frame = (
        compat._encode_varint(7 | 64)
        + compat._encode_varint(1)
        + compat._encode_varint(len(bomb))
        + bomb
    )
    source = _write(tmp_path / "source.dem", b"PBDEMS2\x00" + b"\x00" * 8 + frame)

    with pytest.raises(compat.DemoPlaybackCompatibilityError, match="size limit"):
        compat.prepare_cs2_playback_demo(source, tmp_path / "playback.dem")


def test_existing_destination_is_never_overwritten(tmp_path: Path):
    packet_data = _packet_data([(76, b"clean")])
    source = _write(tmp_path / "source.dem", _demo(_packet_proto(packet_data)))
    destination = _write(tmp_path / "playback.dem", b"keep-me")

    with pytest.raises(compat.DemoPlaybackCompatibilityError, match="already exists"):
        compat.prepare_cs2_playback_demo(source, destination)

    assert destination.read_bytes() == b"keep-me"


def test_header_offset_must_point_to_expected_command(tmp_path: Path):
    packet_data = _packet_data([(76, b"clean")])
    data = bytearray(_demo(_packet_proto(packet_data)))
    data[8:12] = (16).to_bytes(4, "little")  # command 7, not FileInfo command 2
    source = _write(tmp_path / "source.dem", bytes(data))

    with pytest.raises(compat.DemoPlaybackCompatibilityError, match="expected 2"):
        compat.prepare_cs2_playback_demo(source, tmp_path / "playback.dem")


def test_in_place_repair_atomically_replaces_affected_source(tmp_path: Path):
    packet_data = _packet_data(
        [(207, b"before"), (138, _remove_decals_payload(300_000)), (76, b"after")]
    )
    source = _write(
        tmp_path / "source.dem",
        _demo(_packet_proto(packet_data), compressed=True),
    )
    original = source.read_bytes()
    original_mtime_ns = source.stat().st_mtime_ns

    report = compat.repair_demo_in_place(source)

    assert report.outcome == "repaired"
    assert report.removed_messages == 1
    assert source.read_bytes() != original
    assert source.stat().st_mtime_ns >= original_mtime_ns + 1_000_000_000
    assert compat.scan_demo_legacy_type138(source).selected_messages == 0
    assert not list(tmp_path.glob(".source.dem.compat-*.tmp"))


def test_in_place_clean_demo_is_not_replaced(tmp_path: Path, monkeypatch):
    packet_data = _packet_data([(207, b"already-clean"), (76, b"next")])
    source = _write(
        tmp_path / "source.dem",
        _demo(_packet_proto(packet_data), compressed=True),
    )
    original = source.read_bytes()
    original_stat = compat._stat_fingerprint(source.stat())

    def unexpected_rewrite(*_args, **_kwargs):
        raise AssertionError("clean demo should not create a rewritten candidate")

    monkeypatch.setattr(compat, "_rewrite_stream", unexpected_rewrite)

    report = compat.repair_demo_in_place(source)

    assert report.outcome == "clean"
    assert source.read_bytes() == original
    assert compat._stat_fingerprint(source.stat()) == original_stat
    assert not list(tmp_path.glob(".source.dem.compat-*.tmp"))


def test_in_place_invalid_payload_keeps_original_and_removes_candidate(tmp_path: Path):
    packet_data = _packet_data([(138, b"\x08\x00\x12\x02\x08\x01")])
    source = _write(tmp_path / "source.dem", _demo(_packet_proto(packet_data)))
    original = source.read_bytes()

    with pytest.raises(compat.DemoPlaybackCompatibilityError):
        compat.repair_demo_in_place(source)

    assert source.read_bytes() == original
    assert not list(tmp_path.glob(".source.dem.compat-*.tmp"))


def test_in_place_replace_failure_keeps_original_and_removes_candidate(
    tmp_path: Path, monkeypatch
):
    packet_data = _packet_data([(138, _remove_decals_payload(300_000)), (76, b"next")])
    source = _write(
        tmp_path / "source.dem",
        _demo(_packet_proto(packet_data), compressed=True),
    )
    original = source.read_bytes()

    def fail_replace(_source, _destination):
        raise PermissionError("locked")

    monkeypatch.setattr(compat.os, "replace", fail_replace)
    with pytest.raises(compat.DemoPlaybackCompatibilityError, match="atomically replace"):
        compat.repair_demo_in_place(source)

    assert source.read_bytes() == original
    assert not list(tmp_path.glob(".source.dem.compat-*.tmp"))
