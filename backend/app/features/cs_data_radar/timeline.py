"""合辑时间线：数据雷达图候选项 / 占位段纯函数。"""

from __future__ import annotations

from typing import Any, Optional

ANIMATION_DURATION_SEC = 4.0
RADAR_ID_PREFIX = "radar:"


def _trim(value: Any) -> str:
    return str(value or "").strip()


def demo_key_from_clip(clip: Optional[dict[str, Any]]) -> str:
    clip = clip if isinstance(clip, dict) else {}
    path = _trim(clip.get("demo_path"))
    if path:
        return path
    return _trim(clip.get("demo_filename"))


def player_key_from_clip(clip: Optional[dict[str, Any]]) -> str:
    clip = clip if isinstance(clip, dict) else {}
    sid = _trim(clip.get("target_steamid64") or clip.get("target_steam_id") or clip.get("steamid"))
    name = _trim(clip.get("player_name"))
    if sid and sid != "0":
        return f"sid:{sid}"
    norm = name.lower().replace(" ", "")
    return f"name:{norm}" if norm else ""


def candidate_key_from_clip(clip: Optional[dict[str, Any]]) -> str:
    demo = demo_key_from_clip(clip)
    player = player_key_from_clip(clip)
    if not demo or not player:
        return ""
    return f"{demo}::{player}"


def derive_radar_candidates_from_clips(clips: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for clip in clips or []:
        if not isinstance(clip, dict):
            continue
        key = candidate_key_from_clip(clip)
        if not key:
            continue
        sid = _trim(clip.get("target_steamid64") or clip.get("target_steam_id") or clip.get("steamid"))
        name = _trim(clip.get("player_name"))
        if key in out:
            out[key]["segment_count"] = int(out[key]["segment_count"]) + 1
            if name:
                out[key]["player_name"] = name
            continue
        order.append(key)
        out[key] = {
            "key": key,
            "demo_path": _trim(clip.get("demo_path")),
            "demo_filename": _trim(clip.get("demo_filename")),
            "demo_id": clip.get("demo_id"),
            "player_key": player_key_from_clip(clip),
            "player_name": name,
            "steamid64": sid if sid and sid != "0" else None,
            "map_name": _trim(clip.get("map_name") or clip.get("map") or clip.get("demo_map")),
            "segment_count": 1,
        }
    return [out[key] for key in order]


def make_radar_timeline_id(uid: Any) -> str:
    raw = _trim(uid)
    if not raw:
        return f"{RADAR_ID_PREFIX}legacy"
    return raw if raw.startswith(RADAR_ID_PREFIX) else f"{RADAR_ID_PREFIX}{raw}"


def is_radar_timeline_id(item_id: Any) -> bool:
    return isinstance(item_id, str) and item_id.startswith(RADAR_ID_PREFIX)


def coerce_timeline_ids(raw: list[Any] | None) -> list[Any]:
    out: list[Any] = []
    for item in raw or []:
        text = _trim(item)
        if text.startswith(RADAR_ID_PREFIX) or is_radar_timeline_id(item):
            out.append(make_radar_timeline_id(item))
            continue
        try:
            n = int(item)
        except (TypeError, ValueError):
            continue
        if n > 0:
            out.append(n)
    return out


def clip_ids_from_timeline(ordered_ids: list[Any] | None) -> list[int]:
    out: list[int] = []
    for item_id in ordered_ids or []:
        if is_radar_timeline_id(item_id):
            continue
        try:
            n = int(item_id)
        except (TypeError, ValueError):
            continue
        if n > 0:
            out.append(n)
    return out


def insert_relative_to(
    ordered_ids: list[Any] | None,
    new_id: Any,
    *,
    before_id: Any = None,
    after_id: Any = None,
) -> list[Any]:
    next_ids = list(ordered_ids or [])
    if before_id is not None:
        for i, item_id in enumerate(next_ids):
            if str(item_id) == str(before_id):
                next_ids.insert(i, new_id)
                return next_ids
    if after_id is not None:
        for i, item_id in enumerate(next_ids):
            if str(item_id) == str(after_id):
                next_ids.insert(i + 1, new_id)
                return next_ids
    next_ids.append(new_id)
    return next_ids


def _segment_before_clip_id(seg: dict[str, Any]) -> Optional[int]:
    raw = seg.get("before_clip_id", seg.get("beforeClipId"))
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def migrate_radar_segments_into_timeline(
    ordered_clip_ids: list[Any] | None,
    radar_segments: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    ordered_ids = list(ordered_clip_ids or [])
    radar_items: dict[str, dict[str, Any]] = {}
    grouped: dict[int, list[dict[str, Any]]] = {}
    for seg in radar_segments or []:
        if not isinstance(seg, dict):
            continue
        before_id = _segment_before_clip_id(seg)
        if before_id is None:
            continue
        grouped.setdefault(before_id, []).append(seg)
    for before_id, segs in grouped.items():
        clip_index = next((i for i, item_id in enumerate(ordered_ids) if str(item_id) == str(before_id)), -1)
        if clip_index < 0:
            continue
        for offset, seg in enumerate(segs):
            uid = _trim(seg.get("uid") or seg.get("id")) or f"legacy-{before_id}-{offset}"
            radar_id = make_radar_timeline_id(uid)
            try:
                duration = float(seg.get("duration") or ANIMATION_DURATION_SEC)
            except (TypeError, ValueError):
                duration = ANIMATION_DURATION_SEC
            radar_items[radar_id] = {
                "id": radar_id,
                "candidate_key": _trim(seg.get("candidate_key") or seg.get("candidateKey")),
                "player_name": _trim(seg.get("player_name") or seg.get("playerName")),
                "duration": duration if duration > 0 else ANIMATION_DURATION_SEC,
            }
            ordered_ids.insert(clip_index + offset, radar_id)
    return {"ordered_ids": ordered_ids, "radar_items": radar_items}


def export_timeline_ids(ordered_ids: list[Any] | None, *, radar_enabled: bool) -> list[Any]:
    ids = list(ordered_ids or [])
    if radar_enabled:
        return ids
    return [item_id for item_id in ids if not is_radar_timeline_id(item_id)]


def radar_instance_duration_plan(
    instance_duration: Any,
    base_duration: float = ANIMATION_DURATION_SEC,
) -> dict[str, Any]:
    try:
        output = float(instance_duration)
    except (TypeError, ValueError):
        output = float(base_duration)
    output = max(0.1, output)
    base = max(0.1, float(base_duration or ANIMATION_DURATION_SEC))
    eps = 0.02
    if output > base + eps:
        mode = "pad"
    elif output < base - eps:
        mode = "trim"
    else:
        mode = "exact"
    return {"mode": mode, "source_duration": base, "output_duration": output}


def match_player_stats(
    players: list[dict[str, Any]] | None,
    *,
    steamid64: Optional[str],
    name: Optional[str],
) -> Optional[dict[str, Any]]:
    rows = [p for p in (players or []) if isinstance(p, dict)]
    sid = _trim(steamid64)
    if sid:
        for row in rows:
            row_sid = _trim(row.get("steam_id64") or row.get("steamid64") or row.get("steamid"))
            if row_sid == sid:
                return row
    want = _trim(name).lower()
    if want:
        for row in rows:
            row_name = _trim(row.get("name") or row.get("player_name") or row.get("display_name")).lower()
            if row_name == want:
                return row
    return None
