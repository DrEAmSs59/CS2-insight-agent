"""Exact CS2 input tracks extracted from DEM ``svc_UserCmds`` messages.

The bundled Rust extractor owns protobuf/codegen-delta decoding and emits
slot-keyed compact tracks plus the userinfo identity timeline.  This module is
the Python boundary: it resolves the sidecar, caches one report per demo, binds
slots to Steam IDs, and projects exact masks into the existing keyboard HUD.
"""

from __future__ import annotations

from bisect import bisect_right
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from typing import Any, Mapping


_REPO_ROOT = Path(__file__).resolve().parents[2]
_EXTRACTOR_NAME = "demo-input-hud-track.exe" if sys.platform == "win32" else "demo-input-hud-track"
_REPORT_CACHE_MAX = 8
_CACHE_LOCK = threading.Lock()
_LOAD_LOCKS = tuple(threading.Lock() for _ in range(8))
_report_cache: dict[tuple[str, int, int], dict[str, Any]] = {}

_KEYS = ("W", "A", "S", "D", "jump", "crouch", "walk", "reload", "fire", "scope")


class InputCommandError(RuntimeError):
    """The authoritative UserCmd extractor could not produce a usable track."""


def _demo_key(demo_path: str | Path) -> tuple[str, int, int]:
    path = Path(demo_path).resolve()
    try:
        stat = path.stat()
    except OSError:
        return (str(path), 0, 0)
    return (str(path), int(stat.st_size), int(stat.st_mtime_ns))


def resolve_input_extractor() -> Path:
    configured = os.environ.get("CS2_INSIGHT_INPUT_EXTRACTOR", "").strip()
    if configured:
        path = Path(configured).expanduser().resolve()
        if not path.is_file():
            raise InputCommandError(f"configured input extractor does not exist: {path}")
        return path

    executable = Path(sys.executable).resolve()
    candidates = (
        executable.parent.parent / "tools" / _EXTRACTOR_NAME,
        _REPO_ROOT / "tools" / "demo-cosmetic-rewriter" / "target" / "release" / _EXTRACTOR_NAME,
        _REPO_ROOT / "frontend" / "src-tauri" / "bundle-resources" / "tools" / _EXTRACTOR_NAME,
    )
    for path in candidates:
        if path.is_file():
            return path.resolve()
    raise InputCommandError(
        f"{_EXTRACTOR_NAME} not found; build tools/demo-cosmetic-rewriter or set "
        "CS2_INSIGHT_INPUT_EXTRACTOR"
    )


def load_input_report(demo_path: str | Path) -> dict[str, Any]:
    key = _demo_key(demo_path)
    with _CACHE_LOCK:
        cached = _report_cache.get(key)
    if cached is not None:
        return cached

    load_lock = _LOAD_LOCKS[hash(key) % len(_LOAD_LOCKS)]
    with load_lock:
        with _CACHE_LOCK:
            cached = _report_cache.get(key)
        if cached is not None:
            return cached

        extractor = resolve_input_extractor()
        demo = Path(key[0])
        with tempfile.TemporaryDirectory(prefix="cs2-input-command-") as temp_dir:
            output = Path(temp_dir) / "report.json"
            creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
            try:
                completed = subprocess.run(
                    [
                        str(extractor),
                        "--input",
                        str(demo),
                        "--output",
                        str(output),
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=180,
                    shell=False,
                    creationflags=creationflags,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise InputCommandError(f"input extractor failed to start: {exc}") from exc
            if completed.returncode != 0:
                detail = (completed.stderr or completed.stdout).strip()
                raise InputCommandError(
                    f"input extractor exited with {completed.returncode}: {detail[:1000]}"
                )
            try:
                report = json.loads(output.read_text(encoding="utf-8"))
            except (OSError, ValueError, TypeError) as exc:
                raise InputCommandError("input extractor returned invalid JSON") from exc

        if not isinstance(report, dict) or int(report.get("format_version", 0)) < 3:
            raise InputCommandError("input extractor report is missing the v3 truth-source contract")
        if not isinstance(report.get("tracks"), list):
            raise InputCommandError("input extractor report contains no slot tracks")
        try:
            decode_errors = int(report.get("decode_errors", 0))
            missing_slots = int(report.get("commands_without_player_slot", 0))
        except (TypeError, ValueError, OverflowError) as exc:
            raise InputCommandError("input extractor report has invalid integrity counters") from exc
        if decode_errors or missing_slots:
            raise InputCommandError(
                "input extractor did not decode the complete command stream: "
                f"decode_errors={decode_errors}, commands_without_player_slot={missing_slots}"
            )
        with _CACHE_LOCK:
            if len(_report_cache) >= _REPORT_CACHE_MAX:
                _report_cache.pop(next(iter(_report_cache)))
            _report_cache[key] = report
        return report


def _base36(value: str) -> int:
    try:
        return int(value, 36)
    except (TypeError, ValueError) as exc:
        raise InputCommandError(f"invalid base36 input-track token: {value!r}") from exc


def _decode_changes(encoded: str) -> list[tuple[int, int]]:
    previous_tick = 0
    changes: list[tuple[int, int]] = []
    for token in encoded.split(","):
        parts = token.split(".")
        if len(parts) != 2:
            raise InputCommandError(f"invalid input-track token: {token!r}")
        previous_tick += _base36(parts[0])
        changes.append((previous_tick, _base36(parts[1])))
    return changes


def _identity_value(update: Mapping[str, Any]) -> tuple[int, int, str]:
    try:
        xuid = int(update.get("xuid", 0))
    except (TypeError, ValueError, OverflowError):
        xuid = 0
    try:
        steamid = int(update.get("steamid", 0))
    except (TypeError, ValueError, OverflowError):
        steamid = 0
    return xuid, steamid, str(update.get("name") or "")


def _identity_matches(
    update: Mapping[str, Any],
    *,
    steamid: str | int | None,
    player_name: str | None,
) -> bool:
    xuid, legacy_steamid, name = _identity_value(update)
    if steamid is not None:
        try:
            target = int(str(steamid).strip())
        except (TypeError, ValueError, OverflowError):
            return False
        return target in (xuid, legacy_steamid)
    return bool(player_name and name.casefold() == player_name.strip().casefold())


def _player_slot_intervals(
    report: Mapping[str, Any],
    *,
    steamid: str | int | None,
    player_name: str | None,
    start_tick: int,
    end_tick: int,
) -> list[tuple[int, int, int]]:
    raw_updates = report.get("player_identity_updates")
    if not isinstance(raw_updates, list):
        raise InputCommandError("input report contains no userinfo identity timeline")
    by_slot: dict[int, list[tuple[int, Mapping[str, Any]]]] = {}
    for raw in raw_updates:
        if not isinstance(raw, Mapping):
            continue
        try:
            slot = int(raw.get("player_slot"))
            tick = int(raw.get("demo_tick"))
        except (TypeError, ValueError, OverflowError):
            continue
        if tick == 0xFFFFFFFF:
            tick = 0
        by_slot.setdefault(slot, []).append((tick, raw))

    intervals: list[tuple[int, int, int]] = []
    for slot, updates in by_slot.items():
        updates.sort(key=lambda item: item[0])
        for index, (tick, update) in enumerate(updates):
            next_tick = updates[index + 1][0] if index + 1 < len(updates) else end_tick + 1
            interval_start = max(start_tick, tick)
            interval_end = min(end_tick + 1, next_tick)
            if interval_start >= interval_end:
                continue
            if _identity_matches(update, steamid=steamid, player_name=player_name):
                intervals.append((slot, interval_start, interval_end))
    if not intervals:
        target = str(steamid) if steamid is not None else repr(player_name)
        raise InputCommandError(f"input report has no userinfo slot for player {target}")
    return intervals


def _mask_union_between(changes: list[tuple[int, int]], start: int, end: int) -> int:
    if start >= end or not changes:
        return 0
    ticks = [tick for tick, _ in changes]
    index = bisect_right(ticks, start) - 1
    mask = changes[index][1] if index >= 0 else 0
    cursor = index + 1
    while cursor < len(changes) and changes[cursor][0] < end:
        mask |= changes[cursor][1]
        cursor += 1
    return mask


def _record_from_compact_mask(tick: int, mask: int) -> dict[str, Any]:
    record: dict[str, Any] = {"tick": tick}
    for bit, key in enumerate(_KEYS):
        record[key] = bool(mask & (1 << bit))
    return record


def extract_player_input_track(
    report: Mapping[str, Any],
    *,
    steamid: str | int | None,
    player_name: str | None,
    start_tick: int,
    end_tick: int,
    max_frames: int = 2000,
) -> list[dict[str, Any]]:
    start_i = int(start_tick)
    end_i = int(end_tick)
    if end_i < start_i:
        raise InputCommandError(f"invalid input-track tick window: {start_i}-{end_i}")
    intervals = _player_slot_intervals(
        report,
        steamid=steamid,
        player_name=player_name,
        start_tick=start_i,
        end_tick=end_i,
    )

    tracks_by_slot: dict[int, list[tuple[int, int]]] = {}
    for raw_track in report.get("tracks", []):
        if not isinstance(raw_track, Mapping):
            continue
        try:
            slot = int(raw_track.get("slot"))
        except (TypeError, ValueError, OverflowError):
            continue
        encoded = raw_track.get("encoded")
        if isinstance(encoded, str) and encoded:
            tracks_by_slot[slot] = _decode_changes(encoded)

    missing_slots = sorted({slot for slot, _, _ in intervals} - tracks_by_slot.keys())
    if missing_slots:
        raise InputCommandError(
            f"input report has no button track for matched player slot(s): {missing_slots}"
        )

    total = end_i - start_i + 1
    stride = max(1, (total + max(1, int(max_frames)) - 1) // max(1, int(max_frames)))
    sample_ticks = list(range(start_i, end_i + 1, stride))
    records: list[dict[str, Any]] = []
    for index, bucket_start in enumerate(sample_ticks):
        bucket_end = sample_ticks[index + 1] if index + 1 < len(sample_ticks) else end_i + 1
        compact_mask = 0
        for slot, identity_start, identity_end in intervals:
            overlap_start = max(bucket_start, identity_start)
            overlap_end = min(bucket_end, identity_end)
            compact_mask |= _mask_union_between(
                tracks_by_slot.get(slot, []), overlap_start, overlap_end,
            )
        records.append(_record_from_compact_mask(bucket_start, compact_mask))
    return records
