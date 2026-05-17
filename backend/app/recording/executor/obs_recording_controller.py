"""
Safe OBS recording controller with per-call timeout and fresh-connection recovery.

All methods are async. The controller wraps OBSClient (synchronous) with:
- asyncio.wait_for hard timeout (belt-and-suspenders on top of obsws library timeout)
- Recovery via a fresh OBS WebSocket connection + GetRecordStatus to determine
  the actual OBS state when a response is not received.

Usage:
    ctrl = OBSRecordingController(obs_config, obs_client)
    await ctrl.start_record_safe()
    ...
    await ctrl.stop_record_safe()
    # On abort or in finally:
    await ctrl.force_stop_recording()
"""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

from .obs_client import OBSClient, OBSConnectionError, OBSRecordError
from ...env_utils import OBSConfig

logger = logging.getLogger(__name__)

# ── Tuneable constants ────────────────────────────────────────────────────────
OBS_CONNECT_TIMEOUT_SEC: float = 4.0   # handshake timeout for fresh connections
OBS_COMMAND_TIMEOUT_SEC: float = 5.0   # per-call command timeout
OBS_STATUS_TIMEOUT_SEC: float = 3.0    # GetRecordStatus timeout in recovery paths
OBS_STOP_RETRIES: int = 3              # max StopRecord retry attempts in force_stop


class OBSControlError(Exception):
    """Raised when a safe OBS control operation fails unrecoverably."""


class OBSRecordingController:
    """
    Async-safe OBS recording controller.

    Uses self._client for the normal (hot) path.
    Creates fresh OBSClient connections for recovery and force_stop so that
    a dead/stale recv-thread on the hot client does not block recovery.
    """

    def __init__(
        self,
        obs_config: OBSConfig,
        client: OBSClient,
        command_timeout_sec: float = OBS_COMMAND_TIMEOUT_SEC,
    ) -> None:
        self._config = obs_config
        self._client = client
        self._timeout = command_timeout_sec

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _call(self, fn, *, timeout: Optional[float] = None):
        """Run a synchronous OBSClient method in a thread with a hard asyncio timeout."""
        t = self._timeout if timeout is None else timeout
        try:
            return await asyncio.wait_for(asyncio.to_thread(fn), timeout=t + 1.0)
        except asyncio.TimeoutError:
            raise OBSRecordError(f"OBS call timed out after {t:.0f}s")

    async def _fresh_status(self) -> dict:
        """Open a fresh OBS connection, fetch GetRecordStatus, then disconnect."""
        fresh = OBSClient(
            self._config,
            handshake_timeout_sec=OBS_CONNECT_TIMEOUT_SEC,
            command_timeout_sec=OBS_STATUS_TIMEOUT_SEC,
        )
        try:
            await asyncio.to_thread(fresh.connect)
            status = await asyncio.wait_for(
                asyncio.to_thread(fresh.get_record_status),
                timeout=OBS_STATUS_TIMEOUT_SEC + 1.0,
            )
            return status
        finally:
            try:
                await asyncio.to_thread(fresh.disconnect)
            except Exception:
                pass

    async def _fresh_stop(self) -> Optional[str]:
        """Open a fresh OBS connection, send StopRecord, then disconnect.
        Returns outputPath or None."""
        fresh = OBSClient(
            self._config,
            handshake_timeout_sec=OBS_CONNECT_TIMEOUT_SEC,
            command_timeout_sec=OBS_STATUS_TIMEOUT_SEC,
        )
        try:
            await asyncio.to_thread(fresh.connect)
            path = await asyncio.wait_for(
                asyncio.to_thread(fresh.stop_record),
                timeout=OBS_STATUS_TIMEOUT_SEC + 1.0,
            )
            return path
        finally:
            try:
                await asyncio.to_thread(fresh.disconnect)
            except Exception:
                pass

    async def _fresh_resume(self) -> None:
        """Open a fresh OBS connection and send ResumeRecord."""
        fresh = OBSClient(
            self._config,
            handshake_timeout_sec=OBS_CONNECT_TIMEOUT_SEC,
            command_timeout_sec=OBS_STATUS_TIMEOUT_SEC,
        )
        try:
            await asyncio.to_thread(fresh.connect)
            await asyncio.wait_for(
                asyncio.to_thread(fresh.resume_record),
                timeout=OBS_STATUS_TIMEOUT_SEC + 1.0,
            )
        finally:
            try:
                await asyncio.to_thread(fresh.disconnect)
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Safe recording operations
    # ------------------------------------------------------------------

    async def start_record_safe(self) -> str:
        """
        Send StartRecord. On normal response, return immediately without waiting for
        GetRecordStatus — the caller must call demo_resume_silent_strict() right after.
        On timeout/error, recover via fresh GetRecordStatus.

        Returns "ok" or "ok_recovered".
        Raises OBSControlError when OBS is confirmed NOT recording after recovery.
        """
        logger.info("[RecordingV3][OBS] StartRecord request sent")
        try:
            await self._call(self._client.start_record)
            # Hot path: return immediately so demo_resume_silent_strict() can fire
            # without a 3-5s GetRecordStatus delay being recorded by OBS.
            logger.info("[RecordingV3][OBS] StartRecord response ok")
            return "ok"
        except (OBSRecordError, asyncio.TimeoutError) as exc:
            logger.warning(
                "[RecordingV3][OBS] StartRecord timeout; checking status with fresh connection (%s)",
                exc,
            )

        # Recovery via fresh connection
        try:
            status = await self._fresh_status()
        except Exception as e:
            logger.error("[RecordingV3][OBS] StartRecord recovery: fresh status failed: %s", e)
            raise OBSControlError(f"StartRecord recovery failed: {e}") from e

        if status.get("outputActive"):
            logger.info("[RecordingV3][OBS] StartRecord timeout but outputActive=true; treating as started")
            return "ok_recovered"

        logger.error("[RecordingV3][OBS] StartRecord timeout and outputActive=false; treating as failed")
        raise OBSControlError("StartRecord timed out and OBS is not recording")

    async def resume_record_safe(self) -> str:
        """
        Send ResumeRecord. On normal response, return immediately without waiting for
        GetRecordStatus — the caller must call demo_resume_silent_strict() right after.
        On timeout/error, recover via fresh GetRecordStatus.

        Returns "ok" or "ok_recovered".
        Raises OBSControlError when recovery fails or OBS is confirmed not recording.
        """
        logger.info("[RecordingV3][OBS] ResumeRecord request sent")
        try:
            await self._call(self._client.resume_record)
            # Hot path: return immediately so demo_resume_silent_strict() can fire
            # without a 3-5s GetRecordStatus delay being recorded by OBS.
            logger.info("[RecordingV3][OBS] ResumeRecord response ok")
            return "ok"
        except (OBSRecordError, asyncio.TimeoutError) as exc:
            logger.warning(
                "[RecordingV3][OBS] ResumeRecord timeout; checking status with fresh connection (%s)",
                exc,
            )

        # Recovery
        try:
            status = await self._fresh_status()
        except Exception as e:
            logger.error("[RecordingV3][OBS] ResumeRecord recovery: fresh status failed: %s", e)
            raise OBSControlError(f"ResumeRecord recovery failed: {e}") from e

        active = status.get("outputActive", False)
        paused = status.get("outputPaused", False)

        if active and not paused:
            logger.info("[RecordingV3][OBS] ResumeRecord recovered: outputActive=true outputPaused=false")
            return "ok_recovered"

        if active and paused:
            logger.warning("[RecordingV3][OBS] ResumeRecord: still paused after timeout; retrying with fresh connection")
            try:
                await self._fresh_resume()
                return "ok_recovered"
            except Exception as retry_e:
                logger.error("[RecordingV3][OBS] ResumeRecord fresh retry failed: %s", retry_e)
                raise OBSControlError(f"ResumeRecord failed after retry: {retry_e}") from retry_e

        logger.error("[RecordingV3][OBS] ResumeRecord failed: outputActive=false")
        raise OBSControlError("ResumeRecord failed: OBS is not recording")

    async def pause_record_safe(self) -> str:
        """
        Send PauseRecord. Demo must already be paused before calling this.
        Falls back to StopRecord if PauseRecord cannot be recovered.

        Returns "ok", "ok_recovered", or "fallback_stopped".
        Never raises — errors are logged, worst case is "fallback_stopped".
        """
        logger.info("[RecordingV3][OBS] PauseRecord request sent")
        try:
            await self._call(self._client.pause_record)
            status = await self._call(self._client.get_record_status, timeout=OBS_STATUS_TIMEOUT_SEC)
            logger.info(
                "[RecordingV3][OBS] PauseRecord response ok; outputPaused=%s",
                status.get("outputPaused"),
            )
            return "ok"
        except (OBSRecordError, asyncio.TimeoutError) as exc:
            logger.warning(
                "[RecordingV3][OBS] PauseRecord timeout; checking status with fresh connection (%s)",
                exc,
            )

        # Recovery
        try:
            status = await self._fresh_status()
        except Exception as e:
            logger.error("[RecordingV3][OBS] PauseRecord recovery: fresh status failed: %s", e)
            return "error"

        active = status.get("outputActive", False)
        paused = status.get("outputPaused", False)

        if not active:
            logger.info("[RecordingV3][OBS] PauseRecord: outputActive=false; OBS already stopped")
            return "ok"

        if paused:
            logger.info("[RecordingV3][OBS] PauseRecord recovered: outputPaused=true")
            return "ok_recovered"

        # Still active and not paused — fallback to StopRecord to avoid recording wrong footage
        logger.warning("[RecordingV3][OBS] PauseRecord failed, fallback StopRecord")
        try:
            await self._fresh_stop()
        except Exception as stop_e:
            logger.error("[RecordingV3][OBS] PauseRecord fallback StopRecord failed: %s", stop_e)
        return "fallback_stopped"

    async def stop_record_safe(self) -> Optional[str]:
        """
        Send StopRecord with timeout and retry recovery.

        Returns outputPath (or None if path unavailable).
        Does not raise — errors are logged and None is returned on complete failure.
        """
        logger.info("[RecordingV3][OBS] StopRecord request sent")
        try:
            path = await self._call(self._client.stop_record)
            logger.info("[RecordingV3][OBS] StopRecord response ok; path=%s", path)
            return path
        except (OBSRecordError, asyncio.TimeoutError) as exc:
            logger.warning(
                "[RecordingV3][OBS] StopRecord timeout; checking status with fresh connection (%s)",
                exc,
            )

        # Recovery loop
        for attempt in range(1, OBS_STOP_RETRIES + 1):
            try:
                status = await self._fresh_status()
                if not status.get("outputActive"):
                    logger.info("[RecordingV3][OBS] OBS stopped (confirmed via GetRecordStatus)")
                    return None
                logger.warning(
                    "[RecordingV3][OBS] outputActive=true after Stop timeout; retrying StopRecord (attempt %d)",
                    attempt,
                )
                path = await self._fresh_stop()
                logger.info("[RecordingV3][OBS] OBS stopped via fresh StopRecord; path=%s", path)
                return path
            except Exception as e:
                logger.error("[RecordingV3][OBS] StopRecord retry %d failed: %s", attempt, e)

        logger.error("[RecordingV3][OBS] StopRecord failed after %d retries", OBS_STOP_RETRIES)
        return None

    async def get_record_status_safe(self) -> dict:
        """
        Fetch current OBS record status using a fresh connection.
        Returns the status dict, or {} on failure (never raises).
        """
        try:
            return await self._fresh_status()
        except Exception as e:
            logger.warning("[RecordingV3][OBS] get_record_status_safe failed: %s", e)
            return {}

    async def force_stop_recording(self) -> bool:
        """
        Force-stop OBS recording using a fresh connection.

        Must NOT rely on self._client, which may have a dead recv thread.
        Used for abort handling and finally-block cleanup.

        Returns True if OBS is confirmed stopped (or was already stopped).
        Returns False only if all attempts failed.
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
                logger.error("[RecordingV3][ABORT] force stop attempt %d failed: %s", attempt, e)

        logger.error("[RecordingV3][ABORT] OBS force stop failed after %d attempts", OBS_STOP_RETRIES)
        return False
