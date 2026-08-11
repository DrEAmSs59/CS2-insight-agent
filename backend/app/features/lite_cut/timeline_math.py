"""Pure LiteCut source-time and timeline-time mathematics."""

from __future__ import annotations

from typing import Any

MIN_CLIP_VISIBLE_SEC = 0.1


def clip_duration_sec(clip: dict[str, Any]) -> float:
    trim_in = float(clip.get("trim_in") or 0)
    trim_out = clip.get("trim_out")
    if trim_out is not None:
        return max(MIN_CLIP_VISIBLE_SEC, float(trim_out) - trim_in)
    if clip.get("duration") is not None:
        return max(MIN_CLIP_VISIBLE_SEC, float(clip.get("duration") or 0) - trim_in)
    meta = clip.get("meta") if isinstance(clip.get("meta"), dict) else {}
    if meta.get("duration_sec") is not None:
        return max(MIN_CLIP_VISIBLE_SEC, float(meta["duration_sec"]) - trim_in)
    return 5.0


def clip_speed(clip: dict[str, Any]) -> float:
    try:
        speed = float(clip.get("speed") or 1.0)
    except (TypeError, ValueError):
        speed = 1.0
    return max(0.25, min(4.0, speed))


def clip_speed_keyframes(clip: dict[str, Any]) -> list[tuple[float, float]]:
    trim_in = max(0.0, float(clip.get("trim_in") or 0.0))
    trim_out = trim_in + clip_duration_sec(clip)
    points: list[tuple[float, float]] = []
    for raw in clip.get("speed_keyframes") or []:
        if not isinstance(raw, dict):
            continue
        try:
            source_sec = max(trim_in, min(trim_out, float(raw.get("source_sec"))))
            speed = max(0.25, min(4.0, float(raw.get("speed"))))
        except (TypeError, ValueError):
            continue
        points.append((source_sec, speed))
    points.sort(key=lambda point: point[0])
    deduplicated: list[tuple[float, float]] = []
    for point in points:
        if deduplicated and abs(deduplicated[-1][0] - point[0]) <= 1e-6:
            deduplicated[-1] = point
        else:
            deduplicated.append(point)
    if len(deduplicated) < 2:
        return []
    if deduplicated[0][0] > trim_in + 1e-6:
        deduplicated.insert(0, (trim_in, clip_speed(clip)))
    if deduplicated[-1][0] < trim_out - 1e-6:
        deduplicated.append((trim_out, deduplicated[-1][1]))
    return deduplicated


def clip_speed_segments(clip: dict[str, Any]) -> list[tuple[float, float, float]]:
    trim_in = max(0.0, float(clip.get("trim_in") or 0.0))
    trim_out = trim_in + clip_duration_sec(clip)
    points = clip_speed_keyframes(clip)
    if not points:
        return [(trim_in, trim_out, clip_speed(clip))]
    return [(left_t, right_t, speed) for (left_t, speed), (right_t, _) in zip(points[:-1], points[1:]) if right_t - left_t > 1e-6]


def clip_has_speed_ramp(clip: dict[str, Any]) -> bool:
    return len(clip_speed_keyframes(clip)) >= 2


def clip_timeline_time_for_source(clip: dict[str, Any], source_sec: float) -> float:
    trim_in = max(0.0, float(clip.get("trim_in") or 0.0))
    source = max(trim_in, min(trim_in + clip_duration_sec(clip), float(source_sec)))
    timeline = 0.0
    for start, end, speed in clip_speed_segments(clip):
        if source <= start:
            break
        timeline += (min(source, end) - start) / speed
        if source <= end:
            break
    return timeline


def clip_media_timeline_duration_sec(clip: dict[str, Any]) -> float:
    trim_in = max(0.0, float(clip.get("trim_in") or 0.0))
    return max(MIN_CLIP_VISIBLE_SEC, clip_timeline_time_for_source(clip, trim_in + clip_duration_sec(clip)))


def clip_source_time_for_timeline(clip: dict[str, Any], timeline_sec: float) -> float:
    target = max(0.0, min(clip_media_timeline_duration_sec(clip), float(timeline_sec)))
    elapsed = 0.0
    for start, end, speed in clip_speed_segments(clip):
        timeline_length = (end - start) / speed
        if target <= elapsed + timeline_length + 1e-6:
            return start + max(0.0, target - elapsed) * speed
        elapsed += timeline_length
    return max(0.0, float(clip.get("trim_in") or 0.0)) + clip_duration_sec(clip)


def clip_reverse(clip: dict[str, Any]) -> bool:
    return bool(clip.get("reverse"))


def clip_freeze_frame_sec(clip: dict[str, Any]) -> float:
    try:
        freeze = float(clip.get("freeze_frame_sec") or 0.0)
    except (TypeError, ValueError):
        freeze = 0.0
    return max(0.0, min(30.0, freeze))


def clip_preserve_pitch(clip: dict[str, Any]) -> bool:
    return clip.get("preserve_pitch") is not False


def clip_canvas_fit(clip: dict[str, Any], fallback: str = "contain") -> str:
    raw = str(clip.get("canvas_fit") or "").strip().lower()
    if raw in {"contain", "cover", "blur"}:
        return raw
    fit = str(fallback or "contain").strip().lower()
    return fit if fit in {"contain", "cover", "blur"} else "contain"


def clip_timeline_duration_sec(clip: dict[str, Any]) -> float:
    return clip_media_timeline_duration_sec(clip) + clip_freeze_frame_sec(clip)
