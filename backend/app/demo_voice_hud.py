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

# Radar overview edge mask for CT dropped-C4 LOS (grid^2 bits, hex-packed).
RADAR_OCCLUSION_GRID = 96

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


# Payload indices 0-3 are voice/input/roster. 4-7 are reserved for mouse /
# subtitles / weapon pulses / broadcast (see internal Panorama VPK guide).
# Index 8 is the custom radar track; index 9 is POV kill/HS feedback audio;
# index 10 is POV flash-blind intervals (HUD wash + tinnitus cues).
RADAR_PAYLOAD_INDEX = 8
KILL_FEEDBACK_PAYLOAD_INDEX = 9
FLASH_BLIND_PAYLOAD_INDEX = 10
RADAR_SAMPLE_HZ = 8
# Flags for kill-feedback samples: bit0 = headshot, bit1 = armor damage.
_COLOR_SLOT_NAMES = {
    "blue": 0,
    "green": 1,
    "yellow": 2,
    "orange": 3,
    "purple": 4,
}


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
    radar_players: int = 0
    radar_samples: int = 0
    radar_parse_failed: int = 0
    radar_map: str = ""
    radar_planted_bombs: int = 0
    radar_dropped_bombs: int = 0
    radar_player_sounds: int = 0
    radar_occlusion_grid: int = 0
    kill_feedback_events: int = 0
    kill_feedback_parse_failed: int = 0
    flash_blind_events: int = 0
    flash_blind_parse_failed: int = 0


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


def _as_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return None


def _zigzag_encode(value: int) -> int:
    return (value << 1) if value >= 0 else ((-value << 1) - 1)


def _player_color_slot(value: Any) -> int:
    if isinstance(value, str):
        key = value.strip().lower()
        if key in _COLOR_SLOT_NAMES:
            return _COLOR_SLOT_NAMES[key]
    slot = _as_int(value)
    if slot is not None and 0 <= slot <= 4:
        return slot
    return -1


def _normalize_map_name(raw: Any) -> str:
    text = str(raw or "").strip().replace("\\", "/").split("/")[-1]
    if text.lower().endswith(".bsp"):
        text = text[:-4]
    return text.strip()


def _pad_payload_slots(
    packed: list[Any],
    length: int = FLASH_BLIND_PAYLOAD_INDEX + 1,
) -> list[Any]:
    if not isinstance(packed, list):
        raise DemoVoiceHudError("voice HUD payload has an unsupported shape")
    if len(packed) < 4:
        raise DemoVoiceHudError("voice HUD payload has an unsupported shape")
    while len(packed) < length:
        packed.append([])
    return packed


def _encode_kill_feedback_events(
    events: list[tuple[int, int, int]],
) -> str:
    """Delta-encode ``(tick, attacker_xuid_index, flags)`` as base36."""
    previous_tick = 0
    encoded: list[str] = []
    for tick, attacker_index, flags in events:
        encoded.append(
            f"{_base36(tick - previous_tick)}.{_base36(attacker_index)}.{_base36(int(flags) & 0xFF)}"
        )
        previous_tick = tick
    return ",".join(encoded)


def _build_kill_feedback_payload(
    parser: Any,
    roster_by_xuid: Mapping[int, tuple[int, int]],
) -> tuple[list[Any], dict[str, Any]]:
    """Compact POV kill/HS feedback events for local Panorama ``play`` cues."""
    try:
        rows = parser.parse_event("player_death")
    except Exception as exc:  # noqa: BLE001 - demoparser failures vary by demo
        raise DemoVoiceHudError(f"could not parse player_death for kill feedback: {exc}") from exc
    if not isinstance(rows, Mapping):
        raise DemoVoiceHudError("demoparser returned unsupported player_death rows")

    ticks = rows.get("tick")
    attackers = rows.get("attacker_steamid")
    victims = rows.get("user_steamid")
    headshots = rows.get("headshot")
    armor_dmg = rows.get("dmg_armor")
    if not isinstance(ticks, list) or not isinstance(attackers, list) or not isinstance(victims, list):
        raise DemoVoiceHudError("player_death rows are missing tick/attacker/victim fields")

    xuid_table: list[str] = []
    xuid_index: dict[int, int] = {}
    events: list[tuple[int, int, int]] = []
    count = min(len(ticks), len(attackers), len(victims))
    for i in range(count):
        tick = _as_int(ticks[i])
        attacker = _as_positive_int(attackers[i])
        victim = _as_positive_int(victims[i])
        if tick is None or tick < 0 or attacker is None:
            continue
        if victim is not None and victim == attacker:
            continue
        if attacker not in roster_by_xuid:
            continue
        if attacker not in xuid_index:
            xuid_index[attacker] = len(xuid_table)
            xuid_table.append(str(attacker))
        flags = 0
        if isinstance(headshots, list) and i < len(headshots) and bool(headshots[i]):
            flags |= 0x1
        if isinstance(armor_dmg, list) and i < len(armor_dmg):
            armor = _as_int(armor_dmg[i])
            if armor is not None and armor > 0:
                flags |= 0x2
        events.append((tick, xuid_index[attacker], flags))

    events.sort(key=lambda item: item[0])
    if not events:
        raise DemoVoiceHudError("demo contains no usable player_death kill feedback events")

    payload = [xuid_table, _encode_kill_feedback_events(events)]
    return payload, {
        "kill_feedback_events": len(events),
        "kill_feedback_parse_failed": 0,
    }


def _encode_flash_blind_events(
    events: list[tuple[int, int, int]],
) -> str:
    """Delta-encode ``(tick, duration_ticks, victim_xuid_index)`` as base36."""
    previous_tick = 0
    encoded: list[str] = []
    for tick, duration_ticks, victim_index in events:
        encoded.append(
            f"{_base36(tick - previous_tick)}.{_base36(max(1, int(duration_ticks)))}.{_base36(victim_index)}"
        )
        previous_tick = tick
    return ",".join(encoded)


def _infer_demo_tick_rate(parser: Any, header: Mapping[str, Any] | None = None) -> float:
    """Best-effort ticks/sec for converting ``blind_duration`` seconds → ticks."""
    if header is None:
        try:
            parsed = parser.parse_header()
            header = parsed if isinstance(parsed, Mapping) else {}
        except Exception:  # noqa: BLE001
            header = {}
    raw = (header or {}).get("tick_rate") or (header or {}).get("tickrate")
    try:
        tick_rate = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        tick_rate = 0.0
    if tick_rate > 0:
        return tick_rate
    # GOTV/SourceTV demos often omit tick_rate; 64 is the usual broadcast rate.
    return 64.0


def _build_radar_occlusion_mask(map_name: str, grid: int = RADAR_OCCLUSION_GRID) -> list[Any] | None:
    """Pack a radar-overview edge mask as ``[grid, hex_bits]`` for Panorama LOS.

    True 3D wall traces need BSP; this approximates blockers from overview edges so
    CT dropped-C4 radar pings do not freely cross corridors drawn as walls.
    """
    try:
        from PIL import Image

        from .radar.radar_map_assets import resolve_map_png_path
    except Exception:  # noqa: BLE001
        return None
    try:
        png = resolve_map_png_path(map_name)
        image = Image.open(png).convert("L")
    except Exception:  # noqa: BLE001
        return None

    width, height = image.size
    if width < 8 or height < 8 or grid < 8:
        return None
    pixels = image.load()
    edge = [[0] * width for _ in range(height)]
    for y in range(1, height - 1):
        for x in range(1, width - 1):
            grad = abs(int(pixels[x + 1, y]) - int(pixels[x - 1, y])) + abs(
                int(pixels[x, y + 1]) - int(pixels[x, y - 1])
            )
            if grad >= 40:
                edge[y][x] = 1
    # 1px dilate so thin wall strokes survive downsampling.
    dilated = [[0] * width for _ in range(height)]
    for y in range(1, height - 1):
        for x in range(1, width - 1):
            if (
                edge[y][x]
                or edge[y - 1][x]
                or edge[y + 1][x]
                or edge[y][x - 1]
                or edge[y][x + 1]
            ):
                dilated[y][x] = 1

    cell_w = width / float(grid)
    cell_h = height / float(grid)
    bits = bytearray((grid * grid + 7) // 8)
    for gy in range(grid):
        y0 = int(gy * cell_h)
        y1 = max(y0 + 1, int((gy + 1) * cell_h))
        for gx in range(grid):
            x0 = int(gx * cell_w)
            x1 = max(x0 + 1, int((gx + 1) * cell_w))
            hit = 0
            total = 0
            y = y0
            while y < y1:
                x = x0
                while x < x1:
                    total += 1
                    if dilated[y][x]:
                        hit += 1
                    x += 2
                y += 2
            if total and (hit / total) >= 0.08:
                index = gy * grid + gx
                bits[index >> 3] |= 1 << (7 - (index & 7))
    return [int(grid), bits.hex()]


def _build_flash_blind_payload(
    parser: Any,
    roster_by_xuid: Mapping[int, tuple[int, int]],
) -> tuple[list[Any], dict[str, Any]]:
    """Compact ``player_blind`` intervals for POV flash wash + tinnitus cues.

    Demo has no separate tinnitus timeline; CS2 tinnitus tracks flash blindness.
    ``player_blind.blind_duration`` (seconds) is the authoritative window.
    """
    try:
        rows = parser.parse_event("player_blind")
    except Exception as exc:  # noqa: BLE001
        raise DemoVoiceHudError(f"could not parse player_blind for flash track: {exc}") from exc
    if not isinstance(rows, Mapping):
        raise DemoVoiceHudError("demoparser returned unsupported player_blind rows")

    ticks = rows.get("tick")
    victims = rows.get("user_steamid")
    durations = rows.get("blind_duration")
    if not isinstance(ticks, list) or not isinstance(victims, list) or not isinstance(durations, list):
        raise DemoVoiceHudError("player_blind rows are missing tick/victim/duration fields")

    tick_rate = _infer_demo_tick_rate(parser)

    xuid_table: list[str] = []
    xuid_index: dict[int, int] = {}
    events: list[tuple[int, int, int]] = []
    count = min(len(ticks), len(victims), len(durations))
    for i in range(count):
        tick = _as_int(ticks[i])
        victim = _as_positive_int(victims[i])
        try:
            seconds = float(durations[i])
        except (TypeError, ValueError):
            continue
        if tick is None or tick < 0 or victim is None or victim not in roster_by_xuid:
            continue
        if seconds <= 0.05:
            continue
        duration_ticks = max(1, int(round(seconds * tick_rate)))
        if victim not in xuid_index:
            xuid_index[victim] = len(xuid_table)
            xuid_table.append(str(victim))
        events.append((tick, duration_ticks, xuid_index[victim]))

    events.sort(key=lambda item: item[0])
    if not events:
        raise DemoVoiceHudError("demo contains no usable player_blind flash events")

    payload = [xuid_table, _encode_flash_blind_events(events)]
    return payload, {
        "flash_blind_events": len(events),
        "flash_blind_parse_failed": 0,
    }


def _demo_tick_bounds(parser: Any) -> tuple[int, int]:
    """Best-effort inclusive tick window for radar sampling."""
    candidates: list[int] = []
    for event_name in ("round_start", "round_freeze_end", "round_end", "round_officially_ended"):
        try:
            rows = parser.parse_event(event_name)
        except Exception:  # noqa: BLE001 - optional bounds probe
            continue
        ticks = rows.get("tick") if isinstance(rows, Mapping) else None
        if not isinstance(ticks, list):
            continue
        for raw in ticks:
            tick = _as_int(raw)
            if tick is not None and tick >= 0:
                candidates.append(tick)
    if len(candidates) >= 2:
        return min(candidates), max(candidates)
    if candidates:
        only = candidates[0]
        return only, only + 64 * 60
    raise DemoVoiceHudError("demo contains no round events for radar tick bounds")


def _encode_radar_samples(
    samples: list[tuple[int, int, int, int]],
) -> str:
    """Delta-encode ``(x, y, yaw_deg, flags)`` samples as base36 zigzag.

    ``flags`` bit0 = alive, bit1 = carrying C4,
    bit2 = spotted by any T (team 2), bit3 = spotted by any CT (team 3),
    bit4 = current side is CT (team 3); clear means T (team 2). Tracks half swaps.
    """
    if not samples:
        return ""
    previous_x = previous_y = previous_yaw = 0
    encoded: list[str] = []
    for x, y, yaw, flags in samples:
        dx = _zigzag_encode(x - previous_x)
        dy = _zigzag_encode(y - previous_y)
        dyaw = _zigzag_encode(yaw - previous_yaw)
        encoded.append(
            f"{_base36(dx)}.{_base36(dy)}.{_base36(dyaw)}.{_base36(int(flags) & 0xFF)}"
        )
        previous_x, previous_y, previous_yaw = x, y, yaw
    return ",".join(encoded)


def _build_radar_payload(
    parser: Any,
    roster_by_xuid: Mapping[int, tuple[int, int]],
    *,
    sample_hz: int = RADAR_SAMPLE_HZ,
) -> tuple[list[Any], dict[str, Any]]:
    """Extract an 8Hz XUID-bound radar track for Panorama interpolation."""
    try:
        header = parser.parse_header()
    except Exception as exc:  # noqa: BLE001
        raise DemoVoiceHudError(f"could not parse demo header for radar: {exc}") from exc
    if not isinstance(header, Mapping):
        raise DemoVoiceHudError("demoparser returned unsupported demo header")
    map_name = _normalize_map_name(header.get("map_name"))
    if not map_name or map_name == "unknown":
        raise DemoVoiceHudError("demo header is missing map_name for radar")

    from .radar.radar_map_assets import lookup_map_data

    try:
        transform = lookup_map_data(map_name)
    except KeyError as exc:
        raise DemoVoiceHudError(f"no bundled radar transform for map {map_name}") from exc

    try:
        pos_x = float(transform["pos_x"])
        pos_y = float(transform["pos_y"])
        scale = float(transform["scale"])
    except (KeyError, TypeError, ValueError) as exc:
        raise DemoVoiceHudError(f"radar transform for {map_name} is incomplete") from exc
    if scale == 0:
        raise DemoVoiceHudError(f"radar transform scale for {map_name} is zero")

    raw_tick_rate = header.get("tick_rate") or header.get("tickrate") or 64
    try:
        tick_rate = float(raw_tick_rate)
    except (TypeError, ValueError):
        tick_rate = 64.0
    if tick_rate <= 0:
        tick_rate = 64.0
    hz = max(1, int(sample_hz))
    stride = max(1, int(round(tick_rate / hz)))

    start_tick, end_tick = _demo_tick_bounds(parser)
    if end_tick < start_tick:
        start_tick, end_tick = end_tick, start_tick
    sample_ticks = list(range(start_tick, end_tick + 1, stride))
    if not sample_ticks:
        raise DemoVoiceHudError("radar sample tick list is empty")

    field_sets = [
        [
            "X",
            "Y",
            "yaw",
            "steamid",
            "team_num",
            "is_alive",
            "player_color",
            "has_c4",
            "inventory",
            "spotted",
            "approximate_spotted_by",
        ],
        [
            "X",
            "Y",
            "yaw",
            "steamid",
            "team_num",
            "is_alive",
            "player_color",
            "inventory",
            "spotted",
            "approximate_spotted_by",
        ],
        ["X", "Y", "yaw", "steamid", "team_num", "is_alive", "player_color", "has_c4", "inventory"],
        ["X", "Y", "yaw", "steamid", "team_num", "is_alive", "player_color", "inventory"],
    ]
    rows = None
    last_exc: Exception | None = None
    for fields in field_sets:
        try:
            rows = parser.parse_ticks(fields, ticks=sample_ticks)
            break
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            rows = None
    if rows is None:
        raise DemoVoiceHudError(f"could not parse radar player ticks: {last_exc}")
    if not isinstance(rows, Mapping):
        raise DemoVoiceHudError("demoparser returned unsupported radar tick table")

    ticks = rows.get("tick", [])
    xuids = rows.get("steamid", [])
    xs = rows.get("X", [])
    ys = rows.get("Y", [])
    yaws = rows.get("yaw", [])
    alives = rows.get("is_alive", [])
    colors = rows.get("player_color", [])
    teams = rows.get("team_num", [])
    c4s = rows.get("has_c4", [])
    inventories = rows.get("inventory", [])
    spotteds = rows.get("spotted", [])
    spotted_by = rows.get("approximate_spotted_by", [])
    column_lengths = [len(col) for col in (ticks, xuids, xs, ys, yaws) if isinstance(col, list)]
    if not column_lengths or len(set(column_lengths)) != 1:
        raise DemoVoiceHudError("radar tick columns are missing or misaligned")
    row_count = column_lengths[0]

    def _inventory_has_c4(raw: Any) -> bool:
        if raw is None:
            return False
        if isinstance(raw, (list, tuple, set)):
            return any("c4" in str(item).lower() for item in raw)
        text = str(raw).lower()
        return "c4" in text

    def _spotted_team_bits(
        raw_by: Any,
        raw_spotted: Any,
        target_team: int | None,
    ) -> int:
        """Return the live T/CT side that currently has contact on this target.

        ``parse_player_info`` is commonly an end-of-demo team snapshot, so using
        the spotter's roster team reverses these bits before/after a half swap.
        The target row's ``team_num`` is live at this tick, and a spotted player
        can only be enemy radar intel for the opposite playing side. This keeps
        the result correct when Panorama switches POV between any T/CT player.
        """
        has_spotter = False
        if isinstance(raw_by, (list, tuple, set)):
            has_spotter = len(raw_by) > 0
        elif raw_by is not None:
            text = str(raw_by).strip()
            has_spotter = bool(text and text not in ("[]", "None"))
        if not has_spotter and not bool(raw_spotted):
            return 0
        if target_team == 2:
            return 8  # T target is visible to CT.
        if target_team == 3:
            return 4  # CT target is visible to T.
        return 0

    samples_by_xuid: dict[int, dict[int, tuple[int, int, int, int]]] = defaultdict(dict)
    color_by_xuid: dict[int, int] = {}
    for index in range(row_count):
        xuid = _as_positive_int(xuids[index] if index < len(xuids) else None)
        tick = _as_int(ticks[index] if index < len(ticks) else None)
        if xuid is None or tick is None or xuid not in roster_by_xuid:
            continue
        team = _as_int(teams[index] if isinstance(teams, list) and index < len(teams) else None)
        if team not in (2, 3):
            continue
        try:
            x = int(round(float(xs[index])))
            y = int(round(float(ys[index])))
            yaw = int(round(float(yaws[index]))) % 360
        except (TypeError, ValueError, OverflowError):
            continue
        alive_raw = alives[index] if isinstance(alives, list) and index < len(alives) else True
        if isinstance(c4s, list) and index < len(c4s) and c4s[index] is not None:
            has_c4 = bool(c4s[index])
        elif isinstance(inventories, list) and index < len(inventories):
            has_c4 = _inventory_has_c4(inventories[index])
        else:
            has_c4 = False
        raw_spotted_by = (
            spotted_by[index]
            if isinstance(spotted_by, list) and index < len(spotted_by)
            else None
        )
        raw_spotted = (
            spotteds[index]
            if isinstance(spotteds, list) and index < len(spotteds)
            else False
        )
        spotted_bits = _spotted_team_bits(raw_spotted_by, raw_spotted, team)
        flags = (
            (1 if bool(alive_raw) else 0)
            | (2 if has_c4 else 0)
            | spotted_bits
            | (16 if team == 3 else 0)
        )
        samples_by_xuid[xuid][tick] = (x, y, yaw, flags)
        if xuid not in color_by_xuid and isinstance(colors, list) and index < len(colors):
            color_by_xuid[xuid] = _player_color_slot(colors[index])
        elif (
            isinstance(colors, list)
            and index < len(colors)
            and color_by_xuid.get(xuid, -1) < 0
        ):
            slot = _player_color_slot(colors[index])
            if slot >= 0:
                color_by_xuid[xuid] = slot

    # 8Hz position samples miss brief spotted pulses. OR spotter bits from a denser
    # probe onto the enclosing sample tick so radar red dots match live contact.
    probe_stride = max(1, stride // 4)
    probe_ticks = list(range(start_tick, end_tick + 1, probe_stride))
    if probe_ticks and probe_stride < stride:
        try:
            spot_rows = parser.parse_ticks(
                ["steamid", "team_num", "spotted", "approximate_spotted_by"],
                ticks=probe_ticks,
            )
        except Exception:  # noqa: BLE001
            spot_rows = None
        if isinstance(spot_rows, Mapping):
            spot_ticks = spot_rows.get("tick", [])
            spot_xuids = spot_rows.get("steamid", [])
            spot_teams = spot_rows.get("team_num", [])
            spot_flags = spot_rows.get("spotted", [])
            spot_by = spot_rows.get("approximate_spotted_by", [])
            if isinstance(spot_ticks, list) and isinstance(spot_xuids, list):
                sample_set = set(sample_ticks)

                def _snap_sample_tick(raw_tick: int) -> int | None:
                    # Map probe tick onto the sample grid (ceil to next sample).
                    snapped = start_tick + ((raw_tick - start_tick + stride - 1) // stride) * stride
                    if snapped in sample_set:
                        return snapped
                    # Fallback: nearest lower sample.
                    snapped = start_tick + ((raw_tick - start_tick) // stride) * stride
                    return snapped if snapped in sample_set else None

                for index, raw_tick in enumerate(spot_ticks):
                    tick = _as_int(raw_tick)
                    xuid = _as_positive_int(spot_xuids[index] if index < len(spot_xuids) else None)
                    if tick is None or xuid is None or xuid not in samples_by_xuid:
                        continue
                    sample_tick = _snap_sample_tick(tick)
                    if sample_tick is None or sample_tick not in samples_by_xuid[xuid]:
                        continue
                    target_team = _as_int(
                        spot_teams[index]
                        if isinstance(spot_teams, list) and index < len(spot_teams)
                        else None
                    )
                    if target_team not in (2, 3):
                        # The aligned 8Hz sample still carries the live side bit.
                        current_flags = samples_by_xuid[xuid][sample_tick][3]
                        target_team = 3 if current_flags & 16 else 2
                    raw_spotted_by = (
                        spot_by[index]
                        if isinstance(spot_by, list) and index < len(spot_by)
                        else None
                    )
                    raw_spotted = (
                        spot_flags[index]
                        if isinstance(spot_flags, list) and index < len(spot_flags)
                        else False
                    )
                    bits = _spotted_team_bits(raw_spotted_by, raw_spotted, target_team)
                    if bits == 0:
                        continue
                    x, y, yaw, flags = samples_by_xuid[xuid][sample_tick]
                    samples_by_xuid[xuid][sample_tick] = (x, y, yaw, flags | bits)

    encoded_players: list[list[Any]] = []
    sample_count = 0
    for xuid in sorted(samples_by_xuid):
        by_tick = samples_by_xuid[xuid]
        aligned_start = next((tick for tick in sample_ticks if tick in by_tick), None)
        if aligned_start is None:
            continue
        window: list[tuple[int, int, int, int]] = []
        last: tuple[int, int, int, int] | None = None
        for tick in sample_ticks:
            if tick < aligned_start:
                continue
            sample = by_tick.get(tick, last)
            if sample is None:
                continue
            window.append(sample)
            last = sample
        encoded = _encode_radar_samples(window)
        if not encoded:
            continue
        encoded_players.append(
            [
                str(xuid),
                int(color_by_xuid.get(xuid, -1)),
                _base36(aligned_start),
                encoded,
            ]
        )
        sample_count += len(window)

    if not encoded_players:
        raise DemoVoiceHudError("demo contains no roster-bound radar samples")

    planted_bombs = _build_planted_bomb_track(parser, roster_by_xuid)
    dropped_bombs = _build_dropped_bomb_track(parser, roster_by_xuid)
    player_sounds = _build_player_sound_track(parser, roster_by_xuid)
    occlusion = _build_radar_occlusion_mask(map_name)

    radar = [
        map_name,
        [int(round(pos_x)), int(round(pos_y)), int(round(scale * 1000))],
        stride,
        encoded_players,
        planted_bombs,
        player_sounds,
        dropped_bombs,
        occlusion,
    ]
    stats = {
        "radar_players": len(encoded_players),
        "radar_dropped_bombs": len(dropped_bombs),
        "radar_samples": sample_count,
        "radar_parse_failed": 0,
        "radar_map": map_name,
        "radar_planted_bombs": len(planted_bombs),
        "radar_player_sounds": len(player_sounds[1].split(",")) if player_sounds and player_sounds[1] else 0,
        "radar_occlusion_grid": int(occlusion[0]) if occlusion else 0,
    }
    return radar, stats


def _normalize_weapon_name(weapon: Any) -> str:
    text = str(weapon or "").strip().lower()
    if not text:
        return ""
    if not text.startswith("weapon_"):
        text = f"weapon_{text}"
    return text


def _is_util_weapon_name(weapon: Any) -> bool:
    text = _normalize_weapon_name(weapon)
    if not text:
        return False
    return any(
        token in text
        for token in (
            "flashbang",
            "hegrenade",
            "smokegrenade",
            "molotov",
            "incgrenade",
            "decoy",
        )
    )


def _is_gun_weapon_name(weapon: Any) -> bool:
    text = _normalize_weapon_name(weapon)
    if not text:
        return False
    blocked = (
        "knife",
        "bayonet",
        "taser",
        "flashbang",
        "hegrenade",
        "smokegrenade",
        "molotov",
        "incgrenade",
        "decoy",
        "c4",
    )
    return not any(token in text for token in blocked)


def _weapon_fire_sound_radius(weapon: Any, silenced: Any) -> int | None:
    """Stock-ish audible radius for radar rings synthesized from ``weapon_fire``.

    Utility throws also get a thin ring (native bounce mid-radii are filtered from
    ``player_sound``; synthesize the throw itself from ``weapon_fire``).
    """
    if _is_util_weapon_name(weapon):
        # Throw pull/release — thinner/shorter than gunfire, not landing-loud.
        return 700
    if not _is_gun_weapon_name(weapon):
        return None
    text = _normalize_weapon_name(weapon).replace("weapon_", "")
    if bool(silenced) or "silencer" in text:
        return 800
    if text in ("awp", "ssg08", "g3sg1", "scar20", "negev", "m249"):
        return 1400
    return 1100


def _player_sound_flags(
    *,
    is_step: bool,
    radius: int,
    kind: str = "auto",
) -> int:
    """bit0 = footstep, bit1 = loud visual (``.player-sound-max`` / thick border).

    Native hudradar.css: default ``.PlayerSound`` is a thin 1px ring; landing uses
    ``.player-sound-max`` (3px flash). Jump impulses are tiny non-step radii (~98)
    and stay thin. Gunfire is also a thin ring — only landing-like loud movement
    (non-step radius >= 1000) gets the thick flash. Mid radii (~500–999) are
    utility / bounce noise and are filtered out before flags are applied.
    """
    flags = 1 if is_step else 0
    if kind == "weapon":
        return flags
    if kind == "loud" or (kind == "auto" and (not is_step) and radius >= 1000):
        flags |= 2
    return flags


def _build_player_sound_track(
    parser: Any,
    roster_by_xuid: Mapping[int, tuple[int, int]],
) -> list[Any]:
    """Compact ``player_sound`` (+ synthesized gunfire) events for radar rings.

    Returns ``[xuid_table, "dt.xi.radius.durMs.flags,..."]`` where ``xi`` indexes
    ``xuid_table`` and ``flags`` is ``bit0=step, bit1=loudMax``. Missing demos
    yield ``[[], ""]``.
    """
    events: list[tuple[int, int, int, int, int]] = []

    # Equip/buy/pickup clicks show up as non-step ~1100 ``player_sound`` rows but
    # are not audible movement/gun cues on the live radar — suppress those.
    equip_ticks: set[tuple[int, int]] = set()
    for event_name, silent_key in (
        ("item_pickup", "silent"),
        ("item_purchase", None),
    ):
        try:
            rows = parser.parse_event(event_name)
        except Exception:  # noqa: BLE001
            continue
        if not isinstance(rows, Mapping):
            continue
        ticks = rows.get("tick", [])
        xuids = rows.get("user_steamid", rows.get("steamid", []))
        silent = rows.get(silent_key, []) if silent_key else None
        if not isinstance(ticks, list):
            continue
        for index, raw_tick in enumerate(ticks):
            tick = _as_int(raw_tick)
            xuid = None
            if isinstance(xuids, list) and index < len(xuids):
                xuid = _as_positive_int(xuids[index])
            if tick is None or xuid is None or xuid not in roster_by_xuid:
                continue
            if isinstance(silent, list) and index < len(silent) and bool(silent[index]):
                continue
            for delta in range(-8, 9):
                equip_ticks.add((tick + delta, xuid))

    def _near_equip_sound(tick: int, xuid: int) -> bool:
        return (tick, xuid) in equip_ticks

    try:
        rows = parser.parse_event("player_sound")
    except Exception:  # noqa: BLE001
        rows = None
    if isinstance(rows, Mapping):
        ticks = rows.get("tick", [])
        xuids = rows.get("user_steamid", [])
        radii = rows.get("radius", [])
        durations = rows.get("duration", [])
        steps = rows.get("step", [])
        if isinstance(ticks, list):
            for index, raw_tick in enumerate(ticks):
                tick = _as_int(raw_tick)
                xuid = None
                if isinstance(xuids, list) and index < len(xuids):
                    xuid = _as_positive_int(xuids[index])
                if tick is None or tick < 0 or xuid is None or xuid not in roster_by_xuid:
                    continue
                try:
                    radius = (
                        int(round(float(radii[index])))
                        if isinstance(radii, list) and index < len(radii)
                        else 0
                    )
                except (TypeError, ValueError, OverflowError):
                    radius = 0
                if radius <= 0:
                    continue
                is_step = bool(steps[index]) if isinstance(steps, list) and index < len(steps) else False
                # Mid non-step (~597) is sniper scope-open on CS2 demos; keep that
                # band. Other mid radii are util bounce / land-on-you noise.
                is_scope = (not is_step) and 580 <= radius <= 620
                if (not is_step) and 200 <= radius < 1000 and not is_scope:
                    continue
                # Buy/equip/pickup clicks masquerade as non-step ~1100 sounds.
                if (not is_step) and radius >= 1000 and _near_equip_sound(tick, xuid):
                    continue
                try:
                    duration = (
                        float(durations[index])
                        if isinstance(durations, list) and index < len(durations)
                        else 0.1
                    )
                except (TypeError, ValueError, OverflowError):
                    duration = 0.1
                duration_ms = max(50, int(round(duration * 1000)))
                # Scope click is ~100ms in the demo; stretch so the ring is visible.
                if is_scope and duration_ms < 280:
                    duration_ms = 280
                flags = _player_sound_flags(is_step=is_step, radius=radius)
                if (flags & 2) != 0 and duration_ms < 400:
                    duration_ms = 400
                events.append((tick, xuid, radius, duration_ms, flags))

    # GOTV ``player_sound`` almost never records gunshots; synthesize from weapon_fire.
    existing_loud: set[tuple[int, int]] = {
        (tick, xuid)
        for tick, xuid, _radius, _dur, flags in events
        if (flags & 2) != 0
    }
    try:
        fires = parser.parse_event("weapon_fire")
    except Exception:  # noqa: BLE001
        fires = None
    if isinstance(fires, Mapping):
        ticks = fires.get("tick", [])
        xuids = fires.get("user_steamid", [])
        weapons = fires.get("weapon", [])
        silenced = fires.get("silenced", [])
        if isinstance(ticks, list):
            for index, raw_tick in enumerate(ticks):
                tick = _as_int(raw_tick)
                xuid = None
                if isinstance(xuids, list) and index < len(xuids):
                    xuid = _as_positive_int(xuids[index])
                if tick is None or tick < 0 or xuid is None or xuid not in roster_by_xuid:
                    continue
                weapon = weapons[index] if isinstance(weapons, list) and index < len(weapons) else ""
                sil = silenced[index] if isinstance(silenced, list) and index < len(silenced) else False
                radius = _weapon_fire_sound_radius(weapon, sil)
                if radius is None:
                    continue
                is_util = _is_util_weapon_name(weapon)
                # Gunfire dedupes against existing loud cues; util throws are thin
                # rings and should still show next to footsteps / landings.
                if (not is_util) and any(
                    (tick + delta, xuid) in existing_loud for delta in range(-2, 3)
                ):
                    continue
                flags = _player_sound_flags(is_step=False, radius=radius, kind="weapon")
                duration_ms = 160 if is_util else 100
                events.append((tick, xuid, radius, duration_ms, flags))
                if not is_util:
                    existing_loud.add((tick, xuid))

    if not events:
        return [[], ""]

    # Same-tick: keep loud cues after footsteps so the active ring prefers gun/land.
    events.sort(key=lambda item: (item[0], item[1], 0 if (item[4] & 2) == 0 else 1))
    xuid_table: list[str] = []
    xuid_index: dict[int, int] = {}
    encoded: list[str] = []
    previous_tick = 0
    for tick, xuid, radius, duration_ms, flags in events:
        if xuid not in xuid_index:
            xuid_index[xuid] = len(xuid_table)
            xuid_table.append(str(xuid))
        dt = tick - previous_tick
        if dt < 0:
            dt = 0
        previous_tick = tick
        encoded.append(
            f"{_base36(dt)}.{_base36(xuid_index[xuid])}.{_base36(radius)}"
            f".{_base36(duration_ms)}.{_base36(int(flags) & 0xFF)}"
        )
    return [xuid_table, ",".join(encoded)]


def _event_ticks_and_xuids(parser: Any, event_name: str) -> list[tuple[int, int | None]]:
    try:
        rows = parser.parse_event(event_name)
    except Exception:  # noqa: BLE001
        return []
    if not isinstance(rows, Mapping):
        return []
    ticks = rows.get("tick", [])
    xuids = rows.get("user_steamid", [])
    if not isinstance(ticks, list):
        return []
    out: list[tuple[int, int | None]] = []
    for index, raw_tick in enumerate(ticks):
        tick = _as_int(raw_tick)
        if tick is None or tick < 0:
            continue
        xuid = None
        if isinstance(xuids, list) and index < len(xuids):
            xuid = _as_positive_int(xuids[index])
        out.append((tick, xuid))
    return out


def _build_planted_bomb_track(
    parser: Any,
    roster_by_xuid: Mapping[int, tuple[int, int]],
) -> list[list[int]]:
    """Return ``[startTick, endTick, x, y]`` rows using planter position at plant tick."""
    plants = _event_ticks_and_xuids(parser, "bomb_planted")
    if not plants:
        return []
    end_ticks = sorted(
        tick
        for tick, _xuid in (
            _event_ticks_and_xuids(parser, "bomb_defused")
            + _event_ticks_and_xuids(parser, "bomb_exploded")
            + _event_ticks_and_xuids(parser, "round_end")
            + _event_ticks_and_xuids(parser, "round_officially_ended")
        )
    )
    plant_ticks = [tick for tick, _xuid in plants]
    try:
        rows = parser.parse_ticks(["X", "Y", "steamid"], ticks=plant_ticks)
    except Exception:  # noqa: BLE001
        return []
    if not isinstance(rows, Mapping):
        return []
    ticks = rows.get("tick", [])
    xuids = rows.get("steamid", [])
    xs = rows.get("X", [])
    ys = rows.get("Y", [])
    if not all(isinstance(col, list) for col in (ticks, xuids, xs, ys)):
        return []

    pos_by_key: dict[tuple[int, int], tuple[int, int]] = {}
    for index, raw_tick in enumerate(ticks):
        tick = _as_int(raw_tick)
        xuid = _as_positive_int(xuids[index] if index < len(xuids) else None)
        if tick is None or xuid is None:
            continue
        try:
            x = int(round(float(xs[index])))
            y = int(round(float(ys[index])))
        except (TypeError, ValueError, OverflowError):
            continue
        pos_by_key[(tick, xuid)] = (x, y)

    planted: list[list[int]] = []
    for plant_tick, planter_xuid in plants:
        pos = None
        if planter_xuid is not None:
            pos = pos_by_key.get((plant_tick, planter_xuid))
        if pos is None:
            # Fall back to any roster player sampled on that tick.
            for (tick, xuid), sample in pos_by_key.items():
                if tick == plant_tick and xuid in roster_by_xuid:
                    pos = sample
                    break
        if pos is None:
            continue
        end_tick = plant_tick + 64 * 40
        for candidate in end_ticks:
            if candidate > plant_tick:
                end_tick = candidate
                break
        planted.append([plant_tick, end_tick, pos[0], pos[1]])
    return planted


def _build_dropped_bomb_track(
    parser: Any,
    roster_by_xuid: Mapping[int, tuple[int, int]],
) -> list[list[int]]:
    """Return ``[startTick, endTick, x, y]`` for ground C4 between drop and pickup/plant.

    ``endTick`` is inclusive but ends on the tick *before* pickup/plant/next-drop
    so the carrier's C4 pip and the ground marker never overlap.
    """
    drops = _event_ticks_and_xuids(parser, "bomb_dropped")
    if not drops:
        return []
    end_events = sorted(
        {
            tick
            for tick, _xuid in (
                _event_ticks_and_xuids(parser, "bomb_pickup")
                + _event_ticks_and_xuids(parser, "bomb_planted")
                + _event_ticks_and_xuids(parser, "round_end")
                + _event_ticks_and_xuids(parser, "round_officially_ended")
            )
            if tick and tick > 0
        }
    )
    drop_ticks = [tick for tick, _xuid in drops]
    try:
        rows = parser.parse_ticks(["X", "Y", "steamid"], ticks=drop_ticks)
    except Exception:  # noqa: BLE001
        return []
    if not isinstance(rows, Mapping):
        return []
    ticks = rows.get("tick", [])
    xuids = rows.get("steamid", [])
    xs = rows.get("X", [])
    ys = rows.get("Y", [])
    if not all(isinstance(col, list) for col in (ticks, xuids, xs, ys)):
        return []

    pos_by_key: dict[tuple[int, int], tuple[int, int]] = {}
    for index, raw_tick in enumerate(ticks):
        tick = _as_int(raw_tick)
        xuid = _as_positive_int(xuids[index] if index < len(xuids) else None)
        if tick is None or xuid is None:
            continue
        try:
            x = int(round(float(xs[index])))
            y = int(round(float(ys[index])))
        except (TypeError, ValueError, OverflowError):
            continue
        pos_by_key[(tick, xuid)] = (x, y)

    dropped: list[list[int]] = []
    for index, (drop_tick, dropper_xuid) in enumerate(drops):
        pos = None
        if dropper_xuid is not None:
            pos = pos_by_key.get((drop_tick, dropper_xuid))
        if pos is None:
            for (tick, xuid), sample in pos_by_key.items():
                if tick == drop_tick and xuid in roster_by_xuid:
                    pos = sample
                    break
        if pos is None:
            continue
        candidates = [tick for tick in end_events if tick > drop_tick]
        # Only one C4 exists — a later drop means the prior ground pack ended.
        if index + 1 < len(drops):
            next_drop = drops[index + 1][0]
            if next_drop > drop_tick:
                candidates.append(next_drop)
        if candidates:
            # Exclusive at the ending event so pickup tick only shows the carrier pip.
            end_tick = min(candidates) - 1
        else:
            end_tick = drop_tick + 64 * 40
        if end_tick < drop_tick:
            continue
        dropped.append([drop_tick, end_tick, pos[0], pos[1]])
    return dropped


def _build_team_roster_from_tick_fallback(
    parser: Any,
    demo_path: str | Path,
) -> tuple[list[list[Any]], dict[int, tuple[int, int]]]:
    """Reuse the analyzer's event/tick roster when player metadata is unavailable."""
    try:
        from .features.demo_analysis.player_roster import get_player_list

        players = get_player_list(demo_path, parser=parser)
    except Exception as exc:  # noqa: BLE001 - native parser errors are contextualized
        raise DemoVoiceHudError(f"could not recover demo player teams from ticks: {exc}") from exc

    roster: list[list[Any]] = []
    by_xuid: dict[int, tuple[int, int]] = {}
    for player in players:
        if not isinstance(player, Mapping):
            continue
        xuid = _as_positive_int(
            player.get("steam_id64") or player.get("steam_id") or player.get("xuid")
        )
        try:
            team = int(player.get("team") or player.get("team_num"))
        except (TypeError, ValueError, OverflowError):
            continue
        if xuid is None or team not in (2, 3):
            continue
        if xuid in by_xuid:
            raise DemoVoiceHudError(f"tick fallback repeats Steam ID {xuid}")
        # The payload binds all dynamic tracks by XUID. Keep a compact parser
        # slot only for the legacy runtime-slot fallback when the game API does
        # not expose the current POV XUID directly.
        slot = len(roster)
        by_xuid[xuid] = (slot, team)
        roster.append([str(xuid), slot, team])
    if not roster:
        raise DemoVoiceHudError("tick fallback contains no team-bound Steam IDs")
    return roster, by_xuid


def _build_team_roster(
    parser: Any,
    demo_path: str | Path,
) -> tuple[list[list[Any]], dict[int, tuple[int, int]]]:
    """Return compact ``[xuid, slot, team]`` rows keyed by exact Steam ID."""
    player_info_error: str | None = None
    try:
        player_info = parser.parse_player_info()
    except Exception as exc:  # noqa: BLE001 - native parser errors are contextualized
        player_info = None
        player_info_error = f"could not parse demo player teams: {exc}"
    if player_info is not None and not isinstance(player_info, Mapping):
        player_info_error = "demoparser returned unsupported player info"
        player_info = None

    player_xuids = player_info.get("steamid") if player_info is not None else None
    player_teams = player_info.get("team_number") if player_info is not None else None
    if player_info is not None and (
        not isinstance(player_xuids, list) or not isinstance(player_teams, list)
    ):
        player_info_error = "demo player info contains no Steam ID/team roster"
        player_xuids = None
        player_teams = None
    if (
        isinstance(player_xuids, list)
        and isinstance(player_teams, list)
        and len(player_xuids) != len(player_teams)
    ):
        player_info_error = "demo player info Steam ID/team columns are misaligned"
        player_xuids = None
        player_teams = None

    roster: list[list[Any]] = []
    by_xuid: dict[int, tuple[int, int]] = {}
    for slot, (raw_xuid, raw_team) in enumerate(zip(player_xuids or [], player_teams or [])):
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
    if roster:
        return roster, by_xuid

    if player_info_error is None:
        player_info_error = "demo player info contains no team-bound Steam IDs"
    try:
        return _build_team_roster_from_tick_fallback(parser, demo_path)
    except DemoVoiceHudError as exc:
        raise DemoVoiceHudError(f"{player_info_error}; {exc}") from exc


def _parse_demo_voice_rows(
    demo_path: str | Path,
    *,
    parser_factory: Callable[[str], Any] | None = None,
) -> tuple[Any, list[Any]]:
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
    return parser, voice_rows


def demo_has_voice_packets(
    demo_path: str | Path,
    *,
    parser_factory: Callable[[str], Any] | None = None,
) -> bool:
    """Return whether the demo contains at least one non-empty voice packet.

    This intentionally does not require roster resolution: recording only needs
    to know whether voice cvars are useful at all.  Parse failures remain errors
    so callers can preserve the existing fail-closed voice policy.
    """
    _parser, voice_rows = _parse_demo_voice_rows(
        demo_path,
        parser_factory=parser_factory,
    )
    return any(
        isinstance(row, Mapping)
        and isinstance(row.get("bytes"), (bytes, bytearray))
        and bool(row.get("bytes"))
        for row in voice_rows
    )


def build_voice_payload(
    demo_path: str | Path,
    *,
    parser_factory: Callable[[str], Any] | None = None,
) -> tuple[bytes, dict[str, int]]:
    """Extract and compact the voice packet/location timeline for Panorama."""
    parser, voice_rows = _parse_demo_voice_rows(
        demo_path,
        parser_factory=parser_factory,
    )
    raw_voice_packets = sum(
        1
        for row in voice_rows
        if isinstance(row, Mapping)
        and isinstance(row.get("bytes"), (bytes, bytearray))
        and bool(row.get("bytes"))
    )

    encoded_roster, roster_by_xuid = _build_team_roster(parser, demo_path)

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
        # GOTV / stripped demos may have no svc_VoiceData. Keep a roster-only
        # payload so radar and kill-feedback tracks can still attach.
        payload = json.dumps(
            [[""], [], [], encoded_roster],
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("ascii")
        return payload, {
            # Keep raw packet presence even when no speaker can be mapped into
            # the roster.  Recording must not mistake an identity mismatch for
            # a genuinely silent demo and disable voice isolation.
            "voice_packets": raw_voice_packets,
            "speakers": 0,
            "intervals": 0,
            "location_changes": 0,
            "payload_bytes": len(payload),
            "location_parse_failed": 0,
        }
    voice_packets = raw_voice_packets

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
    packed = _pad_payload_slots(packed)

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


def add_radar_track_to_payload(
    voice_payload: bytes,
    demo_path: str | Path,
    *,
    parser_factory: Callable[[str], Any] | None = None,
    sample_hz: int = RADAR_SAMPLE_HZ,
) -> tuple[bytes, dict[str, Any]]:
    """Append the XUID-bound radar track at payload index 8."""
    try:
        packed = json.loads(voice_payload.decode("ascii"))
    except (UnicodeDecodeError, ValueError, TypeError) as exc:
        raise DemoVoiceHudError("voice HUD payload is not valid compact JSON") from exc
    packed = _pad_payload_slots(packed)

    encoded_roster = packed[3]
    if not isinstance(encoded_roster, list):
        raise DemoVoiceHudError("voice HUD payload contains no player roster")
    roster_by_xuid: dict[int, tuple[int, int]] = {}
    for row in encoded_roster:
        if not isinstance(row, list) or len(row) != 3:
            continue
        xuid = _as_positive_int(row[0])
        slot = _as_int(row[1])
        team = _as_int(row[2])
        if xuid is None or slot is None or team not in (2, 3):
            continue
        roster_by_xuid[xuid] = (slot, team)
    if not roster_by_xuid:
        raise DemoVoiceHudError("voice HUD payload contains no team-bound Steam IDs")

    if parser_factory is None:
        from demoparser2 import DemoParser

        parser_factory = DemoParser
    parser = parser_factory(str(demo_path))
    radar, stats = _build_radar_payload(
        parser,
        roster_by_xuid,
        sample_hz=sample_hz,
    )
    packed[RADAR_PAYLOAD_INDEX] = radar
    payload = json.dumps(packed, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    stats = dict(stats)
    stats["payload_bytes"] = len(payload)
    return payload, stats


def add_kill_feedback_track_to_payload(
    voice_payload: bytes,
    demo_path: str | Path,
    *,
    parser_factory: Callable[[str], Any] | None = None,
) -> tuple[bytes, dict[str, Any]]:
    """Append POV kill/HS feedback events at payload index 9."""
    try:
        packed = json.loads(voice_payload.decode("ascii"))
    except (UnicodeDecodeError, ValueError, TypeError) as exc:
        raise DemoVoiceHudError("voice HUD payload is not valid compact JSON") from exc
    packed = _pad_payload_slots(packed)

    encoded_roster = packed[3]
    if not isinstance(encoded_roster, list):
        raise DemoVoiceHudError("voice HUD payload contains no player roster")
    roster_by_xuid: dict[int, tuple[int, int]] = {}
    for row in encoded_roster:
        if not isinstance(row, list) or len(row) != 3:
            continue
        xuid = _as_positive_int(row[0])
        slot = _as_int(row[1])
        team = _as_int(row[2])
        if xuid is None or slot is None or team not in (2, 3):
            continue
        roster_by_xuid[xuid] = (slot, team)
    if not roster_by_xuid:
        raise DemoVoiceHudError("voice HUD payload contains no team-bound Steam IDs")

    if parser_factory is None:
        from demoparser2 import DemoParser

        parser_factory = DemoParser
    parser = parser_factory(str(demo_path))
    kill_feedback, stats = _build_kill_feedback_payload(parser, roster_by_xuid)
    packed[KILL_FEEDBACK_PAYLOAD_INDEX] = kill_feedback
    payload = json.dumps(packed, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    stats = dict(stats)
    stats["payload_bytes"] = len(payload)
    return payload, stats


def add_flash_blind_track_to_payload(
    voice_payload: bytes,
    demo_path: str | Path,
    *,
    parser_factory: Callable[[str], Any] | None = None,
) -> tuple[bytes, dict[str, Any]]:
    """Append POV flash-blind intervals at payload index 10."""
    try:
        packed = json.loads(voice_payload.decode("ascii"))
    except (UnicodeDecodeError, ValueError, TypeError) as exc:
        raise DemoVoiceHudError("voice HUD payload is not valid compact JSON") from exc
    packed = _pad_payload_slots(packed)

    encoded_roster = packed[3]
    if not isinstance(encoded_roster, list):
        raise DemoVoiceHudError("voice HUD payload contains no player roster")
    roster_by_xuid: dict[int, tuple[int, int]] = {}
    for row in encoded_roster:
        if not isinstance(row, list) or len(row) != 3:
            continue
        xuid = _as_positive_int(row[0])
        slot = _as_int(row[1])
        team = _as_int(row[2])
        if xuid is None or slot is None or team not in (2, 3):
            continue
        roster_by_xuid[xuid] = (slot, team)
    if not roster_by_xuid:
        raise DemoVoiceHudError("voice HUD payload contains no team-bound Steam IDs")

    if parser_factory is None:
        from demoparser2 import DemoParser

        parser_factory = DemoParser
    parser = parser_factory(str(demo_path))
    flash_blind, stats = _build_flash_blind_payload(parser, roster_by_xuid)
    packed[FLASH_BLIND_PAYLOAD_INDEX] = flash_blind
    payload = json.dumps(packed, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    stats = dict(stats)
    stats["payload_bytes"] = len(payload)
    return payload, stats


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
    voice_enabled: bool = True,
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

    radar_stats: dict[str, Any] = {
        "radar_players": 0,
        "radar_samples": 0,
        "radar_parse_failed": 0,
        "radar_map": "",
    }
    try:
        payload, radar_stats = add_radar_track_to_payload(
            payload,
            demo_path,
            parser_factory=parser_factory,
        )
        stats["payload_bytes"] = int(radar_stats.pop("payload_bytes", len(payload)))
    except DemoVoiceHudError:
        radar_stats = {
            "radar_players": 0,
            "radar_samples": 0,
            "radar_parse_failed": 1,
            "radar_map": "",
            "radar_planted_bombs": 0,
            "radar_dropped_bombs": 0,
            "radar_player_sounds": 0,
            "radar_occlusion_grid": 0,
        }

    kill_feedback_stats: dict[str, Any] = {
        "kill_feedback_events": 0,
        "kill_feedback_parse_failed": 0,
    }
    try:
        payload, kill_feedback_stats = add_kill_feedback_track_to_payload(
            payload,
            demo_path,
            parser_factory=parser_factory,
        )
        stats["payload_bytes"] = int(kill_feedback_stats.pop("payload_bytes", len(payload)))
    except DemoVoiceHudError:
        kill_feedback_stats = {
            "kill_feedback_events": 0,
            "kill_feedback_parse_failed": 1,
        }

    flash_blind_stats: dict[str, Any] = {
        "flash_blind_events": 0,
        "flash_blind_parse_failed": 0,
    }
    try:
        payload, flash_blind_stats = add_flash_blind_track_to_payload(
            payload,
            demo_path,
            parser_factory=parser_factory,
        )
        stats["payload_bytes"] = int(flash_blind_stats.pop("payload_bytes", len(payload)))
    except DemoVoiceHudError:
        flash_blind_stats = {
            "flash_blind_events": 0,
            "flash_blind_parse_failed": 1,
        }

    if not voice_enabled:
        # Keep roster, input, radar, kill-feedback, and flash tracks intact.
        # Only remove the precomputed speaking schedule that drives the custom
        # lower-left notice; native voice volume is muted by the warmup policy.
        packed = json.loads(payload.decode("ascii"))
        packed[0] = [""]
        packed[1] = []
        payload = json.dumps(
            packed,
            ensure_ascii=True,
            separators=(",", ":"),
        ).encode("ascii")
        stats.update(
            voice_packets=0,
            speakers=0,
            intervals=0,
            location_changes=0,
            payload_bytes=len(payload),
            location_parse_failed=0,
        )

    template = Path(template_vpk_path).read_bytes()
    vpk_bytes = inject_voice_payload(template, payload)
    return DemoVoiceHudBuild(
        vpk_bytes=vpk_bytes,
        **stats,
        **input_stats,
        **radar_stats,
        **kill_feedback_stats,
        **flash_blind_stats,
    )
