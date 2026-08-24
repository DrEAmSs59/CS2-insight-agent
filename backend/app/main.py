"""FastAPI 主入口 — CS2 Insight Agent 后端 API"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import faulthandler

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from .env_utils import (
    load_config,
    resolve_config_path,
    get_data_dir,
)
from .databases import demo_db, lite_cut_db, montage_db
from .demo_watcher import DemoWatcher
from .gsi_ready import (
    cleanup_stale_gsi_configs,
    install_gsi_access_log_filter,
)
from .update_info import resolve_local_version_info
from .runtime_session import runtime_session_state
from .app_state import application_state
from .video_export_log import configure_video_export_logging
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
from .api.demo_replay import router as demo_replay_router
from .api.cosmetics_skin import router as cosmetics_skin_router
from .api.config_backup import router as config_backup_router
from .api.gsi import router as gsi_router
from .recording.api import router as recording_router
from .features.lite_cut.api import router as lite_cut_router
from .features.demo_playback.api import router as demo_playback_router
from .features.demo_library.ingestion import enqueue_demo_path
from .features.demo_library.api import router as demo_library_router
from .features.match_history.api import router as match_history_router
from .features.demo_analysis.api import router as demo_analysis_router


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
    _video_export_log = configure_video_export_logging(_log_dir)
    
    # 将 Uvicorn 的访问日志 (API 请求) 也写入文件
    for _u_logger_name in ("uvicorn", "uvicorn.access"):
        _u_logger = logging.getLogger(_u_logger_name)
        _u_logger.addHandler(_file_handler)
        _u_logger.propagate = False # 避免重复输出到 root logger

    _FAULT_LOG_FILE = (_log_dir / "backend-fault.log").open("w", encoding="utf-8")
    faulthandler.enable(file=_FAULT_LOG_FILE, all_threads=True)
    logging.getLogger(__name__).info("Backend file logging enabled: %s", _backend_log)
    logging.getLogger(__name__).info("Video export logging enabled: %s", _video_export_log)
except Exception:
    logging.getLogger(__name__).exception("Backend file logging setup failed")

@asynccontextmanager
async def lifespan(_: FastAPI):
    """
    仅初始化 DB 与 DemoWatcher 实例（不启动 watchdog Observer，也不做启动时扫描）。

    **为什么不再自动扫描**：watchdog Observer 会在目录出现新 .dem 时立刻触发
    ``enqueue_demo_path``。录制期我们会
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
    from .features.demo_analysis.replay_cache_storage import ensure_replay_cache_owner_index

    async def warm_replay_cache_owner_index() -> None:
        try:
            result = await asyncio.to_thread(ensure_replay_cache_owner_index)
            if result.get("rebuilt"):
                logger.info(
                    "Replay cache owner index warmed: ready=%s errors=%s",
                    result.get("ready"),
                    len(result.get("errors") or []),
                )
        except Exception:
            logger.exception("Replay cache owner index warmup failed")

    replay_cache_index_task = asyncio.create_task(warm_replay_cache_owner_index())
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
        enqueue_demo_path,
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
            await replay_cache_index_task
        except Exception:
            logger.exception("Application shutdown cleanup failed")
        if _FAULT_LOG_FILE and not _FAULT_LOG_FILE.closed:
            _FAULT_LOG_FILE.close()


app = FastAPI(title="CS2 Insight Agent", version=APP_VERSION, lifespan=lifespan)


app.include_router(recording_router)
app.include_router(lite_cut_router)
app.include_router(demo_playback_router)
app.include_router(match_history_router)
app.include_router(demo_library_router)
app.include_router(demo_analysis_router)
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
    expose_headers=[
        "Accept-Ranges",
        "Content-Length",
        "Content-Range",
        "Content-Type",
        "ETag",
        "Last-Modified",
    ],
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
