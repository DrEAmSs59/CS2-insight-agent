"""LiteCut project, clip and timeline semantics."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from ..video_composer import MontageComposerError, _is_hard_cut, _parse_transition_for_edge

_TRANSITION_MAP = {
    "cut": "cut",
    "none": "none",
    "fade": "fade",
    "flash": "flash",
    "flashwhite": "flash",
    "dip": "dip_black",
    "dip_black": "dip_black",
    "black": "dip_black",
    "zoom": "zoom",
    "wipe_l": "wipe_l",
    "wipe_r": "wipe_r",
    "slide_left": "slide_left",
    "slide_right": "slide_right",
    "slide_up": "slide_up",
    "slide_down": "slide_down",
    "blur": "blur",
    "glitch": "glitch",
    "spin": "spin",
}

_MAIN_VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}
_AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}


def _map_transition_type(raw: str) -> str:
    t = str(raw or "cut").strip().lower()
    return _TRANSITION_MAP.get(t, "fade")


def _clip_duration_sec(clip: dict[str, Any]) -> float:
    trim_in = float(clip.get("trim_in") or 0)
    trim_out = clip.get("trim_out")
    if trim_out is not None:
        return max(0.1, float(trim_out) - trim_in)
    if clip.get("duration") is not None:
        return max(0.1, float(clip.get("duration") or 0) - trim_in)
    meta = clip.get("meta") if isinstance(clip.get("meta"), dict) else {}
    if meta.get("duration_sec") is not None:
        return max(0.1, float(meta["duration_sec"]) - trim_in)
    return 5.0


def _clip_speed(clip: dict[str, Any]) -> float:
    try:
        speed = float(clip.get("speed") or 1.0)
    except (TypeError, ValueError):
        speed = 1.0
    return max(0.25, min(4.0, speed))


def _clip_speed_keyframes(clip: dict[str, Any]) -> list[tuple[float, float]]:
    trim_in = max(0.0, float(clip.get("trim_in") or 0.0))
    trim_out = trim_in + _clip_duration_sec(clip)
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
        deduplicated.insert(0, (trim_in, _clip_speed(clip)))
    if deduplicated[-1][0] < trim_out - 1e-6:
        deduplicated.append((trim_out, deduplicated[-1][1]))
    return deduplicated


def _clip_speed_segments(clip: dict[str, Any]) -> list[tuple[float, float, float]]:
    trim_in = max(0.0, float(clip.get("trim_in") or 0.0))
    trim_out = trim_in + _clip_duration_sec(clip)
    points = _clip_speed_keyframes(clip)
    if not points:
        return [(trim_in, trim_out, _clip_speed(clip))]
    return [(left_t, right_t, speed) for (left_t, speed), (right_t, _) in zip(points[:-1], points[1:]) if right_t - left_t > 1e-6]


def _clip_has_speed_ramp(clip: dict[str, Any]) -> bool:
    return len(_clip_speed_keyframes(clip)) >= 2


def _clip_reverse(clip: dict[str, Any]) -> bool:
    return bool(clip.get("reverse"))


def _clip_freeze_frame_sec(clip: dict[str, Any]) -> float:
    try:
        freeze = float(clip.get("freeze_frame_sec") or 0.0)
    except (TypeError, ValueError):
        freeze = 0.0
    return max(0.0, min(30.0, freeze))


def _clip_preserve_pitch(clip: dict[str, Any]) -> bool:
    return clip.get("preserve_pitch") is not False


def _clip_canvas_fit(clip: dict[str, Any], fallback: str = "contain") -> str:
    raw = str(clip.get("canvas_fit") or "").strip().lower()
    if raw in {"contain", "cover", "blur"}:
        return raw
    fit = str(fallback or "contain").strip().lower()
    return fit if fit in {"contain", "cover", "blur"} else "contain"


def _clip_crop_filter(clip: dict[str, Any]) -> str:
    crop = clip.get("crop") if isinstance(clip.get("crop"), dict) else None
    if not crop:
        return ""
    try:
        width = float(crop.get("width", 1))
        height = float(crop.get("height", 1))
        x = float(crop.get("x", 0))
        y = float(crop.get("y", 0))
    except (TypeError, ValueError):
        return ""
    width = max(0.05, min(1.0, width))
    height = max(0.05, min(1.0, height))
    x = max(0.0, min(1.0 - width, x))
    y = max(0.0, min(1.0 - height, y))
    if width >= 0.9999 and height >= 0.9999:
        return ""
    return f"crop=iw*{width:.6f}:ih*{height:.6f}:iw*{x:.6f}:ih*{y:.6f}"


def _clip_volume(clip: dict[str, Any]) -> float:
    if clip.get("muted"):
        return 0.0
    try:
        volume = float(clip.get("volume") if clip.get("volume") is not None else 1.0)
    except (TypeError, ValueError):
        volume = 1.0
    return max(0.0, min(5.0, volume))


def _clip_audio_keyframes(clip: dict[str, Any]) -> list[tuple[float, float]]:
    duration = _clip_timeline_duration_sec(clip)
    points: list[tuple[float, float]] = []
    for keyframe in clip.get("audio_keyframes") or []:
        if not isinstance(keyframe, dict):
            continue
        try:
            time_sec = max(0.0, min(duration, float(keyframe.get("time_sec") or 0.0)))
            volume = max(0.0, min(5.0, float(keyframe.get("volume"))))
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
    points = _clip_audio_keyframes(clip)
    if not points:
        return f"volume={_clip_volume(clip):.6f}"
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
    return f"volume='{expression}':eval=frame"


def _project_master_volume(body: dict[str, Any]) -> float:
    audio = body.get("audio") if isinstance(body.get("audio"), dict) else {}
    try:
        volume = float(audio.get("master_volume") if audio.get("master_volume") is not None else 1.0)
    except Exception:
        volume = 1.0
    return max(0.0, min(2.0, volume))


def _project_output_settings(body: dict[str, Any], ref: dict[str, Any]) -> tuple[int, int, float]:
    output = body.get("output") if isinstance(body.get("output"), dict) else {}

    def _int_setting(key: str, fallback: int, lo: int, hi: int) -> int:
        try:
            value = int(output.get(key) if output.get(key) is not None else fallback)
        except (TypeError, ValueError):
            value = fallback
        return max(lo, min(hi, value))

    def _fps_setting(fallback: float) -> float:
        try:
            value = float(output.get("fps") if output.get("fps") is not None else fallback)
        except (TypeError, ValueError):
            value = fallback
        return max(1.0, min(240.0, value))

    fallback_w = int(ref.get("width") or 1920)
    fallback_h = int(ref.get("height") or 1080)
    fallback_fps = float(ref.get("fps") or 60)
    width = _int_setting("width", fallback_w, 320, 7680)
    height = _int_setting("height", fallback_h, 180, 4320)
    fps = _fps_setting(fallback_fps)
    return width, height, fps


def _project_encoder_tier(body: dict[str, Any]) -> str:
    output = body.get("output") if isinstance(body.get("output"), dict) else {}
    return "fast" if str(output.get("encoder_tier") or "").strip().lower() == "fast" else "quality"


def _ffmpeg_color(value: Any) -> str:
    raw = str(value or "").strip()
    if raw.startswith("#"):
        raw = raw[1:]
    if len(raw) in (3, 6) and all(c in "0123456789abcdefABCDEF" for c in raw):
        if len(raw) == 3:
            raw = "".join(c * 2 for c in raw)
        return f"0x{raw.lower()}"
    return "black"


def _project_canvas_settings(body: dict[str, Any]) -> tuple[str, str, int]:
    output = body.get("output") if isinstance(body.get("output"), dict) else {}
    fit = str(output.get("canvas_fit") or "contain").strip().lower()
    if fit not in {"contain", "cover", "blur"}:
        fit = "contain"
    try:
        blur_amount = int(output.get("blur_amount") if output.get("blur_amount") is not None else 24)
    except (TypeError, ValueError):
        blur_amount = 24
    return fit, _ffmpeg_color(output.get("background_color")), max(4, min(80, blur_amount))


def _project_export_range(body: dict[str, Any]) -> tuple[float, Optional[float]]:
    output = body.get("output") if isinstance(body.get("output"), dict) else {}
    if str(output.get("range_mode") or "full").strip().lower() != "custom":
        return 0.0, None
    try:
        start_sec = float(output.get("range_start_sec") or 0.0)
    except (TypeError, ValueError):
        start_sec = 0.0
    start_sec = max(0.0, start_sec)

    end_sec: Optional[float] = None
    raw_end = output.get("range_end_sec")
    if raw_end is not None:
        try:
            parsed_end = float(raw_end)
            if parsed_end > start_sec + 0.05:
                end_sec = parsed_end
        except (TypeError, ValueError):
            end_sec = None
    if start_sec <= 0.0 and end_sec is None:
        return 0.0, None
    return start_sec, end_sec


def _clip_audio_fade(clip: dict[str, Any], key: str) -> float:
    try:
        fade = float(clip.get(key) or 0.0)
    except (TypeError, ValueError):
        fade = 0.0
    duration = _clip_duration_sec(clip)
    return max(0.0, min(duration, fade))


def _clip_visual_fade(clip: dict[str, Any], key: str) -> float:
    try:
        fade = float(clip.get(key) or 0.0)
    except (TypeError, ValueError):
        fade = 0.0
    duration = _clip_duration_sec(clip)
    return max(0.0, min(duration, fade))


def _clip_timeline_duration_sec(clip: dict[str, Any]) -> float:
    duration = sum((end - start) / speed for start, end, speed in _clip_speed_segments(clip))
    return max(0.1, duration) + _clip_freeze_frame_sec(clip)


def _clip_video_fade(clip: dict[str, Any], key: str) -> float:
    try:
        fade = float(clip.get(key) or 0.0)
    except (TypeError, ValueError):
        fade = 0.0
    return max(0.0, min(_clip_timeline_duration_sec(clip), fade))


def _track_main_video_clips(track: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        c
        for c in (track.get("clips") or [])
        if isinstance(c, dict) and (_is_recorded_timeline_clip(c) or _is_main_file_clip(c))
    ]


def _has_solo_audio_tracks(body: dict[str, Any]) -> bool:
    tracks = body.get("tracks") if isinstance(body.get("tracks"), list) else []
    return any(isinstance(track, dict) and track.get("type") == "audio" and track.get("solo") for track in tracks)


def _track_volume(track: dict[str, Any]) -> float:
    try:
        volume = float(track.get("volume") if track.get("volume") is not None else 1.0)
    except (TypeError, ValueError):
        volume = 1.0
    return max(0.0, min(2.0, volume))


def _clip_with_track_audio_gain(clip: dict[str, Any], track: dict[str, Any], *, force_muted: bool = False) -> dict[str, Any]:
    gain = _track_volume(track)
    out = {**clip, "volume": _clip_volume(clip) * gain}
    if force_muted or track.get("muted"):
        out["muted"] = True
    keyframes = clip.get("audio_keyframes")
    if isinstance(keyframes, list):
        scaled_keyframes: list[dict[str, Any]] = []
        for point in keyframes:
            if not isinstance(point, dict):
                continue
            try:
                volume = float(point.get("volume") or 0.0)
            except (TypeError, ValueError):
                volume = 0.0
            scaled_keyframes.append({**point, "volume": max(0.0, min(2.0, volume * gain))})
        out["audio_keyframes"] = scaled_keyframes
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
                    "type": "text",
                    "timeline_start": float(ov.get("timeline_start") or 0),
                    "trim_in": 0,
                    "trim_out": dur,
                    "duration": dur,
                    "fade_in_sec": float(ov.get("fade_in_sec") or 0),
                    "fade_out_sec": float(ov.get("fade_out_sec") or 0),
                    "transition_in": ov.get("transition_in") if isinstance(ov.get("transition_in"), dict) else None,
                    "transition_out": ov.get("transition_out") if isinstance(ov.get("transition_out"), dict) else None,
                    "transform": ov.get("transform") if isinstance(ov.get("transform"), dict) else None,
                    "keyframes": ov.get("keyframes") if isinstance(ov.get("keyframes"), list) else [],
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
                "type": "file",
                "file_path": path,
                "timeline_start": float(ov.get("timeline_start") or 0),
                "trim_in": trim_in,
                "trim_out": trim_in + dur,
                "duration": dur,
                "fade_in_sec": float(ov.get("fade_in_sec") or 0),
                "fade_out_sec": float(ov.get("fade_out_sec") or 0),
                "transition_in": ov.get("transition_in") if isinstance(ov.get("transition_in"), dict) else None,
                "transition_out": ov.get("transition_out") if isinstance(ov.get("transition_out"), dict) else None,
                "transform": ov.get("transform") if isinstance(ov.get("transform"), dict) else None,
                "keyframes": ov.get("keyframes") if isinstance(ov.get("keyframes"), list) else [],
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
    tracks = body.get("tracks") if isinstance(body.get("tracks"), list) else []
    v1 = next((t for t in tracks if isinstance(t, dict) and t.get("id") == "v1"), None)
    if isinstance(v1, dict) and v1.get("hidden"):
        return []
    clips = list(v1.get("clips") or []) if isinstance(v1, dict) else []
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


def _video_layer_audio_clips_for_export(body: dict[str, Any], *, base_track_id: str | None = None) -> list[dict[str, Any]]:
    """Collect original audio from visible video layers above the base track."""
    tracks = body.get("tracks") if isinstance(body.get("tracks"), list) else []
    if base_track_id is None:
        base_track_id = _base_video_track_for_export(body)[0]
    solo_active = _has_solo_audio_tracks(body)
    base_index = next((index for index, track in enumerate(tracks) if isinstance(track, dict) and str(track.get("id") or "") == str(base_track_id or "")), len(tracks))
    out: list[dict[str, Any]] = []
    for track in tracks[:base_index]:
        if not isinstance(track, dict) or track.get("hidden"):
            continue
        ttype = track.get("type")
        if ttype not in (None, "video"):
            continue
        track_id = str(track.get("id") or "")
        if ttype is None and track_id in ("overlay", "a1", "a2"):
            continue
        for clip in track.get("clips") or []:
            if not isinstance(clip, dict) or not (_is_recorded_timeline_clip(clip) or _is_main_file_clip(clip)):
                continue
            out.append(_clip_with_track_audio_gain(clip, track, force_muted=solo_active))
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
        start_sec = max(0.0, float(bgm.get("start_sec") or 0))
    except (TypeError, ValueError):
        start_sec = 0.0
    try:
        duration_sec = float(bgm.get("duration_sec") or 0)
    except (TypeError, ValueError):
        duration_sec = 0.0
    clip: dict[str, Any] = {
        "id": "project-bgm",
        "source_type": "file",
        "file_path": path,
        "timeline_start": start_sec,
        "trim_in": 0,
        "volume": bgm.get("volume", 1.0),
        "fade_in_sec": bgm.get("fade_in_sec", 0.0),
        "fade_out_sec": bgm.get("fade_out_sec", 0.0),
        "meta": {
            "kind": "audio",
            "name": bgm.get("name") or Path(path).name,
            "project_bgm": True,
            "ducking_enabled": bool(bgm.get("ducking_enabled")),
            "ducking_volume": bgm.get("ducking_volume", 0.35),
        },
    }
    if bgm.get("asset_id") is not None:
        clip["meta"]["asset_id"] = bgm.get("asset_id")
    if duration_sec > 0:
        clip["meta"]["duration_sec"] = duration_sec
    return clip


def _build_transitions(clips: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for clip in clips:
        sid = clip.get("source_id")
        if sid is None:
            continue
        tr = clip.get("transition_out")
        if not isinstance(tr, dict):
            continue
        t_type = _map_transition_type(str(tr.get("type") or "cut"))
        try:
            d = float(tr.get("duration_sec", 0.4))
        except (TypeError, ValueError):
            d = 0.4
        out[str(int(sid))] = {"type": t_type, "duration": d}
    return out


def _build_positional_transitions(clips: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for i, clip in enumerate(clips[:-1]):
        incoming = clips[i + 1].get("transition_in")
        tr = incoming if isinstance(incoming, dict) else clip.get("transition_out")
        if not isinstance(tr, dict):
            continue
        t_type = _map_transition_type(str(tr.get("type") or "cut"))
        try:
            d = float(tr.get("duration_sec", 0.4))
        except (TypeError, ValueError):
            d = 0.4
        out[str(i)] = {"type": t_type, "duration": d}
    return out


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


def _has_soft_positional_transition(clips: list[dict[str, Any]], transitions: dict[str, Any], fps: float) -> bool:
    for index in range(max(0, len(clips) - 1)):
        t_type, duration = _parse_transition_for_edge(transitions, index)
        if not _is_hard_cut(t_type, duration, fps):
            return True
    return False
