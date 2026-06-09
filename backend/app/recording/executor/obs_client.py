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
    # Scene & transition control
    # ------------------------------------------------------------------

    def get_scene_names(self) -> list[str]:
        """GetSceneList → sorted list of scene names."""
        self._require_connected()
        try:
            resp = self._ws.call(obs_requests.GetSceneList())
            scenes = (getattr(resp, "datain", None) or {}).get("scenes") or []
            return [str(s.get("sceneName") or "") for s in scenes if isinstance(s, dict)]
        except Exception as exc:
            raise OBSRecordError(f"GetSceneList failed: {exc}") from exc

    def create_scene(self, scene_name: str) -> None:
        """CreateScene. Silently succeeds if the scene already exists."""
        self._require_connected()
        try:
            self._ws.call(obs_requests.CreateScene(sceneName=scene_name))
        except Exception as exc:
            raise OBSRecordError(f"CreateScene({scene_name!r}) failed: {exc}") from exc

    def set_current_program_scene(self, scene_name: str) -> None:
        """SetCurrentProgramScene — triggers the current OBS transition."""
        self._require_connected()
        try:
            req = getattr(obs_requests, "SetCurrentProgramScene", None)
            if req is None:
                raise OBSRecordError("SetCurrentProgramScene not available in obs-websocket-py")
            self._ws.call(req(sceneName=scene_name))
        except OBSRecordError:
            raise
        except Exception as exc:
            raise OBSRecordError(f"SetCurrentProgramScene({scene_name!r}) failed: {exc}") from exc

    def set_current_scene_transition(self, name: str, duration_ms: int) -> None:
        """SetCurrentSceneTransition — sets the global OBS transition."""
        self._require_connected()
        try:
            req = getattr(obs_requests, "SetCurrentSceneTransition", None)
            if req is None:
                raise OBSRecordError("SetCurrentSceneTransition not available in obs-websocket-py")
            self._ws.call(req(transitionName=name, transitionDuration=duration_ms))
        except OBSRecordError:
            raise
        except Exception as exc:
            raise OBSRecordError(
                f"SetCurrentSceneTransition({name!r}, {duration_ms}ms) failed: {exc}"
            ) from exc

    def get_scene_transition_list(self) -> list[str]:
        """GetSceneTransitionList → list of available transition names."""
        self._require_connected()
        try:
            req = getattr(obs_requests, "GetSceneTransitionList", None)
            if req is None:
                return []
            resp = self._ws.call(req())
            transitions = (getattr(resp, "datain", None) or {}).get("transitions") or []
            return [str(t.get("transitionName") or "") for t in transitions if isinstance(t, dict)]
        except Exception as exc:
            logger.warning("GetSceneTransitionList failed: %s", exc)
            return []

    def scene_has_source(self, scene_name: str, source_name: str) -> bool:
        """Return True if scene already contains a source with source_name."""
        self._require_connected()
        try:
            req = getattr(obs_requests, "GetSceneItemList", None)
            if req is None:
                return False
            resp = self._ws.call(req(sceneName=scene_name))
            items = (getattr(resp, "datain", None) or {}).get("sceneItems") or []
            return any(
                isinstance(it, dict) and str(
                    it.get("sourceName") or it.get("sceneItemSourceName") or ""
                ) == source_name
                for it in items
            )
        except Exception:
            return False

    def add_color_source_to_scene(
        self, scene_name: str, source_name: str, color: int = 0xFF000000
    ) -> None:
        """Create a Color Source in scene_name. color is ARGB int (default opaque black)."""
        self._require_connected()
        try:
            req = getattr(obs_requests, "CreateInput", None)
            if req is None:
                raise OBSRecordError("CreateInput not available in obs-websocket-py")
            self._ws.call(
                req(
                    sceneName=scene_name,
                    inputName=source_name,
                    inputKind="color_source_v3",
                    inputSettings={"color": color, "width": 1920, "height": 1080},
                    sceneItemEnabled=True,
                )
            )
        except OBSRecordError:
            raise
        except Exception as exc:
            raise OBSRecordError(
                f"add_color_source_to_scene({scene_name!r}) failed: {exc}"
            ) from exc

    def set_input_settings(
        self, input_name: str, settings: dict, overlay: bool = True
    ) -> None:
        """Apply settings to an existing input (SetInputSettings).

        overlay=True merges with existing settings rather than replacing them.
        Raises OBSRecordError on failure.
        """
        self._require_connected()
        req = getattr(obs_requests, "SetInputSettings", None)
        if req is None:
            raise OBSRecordError("SetInputSettings not available")
        try:
            self._ws.call(req(inputName=input_name, inputSettings=settings, overlay=overlay))
            logger.info("OBSClient: settings applied to input %r", input_name)
        except Exception as exc:
            raise OBSRecordError(f"set_input_settings({input_name!r}) failed: {exc}") from exc

    def ensure_game_capture_in_scene(
        self,
        scene_name: str,
        capture_name: str,
        capture_kind: str = "game_capture",
        input_settings: dict | None = None,
    ) -> None:
        """Create a Game Capture input, link it to scene_name, and apply settings.

        Always applies input_settings (if provided) via SetInputSettings so that
        properties like capture_cursor=False are enforced even on already-existing
        sources.  Mirrors obs_director._obs_ensure_managed_game_capture + apply.
        Raises OBSRecordError on failure.
        """
        self._require_connected()
        already_in_scene = self.scene_has_source(scene_name, capture_name)

        if not already_in_scene:
            # Check if the input already exists globally (just not in this scene).
            input_exists = False
            try:
                req = getattr(obs_requests, "GetInputList", None)
                if req is not None:
                    resp = self._ws.call(req())
                    inputs = (getattr(resp, "datain", None) or {}).get("inputs") or []
                    input_exists = any(
                        isinstance(it, dict) and str(it.get("inputName") or "") == capture_name
                        for it in inputs
                    )
            except Exception as exc:
                logger.warning("OBSClient: GetInputList failed: %s", exc)

            try:
                if input_exists:
                    req = getattr(obs_requests, "CreateSceneItem", None)
                    if req is None:
                        raise OBSRecordError("CreateSceneItem not available")
                    self._ws.call(req(sceneName=scene_name, sourceName=capture_name))
                else:
                    req = getattr(obs_requests, "CreateInput", None)
                    if req is None:
                        raise OBSRecordError("CreateInput not available")
                    self._ws.call(
                        req(
                            sceneName=scene_name,
                            inputName=capture_name,
                            inputKind=capture_kind,
                            inputSettings=input_settings or {},
                            sceneItemEnabled=True,
                        )
                    )
                logger.info("OBSClient: game capture %r linked to scene %r", capture_name, scene_name)
            except OBSRecordError as exc:
                logger.warning(
                    "OBSClient: game capture creation/link failed (non-fatal, will still apply settings): %s", exc
                )
            except Exception as exc:
                logger.warning(
                    "OBSClient: game capture creation/link unexpected error (non-fatal, will still apply settings): %s", exc
                )

        # Always (re-)apply settings so properties like capture_cursor=False are
        # enforced even when the source already existed before this run.
        if input_settings:
            try:
                self.set_input_settings(capture_name, input_settings, overlay=True)
            except OBSRecordError as exc:
                logger.warning("OBSClient: apply game capture settings failed (non-fatal): %s", exc)

    def get_current_program_scene(self) -> Optional[str]:
        """GetCurrentProgramScene → scene name string, or None on failure."""
        self._require_connected()
        try:
            req = getattr(obs_requests, "GetCurrentProgramScene", None)
            if req is None:
                return None
            resp = self._ws.call(req())
            data = getattr(resp, "datain", None) or {}
            return str(data.get("currentProgramSceneName") or "") or None
        except Exception as exc:
            logger.warning("OBSClient: get_current_program_scene failed: %s", exc)
            return None

    def ensure_kb_overlay_in_scene(
        self,
        scene_name: str,
        overlay_url: str,
        source_name: str = "CS2 Keyboard Overlay",
    ) -> bool:
        """确保当前场景中存在键盘 Overlay Browser Source。

        - 如果已存在同名 source，仅更新 URL（幂等）。
        - 如果不存在，创建并全屏对齐到场景画布。
        返回 True 表示操作成功（或已存在）。
        """
        self._require_connected()
        try:
            video = self.get_video_settings()
            width = video.get("base_width") or 1920
            height = video.get("base_height") or 1080

            browser_settings = {
                "url": overlay_url,
                "width": width,
                "height": height,
                "fps": 60,
                "reroute_audio": False,
                "restart_when_active": False,  # 保持 WebSocket 常连，避免录制开始时刷新导致错过 load/resume 广播
            }

            already_in_scene = self.scene_has_source(scene_name, source_name)

            if already_in_scene:
                # 更新 URL 并确保 restart_when_active=False（保持 WebSocket 常连）
                try:
                    self.set_input_settings(source_name, {
                        "url": overlay_url,
                        "restart_when_active": False,
                    }, overlay=True)
                    logger.info("OBSClient: kb overlay %r already in scene %r — settings updated", source_name, scene_name)
                except Exception as e:
                    logger.warning("OBSClient: kb overlay settings update failed (non-fatal): %s", e)
                # URL 改变后 OBS Browser Source 不会自动重载，手动触发刷新
                try:
                    req_refresh = getattr(obs_requests, "PressInputPropertiesButton", None)
                    if req_refresh is not None:
                        self._ws.call(req_refresh(inputName=source_name, propertyName="refreshnocache"))
                        logger.info("OBSClient: kb overlay %r refreshed", source_name)
                except Exception as e:
                    logger.warning("OBSClient: kb overlay refresh failed (non-fatal): %s", e)
                return True

            # 检查是否全局已有同名 input（只是不在当前场景）
            input_exists = False
            try:
                req = getattr(obs_requests, "GetInputList", None)
                if req is not None:
                    resp = self._ws.call(req())
                    inputs = (getattr(resp, "datain", None) or {}).get("inputs") or []
                    input_exists = any(
                        isinstance(it, dict) and str(it.get("inputName") or "") == source_name
                        for it in inputs
                    )
            except Exception:
                pass

            if input_exists:
                # 已有 input，只需添加到场景
                req = getattr(obs_requests, "CreateSceneItem", None)
                if req:
                    self._ws.call(req(sceneName=scene_name, sourceName=source_name))
                self.set_input_settings(source_name, browser_settings, overlay=True)
            else:
                # 全新创建
                req = getattr(obs_requests, "CreateInput", None)
                if req is None:
                    raise OBSRecordError("CreateInput not available")
                self._ws.call(req(
                    sceneName=scene_name,
                    inputName=source_name,
                    inputKind="browser_source",
                    inputSettings=browser_settings,
                    sceneItemEnabled=True,
                ))

            # 全屏铺满画布
            try:
                item_id = self.get_scene_item_id(scene_name, source_name)
                if item_id is not None:
                    self.set_scene_item_transform(scene_name, item_id, {
                        "positionX": 0, "positionY": 0,
                        "scaleX": 1.0, "scaleY": 1.0,
                        "boundsWidth": float(width), "boundsHeight": float(height),
                        "boundsType": "OBS_BOUNDS_STRETCH",
                    })
            except Exception as te:
                logger.warning("OBSClient: kb overlay transform failed (non-fatal): %s", te)

            logger.info(
                "OBSClient: kb overlay Browser Source %r created in scene %r (%dx%d)",
                source_name, scene_name, width, height,
            )
            return True

        except Exception as exc:
            logger.warning("OBSClient: ensure_kb_overlay_in_scene failed: %s", exc)
            return False

    def get_video_settings(self) -> dict:
        """GetVideoSettings → dict with base_width, base_height, output_width, output_height."""
        self._require_connected()
        try:
            req = getattr(obs_requests, "GetVideoSettings", None)
            if req is None:
                return {}
            resp = self._ws.call(req())
            data = getattr(resp, "datain", None) or {}
            return {
                "base_width": int(data.get("baseWidth") or 1920),
                "base_height": int(data.get("baseHeight") or 1080),
                "output_width": int(data.get("outputWidth") or 1920),
                "output_height": int(data.get("outputHeight") or 1080),
            }
        except Exception as exc:
            logger.warning("OBSClient: get_video_settings failed: %s", exc)
            return {}

    def get_scene_item_id(self, scene_name: str, source_name: str) -> Optional[int]:
        """GetSceneItemId → scene item id int, or None if not found."""
        self._require_connected()
        try:
            req = getattr(obs_requests, "GetSceneItemId", None)
            if req is None:
                return None
            resp = self._ws.call(req(sceneName=scene_name, sourceName=source_name))
            data = getattr(resp, "datain", None) or {}
            raw = data.get("sceneItemId")
            return int(raw) if raw is not None else None
        except Exception as exc:
            logger.warning("OBSClient: get_scene_item_id(%r, %r) failed: %s", scene_name, source_name, exc)
            return None

    def set_scene_item_transform(
        self, scene_name: str, scene_item_id: int, transform: dict
    ) -> None:
        """SetSceneItemTransform — apply a transform dict to a scene item."""
        self._require_connected()
        try:
            req = getattr(obs_requests, "SetSceneItemTransform", None)
            if req is None:
                raise OBSRecordError("SetSceneItemTransform not available in obs-websocket-py")
            self._ws.call(
                req(
                    sceneName=scene_name,
                    sceneItemId=scene_item_id,
                    sceneItemTransform=transform,
                )
            )
        except OBSRecordError:
            raise
        except Exception as exc:
            raise OBSRecordError(
                f"set_scene_item_transform({scene_name!r}, {scene_item_id}) failed: {exc}"
            ) from exc

    def set_scene_item_index(
        self, scene_name: str, scene_item_id: int, index: int
    ) -> None:
        """SetSceneItemIndex — set a scene item's z-order index.

        Index 0 is the bottom of the stack; higher indices render on top.
        """
        self._require_connected()
        try:
            req = getattr(obs_requests, "SetSceneItemIndex", None)
            if req is None:
                raise OBSRecordError("SetSceneItemIndex not available in obs-websocket-py")
            self._ws.call(
                req(
                    sceneName=scene_name,
                    sceneItemId=scene_item_id,
                    sceneItemIndex=index,
                )
            )
        except OBSRecordError:
            raise
        except Exception as exc:
            raise OBSRecordError(
                f"set_scene_item_index({scene_name!r}, {scene_item_id}) failed: {exc}"
            ) from exc

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

            # 握手完成后将 socket 超时改为 None（阻塞模式），避免 receive thread 在
            # kb_track 提取等长时间操作期间因无数据而抛出 WebSocketTimeoutException
            try:
                if self.ws.sock:
                    self.ws.sock.settimeout(None)
            except Exception:
                pass

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
