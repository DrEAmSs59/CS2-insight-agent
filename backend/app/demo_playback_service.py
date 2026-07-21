"""Direct CS2 demo playback with process gating and optional POV HUD lifecycle."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from .cs2_config_backup import is_cs2_running
from .demo_compat_service import ensure_demo_compatible
from .pov_constants import POV_CORE_FORCED_COMMANDS, pov_tail_commands
from .pov_hud_manager import PovHudError, PovHudManager

logger = logging.getLogger(__name__)


class DemoPlaybackBusyError(RuntimeError):
    """A playback launch is already active or still being cleaned up."""


class DemoPlaybackCs2RunningError(RuntimeError):
    """CS2 is already running and must be closed before managed playback."""


@dataclass(frozen=True)
class DemoPlaybackPovOptions:
    enabled: bool = False
    radar_mode: int = 0
    teamcounter_numeric: bool = False


@dataclass
class DemoPlaybackSession:
    session_id: str
    process: Any
    copied_demo: Path
    copied_cfg: Optional[Path]
    pov_manager: Optional[PovHudManager]
    pov_enabled: bool
    expected_gameinfo_sha256: Optional[str]
    started_at_monotonic: float


class DemoPlaybackService:
    """Own one direct-playback CS2 session and clean up after CS2 exits."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._active: Optional[DemoPlaybackSession] = None
        self._session_reports: dict[str, dict[str, Any]] = {}
        self._session_verifiers: dict[str, tuple[PovHudManager, Optional[str]]] = {}

    def _set_session_report(self, session_id: str, **updates: Any) -> None:
        with self._lock:
            current = dict(self._session_reports.get(session_id) or {"session_id": session_id})
            current.update(updates)
            self._session_reports[session_id] = current
            while len(self._session_reports) > 20:
                expired_id = next(iter(self._session_reports))
                self._session_reports.pop(expired_id)
                self._session_verifiers.pop(expired_id, None)

    def session_status(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            report = self._session_reports.get(str(session_id))
            if report is None:
                return {"found": False, "session_id": str(session_id)}
            result = dict(report)
            verifier = self._session_verifiers.get(str(session_id))
        if verifier and result.get("state") in {"completed", "restore_failed"}:
            manager, expected_sha = verifier
            try:
                fresh_restore = manager.verify_restoration(expected_sha)
                previous_error = str((result.get("restore") or {}).get("error") or "")
                fresh_restore["error"] = "" if fresh_restore.get("verified") else previous_error
                result["restore"] = fresh_restore
                result["state"] = "completed" if fresh_restore.get("verified") else "restore_failed"
                self._set_session_report(str(session_id), state=result["state"], restore=fresh_restore)
            except Exception as exc:  # noqa: BLE001
                result["state"] = "restore_failed"
                result["restore"] = {"verified": False, "error": str(exc)}
        result["found"] = True
        result["cs2_running"] = bool(is_cs2_running())
        return result

    def preflight(self, config_like: Any) -> dict[str, Any]:
        cs2_path = str(getattr(config_like, "cs2_path", "") or "").strip()
        cs2_path_valid = bool(cs2_path and Path(cs2_path).is_file())
        with self._lock:
            active = self._active is not None

        running = bool(is_cs2_running())
        needs_restore = False
        warnings: list[str] = []
        if cs2_path_valid:
            try:
                status = PovHudManager(config_like).status()
                needs_restore = bool(status.get("needs_restore"))
                warnings = [str(x) for x in status.get("warnings") or [] if str(x).strip()]
            except PovHudError as exc:
                warnings.append(str(exc))

        return {
            "ok": cs2_path_valid and not active and not running,
            "cs2_path_configured": cs2_path_valid,
            "cs2_running": running,
            "playback_active": active,
            "pov_needs_restore": needs_restore,
            "warnings": warnings,
        }

    @staticmethod
    def _resolve_game_paths(cs2_path: str) -> tuple[Path, Path]:
        cs2_bin = Path(cs2_path)
        if not cs2_path or not cs2_bin.is_file():
            raise FileNotFoundError("CS2 path is not configured or cs2.exe does not exist")
        try:
            game_root = cs2_bin.parents[2]
        except IndexError as exc:
            raise FileNotFoundError("Unable to resolve the CS2 game directory from cs2.exe") from exc
        csgo_dir = game_root / "csgo"
        if not csgo_dir.is_dir():
            raise FileNotFoundError("Unable to find the CS2 game/csgo directory")
        return game_root, csgo_dir

    @staticmethod
    def _write_pov_cfg(cfg_path: Path, demo_stem: str, options: DemoPlaybackPovOptions) -> None:
        commands = [
            "con_enable 1",
            *POV_CORE_FORCED_COMMANDS,
            *pov_tail_commands(
                teamcounter_numeric=bool(options.teamcounter_numeric),
                radar_mode=int(options.radar_mode),
            ),
            f'playdemo "{demo_stem}.dem"',
        ]
        cfg_path.write_text("\n".join(commands) + "\n", encoding="ascii")

    @staticmethod
    def _cleanup_artifacts(session: DemoPlaybackSession) -> None:
        for label, path in (("preview cfg", session.copied_cfg), ("preview demo", session.copied_demo)):
            if path and path.is_file():
                try:
                    path.unlink()
                except OSError as exc:
                    logger.warning("Could not remove direct playback %s %s: %s", label, path, exc)

    @staticmethod
    def _restore_pov_after_exit(
        manager: PovHudManager,
        expected_gameinfo_sha256: Optional[str],
    ) -> dict[str, Any]:
        # A newly started external CS2 process must also finish before files can be restored.
        while is_cs2_running():
            time.sleep(1.0)

        last_error: Optional[Exception] = None
        verification: dict[str, Any] = {}
        for _ in range(20):
            try:
                status = manager.status()
                if status.get("needs_restore"):
                    restored = manager.restore()
                    verification = restored if isinstance(restored, dict) else {}
                verification = manager.verify_restoration(expected_gameinfo_sha256)
                if verification.get("verified"):
                    verification["error"] = ""
                    logger.info("Direct playback POV HUD files restored and verified")
                    return verification
                last_error = PovHudError("restore verification did not pass")
            except PovHudError as exc:
                last_error = exc
            except Exception as exc:  # noqa: BLE001
                last_error = exc

            if is_cs2_running():
                while is_cs2_running():
                    time.sleep(1.0)
            else:
                time.sleep(0.5)

        try:
            verification = manager.verify_restoration(expected_gameinfo_sha256)
        except Exception as exc:  # noqa: BLE001
            last_error = last_error or exc
            verification = {"verified": False, "errors": [str(exc)]}
        verification["verified"] = False
        verification["error"] = str(last_error or "restore verification failed")
        logger.error("Direct playback POV HUD restore failed; manual restore is required: %s", last_error)
        return verification

    def _monitor_session(self, session: DemoPlaybackSession) -> None:
        try:
            try:
                session.process.wait()
            except Exception as exc:  # noqa: BLE001
                logger.warning("Could not wait for direct playback CS2 process: %s", exc)

            runtime = time.monotonic() - session.started_at_monotonic
            # A very short-lived child may be a Steam launcher. Give the real cs2.exe time to appear.
            if runtime < 3.0 and not is_cs2_running():
                deadline = time.monotonic() + 12.0
                while time.monotonic() < deadline and not is_cs2_running():
                    time.sleep(0.5)

            while is_cs2_running():
                time.sleep(1.0)

            if session.pov_enabled and session.pov_manager is not None:
                self._set_session_report(session.session_id, state="restoring")
                restoration = self._restore_pov_after_exit(
                    session.pov_manager,
                    session.expected_gameinfo_sha256,
                )
                self._set_session_report(
                    session.session_id,
                    state="completed" if restoration.get("verified") else "restore_failed",
                    restore=restoration,
                )
            else:
                self._set_session_report(session.session_id, state="completed", restore=None)
        finally:
            self._cleanup_artifacts(session)
            with self._lock:
                if self._active is session:
                    self._active = None
                report = self._session_reports.get(session.session_id)
                if report and report.get("state") not in {"completed", "restore_failed"}:
                    report["state"] = "restore_failed" if session.pov_enabled else "completed"
                    if session.pov_enabled and not report.get("restore"):
                        report["restore"] = {
                            "verified": False,
                            "error": "Playback monitor ended before restoration could be verified.",
                        }
            logger.info("Direct playback session %s cleaned up", session.session_id)

    @staticmethod
    def _best_effort_restore(manager: Optional[PovHudManager], attempted: bool) -> None:
        if not attempted or manager is None or is_cs2_running():
            return
        try:
            if manager.status().get("needs_restore"):
                manager.restore()
        except Exception as exc:  # noqa: BLE001
            logger.error("Could not roll back POV HUD after playback launch failure: %s", exc)

    def launch(
        self,
        dem_path: Path,
        config_like: Any,
        pov_options: Optional[DemoPlaybackPovOptions] = None,
    ) -> dict[str, Any]:
        options = pov_options or DemoPlaybackPovOptions()
        dem_path = Path(dem_path)

        with self._lock:
            if self._active is not None:
                raise DemoPlaybackBusyError("A direct playback session is already active")
            if is_cs2_running():
                raise DemoPlaybackCs2RunningError("CS2 is already running")
            if not dem_path.is_file():
                raise FileNotFoundError(f"Demo file not found: {dem_path}")

            cs2_path = str(getattr(config_like, "cs2_path", "") or "").strip()
            game_root, csgo_dir = self._resolve_game_paths(cs2_path)
            cs2_bin = Path(cs2_path)
            session_id = uuid.uuid4().hex
            stem = f"_insight_preview_{session_id}"
            copied_demo = csgo_dir / f"{stem}.dem"
            copied_cfg = csgo_dir / "cfg" / f"{stem}.cfg" if options.enabled else None
            pov_manager = PovHudManager(config_like)
            pov_install_attempted = False
            expected_gameinfo_sha256: Optional[str] = None
            session: Optional[DemoPlaybackSession] = None

            try:
                stale_status = pov_manager.status()
                if stale_status.get("needs_restore"):
                    if is_cs2_running():
                        raise DemoPlaybackCs2RunningError("CS2 is already running")
                    pov_manager.restore()

                compat = ensure_demo_compatible(dem_path)
                shutil.copy2(dem_path, copied_demo)
                logger.info(
                    "Direct playback compatibility ready: cached=%s outcome=%s removed_type138=%d source=%s",
                    compat.cached,
                    compat.report.outcome,
                    compat.report.removed_messages,
                    dem_path,
                )

                if copied_cfg is not None:
                    copied_cfg.parent.mkdir(parents=True, exist_ok=True)
                    self._write_pov_cfg(copied_cfg, stem, options)

                # Recheck immediately before modifying POV files / starting the process.
                if is_cs2_running():
                    raise DemoPlaybackCs2RunningError("CS2 started during playback preparation")

                if options.enabled:
                    pov_install_attempted = True
                    pov_manager.install()
                    installed_status = pov_manager.status()
                    expected_gameinfo_sha256 = str(
                        installed_status.get("original_gameinfo_sha256") or ""
                    ).strip().lower() or None
                    if not expected_gameinfo_sha256:
                        raise PovHudError("POV HUD install manifest does not contain the original gameinfo.gi hash.")

                if is_cs2_running():
                    raise DemoPlaybackCs2RunningError("CS2 started during playback preparation")

                argv = [str(cs2_bin), "-steam", "-insecure", "-novid", "-console"]
                if copied_cfg is not None:
                    argv.extend(["+exec", stem])
                else:
                    argv.extend(["+playdemo", copied_demo.name])

                child_env = os.environ.copy()
                child_env["SteamAppId"] = "730"
                child_env["SteamGameId"] = "730"
                creationflags = 0
                if sys.platform == "win32":
                    creationflags = (
                        getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                        | getattr(subprocess, "DETACHED_PROCESS", 0)
                    )

                logger.info("Launch CS2 direct playback: cwd=%s cmd=%s", game_root, " ".join(argv))
                process = subprocess.Popen(
                    argv,
                    cwd=str(game_root),
                    env=child_env,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    close_fds=True,
                    creationflags=creationflags,
                )
                session = DemoPlaybackSession(
                    session_id=session_id,
                    process=process,
                    copied_demo=copied_demo,
                    copied_cfg=copied_cfg,
                    pov_manager=pov_manager if options.enabled else None,
                    pov_enabled=bool(options.enabled),
                    expected_gameinfo_sha256=expected_gameinfo_sha256,
                    started_at_monotonic=time.monotonic(),
                )
                self._active = session
                self._set_session_report(
                    session_id,
                    state="running",
                    pov_hud_enabled=bool(options.enabled),
                    restore=None,
                )
                if options.enabled:
                    self._session_verifiers[session_id] = (pov_manager, expected_gameinfo_sha256)
                monitor = threading.Thread(
                    target=self._monitor_session,
                    args=(session,),
                    name=f"demo-playback-{session_id[:8]}",
                    daemon=True,
                )
                monitor.start()
                return {
                    "ok": True,
                    "session_id": session_id,
                    "pov_hud_enabled": bool(options.enabled),
                }
            except Exception:
                if session is not None:
                    if self._active is session:
                        self._active = None
                    self._session_reports.pop(session_id, None)
                    self._session_verifiers.pop(session_id, None)
                    try:
                        session.process.terminate()
                        session.process.wait(timeout=10)
                    except Exception as stop_exc:  # noqa: BLE001
                        logger.error("Could not stop CS2 after playback monitor startup failure: %s", stop_exc)
                self._best_effort_restore(pov_manager, pov_install_attempted)
                placeholder = session or DemoPlaybackSession(
                    session_id=session_id,
                    process=None,
                    copied_demo=copied_demo,
                    copied_cfg=copied_cfg,
                    pov_manager=None,
                    pov_enabled=False,
                    expected_gameinfo_sha256=None,
                    started_at_monotonic=time.monotonic(),
                )
                self._cleanup_artifacts(placeholder)
                raise


demo_playback_service = DemoPlaybackService()
