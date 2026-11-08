import pytest

from app import demo_baseline_compat as baseline
from app import demo_playback_compat as wire
from test_demo_playback_compat import (
    _append_bits, _append_ubitvar, _bits_to_bytes, _frame, _packet_data,
)


def field(key, value):
    if isinstance(value, bytes):
        return wire._encode_varint(key * 8 + 2) + wire._encode_varint(len(value)) + value
    return wire._encode_varint(key * 8) + wire._encode_varint(value)


def entry_bits(key, value, *, index=None, flags=1, var_sizes=True, compressed=False):
    bits = []
    _append_bits(bits, int(index is None), 1)
    if index is not None:
        for byte in wire._encode_varint(index - 1):
            _append_bits(bits, byte, 8)
    _append_bits(bits, 1, 1)  # key present
    _append_bits(bits, 0, 1)  # literal key
    for byte in key + b"\0":
        _append_bits(bits, byte, 8)
    _append_bits(bits, 1, 1)  # userdata present
    if flags & 1:
        _append_bits(bits, int(compressed), 1)
    stored = wire._snappy_compress(value) if compressed else value
    if var_sizes:
        _append_ubitvar(bits, len(stored))
    else:
        _append_bits(bits, len(stored), 17)
    for byte in stored:
        _append_bits(bits, byte, 8)
    return bits


def fixture(*, count=2, flags=1, var_sizes=True, compressed=True,
            class_name=b"CChicken", snapshot_value=None, update_index=None,
            include_full=True, entity_first=False, chicken_id=22):
    old = [(str(100 + i).encode(), bytes([i % 256]) * 25) for i in range(count)]
    key, value = str(chicken_id).encode(), b"existing-chicken-baseline" * 22
    bits = []
    for k, v in old:
        bits += entry_bits(k, v, flags=flags, var_sizes=var_sizes)
    stringdata = _bits_to_bytes(bits)
    create = (field(1, b"instancebaseline") + field(2, count) + field(3, 0)
              + field(6, flags) + field(7, wire._snappy_compress(stringdata) if compressed else stringdata)
              + field(8, len(stringdata)) + field(9, int(compressed)) + field(10, int(var_sizes)))
    def snapshot(items):
        table = field(1, b"instancebaseline") + b"".join(field(2, field(1, k) + field(2, v)) for k, v in items)
        return field(1, table + field(4, flags)) + field(1, field(1, b"other-table"))
    update = field(1, 1) + field(2, 1) + field(3, _bits_to_bytes(entry_bits(
        key, value, index=count if update_index is None else update_index,
        flags=flags, var_sizes=var_sizes, compressed=bool(flags & 1))))
    messages = [(45, update), (55, b"untouched entity data"), (207, field(2, 216) + field(4, 1))]
    if entity_first:
        messages = [messages[1], messages[0], messages[2]]
    frames = [
        _frame(8, wire._U32_MAX, field(3, _packet_data([
            (44, field(1, b"userinfo")), (44, create), (40, b"server info")]))),
        _frame(5, wire._U32_MAX, field(1, field(1, chicken_id) + field(2, class_name))),
        _frame(6, wire._U32_MAX, snapshot(old), compressed=compressed),
        _frame(7, 1, field(3, _packet_data(messages)), compressed=compressed),
    ]
    if include_full:
        frames.append(_frame(13, 1, field(1, snapshot(old + [(key, value if snapshot_value is None else snapshot_value)]))
                             + field(2, field(3, _packet_data([(55, b"full entities")]))), compressed=compressed))
    frames += [_frame(7, 2, field(3, _packet_data([(55, b"next entities")]))),
               _frame(0, 3, b""), _frame(15, 3, b"spawn groups"), _frame(2, 3, b"file info")]
    spawn = 16 + sum(map(len, frames[:-2]))
    info = spawn + len(frames[-2])
    return wire._MAGIC + info.to_bytes(4, "little") + spawn.to_bytes(4, "little") + b"".join(frames)


def frames(path):
    with path.open("rb") as reader:
        reader.seek(16)
        return list(baseline._frames(reader))


@pytest.mark.parametrize("count,flags,var_sizes,compressed,chicken_id", [
    (1, 0, False, False, 22), (38, 1, True, True, 22), (46, 1, False, True, 77),
])
def test_preloads_only_initial_tables_and_remaps_footer(tmp_path, count, flags, var_sizes, compressed, chicken_id):
    path = tmp_path / "copy.dem"
    original = fixture(count=count, flags=flags, var_sizes=var_sizes, compressed=compressed, chicken_id=chicken_id)
    path.write_bytes(original)
    before = frames(path)
    assert baseline.repair_recording_baseline(path)
    after = frames(path)
    changed = [i for i, (a, b) in enumerate(zip(before, after)) if a[-1] != b[-1]]
    assert changed == [0, 2]
    assert len(before) == len(after)
    assert [(f[1], f[2]) for f in before] == [(f[1], f[2]) for f in after]
    data = path.read_bytes()
    assert int.from_bytes(data[8:12], "little") == after[-1][0]
    assert int.from_bytes(data[12:16], "little") == after[-2][0]
    raw_snapshot = wire._snappy_decompress(after[2][3]) if compressed else after[2][3]
    raw_full = wire._snappy_decompress(after[4][3]) if compressed else after[4][3]
    assert baseline._snapshot(raw_snapshot)[-1] == baseline._snapshot(baseline._get(raw_full, 1))[-1]
    # Repeat preparation after reopening: no second rewrite or mtime change.
    stamp = path.stat().st_mtime_ns
    assert not baseline.repair_recording_baseline(path)
    assert path.read_bytes() == data and path.stat().st_mtime_ns == stamp
    assert sorted(p.name for p in tmp_path.iterdir()) == ["copy.dem"]


@pytest.mark.parametrize("options", [
    {"class_name": b"CWeaponAK47"}, {"include_full": False}, {"entity_first": True},
])
def test_unmatched_shapes_are_byte_identical_noops(tmp_path, options):
    path = tmp_path / "copy.dem"
    original = fixture(**options)
    path.write_bytes(original)
    stamp = path.stat().st_mtime_ns
    assert not baseline.repair_recording_baseline(path)
    assert path.read_bytes() == original and path.stat().st_mtime_ns == stamp


@pytest.mark.parametrize("options,message", [
    ({"snapshot_value": b"different"}, "disagrees"),
    ({"update_index": 4}, "inconsistent initial indices"),
])
def test_contradictory_candidate_fails_without_writing(tmp_path, options, message):
    path = tmp_path / "copy.dem"
    original = fixture(**options)
    path.write_bytes(original)
    with pytest.raises(wire.DemoPlaybackCompatibilityError, match=message):
        baseline.repair_recording_baseline(path)
    assert path.read_bytes() == original
    assert len(list(tmp_path.iterdir())) == 1


def test_failed_atomic_publish_keeps_input_and_cleans_temp(tmp_path, monkeypatch):
    path = tmp_path / "copy.dem"
    original = fixture()
    path.write_bytes(original)
    def fail(*args):
        raise PermissionError("locked")
    monkeypatch.setattr(baseline.os, "replace", fail)
    with pytest.raises(PermissionError, match="locked"):
        baseline.repair_recording_baseline(path)
    assert path.read_bytes() == original
    assert len(list(tmp_path.iterdir())) == 1


def test_existing_end_panel_repair_composes_with_baseline(tmp_path):
    path = tmp_path / "copy.dem"
    path.write_bytes(fixture())
    report = wire.repair_demo_in_place(path)
    assert report.removed_win_panel_events == 1
    assert baseline.repair_recording_baseline(path)
    before = path.read_bytes()
    report = wire.repair_demo_in_place(path)
    assert report.changed_frames == 0
    assert path.read_bytes() == before
