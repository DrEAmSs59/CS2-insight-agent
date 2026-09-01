"""Build a demo-specific Panorama voice HUD package.

CS2 demo playback still decodes ``svc_VoiceData``, but the normal lower-left
speaker notices are not published on the HLTV demo UI path.  The bundled VPK
contains the stock demo controller plus a small Panorama overlay.  Before CS2
starts, this module fills that overlay with speaking intervals and player
locations extracted from the demo itself.
"""

from __future__ import annotations

from bisect import bisect_right
from collections import defaultdict
from dataclasses import dataclass
import json
import math
from pathlib import Path
import re
import struct
from typing import Any, Callable, Iterable, Mapping
import zlib

from .pov_constants import DEFAULT_POV_VOICE_MODE, normalize_pov_voice_mode

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


# Payload indices 0-3 are voice/input/roster. Index 6 carries exact
# weapon-selection pulses; 4, 5, and 7 remain reserved.
# Index 8 is the custom radar track; index 9 is POV kill/HS feedback audio;
# index 10 is POV flash-blind intervals (HUD wash + tinnitus cues); index 11
# is the fully reconstructed lower-left feed (radio, chat, server notices);
# index 12 is the interactive advanced-playback roster/event index; index 13
# stores the fixed recording voice audience (advanced playback has live controls);
# index 14 stores trusted session console commands that Panorama reapplies only
# after the demo controller reports a loaded map; index 15 carries exact
# CBaseUserCmdPB mousedx/mousedy samples for the keyboard's mouse-motion pad;
# index 16 carries authoritative CSGOUserCmdPB.left_hand_desired edges; index
# 17 carries exact button press/release edges for the input-audio SoundEvents;
# index 18 stores the per-session input-HUD presentation settings.
RADAR_PAYLOAD_INDEX = 8
KILL_FEEDBACK_PAYLOAD_INDEX = 9
FLASH_BLIND_PAYLOAD_INDEX = 10
RADIO_PAYLOAD_INDEX = 11
ADVANCED_PLAYBACK_PAYLOAD_INDEX = 12
VOICE_MODE_PAYLOAD_INDEX = 13
SESSION_CONSOLE_COMMANDS_PAYLOAD_INDEX = 14
MOUSE_INPUT_PAYLOAD_INDEX = 15
HAND_SWITCH_PAYLOAD_INDEX = 16
INPUT_AUDIO_EDGE_PAYLOAD_INDEX = 17
INPUT_PRESENTATION_PAYLOAD_INDEX = 18
WEAPON_SELECT_PAYLOAD_INDEX = 6
WEAPON_SELECT_ENTITY_INDEX_MASK = 0x3FFF
WEAPON_SELECT_MATCH_MAX_TICKS = 4
HAND_SWITCH_PULSE_TICKS = 4
_INPUT_RAW_TO_COMPACT_BIT = {
    raw_bit: compact_bit
    for compact_bit, raw_bit in enumerate((3, 9, 4, 10, 1, 2, 16, 13, 0, 11, 5, 35, 33))
}
RADAR_SAMPLE_HZ = 8
_GROUND_ENTITY_FIELD = "CCSPlayerPawn.m_hGroundEntity"
_LAST_JUMP_TICK_FIELD = (
    "CCSPlayerPawn.CCSPlayer_MovementServices.m_nLastJumpTick"
)
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
    input_weaponselect_requests: int = 0
    input_weaponselect_resolved: int = 0
    input_weaponselect_unresolved: int = 0
    input_weaponselect_tracks: int = 0
    input_weaponselect_parse_failed: int = 0
    input_mouse_tracks: int = 0
    input_mouse_samples: int = 0
    input_mouse_updates: int = 0
    input_hand_switch_tracks: int = 0
    input_hand_switch_events: int = 0
    input_left_hand_desired_updates: int = 0
    input_audio_edge_tracks: int = 0
    input_audio_edges: int = 0
    input_audio_subtick_edges: int = 0
    radar_players: int = 0
    radar_samples: int = 0
    radar_parse_failed: int = 0
    radar_map: str = ""
    radar_planted_bombs: int = 0
    radar_dropped_bombs: int = 0
    radar_player_sounds: int = 0
    radar_native_sound_complete: int = 0
    radar_occlusion_grid: int = 0
    kill_feedback_events: int = 0
    kill_feedback_parse_failed: int = 0
    flash_blind_events: int = 0
    flash_blind_parse_failed: int = 0
    flash_blind_tick_fallback: int = 0
    radio_events: int = 0
    radio_native_events: int = 0
    radio_rebuilt_events: int = 0
    radio_objective_events: int = 0
    radio_chat_messages: int = 0
    radio_server_messages: int = 0
    radio_parse_failed: int = 0
    advanced_playback_enabled: int = 0
    advanced_playback_players: int = 0
    advanced_playback_events: int = 0
    advanced_playback_rounds: int = 0
    advanced_playback_total_tick: int = 0
    advanced_playback_parse_failed: int = 0


def _read_cstring(data: bytes, cursor: int, limit: int) -> tuple[str, int]:
    end = data.find(b"\0", cursor, limit)
    if end < 0:
        raise DemoVoiceHudError("VPK directory contains an unterminated string")
    try:
        value = data[cursor:end].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise DemoVoiceHudError("VPK directory contains a non-UTF-8 path") from exc
    return value, end + 1


def read_inline_vpk(
    vpk_bytes: bytes,
    *,
    include_paths: Iterable[str] | None = None,
) -> dict[str, bytes]:
    """Read the inline entries used by the bundled, single-file VPK."""
    selected_paths = (
        {str(path).replace("\\", "/").strip("/") for path in include_paths}
        if include_paths is not None
        else None
    )
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
                directory_part = "" if directory == " " else directory.strip("/")
                extension_part = "" if extension == " " else f".{extension}"
                leaf = f"{stem}{extension_part}"
                full_path = f"{directory_part}/{leaf}" if directory_part else leaf
                if selected_paths is None or full_path in selected_paths:
                    body = preload + vpk_bytes[entry_start:entry_end]
                    if zlib.crc32(body) & 0xFFFFFFFF != expected_crc:
                        raise DemoVoiceHudError("VPK entry CRC does not match its payload")
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


def _zigzag_decode(value: int) -> int:
    return -(value // 2) - 1 if value & 1 else value // 2


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
    length: int = INPUT_PRESENTATION_PAYLOAD_INDEX + 1,
) -> list[Any]:
    if not isinstance(packed, list):
        raise DemoVoiceHudError("voice HUD payload has an unsupported shape")
    if len(packed) < 4:
        raise DemoVoiceHudError("voice HUD payload has an unsupported shape")
    while len(packed) < length:
        packed.append([])
    return packed


def _normalize_session_console_commands(
    commands: Iterable[object] | None,
) -> list[str]:
    normalized: list[str] = []
    for raw in commands or ():
        command = str(raw or "").strip()
        if not command:
            continue
        if len(command) > 256 or any(char in command for char in "\r\n;"):
            raise DemoVoiceHudError("session console command is unsafe")
        normalized.append(command)
        if len(normalized) > 32:
            raise DemoVoiceHudError("too many session console commands")
    return normalized


def _encode_kill_feedback_events(
    events: list[tuple[int, int, int, int]],
) -> str:
    """Delta-encode ``(tick, attacker_xuid_index, flags, cash_award)``."""
    previous_tick = 0
    encoded: list[str] = []
    for tick, attacker_index, flags, cash_award in events:
        encoded.append(
            ".".join((
                _base36(tick - previous_tick),
                _base36(attacker_index),
                _base36(int(flags) & 0xFF),
                _base36(max(0, int(cash_award))),
            ))
        )
        previous_tick = tick
    return ",".join(encoded)


def _build_kill_feedback_payload(
    parser: Any,
    roster_by_xuid: Mapping[int, tuple[int, int]],
) -> tuple[list[Any], dict[str, Any]]:
    """Compact POV kill/HS cues and lower-left enemy-kill cash awards."""
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
    weapons = rows.get("weapon")
    attacker_teams = rows.get("attackerteam")
    victim_teams = rows.get("userteam") or rows.get("user_team_num")
    if not isinstance(ticks, list) or not isinstance(attackers, list) or not isinstance(victims, list):
        raise DemoVoiceHudError("player_death rows are missing tick/attacker/victim fields")

    xuid_table: list[str] = []
    xuid_index: dict[int, int] = {}
    events: list[tuple[int, int, int, int]] = []
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
        cash_award = _kill_cash_award(
            weapons[i] if isinstance(weapons, list) and i < len(weapons) else None
        )
        if isinstance(attacker_teams, list) and isinstance(victim_teams, list):
            attacker_team = _as_int(attacker_teams[i]) if i < len(attacker_teams) else None
            victim_team = _as_int(victim_teams[i]) if i < len(victim_teams) else None
            if attacker_team in (2, 3) and attacker_team == victim_team:
                cash_award = 0
        events.append((tick, xuid_index[attacker], flags, cash_award))

    events.sort(key=lambda item: item[0])
    if not events:
        raise DemoVoiceHudError("demo contains no usable player_death kill feedback events")

    payload = [
        xuid_table,
        _encode_kill_feedback_events(events),
        int(round(_infer_demo_tick_rate(parser) * 1000.0)),
    ]
    return payload, {
        "kill_feedback_events": len(events),
        "kill_feedback_parse_failed": 0,
    }


_RADIO_PAYLOAD_VERSION = 2
_RADIO_NATIVE_MATCH_TOLERANCE_TICKS = 16
_RADIO_KIND_BY_WEAPON = {
    "smokegrenade": 0,
    "flashbang": 1,
    "hegrenade": 2,
    "molotov": 3,
    "incgrenade": 4,
    "incendiarygrenade": 4,
    "decoy": 5,
}
_RADIO_KIND_PLANTING = 6
_RADIO_KIND_DEFUSING = 7
_LOWER_LEFT_CHAT = 0
_LOWER_LEFT_TEAM_ATTACK = 1
_LOWER_LEFT_TEAM_KILL = 2
_LOWER_LEFT_SERVER = 3


@dataclass(frozen=True)
class _RadioEvent:
    tick: int
    xuid: int
    kind: int
    location: str
    team: int
    native: bool = False


@dataclass(frozen=True)
class _LowerLeftMessage:
    tick: int
    kind: int
    xuid: int
    team: int
    name: str = ""
    text: str = ""
    team_only: bool = False


def _radio_weapon_kind(raw_weapon: Any) -> int | None:
    weapon = str(raw_weapon or "").strip().lower()
    while weapon.startswith("weapon_"):
        weapon = weapon[len("weapon_") :]
    return _RADIO_KIND_BY_WEAPON.get(weapon)


def _radio_location(raw_location: Any) -> str:
    return str(raw_location or "").strip().lstrip("#")


def _parse_radio_event_rows(
    parser: Any,
    event_name: str,
    roster_by_xuid: Mapping[int, tuple[int, int]],
    *,
    fixed_kind: int | None = None,
    native: bool = False,
) -> list[_RadioEvent]:
    """Return XUID-bound radio rows with event-time location enrichment."""
    try:
        rows = parser.parse_event(
            event_name,
            player=["last_place_name", "team_num"],
        )
    except TypeError:
        # Older parser shims (and a few tests) do not accept ``player``.
        rows = parser.parse_event(event_name)
    if not isinstance(rows, Mapping):
        return []

    ticks = rows.get("tick")
    xuids = rows.get("user_steamid")
    if not isinstance(ticks, list) or not isinstance(xuids, list):
        return []
    weapons = rows.get("weapon")
    locations = rows.get("user_last_place_name")
    teams = rows.get("user_team_num")
    count = min(len(ticks), len(xuids))
    events: list[_RadioEvent] = []
    seen: set[tuple[int, int, int]] = set()
    for index in range(count):
        tick = _as_int(ticks[index])
        xuid = _as_positive_int(xuids[index])
        kind = fixed_kind
        if kind is None:
            kind = _radio_weapon_kind(
                weapons[index]
                if isinstance(weapons, list) and index < len(weapons)
                else None
            )
        if (
            tick is None
            or tick < 0
            or xuid is None
            or xuid not in roster_by_xuid
            or kind is None
        ):
            continue
        key = (tick, xuid, kind)
        if key in seen:
            continue
        seen.add(key)
        location = _radio_location(
            locations[index]
            if isinstance(locations, list) and index < len(locations)
            else ""
        )
        team = _as_int(
            teams[index]
            if isinstance(teams, list) and index < len(teams)
            else None
        )
        if team not in (2, 3):
            team = roster_by_xuid[xuid][1]
        events.append(_RadioEvent(tick, xuid, kind, location, team, native))
    # Python's sort is stable, preserving the source user-message order for
    # multiple teammates throwing utility on the same server tick.
    events.sort(key=lambda event: event.tick)
    return events


def _merge_native_and_rebuilt_radio_events(
    native_events: list[_RadioEvent],
    rebuilt_events: list[_RadioEvent],
) -> tuple[list[_RadioEvent], int]:
    """Use native ``grenade_thrown`` rows and fill only unmatched fires.

    Current native rows arrive 5-14 ticks after the corresponding
    ``weapon_fire`` in all scanned Valve/5E/Faceit/PWA/GOTV samples.  A greedy
    one-to-one match within 16 ticks avoids duplicates while retaining a fire
    row when a partially stripped native stream missed that throw.
    """
    merged = list(native_events)
    used_native: set[int] = set()
    rebuilt_count = 0
    for rebuilt in rebuilt_events:
        candidates = [
            (abs(native_event.tick - rebuilt.tick), index)
            for index, native_event in enumerate(native_events)
            if index not in used_native
            and native_event.xuid == rebuilt.xuid
            and native_event.kind == rebuilt.kind
            and abs(native_event.tick - rebuilt.tick)
            <= _RADIO_NATIVE_MATCH_TOLERANCE_TICKS
        ]
        if candidates:
            _distance, native_index = min(candidates)
            used_native.add(native_index)
            continue
        merged.append(rebuilt)
        rebuilt_count += 1
    merged.sort(key=lambda event: event.tick)
    return merged, rebuilt_count


def _encode_radio_events(
    events: list[_RadioEvent],
    xuid_index: Callable[[int], int],
    location_index: Callable[[str], int],
) -> str:
    previous_tick = 0
    encoded: list[str] = []
    for event in events:
        encoded.append(
            f"{_base36(event.tick - previous_tick)}.{_base36(xuid_index(event.xuid))}"
            f".{_base36(event.kind)}.{_base36(location_index(event.location))}"
            f".{_base36(event.team)}"
        )
        previous_tick = event.tick
    return ",".join(encoded)


def _row_values(rows: Mapping[str, Any], *names: str) -> list[Any]:
    for name in names:
        values = rows.get(name)
        if isinstance(values, list):
            return values
    return []


def _parse_chat_messages(parser: Any) -> list[_LowerLeftMessage]:
    """Extract the player chat stream exposed by demoparser's SayText2 event."""
    try:
        rows = parser.parse_event(
            "chat_message",
            player=["team_num"],
        )
    except TypeError:
        try:
            rows = parser.parse_event("chat_message")
        except Exception:  # noqa: BLE001
            return []
    except Exception:  # noqa: BLE001 - chat is optional on stripped demos
        return []
    if not isinstance(rows, Mapping):
        return []

    ticks = _row_values(rows, "tick")
    texts = _row_values(rows, "chat_message", "message", "text")
    xuids = _row_values(rows, "user_steamid", "steamid")
    names = _row_values(rows, "user_name", "name")
    teams = _row_values(rows, "user_team_num", "team_num", "team")
    team_only_values = _row_values(
        rows,
        "team_only",
        "teamonly",
        "is_team_chat",
        "is_team",
    )
    events: list[_LowerLeftMessage] = []
    for index in range(min(len(ticks), len(texts))):
        tick = _as_int(ticks[index])
        text = str(texts[index] or "").strip()
        xuid = _as_positive_int(xuids[index] if index < len(xuids) else None) or 0
        if tick is None or tick < 0 or not text:
            continue
        team = _as_int(teams[index] if index < len(teams) else None) or 0
        if team not in (2, 3):
            team = 0
        events.append(
            _LowerLeftMessage(
                tick=tick,
                kind=_LOWER_LEFT_CHAT,
                xuid=xuid,
                team=team,
                name=str(names[index] or "").strip() if index < len(names) else "",
                text=text,
                team_only=bool(
                    team_only_values[index]
                    if index < len(team_only_values)
                    else False
                ),
            )
        )
    return events


def _parse_direct_server_messages(parser: Any) -> list[_LowerLeftMessage]:
    """Best-effort support for parsers that expose TextMsg as server_message."""
    try:
        rows = parser.parse_event("server_message")
    except Exception:  # noqa: BLE001 - not exposed by current demoparser builds
        return []
    if not isinstance(rows, Mapping):
        return []
    ticks = _row_values(rows, "tick")
    texts = _row_values(rows, "server_message", "message", "text")
    events: list[_LowerLeftMessage] = []
    for index in range(min(len(ticks), len(texts))):
        tick = _as_int(ticks[index])
        text = str(texts[index] or "").strip()
        if tick is None or tick < 0 or not text:
            continue
        events.append(
            _LowerLeftMessage(
                tick=tick,
                kind=_LOWER_LEFT_SERVER,
                xuid=0,
                team=0,
                text=text,
            )
        )
    return events


def _parse_team_notice_messages(
    parser: Any,
    roster_by_xuid: Mapping[int, tuple[int, int]],
    *,
    tick_rate: float,
) -> list[_LowerLeftMessage]:
    """Rebuild red teammate-attack/team-kill server notices from game events."""
    events: list[_LowerLeftMessage] = []
    try:
        hurt_rows = parser.parse_event(
            "player_hurt",
            player=["team_num"],
        )
    except TypeError:
        try:
            hurt_rows = parser.parse_event("player_hurt")
        except Exception:  # noqa: BLE001
            hurt_rows = None
    except Exception:  # noqa: BLE001
        hurt_rows = None
    if isinstance(hurt_rows, Mapping):
        ticks = _row_values(hurt_rows, "tick")
        attackers = _row_values(hurt_rows, "attacker_steamid")
        victims = _row_values(hurt_rows, "user_steamid")
        attacker_teams = _row_values(
            hurt_rows,
            "attacker_team_num",
            "attackerteam",
        )
        victim_teams = _row_values(hurt_rows, "user_team_num", "userteam")
        attacker_names = _row_values(hurt_rows, "attacker_name")
        damage = _row_values(hurt_rows, "dmg_health")
        last_attack_tick: dict[int, int] = {}
        cooldown_ticks = max(1, int(round(max(1.0, tick_rate))))
        count = min(len(ticks), len(attackers), len(victims))
        for index in range(count):
            tick = _as_int(ticks[index])
            attacker = _as_positive_int(attackers[index])
            victim = _as_positive_int(victims[index])
            attacker_team = _as_int(
                attacker_teams[index] if index < len(attacker_teams) else None
            )
            victim_team = _as_int(
                victim_teams[index] if index < len(victim_teams) else None
            )
            health_damage = _as_int(damage[index] if index < len(damage) else 1)
            if (
                tick is None
                or attacker is None
                or victim is None
                or attacker == victim
                or attacker not in roster_by_xuid
                or attacker_team not in (2, 3)
                or attacker_team != victim_team
                or health_damage is None
                or health_damage <= 0
            ):
                continue
            if tick - last_attack_tick.get(attacker, -cooldown_ticks - 1) <= cooldown_ticks:
                continue
            last_attack_tick[attacker] = tick
            events.append(
                _LowerLeftMessage(
                    tick=tick,
                    kind=_LOWER_LEFT_TEAM_ATTACK,
                    xuid=attacker,
                    team=attacker_team,
                    name=(
                        str(attacker_names[index] or "").strip()
                        if index < len(attacker_names)
                        else ""
                    ),
                )
            )

    try:
        death_rows = parser.parse_event(
            "player_death",
            player=["team_num"],
        )
    except TypeError:
        try:
            death_rows = parser.parse_event("player_death")
        except Exception:  # noqa: BLE001
            death_rows = None
    except Exception:  # noqa: BLE001
        death_rows = None
    if isinstance(death_rows, Mapping):
        ticks = _row_values(death_rows, "tick")
        attackers = _row_values(death_rows, "attacker_steamid")
        victims = _row_values(death_rows, "user_steamid")
        attacker_teams = _row_values(
            death_rows,
            "attacker_team_num",
            "attackerteam",
        )
        victim_teams = _row_values(death_rows, "user_team_num", "userteam")
        attacker_names = _row_values(death_rows, "attacker_name")
        count = min(len(ticks), len(attackers), len(victims))
        for index in range(count):
            tick = _as_int(ticks[index])
            attacker = _as_positive_int(attackers[index])
            victim = _as_positive_int(victims[index])
            attacker_team = _as_int(
                attacker_teams[index] if index < len(attacker_teams) else None
            )
            victim_team = _as_int(
                victim_teams[index] if index < len(victim_teams) else None
            )
            if (
                tick is None
                or attacker is None
                or victim is None
                or attacker == victim
                or attacker not in roster_by_xuid
                or attacker_team not in (2, 3)
                or attacker_team != victim_team
            ):
                continue
            events.append(
                _LowerLeftMessage(
                    tick=tick,
                    kind=_LOWER_LEFT_TEAM_KILL,
                    xuid=attacker,
                    team=attacker_team,
                    name=(
                        str(attacker_names[index] or "").strip()
                        if index < len(attacker_names)
                        else ""
                    ),
                )
            )

    events.sort(key=lambda event: event.tick)
    return events


def _encode_lower_left_messages(
    events: list[_LowerLeftMessage],
    xuid_index: Callable[[int], int],
    text_index: Callable[[str, str], int],
) -> str:
    previous_tick = 0
    encoded: list[str] = []
    for event in events:
        flags = 1 if event.team_only else 0
        encoded.append(
            f"{_base36(event.tick - previous_tick)}.{_base36(event.kind)}"
            f".{_base36(xuid_index(event.xuid))}.{_base36(event.team)}"
            f".{_base36(flags)}.{_base36(text_index(event.name, event.text))}"
        )
        previous_tick = event.tick
    return ",".join(encoded)


_KILL_CASH_AWARD_BY_WEAPON = {
    # Current classic-mode weapon kill awards. Unlisted weapons use the
    # server's cash_player_killed_enemy_default ($300).
    "awp": 100,
    "cz75a": 100,
    "knife": 1500,
    "bayonet": 1500,
    "nova": 900,
    "mag7": 900,
    "sawedoff": 900,
    "xm1014": 900,
    "mac10": 600,
    "mp9": 600,
    "mp7": 600,
    "mp5sd": 600,
    "ump45": 600,
    "bizon": 600,
    "taser": 0,
}


def _kill_cash_award(raw_weapon: Any) -> int:
    weapon = str(raw_weapon or "").strip().lower()
    if weapon.startswith("weapon_"):
        weapon = weapon[7:]
    if weapon.startswith("knife") or "bayonet" in weapon:
        return 1500
    return _KILL_CASH_AWARD_BY_WEAPON.get(weapon, 300)


def _build_radio_payload(
    parser: Any,
    roster_by_xuid: Mapping[int, tuple[int, int]],
) -> tuple[list[Any], dict[str, Any]]:
    """Build one deterministic lower-left feed for the POV audience.

    Some newer GOTV demos expose ``grenade_thrown`` while older platform demos
    retain only ``weapon_fire``.  Both are compacted into one deterministic
    timeline. Bomb plant/defuse radio, player chat, and teammate attack/kill
    notices are carried beside it so Panorama never has to interleave an
    Insight row stack with CS2's independently animated native alert pool.
    """
    try:
        native_events = _parse_radio_event_rows(
            parser,
            "grenade_thrown",
            roster_by_xuid,
            native=True,
        )
    except Exception:  # noqa: BLE001 - event is absent in most demos
        native_events = []
    try:
        rebuilt_events = _parse_radio_event_rows(
            parser,
            "weapon_fire",
            roster_by_xuid,
        )
    except Exception:  # noqa: BLE001
        rebuilt_events = []

    throw_events, rebuilt_count = _merge_native_and_rebuilt_radio_events(
        native_events,
        rebuilt_events,
    )
    objective_events: list[_RadioEvent] = []
    for event_name, kind in (
        ("bomb_beginplant", _RADIO_KIND_PLANTING),
        ("bomb_begindefuse", _RADIO_KIND_DEFUSING),
    ):
        try:
            objective_events.extend(
                _parse_radio_event_rows(
                    parser,
                    event_name,
                    roster_by_xuid,
                    fixed_kind=kind,
                )
            )
        except Exception:  # noqa: BLE001 - objective radio is best effort
            continue
    radio_events = sorted(
        throw_events + objective_events,
        key=lambda event: event.tick,
    )
    tick_rate = _infer_demo_tick_rate(parser)
    chat_events = _parse_chat_messages(parser)
    team_notice_events = _parse_team_notice_messages(
        parser,
        roster_by_xuid,
        tick_rate=tick_rate,
    )
    direct_server_events = _parse_direct_server_messages(parser)
    message_events = sorted(
        chat_events + team_notice_events + direct_server_events,
        key=lambda event: event.tick,
    )

    xuid_table: list[str] = []
    xuid_indexes: dict[int, int] = {}

    def xuid_index(xuid: int) -> int:
        if xuid not in xuid_indexes:
            xuid_indexes[xuid] = len(xuid_table)
            xuid_table.append(str(xuid))
        return xuid_indexes[xuid]

    locations = [""]
    location_indexes = {"": 0}

    def location_index(location: str) -> int:
        if location not in location_indexes:
            location_indexes[location] = len(locations)
            locations.append(location)
        return location_indexes[location]

    encoded_radio = _encode_radio_events(
        radio_events,
        xuid_index,
        location_index,
    )

    texts: list[list[str]] = []
    text_indexes: dict[tuple[str, str], int] = {}

    def text_index(name: str, text: str) -> int:
        key = (name, text)
        if key not in text_indexes:
            text_indexes[key] = len(texts)
            texts.append([name, text])
        return text_indexes[key]

    encoded_messages = _encode_lower_left_messages(
        message_events,
        xuid_index,
        text_index,
    )
    payload = [
        xuid_table,
        locations,
        encoded_radio,
        texts,
        encoded_messages,
        int(round(tick_rate * 1000.0)),
        _RADIO_PAYLOAD_VERSION,
    ]
    return payload, {
        "radio_events": len(radio_events),
        "radio_native_events": len(native_events),
        "radio_rebuilt_events": rebuilt_count,
        "radio_objective_events": len(objective_events),
        "radio_chat_messages": len(chat_events),
        "radio_server_messages": len(team_notice_events) + len(direct_server_events),
        "radio_parse_failed": 0,
    }


_FLASH_BLIND_PAYLOAD_VERSION = 2
_FLASH_BLIND_CLEAR = 0x1
_FLASH_DURATION_EPSILON = 0.0001


def _encode_flash_blind_events(
    events: list[tuple[int, int, int, int, int]],
) -> str:
    """Delta-encode v2 flash state updates as base36.

    Tokens are ``dt.duration_ticks.victim_index.flags.max_alpha``.  ``flags``
    bit0 clears the victim's state (death / round reset).  Keeping clears in the
    same stream makes backward seeks deterministic without relying on whatever
    flash state CS2 happened to retain before ``demo_gototick``.
    """
    previous_tick = 0
    encoded: list[str] = []
    for tick, duration_ticks, victim_index, flags, max_alpha in events:
        encoded.append(
            f"{_base36(tick - previous_tick)}.{_base36(max(0, int(duration_ticks)))}"
            f".{_base36(victim_index)}.{_base36(int(flags) & 0xFF)}"
            f".{_base36(max(0, min(255, int(max_alpha))))}"
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
    """Compact authoritative flash state updates for the POV HUD.

    ``blind_duration`` / ``flash_duration`` is already the server's merged state
    after overlapping flashes.  A later positive update therefore replaces the
    previous end-time; it is not a second independent opacity animation.  Native
    ``player_blind`` rows are combined with exact property changes sampled only
    around ``flashbang_detonate`` ticks.  Deaths and round resets are encoded as
    explicit clears.
    """
    tick_rate = _infer_demo_tick_rate(parser)
    round_starts, deaths_by_xuid = _flash_lifecycle_events(parser, roster_by_xuid)

    try:
        rows = parser.parse_event("player_blind", other=["blind_duration"])
    except Exception:  # noqa: BLE001 - property fallback remains authoritative
        rows = None

    native_by_key: dict[tuple[int, int], tuple[int, int]] = {}
    if isinstance(rows, Mapping):
        ticks = rows.get("tick")
        victims = rows.get("user_steamid")
        durations = rows.get("blind_duration")
        if isinstance(ticks, list) and isinstance(victims, list) and isinstance(durations, list):
            count = min(len(ticks), len(victims), len(durations))
            for i in range(count):
                tick = _as_int(ticks[i])
                victim = _as_positive_int(victims[i])
                try:
                    seconds = float(durations[i])
                except (TypeError, ValueError, OverflowError):
                    continue
                if (
                    tick is None
                    or tick < 0
                    or victim is None
                    or victim not in roster_by_xuid
                    or not seconds > 0.01
                    or not _flash_victim_alive_at(
                        victim,
                        tick,
                        round_starts=round_starts,
                        deaths_by_xuid=deaths_by_xuid,
                    )
                ):
                    continue
                key = (tick, victim)
                duration_ticks = max(1, int(round(seconds * tick_rate)))
                previous = native_by_key.get(key)
                if previous is None or duration_ticks > previous[0]:
                    native_by_key[key] = (duration_ticks, 255)

    property_updates: list[tuple[int, int, int, int, int]] = []
    try:
        property_updates = _flash_property_updates_from_detonations(
            parser,
            roster_by_xuid,
            tick_rate=tick_rate,
            round_starts=round_starts,
            deaths_by_xuid=deaths_by_xuid,
        )
    except DemoVoiceHudError:
        # Native rows remain usable when a stripped demo lacks tick properties.
        property_updates = []

    merged: dict[tuple[int, int], tuple[int, int]] = dict(native_by_key)
    property_fills = 0
    for update_tick, duration_ticks, victim, max_alpha, detonate_tick in property_updates:
        native_key = (detonate_tick, victim)
        if native_key in merged:
            # The property is the final state after every same-tick blind event.
            merged[native_key] = (duration_ticks, max_alpha)
            continue
        merged[(update_tick, victim)] = (duration_ticks, max_alpha)
        property_fills += 1

    used_tick_fallback = property_fills > 0
    if not merged:
        coarse_events = _flash_blind_events_from_tick_properties(
            parser,
            roster_by_xuid,
            tick_rate=tick_rate,
        )
        for tick, duration_ticks, victim in coarse_events:
            merged[(tick, victim)] = (duration_ticks, 255)
        used_tick_fallback = True

    flashed_victims = {victim for _tick, victim in merged}
    raw_updates: list[tuple[int, int, int, int, int]] = [
        (tick, duration_ticks, victim, 0, max_alpha)
        for (tick, victim), (duration_ticks, max_alpha) in merged.items()
    ]
    for victim in flashed_victims:
        for round_start_tick in round_starts:
            raw_updates.append((round_start_tick, 0, victim, _FLASH_BLIND_CLEAR, 0))
        for death_tick in deaths_by_xuid.get(victim, []):
            raw_updates.append((death_tick, 0, victim, _FLASH_BLIND_CLEAR, 0))

    xuid_table: list[str] = []
    xuid_index: dict[int, int] = {}
    events: list[tuple[int, int, int, int, int]] = []
    # Positive updates at a tick must run before a same-tick death clear.
    raw_updates.sort(
        key=lambda item: (item[0], 1 if (item[3] & _FLASH_BLIND_CLEAR) else 0, item[2])
    )
    for tick, duration_ticks, victim, flags, max_alpha in raw_updates:
        if victim not in xuid_index:
            xuid_index[victim] = len(xuid_table)
            xuid_table.append(str(victim))
        events.append((tick, duration_ticks, xuid_index[victim], flags, max_alpha))

    if not events:
        raise DemoVoiceHudError("demo contains no usable player_blind flash events")

    payload = [
        xuid_table,
        _encode_flash_blind_events(events),
        _FLASH_BLIND_PAYLOAD_VERSION,
        int(round(tick_rate * 1000.0)),
    ]
    return payload, {
        "flash_blind_events": len(merged),
        "flash_blind_parse_failed": 0,
        "flash_blind_tick_fallback": int(used_tick_fallback),
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


def _flash_lifecycle_events(
    parser: Any,
    roster_by_xuid: Mapping[int, tuple[int, int]],
) -> tuple[list[int], dict[int, list[int]]]:
    """Return round resets and victim death ticks used by the flash state machine."""
    round_starts: list[int] = []
    try:
        rows = parser.parse_event("round_start")
    except Exception:  # noqa: BLE001 - lifecycle filtering is best effort
        rows = None
    ticks = rows.get("tick") if isinstance(rows, Mapping) else None
    if isinstance(ticks, list):
        round_starts = sorted({
            tick
            for tick in (_as_int(raw_tick) for raw_tick in ticks)
            if tick is not None and tick >= 0
        })

    deaths_by_xuid: dict[int, list[int]] = defaultdict(list)
    try:
        rows = parser.parse_event("player_death")
    except Exception:  # noqa: BLE001
        rows = None
    ticks = rows.get("tick") if isinstance(rows, Mapping) else None
    victims = rows.get("user_steamid") if isinstance(rows, Mapping) else None
    if isinstance(ticks, list) and isinstance(victims, list):
        for raw_tick, raw_victim in zip(ticks, victims):
            tick = _as_int(raw_tick)
            victim = _as_positive_int(raw_victim)
            if (
                tick is None
                or tick < 0
                or victim is None
                or victim not in roster_by_xuid
            ):
                continue
            deaths_by_xuid[victim].append(tick)
    for death_ticks in deaths_by_xuid.values():
        death_ticks.sort()
    return round_starts, dict(deaths_by_xuid)


def _flash_victim_alive_at(
    victim: int,
    tick: int,
    *,
    round_starts: list[int],
    deaths_by_xuid: Mapping[int, list[int]],
) -> bool:
    """Infer ordinary competitive respawns and reject blind rows after death."""
    prior_deaths = [death for death in deaths_by_xuid.get(victim, []) if death < tick]
    if not prior_deaths:
        return True
    last_death = prior_deaths[-1]
    return any(round_tick > last_death and round_tick <= tick for round_tick in round_starts)


def _flash_property_updates_from_detonations(
    parser: Any,
    roster_by_xuid: Mapping[int, tuple[int, int]],
    *,
    tick_rate: float,
    round_starts: list[int],
    deaths_by_xuid: Mapping[int, list[int]],
) -> list[tuple[int, int, int, int, int]]:
    """Read final pawn flash states around exact flashbang detonation ticks.

    GOTV demos that omit ``player_blind`` still retain ``m_flFlashDuration``.
    Sampling ``t-1/t/t+1`` for every detonation finds its network transition
    without a costly 16 Hz whole-match scan and preserves the authored tick to
    within one demo tick.  The returned final item is the source detonation tick
    used to merge a property transition with a native event when both exist.
    """
    try:
        detonations = parser.parse_event("flashbang_detonate")
    except Exception as exc:  # noqa: BLE001
        raise DemoVoiceHudError(f"could not parse flashbang_detonate: {exc}") from exc
    detonation_ticks_raw = detonations.get("tick") if isinstance(detonations, Mapping) else None
    if not isinstance(detonation_ticks_raw, list):
        return []
    detonation_ticks = sorted(
        {
            tick
            for tick in (_as_int(raw_tick) for raw_tick in detonation_ticks_raw)
            if tick is not None and tick >= 0
        }
    )
    if not detonation_ticks:
        return []

    sample_ticks = sorted(
        {
            candidate
            for detonation_tick in detonation_ticks
            for candidate in (detonation_tick - 1, detonation_tick, detonation_tick + 1)
            if candidate >= 0
        }
    )
    try:
        rows = parser.parse_ticks(
            ["steamid", "flash_duration", "flash_max_alpha", "is_alive"],
            ticks=sample_ticks,
        )
    except Exception as exc:  # noqa: BLE001
        raise DemoVoiceHudError(f"could not parse flash state at detonations: {exc}") from exc
    if not isinstance(rows, Mapping):
        raise DemoVoiceHudError("demoparser returned unsupported flash detonation state")

    ticks = rows.get("tick")
    victims = rows.get("steamid")
    durations = rows.get("flash_duration")
    if not isinstance(ticks, list) or not isinstance(victims, list) or not isinstance(durations, list):
        raise DemoVoiceHudError("flash detonation state is missing tick/steamid/duration")
    count = min(len(ticks), len(victims), len(durations))
    alphas = rows.get("flash_max_alpha")
    alive_values = rows.get("is_alive")
    snapshots: dict[tuple[int, int], tuple[float, int, bool | None]] = {}
    for index in range(count):
        tick = _as_int(ticks[index])
        victim = _as_positive_int(victims[index])
        if tick is None or victim is None or victim not in roster_by_xuid:
            continue
        try:
            duration = float(durations[index] or 0.0)
        except (TypeError, ValueError, OverflowError):
            duration = 0.0
        max_alpha = 255
        if isinstance(alphas, list) and index < len(alphas):
            try:
                max_alpha = int(round(float(alphas[index])))
            except (TypeError, ValueError, OverflowError):
                max_alpha = 255
        max_alpha = max(0, min(255, max_alpha))
        alive: bool | None = None
        if isinstance(alive_values, list) and index < len(alive_values):
            alive = bool(alive_values[index])
        snapshots[(tick, victim)] = (max(0.0, duration), max_alpha, alive)

    updates: list[tuple[int, int, int, int, int]] = []
    last_snapshot_by_xuid: dict[int, tuple[float, int, bool | None]] = {}
    for detonation_tick in detonation_ticks:
        for victim in roster_by_xuid:
            before = snapshots.get((detonation_tick - 1, victim))
            if before is None:
                before = last_snapshot_by_xuid.get(victim)
            chosen_tick: int | None = None
            chosen: tuple[float, int, bool | None] | None = None
            for candidate_tick in (detonation_tick, detonation_tick + 1):
                candidate = snapshots.get((candidate_tick, victim))
                if candidate is None:
                    continue
                if before is None:
                    changed = candidate[0] > 0.01
                else:
                    changed = (
                        candidate[0] > 0.01
                        and (
                            before[0] <= 0.01
                            or abs(candidate[0] - before[0]) > _FLASH_DURATION_EPSILON
                        )
                    )
                if changed:
                    chosen_tick = candidate_tick
                    chosen = candidate
                    break
            latest = snapshots.get((detonation_tick + 1, victim))
            if latest is None:
                latest = snapshots.get((detonation_tick, victim))
            if latest is not None:
                last_snapshot_by_xuid[victim] = latest
            if chosen_tick is None or chosen is None:
                continue
            duration, max_alpha, alive = chosen
            if alive is False or not _flash_victim_alive_at(
                victim,
                chosen_tick,
                round_starts=round_starts,
                deaths_by_xuid=deaths_by_xuid,
            ):
                continue
            updates.append(
                (
                    chosen_tick,
                    max(1, int(round(duration * tick_rate))),
                    victim,
                    max_alpha,
                    detonation_tick,
                )
            )
    return updates


def _flash_blind_events_from_tick_properties(
    parser: Any,
    roster_by_xuid: Mapping[int, tuple[int, int]],
    *,
    tick_rate: float,
) -> list[tuple[int, int, int]]:
    """Rebuild flash starts from pawn ``flash_duration`` state transitions."""
    start_tick, end_tick = _demo_tick_bounds(parser)
    probe_hz = 16
    stride = max(1, int(round(max(1.0, tick_rate) / probe_hz)))
    sample_ticks = list(range(start_tick, end_tick + 1, stride))
    if not sample_ticks:
        return []
    try:
        rows = parser.parse_ticks(["steamid", "flash_duration"], ticks=sample_ticks)
    except Exception as exc:  # noqa: BLE001
        raise DemoVoiceHudError(f"could not parse flash_duration tick state: {exc}") from exc
    if not isinstance(rows, Mapping):
        raise DemoVoiceHudError("demoparser returned unsupported flash_duration tick state")

    ticks = rows.get("tick")
    victims = rows.get("steamid")
    durations = rows.get("flash_duration")
    if not isinstance(ticks, list) or not isinstance(victims, list) or not isinstance(durations, list):
        raise DemoVoiceHudError("flash_duration tick columns are missing")
    if not ticks or len(ticks) != len(victims) or len(ticks) != len(durations):
        raise DemoVoiceHudError("flash_duration tick columns are empty or misaligned")

    samples: list[tuple[int, int, float]] = []
    for raw_tick, raw_victim, raw_duration in zip(ticks, victims, durations):
        tick = _as_int(raw_tick)
        victim = _as_positive_int(raw_victim)
        try:
            seconds = float(raw_duration or 0)
        except (TypeError, ValueError, OverflowError):
            seconds = 0.0
        if tick is None or victim is None or victim not in roster_by_xuid:
            continue
        samples.append((tick, victim, seconds if seconds > 0.01 else 0.0))
    samples.sort(key=lambda item: (item[0], item[1]))

    previous_by_xuid: dict[int, float] = {}
    events: list[tuple[int, int, int, int]] = []
    for tick, victim, seconds in samples:
        previous = previous_by_xuid.get(victim, 0.0)
        # flash_duration is stable between flash applications. A transition from
        # zero or to a materially different positive value represents a new hit,
        # including a weaker overlapping flash.
        changed = seconds > 0.01 and (
            previous <= 0.01 or abs(seconds - previous) > _FLASH_DURATION_EPSILON
        )
        if changed:
            events.append((tick, max(1, int(round(seconds * tick_rate))), victim))
        previous_by_xuid[victim] = seconds
    if not events:
        raise DemoVoiceHudError("demo contains no usable flash_duration tick transitions")
    return events


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
    input_tracks: Any = None,
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

    action_probe_fields = [
        "Z",
        "is_in_reload",
        "is_walking",
        "duck_amount",
        "move_type",
        _GROUND_ENTITY_FIELD,
        _LAST_JUMP_TICK_FIELD,
    ]
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
            *action_probe_fields,
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
            *action_probe_fields,
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
    zs = rows.get("Z", [])
    reloads = rows.get("is_in_reload", [])
    walkings = rows.get("is_walking", [])
    duck_amounts = rows.get("duck_amount", [])
    move_types = rows.get("move_type", [])
    ground_entities = rows.get(_GROUND_ENTITY_FIELD, [])
    last_jump_ticks = rows.get(_LAST_JUMP_TICK_FIELD, [])
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
    observed_actions: list[tuple[str, int, int]] = []
    # ``player_jump`` is absent from common GOTV demos. The exact UserCmd track
    # below is preferred, while pawn movement fields preserve jumps and running
    # intervals when that track was stripped as well. ``player_footstep`` rows
    # are also consumed later as exact anchors; these 8Hz states fill the longer
    # gaps in producers which retain only a sparse subset of those events.
    observed_state: dict[
        int,
        tuple[
            int,
            int,
            float | None,
            float,
            bool,
            bool,
            int | None,
            int | None,
            int,
        ],
    ] = {}

    def _grounded(raw: int | None) -> bool | None:
        if raw is None:
            return None
        # Source 2 serializes an invalid entity handle as 0xFFFFFF (and some
        # parser builds widen it to 0xFFFFFFFF). Every other retained handle is
        # a concrete ground entity, including the world handle used on floors.
        return raw not in (-1, 0xFFFFFF, 0xFFFFFFFF)

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

        z: float | None = None
        if isinstance(zs, list) and index < len(zs):
            try:
                z = float(zs[index])
            except (TypeError, ValueError, OverflowError):
                z = None
        reload_active = bool(
            reloads[index]
            if isinstance(reloads, list) and index < len(reloads)
            else False
        )
        walking = bool(
            walkings[index]
            if isinstance(walkings, list) and index < len(walkings)
            else False
        )
        try:
            duck_amount = float(
                duck_amounts[index]
                if isinstance(duck_amounts, list) and index < len(duck_amounts)
                else 0.0
            )
        except (TypeError, ValueError, OverflowError):
            duck_amount = 0.0
        move_type = _as_int(
            move_types[index]
            if isinstance(move_types, list) and index < len(move_types)
            else None
        )
        ground_entity = _as_int(
            ground_entities[index]
            if isinstance(ground_entities, list) and index < len(ground_entities)
            else None
        )
        last_jump_tick = _as_int(
            last_jump_ticks[index]
            if isinstance(last_jump_ticks, list) and index < len(last_jump_ticks)
            else None
        )
        alive = bool(alive_raw)
        previous = observed_state.get(xuid)
        vertical_delta = 0.0
        if previous is not None:
            (
                previous_x,
                previous_y,
                previous_z,
                previous_delta,
                previous_alive,
                previous_reload,
                previous_jump_tick,
                previous_ground_entity,
                previous_tick,
            ) = previous
            if alive and previous_alive:
                if reload_active and not previous_reload:
                    observed_actions.append(("reload", tick, xuid))
                horizontal_delta = math.hypot(x - previous_x, y - previous_y)
                tick_delta = max(1, tick - previous_tick)
                horizontal_speed = horizontal_delta * tick_rate / tick_delta
                if z is not None and previous_z is not None:
                    vertical_delta = z - previous_z
                previous_grounded = _grounded(previous_ground_entity)
                current_grounded = _grounded(ground_entity)
                jump_marker_changed = (
                    previous_jump_tick is not None
                    and last_jump_tick is not None
                    and last_jump_tick != previous_jump_tick
                )
                took_off = previous_grounded is True and current_grounded is False
                rising_fallback = (
                    z is not None
                    and previous_z is not None
                    and vertical_delta >= 20.0
                    and previous_delta < 20.0
                    and horizontal_delta < 64.0
                )
                jump_marker_available = (
                    previous_jump_tick is not None and last_jump_tick is not None
                )
                if (jump_marker_changed and took_off) or (
                    (not jump_marker_available or previous_grounded is None)
                    and rising_fallback
                ):
                    # The state changes inside this 8Hz interval. UserCmd edges
                    # dedupe this approximation when exact input was retained.
                    observed_actions.append(("jump", max(0, tick - min(stride, 4)), xuid))

                current_grounded = _grounded(ground_entity)
                on_foot = move_type in (None, 2)
                # Running footsteps begin well above silent Shift/crouch speed.
                # A bounded speed also rejects round-start teleports and POV
                # correction jumps. Exact player_footstep rows remain anchors
                # for unusual surfaces and transitions outside this gate.
                if (
                    not walking
                    and duck_amount < 0.5
                    and on_foot
                    and current_grounded is not False
                    and 125.0 <= horizontal_speed <= 340.0
                ):
                    observed_actions.append(("step", tick, xuid))
        observed_state[xuid] = (
            x,
            y,
            z,
            vertical_delta,
            alive,
            reload_active,
            last_jump_tick,
            ground_entity,
            tick,
        )
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
    player_sounds = _build_player_sound_track(
        parser,
        roster_by_xuid,
        input_tracks=input_tracks,
        observed_actions=observed_actions,
    )
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
        "radar_native_sound_complete": int(
            bool(player_sounds and len(player_sounds) >= 3 and player_sounds[2])
        ),
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


def _is_knife_weapon_name(weapon: Any) -> bool:
    text = _normalize_weapon_name(weapon)
    return "knife" in text or "bayonet" in text


def _is_fire_util_weapon_name(weapon: Any) -> bool:
    text = _normalize_weapon_name(weapon)
    return "molotov" in text or "incgrenade" in text or "incendiary" in text


def _weapon_fire_sound_radius(weapon: Any, silenced: Any) -> int | None:
    """Return the HUD sound-circle radius attributable to ``weapon_fire``.

    Audio propagation distance is not the CHudRadar circle radius. Retained
    native demos do not pair ordinary gun ``weapon_fire`` rows with a
    ``player_sound`` circle, so gun/taser shots only drive the combat border.
    Knife slash and fire-utility action layers are the two broadcast circles
    which can be reconstructed from this event stream. Ordinary grenade pin
    pulls remain local-only.
    """
    del silenced
    text = _normalize_weapon_name(weapon).replace("weapon_", "")
    if _is_knife_weapon_name(text):
        return 800
    if _is_fire_util_weapon_name(weapon):
        return 1100
    return None


def _weapon_fire_sound_specs(weapon: Any, silenced: Any) -> tuple[tuple[int, int], ...]:
    """Return missing action-layer ``(radius, duration_ms)`` rows.

    Knife swing playback follows the two authored distance-curve layers of
    ``Weapon_Knife.Slash``: the 352u inner ring and the 800u broadcast radius.
    Native 1000u Hit/Stab rows, when present, remain separate impact layers.
    """
    radius = _weapon_fire_sound_radius(weapon, silenced)
    if radius is None:
        return ()
    if _is_knife_weapon_name(weapon):
        return ((352, 100), (radius, 100))
    return ((radius, 100),)


def _player_sound_flags(
    *,
    is_step: bool,
    radius: int,
    kind: str = "auto",
) -> int:
    """Return compact radar-event flags.

    Bit 0 is the server-provided ``step`` bit. Bit 1 remains reserved for old
    payloads. Bit 2 marks a gunshot which drives only the live radar combat
    border; it must never be painted as a centered PlayerSound circle.
    """
    del radius
    return (1 if is_step else 0) | (4 if kind == "combat" else 0)


def _build_player_sound_track(
    parser: Any,
    roster_by_xuid: Mapping[int, tuple[int, int]],
    *,
    input_tracks: Any = None,
    observed_actions: Iterable[tuple[str, int, int]] = (),
) -> list[Any]:
    """Compact and reconcile radar sound-ring sources.

    Returns ``[xuid_table, "dt.xi.radius.durMs.flags,...", native_complete]``
    where ``xi`` indexes ``xuid_table`` and ``flags`` is ``bit0=step,
    bit1=legacy loudMax``. ``native_complete`` is true only when the demo has a
    fully aligned, valid native ``player_sound`` table. This is a structural
    source-quality flag, not a promise that the producer retained every action
    which can drive CS2's live sound HUD. Local-only pickup rows are excluded,
    while missing knife/jump/reload rows are reconciled from their independent
    action streams and player state.
    """
    events: list[tuple[int, int, int, int, int]] = []

    # ``player_sound`` is a transport table, not a final HUD decision. CS2's
    # Player.PickupWeapon event is audible locally but has display_broadcast
    # disabled. GOTV still commonly records it as a 1000/1100u, 100ms row at
    # the exact item_pickup tick, so keep the action context needed to reject
    # that false broadcast circle. The exact-tick match avoids suppressing an
    # unrelated movement or combat sound merely near a pickup.
    pickup_ticks: set[tuple[int, int]] = set()
    try:
        pickup_rows = parser.parse_event("item_pickup")
    except Exception:  # noqa: BLE001
        pickup_rows = None
    if isinstance(pickup_rows, Mapping):
        raw_pickup_ticks = pickup_rows.get("tick", [])
        raw_pickup_xuids = pickup_rows.get("user_steamid", [])
        if isinstance(raw_pickup_ticks, list) and isinstance(raw_pickup_xuids, list):
            for raw_tick, raw_xuid in zip(raw_pickup_ticks, raw_pickup_xuids):
                tick = _as_int(raw_tick)
                xuid = _as_positive_int(raw_xuid)
                if tick is not None and tick >= 0 and xuid is not None:
                    pickup_ticks.add((tick, xuid))

    try:
        rows = parser.parse_event("player_sound")
    except Exception:  # noqa: BLE001
        rows = None
    native_complete = _native_player_sound_rows_complete(rows, roster_by_xuid)
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
                try:
                    duration = (
                        float(durations[index])
                        if isinstance(durations, list) and index < len(durations)
                        else 0.1
                    )
                except (TypeError, ValueError, OverflowError):
                    duration = 0.1
                duration_ms = max(1, int(round(duration * 1000)))
                if (
                    not is_step
                    and (tick, xuid) in pickup_ticks
                    and radius in (1000, 1100)
                    and duration_ms <= 160
                ):
                    continue
                flags = _player_sound_flags(is_step=is_step, radius=radius)
                events.append((tick, xuid, radius, duration_ms, flags))

    native_events = tuple(events)

    def _has_nearby_native_sound(xuid: int, tick: int, radius: int, window: int) -> bool:
        return any(
            event_xuid == xuid
            and event_radius == radius
            and not (event_flags & 1)
            and abs(event_tick - tick) <= window
            for event_tick, event_xuid, event_radius, _duration, event_flags in native_events
        )

    # Decode UserCmd rising edges once. For a held grenade, M1 rises when the
    # player starts the pull/arming animation while ``weapon_fire`` arrives on
    # release. Matching a later fire-utility event back to that edge preserves
    # the visible circle's action timing. Jump/reload reuse the same edge pass.
    input_action_edges: list[tuple[str, int, int]] = []
    fire_press_ticks_by_xuid: dict[int, list[int]] = defaultdict(list)
    if isinstance(input_tracks, list):
        for raw_track in input_tracks:
            if not isinstance(raw_track, list) or len(raw_track) < 2:
                continue
            xuid = _as_positive_int(raw_track[0])
            encoded = raw_track[1]
            if (
                xuid is None
                or xuid not in roster_by_xuid
                or not isinstance(encoded, str)
                or not _ENCODED_INPUT_TRACK.fullmatch(encoded)
            ):
                continue
            previous_tick = 0
            previous_mask = 0
            for token in encoded.split(","):
                fields = token.split(".")
                try:
                    tick = previous_tick + int(fields[0], 36)
                    mask = int(fields[1], 36)
                except (IndexError, TypeError, ValueError, OverflowError):
                    break
                for kind, bit in (("jump", 4), ("reload", 7)):
                    if (mask & (1 << bit)) and not (previous_mask & (1 << bit)):
                        input_action_edges.append((kind, tick, xuid))
                if (mask & (1 << 8)) and not (previous_mask & (1 << 8)):
                    fire_press_ticks_by_xuid[xuid].append(tick)
                previous_tick = tick
                previous_mask = mask

    # ``weapon_fire`` is an independent event stream. Reconcile knife slashes
    # and the fire-utility ignition/throw layer, while carrying ordinary shots
    # as combat-border-only markers. Audio propagation range (formerly 9000u)
    # is never a centered radar-circle radius.
    try:
        fires = parser.parse_event("weapon_fire")
    except Exception:  # noqa: BLE001
        fires = None
    used_fire_presses: set[tuple[int, int]] = set()
    fire_press_window = max(1, int(round(_infer_demo_tick_rate(parser) * 8.0)))
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
                normalized_weapon = _normalize_weapon_name(weapon)
                if _is_gun_weapon_name(weapon) or "taser" in normalized_weapon:
                    events.append(
                        (
                            tick,
                            xuid,
                            1,
                            100,
                            _player_sound_flags(
                                is_step=False,
                                radius=1,
                                kind="combat",
                            ),
                        )
                    )
                    continue
                reconcile_complete = (
                    _is_knife_weapon_name(weapon)
                    or _is_fire_util_weapon_name(weapon)
                )
                if native_complete and not reconcile_complete:
                    continue
                action_tick = tick
                if _is_fire_util_weapon_name(weapon):
                    candidates = [
                        press_tick
                        for press_tick in fire_press_ticks_by_xuid.get(xuid, [])
                        if press_tick <= tick
                        and tick - press_tick <= fire_press_window
                        and (xuid, press_tick) not in used_fire_presses
                    ]
                    if candidates:
                        action_tick = max(candidates)
                        used_fire_presses.add((xuid, action_tick))
                for radius, duration_ms in _weapon_fire_sound_specs(weapon, sil):
                    # Match by authored radius as well as owner/tick. A nearby
                    # impact/mechanism row must not suppress another knife layer.
                    if _has_nearby_native_sound(xuid, action_tick, radius, 2):
                        continue
                    flags = _player_sound_flags(is_step=False, radius=radius, kind="weapon")
                    events.append((action_tick, xuid, radius, duration_ms, flags))

    # Values measured from retained CS2 ``player_sound`` rows. Jump itself is a
    # short 98u take-off pulse. Nearby 1100u/step rows belong to the independent
    # footstep/movement state and must not be synthesized from jump input.
    action_specs = {
        "reload": ((98, 100, False),),
        "jump": ((98, 100, False),),
        "step": ((1100, 500, True),),
    }
    inferred_actions: list[tuple[str, int, int]] = []

    # Server-observable events are exact when present. ``player_jump`` is absent
    # from some GOTV streams even though sampled pawn state is retained.
    for event_name, kind in (("weapon_reload", "reload"), ("player_jump", "jump")):
        for tick, xuid in _event_ticks_and_xuids(parser, event_name):
            if xuid is not None and xuid in roster_by_xuid:
                inferred_actions.append((kind, tick, xuid))

    # Several POV/GOTV producers omit the aggregated ``player_sound`` table but
    # retain standard player_footstep events. They provide exact cadence anchors
    # but no radius/duration, whose stock step values are consistently 1100u and
    # 0.5s in complete CS2 recordings.
    for tick, xuid in _event_ticks_and_xuids(parser, "player_footstep"):
        if xuid is not None and xuid in roster_by_xuid:
            inferred_actions.append(("step", tick, xuid))

    # The compact UserCmd mask is W,A,S,D,jump,crouch,walk,reload,fire,scope.
    # Rising edges make held R/SPACE produce exactly one sound event.
    inferred_actions.extend(input_action_edges)

    for raw_action in observed_actions:
        try:
            kind, raw_tick, raw_xuid = raw_action
        except (TypeError, ValueError):
            continue
        tick = _as_int(raw_tick)
        xuid = _as_positive_int(raw_xuid)
        if kind in action_specs and tick is not None and tick >= 0 and xuid in roster_by_xuid:
            inferred_actions.append((kind, tick, xuid))

    accepted_action_ticks: dict[tuple[str, int], list[int]] = defaultdict(list)
    for kind, tick, xuid in inferred_actions:
        if kind == "step" and native_complete:
            continue
        dedupe_window = 12 if kind == "reload" else (4 if kind == "step" else 8)
        key = (kind, xuid)
        if any(abs(tick - prior) <= dedupe_window for prior in accepted_action_ticks[key]):
            continue
        accepted_action_ticks[key].append(tick)
        for radius, duration_ms, is_step in action_specs[kind]:
            if _has_nearby_native_sound(xuid, tick, radius, dedupe_window):
                continue
            flags = _player_sound_flags(is_step=is_step, radius=radius, kind=kind)
            events.append((tick, xuid, radius, duration_ms, flags))

    if not events:
        return [[], "", int(native_complete)]

    events.sort(key=lambda item: (item[0], item[1], item[2], item[4]))
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
    return [xuid_table, ",".join(encoded), int(native_complete)]


def _native_player_sound_rows_complete(
    rows: Any,
    roster_by_xuid: Mapping[int, tuple[int, int]],
) -> bool:
    """Return whether CS2 can be trusted to render the demo's native rings."""
    if not isinstance(rows, Mapping):
        return False
    columns = [rows.get(key) for key in ("tick", "user_steamid", "radius", "duration", "step")]
    if not all(isinstance(column, list) for column in columns):
        return False
    lengths = [len(column) for column in columns]
    if not lengths or lengths[0] == 0 or len(set(lengths)) != 1:
        return False
    ticks, xuids, radii, durations, _steps = columns
    for raw_tick, raw_xuid, raw_radius, raw_duration in zip(ticks, xuids, radii, durations):
        tick = _as_int(raw_tick)
        xuid = _as_positive_int(raw_xuid)
        try:
            radius = float(raw_radius)
            duration = float(raw_duration)
        except (TypeError, ValueError, OverflowError):
            return False
        if (
            tick is None
            or tick < 0
            or xuid is None
            or xuid not in roster_by_xuid
            or not radius > 0
            or not duration > 0
        ):
            return False
    return True


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
_ENCODED_MOUSE_TRACK = re.compile(
    r"(?:[0-9a-z]+\.[0-9a-z]+\.[0-9a-z]+)"
    r"(?:,[0-9a-z]+\.[0-9a-z]+\.[0-9a-z]+)*\Z"
)


def _decode_input_changes(encoded: str) -> list[tuple[int, int]]:
    previous_tick = 0
    changes: list[tuple[int, int]] = []
    for token in encoded.split(","):
        fields = token.split(".")
        if len(fields) != 2:
            raise DemoVoiceHudError("input-track report contains an invalid token")
        try:
            tick = previous_tick + int(fields[0], 36)
            mask = int(fields[1], 36)
        except (TypeError, ValueError, OverflowError) as exc:
            raise DemoVoiceHudError("input-track report contains invalid base36 data") from exc
        if tick < previous_tick or mask < 0:
            raise DemoVoiceHudError("input-track report contains a negative delta or mask")
        changes.append((tick, mask))
        previous_tick = tick
    return changes


def _encode_input_changes(changes: Iterable[tuple[int, int]]) -> str:
    previous_tick = 0
    encoded: list[str] = []
    previous_mask = 0
    for raw_tick, raw_mask in sorted(changes):
        tick = int(raw_tick)
        mask = int(raw_mask)
        if tick < previous_tick or mask < 0:
            raise DemoVoiceHudError("input-track projection is not monotonic")
        if mask == previous_mask:
            continue
        encoded.append(f"{_base36(tick - previous_tick)}.{_base36(mask)}")
        previous_tick = tick
        previous_mask = mask
    return ",".join(encoded)


def _decode_mouse_samples(encoded: str) -> list[tuple[int, int, int]]:
    previous_tick = 0
    samples: list[tuple[int, int, int]] = []
    for token in encoded.split(","):
        fields = token.split(".")
        if len(fields) != 3:
            raise DemoVoiceHudError("mouse-track report contains an invalid token")
        try:
            tick = previous_tick + int(fields[0], 36)
            mousedx = _zigzag_decode(int(fields[1], 36))
            mousedy = _zigzag_decode(int(fields[2], 36))
        except (TypeError, ValueError, OverflowError) as exc:
            raise DemoVoiceHudError("mouse-track report contains invalid base36 data") from exc
        if tick < previous_tick:
            raise DemoVoiceHudError("mouse-track report contains a negative tick delta")
        if mousedx != 0 or mousedy != 0:
            samples.append((tick, mousedx, mousedy))
        previous_tick = tick
    return samples


def _encode_mouse_samples(samples: Iterable[tuple[int, int, int]]) -> str:
    previous_tick = 0
    encoded: list[str] = []
    for raw_tick, raw_mousedx, raw_mousedy in sorted(samples):
        tick = int(raw_tick)
        mousedx = int(raw_mousedx)
        mousedy = int(raw_mousedy)
        if tick < previous_tick:
            raise DemoVoiceHudError("mouse-track projection is not monotonic")
        if mousedx == 0 and mousedy == 0:
            continue
        encoded.append(
            f"{_base36(tick - previous_tick)}."
            f"{_base36(_zigzag_encode(mousedx))}."
            f"{_base36(_zigzag_encode(mousedy))}"
        )
        previous_tick = tick
    return ",".join(encoded)


def _identity_timeline_by_slot(
    report: Mapping[str, Any],
) -> dict[int, list[tuple[int, int]]]:
    collected: dict[int, list[tuple[int, int]]] = defaultdict(list)
    raw_identities = report.get("player_identity_updates")
    if not isinstance(raw_identities, list):
        return {}
    for raw_update in raw_identities:
        if not isinstance(raw_update, Mapping):
            continue
        try:
            slot = int(raw_update.get("player_slot"))
            tick = int(raw_update.get("demo_tick"))
            xuid = int(raw_update.get("xuid") or raw_update.get("steamid") or 0)
        except (TypeError, ValueError, OverflowError):
            continue
        if slot >= 0 and tick >= 0:
            collected[slot].append((tick, xuid))

    timelines: dict[int, list[tuple[int, int]]] = {}
    for slot, updates in collected.items():
        collapsed: list[tuple[int, int]] = []
        for tick, xuid in sorted(updates, key=lambda item: item[0]):
            if collapsed and collapsed[-1][1] == xuid:
                continue
            collapsed.append((tick, xuid))
        if collapsed:
            timelines[slot] = collapsed
    return timelines


def _identity_xuid_at(updates: list[tuple[int, int]], tick: int) -> int:
    index = bisect_right([update_tick for update_tick, _xuid in updates], tick) - 1
    return updates[index][1] if index >= 0 else 0


def _weapon_slot_from_item_def(raw_item_def: Any) -> int | None:
    from .features.demo_analysis.cs2_item_catalog import resolve_cs2_item

    item = resolve_cs2_item(raw_item_def, 0)
    if not item:
        return None
    item_type = str(item.get("type") or "")
    category = str(item.get("category") or "")
    model = str(item.get("model") or "")
    if category in {"rifle", "smg", "heavy"}:
        return 1
    if category == "secondary":
        return 2
    if item_type == "melee" or category == "equipment":
        return 3
    if item_type == "utility":
        return 4
    if category == "c4" or model == "c4":
        return 5
    return None


def _build_weapon_select_tracks(
    demo_path: str | Path,
    report: Mapping[str, Any],
    slot_to_xuid: Mapping[int, int],
    *,
    parser_factory: Callable[[str], Any] | None,
) -> tuple[list[list[str]], dict[str, int]]:
    raw_requests = report.get("weaponselect_requests")
    if not isinstance(raw_requests, list) or not raw_requests:
        return [], {
            "input_weaponselect_requests": 0,
            "input_weaponselect_resolved": 0,
            "input_weaponselect_unresolved": 0,
            "input_weaponselect_tracks": 0,
            "input_weaponselect_parse_failed": 0,
        }

    requests: list[tuple[int, int, int, int]] = []
    for order, raw_request in enumerate(raw_requests):
        if not isinstance(raw_request, Mapping):
            continue
        tick = _as_int(raw_request.get("demo_tick"))
        slot = _as_int(raw_request.get("player_slot"))
        entity_index = _as_int(raw_request.get("weaponselect"))
        if tick is None or tick < 0 or slot is None or slot < 0 or entity_index is None:
            continue
        if entity_index <= 0:
            continue
        entity_index &= WEAPON_SELECT_ENTITY_INDEX_MASK
        if entity_index <= 0:
            continue
        requests.append((tick, order, slot, entity_index))
    requests.sort()
    request_count = len(requests)
    if not requests:
        return [], {
            "input_weaponselect_requests": 0,
            "input_weaponselect_resolved": 0,
            "input_weaponselect_unresolved": 0,
            "input_weaponselect_tracks": 0,
            "input_weaponselect_parse_failed": 0,
        }

    probe_ticks = sorted({
        tick + offset
        for tick, _order, _slot, _entity_index in requests
        for offset in range(WEAPON_SELECT_MATCH_MAX_TICKS + 1)
    })
    if parser_factory is None:
        from demoparser2 import DemoParser

        parser_factory = DemoParser
    parser = parser_factory(str(demo_path))
    try:
        rows = parser.parse_ticks(
            ["active_weapon", "item_def_idx"],
            ticks=probe_ticks,
        )
    except Exception as exc:  # noqa: BLE001 - native parser error boundary
        raise DemoVoiceHudError(f"could not resolve weaponselect entities: {exc}") from exc
    if not isinstance(rows, Mapping):
        raise DemoVoiceHudError("demoparser returned unsupported weaponselect tick state")
    ticks = rows.get("tick")
    xuids = rows.get("steamid")
    handles = rows.get("active_weapon")
    item_defs = rows.get("item_def_idx")
    if not all(isinstance(column, list) for column in (ticks, xuids, handles, item_defs)):
        raise DemoVoiceHudError("weaponselect tick-state columns are missing")
    assert isinstance(ticks, list)
    assert isinstance(xuids, list)
    assert isinstance(handles, list)
    assert isinstance(item_defs, list)
    if not (len(ticks) == len(xuids) == len(handles) == len(item_defs)):
        raise DemoVoiceHudError("weaponselect tick-state columns are misaligned")

    slots_by_entity: dict[tuple[int, int, int], int] = {}
    item_def_slot_cache: dict[int, int | None] = {}
    for raw_tick, raw_xuid, raw_handle, raw_item_def in zip(
        ticks, xuids, handles, item_defs
    ):
        tick = _as_int(raw_tick)
        xuid = _as_positive_int(raw_xuid)
        handle = _as_int(raw_handle)
        item_def = _as_int(raw_item_def)
        if item_def is None:
            continue
        if item_def not in item_def_slot_cache:
            item_def_slot_cache[item_def] = _weapon_slot_from_item_def(item_def)
        weapon_slot = item_def_slot_cache[item_def]
        if (
            tick is None
            or xuid is None
            or handle is None
            or handle <= 0
            or weapon_slot is None
        ):
            continue
        entity_index = handle & WEAPON_SELECT_ENTITY_INDEX_MASK
        if entity_index > 0:
            slots_by_entity[(tick, xuid, entity_index)] = weapon_slot

    identity_by_slot = _identity_timeline_by_slot(report)
    roster_xuids = set(slot_to_xuid.values())
    pulses_by_xuid: dict[int, dict[int, int]] = defaultdict(dict)
    resolved = 0
    for tick, _order, player_slot, entity_index in requests:
        identities = identity_by_slot.get(player_slot)
        xuid = (
            _identity_xuid_at(identities, tick)
            if identities
            else slot_to_xuid.get(player_slot, 0)
        )
        if xuid not in roster_xuids:
            continue
        weapon_slot = next(
            (
                slots_by_entity[(tick + offset, xuid, entity_index)]
                for offset in range(WEAPON_SELECT_MATCH_MAX_TICKS + 1)
                if (tick + offset, xuid, entity_index) in slots_by_entity
            ),
            None,
        )
        if weapon_slot is None:
            continue
        pulses_by_xuid[xuid][tick] = weapon_slot
        pulses_by_xuid[xuid].setdefault(tick + 1, 0)
        resolved += 1

    encoded_tracks: list[list[str]] = []
    for xuid, pulses in pulses_by_xuid.items():
        encoded = _encode_input_changes(pulses.items())
        if encoded:
            encoded_tracks.append([str(xuid), encoded])
    return encoded_tracks, {
        "input_weaponselect_requests": request_count,
        "input_weaponselect_resolved": resolved,
        "input_weaponselect_unresolved": request_count - resolved,
        "input_weaponselect_tracks": len(encoded_tracks),
        "input_weaponselect_parse_failed": 0,
    }


def _identity_bound_input_tracks(
    report: Mapping[str, Any],
    slot_to_xuid: Mapping[int, int],
) -> list[list[str]]:
    tracks_by_slot: dict[int, list[tuple[int, int]]] = {}
    raw_tracks = report.get("tracks")
    if not isinstance(raw_tracks, list):
        raise DemoVoiceHudError("input-track report contains no track list")
    for raw_track in raw_tracks:
        if not isinstance(raw_track, Mapping):
            continue
        try:
            slot = int(raw_track.get("slot"))
            changes = int(raw_track.get("changes"))
        except (TypeError, ValueError, OverflowError):
            continue
        encoded = raw_track.get("encoded")
        if (
            slot < 0
            or changes <= 0
            or not isinstance(encoded, str)
            or not _ENCODED_INPUT_TRACK.fullmatch(encoded)
        ):
            continue
        decoded = _decode_input_changes(encoded)
        if len(decoded) != changes:
            raise DemoVoiceHudError(
                f"input-track report change count mismatch for player slot {slot}"
            )
        tracks_by_slot[slot] = decoded

    roster_xuids = set(slot_to_xuid.values())
    identity_by_slot = _identity_timeline_by_slot(report)

    # V3 reports without an identity timeline retain the old exact static-slot
    # binding. V4 reports normally take the branch below, which prevents a
    # reconnect or slot reuse from leaking one player's mask into another.
    if not identity_by_slot:
        encoded_tracks: list[list[str]] = []
        for slot, changes in tracks_by_slot.items():
            xuid = slot_to_xuid.get(slot)
            encoded = _encode_input_changes(changes)
            if xuid is not None and encoded:
                encoded_tracks.append([str(xuid), encoded])
        return encoded_tracks

    projected: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for slot, changes in tracks_by_slot.items():
        identities = identity_by_slot.get(slot)
        if not identities:
            xuid = slot_to_xuid.get(slot)
            if xuid is not None:
                projected[xuid].extend(changes)
            continue
        for index, (start_tick, xuid) in enumerate(identities):
            end_tick = identities[index + 1][0] if index + 1 < len(identities) else None
            if xuid not in roster_xuids:
                continue
            interval_changes = [
                (tick, mask)
                for tick, mask in changes
                if tick >= start_tick and (end_tick is None or tick < end_tick)
            ]
            projected[xuid].extend(interval_changes)
            if end_tick is not None:
                projected[xuid].append((end_tick, 0))

    encoded_tracks = []
    for xuid, changes in projected.items():
        # At equal ticks the later identity-bound event wins. This is needed
        # when the Rust track resets a reused player slot at the same tick.
        by_tick: dict[int, int] = {}
        for tick, mask in changes:
            by_tick[int(tick)] = int(mask)
        encoded = _encode_input_changes(by_tick.items())
        if encoded:
            encoded_tracks.append([str(xuid), encoded])
    return encoded_tracks


def _identity_bound_mouse_tracks(
    report: Mapping[str, Any],
    slot_to_xuid: Mapping[int, int],
) -> list[list[str]]:
    samples_by_slot: dict[int, list[tuple[int, int, int]]] = {}
    raw_tracks = report.get("mouse_tracks")
    if not isinstance(raw_tracks, list):
        return []
    for raw_track in raw_tracks:
        if not isinstance(raw_track, Mapping):
            continue
        try:
            slot = int(raw_track.get("slot"))
            sample_count = int(raw_track.get("samples"))
        except (TypeError, ValueError, OverflowError):
            continue
        encoded = raw_track.get("encoded")
        if (
            slot < 0
            or sample_count <= 0
            or not isinstance(encoded, str)
            or not _ENCODED_MOUSE_TRACK.fullmatch(encoded)
        ):
            continue
        decoded = _decode_mouse_samples(encoded)
        if len(decoded) != sample_count:
            raise DemoVoiceHudError(
                f"mouse-track report sample count mismatch for player slot {slot}"
            )
        samples_by_slot[slot] = decoded

    roster_xuids = set(slot_to_xuid.values())
    identity_by_slot = _identity_timeline_by_slot(report)
    projected: dict[int, list[tuple[int, int, int]]] = defaultdict(list)
    for slot, samples in samples_by_slot.items():
        identities = identity_by_slot.get(slot)
        if not identities:
            xuid = slot_to_xuid.get(slot)
            if xuid is not None:
                projected[xuid].extend(samples)
            continue
        for tick, mousedx, mousedy in samples:
            xuid = _identity_xuid_at(identities, tick)
            if xuid in roster_xuids:
                projected[xuid].append((tick, mousedx, mousedy))

    encoded_tracks: list[list[str]] = []
    for xuid, samples in projected.items():
        by_tick: dict[int, tuple[int, int]] = {}
        for tick, mousedx, mousedy in samples:
            previous_dx, previous_dy = by_tick.get(int(tick), (0, 0))
            by_tick[int(tick)] = (
                previous_dx + int(mousedx),
                previous_dy + int(mousedy),
            )
        encoded = _encode_mouse_samples(
            (tick, axes[0], axes[1]) for tick, axes in by_tick.items()
        )
        if encoded:
            encoded_tracks.append([str(xuid), encoded])
    return encoded_tracks


def _identity_bound_hand_switch_tracks(
    report: Mapping[str, Any],
    slot_to_xuid: Mapping[int, int],
) -> tuple[list[list[str]], int]:
    raw_changes = report.get("handedness_changes")
    if not isinstance(raw_changes, list):
        return [], 0

    roster_xuids = set(slot_to_xuid.values())
    identity_by_slot = _identity_timeline_by_slot(report)
    ticks_by_xuid: dict[int, set[int]] = defaultdict(set)
    for raw_change in raw_changes:
        if not isinstance(raw_change, Mapping):
            continue
        tick = _as_int(raw_change.get("demo_tick"))
        slot = _as_int(raw_change.get("player_slot"))
        if tick is None or tick < 0 or slot is None or slot < 0:
            continue
        identities = identity_by_slot.get(slot)
        xuid = (
            _identity_xuid_at(identities, tick)
            if identities
            else slot_to_xuid.get(slot, 0)
        )
        if xuid in roster_xuids:
            ticks_by_xuid[xuid].add(tick)

    encoded_tracks: list[list[str]] = []
    event_count = 0
    for xuid, ticks in ticks_by_xuid.items():
        intervals: list[list[int]] = []
        for tick in sorted(ticks):
            event_count += 1
            end_tick = tick + HAND_SWITCH_PULSE_TICKS
            if intervals and tick <= intervals[-1][1]:
                intervals[-1][1] = max(intervals[-1][1], end_tick)
            else:
                intervals.append([tick, end_tick])
        changes = [
            change
            for start_tick, end_tick in intervals
            for change in ((start_tick, 1), (end_tick, 0))
        ]
        encoded = _encode_input_changes(changes)
        if encoded:
            encoded_tracks.append([str(xuid), encoded])
    return encoded_tracks, event_count


def _identity_bound_input_audio_edges(
    report: Mapping[str, Any],
    slot_to_xuid: Mapping[int, int],
) -> tuple[list[list[str]], int, int]:
    raw_edges = report.get("button_edges")
    if not isinstance(raw_edges, list):
        return [], 0, 0

    roster_xuids = set(slot_to_xuid.values())
    identity_by_slot = _identity_timeline_by_slot(report)
    by_xuid: dict[int, list[tuple[int, int, int, int, list[Any], bool]]] = defaultdict(list)
    for source_order, raw_edge in enumerate(raw_edges):
        if not isinstance(raw_edge, Mapping):
            continue
        tick = _as_int(raw_edge.get("demo_tick"))
        slot = _as_int(raw_edge.get("player_slot"))
        command_index = _as_int(raw_edge.get("command_index"))
        edge_ordinal = _as_int(raw_edge.get("edge_ordinal"))
        raw_bit = _as_int(raw_edge.get("bit"))
        pressed = raw_edge.get("pressed")
        if (
            tick is None
            or tick < 0
            or slot is None
            or slot < 0
            or command_index is None
            or command_index < 0
            or edge_ordinal is None
            or edge_ordinal < 0
            or raw_bit not in _INPUT_RAW_TO_COMPACT_BIT
            or not isinstance(pressed, bool)
        ):
            continue
        identities = identity_by_slot.get(slot)
        xuid = (
            _identity_xuid_at(identities, tick)
            if identities
            else slot_to_xuid.get(slot, 0)
        )
        if xuid not in roster_xuids:
            continue
        raw_when = raw_edge.get("when")
        when: float | None = None
        if isinstance(raw_when, (int, float)) and not isinstance(raw_when, bool):
            candidate = float(raw_when)
            if math.isfinite(candidate):
                when = candidate
        from_subtick = raw_edge.get("source") == "subtick"
        by_xuid[xuid].append(
            (
                tick,
                command_index,
                edge_ordinal,
                source_order,
                [tick, _INPUT_RAW_TO_COMPACT_BIT[raw_bit], int(pressed), when],
                from_subtick,
            )
        )

    tracks: list[list[str]] = []
    edge_count = 0
    subtick_count = 0
    for xuid, rows in by_xuid.items():
        # Rust appends edges in authoritative command-stream order. Command
        # indexes can restart in a later svc_UserCmds message at the same demo
        # tick, so preserve the report order instead of re-sorting by index.
        rows.sort(key=lambda row: (row[0], row[3]))
        if not rows:
            continue
        previous_tick = 0
        encoded_events: list[str] = []
        for row in rows:
            tick, bit, pressed, when = row[4]
            fields = [
                _base36(int(tick) - previous_tick),
                _base36((int(bit) << 1) | int(bool(pressed))),
            ]
            if when is not None:
                # The extractor emits f32. Store its IEEE-754 bits so compacting
                # the JSON preserves the authoritative subtick timestamp exactly.
                when_bits = struct.unpack("<I", struct.pack("<f", float(when)))[0]
                fields.append(_base36(when_bits))
            encoded_events.append(".".join(fields))
            previous_tick = int(tick)
        edge_count += len(rows)
        subtick_count += sum(int(row[5]) for row in rows)
        tracks.append([str(xuid), ",".join(encoded_events)])
    return tracks, edge_count, subtick_count


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

    encoded_tracks = _identity_bound_input_tracks(input_track_report, slot_to_xuid)
    input_changes = sum(encoded.count(",") + 1 for _, encoded in encoded_tracks)
    if not encoded_tracks:
        raise DemoVoiceHudError("input-track report contains no usable player tracks")

    packed[2] = encoded_tracks
    try:
        weapon_select_tracks, weapon_select_stats = _build_weapon_select_tracks(
            demo_path,
            input_track_report,
            slot_to_xuid,
            parser_factory=parser_factory,
        )
    except DemoVoiceHudError:
        raw_requests = input_track_report.get("weaponselect_requests")
        request_count = len(raw_requests) if isinstance(raw_requests, list) else 0
        weapon_select_tracks = []
        weapon_select_stats = {
            "input_weaponselect_requests": request_count,
            "input_weaponselect_resolved": 0,
            "input_weaponselect_unresolved": request_count,
            "input_weaponselect_tracks": 0,
            "input_weaponselect_parse_failed": int(request_count > 0),
        }
    packed[WEAPON_SELECT_PAYLOAD_INDEX] = weapon_select_tracks
    mouse_tracks = _identity_bound_mouse_tracks(input_track_report, slot_to_xuid)
    packed[MOUSE_INPUT_PAYLOAD_INDEX] = mouse_tracks
    hand_switch_tracks, hand_switch_events = _identity_bound_hand_switch_tracks(
        input_track_report,
        slot_to_xuid,
    )
    packed[HAND_SWITCH_PAYLOAD_INDEX] = hand_switch_tracks
    audio_edge_tracks, audio_edges, audio_subtick_edges = (
        _identity_bound_input_audio_edges(input_track_report, slot_to_xuid)
    )
    packed[INPUT_AUDIO_EDGE_PAYLOAD_INDEX] = audio_edge_tracks
    mouse_samples = sum(encoded.count(",") + 1 for _, encoded in mouse_tracks)
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
        "input_mouse_tracks": len(mouse_tracks),
        "input_mouse_samples": mouse_samples,
        "input_mouse_updates": report_int("mouse_updates"),
        "input_hand_switch_tracks": len(hand_switch_tracks),
        "input_hand_switch_events": hand_switch_events,
        "input_left_hand_desired_updates": report_int("left_hand_desired_updates"),
        "input_audio_edge_tracks": len(audio_edge_tracks),
        "input_audio_edges": audio_edges,
        "input_audio_subtick_edges": audio_subtick_edges,
        **weapon_select_stats,
    }


def add_input_presentation_to_payload(
    voice_payload: bytes,
    *,
    enabled: bool,
    display_mode: str,
    scale_percent: int,
    audio_enabled: bool,
    audio_volume_percent: int,
) -> bytes:
    """Append validated per-session keyboard/mouse presentation settings."""
    try:
        packed = json.loads(voice_payload.decode("ascii"))
    except (UnicodeDecodeError, ValueError, TypeError) as exc:
        raise DemoVoiceHudError("voice HUD payload is not valid compact JSON") from exc
    packed = _pad_payload_slots(packed)

    mode = str(display_mode or "").strip().lower()
    if mode not in {"hybrid", "always", "active"}:
        raise DemoVoiceHudError(f"unsupported input HUD display mode: {display_mode}")
    scale = int(scale_percent)
    if scale < 75 or scale > 125:
        raise DemoVoiceHudError("input HUD scale must be between 75 and 125 percent")
    volume = int(audio_volume_percent)
    if volume not in {25, 50, 75, 100}:
        raise DemoVoiceHudError("input audio volume must be one of 25, 50, 75, or 100 percent")

    packed[INPUT_PRESENTATION_PAYLOAD_INDEX] = [
        int(bool(enabled)),
        mode,
        scale,
        int(bool(audio_enabled)),
        volume,
    ]
    return json.dumps(packed, ensure_ascii=True, separators=(",", ":")).encode("ascii")


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
        input_tracks=packed[2],
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


def add_radio_track_to_payload(
    voice_payload: bytes,
    demo_path: str | Path,
    *,
    parser_factory: Callable[[str], Any] | None = None,
) -> tuple[bytes, dict[str, Any]]:
    """Append the reconstructed lower-left feed at payload index 11."""
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
    radio, stats = _build_radio_payload(parser, roster_by_xuid)
    packed[RADIO_PAYLOAD_INDEX] = radio
    payload = json.dumps(packed, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    stats = dict(stats)
    stats["payload_bytes"] = len(payload)
    return payload, stats


_ADVANCED_EVENT_KILL = 0
_ADVANCED_EVENT_UTILITY = 1
_ADVANCED_UTILITY_STEMS = {
    0: "smokegrenade",
    1: "flashbang",
    2: "hegrenade",
    3: "molotov",
    4: "incgrenade",
    5: "decoy",
}


def _advanced_player_names(parser: Any) -> dict[int, str]:
    try:
        rows = parser.parse_player_info()
    except Exception:  # noqa: BLE001 - names are optional at runtime
        return {}
    if not isinstance(rows, Mapping):
        return {}
    xuids = _row_values(rows, "steamid", "steam_id64", "xuid")
    names = _row_values(rows, "name", "player_name")
    result: dict[int, str] = {}
    for raw_xuid, raw_name in zip(xuids, names):
        xuid = _as_positive_int(raw_xuid)
        name = str(raw_name or "").strip()
        if xuid is not None and name:
            result[xuid] = name
    return result


def _advanced_demo_total_tick(
    parser: Any,
    demo_path: str | Path,
    *,
    event_max_tick: int,
) -> int:
    """Resolve the real playback boundary for the Insight progress bar."""
    candidates = [max(0, int(event_max_tick))]
    header: Mapping[str, Any] = {}
    try:
        parsed = parser.parse_header()
        if isinstance(parsed, Mapping):
            header = parsed
    except Exception:  # noqa: BLE001 - the file frame scan remains authoritative
        pass
    header_ticks = _as_int(header.get("playback_ticks") or header.get("playback_frames"))
    if header_ticks is not None and header_ticks > 0:
        candidates.append(header_ticks)
    try:
        playback_time = float(header.get("playback_time") or 0.0)
    except (TypeError, ValueError):
        playback_time = 0.0
    if playback_time > 0:
        candidates.append(int(round(playback_time * _infer_demo_tick_rate(parser, header))))
    try:
        from .demo_playback_compat import read_demo_end_tick

        file_tick = int(read_demo_end_tick(demo_path))
        if file_tick > 0:
            candidates.append(file_tick)
    except Exception:  # noqa: BLE001 - synthetic tests and malformed EOF use header fallback
        pass
    return max(1, *candidates)


def _advanced_round_starts(parser: Any) -> list[tuple[int, int]]:
    """Return stable ``(round_number, start_tick)`` rows for the menu.

    Panorama's live ``RoundIntervals`` field is absent on several CS2 demo
    controller builds. Resolve the timeline while the demo is already open in
    demoparser instead. ``round_start`` is preferred because it is the round's
    ``startFreezeTick`` anchor: event grouping, elapsed time, and navigation
    must include the freeze phase. ``round_freeze_end`` remains a fallback for
    demos whose round-start table is missing or incomplete.
    """

    match_start_tick: int | None = None
    try:
        announce = parser.parse_event("round_announce_match_start")
    except Exception:  # noqa: BLE001 - warmup filtering is best effort
        announce = None
    announce_ticks = _row_values(announce, "tick") if isinstance(announce, Mapping) else []
    valid_announce_ticks = sorted(
        tick
        for tick in (_as_int(raw_tick) for raw_tick in announce_ticks)
        if tick is not None and tick >= 0
    )
    if valid_announce_ticks:
        # A demo can contain several announces after warmup/knife restarts.
        # The last one is the beginning of the retained competitive match.
        match_start_tick = valid_announce_ticks[-1]

    candidates_by_source: dict[str, list[int]] = {}
    for event_name in ("round_start", "round_freeze_end"):
        try:
            rows = parser.parse_event(event_name)
        except Exception:  # noqa: BLE001 - either source may be omitted by a demo
            rows = None
        ticks = _row_values(rows, "tick") if isinstance(rows, Mapping) else []
        candidates = sorted(
            {
                tick
                for tick in (_as_int(raw_tick) for raw_tick in ticks)
                if tick is not None and tick >= 0
            }
        )
        candidates_by_source[event_name] = candidates

    freeze_ends = candidates_by_source.get("round_freeze_end", [])
    if match_start_tick is not None and freeze_ends:
        filtered_freeze_ends = [tick for tick in freeze_ends if tick >= match_start_tick]
        if filtered_freeze_ends:
            freeze_ends = filtered_freeze_ends

    raw_freeze_starts = candidates_by_source.get("round_start", [])
    freeze_starts = raw_freeze_starts
    if match_start_tick is not None and raw_freeze_starts:
        freeze_starts = [tick for tick in raw_freeze_starts if tick >= match_start_tick]

        # round_announce_match_start can be emitted *inside* round one's freeze
        # phase. In that case a strict >= filter drops the real startFreezeTick
        # and makes the entire timeline fall back to round_freeze_end. Preserve
        # the closest preceding round_start only when no post-announce start
        # already exists before the first retained freeze end.
        first_freeze_end = freeze_ends[0] if freeze_ends else None
        has_post_announce_first_start = bool(
            first_freeze_end is not None
            and any(
                match_start_tick <= tick < first_freeze_end
                for tick in raw_freeze_starts
            )
        )
        preceding = [tick for tick in raw_freeze_starts if tick < match_start_tick]
        if first_freeze_end is not None and preceding and not has_post_announce_first_start:
            freeze_starts.insert(0, preceding[-1])

    if len(freeze_starts) >= len(freeze_ends):
        starts = freeze_starts
    else:
        # Keep every known startFreezeTick even when the round_start table is
        # partially retained. Fall back to freeze end only for the individual
        # round whose freeze-start event is missing.
        starts = []
        previous_freeze_end: int | None = None
        for freeze_end in freeze_ends:
            matching_starts = [
                tick
                for tick in freeze_starts
                if (previous_freeze_end is None or tick > previous_freeze_end)
                and tick < freeze_end
            ]
            starts.append(matching_starts[-1] if matching_starts else freeze_end)
            previous_freeze_end = freeze_end

    return [(index + 1, tick) for index, tick in enumerate(starts)]


def _advanced_round_intervals(
    starts: list[tuple[int, int]],
    *,
    total_tick: int,
) -> list[list[int]]:
    intervals: list[list[int]] = []
    for index, (round_number, start_tick) in enumerate(starts):
        next_start = starts[index + 1][1] if index + 1 < len(starts) else total_tick + 1
        intervals.append(
            [
                int(round_number),
                max(0, int(start_tick)),
                max(int(start_tick), int(next_start) - 1),
            ]
        )
    return intervals


def _encode_advanced_playback_events(
    events: list[tuple[int, int, int, int, int, int]],
) -> str:
    """Delta encode ``tick,type,actor+1,target+1,detail,flags`` rows."""
    previous_tick = 0
    encoded: list[str] = []
    for tick, kind, actor, target, detail, flags in events:
        encoded.append(
            ".".join(
                (
                    _base36(tick - previous_tick),
                    _base36(kind),
                    _base36(actor + 1),
                    _base36(target + 1),
                    _base36(detail),
                    _base36(flags),
                )
            )
        )
        previous_tick = tick
    return ",".join(encoded)


def add_advanced_playback_track_to_payload(
    voice_payload: bytes,
    demo_path: str | Path,
    *,
    parser_factory: Callable[[str], Any] | None = None,
) -> tuple[bytes, dict[str, Any]]:
    """Append the XUID-bound interactive player/event menu at payload index 12."""
    try:
        packed = json.loads(voice_payload.decode("ascii"))
    except (UnicodeDecodeError, ValueError, TypeError) as exc:
        raise DemoVoiceHudError("voice HUD payload is not valid compact JSON") from exc
    packed = _pad_payload_slots(packed)

    encoded_roster = packed[3]
    if not isinstance(encoded_roster, list):
        raise DemoVoiceHudError("voice HUD payload contains no player roster")
    roster_by_xuid: dict[int, tuple[int, int]] = {}
    ordered_xuids: list[int] = []
    for row in encoded_roster:
        if not isinstance(row, list) or len(row) < 3:
            continue
        xuid = _as_positive_int(row[0])
        slot = _as_int(row[1])
        team = _as_int(row[2])
        if xuid is None or slot is None or team not in (2, 3):
            continue
        roster_by_xuid[xuid] = (slot, team)
        ordered_xuids.append(xuid)
    if not ordered_xuids:
        raise DemoVoiceHudError("advanced playback contains no team-bound players")

    if parser_factory is None:
        from demoparser2 import DemoParser

        parser_factory = DemoParser
    parser = parser_factory(str(demo_path))
    names = _advanced_player_names(parser)
    player_index = {xuid: index for index, xuid in enumerate(ordered_xuids)}
    players = [
        [str(xuid), names.get(xuid, ""), roster_by_xuid[xuid][1], roster_by_xuid[xuid][0]]
        for xuid in ordered_xuids
    ]

    details = [""]
    detail_indexes = {"": 0}

    def detail_index(value: Any) -> int:
        text = str(value or "").strip()
        if text not in detail_indexes:
            detail_indexes[text] = len(details)
            details.append(text)
        return detail_indexes[text]

    events: list[tuple[int, int, int, int, int, int]] = []
    try:
        deaths = parser.parse_event("player_death")
    except Exception:  # noqa: BLE001 - individual event families are best effort
        deaths = None
    if isinstance(deaths, Mapping):
        ticks = _row_values(deaths, "tick")
        attackers = _row_values(deaths, "attacker_steamid")
        victims = _row_values(deaths, "user_steamid")
        weapons = _row_values(deaths, "weapon")
        headshots = _row_values(deaths, "headshot")
        through_smokes = _row_values(deaths, "thrusmoke", "through_smoke")
        penetrated = _row_values(deaths, "penetrated")
        noscopes = _row_values(deaths, "noscope")
        attacker_blinds = _row_values(deaths, "attackerblind", "attacker_blind")
        assisted_flashes = _row_values(deaths, "assistedflash", "assisted_flash")
        count = min(len(ticks), len(victims))
        for index in range(count):
            tick = _as_int(ticks[index])
            attacker = _as_positive_int(attackers[index]) if index < len(attackers) else None
            victim = _as_positive_int(victims[index])
            actor_index = player_index.get(attacker, -1)
            victim_index = player_index.get(victim, -1)
            if tick is None or tick < 0 or (actor_index < 0 and victim_index < 0):
                continue
            weapon = weapons[index] if index < len(weapons) else ""
            flags = (
                (1 if index < len(headshots) and bool(headshots[index]) else 0)
                | (2 if index < len(through_smokes) and bool(through_smokes[index]) else 0)
                | (
                    4
                    if index < len(penetrated)
                    and (_as_int(penetrated[index]) or 0) > 0
                    else 0
                )
                | (8 if index < len(noscopes) and bool(noscopes[index]) else 0)
                | (16 if index < len(attacker_blinds) and bool(attacker_blinds[index]) else 0)
                | (32 if index < len(assisted_flashes) and bool(assisted_flashes[index]) else 0)
            )
            events.append(
                (
                    tick,
                    _ADVANCED_EVENT_KILL,
                    actor_index,
                    victim_index,
                    detail_index(weapon),
                    flags,
                )
            )

    native_utility: list[_RadioEvent] = []
    rebuilt_utility: list[_RadioEvent] = []
    try:
        native_utility = _parse_radio_event_rows(
            parser,
            "grenade_thrown",
            roster_by_xuid,
            native=True,
        )
    except Exception:  # noqa: BLE001
        pass
    try:
        rebuilt_utility = _parse_radio_event_rows(
            parser,
            "weapon_fire",
            roster_by_xuid,
        )
    except Exception:  # noqa: BLE001
        pass
    utility_events, _rebuilt_count = _merge_native_and_rebuilt_radio_events(
        native_utility,
        rebuilt_utility,
    )
    for event in utility_events:
        actor_index = player_index.get(event.xuid, -1)
        if actor_index < 0:
            continue
        events.append(
            (
                event.tick,
                _ADVANCED_EVENT_UTILITY,
                actor_index,
                -1,
                detail_index(_ADVANCED_UTILITY_STEMS.get(event.kind, "utility")),
                1 if event.native else 0,
            )
        )

    events.sort(key=lambda row: (row[0], row[1], row[2], row[3]))
    round_starts = _advanced_round_starts(parser)
    total_tick = _advanced_demo_total_tick(
        parser,
        demo_path,
        event_max_tick=max(
            max((row[0] for row in events), default=0),
            max((row[1] for row in round_starts), default=0),
        ),
    )
    round_intervals = _advanced_round_intervals(round_starts, total_tick=total_tick)
    advanced = [
        1,
        int(round(_infer_demo_tick_rate(parser) * 1000.0)),
        players,
        details,
        _encode_advanced_playback_events(events),
        total_tick,
        round_intervals,
    ]
    packed[ADVANCED_PLAYBACK_PAYLOAD_INDEX] = advanced
    payload = json.dumps(packed, ensure_ascii=True, separators=(",", ":")).encode("ascii")
    return payload, {
        "advanced_playback_enabled": 1,
        "advanced_playback_players": len(players),
        "advanced_playback_events": len(events),
        "advanced_playback_rounds": len(round_intervals),
        "advanced_playback_total_tick": total_tick,
        "advanced_playback_parse_failed": 0,
        "payload_bytes": len(payload),
    }


def inject_voice_payload(template_vpk: bytes, payload: bytes) -> bytes:
    """Replace the compiled Panorama payload and rebuild the VPK with fresh CRCs.

    The payload lives inside the ``DATA`` block of a compiled Panorama resource.
    Its size varies substantially with demo length, so replacing it must also
    update the resource header, block size, and offsets of any following blocks.
    """
    entries = read_inline_vpk(template_vpk)
    script = entries.get(VOICE_SCRIPT_PATH)
    if script is None:
        raise DemoVoiceHudError(f"voice HUD template is missing {VOICE_SCRIPT_PATH}")

    if len(script) < 16:
        raise DemoVoiceHudError("compiled Panorama resource is truncated")
    total_size = struct.unpack_from("<I", script, 0)[0]
    block_count = struct.unpack_from("<I", script, 12)[0]
    if total_size != len(script) or block_count <= 0 or block_count > 64:
        raise DemoVoiceHudError("compiled Panorama resource header is unsupported")

    descriptors: list[tuple[int, bytes, int, int]] = []
    for index in range(block_count):
        descriptor = 16 + index * 12
        if descriptor + 12 > len(script):
            raise DemoVoiceHudError("compiled Panorama block table is truncated")
        name = script[descriptor : descriptor + 4]
        relative_offset, size = struct.unpack_from("<II", script, descriptor + 4)
        start = descriptor + 4 + relative_offset
        end = start + size
        if start < 0 or end > len(script):
            raise DemoVoiceHudError(
                f"compiled Panorama block {name!r} exceeds the resource"
            )
        descriptors.append((descriptor, name, start, size))

    data = next((item for item in descriptors if item[1] == b"DATA"), None)
    if data is None:
        raise DemoVoiceHudError("compiled Panorama resource has no DATA block")
    data_descriptor, _, data_start, old_data_size = data
    old_data_end = data_start + old_data_size
    data_source = script[data_start:old_data_end]
    begin = data_source.find(VOICE_DATA_BEGIN)
    end = data_source.find(VOICE_DATA_END, begin + len(VOICE_DATA_BEGIN))
    if begin < 0 or end < 0:
        raise DemoVoiceHudError("voice HUD template data markers were not found")
    payload_start = begin + len(VOICE_DATA_BEGIN)
    rebuilt_data = b"".join(
        (
            data_source[:payload_start],
            payload,
            data_source[end:],
        )
    )
    delta = len(rebuilt_data) - old_data_size
    rebuilt_script = bytearray(
        script[:data_start] + rebuilt_data + script[old_data_end:]
    )
    struct.pack_into("<I", rebuilt_script, 0, len(rebuilt_script))
    struct.pack_into("<I", rebuilt_script, data_descriptor + 8, len(rebuilt_data))
    for descriptor, name, start, _ in descriptors:
        if name != b"DATA" and start >= old_data_end:
            relative_offset = struct.unpack_from(
                "<I", rebuilt_script, descriptor + 4
            )[0]
            struct.pack_into(
                "<I", rebuilt_script, descriptor + 4, relative_offset + delta
            )
    entries[VOICE_SCRIPT_PATH] = bytes(rebuilt_script)
    return write_inline_vpk(entries)


def build_demo_voice_hud_vpk(
    demo_path: str | Path,
    template_vpk_path: str | Path,
    *,
    parser_factory: Callable[[str], Any] | None = None,
    input_track_report: Mapping[str, Any] | None = None,
    voice_enabled: bool = True,
    voice_mode: str = DEFAULT_POV_VOICE_MODE,
    advanced_playback_enabled: bool = False,
    input_hud_enabled: bool = True,
    input_hud_display_mode: str = "hybrid",
    input_hud_scale_percent: int = 100,
    input_audio_enabled: bool = True,
    input_audio_volume_percent: int = 100,
    session_console_commands: Iterable[object] | None = None,
) -> DemoVoiceHudBuild:
    payload, stats = build_voice_payload(demo_path, parser_factory=parser_factory)
    input_stats = {
        "input_tracks": 0,
        "input_changes": 0,
        "input_commands": 0,
        "input_button_updates": 0,
        "input_subtick_steps": 0,
        "input_weaponselect_requests": 0,
        "input_weaponselect_resolved": 0,
        "input_weaponselect_unresolved": 0,
        "input_weaponselect_tracks": 0,
        "input_weaponselect_parse_failed": 0,
        "input_mouse_tracks": 0,
        "input_mouse_samples": 0,
        "input_mouse_updates": 0,
        "input_hand_switch_tracks": 0,
        "input_hand_switch_events": 0,
        "input_left_hand_desired_updates": 0,
        "input_audio_edge_tracks": 0,
        "input_audio_edges": 0,
        "input_audio_subtick_edges": 0,
    }
    if input_track_report is not None:
        payload, input_stats = add_input_tracks_to_payload(
            payload,
            demo_path,
            input_track_report,
            parser_factory=parser_factory,
        )
        stats["payload_bytes"] = len(payload)

    payload = add_input_presentation_to_payload(
        payload,
        enabled=input_hud_enabled,
        display_mode=input_hud_display_mode,
        scale_percent=input_hud_scale_percent,
        audio_enabled=input_audio_enabled,
        audio_volume_percent=input_audio_volume_percent,
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
            "radar_native_sound_complete": 0,
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
        "flash_blind_tick_fallback": 0,
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
            "flash_blind_tick_fallback": 0,
        }

    radio_stats: dict[str, Any] = {
        "radio_events": 0,
        "radio_native_events": 0,
        "radio_rebuilt_events": 0,
        "radio_objective_events": 0,
        "radio_chat_messages": 0,
        "radio_server_messages": 0,
        "radio_parse_failed": 0,
    }
    try:
        payload, radio_stats = add_radio_track_to_payload(
            payload,
            demo_path,
            parser_factory=parser_factory,
        )
        stats["payload_bytes"] = int(radio_stats.pop("payload_bytes", len(payload)))
    except DemoVoiceHudError:
        radio_stats = {
            "radio_events": 0,
            "radio_native_events": 0,
            "radio_rebuilt_events": 0,
            "radio_objective_events": 0,
            "radio_chat_messages": 0,
            "radio_server_messages": 0,
            "radio_parse_failed": 1,
        }

    advanced_playback_stats: dict[str, Any] = {
        "advanced_playback_enabled": 0,
        "advanced_playback_players": 0,
        "advanced_playback_events": 0,
        "advanced_playback_rounds": 0,
        "advanced_playback_total_tick": 0,
        "advanced_playback_parse_failed": 0,
    }
    if advanced_playback_enabled:
        try:
            payload, advanced_playback_stats = add_advanced_playback_track_to_payload(
                payload,
                demo_path,
                parser_factory=parser_factory,
            )
            stats["payload_bytes"] = int(
                advanced_playback_stats.pop("payload_bytes", len(payload))
            )
        except DemoVoiceHudError:
            advanced_playback_stats = {
                "advanced_playback_enabled": 1,
                "advanced_playback_players": 0,
                "advanced_playback_events": 0,
                "advanced_playback_rounds": 0,
                "advanced_playback_total_tick": 0,
                "advanced_playback_parse_failed": 1,
            }
            raise

    resolved_voice_mode = normalize_pov_voice_mode(
        voice_mode,
        legacy_voice_disabled=not voice_enabled,
    )
    packed = _pad_payload_slots(json.loads(payload.decode("ascii")))
    packed[VOICE_MODE_PAYLOAD_INDEX] = resolved_voice_mode
    packed[SESSION_CONSOLE_COMMANDS_PAYLOAD_INDEX] = (
        _normalize_session_console_commands(session_console_commands)
    )
    payload = json.dumps(
        packed,
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode("ascii")
    stats["payload_bytes"] = len(payload)

    if resolved_voice_mode == "mute":
        # Keep roster, input, radar, kill-feedback, flash, and radio tracks intact.
        # Only remove the precomputed speaking schedule that drives the custom
        # lower-left notice; native voice volume is muted by the warmup policy.
        packed = _pad_payload_slots(json.loads(payload.decode("ascii")))
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
        **radio_stats,
        **advanced_playback_stats,
    )
