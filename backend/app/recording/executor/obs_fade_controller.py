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
from dataclasses import dataclass
from typing import Optional

from ...env_utils import OBSConfig
from .obs_client import OBSClient, OBSRecordError

logger = logging.getLogger(__name__)

_BLACK_COLOR_SOURCE_NAME = "CS2 Insight Black Source"
_GAME_CAPTURE_INPUT_NAME = "CS2 Insight Game Capture"
_GAME_CAPTURE_KIND = "game_capture"


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
        """Ensure game scene + black scene exist in OBS.

        Returns True on success (fade transitions will be used).
        Returns False if disabled or any OBS call fails (hard-cut fallback).
        """
        if not self._cfg.enabled:
            logger.info("[OBSFade] transition disabled; running in hard-cut mode")
            return False

        client = self._new_client()
        try:
            await asyncio.to_thread(client.connect)
            ok = await asyncio.to_thread(self._setup_scenes, client)
            if ok:
                self._ready = True
                logger.info(
                    "[OBSFade] setup complete — game=%r black=%r transition=%r %dms",
                    self._cfg.game_scene_name,
                    self._cfg.black_scene_name,
                    self._cfg.transition_name,
                    self._cfg.duration_ms,
                )
            return ok
        except Exception as exc:
            logger.warning("[OBSFade] setup failed: %s", exc)
            return False
        finally:
            try:
                await asyncio.to_thread(client.disconnect)
            except Exception:
                pass

    def _setup_scenes(self, client: OBSClient) -> bool:
        """Synchronous scene setup — runs in executor thread."""
        try:
            existing = set(client.get_scene_names())
        except OBSRecordError as exc:
            logger.warning("[OBSFade] GetSceneList failed: %s", exc)
            return False

        # ── Game scene ──────────────────────────────────────────────────
        game = self._cfg.game_scene_name
        if game not in existing:
            try:
                client.create_scene(game)
                logger.info("[OBSFade] created game scene: %r", game)
            except OBSRecordError as exc:
                logger.warning("[OBSFade] create game scene failed: %s", exc)
                return False

        if not client.scene_has_source(game, _GAME_CAPTURE_INPUT_NAME):
            try:
                client.ensure_game_capture_in_scene(game, _GAME_CAPTURE_INPUT_NAME)
            except Exception as exc:
                logger.warning("[OBSFade] ensure game capture failed: %s", exc)
                # non-fatal — scene exists but capture may need manual setup

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

        # ── Validate transition (warning only) ───────────────────────────
        available = client.get_scene_transition_list()
        if available and self._cfg.transition_name not in available:
            logger.warning(
                "[OBSFade] transition %r not in OBS list %s; will attempt anyway",
                self._cfg.transition_name, available,
            )

        return True

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
