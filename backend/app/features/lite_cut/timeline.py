"""LiteCut project, clip and timeline semantics."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ...video_composer import MontageComposerError
from .export_projection import (
    ffmpeg_color as _ffmpeg_color,
    project_canvas_settings as _project_canvas_settings,
    project_encoder_tier as _project_encoder_tier,
    project_export_range as _project_export_range,
    project_master_volume as _project_master_volume,
    project_output_settings as _project_output_settings,
)
from .timeline_math import (
    clip_canvas_fit as _clip_canvas_fit,
    clip_duration_sec as _clip_duration_sec,
    clip_freeze_frame_sec as _clip_freeze_frame_sec,
    clip_has_speed_ramp as _clip_has_speed_ramp,
    clip_preserve_pitch as _clip_preserve_pitch,
    clip_reverse as _clip_reverse,
    clip_speed as _clip_speed,
    clip_speed_keyframes as _clip_speed_keyframes,
    clip_speed_segments as _clip_speed_segments,
    clip_timeline_duration_sec as _clip_timeline_duration_sec,
)
from .timeline_selectors import has_solo_audio_tracks, project_tracks, track_by_id, track_clips
from .project_boundaries import (
    AUDIO_BGM_GAIN_DEFAULT,
    AUDIO_CLIP_GAIN_DEFAULT,
    AUDIO_CLIP_GAIN_MAX,
    AUDIO_CLIP_GAIN_MIN,
    AUDIO_DUCKING_GAIN_DEFAULT,
    AUDIO_FADE_DURATION_DEFAULT,
    AUDIO_TRACK_GAIN_DEFAULT,
    AUDIO_TRACK_GAIN_MAX,
    AUDIO_TRACK_GAIN_MIN,
    TIMELINE_TIME_DEFAULT,
    TIMELINE_TIME_MIN,
)
from .visual_material import (
    VISUAL_CROP_POSITION_MAX,
    VISUAL_CROP_POSITION_MIN,
    VISUAL_CROP_SIZE_MAX,
    VISUAL_CROP_SIZE_MIN,
    VISUAL_MATERIAL_DEFAULTS,
)

_MAIN_VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
_AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}


def _clip_crop_filter(clip: dict[str, Any]) -> str:
    crop = clip.get("crop") if isinstance(clip.get("crop"), dict) else None
    if not crop:
        return ""
    crop_defaults = VISUAL_MATERIAL_DEFAULTS["crop"]
    try:
        width = float(crop.get("width", crop_defaults["width"]))
        height = float(crop.get("height", crop_defaults["height"]))
        x = float(crop.get("x", crop_defaults["x"]))
        y = float(crop.get("y", crop_defaults["y"]))
    except (TypeError, ValueError):
        return ""
    width = max(VISUAL_CROP_SIZE_MIN, min(VISUAL_CROP_SIZE_MAX, width))
    height = max(VISUAL_CROP_SIZE_MIN, min(VISUAL_CROP_SIZE_MAX, height))
    x = max(VISUAL_CROP_POSITION_MIN, min(VISUAL_CROP_POSITION_MAX - width, x))
    y = max(VISUAL_CROP_POSITION_MIN, min(VISUAL_CROP_POSITION_MAX - height, y))
    if width >= 0.9999 and height >= 0.9999:
        return ""
    return f"crop=iw*{width:.6f}:ih*{height:.6f}:iw*{x:.6f}:ih*{y:.6f}"


def _clip_volume(clip: dict[str, Any]) -> float:
    if clip.get("muted"):
        return 0.0
    try:
        volume = float(clip.get("volume") if clip.get("volume") is not None else AUDIO_CLIP_GAIN_DEFAULT)
    except (TypeError, ValueError):
        volume = AUDIO_CLIP_GAIN_DEFAULT
    return max(AUDIO_CLIP_GAIN_MIN, min(AUDIO_CLIP_GAIN_MAX, volume))


def _clip_audio_keyframes(clip: dict[str, Any]) -> list[tuple[float, float]]:
    duration = _clip_timeline_duration_sec(clip)
    points: list[tuple[float, float]] = []
    for keyframe in clip.get("audio_keyframes") or []:
        if not isinstance(keyframe, dict):
            continue
        try:
            time_sec = max(TIMELINE_TIME_MIN, min(duration, float(keyframe.get("time_sec") or TIMELINE_TIME_DEFAULT)))
            volume = max(AUDIO_CLIP_GAIN_MIN, min(AUDIO_CLIP_GAIN_MAX, float(keyframe.get("volume"))))
        except (TypeError, ValueError):
            continue
        points.append((time_sec, volume))
    points.sort(key=lambda point: point[0])
    deduplicated: list[tuple[float, float]] = []
    for point in points:
        if deduplicated and abs(deduplicated[-1][0] - point[0]) <= 1e-6:
            deduplicated[-1] = point
        else:
            deduplicated.append(point)
    return deduplicated


def _clip_volume_filter(clip: dict[str, Any]) -> str:
    if clip.get("muted"):
        return "volume=0.000000"
    try:
        track_gain = max(AUDIO_TRACK_GAIN_MIN, min(AUDIO_TRACK_GAIN_MAX, float(clip.get("_track_volume") if clip.get("_track_volume") is not None else 1.0)))
    except (TypeError, ValueError):
        track_gain = 1.0
    points = _clip_audio_keyframes(clip)
    if not points:
        return f"volume={_clip_volume(clip) * track_gain:.6f}"
    expression = f"{points[-1][1]:.6f}"
    for index in range(len(points) - 1, 0, -1):
        start_time, start_volume = points[index - 1]
        end_time, end_volume = points[index]
        delta = max(0.0001, end_time - start_time)
        linear = f"{start_volume:.6f}+({end_volume:.6f}-{start_volume:.6f})*(t-{start_time:.6f})/{delta:.6f}"
        expression = f"if(lt(t\\,{end_time:.6f})\\,{linear}\\,{expression})"
    first_time, first_volume = points[0]
    if first_time > 1e-6:
        expression = f"if(lt(t\\,{first_time:.6f})\\,{first_volume:.6f}\\,{expression})"
    if abs(track_gain - 1.0) > 1e-6:
        expression = f"({expression})*{track_gain:.6f}"
    return f"volume='{expression}':eval=frame"


def _clip_audio_fade(clip: dict[str, Any], key: str) -> float:
    try:
        fade = float(clip.get(key) or 0.0)
    except (TypeError, ValueError):
        fade = 0.0
    duration = _clip_duration_sec(clip)
    return max(0.0, min(duration, fade))


def _track_main_video_clips(track: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        c
        for c in (track.get("clips") or [])
        if isinstance(c, dict) and (_is_recorded_timeline_clip(c) or _is_main_file_clip(c))
    ]


def _has_solo_audio_tracks(body: dict[str, Any]) -> bool:
    return has_solo_audio_tracks(body)


def _track_volume(track: dict[str, Any]) -> float:
    try:
        volume = float(track.get("volume") if track.get("volume") is not None else AUDIO_TRACK_GAIN_DEFAULT)
    except (TypeError, ValueError):
        volume = AUDIO_TRACK_GAIN_DEFAULT
    return max(AUDIO_TRACK_GAIN_MIN, min(AUDIO_TRACK_GAIN_MAX, volume))


def _clip_with_track_audio_gain(clip: dict[str, Any], track: dict[str, Any], *, force_muted: bool = False) -> dict[str, Any]:
    gain = _track_volume(track)
    out = {**clip, "_track_volume": gain}
    if force_muted or track.get("muted"):
        out["muted"] = True
    return out


def _base_video_track_for_export(body: dict[str, Any]) -> tuple[str | None, list[dict[str, Any]]]:
    tracks = body.get("tracks") if isinstance(body.get("tracks"), list) else []
    for track in reversed(tracks):
        if not isinstance(track, dict) or track.get("hidden"):
            continue
        if track.get("type") not in (None, "video"):
            continue
        track_id = str(track.get("id") or "")
        clips = sorted(_track_main_video_clips(track), key=lambda c: float(c.get("timeline_start") or 0))
        if clips:
            clips = [
                _clip_with_track_audio_gain(c, track, force_muted=bool(track.get("muted") or _has_solo_audio_tracks(body)))
                if isinstance(c, dict)
                else c
                for c in clips
            ]
            return track_id, clips
    return None, []


def _main_video_clips_sorted(body: dict[str, Any]) -> list[dict[str, Any]]:
    return _base_video_track_for_export(body)[1]


def _overlay_track_clips(body: dict[str, Any], *, base_track_id: str | None = None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    tracks = body.get("tracks") if isinstance(body.get("tracks"), list) else []
    if base_track_id is None:
        base_track_id = _base_video_track_for_export(body)[0]
    base_index = next((index for index, track in enumerate(tracks) if isinstance(track, dict) and str(track.get("id") or "") == str(base_track_id or "")), len(tracks))
    # UI order is top-to-bottom. Composite tracks above the base from the
    # nearest bottom layer upward so index 0 is rendered last and stays on top.
    for track in reversed(tracks[:base_index]):
        if not isinstance(track, dict):
            continue
        if track.get("hidden"):
            continue
        ttype = track.get("type")
        if ttype not in (None, "video"):
            continue
        if ttype is None and str(track.get("id") or "") in ("overlay", "a1", "a2"):
            continue
        track_id = str(track.get("id") or "")
        for clip in sorted(track.get("clips") or [], key=lambda item: float(item.get("timeline_start") or 0) if isinstance(item, dict) else 0):
            if not isinstance(clip, dict):
                continue
            if _is_recorded_timeline_clip(clip) or _is_main_file_clip(clip):
                out.append(_timeline_video_layer_clip(clip, track_id=track_id))
            elif _is_file_overlay_clip(clip):
                out.append(clip)
    return out


def _timeline_video_layer_clip(clip: dict[str, Any], *, track_id: str) -> dict[str, Any]:
    out = {**clip}
    out["type"] = "file"
    out["source_track_id"] = track_id
    out["is_timeline_video_layer"] = True
    out["transform"] = out.get("transform") if isinstance(out.get("transform"), dict) else {
        "x": 0.5,
        "y": 0.5,
        "scale": 1.0,
        "rotation": 0.0,
        "width": 1.0,
        "height": 1.0,
        "opacity": 1.0,
    }
    return out


def _schema_overlay_clips(body: dict[str, Any]) -> list[dict[str, Any]]:
    """Preview 区叠层 (body.overlays) → 导出合成列表。"""
    out: list[dict[str, Any]] = []
    hidden_track_ids = {
        str(track.get("id"))
        for track in (body.get("overlay_tracks") or [])
        if isinstance(track, dict) and track.get("hidden")
    }
    for ov in body.get("overlays") or []:
        if not isinstance(ov, dict):
            continue
        meta = ov.get("meta") if isinstance(ov.get("meta"), dict) else {}
        if str(meta.get("overlay_track_id") or "ot1") in hidden_track_ids:
            continue
        if ov.get("type") == "text":
            dur = float(ov.get("duration") or 3)
            out.append(
                {
                    "id": str(ov.get("id") or ""),
                    "type": "text",
                    "timeline_start": float(ov.get("timeline_start") or 0),
                    "trim_in": 0,
                    "trim_out": dur,
                    "duration": dur,
                    "_transition_events": ov.get("_transition_events") if isinstance(ov.get("_transition_events"), list) else [],
                    "transform": ov.get("transform") if isinstance(ov.get("transform"), dict) else None,
                    "keyframes": ov.get("keyframes") if isinstance(ov.get("keyframes"), list) else [],
                    "content_fit": str(ov.get("content_fit") or "fill"),
                    "flip_horizontal": bool(ov.get("flip_horizontal")),
                    "flip_vertical": bool(ov.get("flip_vertical")),
                    "text": ov.get("text") if isinstance(ov.get("text"), dict) else {},
                    "meta": ov.get("meta") if isinstance(ov.get("meta"), dict) else {},
                }
            )
            continue
        path = str(ov.get("asset_path") or "").strip()
        if not path:
            continue
        dur = float(ov.get("duration") or 3)
        trim_in = max(0.0, float(ov.get("trim_in") or 0))
        out.append(
            {
                "id": str(ov.get("id") or ""),
                "type": "file",
                "file_path": path,
                "timeline_start": float(ov.get("timeline_start") or 0),
                "trim_in": trim_in,
                "trim_out": trim_in + dur,
                "duration": dur,
                "_transition_events": ov.get("_transition_events") if isinstance(ov.get("_transition_events"), list) else [],
                "transform": ov.get("transform") if isinstance(ov.get("transform"), dict) else None,
                "keyframes": ov.get("keyframes") if isinstance(ov.get("keyframes"), list) else [],
                "crop": ov.get("crop") if isinstance(ov.get("crop"), dict) else None,
                "color": ov.get("color") if isinstance(ov.get("color"), dict) else None,
                "content_fit": str(ov.get("content_fit") or "fill"),
                "flip_horizontal": bool(ov.get("flip_horizontal")),
                "flip_vertical": bool(ov.get("flip_vertical")),
                "meta": ov.get("meta") if isinstance(ov.get("meta"), dict) else {},
            }
        )
    return out


def _all_overlay_clips_for_export(body: dict[str, Any], *, base_track_id: str | None = None) -> list[dict[str, Any]]:
    merged = _overlay_track_clips(body, base_track_id=base_track_id) + _schema_overlay_clips(body)
    # Items are composited sequentially. Preserve bottom-to-top track order;
    # sorting globally by start time would let a lower track cover a higher one.
    return merged


def _missing_file_assets_for_export(body: dict[str, Any], *, base_track_id: str | None = None) -> list[dict[str, str]]:
    """List unavailable uploaded assets that would affect an export."""
    _base_track_id, base_clips = _base_video_track_for_export(body)
    effective_base_track_id = base_track_id if base_track_id is not None else _base_track_id
    candidates: list[tuple[str, str]] = [
        ("video", str(clip.get("file_path") or "").strip())
        for clip in base_clips
        if _is_main_file_clip(clip)
    ]
    for clip in _all_overlay_clips_for_export(body, base_track_id=effective_base_track_id):
        if clip.get("type") == "text":
            text = clip.get("text") if isinstance(clip.get("text"), dict) else {}
            candidates.append(("font", str(text.get("font_file") or "").strip()))
        else:
            candidates.append(("overlay", str(clip.get("file_path") or "").strip()))
    candidates.extend(("audio", str(clip.get("file_path") or "").strip()) for clip in _audio_track_clips_for_export(body))
    bgm = _project_bgm_clip_for_export(body)
    if bgm:
        candidates.append(("bgm", str(bgm.get("file_path") or "").strip()))

    missing: list[dict[str, str]] = []
    seen: set[str] = set()
    for kind, raw_path in candidates:
        if not raw_path:
            continue
        path = Path(raw_path).expanduser()
        key = str(path)
        if not path.is_file() and key not in seen:
            seen.add(key)
            missing.append({"kind": kind, "name": path.name or raw_path, "path": raw_path})
    return missing


def _first_missing_file_asset_for_export(body: dict[str, Any], *, base_track_id: str | None = None) -> str | None:
    missing = _missing_file_assets_for_export(body, base_track_id=base_track_id)
    return missing[0]["name"] if missing else None


def _recorded_source_ids_for_export(body: dict[str, Any]) -> list[int]:
    base_track_id, base_clips = _base_video_track_for_export(body)
    clips = base_clips + _overlay_track_clips(body, base_track_id=base_track_id)
    return sorted(
        {
            int(c["source_id"])
            for c in clips
            if c.get("source_id") is not None and c.get("source_type") != "file"
        }
    )


def _resolve_overlay_clip_paths(
    overlay_clips: list[dict[str, Any]],
    clip_path_by_id: dict[int, Path],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for clip in overlay_clips:
        if str(clip.get("file_path") or "").strip():
            out.append(clip)
            continue
        sid = clip.get("source_id")
        if sid is None:
            out.append(clip)
            continue
        path = clip_path_by_id.get(int(sid))
        if path is None:
            raise MontageComposerError("MONTAGE_CLIP_FILE_MISSING", name=str(sid))
        out.append({**clip, "file_path": str(path)})
    return out


def _is_file_overlay_clip(clip: dict[str, Any]) -> bool:
    return clip.get("source_type") == "file" and bool(str(clip.get("file_path") or "").strip())


def _is_main_file_clip(clip: dict[str, Any]) -> bool:
    if clip.get("source_type") != "file":
        return False
    path = str(clip.get("file_path") or "").strip()
    return bool(path) and Path(path).suffix.lower() in _MAIN_VIDEO_EXT


def _is_audio_file_clip(clip: dict[str, Any]) -> bool:
    if clip.get("source_type") != "file":
        return False
    path = str(clip.get("file_path") or "").strip()
    meta = clip.get("meta") if isinstance(clip.get("meta"), dict) else {}
    return bool(path) and (Path(path).suffix.lower() in _AUDIO_EXT or meta.get("kind") == "audio")


def _is_recorded_timeline_clip(clip: dict[str, Any]) -> bool:
    if _is_file_overlay_clip(clip):
        return False
    return clip.get("source_id") is not None


def _v1_clips_sorted(body: dict[str, Any]) -> list[dict[str, Any]]:
    v1 = track_by_id(body, "v1")
    if isinstance(v1, dict) and v1.get("hidden"):
        return []
    clips = track_clips(v1)
    if isinstance(v1, dict):
        clips = [
            _clip_with_track_audio_gain(c, v1, force_muted=bool(v1.get("muted") or _has_solo_audio_tracks(body)))
            if isinstance(c, dict)
            else c
            for c in clips
        ]
    return sorted(clips, key=lambda c: float(c.get("timeline_start") or 0))


def _v1_recorded_clips_sorted(body: dict[str, Any]) -> list[dict[str, Any]]:
    """V1 主轨导出：仅 recorded_clip；file 贴纸走叠层合成。"""
    return [c for c in _v1_clips_sorted(body) if _is_recorded_timeline_clip(c)]


def _v1_main_clips_sorted(body: dict[str, Any]) -> list[dict[str, Any]]:
    return [c for c in _v1_clips_sorted(body) if _is_recorded_timeline_clip(c) or _is_main_file_clip(c)]


def _audio_track_clips_for_export(body: dict[str, Any]) -> list[dict[str, Any]]:
    tracks = body.get("tracks") if isinstance(body.get("tracks"), list) else []
    out: list[dict[str, Any]] = []
    solo_active = _has_solo_audio_tracks(body)
    for track in tracks:
        if (
            not isinstance(track, dict)
            or track.get("type") != "audio"
            or track.get("muted")
            or track.get("hidden")
            or (solo_active and not track.get("solo"))
        ):
            continue
        for clip in track.get("clips") or []:
            if isinstance(clip, dict) and _is_audio_file_clip(clip):
                out.append(_clip_with_track_audio_gain(clip, track))
    return sorted(out, key=lambda c: float(c.get("timeline_start") or 0))


def _resolve_audio_clip_paths(audio_clips: list[dict[str, Any]], clip_path_by_id: dict[int, Path]) -> list[dict[str, Any]]:
    """Resolve recorded layer sources to the same local file paths used for video export."""
    out: list[dict[str, Any]] = []
    for clip in audio_clips:
        raw_path = str(clip.get("file_path") or "").strip()
        if raw_path:
            out.append(clip)
            continue
        source_id = clip.get("source_id")
        if source_id is None:
            out.append(clip)
            continue
        path = clip_path_by_id.get(int(source_id))
        out.append({**clip, "file_path": str(path)} if path else clip)
    return out


def _project_bgm_clip_for_export(body: dict[str, Any]) -> dict[str, Any] | None:
    audio = body.get("audio") if isinstance(body.get("audio"), dict) else {}
    bgm = audio.get("bgm") if isinstance(audio.get("bgm"), dict) else None
    if not bgm:
        return None
    path = str(bgm.get("path") or "").strip()
    if not path:
        return None
    try:
        start_sec = max(TIMELINE_TIME_MIN, float(bgm.get("start_sec") or TIMELINE_TIME_DEFAULT))
    except (TypeError, ValueError):
        start_sec = TIMELINE_TIME_DEFAULT
    try:
        duration_sec = float(bgm.get("duration_sec") or 0)
    except (TypeError, ValueError):
        duration_sec = 0.0
    clip: dict[str, Any] = {
        "id": "project-bgm",
        "source_type": "file",
        "file_path": path,
        "timeline_start": start_sec,
        "trim_in": TIMELINE_TIME_DEFAULT,
        "volume": bgm.get("volume", AUDIO_BGM_GAIN_DEFAULT),
        "fade_in_sec": bgm.get("fade_in_sec", AUDIO_FADE_DURATION_DEFAULT),
        "fade_out_sec": bgm.get("fade_out_sec", AUDIO_FADE_DURATION_DEFAULT),
        "meta": {
            "kind": "audio",
            "name": bgm.get("name") or Path(path).name,
            "project_bgm": True,
            "ducking_enabled": bool(bgm.get("ducking_enabled")),
            "ducking_volume": bgm.get("ducking_volume", AUDIO_DUCKING_GAIN_DEFAULT),
        },
    }
    if bgm.get("asset_id") is not None:
        clip["meta"]["asset_id"] = bgm.get("asset_id")
    if duration_sec > 0:
        clip["meta"]["duration_sec"] = duration_sec
    return clip


def _timeline_gap_plan(clips: list[dict[str, Any]], epsilon: float = 0.001) -> list[tuple[int, float]] | None:
    """Return needed pre-clip gaps for a non-overlapping V1 timeline.

    ``None`` signals overlap, which keeps the existing transition compositor in charge.
    """
    cursor = 0.0
    gaps: list[tuple[int, float]] = []
    for index, clip in enumerate(clips):
        start = max(0.0, float(clip.get("timeline_start") or 0.0))
        if start < cursor - epsilon:
            return None
        if start > cursor + epsilon:
            gaps.append((index, start - cursor))
        cursor = max(cursor, start + _clip_timeline_duration_sec(clip))
    return gaps


def _timeline_overlap_pair(
    clips: list[dict[str, Any]], epsilon: float = 0.001
) -> tuple[str, str] | None:
    cursor = 0.0
    previous_id = ""
    for index, clip in enumerate(clips):
        start = max(0.0, float(clip.get("timeline_start") or 0.0))
        if start < cursor - epsilon:
            return previous_id or str(index - 1), str(clip.get("id") or index)
        cursor = max(cursor, start + _clip_timeline_duration_sec(clip))
        previous_id = str(clip.get("id") or index)
    return None
