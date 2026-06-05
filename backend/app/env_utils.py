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
import sys
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
_DEFAULT_CS2_EXTRA_LAUNCH_ARGS = "-fullscreen"
_DEFAULT_RECORD_INJECT_CONSOLE_LINES = "\n".join((
    "cl_hud_telemetry_frametime_show 0",
    "engine_no_focus_sleep 0",
    "cl_demo_predict 0",
    "fps_max 0",
    "cl_trueview_show_status 0",
))


def get_data_dir() -> Path:
    """可写应用数据目录：OBS / 玩家配置备份、库边文件等（与正式配置文件同盘根树）。

    默认：仓库根下 ``data/``。Electron 安装版通过 ``CS2_INSIGHT_DATA_DIR`` 指向
    ``%APPDATA%/<应用>/data``（与配置文件、SQLite、logs 同级），避免写入 ``Program Files`` 下的 ``resources``。
    """
    override = os.environ.get("CS2_INSIGHT_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return (_REPO_ROOT / _DATA_SUBDIR).resolve()


def get_bundle_data_dir() -> Path:
    """只读随包资源：``cs2-insight.config.example.json``、``basic.ini`` 等。

    开发/便携包：与 ``get_data_dir()`` 相同。Electron 安装版由 ``CS2_INSIGHT_BUNDLE_DATA_DIR``
    指向 ``resources/data``（安装目录下只读副本）。
    """
    override = os.environ.get("CS2_INSIGHT_BUNDLE_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return get_data_dir()


def resolve_example_config_path() -> Path:
    """随应用提供的示例配置（默认 ``data/cs2-insight.config.example.json``）。"""
    return get_bundle_data_dir() / _DEFAULT_EXAMPLE_FILENAME


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
    # OBS 可执行文件完整路径，用于录制前自动启动 OBS
    obs_path: str = ""
    # OBS 配置中心"配置检查"是否通过过（WebSocket 连接成功）
    obs_config_verified: bool = False


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
    # 前端录制队列「全局节奏」覆写（仅含用户改过的字段；空对象表示沿用内置默认）
    recording_global_pacing: dict[str, Any] = Field(default_factory=dict)
    # 录制前观战选项默认值（与前端 RecordWarmupModal DEFAULT_OPTIONS 对齐的扁平对象）
    default_record_warmup: dict[str, Any] = Field(default_factory=dict)
    # 录制启动 cs2.exe 时附加的命令行参数（shlex 分词后追加在内置参数与 +exec 之前）
    cs2_extra_launch_args: str = _DEFAULT_CS2_EXTRA_LAUNCH_ARGS
    # False 表示仍沿用程序默认启动项；True 表示用户已手动编辑过该字段，
    # 此时即便清空也应尊重用户选择，不再自动回填 -fullscreen。
    cs2_extra_launch_args_user_configured: bool = False
    # 首次片段 seek 前、与会话预热 cvar 一并注入的附加控制台行（每行一条，# // 开头为注释）
    record_inject_console_lines: str = _DEFAULT_RECORD_INJECT_CONSOLE_LINES
    # False 表示仍沿用程序默认预热 cvar；True 表示用户已手动编辑过该字段，
    # 此时即便删空也尊重用户选择，不再自动回填默认 cvar。
    record_inject_console_lines_user_configured: bool = False
    # 检查更新：auto=镜像与直连并发；on=仅用镜像；off=仅直连；或以 https:// 开头的自定义镜像前缀
    update_github_mirror: str = "auto"
    obs_transition_enabled: bool = False
    obs_transition_name: str = "Fade"
    obs_transition_duration_ms: int = 100
    obs_game_scene_name: str = "CS2 Insight Recording"
    obs_black_scene_name: str = "CS2 Insight Black"
    # 官匹战绩
    steam_api_key: str = ""
    steam_id64: str = ""
    match_mode: str = "premier"   # premier / competitive
    match_count: int = 20         # 20 / 50 / 100
    # 虚拟键盘 overlay（OBS Browser Source 实时合成）
    kb_overlay_enabled: bool = False
    kb_overlay_tick_offset: int = 6   # 补偿 OBS CEF 渲染流水线延迟；正=overlay提前显示，负=延迟显示
    kb_overlay_position: str = "bottom_center"  # bottom_center | minimap_below


def _normalize_config_defaults(cfg: AppConfig, raw: Optional[dict[str, Any]] = None) -> bool:
    changed = False
    fullscreen_re = re.compile(r"(?<!\S)-fullscreen(?!\S)", re.IGNORECASE)

    def ensure_fullscreen_arg(text: str) -> str:
        s = str(text or "").strip()
        if not s:
            return _DEFAULT_CS2_EXTRA_LAUNCH_ARGS
        if fullscreen_re.search(s):
            return s
        return s + "\n" + _DEFAULT_CS2_EXTRA_LAUNCH_ARGS

    # 旧配置迁移：
    # - 仅当本次是从 JSON 原始对象加载，且缺少 user_configured 标记时，补写该字段
    # - save_config(cfg) 传入 raw=None 时，不做“缺字段迁移”推断，避免把用户已配置状态误重置
    if isinstance(raw, dict) and ("cs2_extra_launch_args_user_configured" not in raw):
        changed = True

    if not cfg.cs2_extra_launch_args_user_configured:
        current_args = str(cfg.cs2_extra_launch_args or "")
        next_args = ensure_fullscreen_arg(current_args)
        if next_args != current_args:
            cfg.cs2_extra_launch_args = next_args
            changed = True

    if isinstance(raw, dict) and ("record_inject_console_lines_user_configured" not in raw):
        # 老配置无标记：有非空内容视为用户已配置，空内容视为未配置（待回填种子）
        cfg.record_inject_console_lines_user_configured = bool(
            str(cfg.record_inject_console_lines or "").strip()
        )
        changed = True

    if not cfg.record_inject_console_lines_user_configured:
        if cfg.record_inject_console_lines != _DEFAULT_RECORD_INJECT_CONSOLE_LINES:
            cfg.record_inject_console_lines = _DEFAULT_RECORD_INJECT_CONSOLE_LINES
            changed = True
    return changed


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
        cfg = AppConfig(**raw)
        if _normalize_config_defaults(cfg, raw):
            save_config(cfg)
        return cfg
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
    _normalize_config_defaults(cfg)
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


_FFMPEG_SCAN_ROOTS: list[Path] = [
    Path(r"C:\\"),
    Path(r"D:\\"),
    Path(r"E:\\"),
    Path(r"F:\\"),
]

_DEFAULT_FFMPEG_DIRS: list[Path] = [
    Path(r"C:\ffmpeg\bin"),
    Path(r"C:\Program Files\ffmpeg\bin"),
    Path(r"C:\Program Files (x86)\ffmpeg\bin"),
    Path(r"D:\ffmpeg\bin"),
    Path(r"E:\ffmpeg\bin"),
    Path(r"C:\tools\ffmpeg\bin"),
    Path(r"C:\ProgramData\chocolatey\bin"),
    Path(r"C:\tools\ffmpeg"),
]


def _iter_ffmpeg_glob_candidates(exe_name: str):
    """在各盘根目录下查找 ffmpeg* 开头的文件夹，返回其中可能的 exe 路径。"""
    for root in _FFMPEG_SCAN_ROOTS:
        if not root.is_dir():
            continue
        try:
            for d in sorted(root.glob("ffmpeg*")):
                if not d.is_dir():
                    continue
                # 优先 bin/ 子目录，再尝试根目录本身
                for sub in (d / "bin", d):
                    candidate = sub / exe_name
                    if candidate.is_file():
                        yield candidate
        except OSError:
            continue


def detect_ffmpeg_path() -> Optional[str]:
    """搜索本机 FFmpeg 可执行文件。优先级：bundled → PATH → 固定目录 → 盘根 ffmpeg* 通配。"""
    bundled = get_data_dir().parent / "third_party" / "ffmpeg" / "ffmpeg.exe"
    if bundled.is_file():
        return str(bundled.resolve())

    found = shutil.which("ffmpeg")
    if found:
        return str(Path(found).resolve())

    exe_name = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    for d in _DEFAULT_FFMPEG_DIRS:
        candidate = d / exe_name
        if candidate.is_file():
            return str(candidate.resolve())

    for candidate in _iter_ffmpeg_glob_candidates(exe_name):
        return str(candidate.resolve())

    return None


_OBS64_REL = Path("bin") / "64bit" / "obs64.exe"
_DEFAULT_OBS_PATHS: tuple[str, ...] = (
    r"C:\Program Files\obs-studio\bin\64bit\obs64.exe",
    r"C:\Program Files (x86)\obs-studio\bin\64bit\obs64.exe",
)


def _obs64_from_install_root(install_root: Path) -> Optional[Path]:
    """由 OBS 安装根目录推断 obs64.exe。"""
    candidates = (
        install_root / _OBS64_REL,
        install_root / "obs64.exe",
        install_root / "bin" / "obs64.exe",
    )
    for cand in candidates:
        if cand.is_file():
            return cand
    return None


def _obs_path_from_registry_value(raw: object) -> Optional[Path]:
    """解析卸载项 InstallLocation / DisplayIcon / UninstallString。"""
    if raw is None:
        return None
    text = str(raw).strip().strip('"')
    if not text:
        return None
    if "," in text:
        text = text.split(",", 1)[0].strip().strip('"')
    try:
        p = Path(text)
    except ValueError:
        return None
    name = p.name.lower()
    if name in ("obs64.exe", "obs.exe") and p.is_file():
        return p
    if name == "uninstall.exe":
        root = p.parent
        if root.name.lower() == "64bit":
            root = root.parent.parent
        found = _obs64_from_install_root(root)
        if found:
            return found
    if p.is_dir():
        return _obs64_from_install_root(p)
    if p.is_file():
        found = _obs64_from_install_root(p.parent)
        if found:
            return found
    return None


def _obs_paths_from_uninstall_registry() -> list[Path]:
    """扫描 Windows 卸载注册表中的 OBS Studio 安装信息。"""
    if winreg is None:
        return []
    out: list[Path] = []
    seen: set[str] = set()

    def add(candidate: Optional[Path]) -> None:
        if candidate is None or not candidate.is_file():
            return
        try:
            key = str(candidate.resolve())
        except OSError:
            key = str(candidate)
        if key in seen:
            return
        seen.add(key)
        out.append(candidate)

    uninstall_roots = (
        (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
    )
    for hive, sub in uninstall_roots:
        try:
            root_key = winreg.OpenKey(hive, sub)
        except OSError:
            continue
        try:
            for direct in ("OBS Studio",):
                try:
                    sk = winreg.OpenKey(root_key, direct)
                except OSError:
                    continue
                try:
                    for val_name in ("InstallLocation", "DisplayIcon", "UninstallString"):
                        try:
                            raw, _ = winreg.QueryValueEx(sk, val_name)
                        except OSError:
                            continue
                        add(_obs_path_from_registry_value(raw))
                finally:
                    winreg.CloseKey(sk)

            i = 0
            while True:
                try:
                    sub_name = winreg.EnumKey(root_key, i)
                except OSError:
                    break
                i += 1
                sk = None
                try:
                    sk = winreg.OpenKey(root_key, sub_name)
                    try:
                        disp, _ = winreg.QueryValueEx(sk, "DisplayName")
                    except OSError:
                        continue
                    name = str(disp).strip().lower()
                    if "obs studio" not in name:
                        continue
                    for val_name in ("InstallLocation", "DisplayIcon", "UninstallString"):
                        try:
                            raw, _ = winreg.QueryValueEx(sk, val_name)
                        except OSError:
                            continue
                        add(_obs_path_from_registry_value(raw))
                finally:
                    if sk is not None:
                        winreg.CloseKey(sk)
        finally:
            winreg.CloseKey(root_key)
    return out


def detect_obs_path() -> Optional[str]:
    """查找 OBS 可执行文件。优先级：卸载注册表 → 常见安装路径 → PATH。"""
    for candidate in _obs_paths_from_uninstall_registry():
        return str(candidate.resolve())
    for p in _DEFAULT_OBS_PATHS:
        pp = Path(p)
        if pp.is_file():
            return str(pp.resolve())
    found = shutil.which("obs64.exe") or shutil.which("obs.exe")
    if found:
        return str(Path(found).resolve())
    return None


def minimize_obs_window() -> None:
    """最小化 OBS 主窗口。仅 Windows 生效；非 Windows 为 no-op。

    先通过 tasklist 找 obs64.exe/obs32.exe 的 PID，再按 PID + 可见窗口匹配。
    OBS 进程起来后需要一点时间才创建窗口，因此内部带重试。
    """
    if sys.platform != "win32":
        return
    try:
        import ctypes
        import subprocess as _sp
        import time as _t

        SW_MINIMIZE = 2

        def _get_obs_pids() -> set[int]:
            obs_pids: set[int] = set()
            try:
                result = _sp.run(
                    ["tasklist", "/FI", "IMAGENAME eq obs64.exe", "/NH", "/FO", "CSV"],
                    capture_output=True, text=True, timeout=10,
                )
                for line in result.stdout.splitlines():
                    parts = [p.strip().strip('"') for p in line.split(",")]
                    if len(parts) >= 2 and parts[0] and parts[1].isdigit():
                        obs_pids.add(int(parts[1]))
            except Exception:
                pass
            return obs_pids

        def _find_visible_hwnd(obs_pids: set[int]):
            found = None

            WNDENUMPROC = ctypes.WINFUNCTYPE(
                ctypes.c_bool, ctypes.c_void_p, ctypes.c_long
            )

            def enum_callback(hwnd, _lparam):
                nonlocal found
                if not ctypes.windll.user32.IsWindowVisible(hwnd):
                    return True
                pid_buf = ctypes.c_ulong(0)
                ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid_buf))
                if pid_buf.value not in obs_pids:
                    return True
                found = hwnd
                return False

            ctypes.windll.user32.EnumWindows(WNDENUMPROC(enum_callback), 0)
            return found

        # 重试最多 5 次，每 0.5 秒一次，给 OBS 时间创建窗口
        for _attempt in range(5):
            obs_pids = _get_obs_pids()
            if not obs_pids:
                logger.warning("OBS process not found for minimization")
                return
            hwnd = _find_visible_hwnd(obs_pids)
            if hwnd:
                ctypes.windll.user32.ShowWindow(hwnd, SW_MINIMIZE)
                logger.info("Minimized OBS window (hwnd=%d, pid=%d)", hwnd, list(obs_pids)[0])
                return
            _t.sleep(0.5)

        logger.warning("No visible OBS window found after retries (PIDs: %s)", obs_pids)
    except Exception as e:
        logger.warning("Failed to minimize OBS window: %s", e)


def ensure_cs2_path(cfg: AppConfig) -> AppConfig:
    """If cs2_path is empty, try auto-detection and persist."""
    if not cfg.cs2_path:
        detected = detect_cs2_path()
        if detected:
            cfg.cs2_path = detected
            save_config(cfg)
    return cfg


def _backend_dir() -> Path:
    """``backend/`` 根目录（与 ``radar_map_assets._backend_dir`` 一致）。"""
    return Path(__file__).resolve().parents[1]


def _name_card_fonts_dir() -> Path:
    """名牌烧录内置字体：``backend/assets/fonts``（随仓库 / 便携包分发）。"""
    return _backend_dir() / "assets" / "fonts"


def _name_card_cjk_medium_candidates() -> list[Path]:
    """CJK 600：Noto Sans SC Medium，眉标 / RESULT 标签。"""
    fonts_dir = _name_card_fonts_dir()
    return [
        fonts_dir / "NotoSansSC-Medium.ttf",
        fonts_dir / "NotoSansSC-SemiBold.ttf",
        fonts_dir / "NotoSansSC-Regular.otf",
        Path("C:/Windows/Fonts/msyh.ttc"),
        Path("/System/Library/Fonts/PingFang.ttc"),
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
    ]


def _name_card_cjk_bold_candidates() -> list[Path]:
    """CJK 700：Noto Sans SC Bold，名字 / 战绩数值 / chip。"""
    fonts_dir = _name_card_fonts_dir()
    return [
        fonts_dir / "NotoSansSC-Bold.ttf",
        fonts_dir / "NotoSansSC-SemiBold.ttf",
        Path("C:/Windows/Fonts/msyhbd.ttc"),
        Path("C:/Windows/Fonts/msyh.ttc"),
        Path("/System/Library/Fonts/PingFang.ttc"),
    ]


def _name_card_font_candidates() -> list[Path]:
    """CJK 字体候选（默认 Medium 档）。"""
    return _name_card_cjk_medium_candidates()


def _font_file_renders_cjk(font_path: Path) -> bool:
    """Pillow 能否用该字体文件正确绘制中文（避免残缺 OTF/VF 导致方框）。"""
    try:
        from PIL import Image, ImageDraw, ImageFont  # type: ignore[import]
    except ImportError:
        return font_path.is_file()

    ext = font_path.suffix.lower()
    load_attempts: list[dict[str, int]] = []
    if ext == ".ttc":
        load_attempts = [{"index": i} for i in range(4)]
    else:
        load_attempts = [{}]

    for kw in load_attempts:
        try:
            font = ImageFont.truetype(str(font_path), 28, **kw)
        except Exception:
            continue
        try:
            bb = font.getbbox("高光")
            if bb is None or (bb[2] - bb[0]) < 12:
                continue
            probe = Image.new("L", (64, 48), 0)
            draw = ImageDraw.Draw(probe)
            draw.text((2, 4), "高光", font=font, fill=255)
            if probe.getbbox() is None:
                continue
            return True
        except Exception:
            continue
    return False


def resolve_name_card_font() -> Optional[Path]:
    """名牌 CJK Medium（600）路径。"""
    for candidate in _name_card_cjk_medium_candidates():
        if candidate.is_file() and _font_file_renders_cjk(candidate):
            return candidate
    return None


def resolve_name_card_font_bold() -> Optional[Path]:
    """名牌 CJK Bold（700）路径。"""
    for candidate in _name_card_cjk_bold_candidates():
        if candidate.is_file() and _font_file_renders_cjk(candidate):
            return candidate
    return None


def resolve_rajdhani_fonts() -> tuple[Optional[Path], Optional[Path]]:
    """返回 (SemiBold, Bold) Rajdhani 字体路径；未安装则返回 (None, None)。
    字体文件位于 ``backend/assets/fonts/``。
    """
    fonts_dir = _name_card_fonts_dir()
    def _first(*names: str) -> Optional[Path]:
        for name in names:
            p = fonts_dir / name
            if p.is_file():
                return p
        return None

    semi = _first("Rajdhani-SemiBold.ttf", "Rajdhani-Medium.ttf")
    bold = _first("Rajdhani-Bold.ttf", "Rajdhani-SemiBold.ttf")
    return semi, bold


def get_primary_monitor_resolution() -> tuple[int, int]:
    """返回主显示器物理分辨率 (width, height)，忽略 DPI 缩放。非 Windows 返回 (1920, 1080) 作为 fallback。"""
    try:
        import ctypes
        # DESKTOPHORZRES/DESKTOPVERTRES 返回实际物理像素，不受 DPI 缩放影响
        gdi32 = ctypes.windll.gdi32  # type: ignore[attr-defined]
        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        hdc = user32.GetDC(0)
        try:
            w = gdi32.GetDeviceCaps(hdc, 118)  # DESKTOPHORZRES
            h = gdi32.GetDeviceCaps(hdc, 117)  # DESKTOPVERTRES
        finally:
            user32.ReleaseDC(0, hdc)
        if w > 0 and h > 0:
            return int(w), int(h)
        return int(user32.GetSystemMetrics(0)), int(user32.GetSystemMetrics(1))
    except Exception:
        return 1920, 1080
