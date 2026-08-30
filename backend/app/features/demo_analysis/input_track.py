from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from ...input_command import (
    InputCommandError,
    extract_player_input_track,
    load_input_report,
)


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


def detect_player_keyboard_input(
    *,
    demo_path: str | Path,
) -> bool | None:
    """Detect input exclusively from the Rust ``svc_UserCmds`` report.

    ``None`` means that the authoritative report could not be produced.  A
    demoparser column probe or inferred-key fallback is deliberately absent.
    """
    try:
        report = load_input_report(demo_path)
    except InputCommandError:
        return None
    return bool(report.get("tracks")) and int(report.get("button_updates", 0)) > 0


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
