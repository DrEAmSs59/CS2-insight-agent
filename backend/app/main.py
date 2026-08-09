"""FastAPI 主入口 — CS2 Insight Agent 后端 API"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import sys
import uuid
import weakref
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, Literal, Optional

import faulthandler

from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .env_utils import (
    AppConfig,
    load_config,
    ensure_cs2_path,
    resolve_config_path,
    llm_api_key_configured,
    llm_base_url_is_local_host,
    get_data_dir,
)
from .demo_db import DemoListFilters, utc_now_iso
from .databases import demo_db, lite_cut_db, montage_db
from .demo_library_hub import demo_library_hub
from .demo_paths import UPLOAD_DIR, resolve_demo_path, resolve_working_demo_path
from .demo_compat_service import ensure_demo_compatible
from .demo_playback_service import (
    DemoPlaybackBusyError,
    DemoPlaybackCs2RunningError,
    DemoPlaybackPovOptions,
    demo_playback_service,
)
from .demo_watcher import DemoWatcher, _demo_ingest_md5_enabled
from .file_hash import file_md5_hex
from .gsi_ready import (
    cleanup_stale_gsi_configs,
    install_gsi_access_log_filter,
)
from .update_info import resolve_local_version_info
from .runtime_session import runtime_session_dependency, runtime_session_state
from .app_state import application_state
from .api.config import (
    build_data_dir_info,
    open_directory,
    router as config_router,
)
from .api.obs import router as obs_router
from .api.montage import router as montage_router
from .api.montage_exports import router as montage_exports_router
from .api.recorded_clips import router as recorded_clips_router
from .api.desktop import router as desktop_router
from .api.demo_replay import (
    DemoReplayRequest,
    PlayerAnalysisReviewRequest,
    PlayerClipReviewRequest,
    get_demo_replay_binary,
    router as demo_replay_router,
)
from .api.cosmetics_skin import router as cosmetics_skin_router
from .api.config_backup import router as config_backup_router
from .api.gsi import router as gsi_router
from .recording.api import router as recording_router
from .features.lite_cut.api import router as lite_cut_router
from .api_errors import error_detail
from .pov_hud_manager import PovHudError
import httpx

from .steam_match_history import (
    _official_steam_avatar_url,
    fetch_match_history,
    fetch_player_summaries,
    fetch_public_player_summaries,
    fetch_player_summary,
    parse_match_row,
    download_demo,
    game_type_to_mode,
)


# Compatibility exports for tests and older integrations that call helpers from
# ``app.main`` directly. The HTTP routes themselves live in ``app.api.config``.
def get_data_dir_info():
    return build_data_dir_info(get_data_dir())


def open_log_directory():
    logs_dir = get_data_dir() / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    return open_directory(
        str(logs_dir.resolve()),
        "无法自动打开日志目录，请手动复制路径。",
    )


APP_VERSION, _APP_VERSION_SOURCE = resolve_local_version_info()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
install_gsi_access_log_filter()

_FAULT_LOG_FILE = None
try:
    _log_dir_raw = (os.environ.get("CS2_INSIGHT_LOG_DIR") or "").strip()
    _log_dir = Path(_log_dir_raw) if _log_dir_raw else (resolve_config_path().parent / "logs")
    _log_dir.mkdir(parents=True, exist_ok=True)
    _backend_log = _log_dir / "backend.log"
    # 使用 mode='w' 确保每次启动清空旧日志，仅保留当次运行记录
    _file_handler = logging.FileHandler(_backend_log, mode="w", encoding="utf-8")
    _file_handler.setFormatter(logging.Formatter("%(asctime)s [%(name)s] %(levelname)s: %(message)s"))
    logging.getLogger().addHandler(_file_handler)
    
    # 将 Uvicorn 的访问日志 (API 请求) 也写入文件
    for _u_logger_name in ("uvicorn", "uvicorn.access"):
        _u_logger = logging.getLogger(_u_logger_name)
        _u_logger.addHandler(_file_handler)
        _u_logger.propagate = False # 避免重复输出到 root logger

    _FAULT_LOG_FILE = (_log_dir / "backend-fault.log").open("w", encoding="utf-8")
    faulthandler.enable(file=_FAULT_LOG_FILE, all_threads=True)
    logging.getLogger(__name__).info("Backend file logging enabled: %s", _backend_log)
except Exception:
    logging.getLogger(__name__).exception("Backend file logging setup failed")

_demo_roster_locks: weakref.WeakValueDictionary[int, asyncio.Lock] = (
    weakref.WeakValueDictionary()
)
_DEMO_ROSTER_CACHE_VERSION = 3

# 同一路径并发入库（扫描 + watchdog 双触发等）时，避免重复写库 / 双开自动解析任务
_enqueue_striped_locks: list[asyncio.Lock] = []
_enqueue_striped_init_lock = asyncio.Lock()
_ENQUEUE_STRIPE_COUNT = 64

def infer_demo_source(filename: str, server_name: str | None = None) -> str:
    fn = filename.lower()
    sn = (server_name or "").lower()
    if "faceit" in sn:
        return "Faceit"
    if "5eplay" in sn or "5e" in sn:
        return "5E"
    if "完美世界" in sn or "wanmei" in sn:
        return "Perfect World"
    if "valve" in sn:
        return "Matchmaking"
    if "esl" in sn:
        return "ESL"
    if "ESL" in sn:
        return "ESL"
    if "esea" in sn:
        return "ESEA"
    if "blast" in sn:
        return "Blast"
    if "BLAST" in sn:
        return "Blast"
    if "pgl" in sn:
        return "PGL"
    if "starladder" in sn:
        return "StarLadder"
    if "flashpoint" in sn:
        return "Flashpoint"
    if "challengermode" in sn:
        return "Challengermode"

    if re.match(r"^g\d+-", fn):
        return "5E"
    if re.match(r"^\d+_team", fn):
        return "Faceit"

    if "faceit" in fn:
        return "Faceit"
    if "5e" in fn:
        return "5E"
    if "perfectworld" in fn or "pvp" in fn:
        return "Perfect World"
    if "match730" in fn or "matchmaking" in fn:
        return "Matchmaking"
    if "esl" in fn:
        return "ESL"
    if "esea" in fn:
        return "ESEA"

    return "Local/Other"


async def _enqueue_demo_path(path: Path, origin_zip: str | None = None) -> None:
    global _enqueue_striped_locks
    can_store_md5 = demo_db.ingest_md5_supported
    use_md5 = can_store_md5 and _demo_ingest_md5_enabled()
    async with _enqueue_striped_init_lock:
        if not _enqueue_striped_locks:
            _enqueue_striped_locks = [asyncio.Lock() for _ in range(_ENQUEUE_STRIPE_COUNT)]
    demo_path = str(path.resolve())
    stripe = (hash(demo_path) & 0x7FFFFFFF) % _ENQUEUE_STRIPE_COUNT
    async with _enqueue_striped_locks[stripe]:
        size: int | None = None
        mtime_iso: str | None = None
        try:
            st = path.stat()
            size = st.st_size
            from datetime import timezone

            mtime_iso = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat()
        except OSError:
            pass
        source = infer_demo_source(path.name)
        watcher = application_state.demo_watcher
        watch_root = watcher.watch_root_for(path) if watcher is not None else None

        md5_hex: str | None = None
        if use_md5:
            try:
                md5_hex = await asyncio.to_thread(file_md5_hex, path)
            except OSError as e:
                logger.warning("Demo file md5 failed, continue without md5 dedupe: %s (%s)", demo_path, e)
            if md5_hex and await demo_db.content_md5_exists(md5_hex):
                logger.info("Skip enqueue duplicate demo content (md5): %s", demo_path)
                return

        _, inserted = await demo_db.add_demo(
            demo_path,
            file_size=size,
            source=source,
            status="pending",
            added_at=mtime_iso,
            content_md5=md5_hex if use_md5 else None,
            origin_zip=origin_zip if use_md5 else None,
            watch_root=watch_root,
        )
        if not inserted:
            if use_md5 and md5_hex:
                await demo_db.update_demo_content_md5_if_absent(demo_path, md5_hex, origin_zip)
            return

        # 发现阶段只做文件登记、去重与基础校验。地图、名单和记分板在用户确认
        # 入库时一次性提取，避免“扫描目录一次 + 入库一次”的重复 parser 读盘。
    await demo_library_hub.notify("enqueue")


@asynccontextmanager
async def lifespan(_: FastAPI):
    """
    仅初始化 DB 与 DemoWatcher 实例（不启动 watchdog Observer，也不做启动时扫描）。

    **为什么不再自动扫描**：watchdog Observer 会在目录出现新 .dem 时立刻触发
    ``_enqueue_demo_path``。录制期我们会
    准备一个兼容性复验后的 ``_insight_<uuid>.dem`` 到 CS2 的 ``csgo/``；若用户的监听目录与
    ``csgo/`` 有重叠（常见：就是把 CS2 的 replay 目录作为监听目录），**每次录制都会在后台触发
    登记新文件并做内容去重，仍可能与录制争用磁盘；历史上还曾叠加解析工作
    加重负载，故默认不在启动时全量扫描。
    保留 ``DemoWatcher`` 实例只是为 ``POST /api/demos/scan`` 这一条手动扫描接口
    服务；页面上改为用户点"刷新"按钮时主动扫描。
    """
    from .demoparser_runtime import require_demoparser_runtime

    demoparser_runtime = require_demoparser_runtime()
    logger.info(
        "Patched demoparser runtime ready: %s",
        demoparser_runtime["installed_version"],
    )

    await demo_db.init_db()
    await montage_db.init_tables()
    await lite_cut_db.init_tables()
    stale_lite_cut_outputs = await lite_cut_db.recover_interrupted_exports()
    if stale_lite_cut_outputs:
        from .features.lite_cut.export_preflight import cleanup_stale_export_artifacts

        await asyncio.to_thread(cleanup_stale_export_artifacts, stale_lite_cut_outputs)
    cfg = load_config()
    removed_gsi_configs = cleanup_stale_gsi_configs(cfg.cs2_path)
    if removed_gsi_configs:
        logger.info("Removed %d stale CS2 Insight GSI config(s)", len(removed_gsi_configs))
    application_state.demo_watcher = DemoWatcher(
        cfg.demo_watch_paths or [],
        _enqueue_demo_path,
        demo_db,
        max_depth=cfg.demo_watch_scan_depth,
    )
    from .pov_hud_manager import try_restore_stale_pov_on_startup

    for _msg in try_restore_stale_pov_on_startup(cfg):
        if _msg:
            logger.info("POV startup: %s", _msg)
    try:
        yield
    finally:
        try:
            from .recording.api import get_queue_abort_event

            abort_event = get_queue_abort_event()
            if abort_event is not None:
                abort_event.set()
            from .features.lite_cut.api import shutdown_lite_cut_jobs

            await shutdown_lite_cut_jobs(timeout_sec=5.0)
            if application_state.demo_watcher is not None:
                await application_state.demo_watcher.stop()
        except Exception:
            logger.exception("Application shutdown cleanup failed")
        if _FAULT_LOG_FILE and not _FAULT_LOG_FILE.closed:
            _FAULT_LOG_FILE.close()


app = FastAPI(title="CS2 Insight Agent", version=APP_VERSION, lifespan=lifespan)


app.include_router(recording_router)
app.include_router(lite_cut_router)
app.include_router(config_router)
app.include_router(obs_router)
app.include_router(montage_router)
app.include_router(montage_exports_router)
app.include_router(recorded_clips_router)
app.include_router(desktop_router)
app.include_router(demo_replay_router)
app.include_router(cosmetics_skin_router)
app.include_router(config_backup_router)
app.include_router(gsi_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _recovery_marker_path() -> Path:
    return get_data_dir() / "recovery-required.json"


def _write_recovery_marker(reason: str) -> None:
    marker = _recovery_marker_path()
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(
        json.dumps(
            {"reason": reason, "created_at": datetime.now().astimezone().isoformat()},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


@app.get("/api/app/runtime-state")
async def app_runtime_state():
    from .demoparser_runtime import inspect_demoparser_runtime

    return {
        "pid": os.getpid(),
        "instance_id": (os.getenv("CS2_INSIGHT_INSTANCE_ID") or "").strip(),
        "version": app.version,
        "data_dir": str(get_data_dir()),
        "recovery_required": _recovery_marker_path().is_file(),
        "runtime_session": runtime_session_state(),
        "demoparser_runtime": inspect_demoparser_runtime(),
    }


@app.post("/api/app/shutdown")
async def app_shutdown():
    """Abort owned jobs, flush cleanup and then ask uvicorn to exit normally."""
    from .features.lite_cut.api import shutdown_lite_cut_jobs
    from .recording.api import get_queue_abort_event
    from .shutdown_state import request_server_shutdown

    abort_event = get_queue_abort_event()
    if abort_event is not None:
        abort_event.set()
    jobs_clean = await shutdown_lite_cut_jobs(timeout_sec=8.0)
    if application_state.demo_watcher is not None:
        await application_state.demo_watcher.stop()

    loop = asyncio.get_running_loop()
    deadline = loop.time() + 8.0
    while runtime_session_state()["busy"] and loop.time() < deadline:
        await asyncio.sleep(0.1)
    session_clean = not bool(runtime_session_state()["busy"])
    safe_to_exit = jobs_clean and session_clean
    if safe_to_exit:
        _recovery_marker_path().unlink(missing_ok=True)
    else:
        reason = "runtime cleanup timed out before desktop exit"
        await asyncio.to_thread(_write_recovery_marker, reason)

    # Delay until the HTTP response has been handed back to the desktop shell.
    loop.call_later(0.25, request_server_shutdown)
    return {
        "safe_to_exit": safe_to_exit,
        "jobs_clean": jobs_clean,
        "session_clean": session_clean,
        "recovery_marker": str(_recovery_marker_path()) if not safe_to_exit else None,
    }


@app.middleware("http")
async def log_unhandled_http_errors(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception:
        logger.exception("Unhandled request error: %s %s", request.method, request.url.path)
        raise

logger = logging.getLogger(__name__)

# 防止并发请求同时拉起多个 OBS（React StrictMode 双重挂载导致请求发两次）
import threading

_obs_launch_lock = threading.Lock()

def _resolve_web_dist_dir() -> Optional[Path]:
    """
    解析前端静态目录（用于便携包/生产环境）：
    1) CS2_INSIGHT_WEB_DIR 环境变量（最高优先）
    2) 项目根目录下 web/
    3) frontend/dist/
    """
    env_path = (os.getenv("CS2_INSIGHT_WEB_DIR") or "").strip()
    if env_path:
        p = Path(env_path).expanduser().resolve()
        if (p / "index.html").is_file():
            return p

    project_root = Path(__file__).resolve().parents[2]
    for cand in (project_root / "web", project_root / "frontend" / "dist"):
        if (cand / "index.html").is_file():
            return cand
    return None


WEB_DIST_DIR = _resolve_web_dist_dir()
if WEB_DIST_DIR is not None:
    assets_dir = WEB_DIST_DIR / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="web-assets")
    logger.info("前端静态目录已启用: %s", WEB_DIST_DIR)
else:
    logger.warning("未找到前端静态目录（web/ 或 frontend/dist），仅提供 API 服务")

# ── 虚拟键盘 overlay：无条件注册路由，广播行为由 kb_overlay_enabled 配置项运行时控制 ──
from fastapi import WebSocket, WebSocketDisconnect
from .recording.executor.kb_overlay_bus import kb_overlay_bus as _kb_overlay_bus

_overlay_dir = Path(__file__).parent / "recording" / "executor" / "overlay"
app.mount("/overlay", StaticFiles(directory=str(_overlay_dir)), name="kb-overlay-static")

@app.websocket("/ws/kb-overlay")
async def kb_overlay_ws(ws: WebSocket) -> None:
    await ws.accept()
    await _kb_overlay_bus.register(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await _kb_overlay_bus.unregister(ws)


def resolve_spectator_for_demo(dem_path: Path, requested: Optional[str]) -> Optional[str]:
    """
    将客户端传来的 target_player 与本场 Demo 的 roster 对齐（大小写/空白），
    再用于 spec_player。必须先对 roster 匹配：昵称里可能出现 SQLException 等字样，
    不能当作异常串过滤掉。
    """
    from .demo_parse_isolation import get_player_list_isolated

    raw = (requested or "").strip()
    if not raw:
        return None
    low = raw.lower()

    roster = get_player_list_isolated(str(dem_path))
    names = [str(p["name"]).strip() for p in roster if p.get("name") and str(p["name"]).strip()]
    if names:
        if raw in names:
            return raw
        for n in names:
            if n.lower() == low:
                logger.info("spectator 名称大小写归一: %r -> %r", raw, n)
                return n

        # 不在名单中时，再拒绝明显占位串（避免把 HTTP/JSON 错误当名字送进游戏）
        junk = frozenset({"error", "null", "undefined", "nan", "none", "true", "false"})
        if low in junk or "traceback" in low:
            logger.warning("忽略无效的 spectator 名称: %r", raw)
            return None
        logger.warning(
            "spectator 不在本 Demo 玩家名单中，将跳过 spec_player: %r（共 %d 名玩家）",
            raw,
            len(names),
        )
        return None

    # 无名单（解析失败等）：仍信任客户端，避免完全无法切视角
    logger.warning("本 Demo 未能生成玩家名单，仍使用 spectator: %r", raw)
    return raw


def resolve_uploaded_demo_path(p: str) -> Path:
    """接受绝对路径或仅文件名（相对 ``UPLOAD_DIR``）。"""
    return resolve_demo_path(p, upload_dir=UPLOAD_DIR)


async def resolve_uploaded_demo_path_async(p: str) -> Path:
    """Library-aware resolve: use demo cache when the path belongs to demo_files."""
    return await resolve_working_demo_path(p, demo_db=demo_db, upload_dir=UPLOAD_DIR)


async def _library_working_demo_path(row: dict[str, Any]) -> Path:
    from .demo_cache import ensure_row_cached

    try:
        return await ensure_row_cached(demo_db, row)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc


def _analyze_demo_sync(
    dem_path: str,
    target_player: str,
    freeze_to_death_rounds: Optional[list[int]] = None,
) -> dict:
    """Parse in a child process so demoparser native crashes cannot kill FastAPI."""
    from .demo_parse_isolation import analyze_demo_isolated

    return analyze_demo_isolated(dem_path, target_player, freeze_to_death_rounds)


def _demo_inspect_concurrency() -> int:
    try:
        configured = int(os.environ.get("CS2_INSIGHT_DEMO_INSPECT_CONCURRENCY", "2"))
    except ValueError:
        configured = 2
    return max(1, min(4, configured))


async def _inspect_demo_meta(dem_path: Path) -> tuple[list[dict], dict]:
    from .demo_parse_isolation import inspect_demo_isolated

    inspection = await asyncio.to_thread(inspect_demo_isolated, str(dem_path))
    players = inspection.get("players")
    match_meta = inspection.get("match_meta")
    if not isinstance(players, list) or not isinstance(match_meta, dict):
        raise ValueError("Demo inspection returned invalid metadata")
    return players, match_meta


def _demo_failure_code(error: BaseException, phase: str) -> str:
    if isinstance(error, FileNotFoundError):
        return "DEMO_FILE_NOT_FOUND"
    text = str(error).casefold()
    if "not a .dem file" in text or "only .dem" in text:
        return "DEMO_INVALID_EXTENSION"
    if any(marker in text for marker in ("not found", "no such file", "找不到", "不存在")):
        return "DEMO_FILE_NOT_FOUND"
    if "timeout" in text or "timed out" in text or "超时" in text:
        if phase == "inspection":
            return "DEMO_INSPECTION_TIMEOUT"
        if phase == "analysis":
            return "DEMO_ANALYSIS_TIMEOUT"
        return "DEMO_PREPARE_FAILED"
    return {
        "prepare": "DEMO_PREPARE_FAILED",
        "inspection": "DEMO_INSPECTION_FAILED",
        "analysis": "DEMO_ANALYSIS_FAILED",
        "save": "DEMO_ANALYSIS_SAVE_FAILED",
    }.get(phase, "DEMO_ANALYSIS_FAILED")


def _demo_failure_item(
    filename: str,
    error: BaseException,
    phase: str,
    *,
    demo_id: Optional[int] = None,
) -> dict:
    item = {
        "filename": str(filename or "Demo"),
        "code": _demo_failure_code(error, phase),
    }
    if demo_id is not None:
        item["id"] = int(demo_id)
    return item


async def _safe_upload_demo_meta(dem_path: Path) -> tuple[list[dict], dict, Optional[str]]:
    """Return metadata or a stable public error code while keeping the batch alive."""
    try:
        players, match_meta = await _inspect_demo_meta(dem_path)
        if not players:
            logger.warning("Demo inspection returned no players for %s", dem_path)
            return [], match_meta, "DEMO_INSPECTION_FAILED"
        return players, match_meta, None
    except Exception as e:  # noqa: BLE001
        logger.exception("Upload metadata inspection failed for %s: %s", dem_path, e)
        return [], {}, _demo_failure_code(e, "inspection")


def _save_uploaded_demo(file: UploadFile, destination: Path) -> str:
    """Save one upload and return the MD5 calculated during that same read.

    Writes via a unique ``.partial`` then ``os.replace`` so Windows does not
    hit ``OSError: [Errno 22] Invalid argument`` when truncating a large
    existing ``.dem`` that is briefly locked (Defender / prior parse handle).
    """

    if not destination.name or destination.name in {".", ".."}:
        raise ValueError(f"invalid upload destination name: {destination!r}")

    destination.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.md5()
    tmp = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.partial")
    try:
        with tmp.open("wb") as writer:
            while chunk := file.file.read(1024 * 1024):
                writer.write(chunk)
                digest.update(chunk)
        try:
            os.replace(tmp, destination)
        except OSError:
            # Same-volume replace can still fail if the final name is locked.
            try:
                destination.unlink(missing_ok=True)
            except OSError:
                logger.warning(
                    "Could not remove locked upload destination before replace: %s",
                    destination,
                )
            os.replace(tmp, destination)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
    return digest.hexdigest()


def _decode_upload_source_paths(raw: Optional[str], count: int) -> list[Optional[str]]:
    """Decode Electron source paths; malformed browser input safely means no paths."""

    if not raw:
        return [None] * count
    try:
        decoded = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        logger.warning("Ignoring malformed demo upload source_paths_json")
        return [None] * count
    if not isinstance(decoded, list) or len(decoded) != count:
        logger.warning(
            "Ignoring demo upload source paths with unexpected count: expected=%d",
            count,
        )
        return [None] * count
    return [item.strip() if isinstance(item, str) and item.strip() else None for item in decoded]


def _verified_upload_source_path(
    raw_source_path: Optional[str],
    uploaded_path: Path,
    uploaded_md5: str,
) -> Path:
    """Use an Electron local path only when it is the exact uploaded demo."""

    if not raw_source_path:
        logger.info(
            "Browser demo upload has no local source path; using uploaded copy: %s",
            uploaded_path,
        )
        return uploaded_path
    try:
        source = Path(raw_source_path).resolve(strict=True)
        if not source.is_file() or source.suffix.lower() != ".dem":
            raise ValueError("source is not a .dem file")
        if source.stat().st_size != uploaded_path.stat().st_size:
            raise ValueError("source size does not match upload")
        if file_md5_hex(source) != uploaded_md5:
            raise ValueError("source content does not match upload")
    except (OSError, ValueError) as exc:
        logger.warning(
            "Demo upload source path was not trusted; using temporary copy: source=%r reason=%s",
            raw_source_path,
            exc,
        )
        return uploaded_path

    logger.info("Verified original demo path for persistent repair: %s", source)
    return source


def _upload_source_scope(persistent_path: Path, uploaded_path: Path) -> str:
    try:
        return "uploaded_copy" if persistent_path.resolve() == uploaded_path.resolve() else "original"
    except OSError:
        return "uploaded_copy"


def _normalized_expected_parse_players(cfg: AppConfig) -> list[str]:
    """Normalize the watched-player list used by batch resolve / load-mode parse."""
    raw = getattr(cfg, "expected_parse_players", None) or []
    seen: set[str] = set()
    out: list[str] = []
    for x in raw:
        if not isinstance(x, str):
            continue
        s = x.strip()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)
        if len(out) >= 50:
            break
    return out


def _norm_player_key(s: str) -> str:
    from .player_names import normalize_player_key

    return normalize_player_key(s)


def _match_expected_to_roster_row(expected: str, roster: list[dict]) -> Optional[dict]:
    e = (expected or "").strip()
    if not e:
        return None
    en = _norm_player_key(e)
    el = e.lower()
    for r in roster:
        n = (r.get("name") or "").strip()
        if not n:
            continue
        if _norm_player_key(n) == en or n.lower() == el:
            return r
    if len(el) >= 3:
        for r in roster:
            n = (r.get("name") or "").strip()
            if not n:
                continue
            nl = n.lower()
            if el in nl or nl in el:
                return r
    return None


def _match_expected_players_in_roster(expected: list[str], roster: list[dict]) -> list[dict]:
    """Match configured names against an already loaded roster."""

    if not roster:
        return []
    out: list[dict] = []
    seen_key: set[str] = set()
    for exp in expected:
        exp_text = str(exp or "").strip()
        exact = [
            row for row in roster
            if str(row.get("player_key") or "").strip() == exp_text
            or str(row.get("name") or "").strip().casefold() == exp_text.casefold()
        ]
        matches = exact or [row for row in [_match_expected_to_roster_row(exp_text, roster)] if row]
        for row in matches:
            key = str(row.get("player_key") or "").strip()
            if not key:
                sid = str(row.get("steam_id64") or row.get("steamid64") or "").strip()
                key = f"steamid:{sid}" if sid else _norm_player_key(str(row.get("name") or ""))
            if not key or key in seen_key:
                continue
            seen_key.add(key)
            out.append(row)
    return out



async def _run_library_demo_analyze(
    demo_id: int,
    dem_path: str | Path,
    target_players: list[str],
    freeze_to_death_rounds: Optional[list[int]] = None,
    locale: str = "zh",
) -> dict:
    # Working-cache path is for file I/O; demo_files.path remains the DB join key.
    working_path = os.fspath(dem_path)
    row = await demo_db.get_demo_by_id(demo_id)
    library_path = str(row.get("path") or "").strip() if row else ""
    if not library_path:
        library_path = working_path
    target_players = list(
        dict.fromkeys(
            str(player).strip()
            for player in target_players
            if str(player).strip()
        )
    )
    if not target_players:
        raise HTTPException(400, "target_players 不能为空")
    # 列表筛选 / PlayerSelect 依赖 demo_player_stats；缓存命中时不再重复扫描 Demo。
    idx = await get_or_index_demo_roster(demo_id, library_path)
    if idx.get("error"):
        logger.warning(
            "index_demo_player_stats before library analyze demo_id=%s: %s",
            demo_id,
            idx.get("error"),
        )
    await demo_db.update_status(library_path, "parsing", error_msg=None, parsed_at=None)
    players_out: dict = {}
    analysis_workspace = None
    try:
        from .demo_parse_isolation import analyze_multi_isolated

        batch_result = await asyncio.to_thread(
            analyze_multi_isolated,
            working_path,
            target_players,
            freeze_to_death_rounds,
        )
        analysis_workspace = batch_result.pop("__analysis_workspace__", None)
        players_out = {p: v for p, v in batch_result.items() if isinstance(v, dict)}
        missing = [p for p in target_players if p not in players_out]
        if missing:
            logger.warning(
                "analyze_multi_isolated missing players demo_id=%s missing=%s",
                demo_id, missing,
            )
    except Exception as e:
        code = _demo_failure_code(e, "analysis")
        logger.error("Library demo parse failed demo_id=%s path=%s: %s", demo_id, working_path, e)
        await demo_db.update_status(library_path, "error", error_msg=code, parsed_at=None)
        await demo_library_hub.notify("parse_error")
        raise HTTPException(500, error_detail(code)) from e

    if not players_out:
        code = "DEMO_ANALYSIS_EMPTY"
        await demo_db.update_status(library_path, "error", error_msg=code, parsed_at=None)
        await demo_library_hub.notify("parse_error")
        raise HTTPException(500, error_detail(code))

    first_player = next(
        (player for player in target_players if player in players_out),
        next(iter(players_out)),
    )
    first_pdata = players_out[first_player]
    players_payload = {p: dict(v) for p, v in players_out.items() if isinstance(v, dict)}
    analyzed_targets = [p for p in target_players if p in players_payload]
    analyzed_targets.extend(p for p in players_payload if p not in analyzed_targets)
    composite: dict[str, Any] = {
        "players": players_payload,
        "analysis_workspace": analysis_workspace if isinstance(analysis_workspace, dict) else None,
        "analyzed_target_players": analyzed_targets,
        "auto_target_player": first_player,
        # 兼容仍读取「顶层 clips / match_meta」的旧逻辑（列表、SSE、部分 UI）
        "clips": first_pdata.get("clips") or [],
        "match_meta": first_pdata.get("match_meta"),
        "timeline": first_pdata.get("timeline"),
        "round_timeline": first_pdata.get("round_timeline"),
    }
    try:
        # save_result replaces the previous snapshot transactionally; the old
        # result remains readable until the new parse is complete.
        await demo_db.save_result(
            library_path,
            composite,
            timeline_results=players_out,
        )
        await demo_db.update_status(library_path, "done", error_msg=None, parsed_at=utc_now_iso())
    except Exception as e:
        code = _demo_failure_code(e, "save")
        logger.exception("Library demo result commit failed demo_id=%s path=%s", demo_id, library_path)
        await demo_db.update_status(library_path, "error", error_msg=code, parsed_at=None)
        await demo_library_hub.notify("parse_error")
        raise HTTPException(500, error_detail(code)) from e
    await demo_library_hub.notify("analyzed")
    return {
        "players": players_out,
        "analysis_workspace": analysis_workspace if isinstance(analysis_workspace, dict) else None,
        "demo_path": library_path,
    }



class MatchHistoryDownloadBody(BaseModel):
    demo_url: str
    match_id: str
    filename: str  # e.g. "match730_3733386468353335412.dem"


# ─── Demo parsing endpoints ───────────────────────────────────

class ParseRequest(BaseModel):
    target_player: str
    freeze_to_death_rounds: Optional[list[int]] = None
    locale: str = "zh"


async def _ensure_analysis_demo_row(path: Path) -> int:
    """Give every successfully opened analysis demo a stable library id.

    Cosmetics rewrites are persisted and resolved through ``demo_files``.  The
    direct-analysis upload path used to skip that registration, leaving a fully
    parsed demo without the id required by the custom-skin API.
    """
    resolved = path.resolve(strict=True)
    demo_path = str(resolved)
    existing = await demo_db.get_demo_by_path(demo_path)
    if existing:
        return int(existing["id"])

    stat = await asyncio.to_thread(resolved.stat)
    demo_id, inserted = await demo_db.add_demo(
        demo_path,
        file_size=stat.st_size,
        source=infer_demo_source(resolved.name),
        status="pending",
    )
    if inserted:
        await demo_library_hub.notify("enqueue")
    return int(demo_id)


@app.post("/api/demo/upload")
async def upload_demo(
    file: UploadFile = File(...),
    source_path: Annotated[Optional[str], Form()] = None,
):
    if not file.filename or not str(file.filename).lower().endswith(".dem"):
        raise HTTPException(400, error_detail("DEMO_INVALID_EXTENSION"))

    filename = Path(file.filename).name
    dest = UPLOAD_DIR / filename
    uploaded_md5 = await asyncio.to_thread(_save_uploaded_demo, file, dest)
    persistent_path = await asyncio.to_thread(
        _verified_upload_source_path,
        source_path,
        dest,
        uploaded_md5,
    )
    compat = await asyncio.to_thread(
        ensure_demo_compatible,
        persistent_path,
        allow_truncated_packet_tail=True,
    )

    players, match_meta, inspection_error = await _safe_upload_demo_meta(persistent_path)
    demo_id = await _ensure_analysis_demo_row(persistent_path)
    return {
        "id": demo_id,
        "filename": filename,
        "path": str(persistent_path),
        "uploaded_path": str(dest),
        "source_scope": _upload_source_scope(persistent_path, dest),
        "compatibility": {**compat.report.to_dict(), "cached": compat.cached},
        "players": players,
        "match_meta": match_meta,
        "inspection_error": {"code": inspection_error} if inspection_error else None,
    }


@app.post("/api/demo/upload-multiple")
async def upload_demos(
    files: Annotated[list[UploadFile], File()],
    source_paths_json: Annotated[Optional[str], Form()] = None,
):
    """一次上传多个 .dem，返回与单文件 upload 相同结构的数组。"""
    if not files:
        raise HTTPException(400, "请至少选择一个文件")
    source_paths = _decode_upload_source_paths(source_paths_json, len(files))
    saved: list[tuple[str, Path, Path, Any]] = []
    failed: list[dict] = []
    for file, source_path in zip(files, source_paths):
        filename = Path(str(file.filename or "Demo")).name
        try:
            if not file.filename or not str(file.filename).lower().endswith(".dem"):
                raise ValueError("not a .dem file")
            dest = UPLOAD_DIR / filename
            uploaded_md5 = await asyncio.to_thread(_save_uploaded_demo, file, dest)
            persistent_path = await asyncio.to_thread(
                _verified_upload_source_path,
                source_path,
                dest,
                uploaded_md5,
            )
            compat = await asyncio.to_thread(
                ensure_demo_compatible,
                persistent_path,
                allow_truncated_packet_tail=True,
            )
            saved.append((filename, dest, persistent_path, compat))
        except Exception as exc:  # noqa: BLE001
            logger.exception("Demo preparation failed for %s", filename)
            failed.append(_demo_failure_item(filename, exc, "prepare"))

    inspect_sem = asyncio.Semaphore(_demo_inspect_concurrency())

    async def _inspect_one(dest: Path) -> tuple[list[dict], dict]:
        async with inspect_sem:
            return await _safe_upload_demo_meta(dest)

    inspected = await asyncio.gather(
        *(_inspect_one(persistent_path) for _, _, persistent_path, _ in saved)
    )
    out: list[dict] = []
    for (filename, dest, persistent_path, compat), (players, match_meta, inspection_error) in zip(saved, inspected):
        if inspection_error:
            failed.append({"filename": filename, "code": inspection_error})
            continue
        demo_id = await _ensure_analysis_demo_row(persistent_path)
        out.append(
            {
                "id": demo_id,
                "filename": filename,
                "path": str(persistent_path),
                "uploaded_path": str(dest),
                "source_scope": _upload_source_scope(persistent_path, dest),
                "compatibility": {**compat.report.to_dict(), "cached": compat.cached},
                "players": players,
                "match_meta": match_meta,
            },
        )
    return {"uploads": out, "failed": failed}


class OpenLocalDemosBody(BaseModel):
    paths: list[str] = Field(..., min_length=1, max_length=100)


@app.post("/api/demo/open-local")
async def open_local_demos(body: OpenLocalDemosBody):
    """Open Electron-selected demos by absolute path and repair each source once."""

    opened: list[tuple[Path, Any]] = []
    failed: list[dict] = []
    for raw_path in body.paths:
        try:
            path = Path(raw_path).resolve(strict=True)
            if not path.is_file() or path.suffix.lower() != ".dem":
                raise ValueError("not a .dem file")
            compat = await asyncio.to_thread(ensure_demo_compatible, path)
            opened.append((path, compat))
        except Exception as exc:  # noqa: BLE001
            logger.exception("Could not prepare local Demo: %s", raw_path)
            failed.append(
                _demo_failure_item(Path(str(raw_path)).name or str(raw_path), exc, "prepare")
            )

    inspect_sem = asyncio.Semaphore(_demo_inspect_concurrency())

    async def _inspect_local(path: Path) -> tuple[list[dict], dict]:
        async with inspect_sem:
            return await _safe_upload_demo_meta(path)

    inspected = await asyncio.gather(*(_inspect_local(path) for path, _ in opened))
    uploads: list[dict] = []
    for (path, compat), (players, match_meta, inspection_error) in zip(opened, inspected):
        if inspection_error:
            failed.append({"filename": path.name, "code": inspection_error})
            continue
        demo_id = await _ensure_analysis_demo_row(path)
        uploads.append(
            {
                "id": demo_id,
                "filename": path.name,
                "path": str(path),
                "uploaded_path": None,
                "source_scope": "original",
                "compatibility": {**compat.report.to_dict(), "cached": compat.cached},
                "players": players,
                "match_meta": match_meta,
            }
        )
    return {"uploads": uploads, "failed": failed}


@app.post("/api/demo/parse")
async def parse_demo(req: ParseRequest, filename: str):
    from .demo_parse_isolation import IsolatedParseError

    dem_path = UPLOAD_DIR / filename
    if not dem_path.exists():
        raise HTTPException(404, error_detail("DEMO_FILE_NOT_FOUND"))

    try:
        result = await asyncio.to_thread(
            _analyze_demo_sync,
            str(dem_path),
            req.target_player,
            req.freeze_to_death_rounds,
        )
    except IsolatedParseError as e:
        logger.error("Demo parse failed filename=%s: %s", filename, e)
        raise HTTPException(500, error_detail(_demo_failure_code(e, "analysis"))) from e

    cfg = load_config()
    if cfg.ai_mode and cfg.llm.api_key:
        try:
            from .ai_reviewer import enrich_clips_dicts_with_reviewer

            result["clips"] = await enrich_clips_dicts_with_reviewer(
                result.get("clips") or [],
                result.get("match_meta") or {},
                cfg.llm,
                locale=req.locale,
            )
        except Exception as e:
            logging.error("AI review failed: %s", e)

    return result


class ParseMultiRequest(BaseModel):
    target_players: list[str] = Field(..., min_length=1)
    freeze_to_death_rounds: Optional[list[int]] = None
    locale: str = "zh"


@app.post("/api/demo/parse-multi")
async def parse_demo_multi(
    req: ParseMultiRequest,
    filename: str,
    path: Optional[str] = None,
):
    """多玩家解析：共享同一次 Demo 扫描，返回 { players: { name: result } }。"""
    from .demo_parse_isolation import IsolatedParseError, analyze_multi_isolated

    try:
        dem_path = await resolve_uploaded_demo_path_async(path or filename)
        results_by_player = await asyncio.to_thread(
            analyze_multi_isolated,
            str(dem_path),
            req.target_players,
            req.freeze_to_death_rounds,
        )
    except FileNotFoundError as e:
        raise HTTPException(404, error_detail("DEMO_FILE_NOT_FOUND")) from e
    except HTTPException as e:
        code = "DEMO_FILE_NOT_FOUND" if e.status_code == 404 else "DEMO_PREPARE_FAILED"
        raise HTTPException(e.status_code, error_detail(code)) from e
    except IsolatedParseError as e:
        logger.error("Multi-player Demo parse failed filename=%s path=%s: %s", filename, path, e)
        raise HTTPException(500, error_detail(_demo_failure_code(e, "analysis"))) from e

    analysis_workspace = results_by_player.pop("__analysis_workspace__", None)
    players_out = {
        player: result
        for player, result in results_by_player.items()
        if isinstance(result, dict)
    }
    if not players_out:
        logger.error("Multi-player Demo parse returned no player results filename=%s", filename)
        raise HTTPException(500, error_detail("DEMO_ANALYSIS_EMPTY"))

    return {
        "players": players_out,
        "analysis_workspace": analysis_workspace if isinstance(analysis_workspace, dict) else None,
    }


class BatchParseRequest(BaseModel):
    target_player: str
    paths: list[str] = Field(..., min_length=1)
    freeze_to_death_rounds: Optional[list[int]] = None
    locale: str = "zh"


@app.post("/api/demo/parse-batch")
async def parse_demo_batch(req: BatchParseRequest):
    """
    批量解析：``paths`` 为上传后返回的绝对路径或 ``UPLOAD_DIR`` 下的文件名。
    使用线程池并行调用 ``DemoAnalyzer.analyze``，顺序与 ``paths`` 一致。
    """
    from .demo_parse_isolation import IsolatedParseError

    resolved: list[Path] = []
    for p in req.paths:
        resolved.append(await resolve_uploaded_demo_path_async(p))

    target = (req.target_player or "").strip()
    if not target:
        raise HTTPException(400, "target_player 不能为空")

    workers = min(8, max(1, len(resolved)))
    loop = asyncio.get_running_loop()

    def run_one(path_str: str) -> dict:
        return _analyze_demo_sync(path_str, target, req.freeze_to_death_rounds)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        tasks = [loop.run_in_executor(pool, run_one, str(p)) for p in resolved]
        try:
            raw_matches: list[dict] = await asyncio.gather(*tasks)
        except IsolatedParseError as e:
            logger.error("Batch Demo parse failed: %s", e)
            raise HTTPException(500, error_detail(_demo_failure_code(e, "analysis"))) from e

    cfg = load_config()
    matches_out: list[dict] = []
    for dem_path, response in zip(resolved, raw_matches):
        response = dict(response)
        response["demo_path"] = str(dem_path)
        response["demo_filename"] = dem_path.name
        if cfg.ai_mode and cfg.llm.api_key:
            try:
                from .ai_reviewer import enrich_clips_dicts_with_reviewer

                response["clips"] = await enrich_clips_dicts_with_reviewer(
                    response["clips"],
                    response["match_meta"],
                    cfg.llm,
                    locale=req.locale,
                )
            except Exception as e:
                logging.error("AI review failed for %s: %s", dem_path.name, e)
        matches_out.append(response)

    return {"matches": matches_out}


# ─── Local demo library endpoints ─────────────────────────────

_DEMO_LIBRARY_ALLOWED_STATUSES = frozenset({"loaded", "parsing", "done", "error"})


def _split_csv_query_param(s: Optional[str]) -> list[str]:
    if not s:
        return []
    return [p.strip() for p in str(s).split(",") if p.strip()]


def _demo_library_filters_from_query(
    *,
    map_names: Optional[str],
    map_name: Optional[str],
    statuses: Optional[str],
    status: Optional[str],
    min_kills: Optional[int],
    max_deaths: Optional[int],
    min_assists: Optional[int],
    min_kd: Optional[float],
    player_query: Optional[str],
    steam_query: Optional[str] = None,
    rounds_min: Optional[int] = None,
    rounds_max: Optional[int] = None,
    duration_min: Optional[float] = None,
    duration_max: Optional[float] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
) -> DemoListFilters:
    f: DemoListFilters = {}
    mns = _split_csv_query_param(map_names)
    if not mns and map_name and str(map_name).strip():
        mns = [str(map_name).strip()]
    if mns:
        f["map_names"] = mns

    sts = [x for x in _split_csv_query_param(statuses) if x in _DEMO_LIBRARY_ALLOWED_STATUSES]
    if not sts and status and str(status).strip():
        s0 = str(status).strip()
        if s0 in _DEMO_LIBRARY_ALLOWED_STATUSES:
            sts = [s0]
    if sts:
        f["statuses"] = sts
    pq = (player_query or "").strip() or None
    if pq:
        f["player_query"] = pq
    sq = (steam_query or "").strip() or None
    if sq:
        f["steam_query"] = sq
    for key, value in (
        ("min_kills", min_kills),
        ("max_deaths", max_deaths),
        ("min_assists", min_assists),
        ("min_kd", min_kd),
        ("rounds_min", rounds_min),
        ("rounds_max", rounds_max),
        ("duration_min", duration_min),
        ("duration_max", duration_max),
    ):
        if value is not None:
            f[key] = value
    if date_from and str(date_from).strip():
        f["date_from"] = str(date_from).strip()
    if date_to and str(date_to).strip():
        f["date_to"] = str(date_to).strip()
    return f


def _demo_roster_source_fingerprint(demo_path: str) -> tuple[str, int | None, int | None]:
    normalized_path = os.path.normcase(os.path.abspath(os.fspath(demo_path)))
    try:
        stat = Path(demo_path).stat()
        return normalized_path, int(stat.st_size), int(stat.st_mtime_ns)
    except OSError:
        return normalized_path, None, None


async def index_demo_player_stats(
    demo_id: int,
    demo_path: str,
    *,
    precomputed_players: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    from .demo_parse_isolation import get_player_list_isolated

    normalized_path, file_size, mtime_ns = _demo_roster_source_fingerprint(demo_path)
    try:
        raw: Any = (
            precomputed_players
            if precomputed_players is not None
            else await asyncio.to_thread(get_player_list_isolated, demo_path)
        )
        if isinstance(raw, dict):
            players = raw.get("players") or raw.get("roster") or []
        elif isinstance(raw, list):
            players = raw
        else:
            players = []
        if isinstance(players, dict):
            players = list(players.values())
        if not isinstance(players, list):
            players = []
        await demo_db.replace_demo_player_stats(demo_id, demo_path, players)
        await demo_db.save_demo_roster_cache(
            demo_id,
            normalized_path,
            cache_version=_DEMO_ROSTER_CACHE_VERSION,
            source_file_size=file_size,
            source_mtime_ns=mtime_ns,
            state="ready" if players else "empty",
            row_count=len(players),
        )
        return {
            "indexed": True,
            "player_count": len(players),
            "players": players,
            "error": None,
        }
    except Exception as exc:
        logger.warning("Failed to index player stats for demo %s: %s", demo_id, exc)
        try:
            await demo_db.replace_demo_player_stats(demo_id, demo_path, [])
            await demo_db.save_demo_roster_cache(
                demo_id,
                normalized_path,
                cache_version=_DEMO_ROSTER_CACHE_VERSION,
                source_file_size=file_size,
                source_mtime_ns=mtime_ns,
                state="error",
                row_count=0,
                error_msg=str(exc),
            )
        except Exception:
            logger.exception("Failed to persist roster error state for demo %s", demo_id)
        return {
            "indexed": False,
            "player_count": 0,
            "players": [],
            "error": str(exc),
        }


def _roster_rows_for_api(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalize persisted player stats to the roster shape returned by demoparser."""

    out: list[dict[str, Any]] = []
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or raw.get("player_name") or "").strip()
        if not name:
            continue
        team = raw.get("team")
        if team is None:
            team = raw.get("team_number")
        try:
            team = int(team) if team is not None else 0
        except (TypeError, ValueError):
            team = 0
        raw_steam_id64 = raw.get("steam_id64") or raw.get("steamid64")
        raw_steam_id = raw.get("steam_id") or raw.get("steamid")
        steam_id64 = str(raw_steam_id64).strip() if raw_steam_id64 not in (None, "") else None
        steam_id = str(raw_steam_id).strip() if raw_steam_id not in (None, "") else None
        if steam_id64 is None and steam_id and steam_id.isdigit() and len(steam_id) >= 15:
            steam_id64 = steam_id
        if steam_id is None:
            steam_id = steam_id64
        account_id = raw.get("account_id")
        if account_id is None and steam_id64:
            try:
                derived = int(steam_id64) - 76561197960265728
                account_id = derived if derived >= 0 else None
            except (TypeError, ValueError):
                account_id = None
        user_id = raw.get("user_id")

        def integer(key: str) -> int:
            try:
                return int(raw.get(key) or 0)
            except (TypeError, ValueError):
                return 0

        kills = integer("kills")
        deaths = integer("deaths")
        assists = integer("assists")
        try:
            kd = float(raw.get("kd")) if raw.get("kd") is not None else kills / max(deaths, 1)
        except (TypeError, ValueError):
            kd = kills / max(deaths, 1)
        team_name = raw.get("team_name")
        out.append(
            {
                "name": name,
                "player_name": name,
                "player_key": (
                    f"steamid:{steam_id64}"
                    if steam_id64
                    else f"userid:{user_id}"
                    if user_id not in (None, "")
                    else f"name:{name.casefold()}"
                ),
                "team": team,
                "team_number": team,
                "team_name": str(team_name).strip() if team_name not in (None, "") else None,
                "player_color": str(raw.get("player_color") or "").strip().lower() or None,
                "steam_id": steam_id,
                "steam_id64": steam_id64,
                "steamid64": steam_id64,
                "account_id": str(account_id) if account_id not in (None, "") else None,
                "user_id": str(user_id) if user_id not in (None, "") else None,
                "kills": kills,
                "deaths": deaths,
                "assists": assists,
                "kd": round(kd, 3),
            }
        )
    return out


async def _read_valid_demo_roster_cache(
    demo_id: int,
    demo_path: str,
    *,
    cached_rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    metadata = await demo_db.get_demo_roster_cache(demo_id)
    if not metadata:
        return None
    normalized_path, file_size, mtime_ns = _demo_roster_source_fingerprint(demo_path)
    cached_path = os.path.normcase(os.path.abspath(str(metadata.get("demo_path") or "")))
    source_md5 = str(metadata.get("source_content_md5") or "").strip().lower()
    current_md5 = str(metadata.get("current_content_md5") or "").strip().lower()
    try:
        cache_version = int(metadata.get("cache_version"))
        cached_file_size = (
            int(metadata["source_file_size"])
            if metadata.get("source_file_size") is not None
            else None
        )
        cached_mtime_ns = (
            int(metadata["source_mtime_ns"])
            if metadata.get("source_mtime_ns") is not None
            else None
        )
        row_count = int(metadata.get("row_count") or 0)
    except (TypeError, ValueError):
        return None
    if (
        cache_version != _DEMO_ROSTER_CACHE_VERSION
        or cached_path != normalized_path
        or cached_file_size != file_size
        or cached_mtime_ns != mtime_ns
        or source_md5 != current_md5
    ):
        return None

    state = str(metadata.get("state") or "")
    if state == "empty" and row_count == 0:
        return {
            "players": [],
            "cache_hit": True,
            "indexed": True,
            "error": None,
        }
    if state == "error" and row_count == 0:
        return {
            "players": [],
            "cache_hit": True,
            "indexed": False,
            "error": str(metadata.get("error_msg") or "Demo 玩家名单解析失败"),
        }
    if state != "ready" or row_count <= 0:
        return None
    rows = cached_rows if cached_rows is not None else await demo_db.list_demo_player_stats(demo_id)
    players = _roster_rows_for_api(rows)
    if len(players) != row_count:
        return None
    return {
        "players": players,
        "cache_hit": True,
        "indexed": True,
        "error": None,
    }


async def get_or_index_demo_roster(
    demo_id: int,
    demo_path: str,
    *,
    parse_semaphore: asyncio.Semaphore | None = None,
    cached_rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Return a versioned roster cache, parsing the Demo once on a valid miss."""

    cached = await _read_valid_demo_roster_cache(
        demo_id,
        demo_path,
        cached_rows=cached_rows,
    )
    if cached is not None:
        return cached
    lock = _demo_roster_locks.get(demo_id)
    if lock is None:
        lock = asyncio.Lock()
        _demo_roster_locks[demo_id] = lock
    async with lock:
        # Recheck after acquiring the single-flight lock. Persisted empty and
        # error states stop concurrent waiters from serially repeating a parse.
        cached = await _read_valid_demo_roster_cache(demo_id, demo_path)
        if cached is not None:
            return cached
        if parse_semaphore is None:
            indexed = await index_demo_player_stats(demo_id, demo_path)
        else:
            async with parse_semaphore:
                indexed = await index_demo_player_stats(demo_id, demo_path)
        if indexed.get("indexed"):
            await demo_library_hub.notify("player_stats")
        return {
            "players": _roster_rows_for_api(indexed.get("players") or []),
            "cache_hit": False,
            "indexed": bool(indexed.get("indexed")),
            "error": indexed.get("error"),
        }


@app.get("/api/demos")
async def list_demos(
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    q: Optional[str] = Query(default=None, max_length=200, description="按文件名或库内展示名子串筛选"),
    map_names: Optional[str] = Query(
        default=None,
        max_length=4000,
        description="逗号分隔多地图；与 map_name 二选一，优先本参数",
    ),
    map_name: Optional[str] = Query(default=None, max_length=200, description="单地图筛选（兼容旧客户端）"),
    statuses: Optional[str] = Query(
        default=None,
        max_length=256,
        description="逗号分隔状态 loaded,parsing,done,error；与 status 二选一，优先本参数（不含 pending，待入库见 /demos/discovered）",
    ),
    status: Optional[str] = Query(default=None, max_length=64, description="单状态（不含 pending）"),
    min_kills: Optional[int] = Query(default=None, ge=0),
    max_deaths: Optional[int] = Query(default=None, ge=0),
    min_assists: Optional[int] = Query(default=None, ge=0),
    min_kd: Optional[float] = Query(default=None, ge=0),
    player_query: Optional[str] = Query(default=None, max_length=200),
    steam_query: Optional[str] = Query(default=None, max_length=64),
    rounds_min: Optional[int] = Query(default=None, ge=0),
    rounds_max: Optional[int] = Query(default=None, ge=0),
    duration_min: Optional[float] = Query(default=None, ge=0),
    duration_max: Optional[float] = Query(default=None, ge=0),
    date_from: Optional[str] = Query(default=None, max_length=32),
    date_to: Optional[str] = Query(default=None, max_length=32),
):
    qn = (q or "").strip() or None
    filters = _demo_library_filters_from_query(
        map_names=map_names,
        map_name=map_name,
        statuses=statuses,
        status=status,
        min_kills=min_kills,
        max_deaths=max_deaths,
        min_assists=min_assists,
        min_kd=min_kd,
        player_query=player_query,
        steam_query=steam_query,
        rounds_min=rounds_min,
        rounds_max=rounds_max,
        duration_min=duration_min,
        duration_max=duration_max,
        date_from=date_from,
        date_to=date_to,
    )
    total = await demo_db.count_demos(name_query=qn, filters=filters or None)
    rows = await demo_db.list_demos(
        limit=limit,
        offset=offset,
        name_query=qn,
        filters=filters or None,
    )
    return {"items": rows, "limit": limit, "offset": offset, "total": total, "q": qn}


@app.get("/api/demos/compact")
async def list_demos_compact_api(
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    q: Optional[str] = Query(default=None, max_length=200, description="按文件名或库内展示名子串筛选"),
    map_names: Optional[str] = Query(default=None, max_length=4000),
    map_name: Optional[str] = Query(default=None, max_length=200),
    statuses: Optional[str] = Query(default=None, max_length=256),
    status: Optional[str] = Query(default=None, max_length=64),
    min_kills: Optional[int] = Query(default=None, ge=0),
    max_deaths: Optional[int] = Query(default=None, ge=0),
    min_assists: Optional[int] = Query(default=None, ge=0),
    min_kd: Optional[float] = Query(default=None, ge=0),
    player_query: Optional[str] = Query(default=None, max_length=200),
    steam_query: Optional[str] = Query(default=None, max_length=64),
    rounds_min: Optional[int] = Query(default=None, ge=0),
    rounds_max: Optional[int] = Query(default=None, ge=0),
    duration_min: Optional[float] = Query(default=None, ge=0),
    duration_max: Optional[float] = Query(default=None, ge=0),
    date_from: Optional[str] = Query(default=None, max_length=32),
    date_to: Optional[str] = Query(default=None, max_length=32),
):
    qn = (q or "").strip() or None
    filters = _demo_library_filters_from_query(
        map_names=map_names,
        map_name=map_name,
        statuses=statuses,
        status=status,
        min_kills=min_kills,
        max_deaths=max_deaths,
        min_assists=min_assists,
        min_kd=min_kd,
        player_query=player_query,
        steam_query=steam_query,
        rounds_min=rounds_min,
        rounds_max=rounds_max,
        duration_min=duration_min,
        duration_max=duration_max,
        date_from=date_from,
        date_to=date_to,
    )
    total = await demo_db.count_demos(name_query=qn, filters=filters or None)
    rows = await demo_db.list_demos_compact(
        limit=limit,
        offset=offset,
        name_query=qn,
        filters=filters or None,
    )
    return {"items": rows, "limit": limit, "offset": offset, "total": total, "q": qn}


@app.get("/api/demos/ids")
async def list_demo_ids(
    limit: int = Query(default=1000, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    q: Optional[str] = Query(default=None, max_length=200),
    map_names: Optional[str] = Query(default=None, max_length=4000),
    map_name: Optional[str] = Query(default=None, max_length=200),
    statuses: Optional[str] = Query(default=None, max_length=256),
    status: Optional[str] = Query(default=None, max_length=64),
    min_kills: Optional[int] = Query(default=None, ge=0),
    max_deaths: Optional[int] = Query(default=None, ge=0),
    min_assists: Optional[int] = Query(default=None, ge=0),
    min_kd: Optional[float] = Query(default=None, ge=0),
    player_query: Optional[str] = Query(default=None, max_length=200),
    steam_query: Optional[str] = Query(default=None, max_length=64),
    rounds_min: Optional[int] = Query(default=None, ge=0),
    rounds_max: Optional[int] = Query(default=None, ge=0),
    duration_min: Optional[float] = Query(default=None, ge=0),
    duration_max: Optional[float] = Query(default=None, ge=0),
    date_from: Optional[str] = Query(default=None, max_length=32),
    date_to: Optional[str] = Query(default=None, max_length=32),
):
    qn = (q or "").strip() or None
    filters = _demo_library_filters_from_query(
        map_names=map_names,
        map_name=map_name,
        statuses=statuses,
        status=status,
        min_kills=min_kills,
        max_deaths=max_deaths,
        min_assists=min_assists,
        min_kd=min_kd,
        player_query=player_query,
        steam_query=steam_query,
        rounds_min=rounds_min,
        rounds_max=rounds_max,
        duration_min=duration_min,
        duration_max=duration_max,
        date_from=date_from,
        date_to=date_to,
    )
    ids = await demo_db.list_filtered_demo_ids(
        name_query=qn,
        filters=filters or None,
        limit=limit,
        offset=offset,
    )
    return {"ids": ids, "limit": limit, "offset": offset, "q": qn}


@app.get("/api/demos/stream")
async def demo_library_event_stream():
    """SSE：库内 demo 新增 / 改名 / 解析状态变化时推送，前端防抖刷新列表。"""

    async def event_iter():
        q = await demo_library_hub.subscribe()
        try:
            yield ": ok\n\n"
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=20.0)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                payload = json.dumps({"reason": msg}, ensure_ascii=False)
                yield f"event: library\ndata: {payload}\n\n"
        finally:
            await demo_library_hub.unsubscribe(q)

    return StreamingResponse(
        event_iter(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-store, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/match-history/matches")
async def get_match_history():
    cfg = load_config()
    if not cfg.steam_api_key or not cfg.steam_id64:
        raise HTTPException(400, "Steam API Key 和 SteamID64 未配置，请先保存凭据")

    try:
        raw_matches, player = await asyncio.gather(
            fetch_match_history(cfg.steam_api_key, cfg.steam_id64, cfg.match_count),
            fetch_player_summary(cfg.steam_api_key, cfg.steam_id64),
        )
    except httpx.HTTPStatusError as e:
        status = e.response.status_code
        if status == 403:
            raise HTTPException(403, "Steam API Key 无效，请检查凭据")
        if status == 429:
            raise HTTPException(429, "Steam API 请求频率超限，请稍后再试")
        raise HTTPException(502, f"Steam API 返回 {status}")
    except httpx.RequestError as e:
        raise HTTPException(502, f"无法连接 Steam API: {e}")
    except ValueError as e:
        raise HTTPException(502, str(e))

    mode_filter = cfg.match_mode
    parsed_rows: list[tuple[dict, str]] = []
    for i, m in enumerate(raw_matches):
        wmi = m.get("watchablematchinfo") or {}
        mode = game_type_to_mode(int(wmi.get("game_type", 0)))
        if mode != mode_filter:
            continue
        try:
            row = parse_match_row(m, player_index=0)
        except Exception:
            logger.exception("Failed to parse match %s", m.get("matchid"))
            continue
        dem_name = f"match730_{row['match_id']}.dem"
        parsed_rows.append((row, dem_name))
    existing_filenames = await demo_db.find_existing_filenames(
        dem_name for _, dem_name in parsed_rows
    )
    rows = []
    for row, dem_name in parsed_rows:
        row["demo_in_library"] = dem_name in existing_filenames
        rows.append(row)

    wins = sum(1 for r in rows if r["result"] == "win")
    losses = sum(1 for r in rows if r["result"] == "loss")
    total_kills = sum(r["kills"] for r in rows)
    total_deaths = sum(r["deaths"] for r in rows)
    total_hs = sum(r["headshot_kills"] for r in rows)
    total_dmg = sum(r["damage"] for r in rows)
    total_rounds = sum(r["score_own"] + r["score_opp"] for r in rows)
    avg_kd = round(total_kills / total_deaths, 2) if total_deaths else 0.0
    hs_pct = round(total_hs / total_kills * 100) if total_kills else 0
    avg_adr = round(total_dmg / total_rounds, 1) if total_rounds else 0.0
    avg_rating = round(sum(r["rating"] for r in rows) / len(rows), 2) if rows else 0.0

    return {
        "player": {
            "name": player.get("personaname", ""),
            "avatar": player.get("avatarfull", ""),
            "steam_id64": cfg.steam_id64,
        },
        "stats_summary": {
            "wins": wins,
            "losses": losses,
            "avg_kd": avg_kd,
            "headshot_pct": hs_pct,
            "avg_adr": avg_adr,
            "rating": avg_rating,
        },
        "matches": rows,
        "total": len(rows),
    }


@app.post("/api/match-history/test-connection")
async def test_steam_connection(body: dict = Body(...)):
    api_key = str(body.get("steam_api_key") or "").strip()
    steam_id64 = str(body.get("steam_id64") or "").strip()
    if not api_key or not steam_id64:
        raise HTTPException(400, "steam_api_key 和 steam_id64 不能为空")
    try:
        player = await fetch_player_summary(api_key, steam_id64)
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, f"Steam API 返回 {e.response.status_code}")
    except httpx.RequestError as e:
        raise HTTPException(502, f"无法连接 Steam: {e}")
    if not player:
        raise HTTPException(404, "未找到该 SteamID 的玩家信息，请检查 SteamID64")
    return {"ok": True, "name": player.get("personaname", ""), "avatar": player.get("avatarfull", "")}


@app.get("/api/steam/player-avatars")
async def get_steam_player_avatars(
    steam_ids: str = Query("", max_length=220),
):
    """Resolve optional Steam CDN avatars for one Demo roster."""
    cfg = load_config()
    if not cfg.steam_cdn_assets_enabled:
        return {"enabled": False, "avatars": {}}

    unique_ids: list[str] = []
    for raw in steam_ids.split(","):
        value = raw.strip()
        if not value.isdigit() or not 15 <= len(value) <= 20 or value in unique_ids:
            continue
        unique_ids.append(value)
        if len(unique_ids) >= 10:
            break
    if not unique_ids:
        return {"enabled": True, "avatars": {}}

    players: list[dict] = []
    try:
        players = await fetch_public_player_summaries(unique_ids)
    except httpx.HTTPError as exc:
        logger.info("Public Steam avatar lookup unavailable: %s", exc)

    resolved_ids = {str(player.get("steamid") or "") for player in players}
    missing_ids = [steam_id for steam_id in unique_ids if steam_id not in resolved_ids]
    if missing_ids and cfg.steam_api_key:
        try:
            players.extend(await fetch_player_summaries(cfg.steam_api_key, missing_ids))
        except (httpx.HTTPError, ValueError) as exc:
            logger.info("Steam Web API avatar lookup unavailable: %s", exc)

    avatars: dict[str, str] = {}
    for player in players:
        steam_id = str(player.get("steamid") or "")
        avatar_url = _official_steam_avatar_url(player.get("avatarfull"))
        if steam_id in unique_ids and avatar_url:
            avatars[steam_id] = avatar_url
    return {"enabled": True, "avatars": avatars}


@app.post("/api/match-history/download")
async def download_match_demo(body: MatchHistoryDownloadBody):
    cfg = load_config()
    watch_paths = [p for p in cfg.demo_watch_paths if p.strip()]
    if not watch_paths:
        raise HTTPException(400, "未配置 Demo 库监听目录，请先在「Demo 库」设置监听路径")

    dest_dir = Path(watch_paths[0])
    requested_filename = Path(body.filename).name.strip()
    if not requested_filename or requested_filename in {".", ".."}:
        raise HTTPException(400, "Demo 文件名无效")
    filename = (
        requested_filename
        if requested_filename.lower().endswith(".dem")
        else requested_filename + ".dem"
    )
    try:
        dem_path = await download_demo(body.demo_url, dest_dir, filename)
    except httpx.HTTPStatusError as e:
        raise HTTPException(502, f"下载失败，HTTP {e.response.status_code}")
    except httpx.RequestError as e:
        raise HTTPException(502, f"下载超时或网络错误: {e}")
    except OSError as e:
        raise HTTPException(500, f"文件写入失败: {e}")
    except Exception as e:
        raise HTTPException(500, f"解压失败: {e}")

    await _enqueue_demo_path(dem_path)
    return {"ok": True, "path": str(dem_path), "filename": filename}


@app.get("/api/demos/discovered")
async def list_discovered_demos(
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    q: Optional[str] = Query(default=None, max_length=200),
):
    """列出已发现但尚未入库（status='pending'）的 demo。"""
    qn = (q or "").strip() or None
    rows, total = await demo_db.list_discovered_page(
        limit=limit,
        offset=offset,
        name_query=qn,
    )
    return {"items": rows, "limit": limit, "offset": offset, "total": total, "q": qn}


@app.get("/api/demos/{demo_id}")
async def get_demo_library_item(demo_id: int):
    """单条 Demo 库记录（与列表项结构一致），用于跨页选中后按 id 拉取元数据。"""
    item = await demo_db.get_demo_list_item(demo_id)
    if not item:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    return item


@app.get("/api/demos/{demo_id}/player-stats")
async def get_demo_player_stats_library(demo_id: int):
    row = await demo_db.get_demo_by_id(demo_id)
    if not row:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    return {"demo_id": demo_id, "players": await demo_db.list_demo_player_stats(demo_id)}


@app.post("/api/demos/{demo_id}/index-player-stats")
async def post_index_demo_player_stats(demo_id: int):
    row = await demo_db.get_demo_by_id(demo_id)
    if not row:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    dem_path = str(row["path"])
    if not Path(dem_path).is_file():
        raise HTTPException(404, "Demo file not found on disk")
    out = await index_demo_player_stats(demo_id, dem_path)
    if out.get("indexed"):
        await demo_library_hub.notify("player_stats")
        return {"ok": True, "demo_id": demo_id, "indexed": True, "player_count": int(out.get("player_count") or 0)}
    return {
        "ok": False,
        "demo_id": demo_id,
        "indexed": False,
        "player_count": 0,
        "error": str(out.get("error") or "索引失败"),
    }


@app.get("/api/players/search")
async def search_players_library(
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(20, ge=1, le=100),
):
    return {"items": await demo_db.search_players(q, limit=limit)}


class BatchResolvePlayersBody(BaseModel):
    """多选载入时：按关注名单或手动昵称行，在每份 demo roster 中解析出待分析玩家名。"""

    demo_ids: list[int] = Field(..., min_length=1, max_length=200)
    mode: Literal["config_expected", "manual", "none"] = "none"
    manual_lines: Optional[list[str]] = None


class BatchSummaryBody(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=100)


@app.post("/api/demos/batch-resolve-players")
async def batch_resolve_players(body: BatchResolvePlayersBody):
    if body.mode == "none":
        return {"resolved": {str(i): [] for i in body.demo_ids}, "failed": []}
    if body.mode == "config_expected":
        cfg = load_config()
        exp = _normalized_expected_parse_players(cfg)
        if not exp:
            return {"resolved": {str(i): [] for i in body.demo_ids}, "failed": []}
    elif body.mode == "manual":
        exp = [s.strip() for s in (body.manual_lines or []) if isinstance(s, str) and s.strip()]
    else:
        exp = []
    resolved: dict[str, list[str]] = {}
    failed: list[dict] = []
    for did in body.demo_ids:
        row = await demo_db.get_demo_by_id(int(did))
        if not row:
            resolved[str(did)] = []
            failed.append(
                _demo_failure_item(str(did), FileNotFoundError(), "inspection", demo_id=int(did))
            )
            continue
        dem_path = str(row["path"])
        try:
            roster_lookup = await get_or_index_demo_roster(int(did), dem_path)
            if roster_lookup.get("error"):
                raise RuntimeError(str(roster_lookup["error"]))
            matched = _match_expected_players_in_roster(exp, roster_lookup["players"])
        except Exception as exc:  # noqa: BLE001
            logger.exception("batch_resolve roster match failed demo_id=%s", did)
            resolved[str(did)] = []
            failed.append(
                _demo_failure_item(
                    str(row.get("display_name") or row.get("filename") or did),
                    exc,
                    "inspection",
                    demo_id=int(did),
                )
            )
            continue
        player_keys = [
            str(r.get("player_key") or r.get("name") or "").strip()
            for r in matched
            if r.get("player_key") or r.get("name")
        ]
        resolved[str(did)] = player_keys
    return {"resolved": resolved, "failed": failed}


@app.post("/api/demos/batch-summary")
async def batch_demo_summary(body: BatchSummaryBody):
    """批量加载 Demo 元数据 + 玩家列表；坏文件作为逐项失败返回。"""
    sem = asyncio.Semaphore(5)
    rows_by_id = {
        int(row["id"]): row
        for row in await demo_db.get_demo_list_items(body.ids)
    }

    async def fetch_one(demo_id: int) -> dict:
        row = rows_by_id.get(int(demo_id))
        if not row:
            raise FileNotFoundError(f"Demo {demo_id} does not exist")
        row = dict(row)
        if row.get("result_error"):
            raise ValueError(str(row["result_error"]))
        # Materialize working cache for legacy rows (no / stale cached_path).
        await _library_working_demo_path(row)
        dem_path = str(row.get("path") or "")
        roster_lookup = await get_or_index_demo_roster(
            demo_id,
            dem_path,
            parse_semaphore=sem,
            cached_rows=row.get("players") or None,
        )
        if roster_lookup.get("error"):
            raise ValueError(str(roster_lookup["error"]))
        players = roster_lookup["players"]
        match_meta = {
            "map_name": row.get("map_name"),
            "total_rounds": row.get("total_rounds"),
            "team_a_score": row.get("team_a_score"),
            "team_b_score": row.get("team_b_score"),
            "duration_mins": row.get("duration_mins"),
            "match_date": row.get("match_date"),
        }
        row.pop("players", None)
        return {**row, "players": players, "match_meta": match_meta}

    results = await asyncio.gather(
        *[fetch_one(did) for did in body.ids],
        return_exceptions=True,
    )

    errors: list[dict] = []
    items: list[dict] = []
    for did, res in zip(body.ids, results):
        if isinstance(res, Exception):
            row = rows_by_id.get(int(did))
            if row:
                fname = (
                    (row.get("display_name") and str(row["display_name"]).strip())
                    or row.get("filename")
                    or str(did)
                )
            else:
                fname = str(did)
            logger.warning("Batch Demo summary skipped id=%s filename=%s: %s", did, fname, res)
            errors.append(
                _demo_failure_item(
                    fname,
                    res,
                    "inspection",
                    demo_id=int(did),
                )
            )
        else:
            items.append(res)

    return {"items": items, "failed": errors}


class DemoDisplayNamePatch(BaseModel):
    """仅更新库内展示名，不修改磁盘文件；空串表示清除展示名（界面回退为 ``filename``）。"""

    display_name: str = Field(default="", max_length=512)


class DemoWatchPathInspectBody(BaseModel):
    path: str = Field(..., min_length=1, max_length=4096)
    max_depth: int = Field(default=2, ge=0, le=32)


@app.patch("/api/demos/{demo_id}")
async def patch_demo_display_name(demo_id: int, body: DemoDisplayNamePatch):
    ok = await demo_db.update_display_name(demo_id, body.display_name)
    if not ok:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    item = await demo_db.get_demo_list_item(demo_id)
    if not item:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    await demo_library_hub.notify("display_name")
    return item


@app.post("/api/demos/scan")
async def scan_watch_paths():
    watcher = application_state.demo_watcher
    if watcher is None:
        return {"scanned": 0, "player_stats_index": None, "discovered_count": 0}
    scanned = await watcher.scan_existing()
    logger.info("POST /api/demos/scan: scan_existing finished scanned=%s", scanned)
    try:
        discovered_count = await demo_db.count_discovered_demos()
    except Exception:
        logger.exception("count discovered demos after scan failed")
        discovered_count = 0
    return {"scanned": scanned, "player_stats_index": None, "discovered_count": discovered_count}


@app.post("/api/demos/watch-path/inspect")
async def inspect_demo_watch_path(body: DemoWatchPathInspectBody):
    """Validate and enumerate a watch directory without parsing demo contents."""
    from .demo_watcher import iter_candidate_files

    candidate = Path(body.path).expanduser()
    if not candidate.is_dir():
        return {
            "valid": False,
            "path": str(candidate),
            "demo_count": 0,
            "zip_count": 0,
            "error": "目录不存在或无法访问",
        }
    try:
        resolved = candidate.resolve()

        def _count_candidates() -> tuple[int, int]:
            demos = sum(1 for _ in iter_candidate_files(resolved, (".dem",), max_depth=body.max_depth))
            zips = sum(1 for _ in iter_candidate_files(resolved, (".zip",), max_depth=body.max_depth))
            return demos, zips

        demo_count, zip_count = await asyncio.to_thread(_count_candidates)
    except OSError as exc:
        return {
            "valid": False,
            "path": str(candidate),
            "demo_count": 0,
            "zip_count": 0,
            "error": str(exc),
        }
    return {
        "valid": True,
        "path": str(resolved),
        "demo_count": demo_count,
        "zip_count": zip_count,
        "max_depth": body.max_depth,
    }


@app.post("/api/demos/{demo_id}/parse")
async def reparse_demo(demo_id: int):
    row = await demo_db.get_demo_by_id(demo_id)
    if not row:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    await demo_db.invalidate_demo_roster_cache(demo_id, clear_rows=True)
    await demo_db.clear_result(row["path"])
    await demo_db.update_status(row["path"], "loaded", error_msg=None, parsed_at=None)
    await demo_library_hub.notify("reparse")
    return {"status": "loaded", "demo_id": demo_id}


class DemoAnalyzeRequest(BaseModel):
    target_players: list[str] = Field(..., min_length=1)
    freeze_to_death_rounds: Optional[list[int]] = None
    locale: str = "zh"




@app.post("/api/demo/player-review")
async def review_demo_player(req: PlayerAnalysisReviewRequest):
    """Generate a player-level review from the current Insight Agent parse."""
    cfg = load_config()
    if not (
        llm_api_key_configured(cfg.llm.api_key)
        or llm_base_url_is_local_host(cfg.llm.base_url)
    ):
        raise HTTPException(400, "请先在设置中配置 AI 服务")
    try:
        from .ai_reviewer import review_player_stats_with_reviewer

        commentary = await review_player_stats_with_reviewer(
            req.player,
            req.match,
            cfg.llm,
            locale=req.locale,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logging.getLogger(__name__).warning("Player review failed: %s", exc)
        raise HTTPException(502, f"AI 点评生成失败：{exc}") from exc
    return {"commentary": commentary}


@app.post("/api/demo/review-clips")
async def review_demo_player_clips(req: PlayerClipReviewRequest):
    """Review one selected player's existing clips without re-parsing the Demo."""
    cfg = load_config()
    if not cfg.ai_mode:
        raise HTTPException(409, "AI 洞察模式未开启")
    if not (
        llm_api_key_configured(cfg.llm.api_key)
        or llm_base_url_is_local_host(cfg.llm.base_url)
    ):
        raise HTTPException(400, "请先在设置中配置 AI 服务")
    try:
        from .ai_reviewer import enrich_clips_dicts_with_reviewer

        clips = await enrich_clips_dicts_with_reviewer(
            req.clips,
            req.match_meta,
            cfg.llm,
            locale=req.locale,
        )
    except Exception as exc:
        logging.getLogger(__name__).warning("Selected-player clip review failed: %s", exc)
        raise HTTPException(502, f"AI 锐评生成失败：{exc}") from exc
    return {"clips": clips, "reviewed": True}


@app.get("/api/demos/{demo_id}/players")
async def get_demo_players(demo_id: int):
    row = await demo_db.get_demo_by_id(demo_id)
    if not row:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    dem_path = await _library_working_demo_path(row)
    await asyncio.to_thread(ensure_demo_compatible, dem_path)
    match_meta = {
        "map_name": row.get("map_name"),
        "total_rounds": row.get("total_rounds"),
        "team_a_score": row.get("team_a_score"),
        "team_b_score": row.get("team_b_score"),
        "duration_mins": row.get("duration_mins"),
        "match_date": row.get("match_date"),
    }
    roster_lookup = await get_or_index_demo_roster(demo_id, str(row["path"]))
    if roster_lookup.get("error"):
        raise HTTPException(500, f"Demo 玩家名单解析失败：{roster_lookup['error']}")
    return {
        "players": roster_lookup["players"],
        "match_meta": match_meta,
    }


@app.post("/api/demos/{demo_id}/analyze")
async def analyze_demo_from_library(demo_id: int, req: DemoAnalyzeRequest):
    row = await demo_db.get_demo_by_id(demo_id)
    if not row:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    dem_path = await _library_working_demo_path(row)
    await asyncio.to_thread(ensure_demo_compatible, dem_path)
    out = await _run_library_demo_analyze(
        demo_id,
        dem_path,
        req.target_players,
        req.freeze_to_death_rounds,
        locale=req.locale,
    )
    return {**out, "demo_filename": row["filename"]}


@app.delete("/api/demos/{demo_id}")
async def delete_demo(demo_id: int):
    demo = await demo_db.get_demo_by_id(demo_id)
    if not demo:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    from .parser.replay_cache_storage import remove_demo_row_caches

    # Reclaim parse/replay caches for original + working paths before the
    # demo-cache file is unlinked with the library row.
    cache_removed = await asyncio.to_thread(remove_demo_row_caches, demo)
    ok = await demo_db.delete_demo(demo_id)
    if not ok:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    await demo_library_hub.notify("deleted")
    return {"status": "deleted", "demo_id": demo_id, "replay_cache": cache_removed}


class DemoPlaybackPovBody(BaseModel):
    enabled: bool = False
    radar_mode: Literal[-1, 0] = 0
    teamcounter_numeric: bool = False


class DemoPlaybackOptionsBody(BaseModel):
    pov_hud: DemoPlaybackPovBody = Field(default_factory=DemoPlaybackPovBody)


class DemoPlayByPathBody(DemoPlaybackOptionsBody):
    path: str = Field(..., min_length=1)


def _launch_cs2_play_demo(
    dem_path: Path,
    options: Optional[DemoPlaybackOptionsBody] = None,
) -> dict[str, Any]:
    """Launch managed direct playback; both normal and POV modes require CS2 to be closed."""
    cfg = ensure_cs2_path(load_config())
    if not cfg.cs2_path or not Path(cfg.cs2_path).is_file():
        raise HTTPException(400, error_detail("DEMO_PLAYBACK_CS2_PATH_MISSING"))
    if not dem_path.is_file():
        raise HTTPException(422, error_detail("DEMO_PLAYBACK_DEMO_NOT_FOUND", path=str(dem_path)))

    body = options or DemoPlaybackOptionsBody()
    pov = body.pov_hud
    try:
        return demo_playback_service.launch(
            dem_path,
            cfg,
            DemoPlaybackPovOptions(
                enabled=bool(pov.enabled),
                radar_mode=int(pov.radar_mode),
                teamcounter_numeric=bool(pov.teamcounter_numeric),
            ),
        )
    except DemoPlaybackCs2RunningError as exc:
        raise HTTPException(409, error_detail("DEMO_PLAYBACK_CS2_RUNNING")) from exc
    except DemoPlaybackBusyError as exc:
        raise HTTPException(409, error_detail("DEMO_PLAYBACK_BUSY")) from exc
    except PovHudError as exc:
        raise HTTPException(400, error_detail("DEMO_PLAYBACK_POV_FAILED", err=str(exc))) from exc
    except FileNotFoundError as exc:
        raise HTTPException(400, error_detail("DEMO_PLAYBACK_CS2_PATH_MISSING")) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to launch CS2 for direct playback")
        raise HTTPException(500, error_detail("DEMO_PLAYBACK_LAUNCH_FAILED", err=str(exc))) from exc


@app.get("/api/demo/playback/preflight")
async def demo_playback_preflight():
    """Preflight for the playback dialog; launch performs the authoritative recheck."""
    cfg = ensure_cs2_path(load_config())
    return await asyncio.to_thread(demo_playback_service.preflight, cfg)


@app.get("/api/demo/playback/status")
async def demo_playback_status(session_id: str = Query(..., min_length=1, max_length=128)):
    """Return the measured lifecycle and POV file-restoration result for one playback session."""
    return await asyncio.to_thread(demo_playback_service.session_status, session_id)


@app.post("/api/demo/play")
async def play_demo_by_path(
    body: DemoPlayByPathBody,
    _runtime_session: None = Depends(runtime_session_dependency),
):
    """按路径启动 CS2 播放 Demo（本地上传等无库内 id 的场景）。"""
    dem_path = await resolve_uploaded_demo_path_async(body.path)
    return await asyncio.to_thread(_launch_cs2_play_demo, dem_path, body)


@app.post("/api/demos/{demo_id}/play")
async def play_demo_in_cs2(
    demo_id: int,
    body: Annotated[Optional[DemoPlaybackOptionsBody], Body()] = None,
    _runtime_session: None = Depends(runtime_session_dependency),
):
    """将 Demo 复制到 game/csgo/ 后直接启动 CS2 播放，不涉及 OBS 录制。"""
    row = await demo_db.get_demo_by_id(demo_id)
    if not row:
        raise HTTPException(404, f"Demo not found: {demo_id}")

    dem_path = await _library_working_demo_path(row)
    if not dem_path.is_file():
        raise HTTPException(422, "Demo 文件不存在于磁盘，无法播放。")

    return await asyncio.to_thread(_launch_cs2_play_demo, dem_path, body)


@app.post("/api/demos/{demo_id}/delete-file")
async def delete_demo_file(demo_id: int):
    """从磁盘删除 .dem 文件（如有同名 .zip 也一并删除），同时删除库内记录。"""
    demo = await demo_db.get_demo_by_id(demo_id)
    if not demo:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    disk_path = str(demo["path"])
    cached_path = str(demo.get("cached_path") or "").strip()
    from .file_quarantine import quarantine_files

    targets = [Path(disk_path), Path(disk_path).with_suffix(".zip")]
    if cached_path:
        targets.append(Path(cached_path))
    from .parser.replay_cache_storage import remove_demo_row_caches

    # Generated replay assets are disposable. Reclaim them while the source
    # Demo still exists so legacy fingerprint-only entries remain attributable.
    cache_removed = await asyncio.to_thread(remove_demo_row_caches, demo)
    try:
        quarantined = await asyncio.to_thread(quarantine_files, targets, "demos")
    except OSError as exc:
        raise HTTPException(409, f"Demo 文件无法安全移入回收区，数据库记录未删除：{exc}") from exc
    # Only commit the database deletion after every owned file is recoverable.
    try:
        deleted = await demo_db.delete_demo(demo_id)
        if not deleted:
            raise HTTPException(404, f"Demo not found: {demo_id}")
    except Exception:
        try:
            await asyncio.to_thread(quarantined.restore)
        except OSError:
            logger.exception("Failed to restore quarantined demo files for demo_id=%s", demo_id)
        raise
    await demo_library_hub.notify("deleted")
    return {
        "status": "deleted",
        "demo_id": demo_id,
        "quarantined_files": [str(item.original) for item in quarantined.files],
        "recovery_directory": str(quarantined.directory) if quarantined.files else None,
        "replay_cache": cache_removed,
    }


class BatchIngestBody(BaseModel):
    demo_ids: list[int] = Field(..., min_length=1, max_length=200)


@app.post("/api/demos/batch-ingest")
async def batch_ingest_demos(body: BatchIngestBody):
    """批量入库：对每个 pending demo 运行轻量元数据提取，状态改为 loaded。"""
    ingested = 0
    failed: list[dict[str, Any]] = []
    rows_by_id = {
        int(row["id"]): row
        for row in await demo_db.get_demo_list_items(body.demo_ids)
    }
    candidates: list[tuple[int, dict[str, Any], str]] = []
    for demo_id in body.demo_ids:
        row = rows_by_id.get(int(demo_id))
        if not row:
            failed.append({"demo_id": demo_id, "error": "Demo 不存在"})
            continue
        if (row.get("status") or "") != "pending":
            failed.append({"demo_id": demo_id, "error": f"当前状态为 {row.get('status')}，非 pending"})
            continue
        dem_path = str(row["path"])
        if not Path(dem_path).is_file():
            failed.append({"demo_id": demo_id, "filename": row.get("filename", ""), "error": "文件不存在"})
            continue
        candidates.append((int(demo_id), row, dem_path))

    inspect_sem = asyncio.Semaphore(_demo_inspect_concurrency())

    async def _inspect_candidate(
        candidate: tuple[int, dict[str, Any], str],
    ) -> tuple[int, dict[str, Any], str, Optional[list[dict]], Optional[dict], Optional[Exception]]:
        demo_id, row, dem_path = candidate
        try:
            working = await _library_working_demo_path(row)
            async with inspect_sem:
                # Finalize the narrowly classified unfinalized-demo shape (and
                # apply 138/win-panel compatibility patches) before any parser
                # reads the working copy. Normal demos remain byte-identical.
                await asyncio.to_thread(
                    ensure_demo_compatible,
                    working,
                    allow_truncated_packet_tail=True,
                )
                players, meta = await _inspect_demo_meta(working)
            return demo_id, row, dem_path, players, meta, None
        except Exception as exc:  # noqa: BLE001 - report one failed demo without cancelling the batch.
            return demo_id, row, dem_path, None, None, exc

    inspected = await asyncio.gather(*(_inspect_candidate(item) for item in candidates))
    for demo_id, row, dem_path, players, meta, error in inspected:
        if error is not None:
            logger.error(
                "Ingest inspection failed demo_id=%s path=%s: %s",
                demo_id,
                dem_path,
                error,
            )
            failed.append({"demo_id": demo_id, "filename": row.get("filename", ""), "error": str(error)})
            continue
        try:
            if isinstance(meta, dict):
                refined_source = infer_demo_source(Path(dem_path).name, server_name=meta.get("server_name"))
                await demo_db.update_lightweight_meta(dem_path, meta, source=refined_source)
            await index_demo_player_stats(
                demo_id,
                dem_path,
                precomputed_players=players or [],
            )
            await demo_db.update_status(dem_path, "loaded", error_msg=None, parsed_at=utc_now_iso())
            ingested += 1
        except Exception as exc:  # noqa: BLE001
            logger.exception("Ingest persist failed demo_id=%s path=%s", demo_id, dem_path)
            failed.append({"demo_id": demo_id, "filename": row.get("filename", ""), "error": str(exc)})
    if ingested:
        await demo_library_hub.notify("enqueue")
    return {"ingested": ingested, "failed": failed}


class DemoRemarkPatch(BaseModel):
    remark: str = Field(default="", max_length=2000)


@app.patch("/api/demos/{demo_id}/remark")
async def patch_demo_remark(demo_id: int, body: DemoRemarkPatch):
    ok = await demo_db.update_remark(demo_id, body.remark or None)
    if not ok:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    await demo_library_hub.notify("remark")
    return {"status": "ok", "demo_id": demo_id}



# Montage and recorded-clip routes live in app.api.montage.


# Native file and folder dialogs live in app.api.desktop.




# ─── Health ────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {"status": "ok", "version": APP_VERSION}


@app.get("/")
def index():
    if WEB_DIST_DIR is None:
        raise HTTPException(
            status_code=503,
            detail="Web UI not found. Build frontend and provide web/ or frontend/dist.",
        )
    return FileResponse(str(WEB_DIST_DIR / "index.html"))


@app.get("/overlay/{filename:path}")
def serve_kb_overlay(filename: str):
    """直接提供虚拟键盘 Overlay 静态文件，避免被 SPA fallback 拦截。"""
    from fastapi.responses import FileResponse as _FR
    fp = (_overlay_dir / filename).resolve()
    if fp.is_file() and str(fp).startswith(str(_overlay_dir.resolve())):
        return _FR(str(fp))
    raise HTTPException(404, "Not Found")


@app.get("/{path:path}")
def spa_fallback(path: str):
    # API 路径和 overlay 路径保持 404/原路由处理，不进入前端 fallback。
    if path.startswith("api/") or path.startswith("overlay/"):
        raise HTTPException(404, "Not Found")
    if WEB_DIST_DIR is None:
        raise HTTPException(404, "Not Found")

    candidate = (WEB_DIST_DIR / path).resolve()
    if candidate.is_file() and WEB_DIST_DIR in candidate.parents:
        return FileResponse(str(candidate))

    # React/Vite SPA 刷新子路由时回退到 index.html。
    return FileResponse(str(WEB_DIST_DIR / "index.html"))
