"""从成片对应 demo 的解析结果里取出主角数据。"""

from __future__ import annotations

from typing import Any, Optional

from .radar_model import compute_match_avg_radar, derive_radar_stats
from .source_assets import infer_map_name, infer_source_from_path, normalize_demo_source
from .timeline import derive_radar_candidates_from_clips, match_player_stats


def _kda_line(stats: Optional[dict[str, Any]]) -> str:
    if not isinstance(stats, dict):
        return ""
    try:
        kills = int(float(stats.get("kills") or 0))
        deaths = int(float(stats.get("deaths") or 0))
        assists = int(float(stats.get("assists") or 0))
    except (TypeError, ValueError):
        return ""
    return f"{kills} / {deaths} / {assists}"


async def _workspace_bundle_for_demo(
    demo_db: Any,
    *,
    demo_path: str,
    demo_filename: str,
) -> tuple[Optional[list[dict[str, Any]]], str, str]:
    paths: list[str] = []
    source = ""
    map_name = ""
    for raw in (demo_path,):
        text = str(raw or "").strip()
        if text and text not in paths:
            paths.append(text)
    for path in list(paths):
        demo = await demo_db.get_demo_by_path(path)
        if demo is None:
            getter = getattr(demo_db, "get_demo_by_cached_path", None)
            if callable(getter):
                demo = await getter(path)
        if isinstance(demo, dict):
            origin = str(demo.get("path") or "").strip()
            if origin and origin not in paths:
                paths.append(origin)
            if not source:
                source = normalize_demo_source(demo.get("source") or "")
            if not map_name:
                map_name = infer_map_name(demo.get("map_name"))
    if demo_filename:
        finder = getattr(demo_db, "find_by_filename", None)
        if callable(finder):
            demo = await finder(str(demo_filename).strip())
            if isinstance(demo, dict):
                origin = str(demo.get("path") or "").strip()
                if origin and origin not in paths:
                    paths.append(origin)
                if not source:
                    source = normalize_demo_source(demo.get("source") or "")
                if not map_name:
                    map_name = infer_map_name(demo.get("map_name"))

    players: Optional[list[dict[str, Any]]] = None
    for path in paths:
        result = await demo_db.get_result(path)
        if not isinstance(result, dict):
            continue
        workspace = result.get("analysis_workspace")
        if not isinstance(workspace, dict):
            continue
        if not map_name:
            map_name = infer_map_name(workspace.get("map_name"))
        rows = workspace.get("players")
        if isinstance(rows, list) and rows:
            players = [p for p in rows if isinstance(p, dict)]
            break
    if not source:
        source = infer_source_from_path(demo_path, demo_filename)
    if not map_name:
        map_name = infer_map_name(demo_filename, demo_path)
    return players, source, map_name


async def _workspace_players_for_demo(
    demo_db: Any,
    *,
    demo_path: str,
    demo_filename: str,
) -> Optional[list[dict[str, Any]]]:
    players, _source, _map_name = await _workspace_bundle_for_demo(
        demo_db, demo_path=demo_path, demo_filename=demo_filename
    )
    return players


def _public_candidate(
    candidate: dict[str, Any],
    stats: Optional[dict[str, Any]],
    *,
    rating: Any = None,
    match_avg: Optional[dict[str, Any]] = None,
    demo_source: str = "",
    map_name: str = "",
) -> dict[str, Any]:
    radar = derive_radar_stats(stats or {}, rating=rating) if stats else derive_radar_stats({}, rating=rating)
    resolved_map = infer_map_name(
        map_name,
        (stats or {}).get("map_name"),
        candidate.get("map_name"),
        candidate.get("demo_filename"),
        candidate.get("demo_path"),
    )
    avg = dict(match_avg or {})
    return {
        **candidate,
        "has_parse_data": bool(stats),
        "stats": stats,
        "radar": radar,
        "match_avg": avg,
        "match_median": avg,
        "demo_source": demo_source,
        "map_name": resolved_map,
        "kda": _kda_line(stats),
        "team_key": (stats or {}).get("team_key"),
        "team_label": (stats or {}).get("team_label") or "",
    }


async def build_candidates_for_clips(
    clips: list[dict[str, Any]],
    *,
    demo_db: Any,
    rating_by_key: Optional[dict[str, Any]] = None,
    avg_rating_by_key: Optional[dict[str, Any]] = None,
    median_rating_by_key: Optional[dict[str, Any]] = None,
) -> list[dict[str, Any]]:
    ratings = rating_by_key or {}
    avg_ratings = avg_rating_by_key or median_rating_by_key or {}
    out: list[dict[str, Any]] = []
    cache: dict[tuple[str, str], tuple[Optional[list[dict[str, Any]]], str, str]] = {}
    for candidate in derive_radar_candidates_from_clips(clips):
        cache_key = (str(candidate.get("demo_path") or ""), str(candidate.get("demo_filename") or ""))
        if cache_key not in cache:
            cache[cache_key] = await _workspace_bundle_for_demo(
                demo_db,
                demo_path=cache_key[0],
                demo_filename=cache_key[1],
            )
        players, demo_source, map_name = cache[cache_key]
        stats = match_player_stats(
            players,
            steamid64=candidate.get("steamid64"),
            name=candidate.get("player_name"),
        )
        rating = ratings.get(candidate["key"])
        match_avg = compute_match_avg_radar(
            players or [],
            rating_avg=avg_ratings.get(candidate["key"]),
        )
        out.append(
            _public_candidate(
                candidate,
                stats,
                rating=rating,
                match_avg=match_avg,
                demo_source=demo_source,
                map_name=map_name,
            )
        )
    return out
