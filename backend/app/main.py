"""FastAPI 主入口 — CS2 Insight Agent 后端 API"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, Literal, Optional

import faulthandler

from fastapi import Body, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .env_utils import (
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
from .demo_paths import UPLOAD_DIR
from .demo_compat_service import ensure_demo_compatible
from .demo_watcher import DemoWatcher
from .gsi_ready import (
    cleanup_stale_gsi_configs,
    install_gsi_access_log_filter,
)
from .update_info import resolve_local_version_info
from .runtime_session import runtime_session_state
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
from .features.demo_playback.api import router as demo_playback_router
from .features.demo_library.ingestion import enqueue_demo_path, infer_demo_source
from .features.demo_library.roster import (
    get_or_index_demo_roster,
    index_demo_player_stats,
    _roster_rows_for_api,
)
from .features.match_history.api import router as match_history_router
from .features.demo_analysis.inspection import (
    analyze_demo_sync,
    demo_failure_code,
    demo_failure_item,
    demo_inspect_concurrency,
    inspect_demo_meta,
    library_working_demo_path,
    resolve_spectator_for_demo,
    resolve_uploaded_demo_path,
    resolve_uploaded_demo_path_async,
    safe_upload_demo_meta,
)
from .features.demo_analysis.player_matching import (
    match_expected_players_in_roster,
    normalized_expected_parse_players,
)
from .features.demo_analysis.uploads import (
    decode_upload_source_paths,
    save_uploaded_demo,
    upload_source_scope,
    verified_upload_source_path,
)
from .features.demo_analysis.workflows import run_library_demo_analyze
from .api_errors import error_detail


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
        except Exception:
            logger.exception("Application shutdown cleanup failed")
        if _FAULT_LOG_FILE and not _FAULT_LOG_FILE.closed:
            _FAULT_LOG_FILE.close()


app = FastAPI(title="CS2 Insight Agent", version=APP_VERSION, lifespan=lifespan)


app.include_router(recording_router)
app.include_router(lite_cut_router)
app.include_router(demo_playback_router)
app.include_router(match_history_router)
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
    uploaded_md5 = await asyncio.to_thread(save_uploaded_demo, file, dest)
    persistent_path = await asyncio.to_thread(
        verified_upload_source_path,
        source_path,
        dest,
        uploaded_md5,
    )
    compat = await asyncio.to_thread(
        ensure_demo_compatible,
        persistent_path,
        allow_truncated_packet_tail=True,
    )

    players, match_meta, inspection_error = await safe_upload_demo_meta(persistent_path)
    demo_id = await _ensure_analysis_demo_row(persistent_path)
    return {
        "id": demo_id,
        "filename": filename,
        "path": str(persistent_path),
        "uploaded_path": str(dest),
        "source_scope": upload_source_scope(persistent_path, dest),
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
    source_paths = decode_upload_source_paths(source_paths_json, len(files))
    saved: list[tuple[str, Path, Path, Any]] = []
    failed: list[dict] = []
    for file, source_path in zip(files, source_paths):
        filename = Path(str(file.filename or "Demo")).name
        try:
            if not file.filename or not str(file.filename).lower().endswith(".dem"):
                raise ValueError("not a .dem file")
            dest = UPLOAD_DIR / filename
            uploaded_md5 = await asyncio.to_thread(save_uploaded_demo, file, dest)
            persistent_path = await asyncio.to_thread(
                verified_upload_source_path,
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
            failed.append(demo_failure_item(filename, exc, "prepare"))

    inspect_sem = asyncio.Semaphore(demo_inspect_concurrency())

    async def _inspect_one(dest: Path) -> tuple[list[dict], dict]:
        async with inspect_sem:
            return await safe_upload_demo_meta(dest)

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
                "source_scope": upload_source_scope(persistent_path, dest),
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
                demo_failure_item(Path(str(raw_path)).name or str(raw_path), exc, "prepare")
            )

    inspect_sem = asyncio.Semaphore(demo_inspect_concurrency())

    async def _inspect_local(path: Path) -> tuple[list[dict], dict]:
        async with inspect_sem:
            return await safe_upload_demo_meta(path)

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
            analyze_demo_sync,
            str(dem_path),
            req.target_player,
            req.freeze_to_death_rounds,
        )
    except IsolatedParseError as e:
        logger.error("Demo parse failed filename=%s: %s", filename, e)
        raise HTTPException(500, error_detail(demo_failure_code(e, "analysis"))) from e

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
        raise HTTPException(500, error_detail(demo_failure_code(e, "analysis"))) from e

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
        return analyze_demo_sync(path_str, target, req.freeze_to_death_rounds)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        tasks = [loop.run_in_executor(pool, run_one, str(p)) for p in resolved]
        try:
            raw_matches: list[dict] = await asyncio.gather(*tasks)
        except IsolatedParseError as e:
            logger.error("Batch Demo parse failed: %s", e)
            raise HTTPException(500, error_detail(demo_failure_code(e, "analysis"))) from e

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
        exp = normalized_expected_parse_players(cfg)
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
                demo_failure_item(str(did), FileNotFoundError(), "inspection", demo_id=int(did))
            )
            continue
        dem_path = str(row["path"])
        try:
            roster_lookup = await get_or_index_demo_roster(int(did), dem_path)
            if roster_lookup.get("error"):
                raise RuntimeError(str(roster_lookup["error"]))
            matched = match_expected_players_in_roster(exp, roster_lookup["players"])
        except Exception as exc:  # noqa: BLE001
            logger.exception("batch_resolve roster match failed demo_id=%s", did)
            resolved[str(did)] = []
            failed.append(
                demo_failure_item(
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
        await library_working_demo_path(row)
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
                demo_failure_item(
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
    dem_path = await library_working_demo_path(row)
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
    dem_path = await library_working_demo_path(row)
    await asyncio.to_thread(ensure_demo_compatible, dem_path)
    out = await run_library_demo_analyze(
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
    from .features.demo_analysis.replay_cache_storage import remove_demo_row_caches

    # Reclaim parse/replay caches for original + working paths before the
    # demo-cache file is unlinked with the library row.
    cache_removed = await asyncio.to_thread(remove_demo_row_caches, demo)
    ok = await demo_db.delete_demo(demo_id)
    if not ok:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    await demo_library_hub.notify("deleted")
    return {"status": "deleted", "demo_id": demo_id, "replay_cache": cache_removed}


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
    from .features.demo_analysis.replay_cache_storage import remove_demo_row_caches

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

    inspect_sem = asyncio.Semaphore(demo_inspect_concurrency())

    async def _inspect_candidate(
        candidate: tuple[int, dict[str, Any], str],
    ) -> tuple[int, dict[str, Any], str, Optional[list[dict]], Optional[dict], Optional[Exception]]:
        demo_id, row, dem_path = candidate
        try:
            working = await library_working_demo_path(row)
            async with inspect_sem:
                # Finalize the narrowly classified unfinalized-demo shape (and
                # apply 138/win-panel compatibility patches) before any parser
                # reads the working copy. Normal demos remain byte-identical.
                await asyncio.to_thread(
                    ensure_demo_compatible,
                    working,
                    allow_truncated_packet_tail=True,
                )
                players, meta = await inspect_demo_meta(working)
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
