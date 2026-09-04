"""录制 VPK 生命周期：生成天空/POV 包，临时挂载 gameinfo.gi，并可靠恢复。"""

from __future__ import annotations

import ctypes
import hashlib
import json
import logging
import os
import re
import shutil
import sys
import tempfile
import threading
import time
from contextlib import ExitStack
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

from .chroma_skybox_child import (
    CHROMA_CHILD_MANIFEST_SCHEMA_VERSION,
    ChromaSkyboxChildError,
    build_chroma_child_vpk,
)
from .chroma_main_map import (
    CHROMA_MAIN_MAP_MANIFEST_SCHEMA_VERSION,
    ChromaMainMapError,
    build_chroma_main_map_vpk,
)
from .cs2_config_backup import is_cs2_running
from .demo_voice_hud import (
    DemoVoiceHudBuild,
    DemoVoiceHudError,
    build_demo_voice_hud_vpk,
    read_inline_vpk,
)
from .demo_playback_compat import detect_demo_map_name_from_spawn_groups
from .inline_vpk_stream import (
    InlineVpkStreamError,
    VerifiedFileSource,
    write_inline_vpk_file,
)
from .input_command import InputCommandError, load_input_report
from .map_material_vpk import (
    DEFAULT_MAP_MATERIAL_ID,
    MapMaterialVpkError,
    RAIN_PUDDLES_MAP_MATERIAL_ID,
    compose_recording_map_material_vpk,
    map_material_console_commands,
    normalize_map_material_id,
)
from .map_sun_vpk import (
    MAP_SUN_SUPPRESSION_MAPS,
    MapSunVpkError,
    compose_map_sun_suppression_vpk,
)
from .pov_constants import DEFAULT_POV_VOICE_MODE, normalize_pov_voice_mode
from .skybox_vpk import (
    CHROMA_SKYBOX_IDS,
    DEFAULT_SKYBOX_ID,
    SKYBOX_ASSETS,
    SkyboxVpkError,
    compose_recording_skybox_vpk,
    normalize_skybox_id,
    normalize_skybox_map_name,
)
from .weather_effects import (
    DEFAULT_WEATHER_EFFECT_ID,
    RAIN_WEATHER_EFFECT_ID,
    SNOW_WEATHER_EFFECT_ID,
    WeatherEffectError,
    normalize_weather_effect_id,
)
from .weather_particle_vpk import (
    TRAIN_SNOW_PROBE_MAP,
    WeatherParticleVpkError,
    build_train_snow_particle_override_vpk,
)

logger = logging.getLogger(__name__)

CS2_RUNNING_POV_MSG = (
    "检测到 CS2 正在运行。POV HUD 需要修改本地资源加载配置，请先关闭 CS2 后再继续。"
)


class PovHudError(RuntimeError):
    pass


_POV_OPERATION_LOCK = threading.RLock()
_POV_OPERATION_MUTEX_NAME = "Local\\CS2InsightAgentPovHudOperation"
_CHROMA_MAP_NAME_RE = re.compile(r"^de_[a-z0-9_]+$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_CHROMA_RUNTIME_DIRNAME = "cs2_insight_chroma_runtime"
_CHROMA_RUNTIME_SEARCH_PATH = f"csgo/{_CHROMA_RUNTIME_DIRNAME}"
_CHROMA_SWAP_BACKUP_DIRNAME = "chroma_originals"
_CHROMA_OFFICIAL_SWAP_ROUTE = "transactional_official_child_vpk_swap"


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


def _pov_dir_has_recording_assets(pov_dir: Path) -> bool:
    return (
        (pov_dir / "pov.vpk").is_file()
        or (pov_dir / "pov_default.vpk").is_file()
        or (pov_dir / "skyboxes").is_dir()
    )


def find_project_root() -> Path:
    current = Path(__file__).resolve()
    for parent in [current.parent, *current.parents]:
        if _pov_dir_has_recording_assets(parent / "pov"):
            return parent
    raise PovHudError("未找到项目根目录下的录制资源（POV HUD 或天空盒目录）。")


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


def _line_loads_chroma_runtime(line: str) -> bool:
    stripped = line.strip()
    if not stripped or stripped.startswith("//"):
        return False
    parts = stripped.split()
    return bool(
        len(parts) >= 2
        and parts[0].lower() == "game"
        and parts[1].replace("\\", "/").lower()
        == _CHROMA_RUNTIME_SEARCH_PATH.lower()
    )


def gameinfo_loads_pov_vpk(content: str) -> bool:
    return any(_line_loads_pov_vpk(line) for line in content.splitlines())


def gameinfo_loads_chroma_runtime(content: str) -> bool:
    return any(_line_loads_chroma_runtime(line) for line in content.splitlines())


def remove_pov_gameinfo_entries(content: str) -> tuple[str, int]:
    """Remove only Agent-owned POV/chroma search-path entries."""
    lines = content.splitlines(keepends=True)
    kept = [
        line
        for line in lines
        if not _line_loads_pov_vpk(line)
        and not _line_loads_chroma_runtime(line)
    ]
    return "".join(kept), len(lines) - len(kept)


def patch_gameinfo_content(
    content: str,
    *,
    include_chroma_runtime: bool = False,
) -> str:
    has_pov = gameinfo_loads_pov_vpk(content)
    has_runtime = gameinfo_loads_chroma_runtime(content)
    if has_pov and (not include_chroma_runtime or has_runtime):
        return content

    managed_lines: list[str] = []
    if not has_pov:
        managed_lines.append("Game    csgo/pov.vpk")
    if include_chroma_runtime and not has_runtime:
        managed_lines.append(f"Game    {_CHROMA_RUNTIME_SEARCH_PATH}")

    lines = content.splitlines()
    patched: list[str] = []
    inserted = False

    for line in lines:
        patched.append(line)
        if not inserted and "Game_LowViolence" in line and "csgo_lv" in line:
            indent = line[: len(line) - len(line.lstrip())]
            patched.append("")
            patched.extend(f"{indent}{managed_line}" for managed_line in managed_lines)
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
                patched.extend(f"{indent}{managed_line}" for managed_line in managed_lines)
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


def _read_json_manifest(path: Path, *, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError) as exc:
        raise PovHudError(f"无法读取{label}：{path}；{exc}") from exc
    if not isinstance(value, dict):
        raise PovHudError(f"{label}必须是 JSON 对象：{path}")
    return value


def _normalize_catalog_map_key(value: object, *, field: str) -> str:
    if not isinstance(value, str):
        raise PovHudError(f"蓝/绿幕主地图目录字段 {field} 必须是字符串。")
    normalized = normalize_skybox_map_name(value)
    if value != normalized or not _CHROMA_MAP_NAME_RE.fullmatch(normalized):
        raise PovHudError(f"蓝/绿幕主地图目录字段 {field} 不是规范地图名：{value!r}")
    return normalized


def _chroma_main_patch_required(
    manifest: Mapping[str, Any],
    map_name: object,
) -> bool:
    """Resolve the explicit, fail-closed main-map routing contract."""

    if manifest.get("schema_version") != CHROMA_MAIN_MAP_MANIFEST_SCHEMA_VERSION:
        raise PovHudError("不支持的蓝/绿幕主地图目录版本。")
    maps = manifest.get("maps")
    no_main = manifest.get("no_main_patch_required")
    if not isinstance(maps, Mapping):
        raise PovHudError("蓝/绿幕主地图目录 maps 必须是对象。")
    if not isinstance(no_main, list):
        raise PovHudError("蓝/绿幕主地图目录缺少 no_main_patch_required 显式列表。")

    map_keys = {
        _normalize_catalog_map_key(key, field=f"maps.{key}")
        for key in maps
    }
    no_main_keys = [
        _normalize_catalog_map_key(value, field=f"no_main_patch_required[{index}]")
        for index, value in enumerate(no_main)
    ]
    if len(no_main_keys) != len(set(no_main_keys)):
        raise PovHudError("蓝/绿幕主地图目录 no_main_patch_required 存在重复地图。")
    no_main_set = set(no_main_keys)
    overlap = map_keys.intersection(no_main_set)
    if overlap:
        raise PovHudError(
            "蓝/绿幕主地图目录同时要求构建和跳过主地图补丁："
            + ", ".join(sorted(overlap))
        )

    normalized_map = normalize_skybox_map_name(map_name)
    if not _CHROMA_MAP_NAME_RE.fullmatch(normalized_map):
        raise PovHudError("蓝/绿幕需要明确且有效的 Demo 地图名。")
    in_maps = normalized_map in map_keys
    in_no_main = normalized_map in no_main_set
    if in_maps == in_no_main:
        raise PovHudError(
            f"蓝/绿幕主地图目录没有给 {normalized_map} 唯一且明确的处理策略。"
        )
    return in_maps


def _chroma_child_main_patch_required(
    manifest: Mapping[str, Any],
    map_name: object,
) -> bool:
    """Read the child's duplicate routing assertion with strict typing."""

    if manifest.get("schema_version") != CHROMA_CHILD_MANIFEST_SCHEMA_VERSION:
        raise PovHudError("不支持的蓝/绿幕子天空盒目录版本。")
    maps = manifest.get("maps")
    if not isinstance(maps, Mapping):
        raise PovHudError("蓝/绿幕子天空盒目录 maps 必须是对象。")
    normalized_map = normalize_skybox_map_name(map_name)
    if not _CHROMA_MAP_NAME_RE.fullmatch(normalized_map):
        raise PovHudError("蓝/绿幕需要明确且有效的 Demo 地图名。")
    profile = maps.get(normalized_map)
    if not isinstance(profile, Mapping):
        raise PovHudError(
            f"蓝/绿幕子天空盒目录不支持地图 {normalized_map}。"
        )
    required = profile.get("main_map_patch_required")
    if type(required) is not bool:
        raise PovHudError(
            "蓝/绿幕子天空盒目录的 main_map_patch_required "
            f"必须是布尔值：{normalized_map}。"
        )
    return required


def _detect_chroma_demo_map_name(demo_path: str | Path) -> str:
    """Detect a Demo map from the header, then authoritative terminal SpawnGroups.

    The historical name is retained for compatibility, but the detector is
    shared by every map-specific visual preset, including rain and puddles.
    """

    path = Path(demo_path).expanduser()
    if not path.is_file():
        raise PovHudError(f"无法识别 Demo 地图：Demo 文件不存在 {path}。")
    header_error = ""
    try:
        from demoparser2 import DemoParser

        header = DemoParser(str(path)).parse_header()
    except (KeyboardInterrupt, SystemExit, GeneratorExit):
        raise
    except BaseException as exc:  # PyO3 PanicException is not an Exception subclass.
        header = None
        header_error = str(exc)
    if isinstance(header, Mapping):
        detected = normalize_skybox_map_name(header.get("map_name"))
        if _CHROMA_MAP_NAME_RE.fullmatch(detected):
            return detected
        header_error = "map_name 缺失或无效"
    elif not header_error:
        header_error = "返回格式无效"

    try:
        detected = normalize_skybox_map_name(
            detect_demo_map_name_from_spawn_groups(path)
        )
    except (OSError, ValueError) as exc:
        raise PovHudError(
            "无法从 Demo 头或 SpawnGroups 确认地图："
            f"header={header_error or 'unknown'}; SpawnGroups={exc}"
        ) from exc
    if not _CHROMA_MAP_NAME_RE.fullmatch(detected):
        raise PovHudError("Demo SpawnGroups 返回了无效地图名。")
    return detected


def _enter_chroma_staging_dir(stack: ExitStack, *, csgo_dir: Path) -> Path:
    """Create staging outside the game tree and bind cleanup to the install call."""

    temp_root = Path(tempfile.gettempdir()).resolve()
    game_root = Path(csgo_dir).resolve()
    if temp_root == game_root or temp_root.is_relative_to(game_root):
        raise PovHudError("系统临时目录位于 CS2 游戏目录内，无法安全构建蓝/绿幕 VPK。")
    staging = stack.enter_context(
        tempfile.TemporaryDirectory(prefix="cs2-insight-chroma-", dir=temp_root)
    )
    return Path(staging)


def _resolve_chroma_runtime_target(runtime_root: Path, logical_path: str) -> Path:
    normalized = str(logical_path or "").replace("\\", "/")
    parts = normalized.split("/")
    if (
        not normalized
        or normalized.startswith("/")
        or ":" in normalized
        or any(not part or part in {".", ".."} for part in parts)
        or not normalized.lower().endswith(".vpk")
    ):
        raise PovHudError(f"蓝/绿幕运行 VPK 路径无效：{logical_path!r}")
    root = runtime_root.resolve()
    target = root.joinpath(*parts).resolve()
    if target == root or not target.is_relative_to(root):
        raise PovHudError(f"蓝/绿幕运行 VPK 路径越界：{logical_path!r}")
    return target


def _verified_vpk_identity(
    metadata: Mapping[str, Any],
    *,
    field: str,
) -> tuple[int, str]:
    value = metadata.get(field)
    if not isinstance(value, Mapping):
        raise PovHudError(f"蓝/绿幕 VPK 缺少 {field} 身份信息。")
    size = value.get("size")
    sha256 = str(value.get("sha256") or "").strip().lower()
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        raise PovHudError(f"蓝/绿幕 VPK 的 {field}.size 无效。")
    if not _SHA256_RE.fullmatch(sha256):
        raise PovHudError(f"蓝/绿幕 VPK 的 {field}.sha256 无效。")
    return size, sha256


def _chroma_official_swap_records(
    manifest: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    section = manifest.get("chroma_official_swaps")
    if section is None:
        return []
    if not isinstance(section, Mapping):
        raise PovHudError("蓝/绿幕官方 VPK 恢复记录格式无效。")
    if section.get("route") != _CHROMA_OFFICIAL_SWAP_ROUTE:
        raise PovHudError("蓝/绿幕官方 VPK 恢复路线无效。")
    files = section.get("files")
    if not isinstance(files, list) or not files:
        raise PovHudError("蓝/绿幕官方 VPK 恢复记录没有文件。")
    if any(not isinstance(item, Mapping) for item in files):
        raise PovHudError("蓝/绿幕官方 VPK 恢复文件记录格式无效。")
    return files


def _validated_chroma_swap_record(
    record: Mapping[str, Any],
    *,
    csgo_root: Path,
    backup_root: Path,
) -> tuple[Path, Path, int, str, int, str]:
    logical_path = str(record.get("logical_path") or "")
    target = _resolve_chroma_runtime_target(csgo_root, logical_path)
    backup = _resolve_chroma_runtime_target(backup_root, logical_path)
    original_size = record.get("original_size")
    installed_size = record.get("installed_size")
    original_sha256 = str(record.get("original_sha256") or "").strip().lower()
    installed_sha256 = str(record.get("installed_sha256") or "").strip().lower()
    if (
        isinstance(original_size, bool)
        or not isinstance(original_size, int)
        or original_size < 0
        or isinstance(installed_size, bool)
        or not isinstance(installed_size, int)
        or installed_size < 0
        or not _SHA256_RE.fullmatch(original_sha256)
        or not _SHA256_RE.fullmatch(installed_sha256)
    ):
        raise PovHudError(f"蓝/绿幕官方 VPK 恢复身份无效：{logical_path!r}")
    return (
        target,
        backup,
        original_size,
        original_sha256,
        installed_size,
        installed_sha256,
    )


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

    def get_chroma_runtime_dir(self) -> Path:
        return self.get_csgo_dir() / _CHROMA_RUNTIME_DIRNAME

    def get_backup_dir(self) -> Path:
        return self.get_csgo_dir() / ".cs2_insight_pov_backup"

    def get_manifest_path(self) -> Path:
        return self.get_backup_dir() / "pov_manifest.json"

    def get_backup_gameinfo_path(self) -> Path:
        return self.get_backup_dir() / "gameinfo.gi.bak"

    def get_chroma_swap_backup_dir(self) -> Path:
        return self.get_backup_dir() / _CHROMA_SWAP_BACKUP_DIRNAME

    def get_project_pov_dir(self) -> Path:
        return find_project_root() / "pov"

    def get_pov_vpk_source_path(self, map_name: Optional[str] = None) -> Path:
        return resolve_pov_vpk_source_in_project_pov_dir(self.get_project_pov_dir(), map_name)

    def get_voice_hud_template_path(
        self,
        *,
        advanced_playback_enabled: bool = False,
    ) -> Path:
        filename = (
            "pov_advanced_playback_template.vpk"
            if advanced_playback_enabled
            else "pov_voice_template.vpk"
        )
        return self.get_project_pov_dir() / filename

    def get_skybox_assets_dir(self) -> Path:
        return self.get_project_pov_dir() / "skyboxes"

    def get_map_material_assets_dir(self) -> Path:
        return self.get_project_pov_dir() / "map_materials"

    def get_chroma_child_assets_dir(self) -> Path:
        return self.get_project_pov_dir() / "chroma_skybox_children"

    def get_chroma_main_map_assets_dir(self) -> Path:
        return self.get_project_pov_dir() / "chroma_main_maps"

    def get_weather_effect_assets_dir(self, effect_id: str) -> Path:
        return self.get_project_pov_dir() / "weather_effects" / effect_id

    def get_reference_default_gameinfo_path(self) -> Path:
        return self.get_project_pov_dir() / "gameinfo.gi.default"

    def get_reference_pov_gameinfo_path(self) -> Path:
        return self.get_project_pov_dir() / "gameinfo.gi.pov"

    def is_gameinfo_patched(self, content: str) -> bool:
        return bool(
            gameinfo_loads_pov_vpk(content)
            or gameinfo_loads_chroma_runtime(content)
        )

    def _read_manifest(self) -> dict[str, Any]:
        path = self.get_manifest_path()
        if not path.is_file():
            return {}
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return {}
        return value if isinstance(value, dict) else {}

    def _verify_chroma_official_swaps(
        self,
        manifest: Mapping[str, Any],
    ) -> tuple[bool, list[str]]:
        errors: list[str] = []
        try:
            records = _chroma_official_swap_records(manifest)
        except PovHudError as exc:
            return False, [str(exc)]
        if not records:
            return True, errors
        csgo_root = self.get_csgo_dir()
        backup_root = self.get_chroma_swap_backup_dir()
        for record in records:
            try:
                target, _backup, original_size, original_sha, _installed_size, _installed_sha = (
                    _validated_chroma_swap_record(
                        record,
                        csgo_root=csgo_root,
                        backup_root=backup_root,
                    )
                )
                if not target.is_file() or target.is_symlink():
                    raise PovHudError(f"官方蓝/绿幕 VPK 不存在或不是普通文件：{target}")
                if target.stat().st_size != original_size or sha256_file(target) != original_sha:
                    raise PovHudError(f"官方蓝/绿幕 VPK 尚未恢复：{target}")
            except (OSError, PovHudError) as exc:
                errors.append(str(exc))
        return not errors, errors

    def _restore_chroma_official_swaps(
        self,
        manifest: Mapping[str, Any],
    ) -> list[str]:
        records = _chroma_official_swap_records(manifest)
        if not records:
            return []
        csgo_root = self.get_csgo_dir()
        backup_root = self.get_chroma_swap_backup_dir()
        restored: list[str] = []
        for record in records:
            (
                target,
                backup,
                original_size,
                original_sha,
                installed_size,
                installed_sha,
            ) = _validated_chroma_swap_record(
                record,
                csgo_root=csgo_root,
                backup_root=backup_root,
            )
            if not target.is_file() or target.is_symlink():
                raise PovHudError(f"无法恢复官方蓝/绿幕 VPK：目标不存在或不是普通文件 {target}")
            current_size = target.stat().st_size
            current_sha = sha256_file(target)
            if current_size == original_size and current_sha == original_sha:
                restored.append(str(target))
                continue
            if current_size != installed_size or current_sha != installed_sha:
                raise PovHudError(
                    "拒绝覆盖会话外发生变化的官方蓝/绿幕 VPK："
                    f"{target}"
                )
            if not backup.is_file() or backup.is_symlink():
                raise PovHudError(f"无法恢复官方蓝/绿幕 VPK：备份不存在 {backup}")
            if backup.stat().st_size != original_size or sha256_file(backup) != original_sha:
                raise PovHudError(f"无法恢复官方蓝/绿幕 VPK：备份身份校验失败 {backup}")
            _atomic_copy(backup, target)
            if target.stat().st_size != original_size or sha256_file(target) != original_sha:
                raise PovHudError(f"官方蓝/绿幕 VPK 恢复后校验失败：{target}")
            restored.append(str(target))
        return restored

    def _cleanup_chroma_swap_backups(self) -> None:
        swap_root = self.get_chroma_swap_backup_dir()
        if not swap_root.exists():
            return
        backup_root = self.get_backup_dir().resolve()
        resolved = swap_root.resolve()
        if (
            swap_root.name != _CHROMA_SWAP_BACKUP_DIRNAME
            or resolved.parent != backup_root
        ):
            raise PovHudError(f"拒绝清理越界的蓝/绿幕 VPK 备份目录：{swap_root}")
        try:
            shutil.rmtree(swap_root)
        except OSError as exc:
            raise PovHudError(f"无法清理蓝/绿幕 VPK 备份目录 {swap_root}：{exc}") from exc

    def _assert_orphan_chroma_swap_backups_safe(self) -> None:
        swap_root = self.get_chroma_swap_backup_dir()
        if not swap_root.exists():
            return
        if swap_root.is_symlink() or not swap_root.is_dir():
            raise PovHudError(f"蓝/绿幕 VPK 备份目录无效：{swap_root}")
        csgo_root = self.get_csgo_dir()
        for backup in swap_root.rglob("*"):
            if backup.is_dir():
                continue
            if backup.is_symlink() or not backup.is_file():
                raise PovHudError(f"蓝/绿幕 VPK 孤立备份无效：{backup}")
            relative = backup.relative_to(swap_root).as_posix()
            target = _resolve_chroma_runtime_target(csgo_root, relative)
            if (
                not target.is_file()
                or target.is_symlink()
                or target.stat().st_size != backup.stat().st_size
                or sha256_file(target) != sha256_file(backup)
            ):
                raise PovHudError(
                    "蓝/绿幕官方 VPK 恢复记录缺失且目标与备份不同，"
                    f"拒绝自动覆盖或删除备份：{target}"
                )

    def verify_restoration(self, expected_gameinfo_sha256: Optional[str] = None) -> dict[str, Any]:
        """Return file-system evidence for POV restoration without inferring success."""
        gi_path = self.get_gameinfo_path()
        pov_path = self.get_pov_vpk_target_path()
        chroma_runtime_path = self.get_chroma_runtime_dir()
        manifest_path = self.get_manifest_path()
        backup_path = self.get_backup_gameinfo_path()
        manifest = self._read_manifest() if manifest_path.is_file() else {}
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
        chroma_runtime_exists = chroma_runtime_path.exists()
        chroma_runtime_removed = not chroma_runtime_exists
        chroma_official_swaps_restored, swap_errors = (
            self._verify_chroma_official_swaps(manifest)
        )
        errors.extend(swap_errors)
        return {
            "verified": bool(
                gameinfo_restored
                and pov_vpk_removed
                and chroma_runtime_removed
                and chroma_official_swaps_restored
            ),
            "gameinfo_path": str(gi_path),
            "gameinfo_exists": gi_path.is_file(),
            "gameinfo_restored": gameinfo_restored,
            "gameinfo_has_pov_entry": gameinfo_has_pov_entry,
            "expected_gameinfo_sha256": expected_sha,
            "actual_gameinfo_sha256": actual_sha,
            "pov_vpk_path": str(pov_path),
            "pov_vpk_exists": pov_vpk_exists,
            "pov_vpk_removed": pov_vpk_removed,
            "chroma_runtime_path": str(chroma_runtime_path),
            "chroma_runtime_exists": chroma_runtime_exists,
            "chroma_runtime_removed": chroma_runtime_removed,
            "chroma_official_swaps_restored": chroma_official_swaps_restored,
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
        chroma_runtime = csgo / _CHROMA_RUNTIME_DIRNAME if csgo else None
        chroma_swap_backup = (
            csgo / ".cs2_insight_pov_backup" / _CHROMA_SWAP_BACKUP_DIRNAME
            if csgo
            else None
        )

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
        chroma_runtime_installed = bool(chroma_runtime and chroma_runtime.exists())
        chroma_swap_backup_exists = bool(
            chroma_swap_backup and chroma_swap_backup.exists()
        )
        manifest = self._read_manifest() if manifest_exists else {}
        chroma_official_swap_managed = bool(
            isinstance(manifest.get("chroma_official_swaps"), Mapping)
        )
        original_gameinfo_sha256 = str(manifest.get("original_gameinfo_sha256") or "").strip().lower() or None

        if gameinfo_patched and not manifest_exists:
            warnings.append(
                "检测到 Agent 遗留的 gameinfo.gi POV 加载项，但未找到恢复记录，将使用残留修复。"
            )

        if pov_installed and not manifest_exists:
            warnings.append("检测到 Agent 遗留的 pov.vpk，但未找到恢复记录，将使用残留修复。")
        if chroma_runtime_installed and not manifest_exists:
            warnings.append(
                "检测到 Agent 遗留的蓝/绿幕运行目录，但未找到恢复记录，将使用残留修复。"
            )
        if chroma_swap_backup_exists and not manifest_exists:
            warnings.append(
                "检测到蓝/绿幕官方 VPK 备份但恢复记录缺失；若官方文件身份不一致将拒绝自动覆盖。"
            )
        if backup_exists and not manifest_exists:
            warnings.append("检测到 Agent 遗留的 gameinfo.gi.bak，将在残留修复后清理。")

        orphaned_changes = bool(
            not manifest_exists
            and (
                gameinfo_patched
                or pov_installed
                or chroma_runtime_installed
                or chroma_swap_backup_exists
                or backup_exists
            )
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
            "chroma_runtime_installed": chroma_runtime_installed,
            "chroma_official_swap_managed": chroma_official_swap_managed,
            "chroma_swap_backup_exists": chroma_swap_backup_exists,
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
        voice_mode: str = DEFAULT_POV_VOICE_MODE,
        advanced_playback_enabled: bool = False,
        skybox_id: str = DEFAULT_SKYBOX_ID,
        map_material_id: str = DEFAULT_MAP_MATERIAL_ID,
        input_hud_enabled: bool = True,
        input_hud_display_mode: str = "hybrid",
        input_hud_scale_percent: int = 100,
        input_audio_enabled: bool = True,
        input_audio_volume_percent: int = 100,
        combat_stats_enabled: bool = True,
        weather_effect_id: str = DEFAULT_WEATHER_EFFECT_ID,
    ) -> Optional[DemoVoiceHudBuild]:
        with ExitStack() as staging_stack:
            return self._install_impl(
                map_name,
                demo_path=demo_path,
                input_track_report=input_track_report,
                voice_enabled=voice_enabled,
                voice_mode=voice_mode,
                advanced_playback_enabled=advanced_playback_enabled,
                skybox_id=skybox_id,
                map_material_id=map_material_id,
                input_hud_enabled=input_hud_enabled,
                input_hud_display_mode=input_hud_display_mode,
                input_hud_scale_percent=input_hud_scale_percent,
                input_audio_enabled=input_audio_enabled,
                input_audio_volume_percent=input_audio_volume_percent,
                combat_stats_enabled=combat_stats_enabled,
                weather_effect_id=weather_effect_id,
                staging_stack=staging_stack,
            )

    def _install_impl(
        self,
        map_name: Optional[str] = None,
        *,
        demo_path: Optional[str | Path] = None,
        input_track_report: Optional[Mapping[str, Any]] = None,
        voice_enabled: bool = True,
        voice_mode: str = DEFAULT_POV_VOICE_MODE,
        advanced_playback_enabled: bool = False,
        skybox_id: str = DEFAULT_SKYBOX_ID,
        map_material_id: str = DEFAULT_MAP_MATERIAL_ID,
        input_hud_enabled: bool = True,
        input_hud_display_mode: str = "hybrid",
        input_hud_scale_percent: int = 100,
        input_audio_enabled: bool = True,
        input_audio_volume_percent: int = 100,
        combat_stats_enabled: bool = True,
        weather_effect_id: str = DEFAULT_WEATHER_EFFECT_ID,
        staging_stack: ExitStack,
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
        try:
            selected_map_material = normalize_map_material_id(map_material_id)
        except MapMaterialVpkError as exc:
            raise PovHudError(str(exc)) from exc
        try:
            selected_weather = normalize_weather_effect_id(weather_effect_id)
        except WeatherEffectError as exc:
            raise PovHudError(str(exc)) from exc
        if selected_map_material == RAIN_PUDDLES_MAP_MATERIAL_ID:
            if selected_weather not in (
                DEFAULT_WEATHER_EFFECT_ID,
                RAIN_WEATHER_EFFECT_ID,
            ):
                raise PovHudError("全局雨天地图适配不能与另一种天气粒子同时启用。")
            # Compatibility for clients/presets from before rain became an
            # independent weather category.
            selected_map_material = DEFAULT_MAP_MATERIAL_ID
            selected_weather = RAIN_WEATHER_EFFECT_ID
        if (
            selected_map_material != DEFAULT_MAP_MATERIAL_ID
            and selected_weather != DEFAULT_WEATHER_EFFECT_ID
        ):
            raise PovHudError("打蜡与天气效果不能同时启用。")
        effective_map_material = (
            RAIN_PUDDLES_MAP_MATERIAL_ID
            if selected_weather == RAIN_WEATHER_EFFECT_ID
            else selected_map_material
        )

        needs_pov_source = demo_path is not None or (
            selected_skybox == DEFAULT_SKYBOX_ID
            and selected_map_material == DEFAULT_MAP_MATERIAL_ID
            and selected_weather == DEFAULT_WEATHER_EFFECT_ID
        )
        pov_src: Optional[Path] = None
        if needs_pov_source:
            pov_src = self.get_pov_vpk_source_path(map_name)
            if not pov_src.is_file():
                raise PovHudError("未找到 POV HUD 资源文件，请确认 pov 目录下资源完整。")

        resolved_voice_mode = normalize_pov_voice_mode(
            voice_mode,
            legacy_voice_disabled=not voice_enabled,
        )
        resolved_input_track_report = input_track_report
        if demo_path is not None and resolved_input_track_report is None:
            try:
                resolved_input_track_report = load_input_report(demo_path)
            except InputCommandError as exc:
                # The in-game keyboard is an independent exact-data layer. A
                # demo without the authoritative UserCmd stream simply keeps
                # that panel hidden while the other VPK layers remain usable.
                logger.info("No exact UserCmd track for the VPK keyboard: %s", exc)
        voice_build: Optional[DemoVoiceHudBuild] = None
        voice_template = self.get_voice_hud_template_path(
            advanced_playback_enabled=advanced_playback_enabled,
        )
        if (
            demo_path is not None
            and advanced_playback_enabled
            and not voice_template.is_file()
        ):
            raise PovHudError(f"未找到高级播放 HUD 模板：{voice_template}")
        if demo_path is not None and voice_template.is_file():
            try:
                voice_build = build_demo_voice_hud_vpk(
                    demo_path,
                    voice_template,
                    input_track_report=resolved_input_track_report,
                    voice_enabled=voice_enabled,
                    voice_mode=resolved_voice_mode,
                    advanced_playback_enabled=advanced_playback_enabled,
                    input_hud_enabled=input_hud_enabled,
                    input_hud_display_mode=input_hud_display_mode,
                    input_hud_scale_percent=input_hud_scale_percent,
                    input_audio_enabled=input_audio_enabled,
                    input_audio_volume_percent=input_audio_volume_percent,
                    combat_stats_enabled=combat_stats_enabled,
                    session_console_commands=(
                        map_material_console_commands(selected_map_material)
                        if advanced_playback_enabled
                        else ()
                    ),
                )
                logger.info(
                    "Built demo voice HUD: packets=%d speakers=%d intervals=%d "
                    "locations=%d input_tracks=%d input_changes=%d mouse=%d/%d "
                    "weaponselect=%d/%d radio=%d "
                    "chat=%d server=%d native_radio=%d rebuilt_radio=%d radar_sounds=%d "
                    "native_sound_table=%d combat_stats=%d/%d payload=%d bytes",
                    voice_build.voice_packets,
                    voice_build.speakers,
                    voice_build.intervals,
                    voice_build.location_changes,
                    voice_build.input_tracks,
                    voice_build.input_changes,
                    voice_build.input_mouse_tracks,
                    voice_build.input_mouse_samples,
                    voice_build.input_weaponselect_resolved,
                    voice_build.input_weaponselect_requests,
                    voice_build.radio_events,
                    voice_build.radio_chat_messages,
                    voice_build.radio_server_messages,
                    voice_build.radio_native_events,
                    voice_build.radio_rebuilt_events,
                    voice_build.radar_player_sounds,
                    voice_build.radar_native_sound_complete,
                    voice_build.combat_stats_players,
                    voice_build.combat_stats_changes,
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
        explicit_map_name = normalize_skybox_map_name(map_name)
        detected_map_name = (
            normalize_skybox_map_name(voice_build.radar_map)
            if demo_path is not None and voice_build is not None
            else ""
        )
        visual_layer_enabled = (
            selected_map_material != DEFAULT_MAP_MATERIAL_ID
            or selected_skybox != DEFAULT_SKYBOX_ID
            or selected_weather != DEFAULT_WEATHER_EFFECT_ID
        )
        if (
            demo_path is not None
            and visual_layer_enabled
            and not detected_map_name
        ):
            detected_map_name = _detect_chroma_demo_map_name(demo_path)
        if (
            demo_path is not None
            and explicit_map_name
            and detected_map_name
            and explicit_map_name != detected_map_name
        ):
            raise PovHudError(
                "显式 Demo 地图与 Demo 文件检测结果不一致："
                f"{explicit_map_name} != {detected_map_name}。"
            )
        effective_map_name = explicit_map_name or detected_map_name
        if demo_path is not None and package_bytes is None and visual_layer_enabled:
            if pov_src is None:
                raise PovHudError("未找到 POV HUD 资源文件，请确认 pov 目录下资源完整。")
            package_bytes = pov_src.read_bytes()
        if effective_map_material != DEFAULT_MAP_MATERIAL_ID:
            map_material_assets_dir = self.get_map_material_assets_dir()
            if not map_material_assets_dir.is_dir():
                raise PovHudError(f"未找到地图材质资源目录：{map_material_assets_dir}")
            try:
                package_bytes = compose_recording_map_material_vpk(
                    assets_dir=map_material_assets_dir,
                    base_vpk_bytes=package_bytes,
                    material_id=effective_map_material,
                    map_name=effective_map_name,
                )
            except (OSError, MapMaterialVpkError) as exc:
                raise PovHudError(f"地图材质 VPK 生成失败：{exc}") from exc
        chroma_child_metadata: Optional[dict[str, Any]] = None
        chroma_main_metadata: Optional[dict[str, Any]] = None
        chroma_outer_metadata: Optional[dict[str, Any]] = None
        chroma_official_swap_metadata: Optional[dict[str, Any]] = None
        map_sun_suppression_metadata: Optional[dict[str, Any]] = None
        weather_main_metadata: Optional[dict[str, Any]] = None
        weather_particle_metadata: Optional[dict[str, Any]] = None
        staged_chroma_swap_files: dict[str, VerifiedFileSource] = {}
        staged_chroma_original_identities: dict[str, tuple[int, str]] = {}
        staged_package_path: Optional[Path] = None
        if selected_skybox != DEFAULT_SKYBOX_ID:
            skybox_assets_dir = (
                self.get_skybox_assets_dir()
                if selected_skybox in SKYBOX_ASSETS
                else None
            )
            if skybox_assets_dir is not None and not skybox_assets_dir.is_dir():
                raise PovHudError(f"未找到内置天空盒资源目录：{skybox_assets_dir}")
            try:
                # Normal recording deliberately starts with an empty package,
                # so enabling a skybox never brings the POV Panorama overrides
                # into the ordinary HUD. POV recording composes onto its
                # demo-specific package (or its static fallback).
                package_bytes = compose_recording_skybox_vpk(
                    builtin_assets_dir=skybox_assets_dir,
                    base_vpk_bytes=package_bytes,
                    skybox_id=selected_skybox,
                    map_name=effective_map_name,
                    advanced_demo_chroma=(
                        demo_path is not None
                        and advanced_playback_enabled
                        and selected_skybox in CHROMA_SKYBOX_IDS
                    ),
                )
            except (OSError, SkyboxVpkError) as exc:
                raise PovHudError(f"天空盒 VPK 生成失败：{exc}") from exc
        suppress_map_visual_sun = (
            effective_map_name in MAP_SUN_SUPPRESSION_MAPS
            and selected_skybox not in CHROMA_SKYBOX_IDS
            and (
                selected_skybox != DEFAULT_SKYBOX_ID
                or selected_weather == RAIN_WEATHER_EFFECT_ID
            )
        )
        if suppress_map_visual_sun:
            try:
                sun_build = compose_map_sun_suppression_vpk(
                    csgo_dir=self.get_csgo_dir(),
                    map_name=effective_map_name,
                    base_vpk_bytes=package_bytes,
                )
                package_bytes = sun_build.vpk_bytes
                map_sun_suppression_metadata = sun_build.metadata
            except (OSError, ValueError, TypeError, MapSunVpkError) as exc:
                raise PovHudError(f"地图可见太阳移除 VPK 生成失败：{exc}") from exc
        if selected_skybox in CHROMA_SKYBOX_IDS:
            child_assets_dir = self.get_chroma_child_assets_dir()
            child_manifest_path = child_assets_dir / "manifest.json"
            if not child_manifest_path.is_file():
                raise PovHudError(
                    f"未找到蓝/绿幕子天空盒资源：{child_assets_dir}"
                )
            main_assets_dir = self.get_chroma_main_map_assets_dir()
            main_manifest_path = main_assets_dir / "manifest.json"
            if not main_manifest_path.is_file():
                raise PovHudError(
                    f"未找到蓝/绿幕主地图资源：{main_assets_dir}"
                )
            try:
                child_manifest = _read_json_manifest(
                    child_manifest_path,
                    label="蓝/绿幕子天空盒目录",
                )
                main_manifest = _read_json_manifest(
                    main_manifest_path,
                    label="蓝/绿幕主地图目录",
                )
                main_required = _chroma_main_patch_required(
                    main_manifest,
                    effective_map_name,
                )
                child_main_required = _chroma_child_main_patch_required(
                    child_manifest,
                    effective_map_name,
                )
                if child_main_required != main_required:
                    raise PovHudError(
                        "蓝/绿幕子天空盒与主地图目录的补丁策略不一致："
                        f"{effective_map_name}。"
                    )
                if main_required:
                    raise PovHudError(
                        "蓝/绿幕正式路线禁止临时替换官方主地图 VPK："
                        f"{effective_map_name}。"
                    )
                child_build = build_chroma_child_vpk(
                    csgo_dir=self.get_csgo_dir(),
                    payload_root=child_assets_dir,
                    manifest=child_manifest,
                    map_name=effective_map_name,
                )
                if package_bytes is None:
                    raise ChromaSkyboxChildError(
                        "outer chroma VPK was not generated"
                    )
                staging_dir = _enter_chroma_staging_dir(
                    staging_stack,
                    csgo_dir=self.get_csgo_dir(),
                )
                child_output = child_build.metadata.get("output")
                if not isinstance(child_output, Mapping):
                    raise ChromaSkyboxChildError(
                        "verified child-skybox build has no output metadata"
                    )
                staged_child_path = staging_dir / "runtime" / child_build.logical_path
                staged_child_path.parent.mkdir(parents=True, exist_ok=True)
                _atomic_write_bytes(staged_child_path, child_build.vpk_bytes)
                staged_chroma_swap_files[child_build.logical_path] = VerifiedFileSource(
                    path=staged_child_path,
                    size=int(child_output.get("size", -1)),
                    sha256=str(child_output.get("sha256") or ""),
                )
                staged_chroma_original_identities[child_build.logical_path] = (
                    _verified_vpk_identity(child_build.metadata, field="source")
                )
                chroma_main_metadata = {
                    "schema_version": CHROMA_MAIN_MAP_MANIFEST_SCHEMA_VERSION,
                    "map_name": effective_map_name,
                    "required": False,
                    "route": "explicit_no_main_patch_required",
                }

                outer_entries = read_inline_vpk(package_bytes)
                if child_build.logical_path in outer_entries:
                    raise ChromaSkyboxChildError(
                        "outer POV package unexpectedly contains a nested child skybox"
                    )
                outer_build = write_inline_vpk_file(
                    output_path=staging_dir / "pov.vpk",
                    byte_entries=outer_entries,
                )
                staged_package_path = outer_build.output_path
                package_bytes = None
                chroma_child_metadata = child_build.metadata
                chroma_outer_metadata = {
                    **outer_build.metadata,
                    "logical_path": "csgo/pov.vpk",
                    "skybox_id": selected_skybox,
                }
                chroma_official_swap_metadata = {
                    "schema_version": 1,
                    "route": _CHROMA_OFFICIAL_SWAP_ROUTE,
                    "files": [
                        {
                            "logical_path": logical_path,
                            "original_size": staged_chroma_original_identities[
                                logical_path
                            ][0],
                            "original_sha256": staged_chroma_original_identities[
                                logical_path
                            ][1],
                            "installed_size": source.size,
                            "installed_sha256": source.sha256,
                        }
                        for logical_path, source in sorted(
                            staged_chroma_swap_files.items()
                        )
                    ],
                }
            except (
                OSError,
                ValueError,
                TypeError,
                DemoVoiceHudError,
                ChromaSkyboxChildError,
                InlineVpkStreamError,
            ) as exc:
                raise PovHudError(f"蓝/绿幕运行 VPK 生成失败：{exc}") from exc

        if selected_weather != DEFAULT_WEATHER_EFFECT_ID:
            if not effective_map_name:
                raise PovHudError("无法确认 Demo 地图，不能安全应用天气效果。")
            if (
                selected_weather == SNOW_WEATHER_EFFECT_ID
                and effective_map_name == TRAIN_SNOW_PROBE_MAP
            ):
                try:
                    particle_build = build_train_snow_particle_override_vpk(
                        csgo_dir=self.get_csgo_dir(),
                        map_name=effective_map_name,
                        base_vpk_bytes=package_bytes,
                    )
                    package_bytes = particle_build.vpk_bytes
                    weather_particle_metadata = {
                        **particle_build.metadata,
                        "effect_id": selected_weather,
                        "official_visual_resources_only": True,
                    }
                except (OSError, ValueError, TypeError, WeatherParticleVpkError) as exc:
                    raise PovHudError(f"Train 雨转雪粒子 VPK 生成失败：{exc}") from exc
            else:
                weather_assets_dir = self.get_weather_effect_assets_dir(selected_weather)
                weather_manifest_path = weather_assets_dir / "manifest.json"
                if not weather_manifest_path.is_file():
                    raise PovHudError(f"未找到天气效果资源目录：{weather_assets_dir}")
                try:
                    weather_manifest = _read_json_manifest(
                        weather_manifest_path,
                        label="天气效果目录",
                    )
                    staging_dir = _enter_chroma_staging_dir(
                        staging_stack,
                        csgo_dir=self.get_csgo_dir(),
                    )
                    staged_weather_path = (
                        staging_dir / "runtime" / "maps" / f"{effective_map_name}.vpk"
                    )
                    staged_weather_path.parent.mkdir(parents=True, exist_ok=True)
                    weather_build = build_chroma_main_map_vpk(
                        csgo_dir=self.get_csgo_dir(),
                        payload_root=weather_assets_dir,
                        output_path=staged_weather_path,
                        manifest=weather_manifest,
                        map_name=effective_map_name,
                        require_in_game_confirmed=True,
                    )
                    weather_output = weather_build.metadata.get("output")
                    if not isinstance(weather_output, Mapping):
                        raise ChromaMainMapError(
                            "verified weather build has no output metadata"
                        )
                    if weather_build.logical_path in staged_chroma_swap_files:
                        raise ChromaMainMapError(
                            "weather VPK conflicts with another temporary official VPK swap"
                        )
                    staged_chroma_swap_files[weather_build.logical_path] = VerifiedFileSource(
                        path=weather_build.output_path,
                        size=int(weather_output.get("size", -1)),
                        sha256=str(weather_output.get("sha256") or ""),
                    )
                    staged_chroma_original_identities[weather_build.logical_path] = (
                        _verified_vpk_identity(weather_build.metadata, field="source")
                    )
                    weather_profile = (weather_manifest.get("maps") or {}).get(
                        effective_map_name, {}
                    )
                    spatial_puddles = (
                        weather_profile.get("spatial_puddles", {})
                        if isinstance(weather_profile, Mapping)
                        else {}
                    )
                    has_custom_visual_geometry = bool(
                        isinstance(spatial_puddles, Mapping)
                        and int(spatial_puddles.get("instance_count") or 0) > 0
                    )
                    weather_main_metadata = {
                        **weather_build.metadata,
                        "effect_id": selected_weather,
                        "original_map_runtime": True,
                        "workshop_map_required": False,
                        "official_visual_resources_only": not has_custom_visual_geometry,
                    }
                except (
                    OSError,
                    ValueError,
                    TypeError,
                    ChromaMainMapError,
                ) as exc:
                    raise PovHudError(f"天气效果运行 VPK 生成失败：{exc}") from exc

        if staged_chroma_swap_files:
            chroma_official_swap_metadata = {
                "schema_version": 1,
                "route": _CHROMA_OFFICIAL_SWAP_ROUTE,
                "files": [
                    {
                        "logical_path": logical_path,
                        "original_size": staged_chroma_original_identities[
                            logical_path
                        ][0],
                        "original_sha256": staged_chroma_original_identities[
                            logical_path
                        ][1],
                        "installed_size": source.size,
                        "installed_sha256": source.sha256,
                    }
                    for logical_path, source in sorted(
                        staged_chroma_swap_files.items()
                    )
                ],
            }

        gi_path = self.get_gameinfo_path()
        if not gi_path.is_file():
            raise PovHudError("未找到 gameinfo.gi，请确认 CS2 路径是否正确。")

        backup_dir = self.get_backup_dir()
        manifest_path = self.get_manifest_path()
        bak_path = self.get_backup_gameinfo_path()
        pov_dst = self.get_pov_vpk_target_path()
        chroma_swap_backup_dir = self.get_chroma_swap_backup_dir()

        try:
            raw_gi = gi_path.read_text(encoding="utf-8", errors="surrogateescape")
            original_gameinfo_sha = sha256_file(gi_path)
            patched_txt = patch_gameinfo_content(
                raw_gi,
                include_chroma_runtime=False,
            )
            planned_patched_sha = hashlib.sha256(
                patched_txt.encode("utf-8")
            ).hexdigest()
        except (OSError, UnicodeError) as e:
            raise PovHudError(
                f"无法读取或校验 gameinfo.gi {gi_path}。系统错误：{e}"
            ) from e

        # Voice parsing and chroma main-map reconstruction can be lengthy.  Do
        # not trust the check made at method entry after all staging has
        # completed: no game-tree write is allowed if CS2 started meanwhile.
        if is_cs2_running():
            raise PovHudError(CS2_RUNNING_POV_MSG)

        if chroma_official_swap_metadata is not None:
            for record in _chroma_official_swap_records(
                {"chroma_official_swaps": chroma_official_swap_metadata}
            ):
                (
                    target,
                    backup,
                    original_size,
                    original_vpk_sha,
                    _installed_size,
                    _installed_sha,
                ) = _validated_chroma_swap_record(
                    record,
                    csgo_root=self.get_csgo_dir(),
                    backup_root=chroma_swap_backup_dir,
                )
                if not target.is_file() or target.is_symlink():
                    raise PovHudError(
                        f"蓝/绿幕官方 child VPK 不存在或不是普通文件：{target}"
                    )
                if (
                    target.stat().st_size != original_size
                    or sha256_file(target) != original_vpk_sha
                ):
                    raise PovHudError(
                        "蓝/绿幕官方 child VPK 已变化，拒绝开始会话："
                        f"{target}"
                    )
                record["target_path"] = str(target)
                record["backup_path"] = str(backup)

        try:
            backup_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise PovHudError(
                f"无法创建备份目录 {backup_dir}。系统错误：{e}"
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
        elif selected_weather != DEFAULT_WEATHER_EFFECT_ID and demo_path is None:
            source_basename = f"weather_effect:{selected_weather}"
        elif selected_map_material != DEFAULT_MAP_MATERIAL_ID and demo_path is None:
            source_basename = f"map_material:{selected_map_material}"
        elif selected_skybox != DEFAULT_SKYBOX_ID and demo_path is None:
            source_basename = (
                Path(SKYBOX_ASSETS[selected_skybox][0]).name
                if selected_skybox in SKYBOX_ASSETS
                else selected_skybox
            )
        else:
            source_basename = pov_src.name if pov_src is not None else ""

        if selected_weather != DEFAULT_WEATHER_EFFECT_ID:
            feature = (
                "experimental_pov_with_weather"
                if demo_path is not None
                else "recording_weather"
            )
        elif selected_map_material != DEFAULT_MAP_MATERIAL_ID:
            if demo_path is not None and selected_skybox != DEFAULT_SKYBOX_ID:
                feature = "experimental_pov_with_map_material_and_skybox"
            elif demo_path is not None:
                feature = "experimental_pov_with_map_material"
            elif selected_skybox != DEFAULT_SKYBOX_ID:
                feature = "recording_map_material_with_skybox"
            else:
                feature = "recording_map_material"
        else:
            feature = (
                "experimental_pov_with_skybox"
                if demo_path is not None and selected_skybox != DEFAULT_SKYBOX_ID
                else "recording_skybox"
                if selected_skybox != DEFAULT_SKYBOX_ID
                else "experimental_pov"
            )

        manifest = {
            "state": "prepared",
            "enabled_by": "CS2 Insight Agent",
            "feature": feature,
            "installed_at": datetime.now(timezone.utc).isoformat(),
            "gameinfo_path": str(gi_path),
            "backup_gameinfo_path": str(bak_path),
            "pov_vpk_path": str(pov_dst),
            "pov_vpk_source_basename": source_basename,
            "demo_voice_hud_generated": voice_build is not None,
            "demo_voice_hud": (
                {
                    "voice_packets": voice_build.voice_packets,
                    "voice_mode": resolved_voice_mode,
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
                    "input_weaponselect_requests": voice_build.input_weaponselect_requests,
                    "input_weaponselect_resolved": voice_build.input_weaponselect_resolved,
                    "input_weaponselect_unresolved": voice_build.input_weaponselect_unresolved,
                    "input_weaponselect_tracks": voice_build.input_weaponselect_tracks,
                    "input_weaponselect_parse_failed": bool(
                        voice_build.input_weaponselect_parse_failed
                    ),
                    "input_mouse_tracks": voice_build.input_mouse_tracks,
                    "input_mouse_samples": voice_build.input_mouse_samples,
                    "input_mouse_updates": voice_build.input_mouse_updates,
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
                    "combat_stats_players": voice_build.combat_stats_players,
                    "combat_stats_changes": voice_build.combat_stats_changes,
                    "combat_stats_parse_failed": bool(
                        voice_build.combat_stats_parse_failed
                    ),
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
            "demo_map_name_used": effective_map_name,
            "recording_skybox_id": selected_skybox,
            "map_sun_suppression": map_sun_suppression_metadata,
            "chroma_child_skybox": chroma_child_metadata,
            "chroma_main_map": chroma_main_metadata,
            "chroma_outer_vpk": chroma_outer_metadata,
            "chroma_runtime": None,
            "chroma_official_swaps": chroma_official_swap_metadata,
            "recording_map_material_id": selected_map_material,
            "input_hud_enabled": bool(input_hud_enabled),
            "input_hud_display_mode": str(input_hud_display_mode),
            "input_hud_scale_percent": int(input_hud_scale_percent),
            "input_audio_enabled": bool(input_audio_enabled),
            "input_audio_volume_percent": int(input_audio_volume_percent),
            "combat_stats_enabled": bool(combat_stats_enabled),
            "weather_effect_id": selected_weather,
            "weather_main_map": weather_main_metadata,
            "weather_particle_override": weather_particle_metadata,
            "original_gameinfo_sha256": original_gameinfo_sha,
            "planned_patched_gameinfo_sha256": planned_patched_sha,
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
            if chroma_official_swap_metadata is not None:
                for record in _chroma_official_swap_records(manifest):
                    (
                        target,
                        backup,
                        original_size,
                        original_vpk_sha,
                        _installed_size,
                        _installed_sha,
                    ) = _validated_chroma_swap_record(
                        record,
                        csgo_root=self.get_csgo_dir(),
                        backup_root=chroma_swap_backup_dir,
                    )
                    if (
                        target.stat().st_size != original_size
                        or sha256_file(target) != original_vpk_sha
                    ):
                        raise PovHudError(
                            "备份前官方蓝/绿幕 child VPK 身份发生变化："
                            f"{target}"
                        )
                    backup.parent.mkdir(parents=True, exist_ok=True)
                    _atomic_copy(target, backup)
                    if (
                        backup.stat().st_size != original_size
                        or sha256_file(backup) != original_vpk_sha
                    ):
                        raise PovHudError(
                            f"官方蓝/绿幕 child VPK 备份校验失败：{backup}"
                        )

            if staged_package_path is not None:
                _atomic_copy(staged_package_path, pov_dst)
            elif package_bytes is not None:
                _atomic_write_bytes(pov_dst, package_bytes)
            else:
                if pov_src is None:
                    raise PovHudError("未找到可安装的录制 VPK 资源。")
                _atomic_copy(pov_src, pov_dst)
            pov_sha = sha256_file(pov_dst)
            if chroma_outer_metadata is not None:
                outer_output = chroma_outer_metadata.get("output")
                expected_outer_sha = (
                    str(outer_output.get("sha256") or "").strip().lower()
                    if isinstance(outer_output, Mapping)
                    else ""
                )
                if not expected_outer_sha or pov_sha != expected_outer_sha:
                    raise PovHudError(
                        "安装后的蓝/绿幕 pov.vpk 与已验证 staging 输出 SHA-256 不一致。"
                    )

            for logical_path, source in sorted(staged_chroma_swap_files.items()):
                if not source.path.is_file():
                    raise PovHudError(
                        f"蓝/绿幕 staging VPK 不存在：{source.path}"
                    )
                source_size = source.path.stat().st_size
                source_sha = sha256_file(source.path)
                if source_size != source.size or source_sha != source.sha256:
                    raise PovHudError(
                        f"蓝/绿幕 staging VPK 身份校验失败：{logical_path}"
                    )
                record = next(
                    item
                    for item in _chroma_official_swap_records(manifest)
                    if item.get("logical_path") == logical_path
                )
                target, backup, original_size, original_vpk_sha, installed_size, installed_sha = (
                    _validated_chroma_swap_record(
                        record,
                        csgo_root=self.get_csgo_dir(),
                        backup_root=chroma_swap_backup_dir,
                    )
                )
                if (
                    backup.stat().st_size != original_size
                    or sha256_file(backup) != original_vpk_sha
                ):
                    raise PovHudError(
                        f"安装前官方蓝/绿幕 child VPK 备份校验失败：{backup}"
                    )
                _atomic_copy(source.path, target)
                if target.stat().st_size != installed_size or sha256_file(target) != installed_sha:
                    raise PovHudError(
                        f"安装后的官方蓝/绿幕 child VPK 校验失败：{logical_path}"
                    )
        except (OSError, PovHudError) as e:
            rollback_failed_install()
            if isinstance(e, PovHudError):
                raise
            raise PovHudError(
                f"无法写入 POV HUD 文件 {pov_dst}。请检查 CS2 目录权限。系统错误：{e}"
            ) from e

        try:
            _atomic_write_text(gi_path, patched_txt)
            patched_sha = sha256_file(gi_path)
            if patched_sha != planned_patched_sha:
                raise PovHudError("gameinfo.gi 写入后与预计的补丁哈希不一致。")
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
        chroma_runtime_dir = self.get_chroma_runtime_dir()
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

        def remove_chroma_runtime() -> None:
            if not chroma_runtime_dir.exists():
                return
            try:
                csgo_root = self.get_csgo_dir().resolve()
                runtime_resolved = chroma_runtime_dir.resolve()
            except OSError as e:
                raise PovHudError(
                    f"无法解析 Agent 蓝/绿幕运行目录 {chroma_runtime_dir}。系统错误：{e}"
                ) from e
            if (
                chroma_runtime_dir.name != _CHROMA_RUNTIME_DIRNAME
                or runtime_resolved.parent != csgo_root
            ):
                raise PovHudError(
                    f"拒绝清理越界的蓝/绿幕运行目录：{chroma_runtime_dir}"
                )
            try:
                shutil.rmtree(chroma_runtime_dir)
            except OSError as e:
                raise PovHudError(
                    f"无法删除 Agent 蓝/绿幕运行目录 {chroma_runtime_dir}。系统错误：{e}"
                ) from e

        def cleanup_recovery_files() -> None:
            try:
                self._cleanup_chroma_swap_backups()
                manifest_path.unlink(missing_ok=True)
                bak_path.unlink(missing_ok=True)
                if backup_dir.is_dir() and not any(backup_dir.iterdir()):
                    backup_dir.rmdir()
            except OSError as e:
                raise PovHudError(
                    f"POV 文件已恢复，但无法清理恢复记录 {backup_dir}。系统错误：{e}"
                ) from e

        manifest = self._read_manifest() if manifest_path.is_file() else {}
        if manifest.get("chroma_official_swaps") is not None:
            self._restore_chroma_official_swaps(manifest)
        elif self.get_chroma_swap_backup_dir().exists():
            self._assert_orphan_chroma_swap_backups_safe()
        expected_sha = str(
            manifest.get("original_gameinfo_sha256") or ""
        ).strip().lower() or None
        patched_sha = str(
            manifest.get("patched_gameinfo_sha256")
            or manifest.get("planned_patched_gameinfo_sha256")
            or ""
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
                    remove_chroma_runtime()
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
        remove_chroma_runtime()
        verification = self.verify_restoration(None)
        semantic_verified = bool(
            verification.get("gameinfo_exists")
            and verification.get("gameinfo_has_pov_entry") is False
            and verification.get("pov_vpk_removed")
            and verification.get("chroma_runtime_removed")
            and verification.get("chroma_official_swaps_restored")
        )
        if not semantic_verified:
            raise PovHudError(
                "POV 残留修复验证失败：加载项、pov.vpk 或蓝/绿幕运行目录仍然存在。"
            )

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
