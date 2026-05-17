"""Thin synchronous wrapper around obswebsocket for OBS recording control.

All methods are synchronous. Call from async context via asyncio.to_thread().
"""

from __future__ import annotations

import logging
from typing import Optional

import websocket
from obswebsocket import obsws, requests as obs_requests
from obswebsocket import exceptions as obs_ws_exceptions
from obswebsocket.core import RecvThread

from ...env_utils import OBSConfig

logger = logging.getLogger(__name__)


class OBSConnectionError(Exception):
    pass


class OBSRecordError(Exception):
    pass


class OBSClient:
    def __init__(self, config: OBSConfig, handshake_timeout_sec: float = 4.0,
                 command_timeout_sec: float = 5.0):
        self._config = config
        self._handshake_timeout_sec = max(0.5, float(handshake_timeout_sec))
        self._command_timeout_sec = max(1.0, float(command_timeout_sec))
        self._ws: Optional[obsws] = None

    # ------------------------------------------------------------------
    # Connection management
    # ------------------------------------------------------------------

    def connect(self) -> None:
        """Connect to OBS WebSocket. Raises OBSConnectionError on failure."""
        host = self._config.host
        port = self._config.port
        password = self._config.password

        logger.info(
            "Connecting to OBS WebSocket ws://%s:%s (handshake timeout=%.1fs)...",
            host,
            port,
            self._handshake_timeout_sec,
        )
        try:
            # Use a patched obsws subclass that honours a handshake timeout,
            # mirroring the _ObswsBoundedHandshake pattern used in obs_director.py.
            client = _BoundedHandshakeOBSWS(
                host=host,
                port=port,
                password=password,
                handshake_timeout_sec=self._handshake_timeout_sec,
                command_timeout_sec=self._command_timeout_sec,
            )
            client.connect()
            self._ws = client
            logger.info("OBSClient: connected to OBS WebSocket at %s:%s", host, port)
        except obs_ws_exceptions.ConnectionFailure as exc:
            raise OBSConnectionError(f"Failed to connect to OBS: {exc}") from exc
        except Exception as exc:
            raise OBSConnectionError(f"Unexpected error connecting to OBS: {exc}") from exc

    def disconnect(self) -> None:
        """Disconnect cleanly. No-op if not connected."""
        if self._ws is None:
            return
        try:
            self._ws.disconnect()
            logger.info("OBSClient: disconnected from OBS WebSocket")
        except Exception as exc:
            logger.warning("OBSClient: error during disconnect (ignored): %s", exc)
        finally:
            self._ws = None

    def is_connected(self) -> bool:
        return self._ws is not None

    @property
    def config(self) -> OBSConfig:
        return self._config

    # ------------------------------------------------------------------
    # Recording control
    # ------------------------------------------------------------------

    def start_record(self) -> None:
        """Call OBS StartRecord. Raises OBSRecordError if already recording or call fails."""
        self._require_connected()
        try:
            response = self._ws.call(obs_requests.StartRecord())
            logger.debug("OBSClient: StartRecord response: %s", response)
        except obs_ws_exceptions.MessageTimeout as exc:
            raise OBSRecordError(f"StartRecord timed out: {exc}") from exc
        except Exception as exc:
            raise OBSRecordError(f"StartRecord failed: {exc}") from exc

    def pause_record(self) -> None:
        """Call OBS PauseRecord. Raises OBSRecordError on failure."""
        self._require_connected()
        try:
            response = self._ws.call(obs_requests.PauseRecord())
            logger.debug("OBSClient: PauseRecord response: %s", response)
        except obs_ws_exceptions.MessageTimeout as exc:
            raise OBSRecordError(f"PauseRecord timed out: {exc}") from exc
        except Exception as exc:
            raise OBSRecordError(f"PauseRecord failed: {exc}") from exc

    def resume_record(self) -> None:
        """Call OBS ResumeRecord. Raises OBSRecordError on failure."""
        self._require_connected()
        try:
            response = self._ws.call(obs_requests.ResumeRecord())
            logger.debug("OBSClient: ResumeRecord response: %s", response)
        except obs_ws_exceptions.MessageTimeout as exc:
            raise OBSRecordError(f"ResumeRecord timed out: {exc}") from exc
        except Exception as exc:
            raise OBSRecordError(f"ResumeRecord failed: {exc}") from exc

    def stop_record(self) -> Optional[str]:
        """Call OBS StopRecord. Returns the output file path if available, else None."""
        self._require_connected()
        try:
            response = self._ws.call(obs_requests.StopRecord())
            logger.debug("OBSClient: StopRecord response: %s", response)
            # Try to extract outputPath from the response
            output_path: Optional[str] = None
            try:
                output_path = response.datain.get("outputPath") if response.datain else None
            except Exception:
                pass
            if output_path:
                logger.info("OBSClient: recording saved to %s", output_path)
            return output_path
        except obs_ws_exceptions.MessageTimeout as exc:
            raise OBSRecordError(f"StopRecord timed out: {exc}") from exc
        except Exception as exc:
            raise OBSRecordError(f"StopRecord failed: {exc}") from exc

    def get_record_status(self) -> dict:
        """Call OBS GetRecordStatus. Returns dict with 'outputActive', 'outputPaused', 'outputPath'."""
        self._require_connected()
        try:
            response = self._ws.call(obs_requests.GetRecordStatus())
            data = response.datain or {}
            return {
                "outputActive": data.get("outputActive", False),
                "outputPaused": data.get("outputPaused", False),
                "outputPath": data.get("outputPath", None),
            }
        except obs_ws_exceptions.MessageTimeout as exc:
            raise OBSRecordError(f"GetRecordStatus timed out: {exc}") from exc
        except Exception as exc:
            raise OBSRecordError(f"GetRecordStatus failed: {exc}") from exc

    def get_output_path(self) -> Optional[str]:
        """Return current OBS output path from GetRecordStatus, or None."""
        try:
            status = self.get_record_status()
            return status.get("outputPath") or None
        except OBSRecordError as exc:
            logger.warning("OBSClient: could not retrieve output path: %s", exc)
            return None

    def get_record_directory(self) -> Optional[str]:
        """Return the OBS recording output directory path, or None if unavailable."""
        self._require_connected()
        try:
            req = getattr(obs_requests, "GetRecordDirectory", None)
            if req is None:
                logger.debug("OBSClient: GetRecordDirectory not available in obswebsocket")
                return None
            response = self._ws.call(req())
            datain = getattr(response, "datain", None) or {}
            raw = (
                datain.get("recordDirectory")
                or datain.get("record_directory")
                or datain.get("record-directory")
            )
            if raw:
                logger.debug("OBSClient: OBS record directory: %s", raw)
            return str(raw) if raw else None
        except Exception as exc:
            logger.warning("OBSClient: get_record_directory failed: %s", exc)
            return None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _require_connected(self) -> None:
        if self._ws is None:
            raise OBSConnectionError("OBSClient is not connected. Call connect() first.")


class _BoundedHandshakeOBSWS(obsws):
    """obsws subclass that passes a timeout to WebSocket.connect() to avoid
    blocking indefinitely when OBS is not running, and sets per-call command timeout."""

    def __init__(
        self,
        host: str = "localhost",
        port: int = 4444,
        password: str = "",
        *,
        handshake_timeout_sec: float = 4.0,
        command_timeout_sec: float = 5.0,
    ):
        self._handshake_timeout_sec = handshake_timeout_sec
        # obsws `timeout` controls how long call() waits for a response (seconds).
        super().__init__(host, port, password, timeout=max(1, int(command_timeout_sec)))

    def connect(self):
        try:
            self.ws = websocket.WebSocket()
            url = "ws://{}:{}".format(self.host, self.port)
            logger.debug(
                "_BoundedHandshakeOBSWS: connecting to %s (timeout=%.1fs)",
                url,
                self._handshake_timeout_sec,
            )
            self.ws.connect(url, timeout=self._handshake_timeout_sec)

            # Perform authentication (obsws v5 protocol)
            if getattr(self, "legacy", None):
                self._auth_legacy()
            else:
                self._auth()

            # Start receive thread
            if getattr(self, "thread_recv", None) is not None:
                self.thread_recv.running = False
            self.thread_recv = RecvThread(self)
            self.thread_recv.daemon = True
            self.thread_recv.start()

            if getattr(self, "on_connect", None):
                self.on_connect(self)
        except OSError as exc:
            raise obs_ws_exceptions.ConnectionFailure(str(exc)) from exc
