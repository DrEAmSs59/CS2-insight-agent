from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import math
from pathlib import Path
from typing import Any, BinaryIO, Iterable, Iterator, Mapping, Sequence


COMMAND_NAMES = {
    0: "DemStop",
    1: "DemFileHeader",
    2: "DemFileInfo",
    3: "DemSyncTick",
    4: "DemSendTables",
    5: "DemClassInfo",
    6: "DemStringTables",
    7: "DemPacket",
    8: "DemSignonPacket",
    9: "DemConsoleCmd",
    10: "DemCustomData",
    11: "DemCustomDataCallbacks",
    12: "DemUserCmd",
    13: "DemFullPacket",
    14: "DemSaveGame",
    15: "DemSpawnGroups",
    16: "DemAnimationData",
    17: "DemAnimationHeader",
    18: "DemRecovery",
}

COMPRESSION_FLAG = 64
SVC_USERCMDS_ID = 76

# These are the only carriers in a retail Source 2 demo that can expose an
# exact command/button stream. The synthetic usercmd_* names are supplied by
# the local demoparser2 fork when svc_UserCmds is present.
EXACT_INPUT_PROPS = (
    "buttons",
    "CCSPlayerPawn.CCSPlayer_MovementServices.m_nButtonDownMaskPrev",
    "usercmd_viewangle_x",
    "usercmd_viewangle_y",
    "usercmd_viewangle_z",
    "usercmd_forwardmove",
    "usercmd_leftmove",
    "usercmd_impulse",
    "usercmd_mouse_dx",
    "usercmd_mouse_dy",
    "usercmd_buttonstate_1",
    "usercmd_buttonstate_2",
    "usercmd_buttonstate_3",
    "usercmd_weapon_select",
    "usercmd_subtick_move_analog_forward_delta",
    "usercmd_subtick_move_analog_left_delta",
    "usercmd_subtick_move_button",
    "usercmd_subtick_move_when",
)

# These are server-observable consequences or movement-service state. They
# are deliberately not labelled as physical keyboard input.
OBSERVABLE_PROPS = (
    *EXACT_INPUT_PROPS,
    "CCSPlayerPawn.CCSPlayer_MovementServices.m_nToggleButtonDownMask",
    "CCSPlayerPawn.CCSPlayer_MovementServices.m_bOldJumpPressed",
    "CCSPlayerPawn.CCSPlayer_MovementServices.m_bDesiresDuck",
    "CCSPlayerPawn.CCSPlayer_MovementServices.m_bDucked",
    "CCSPlayerPawn.CCSPlayer_MovementServices.m_bDucking",
    "CCSPlayerPawn.CCSPlayer_MovementServices.m_nLastActualJumpPressTick",
    "CCSPlayerPawn.CCSPlayer_MovementServices.m_nLastUsableJumpPressTick",
    "CCSPlayerPawn.m_bIsWalking",
    "CCSPlayerPawn.m_bIsScoped",
    "CCSPlayerPawn.m_bWaitForNoAttack",
    "Weapon.m_bInReload",
    "X",
    "Y",
    "Z",
    "pitch",
    "yaw",
    "active_weapon_name",
    "is_alive",
    "team_num",
    "health",
    "steamid",
    "name",
)

TRANSITION_PROPS = (
    *EXACT_INPUT_PROPS,
    "CCSPlayerPawn.CCSPlayer_MovementServices.m_nToggleButtonDownMask",
    "CCSPlayerPawn.CCSPlayer_MovementServices.m_bOldJumpPressed",
    "CCSPlayerPawn.CCSPlayer_MovementServices.m_bDesiresDuck",
    "CCSPlayerPawn.CCSPlayer_MovementServices.m_bDucked",
    "CCSPlayerPawn.CCSPlayer_MovementServices.m_bDucking",
    "CCSPlayerPawn.CCSPlayer_MovementServices.m_nLastActualJumpPressTick",
    "CCSPlayerPawn.CCSPlayer_MovementServices.m_nLastUsableJumpPressTick",
    "CCSPlayerPawn.m_bIsWalking",
    "CCSPlayerPawn.m_bIsScoped",
    "CCSPlayerPawn.m_bWaitForNoAttack",
    "Weapon.m_bInReload",
)

INPUT_OUTCOME_EVENTS = {
    "player_jump",
    "weapon_fire",
    "weapon_reload",
    "weapon_zoom",
    "player_footstep",
    "fire_bullets",
}

INPUT_FIELD_KEYWORDS = (
    "button",
    "usercmd",
    "input",
    "jump",
    "duck",
    "walking",
    "reload",
    "attack",
    "move",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Create a byte-addressable PBDEMS2 frame map and export every "
            "input-related carrier or server-observable proxy."
        )
    )
    parser.add_argument("demos", nargs="+", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument(
        "--audit-dir",
        type=Path,
        help="Directory containing <stem>.usercmd-audit.json and .netmessage-audit.json",
    )
    parser.add_argument(
        "--skip-observable-ticks",
        action="store_true",
        help="Skip the large all-player, all-tick observable state export",
    )
    parser.add_argument(
        "--skip-events",
        action="store_true",
        help="Skip the all-game-events JSONL export",
    )
    return parser.parse_args()


def read_varint(stream: BinaryIO, *, allow_eof: bool = False) -> tuple[int, int] | None:
    value = 0
    for index in range(10):
        raw = stream.read(1)
        if not raw:
            if allow_eof and index == 0:
                return None
            raise EOFError("truncated varint")
        byte = raw[0]
        value |= (byte & 0x7F) << (7 * index)
        if byte & 0x80 == 0:
            return value, index + 1
    raise ValueError("varint exceeds 10 bytes")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def scan_outer_frames(path: Path, output_path: Path) -> dict[str, Any]:
    size = path.stat().st_size
    command_counts: dict[int, int] = {}
    compressed_counts: dict[int, int] = {}
    first_ticks: dict[int, int] = {}
    last_ticks: dict[int, int] = {}
    last_non_sentinel_tick = 0

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("rb") as stream, gzip.open(
        output_path, "wt", encoding="utf-8", newline="", compresslevel=6
    ) as output:
        header = stream.read(16)
        if len(header) != 16 or header[:8] != b"PBDEMS2\0":
            raise ValueError(f"{path} is not a PBDEMS2 demo")
        file_info_offset = int.from_bytes(header[8:12], "little")
        spawn_groups_offset = int.from_bytes(header[12:16], "little")

        fields = (
            "frame_index",
            "frame_offset",
            "raw_command",
            "command_id",
            "command_name",
            "compressed",
            "tick",
            "payload_offset",
            "payload_size",
            "payload_sha256",
        )
        writer = csv.DictWriter(output, fieldnames=fields)
        writer.writeheader()

        frame_index = 0
        while True:
            frame_offset = stream.tell()
            command_result = read_varint(stream, allow_eof=True)
            if command_result is None:
                break
            raw_command, _ = command_result
            tick_result = read_varint(stream)
            size_result = read_varint(stream)
            assert tick_result is not None and size_result is not None
            tick, _ = tick_result
            payload_size, _ = size_result
            payload_offset = stream.tell()
            payload = stream.read(payload_size)
            if len(payload) != payload_size:
                raise EOFError(
                    f"frame {frame_index} at {frame_offset} declares {payload_size} "
                    f"bytes but only {len(payload)} remain"
                )

            compressed = bool(raw_command & COMPRESSION_FLAG)
            command_id = raw_command & ~COMPRESSION_FLAG
            digest = hashlib.sha256(payload).hexdigest().upper()
            writer.writerow(
                {
                    "frame_index": frame_index,
                    "frame_offset": frame_offset,
                    "raw_command": raw_command,
                    "command_id": command_id,
                    "command_name": COMMAND_NAMES.get(command_id, "Unknown"),
                    "compressed": int(compressed),
                    "tick": tick,
                    "payload_offset": payload_offset,
                    "payload_size": payload_size,
                    "payload_sha256": digest,
                }
            )
            command_counts[command_id] = command_counts.get(command_id, 0) + 1
            if compressed:
                compressed_counts[command_id] = compressed_counts.get(command_id, 0) + 1
            first_ticks.setdefault(command_id, tick)
            last_ticks[command_id] = tick
            if tick != 0xFFFFFFFF:
                last_non_sentinel_tick = max(last_non_sentinel_tick, tick)
            frame_index += 1

        exact_eof = stream.tell() == size

    return {
        "magic": "PBDEMS2\\0",
        "file_bytes": size,
        "file_info_offset": file_info_offset,
        "spawn_groups_offset": spawn_groups_offset,
        "frame_count": frame_index,
        "exact_eof": exact_eof,
        "ending_offset": size if exact_eof else None,
        "last_non_sentinel_tick": last_non_sentinel_tick,
        "command_counts": {
            str(key): {
                "name": COMMAND_NAMES.get(key, "Unknown"),
                "count": count,
                "compressed_count": compressed_counts.get(key, 0),
                "first_tick": first_ticks[key],
                "last_tick": last_ticks[key],
            }
            for key, count in sorted(command_counts.items())
        },
        "dem_usercmd_id": 12,
        "dem_usercmd_count": command_counts.get(12, 0),
    }


def json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, bytes):
        return {"hex": value.hex(), "bytes": len(value)}
    if isinstance(value, Mapping):
        return {str(key): json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    if hasattr(value, "item"):
        try:
            return json_value(value.item())
        except Exception:
            pass
    return str(value)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as output:
        json.dump(json_value(value), output, ensure_ascii=False, indent=2, sort_keys=True)
        output.write("\n")


def table_length(table: Mapping[str, Sequence[Any]]) -> int:
    lengths = {len(values) for values in table.values()}
    if not lengths:
        return 0
    if len(lengths) != 1:
        raise ValueError(f"column lengths differ: {sorted(lengths)}")
    return next(iter(lengths))


def table_rows(table: Mapping[str, Sequence[Any]]) -> Iterator[dict[str, Any]]:
    columns = list(table)
    for index in range(table_length(table)):
        yield {column: json_value(table[column][index]) for column in columns}


def table_to_rows(table: Any) -> list[dict[str, Any]]:
    if isinstance(table, Mapping):
        return list(table_rows(table))
    if hasattr(table, "to_dict"):
        converted = table.to_dict(as_series=False)
        if isinstance(converted, Mapping):
            return list(table_rows(converted))
    raise TypeError(f"unsupported table type: {type(table)!r}")


def ordered_columns(table: Mapping[str, Sequence[Any]]) -> list[str]:
    preferred = ["tick", "steamid", "name"]
    return [name for name in preferred if name in table] + [
        name for name in table if name not in preferred
    ]


def write_table_csv_gz(path: Path, table: Mapping[str, Sequence[Any]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    columns = ordered_columns(table)
    row_count = table_length(table)
    with gzip.open(path, "wt", encoding="utf-8", newline="", compresslevel=6) as output:
        writer = csv.DictWriter(output, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for row in table_rows(table):
            writer.writerow(row)
    return row_count


def write_transitions(path: Path, table: Mapping[str, Sequence[Any]]) -> tuple[int, list[str]]:
    transition_columns = [column for column in TRANSITION_PROPS if column in table]
    path.parent.mkdir(parents=True, exist_ok=True)
    output_fields = ("tick", "steamid", "name", "field", "previous", "current")
    previous: dict[tuple[str, str], Any] = {}
    transition_count = 0
    with gzip.open(path, "wt", encoding="utf-8", newline="", compresslevel=6) as output:
        writer = csv.DictWriter(output, fieldnames=output_fields)
        writer.writeheader()
        for row in table_rows(table):
            steamid = str(row.get("steamid", ""))
            for column in transition_columns:
                value = row.get(column)
                key = (steamid, column)
                if key not in previous:
                    previous[key] = value
                    continue
                old = previous[key]
                if old == value:
                    continue
                writer.writerow(
                    {
                        "tick": row.get("tick"),
                        "steamid": steamid,
                        "name": row.get("name"),
                        "field": column,
                        "previous": json.dumps(old, ensure_ascii=False),
                        "current": json.dumps(value, ensure_ascii=False),
                    }
                )
                previous[key] = value
                transition_count += 1
    return transition_count, transition_columns


def export_events(
    parser: Any,
    event_names: Sequence[str],
    all_events_path: Path,
    outcomes_path: Path,
) -> dict[str, int]:
    parsed = parser.parse_events(list(event_names))
    event_counts: dict[str, int] = {name: 0 for name in event_names}
    all_events_path.parent.mkdir(parents=True, exist_ok=True)
    outcome_columns: list[str] = [
        "event",
        "tick",
        "user_steamid",
        "user_name",
        "weapon",
        "silenced",
    ]
    outcome_rows: list[dict[str, Any]] = []
    with gzip.open(
        all_events_path, "wt", encoding="utf-8", newline="", compresslevel=6
    ) as output:
        for event_name, raw_table in parsed:
            if not isinstance(raw_table, Mapping):
                continue
            count = table_length(raw_table)
            event_counts[str(event_name)] = count
            for row in table_rows(raw_table):
                record = {"event": str(event_name), **row}
                output.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
                output.write("\n")
                if event_name in INPUT_OUTCOME_EVENTS:
                    outcome_rows.append(record)
                    for key in record:
                        if key not in outcome_columns:
                            outcome_columns.append(key)

    with gzip.open(
        outcomes_path, "wt", encoding="utf-8", newline="", compresslevel=6
    ) as output:
        writer = csv.DictWriter(output, fieldnames=outcome_columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(outcome_rows)
    return event_counts


def load_optional_json(path: Path | None) -> dict[str, Any] | None:
    if path is None or not path.is_file():
        return None
    with path.open("r", encoding="utf-8") as stream:
        value = json.load(stream)
    return value if isinstance(value, dict) else None


def nested_message_count(net_audit: Mapping[str, Any] | None, message_id: int) -> int | None:
    if net_audit is None:
        return None
    table = net_audit.get("packet_message_types")
    if not isinstance(table, Mapping):
        return None
    entry = table.get(str(message_id))
    if not isinstance(entry, Mapping):
        return 0
    count = entry.get("count")
    return int(count) if isinstance(count, (int, float)) else None


def analyze_demo(
    path: Path,
    output_root: Path,
    audit_dir: Path | None,
    *,
    skip_observable_ticks: bool,
    skip_events: bool,
) -> dict[str, Any]:
    from demoparser2 import DemoParser

    path = path.resolve(strict=True)
    demo_dir = output_root / path.stem
    demo_dir.mkdir(parents=True, exist_ok=True)

    print(f"[{path.name}] hashing and scanning PBDEMS2 outer frames", flush=True)
    outer = scan_outer_frames(path, demo_dir / "outer_frames.csv.gz")
    digest = file_sha256(path)

    print(f"[{path.name}] parsing header, roster, fields and event directory", flush=True)
    parser = DemoParser(str(path))
    header = json_value(parser.parse_header())
    roster_table = parser.parse_player_info()
    roster = table_to_rows(roster_table)
    updated_fields = sorted(str(value) for value in parser.list_updated_fields())
    event_names = sorted(str(value) for value in parser.list_game_events())
    input_related_fields = [
        field
        for field in updated_fields
        if any(keyword in field.lower() for keyword in INPUT_FIELD_KEYWORDS)
    ]

    write_json(demo_dir / "header.json", header)
    write_json(demo_dir / "player_roster.json", roster)
    write_json(demo_dir / "updated_fields.json", updated_fields)
    write_json(demo_dir / "input_related_updated_fields.json", input_related_fields)
    write_json(demo_dir / "game_event_names.json", event_names)

    event_counts: dict[str, int] | None = None
    if not skip_events:
        print(f"[{path.name}] exporting every game event", flush=True)
        event_counts = export_events(
            parser,
            event_names,
            demo_dir / "game_events.jsonl.gz",
            demo_dir / "input_outcome_events.csv.gz",
        )
        write_json(demo_dir / "game_event_counts.json", event_counts)

    observed_columns: list[str] = []
    observable_rows: int | None = None
    transition_count: int | None = None
    transition_columns: list[str] = []
    if not skip_observable_ticks:
        print(
            f"[{path.name}] exporting all {outer['last_non_sentinel_tick'] + 1} ticks of "
            "input-related observable state",
            flush=True,
        )
        ticks = list(range(int(outer["last_non_sentinel_tick"]) + 1))
        observable_table = parser.parse_ticks(list(OBSERVABLE_PROPS), ticks=ticks)
        if not isinstance(observable_table, Mapping):
            raise TypeError(f"unexpected parse_ticks return: {type(observable_table)!r}")
        observed_columns = list(observable_table)
        observable_rows = write_table_csv_gz(
            demo_dir / "observable_player_ticks.csv.gz", observable_table
        )
        transition_count, transition_columns = write_transitions(
            demo_dir / "observable_input_transitions.csv.gz", observable_table
        )

    usercmd_audit_path = (
        audit_dir / f"{path.stem}.usercmd-audit.json" if audit_dir else None
    )
    net_audit_path = (
        audit_dir / f"{path.stem}.netmessage-audit.json" if audit_dir else None
    )
    usercmd_audit = load_optional_json(usercmd_audit_path)
    net_audit = load_optional_json(net_audit_path)
    svc_usercmd_count = nested_message_count(net_audit, SVC_USERCMDS_ID)
    usercmd_command_count = (
        int(usercmd_audit.get("svc_usercmd_command_count", 0))
        if usercmd_audit is not None
        else None
    )
    outer_dem_usercmd_count = int(outer["dem_usercmd_count"])
    raw_button_field = "CCSPlayerPawn.CCSPlayer_MovementServices.m_nButtonDownMaskPrev"
    raw_button_field_present = raw_button_field in updated_fields
    synthetic_exact_columns = [
        column for column in observed_columns if column in EXACT_INPUT_PROPS
    ]
    exact_absence_confirmed = (
        outer_dem_usercmd_count == 0
        and svc_usercmd_count == 0
        and usercmd_command_count == 0
        and not raw_button_field_present
        and not synthetic_exact_columns
    )

    metadata = {
        "analysis_format_version": 1,
        "source_demo": str(path),
        "source_file_name": path.name,
        "source_bytes": path.stat().st_size,
        "source_sha256": digest,
        "header": header,
        "roster_count": len(roster),
        "updated_field_count": len(updated_fields),
        "input_related_updated_field_count": len(input_related_fields),
        "event_type_count": len(event_names),
        "event_counts": event_counts,
        "outer_frame_scan": outer,
        "nested_packet_scan": {
            "svc_usercmd_message_id": SVC_USERCMDS_ID,
            "svc_usercmd_message_count": svc_usercmd_count,
            "decoded_usercmd_command_count": usercmd_command_count,
            "netmessage_decode_failure_count": (
                len(net_audit.get("decode_failures", [])) if net_audit else None
            ),
            "source_report": str(net_audit_path) if net_audit_path else None,
        },
        "exact_input_carriers": {
            "dem_usercmd_outer_message_count": outer_dem_usercmd_count,
            "svc_usercmd_message_count": svc_usercmd_count,
            "decoded_cmsg_server_usercmd_count": usercmd_command_count,
            "m_nButtonDownMaskPrev_updated": raw_button_field_present,
            "exact_columns_in_tick_export": synthetic_exact_columns,
        },
        "observable_tick_export": {
            "rows": observable_rows,
            "columns": observed_columns,
            "transition_rows": transition_count,
            "transition_columns": transition_columns,
        },
        "conclusion": {
            "exact_player_key_record_absence_confirmed": exact_absence_confirmed,
            "scope": (
                "No DEM_UserCmd, no svc_UserCmds/CMsgServerUserCmd stream, and no "
                "networked m_nButtonDownMaskPrev were found. Observable movement/service "
                "states and action events are consequences, not a physical keyboard log."
            ),
        },
    }
    write_json(demo_dir / "forensic_summary.json", metadata)
    print(
        f"[{path.name}] complete: frames={outer['frame_count']} "
        f"DEM_UserCmd={outer_dem_usercmd_count} svc_UserCmds={svc_usercmd_count} "
        f"exact_absence={exact_absence_confirmed}",
        flush=True,
    )
    return metadata


def write_index(output_root: Path, results: Iterable[Mapping[str, Any]]) -> None:
    rows = []
    for result in results:
        outer = result["outer_frame_scan"]
        nested = result["nested_packet_scan"]
        carriers = result["exact_input_carriers"]
        rows.append(
            {
                "demo": result["source_file_name"],
                "bytes": result["source_bytes"],
                "sha256": result["source_sha256"],
                "map": result.get("header", {}).get("map_name"),
                "client_name": result.get("header", {}).get("client_name"),
                "outer_frames": outer["frame_count"],
                "exact_eof": outer["exact_eof"],
                "DEM_UserCmd": carriers["dem_usercmd_outer_message_count"],
                "svc_UserCmds": nested["svc_usercmd_message_count"],
                "CMsgServerUserCmd": nested["decoded_usercmd_command_count"],
                "m_nButtonDownMaskPrev": carriers["m_nButtonDownMaskPrev_updated"],
                "exact_key_record_absent": result["conclusion"][
                    "exact_player_key_record_absence_confirmed"
                ],
            }
        )
    write_json(output_root / "index.json", rows)
    if not rows:
        return
    with (output_root / "index.csv").open("w", encoding="utf-8", newline="") as output:
        writer = csv.DictWriter(output, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    args = parse_args()
    output_root = args.output_dir.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    audit_dir = args.audit_dir.resolve() if args.audit_dir else None
    results = [
        analyze_demo(
            demo,
            output_root,
            audit_dir,
            skip_observable_ticks=args.skip_observable_ticks,
            skip_events=args.skip_events,
        )
        for demo in args.demos
    ]
    write_index(output_root, results)


if __name__ == "__main__":
    main()
