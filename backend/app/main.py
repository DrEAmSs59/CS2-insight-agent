"""FastAPI 主入口 — CS2 Insight Agent 后端 API"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
import zipfile
from datetime import datetime
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, Literal, Optional

import faulthandler

from fastapi import Body, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .env_utils import (
    AppConfig,
    OBSConfig,
    LLMConfig,
    ExperimentalConfig,
    load_config,
    save_config,
    ensure_cs2_path,
    detect_cs2_path,
    detect_ffmpeg_path,
    detect_obs_path,
    minimize_obs_window,
    resolve_config_path,
    llm_api_key_configured,
    llm_base_url_is_local_host,
    get_data_dir,
)
from .demo_db import DemoDB, DemoListFilters, utc_now_iso
from .demo_library_hub import demo_library_hub
from .demo_watcher import DemoWatcher, _demo_ingest_md5_enabled
from .file_hash import file_md5_hex
from .gsi_ready import gsi_status, notify_gsi_payload
from .update_info import build_update_payload, resolve_local_version_info
from .montage_db import MontageDB
from .name_card_meta import (
    build_name_card_tags_and_result,
    resolve_name_card_category,
    resolve_name_card_eyebrow,
)
from . import obs_config_center
from .recording.api import router as recording_router
from .cs2_config_backup import (
    build_config_backup_status_payload,
    is_cs2_running,
    is_restore_required,
    open_backup_directory,
    restore_latest_user_config_backup,
)
import httpx

from .steam_match_history import (
    fetch_match_history,
    fetch_player_summary,
    parse_match_row,
    download_demo,
    game_type_to_mode,
    is_demo_expired,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")

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

DB_PATH = resolve_config_path().parent / "cs2-insight.db"
demo_db = DemoDB(DB_PATH)
montage_db = MontageDB(DB_PATH)
demo_watcher: DemoWatcher | None = None

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
    if await demo_db.is_path_scan_blocked(demo_path):
        logger.debug("Skip enqueue (scan blocklist): %s", demo_path)
        return
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
        )
        if not inserted:
            if can_store_md5:
                try:
                    fill = await asyncio.to_thread(file_md5_hex, path)
                    await demo_db.update_demo_content_md5_if_absent(demo_path, fill, origin_zip)
                except OSError:
                    pass
            return

        # 轻量解析：只提取地图与记分板元数据，避免重量级玩家片段解析。
        try:
            from .demo_parse_isolation import get_demo_match_summary_isolated

            meta = await asyncio.to_thread(get_demo_match_summary_isolated, demo_path)
            if isinstance(meta, dict):
                refined_source = infer_demo_source(path.name, server_name=meta.get("server_name"))
                await demo_db.update_lightweight_meta(demo_path, meta, source=refined_source)
        except Exception:
            logger.exception("Lightweight meta parse failed for %s", demo_path)
        await demo_db.update_status(demo_path, "pending", error_msg=None, parsed_at=None)
        if can_store_md5:
            try:
                fill = md5_hex if md5_hex else await asyncio.to_thread(file_md5_hex, path)
                await demo_db.update_demo_content_md5_if_absent(demo_path, fill, origin_zip)
            except OSError:
                pass
    await demo_library_hub.notify("enqueue")


@asynccontextmanager
async def lifespan(_: FastAPI):
    """
    仅初始化 DB 与 DemoWatcher 实例（不启动 watchdog Observer，也不做启动时扫描）。

    **为什么不再自动扫描**：watchdog Observer 会在目录出现新 .dem 时立刻触发
    ``_enqueue_demo_path``，其中包含 ``get_demo_match_summary`` 的轻量解析。录制期我们会
    ``shutil.copy2`` 一个 ``_insight_<uuid>.dem`` 到 CS2 的 ``csgo/``；若用户的监听目录与
    ``csgo/`` 有重叠（常见：就是把 CS2 的 replay 目录作为监听目录），**每次录制都会在后台触发
    入库与轻量读盘**（记分板元数据等），仍可能与录制争用磁盘；历史上还曾叠加「名单自动深度解析」
    加重负载，故默认不在启动时全量扫描。
    保留 ``DemoWatcher`` 实例只是为 ``POST /api/demos/scan`` 这一条手动扫描接口
    服务；页面上改为用户点"刷新"按钮时主动扫描。
    """
    global demo_watcher
    await demo_db.init_db()
    await montage_db.init_tables()
    cfg = load_config()
    demo_watcher = DemoWatcher(cfg.demo_watch_paths or [], _enqueue_demo_path, demo_db)
    from .pov_hud_manager import try_restore_stale_pov_on_startup

    for _msg in try_restore_stale_pov_on_startup(cfg):
        if _msg:
            logger.info("POV startup: %s", _msg)
    try:
        yield
    finally:
        pass


app = FastAPI(title="CS2 Insight Agent", version="2.0.2", lifespan=lifespan)

app.include_router(recording_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_unhandled_http_errors(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception:
        logger.exception("Unhandled request error: %s %s", request.method, request.url.path)
        raise

UPLOAD_DIR = Path(tempfile.gettempdir()) / "cs2_insight_demos"
UPLOAD_DIR.mkdir(exist_ok=True)

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
    raw = (p or "").strip()
    if not raw:
        raise HTTPException(400, "Demo 路径为空")
    cand = Path(raw)
    if cand.is_file():
        return cand.resolve()
    dest = (UPLOAD_DIR / cand.name).resolve()
    if dest.is_file():
        return dest
    raise HTTPException(404, f"未找到 Demo 文件: {raw}")


def _analyze_demo_sync(
    dem_path: str,
    target_player: str,
    freeze_to_death_rounds: Optional[list[int]] = None,
) -> dict:
    """Parse in a child process so demoparser native crashes cannot kill FastAPI."""
    from .demo_parse_isolation import analyze_demo_isolated

    return analyze_demo_isolated(dem_path, target_player, freeze_to_death_rounds)


async def _safe_upload_demo_meta(dem_path: Path) -> tuple[list[dict], dict]:
    """Best-effort metadata for upload responses; upload must not fail if parsing does."""
    from .demo_parse_isolation import get_demo_match_summary_isolated, get_player_list_isolated

    players: list[dict] = []
    match_meta: dict = {}
    try:
        players = await asyncio.to_thread(get_player_list_isolated, str(dem_path))
    except Exception as e:  # noqa: BLE001
        logger.exception("Upload player-list parse failed for %s: %s", dem_path, e)
    try:
        match_meta = await asyncio.to_thread(get_demo_match_summary_isolated, str(dem_path))
    except Exception as e:  # noqa: BLE001
        logger.exception("Upload summary parse failed for %s: %s", dem_path, e)
    return players, match_meta


# 监听目录按「期望玩家」自动写库展示名时串行，避免大量 demo 同时读盘
def _normalized_expected_parse_players(cfg: AppConfig) -> list[str]:
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
    return "".join((s or "").split()).casefold()


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


def _matched_demo_players_in_order(expected: list[str], dem_path: str) -> list[dict]:
    """按配置名单顺序，在本场 roster 中依次匹配；同一场可命中多名（去重后保留名单顺序）。"""
    from .demo_parse_isolation import get_player_list_isolated

    roster = get_player_list_isolated(str(dem_path))
    if not roster:
        return []
    out: list[dict] = []
    seen_key: set[str] = set()
    for exp in expected:
        row = _match_expected_to_roster_row(exp, roster)
        if row is None:
            continue
        key = _norm_player_key(str(row.get("name") or ""))
        if not key or key in seen_key:
            continue
        seen_key.add(key)
        out.append(row)
    return out



async def _run_library_demo_analyze(
    demo_id: int,
    dem_path: str,
    target_players: list[str],
    freeze_to_death_rounds: Optional[list[int]] = None,
    locale: str = "zh",
) -> dict:
    if not target_players:
        raise HTTPException(400, "target_players 不能为空")
    # 列表筛选 / PlayerSelect 依赖 demo_player_stats；待入库入库失败或旧数据可能缺失，解析前强制补索引
    idx = await index_demo_player_stats(demo_id, dem_path)
    if idx.get("indexed"):
        await demo_library_hub.notify("player_stats")
    elif idx.get("error"):
        logger.warning(
            "index_demo_player_stats before library analyze demo_id=%s: %s",
            demo_id,
            idx.get("error"),
        )
    await demo_db.clear_result(dem_path)
    await demo_db.update_status(dem_path, "parsing", error_msg=None, parsed_at=None)
    players_out: dict = {}
    try:
        from .demo_parse_isolation import IsolatedParseError, analyze_multi_isolated

        batch_result = await asyncio.to_thread(
            analyze_multi_isolated,
            dem_path,
            target_players,
            freeze_to_death_rounds,
        )
        players_out = {p: v for p, v in batch_result.items() if isinstance(v, dict)}
        missing = [p for p in target_players if p not in players_out]
        if missing:
            logger.warning(
                "analyze_multi_isolated missing players demo_id=%s missing=%s",
                demo_id, missing,
            )
    except IsolatedParseError as e:
        msg = f"Demo 解析失败：{e}"
        logger.error("Library demo parse failed demo_id=%s path=%s: %s", demo_id, dem_path, e)
        await demo_db.update_status(dem_path, "error", error_msg=msg, parsed_at=None)
        await demo_library_hub.notify("parse_error")
        raise HTTPException(500, msg) from e

    cfg = load_config()
    if cfg.ai_mode and cfg.llm.api_key:
        from .ai_reviewer import enrich_clips_dicts_with_reviewer

        async def _enrich_library_player(player: str) -> None:
            pdata = players_out.get(player)
            if not isinstance(pdata, dict):
                return
            clips = pdata.get("clips") or []
            meta = pdata.get("match_meta")
            if not clips or not isinstance(meta, dict):
                return
            try:
                pdata["clips"] = await enrich_clips_dicts_with_reviewer(clips, meta, cfg.llm, locale=locale)
            except Exception:
                logger.exception(
                    "AI review failed for library demo_id=%s path=%s player=%s",
                    demo_id,
                    dem_path,
                    player,
                )

        await asyncio.gather(*[_enrich_library_player(p) for p in target_players])

    first_player = target_players[0]
    first_pdata = players_out[first_player]
    players_payload = {p: dict(v) for p, v in players_out.items() if isinstance(v, dict)}
    composite: dict[str, Any] = {
        "players": players_payload,
        "analyzed_target_players": list(target_players),
        "auto_target_player": first_player,
        # 兼容仍读取「顶层 clips / match_meta」的旧逻辑（列表、SSE、部分 UI）
        "clips": first_pdata.get("clips") or [],
        "match_meta": first_pdata.get("match_meta"),
        "timeline": first_pdata.get("timeline"),
        "round_timeline": first_pdata.get("round_timeline"),
    }
    await demo_db.save_result(dem_path, composite)
    for player, pdata in players_out.items():
        if player == first_player:
            continue
        if isinstance(pdata, dict):
            await demo_db.replace_timeline_events(dem_path, player, pdata)
    await demo_db.update_status(dem_path, "done", error_msg=None, parsed_at=utc_now_iso())
    await demo_library_hub.notify("analyzed")
    return {"players": players_out, "demo_path": dem_path}



# ─── Config endpoints ─────────────────────────────────────────

class ExperimentalPayload(BaseModel):
    pov_enabled: Optional[bool] = None


class ConfigPayload(BaseModel):
    obs: Optional[OBSConfig] = None
    llm: Optional[LLMConfig] = None
    ffmpeg_path: Optional[str] = None
    montage_encoder: Optional[str] = None
    cs2_path: Optional[str] = None
    demo_watch_paths: Optional[list[str]] = None
    ai_mode: Optional[bool] = None
    locale: Optional[str] = None
    expected_parse_players: Optional[list[str]] = None
    recording_global_pacing: Optional[dict[str, Any]] = None
    default_record_warmup: Optional[dict[str, Any]] = None
    cs2_extra_launch_args: Optional[str] = None
    cs2_extra_launch_args_user_configured: Optional[bool] = None
    record_inject_console_lines: Optional[str] = None
    record_inject_console_lines_user_configured: Optional[bool] = None
    obs_transition_enabled: Optional[bool] = None
    obs_transition_name: Optional[str] = None
    obs_transition_duration_ms: Optional[int] = None
    kb_overlay_enabled: Optional[bool] = None
    kb_overlay_tick_offset: Optional[int] = None
    kb_overlay_position: Optional[str] = None
    experimental: Optional[ExperimentalPayload] = None
    steam_api_key: Optional[str] = None
    steam_id64: Optional[str] = None
    match_mode: Optional[str] = None
    match_count: Optional[int] = None


class MatchHistoryDownloadBody(BaseModel):
    demo_url: str
    match_id: str
    filename: str  # e.g. "match730_3733386468353335412.dem"


@app.get("/api/config")
def get_config():
    cfg = load_config()
    cfg = ensure_cs2_path(cfg)
    data = cfg.model_dump()
    if data["llm"]["api_key"]:
        data["llm"]["api_key"] = "****" + data["llm"]["api_key"][-4:]
    if data.get("steam_api_key"):
        raw = data["steam_api_key"]
        data["steam_api_key"] = "****" + raw[-4:] if len(raw) >= 4 else "****"
    obs_pw = (data.get("obs") or {}).get("password") or ""
    if obs_pw:
        data.setdefault("obs", {})
        data["obs"]["password"] = "****" + str(obs_pw)[-4:] if len(str(obs_pw)) > 4 else "****"
    return data


@app.get("/api/app/update-info")
def get_app_update_info(force: bool = False):
    """对比 GitHub 最新 Release；force=true 跳过进程内短缓存（手动「检查更新」）。"""
    cur, src = resolve_local_version_info()
    payload = build_update_payload(cur, src, force_refresh=bool(force))
    # 保存检查时间到配置
    if payload.get("checked_at"):
        try:
            cfg = load_config()
            cfg.last_update_check_at = payload["checked_at"]
            save_config(cfg)
        except Exception:
            pass
    return payload


@app.post("/api/config/detect-encoder")
async def detect_encoder():
    """检测当前 FFmpeg 支持哪些 H.264 编码器，返回自动选择结果与各硬件编码器探测详情。"""
    from .montage_encoder import diagnose_encoders
    from .video_composer import MontageComposerError, resolve_ffmpeg_binary

    cfg = load_config()
    try:
        ffmpeg_bin = resolve_ffmpeg_binary(cfg.ffmpeg_path)
    except MontageComposerError as e:
        raise HTTPException(400, str(e)) from e
    result = await asyncio.to_thread(diagnose_encoders, ffmpeg_bin)
    result["ffmpeg_path"] = str(ffmpeg_bin)
    return result


@app.post("/api/config/detect-cs2")
def detect_cs2_save():
    """扫描本机 Steam 库并写入 cs2-insight.config.json 中的 cs2_path。"""
    path = detect_cs2_path()
    if not path:
        raise HTTPException(
            404,
            "未找到 CS2（cs2.exe）。请确认已安装游戏，或在侧栏手动填写 cs2.exe 的完整路径。",
        )
    cfg = load_config()
    cfg.cs2_path = path
    save_config(cfg)
    return {"cs2_path": path}


@app.post("/api/config/detect-ffmpeg")
def detect_ffmpeg_save():
    """扫描本机常见位置并写入 cs2-insight.config.json 中的 ffmpeg_path。"""
    path = detect_ffmpeg_path()
    if not path:
        raise HTTPException(
            404,
            "未找到 FFmpeg（ffmpeg.exe）。请安装 FFmpeg 并确保其在系统 PATH 中，或在设置中手动填写完整路径。",
        )
    cfg = load_config()
    cfg.ffmpeg_path = path
    save_config(cfg)
    return {"ffmpeg_path": path}


@app.post("/api/config/open-dir")
def open_config_data_dir():
    """在资源管理器中打开主配置文件所在目录（含 cs2-insight.config.json）。"""
    path = resolve_config_path()
    folder = str(path.parent.resolve())
    try:
        if sys.platform == "win32":
            os.startfile(folder)  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.run(["open", folder], check=False, timeout=30)
        else:
            subprocess.run(["xdg-open", folder], check=False, timeout=30)
        return {"ok": True, "path": folder}
    except Exception as e:  # noqa: BLE001
        logging.warning("open config dir failed: %s", e)
        return {"ok": False, "path": folder, "message": "无法自动打开目录，请手动复制路径。"}


def _get_dir_size(path: Path) -> int:
    """计算文件夹总大小（字节）。"""
    if not path.is_dir():
        return 0
    total = 0
    try:
        for entry in path.rglob("*"):
            if entry.is_file():
                try:
                    total += entry.stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


def _format_size(bytes: int) -> str:
    """格式化字节大小为人类可读字符串。"""
    if bytes < 1024:
        return f"{bytes} B"
    elif bytes < 1024 * 1024:
        return f"{bytes / 1024:.1f} KB"
    elif bytes < 1024 * 1024 * 1024:
        return f"{bytes / (1024 * 1024):.1f} MB"
    else:
        return f"{bytes / (1024 * 1024 * 1024):.2f} GB"


@app.get("/api/config/data-dir-info")
def get_data_dir_info():
    """返回数据目录路径和大小信息。"""
    data_dir = get_data_dir()
    size_bytes = _get_dir_size(data_dir)
    size_str = _format_size(size_bytes)
    return {
        "path": str(data_dir.resolve()),
        "exists": data_dir.exists(),
        "size_bytes": size_bytes,
        "size_str": size_str,
    }


@app.post("/api/config/detect-obs")
def detect_obs_path_save():
    """扫描常见安装路径并写入 cs2-insight.config.json 中的 obs.obs_path。"""
    path = detect_obs_path()
    if not path:
        raise HTTPException(
            404,
            "未找到 OBS（obs64.exe）。请确认已安装 OBS，或在 OBS 配置中心手动填写完整路径。",
        )
    cfg = load_config()
    cfg.obs.obs_path = path
    save_config(cfg)
    return {"obs_path": path}


@app.post("/api/config/test-llm")
async def test_llm_connection():
    """轻量探测当前大模型配置是否可用（本地 HTTP 或云端一次极短补全）。"""
    cfg = load_config()
    llm = cfg.llm
    bu_raw = (llm.base_url or "").strip()
    if bu_raw and llm_base_url_is_local_host(bu_raw):
        root = bu_raw.rstrip("/").removesuffix("/v1").rstrip("/")
        probe_urls = []
        for u in (f"{root}/api/tags", f"{root}/v1/models"):
            if u not in probe_urls:
                probe_urls.append(u)

        def _ping_one(url: str) -> tuple[bool, str]:
            import urllib.error
            import urllib.request

            try:
                req = urllib.request.Request(url, headers={"Accept": "application/json"})  # noqa: S310
                with urllib.request.urlopen(req, timeout=4.0) as r:  # noqa: S310
                    return True, f"HTTP {r.getcode()} {url}"
            except urllib.error.HTTPError as e:
                return False, f"HTTP {e.code} {url}"
            except Exception as ex:  # noqa: BLE001
                return False, str(ex)[:200]

        def _ping_local() -> tuple[bool, str]:
            last_err = "无可用探测 URL"
            for url in probe_urls:
                ok, detail = _ping_one(url)
                if ok:
                    return True, detail
                last_err = detail
            return False, last_err

        ok, detail = await asyncio.to_thread(_ping_local)
        return {"ok": ok, "detail": detail if ok else detail}

    api_key = (llm.api_key or "").strip()
    if not llm_api_key_configured(llm.api_key):
        return {"ok": False, "detail": "请填写 API 密钥并保存后再测试。"}
    if api_key.startswith("****"):
        return {
            "ok": False,
            "detail": "配置文件中的密钥为脱敏占位（****…），请在设置中重新粘贴完整 API 密钥并保存后再测试。",
        }

    from openai import APIConnectionError, APIError, APITimeoutError, AsyncOpenAI, RateLimitError

    bu = (llm.base_url or "").strip() or None
    model = (llm.model or "").strip() or "gpt-4o-mini"
    try:
        client = AsyncOpenAI(api_key=api_key, base_url=bu, timeout=12.0)
        resp = await asyncio.wait_for(
            client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": "ping"}],
                max_tokens=2,
            ),
            timeout=18.0,
        )
        ok = bool(resp.choices)
        return {"ok": ok, "detail": "连接成功" if ok else "未收到模型输出"}
    except asyncio.TimeoutError:
        return {"ok": False, "detail": "请求超时"}
    except (APIConnectionError, APITimeoutError, RateLimitError, APIError) as e:
        return {"ok": False, "detail": str(e)[:300]}
    except Exception as e:  # noqa: BLE001
        logging.warning("test_llm: %s", e)
        return {"ok": False, "detail": str(e)[:300]}


@app.put("/api/config")
async def update_config(payload: ConfigPayload):
    global demo_watcher
    cfg = load_config()
    if payload.obs:
        o = payload.obs
        cfg.obs.host = o.host
        try:
            cfg.obs.port = int(o.port)
        except (TypeError, ValueError):
            cfg.obs.port = o.port if isinstance(o.port, int) else cfg.obs.port
        raw_pw = (o.password or "").strip()
        if raw_pw.startswith("****"):
            pass
        elif raw_pw:
            cfg.obs.password = raw_pw
        # 空字符串：GET 脱敏后输入框为空或未提交密码，不覆盖已保存的密码
        if o.obs_path is not None:
            cfg.obs.obs_path = str(o.obs_path).strip()
    if payload.llm:
        if payload.llm.api_key and not payload.llm.api_key.startswith("****"):
            cfg.llm = payload.llm
        else:
            cfg.llm.provider = payload.llm.provider
            cfg.llm.model = payload.llm.model
            if payload.llm.base_url is not None:
                cfg.llm.base_url = payload.llm.base_url
    if payload.cs2_path is not None:
        cfg.cs2_path = payload.cs2_path
    if payload.demo_watch_paths is not None:
        cfg.demo_watch_paths = [str(Path(p).expanduser()) for p in payload.demo_watch_paths if str(p).strip()]
    if payload.ai_mode is not None:
        cfg.ai_mode = payload.ai_mode
    if payload.locale is not None and payload.locale in ("zh", "en"):
        cfg.locale = payload.locale
    if payload.expected_parse_players is not None:
        cleaned: list[str] = []
        for x in payload.expected_parse_players:
            if not isinstance(x, str):
                continue
            s = x.strip()
            if s and s not in cleaned:
                cleaned.append(s)
            if len(cleaned) >= 50:
                break
        cfg.expected_parse_players = cleaned
    if payload.ffmpeg_path is not None:
        cfg.ffmpeg_path = str(payload.ffmpeg_path).strip()
    if payload.montage_encoder is not None:
        cfg.montage_encoder = str(payload.montage_encoder).strip().lower() or "auto"
    if payload.recording_global_pacing is not None:
        cfg.recording_global_pacing = (
            dict(payload.recording_global_pacing)
            if isinstance(payload.recording_global_pacing, dict)
            else {}
        )
    if payload.default_record_warmup is not None:
        cfg.default_record_warmup = (
            dict(payload.default_record_warmup)
            if isinstance(payload.default_record_warmup, dict)
            else {}
        )
    if payload.cs2_extra_launch_args is not None:
        next_launch_args = str(payload.cs2_extra_launch_args)
        if payload.cs2_extra_launch_args_user_configured is not None:
            cfg.cs2_extra_launch_args = next_launch_args
            cfg.cs2_extra_launch_args_user_configured = bool(payload.cs2_extra_launch_args_user_configured)
        elif next_launch_args != cfg.cs2_extra_launch_args:
            cfg.cs2_extra_launch_args = next_launch_args
            cfg.cs2_extra_launch_args_user_configured = True
    elif payload.cs2_extra_launch_args_user_configured is not None:
        cfg.cs2_extra_launch_args_user_configured = bool(payload.cs2_extra_launch_args_user_configured)
    if payload.record_inject_console_lines is not None:
        next_inject_lines = str(payload.record_inject_console_lines)
        if payload.record_inject_console_lines_user_configured is not None:
            cfg.record_inject_console_lines = next_inject_lines
            cfg.record_inject_console_lines_user_configured = bool(
                payload.record_inject_console_lines_user_configured
            )
        elif next_inject_lines != cfg.record_inject_console_lines:
            cfg.record_inject_console_lines = next_inject_lines
            cfg.record_inject_console_lines_user_configured = True
    elif payload.record_inject_console_lines_user_configured is not None:
        cfg.record_inject_console_lines_user_configured = bool(
            payload.record_inject_console_lines_user_configured
        )
    if payload.obs_transition_enabled is not None:
        cfg.obs_transition_enabled = bool(payload.obs_transition_enabled)
    if payload.obs_transition_name is not None:
        name = str(payload.obs_transition_name).strip()
        cfg.obs_transition_name = name or "Fade"
    if payload.obs_transition_duration_ms is not None:
        try:
            cfg.obs_transition_duration_ms = max(0, int(payload.obs_transition_duration_ms))
        except (TypeError, ValueError):
            pass
    if payload.kb_overlay_enabled is not None:
        cfg.kb_overlay_enabled = bool(payload.kb_overlay_enabled)
    if payload.kb_overlay_tick_offset is not None:
        try:
            cfg.kb_overlay_tick_offset = int(payload.kb_overlay_tick_offset)
        except (TypeError, ValueError):
            pass
    if payload.kb_overlay_position is not None:
        if str(payload.kb_overlay_position) in ("bottom_center", "minimap_below", "weapon_right"):
            cfg.kb_overlay_position = str(payload.kb_overlay_position)
    if payload.experimental is not None:
        if payload.experimental.pov_enabled is not None:
            cfg.experimental.pov_enabled = bool(payload.experimental.pov_enabled)
    if payload.steam_api_key is not None and payload.steam_api_key and not payload.steam_api_key.startswith("****"):
        cfg.steam_api_key = payload.steam_api_key.strip()
    if payload.steam_id64 is not None and payload.steam_id64:
        cfg.steam_id64 = payload.steam_id64.strip()
    if payload.match_mode is not None and payload.match_mode in ("premier", "competitive"):
        cfg.match_mode = payload.match_mode
    if payload.match_count is not None and payload.match_count in (20, 50, 100):
        cfg.match_count = payload.match_count
    save_config(cfg)
    if demo_watcher is not None and payload.demo_watch_paths is not None:
        # 只更新路径配置（供后续 /api/demos/scan 手动扫描使用）；
        # 不再 restart watchdog、也不再自动 scan_existing，避免配置保存瞬间触发
        # 大量重型解析抢占 CS2 录制时的系统资源。
        demo_watcher._paths = list(cfg.demo_watch_paths or [])
    return {"status": "ok"}


@app.get("/api/experimental/pov/status")
def experimental_pov_status():
    from .pov_hud_manager import PovHudError, PovHudManager

    cfg = load_config()
    cfg = ensure_cs2_path(cfg)
    try:
        mgr = PovHudManager(cfg)
        st = mgr.status()
    except PovHudError as e:
        raise HTTPException(400, str(e)) from e
    st["enabled"] = bool(cfg.experimental.pov_enabled)
    return st


@app.post("/api/experimental/pov/restore")
def experimental_pov_restore():
    from .pov_hud_manager import PovHudError, PovHudManager

    cfg = load_config()
    cfg = ensure_cs2_path(cfg)
    try:
        mgr = PovHudManager(cfg)
        mgr.restore()
    except PovHudError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True, "message": "POV HUD 修改已恢复"}


def merge_obs_for_connection(payload: Optional[OBSConfig], saved: OBSConfig) -> OBSConfig:
    """
    将请求体中的 OBS 与已保存配置合并，供 WebSocket 连接（测试 / 录制）使用。
    前端常附带 host/port 且 password 留空（表示沿用服务器已保存密码）；若整段省略则完全使用 saved。
    """
    if payload is None:
        return saved
    host = (payload.host or "").strip() or saved.host
    try:
        port = int(payload.port)
    except (TypeError, ValueError):
        port = int(saved.port) if isinstance(saved.port, int) else saved.port
    raw_pw = (payload.password or "").strip()
    if raw_pw.startswith("****"):
        raw_pw = ""
    password = raw_pw if raw_pw else saved.password
    return OBSConfig(host=host, port=port, password=password)


def _normalize_obs_path_auto_detect(cfg: AppConfig) -> None:
    """OBS 验证成功后：若 obs_path 为空，尝试自动探测并写入配置。"""
    if cfg.obs.obs_path and Path(cfg.obs.obs_path).is_file():
        return
    detected = detect_obs_path()
    if detected:
        cfg.obs.obs_path = detected


# ─── Setup status endpoint ─────────────────────────────────────

def _setup_status_obs_handshake_timeout_sec() -> float:
    """新手引导 ``/api/status/setup`` 中 OBS 行探测用的握手超时（秒），过短易误判，过长会拖住整页。"""
    raw = (os.environ.get("CS2_INSIGHT_SETUP_OBS_PROBE_SEC") or "").strip()
    if raw:
        try:
            return max(0.5, min(float(raw), 60.0))
        except ValueError:
            pass
    return 4.0


@app.get("/api/config/quick-check")
def config_quick_check():
    """轻量配置核查：返回各项配置是否已检测通过（OBS 为 obs_config_verified 标记，
    CS2 路径为实际文件存在性）。**不尝试连接 OBS**。
    供首页引导页、录制队列页状态展示使用，避免 /api/status/setup 的 WebSocket 开销。
    """
    cfg = load_config()
    cfg = ensure_cs2_path(cfg)

    cs2_path_ok = bool(cfg.cs2_path and Path(cfg.cs2_path).is_file())

    ffmpeg_ok = False
    if cfg.ffmpeg_path:
        ffmpeg_ok = Path(cfg.ffmpeg_path).is_file()
    else:
        ffmpeg_ok = shutil.which("ffmpeg") is not None

    ai_key_ok = llm_api_key_configured(cfg.llm.api_key) or llm_base_url_is_local_host(
        cfg.llm.base_url
    )

    try:
        port_val = int(cfg.obs.port) if cfg.obs.port is not None else 0
    except (TypeError, ValueError):
        port_val = 0
    return {
        "obs_configured": cfg.obs.obs_config_verified,
        "cs2_path_ok": cs2_path_ok,
        "ffmpeg_ok": ffmpeg_ok,
        "ai_key_ok": ai_key_ok,
        "cs2_path": cfg.cs2_path or "",
        "ffmpeg_path": cfg.ffmpeg_path or "",
    }


@app.get("/api/config/ffmpeg-check")
def ffmpeg_montage_gate_check():
    """合辑工作台门控：须配置 ffmpeg_path，且与合辑导出相同的解析逻辑可找到可执行文件。"""
    from .video_composer import MontageComposerError, resolve_ffmpeg_binary

    cfg = load_config()
    raw = (cfg.ffmpeg_path or "").strip()
    if not raw:
        return {"ok": False, "reason": "not_configured", "ffmpeg_path": ""}
    if not Path(raw).is_file():
        return {"ok": False, "reason": "path_not_found", "ffmpeg_path": raw}
    try:
        resolved = resolve_ffmpeg_binary(raw)
        return {"ok": True, "ffmpeg_path": str(resolved)}
    except MontageComposerError:
        return {"ok": False, "reason": "not_usable", "ffmpeg_path": raw}


@app.get("/api/status/setup")
def setup_status():
    """快速核查四项配置是否就绪，供录制启动前调用（含 OBS 真实连接检测）。"""
    from .video_composer import MontageComposerError, resolve_ffmpeg_binary

    cfg = load_config()
    cfg = ensure_cs2_path(cfg)

    # 本地项先算好（不依赖网络），OBS 失败时也能立刻返回其余状态
    cs2_path_ok = bool(cfg.cs2_path and Path(cfg.cs2_path).is_file())

    # 与 video_composer.resolve_ffmpeg_binary 一致：配置路径 → 安装目录 third_party/ffmpeg → PATH
    ffmpeg_ok = False
    try:
        resolve_ffmpeg_binary(cfg.ffmpeg_path or None)
        ffmpeg_ok = True
    except MontageComposerError:
        ffmpeg_ok = False

    ai_key_ok = llm_api_key_configured(cfg.llm.api_key) or llm_base_url_is_local_host(
        cfg.llm.base_url
    )

    obs_connected = False
    try:
        from .obs_director import OBSDirector

        director = OBSDirector(
            cfg.obs,
            cfg.cs2_path,
            cs2_extra_launch_args=cfg.cs2_extra_launch_args,
            record_inject_console_lines=cfg.record_inject_console_lines,
        )
        probe_timeout = _setup_status_obs_handshake_timeout_sec()
        result = director.test_obs_connection(handshake_timeout_sec=probe_timeout)
        obs_connected = bool(result.get("ok", False))

        # OBS 验证成功后自动写入配置文件，标记为已验证
        if obs_connected:
            _normalize_obs_path_auto_detect(cfg)
            cfg.obs.obs_config_verified = True
            save_config(cfg)
    except Exception:
        obs_connected = False

    return {
        "obs_connected": obs_connected,
        "cs2_path_ok": cs2_path_ok,
        "ffmpeg_ok": ffmpeg_ok,
        "ai_key_ok": ai_key_ok,
        "cs2_path": cfg.cs2_path or "",
        "ffmpeg_path": cfg.ffmpeg_path or "",
    }


# ─── OBS endpoints ─────────────────────────────────────────────

@app.post("/api/obs/config-check")
def obs_config_check(payload: OBSConfig | None = Body(default=None)):
    """配置检查：先测路径（拉起 OBS），再测连接。"""
    import time as _time

    cfg = load_config()
    obs_use = merge_obs_for_connection(payload, cfg.obs)

    path_ok = False
    launched_obs = False
    connected = False
    obs_version = None

    obs_path = (obs_use.obs_path or cfg.obs.obs_path or "").strip()
    logger.info("[OBS config-check] obs_path=%r", obs_path)

    if obs_path and Path(obs_path).is_file():
        with _obs_launch_lock:
            # 双重检查：第一个请求可能已经拉起了 OBS
            running = _is_obs_process_running(obs_path)
            logger.info("[OBS config-check] Path OK, OBS already running=%s", running)
            if not running:
                logger.info("[OBS config-check] Launching OBS: %s", obs_path)
                try:
                    subprocess.Popen([obs_path], cwd=str(Path(obs_path).parent))
                    launched_obs = True
                    path_ok = True
                    # 轮询等待 OBS 进程出现，最多 15 秒
                    for _attempt in range(30):
                        if _is_obs_process_running(obs_path):
                            break
                        _time.sleep(0.5)
                    else:
                        logger.warning("[OBS config-check] OBS did not appear after 15s; continuing anyway")
                    _time.sleep(1)
                except Exception as e:
                    logger.error("[OBS config-check] Failed to launch OBS: %s", e)
                    return {"path_ok": False, "error": f"无法启动 OBS: {e}"}
            else:
                path_ok = True
    elif obs_path:
        logger.warning("[OBS config-check] Path configured but file not found: %s", obs_path)
        return {"path_ok": False, "error": "OBS 路径不存在"}
    else:
        logger.info("[OBS config-check] No obs_path configured, skipping launch")
        return {"path_ok": False, "connected": False, "error": "请先配置 OBS 路径，再点击配置检查"}

    # 2) 测试 WebSocket 连接 — 15s 内每 1s 重试一次
    try:
        from .obs_director import OBSDirector
        director = OBSDirector(obs_use, cfg.cs2_path)

        connected = False
        for _attempt in range(15):
            result = director.test_obs_connection()
            if result.get("ok"):
                connected = True
                break
            _time.sleep(1)
        else:
            logger.warning("[OBS config-check] WebSocket connection failed after 15 retries")

        if connected:
            _normalize_obs_path_auto_detect(cfg)
            cfg.obs.obs_config_verified = True
            save_config(cfg)
    except Exception as e:
        logger.warning("[OBS config-check] OBS connection test exception: %s", e)
        connected = False

    # 连接成功后最小化 OBS 窗口（放在 try 外确保执行）
    if connected:
        minimize_obs_window()

    return {
        "path_ok": path_ok,
        "connected": connected,
        "launched_obs": launched_obs,
    }


def _is_obs_process_running(obs_path: str) -> bool:
    """检查 OBS 进程是否已在运行（Windows 上按可执行文件名匹配）。"""
    import subprocess as _sp
    try:
        exe_name = Path(obs_path).name
        result = _sp.run(
            ["tasklist", "/FI", f"IMAGENAME eq {exe_name}", "/NH", "/FO", "CSV"],
            capture_output=True, text=True, timeout=10,
        )
        return exe_name.lower() in result.stdout.lower()
    except Exception:
        return False


@app.post("/api/obs/is-running")
def obs_is_running():
    """检查 OBS 进程是否在运行（不尝试连接 WebSocket）。"""
    cfg = load_config()
    obs_path = (cfg.obs.obs_path or "").strip()
    running = _is_obs_process_running(obs_path) if obs_path else False
    return {"running": running, "obs_path": obs_path}


@app.post("/api/obs/launch")
def obs_launch():
    """拉起 OBS 进程（不等待 WebSocket）。"""
    import time as _t
    cfg = load_config()
    obs_path = (cfg.obs.obs_path or "").strip()
    if not obs_path or not Path(obs_path).is_file():
        raise HTTPException(400, "OBS 路径未配置或文件不存在")
    try:
        subprocess.Popen([obs_path], cwd=str(Path(obs_path).parent))
        _t.sleep(2)
    except Exception as e:
        raise HTTPException(400, f"无法启动 OBS: {e}")
    return {"ok": True}


@app.get("/api/obs-config/status")
def obs_config_status():
    cfg = load_config()
    return obs_config_center.get_status_payload(cfg.obs)


@app.post("/api/obs-config/diagnose")
def obs_config_diagnose(payload: Optional[OBSConfig] = Body(default=None)):
    cfg = load_config()
    obs_use = merge_obs_for_connection(payload, cfg.obs)
    return obs_config_center.diagnose(obs_use)


@app.post("/api/obs-config/calibrate")
def obs_config_calibrate():
    cfg = load_config()
    try:
        return obs_config_center.calibrate(cfg.obs)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/obs-config/backups")
def obs_config_backups_list():
    return {"ok": True, "items": obs_config_center.list_backups()}


@app.post("/api/obs-config/backups/{backup_id}/restore")
def obs_config_restore_backup(backup_id: str, payload: Optional[OBSConfig] = Body(default=None)):
    cfg = load_config()
    obs_use = merge_obs_for_connection(payload, cfg.obs)
    try:
        return obs_config_center.restore_backup(backup_id, obs_use)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.delete("/api/obs-config/backups/{backup_id}")
def obs_config_delete_backup(backup_id: str):
    try:
        return obs_config_center.delete_backup(backup_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/obs-config/backups/open-folder")
def obs_config_open_backup_folder():
    return obs_config_center.open_backup_folder()


# ─── Demo parsing endpoints ───────────────────────────────────

class ParseRequest(BaseModel):
    target_player: str
    freeze_to_death_rounds: Optional[list[int]] = None
    locale: str = "zh"


@app.post("/api/demo/upload")
async def upload_demo(file: UploadFile = File(...)):
    if not file.filename or not file.filename.endswith(".dem"):
        raise HTTPException(400, "Only .dem files are accepted")

    dest = UPLOAD_DIR / file.filename
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    players, match_meta = await _safe_upload_demo_meta(dest)
    return {
        "filename": file.filename,
        "path": str(dest),
        "players": players,
        "match_meta": match_meta,
    }


@app.post("/api/demo/upload-multiple")
async def upload_demos(files: Annotated[list[UploadFile], File()]):
    """一次上传多个 .dem，返回与单文件 upload 相同结构的数组。"""
    if not files:
        raise HTTPException(400, "请至少选择一个文件")
    out: list[dict] = []
    for file in files:
        if not file.filename or not str(file.filename).lower().endswith(".dem"):
            raise HTTPException(400, f"仅接受 .dem 文件: {file.filename!r}")
        dest = UPLOAD_DIR / file.filename
        with dest.open("wb") as f:
            shutil.copyfileobj(file.file, f)
        players, match_meta = await _safe_upload_demo_meta(dest)
        out.append(
            {
                "filename": file.filename,
                "path": str(dest),
                "players": players,
                "match_meta": match_meta,
            },
        )
    return {"uploads": out}


@app.post("/api/demo/parse")
async def parse_demo(req: ParseRequest, filename: str):
    from .demo_parse_isolation import IsolatedParseError

    dem_path = UPLOAD_DIR / filename
    if not dem_path.exists():
        raise HTTPException(404, f"Demo file not found: {filename}")

    try:
        result = await asyncio.to_thread(
            _analyze_demo_sync,
            str(dem_path),
            req.target_player,
            req.freeze_to_death_rounds,
        )
    except IsolatedParseError as e:
        raise HTTPException(500, f"Demo 解析失败：{e}") from e

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
async def parse_demo_multi(req: ParseMultiRequest, filename: str):
    """多玩家解析：对同一个 Demo 依次分析每个目标玩家，返回 { players: { name: result } }。"""
    from .demo_parse_isolation import IsolatedParseError

    dem_path = UPLOAD_DIR / filename
    if not dem_path.exists():
        raise HTTPException(status_code=404, detail=f"Demo file not found: {filename}")

    cfg = load_config()

    results_by_player: dict = {}
    try:
        for player in req.target_players:
            results_by_player[player] = await asyncio.to_thread(
                _analyze_demo_sync,
                str(dem_path),
                player,
                req.freeze_to_death_rounds,
            )
    except IsolatedParseError as e:
        raise HTTPException(500, f"Demo 解析失败：{e}") from e

    if cfg.ai_mode and cfg.llm.api_key:
        from .ai_reviewer import enrich_clips_dicts_with_reviewer

        async def _review(player: str, result) -> None:
            try:
                result["clips"] = await enrich_clips_dicts_with_reviewer(
                    result.get("clips") or [],
                    result.get("match_meta") or {},
                    cfg.llm,
                    locale=req.locale,
                )
            except Exception as e:
                logging.error("AI review failed for %s: %s", player, e)

        await asyncio.gather(*[_review(p, r) for p, r in results_by_player.items()])

    return {
        "players": results_by_player
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
        resolved.append(resolve_uploaded_demo_path(p))

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
            raise HTTPException(500, f"Demo 解析失败：{e}") from e

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
        if min_kills is not None:
            f["min_kills"] = min_kills
        if max_deaths is not None:
            f["max_deaths"] = max_deaths
        if min_assists is not None:
            f["min_assists"] = min_assists
        if min_kd is not None:
            f["min_kd"] = min_kd
    return f


async def index_demo_player_stats(demo_id: int, demo_path: str) -> dict[str, Any]:
    from .demo_parse_isolation import get_player_list_isolated

    try:
        raw = await asyncio.to_thread(get_player_list_isolated, demo_path)
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
        return {"indexed": True, "player_count": len(players), "error": None}
    except Exception as exc:
        logger.warning("Failed to index player stats for demo %s: %s", demo_id, exc)
        return {"indexed": False, "player_count": 0, "error": str(exc)}


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
    )
    total = await demo_db.count_demos(name_query=qn, filters=filters or None)
    rows = await demo_db.list_demos(limit=limit, offset=offset, name_query=qn, filters=filters or None)
    return {"items": rows, "limit": limit, "offset": offset, "total": total, "q": qn}


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
        raw_matches = await fetch_match_history(cfg.steam_api_key, cfg.steam_id64, cfg.match_count)
        player = await fetch_player_summary(cfg.steam_api_key, cfg.steam_id64)
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
    rows = []
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
        # check if already in library
        dem_name = f"match730_{row['match_id']}.dem"
        in_lib = await demo_db.find_by_filename(dem_name) is not None
        row["demo_in_library"] = in_lib
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


@app.post("/api/match-history/download")
async def download_match_demo(body: MatchHistoryDownloadBody):
    cfg = load_config()
    watch_paths = [p for p in cfg.demo_watch_paths if p.strip()]
    if not watch_paths:
        raise HTTPException(400, "未配置 Demo 库监听目录，请先在「Demo 库」设置监听路径")

    dest_dir = Path(watch_paths[0])
    filename = body.filename if body.filename.endswith(".dem") else body.filename + ".dem"
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
    total = await demo_db.count_discovered_demos(name_query=qn)
    rows = await demo_db.list_discovered_demos(limit=limit, offset=offset, name_query=qn)
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
        return {"resolved": {str(i): [] for i in body.demo_ids}}
    if body.mode == "config_expected":
        cfg = load_config()
        exp = _normalized_expected_parse_players(cfg)
        if not exp:
            return {"resolved": {str(i): [] for i in body.demo_ids}}
    elif body.mode == "manual":
        exp = [s.strip() for s in (body.manual_lines or []) if isinstance(s, str) and s.strip()]
    else:
        exp = []
    resolved: dict[str, list[str]] = {}
    for did in body.demo_ids:
        row = await demo_db.get_demo_by_id(int(did))
        if not row:
            resolved[str(did)] = []
            continue
        dem_path = str(row["path"])
        try:
            matched = await asyncio.to_thread(_matched_demo_players_in_order, exp, dem_path)
        except Exception:
            logger.exception("batch_resolve roster match failed demo_id=%s", did)
            resolved[str(did)] = []
            continue
        names = [str(r.get("name") or "").strip() for r in matched if r.get("name")]
        resolved[str(did)] = names
    return {"resolved": resolved}


@app.post("/api/demos/batch-summary")
async def batch_demo_summary(body: BatchSummaryBody):
    """批量加载 Demo 元数据 + 玩家列表，并发数上限 5。任一失败返回 400。"""
    from .demo_parse_isolation import get_player_list_isolated

    sem = asyncio.Semaphore(5)

    async def fetch_one(demo_id: int) -> dict:
        row = await demo_db.get_demo_list_item(demo_id)
        if not row:
            raise ValueError(f"Demo {demo_id} 不存在")
        row = dict(row)
        dem_path = row.get("path", "")
        async with sem:
            players = await asyncio.to_thread(get_player_list_isolated, dem_path)
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
            try:
                row = await demo_db.get_demo_list_item(did)
                fname = (row.get("display_name") and str(row["display_name"]).strip()) or row.get("filename") or str(did)
            except Exception:
                fname = str(did)
            errors.append({"id": did, "filename": fname, "reason": str(res)})
        else:
            items.append(res)

    if errors:
        raise HTTPException(
            status_code=400,
            detail={"message": "部分 Demo 加载失败", "failed": errors},
        )

    return {"items": items}


class DemoDisplayNamePatch(BaseModel):
    """仅更新库内展示名，不修改磁盘文件；空串表示清除展示名（界面回退为 ``filename``）。"""

    display_name: str = Field(default="", max_length=512)


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
    if demo_watcher is None:
        return {"scanned": 0, "player_stats_index": None, "discovered_count": 0}
    scanned = await demo_watcher.scan_existing()
    logger.info("POST /api/demos/scan: scan_existing finished scanned=%s", scanned)
    try:
        discovered_count = await demo_db.count_discovered_demos()
    except Exception:
        logger.exception("count discovered demos after scan failed")
        discovered_count = 0
    return {"scanned": scanned, "player_stats_index": None, "discovered_count": discovered_count}


@app.post("/api/demos/{demo_id}/parse")
async def reparse_demo(demo_id: int):
    row = await demo_db.get_demo_by_id(demo_id)
    if not row:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    await demo_db.clear_result(row["path"])
    await demo_db.update_status(row["path"], "loaded", error_msg=None, parsed_at=None)
    await demo_library_hub.notify("reparse")
    return {"status": "loaded", "demo_id": demo_id}


class DemoAnalyzeRequest(BaseModel):
    target_players: list[str] = Field(..., min_length=1)
    freeze_to_death_rounds: Optional[list[int]] = None
    locale: str = "zh"


@app.get("/api/demos/{demo_id}/players")
async def get_demo_players(demo_id: int):
    from .demo_parse_isolation import get_player_list_isolated

    row = await demo_db.get_demo_by_id(demo_id)
    if not row:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    dem_path = row["path"]
    match_meta = {
        "map_name": row.get("map_name"),
        "total_rounds": row.get("total_rounds"),
        "team_a_score": row.get("team_a_score"),
        "team_b_score": row.get("team_b_score"),
        "duration_mins": row.get("duration_mins"),
        "match_date": row.get("match_date"),
    }
    return {
        "players": await asyncio.to_thread(get_player_list_isolated, dem_path),
        "match_meta": match_meta,
    }


@app.post("/api/demos/{demo_id}/analyze")
async def analyze_demo_from_library(demo_id: int, req: DemoAnalyzeRequest):
    row = await demo_db.get_demo_by_id(demo_id)
    if not row:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    dem_path = row["path"]
    out = await _run_library_demo_analyze(
        demo_id,
        dem_path,
        req.target_players,
        req.freeze_to_death_rounds,
        locale=req.locale,
    )
    return {**out, "demo_filename": row["filename"]}


@app.delete("/api/demos/{demo_id}")
async def delete_demo(
    demo_id: int,
    rescan: Annotated[Literal["reimport", "skip"], Query(description="reimport=再次扫描可入库; skip=扫描不再入库")] = "reimport",
):
    ok = await demo_db.delete_demo(demo_id, rescan=rescan)
    if not ok:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    await demo_library_hub.notify("deleted")
    return {"status": "deleted", "demo_id": demo_id}


@app.post("/api/demos/{demo_id}/play")
async def play_demo_in_cs2(demo_id: int):
    """将 Demo 复制到 game/csgo/ 后直接启动 CS2 播放，不涉及 OBS 录制。"""
    row = await demo_db.get_demo_by_id(demo_id)
    if not row:
        raise HTTPException(404, f"Demo not found: {demo_id}")

    cfg = load_config()
    cs2_path = cfg.cs2_path
    if not cs2_path or not Path(cs2_path).is_file():
        raise HTTPException(400, "CS2 路径未配置或文件不存在，请先在设置中配置 CS2 路径。")

    dem_path = row.get("path") or ""
    if not dem_path or not Path(dem_path).is_file():
        raise HTTPException(422, "Demo 文件不存在于磁盘，无法播放。")

    try:
        cs2_bin = Path(cs2_path)
        # 约定路径结构: …/game/bin/win64/cs2.exe → game/
        game_root = cs2_bin.parents[2]
        csgo_dir = game_root / "csgo"
        dest = csgo_dir / "cs2_insight_preview.dem"
        shutil.copy2(dem_path, dest)
        logger.info("Launch CS2 for playback: cwd=%s demo=%s", game_root, dest)
        import subprocess as _sp
        creationflags = 0
        if sys.platform == "win32":
            creationflags = (
                getattr(_sp, "CREATE_NEW_PROCESS_GROUP", 0)
                | getattr(_sp, "DETACHED_PROCESS", 0)
            )
        _sp.Popen(
            [str(cs2_bin), "-steam", "-insecure", "-novid", "-console",
             "+playdemo", "cs2_insight_preview.dem"],
            cwd=str(game_root),
            stdin=_sp.DEVNULL, stdout=_sp.DEVNULL, stderr=_sp.DEVNULL,
            close_fds=True,
            creationflags=creationflags,
        )
    except Exception as e:
        logger.exception("Failed to launch CS2 for playback")
        raise HTTPException(500, f"启动 CS2 失败: {e}") from e

    return {"ok": True}


@app.post("/api/demos/{demo_id}/delete-file")
async def delete_demo_file(demo_id: int):
    """从磁盘删除 .dem 文件（如有同名 .zip 也一并删除），同时删除库内记录。"""
    demo = await demo_db.get_demo_by_id(demo_id)
    if not demo:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    disk_path = str(demo["path"])
    import os as _os
    deleted_files: list[str] = []
    errors: list[str] = []
    for target in (disk_path, disk_path.rsplit(".", 1)[0] + ".zip" if "." in _os.path.basename(disk_path) else None):
        if target is None:
            continue
        try:
            _os.remove(target)
            deleted_files.append(target)
        except FileNotFoundError:
            pass
        except OSError as e:
            errors.append(f"{target}: {e}")
    # 无论文件删除成功与否，都删除库内记录
    await demo_db.delete_demo(demo_id, rescan="skip")
    await demo_library_hub.notify("deleted")
    return {"status": "deleted", "demo_id": demo_id, "deleted_files": deleted_files, "errors": errors}


class BatchIngestBody(BaseModel):
    demo_ids: list[int] = Field(..., min_length=1, max_length=200)


@app.post("/api/demos/batch-ingest")
async def batch_ingest_demos(body: BatchIngestBody):
    """批量入库：对每个 pending demo 运行轻量元数据提取，状态改为 loaded。"""
    ingested = 0
    failed: list[dict[str, Any]] = []
    for demo_id in body.demo_ids:
        row = await demo_db.get_demo_by_id(demo_id)
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
        try:
            from .demo_parse_isolation import get_demo_match_summary_isolated

            meta = await asyncio.to_thread(get_demo_match_summary_isolated, dem_path)
            if isinstance(meta, dict):
                refined_source = infer_demo_source(Path(dem_path).name, server_name=meta.get("server_name"))
                await demo_db.update_lightweight_meta(dem_path, meta, source=refined_source)
            await index_demo_player_stats(demo_id, dem_path)
            await demo_db.update_status(dem_path, "loaded", error_msg=None, parsed_at=utc_now_iso())
            ingested += 1
        except Exception as e:
            logger.exception("Ingest failed demo_id=%s path=%s", demo_id, dem_path)
            failed.append({"demo_id": demo_id, "filename": row.get("filename", ""), "error": str(e)})
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



@app.get("/api/config-backup/status")
def config_backup_status():
    return build_config_backup_status_payload()


@app.post("/api/config-backup/restore")
def config_backup_restore():
    if not is_restore_required():
        return {"ok": True, "code": "CONFIG_RESTORE_NOT_NEEDED", "restored": 0}
    if is_cs2_running():
        raise HTTPException(
            status_code=409,
            detail={"code": "CS2_RUNNING"},
        )
    res = restore_latest_user_config_backup()
    if res.get("code") == "CS2_RUNNING":
        raise HTTPException(status_code=409, detail={"code": "CS2_RUNNING"})
    if res.get("ok"):
        return {"ok": True, "code": "CONFIG_RESTORE_OK", "restored": res.get("restored", 0)}
    return {
        "ok": False,
        "code": "CONFIG_RESTORE_PARTIAL",
        "failed": res.get("failed") or [],
    }


@app.post("/api/config-backup/open-dir")
def config_backup_open_dir():
    return open_backup_directory()


@app.post("/api/gsi/cs2")
async def cs2_gsi(payload: Optional[dict] = Body(default=None)):
    """CS2 Game State Integration sink used as a recording startup ready gate."""
    _payload = payload or {}
    ready = notify_gsi_payload(_payload)
    # 实时雷达缓存：转发快照到活跃会话
    try:
        from app.radar.radar_live_session import get_active_session
        _sess = get_active_session()
        if _sess is not None:
            import time as _time
            _sess.push_gsi_snapshot(_payload, wall_time=_time.monotonic())
    except Exception:
        pass
    return {"ok": True, "ready": ready}


@app.get("/api/gsi/status")
def cs2_gsi_status():
    return gsi_status()


# ─── Montage (V2) ─────────────────────────────────────────────


class RadarOverlayOptions(BaseModel):
    enabled: bool = False
    hud_overlay: bool = False
    killfeed_overlay: bool = False
    crosshair_overlay: bool = False
    lens_overlay: bool = False


class PlayerAvatar(BaseModel):
    player_key: str
    steamid64: Optional[str] = None
    player_name: str = ""
    avatar_path: Optional[str] = None
    enabled: bool = True


class MontageProjectBody(BaseModel):
    project_id: Optional[int] = None
    name: str = ""
    recorded_clip_ids: list[int] = Field(default_factory=list)
    bgm_path: Optional[str] = None
    bgm_volume: Optional[float] = None
    bgm_start_sec: Optional[float] = None
    intro_path: Optional[str] = None
    intro_image_duration: Optional[float] = None
    outro_path: Optional[str] = None
    outro_image_duration: Optional[float] = None
    output_filename: str = Field(default="montage_export.mp4", max_length=240)
    transitions: Optional[dict[str, Any]] = None
    radar_overlay: Optional[RadarOverlayOptions] = None
    theme_id: Optional[str] = Field(default=None, max_length=64)
    player_avatars: list[PlayerAvatar] = Field(default_factory=list)
    name_cards_enabled: bool = False


@app.get("/api/recorded-clips")
async def list_recorded_clips(
    limit: int = Query(default=300, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    rows = await montage_db.list_recorded_clips(limit=limit, offset=offset)
    return {"items": rows, "limit": limit, "offset": offset}


@app.delete("/api/recorded-clips/{clip_id}")
async def delete_recorded_clip(clip_id: int):
    try:
        r = await montage_db.delete_recorded_clip(clip_id)
    except ValueError as e:
        raise HTTPException(500, str(e)) from e
    if r is None:
        from .api_errors import error_detail

        raise HTTPException(404, error_detail("MONTAGE_CLIP_ALREADY_DELETED"))
    return r


class BatchDeleteRecordedClipsBody(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=500)


@app.post("/api/recorded-clips/batch-delete")
async def batch_delete_recorded_clips(body: BatchDeleteRecordedClipsBody):
    try:
        return await montage_db.delete_recorded_clips_batch(body.ids)
    except ValueError as e:
        raise HTTPException(500, str(e)) from e


@app.post("/api/recorded-clips/purge-missing")
async def purge_missing_recorded_clips():
    """删除 output_path 文件已不存在的孤儿记录，进入合集工作台时调用。"""
    return await montage_db.purge_missing_recorded_clips()


@app.post("/api/montage/projects")
async def save_montage_project(body: MontageProjectBody):
    proj_body = {
        "recorded_clip_ids": list(body.recorded_clip_ids),
        "bgm_path": body.bgm_path,
        "intro_path": body.intro_path,
        "outro_path": body.outro_path,
        "output_filename": (body.output_filename or "montage_export.mp4").strip() or "montage_export.mp4",
    }
    if body.transitions is not None:
        proj_body["transitions"] = body.transitions
    proj_body["player_avatars"] = [pa.model_dump() for pa in body.player_avatars]
    proj_body["name_cards_enabled"] = body.name_cards_enabled
    # 后期 FFmpeg 雷达叠层已下线；忽略客户端传入的旧开关，写入占位以兼容旧前端读取。
    proj_body["radar_overlay"] = {"enabled": False}
    if body.theme_id is not None:
        tid = str(body.theme_id).strip()
        if tid:
            proj_body["theme_id"] = tid
    if body.bgm_volume is not None:
        try:
            proj_body["bgm_volume"] = max(0.0, min(2.0, float(body.bgm_volume)))
        except (TypeError, ValueError):
            pass
    if body.bgm_start_sec is not None:
        try:
            proj_body["bgm_start_sec"] = max(0.0, float(body.bgm_start_sec))
        except (TypeError, ValueError):
            pass
    if body.intro_image_duration is not None:
        try:
            proj_body["intro_image_duration"] = max(1.0, float(body.intro_image_duration))
        except (TypeError, ValueError):
            pass
    if body.outro_image_duration is not None:
        try:
            proj_body["outro_image_duration"] = max(1.0, float(body.outro_image_duration))
        except (TypeError, ValueError):
            pass
    try:
        pid = await montage_db.save_project(name=body.name.strip() or None, body=proj_body, project_id=body.project_id)
    except ValueError as e:
        from .api_errors import error_detail

        if str(e) == "project not found":
            raise HTTPException(404, error_detail("MONTAGE_PROJECT_NOT_FOUND")) from e
        raise HTTPException(400, error_detail("MONTAGE_EXPORT_FAILED")) from e
    item = await montage_db.get_project(pid)
    if not item:
        from .api_errors import error_detail

        raise HTTPException(500, error_detail("MONTAGE_EXPORT_FAILED"))
    return item


class MontageExportBody(BaseModel):
    project_id: Optional[int] = None
    recorded_clip_ids: Optional[list[int]] = None
    ordered_ids: Optional[list[str]] = None
    bgm_path: Optional[str] = None
    bgm_volume: Optional[float] = None
    bgm_start_sec: Optional[float] = None
    intro_path: Optional[str] = None
    intro_image_duration: Optional[float] = None
    outro_path: Optional[str] = None
    outro_image_duration: Optional[float] = None
    output_path: str = Field(..., min_length=1, max_length=2048)
    theme_id: Optional[str] = Field(default=None, max_length=64)
    transitions: Optional[dict[str, Any]] = None
    radar_overlay: Optional[RadarOverlayOptions] = None
    player_avatars: list[PlayerAvatar] = Field(default_factory=list)
    name_cards_enabled: Optional[bool] = None  # None = inherit from project extras


@app.post("/api/montage/export")
async def montage_export(body: MontageExportBody):
    cfg = load_config()
    try:
        from .video_composer import resolve_ffmpeg_binary

        ffmpeg_bin = resolve_ffmpeg_binary(cfg.ffmpeg_path)
    except MontageComposerError as e:
        from .montage_errors import montage_detail_from_exception

        raise HTTPException(400, montage_detail_from_exception(e)) from e

    extras: dict[str, Any] = {}
    if body.project_id is not None:
        proj = await montage_db.get_project(int(body.project_id))
        if not proj:
            from .api_errors import error_detail

            raise HTTPException(404, error_detail("MONTAGE_PROJECT_NOT_FOUND"))
        extras = proj.get("body") if isinstance(proj.get("body"), dict) else {}

    clip_ids = list(body.recorded_clip_ids) if body.recorded_clip_ids is not None else list(extras.get("recorded_clip_ids") or [])
    if not clip_ids:
        from .api_errors import error_detail

        raise HTTPException(400, error_detail("MONTAGE_NO_CLIPS"))

    def _coalesce(req_val: Optional[str], key: str) -> Optional[str]:
        if req_val is not None:
            s = str(req_val).strip()
            return s or None
        v = extras.get(key)
        if v is None:
            return None
        s = str(v).strip()
        return s or None

    bgm_s = _coalesce(body.bgm_path, "bgm_path")
    intro_s = _coalesce(body.intro_path, "intro_path")
    outro_s = _coalesce(body.outro_path, "outro_path")

    def _coalesce_volume(req_val: Optional[float], key: str) -> Optional[float]:
        if req_val is not None:
            try:
                return max(0.0, min(2.0, float(req_val)))
            except (TypeError, ValueError):
                return None
        if not isinstance(extras, dict):
            return None
        v = extras.get(key)
        if v is None:
            return None
        try:
            return max(0.0, min(2.0, float(v)))
        except (TypeError, ValueError):
            return None

    bgm_volume_eff = _coalesce_volume(body.bgm_volume, "bgm_volume")

    def _coalesce_float(req_val: Optional[float], key: str, lo: float = 0.0, hi: float = 1e9) -> Optional[float]:
        v = req_val if req_val is not None else (extras.get(key) if isinstance(extras, dict) else None)
        if v is None:
            return None
        try:
            return max(lo, min(hi, float(v)))
        except (TypeError, ValueError):
            return None

    bgm_start_eff = _coalesce_float(body.bgm_start_sec, "bgm_start_sec", lo=0.0)
    intro_img_dur_eff = _coalesce_float(body.intro_image_duration, "intro_image_duration", lo=1.0, hi=60.0)
    outro_img_dur_eff = _coalesce_float(body.outro_image_duration, "outro_image_duration", lo=1.0, hi=60.0)

    transitions_eff: Any = body.transitions
    if transitions_eff is None and isinstance(extras, dict):
        transitions_eff = extras.get("transitions")

    # player_avatars / name_cards_enabled — coalesce from request or project extras
    player_avatars_eff: list[PlayerAvatar]
    if body.player_avatars:
        player_avatars_eff = body.player_avatars
    else:
        raw_pas = extras.get("player_avatars") if isinstance(extras, dict) else None
        if isinstance(raw_pas, list):
            player_avatars_eff = [PlayerAvatar(**pa) for pa in raw_pas if isinstance(pa, dict)]
        else:
            player_avatars_eff = []

    name_cards_enabled_eff: bool
    if body.name_cards_enabled is not None:
        name_cards_enabled_eff = bool(body.name_cards_enabled)
    else:
        name_cards_enabled_eff = bool(extras.get("name_cards_enabled")) if isinstance(extras, dict) else False

    try:
        from .video_composer import MontageComposerError, validate_output_path

        out = validate_output_path(body.output_path)
    except MontageComposerError as e:
        from .montage_errors import montage_detail_from_exception

        raise HTTPException(400, montage_detail_from_exception(e)) from e

    rows = await montage_db.get_recorded_clips_by_ids([int(x) for x in clip_ids])
    clip_paths: list[Path] = []
    for cid in clip_ids:
        row = rows.get(int(cid))
        if not row:
            from .api_errors import error_detail

            raise HTTPException(400, error_detail("MONTAGE_CLIP_NOT_FOUND", id=str(cid)))
        clip_paths.append(Path(str(row["output_path"])))

    intro_p = Path(intro_s).expanduser() if intro_s else None
    outro_p = Path(outro_s).expanduser() if outro_s else None
    bgm_p = Path(bgm_s).expanduser() if bgm_s else None

    # Build name_cards list parallel to clip_paths
    # Build a lookup from player_key → PlayerAvatar for fast matching
    _pa_lookup: dict[str, PlayerAvatar] = {pa.player_key: pa for pa in player_avatars_eff}

    name_cards_list: list[Optional[dict]] = []
    for cid in clip_ids:
        row = rows.get(int(cid))
        if row is None:
            name_cards_list.append(None)
            continue
        # Determine player_key for this clip row (steamid takes priority)
        steamid_val = (
            row.get("target_steamid64")
            or row.get("target_steam_id")
            or row.get("steamid")
        )
        if steamid_val:
            pk = "sid:" + str(steamid_val)
        else:
            pk = "name:" + _norm_player_key(str(row.get("player_name") or ""))

        matched_pa = _pa_lookup.get(pk)
        if matched_pa is None or not matched_pa.enabled:
            name_cards_list.append(None)
        else:
            display_name = matched_pa.player_name or str(row.get("player_name") or "")
            category = resolve_name_card_category(row)
            eyebrow = resolve_name_card_eyebrow(row, category)
            tags, result_tag = build_name_card_tags_and_result(row, category)
            name_cards_list.append(
                {
                    "avatar_path": matched_pa.avatar_path,
                    "display_name": display_name,
                    "category": category,
                    "eyebrow": eyebrow,
                    "result": result_tag,
                    "tags": tags,
                    "enabled": True,
                }
            )

    name_cards_arg = name_cards_list if name_cards_enabled_eff else None

    snap = {
        "recorded_clip_ids": clip_ids,
        "bgm_path": bgm_s,
        "intro_path": intro_s,
        "outro_path": outro_s,
        "output_path": str(out),
    }
    if isinstance(transitions_eff, dict):
        snap["transitions"] = transitions_eff
    snap["radar_overlay"] = {"enabled": False}
    if body.ordered_ids is not None:
        snap["ordered_ids"] = list(body.ordered_ids)
    if body.theme_id is not None:
        tid = str(body.theme_id).strip()
        if tid:
            snap["theme_id"] = tid
    if bgm_volume_eff is not None:
        snap["bgm_volume"] = bgm_volume_eff
    if bgm_start_eff is not None:
        snap["bgm_start_sec"] = bgm_start_eff
    if intro_img_dur_eff is not None:
        snap["intro_image_duration"] = intro_img_dur_eff
    if outro_img_dur_eff is not None:
        snap["outro_image_duration"] = outro_img_dur_eff
    snap["player_avatars"] = [pa.model_dump() for pa in player_avatars_eff]
    snap["name_cards_enabled"] = name_cards_enabled_eff
    export_id = await montage_db.create_export(
        project_id=int(body.project_id) if body.project_id is not None else None,
        body=snap,
        status="running",
    )

    try:
        from .video_composer import MontageComposerError, compose_montage

        await asyncio.to_thread(
            compose_montage,
            ffmpeg_bin=ffmpeg_bin,
            clip_paths=clip_paths,
            intro_path=intro_p,
            outro_path=outro_p,
            bgm_path=bgm_p,
            output_path=out,
            transitions=transitions_eff if isinstance(transitions_eff, dict) else None,
            clip_row_ids=[int(x) for x in clip_ids],
            bgm_volume=bgm_volume_eff,
            bgm_start_sec=bgm_start_eff,
            intro_image_duration=intro_img_dur_eff,
            outro_image_duration=outro_img_dur_eff,
            montage_encoder=cfg.montage_encoder or "auto",
            name_cards=name_cards_arg,
        )
    except MontageComposerError as e:
        from .montage_errors import montage_detail_from_exception

        detail = montage_detail_from_exception(e)
        await montage_db.update_export(
            export_id, status="error", error_msg=str(detail.get("code") or "MONTAGE_EXPORT_FAILED"), output_path=None,
        )
        raise HTTPException(400, detail) from e

    await montage_db.update_export(export_id, status="done", error_msg="", output_path=str(out))
    return {"export_id": export_id, "status": "done", "output_path": str(out)}


_AVATAR_MAX_BYTES = 5 * 1024 * 1024  # 5 MB
_ALLOWED_AVATAR_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

# Subtitle label displayed under the player name in the burned-in name card
_CATEGORY_SUBTITLE: dict[str, str] = {
    "highlight": "高光",
    "fail": "下饭",
    "meme_death": "梗死亡",
    "compilation": "合集",
}

_CATEGORY_EYEBROW: dict[str, str] = {
    "highlight":   "HIGHLIGHT · 高光",
    "fail":        "LOWLIGHT · 下饭",
    "meme_death":  "MEME · 梗死亡",
    "compilation": "ROUND · 合集",
}

# 高光片段 RESULT 块显示的杀数 tag 集合
_KILL_COUNT_TAGS: frozenset[str] = frozenset({
    "五杀 (ACE)", "四杀", "三杀", "双杀",
})


@app.post("/api/montage/avatars")
async def upload_montage_avatar(file: UploadFile = File(...)):
    """接收玩家头像图片上传，存储到 data/montage_avatars/，返回绝对路径。"""
    content_type = file.content_type or ""
    if content_type not in _ALLOWED_AVATAR_TYPES:
        raise HTTPException(400, "仅支持 JPEG / PNG / WebP / GIF 格式图片")

    data = await file.read()
    if len(data) > _AVATAR_MAX_BYTES:
        raise HTTPException(400, "图片文件大小不能超过 5MB")

    avatars_dir = get_data_dir() / "montage_avatars"
    avatars_dir.mkdir(parents=True, exist_ok=True)

    original_name = file.filename or ""
    suffix = Path(original_name).suffix if original_name else ""
    if not suffix:
        suffix = ".jpg"
    dest = avatars_dir / (str(uuid.uuid4()) + suffix)

    def _write(p: Path, d: bytes) -> None:
        p.write_bytes(d)

    await asyncio.to_thread(_write, dest, data)
    return {"path": str(dest), "url": f"/api/montage/avatars/{dest.name}"}


@app.get("/api/montage/avatars/{filename}")
async def serve_montage_avatar(filename: str):
    import re
    # Reject path traversal attempts
    if not re.fullmatch(r"[a-zA-Z0-9_\-\.]+", filename):
        raise HTTPException(400, "Invalid filename")
    avatar_dir = get_data_dir() / "montage_avatars"
    file_path = avatar_dir / filename
    if not file_path.is_file() or not str(file_path.resolve()).startswith(str(avatar_dir.resolve())):
        raise HTTPException(404, "Avatar not found")
    return FileResponse(str(file_path))


class FilePickerBody(BaseModel):
    file_type: str = Field(default="any", pattern=r"^(audio|video_or_image|any)$")


_FILE_PICKER_FILTERS: dict[str, str] = {
    "audio": "音频文件|*.mp3;*.ogg;*.wav;*.flac;*.aac;*.m4a|所有文件|*.*",
    "video_or_image": "视频与图片|*.mp4;*.mov;*.mkv;*.avi;*.png;*.jpg;*.jpeg;*.webp;*.bmp;*.gif|所有文件|*.*",
    "any": "所有文件|*.*",
}


@app.post("/api/file-picker")
async def file_picker(body: FilePickerBody):
    import sys
    import subprocess as sp

    if sys.platform != "win32":
        raise HTTPException(400, "文件浏览对话框仅 Windows 可用")

    ft = body.file_type if body.file_type in _FILE_PICKER_FILTERS else "any"
    filt = _FILE_PICKER_FILTERS[ft].replace("'", "''")

    ps = (
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;"
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$d = New-Object System.Windows.Forms.OpenFileDialog;"
        f"$d.Filter = '{filt}';"
        "$d.Multiselect = $false;"
        "if ($d.ShowDialog() -eq 'OK') { Write-Output $d.FileName }"
    )

    def _run() -> str:
        r = sp.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True,
            timeout=120,
        )
        return (r.stdout or b"").decode("utf-8", errors="replace").strip()

    try:
        path = await asyncio.to_thread(_run)
    except Exception as exc:
        raise HTTPException(500, f"文件选择器失败: {exc}") from exc

    return {"path": path or None}


class OpenFolderBody(BaseModel):
    path: str = Field(..., min_length=1, max_length=2048)


class RevealFileInExplorerBody(BaseModel):
    path: str = Field(..., min_length=1, max_length=2600)


@app.post("/api/open-folder")
def open_folder(body: OpenFolderBody):
    import os, subprocess as sp, sys
    p = body.path.strip()
    try:
        if sys.platform == "win32":
            os.startfile(p)  # noqa: S606
        elif sys.platform == "darwin":
            sp.run(["open", p], check=False, timeout=10)
        else:
            sp.run(["xdg-open", p], check=False, timeout=10)
    except Exception as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True}


@app.post("/api/reveal-file-in-explorer")
def reveal_file_in_explorer(body: RevealFileInExplorerBody):
    """在文件管理器中显示该 Demo：Windows 资源管理器 /select；macOS Finder -R；Linux 打开所在目录。"""
    import subprocess as sp
    import sys

    raw = (body.path or "").strip().strip('"')
    if not raw:
        raise HTTPException(400, "path 为空")
    try:
        p = Path(raw).expanduser().resolve(strict=False)
    except OSError as exc:
        raise HTTPException(400, f"无效路径: {exc}") from exc
    if not p.exists():
        raise HTTPException(404, f"路径不存在: {p}")
    try:
        if sys.platform == "win32":
            if p.is_dir():
                os.startfile(str(p))  # noqa: S606
            else:
                # `/select, <path>` 分成两个参数更稳；把路径拼进同一个参数时，
                # Explorer 在含空格/特殊字符场景下可能退回默认“文档”目录。
                sp.Popen(["explorer.exe", "/select,", str(p)])
        elif sys.platform == "darwin":
            sp.run(["open", "-R", str(p)], check=False, timeout=20)
        else:
            target = str(p.parent) if p.is_file() else str(p)
            sp.run(["xdg-open", target], check=False, timeout=20)
    except Exception as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True}


@app.get("/api/montage/exports")
async def list_montage_exports(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    status: str | None = Query(None),
):
    items, total = await montage_db.list_exports(limit=limit, offset=offset, status=status or None)
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@app.get("/api/montage/exports/{export_id}")
async def get_montage_export(export_id: int):
    row = await montage_db.get_export(export_id)
    if not row:
        raise HTTPException(404, "导出记录不存在")
    return row


class RenameExportBody(BaseModel):
    name: str = Field(..., max_length=200)


@app.patch("/api/montage/exports/{export_id}")
async def rename_montage_export(export_id: int, body: RenameExportBody):
    await montage_db.rename_export(export_id, body.name)
    return {"ok": True}


@app.delete("/api/montage/exports/{export_id}")
async def delete_montage_export(
    export_id: int,
    delete_file: bool = Query(False),
):
    output_path = await montage_db.delete_export(export_id)
    if output_path is None:
        raise HTTPException(404, "导出记录不存在")
    file_deleted = False
    if delete_file and output_path:
        try:
            import os as _os
            _os.remove(output_path)
            file_deleted = True
        except FileNotFoundError:
            file_deleted = False
        except OSError as e:
            raise HTTPException(400, f"文件删除失败：{e}") from e
    return {"ok": True, "file_deleted": file_deleted}


class BatchDeleteExportsBody(BaseModel):
    ids: list[int] = Field(..., min_length=1)
    delete_files: bool = False


@app.post("/api/montage/exports/batch-delete")
async def batch_delete_montage_exports(body: BatchDeleteExportsBody):
    paths = await montage_db.delete_exports_batch(body.ids)
    file_results: dict[str, str] = {}
    if body.delete_files:
        import os as _os
        for p in paths:
            if not p:
                continue
            try:
                _os.remove(p)
                file_results[p] = "deleted"
            except FileNotFoundError:
                file_results[p] = "not_found"
            except OSError as e:
                file_results[p] = f"error: {e}"
    return {"ok": True, "deleted_count": len(paths), "file_results": file_results}


# ─── Health ────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {"status": "ok", "version": "2.0.2"}


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
