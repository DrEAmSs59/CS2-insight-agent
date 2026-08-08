"""Safe compatibility rewriting for legacy PBDEMS2 demos.

The July 2026 CS2 client can lose netmessage framing when it encounters the
legacy entity message ``EM_RemoveAllDecals`` (type 138).  The terminal
``cs_win_panel_match`` event is also observed when CS2 enters the post-match
panel, after which later ``demo_gototick`` commands are ignored.  This module
can prepare a disposable playback copy without that event, and can atomically
remove both compatibility blockers from the source demo after the rewritten
file has passed a complete rescan.

Detection is content-based.  File dates and demo filenames are deliberately
not used: a packet is changed only when type 138 has the exact, previously
validated ``CEntityMessageRemoveAllDecals`` wire schema.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import time
from dataclasses import asdict, dataclass
from functools import lru_cache
from pathlib import Path
from typing import BinaryIO, Callable, Literal, Optional


PATCH_ID = "drop-legacy-remove-all-decals-138"
PATCH_REVISION = 3
WIN_PANEL_PATCH_ID = "drop-cs-win-panel-match-gameevent-207"
PERSISTENT_PATCH_ID = f"{PATCH_ID}+{WIN_PANEL_PATCH_ID}"

_MAGIC = b"PBDEMS2\x00"
_COMPRESSED_COMMAND_FLAG = 64
_PACKET_COMMANDS = frozenset({7, 8, 13})
_TYPE_REMOVE_ALL_DECALS = 138
_TYPE_GAME_EVENT = 207
_WIN_PANEL_MATCH_EVENT_ID = 216
_WIN_PANEL_MATCH_EVENT_NAME = b"cs_win_panel_match"

# Defensive limits.  Real packet frames are far below these ceilings.
_MAX_OUTER_FRAME_SIZE = 256 * 1024 * 1024
_MAX_TRUNCATED_PACKET_TAIL_MISSING_BYTES = 64 * 1024
_MAX_SNAPPY_DECOMPRESSED_SIZE = 128 * 1024 * 1024
_MAX_PROTOBUF_FIELD_SIZE = 128 * 1024 * 1024
_MAX_NETMESSAGE_PAYLOAD_SIZE = 64 * 1024 * 1024
_U32_MAX = (1 << 32) - 1
_U64_MAX = (1 << 64) - 1


class DemoPlaybackCompatibilityError(ValueError):
    """The source demo cannot be safely classified or rewritten."""


@dataclass(frozen=True)
class DemoCompatibilityScan:
    selected_messages: int
    affected_frames: int
    first_tick: Optional[int]
    last_tick: Optional[int]
    max_per_frame: int
    outer_frames: int
    selected_win_panel_events: int = 0


@dataclass(frozen=True)
class PlaybackDemoReport:
    schema_version: int
    outcome: Literal["clean", "repaired", "tolerated"]
    patch_id: str
    patch_revision: int
    removed_messages: int
    changed_frames: int
    first_tick: Optional[int]
    last_tick: Optional[int]
    max_per_frame: int
    remaining_selected_messages: int
    removed_win_panel_events: int = 0
    remaining_win_panel_events: int = 0
    tolerated_truncated_packet_tail: bool = False

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True)
class TruncatedPacketTailRepair:
    """Narrow classification of one incomplete terminal packet."""

    frame_offset: int
    tick: int
    declared_payload_size: int
    available_payload_size: int
    missing_payload_bytes: int
    discarded_bytes: int


@dataclass
class _PatchStats:
    removed_messages: int = 0
    removed_win_panel_events: int = 0
    changed_frames: int = 0
    first_tick: Optional[int] = None
    last_tick: Optional[int] = None
    max_per_frame: int = 0
    outer_frames: int = 0

    def add_frame(
        self,
        tick: int,
        removed: int,
        removed_win_panel_events: int = 0,
    ) -> None:
        removed_total = removed + removed_win_panel_events
        if removed_total <= 0:
            return
        self.removed_messages += removed
        self.removed_win_panel_events += removed_win_panel_events
        self.changed_frames += 1
        self.first_tick = tick if self.first_tick is None else self.first_tick
        self.last_tick = tick
        self.max_per_frame = max(self.max_per_frame, removed_total)


@dataclass(frozen=True)
class _MessageRecord:
    message_type: int
    payload_size: int
    start_bit: int
    type_end_bit: int
    payload_start_bit: int
    end_bit: int


def _fail(message: str) -> DemoPlaybackCompatibilityError:
    return DemoPlaybackCompatibilityError(message)


def _encode_varint(value: int) -> bytes:
    if value < 0 or value > _U64_MAX:
        raise _fail(f"varint value out of u64 range: {value}")
    out = bytearray()
    while value >= 0x80:
        out.append((value & 0x7F) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def _read_varint_bytes(
    data: bytes,
    pos: int,
    *,
    max_bits: int,
    context: str,
) -> tuple[int, int, bytes]:
    max_bytes = (max_bits + 6) // 7
    value = 0
    start = pos
    for index in range(max_bytes):
        if pos >= len(data):
            raise _fail(f"truncated {context} varint")
        byte = data[pos]
        pos += 1
        value |= (byte & 0x7F) << (7 * index)
        if not (byte & 0x80):
            if value >= (1 << max_bits):
                raise _fail(f"overflowing {context} varint")
            return value, pos, data[start:pos]
    raise _fail(f"overflowing {context} varint")


def _read_stream_varint(
    reader: BinaryIO,
    *,
    context: str,
    allow_clean_eof: bool = False,
) -> Optional[tuple[int, bytes]]:
    first = reader.read(1)
    if not first:
        if allow_clean_eof:
            return None
        raise _fail(f"truncated {context} varint")
    raw = bytearray(first)
    value = first[0] & 0x7F
    if not (first[0] & 0x80):
        return value, bytes(raw)
    for index in range(1, 5):
        part = reader.read(1)
        if not part:
            raise _fail(f"truncated {context} varint")
        raw.extend(part)
        byte = part[0]
        value |= (byte & 0x7F) << (7 * index)
        if not (byte & 0x80):
            if value > _U32_MAX:
                raise _fail(f"overflowing {context} varint")
            return value, bytes(raw)
    raise _fail(f"overflowing {context} varint")


def _read_exact(reader: BinaryIO, size: int, *, context: str) -> bytes:
    if size < 0:
        raise _fail(f"negative {context} size")
    data = reader.read(size)
    if len(data) != size:
        raise _fail(f"truncated {context}: expected {size} bytes, got {len(data)}")
    return data


def _snappy_declared_size(payload: bytes) -> int:
    size, _pos, _raw = _read_varint_bytes(
        payload,
        0,
        max_bits=32,
        context="Snappy uncompressed-size",
    )
    if size > _MAX_SNAPPY_DECOMPRESSED_SIZE:
        raise _fail(
            "Snappy block exceeds decompressed-size limit: "
            f"{size} > {_MAX_SNAPPY_DECOMPRESSED_SIZE}"
        )
    return size


@lru_cache(maxsize=1)
def _snappy_backend() -> tuple[str, object]:
    """Resolve the native codec once; avoid an ImportError for every frame."""

    try:
        import cramjam  # type: ignore[import-not-found]

        return "cramjam", cramjam
    except ImportError:
        try:
            import pyarrow as pa  # type: ignore[import-not-found]

            return "pyarrow", pa
        except ImportError as exc:
            raise _fail(
                "raw Snappy support is unavailable; install the backend requirements"
            ) from exc


def _snappy_decompress(payload: bytes) -> bytes:
    expected_size = _snappy_declared_size(payload)
    try:
        backend_name, backend = _snappy_backend()
        if backend_name == "cramjam":
            decoded = bytes(backend.snappy.decompress_raw(payload))  # type: ignore[attr-defined]
        else:
            # Standard demoparser2 installs include PyArrow. Lean release
            # builds install cramjam explicitly through the uv-locked runtime.
            decoded = bytes(  # type: ignore[attr-defined]
                backend.Codec("snappy").decompress(payload, expected_size)
            )
    except DemoPlaybackCompatibilityError:
        raise
    except Exception as exc:
        raise _fail(f"invalid raw Snappy block: {exc}") from exc
    if len(decoded) != expected_size:
        raise _fail(
            "Snappy decompressed-size mismatch: "
            f"declared {expected_size}, decoded {len(decoded)}"
        )
    return decoded


def _snappy_compress(data: bytes) -> bytes:
    if len(data) > _MAX_SNAPPY_DECOMPRESSED_SIZE:
        raise _fail(f"packet is too large to Snappy-compress: {len(data)}")
    try:
        backend_name, backend = _snappy_backend()
        if backend_name == "cramjam":
            encoded = bytes(backend.snappy.compress_raw(data))  # type: ignore[attr-defined]
        else:
            encoded = bytes(backend.Codec("snappy").compress(data))  # type: ignore[attr-defined]
    except Exception as exc:
        raise _fail(f"raw Snappy compression failed: {exc}") from exc
    if _snappy_decompress(encoded) != data:
        raise _fail("raw Snappy round-trip verification failed")
    return encoded


def _read_bits_lsb(data: bytes, bit_pos: int, count: int) -> int:
    if count < 0 or count > 32:
        raise _fail(f"invalid bit read width: {count}")
    if bit_pos < 0 or bit_pos + count > len(data) * 8:
        raise _fail("netmessage bitstream is truncated")
    if count == 0:
        return 0
    first_byte = bit_pos >> 3
    shift = bit_pos & 7
    byte_count = (shift + count + 7) >> 3
    chunk = int.from_bytes(data[first_byte : first_byte + byte_count], "little")
    return (chunk >> shift) & ((1 << count) - 1)


def _read_ubitvar(data: bytes, bit_pos: int) -> tuple[int, int]:
    first = _read_bits_lsb(data, bit_pos, 6)
    bit_pos += 6
    selector = first & 0x30
    if selector == 0x10:
        value = (first & 0x0F) | (_read_bits_lsb(data, bit_pos, 4) << 4)
        return value, bit_pos + 4
    if selector == 0x20:
        value = (first & 0x0F) | (_read_bits_lsb(data, bit_pos, 8) << 4)
        return value, bit_pos + 8
    if selector == 0x30:
        value = (first & 0x0F) | (_read_bits_lsb(data, bit_pos, 28) << 4)
        return value, bit_pos + 28
    return first, bit_pos


def _read_unaligned_varint(data: bytes, bit_pos: int) -> tuple[int, int]:
    value = 0
    for index in range(10):
        byte = _read_bits_lsb(data, bit_pos, 8)
        bit_pos += 8
        value |= (byte & 0x7F) << (7 * index)
        if not (byte & 0x80):
            if value > _U64_MAX:
                raise _fail("overflowing netmessage payload-size varint")
            return value, bit_pos
    raise _fail("overflowing netmessage payload-size varint")


def _read_unaligned_bytes(data: bytes, bit_pos: int, size: int) -> bytes:
    if size < 0 or bit_pos < 0 or bit_pos + size * 8 > len(data) * 8:
        raise _fail("netmessage payload extends past packet data")
    if size == 0:
        return b""
    if not (bit_pos & 7):
        start = bit_pos >> 3
        return data[start : start + size]
    shift = bit_pos & 7
    base = bit_pos >> 3
    out = bytearray(size)
    for index in range(size):
        lo = data[base + index] >> shift
        next_index = base + index + 1
        hi = data[next_index] << (8 - shift) if next_index < len(data) else 0
        out[index] = (lo | hi) & 0xFF
    return bytes(out)


def _parse_netmessages(packet_data: bytes) -> list[_MessageRecord]:
    records: list[_MessageRecord] = []
    bit_pos = 0
    total_bits = len(packet_data) * 8
    while total_bits - bit_pos > 8:
        start = bit_pos
        message_type, bit_pos = _read_ubitvar(packet_data, bit_pos)
        type_end = bit_pos
        payload_size, bit_pos = _read_unaligned_varint(packet_data, bit_pos)
        if payload_size > _MAX_NETMESSAGE_PAYLOAD_SIZE:
            raise _fail(
                "netmessage payload exceeds size limit: "
                f"{payload_size} > {_MAX_NETMESSAGE_PAYLOAD_SIZE}"
            )
        payload_start = bit_pos
        payload_bits = payload_size * 8
        if payload_bits > total_bits - bit_pos:
            raise _fail(
                f"netmessage type {message_type} payload extends past packet data"
            )
        bit_pos += payload_bits
        records.append(
            _MessageRecord(
                message_type=message_type,
                payload_size=payload_size,
                start_bit=start,
                type_end_bit=type_end,
                payload_start_bit=payload_start,
                end_bit=bit_pos,
            )
        )
    return records


def _read_canonical_proto_varint(
    data: bytes,
    pos: int,
    *,
    max_bits: int,
    context: str,
) -> tuple[int, int]:
    value, end, raw = _read_varint_bytes(
        data,
        pos,
        max_bits=max_bits,
        context=context,
    )
    if raw != _encode_varint(value):
        raise _fail(f"non-canonical {context} varint")
    return value, end


def _validate_remove_all_decals_payload(payload: bytes) -> None:
    """Apply the deliberately narrow legacy CEntityMessage predicate."""

    pos = 0
    key, pos = _read_canonical_proto_varint(
        payload, pos, max_bits=64, context="RemoveAllDecals field-1 key"
    )
    if key != (1 << 3):
        raise _fail("type 138 payload does not begin with varint field 1")
    remove_decals, pos = _read_canonical_proto_varint(
        payload, pos, max_bits=64, context="RemoveAllDecals field-1 value"
    )
    if remove_decals != 1:
        raise _fail("type 138 remove_decals must be exactly true")

    key, pos = _read_canonical_proto_varint(
        payload, pos, max_bits=64, context="RemoveAllDecals field-2 key"
    )
    if key != ((2 << 3) | 2):
        raise _fail("type 138 payload second field is not bytes field 2")
    nested_size, pos = _read_canonical_proto_varint(
        payload, pos, max_bits=64, context="RemoveAllDecals nested length"
    )
    nested_end = pos + nested_size
    if nested_end != len(payload):
        raise _fail("type 138 payload has an invalid nested length or trailing fields")
    nested = payload[pos:nested_end]

    nested_pos = 0
    nested_key, nested_pos = _read_canonical_proto_varint(
        nested, nested_pos, max_bits=64, context="entity_msg field-1 key"
    )
    if nested_key != (1 << 3):
        raise _fail("type 138 entity_msg is not exactly varint field 1")
    target_entity, nested_pos = _read_canonical_proto_varint(
        nested, nested_pos, max_bits=64, context="target_entity"
    )
    if target_entity > _U32_MAX:
        raise _fail("type 138 target_entity does not fit u32")
    if nested_pos != len(nested):
        raise _fail("type 138 entity_msg contains duplicate, unknown, or trailing fields")


def _is_win_panel_match_event(
    payload: bytes,
    *,
    allow_tick_selected_fallback: bool = False,
) -> bool:
    """Match the terminal, keyless ``CSVCMsg_GameEvent`` conservatively.

    The tested CS2 tournament demo omits ``event_name`` and encodes event id
    216 plus the server event tick.  Some producers include the literal name,
    which is even stronger evidence.  When demoparser has already selected the
    exact outer tick, a unique keyless event may be accepted as a version-safe
    fallback.  A message with keys, duplicate fields, unknown fields,
    non-canonical framing, or no event tick is deliberately not selected.
    """

    pos = 0
    event_name: Optional[bytes] = None
    event_id: Optional[int] = None
    event_tick: Optional[int] = None
    try:
        while pos < len(payload):
            key, key_end, raw_key = _read_varint_bytes(
                payload,
                pos,
                max_bits=64,
                context="win-panel GameEvent field key",
            )
            if raw_key != _encode_varint(key) or key == 0:
                return False
            pos = key_end
            field_number = key >> 3
            wire_type = key & 7

            if field_number == 1:
                if wire_type != 2 or event_name is not None:
                    return False
                size, pos, raw_size = _read_varint_bytes(
                    payload,
                    pos,
                    max_bits=64,
                    context="win-panel GameEvent name length",
                )
                if raw_size != _encode_varint(size) or pos + size > len(payload):
                    return False
                event_name = payload[pos : pos + size]
                pos += size
            elif field_number in (2, 4):
                if wire_type != 0:
                    return False
                value, pos, raw_value = _read_varint_bytes(
                    payload,
                    pos,
                    max_bits=64,
                    context="win-panel GameEvent varint",
                )
                if raw_value != _encode_varint(value):
                    return False
                if field_number == 2:
                    if event_id is not None:
                        return False
                    event_id = value
                else:
                    if event_tick is not None:
                        return False
                    event_tick = value
            else:
                # Field 3 contains event keys.  cs_win_panel_match is keyless;
                # rejecting it also protects against selecting another event
                # if a future build reuses numeric id 216.
                return False
    except DemoPlaybackCompatibilityError:
        return False

    if event_tick is None:
        return False
    if event_name is not None:
        return event_name == _WIN_PANEL_MATCH_EVENT_NAME
    return event_id == _WIN_PANEL_MATCH_EVENT_ID or (
        allow_tick_selected_fallback and event_id is not None
    )


def _validate_selected_record_framing(
    packet_data: bytes,
    target: _MessageRecord,
    *,
    label: str,
) -> None:
    if target.type_end_bit - target.start_bit != 10:
        raise _fail(f"{label} does not use the canonical 10-bit UBitVar encoding")
    canonical_size = _encode_varint(target.payload_size)
    if (
        target.payload_start_bit - target.type_end_bit != len(canonical_size) * 8
        or _read_unaligned_bytes(
            packet_data,
            target.type_end_bit,
            len(canonical_size),
        )
        != canonical_size
    ):
        raise _fail(f"{label} payload size does not use canonical varint framing")


def _copy_bit_range(
    destination: bytearray,
    destination_bit: int,
    source: bytes,
    source_start_bit: int,
    source_end_bit: int,
) -> int:
    source_bit = source_start_bit
    while source_bit < source_end_bit:
        count = min(8 - (destination_bit & 7), source_end_bit - source_bit)
        value = _read_bits_lsb(source, source_bit, count)
        destination[destination_bit >> 3] |= value << (destination_bit & 7)
        source_bit += count
        destination_bit += count
    return destination_bit


def _bit_ranges_equal(
    left: bytes,
    left_start: int,
    left_end: int,
    right: bytes,
    right_start: int,
    right_end: int,
) -> bool:
    if left_end - left_start != right_end - right_start:
        return False
    remaining = left_end - left_start
    while remaining:
        count = min(32, remaining)
        if _read_bits_lsb(left, left_start, count) != _read_bits_lsb(
            right, right_start, count
        ):
            return False
        left_start += count
        right_start += count
        remaining -= count
    return True


def _strip_playback_messages(
    packet_data: bytes,
    *,
    drop_legacy_type138: bool,
    drop_win_panel_match: bool,
    allow_win_panel_tick_fallback: bool = False,
) -> Optional[tuple[bytes, int, int]]:
    records = _parse_netmessages(packet_data)
    type138_targets = (
        [record for record in records if record.message_type == _TYPE_REMOVE_ALL_DECALS]
        if drop_legacy_type138
        else []
    )
    win_panel_targets: list[_MessageRecord] = []
    if drop_win_panel_match:
        fallback_targets: list[_MessageRecord] = []
        for record in records:
            if record.message_type != _TYPE_GAME_EVENT:
                continue
            payload = _read_unaligned_bytes(
                packet_data,
                record.payload_start_bit,
                record.payload_size,
            )
            if _is_win_panel_match_event(payload):
                win_panel_targets.append(record)
            elif allow_win_panel_tick_fallback and _is_win_panel_match_event(
                payload,
                allow_tick_selected_fallback=True,
            ):
                fallback_targets.append(record)
        if not win_panel_targets:
            if len(fallback_targets) > 1:
                raise _fail(
                    "demoparser win-panel tick contains multiple keyless "
                    "GameEvents; refusing an ambiguous rewrite"
                )
            win_panel_targets = fallback_targets

    targets = [*type138_targets, *win_panel_targets]
    if not targets:
        return None

    for target in type138_targets:
        _validate_selected_record_framing(packet_data, target, label="type 138")
        payload = _read_unaligned_bytes(
            packet_data,
            target.payload_start_bit,
            target.payload_size,
        )
        _validate_remove_all_decals_payload(payload)
    for target in win_panel_targets:
        _validate_selected_record_framing(
            packet_data,
            target,
            label="cs_win_panel_match GameEvent",
        )

    target_starts = {record.start_bit for record in targets}
    kept = [record for record in records if record.start_bit not in target_starts]
    kept_bits = sum(record.end_bit - record.start_bit for record in kept)
    rewritten = bytearray((kept_bits + 7) // 8)
    destination_bit = 0
    for record in kept:
        destination_bit = _copy_bit_range(
            rewritten,
            destination_bit,
            packet_data,
            record.start_bit,
            record.end_bit,
        )
    if destination_bit != kept_bits:
        raise _fail("internal bitstream rewrite length mismatch")

    output = bytes(rewritten)
    output_records = _parse_netmessages(output)
    if len(output_records) != len(kept):
        raise _fail("rewritten packet changed the kept netmessage count")
    for original, current in zip(kept, output_records):
        if (
            original.message_type != current.message_type
            or original.payload_size != current.payload_size
            or not _bit_ranges_equal(
                packet_data,
                original.start_bit,
                original.end_bit,
                output,
                current.start_bit,
                current.end_bit,
            )
        ):
            raise _fail("rewritten packet changed a retained netmessage")
    if drop_legacy_type138 and any(
        record.message_type == _TYPE_REMOVE_ALL_DECALS for record in output_records
    ):
        raise _fail("rewritten packet still contains selected type 138")
    if drop_win_panel_match:
        for record in output_records:
            if record.message_type != _TYPE_GAME_EVENT:
                continue
            payload = _read_unaligned_bytes(
                output,
                record.payload_start_bit,
                record.payload_size,
            )
            if _is_win_panel_match_event(payload):
                raise _fail("rewritten packet still contains cs_win_panel_match GameEvent")
    return output, len(type138_targets), len(win_panel_targets)


def _strip_legacy_type138(packet_data: bytes) -> Optional[tuple[bytes, int]]:
    """Backward-compatible helper retained for focused unit tests and callers."""

    result = _strip_playback_messages(
        packet_data,
        drop_legacy_type138=True,
        drop_win_panel_match=False,
        allow_win_panel_tick_fallback=False,
    )
    if result is None:
        return None
    rewritten, removed, _removed_win_panel = result
    return rewritten, removed


def _parse_proto_fields(
    data: bytes,
    *,
    target_field_number: int,
) -> Optional[tuple[int, int, int]]:
    """Return (key_end, value_start, value_end) for one bytes field."""

    pos = 0
    target: Optional[tuple[int, int, int]] = None
    while pos < len(data):
        key, key_end, _key_raw = _read_varint_bytes(
            data, pos, max_bits=64, context="protobuf field key"
        )
        if key == 0:
            raise _fail("protobuf field number 0 is invalid")
        field_number = key >> 3
        wire_type = key & 7
        pos = key_end
        if wire_type == 0:
            _value, pos, _raw = _read_varint_bytes(
                data, pos, max_bits=64, context="protobuf varint field"
            )
            value_start = value_end = -1
        elif wire_type == 1:
            value_start = pos
            value_end = pos + 8
            if value_end > len(data):
                raise _fail("truncated protobuf fixed64 field")
            pos = value_end
        elif wire_type == 2:
            length, value_start, _raw = _read_varint_bytes(
                data, pos, max_bits=64, context="protobuf length"
            )
            if length > _MAX_PROTOBUF_FIELD_SIZE:
                raise _fail(
                    "protobuf field exceeds size limit: "
                    f"{length} > {_MAX_PROTOBUF_FIELD_SIZE}"
                )
            value_end = value_start + length
            if value_end > len(data):
                raise _fail("truncated protobuf length-delimited field")
            pos = value_end
        elif wire_type == 5:
            value_start = pos
            value_end = pos + 4
            if value_end > len(data):
                raise _fail("truncated protobuf fixed32 field")
            pos = value_end
        else:
            raise _fail(f"unsupported protobuf wire type {wire_type}")

        if field_number == target_field_number:
            if wire_type != 2:
                raise _fail(
                    f"protobuf target field {target_field_number} is not length-delimited"
                )
            if target is not None:
                raise _fail(f"protobuf target field {target_field_number} is repeated")
            target = (key_end, value_start, value_end)
    return target


def _replace_unique_length_delimited_field(
    data: bytes,
    *,
    field_number: int,
    transform: Callable[[bytes], Optional[bytes]],
) -> Optional[bytes]:
    target = _parse_proto_fields(data, target_field_number=field_number)
    if target is None:
        return None
    key_end, value_start, value_end = target
    replacement = transform(data[value_start:value_end])
    if replacement is None:
        return None
    return (
        data[:key_end]
        + _encode_varint(len(replacement))
        + replacement
        + data[value_end:]
    )


def _patch_cdemo_packet(
    packet_proto: bytes,
    tick: int,
    stats: _PatchStats,
    *,
    drop_legacy_type138: bool,
    drop_win_panel_match: bool,
    win_panel_match_tick: Optional[int],
) -> Optional[bytes]:
    removed_in_packet = 0
    removed_win_panel_in_packet = 0

    def transform(packet_data: bytes) -> Optional[bytes]:
        nonlocal removed_in_packet, removed_win_panel_in_packet
        tick_selected_panel = (
            win_panel_match_tick is not None and tick == win_panel_match_tick
        )
        result = _strip_playback_messages(
            packet_data,
            drop_legacy_type138=drop_legacy_type138,
            drop_win_panel_match=drop_win_panel_match or tick_selected_panel,
            # The version-safe id fallback is only safe when demoparser has
            # independently selected this exact outer tick.  A global source
            # repair removes only the known id/name and never guesses.
            allow_win_panel_tick_fallback=tick_selected_panel,
        )
        if result is None:
            return None
        rewritten, removed, removed_win_panel = result
        removed_in_packet = removed
        removed_win_panel_in_packet = removed_win_panel
        return rewritten

    patched = _replace_unique_length_delimited_field(
        packet_proto,
        field_number=3,
        transform=transform,
    )
    if patched is not None:
        stats.add_frame(tick, removed_in_packet, removed_win_panel_in_packet)
    return patched


def _patch_outer_payload(
    command: int,
    payload: bytes,
    tick: int,
    stats: _PatchStats,
    *,
    drop_legacy_type138: bool,
    drop_win_panel_match: bool,
    win_panel_match_tick: Optional[int],
) -> Optional[bytes]:
    if command in (7, 8):
        return _patch_cdemo_packet(
            payload,
            tick,
            stats,
            drop_legacy_type138=drop_legacy_type138,
            drop_win_panel_match=drop_win_panel_match,
            win_panel_match_tick=win_panel_match_tick,
        )
    if command == 13:
        return _replace_unique_length_delimited_field(
            payload,
            field_number=2,
            transform=lambda packet: _patch_cdemo_packet(
                packet,
                tick,
                stats,
                drop_legacy_type138=drop_legacy_type138,
                drop_win_panel_match=drop_win_panel_match,
                win_panel_match_tick=win_panel_match_tick,
            ),
        )
    return None


def _validate_header_offsets(
    old_offset_a: int,
    old_offset_b: int,
    offset_commands: dict[int, int],
) -> None:
    for offset, expected_command, label in (
        (old_offset_a, 2, "FileInfo"),
        (old_offset_b, 15, "SpawnGroups"),
    ):
        if offset == 0:
            continue
        command = offset_commands.get(offset)
        if command is None:
            raise _fail(f"short-header {label} offset {offset} is not a frame boundary")
        if command != expected_command:
            raise _fail(
                f"short-header {label} offset points to command {command}, "
                f"expected {expected_command}"
            )


def _scan_stream(
    reader: BinaryIO,
    *,
    stop_after_first_selected: bool = False,
    drop_legacy_type138: bool = True,
    drop_win_panel_match: bool = False,
    win_panel_match_tick: Optional[int] = None,
    logical_end_offset: Optional[int] = None,
) -> tuple[_PatchStats, tuple[int, int]]:
    header = _read_exact(reader, 16, context="PBDEMS2 short header")
    if header[:8] != _MAGIC:
        raise _fail("expected PBDEMS2 short header")
    old_offset_a = int.from_bytes(header[8:12], "little")
    old_offset_b = int.from_bytes(header[12:16], "little")
    old_pos = 16
    offset_commands: dict[int, int] = {}
    stats = _PatchStats()

    while True:
        if logical_end_offset is not None:
            current_offset = reader.tell()
            if current_offset == logical_end_offset:
                break
            if current_offset > logical_end_offset:
                raise _fail("compatibility scan crossed its validated logical EOF")
        command_result = _read_stream_varint(
            reader, context="outer command", allow_clean_eof=True
        )
        if command_result is None:
            break
        raw_command, raw_command_bytes = command_result
        tick_result = _read_stream_varint(reader, context="outer tick")
        size_result = _read_stream_varint(reader, context="outer payload size")
        assert tick_result is not None and size_result is not None
        tick, raw_tick_bytes = tick_result
        size, raw_size_bytes = size_result
        if size > _MAX_OUTER_FRAME_SIZE:
            raise _fail(f"outer frame exceeds size limit: {size}")
        payload = _read_exact(reader, size, context="outer frame payload")
        if logical_end_offset is not None and reader.tell() > logical_end_offset:
            raise _fail("outer frame crosses the validated logical EOF")

        command = raw_command & ~_COMPRESSED_COMMAND_FLAG
        if old_pos in (old_offset_a, old_offset_b):
            offset_commands[old_pos] = command
        stats.outer_frames += 1
        inspect_packet = drop_legacy_type138 or drop_win_panel_match or (
            win_panel_match_tick is not None and tick == win_panel_match_tick
        )
        if command in _PACKET_COMMANDS and inspect_packet:
            decoded = (
                _snappy_decompress(payload)
                if raw_command & _COMPRESSED_COMMAND_FLAG
                else payload
            )
            _patch_outer_payload(
                command,
                decoded,
                tick,
                stats,
                drop_legacy_type138=drop_legacy_type138,
                drop_win_panel_match=drop_win_panel_match,
                win_panel_match_tick=win_panel_match_tick,
            )
            if stop_after_first_selected and (
                stats.removed_messages or stats.removed_win_panel_events
            ):
                return stats, (old_offset_a, old_offset_b)
        old_pos += (
            len(raw_command_bytes)
            + len(raw_tick_bytes)
            + len(raw_size_bytes)
            + len(payload)
        )

    _validate_header_offsets(old_offset_a, old_offset_b, offset_commands)
    return stats, (old_offset_a, old_offset_b)


def scan_demo_legacy_type138(source_path: os.PathLike[str] | str) -> DemoCompatibilityScan:
    """Classify a demo by strict packet content; never use timestamps."""

    source = Path(source_path)
    with source.open("rb") as reader:
        stats, _offsets = _scan_stream(reader)
    return DemoCompatibilityScan(
        selected_messages=stats.removed_messages,
        affected_frames=stats.changed_frames,
        first_tick=stats.first_tick,
        last_tick=stats.last_tick,
        max_per_frame=stats.max_per_frame,
        outer_frames=stats.outer_frames,
        selected_win_panel_events=0,
    )


def scan_demo_playback_messages(
    source_path: os.PathLike[str] | str,
    *,
    win_panel_match_tick: Optional[int],
    scan_legacy_type138: bool = True,
    scan_win_panel_match: bool = False,
) -> DemoCompatibilityScan:
    """Scan exactly the selected compatibility message classes."""

    source = Path(source_path)
    with source.open("rb") as reader:
        stats, _offsets = _scan_stream(
            reader,
            drop_legacy_type138=scan_legacy_type138,
            drop_win_panel_match=scan_win_panel_match,
            win_panel_match_tick=win_panel_match_tick,
        )
    return DemoCompatibilityScan(
        selected_messages=stats.removed_messages,
        affected_frames=stats.changed_frames,
        first_tick=stats.first_tick,
        last_tick=stats.last_tick,
        max_per_frame=stats.max_per_frame,
        outer_frames=stats.outer_frames,
        selected_win_panel_events=stats.removed_win_panel_events,
    )


def _rewrite_stream(
    reader: BinaryIO,
    writer: BinaryIO,
    *,
    drop_legacy_type138: bool = True,
    drop_win_panel_match: bool = False,
    win_panel_match_tick: Optional[int] = None,
) -> _PatchStats:
    header = _read_exact(reader, 16, context="PBDEMS2 short header")
    if header[:8] != _MAGIC:
        raise _fail("expected PBDEMS2 short header")
    old_offset_a = int.from_bytes(header[8:12], "little")
    old_offset_b = int.from_bytes(header[12:16], "little")
    writer.write(header)

    old_pos = 16
    new_pos = 16
    offset_map: dict[int, int] = {}
    offset_commands: dict[int, int] = {}
    stats = _PatchStats()

    while True:
        command_result = _read_stream_varint(
            reader, context="outer command", allow_clean_eof=True
        )
        if command_result is None:
            break
        raw_command, raw_command_bytes = command_result
        tick_result = _read_stream_varint(reader, context="outer tick")
        size_result = _read_stream_varint(reader, context="outer payload size")
        assert tick_result is not None and size_result is not None
        tick, raw_tick_bytes = tick_result
        size, raw_size_bytes = size_result
        if size > _MAX_OUTER_FRAME_SIZE:
            raise _fail(f"outer frame exceeds size limit: {size}")
        payload = _read_exact(reader, size, context="outer frame payload")

        command = raw_command & ~_COMPRESSED_COMMAND_FLAG
        if old_pos in (old_offset_a, old_offset_b):
            offset_map[old_pos] = new_pos
            offset_commands[old_pos] = command
        stats.outer_frames += 1

        replacement: Optional[bytes] = None
        inspect_packet = drop_legacy_type138 or drop_win_panel_match or (
            win_panel_match_tick is not None and tick == win_panel_match_tick
        )
        if command in _PACKET_COMMANDS and inspect_packet:
            decoded = (
                _snappy_decompress(payload)
                if raw_command & _COMPRESSED_COMMAND_FLAG
                else payload
            )
            patched = _patch_outer_payload(
                command,
                decoded,
                tick,
                stats,
                drop_legacy_type138=drop_legacy_type138,
                drop_win_panel_match=drop_win_panel_match,
                win_panel_match_tick=win_panel_match_tick,
            )
            if patched is not None:
                replacement = (
                    _snappy_compress(patched)
                    if raw_command & _COMPRESSED_COMMAND_FLAG
                    else patched
                )

        writer.write(raw_command_bytes)
        writer.write(raw_tick_bytes)
        if replacement is None:
            writer.write(raw_size_bytes)
            writer.write(payload)
            new_frame_size = (
                len(raw_command_bytes)
                + len(raw_tick_bytes)
                + len(raw_size_bytes)
                + len(payload)
            )
        else:
            new_size_bytes = _encode_varint(len(replacement))
            writer.write(new_size_bytes)
            writer.write(replacement)
            new_frame_size = (
                len(raw_command_bytes)
                + len(raw_tick_bytes)
                + len(new_size_bytes)
                + len(replacement)
            )

        old_pos += (
            len(raw_command_bytes)
            + len(raw_tick_bytes)
            + len(raw_size_bytes)
            + len(payload)
        )
        new_pos += new_frame_size

    _validate_header_offsets(old_offset_a, old_offset_b, offset_commands)
    for old_offset, label in ((old_offset_a, "FileInfo"), (old_offset_b, "SpawnGroups")):
        if old_offset and old_offset not in offset_map:
            raise _fail(f"could not remap short-header {label} offset {old_offset}")
    new_offset_a = 0 if old_offset_a == 0 else offset_map[old_offset_a]
    new_offset_b = 0 if old_offset_b == 0 else offset_map[old_offset_b]
    if new_offset_a > _U32_MAX or new_offset_b > _U32_MAX:
        raise _fail("rewritten short-header offset exceeds u32")

    writer.seek(8)
    writer.write(new_offset_a.to_bytes(4, "little"))
    writer.write(new_offset_b.to_bytes(4, "little"))
    writer.seek(0, os.SEEK_END)
    return stats


def _files_equal(left: Path, right: Path) -> bool:
    try:
        if left.stat().st_size != right.stat().st_size:
            return False
        with left.open("rb") as left_file, right.open("rb") as right_file:
            while True:
                left_chunk = left_file.read(1024 * 1024)
                right_chunk = right_file.read(1024 * 1024)
                if left_chunk != right_chunk:
                    return False
                if not left_chunk:
                    return True
    except OSError:
        return False


def read_demo_end_tick(source_path: os.PathLike[str] | str) -> int:
    """Return the maximum PBDEMS2 outer-frame tick without decoding payloads.

    This is the file's playback boundary, unlike event-derived maxima such as
    the last death or round-end tick.  Recording uses it only to stop before
    actual EOF so CS2 cannot finish the demo and return to the main menu.
    """

    source = Path(source_path)
    file_size = source.stat().st_size
    with source.open("rb") as reader:
        header = _read_exact(reader, 16, context="PBDEMS2 short header")
        if header[:8] != _MAGIC:
            raise _fail("expected PBDEMS2 short header")

        max_tick = 0
        while True:
            command_result = _read_stream_varint(
                reader,
                context="outer command",
                allow_clean_eof=True,
            )
            if command_result is None:
                return max_tick
            tick_result = _read_stream_varint(reader, context="outer tick")
            size_result = _read_stream_varint(reader, context="outer payload size")
            assert tick_result is not None and size_result is not None
            tick, _raw_tick = tick_result
            size, _raw_size = size_result
            if size > _MAX_OUTER_FRAME_SIZE:
                raise _fail(f"outer frame exceeds size limit: {size}")
            payload_end = reader.tell() + size
            if payload_end > file_size:
                raise _fail("outer frame payload extends past end of file")
            reader.seek(size, os.SEEK_CUR)
            # PBDEMS2 uses uint32(-1) on terminal metadata/stop frames.  It is
            # a sentinel, not a playable tick.
            if int(tick) != _U32_MAX:
                max_tick = max(max_tick, int(tick))


def _publish_without_overwrite(temp_path: Path, destination: Path) -> None:
    try:
        if os.name == "nt":
            # Windows rename is atomic on one volume and fails if destination
            # already exists.  Unlike a hard link, it also works on exFAT.
            os.rename(temp_path, destination)
            return
        # On POSIX, rename would replace destination.  A same-volume hard link
        # gives atomic no-overwrite publication, then the temp name is removed.
        os.link(temp_path, destination)
    except FileExistsError as exc:
        raise _fail(f"playback destination already exists: {destination}") from exc
    except OSError as exc:
        raise _fail(f"could not atomically publish playback demo: {exc}") from exc
    temp_path.unlink()


def _verify_rewritten_demo(
    source: Path,
    rewritten: Path,
    stats: _PatchStats,
    *,
    drop_legacy_type138: bool = True,
    drop_win_panel_match: bool = False,
    win_panel_match_tick: Optional[int] = None,
) -> DemoCompatibilityScan:
    verification = scan_demo_playback_messages(
        rewritten,
        win_panel_match_tick=win_panel_match_tick,
        scan_legacy_type138=drop_legacy_type138,
        scan_win_panel_match=drop_win_panel_match,
    )
    if drop_legacy_type138 and verification.selected_messages != 0:
        raise _fail(
            "rewritten demo still contains "
            f"{verification.selected_messages} selected type 138 message(s)"
        )
    if (
        drop_win_panel_match or win_panel_match_tick is not None
    ) and verification.selected_win_panel_events != 0:
        raise _fail(
            "rewritten demo still contains "
            f"{verification.selected_win_panel_events} selected "
            "cs_win_panel_match event(s)"
        )
    if (
        stats.removed_messages == 0
        and stats.removed_win_panel_events == 0
        and not _files_equal(source, rewritten)
    ):
        raise _fail("clean rewritten demo is not byte-identical to its source")
    return verification


def _build_report(
    stats: _PatchStats,
    verification: DemoCompatibilityScan,
    *,
    patch_id: str = PATCH_ID,
) -> PlaybackDemoReport:
    return PlaybackDemoReport(
        schema_version=1,
        outcome=(
            "repaired"
            if stats.removed_messages or stats.removed_win_panel_events
            else "clean"
        ),
        patch_id=patch_id,
        patch_revision=PATCH_REVISION,
        removed_messages=stats.removed_messages,
        changed_frames=stats.changed_frames,
        first_tick=stats.first_tick,
        last_tick=stats.last_tick,
        max_per_frame=stats.max_per_frame,
        remaining_selected_messages=verification.selected_messages,
        removed_win_panel_events=stats.removed_win_panel_events,
        remaining_win_panel_events=verification.selected_win_panel_events,
    )


def _stat_fingerprint(stat_result: os.stat_result) -> tuple[int, int, int, int]:
    # Windows may report different st_ctime_ns values for Path.stat() and
    # os.fstat() after shutil.copy2 preserved timestamps.  Device/inode,
    # size, and mtime are stable across both views and still catch replacement
    # or writes during the repair window.
    return (
        int(stat_result.st_dev),
        int(stat_result.st_ino),
        int(stat_result.st_size),
        int(stat_result.st_mtime_ns),
    )


def _find_truncated_packet_tail(
    reader: BinaryIO,
) -> Optional[TruncatedPacketTailRepair]:
    """Return a narrowly classified incomplete final packet, otherwise fail/no-op.

    Only a payload that runs past physical EOF is repairable. Truncated
    varints, metadata frames, backward ticks, empty payload fragments, and
    large gaps remain hard failures so this cannot become a generic corruption
    recovery path.
    """

    file_size = int(os.fstat(reader.fileno()).st_size)
    header = _read_exact(reader, 16, context="PBDEMS2 short header")
    if header[:8] != _MAGIC:
        raise _fail("expected PBDEMS2 short header")
    old_offset_a = int.from_bytes(header[8:12], "little")
    old_offset_b = int.from_bytes(header[12:16], "little")
    offset_commands: dict[int, int] = {}
    complete_frames = 0
    max_tick = 0

    while True:
        frame_offset = reader.tell()
        command_result = _read_stream_varint(
            reader,
            context="outer command",
            allow_clean_eof=True,
        )
        if command_result is None:
            _validate_header_offsets(old_offset_a, old_offset_b, offset_commands)
            return None
        raw_command, _raw_command_bytes = command_result
        tick_result = _read_stream_varint(reader, context="outer tick")
        size_result = _read_stream_varint(reader, context="outer payload size")
        assert tick_result is not None and size_result is not None
        tick, _raw_tick_bytes = tick_result
        size, _raw_size_bytes = size_result
        if size > _MAX_OUTER_FRAME_SIZE:
            raise _fail(f"outer frame exceeds size limit: {size}")

        command = raw_command & ~_COMPRESSED_COMMAND_FLAG
        payload_offset = reader.tell()
        available = file_size - payload_offset
        if size > available:
            missing = size - available
            _validate_header_offsets(old_offset_a, old_offset_b, offset_commands)
            if complete_frames <= 0:
                raise _fail("refusing to discard the first outer frame")
            if command not in _PACKET_COMMANDS:
                raise _fail(
                    f"truncated terminal frame is command {command}, not a packet"
                )
            if int(tick) == _U32_MAX or int(tick) < max_tick:
                raise _fail("truncated terminal packet has an invalid or backward tick")
            if available <= 0:
                raise _fail("truncated terminal packet has no payload bytes")
            if missing > _MAX_TRUNCATED_PACKET_TAIL_MISSING_BYTES:
                raise _fail(
                    "truncated terminal packet exceeds the safe missing-byte limit: "
                    f"{missing}"
                )
            return TruncatedPacketTailRepair(
                frame_offset=int(frame_offset),
                tick=int(tick),
                declared_payload_size=int(size),
                available_payload_size=int(available),
                missing_payload_bytes=int(missing),
                discarded_bytes=int(file_size - frame_offset),
            )

        if frame_offset in (old_offset_a, old_offset_b):
            offset_commands[int(frame_offset)] = int(command)
        reader.seek(size, os.SEEK_CUR)
        complete_frames += 1
        if int(tick) != _U32_MAX:
            max_tick = max(max_tick, int(tick))


def repair_truncated_packet_tail_in_place(
    source_path: os.PathLike[str] | str,
) -> Optional[TruncatedPacketTailRepair]:
    """Atomically discard one incomplete terminal packet from a disposable copy.

    Callers must opt in and must ensure ``source_path`` is an application-owned
    uploaded copy. Clean demos are byte-identical no-ops. The original path is
    replaced only after the retained prefix passes a complete structural scan.
    """

    source = Path(source_path)
    if not source.is_file():
        raise FileNotFoundError(f"Demo file not found: {source}")
    source_before = _stat_fingerprint(source.stat())
    with source.open("rb") as reader:
        if _stat_fingerprint(os.fstat(reader.fileno())) != source_before:
            raise _fail("source demo changed before tail scan started")
        repair = _find_truncated_packet_tail(reader)
    if repair is None:
        return None
    if _stat_fingerprint(source.stat()) != source_before:
        raise _fail("source demo changed while tail scan was running")

    temp_file = tempfile.NamedTemporaryFile(
        mode="w+b",
        prefix=f".{source.name}.tail-",
        suffix=".tmp",
        dir=source.parent,
        delete=False,
    )
    temp_path = Path(temp_file.name)
    replaced = False
    try:
        with temp_file as writer, source.open("rb") as reader:
            if _stat_fingerprint(os.fstat(reader.fileno())) != source_before:
                raise _fail("source demo changed before tail repair started")
            remaining = repair.frame_offset
            while remaining > 0:
                chunk = reader.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise _fail("source demo ended while copying retained prefix")
                writer.write(chunk)
                remaining -= len(chunk)
            writer.flush()
            os.fsync(writer.fileno())

        with temp_path.open("rb") as candidate:
            _scan_stream(
                candidate,
                drop_legacy_type138=False,
                drop_win_panel_match=False,
            )
        if _stat_fingerprint(source.stat()) != source_before:
            raise _fail("source demo changed while tail repair was being validated")

        shutil.copymode(source, temp_path)
        source_stat = source.stat()
        repaired_mtime_ns = max(time.time_ns(), source_stat.st_mtime_ns + 1_000_000_000)
        os.utime(temp_path, ns=(source_stat.st_atime_ns, repaired_mtime_ns))
        if _stat_fingerprint(source.stat()) != source_before:
            raise _fail("source demo changed before atomic tail replacement")
        os.replace(temp_path, source)
        replaced = True
        return repair
    except DemoPlaybackCompatibilityError:
        raise
    except OSError as exc:
        raise _fail(f"could not atomically repair truncated demo tail: {exc}") from exc
    finally:
        if not replaced:
            try:
                temp_file.close()
            except Exception:
                pass
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass


def prepare_cs2_playback_demo(
    source_path: os.PathLike[str] | str,
    destination_path: os.PathLike[str] | str,
    *,
    win_panel_match_tick: Optional[int] = None,
    drop_legacy_type138: bool = True,
) -> PlaybackDemoReport:
    """Create a verified CS2 playback copy with selected blockers removed.

    The destination must not exist.  A secure temporary file in the destination
    directory is fully written, flushed, rescanned, and then published without
    overwriting.  ``win_panel_match_tick`` must come from demoparser's
    ``cs_win_panel_match`` event; only a strict keyless GameEvent at that exact
    outer tick is removed.  Any failure removes the unpublished partial file.
    """

    source = Path(source_path)
    destination = Path(destination_path)
    if not source.is_file():
        raise FileNotFoundError(f"Demo file not found: {source}")
    if source.resolve() == destination.resolve():
        raise _fail("source and playback destination must differ")
    if destination.exists():
        raise _fail(f"playback destination already exists: {destination}")
    if not destination.parent.is_dir():
        raise FileNotFoundError(f"Playback destination directory not found: {destination.parent}")
    if win_panel_match_tick is not None and int(win_panel_match_tick) < 0:
        raise _fail("win_panel_match_tick must be non-negative")
    selected_win_panel_tick = (
        int(win_panel_match_tick) if win_panel_match_tick is not None else None
    )

    temp_file = tempfile.NamedTemporaryFile(
        mode="w+b",
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=destination.parent,
        delete=False,
    )
    temp_path = Path(temp_file.name)
    published = False
    try:
        with temp_file as writer, source.open("rb") as reader:
            stats = _rewrite_stream(
                reader,
                writer,
                drop_legacy_type138=drop_legacy_type138,
                win_panel_match_tick=selected_win_panel_tick,
            )
            writer.flush()
            os.fsync(writer.fileno())

        verification = _verify_rewritten_demo(
            source,
            temp_path,
            stats,
            drop_legacy_type138=drop_legacy_type138,
            win_panel_match_tick=selected_win_panel_tick,
        )

        _publish_without_overwrite(temp_path, destination)
        published = True
        playback_patch_id = (
            PERSISTENT_PATCH_ID
            if selected_win_panel_tick is not None and drop_legacy_type138
            else WIN_PANEL_PATCH_ID
            if selected_win_panel_tick is not None
            else PATCH_ID
        )
        return _build_report(stats, verification, patch_id=playback_patch_id)
    finally:
        if not published:
            try:
                temp_file.close()
            except Exception:
                pass
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass


def repair_demo_in_place(
    source_path: os.PathLike[str] | str,
    *,
    allow_truncated_packet_tail: bool = False,
) -> PlaybackDemoReport:
    """Persistently remove legacy 138 and the terminal win-panel GameEvent.

    The candidate is created in the source directory so ``os.replace`` remains
    same-volume and atomic.  A clean demo is left untouched.  If parsing,
    rewriting, verification, metadata copying, or replacement fails, the
    original path still refers to the original file.

    ``allow_truncated_packet_tail`` is an analysis-only compatibility escape
    hatch.  It accepts exactly the narrow terminal packet shape classified by
    :func:`_find_truncated_packet_tail`, scans the complete prefix as a logical
    file, and never removes the incomplete bytes.  Compatibility messages in
    the retained prefix are reported but not rewritten, because CS2 may still
    recover only the unfinalized demo's original byte stream.
    """

    source = Path(source_path)
    if not source.is_file():
        raise FileNotFoundError(f"Demo file not found: {source}")
    source_before = _stat_fingerprint(source.stat())
    truncated_tail: Optional[TruncatedPacketTailRepair] = None

    if allow_truncated_packet_tail:
        with source.open("rb") as reader:
            if _stat_fingerprint(os.fstat(reader.fileno())) != source_before:
                raise _fail("source demo changed before terminal-tail scan started")
            truncated_tail = _find_truncated_packet_tail(reader)
        if _stat_fingerprint(source.stat()) != source_before:
            raise _fail("source demo changed while terminal-tail scan was running")

    # A clean demo needs only one read pass and no full-size temporary copy.
    # Legacy demos normally expose the first selected message near the start.
    # A panel-only demo requires one full scan to find its terminal event, then
    # continues through the same rewrite + full verification path.
    with source.open("rb") as reader:
        if _stat_fingerprint(os.fstat(reader.fileno())) != source_before:
            raise _fail("source demo changed before compatibility scan started")
        initial_stats, _ = _scan_stream(
            reader,
            stop_after_first_selected=True,
            drop_legacy_type138=True,
            drop_win_panel_match=True,
            logical_end_offset=(
                truncated_tail.frame_offset if truncated_tail is not None else None
            ),
        )
    if _stat_fingerprint(source.stat()) != source_before:
        raise _fail("source demo changed while compatibility scan was running")
    if truncated_tail is not None:
        return PlaybackDemoReport(
            schema_version=1,
            outcome="tolerated",
            patch_id=PERSISTENT_PATCH_ID,
            patch_revision=PATCH_REVISION,
            removed_messages=0,
            changed_frames=0,
            first_tick=None,
            last_tick=None,
            max_per_frame=0,
            remaining_selected_messages=initial_stats.removed_messages,
            removed_win_panel_events=0,
            remaining_win_panel_events=initial_stats.removed_win_panel_events,
            tolerated_truncated_packet_tail=True,
        )
    if (
        initial_stats.removed_messages == 0
        and initial_stats.removed_win_panel_events == 0
    ):
        clean_scan = DemoCompatibilityScan(
            selected_messages=0,
            affected_frames=0,
            first_tick=None,
            last_tick=None,
            max_per_frame=0,
            outer_frames=initial_stats.outer_frames,
            selected_win_panel_events=0,
        )
        return _build_report(
            initial_stats,
            clean_scan,
            patch_id=PERSISTENT_PATCH_ID,
        )

    temp_file = tempfile.NamedTemporaryFile(
        mode="w+b",
        prefix=f".{source.name}.compat-",
        suffix=".tmp",
        dir=source.parent,
        delete=False,
    )
    temp_path = Path(temp_file.name)
    replaced = False
    try:
        with temp_file as writer, source.open("rb") as reader:
            if _stat_fingerprint(os.fstat(reader.fileno())) != source_before:
                raise _fail("source demo changed before compatibility repair started")
            stats = _rewrite_stream(
                reader,
                writer,
                drop_legacy_type138=True,
                drop_win_panel_match=True,
            )
            writer.flush()
            os.fsync(writer.fileno())

        if _stat_fingerprint(source.stat()) != source_before:
            raise _fail("source demo changed while compatibility repair was running")
        verification = _verify_rewritten_demo(
            source,
            temp_path,
            stats,
            drop_legacy_type138=True,
            drop_win_panel_match=True,
        )
        report = _build_report(
            stats,
            verification,
            patch_id=PERSISTENT_PATCH_ID,
        )
        if report.outcome == "clean":
            return report

        # Preserve the mode, but make Last Modified reflect the persistent
        # repair.  Keep it at least one second newer so Explorer's coarse
        # display cannot make a successful replacement look unchanged.
        shutil.copymode(source, temp_path)
        source_stat = source.stat()
        repaired_mtime_ns = max(time.time_ns(), source_stat.st_mtime_ns + 1_000_000_000)
        os.utime(temp_path, ns=(source_stat.st_atime_ns, repaired_mtime_ns))
        if _stat_fingerprint(source.stat()) != source_before:
            raise _fail("source demo changed before atomic compatibility replacement")
        os.replace(temp_path, source)
        replaced = True
        return report
    except DemoPlaybackCompatibilityError:
        raise
    except OSError as exc:
        raise _fail(f"could not atomically replace source demo: {exc}") from exc
    finally:
        if not replaced:
            try:
                temp_file.close()
            except Exception:
                pass
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass
