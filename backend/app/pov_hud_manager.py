"""POV HUD：安装统一的 pov_default.vpk、增量 patch gameinfo.gi、备份与恢复（实验性功能）。"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

from .cs2_config_backup import is_cs2_running
from .demo_voice_hud import DemoVoiceHudBuild, DemoVoiceHudError, build_demo_voice_hud_vpk

logger = logging.getLogger(__name__)

CS2_RUNNING_POV_MSG = (
    "检测到 CS2 正在运行。POV HUD 需要修改本地资源加载配置，请先关闭 CS2 后再继续。"
)


class PovHudError(RuntimeError):
    pass


def _pov_dir_has_any_vpk(pov_dir: Path) -> bool:
    return (
        (pov_dir / "pov.vpk").is_file()
        or (pov_dir / "pov_default.vpk").is_file()
    )


def find_project_root() -> Path:
    current = Path(__file__).resolve()
    for parent in [current.parent, *current.parents]:
        if _pov_dir_has_any_vpk(parent / "pov"):
            return parent
    raise PovHudError("未找到项目根目录下的 POV 资源（pov/pov_default.vpk 或旧版 pov/pov.vpk）")


def resolve_pov_vpk_source_in_project_pov_dir(pov_dir: Path, map_name: Optional[str]) -> Path:
    """所有 Demo 地图统一使用 pov_default.vpk；map_name 仅为兼容旧调用保留。"""
    del map_name
    default = pov_dir / "pov_default.vpk"
    if default.is_file():
        return default
    legacy = pov_dir / "pov.vpk"
    if legacy.is_file():
        return legacy
    raise PovHudError("未找到 POV HUD 资源：请使用 pov/pov_default.vpk 或旧版 pov/pov.vpk。")


def resolve_csgo_dir_from_cs2_path(cs2_path: str) -> Path:
    s = (cs2_path or "").strip()
    if not s:
        raise PovHudError("未找到 CS2 安装目录，请先在设置中配置 cs2.exe 路径。")
    p = Path(s).expanduser()
    if not p.exists():
        raise PovHudError("未找到 CS2 安装目录，请先在设置中配置 cs2.exe 路径。")
    name = p.name.lower()
    if p.is_file() and name == "cs2.exe":
        # .../game/bin/win64/cs2.exe → .../game/csgo
        game = p.parent.parent.parent
        return game / "csgo"
    if p.is_dir():
        cand = p / "game" / "csgo"
        if cand.is_dir():
            return cand
    raise PovHudError("未找到 CS2 安装目录，请先在设置中配置 cs2.exe 路径。")


def patch_gameinfo_content(content: str) -> str:
    if "csgo/pov.vpk" in content:
        return content

    lines = content.splitlines()
    patched: list[str] = []
    inserted = False

    for line in lines:
        patched.append(line)
        if not inserted and "Game_LowViolence" in line and "csgo_lv" in line:
            indent = line[: len(line) - len(line.lstrip())]
            patched.append("")
            patched.append(f"{indent}Game    csgo/pov.vpk")
            inserted = True

    if inserted:
        out = "\n".join(patched)
        return out + ("\n" if content.endswith("\n") else "")

    patched = []
    inserted = False
    for line in lines:
        if not inserted:
            stripped = line.strip()
            parts = stripped.split()
            if len(parts) >= 2 and parts[0] == "Game" and parts[1] == "csgo":
                indent = line[: len(line) - len(line.lstrip())]
                patched.append(f"{indent}Game    csgo/pov.vpk")
                inserted = True
        patched.append(line)

    if not inserted:
        raise PovHudError("未能修改 gameinfo.gi，请检查文件内容是否被 Steam 更新改变。")

    out = "\n".join(patched)
    return out + ("\n" if content.endswith("\n") else "")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


class PovHudManager:
    """定位资源、安装 / 恢复 POV HUD 文件。"""

    def __init__(self, config_like: Any) -> None:
        self._cs2_path = str(getattr(config_like, "cs2_path", "") or "").strip()

    def get_csgo_dir(self) -> Path:
        return resolve_csgo_dir_from_cs2_path(self._cs2_path)

    def get_gameinfo_path(self) -> Path:
        return self.get_csgo_dir() / "gameinfo.gi"

    def get_pov_vpk_target_path(self) -> Path:
        return self.get_csgo_dir() / "pov.vpk"

    def get_backup_dir(self) -> Path:
        return self.get_csgo_dir() / ".cs2_insight_pov_backup"

    def get_manifest_path(self) -> Path:
        return self.get_backup_dir() / "pov_manifest.json"

    def get_backup_gameinfo_path(self) -> Path:
        return self.get_backup_dir() / "gameinfo.gi.bak"

    def get_project_pov_dir(self) -> Path:
        return find_project_root() / "pov"

    def get_pov_vpk_source_path(self, map_name: Optional[str] = None) -> Path:
        return resolve_pov_vpk_source_in_project_pov_dir(self.get_project_pov_dir(), map_name)

    def get_voice_hud_template_path(self) -> Path:
        return self.get_project_pov_dir() / "pov_voice_template.vpk"

    def get_reference_default_gameinfo_path(self) -> Path:
        return self.get_project_pov_dir() / "gameinfo.gi.default"

    def get_reference_pov_gameinfo_path(self) -> Path:
        return self.get_project_pov_dir() / "gameinfo.gi.pov"

    def is_gameinfo_patched(self, content: str) -> bool:
        return "csgo/pov.vpk" in content

    def _read_manifest(self) -> dict[str, Any]:
        path = self.get_manifest_path()
        if not path.is_file():
            return {}
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return {}
        return value if isinstance(value, dict) else {}

    def verify_restoration(self, expected_gameinfo_sha256: Optional[str] = None) -> dict[str, Any]:
        """Return file-system evidence for POV restoration without inferring success."""
        gi_path = self.get_gameinfo_path()
        pov_path = self.get_pov_vpk_target_path()
        manifest_path = self.get_manifest_path()
        backup_path = self.get_backup_gameinfo_path()
        expected_sha = str(expected_gameinfo_sha256 or "").strip().lower() or None
        actual_sha: Optional[str] = None
        gameinfo_has_pov_entry: Optional[bool] = None
        errors: list[str] = []

        if gi_path.is_file():
            try:
                actual_sha = sha256_file(gi_path)
            except OSError as exc:
                errors.append(f"Unable to hash gameinfo.gi: {exc}")
            try:
                content = gi_path.read_text(encoding="utf-8", errors="ignore")
                gameinfo_has_pov_entry = self.is_gameinfo_patched(content)
            except OSError as exc:
                errors.append(f"Unable to read gameinfo.gi: {exc}")
        else:
            errors.append("gameinfo.gi does not exist")

        gameinfo_restored = bool(expected_sha and actual_sha == expected_sha and gameinfo_has_pov_entry is False)
        pov_vpk_exists = pov_path.is_file()
        pov_vpk_removed = not pov_vpk_exists
        return {
            "verified": bool(gameinfo_restored and pov_vpk_removed),
            "gameinfo_path": str(gi_path),
            "gameinfo_exists": gi_path.is_file(),
            "gameinfo_restored": gameinfo_restored,
            "gameinfo_has_pov_entry": gameinfo_has_pov_entry,
            "expected_gameinfo_sha256": expected_sha,
            "actual_gameinfo_sha256": actual_sha,
            "pov_vpk_path": str(pov_path),
            "pov_vpk_exists": pov_vpk_exists,
            "pov_vpk_removed": pov_vpk_removed,
            "manifest_exists": manifest_path.is_file(),
            "backup_exists": backup_path.is_file(),
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "errors": errors,
        }

    def status(self) -> dict[str, Any]:
        warnings: list[str] = []
        csgo = None
        try:
            csgo = self.get_csgo_dir()
        except PovHudError:
            warnings.append("无法解析 CS2 game/csgo 路径。")

        cs2_running = bool(is_cs2_running())
        gi_path = csgo / "gameinfo.gi" if csgo else None
        manifest_path = csgo / ".cs2_insight_pov_backup" / "pov_manifest.json" if csgo else None
        bak_path = csgo / ".cs2_insight_pov_backup" / "gameinfo.gi.bak" if csgo else None
        pov_dst = csgo / "pov.vpk" if csgo else None

        gameinfo_patched = False
        if gi_path and gi_path.is_file():
            try:
                txt = gi_path.read_text(encoding="utf-8", errors="ignore")
                gameinfo_patched = self.is_gameinfo_patched(txt)
            except OSError:
                pass

        manifest_exists = bool(manifest_path and manifest_path.is_file())
        backup_exists = bool(bak_path and bak_path.is_file())
        pov_installed = bool(pov_dst and pov_dst.is_file())
        manifest = self._read_manifest() if manifest_exists else {}
        original_gameinfo_sha256 = str(manifest.get("original_gameinfo_sha256") or "").strip().lower() or None

        if gameinfo_patched and not manifest_exists:
            warnings.append(
                "检测到 gameinfo.gi 中存在 csgo/pov.vpk，但未找到 CS2 Insight Agent 的备份记录。请用户手动检查 gameinfo.gi。"
            )

        if pov_installed and not manifest_exists:
            warnings.append("Detected pov.vpk without a CS2 Insight Agent restore manifest; manual inspection is required.")

        needs_restore = bool(manifest_exists or gameinfo_patched or pov_installed)

        return {
            "installed": pov_installed,
            "gameinfo_patched": gameinfo_patched,
            "backup_exists": backup_exists,
            "manifest_exists": manifest_exists,
            "original_gameinfo_sha256": original_gameinfo_sha256,
            "cs2_running": cs2_running,
            "needs_restore": needs_restore,
            "warnings": warnings,
        }

    def install(
        self,
        map_name: Optional[str] = None,
        *,
        demo_path: Optional[str | Path] = None,
        input_track_report: Optional[Mapping[str, Any]] = None,
    ) -> None:
        if sys.platform != "win32":
            raise PovHudError("POV HUD 仅支持 Windows。")
        if is_cs2_running():
            raise PovHudError(CS2_RUNNING_POV_MSG)

        pov_src = self.get_pov_vpk_source_path(map_name)
        if not pov_src.is_file():
            raise PovHudError("未找到 POV HUD 资源文件，请确认 pov 目录下资源完整。")

        voice_build: Optional[DemoVoiceHudBuild] = None
        voice_template = self.get_voice_hud_template_path()
        if demo_path is not None and voice_template.is_file():
            try:
                voice_build = build_demo_voice_hud_vpk(
                    demo_path,
                    voice_template,
                    input_track_report=input_track_report,
                )
                logger.info(
                    "Built demo voice HUD: packets=%d speakers=%d intervals=%d "
                    "locations=%d input_tracks=%d input_changes=%d payload=%d bytes",
                    voice_build.voice_packets,
                    voice_build.speakers,
                    voice_build.intervals,
                    voice_build.location_changes,
                    voice_build.input_tracks,
                    voice_build.input_changes,
                    voice_build.payload_bytes,
                )
            except (DemoVoiceHudError, OSError) as exc:
                logger.warning(
                    "Could not build demo-specific voice HUD; using the static POV package: %s",
                    exc,
                )

        csgo = self.get_csgo_dir()
        gi_path = self.get_gameinfo_path()
        if not gi_path.is_file():
            raise PovHudError("未找到 gameinfo.gi，请确认 CS2 路径是否正确。")

        backup_dir = self.get_backup_dir()
        manifest_path = self.get_manifest_path()
        bak_path = self.get_backup_gameinfo_path()
        pov_dst = self.get_pov_vpk_target_path()

        # 若残留 manifest，先尝试恢复再重装，避免重复备份错乱
        if manifest_path.is_file():
            self.restore()

        backup_dir.mkdir(parents=True, exist_ok=True)

        raw_gi = gi_path.read_text(encoding="utf-8", errors="surrogateescape")
        original_sha = sha256_file(gi_path)

        # Each session must back up the current gameinfo.gi. Reusing an older
        # successful session's backup can roll back later Steam updates.
        shutil.copy2(gi_path, bak_path)

        try:
            if voice_build is not None:
                pov_dst.write_bytes(voice_build.vpk_bytes)
            else:
                shutil.copy2(pov_src, pov_dst)
        except OSError as e:
            raise PovHudError("无法写入 CS2 目录，请尝试以管理员权限运行，或检查 Steam / CS2 目录权限。") from e

        patched_txt = patch_gameinfo_content(raw_gi)
        try:
            gi_path.write_text(patched_txt, encoding="utf-8", newline="\n")
        except OSError as e:
            try:
                if bak_path.is_file():
                    shutil.copy2(bak_path, gi_path)
            except OSError:
                pass
            try:
                if pov_dst.is_file():
                    pov_dst.unlink()
            except OSError:
                pass
            raise PovHudError("无法写入 CS2 目录，请尝试以管理员权限运行，或检查 Steam / CS2 目录权限。") from e

        patched_sha = sha256_file(gi_path)
        pov_sha = sha256_file(pov_dst)

        manifest = {
            "enabled_by": "CS2 Insight Agent",
            "feature": "experimental_pov",
            "installed_at": datetime.now(timezone.utc).isoformat(),
            "gameinfo_path": str(gi_path),
            "backup_gameinfo_path": str(bak_path),
            "pov_vpk_path": str(pov_dst),
            "pov_vpk_source_basename": (
                voice_template.name if voice_build is not None else pov_src.name
            ),
            "demo_voice_hud_generated": voice_build is not None,
            "demo_voice_hud": (
                {
                    "voice_packets": voice_build.voice_packets,
                    "speakers": voice_build.speakers,
                    "intervals": voice_build.intervals,
                    "location_changes": voice_build.location_changes,
                    "payload_bytes": voice_build.payload_bytes,
                    "location_parse_failed": bool(voice_build.location_parse_failed),
                    "input_tracks": voice_build.input_tracks,
                    "input_changes": voice_build.input_changes,
                    "input_commands": voice_build.input_commands,
                    "input_button_updates": voice_build.input_button_updates,
                    "input_subtick_steps": voice_build.input_subtick_steps,
                    "radar_players": voice_build.radar_players,
                    "radar_samples": voice_build.radar_samples,
                    "radar_parse_failed": bool(voice_build.radar_parse_failed),
                    "radar_map": voice_build.radar_map,
                    "radar_planted_bombs": voice_build.radar_planted_bombs,
                    "radar_player_sounds": voice_build.radar_player_sounds,
                    "kill_feedback_events": voice_build.kill_feedback_events,
                    "kill_feedback_parse_failed": bool(voice_build.kill_feedback_parse_failed),
                }
                if voice_build is not None
                else None
            ),
            "demo_map_name_used": (map_name or "").strip(),
            "original_gameinfo_sha256": original_sha,
            "patched_gameinfo_sha256": patched_sha,
            "installed_pov_vpk_sha256": pov_sha,
        }
        try:
            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError as e:
            # Do not leave a patched game without a manifest that startup recovery can find.
            try:
                shutil.copy2(bak_path, gi_path)
            except OSError:
                pass
            try:
                if pov_dst.is_file():
                    pov_dst.unlink()
            except OSError:
                pass
            raise PovHudError("无法写入 CS2 目录，请尝试以管理员权限运行，或检查 Steam / CS2 目录权限。") from e

    def restore(self) -> dict[str, Any]:
        if sys.platform != "win32":
            raise PovHudError("POV HUD 仅支持 Windows。")
        if is_cs2_running():
            raise PovHudError("检测到 CS2 正在运行，请先关闭 CS2 后再恢复 POV HUD 修改。")

        manifest_path = self.get_manifest_path()
        bak_path = self.get_backup_gameinfo_path()
        gi_path = self.get_gameinfo_path()
        pov_dst = self.get_pov_vpk_target_path()
        backup_dir = self.get_backup_dir()

        if not manifest_path.is_file():
            raise PovHudError("未找到 POV 安装记录，无需恢复。")
        if not bak_path.is_file():
            raise PovHudError("POV HUD 自动恢复失败，请到 .cs2_insight_pov_backup 目录手动恢复 gameinfo.gi.bak。")

        manifest = self._read_manifest()
        expected_sha = str(manifest.get("original_gameinfo_sha256") or "").strip().lower()
        try:
            backup_sha = sha256_file(bak_path)
        except OSError as e:
            raise PovHudError("POV HUD restore failed: unable to verify gameinfo.gi backup.") from e
        if expected_sha and backup_sha != expected_sha:
            raise PovHudError("POV HUD restore failed: gameinfo.gi backup hash does not match the install manifest.")
        expected_sha = expected_sha or backup_sha

        try:
            shutil.copy2(bak_path, gi_path)
        except OSError as e:
            raise PovHudError("POV HUD 自动恢复失败，请到 .cs2_insight_pov_backup 目录手动恢复 gameinfo.gi.bak。") from e

        try:
            if pov_dst.is_file():
                pov_dst.unlink()
        except OSError as e:
            raise PovHudError("POV HUD 自动恢复失败：无法删除 pov.vpk。") from e

        verification = self.verify_restoration(expected_sha)
        if not verification.get("verified"):
            raise PovHudError("POV HUD restore verification failed: gameinfo.gi or pov.vpk is not restored.")

        try:
            manifest_path.unlink()
        except OSError as e:
            raise PovHudError("POV HUD 自动恢复失败：无法删除恢复记录。") from e

        try:
            if bak_path.is_file():
                bak_path.unlink()
        except OSError:
            # gameinfo and pov.vpk are already restored; an orphan backup is harmless
            # and will be overwritten on the next install.
            pass

        try:
            if backup_dir.is_dir() and not any(backup_dir.iterdir()):
                backup_dir.rmdir()
        except OSError:
            pass
        return self.verify_restoration(expected_sha)

    def debug_compare_reference_gameinfo(self) -> dict[str, Any]:
        """开发阶段：对比参考 gameinfo，不参与录制。"""
        d = self.get_reference_default_gameinfo_path()
        p = self.get_reference_pov_gameinfo_path()
        if not d.is_file() or not p.is_file():
            return {"ok": False, "error": "缺少 gameinfo.gi.default / gameinfo.gi.pov"}
        td = d.read_text(encoding="utf-8", errors="ignore")
        tp = p.read_text(encoding="utf-8", errors="ignore")
        return {
            "ok": True,
            "default_has_pov": "csgo/pov.vpk" in td,
            "pov_has_pov": "csgo/pov.vpk" in tp,
            "len_delta": len(tp) - len(td),
        }


def restore_pov_after_cs2_exit(
    manager: PovHudManager,
    expected_gameinfo_sha256: Optional[str],
    *,
    is_running: Optional[Callable[[], bool]] = None,
    sleep: Optional[Callable[[float], None]] = None,
    max_attempts: int = 20,
    logger: Optional[logging.Logger] = None,
) -> dict[str, Any]:
    """Wait for CS2 to exit, then restore and strictly verify POV HUD files."""
    running_check = is_running or is_cs2_running
    sleep_fn = sleep or time.sleep
    event_logger = logger or logging.getLogger(__name__)
    expected_sha = str(expected_gameinfo_sha256 or "").strip().lower() or None

    # A newly started external CS2 process must also finish before files can be restored.
    while running_check():
        sleep_fn(1.0)

    last_error: Optional[Exception] = None
    verification: dict[str, Any] = {}
    for _ in range(max_attempts):
        try:
            status = manager.status()
            if not expected_sha:
                expected_sha = (
                    str(status.get("original_gameinfo_sha256") or "").strip().lower() or None
                )
            if status.get("needs_restore"):
                restored = manager.restore()
                verification = restored if isinstance(restored, dict) else {}
                if not expected_sha:
                    expected_sha = (
                        str(verification.get("expected_gameinfo_sha256") or "").strip().lower() or None
                    )
            verification = manager.verify_restoration(expected_sha)
            if expected_sha and verification.get("verified"):
                verification["error"] = ""
                event_logger.info("POV HUD files restored and verified after CS2 exit")
                return verification
            if expected_sha:
                last_error = PovHudError("restore verification did not pass")
            else:
                last_error = PovHudError(
                    "restore verification cannot pass without the original gameinfo.gi hash"
                )
        except PovHudError as exc:
            last_error = exc
        except Exception as exc:  # noqa: BLE001
            last_error = exc

        if running_check():
            while running_check():
                sleep_fn(1.0)
        else:
            sleep_fn(0.5)

    try:
        verification = manager.verify_restoration(expected_sha)
    except Exception as exc:  # noqa: BLE001
        last_error = last_error or exc
        verification = {"verified": False, "errors": [str(exc)]}
    verification["verified"] = False
    verification["error"] = str(last_error or "restore verification failed")
    event_logger.error("POV HUD restore failed; manual restore is required: %s", last_error)
    return verification


def try_restore_stale_pov_on_startup(cfg: Any) -> list[str]:
    """后端启动：若存在 manifest 且 CS2 未运行，自动恢复。"""
    out: list[str] = []
    if sys.platform != "win32":
        return out
    try:
        mgr = PovHudManager(cfg)
        st = mgr.status()
        if st.get("manifest_exists") and not st.get("cs2_running"):
            mgr.restore()
            out.append("已自动恢复上次未完成的 POV HUD 修改。")
    except PovHudError as e:
        out.append(str(e))
    except Exception:
        pass
    return out
