"""Preload a verified tick-1 CChicken baseline in disposable recording demos.

This avoids the observed CS2 late-baseline playback failure; it does not claim
that the original baseline bytes are corrupt. Entities and events are retained.
"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

from . import demo_playback_compat as wire

logger = logging.getLogger(__name__)


def _var(data: bytes, pos: int = 0) -> tuple[int, int]:
    value, end, _ = wire._read_varint_bytes(data, pos, max_bits=64, context="baseline")
    return value, end


def _fields(data: bytes):
    pos = 0
    while pos < len(data):
        start = pos
        tag, pos = _var(data, pos)
        number, kind = tag >> 3, tag & 7
        if not number:
            raise wire._fail("invalid baseline protobuf field")
        if kind == 0:
            value, pos = _var(data, pos)
        elif kind in (1, 2, 5):
            if kind == 2:
                size, pos = _var(data, pos)
            else:
                size = 8 if kind == 1 else 4
            if size > wire._MAX_PROTOBUF_FIELD_SIZE or pos + size > len(data):
                raise wire._fail("truncated baseline protobuf field")
            value = data[pos:pos + size]
            pos += size
        else:
            raise wire._fail("unsupported baseline protobuf wire type")
        yield number, kind, value, start, pos


def _get(data: bytes, number: int, default=None):
    values = [value for key, _, value, _, _ in _fields(data) if key == number]
    if len(values) > 1:
        raise wire._fail(f"repeated baseline field {number}")
    return values[0] if values else default


def _field(number: int, value: int | bytes) -> bytes:
    if isinstance(value, bytes):
        return wire._encode_varint(number << 3 | 2) + wire._encode_varint(len(value)) + value
    return wire._encode_varint(number << 3) + wire._encode_varint(value)


def _set(data: bytes, number: int, value: int | bytes) -> bytes:
    # Validate uniqueness even when replacing an optional field.
    _get(data, number)
    for key, _, _, start, end in _fields(data):
        if key == number:
            return data[:start] + _field(number, value) + data[end:]
    return data + _field(number, value)


class _Bits:
    def __init__(self, data):
        self.data, self.pos = data, 0

    def read(self, count):
        value = wire._read_bits_lsb(self.data, self.pos, count)
        self.pos += count
        return value

    def var(self):
        value, self.pos = wire._read_unaligned_varint(self.data, self.pos)
        return value

    def uint(self):
        value, self.pos = wire._read_ubitvar(self.data, self.pos)
        return value

    def bytes(self, count):
        value = wire._read_unaligned_bytes(self.data, self.pos, count)
        self.pos += count * 8
        return value

    def string(self):
        value = bytearray()
        while byte := self.read(8):
            value.append(byte)
        return bytes(value)


def _entries(data: bytes, count: int, flags: int, var_sizes: bool):
    bits, index, history, entries = _Bits(data), -1, [], []
    for _ in range(count):
        # CS2 ParseUpdate's explicit index is last_index + varint + 2.
        index += 1 if bits.read(1) else bits.var() + 2
        key = value = None
        if bits.read(1):
            if bits.read(1):
                slot, length = bits.read(5), bits.read(5)
                if slot >= len(history) or length > len(history[slot]):
                    raise wire._fail("invalid baseline string history")
                key = history[slot][:length] + bits.string()
            else:
                key = bits.string()
            history = (history + [key])[-32:]
        if bits.read(1):
            compressed = bits.read(1) if flags & 1 else False
            size = bits.uint() if var_sizes else bits.read(17)
            value = bits.bytes(size)
            if compressed:
                value = wire._snappy_decompress(value)
        entries.append((index, key, value))
    if len(data) * 8 - bits.pos >= 8:
        raise wire._fail("unexpected baseline entry tail")
    return entries, bits.pos


def _splice(data, start, end, value, width, *, total=None):
    total = len(data) * 8 if total is None else total
    original = int.from_bytes(data, "little") & ((1 << total) - 1)
    result = (original & ((1 << start) - 1)) | (value << start) | ((original >> end) << (start + width))
    return result.to_bytes((total - end + start + width + 7) // 8, "little")


def _append_entry(data, end, key, value, flags, var_sizes):
    # Sequential index, explicit key (no history dependency), literal userdata.
    parts = [(3, 3), (int.from_bytes(key + b"\0", "little"), (len(key) + 1) * 8), (1, 1)]
    if flags & 1:
        parts.append((0, 1))
    size = len(value)
    if var_sizes:
        extra = 0 if size < 16 else 4 if size < 256 else 8 if size < 4096 else 28
        parts.append(((size & 15) | ({0: 0, 4: 16, 8: 32, 28: 48}[extra]) | ((size >> 4) << 6), 6 + extra))
    else:
        if size >= 1 << 17:
            raise wire._fail("baseline userdata exceeds fixed length field")
        parts.append((size, 17))
    parts.append((int.from_bytes(value, "little"), size * 8))
    encoded = width = 0
    for number, count in parts:
        encoded |= number << width
        width += count
    return _splice(data, end, len(data) * 8, encoded, width)


def _frames(reader):
    while True:
        start = reader.tell()
        command = wire._read_stream_varint(reader, context="baseline command", allow_clean_eof=True)
        if command is None:
            return
        tick = wire._read_stream_varint(reader, context="baseline tick")
        size = wire._read_stream_varint(reader, context="baseline frame size")
        if size[0] > wire._MAX_OUTER_FRAME_SIZE:
            raise wire._fail("baseline frame exceeds size limit")
        payload = wire._read_exact(reader, size[0], context="baseline frame")
        yield start, command[0], tick[0], payload, command[1] + tick[1] + size[1] + payload


def _snapshot(data: bytes):
    tables = [(value, start, end) for key, _, value, start, end in _fields(data)
              if key == 1 and _get(value, 1) == b"instancebaseline"]
    if len(tables) != 1:
        raise wire._fail("expected one instancebaseline snapshot")
    table, start, end = tables[0]
    items = [value for key, _, value, _, _ in _fields(table) if key == 2]
    values = [(_get(item, 1), _get(item, 2, b"")) for item in items]
    return table, start, end, items, values


def _plan(reader):
    """Match only the evidenced signon -> tick-1 update -> full snapshot shape."""
    header = wire._read_exact(reader, 16, context="baseline demo header")
    if header[:8] != wire._MAGIC:
        raise wire._fail("expected PBDEMS2 short header")
    classes, tables, snapshots = {}, [], []
    initial = update = full = None
    entities_seen = False
    for offset, command, tick, payload, raw in _frames(reader):
        kind = command & ~64
        if tick != wire._U32_MAX and tick > 1:
            break
        if kind not in (5, 6, 7, 8, 13):
            continue
        decoded = wire._snappy_decompress(payload) if command & 64 else payload
        frame = (offset, command, tick, raw)
        if kind == 5:
            classes.update({_get(value, 1): _get(value, 2) for key, _, value, _, _ in _fields(decoded) if key == 1})
        elif kind == 6 and tick == wire._U32_MAX:
            snapshots.append((frame, decoded))
        elif kind == 13:
            if tick == 1:
                full = _get(decoded, 1)
            break
        elif kind in (7, 8):
            packet = _get(decoded, 3, b"")
            records = wire._parse_netmessages(packet)
            for record in records:
                if record.message_type == 55 and tick != wire._U32_MAX:
                    entities_seen = True
                if record.message_type not in (44, 45):
                    continue
                body = wire._read_unaligned_bytes(packet, record.payload_start_bit, record.payload_size)
                if record.message_type == 44:
                    name = _get(body, 1)
                    tables.append(name)
                    if name == b"instancebaseline":
                        if initial is not None or tick != wire._U32_MAX:
                            return None
                        initial = (frame, decoded, packet, records, record, body, len(tables) - 1)
                elif initial and _get(body, 1) == initial[-1]:
                    if tick != 1 or entities_seen or update is not None:
                        return None
                    update = body
    if initial is None or update is None or full is None or not snapshots:
        return None
    frame, decoded, packet, records, record, create, _ = initial
    # Fixed-size userdata isn't the observed instancebaseline encoding.
    if _get(create, 3, 0):
        return None
    flags, var_sizes, count = _get(create, 6, 0), _get(create, 10, 0), _get(create, 2, 0)
    data = _get(create, 7, b"")
    if _get(create, 9, 0):
        data = wire._snappy_decompress(data)
    old, end = _entries(data, count, flags, var_sizes)
    added, _ = _entries(_get(update, 3, b""), _get(update, 2, 1), flags, var_sizes)
    if len(added) != 1:
        return None
    index, key, value = added[0]
    if not key or not key.isdigit() or classes.get(int(key)) != b"CChicken":
        return None
    if any(entry[1] == key for entry in old):
        return None  # Already preloaded: byte-identical no-op.
    if index != count or not value or [entry[0] for entry in old] != list(range(count)):
        raise wire._fail("late CChicken baseline has inconsistent initial indices")
    expected = [(entry[1], entry[2]) for entry in old]
    if any(k is None or v is None for k, v in expected):
        raise wire._fail("incomplete initial baseline entries")
    _, _, _, full_items, full_values = _snapshot(full)
    if full_values != expected + [(key, value)]:
        raise wire._fail("late CChicken baseline disagrees with full snapshot")
    replacements = {}
    for snap_frame, snapshot in snapshots:
        table, start, stop, _, values = _snapshot(snapshot)
        if values != expected:
            raise wire._fail("initial baseline snapshots disagree")
        patched = snapshot[:start] + _field(1, table + _field(2, full_items[-1])) + snapshot[stop:]
        replacements[snap_frame[0]] = (snap_frame, patched)
    new_data = _append_entry(data, end, key, value, flags, var_sizes)
    if _entries(new_data, count + 1, flags, var_sizes)[0] != old + [(index, key, value)]:
        raise wire._fail("preloaded baseline entry verification failed")
    new_create = _set(create, 2, count + 1)
    new_create = _set(new_create, 7, wire._snappy_compress(new_data) if _get(create, 9, 0) else new_data)
    if _get(create, 9, 0):
        new_create = _set(new_create, 8, len(new_data))
    encoded = wire._encode_varint(len(new_create)) + new_create
    new_packet = _splice(packet, record.type_end_bit, record.end_bit, int.from_bytes(encoded, "little"), len(encoded) * 8, total=records[-1].end_bit)
    after = wire._parse_netmessages(new_packet)
    if len(after) != len(records):
        raise wire._fail("preloaded baseline changed packet framing")
    for before, following in zip(records, after):
        before_body = wire._read_unaligned_bytes(packet, before.payload_start_bit, before.payload_size)
        after_body = wire._read_unaligned_bytes(new_packet, following.payload_start_bit, following.payload_size)
        if before.message_type != following.message_type or after_body != (new_create if before == record else before_body):
            raise wire._fail("preloaded baseline changed unrelated netmessage")
    replacements[frame[0]] = (frame, _set(decoded, 3, new_packet))
    return replacements


def repair_recording_baseline(path: str | Path) -> bool:
    """Atomically patch an app-owned recording copy, never a library original."""
    path = Path(path)
    original_stat = wire._stat_fingerprint(path.stat())
    with path.open("rb") as reader:
        plan = _plan(reader)
    if plan is None:
        return False
    replacements = {}
    for offset, (frame, decoded) in plan.items():
        _, command, tick, _ = frame
        payload = wire._snappy_compress(decoded) if command & 64 else decoded
        replacements[offset] = wire._encode_outer_frame(command, tick, payload)
    temp = tempfile.NamedTemporaryFile(mode="w+b", prefix=f".{path.name}.baseline-", suffix=".tmp", dir=path.parent, delete=False)
    temp_path = Path(temp.name)
    try:
        with temp as writer, path.open("rb") as reader:
            header = bytearray(wire._read_exact(reader, 16, context="baseline header"))
            old_offsets = [int.from_bytes(header[pos:pos + 4], "little") for pos in (8, 12)]
            offsets, commands = {}, {}
            writer.write(header)
            for offset, command, _, _, raw in _frames(reader):
                if offset in old_offsets:
                    offsets[offset], commands[offset] = writer.tell(), command & ~64
                writer.write(replacements.get(offset, raw))
            wire._validate_header_offsets(*old_offsets, commands)
            for pos, old in zip((8, 12), old_offsets):
                new = offsets[old] if old else 0
                if new > wire._U32_MAX:
                    raise wire._fail("preloaded baseline footer offset overflow")
                header[pos:pos + 4] = new.to_bytes(4, "little")
            writer.seek(0)
            writer.write(header)
            writer.flush()
            os.fsync(writer.fileno())
        with path.open("rb") as original, temp_path.open("rb") as patched:
            original.seek(16)
            if patched.read(16) != header:
                raise wire._fail("preloaded baseline header verification failed")
            patched_frames = _frames(patched)
            for offset, _, _, _, raw in _frames(original):
                actual = next(patched_frames, None)
                if actual is None or actual[-1] != replacements.get(offset, raw):
                    raise wire._fail("preloaded baseline changed unrelated demo frame")
            if next(patched_frames, None) is not None:
                raise wire._fail("preloaded baseline added unexpected demo frames")
            patched.seek(0)
            if _plan(patched) is not None:
                raise wire._fail("preloaded baseline is not idempotent")
        if wire._stat_fingerprint(path.stat()) != original_stat:
            raise wire._fail("recording demo changed during baseline repair")
        os.replace(temp_path, path)
    finally:
        temp.close()
        temp_path.unlink(missing_ok=True)
    logger.info("Preloaded tick-1 CChicken baseline in recording copy: %s", path)
    return True
