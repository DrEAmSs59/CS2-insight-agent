"""把统一时间线编成合辑导出要用的段列表（不含渲染）。"""

from __future__ import annotations

from typing import Any, Optional

from .timeline import export_timeline_ids, is_radar_timeline_id, radar_instance_duration_plan


def flatten_export_timeline(
    ordered_ids: list[Any] | None,
    *,
    radar_enabled: bool,
    radar_items: dict[str, Any] | None = None,
    baked_videos: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """返回导出段：clip 用 recorded_clip_id，radar 用已烘焙视频路径。"""
    items = radar_items or {}
    baked = baked_videos or {}
    out: list[dict[str, Any]] = []
    for item_id in export_timeline_ids(ordered_ids, radar_enabled=radar_enabled):
        if is_radar_timeline_id(item_id):
            meta = items.get(str(item_id)) if isinstance(items, dict) else None
            meta = meta if isinstance(meta, dict) else {}
            candidate_key = str(meta.get("candidate_key") or meta.get("candidateKey") or "")
            duration = float(meta.get("duration") or 4.0)
            plan = radar_instance_duration_plan(duration)
            video = baked.get(candidate_key) or baked.get(str(item_id)) or str(meta.get("video_path") or "")
            out.append(
                {
                    "kind": "radar",
                    "row_id": str(item_id),
                    "candidate_key": candidate_key,
                    "video_path": video,
                    "duration": plan["output_duration"],
                    "duration_mode": plan["mode"],
                }
            )
            continue
        try:
            clip_id = int(item_id)
        except (TypeError, ValueError):
            continue
        if clip_id <= 0:
            continue
        out.append({"kind": "clip", "row_id": clip_id, "clip_id": clip_id})
    return out


def used_candidate_keys(segments: list[dict[str, Any]]) -> list[str]:
    seen: list[str] = []
    for seg in segments:
        if seg.get("kind") != "radar":
            continue
        key = str(seg.get("candidate_key") or "")
        if key and key not in seen:
            seen.append(key)
    return seen
