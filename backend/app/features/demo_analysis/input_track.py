from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from ...input_command import (
    extract_player_input_track,
    load_input_report,
)

_MAGIC = b"PBDEMS2\x00"
_COMPRESSED_COMMAND_FLAG = 64
_PACKET_COMMANDS = frozenset({7, 8, 13})
_DEM_USERCMD = 12
_SVC_USERCMDS = 76
_MAX_OUTER_FRAME_SIZE = 256 * 1024 * 1024


KEYS = ("W", "A", "S", "D", "jump", "crouch", "walk", "reload", "fire", "scope")


@dataclass(frozen=True)
class PreparedInputTrackBatch:
    """One authoritative UserCmd report shared by every segment in a demo."""

    demo_key: tuple[str, int, int]
    report: Mapping[str, Any]


def _demo_cache_key(demo_path: str | Path) -> tuple[str, int, int]:
    path = Path(demo_path).resolve()
    try:
        stat = path.stat()
    except OSError:
        return (str(path), 0, 0)
    return (str(path), int(stat.st_size), int(stat.st_mtime_ns))


def _packet_data_bytes(command: int, payload: bytes) -> bytes | None:
    from ...demo_playback_compat import _parse_proto_fields

    packet_proto = payload
    if command == 13:
        nested = _parse_proto_fields(payload, target_field_number=2)
        if nested is None:
            return None
        _key_end, value_start, value_end = nested
        packet_proto = payload[value_start:value_end]
    data_field = _parse_proto_fields(packet_proto, target_field_number=3)
    if data_field is None:
        return None
    _key_end, value_start, value_end = data_field
    return packet_proto[value_start:value_end]


def _payload_has_svc_usercmds(command: int, payload: bytes) -> bool:
    from ...demo_playback_compat import _parse_netmessages

    packet_data = _packet_data_bytes(command, payload)
    if not packet_data:
        return False
    return any(record.message_type == _SVC_USERCMDS for record in _parse_netmessages(packet_data))


def detect_player_keyboard_input(
    *,
    demo_path: str | Path,
) -> bool | None:
    """Cheap carrier probe for queue warnings; not the HUD extraction report.

    ``True`` if the demo contains ``DEM_UserCmd`` or nested ``svc_UserCmds``.
    ``False`` if a readable PBDEMS2 file has neither.  ``None`` if the file
    cannot be classified.  This deliberately does not spawn the Rust extractor.
    """
    from ...demo_playback_compat import (
        DemoPlaybackCompatibilityError,
        _read_stream_varint,
        _snappy_decompress,
    )

    path = Path(demo_path)
    try:
        file_size = path.stat().st_size
        with path.open("rb") as reader:
            header = reader.read(16)
            if len(header) != 16 or header[:8] != _MAGIC:
                return None
            while True:
                command_result = _read_stream_varint(
                    reader, context="outer command", allow_clean_eof=True,
                )
                if command_result is None:
                    return False
                raw_command, _raw = command_result
                tick_result = _read_stream_varint(reader, context="outer tick")
                size_result = _read_stream_varint(reader, context="outer payload size")
                if tick_result is None or size_result is None:
                    return None
                size = size_result[0]
                if size < 0 or size > _MAX_OUTER_FRAME_SIZE:
                    return None
                command = raw_command & ~_COMPRESSED_COMMAND_FLAG
                if command == _DEM_USERCMD:
                    return True
                payload_end = reader.tell() + size
                if payload_end > file_size:
                    return None
                if command not in _PACKET_COMMANDS:
                    reader.seek(size, os.SEEK_CUR)
                    continue
                payload = reader.read(size)
                if len(payload) != size:
                    return None
                try:
                    decoded = (
                        _snappy_decompress(payload)
                        if raw_command & _COMPRESSED_COMMAND_FLAG
                        else payload
                    )
                    if _payload_has_svc_usercmds(command, decoded):
                        return True
                except DemoPlaybackCompatibilityError:
                    continue
    except (OSError, DemoPlaybackCompatibilityError):
        return None


def prepare_input_track_batch(
    demo_path: str,
    windows: list[tuple[int, int]],
) -> PreparedInputTrackBatch:
    for start_tick, end_tick in windows:
        if int(end_tick) < int(start_tick):
            raise ValueError(f"Invalid input-track tick window: {start_tick}-{end_tick}")
    return PreparedInputTrackBatch(
        demo_key=_demo_cache_key(demo_path),
        report=load_input_report(demo_path),
    )


def extract_input_track(
    demo_path: str,
    *,
    steamid: str | int | None = None,
    player_name: str | None = None,
    start_tick: int,
    end_tick: int,
    shared_start_tick: int | None = None,
    shared_end_tick: int | None = None,
    prepared: PreparedInputTrackBatch | None = None,
) -> list[dict]:
    """Return exact mask-backed keyboard frames in ascending demo-tick order.

    ``shared_*`` remains in the public call contract but no longer changes the
    extraction window: the native report is already parsed once for the entire
    demo and cached by file identity.
    """
    del shared_start_tick, shared_end_tick
    report = (
        prepared.report
        if prepared is not None and prepared.demo_key == _demo_cache_key(demo_path)
        else load_input_report(demo_path)
    )
    return extract_player_input_track(
        report,
        steamid=steamid,
        player_name=player_name,
        start_tick=int(start_tick),
        end_tick=int(end_tick),
    )
