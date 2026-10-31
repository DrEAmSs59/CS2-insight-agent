"""Low-latency bridge for the in-demo Panorama recording controller.

Panorama owns all demo truth and transitions.  The backend reads only tagged
phase events from the session's engine log so it can align OBS start/pause/stop;
it never estimates the current demo tick and never consults GSI.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import logging
from pathlib import Path
import re
import time
from typing import Any, Iterable, Mapping, Optional

from ..models import RecordingPlan
from .spec_controller import obs_spec_slot

logger = logging.getLogger(__name__)

_EVENT_RE = re.compile(
    r"CS2I_RC:(?P<session>[A-Za-z0-9_-]+):"
    r"(?P<event>BOOT|READY|STARTED|ENDED|COMPLETE|ERROR):"
    r"(?P<operation>[A-Za-z0-9_-]+):"
    r"(?P<tick>-?\d+):(?P<xuid>\d*)"
    r"(?::body:(?P<pawn>\d+):(?P<mode>-?\d+))?"
)


class PanoramaControlError(RuntimeError):
    pass


class PanoramaControlTimeout(PanoramaControlError):
    pass


class PanoramaControlAborted(PanoramaControlError):
    pass


@dataclass(frozen=True)
class PanoramaControlEvent:
    event: str
    operation_id: str
    tick: int
    xuid: str
    received_monotonic: float
    observer_pawn: int | None = None
    observer_mode: int | None = None


def build_recording_control_payload(
    plans: Iterable[RecordingPlan],
    *,
    session_id: str,
) -> dict[str, Any]:
    """Flatten plans in execution order and attach stable operation ids."""
    segments: list[dict[str, Any]] = []
    operation_index = 0
    for plan in plans:
        for segment in plan.segments:
            if segment.disabled:
                continue
            target_slot = int(obs_spec_slot(segment, plan.demo_path) or 0)
            target_xuid = str(segment.target_steamid64 or "")
            if target_slot < 1 or not target_xuid:
                raise PanoramaControlError(
                    f"segment {segment.segment_index} has no direct spectator identity"
                )
            operation_id = f"op{operation_index}"
            operation_index += 1
            segment.metadata["panorama_operation_id"] = operation_id
            segments.append(
                {
                    "operation_id": operation_id,
                    "start_tick": int(segment.start_tick),
                    "end_tick": int(segment.end_tick),
                    "target_slot": target_slot,
                    "target_xuid": target_xuid,
                    "spec_mode": 5,
                }
            )
            if segment.metadata.get("obs_body_timeline"):
                from ..obs_observer import validate_timeline
                segments[-1]["obs_body_timeline"] = validate_timeline(
                    segment.metadata["obs_body_timeline"], segment.start_tick, segment.end_tick,
                    target_slot, segment.metadata.get("obs_controller_pawn"))
    if not segments:
        raise PanoramaControlError("recording control plan has no active segments")
    return {"session_id": session_id, "segments": segments}


class PanoramaControlBridge:
    """Tail one unique engine log and expose structured control events."""

    def __init__(
        self,
        log_path: str | Path,
        session_id: str,
        *,
        abort_event: Optional[asyncio.Event] = None,
        poll_interval_sec: float = 0.02,
    ) -> None:
        self.log_path = Path(log_path)
        self.session_id = str(session_id)
        self._abort_event = abort_event
        self._poll_interval_sec = max(0.005, float(poll_interval_sec))
        self._offset = 0
        self._partial = b""
        self._events: list[PanoramaControlEvent] = []

    def _read_new_events(self) -> None:
        try:
            size = self.log_path.stat().st_size
        except OSError:
            return
        if size < self._offset:
            self._offset = 0
            self._partial = b""
        try:
            with self.log_path.open("rb") as handle:
                handle.seek(self._offset)
                chunk = handle.read()
                self._offset = handle.tell()
        except (FileNotFoundError, PermissionError, OSError):
            return
        if not chunk:
            return
        data = self._partial + chunk
        lines = data.splitlines(keepends=True)
        self._partial = b""
        if lines and not lines[-1].endswith((b"\n", b"\r")):
            self._partial = lines.pop()
        for raw_line in lines:
            line = raw_line.decode("utf-8", errors="replace")
            match = _EVENT_RE.search(line)
            if not match or match.group("session") != self.session_id:
                continue
            event = PanoramaControlEvent(
                event=match.group("event"),
                operation_id=match.group("operation"),
                tick=int(match.group("tick")),
                xuid=match.group("xuid"),
                received_monotonic=time.monotonic(),
                observer_pawn=int(match.group("pawn")) if match.group("pawn") else None,
                observer_mode=int(match.group("mode")) if match.group("mode") else None,
            )
            logger.info(
                "[RecordingV3][Panorama] event=%s operation=%s tick=%d xuid=%s",
                event.event,
                event.operation_id,
                event.tick,
                event.xuid or "(none)",
            )
            self._events.append(event)

    def _pop_matching(
        self,
        event_name: str,
        operation_id: Optional[str],
    ) -> Optional[PanoramaControlEvent]:
        # Every ERROR stops this controller, even when it happened in another
        # operation or before the first one. Do not start OBS on a stale READY.
        for event in self._events:
            if event.event == "ERROR":
                raise PanoramaControlError(
                    f"Panorama controller failed at {event.operation_id} tick {event.tick}"
                )
        for index, event in enumerate(self._events):
            operation_matches = operation_id is None or event.operation_id == operation_id
            if event.event == event_name and operation_matches:
                return self._events.pop(index)
        return None

    async def wait_for(
        self,
        event_name: str,
        *,
        operation_id: Optional[str] = None,
        timeout_sec: float,
    ) -> PanoramaControlEvent:
        deadline = time.monotonic() + max(0.05, float(timeout_sec))
        while True:
            if self._abort_event is not None and self._abort_event.is_set():
                raise PanoramaControlAborted("recording aborted")
            self._read_new_events()
            event = self._pop_matching(event_name, operation_id)
            if event is not None:
                return event
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                target = f" for {operation_id}" if operation_id else ""
                raise PanoramaControlTimeout(
                    f"timed out waiting for Panorama {event_name}{target}"
                )
            await asyncio.sleep(min(self._poll_interval_sec, remaining))

    def snapshot(self) -> Mapping[str, Any]:
        self._read_new_events()
        return {
            "session_id": self.session_id,
            "log_path": str(self.log_path),
            "offset": self._offset,
            "buffered_events": [event.event for event in self._events],
        }
