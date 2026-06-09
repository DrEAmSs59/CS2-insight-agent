"""OBS black-scene fade transition controller.

Manages scene lifecycle (game scene + black scene) and fires fade-in/fade-out
transitions at segment boundaries.  Completely independent of OBSRecordingController
— never touches StartRecord / PauseRecord / ResumeRecord / StopRecord.

All public async methods are safe to call even when not ready (returns True as no-op).
All OBS failures are logged as warnings and return False — never raise.
"""
from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from typing import Optional
from ...env_utils import OBSConfig
from .obs_client import OBSClient, OBSRecordError

logger = logging.getLogger(__name__)

_BLACK_COLOR_SOURCE_NAME = "CS2 Insight Black Source"
_GAME_CAPTURE_INPUT_NAME = "CS2 Insight Game Capture"


def _game_capture_settings() -> dict:
    """Build OBS Game Capture input settings matching the legacy managed capture.

    Mirrors obs_director._obs_managed_game_capture_settings():
    - capture_mode: window (env CS2_INSIGHT_OBS_GAME_CAPTURE_MODE)
    - window: Counter-Strike 2:SDL_app:cs2.exe (env CS2_INSIGHT_OBS_GAME_CAPTURE_WINDOW)
    - capture_cursor: False  (always — hides mouse pointer from the recording)
    """
    window = (
        os.environ.get("CS2_INSIGHT_OBS_GAME_CAPTURE_WINDOW", "").strip()
        or "Counter-Strike 2:SDL_app:cs2.exe"
    )
    capture_mode = (
        os.environ.get("CS2_INSIGHT_OBS_GAME_CAPTURE_MODE", "").strip()
        or "window"
    )
    return {
        "capture_mode": capture_mode,
        "window": window,
        "capture_cursor": False,
    }


@dataclass
class FadeConfig:
    enabled: bool
    transition_name: str
    duration_ms: int
    game_scene_name: str
    black_scene_name: str


class OBSFadeController:
    """Async-safe OBS scene fade controller.

    Call ``setup()`` once before recording starts.  Then call ``fade_to_black()``
    and ``fade_to_game()`` at segment boundaries.

    All methods use **fresh** OBS connections (same pattern as OBSRecordingController)
    to avoid stale-receive-thread issues on long-lived sessions.
    """

    def __init__(self, obs_config: OBSConfig, fade_config: FadeConfig) -> None:
        self._obs_config = obs_config
        self._cfg = fade_config
        self._ready = False
        # Pre-warmed client held between prime_fade_to_game() and execute_primed_fade_to_game()
        # so the scene switch fires with near-zero connection latency after StartRecord/ResumeRecord.
        self._primed_client: Optional[OBSClient] = None

    @property
    def is_ready(self) -> bool:
        return self._ready

    def _new_client(self) -> OBSClient:
        return OBSClient(
            self._obs_config,
            handshake_timeout_sec=4.0,
            command_timeout_sec=5.0,
        )

    # ------------------------------------------------------------------
    # setup
    # ------------------------------------------------------------------

    async def setup(self) -> bool:
        """Ensure game scene + game capture exist in OBS (always).

        When transitions are enabled, also ensures the black scene and validates
        the transition name, then sets _ready = True so fade methods fire.

        Returns True when _ready (transitions active).
        Returns False in hard-cut mode (transitions disabled) or on OBS failure.
        """
        client = self._new_client()
        try:
            await asyncio.to_thread(client.connect)
            game_ok = await asyncio.to_thread(self._ensure_game_scene, client)
            if not game_ok:
                return False

            if not self._cfg.enabled:
                logger.info("[OBSFade] transition disabled; game scene ensured, running in hard-cut mode")
                return False

            transition_ok = await asyncio.to_thread(self._ensure_transition_scenes, client)
            if transition_ok:
                self._ready = True
                logger.info(
                    "[OBSFade] setup complete — game=%r black=%r transition=%r %dms",
                    self._cfg.game_scene_name,
                    self._cfg.black_scene_name,
                    self._cfg.transition_name,
                    self._cfg.duration_ms,
                )
            return transition_ok
        except Exception as exc:
            logger.warning("[OBSFade] setup failed: %s", exc)
            return False
        finally:
            try:
                await asyncio.to_thread(client.disconnect)
            except Exception:
                pass

    def _ensure_game_scene(self, client: OBSClient) -> bool:
        """Create game scene + game capture if missing. Always runs regardless of transition setting."""
        try:
            existing = set(client.get_scene_names())
        except OBSRecordError as exc:
            logger.warning("[OBSFade] GetSceneList failed: %s", exc)
            return False

        game = self._cfg.game_scene_name
        if game not in existing:
            try:
                client.create_scene(game)
                logger.info("[OBSFade] created game scene: %r", game)
            except OBSRecordError as exc:
                logger.warning("[OBSFade] create game scene failed: %s", exc)
                return False

        try:
            client.ensure_game_capture_in_scene(
                game,
                _GAME_CAPTURE_INPUT_NAME,
                input_settings=_game_capture_settings(),
            )
        except Exception as exc:
            logger.warning("[OBSFade] ensure game capture failed: %s", exc)
            # non-fatal — scene exists but capture may need manual setup

        # Stretch game capture to fill the OBS canvas.
        try:
            video = client.get_video_settings()
            bw = video.get("base_width", 1920)
            bh = video.get("base_height", 1080)
            item_id = client.get_scene_item_id(game, _GAME_CAPTURE_INPUT_NAME)
            if item_id is not None:
                client.set_scene_item_transform(
                    game,
                    item_id,
                    {
                        "boundsType": "OBS_BOUNDS_STRETCH",
                        "boundsWidth": float(bw),
                        "boundsHeight": float(bh),
                        "positionX": 0.0,
                        "positionY": 0.0,
                        "rotation": 0.0,
                    },
                )
                logger.info("[OBSFade] set game capture transform: stretch to %dx%d", bw, bh)
        except Exception as exc:
            logger.warning("[OBSFade] set game capture transform failed (non-fatal): %s", exc)

        # Switch OBS to the game scene so recording captures CS2 regardless of
        # whether fade transitions are enabled.
        try:
            client.set_current_program_scene(game)
            logger.info("[OBSFade] switched OBS program scene to %r", game)
        except Exception as exc:
            logger.warning("[OBSFade] set program scene failed (non-fatal): %s", exc)

        return True

    def _ensure_transition_scenes(self, client: OBSClient) -> bool:
        """Create black scene + validate transition name. Only runs when transitions are enabled."""
        try:
            existing = set(client.get_scene_names())
        except OBSRecordError as exc:
            logger.warning("[OBSFade] GetSceneList failed: %s", exc)
            return False

        # ── Black scene ─────────────────────────────────────────────────
        black = self._cfg.black_scene_name
        if black not in existing:
            try:
                client.create_scene(black)
                logger.info("[OBSFade] created black scene: %r", black)
            except OBSRecordError as exc:
                logger.warning("[OBSFade] create black scene failed: %s", exc)
                return False

        if not client.scene_has_source(black, _BLACK_COLOR_SOURCE_NAME):
            try:
                client.add_color_source_to_scene(
                    black, _BLACK_COLOR_SOURCE_NAME, color=0xFF000000
                )
                logger.info("[OBSFade] added black color source to %r", black)
            except OBSRecordError as exc:
                logger.warning("[OBSFade] add black source failed (non-fatal): %s", exc)

        # ── Keep game audio alive during the black period ────────────────
        # When CS2 audio is captured by the Game Capture source (rather than the
        # global Desktop Audio device), that source only produces audio while it
        # is in the active program scene.  Switching the program scene to the
        # black scene would deactivate it, dropping audio during the fade and
        # leaving a brief silence at the start of the next clip while the source
        # re-activates.  Mirror the game capture into the black scene (covered by
        # the opaque black color source on top) so its audio stays continuous
        # across the transition while the visuals remain fully black.
        self._ensure_game_capture_hidden_in_black(client, black)

        # ── Validate transition (warning only) ───────────────────────────
        available = client.get_scene_transition_list()
        if available and self._cfg.transition_name not in available:
            logger.warning(
                "[OBSFade] transition %r not in OBS list %s; will attempt anyway",
                self._cfg.transition_name, available,
            )

        return True

    def _ensure_game_capture_hidden_in_black(self, client: OBSClient, black: str) -> None:
        """Mirror the game capture into the black scene, hidden under the black color source.

        Keeps the game-capture source active (so CS2 game-audio capture keeps
        producing audio) while the black color source on top hides the video,
        preserving a fully-black fade.  Best-effort: all failures are logged and
        swallowed so a missing capability never blocks transitions.
        """
        try:
            if not client.scene_has_source(black, _GAME_CAPTURE_INPUT_NAME):
                # Reference the existing game-capture input (created for the game
                # scene) into the black scene rather than creating a duplicate.
                client.ensure_game_capture_in_scene(
                    black,
                    _GAME_CAPTURE_INPUT_NAME,
                    input_settings=_game_capture_settings(),
                )
                logger.info("[OBSFade] mirrored game capture into black scene %r for audio continuity", black)
        except Exception as exc:
            logger.warning("[OBSFade] mirror game capture into black scene failed (non-fatal): %s", exc)
            return

        # Stretch the black color source to fill the canvas so it fully occludes
        # the game capture regardless of canvas resolution, then force the z-order
        # so the black color source is on top and the game capture sits below it.
        try:
            video = client.get_video_settings()
            bw = float(video.get("base_width", 1920) or 1920)
            bh = float(video.get("base_height", 1080) or 1080)
            black_item_id = client.get_scene_item_id(black, _BLACK_COLOR_SOURCE_NAME)
            if black_item_id is not None:
                client.set_scene_item_transform(
                    black,
                    black_item_id,
                    {
                        "boundsType": "OBS_BOUNDS_STRETCH",
                        "boundsWidth": bw,
                        "boundsHeight": bh,
                        "positionX": 0.0,
                        "positionY": 0.0,
                        "rotation": 0.0,
                    },
                )
                # Index 0 = bottom; raise the black color source above the game capture.
                client.set_scene_item_index(black, black_item_id, 1)
            game_item_id = client.get_scene_item_id(black, _GAME_CAPTURE_INPUT_NAME)
            if game_item_id is not None:
                client.set_scene_item_index(black, game_item_id, 0)
        except Exception as exc:
            logger.warning("[OBSFade] order black scene sources failed (non-fatal): %s", exc)

    # ------------------------------------------------------------------
    # fade_to_black / fade_to_game
    # ------------------------------------------------------------------

    async def fade_to_black(self) -> bool:
        """Switch to black scene with configured transition.  Records the fade-out.

        Returns True (no-op success) when not ready.
        Returns False on OBS error — caller should log warning and continue.
        """
        if not self._ready:
            return True
        return await self._do_fade(self._cfg.black_scene_name, direction="to_black")

    async def fade_to_game(self) -> bool:
        """Switch to game scene with configured transition.  Records the fade-in.

        Returns True (no-op success) when not ready.
        Returns False on OBS error — caller should log warning and continue.
        """
        if not self._ready:
            return True
        return await self._do_fade(self._cfg.game_scene_name, direction="to_game")

    async def prime_fade_to_game(self) -> bool:
        """Pre-establish the OBS connection and configure the transition before recording starts.

        Call this BEFORE start_record/resume_record so execute_primed_fade_to_game() can
        switch the scene with near-zero latency — eliminating the connection-setup gap that
        would otherwise be recorded as black-screen-with-audio.

        If not called (or if it fails), execute_primed_fade_to_game() falls back to the
        normal _do_fade path.

        Returns True on success (or when not ready — no-op).
        """
        if not self._ready:
            return True

        # Discard any stale primed client (shouldn't normally happen).
        if self._primed_client is not None:
            try:
                await asyncio.to_thread(self._primed_client.disconnect)
            except Exception:
                pass
            self._primed_client = None

        client = self._new_client()
        try:
            await asyncio.to_thread(client.connect)
            await asyncio.to_thread(
                client.set_current_scene_transition,
                self._cfg.transition_name,
                self._cfg.duration_ms,
            )
            self._primed_client = client
            logger.debug("[OBSFade] primed fade-to-game connection")
            return True
        except Exception as exc:
            logger.warning("[OBSFade] prime_fade_to_game failed: %s", exc)
            try:
                await asyncio.to_thread(client.disconnect)
            except Exception:
                pass
            return False

    async def execute_primed_fade_to_game(self) -> bool:
        """Execute fade-to-game using the pre-established connection from prime_fade_to_game().

        Consumes the primed client so subsequent calls behave normally.
        Falls back to a fresh _do_fade if prime_fade_to_game() was not called or failed.

        Returns True on success. Returns True (no-op) when not ready.
        """
        if not self._ready:
            return True

        client = self._primed_client
        self._primed_client = None  # consume

        if client is None:
            logger.warning("[OBSFade] execute_primed_fade_to_game: not primed; falling back to _do_fade")
            return await self._do_fade(self._cfg.game_scene_name, direction="to_game")

        try:
            await asyncio.to_thread(client.set_current_program_scene, self._cfg.game_scene_name)
            await asyncio.sleep(self._cfg.duration_ms / 1000.0)
            logger.debug("[OBSFade] to_game complete (%dms) [primed]", self._cfg.duration_ms)
            return True
        except Exception as exc:
            logger.warning("[OBSFade] execute_primed_fade_to_game failed: %s", exc)
            return False
        finally:
            try:
                await asyncio.to_thread(client.disconnect)
            except Exception:
                pass

    async def _do_fade(self, target_scene: str, direction: str) -> bool:
        client = self._new_client()
        try:
            await asyncio.to_thread(client.connect)
            await asyncio.to_thread(
                client.set_current_scene_transition,
                self._cfg.transition_name,
                self._cfg.duration_ms,
            )
            await asyncio.to_thread(client.set_current_program_scene, target_scene)
            await asyncio.sleep(self._cfg.duration_ms / 1000.0)
            logger.debug("[OBSFade] %s complete (%dms)", direction, self._cfg.duration_ms)
            return True
        except Exception as exc:
            logger.warning("[OBSFade] %s failed: %s", direction, exc)
            return False
        finally:
            try:
                await asyncio.to_thread(client.disconnect)
            except Exception:
                pass
