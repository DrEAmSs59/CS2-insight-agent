"""HTTP boundary for Demo Library discovery, queries, and lifecycle actions."""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ...app_state import application_state
from ...databases import demo_db
from ...demo_compat_service import ensure_demo_compatible
from ...demo_db import DemoListFilters, utc_now_iso
from ...demo_library_hub import demo_library_hub
from ...env_utils import load_config
from ..demo_analysis.inspection import (
    demo_failure_item,
    demo_inspect_concurrency,
    inspect_demo_meta,
    library_working_demo_path,
)
from ..demo_analysis.player_matching import (
    match_expected_players_in_roster,
    normalized_expected_parse_players,
)
from ..demo_analysis.workflows import run_library_demo_analyze
from .ingestion import infer_demo_source
from .roster import get_or_index_demo_roster, index_demo_player_stats

logger = logging.getLogger(__name__)
router = APIRouter(tags=["demo-library"])

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


@router.get("/api/demos")
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


@router.get("/api/demos/compact")
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


@router.get("/api/demos/ids")
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

@router.get("/api/demos/stream")
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


@router.get("/api/demos/discovered")
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


@router.get("/api/demos/{demo_id}")
async def get_demo_library_item(demo_id: int):
    """单条 Demo 库记录（与列表项结构一致），用于跨页选中后按 id 拉取元数据。"""
    item = await demo_db.get_demo_list_item(demo_id)
    if not item:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    return item


@router.get("/api/demos/{demo_id}/player-stats")
async def get_demo_player_stats_library(demo_id: int):
    row = await demo_db.get_demo_by_id(demo_id)
    if not row:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    return {"demo_id": demo_id, "players": await demo_db.list_demo_player_stats(demo_id)}


@router.post("/api/demos/{demo_id}/index-player-stats")
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


@router.get("/api/players/search")
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


@router.post("/api/demos/batch-resolve-players")
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


@router.post("/api/demos/batch-summary")
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


@router.patch("/api/demos/{demo_id}")
async def patch_demo_display_name(demo_id: int, body: DemoDisplayNamePatch):
    ok = await demo_db.update_display_name(demo_id, body.display_name)
    if not ok:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    item = await demo_db.get_demo_list_item(demo_id)
    if not item:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    await demo_library_hub.notify("display_name")
    return item


@router.post("/api/demos/scan")
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


@router.post("/api/demos/watch-path/inspect")
async def inspect_demo_watch_path(body: DemoWatchPathInspectBody):
    """Validate and enumerate a watch directory without parsing demo contents."""
    from ...demo_watcher import iter_candidate_files

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


@router.post("/api/demos/{demo_id}/parse")
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

@router.get("/api/demos/{demo_id}/players")
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


@router.post("/api/demos/{demo_id}/analyze")
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


@router.delete("/api/demos/{demo_id}")
async def delete_demo(demo_id: int):
    demo = await demo_db.get_demo_by_id(demo_id)
    if not demo:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    from ..demo_analysis.replay_cache_storage import remove_demo_row_caches

    # Reclaim parse/replay caches for original + working paths before the
    # demo-cache file is unlinked with the library row.
    cache_removed = await asyncio.to_thread(remove_demo_row_caches, demo)
    ok = await demo_db.delete_demo(demo_id)
    if not ok:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    await demo_library_hub.notify("deleted")
    return {"status": "deleted", "demo_id": demo_id, "replay_cache": cache_removed}


@router.post("/api/demos/{demo_id}/delete-file")
async def delete_demo_file(demo_id: int):
    """从磁盘删除 .dem 文件（如有同名 .zip 也一并删除），同时删除库内记录。"""
    demo = await demo_db.get_demo_by_id(demo_id)
    if not demo:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    disk_path = str(demo["path"])
    cached_path = str(demo.get("cached_path") or "").strip()
    from ...file_quarantine import quarantine_files

    targets = [Path(disk_path), Path(disk_path).with_suffix(".zip")]
    if cached_path:
        targets.append(Path(cached_path))
    from ..demo_analysis.replay_cache_storage import remove_demo_row_caches

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


@router.post("/api/demos/batch-ingest")
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


@router.patch("/api/demos/{demo_id}/remark")
async def patch_demo_remark(demo_id: int, body: DemoRemarkPatch):
    ok = await demo_db.update_remark(demo_id, body.remark or None)
    if not ok:
        raise HTTPException(404, f"Demo not found: {demo_id}")
    await demo_library_hub.notify("remark")
    return {"status": "ok", "demo_id": demo_id}
