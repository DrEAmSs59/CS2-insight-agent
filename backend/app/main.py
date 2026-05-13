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
from datetime import datetime
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, Literal, Optional

import faulthandler

from fastapi import Body, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from math import gcd
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .demo_parse_isolation import (
    IsolatedParseError,
    analyze_demo_isolated,
    get_demo_match_summary_isolated,
    get_player_list_isolated,
)
from .env_utils import (
    AppConfig,
    OBSConfig,
    LLMConfig,
    ExperimentalConfig,
    SpecPlayerVerifyConfig,
    load_config,
    save_config,
    ensure_cs2_path,
    detect_cs2_path,
    resolve_config_path,
    llm_api_key_configured,
    llm_base_url_is_local_host,
)
from .ai_reviewer import enrich_clips_dicts_with_reviewer
from .demo_db import DemoDB, DemoListFilters, utc_now_iso
from .demo_library_hub import demo_library_hub
from .demo_watcher import DemoWatcher, _demo_ingest_md5_enabled
from .file_hash import file_md5_hex
from .gsi_ready import gsi_status, notify_gsi_payload
from .montage_db import MontageDB
from . import obs_config_center
from .pov_experimental import merge_warmup_extras_for_pov
from .pov_hud_manager import PovHudError, PovHudManager, try_restore_stale_pov_on_startup
from .video_composer import MontageComposerError, compose_montage, resolve_ffmpeg_binary, validate_output_path
from .cs2_config_backup import (
    CONFIG_RESTORE_REQUIRED,
    build_config_backup_status_payload,
    is_cs2_running,
    is_restore_required,
    open_backup_directory,
    restore_latest_user_config_backup,
)
from .obs_director import (
    CS2_RUNNING_MESSAGE,
    CS2AlreadyRunningError,
    CS2NotReadyError,
    OBSDirector,
    RecordingWarmupExtras,
    _RECORDING_RESULT_CLIP_META_KEYS,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")

_FAULT_LOG_FILE = None
try:
    _log_dir_raw = (os.environ.get("CS2_INSIGHT_LOG_DIR") or "").strip()
    _log_dir = Path(_log_dir_raw) if _log_dir_raw else (resolve_config_path().parent / "logs")
    _log_dir.mkdir(parents=True, exist_ok=True)
    # 每次进程启动清空本地 *.log，避免单文件无限增长；与「重启程序」语义一致。
    for _old_log in _log_dir.glob("*.log"):
        try:
            _old_log.unlink(missing_ok=True)
        except OSError:
            pass
    _backend_log = _log_dir / "backend.log"
    _file_handler = logging.FileHandler(_backend_log, mode="w", encoding="utf-8")
    _file_handler.setFormatter(logging.Formatter("%(asctime)s [%(name)s] %(levelname)s: %(message)s"))
    logging.getLogger().addHandler(_file_handler)
    _FAULT_LOG_FILE = (_log_dir / "backend-fault.log").open("w", encoding="utf-8")
    faulthandler.enable(file=_FAULT_LOG_FILE, all_threads=True)
    logging.getLogger(__name__).info("Backend file logging enabled: %s", _backend_log)
except Exception:
    logging.getLogger(__name__).exception("Backend file logging setup failed")

DB_PATH = resolve_config_path().parent / "cs2-insight.db"
demo_db = DemoDB(DB_PATH)
montage_db = MontageDB(DB_PATH)
demo_watcher: DemoWatcher | None = None

# 单次 / 批量录制共用：请求中止时 set()，任务结束后在 finally 中置回 None
_recording_abort_event: Optional[asyncio.Event] = None

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
            cfg_dup = load_config()
            if _normalized_expected_parse_players(cfg_dup):
                row_dup = await demo_db.get_demo_by_path(demo_path)
                if row_dup and not (row_dup.get("display_name") or "").strip():
                    await _auto_tag_library_demo_for_expected_players(demo_path)
            return

        # 轻量解析：只提取地图与记分板元数据，避免重量级玩家片段解析。
        try:
            meta = await asyncio.to_thread(get_demo_match_summary_isolated, demo_path)
            if isinstance(meta, dict):
                refined_source = infer_demo_source(path.name, server_name=meta.get("server_name"))
                await demo_db.update_lightweight_meta(demo_path, meta, source=refined_source)
        except Exception:
            logger.exception("Lightweight meta parse failed for %s", demo_path)
        await demo_db.update_status(demo_path, "pending", error_msg=None, parsed_at=None)
        cfg_now = load_config()
        if _normalized_expected_parse_players(cfg_now):
            await _auto_tag_library_demo_for_expected_players(demo_path)
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
    ``_enqueue_demo_path``，其中包含 ``get_demo_match_summary`` 的轻量解析，以及
    若配置了 ``expected_parse_players``，会在入库流程内 **await**
    ``_auto_tag_library_demo_for_expected_players``，用 roster 同步写好库内展示名（不做高光解析），
    避免列表先显示文件名再异步更名。录制期我们会 ``shutil.copy2`` 一个 ``_insight_<uuid>.dem`` 到
    CS2 的 ``csgo/``；若用户的监听目录与 ``csgo/`` 有重叠（常见：就是把 CS2 的
    replay 目录作为监听目录），**每次录制都会在后台触发入库与轻量读盘**（记分板
    元数据等），仍可能与录制争用磁盘；历史上还曾叠加「名单自动深度解析」加重负载，
    故默认不在启动时全量扫描。
    保留 ``DemoWatcher`` 实例只是为 ``POST /api/demos/scan`` 这一条手动扫描接口
    服务；页面上改为用户点"刷新"按钮时主动扫描。
    """
    global demo_watcher
    await demo_db.init_db()
    await montage_db.init_tables()
    cfg = load_config()
    demo_watcher = DemoWatcher(cfg.demo_watch_paths or [], _enqueue_demo_path, demo_db)
    for _msg in try_restore_stale_pov_on_startup(cfg):
        if _msg:
            logger.info("POV startup: %s", _msg)
    try:
        yield
    finally:
        pass


app = FastAPI(title="CS2 Insight Agent", version="2.0.0", lifespan=lifespan)

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


def resolve_spectator_for_demo(dem_path: Path, requested: Optional[str]) -> Optional[str]:
    """
    将客户端传来的 target_player 与本场 Demo 的 roster 对齐（大小写/空白），
    再用于 spec_player。必须先对 roster 匹配：昵称里可能出现 SQLException 等字样，
    不能当作异常串过滤掉。
    """
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


def _lookup_roster_user_id(roster: list[dict], spectator_name: Optional[str]) -> Optional[int]:
    raw = (spectator_name or "").strip()
    if not raw:
        return None
    low = raw.lower()
    for p in roster:
        name = str(p.get("name") or "").strip()
        if name and name.lower() == low and p.get("user_id") is not None:
            try:
                uid = int(p.get("user_id"))
            except (TypeError, ValueError):
                return None
            return uid if uid > 0 else None
    return None


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
    return analyze_demo_isolated(dem_path, target_player, freeze_to_death_rounds)


async def _safe_upload_demo_meta(dem_path: Path) -> tuple[list[dict], dict]:
    """Best-effort metadata for upload responses; upload must not fail if parsing does."""
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


def _raise_if_recording_never_started(results: list[dict]) -> None:
    if not results:
        raise HTTPException(500, "录制没有产生任何结果，请检查 OBS / CS2 是否正常启动。")
    statuses = {str(r.get("status") or "") for r in results if isinstance(r, dict)}
    if "recorded" not in statuses and (statuses & {"obs_error", "error"}):
        first_error = next(
            (
                str(r.get("error") or r.get("status") or "")
                for r in results
                if isinstance(r, dict) and str(r.get("status") or "") in {"obs_error", "error"}
            ),
            "unknown",
        )
        raise HTTPException(500, f"录制没有开始：{first_error}")


def _clip_meta_from_recording_result(r: dict) -> dict[str, Any]:
    """从单次录制结果提取可 JSON 化的片段元数据，写入 recorded_clips.clip_meta。"""
    out: dict[str, Any] = {}
    for k in _RECORDING_RESULT_CLIP_META_KEYS:
        if k not in r:
            continue
        out[k] = r[k]
    return out


async def _persist_recorded_clips_from_results(results: list[dict]) -> None:
    """将成功录制的片段写入 recorded_clips 表（供合辑工作台）。"""
    for r in results:
        if not isinstance(r, dict):
            continue
        if str(r.get("status") or "") != "recorded":
            continue
        op = (r.get("output_path") or "").strip()
        if not op:
            continue
        demo_path = (r.get("demo_path") or "").strip()
        if not demo_path:
            continue
        clip_id = str(r.get("clip_id") or "")
        demo_fn = (r.get("demo_filename") or "").strip() or None
        player = (r.get("player_name") or "").strip() or None
        dur = r.get("duration")
        dur_f: float | None = None
        if dur is not None:
            try:
                dur_f = float(dur)
            except (TypeError, ValueError):
                dur_f = None
        try:
            meta = _clip_meta_from_recording_result(r)
            await montage_db.insert_recorded_clip(
                clip_id=clip_id,
                demo_path=demo_path,
                demo_filename=demo_fn,
                player_name=player,
                output_path=op,
                duration_sec=dur_f,
                status="ready",
                clip_meta=meta if meta else None,
            )
        except Exception:
            logger.exception("recorded_clips insert failed clip_id=%s path=%s", clip_id, op)


# 监听目录按「期望玩家」自动写库展示名时串行，避免大量 demo 同时读盘
_auto_expected_tag_sem = asyncio.Semaphore(1)


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


def _build_auto_display_name_from_roster(matched_rows: list[dict]) -> str:
    """多名时用「 · 」拼接，与库列表单行展示名一致。"""
    parts: list[str] = []
    for r in matched_rows:
        name = (r.get("name") or "").strip()
        if not name:
            continue
        k = int(r.get("kills") or 0)
        d = int(r.get("deaths") or 0)
        a = int(r.get("assists") or 0)
        parts.append(f"{name} {k}/{d}/{a}")
    s = " · ".join(parts)
    return s[:512] if s else ""


async def _maybe_update_library_display_for_expected(demo_id: int, dem_path: str) -> None:
    cfg = load_config()
    exp = _normalized_expected_parse_players(cfg)
    if not exp:
        return
    try:
        matched = await asyncio.to_thread(_matched_demo_players_in_order, exp, dem_path)
    except BaseException as e:
        if isinstance(e, (KeyboardInterrupt, SystemExit, GeneratorExit)):
            raise
        logger.exception("Expected-player display name roster scan failed for %s", dem_path)
        return
    label = _build_auto_display_name_from_roster(matched)
    if label:
        await demo_db.update_display_name(demo_id, label)
        await demo_library_hub.notify("display_name")


async def _run_library_demo_analyze(
    demo_id: int,
    dem_path: str,
    target_players: list[str],
    freeze_to_death_rounds: Optional[list[int]] = None,
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
        for player in target_players:
            parsed = await asyncio.to_thread(
                _analyze_demo_sync,
                dem_path,
                player,
                freeze_to_death_rounds,
            )
            players_out[player] = parsed
    except IsolatedParseError as e:
        msg = f"Demo 解析失败：{e}"
        logger.error("Library demo parse failed demo_id=%s path=%s: %s", demo_id, dem_path, e)
        await demo_db.update_status(dem_path, "error", error_msg=msg, parsed_at=None)
        await demo_library_hub.notify("parse_error")
        raise HTTPException(500, msg) from e

    cfg = load_config()
    if cfg.ai_mode and cfg.llm.api_key:
        async def _enrich_library_player(player: str) -> None:
            pdata = players_out.get(player)
            if not isinstance(pdata, dict):
                return
            clips = pdata.get("clips") or []
            meta = pdata.get("match_meta")
            if not clips or not isinstance(meta, dict):
                return
            try:
                pdata["clips"] = await enrich_clips_dicts_with_reviewer(clips, meta, cfg.llm)
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
    await _maybe_update_library_display_for_expected(demo_id, dem_path)
    await demo_library_hub.notify("analyzed")
    return {"players": players_out, "demo_path": dem_path}


async def _auto_tag_library_demo_for_expected_players(demo_path: str) -> None:
    """名单命中时只更新库内展示名（ roster K/D/A ），不做每位玩家的片段解析。"""
    async with _auto_expected_tag_sem:
        try:
            cfg0 = load_config()
            exp = _normalized_expected_parse_players(cfg0)
            if not exp:
                return
            row = await demo_db.get_demo_by_path(demo_path)
            if not row:
                return
            demo_id = int(row["id"])
            if (row.get("display_name") or "").strip():
                return
            await _maybe_update_library_display_for_expected(demo_id, demo_path)
            logger.info("Expected-player library display tag path=%s", demo_path)
        except BaseException as e:
            if isinstance(e, (KeyboardInterrupt, SystemExit, GeneratorExit)):
                raise
            logger.exception("Expected-player library display tag failed for %s", demo_path)


# ─── Config endpoints ─────────────────────────────────────────

class ExperimentalPayload(BaseModel):
    pov_enabled: Optional[bool] = None


class SpecPlayerVerifyPatch(BaseModel):
    model_config = ConfigDict(extra="ignore")

    demo_timescale: Optional[float] = Field(default=None, ge=0.01, le=1.0)
    max_retries: Optional[int] = Field(default=None, ge=1, le=16)
    per_retry_timeout_sec: Optional[float] = Field(default=None, ge=0.05, le=5.0)
    settle_sec: Optional[float] = Field(default=None, ge=0.0, le=2.0)


class ConfigPayload(BaseModel):
    obs: Optional[OBSConfig] = None
    llm: Optional[LLMConfig] = None
    ffmpeg_path: Optional[str] = None
    montage_encoder: Optional[str] = None
    cs2_path: Optional[str] = None
    demo_watch_paths: Optional[list[str]] = None
    ai_mode: Optional[bool] = None
    expected_parse_players: Optional[list[str]] = None
    cs2_fps_max: Optional[int] = None
    recording_global_pacing: Optional[dict[str, Any]] = None
    default_record_warmup: Optional[dict[str, Any]] = None
    cs2_extra_launch_args: Optional[str] = None
    record_inject_console_lines: Optional[str] = None
    experimental: Optional[ExperimentalPayload] = None
    spec_player_verify: Optional[SpecPlayerVerifyPatch] = None


@app.get("/api/config")
def get_config():
    cfg = load_config()
    cfg = ensure_cs2_path(cfg)
    data = cfg.model_dump()
    if data["llm"]["api_key"]:
        data["llm"]["api_key"] = "****" + data["llm"]["api_key"][-4:]
    obs_pw = (data.get("obs") or {}).get("password") or ""
    if obs_pw:
        data.setdefault("obs", {})
        data["obs"]["password"] = "****" + str(obs_pw)[-4:] if len(str(obs_pw)) > 4 else "****"
    return data


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
    if payload.cs2_fps_max is not None:
        v = int(payload.cs2_fps_max)
        cfg.cs2_fps_max = max(0, min(v, 9999))
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
        cfg.cs2_extra_launch_args = str(payload.cs2_extra_launch_args)
    if payload.record_inject_console_lines is not None:
        cfg.record_inject_console_lines = str(payload.record_inject_console_lines)
    if payload.experimental is not None:
        if payload.experimental.pov_enabled is not None:
            cfg.experimental.pov_enabled = bool(payload.experimental.pov_enabled)
    if payload.spec_player_verify is not None:
        patch = payload.spec_player_verify.model_dump(exclude_unset=True, exclude_none=True)
        if patch:
            cfg.spec_player_verify = cfg.spec_player_verify.model_copy(update=patch)
    save_config(cfg)
    if demo_watcher is not None and payload.demo_watch_paths is not None:
        # 只更新路径配置（供后续 /api/demos/scan 手动扫描使用）；
        # 不再 restart watchdog、也不再自动 scan_existing，避免配置保存瞬间触发
        # 大量重型解析抢占 CS2 录制时的系统资源。
        demo_watcher._paths = list(cfg.demo_watch_paths or [])
    return {"status": "ok"}


@app.get("/api/experimental/pov/status")
def experimental_pov_status():
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


@app.get("/api/status/setup")
def setup_status():
    """快速核查四项配置是否就绪，供新手引导页轮询。"""
    cfg = load_config()
    cfg = ensure_cs2_path(cfg)

    # 本地项先算好（不依赖网络），OBS 失败时也能立刻返回其余状态
    cs2_path_ok = bool(cfg.cs2_path and Path(cfg.cs2_path).is_file())

    ffmpeg_ok = False
    if cfg.ffmpeg_path:
        ffmpeg_ok = Path(cfg.ffmpeg_path).is_file()
    else:
        ffmpeg_ok = shutil.which("ffmpeg") is not None

    ai_key_ok = llm_api_key_configured(cfg.llm.api_key) or llm_base_url_is_local_host(
        cfg.llm.base_url
    )

    obs_connected = False
    try:
        director = OBSDirector(
            cfg.obs,
            cfg.cs2_path,
            cs2_fps_max=cfg.cs2_fps_max,
            cs2_extra_launch_args=cfg.cs2_extra_launch_args,
            record_inject_console_lines=cfg.record_inject_console_lines,
            spec_player_verify=cfg.spec_player_verify,
        )
        probe_timeout = _setup_status_obs_handshake_timeout_sec()
        result = director.test_obs_connection(handshake_timeout_sec=probe_timeout)
        obs_connected = bool(result.get("ok", False))
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

@app.post("/api/obs/test")
def test_obs(payload: OBSConfig | None = Body(default=None)):
    cfg = load_config()
    obs_use = merge_obs_for_connection(payload, cfg.obs)
    director = OBSDirector(
        obs_use,
        cfg.cs2_path,
        cs2_fps_max=cfg.cs2_fps_max,
        cs2_extra_launch_args=cfg.cs2_extra_launch_args,
        record_inject_console_lines=cfg.record_inject_console_lines,
        spec_player_verify=cfg.spec_player_verify,
    )
    return director.test_obs_connection()


class ObsConfigApplyRecommended(BaseModel):
    create_backup: bool = True
    fix_scene: bool = True
    # 留空则自动解析本机默认 Profile 目录（如「未命名」/ Untitled），不读环境变量
    target_profile: str = ""
    obs: Optional[OBSConfig] = None


@app.get("/api/obs-config/status")
def obs_config_status():
    cfg = load_config()
    return obs_config_center.get_status_payload(cfg.obs)


@app.post("/api/obs-config/diagnose")
def obs_config_diagnose(payload: Optional[OBSConfig] = Body(default=None)):
    cfg = load_config()
    obs_use = merge_obs_for_connection(payload, cfg.obs)
    return obs_config_center.diagnose(obs_use)


@app.post("/api/obs-config/apply-recommended")
def obs_config_apply_recommended(body: Optional[ObsConfigApplyRecommended] = Body(default=None)):
    cfg = load_config()
    req = body or ObsConfigApplyRecommended()
    obs_use = merge_obs_for_connection(req.obs, cfg.obs)
    tp = (req.target_profile or "").strip() or None
    try:
        return obs_config_center.apply_recommended(
            obs_use,
            project_profile=tp,
            create_backup=req.create_backup,
            fix_scene=req.fix_scene,
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/obs-config/import-preset")
async def obs_config_import_preset(
    file: UploadFile = File(...),
    create_backup: bool = Form(True),
):
    cfg = load_config()
    raw = await file.read()
    try:
        data = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError:
        raise HTTPException(400, "无效的 .cs2obs / JSON 文件") from None
    try:
        return obs_config_center.import_cs2obs_bytes(data, cfg.obs, create_backup=create_backup)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/obs-config/export-preset")
def obs_config_export_preset():
    cfg = load_config()
    data = obs_config_center.export_cs2obs_dict(cfg.obs)
    buf = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    return StreamingResponse(
        io.BytesIO(buf),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="cs2-insight-obs-preset-{ts}.cs2obs"'},
    )


@app.post("/api/obs-config/import-native")
async def obs_config_import_native(
    files: list[UploadFile] = File(...),
    create_backup: bool = Form(True),
):
    cfg = load_config()
    pairs: list[tuple[str, bytes]] = []
    for f in files:
        raw = await f.read()
        pairs.append((f.filename or "", raw))
    try:
        return obs_config_center.import_native_files(pairs, cfg.obs, create_backup=create_backup)
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
            result["clips"] = await enrich_clips_dicts_with_reviewer(
                result.get("clips") or [],
                result.get("match_meta") or {},
                cfg.llm,
            )
        except Exception as e:
            logging.error("AI review failed: %s", e)

    return result


class ParseMultiRequest(BaseModel):
    target_players: list[str] = Field(..., min_length=1)
    freeze_to_death_rounds: Optional[list[int]] = None


@app.post("/api/demo/parse-multi")
async def parse_demo_multi(req: ParseMultiRequest, filename: str):
    """多玩家解析：对同一个 Demo 依次分析每个目标玩家，返回 { players: { name: result } }。"""
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
        async def _review(player: str, result) -> None:
            try:
                result["clips"] = await enrich_clips_dicts_with_reviewer(
                    result.get("clips") or [],
                    result.get("match_meta") or {},
                    cfg.llm,
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


@app.post("/api/demo/parse-batch")
async def parse_demo_batch(req: BatchParseRequest):
    """
    批量解析：``paths`` 为上传后返回的绝对路径或 ``UPLOAD_DIR`` 下的文件名。
    使用线程池并行调用 ``DemoAnalyzer.analyze``，顺序与 ``paths`` 一致。
    """
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
                response["clips"] = await enrich_clips_dicts_with_reviewer(
                    response["clips"],
                    response["match_meta"],
                    cfg.llm,
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


@app.get("/api/demos/{demo_id}/players")
async def get_demo_players(demo_id: int):
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
            meta = await asyncio.to_thread(get_demo_match_summary_isolated, dem_path)
            if isinstance(meta, dict):
                refined_source = infer_demo_source(Path(dem_path).name, server_name=meta.get("server_name"))
                await demo_db.update_lightweight_meta(dem_path, meta, source=refined_source)
            await index_demo_player_stats(demo_id, dem_path)
            await demo_db.update_status(dem_path, "loaded", error_msg=None, parsed_at=utc_now_iso())
            await _maybe_update_library_display_for_expected(demo_id, dem_path)
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


# ─── Recording endpoints ──────────────────────────────────────


def _resolution_matches_aspect(width: int, height: int, aspect_ratio: str) -> bool:
    """判定整数宽高化简后是否与所选比例一致。

    CS2 视频设置里「宽高比 4:3」下列有 **1280×1024** 等实为 **5:4** 的分辨率，
    与游戏菜单保持一致：选 4:3 时同时接受标准 4:3 与 5:4。
    """
    g = gcd(int(width), int(height))
    if g <= 0:
        return False
    wn, hn = int(width) // g, int(height) // g
    if aspect_ratio == "4:3":
        if wn * 3 == hn * 4:
            return True
        # 1280×1024 等：游戏内挂在 4:3 分组下，数学上为 5:4（宽:高 = 5:4）
        return wn * 4 == hn * 5
    if aspect_ratio == "16:9":
        return wn * 9 == hn * 16
    if aspect_ratio == "16:10":
        return wn * 10 == hn * 16
    return False


class RecordWarmupOptions(BaseModel):
    """与 obs 首次 seek 前预热阶段注入的观战 cvar 及本次 CS2 启动分辨率一致。"""

    cl_draw_only_deathnotices: bool = True
    spec_show_xray: int = Field(default=0, ge=0, le=1)
    fov_cs_debug: Optional[float] = Field(default=None, ge=1, le=179)
    resolution_width: Optional[int] = Field(default=None, ge=1)
    resolution_height: Optional[int] = Field(default=None, ge=1)
    aspect_ratio: Optional[Literal["4:3", "16:9", "16:10"]] = None
    hud_showtargetid_hide: bool = True
    tv_nochat: bool = True
    viewmodel_fov_68: bool = False
    snd_voipvolume_mute: bool = True
    hide_demo_playback_ui: bool = True
    hide_grenade_trajectory_pip: bool = True
    console_cmds: Optional[list[str]] = None
    pov_radar_mode: int = Field(default=-1, ge=-1, le=0)
    pov_teamcounter_numeric: bool = True

    @model_validator(mode="after")
    def resolution_and_aspect_consistency(self) -> RecordWarmupOptions:
        rw, rh = self.resolution_width, self.resolution_height
        ar = self.aspect_ratio
        has_both = rw is not None and rh is not None
        has_either = rw is not None or rh is not None
        if has_either and not has_both:
            raise ValueError("启动分辨率须同时填写宽度与高度，或两者都留空。")
        if ar is not None and not has_both:
            raise ValueError("已选择屏幕比例时必须填写启动分辨率宽度与高度。")
        if has_both and ar is None:
            raise ValueError("填写启动分辨率时必须选择屏幕比例。")
        if has_both and ar is not None and rw is not None and rh is not None:
            if not _resolution_matches_aspect(rw, rh, ar):
                raise ValueError(f"分辨率 {rw}×{rh} 与所选屏幕比例 {ar} 不符。")
        return self


class RecordRequest(BaseModel):
    demo_filename: str
    clips: list[dict]
    # 与 /api/demo/parse 一致；Steam64 用字符串避免 JS JSON 大数精度丢失
    target_player: Optional[str] = None
    target_player_user_id: Optional[int] = None
    target_steam_id: Optional[str] = None
    warmup: Optional[RecordWarmupOptions] = None
    obs: Optional[OBSConfig] = None


def _raise_if_cs2_already_running() -> None:
    if is_cs2_running():
        raise HTTPException(409, CS2_RUNNING_MESSAGE)


def _raise_if_config_restore_required() -> None:
    if is_restore_required():
        raise HTTPException(status_code=409, detail=CONFIG_RESTORE_REQUIRED)


@app.post("/api/record/start")
async def start_recording(req: RecordRequest):
    cfg = load_config()
    cfg = ensure_cs2_path(cfg)
    obs_cfg = merge_obs_for_connection(req.obs, cfg.obs)

    if not cfg.cs2_path:
        raise HTTPException(
            400,
            "未配置 CS2 路径且自动探测失败。请在左侧「CS2 路径」中填写 cs2.exe 完整路径，或点击「自动探测」。",
        )
    _raise_if_cs2_already_running()
    _raise_if_config_restore_required()

    dem_path = resolve_uploaded_demo_path(req.demo_filename)

    roster = get_player_list_isolated(str(dem_path))

    spectator_name: Optional[str] = None
    raw_steam = (req.target_steam_id or "").strip()
    if raw_steam:
        try:
            want_sid = int(raw_steam)
        except ValueError:
            want_sid = 0
        if want_sid > 0:
            for p in roster:
                ps = p.get("steam_id")
                if ps is None:
                    continue
                try:
                    if int(str(ps)) == want_sid:
                        spectator_name = str(p.get("name") or "").strip() or None
                        break
                except ValueError:
                    continue
            if not spectator_name:
                logger.warning("target_steam_id 未匹配到本场玩家: %s", raw_steam)

    spectator_uid: Optional[int] = req.target_player_user_id
    if spectator_uid is not None:
        allowed = {p.get("user_id") for p in roster if p.get("user_id") is not None}
        if allowed and spectator_uid not in allowed:
            logger.warning(
                "target_player_user_id %r 不在本场 Demo 的 user_id 集合中，将忽略该 id",
                spectator_uid,
            )
            spectator_uid = None
    # 观战槽位按 tick 现算，需要稳定昵称；Steam 优先解析出 roster 内规范名
    if spectator_name is None:
        spectator_name = resolve_spectator_for_demo(dem_path, req.target_player)
    if spectator_uid is None:
        spectator_uid = _lookup_roster_user_id(roster, spectator_name)
    warmup_extras: Optional[RecordingWarmupExtras] = None
    if req.warmup is not None:
        cc = req.warmup.console_cmds
        tup = tuple(cc) if cc else None
        warmup_extras = RecordingWarmupExtras(
            cl_draw_only_deathnotices=req.warmup.cl_draw_only_deathnotices,
            spec_show_xray=int(req.warmup.spec_show_xray),
            fov_cs_debug=req.warmup.fov_cs_debug,
            resolution_width=req.warmup.resolution_width,
            resolution_height=req.warmup.resolution_height,
            hud_showtargetid_hide=req.warmup.hud_showtargetid_hide,
            tv_nochat=req.warmup.tv_nochat,
            viewmodel_fov_68=req.warmup.viewmodel_fov_68,
            snd_voipvolume_mute=req.warmup.snd_voipvolume_mute,
            hide_demo_playback_ui=req.warmup.hide_demo_playback_ui,
            hide_grenade_trajectory_pip=req.warmup.hide_grenade_trajectory_pip,
            aspect_ratio=req.warmup.aspect_ratio,
            console_cmds=tup,
            pov_radar_mode=int(req.warmup.pov_radar_mode),
            pov_teamcounter_numeric=bool(req.warmup.pov_teamcounter_numeric),
        )

    pov_on = bool(cfg.experimental.pov_enabled)
    warmup_eff: Optional[RecordingWarmupExtras] = (
        merge_warmup_extras_for_pov(warmup_extras) if pov_on else warmup_extras
    )

    global _recording_abort_event
    if _recording_abort_event is not None:
        raise HTTPException(409, "已有录制任务进行中，请先中止或等待结束。")
    abort_ev = asyncio.Event()
    _recording_abort_event = abort_ev
    pov_mgr: Optional[PovHudManager] = None
    try:
        if pov_on:
            pov_mgr = PovHudManager(cfg)
            pov_mgr.install()
        director = OBSDirector(
            obs_cfg,
            cfg.cs2_path,
            abort_event=abort_ev,
            cs2_fps_max=cfg.cs2_fps_max,
            cs2_extra_launch_args=cfg.cs2_extra_launch_args,
            record_inject_console_lines=cfg.record_inject_console_lines,
            spec_player_verify=cfg.spec_player_verify,
        )
        results = await director.execute_recording_pipeline(
            dem_path,
            req.clips,
            spectator_name=spectator_name,
            spectator_user_id=spectator_uid,
            warmup=warmup_eff,
            pov_enabled=pov_on,
        )
        _raise_if_recording_never_started(results)
        await _persist_recorded_clips_from_results(results)
        return {"status": "completed", "results": results}
    except PovHudError as e:
        raise HTTPException(400, str(e)) from e
    except CS2AlreadyRunningError as e:
        raise HTTPException(409, str(e)) from e
    except CS2NotReadyError as e:
        raise HTTPException(409, str(e)) from e
    finally:
        _recording_abort_event = None
        if pov_on and pov_mgr is not None:
            try:
                pov_mgr.restore()
            except Exception:
                logger.exception("POV HUD restore failed")


class BatchRecordGroup(BaseModel):
    demo_filename: str
    demo_path: Optional[str] = None
    clips: list[dict]
    target_player: Optional[str] = None
    target_player_user_id: Optional[int] = None
    target_steam_id: Optional[str] = None


class BatchRecordRequest(BaseModel):
    """按 Demo 分组的待录制列表；同一 ``demo_filename`` 可合并为一组由前端保证。"""

    groups: list[BatchRecordGroup] = Field(..., min_length=1)
    warmup: Optional[RecordWarmupOptions] = None
    obs: Optional[OBSConfig] = None


def _resolve_spectators_for_record(
    dem_path: Path,
    req_like: RecordRequest | BatchRecordGroup,
) -> tuple[Optional[str], Optional[int]]:
    """与 ``start_recording`` 相同的观战名 / user_id 解析逻辑。"""
    roster = get_player_list_isolated(str(dem_path))

    spectator_name: Optional[str] = None
    raw_steam = (getattr(req_like, "target_steam_id", None) or "").strip()
    if raw_steam:
        try:
            want_sid = int(raw_steam)
        except ValueError:
            want_sid = 0
        if want_sid > 0:
            for p in roster:
                ps = p.get("steam_id")
                if ps is None:
                    continue
                try:
                    if int(str(ps)) == want_sid:
                        spectator_name = str(p.get("name") or "").strip() or None
                        break
                except ValueError:
                    continue
            if not spectator_name:
                logger.warning("target_steam_id 未匹配到本场玩家: %s", raw_steam)

    spectator_uid: Optional[int] = getattr(req_like, "target_player_user_id", None)
    if spectator_uid is not None:
        allowed = {p.get("user_id") for p in roster if p.get("user_id") is not None}
        if allowed and spectator_uid not in allowed:
            logger.warning(
                "target_player_user_id %r 不在本场 Demo 的 user_id 集合中，将忽略该 id",
                spectator_uid,
            )
            spectator_uid = None
    if spectator_name is None:
        spectator_name = resolve_spectator_for_demo(dem_path, getattr(req_like, "target_player", None))
    if spectator_uid is None:
        spectator_uid = _lookup_roster_user_id(roster, spectator_name)
    return spectator_name, spectator_uid


@app.post("/api/record/batch")
async def start_batch_recording(req: BatchRecordRequest):
    cfg = load_config()
    cfg = ensure_cs2_path(cfg)
    obs_cfg = merge_obs_for_connection(req.obs, cfg.obs)
    if not cfg.cs2_path:
        raise HTTPException(
            400,
            "未配置 CS2 路径且自动探测失败。请在左侧「CS2 路径」中填写 cs2.exe 完整路径，或点击「自动探测」。",
        )
    _raise_if_cs2_already_running()
    _raise_if_config_restore_required()

    warmup_opts = req.warmup
    wobj: Optional[RecordingWarmupExtras] = None
    if warmup_opts is not None:
        cc = warmup_opts.console_cmds
        tup = tuple(cc) if cc else None
        wobj = RecordingWarmupExtras(
            cl_draw_only_deathnotices=warmup_opts.cl_draw_only_deathnotices,
            spec_show_xray=int(warmup_opts.spec_show_xray),
            fov_cs_debug=warmup_opts.fov_cs_debug,
            resolution_width=warmup_opts.resolution_width,
            resolution_height=warmup_opts.resolution_height,
            hud_showtargetid_hide=warmup_opts.hud_showtargetid_hide,
            tv_nochat=warmup_opts.tv_nochat,
            viewmodel_fov_68=warmup_opts.viewmodel_fov_68,
            snd_voipvolume_mute=warmup_opts.snd_voipvolume_mute,
            hide_demo_playback_ui=warmup_opts.hide_demo_playback_ui,
            hide_grenade_trajectory_pip=warmup_opts.hide_grenade_trajectory_pip,
            aspect_ratio=warmup_opts.aspect_ratio,
            console_cmds=tup,
            pov_radar_mode=int(warmup_opts.pov_radar_mode),
            pov_teamcounter_numeric=bool(warmup_opts.pov_teamcounter_numeric),
        )

    pov_on = bool(cfg.experimental.pov_enabled)
    warmup_eff: Optional[RecordingWarmupExtras] = merge_warmup_extras_for_pov(wobj) if pov_on else wobj

    # ── 两层聚合：demo（唯一启动 CS2）→ player（切换 spec_player）→ clips ──
    # 同一个 demo 内的不同玩家合并为一个 CS2 会话，只启动/关闭游戏一次；
    # 玩家之间通过在 clip dict 内嵌入 _spec_name / _spec_uid 字段来切换 spec_player，
    # execute_batch_recording 不再感知玩家维度，OBSDirector 按 clip 自带信息注入。

    # demo_key → (dem_path, ordered_player_groups)
    # ordered_player_groups: list of (spec_name, spec_uid, clips_sorted_by_tick)
    # inner list: [spec_name, spec_uid, clips_list]  — mutable so we can extend clips_list
    demo_player_map: dict[str, tuple[Path, list[list]]] = {}

    for g in req.groups:
        candidate = (g.demo_path or "").strip() or g.demo_filename
        dem_path = resolve_uploaded_demo_path(candidate)
        spec_name, spec_uid = _resolve_spectators_for_record(dem_path, g)
        demo_key = str(dem_path)
        if demo_key not in demo_player_map:
            demo_player_map[demo_key] = (dem_path, [])
        _, player_groups = demo_player_map[demo_key]
        # 同一玩家的多个 group 合并（player_groups 元素为 list，可直接 extend）
        existing_idx = next(
            (i for i, pg in enumerate(player_groups) if pg[0] == spec_name and pg[1] == spec_uid),
            None,
        )
        if existing_idx is None:
            player_groups.append([spec_name, spec_uid, list(g.clips)])
        else:
            player_groups[existing_idx][2].extend(g.clips)

    # 展平为 execute_batch_recording 所需格式：每个 clip 内嵌 _spec_name / _spec_uid
    # 玩家顺序保留原始 group 顺序，各玩家内部按 start_tick 升序
    demo_jobs: list[tuple[Path, list[dict], Optional[str], Optional[int]]] = []
    for demo_key, (dem_path, player_groups) in demo_player_map.items():
        flat_clips: list[dict] = []
        for spec_name, spec_uid, clips in player_groups:
            sorted_clips = sorted(clips, key=lambda c: int(c.get("start_tick") or 0))
            for clip in sorted_clips:
                tagged = dict(clip)
                tagged["_spec_name"] = spec_name
                tagged["_spec_uid"]  = spec_uid
                flat_clips.append(tagged)
        if flat_clips:
            # spec_name/spec_uid 设为 None：由各 clip 自带字段驱动
            demo_jobs.append((dem_path, flat_clips, None, None))

    if not demo_jobs:
        raise HTTPException(400, "没有可录制的片段（clips 为空）")

    global _recording_abort_event
    if _recording_abort_event is not None:
        raise HTTPException(409, "已有录制任务进行中，请先中止或等待结束。")
    abort_ev = asyncio.Event()
    _recording_abort_event = abort_ev
    pov_mgr: Optional[PovHudManager] = None
    try:
        if pov_on:
            pov_mgr = PovHudManager(cfg)
            pov_mgr.install()
        director = OBSDirector(
            obs_cfg,
            cfg.cs2_path,
            abort_event=abort_ev,
            cs2_fps_max=cfg.cs2_fps_max,
            cs2_extra_launch_args=cfg.cs2_extra_launch_args,
            record_inject_console_lines=cfg.record_inject_console_lines,
            spec_player_verify=cfg.spec_player_verify,
        )
        results = await director.execute_batch_recording(
            demo_jobs,
            warmup=warmup_eff,
            pov_enabled=pov_on,
        )
        _raise_if_recording_never_started(results)
        await _persist_recorded_clips_from_results(results)
        return {"status": "completed", "results": results}
    except PovHudError as e:
        raise HTTPException(400, str(e)) from e
    except CS2AlreadyRunningError as e:
        raise HTTPException(409, str(e)) from e
    except CS2NotReadyError as e:
        raise HTTPException(409, str(e)) from e
    finally:
        _recording_abort_event = None
        if pov_on and pov_mgr is not None:
            try:
                pov_mgr.restore()
            except Exception:
                logger.exception("POV HUD restore failed")


@app.post("/api/record/abort")
def record_abort():
    """请求中止当前进行中的单次或批量 OBS 录制（异步收尾，接口立即返回）。"""
    global _recording_abort_event
    if _recording_abort_event is None:
        return {"status": "idle", "message": "当前没有进行中的录制"}
    _recording_abort_event.set()
    return {"status": "ok", "message": "已请求中止，正在收尾…"}


@app.get("/api/config-backup/status")
def config_backup_status():
    return build_config_backup_status_payload()


@app.post("/api/config-backup/restore")
def config_backup_restore():
    if not is_restore_required():
        return {"ok": True, "message": "玩家配置状态正常", "restored": 0}
    if is_cs2_running():
        raise HTTPException(
            status_code=409,
            detail={
                "code": "CS2_RUNNING",
                "message": "CS2 正在运行，请先关闭 CS2 后再恢复玩家配置。",
            },
        )
    res = restore_latest_user_config_backup()
    if res.get("ok"):
        return {"ok": True, "message": "玩家配置已恢复", "restored": res.get("restored", 0)}
    return {
        "ok": False,
        "message": "部分配置恢复失败，请检查文件权限或手动打开备份目录。",
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
        raise HTTPException(404, "片段不存在或已删除")
    return r


class BatchDeleteRecordedClipsBody(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=500)


@app.post("/api/recorded-clips/batch-delete")
async def batch_delete_recorded_clips(body: BatchDeleteRecordedClipsBody):
    try:
        return await montage_db.delete_recorded_clips_batch(body.ids)
    except ValueError as e:
        raise HTTPException(500, str(e)) from e


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
    if body.radar_overlay is not None:
        proj_body["radar_overlay"] = body.radar_overlay.model_dump()
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
        raise HTTPException(404, str(e)) from e
    item = await montage_db.get_project(pid)
    if not item:
        raise HTTPException(500, "保存合辑项目后读取失败")
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


@app.post("/api/montage/export")
async def montage_export(body: MontageExportBody):
    cfg = load_config()
    try:
        ffmpeg_bin = resolve_ffmpeg_binary(cfg.ffmpeg_path)
    except MontageComposerError as e:
        raise HTTPException(400, str(e)) from e

    extras: dict[str, Any] = {}
    if body.project_id is not None:
        proj = await montage_db.get_project(int(body.project_id))
        if not proj:
            raise HTTPException(404, "合辑项目不存在")
        extras = proj.get("body") if isinstance(proj.get("body"), dict) else {}

    clip_ids = list(body.recorded_clip_ids) if body.recorded_clip_ids is not None else list(extras.get("recorded_clip_ids") or [])
    if not clip_ids:
        raise HTTPException(400, "recorded_clip_ids 不能为空")

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

    radar_defaults: dict[str, Any] = {
        "enabled": False,
        "hud_overlay": False,
        "killfeed_overlay": False,
        "crosshair_overlay": False,
        "lens_overlay": False,
    }
    radar_options = dict(radar_defaults)
    if isinstance(extras, dict) and isinstance(extras.get("radar_overlay"), dict):
        ro = extras["radar_overlay"]
        for k in radar_defaults:
            if k in ro:
                radar_options[k] = bool(ro[k])
    if body.radar_overlay is not None:
        radar_options.update(body.radar_overlay.model_dump())

    try:
        out = validate_output_path(body.output_path)
    except MontageComposerError as e:
        raise HTTPException(400, str(e)) from e

    rows = await montage_db.get_recorded_clips_by_ids([int(x) for x in clip_ids])
    clip_paths: list[Path] = []
    ordered_clip_rows: list[dict[str, Any]] = []
    for cid in clip_ids:
        row = rows.get(int(cid))
        if not row:
            raise HTTPException(400, f"未知的 recorded_clip id: {cid}")
        clip_paths.append(Path(str(row["output_path"])))
        ordered_clip_rows.append(dict(row))

    intro_p = Path(intro_s).expanduser() if intro_s else None
    outro_p = Path(outro_s).expanduser() if outro_s else None
    bgm_p = Path(bgm_s).expanduser() if bgm_s else None

    snap = {
        "recorded_clip_ids": clip_ids,
        "bgm_path": bgm_s,
        "intro_path": intro_s,
        "outro_path": outro_s,
        "output_path": str(out),
    }
    if isinstance(transitions_eff, dict):
        snap["transitions"] = transitions_eff
    snap["radar_overlay"] = radar_options
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
    export_id = await montage_db.create_export(
        project_id=int(body.project_id) if body.project_id is not None else None,
        body=snap,
        status="running",
    )

    try:
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
            radar_overlay=radar_options,
            clip_rows=ordered_clip_rows,
            bgm_volume=bgm_volume_eff,
            bgm_start_sec=bgm_start_eff,
            intro_image_duration=intro_img_dur_eff,
            outro_image_duration=outro_img_dur_eff,
            montage_encoder=cfg.montage_encoder or "auto",
        )
    except MontageComposerError as e:
        await montage_db.update_export(export_id, status="error", error_msg=str(e), output_path=None)
        raise HTTPException(400, str(e)) from e

    await montage_db.update_export(export_id, status="done", error_msg="", output_path=str(out))
    return {"export_id": export_id, "status": "done", "output_path": str(out)}


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
                sp.Popen(["explorer", "/select," + str(p)])
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
    return {"status": "ok", "version": "2.0.0"}


@app.get("/")
def index():
    if WEB_DIST_DIR is None:
        raise HTTPException(
            status_code=503,
            detail="Web UI not found. Build frontend and provide web/ or frontend/dist.",
        )
    return FileResponse(str(WEB_DIST_DIR / "index.html"))


@app.get("/{path:path}")
def spa_fallback(path: str):
    # API 路径保持 404/原路由处理，不进入前端 fallback。
    if path.startswith("api/"):
        raise HTTPException(404, "Not Found")
    if WEB_DIST_DIR is None:
        raise HTTPException(404, "Not Found")

    candidate = (WEB_DIST_DIR / path).resolve()
    if candidate.is_file() and WEB_DIST_DIR in candidate.parents:
        return FileResponse(str(candidate))

    # React/Vite SPA 刷新子路由时回退到 index.html。
    return FileResponse(str(WEB_DIST_DIR / "index.html"))
