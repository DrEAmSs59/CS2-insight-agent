"""
OBS recording controller — fire-and-observe pattern.

Root cause context
------------------
OBS WebSocket commands (StartRecord, ResumeRecord, etc.) sent on long-lived
connections frequently do not return a response (recv thread becomes stale).
The old code blocked waiting for that response for up to OBS_COMMAND_TIMEOUT_SEC
(5 s), causing 5 s of frozen demo footage at the start of every segment.

Fix: fire each command on a *fresh* connection (background task, ignore response),
then immediately poll GetRecordStatus on a *second* fresh connection every 80 ms
until the expected state is observed.  Typical latency: 50–300 ms.

The hot `client` passed at construction is kept for API compatibility but is
NOT used for any recording commands in this implementation.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Callable, Optional

from .obs_client import OBSClient, OBSConnectionError, OBSRecordError
from ...env_utils import OBSConfig

logger = logging.getLogger(__name__)

# ── Tunable constants ─────────────────────────────────────────────────────────
OBS_CONNECT_TIMEOUT_SEC: float = 4.0      # fresh-connection WebSocket handshake
OBS_COMMAND_TIMEOUT_SEC: float = 5.0      # bg-task max wait for command response
OBS_STATUS_TIMEOUT_SEC: float = 3.0       # GetRecordStatus in recovery / force-stop

# Fast-observe polling
OBS_FAST_START_DEADLINE_SEC: float = 1.2  # max wait: outputActive after StartRecord
OBS_FAST_RESUME_DEADLINE_SEC: float = 1.2 # max wait: active+unpaused after ResumeRecord
OBS_FAST_PAUSE_DEADLINE_SEC: float = 1.0  # max wait: paused after PauseRecord
OBS_FAST_STOP_DEADLINE_SEC: float = 5.0   # max wait: stopped after StopRecord
OBS_FAST_POLL_INTERVAL_SEC: float = 0.08  # 80 ms between polls
OBS_FAST_STATUS_TIMEOUT_SEC: float = 0.8  # per-poll GetRecordStatus timeout

OBS_STOP_RETRIES: int = 3                  # retries in force_stop_recording


class OBSControlError(Exception):
    """Raised when a safe OBS control operation fails unrecoverably."""


class OBSRecordingController:
    """
    Async-safe OBS recording controller using fire-and-observe.

    Each recording command is sent on a fresh OBS connection (background
    fire-and-forget task) while a separate fresh connection polls
    GetRecordStatus every 80 ms to verify the state transition.
    """

    def __init__(
        self,
        obs_config: OBSConfig,
        client: OBSClient,
        command_timeout_sec: float = OBS_COMMAND_TIMEOUT_SEC,
    ) -> None:
        self._config = obs_config
        # client is kept for backward-compatible API; not used for recording ops.
        self._client = client
        self._timeout = command_timeout_sec

    # ── Internal: fresh client factory ───────────────────────────────────────

    def _new_client(self, command_timeout: float = OBS_FAST_STATUS_TIMEOUT_SEC) -> OBSClient:
        return OBSClient(
            self._config,
            handshake_timeout_sec=OBS_CONNECT_TIMEOUT_SEC,
            command_timeout_sec=command_timeout,
        )

    # ── Internal: fire-and-forget command task ────────────────────────────────

    def _fire_bg(self, method_name: str, display_name: str) -> asyncio.Task:
        """
        Open a fresh OBS connection in a background task, call *method_name*,
        wait for response (up to OBS_COMMAND_TIMEOUT_SEC), then close.

        The response is logged but otherwise ignored — this is fire-and-forget.
        All exceptions are caught so the task never propagates an unhandled error.
        """
        async def _bg() -> None:
            fresh = self._new_client(command_timeout=OBS_COMMAND_TIMEOUT_SEC)
            try:
                await asyncio.to_thread(fresh.connect)
                method = getattr(fresh, method_name)
                try:
                    result = await asyncio.wait_for(
                        asyncio.to_thread(method),
                        timeout=OBS_COMMAND_TIMEOUT_SEC + 1.0,
                    )
                    logger.debug(
                        "[RecordingV3][OBS_FAST] %s bg response received (result=%r)",
                        display_name, result,
                    )
                except asyncio.TimeoutError:
                    logger.warning(
                        "[RecordingV3][OBS_FAST] %s bg response timed out (ignored)",
                        display_name,
                    )
                except Exception as _cmd_e:
                    logger.warning(
                        "[RecordingV3][OBS_FAST] %s bg command error (ignored): %s",
                        display_name, _cmd_e,
                    )
            except Exception as _conn_e:
                logger.warning(
                    "[RecordingV3][OBS_FAST] %s bg connect failed: %s",
                    display_name, _conn_e,
                )
            finally:
                try:
                    await asyncio.to_thread(fresh.disconnect)
                except Exception:
                    pass

        return asyncio.create_task(_bg())

    # ── Internal: status polling ──────────────────────────────────────────────

    async def _observe_state(
        self,
        display_name: str,
        predicate: Callable[[dict], bool],
        deadline_sec: float,
    ) -> dict:
        """
        Open a fresh OBS connection and poll GetRecordStatus every
        OBS_FAST_POLL_INTERVAL_SEC until *predicate* is satisfied or deadline.

        Returns the status dict that satisfied *predicate*.
        Raises OBSControlError on deadline or ≥5 consecutive poll errors.
        """
        poll_client = self._new_client(command_timeout=OBS_FAST_STATUS_TIMEOUT_SEC)
        try:
            await asyncio.to_thread(poll_client.connect)
        except Exception as _ce:
            raise OBSControlError(f"{display_name}: poll connection failed: {_ce}") from _ce

        try:
            deadline = time.monotonic() + deadline_sec
            consecutive_errors = 0
            while time.monotonic() < deadline:
                try:
                    status = await asyncio.wait_for(
                        asyncio.to_thread(poll_client.get_record_status),
                        timeout=OBS_FAST_STATUS_TIMEOUT_SEC + 0.5,
                    )
                    consecutive_errors = 0
                    if predicate(status):
                        return status
                except Exception as _pe:
                    consecutive_errors += 1
                    logger.debug(
                        "[RecordingV3][OBS_FAST] %s poll error #%d: %s",
                        display_name, consecutive_errors, _pe,
                    )
                    if consecutive_errors >= 5:
                        raise OBSControlError(
                            f"{display_name}: polling aborted after "
                            f"{consecutive_errors} consecutive errors"
                        )
                await asyncio.sleep(OBS_FAST_POLL_INTERVAL_SEC)
        finally:
            try:
                await asyncio.to_thread(poll_client.disconnect)
            except Exception:
                pass

        raise OBSControlError(
            f"{display_name}: expected state not observed within {deadline_sec:.1f}s"
        )

    async def _fast_observe(
        self,
        display_name: str,
        method_name: str,
        predicate: Callable[[dict], bool],
        deadline_sec: float,
    ) -> dict:
        """
        Fire *method_name* in background, then immediately poll for *predicate*.
        Logs fire timestamp and observed latency.
        """
        fire_t0 = time.monotonic()
        logger.info("[RecordingV3][OBS_FAST] %s fired", display_name)

        self._fire_bg(method_name, display_name)   # fire-and-forget

        status = await self._observe_state(display_name, predicate, deadline_sec)
        latency_ms = int((time.monotonic() - fire_t0) * 1000)
        logger.info(
            "[RecordingV3][OBS_FAST] %s observed after %d ms",
            display_name, latency_ms,
        )
        return status

    # ── Legacy fresh helpers (force_stop_recording only) ─────────────────────

    async def _fresh_status(self) -> dict:
        fresh = self._new_client(command_timeout=OBS_STATUS_TIMEOUT_SEC)
        try:
            await asyncio.to_thread(fresh.connect)
            return await asyncio.wait_for(
                asyncio.to_thread(fresh.get_record_status),
                timeout=OBS_STATUS_TIMEOUT_SEC + 1.0,
            )
        finally:
            try:
                await asyncio.to_thread(fresh.disconnect)
            except Exception:
                pass

    async def _fresh_stop(self) -> Optional[str]:
        fresh = self._new_client(command_timeout=OBS_STATUS_TIMEOUT_SEC)
        try:
            await asyncio.to_thread(fresh.connect)
            return await asyncio.wait_for(
                asyncio.to_thread(fresh.stop_record),
                timeout=OBS_STATUS_TIMEOUT_SEC + 1.0,
            )
        finally:
            try:
                await asyncio.to_thread(fresh.disconnect)
            except Exception:
                pass

    # ── Public recording operations ───────────────────────────────────────────

    async def start_record_safe(self) -> str:
        """
        Fire StartRecord; poll until outputActive=true (≤1.2 s).

        Returns "ok".
        Raises OBSControlError if the state is not observed in time.
        """
        await self._fast_observe(
            "StartRecord",
            "start_record",
            predicate=lambda s: bool(s.get("outputActive")),
            deadline_sec=OBS_FAST_START_DEADLINE_SEC,
        )
        return "ok"

    async def resume_record_safe(self) -> str:
        """
        Fire ResumeRecord; poll until outputActive=true AND outputPaused=false (≤1.2 s).

        Returns "ok".
        Raises OBSControlError if the state is not observed in time.
        """
        await self._fast_observe(
            "ResumeRecord",
            "resume_record",
            predicate=lambda s: bool(s.get("outputActive")) and not bool(s.get("outputPaused")),
            deadline_sec=OBS_FAST_RESUME_DEADLINE_SEC,
        )
        return "ok"

    async def pause_record_safe(self) -> str:
        """
        Fire PauseRecord; poll until paused OR stopped (≤1 s).

        Returns:
          "ok"               — OBS is recording and paused
          "fallback_stopped" — OBS stopped instead of pausing (no further resume possible)

        Never raises — errors are logged.
        """
        try:
            status = await self._fast_observe(
                "PauseRecord",
                "pause_record",
                predicate=lambda s: (
                    (bool(s.get("outputActive")) and bool(s.get("outputPaused")))
                    or not bool(s.get("outputActive", True))
                ),
                deadline_sec=OBS_FAST_PAUSE_DEADLINE_SEC,
            )
            if not status.get("outputActive", True):
                logger.warning(
                    "[RecordingV3][OBS_FAST] PauseRecord: OBS already stopped; "
                    "treating as fallback_stopped"
                )
                return "fallback_stopped"
            return "ok"
        except OBSControlError as _pe:
            logger.warning(
                "[RecordingV3][OBS_FAST] PauseRecord not observed; fallback StopRecord: %s",
                _pe,
            )

        # Fallback: fire StopRecord and wait for stop confirmation
        self._fire_bg("stop_record", "StopRecord_fallback")
        try:
            await self._observe_state(
                "StopRecord_fallback",
                predicate=lambda s: not bool(s.get("outputActive", True)),
                deadline_sec=3.0,
            )
        except OBSControlError as _se:
            logger.error(
                "[RecordingV3][OBS_FAST] StopRecord fallback also failed: %s", _se
            )
        return "fallback_stopped"

    async def stop_record_safe(self) -> Optional[str]:
        """
        Fire StopRecord; poll until outputActive=false (≤5 s).

        Returns outputPath if the command response arrives in time, else None.
        (None is expected when OBS is unresponsive; obs_director.py scan handles it.)
        Never raises.
        """
        fire_t0 = time.monotonic()
        logger.info("[RecordingV3][OBS_FAST] StopRecord fired")

        # Shared box so the bg task can pass back outputPath if the response arrives.
        output_path_box: list[Optional[str]] = [None]

        async def _fire_stop_capture() -> None:
            fresh = self._new_client(command_timeout=OBS_COMMAND_TIMEOUT_SEC)
            try:
                await asyncio.to_thread(fresh.connect)
                try:
                    path = await asyncio.wait_for(
                        asyncio.to_thread(fresh.stop_record),
                        timeout=OBS_COMMAND_TIMEOUT_SEC + 1.0,
                    )
                    if path:
                        output_path_box[0] = path
                        logger.info(
                            "[RecordingV3][OBS_FAST] StopRecord response path=%s", path
                        )
                    else:
                        logger.debug("[RecordingV3][OBS_FAST] StopRecord response: no path")
                except asyncio.TimeoutError:
                    logger.warning(
                        "[RecordingV3][OBS_FAST] StopRecord bg response timed out (ignored)"
                    )
                except Exception as _e:
                    logger.warning(
                        "[RecordingV3][OBS_FAST] StopRecord bg error (ignored): %s", _e
                    )
            except Exception as _conn_e:
                logger.warning(
                    "[RecordingV3][OBS_FAST] StopRecord bg connect failed: %s", _conn_e
                )
            finally:
                try:
                    await asyncio.to_thread(fresh.disconnect)
                except Exception:
                    pass

        asyncio.create_task(_fire_stop_capture())

        try:
            await self._observe_state(
                "StopRecord",
                predicate=lambda s: not bool(s.get("outputActive", True)),
                deadline_sec=OBS_FAST_STOP_DEADLINE_SEC,
            )
            latency_ms = int((time.monotonic() - fire_t0) * 1000)
            logger.info(
                "[RecordingV3][OBS_FAST] outputActive=false observed after %d ms",
                latency_ms,
            )
        except OBSControlError as _e:
            logger.error(
                "[RecordingV3][OBS_FAST] StopRecord: stop not confirmed: %s", _e
            )

        return output_path_box[0]

    async def get_record_status_safe(self) -> dict:
        """Fetch current OBS record status via a fresh connection. Returns {} on failure."""
        try:
            return await self._fresh_status()
        except Exception as e:
            logger.warning("[RecordingV3][OBS] get_record_status_safe failed: %s", e)
            return {}

    async def force_stop_recording(self) -> bool:
        """
        Force-stop OBS recording using fresh connections.
        Used in abort handling and finally-block cleanup.
        Returns True if confirmed stopped, False if all attempts failed.
        """
        logger.info("[RecordingV3][ABORT] force stopping OBS recording")

        for attempt in range(1, OBS_STOP_RETRIES + 1):
            try:
                status = await self._fresh_status()
                active = status.get("outputActive", False)
                paused = status.get("outputPaused", False)
                logger.info(
                    "[RecordingV3][ABORT] OBS status: outputActive=%s outputPaused=%s",
                    active, paused,
                )
                if not active:
                    logger.info("[RecordingV3][ABORT] OBS already stopped")
                    return True

                logger.info("[RecordingV3][ABORT] StopRecord sent (attempt %d)", attempt)
                await self._fresh_stop()
                logger.info("[RecordingV3][ABORT] OBS stopped")
                return True
            except Exception as e:
                logger.error(
                    "[RecordingV3][ABORT] force stop attempt %d failed: %s", attempt, e
                )

        logger.error(
            "[RecordingV3][ABORT] OBS force stop failed after %d attempts", OBS_STOP_RETRIES
        )
        return False
