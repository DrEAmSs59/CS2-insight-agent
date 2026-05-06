from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def write_radar_debug_points(
    *,
    output_dir: str | Path,
    clip_id: str | int | None,
    map_name: str,
    frame_index: int,
    video_time_sec: float,
    tick: int,
    source_w: int,
    source_h: int,
    points: list[dict[str, Any]],
) -> None:
    """写出雷达点位 debug 数据，方便排查坐标偏移。"""
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    payload: dict[str, Any] = {
        "clip_id": clip_id,
        "map_name": map_name,
        "frame_index": frame_index,
        "video_time_sec": video_time_sec,
        "tick": tick,
        "source_w": source_w,
        "source_h": source_h,
        "points": points,
    }

    cid = str(clip_id) if clip_id is not None else "clip"
    safe_cid = "".join(c if c.isalnum() or c in "-_" else "_" for c in cid)[:80]
    out_path = out_dir / f"radar_debug_{safe_cid}_{frame_index:05d}.json"
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
