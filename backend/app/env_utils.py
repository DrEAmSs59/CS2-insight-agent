"""系统与环境管家 - 配置管理与 CS2 路径探测

配置为单文件 JSON：默认仓库根目录 cs2-insight.config.json；
环境变量 CS2_INSIGHT_CONFIG 可指向其它绝对路径。
若仅有旧版 backend/config.json，首次加载时会迁移到新文件。
"""

import json
import os
import re
from pathlib import Path
from typing import Any, Optional

try:
    import winreg
except ImportError:
    winreg = None  # non-Windows

from pydantic import BaseModel, ConfigDict, Field

# 轻量 JSON 配置：默认在仓库根目录 cs2-insight.config.json（可用环境变量 CS2_INSIGHT_CONFIG 覆盖绝对路径）
_BACKEND_DIR = Path(__file__).resolve().parent.parent
_REPO_ROOT = _BACKEND_DIR.parent
_LEGACY_CONFIG_PATH = _BACKEND_DIR / "config.json"
_DEFAULT_CONFIG_FILENAME = "cs2-insight.config.json"


def resolve_config_path() -> Path:
    override = os.environ.get("CS2_INSIGHT_CONFIG", "").strip()
    if override:
        return Path(override).expanduser()
    return _REPO_ROOT / _DEFAULT_CONFIG_FILENAME

DEFAULT_STEAM_PATHS = [
    Path(r"C:\Program Files (x86)\Steam"),
    Path(r"C:\Program Files\Steam"),
    Path(r"D:\Steam"),
    Path(r"D:\SteamLibrary"),
    Path(r"E:\Steam"),
    Path(r"F:\Steam"),
]

CS2_RELATIVE = Path("steamapps") / "common" / "Counter-Strike Global Offensive" / "game" / "bin" / "win64" / "cs2.exe"


def _steam_install_from_registry() -> Optional[Path]:
    if winreg is None:
        return None
    for hive, subkey in (
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam"),
        (winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam"),
    ):
        try:
            key = winreg.OpenKey(hive, subkey)
            steam_dir, _ = winreg.QueryValueEx(key, "InstallPath")
            winreg.CloseKey(key)
            p = Path(str(steam_dir).strip())
            if p.exists():
                return p
        except OSError:
            continue
    return None


def _library_roots_from_vdf(steam_install: Path) -> list[Path]:
    """解析 Steam config/libraryfolders.vdf 中的额外库路径。"""
    vdf = steam_install / "config" / "libraryfolders.vdf"
    if not vdf.is_file():
        return []
    try:
        text = vdf.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []
    roots: list[Path] = []
    for m in re.finditer(r'"path"\s+"([^"]*)"', text):
        raw = m.group(1).replace("\\\\", "\\").strip()
        if not raw:
            continue
        try:
            p = Path(raw)
        except ValueError:
            continue
        if p.is_dir():
            roots.append(p)
    return roots


def _candidate_steam_roots() -> list[Path]:
    seen: set[str] = set()
    out: list[Path] = []

    def add(p: Optional[Path]) -> None:
        if p is None:
            return
        try:
            rp = str(p.resolve())
        except OSError:
            rp = str(p)
        if rp not in seen and p.is_dir():
            seen.add(rp)
            out.append(p)

    add(_steam_install_from_registry())
    for base in DEFAULT_STEAM_PATHS:
        add(base)
    pf = os.environ.get("ProgramFiles(x86)") or os.environ.get("ProgramFiles")
    if pf:
        add(Path(pf) / "Steam")

    for root in list(out):
        for lib in _library_roots_from_vdf(root):
            add(lib)
    return out


class OBSConfig(BaseModel):
    host: str = "localhost"
    port: int = 4455
    password: str = ""


class LLMConfig(BaseModel):
    provider: str = "deepseek"
    model: str = "deepseek-chat"
    api_key: str = ""
    base_url: Optional[str] = None


class AppConfig(BaseModel):
    model_config = ConfigDict(extra="ignore")

    obs: OBSConfig = Field(default_factory=OBSConfig)
    llm: LLMConfig = Field(default_factory=LLMConfig)
    cs2_path: str = ""
    demo_directory: str = ""
    demo_watch_paths: list[str] = Field(default_factory=list)
    ai_mode: bool = False
    # 监听目录新入库时：按名单在 demo roster 中匹配（同一场可多名），展示名写成「A K/D/A · B K/D/A」作标记（不做高光解析）
    expected_parse_players: list[str] = Field(default_factory=list)
    # 录制期间 CS2 的 fps_max（默认 240；0 表示不限制）
    cs2_fps_max: int = 240
    # 前端录制队列「全局节奏」覆写（仅含用户改过的字段；空对象表示沿用内置默认）
    recording_global_pacing: dict[str, Any] = Field(default_factory=dict)
    # 录制前观战选项默认值（与前端 RecordWarmupModal DEFAULT_OPTIONS 对齐的扁平对象）
    default_record_warmup: dict[str, Any] = Field(default_factory=dict)


def _parse_config_json_file(path: Path) -> dict:
    """
    读取单对象 JSON 配置。若文件在首个 `}` 之后被意外拼接了多余内容（常见误粘贴），
    `json.loads` 会报 Extra data；此处用 raw_decode 只取第一个顶层对象。
    """
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return {}
    decoder = json.JSONDecoder()
    raw, end = decoder.raw_decode(text)
    trailing = text[end:].strip()
    if trailing:
        try:
            path.write_text(text[:end].rstrip() + "\n", encoding="utf-8")
        except OSError:
            pass
    if not isinstance(raw, dict):
        return {}
    return raw


def load_config() -> AppConfig:
    path = resolve_config_path()
    if path.is_file():
        raw = _parse_config_json_file(path)
        return AppConfig(**raw)
    if _LEGACY_CONFIG_PATH.is_file():
        raw = _parse_config_json_file(_LEGACY_CONFIG_PATH)
        cfg = AppConfig(**raw)
        save_config(cfg)
        return cfg
    cfg = AppConfig()
    save_config(cfg)
    return cfg


def save_config(cfg: AppConfig) -> None:
    path = resolve_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(cfg.model_dump_json(indent=2), encoding="utf-8")


def detect_cs2_path() -> Optional[str]:
    """在 Steam 主库、libraryfolders.vdf 及常见盘符下查找 cs2.exe。"""
    for base in _candidate_steam_roots():
        candidate = base / CS2_RELATIVE
        if candidate.is_file():
            return str(candidate)
    return None


def ensure_cs2_path(cfg: AppConfig) -> AppConfig:
    """If cs2_path is empty, try auto-detection and persist."""
    if not cfg.cs2_path:
        detected = detect_cs2_path()
        if detected:
            cfg.cs2_path = detected
            save_config(cfg)
    return cfg
