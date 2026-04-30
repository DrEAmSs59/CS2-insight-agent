"""Tiny CS2 Game State Integration ready gate for recording startup."""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)

_ready_event = threading.Event()
_payload_cond = threading.Condition()
_lock = threading.Lock()
_last_payload: dict[str, Any] = {}
_last_payload_at = 0.0
_last_ready_at = 0.0
_last_summary_log_at = 0.0


def reset_gsi_ready() -> None:
    global _last_payload, _last_payload_at, _last_ready_at, _last_summary_log_at
    with _lock:
        _last_payload = {}
        _last_payload_at = 0.0
        _last_ready_at = 0.0
        _last_summary_log_at = 0.0
        _ready_event.clear()
    with _payload_cond:
        _payload_cond.notify_all()


def _payload_has_demo_world(payload: dict[str, Any]) -> bool:
    if not isinstance(payload, dict):
        return False
    map_obj = payload.get("map") if isinstance(payload.get("map"), dict) else {}
    player_obj = payload.get("player") if isinstance(payload.get("player"), dict) else {}
    round_obj = payload.get("round") if isinstance(payload.get("round"), dict) else {}
    provider_obj = payload.get("provider") if isinstance(payload.get("provider"), dict) else {}
    phase_obj = payload.get("phase_countdowns") if isinstance(payload.get("phase_countdowns"), dict) else {}
    allplayers_obj = payload.get("allplayers") if isinstance(payload.get("allplayers"), dict) else {}

    map_name = str(map_obj.get("name") or "").strip()
    map_mode = str(map_obj.get("mode") or "").strip()
    map_phase = str(map_obj.get("phase") or "").strip().lower()
    player_activity = str(player_obj.get("activity") or "").strip().lower()
    round_phase = str(round_obj.get("phase") or "").strip().lower()
    phase_name = str(phase_obj.get("phase") or "").strip().lower()

    if player_activity in {"menu", "loading"}:
        return False

    has_map_state = bool(map_name or map_mode or map_phase or map_obj.get("round") is not None)
    has_round_state = bool(round_phase or phase_name)
    has_allplayers_state = bool(allplayers_obj)

    if not has_map_state and not has_round_state and not has_allplayers_state:
        return False

    if map_phase in {"warmup", "live", "intermission", "gameover"}:
        return True
    if has_round_state or has_allplayers_state:
        return True
    if player_activity in {"playing", "textinput", "spectating"} and has_map_state:
        return True
    return has_map_state


def _payload_summary(payload: dict[str, Any]) -> str:
    map_obj = payload.get("map") if isinstance(payload.get("map"), dict) else {}
    player_obj = payload.get("player") if isinstance(payload.get("player"), dict) else {}
    round_obj = payload.get("round") if isinstance(payload.get("round"), dict) else {}
    phase_obj = payload.get("phase_countdowns") if isinstance(payload.get("phase_countdowns"), dict) else {}
    allplayers_obj = payload.get("allplayers") if isinstance(payload.get("allplayers"), dict) else {}
    return (
        f"keys={sorted(payload.keys())} "
        f"map.name={map_obj.get('name')!r} map.mode={map_obj.get('mode')!r} map.phase={map_obj.get('phase')!r} "
        f"map.round={map_obj.get('round')!r} player.activity={player_obj.get('activity')!r} "
        f"round.phase={round_obj.get('phase')!r} phase={phase_obj.get('phase')!r} allplayers={len(allplayers_obj)}"
    )


def notify_gsi_payload(payload: dict[str, Any]) -> bool:
    global _last_payload, _last_payload_at, _last_ready_at, _last_summary_log_at
    ready = _payload_has_demo_world(payload)
    with _lock:
        _last_payload = payload if isinstance(payload, dict) else {}
        _last_payload_at = time.monotonic()
        if ready:
            _last_ready_at = time.monotonic()
            _ready_event.set()
    with _payload_cond:
        _payload_cond.notify_all()
    if ready:
        map_name = ((_last_payload.get("map") or {}).get("name") if isinstance(_last_payload.get("map"), dict) else "")
        logger.info("CS2 GSI ready: map=%s", map_name)
    else:
        now = time.monotonic()
        if now - _last_summary_log_at >= 2.0:
            _last_summary_log_at = now
            logger.info("CS2 GSI not ready yet: %s", _payload_summary(payload if isinstance(payload, dict) else {}))
    return ready


def wait_gsi_ready(timeout: float) -> bool:
    return _ready_event.wait(max(0.0, float(timeout)))


def is_gsi_ready() -> bool:
    return _ready_event.is_set()


def gsi_status() -> dict[str, Any]:
    with _lock:
        return {
            "ready": _ready_event.is_set(),
            "last_payload_at": _last_payload_at,
            "last_ready_at": _last_ready_at,
            "last_payload": _last_payload,
        }


def wait_gsi_payload_after(since: float, timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + max(0.0, float(timeout))
    with _payload_cond:
        while True:
            with _lock:
                if _last_payload_at > since and _last_payload:
                    return {
                        "last_payload_at": _last_payload_at,
                        "last_ready_at": _last_ready_at,
                        "last_payload": _last_payload,
                    }
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                with _lock:
                    return {
                        "last_payload_at": _last_payload_at,
                        "last_ready_at": _last_ready_at,
                        "last_payload": _last_payload,
                    }
            _payload_cond.wait(min(remaining, 0.25))
