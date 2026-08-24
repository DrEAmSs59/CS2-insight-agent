"""录制 VPK 生命周期：生成天空/POV 包，临时挂载 gameinfo.gi，并可靠恢复。"""

from __future__ import annotations

import ctypes
import hashlib
import json
import logging
import os
import shutil
import sys
import threading
import time
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

from .cs2_config_backup import is_cs2_running
from .demo_voice_hud import DemoVoiceHudBuild, DemoVoiceHudError, build_demo_voice_hud_vpk
from .skybox_vpk import (
    DEFAULT_SKYBOX_ID,
    SkyboxVpkError,
    compose_recording_skybox_vpk,
    normalize_skybox_id,
)

logger = logging.getLogger(__name__)

CS2_RUNNING_POV_MSG = (
    "检测到 CS2 正在运行。POV HUD 需要修改本地资源加载配置，请先关闭 CS2 后再继续。"
)


class PovHudError(RuntimeError):
    pass


_POV_OPERATION_LOCK = threading.RLock()
_POV_OPERATION_MUTEX_NAME = "Local\\CS2InsightAgentPovHudOperation"


class _CrossProcessPovMutex:
    """Prevent separate backend processes from mutating POV files together."""

    def __init__(self) -> None:
        self._handle = None

    def __enter__(self):
        if os.name != "nt":
            return self
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_wchar_p,
        ]
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        kernel32.WaitForSingleObject.restype = ctypes.c_uint32
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.restype = ctypes.c_int
        handle = kernel32.CreateMutexW(None, False, _POV_OPERATION_MUTEX_NAME)
        if not handle:
            raise PovHudError("无法创建 POV HUD 跨进程操作锁。")
        self._handle = handle
        wait_result = kernel32.WaitForSingleObject(handle, 60_000)
        if wait_result not in {0x00000000, 0x00000080}:
            kernel32.CloseHandle(handle)
            self._handle = None
            raise PovHudError("等待其他 POV HUD 操作超时，请关闭重复运行的应用后重试。")
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        if self._handle is None or os.name != "nt":
            return
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.ReleaseMutex.argtypes = [ctypes.c_void_p]
        kernel32.ReleaseMutex.restype = ctypes.c_int
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.restype = ctypes.c_int
        kernel32.ReleaseMutex(self._handle)
        kernel32.CloseHandle(self._handle)
        self._handle = None


def _serialized_pov_operation(func):
    @wraps(func)
    def wrapped(*args, **kwargs):
        with _POV_OPERATION_LOCK:
            with _CrossProcessPovMutex():
                return func(*args, **kwargs)

    return wrapped


def _temporary_peer_path(path: Path) -> Path:
    return path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")


def _atomic_write_bytes(path: Path, data: bytes) -> None:
    temp_path = _temporary_peer_path(path)
    try:
        temp_path.write_bytes(data)
        temp_path.replace(path)
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass


def _atomic_write_text(path: Path, content: str) -> None:
    temp_path = _temporary_peer_path(path)
    try:
        temp_path.write_text(content, encoding="utf-8", newline="\n")
        temp_path.replace(path)
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass


def _atomic_copy(source: Path, target: Path) -> None:
    temp_path = _temporary_peer_path(target)
    try:
        shutil.copy2(source, temp_path)
        temp_path.replace(target)
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass


def _atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    _atomic_write_text(path, json.dumps(dict(payload), ensure_ascii=False, indent=2))


def _pov_dir_has_any_vpk(pov_dir: Path) -> bool:
    return (
        (pov_dir / "pov.vpk").is_file()
        or (pov_dir / "pov_default.vpk").is_file()
        or (pov_dir / "skybox_assets.vpk").is_file()
    )


def find_project_root() -> Path:
    current = Path(__file__).resolve()
    for parent in [current.parent, *current.parents]:
        if _pov_dir_has_any_vpk(parent / "pov"):
            return parent
    raise PovHudError("未找到项目根目录下的录制 VPK 资源（POV HUD 或天空盒资源包）。")


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


def _line_loads_pov_vpk(line: str) -> bool:
    stripped = line.strip()
    if not stripped or stripped.startswith("//"):
        return False
    parts = stripped.split()
    return bool(
        len(parts) >= 2
        and parts[0].lower() == "game"
        and parts[1].replace("\\", "/").lower() == "csgo/pov.vpk"
    )


def gameinfo_loads_pov_vpk(content: str) -> bool:
    return any(_line_loads_pov_vpk(line) for line in content.splitlines())


def remove_pov_gameinfo_entries(content: str) -> tuple[str, int]:
    """Remove only Agent-owned POV search-path entries, preserving other bytes."""
    lines = content.splitlines(keepends=True)
    kept = [line for line in lines if not _line_loads_pov_vpk(line)]
    return "".join(kept), len(lines) - len(kept)


def patch_gameinfo_content(content: str) -> str:
    if gameinfo_loads_pov_vpk(content):
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

    def get_skybox_assets_path(self) -> Path:
        return self.get_project_pov_dir() / "skybox_assets.vpk"

    def get_reference_default_gameinfo_path(self) -> Path:
        return self.get_project_pov_dir() / "gameinfo.gi.default"

    def get_reference_pov_gameinfo_path(self) -> Path:
        return self.get_project_pov_dir() / "gameinfo.gi.pov"

    def is_gameinfo_patched(self, content: str) -> bool:
        return gameinfo_loads_pov_vpk(content)

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
                "检测到 Agent 遗留的 gameinfo.gi POV 加载项，但未找到恢复记录，将使用残留修复。"
            )

        if pov_installed and not manifest_exists:
            warnings.append("检测到 Agent 遗留的 pov.vpk，但未找到恢复记录，将使用残留修复。")
        if backup_exists and not manifest_exists:
            warnings.append("检测到 Agent 遗留的 gameinfo.gi.bak，将在残留修复后清理。")

        orphaned_changes = bool(
            not manifest_exists
            and (gameinfo_patched or pov_installed or backup_exists)
        )
        manifest_corrupted = bool(manifest_exists and not backup_exists)
        if manifest_corrupted:
            warnings.append("POV 恢复记录存在，但 gameinfo.gi.bak 缺失，将使用残留修复。")
        if manifest_corrupted:
            state = "corrupted"
        elif manifest_exists:
            state = "managed"
        elif orphaned_changes:
            state = "orphaned"
        else:
            state = "clean"
        needs_restore = state != "clean"

        return {
            "state": state,
            "installed": pov_installed,
            "gameinfo_patched": gameinfo_patched,
            "backup_exists": backup_exists,
            "manifest_exists": manifest_exists,
            "orphaned_changes": orphaned_changes,
            "manifest_corrupted": manifest_corrupted,
            "original_gameinfo_sha256": original_gameinfo_sha256,
            "cs2_running": cs2_running,
            "needs_restore": needs_restore,
            "warnings": warnings,
        }

    @_serialized_pov_operation
    def install(
        self,
        map_name: Optional[str] = None,
        *,
        demo_path: Optional[str | Path] = None,
        input_track_report: Optional[Mapping[str, Any]] = None,
        voice_enabled: bool = True,
        advanced_playback_enabled: bool = False,
        skybox_id: str = DEFAULT_SKYBOX_ID,
    ) -> Optional[DemoVoiceHudBuild]:
        if sys.platform != "win32":
            raise PovHudError("POV HUD 仅支持 Windows。")
        if is_cs2_running():
            raise PovHudError(CS2_RUNNING_POV_MSG)

        current_status = self.status()
        if current_status.get("needs_restore"):
            self.restore()

        try:
            selected_skybox = normalize_skybox_id(skybox_id)
        except SkyboxVpkError as exc:
            raise PovHudError(str(exc)) from exc

        needs_pov_source = demo_path is not None or selected_skybox == DEFAULT_SKYBOX_ID
        pov_src: Optional[Path] = None
        if needs_pov_source:
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
                    voice_enabled=voice_enabled,
                    advanced_playback_enabled=advanced_playback_enabled,
                )
                logger.info(
                    "Built demo voice HUD: packets=%d speakers=%d intervals=%d "
                    "locations=%d input_tracks=%d input_changes=%d radio=%d "
                    "chat=%d server=%d native_radio=%d rebuilt_radio=%d radar_sounds=%d "
                    "native_sound_table=%d payload=%d bytes",
                    voice_build.voice_packets,
                    voice_build.speakers,
                    voice_build.intervals,
                    voice_build.location_changes,
                    voice_build.input_tracks,
                    voice_build.input_changes,
                    voice_build.radio_events,
                    voice_build.radio_chat_messages,
                    voice_build.radio_server_messages,
                    voice_build.radio_native_events,
                    voice_build.radio_rebuilt_events,
                    voice_build.radar_player_sounds,
                    voice_build.radar_native_sound_complete,
                    voice_build.payload_bytes,
                )
            except (DemoVoiceHudError, OSError) as exc:
                if advanced_playback_enabled:
                    raise PovHudError(f"高级播放菜单数据生成失败：{exc}") from exc
                logger.warning(
                    "Could not build demo-specific voice HUD; using the static POV package: %s",
                    exc,
                )

        package_bytes: Optional[bytes] = voice_build.vpk_bytes if voice_build is not None else None
        if selected_skybox != DEFAULT_SKYBOX_ID:
            skybox_assets = self.get_skybox_assets_path()
            if not skybox_assets.is_file():
                raise PovHudError(f"未找到天空盒资源包：{skybox_assets}")
            try:
                # Normal recording deliberately starts with an empty package,
                # so enabling a skybox never brings the POV Panorama overrides
                # into the ordinary HUD. POV recording composes onto its
                # demo-specific package (or its static fallback).
                skybox_base = package_bytes
                if demo_path is not None and skybox_base is None:
                    if pov_src is None:
                        raise PovHudError("未找到 POV HUD 资源文件，请确认 pov 目录下资源完整。")
                    skybox_base = pov_src.read_bytes()
                package_bytes = compose_recording_skybox_vpk(
                    asset_vpk_bytes=skybox_assets.read_bytes(),
                    base_vpk_bytes=skybox_base,
                    skybox_id=selected_skybox,
                    map_name=map_name,
                )
            except (OSError, SkyboxVpkError) as exc:
                raise PovHudError(f"天空盒 VPK 生成失败：{exc}") from exc

        gi_path = self.get_gameinfo_path()
        if not gi_path.is_file():
            raise PovHudError("未找到 gameinfo.gi，请确认 CS2 路径是否正确。")

        backup_dir = self.get_backup_dir()
        manifest_path = self.get_manifest_path()
        bak_path = self.get_backup_gameinfo_path()
        pov_dst = self.get_pov_vpk_target_path()

        try:
            backup_dir.mkdir(parents=True, exist_ok=True)
            raw_gi = gi_path.read_text(encoding="utf-8", errors="surrogateescape")
            original_sha = sha256_file(gi_path)
        except OSError as e:
            raise PovHudError(
                f"无法读取 gameinfo.gi 或创建备份目录 {backup_dir}。系统错误：{e}"
            ) from e

        # Each session must back up the current gameinfo.gi. Reusing an older
        # successful session's backup can roll back later Steam updates.
        try:
            _atomic_copy(gi_path, bak_path)
        except OSError as e:
            raise PovHudError(
                f"无法备份 gameinfo.gi 到 {bak_path}。请检查 CS2 目录权限。系统错误：{e}"
            ) from e

        if voice_build is not None:
            source_basename = voice_template.name
        elif selected_skybox != DEFAULT_SKYBOX_ID and demo_path is None:
            source_basename = self.get_skybox_assets_path().name
        else:
            source_basename = pov_src.name if pov_src is not None else ""

        manifest = {
            "state": "prepared",
            "enabled_by": "CS2 Insight Agent",
            "feature": (
                "experimental_pov_with_skybox"
                if demo_path is not None and selected_skybox != DEFAULT_SKYBOX_ID
                else "recording_skybox"
                if selected_skybox != DEFAULT_SKYBOX_ID
                else "experimental_pov"
            ),
            "installed_at": datetime.now(timezone.utc).isoformat(),
            "gameinfo_path": str(gi_path),
            "backup_gameinfo_path": str(bak_path),
            "pov_vpk_path": str(pov_dst),
            "pov_vpk_source_basename": source_basename,
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
                    "radar_native_sound_complete": bool(voice_build.radar_native_sound_complete),
                    "kill_feedback_events": voice_build.kill_feedback_events,
                    "kill_feedback_parse_failed": bool(voice_build.kill_feedback_parse_failed),
                    "flash_blind_events": voice_build.flash_blind_events,
                    "flash_blind_parse_failed": bool(voice_build.flash_blind_parse_failed),
                    "flash_blind_tick_fallback": bool(voice_build.flash_blind_tick_fallback),
                    "radio_events": voice_build.radio_events,
                    "radio_native_events": voice_build.radio_native_events,
                    "radio_rebuilt_events": voice_build.radio_rebuilt_events,
                    "radio_objective_events": voice_build.radio_objective_events,
                    "radio_chat_messages": voice_build.radio_chat_messages,
                    "radio_server_messages": voice_build.radio_server_messages,
                    "radio_parse_failed": bool(voice_build.radio_parse_failed),
                    "advanced_playback_enabled": bool(voice_build.advanced_playback_enabled),
                    "advanced_playback_players": voice_build.advanced_playback_players,
                    "advanced_playback_events": voice_build.advanced_playback_events,
                    "advanced_playback_rounds": voice_build.advanced_playback_rounds,
                    "advanced_playback_total_tick": voice_build.advanced_playback_total_tick,
                    "advanced_playback_parse_failed": bool(voice_build.advanced_playback_parse_failed),
                }
                if voice_build is not None
                else None
            ),
            "demo_map_name_used": (map_name or "").strip(),
            "recording_skybox_id": selected_skybox,
            "original_gameinfo_sha256": original_sha,
        }
        try:
            _atomic_write_json(manifest_path, manifest)
        except OSError as e:
            try:
                bak_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise PovHudError(
                f"无法写入 POV 恢复记录 {manifest_path}。请检查 CS2 目录权限。系统错误：{e}"
            ) from e

        def rollback_failed_install() -> None:
            try:
                self.restore()
            except Exception as rollback_error:  # noqa: BLE001
                logger.error("Could not roll back failed POV HUD install: %s", rollback_error)

        try:
            if package_bytes is not None:
                _atomic_write_bytes(pov_dst, package_bytes)
            else:
                if pov_src is None:
                    raise PovHudError("未找到可安装的录制 VPK 资源。")
                _atomic_copy(pov_src, pov_dst)
        except (OSError, PovHudError) as e:
            rollback_failed_install()
            if isinstance(e, PovHudError):
                raise
            raise PovHudError(
                f"无法写入 POV HUD 文件 {pov_dst}。请检查 CS2 目录权限。系统错误：{e}"
            ) from e

        try:
            patched_txt = patch_gameinfo_content(raw_gi)
            _atomic_write_text(gi_path, patched_txt)
            patched_sha = sha256_file(gi_path)
            pov_sha = sha256_file(pov_dst)
        except (OSError, PovHudError) as e:
            rollback_failed_install()
            if isinstance(e, PovHudError):
                raise
            raise PovHudError(
                f"无法修改或校验 {gi_path}。请检查 CS2 目录权限。系统错误：{e}"
            ) from e

        manifest.update(
            {
                "state": "installed",
                "patched_gameinfo_sha256": patched_sha,
                "installed_pov_vpk_sha256": pov_sha,
            }
        )
        try:
            _atomic_write_json(manifest_path, manifest)
        except OSError as e:
            rollback_failed_install()
            raise PovHudError(
                f"无法完成 POV 恢复记录 {manifest_path}，已尝试回滚。系统错误：{e}"
            ) from e

        return voice_build

    @_serialized_pov_operation
    def restore(self) -> dict[str, Any]:
        if sys.platform != "win32":
            raise PovHudError("POV HUD 仅支持 Windows。")

        manifest_path = self.get_manifest_path()
        bak_path = self.get_backup_gameinfo_path()
        gi_path = self.get_gameinfo_path()
        pov_dst = self.get_pov_vpk_target_path()
        backup_dir = self.get_backup_dir()

        if not gi_path.is_file():
            raise PovHudError(
                f"无法恢复 POV HUD：{gi_path} 不存在。请先通过 Steam 验证游戏文件完整性。"
            )
        status = self.status()
        if not status.get("needs_restore"):
            verification = self.verify_restoration(None)
            verification.update(
                {
                    "verified": True,
                    "gameinfo_restored": not bool(
                        verification.get("gameinfo_has_pov_entry")
                    ),
                    "verification_mode": "none",
                    "byte_verified": False,
                    "not_needed": True,
                    "error": "",
                }
            )
            return verification

        if is_cs2_running():
            raise PovHudError("检测到 CS2 正在运行，请先关闭 CS2 后再恢复 POV HUD 修改。")

        def remove_installed_vpk() -> None:
            try:
                pov_dst.unlink(missing_ok=True)
            except OSError as e:
                raise PovHudError(
                    f"无法删除 Agent 安装的 POV HUD 文件 {pov_dst}。系统错误：{e}"
                ) from e

        def cleanup_recovery_files() -> None:
            try:
                manifest_path.unlink(missing_ok=True)
                bak_path.unlink(missing_ok=True)
                if backup_dir.is_dir() and not any(backup_dir.iterdir()):
                    backup_dir.rmdir()
            except OSError as e:
                raise PovHudError(
                    f"POV 文件已恢复，但无法清理恢复记录 {backup_dir}。系统错误：{e}"
                ) from e

        manifest = self._read_manifest() if manifest_path.is_file() else {}
        expected_sha = str(
            manifest.get("original_gameinfo_sha256") or ""
        ).strip().lower() or None
        patched_sha = str(
            manifest.get("patched_gameinfo_sha256") or ""
        ).strip().lower() or None
        strict_fallback_reason = "missing_or_incomplete_restore_record"

        if expected_sha and bak_path.is_file():
            try:
                backup_sha = sha256_file(bak_path)
                backup_content = bak_path.read_text(encoding="utf-8", errors="ignore")
                current_sha = sha256_file(gi_path)
            except OSError as e:
                strict_fallback_reason = f"backup_verification_failed: {e}"
            else:
                current_matches_session = current_sha in {
                    expected_sha,
                    patched_sha,
                }
                if backup_sha != expected_sha:
                    strict_fallback_reason = "backup_hash_mismatch"
                elif gameinfo_loads_pov_vpk(backup_content):
                    strict_fallback_reason = "backup_contains_pov_entry"
                elif not current_matches_session:
                    strict_fallback_reason = "gameinfo_changed_after_install"
                else:
                    try:
                        _atomic_copy(bak_path, gi_path)
                    except OSError as e:
                        raise PovHudError(
                            f"无法从 {bak_path} 恢复 {gi_path}。系统错误：{e}"
                        ) from e
                    remove_installed_vpk()
                    verification = self.verify_restoration(expected_sha)
                    if verification.get("verified"):
                        cleanup_recovery_files()
                        verification = self.verify_restoration(expected_sha)
                        verification.update(
                            {
                                "verification_mode": "strict",
                                "byte_verified": True,
                                "not_needed": False,
                                "removed_gameinfo_entries": 0,
                                "error": "",
                            }
                        )
                        return verification
                    strict_fallback_reason = "strict_verification_failed"

        try:
            current_content = gi_path.read_text(
                encoding="utf-8",
                errors="surrogateescape",
            )
            cleaned_content, removed_entries = remove_pov_gameinfo_entries(
                current_content
            )
            if removed_entries:
                _atomic_write_text(gi_path, cleaned_content)
        except OSError as e:
            raise PovHudError(
                f"无法清理 {gi_path} 中的 POV 加载项。请检查目录权限。系统错误：{e}"
            ) from e

        remove_installed_vpk()
        verification = self.verify_restoration(None)
        semantic_verified = bool(
            verification.get("gameinfo_exists")
            and verification.get("gameinfo_has_pov_entry") is False
            and verification.get("pov_vpk_removed")
        )
        if not semantic_verified:
            raise PovHudError("POV 残留修复验证失败：加载项或 pov.vpk 仍然存在。")

        cleanup_recovery_files()
        verification = self.verify_restoration(None)
        verification.update(
            {
                "verified": True,
                "gameinfo_restored": True,
                "verification_mode": "semantic",
                "byte_verified": False,
                "not_needed": False,
                "removed_gameinfo_entries": removed_entries,
                "strict_fallback_reason": strict_fallback_reason,
                "error": "",
            }
        )
        return verification

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
            "default_has_pov": gameinfo_loads_pov_vpk(td),
            "pov_has_pov": gameinfo_loads_pov_vpk(tp),
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
                if (
                    verification.get("verified")
                    and verification.get("verification_mode") == "semantic"
                ):
                    verification["error"] = ""
                    event_logger.info(
                        "POV HUD residue removed and semantically verified after CS2 exit"
                    )
                    return verification
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
        if st.get("needs_restore") and not st.get("cs2_running"):
            restored = mgr.restore()
            mode = str(restored.get("verification_mode") or "")
            if mode == "semantic":
                out.append("已自动清理上次遗留的 POV HUD 文件和 gameinfo.gi 加载项。")
            else:
                out.append("已自动恢复上次未完成的 POV HUD 修改。")
    except PovHudError as e:
        out.append(str(e))
    except Exception:
        pass
    return out
