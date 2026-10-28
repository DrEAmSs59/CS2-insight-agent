"""
OBS recording controller — fire-and-observe pattern.

Root cause context
------------------
OBS WebSocket commands (StartRecord, ResumeRecord, etc.) sent on long-lived
connections frequently do not return a response (recv thread becomes stale).
The old code blocked waiting for that response for up to OBS_COMMAND_TIMEOUT_SEC
(5 s), causing 5 s of frozen demo footage at the start of every segment.

Pause/resume use a fresh background connection and state observation.
Start and stop await their command responses for ownership and output paths.
Fire pause/resume on a *fresh* connection,
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

from .obs_client import OBSClient
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

    Commands use fresh connections. Start/stop responses establish ownership
    and output identity; pause/resume use background commands and status polling.
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
        self._owns_recording = False
        self._output_path = None
        self._stop_confirmation_pending = False

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
        Confirm StartRecord ownership, then observe outputActive=true.

        Returns "ok".
        Raises OBSControlError if the state is not observed in time.
        """
        if self._stop_confirmation_pending:
            raise OBSControlError("Previous OBS stop is not confirmed")
        self._output_path = None
        if (await self._fresh_status())["outputActive"]:
            raise OBSControlError("OBS is already recording; stop that recording before starting Insight")
        fresh = self._new_client(command_timeout=self._timeout)
        try:
            await asyncio.to_thread(fresh.connect)
            # A successful StartRecord response establishes ownership. Observing
            # another client's active recording cannot establish it.
            await asyncio.to_thread(fresh.start_record)
            self._owns_recording = True
            self._output_path = None
        except Exception as exc:
            raise OBSControlError(f"StartRecord failed: {exc}") from exc
        finally:
            await asyncio.to_thread(fresh.disconnect)
        await self._observe_state(
            "StartRecord", lambda status: bool(status["outputActive"]),
            OBS_FAST_START_DEADLINE_SEC,
        )
        return "ok"

    async def resume_record_safe(self) -> str:
        """
        Fire ResumeRecord; poll until outputActive=true AND outputPaused=false (≤1.2 s).

        Returns "ok".
        Raises OBSControlError if the state is not observed in time.
        """
        if not self._owns_recording:
            raise OBSControlError("No Insight-owned OBS recording")
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

        Raises if this controller does not own the recording or stopping fails.
        """
        if not self._owns_recording:
            raise OBSControlError("No Insight-owned OBS recording")
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

        await self.stop_record_safe()
        return "fallback_stopped"

    async def stop_record_safe(self) -> Optional[str]:
        """Wait for both the StopRecord response path and stopped state."""
        if not self._owns_recording and not self._stop_confirmation_pending:
            return self._output_path
        try:
            # The response, not a separate status poll, owns the output path.
            if self._owns_recording:
                self._output_path = await self._fresh_stop()
                self._owns_recording = False
                self._stop_confirmation_pending = True
            await self._observe_state(
                "StopRecord", lambda status: not status["outputActive"],
                OBS_FAST_STOP_DEADLINE_SEC,
            )
            self._stop_confirmation_pending = False
        except Exception as exc:
            raise OBSControlError(f"StopRecord finalization failed: {exc}") from exc
        return self._output_path

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
        if not self._owns_recording and not self._stop_confirmation_pending:
            return True
        logger.info("[RecordingV3][ABORT] force stopping OBS recording")

        for attempt in range(1, OBS_STOP_RETRIES + 1):
            try:
                if self._stop_confirmation_pending:
                    # Stop was accepted: only confirm its state, never stop a
                    # recording another client may have started since then.
                    await self.stop_record_safe()
                    return True
                status = await self._fresh_status()
                active = status.get("outputActive", False)
                paused = status.get("outputPaused", False)
                logger.info(
                    "[RecordingV3][ABORT] OBS status: outputActive=%s outputPaused=%s",
                    active, paused,
                )
                if not active:
                    self._owns_recording = False
                    logger.info("[RecordingV3][ABORT] OBS already stopped")
                    return True

                logger.info("[RecordingV3][ABORT] StopRecord sent (attempt %d)", attempt)
                await self.stop_record_safe()
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
