"""系统与环境管家 - 配置管理与 CS2 路径探测

配置为单文件 JSON：默认路径为仓库根下 data/cs2-insight.config.json；
首次启动且无配置文件时，从同目录的 cs2-insight.config.example.json 复制默认值并生成正式配置。
环境变量 CS2_INSIGHT_CONFIG 可指向其它绝对路径。
若仅有旧版 backend/config.json，首次加载时会迁移到新文件。
旧版本将配置 / 数据库 / 备份放在仓库根目录时，启动时会一次性迁入 data/。
"""

import json
import logging
import os
import re
import shutil
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

try:
    import winreg
except ImportError:
    winreg = None  # non-Windows

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

# 轻量 JSON 配置：默认在 <repo>/data/cs2-insight.config.json（可用环境变量 CS2_INSIGHT_CONFIG 覆盖绝对路径）
_BACKEND_DIR = Path(__file__).resolve().parent.parent
_REPO_ROOT = _BACKEND_DIR.parent
_LEGACY_CONFIG_PATH = _BACKEND_DIR / "config.json"
_DEFAULT_CONFIG_FILENAME = "cs2-insight.config.json"
_DEFAULT_EXAMPLE_FILENAME = "cs2-insight.config.example.json"
_DATA_SUBDIR = "data"
_BACKUP_DIR_NAME = ".cs2_config_backup"
_DB_BASENAME = "cs2-insight.db"


def get_data_dir() -> Path:
    """持久化数据目录：配置、SQLite、玩家配置备份、日志等。"""
    return _REPO_ROOT / _DATA_SUBDIR


def resolve_example_config_path() -> Path:
    """随仓库提供的示例配置（默认 ``data/cs2-insight.config.example.json``）。"""
    return get_data_dir() / _DEFAULT_EXAMPLE_FILENAME


def migrate_legacy_app_data() -> None:
    """
    将旧版散落在仓库根目录的数据迁入 ``data/``（仅默认配置路径、且无 CS2_INSIGHT_CONFIG 时执行）。
    若目标已存在则跳过对应项，避免覆盖。任一步失败（例如日志目录被占用）仅记录警告，不阻塞启动。
    """
    if os.environ.get("CS2_INSIGHT_CONFIG", "").strip():
        return

    data_dir = get_data_dir()
    moved_any = False

    def mark_moved() -> None:
        nonlocal moved_any
        moved_any = True

    legacy_cfg = _REPO_ROOT / _DEFAULT_CONFIG_FILENAME
    new_cfg = data_dir / _DEFAULT_CONFIG_FILENAME
    if legacy_cfg.is_file():
        if new_cfg.is_file():
            logger.warning(
                "Legacy config still at %s but %s already exists; leaving legacy file in place",
                legacy_cfg,
                new_cfg,
            )
        else:
            try:
                data_dir.mkdir(parents=True, exist_ok=True)
                shutil.move(str(legacy_cfg), str(new_cfg))
                logger.info("Migrated config: %s -> %s", legacy_cfg, new_cfg)
                mark_moved()
            except OSError as e:
                logger.warning("Could not migrate config to data dir: %s", e)

    legacy_ex = _REPO_ROOT / _DEFAULT_EXAMPLE_FILENAME
    new_ex = data_dir / _DEFAULT_EXAMPLE_FILENAME
    if legacy_ex.is_file():
        if new_ex.is_file():
            logger.warning(
                "Legacy example config still at %s but %s already exists; leaving legacy file in place",
                legacy_ex,
                new_ex,
            )
        else:
            try:
                data_dir.mkdir(parents=True, exist_ok=True)
                shutil.move(str(legacy_ex), str(new_ex))
                logger.info("Migrated example config: %s -> %s", legacy_ex, new_ex)
                mark_moved()
            except OSError as e:
                logger.warning("Could not migrate example config to data dir: %s", e)

    # SQLite 主库及 WAL/SHM
    legacy_db = _REPO_ROOT / _DB_BASENAME
    new_db = data_dir / _DB_BASENAME
    if legacy_db.is_file():
        if new_db.is_file():
            logger.warning(
                "Legacy DB still at %s but %s already exists; leaving legacy DB in place",
                legacy_db,
                new_db,
            )
        else:
            try:
                data_dir.mkdir(parents=True, exist_ok=True)
                for suffix in ("", "-wal", "-shm"):
                    name = _DB_BASENAME + suffix
                    src = _REPO_ROOT / name
                    if src.is_file():
                        shutil.move(str(src), str(data_dir / name))
                logger.info("Migrated SQLite bundle from %s to %s", _REPO_ROOT, data_dir)
                mark_moved()
            except OSError as e:
                logger.warning("Could not migrate SQLite to data dir: %s", e)

    legacy_bak = _REPO_ROOT / _BACKUP_DIR_NAME
    new_bak = data_dir / _BACKUP_DIR_NAME
    if legacy_bak.exists():
        if new_bak.exists():
            logger.warning(
                "Legacy backup dir still at %s but %s already exists; not migrating backup tree",
                legacy_bak,
                new_bak,
            )
        else:
            try:
                data_dir.mkdir(parents=True, exist_ok=True)
                shutil.move(str(legacy_bak), str(new_bak))
                logger.info("Migrated CS2 config backup: %s -> %s", legacy_bak, new_bak)
                mark_moved()
            except OSError as e:
                logger.warning("Could not migrate backup dir to data/: %s", e)

    legacy_logs = _REPO_ROOT / "logs"
    new_logs = data_dir / "logs"
    if legacy_logs.is_dir():
        if new_logs.exists():
            logger.warning(
                "Legacy logs dir %s still present; %s already exists; not merging logs",
                legacy_logs,
                new_logs,
            )
        else:
            try:
                data_dir.mkdir(parents=True, exist_ok=True)
                shutil.move(str(legacy_logs), str(new_logs))
                logger.info("Migrated logs: %s -> %s", legacy_logs, new_logs)
                mark_moved()
            except OSError as e:
                logger.warning(
                    "Could not migrate logs (directory may be in use); new logs will use %s: %s",
                    new_logs,
                    e,
                )

    if moved_any:
        logger.info("App data directory layout: using %s", data_dir)


migrate_legacy_app_data()


def resolve_config_path() -> Path:
    override = os.environ.get("CS2_INSIGHT_CONFIG", "").strip()
    if override:
        p = Path(override).expanduser()
        if p.is_file():
            return p
        # 旧启动脚本可能仍指向仓库根下的配置；已迁移到 data/ 时回退，避免“文件不存在”。
        try:
            legacy = (_REPO_ROOT / _DEFAULT_CONFIG_FILENAME).resolve()
            if p.resolve() == legacy:
                migrated = get_data_dir() / _DEFAULT_CONFIG_FILENAME
                if migrated.is_file():
                    return migrated
        except OSError:
            pass
        return p
    return get_data_dir() / _DEFAULT_CONFIG_FILENAME

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
    """OpenAI 兼容网关：由用户填写 base_url + model；provider 仅兼容旧配置。"""
    provider: str = ""
    model: str = ""
    api_key: str = ""
    base_url: Optional[str] = None


def llm_base_url_is_local_host(base_url: Optional[str]) -> bool:
    """本机 OpenAI 兼容服务（Ollama / LM Studio 等）：可不填 API 密钥。"""
    raw = (base_url or "").strip()
    if not raw:
        return False
    if "://" not in raw:
        raw = "http://" + raw
    try:
        host = urlparse(raw).hostname
    except ValueError:
        return False
    if not host:
        return False
    h = host.lower()
    return h in ("localhost", "127.0.0.1", "::1") or h.endswith(".localhost")


def llm_api_key_configured(api_key: Optional[str]) -> bool:
    """
    True when a non-empty key is present — including a masked placeholder saved on disk
    (e.g. re-imported export: \"****\" + last 4). Those cannot be used for real API calls
    but should not read as \"missing\" in setup UI.
    """
    k = (api_key or "").strip()
    if not k:
        return False
    if k.startswith("****"):
        return len(k) > 4
    return True


class ExperimentalConfig(BaseModel):
    model_config = ConfigDict(extra="ignore")

    pov_enabled: bool = False


class SpecPlayerVerifyConfig(BaseModel):
    """录制期 spec_player 注入后，用 GSI 校验当前观战 Steam64 是否为目标玩家；重试期间用慢放倍率避免 demo 空转。"""

    model_config = ConfigDict(extra="ignore")

    demo_timescale: float = Field(default=0.05, ge=0.01, le=1.0)
    max_retries: int = Field(default=4, ge=1, le=16)
    per_retry_timeout_sec: float = Field(default=0.6, ge=0.05, le=5.0)
    settle_sec: float = Field(default=0.12, ge=0.0, le=2.0)
    # None = 按倒退 seek 距离自适应；有值 = 叠在 CS2_INSIGHT_GOTO_DELAY_JUMP_CUT 上的额外 gototick 等待（秒）
    pov_goto_delay_extra_sec: Optional[float] = Field(default=None, ge=0.0, le=20.0)


class AppConfig(BaseModel):
    model_config = ConfigDict(extra="ignore")

    obs: OBSConfig = Field(default_factory=OBSConfig)
    llm: LLMConfig = Field(default_factory=LLMConfig)
    experimental: ExperimentalConfig = Field(default_factory=ExperimentalConfig)
    spec_player_verify: SpecPlayerVerifyConfig = Field(default_factory=SpecPlayerVerifyConfig)
    # 合辑导出：留空则从 PATH 探测 ffmpeg.exe
    ffmpeg_path: str = ""
    # 合辑 H.264：auto=按 NVENC→QSV→AMF→libx264 顺序，对硬件编码器做单帧实测后再选用；亦可指定编码器名
    montage_encoder: str = "auto"
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
    # 录制启动 cs2.exe 时附加的命令行参数（shlex 分词后追加在内置参数与 +exec 之前）
    cs2_extra_launch_args: str = ""
    # 首次片段 seek 前、与会话预热 cvar 一并注入的附加控制台行（每行一条，# // 开头为注释）
    record_inject_console_lines: str = ""


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
    example_path = resolve_example_config_path()
    if example_path.is_file():
        raw = _parse_config_json_file(example_path)
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
