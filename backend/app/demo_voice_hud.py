"""Build a demo-specific Panorama voice HUD package.

CS2 demo playback still decodes ``svc_VoiceData``, but the normal lower-left
speaker notices are not published on the HLTV demo UI path.  The bundled VPK
contains the stock demo controller plus a small Panorama overlay.  Before CS2
starts, this module fills that overlay with speaking intervals and player
locations extracted from the demo itself.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
import json
from pathlib import Path
import re
import struct
from typing import Any, Callable, Iterable, Mapping
import zlib

_VPK_SIGNATURE = 0x55AA1234
_VPK_VERSION = 2
_VPK_HEADER = struct.Struct("<7I")
_VPK_ENTRY = struct.Struct("<IHHIIH")
_VPK_INLINE_ARCHIVE = 0x7FFF
_VPK_ENTRY_TERMINATOR = 0xFFFF

VOICE_SCRIPT_PATH = "panorama/scripts/hud/huddemocontroller.vts_c"
VOICE_DATA_BEGIN = b"/*__CS2_INSIGHT_VOICE_DATA_BEGIN__*/"
VOICE_DATA_END = b"/*__CS2_INSIGHT_VOICE_DATA_END__*/"


class DemoVoiceHudError(RuntimeError):
    """Raised when a safe demo-specific HUD package cannot be produced."""


@dataclass(frozen=True)
class DemoVoiceHudBuild:
    vpk_bytes: bytes
    voice_packets: int
    speakers: int
    intervals: int
    location_changes: int
    payload_bytes: int
    location_parse_failed: int
    input_tracks: int = 0
    input_changes: int = 0
    input_commands: int = 0
    input_button_updates: int = 0
    input_subtick_steps: int = 0


def _read_cstring(data: bytes, cursor: int, limit: int) -> tuple[str, int]:
    end = data.find(b"\0", cursor, limit)
    if end < 0:
        raise DemoVoiceHudError("VPK directory contains an unterminated string")
    try:
        value = data[cursor:end].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise DemoVoiceHudError("VPK directory contains a non-UTF-8 path") from exc
    return value, end + 1


def read_inline_vpk(vpk_bytes: bytes) -> dict[str, bytes]:
    """Read the inline entries used by the bundled, single-file VPK."""
    if len(vpk_bytes) < _VPK_HEADER.size:
        raise DemoVoiceHudError("VPK is shorter than its header")
    (
        signature,
        version,
        tree_size,
        file_data_size,
        archive_md5_size,
        other_md5_size,
        signature_size,
    ) = _VPK_HEADER.unpack_from(vpk_bytes)
    if signature != _VPK_SIGNATURE or version != _VPK_VERSION:
        raise DemoVoiceHudError("voice HUD template is not a supported VPK v2 archive")

    tree_start = _VPK_HEADER.size
    tree_end = tree_start + tree_size
    data_start = tree_end
    data_end = data_start + file_data_size
    archive_end = data_end + archive_md5_size + other_md5_size + signature_size
    if tree_end > len(vpk_bytes) or data_end > len(vpk_bytes) or archive_end > len(vpk_bytes):
        raise DemoVoiceHudError("VPK section sizes exceed the archive length")

    cursor = tree_start
    entries: dict[str, bytes] = {}
    while True:
        extension, cursor = _read_cstring(vpk_bytes, cursor, tree_end)
        if not extension:
            break
        while True:
            directory, cursor = _read_cstring(vpk_bytes, cursor, tree_end)
            if not directory:
                break
            while True:
                stem, cursor = _read_cstring(vpk_bytes, cursor, tree_end)
                if not stem:
                    break
                if cursor + _VPK_ENTRY.size > tree_end:
                    raise DemoVoiceHudError("VPK directory entry is truncated")
                (
                    expected_crc,
                    preload_size,
                    archive_index,
                    entry_offset,
                    entry_length,
                    terminator,
                ) = _VPK_ENTRY.unpack_from(vpk_bytes, cursor)
                cursor += _VPK_ENTRY.size
                if terminator != _VPK_ENTRY_TERMINATOR:
                    raise DemoVoiceHudError("VPK directory entry terminator is invalid")
                preload_end = cursor + preload_size
                if preload_end > tree_end:
                    raise DemoVoiceHudError("VPK preload bytes exceed the directory tree")
                preload = vpk_bytes[cursor:preload_end]
                cursor = preload_end
                if archive_index != _VPK_INLINE_ARCHIVE:
                    raise DemoVoiceHudError("voice HUD template references an external VPK archive")
                entry_start = data_start + entry_offset
                entry_end = entry_start + entry_length
                if entry_start < data_start or entry_end > data_end:
                    raise DemoVoiceHudError("VPK entry exceeds its inline data section")
                body = preload + vpk_bytes[entry_start:entry_end]
                if zlib.crc32(body) & 0xFFFFFFFF != expected_crc:
                    raise DemoVoiceHudError("VPK entry CRC does not match its payload")

                directory_part = "" if directory == " " else directory.strip("/")
                extension_part = "" if extension == " " else f".{extension}"
                leaf = f"{stem}{extension_part}"
                full_path = f"{directory_part}/{leaf}" if directory_part else leaf
                entries[full_path] = body

    if cursor != tree_end:
        raise DemoVoiceHudError("VPK directory tree has trailing or missing bytes")
    return entries


def write_inline_vpk(entries: Mapping[str, bytes]) -> bytes:
    """Write a deterministic VPK v2 with every entry embedded in the dir file."""
    grouped: dict[str, dict[str, dict[str, bytes]]] = defaultdict(
        lambda: defaultdict(dict)
    )
    for raw_path, body in entries.items():
        normalized = raw_path.replace("\\", "/").strip("/")
        if not normalized or "/../" in f"/{normalized}/" or normalized.startswith("../"):
            raise DemoVoiceHudError(f"unsafe VPK entry path: {raw_path!r}")
        directory, _, leaf = normalized.rpartition("/")
        if "." in leaf:
            stem, extension = leaf.rsplit(".", 1)
        else:
            stem, extension = leaf, " "
        if not stem or not extension:
            raise DemoVoiceHudError(f"invalid VPK entry path: {raw_path!r}")
        grouped[extension][directory or " "][stem] = bytes(body)

    data = bytearray()
    tree = bytearray()
    for extension in sorted(grouped):
        tree.extend(extension.encode("utf-8") + b"\0")
        for directory in sorted(grouped[extension]):
            tree.extend(directory.encode("utf-8") + b"\0")
            for stem in sorted(grouped[extension][directory]):
                body = grouped[extension][directory][stem]
                offset = len(data)
                data.extend(body)
                tree.extend(stem.encode("utf-8") + b"\0")
                tree.extend(
                    _VPK_ENTRY.pack(
                        zlib.crc32(body) & 0xFFFFFFFF,
                        0,
                        _VPK_INLINE_ARCHIVE,
                        offset,
                        len(body),
                        _VPK_ENTRY_TERMINATOR,
                    )
                )
            tree.extend(b"\0")
        tree.extend(b"\0")
    tree.extend(b"\0")

    return b"".join(
        (
            _VPK_HEADER.pack(
                _VPK_SIGNATURE,
                _VPK_VERSION,
                len(tree),
                len(data),
                0,
                0,
                0,
            ),
            bytes(tree),
            bytes(data),
        )
    )


def _base36(value: int) -> str:
    if value < 0:
        raise DemoVoiceHudError("voice HUD timeline contains a negative value")
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    if value == 0:
        return "0"
    encoded = ""
    while value:
        value, remainder = divmod(value, 36)
        encoded = alphabet[remainder] + encoded
    return encoded


def _merge_ticks(
    ticks: Iterable[int],
    *,
    merge_gap_ticks: int = 12,
    tail_ticks: int = 12,
) -> list[tuple[int, int]]:
    ordered = sorted(set(int(tick) for tick in ticks if int(tick) >= 0))
    if not ordered:
        return []
    intervals: list[tuple[int, int]] = []
    start = last = ordered[0]
    for tick in ordered[1:]:
        if tick <= last + merge_gap_ticks:
            last = tick
            continue
        intervals.append((start, last + tail_ticks))
        start = last = tick
    intervals.append((start, last + tail_ticks))
    return intervals


def _encode_intervals(intervals: Iterable[tuple[int, int]]) -> str:
    previous_start = 0
    encoded: list[str] = []
    for start, end in intervals:
        encoded.append(f"{_base36(start - previous_start)}.{_base36(end - start)}")
        previous_start = start
    return ",".join(encoded)


def _encode_locations(
    changes: Iterable[tuple[int, str]],
    token_index: Callable[[str], int],
) -> str:
    previous_tick = 0
    encoded: list[str] = []
    for tick, token in changes:
        encoded.append(f"{_base36(tick - previous_tick)}.{_base36(token_index(token))}")
        previous_tick = tick
    return ",".join(encoded)


def _as_positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if parsed > 0 else None


def _build_team_roster(parser: Any) -> tuple[list[list[Any]], dict[int, tuple[int, int]]]:
    """Return compact ``[xuid, slot, team]`` rows keyed by exact Steam ID."""
    try:
        player_info = parser.parse_player_info()
    except Exception as exc:  # noqa: BLE001 - native parser errors are contextualized
        raise DemoVoiceHudError(f"could not parse demo player teams: {exc}") from exc
    if not isinstance(player_info, Mapping):
        raise DemoVoiceHudError("demoparser returned unsupported player info")

    player_xuids = player_info.get("steamid")
    player_teams = player_info.get("team_number")
    if not isinstance(player_xuids, list) or not isinstance(player_teams, list):
        raise DemoVoiceHudError("demo player info contains no Steam ID/team roster")
    if len(player_xuids) != len(player_teams):
        raise DemoVoiceHudError("demo player info Steam ID/team columns are misaligned")

    roster: list[list[Any]] = []
    by_xuid: dict[int, tuple[int, int]] = {}
    for slot, (raw_xuid, raw_team) in enumerate(zip(player_xuids, player_teams)):
        xuid = _as_positive_int(raw_xuid)
        try:
            team = int(raw_team)
        except (TypeError, ValueError, OverflowError):
            continue
        if xuid is None or team not in (2, 3):
            continue
        if xuid in by_xuid:
            raise DemoVoiceHudError(f"demo player roster repeats Steam ID {xuid}")
        by_xuid[xuid] = (slot, team)
        roster.append([str(xuid), slot, team])
    if not roster:
        raise DemoVoiceHudError("demo player info contains no team-bound Steam IDs")
    return roster, by_xuid


def build_voice_payload(
    demo_path: str | Path,
    *,
    parser_factory: Callable[[str], Any] | None = None,
) -> tuple[bytes, dict[str, int]]:
    """Extract and compact the voice packet/location timeline for Panorama."""
    if parser_factory is None:
        from demoparser2 import DemoParser

        parser_factory = DemoParser
    parser = parser_factory(str(demo_path))
    try:
        voice_rows = parser.parse_voice()
    except Exception as exc:  # noqa: BLE001 - demoparser surfaces native errors
        raise DemoVoiceHudError(f"could not parse demo voice packets: {exc}") from exc
    if not isinstance(voice_rows, list):
        raise DemoVoiceHudError("demoparser returned an unsupported voice table")

    encoded_roster, roster_by_xuid = _build_team_roster(parser)

    ticks_by_xuid: dict[int, list[int]] = defaultdict(list)
    for row in voice_rows:
        if not isinstance(row, Mapping):
            continue
        xuid = _as_positive_int(row.get("steamid"))
        tick = _as_positive_int(row.get("tick"))
        audio = row.get("bytes")
        if (
            xuid not in roster_by_xuid
            or tick is None
            or not isinstance(audio, (bytes, bytearray))
            or not audio
        ):
            continue
        ticks_by_xuid[xuid].append(tick)
    if not ticks_by_xuid:
        raise DemoVoiceHudError("demo contains no team-bound voice packets")
    voice_packets = sum(len(ticks) for ticks in ticks_by_xuid.values())

    try:
        location_rows = parser.parse_ticks(["last_place_name"])
    except Exception as exc:  # noqa: BLE001 - location is useful but non-fatal
        location_rows = {}
        location_error = exc
    else:
        location_error = None

    changes_by_xuid: dict[int, list[tuple[int, str]]] = {
        xuid: [] for xuid in ticks_by_xuid
    }
    last_token: dict[int, str] = {}
    if isinstance(location_rows, Mapping):
        ticks = location_rows.get("tick", [])
        xuids = location_rows.get("steamid", [])
        locations = location_rows.get("last_place_name", [])
        for raw_tick, raw_xuid, raw_location in zip(ticks, xuids, locations):
            xuid = _as_positive_int(raw_xuid)
            tick = _as_positive_int(raw_tick)
            if xuid not in changes_by_xuid or tick is None:
                continue
            token = "" if raw_location is None else str(raw_location).strip().lstrip("#")
            if token == last_token.get(xuid):
                continue
            changes_by_xuid[xuid].append((tick, token))
            last_token[xuid] = token

    location_tokens = [""]
    location_token_indexes = {"": 0}

    def location_token_index(token: str) -> int:
        if token not in location_token_indexes:
            location_token_indexes[token] = len(location_tokens)
            location_tokens.append(token)
        return location_token_indexes[token]

    encoded_speakers: list[list[Any]] = []
    interval_count = 0
    location_count = 0
    for xuid in sorted(ticks_by_xuid):
        slot, _team = roster_by_xuid[xuid]
        intervals = _merge_ticks(ticks_by_xuid[xuid])
        locations = changes_by_xuid[xuid]
        interval_count += len(intervals)
        location_count += len(locations)
        encoded_speakers.append(
            [
                slot,
                str(xuid),
                _encode_intervals(intervals),
                _encode_locations(locations, location_token_index),
            ]
        )

    payload = json.dumps(
        [location_tokens, encoded_speakers, [], encoded_roster],
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode("ascii")
    stats = {
        "voice_packets": voice_packets,
        "speakers": len(encoded_speakers),
        "intervals": interval_count,
        "location_changes": location_count,
        "payload_bytes": len(payload),
        "location_parse_failed": int(location_error is not None),
    }
    return payload, stats


_ENCODED_INPUT_TRACK = re.compile(r"(?:[0-9a-z]+\.[0-9a-z]+)(?:,[0-9a-z]+\.[0-9a-z]+)*\Z")


def add_input_tracks_to_payload(
    voice_payload: bytes,
    demo_path: str | Path,
    input_track_report: Mapping[str, Any],
    *,
    parser_factory: Callable[[str], Any] | None = None,
) -> tuple[bytes, dict[str, int]]:
    """Attach exact, slot-keyed UserCmd tracks to the Panorama payload."""
    try:
        packed = json.loads(voice_payload.decode("ascii"))
    except (UnicodeDecodeError, ValueError, TypeError) as exc:
        raise DemoVoiceHudError("voice HUD payload is not valid compact JSON") from exc
    if not isinstance(packed, list) or len(packed) != 4:
        raise DemoVoiceHudError("voice HUD payload has an unsupported shape")

    slot_to_xuid: dict[int, int] = {}
    encoded_roster = packed[3]
    if not isinstance(encoded_roster, list):
        raise DemoVoiceHudError("voice HUD payload contains no player roster")
    for row in encoded_roster:
        if not isinstance(row, list) or len(row) != 3:
            continue
        xuid = _as_positive_int(row[0])
        try:
            slot = int(row[1])
        except (TypeError, ValueError, OverflowError):
            continue
        if xuid is not None and slot >= 0:
            slot_to_xuid[slot] = xuid

    raw_tracks = input_track_report.get("tracks")
    if not isinstance(raw_tracks, list):
        raise DemoVoiceHudError("input-track report contains no track list")
    encoded_tracks: list[list[str]] = []
    input_changes = 0
    seen_xuids: set[str] = set()
    for raw_track in raw_tracks:
        if not isinstance(raw_track, Mapping):
            continue
        try:
            slot = int(raw_track.get("slot"))
            changes = int(raw_track.get("changes"))
        except (TypeError, ValueError, OverflowError):
            continue
        if slot < 0 or changes <= 0:
            continue
        xuid = slot_to_xuid.get(slot)
        encoded = raw_track.get("encoded")
        if xuid is None or not isinstance(encoded, str) or not _ENCODED_INPUT_TRACK.fullmatch(encoded):
            continue
        xuid_text = str(xuid)
        if xuid_text in seen_xuids:
            raise DemoVoiceHudError(f"input-track report repeats Steam ID {xuid_text}")
        seen_xuids.add(xuid_text)
        encoded_tracks.append([xuid_text, encoded])
        input_changes += changes
    if not encoded_tracks:
        raise DemoVoiceHudError("input-track report contains no usable player tracks")

    packed[2] = encoded_tracks
    payload = json.dumps(packed, ensure_ascii=True, separators=(",", ":")).encode("ascii")

    def report_int(key: str) -> int:
        try:
            return max(0, int(input_track_report.get(key, 0)))
        except (TypeError, ValueError, OverflowError):
            return 0

    return payload, {
        "input_tracks": len(encoded_tracks),
        "input_changes": input_changes,
        "input_commands": report_int("commands"),
        "input_button_updates": report_int("button_updates"),
        "input_subtick_steps": report_int("subtick_steps"),
    }


def inject_voice_payload(template_vpk: bytes, payload: bytes) -> bytes:
    """Fill the bounded data slot and rebuild the VPK with fresh CRCs."""
    entries = read_inline_vpk(template_vpk)
    script = entries.get(VOICE_SCRIPT_PATH)
    if script is None:
        raise DemoVoiceHudError(f"voice HUD template is missing {VOICE_SCRIPT_PATH}")
    begin = script.find(VOICE_DATA_BEGIN)
    end = script.find(VOICE_DATA_END, begin + len(VOICE_DATA_BEGIN))
    if begin < 0 or end < 0:
        raise DemoVoiceHudError("voice HUD template data markers were not found")
    payload_start = begin + len(VOICE_DATA_BEGIN)
    capacity = end - payload_start
    if len(payload) > capacity:
        raise DemoVoiceHudError(
            f"demo voice schedule needs {len(payload)} bytes but the template holds {capacity}"
        )
    entries[VOICE_SCRIPT_PATH] = b"".join(
        (
            script[:payload_start],
            payload,
            b" " * (capacity - len(payload)),
            script[end:],
        )
    )
    return write_inline_vpk(entries)


def build_demo_voice_hud_vpk(
    demo_path: str | Path,
    template_vpk_path: str | Path,
    *,
    parser_factory: Callable[[str], Any] | None = None,
    input_track_report: Mapping[str, Any] | None = None,
) -> DemoVoiceHudBuild:
    payload, stats = build_voice_payload(demo_path, parser_factory=parser_factory)
    input_stats = {
        "input_tracks": 0,
        "input_changes": 0,
        "input_commands": 0,
        "input_button_updates": 0,
        "input_subtick_steps": 0,
    }
    if input_track_report is not None:
        payload, input_stats = add_input_tracks_to_payload(
            payload,
            demo_path,
            input_track_report,
            parser_factory=parser_factory,
        )
        stats["payload_bytes"] = len(payload)
    template = Path(template_vpk_path).read_bytes()
    vpk_bytes = inject_voice_payload(template, payload)
    return DemoVoiceHudBuild(vpk_bytes=vpk_bytes, **stats, **input_stats)
