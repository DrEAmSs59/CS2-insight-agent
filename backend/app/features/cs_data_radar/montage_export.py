"""合辑导出：解析统一时间线并校验雷达候选项解析数据。"""

from __future__ import annotations

from typing import Any, Optional

from .candidates import build_candidates_for_clips
from .export_bake import require_parse_data
from .export_plan import flatten_export_timeline, used_candidate_keys
from .timeline import (
    coerce_timeline_ids,
    is_radar_timeline_id,
    migrate_radar_segments_into_timeline,
)


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def resolve_radar_timeline(
    *,
    recorded_clip_ids: list[int],
    ordered_ids: Optional[list[Any]],
    radar_items: Any,
    radar_segments: list[dict[str, Any]] | None,
    radar_enabled: bool,
) -> dict[str, Any]:
    items = _as_dict(radar_items)
    if ordered_ids:
        ordered = coerce_timeline_ids(ordered_ids)
    else:
        ordered = list(recorded_clip_ids)
        if radar_segments:
            migrated = migrate_radar_segments_into_timeline(ordered, radar_segments)
            ordered = migrated["ordered_ids"]
            merged = dict(migrated.get("radar_items") or {})
            merged.update(items)
            items = merged
    use_new = any(is_radar_timeline_id(item_id) for item_id in ordered) or bool(items)
    segments = flatten_export_timeline(
        ordered,
        radar_enabled=radar_enabled,
        radar_items=items,
    ) if use_new else [
        {"kind": "clip", "row_id": int(cid), "clip_id": int(cid)}
        for cid in recorded_clip_ids
        if int(cid) > 0
    ]
    return {
        "ordered_ids": ordered,
        "radar_items": items,
        "use_new": use_new,
        "segments": segments,
        "used_keys": used_candidate_keys(segments) if use_new else [],
        "radar_enabled": bool(radar_enabled),
    }


async def validate_radar_parse_data(
    *,
    clips: list[dict[str, Any]],
    used_keys: list[str],
    candidate_state: dict[str, Any],
    demo_db: Any,
    radar_items: Optional[dict[str, Any]] = None,
) -> dict[str, dict[str, Any]]:
    if not used_keys:
        return {}
    ratings = {}
    avg_ratings = {}
    for key in used_keys:
        state = candidate_state.get(key) if isinstance(candidate_state, dict) else None
        if not isinstance(state, dict):
            continue
        if "rating" in state:
            ratings[key] = state.get("rating")
        if "avg_rating" in state:
            avg_ratings[key] = state.get("avg_rating")
        elif "median_rating" in state:
            avg_ratings[key] = state.get("median_rating")
    extra_clips = list(clips)
    names_by_key: dict[str, str] = {}
    for meta in (_as_dict(radar_items)).values():
        if not isinstance(meta, dict):
            continue
        key = str(meta.get("candidate_key") or meta.get("candidateKey") or "")
        name = str(meta.get("player_name") or meta.get("playerName") or "")
        if key and name:
            names_by_key[key] = name
    from .timeline import derive_radar_candidates_from_clips

    have_keys = {row["key"] for row in derive_radar_candidates_from_clips(extra_clips)}
    for key in used_keys:
        if key in have_keys:
            continue
        extra_clips.append(_clip_stub_from_candidate_key(key, names_by_key.get(key, "")))
    candidates = await build_candidates_for_clips(
        extra_clips,
        demo_db=demo_db,
        rating_by_key=ratings,
        avg_rating_by_key=avg_ratings,
    )
    by_key = {str(row.get("key") or ""): row for row in candidates if row.get("key")}
    require_parse_data(by_key, used_keys)
    return by_key


def _clip_stub_from_candidate_key(key: str, player_name: str) -> dict[str, Any]:
    demo, _sep, player = str(key).partition("::")
    steamid = player[4:] if player.startswith("sid:") else None
    name = player_name or (player[5:] if player.startswith("name:") else "")
    looks_path = ("/" in demo) or ("\\" in demo)
    return {
        "demo_path": demo if looks_path else "",
        "demo_filename": demo if not looks_path else "",
        "target_steamid64": steamid,
        "player_name": name,
    }
