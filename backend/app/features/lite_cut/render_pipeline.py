"""Multi-stage FFmpeg execution pipeline for LiteCut exports."""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Optional, Sequence

from .ffmpeg_runtime import (
    ProgressCallback,
    emit_progress as _emit_progress,
    raise_if_cancelled as _raise_if_cancelled,
    run_ffmpeg_process as _run_ffmpeg_process,
)
from .graph_builders import (
    build_audio_mix_graph as _audio_mix_filter_complex,
    build_boundary_transition_graph as _boundary_transition_filter_complex,
    build_clip_canvas_graph as _clip_canvas_transform_graph,
    build_clip_video_filter_chain as _clip_video_filter_chain,
    build_text_overlay_graph as _drawtext_filter_complex,
    build_equalizer_filter as _eq_filter,
    build_overlay_graph as _overlay_filter_complex,
    stage_custom_font_for_ffmpeg as _stage_custom_font_for_ffmpeg,
)
from .export_plan import build_lite_cut_export_plan
from .project_boundaries import AUDIO_MASTER_GAIN_DEFAULT, AUDIO_MASTER_GAIN_MAX, AUDIO_MASTER_GAIN_MIN
from .timeline import (
    _all_overlay_clips_for_export,
    _audio_track_clips_for_export,
    _base_video_track_for_export,
    _clip_crop_filter,
    _first_missing_file_asset_for_export,
    _has_solo_audio_tracks,
    _is_main_file_clip,
    _project_bgm_clip_for_export,
    _resolve_audio_clip_paths,
    _resolve_overlay_clip_paths,
    _timeline_gap_plan,
)
from .export_projection import (
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
    clip_reverse as _clip_reverse,
    clip_speed as _clip_speed,
    clip_speed_segments as _clip_speed_segments,
    clip_timeline_duration_sec as _clip_timeline_duration_sec,
)
from .media_policy import is_looping_animation_path
from ...video_composer import (
    MontageComposerError,
    _is_hard_cut,
    _parse_transition_for_edge,
    ffprobe_streams,
    probe_video_audio_summary,
    resolve_ffprobe_binary,
    validate_output_path,
)
from ...montage_encoder import (
    apply_encoder_device_args,
    available_h264_encoders,
    ffmpeg_encoder_identity,
    h264_encode_cli_args,
    raise_hardware_encoder_failure,
)
from ...montage_exceptions import HardwareEncoderFailure
from ...ffmpeg_compatibility import add_ffmpeg_compatibility_hint
from ...video_export_log import export_event, export_gpu_inventory
from ...framemeld import (
    FrameMeldRifeDevicePlan,
    build_framemeld_command,
    framemeld_execution_policy,
    framemeld_failure_from_result,
    log_framemeld_diagnostic_events,
    framemeld_sources_are_compatible,
    framemeld_working_fps,
    parse_framemeld_status_events,
    plan_framemeld_rife_device,
    probe_framemeld,
    record_framemeld_rife_result,
)

logger = logging.getLogger(__name__)


def _webm_has_alpha(path: Path, ffprobe: Path) -> bool:
    if path.suffix.lower() != ".webm":
        return False
    try:
        data = ffprobe_streams(
            path,
            ffprobe,
            "lite_cut_overlay_source_probe",
            "source",
        )
    except Exception:
        return False
    for stream in data.get("streams") or []:
        if not isinstance(stream, dict) or str(stream.get("codec_type") or "") != "video":
            continue
        tags = stream.get("tags") if isinstance(stream.get("tags"), dict) else {}
        if str(tags.get("alpha_mode") or tags.get("ALPHA_MODE") or "").strip() == "1":
            return True
    return False


def _overlay_video_decoder_args(path: Path, ffprobe: Path) -> list[str]:
    # FFmpeg's native VP9 decoder can discard the alpha plane from WebM.
    return ["-c:v", "libvpx-vp9"] if _webm_has_alpha(path, ffprobe) else []


def _is_looping_animation_file(path: Path) -> bool:
    return is_looping_animation_path(path)


def _visual_event_window(clip: dict[str, Any], start: float, end: float) -> tuple[float, float]:
    events = clip.get("_transition_events") if isinstance(clip.get("_transition_events"), list) else []
    return (
        min([start, *(float(event.get("start_sec") or start) for event in events if isinstance(event, dict))]),
        max([end, *(float(event.get("end_sec") or end) for event in events if isinstance(event, dict))]),
    )


def _visual_enable_window(clip: dict[str, Any], start: float, end: float) -> tuple[float, float]:
    if not clip.get("_transition_projection_only"):
        return _visual_event_window(clip, start, end)
    events = clip.get("_transition_events") if isinstance(clip.get("_transition_events"), list) else []
    starts = [float(event.get("start_sec") or start) for event in events if isinstance(event, dict)]
    ends = [float(event.get("end_sec") or end) for event in events if isinstance(event, dict)]
    return (min(starts), max(ends)) if starts and ends else (start, end)


def _composite_overlays_on_base(
    *,
    ffmpeg_bin: Path,
    ffprobe: Path,
    base_mp4: Path,
    overlay_clips: list[dict[str, Any]],
    out_mp4: Path,
    video_encode_quality: list[str],
    blur_amount: int = 24,
    progress_callback: ProgressCallback | None = None,
    cancel_event: Any | None = None,
    progress_start: float = 0.70,
    progress_end: float = 0.84,
) -> None:
    """Burn V2–V5 file overlays onto V1 base (images + alpha-friendly video)."""
    import shutil

    if not overlay_clips:
        shutil.copy2(base_mp4, out_mp4)
        return

    current = base_mp4
    # Intermediate overlay passes belong beside the temporary base file, not
    # beside the user's final export.  Using out_mp4.parent leaked ov_step_*.mp4
    # into the chosen export directory whenever more than one overlay existed.
    work_dir = base_mp4.parent
    still_ext = {".png", ".jpg", ".jpeg", ".webp"}

    for i, clip in enumerate(overlay_clips):
        _raise_if_cancelled(cancel_event)
        staged_font_path: Path | None = None
        overlay_label = str(clip.get("file_path") or clip.get("type") or f"overlay-{i}")
        start = max(0.0, float(clip.get("timeline_start") or 0))
        clip_is_video_overlay = clip.get("type") != "text" and str(clip.get("file_path") or "").strip()
        source_dur = _clip_duration_sec(clip)
        dur = _clip_timeline_duration_sec(clip) if clip_is_video_overlay else source_dur
        end = start + dur
        is_last = i == len(overlay_clips) - 1
        step_out = out_mp4 if is_last else work_dir / f"ov_step_{i:03d}.mp4"

        base_info = probe_video_audio_summary(
            current,
            ffprobe,
            "lite_cut_overlay_base_probe",
            "intermediate",
        )
        render_start, render_end = _visual_enable_window(clip, start, end)
        total = max(float(base_info.get("duration") or 0), render_end, 0.1)

        if clip.get("type") == "text":
            enable = f"between(t,{render_start:.4f},{render_end:.4f})"
            export_text_clip = clip
            text_config = clip.get("text") if isinstance(clip.get("text"), dict) else {}
            custom_font_file = str(text_config.get("font_file") or "").strip()
            if custom_font_file:
                try:
                    staged_font_path = _stage_custom_font_for_ffmpeg(custom_font_file)
                except (OSError, UnicodeError) as exc:
                    logger.error("lite_cut could not stage custom font for FFmpeg: %s", exc)
                    raise MontageComposerError("MONTAGE_EXPORT_FAILED") from exc
                export_text_clip = {
                    **clip,
                    "text": {**text_config, "font_file": str(staged_font_path)},
                }
            fc = _drawtext_filter_complex(
                text_clip=export_text_clip,
                enable_expr=enable,
                canvas_width=int(base_info.get("width") or 1920),
                canvas_height=int(base_info.get("height") or 1080),
                fps=float(base_info.get("fps") or 60.0),
            )
            cmd = [
                str(ffmpeg_bin),
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(current),
                "-filter_complex",
                fc,
                "-map",
                "[vout]",
                "-map",
                "0:a?",
                *video_encode_quality,
                "-c:a",
                "copy",
                str(step_out),
            ]
        else:
            fp = Path(str(clip.get("file_path") or "")).expanduser().resolve()
            if not fp.is_file():
                logger.warning("lite_cut overlay missing: %s", fp)
                continue

            if fp.suffix.lower() in still_ext and not _is_looping_animation_file(fp):
                tr = clip.get("transform") if isinstance(clip.get("transform"), dict) else {}
                render_start, render_end = _visual_enable_window(clip, start, end)
                enable = f"between(t,{render_start:.4f},{render_end:.4f})"
                fc = _overlay_filter_complex(
                    enable_expr=enable,
                    timeline_start=start,
                    duration=dur,
                    transform=tr,
                    content_fit=str(clip.get("content_fit") or "fill"),
                    blur_amount=blur_amount,
                    video_input=False,
                    flip_horizontal=bool(clip.get("flip_horizontal")),
                    flip_vertical=bool(clip.get("flip_vertical")),
                    keyframes=clip.get("keyframes"),
                    source_filters=[item for item in (_clip_crop_filter(clip), _eq_filter(clip.get("color") if isinstance(clip.get("color"), dict) else None)) if item],
                    reverse=_clip_reverse(clip),
                    freeze_frame_sec=_clip_freeze_frame_sec(clip),
                    canvas_width=int(base_info.get("width") or 1920),
                    canvas_height=int(base_info.get("height") or 1080),
                    transition_events=clip.get("_transition_events"),
                )
                cmd = [
                    str(ffmpeg_bin),
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    str(current),
                    "-loop",
                    "1",
                    "-framerate",
                    f"{max(1.0, min(1000.0, float(base_info.get('fps') or 60.0))):.6f}",
                    "-t",
                    f"{total:.4f}",
                    "-i",
                    str(fp),
                    "-filter_complex",
                    fc,
                    "-map",
                    "[vout]",
                    "-map",
                    "0:a?",
                    *video_encode_quality,
                    "-c:a",
                    "copy",
                    str(step_out),
                ]
            else:
                tr = clip.get("transform") if isinstance(clip.get("transform"), dict) else {}
                render_start, render_end = _visual_enable_window(clip, start, end)
                enable = f"between(t,{render_start:.4f},{render_end:.4f})"
                fc = _overlay_filter_complex(
                    enable_expr=enable,
                    timeline_start=start,
                    duration=dur,
                    transform=tr,
                    content_fit=str(clip.get("content_fit") or "fill"),
                    blur_amount=blur_amount,
                    video_input=True,
                    speed=_clip_speed(clip),
                    flip_horizontal=bool(clip.get("flip_horizontal")),
                    flip_vertical=bool(clip.get("flip_vertical")),
                    keyframes=clip.get("keyframes"),
                    source_filters=[item for item in (_clip_crop_filter(clip), _eq_filter(clip.get("color") if isinstance(clip.get("color"), dict) else None)) if item],
                    reverse=_clip_reverse(clip),
                    freeze_frame_sec=_clip_freeze_frame_sec(clip),
                    speed_segments=[(a - float(clip.get("trim_in") or 0), b - float(clip.get("trim_in") or 0), s) for a, b, s in _clip_speed_segments(clip)] if _clip_has_speed_ramp(clip) else None,
                    canvas_width=int(base_info.get("width") or 1920),
                    canvas_height=int(base_info.get("height") or 1080),
                    transition_events=clip.get("_transition_events"),
                )
                cmd = [
                    str(ffmpeg_bin),
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    str(current),
                    *_overlay_video_decoder_args(fp, ffprobe),
                    *( ["-stream_loop", "-1"] if _is_looping_animation_file(fp) else [] ),
                    "-ss",
                    f"{float(clip.get('trim_in') or 0):.4f}",
                    "-t",
                    f"{source_dur:.4f}",
                    "-i",
                    str(fp),
                    "-filter_complex",
                    fc,
                    "-map",
                    "[vout]",
                    "-map",
                    "0:a?",
                    *video_encode_quality,
                    "-c:a",
                    "copy",
                    str(step_out),
                ]

        previous = current
        try:
            r = _run_ffmpeg_process(cmd, timeout=3600, cancel_event=cancel_event)
        finally:
            if staged_font_path is not None:
                try:
                    staged_font_path.unlink(missing_ok=True)
                except OSError:
                    logger.debug("lite_cut could not remove staged custom font: %s", staged_font_path, exc_info=True)
        if r.returncode != 0:
            tail = (r.stderr or r.stdout or "").strip()[-600:]
            logger.error("lite_cut overlay composite failed %s: %s", overlay_label, tail)
            raise_hardware_encoder_failure(
                cmd,
                r,
                stage="lite_cut_overlay",
                artifact_path=step_out,
                public_code="MONTAGE_EXPORT_FAILED",
            )
            raise MontageComposerError("MONTAGE_EXPORT_FAILED")
        current = step_out
        if previous != base_mp4 and previous.parent == work_dir and previous.name.startswith("ov_step_"):
            try:
                previous.unlink(missing_ok=True)
            except OSError:
                logger.debug("lite_cut could not remove completed overlay step: %s", previous, exc_info=True)
        span = max(0.0, progress_end - progress_start)
        _emit_progress(
            progress_callback,
            progress_start + span * ((i + 1) / max(1, len(overlay_clips))),
            "overlays",
        )


def _mix_audio_tracks_on_base(
    *,
    ffmpeg_bin: Path,
    ffprobe: Path,
    base_mp4: Path,
    audio_clips: list[dict[str, Any]],
    out_mp4: Path,
    master_volume: float = AUDIO_MASTER_GAIN_DEFAULT,
    cancel_event: Any | None = None,
) -> None:
    _raise_if_cancelled(cancel_event)
    master_volume = max(AUDIO_MASTER_GAIN_MIN, min(AUDIO_MASTER_GAIN_MAX, float(master_volume)))
    base_info = probe_video_audio_summary(
        base_mp4,
        ffprobe,
        "lite_cut_audio_base_probe",
        "intermediate",
    )
    try:
        base_duration = max(0.0, float(base_info.get("duration") or 0.0))
    except (TypeError, ValueError):
        base_duration = 0.0
    if not audio_clips:
        import shutil

        shutil.copy2(base_mp4, out_mp4)
        return

    existing: list[tuple[dict[str, Any], Path]] = []
    for clip in audio_clips:
        fp = Path(str(clip.get("file_path") or "")).expanduser().resolve()
        if fp.is_file():
            existing.append((clip, fp))
        else:
            logger.warning("lite_cut audio missing: %s", fp)
    if not existing:
        import shutil

        shutil.copy2(base_mp4, out_mp4)
        return

    filter_complex = _audio_mix_filter_complex(
        has_base_audio=False,
        audio_clips=[clip for clip, _fp in existing],
        master_volume=master_volume,
    )
    if not filter_complex:
        import shutil

        shutil.copy2(base_mp4, out_mp4)
        return

    cmd = [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(base_mp4),
    ]
    for clip, fp in existing:
        # Keep source timing in the filter graph.  Passing -ss here as well
        # would make atrim (and speed-ramp segment ranges) apply to an already
        # trimmed input, shifting every non-zero trim_in clip a second time.
        cmd.extend(["-i", str(fp)])
    cmd.extend(
        [
            "-filter_complex",
            filter_complex,
            "-map",
            "0:v:0",
            "-map",
            "[mixa]",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-ac",
            "2",
        ]
    )
    if base_duration > 0.05:
        # The video timeline is authoritative.  ``-shortest`` truncates a
        # silent base video when an added audio clip ends before the picture.
        cmd.extend(["-t", f"{base_duration:.6f}"])
    else:
        # Generated LiteCut bases normally have a probeable duration. Keep a
        # bounded fallback for malformed/legacy intermediates.
        cmd.append("-shortest")
    cmd.append(str(out_mp4))
    r = _run_ffmpeg_process(cmd, timeout=3600, cancel_event=cancel_event)
    if r.returncode != 0:
        tail = (r.stderr or r.stdout or "").strip()[-600:]
        logger.error("lite_cut audio mix failed: %s", tail)
        raise MontageComposerError("MONTAGE_EXPORT_FAILED")


def _trim_final_export_range(
    *,
    ffmpeg_bin: Path,
    src_mp4: Path,
    out_mp4: Path,
    start_sec: float,
    end_sec: Optional[float],
    video_encode_quality: list[str],
    cancel_event: Any | None = None,
) -> None:
    _raise_if_cancelled(cancel_event)
    start_sec = max(0.0, float(start_sec or 0.0))
    duration = None
    if end_sec is not None:
        duration = max(0.05, float(end_sec) - start_sec)
    cmd = [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{start_sec:.6f}",
        "-i",
        str(src_mp4),
    ]
    if duration is not None:
        cmd.extend(["-t", f"{duration:.6f}"])
    cmd.extend(
        [
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            *video_encode_quality,
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            str(out_mp4),
        ]
    )
    r = _run_ffmpeg_process(cmd, timeout=3600, cancel_event=cancel_event)
    if r.returncode != 0:
        tail = (r.stderr or r.stdout or "").strip()[-600:]
        logger.error("lite_cut range trim failed: %s", tail)
        raise_hardware_encoder_failure(
            cmd,
            r,
            stage="lite_cut_range",
            artifact_path=out_mp4,
            public_code="MONTAGE_EXPORT_FAILED",
        )
        raise MontageComposerError("MONTAGE_EXPORT_FAILED")


def _lite_cut_gap_to_ts(
    *,
    ffmpeg_bin: Path,
    out_ts: Path,
    duration: float,
    width: int,
    height: int,
    fps: float,
    background_color: str,
    video_encode_quality: list[str],
    cancel_event: Any | None = None,
) -> None:
    _raise_if_cancelled(cancel_event)
    safe_duration = max(0.02, float(duration))
    fps_s = f"{fps:.4f}".rstrip("0").rstrip(".")
    cmd = [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        f"color=c={background_color}:s={width}x{height}:r={fps_s}:d={safe_duration:.6f}",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-t",
        f"{safe_duration:.6f}",
        *video_encode_quality,
        "-c:a",
        "pcm_s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        str(out_ts),
    ]
    result = _run_ffmpeg_process(cmd, timeout=3600, cancel_event=cancel_event)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip()[-600:]
        logger.error("lite_cut gap render failed: %s", tail)
        raise_hardware_encoder_failure(
            cmd,
            result,
            stage="lite_cut_gap",
            artifact_path=out_ts,
            public_code="MONTAGE_EXPORT_FAILED",
        )
        raise MontageComposerError("MONTAGE_EXPORT_FAILED")


def _lite_cut_boundary_transition_to_ts(
    *,
    ffmpeg_bin: Path,
    ffprobe: Path,
    previous_ts: Path,
    next_ts: Path,
    transition_type: str,
    transition_duration: float,
    fps: float,
    out_ts: Path,
    video_encode_quality: list[str],
    cancel_event: Any | None = None,
) -> None:
    _raise_if_cancelled(cancel_event)
    previous_info = probe_video_audio_summary(
        previous_ts,
        ffprobe,
        "lite_cut_transition_input_probe",
        "intermediate",
    )
    next_info = probe_video_audio_summary(
        next_ts,
        ffprobe,
        "lite_cut_transition_input_probe",
        "intermediate",
    )
    previous_duration = max(0.1, float(previous_info.get("duration") or 0.1))
    next_duration = max(0.1, float(next_info.get("duration") or 0.1))
    filter_complex = _boundary_transition_filter_complex(
        transition_type=transition_type,
        duration=transition_duration,
        previous_duration=previous_duration,
        next_duration=next_duration,
        fps=fps,
        previous_has_audio=bool(previous_info.get("has_audio")),
        next_has_audio=bool(next_info.get("has_audio")),
    )
    cmd = [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(previous_ts),
        "-i",
        str(next_ts),
        "-filter_complex",
        filter_complex,
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        *video_encode_quality,
        "-c:a",
        "pcm_s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        str(out_ts),
    ]
    result = _run_ffmpeg_process(cmd, timeout=7200, cancel_event=cancel_event)
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or "").strip()[-900:]
        logger.error("lite_cut boundary transition failed: %s", tail)
        raise_hardware_encoder_failure(
            cmd,
            result,
            stage="lite_cut_transition",
            artifact_path=out_ts,
            public_code="MONTAGE_TRANSITION_FAILED",
        )
        raise MontageComposerError("MONTAGE_TRANSITION_FAILED")


def _lite_cut_clip_to_ts(
    *,
    ffmpeg_bin: Path,
    src: Path,
    out_ts: Path,
    clip: dict[str, Any],
    width: int,
    height: int,
    fps: float,
    canvas_fit: str,
    background_color: str,
    blur_amount: int,
    video_encode_quality: list[str],
    cancel_event: Any | None = None,
) -> None:
    _raise_if_cancelled(cancel_event)
    trim_in = max(0.0, float(clip.get("trim_in") or 0))
    source_duration = _clip_duration_sec(clip)
    timeline_duration = _clip_timeline_duration_sec(clip)
    speed = _clip_speed(clip)
    ramped = _clip_has_speed_ramp(clip)
    visual_clip = {**clip, "speed": 1.0, "speed_keyframes": []} if ramped else {**clip}
    timeline_start = max(0.0, float(clip.get("timeline_start") or 0.0))
    visual_clip["_transition_events"] = [
        {
            **event,
            "start_sec": float(event.get("start_sec") or 0.0) - timeline_start,
            "end_sec": float(event.get("end_sec") or 0.0) - timeline_start,
            "cut_sec": float(event.get("cut_sec") or 0.0) - timeline_start,
        }
        for event in clip.get("_transition_events") or []
        if isinstance(event, dict) and event.get("mode") != "boundary"
    ]
    vf = _clip_video_filter_chain(
        visual_clip,
        width=width,
        height=height,
        fps=fps,
        canvas_fit=canvas_fit,
        background_color=background_color,
        blur_amount=blur_amount,
        timeline_duration_override=timeline_duration if ramped else None,
    )
    content_fit = _clip_canvas_fit(clip, canvas_fit)

    cmd = [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{trim_in:.6f}",
        "-t",
        f"{source_duration:.6f}",
        "-i",
        str(src),
    ]
    if ramped:
        graph_parts: list[str] = []
        video_labels: list[str] = []
        for index, (start, end, segment_speed) in enumerate(_clip_speed_segments(clip)):
            label = f"[rv{index}]"
            video_labels.append(label)
            graph_parts.append(
                f"[0:v]trim=start={start - trim_in:.6f}:end={end - trim_in:.6f},setpts=PTS-STARTPTS,setpts=PTS/{segment_speed:.6f}{label}"
            )
        graph_parts.append("".join(video_labels) + f"concat=n={len(video_labels)}:v=1:a=0[rampv]")
        graph_parts.append(_clip_canvas_transform_graph(
            "[rampv]", "[vout]", clip=visual_clip, source_filter=vf,
            content_fit=content_fit, width=width, height=height, fps=fps,
            duration=timeline_duration, background_color=background_color,
            blur_amount=blur_amount,
        ))
        graph_parts.append(
            f"anullsrc=r=48000:cl=stereo,atrim=0:{timeline_duration:.6f},asetpts=PTS-STARTPTS[aout]"
        )
        cmd.extend(["-filter_complex", ";".join(graph_parts), "-map", "[vout]"])
        cmd.extend(["-map", "[aout]"])
    else:
        # V tracks are visual-only. Keep a silent stream solely so normalized
        # segments remain concat/transition compatible; real audio is mixed
        # later from explicit A-track events.
        cmd.extend([
            "-f",
            "lavfi",
            "-t",
            f"{timeline_duration + 0.1:.6f}",
            "-i",
            "anullsrc=r=48000:cl=stereo",
        ])
        cmd.extend(["-filter_complex", _clip_canvas_transform_graph(
            "[0:v]", "[vout]", clip=visual_clip, source_filter=vf,
            content_fit=content_fit, width=width, height=height, fps=fps,
            duration=timeline_duration, background_color=background_color,
            blur_amount=blur_amount,
        ), "-map", "[vout]"])
        cmd.extend(["-map", "1:a:0"])
    cmd.extend([
        *video_encode_quality,
        "-c:a",
        "pcm_s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-t",
        f"{timeline_duration:.6f}",
        str(out_ts),
    ])
    r = _run_ffmpeg_process(cmd, timeout=3600, cancel_event=cancel_event)
    if r.returncode != 0:
        tail = (r.stderr or r.stdout or "").strip()[-600:]
        logger.error("lite_cut clip normalize failed %s: %s", src.name, tail)
        raise_hardware_encoder_failure(
            cmd,
            r,
            stage="lite_cut_clip_normalize",
            artifact_path=out_ts,
            public_code="MONTAGE_CLIP_NORMALIZE_FAILED",
            public_params={"name": src.name},
        )
        raise MontageComposerError("MONTAGE_CLIP_NORMALIZE_FAILED", name=src.name)


def _timeline_concat_filter_complex(
    *,
    segment_count: int,
    fps: float,
) -> str:
    """Join independently encoded timeline segments in the decoded-frame domain.

    A concat-demuxer stream copy is not a valid scene boundary for independently
    initialized H.264 encoders.  It can produce a file that decodes in a simple
    single-input pass but deadlocks FFmpeg framesync when the result is later used
    by ``overlay``.  Every segment is therefore decoded as its own input and the
    timeline is rebuilt from continuous video/audio frames before the selected
    production encoder is invoked.
    """

    if segment_count <= 0:
        raise ValueError("segment_count must be positive")
    fps_s = f"{max(1.0, float(fps)):.9f}".rstrip("0").rstrip(".")
    parts: list[str] = []
    inputs: list[str] = []
    for index in range(segment_count):
        parts.extend([
            (
                f"[{index}:v:0]fps={fps_s},settb=AVTB,"
                f"setpts=PTS-STARTPTS[timeline_v{index}]"
            ),
            (
                f"[{index}:a:0]aresample=48000:async=1:first_pts=0,"
                f"asetpts=PTS-STARTPTS[timeline_a{index}]"
            ),
        ])
        inputs.extend([f"[timeline_v{index}]", f"[timeline_a{index}]"])
    parts.append(
        "".join(inputs)
        + f"concat=n={segment_count}:v=1:a=1[timeline_vout][timeline_aout]"
    )
    return ";".join(parts)


def _concat_timeline_command(
    *,
    ffmpeg_bin: Path,
    segment_paths: Sequence[Path],
    output_path: Path,
    fps: float,
    video_encode_quality: Sequence[str],
) -> list[str]:
    """Build the frame-domain timeline assembly command.

    ``video_encode_quality`` is supplied by the unchanged shared encoder plan;
    this assembly layer neither selects a codec nor alters device bindings.
    """

    paths = [Path(path) for path in segment_paths]
    if not paths:
        raise ValueError("at least one timeline segment is required")
    command = [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
    ]
    for path in paths:
        command.extend(["-i", str(path)])
    command.extend([
        "-filter_complex",
        _timeline_concat_filter_complex(segment_count=len(paths), fps=fps),
        "-map",
        "[timeline_vout]",
        "-map",
        "[timeline_aout]",
        *[str(item) for item in video_encode_quality],
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-avoid_negative_ts",
        "make_zero",
        "-movflags",
        "+faststart",
        str(output_path),
    ])
    return command


def _compose_lite_cut_montage_once(
    *,
    ffmpeg_bin: Path,
    project_body: dict[str, Any],
    clip_path_by_id: dict[int, Path],
    output_path: Path,
    montage_encoder: str = "auto",
    progress_callback: ProgressCallback | None = None,
    cancel_event: Any | None = None,
    encoder_device_args: Sequence[str] | None = None,
    encoder_adapter: object | None = None,
    rife_device_plan: FrameMeldRifeDevicePlan | None = None,
) -> None:
    """Export a LiteCut schema-v3 body with trim, effects, and transition events."""
    export_plan = build_lite_cut_export_plan(project_body)
    framemeld_requested = export_plan.framemeld_enabled
    external_progress_callback = progress_callback

    def mapped_progress_callback(
        progress: float,
        stage: str,
        detail: dict[str, Any] | None = None,
    ) -> None:
        mapped = float(progress)
        if framemeld_requested and stage not in {"framemeld", "done"}:
            # Reserve 40% of the visible range for the usually dominant FrameMeld
            # pass instead of reporting 99% before interpolation has started.
            mapped = min(0.60, mapped * (0.60 / 0.98))
        _emit_progress(external_progress_callback, mapped, stage, detail)

    progress_callback = mapped_progress_callback
    _emit_progress(progress_callback, 0.02, "checking")
    _raise_if_cancelled(cancel_event)
    base_track_id, clips = export_plan.base_track_id, list(export_plan.base_clips)
    if not clips:
        raise MontageComposerError("MONTAGE_NO_CLIPS")
    missing_asset = _first_missing_file_asset_for_export(project_body, base_track_id=base_track_id)
    if missing_asset:
        raise MontageComposerError("MONTAGE_CLIP_FILE_MISSING", name=missing_asset)

    paths: list[Path] = []
    row_ids: list[int] = []
    for i, clip in enumerate(clips):
        if _is_main_file_clip(clip):
            p = Path(str(clip.get("file_path") or "")).expanduser().resolve()
            name = p.name or str(clip.get("file_path") or "uploaded")
        else:
            sid = clip.get("source_id")
            if sid is None:
                raise MontageComposerError("MONTAGE_CLIP_NOT_FOUND", id="?")
            cid = int(sid)
            p = clip_path_by_id.get(cid)
            name = str(sid)
        if p is None or not p.is_file():
            raise MontageComposerError("MONTAGE_CLIP_FILE_MISSING", name=name)
        paths.append(p)
        row_ids.append(i)

    gap_plan = _timeline_gap_plan(clips)
    if gap_plan is None:
        raise MontageComposerError("LITECUT_TIMELINE_OVERLAP")

    transitions = export_plan.transitions
    _codec = str(montage_encoder or "libx264").strip().lower()
    video_encode_quality = apply_encoder_device_args(
        h264_encode_cli_args(_codec, _project_encoder_tier(project_body)),
        encoder_device_args,
    )
    ffprobe = resolve_ffprobe_binary(ffmpeg_bin)

    overlay_clips = _resolve_overlay_clip_paths(
        [*export_plan.transition_layers, *export_plan.video_layers],
        clip_path_by_id,
    )
    framemeld_source_paths = list(paths)
    video_extensions = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".ts", ".mts", ".m2ts"}
    for overlay in overlay_clips:
        if overlay.get("type") == "text":
            continue
        overlay_meta = overlay.get("meta") if isinstance(overlay.get("meta"), dict) else {}
        overlay_path = Path(str(overlay.get("file_path") or "")).expanduser().resolve()
        overlay_kind = str(overlay_meta.get("kind") or overlay.get("type") or "").lower()
        if overlay_kind in {"video", "webm"} or overlay_path.suffix.lower() in video_extensions:
            if overlay_path.is_file() and overlay_path not in framemeld_source_paths:
                framemeld_source_paths.append(overlay_path)

    ref = probe_video_audio_summary(paths[0], ffprobe)
    source_fps_values: list[float] = []
    for source_path in framemeld_source_paths:
        try:
            source_info = ref if source_path == paths[0] else probe_video_audio_summary(source_path, ffprobe)
            source_fps = float(source_info.get("fps") or 0)
            if source_fps < 1.0:
                raise ValueError("invalid source frame rate")
            source_fps_values.append(source_fps)
        except Exception:
            if framemeld_requested:
                raise MontageComposerError(
                    "MONTAGE_FRAMEMELD_SOURCE_FPS_REQUIRED",
                    name=source_path.name,
                )
    if int(ref["width"]) <= 0 or int(ref["height"]) <= 0:
        raise MontageComposerError("MONTAGE_FIRST_CLIP_NO_RESOLUTION")
    w, h, fps = _project_output_settings(project_body, ref)
    if framemeld_requested:
        if not framemeld_sources_are_compatible(source_fps_values):
            raise MontageComposerError("MONTAGE_FRAMEMELD_MIXED_SOURCE_FPS")
        # Preserve one real source-rate family until the external final pass.
        fps = framemeld_working_fps(source_fps_values)
    canvas_fit, background_color, blur_amount = _project_canvas_settings(project_body)
    overlay_clips = [
        {
            **clip,
            "content_fit": _clip_canvas_fit(clip, canvas_fit),
        } if clip.get("is_timeline_video_layer") else clip
        for clip in overlay_clips
    ]
    range_start_sec, range_end_sec = _project_export_range(project_body)
    _emit_progress(progress_callback, 0.08, "normalizing")

    tmpdir = tempfile.mkdtemp(prefix="cs2_lite_cut_", dir=str(output_path.parent))
    try:
        normed: list[Path] = []
        for i, (clip, src) in enumerate(zip(clips, paths)):
            _raise_if_cancelled(cancel_event)
            out_ts = Path(tmpdir) / f"clip_{i:03d}.mkv"
            _lite_cut_clip_to_ts(
                ffmpeg_bin=ffmpeg_bin,
                src=src,
                out_ts=out_ts,
                clip=clip,
                width=w,
                height=h,
                fps=fps,
                canvas_fit=canvas_fit,
                background_color=background_color,
                blur_amount=blur_amount,
                video_encode_quality=video_encode_quality,
                cancel_event=cancel_event,
            )
            normed.append(out_ts)
            _emit_progress(progress_callback, 0.10 + 0.35 * ((i + 1) / max(1, len(clips))), "normalizing")

        if gap_plan:
            gap_by_index = {index: duration for index, duration in gap_plan}
            timeline_paths: list[Path] = []
            timeline_row_ids: list[int | None] = []
            for index, clip_path in enumerate(normed):
                gap_duration = gap_by_index.get(index)
                if gap_duration is not None:
                    gap_ts = Path(tmpdir) / f"gap_{index:03d}.mkv"
                    _lite_cut_gap_to_ts(
                        ffmpeg_bin=ffmpeg_bin,
                        out_ts=gap_ts,
                        duration=gap_duration,
                        width=w,
                        height=h,
                        fps=fps,
                        background_color=background_color,
                        video_encode_quality=video_encode_quality,
                        cancel_event=cancel_event,
                    )
                    timeline_paths.append(gap_ts)
                    timeline_row_ids.append(None)
                timeline_paths.append(clip_path)
                timeline_row_ids.append(row_ids[index])
            normed = timeline_paths
            row_ids = timeline_row_ids

        n_clips = len(normed)
        concat_paths: list[Path]
        if n_clips >= 2 and transitions:
            processed: list[Path] = []
            current = normed[0]
            current_row_id = row_ids[0]
            for index in range(1, n_clips):
                _raise_if_cancelled(cancel_event)
                next_row_id = row_ids[index]
                if current_row_id is None or next_row_id is None:
                    t_type, t_dur = "none", 0.0
                else:
                    t_type, t_dur = _parse_transition_for_edge(transitions, current_row_id)
                if _is_hard_cut(t_type, t_dur, fps):
                    processed.append(current)
                    current = normed[index]
                else:
                    transition_ts = Path(tmpdir) / f"transition_{index:03d}.mkv"
                    _lite_cut_boundary_transition_to_ts(
                        ffmpeg_bin=ffmpeg_bin,
                        ffprobe=ffprobe,
                        previous_ts=current,
                        next_ts=normed[index],
                        transition_type=t_type,
                        transition_duration=t_dur,
                        fps=fps,
                        out_ts=transition_ts,
                        video_encode_quality=video_encode_quality,
                        cancel_event=cancel_event,
                    )
                    current = transition_ts
                current_row_id = next_row_id
                _emit_progress(progress_callback, 0.48 + 0.10 * (index / max(1, n_clips - 1)), "transitions")
            processed.append(current)
            concat_paths = processed
        else:
            concat_paths = normed
            _emit_progress(progress_callback, 0.58, "transitions")

        _raise_if_cancelled(cancel_event)
        _emit_progress(progress_callback, 0.62, "concat")

        cmd_concat = _concat_timeline_command(
            ffmpeg_bin=ffmpeg_bin,
            segment_paths=concat_paths,
            output_path=output_path,
            fps=fps,
            video_encode_quality=video_encode_quality,
        )
        r = _run_ffmpeg_process(cmd_concat, timeout=3600, cancel_event=cancel_event)
        if r.returncode != 0:
            tail = (r.stderr or r.stdout or "").strip()[-600:]
            logger.error("lite_cut concat failed: %s", tail)
            raise_hardware_encoder_failure(
                cmd_concat,
                r,
                stage="lite_cut_timeline_assemble",
                artifact_path=output_path,
                public_code="MONTAGE_EXPORT_FAILED",
            )
            raise MontageComposerError("MONTAGE_EXPORT_FAILED")
        _emit_progress(progress_callback, 0.68, "concat")

        if overlay_clips:
            _raise_if_cancelled(cancel_event)
            v1_base = Path(tmpdir) / "v1_concat.mp4"
            import shutil

            shutil.move(str(output_path), str(v1_base))
            _composite_overlays_on_base(
                ffmpeg_bin=ffmpeg_bin,
                ffprobe=ffprobe,
                base_mp4=v1_base,
                overlay_clips=overlay_clips,
                blur_amount=blur_amount,
                out_mp4=output_path,
                video_encode_quality=video_encode_quality,
                progress_callback=progress_callback,
                cancel_event=cancel_event,
                progress_start=0.70,
                progress_end=0.84,
            )
        else:
            _emit_progress(progress_callback, 0.84, "overlays")

        audio_clips = list(export_plan.audio_events)
        audio_clips = _resolve_audio_clip_paths(audio_clips, clip_path_by_id)
        master_volume = export_plan.master_volume
        if audio_clips:
            _raise_if_cancelled(cancel_event)
            _emit_progress(progress_callback, 0.88, "audio")
            audio_base = Path(tmpdir) / "visual_base.mp4"
            import shutil

            shutil.move(str(output_path), str(audio_base))
            _mix_audio_tracks_on_base(
                ffmpeg_bin=ffmpeg_bin,
                ffprobe=ffprobe,
                base_mp4=audio_base,
                audio_clips=audio_clips,
                out_mp4=output_path,
                master_volume=master_volume,
                cancel_event=cancel_event,
            )
            _emit_progress(progress_callback, 0.96, "audio")
        else:
            _emit_progress(progress_callback, 0.96, "audio")
        if range_start_sec > 0.0 or range_end_sec is not None:
            _raise_if_cancelled(cancel_event)
            _emit_progress(progress_callback, 0.98, "range")
            range_base = Path(tmpdir) / "full_range_base.mp4"
            import shutil

            shutil.move(str(output_path), str(range_base))
            _trim_final_export_range(
                ffmpeg_bin=ffmpeg_bin,
                src_mp4=range_base,
                out_mp4=output_path,
                start_sec=range_start_sec,
                end_sec=range_end_sec,
                video_encode_quality=video_encode_quality,
                cancel_event=cancel_event,
            )
        if framemeld_requested:
            _raise_if_cancelled(cancel_event)
            capability = probe_framemeld(ffmpeg_bin)
            if capability is None:
                raise MontageComposerError("MONTAGE_FRAMEMELD_REQUIRED")
            _emit_progress(progress_callback, 0.60, "framemeld")
            framemeld_base = Path(tmpdir) / "framemeld_base.mp4"
            import shutil

            shutil.move(str(output_path), str(framemeld_base))
            cmd_framemeld = build_framemeld_command(
                ffmpeg_bin=ffmpeg_bin,
                source_path=framemeld_base,
                output_path=output_path,
                video_encode_args=video_encode_quality,
                encoder_adapter=encoder_adapter,
                rife_device_plan=rife_device_plan,
                capability=capability,
            )
            precise_policy = framemeld_execution_policy(cmd_framemeld)
            framemeld_result = _run_ffmpeg_process(
                cmd_framemeld,
                timeout=(
                    precise_policy.hard_timeout_seconds
                    if precise_policy is not None else 3600
                ),
                stall_timeout=(
                    precise_policy.stall_timeout_seconds
                    if precise_policy is not None else None
                ),
                cancel_event=cancel_event,
                progress_callback=progress_callback,
                progress_start=0.60,
                progress_end=0.995,
                progress_stage="framemeld",
            )
            precise_events = parse_framemeld_status_events(
                framemeld_result.stdout,
                framemeld_result.stderr,
            )
            record_framemeld_rife_result(
                rife_device_plan,
                precise_events,
                succeeded=framemeld_result.returncode == 0,
            )
            if precise_events:
                log_framemeld_diagnostic_events(
                    precise_events,
                    branch=precise_policy.branch if precise_policy is not None else "legacy",
                )
                final_event = precise_events[-1]
                export_event(
                    "framemeld_result",
                    branch=precise_policy.branch if precise_policy is not None else "legacy",
                    status=final_event.get("status"),
                    failure_domain=final_event.get("failure_domain"),
                    encoder=final_event.get("encoder"),
                    devices=final_event.get("devices"),
                    elapsed_ms=final_event.get("elapsed_ms"),
                    processed_frames=final_event.get("processed_frames"),
                    total_frames=final_event.get("total_frames"),
                    ffmpeg_returncode=final_event.get("ffmpeg_returncode"),
                    vspipe_returncode=final_event.get("vspipe_returncode"),
                )
                logger.info(
                    "lite_cut FrameMeld precise branch=%s status=%s domain=%s encoder=%s devices=%s elapsed_ms=%s processed_frames=%s total_frames=%s ffmpeg_returncode=%s vspipe_returncode=%s",
                    precise_policy.branch if precise_policy is not None else "legacy",
                    final_event.get("status"),
                    final_event.get("failure_domain") or "",
                    final_event.get("encoder") or "",
                    final_event.get("devices") or {},
                    final_event.get("elapsed_ms"),
                    final_event.get("processed_frames"),
                    final_event.get("total_frames"),
                    final_event.get("ffmpeg_returncode"),
                    final_event.get("vspipe_returncode"),
                )
            if framemeld_result.returncode != 0:
                tail = (framemeld_result.stderr or framemeld_result.stdout or "").strip()[-600:]
                precise_failure = framemeld_failure_from_result(framemeld_result)
                export_event(
                    "framemeld_failed",
                    level=logging.ERROR,
                    branch=precise_policy.branch if precise_policy is not None else "legacy",
                    returncode=framemeld_result.returncode,
                    failure_domain=(
                        precise_failure.domain if precise_failure is not None else "legacy-unclassified"
                    ),
                    encoder=precise_failure.encoder if precise_failure is not None else "",
                    devices=precise_failure.devices if precise_failure is not None else {},
                    detail=(precise_failure.detail if precise_failure is not None else tail),
                )
                logger.error(
                    "lite_cut FrameMeld failed branch=%s returncode=%d domain=%s encoder=%s devices=%s detail=%s",
                    precise_policy.branch if precise_policy is not None else "legacy",
                    framemeld_result.returncode,
                    precise_failure.domain if precise_failure is not None else "legacy-unclassified",
                    precise_failure.encoder if precise_failure is not None else "",
                    precise_failure.devices if precise_failure is not None else {},
                    tail,
                )
                if framemeld_result.returncode == 124 and precise_policy is not None:
                    raise MontageComposerError(
                        "MONTAGE_FRAMEMELD_TIMEOUT",
                        branch=precise_policy.branch,
                        encoder=precise_policy.encoder,
                        stage="lite_cut_framemeld",
                        timeout_seconds=(
                            precise_policy.stall_timeout_seconds
                            if "no frame progress" in tail
                            else precise_policy.hard_timeout_seconds
                        ),
                        detail=tail,
                    )
                if precise_failure is not None and precise_failure.domain != "encoder":
                    raise MontageComposerError(
                        "MONTAGE_FRAMEMELD_FAILED",
                        branch=precise_policy.branch if precise_policy is not None else "legacy",
                        failure_domain=precise_failure.domain,
                        encoder=precise_failure.encoder,
                        devices=precise_failure.devices,
                        detail=precise_failure.detail[-1200:],
                    )
                raise_hardware_encoder_failure(
                    cmd_framemeld,
                    framemeld_result,
                    stage="lite_cut_framemeld",
                    artifact_path=output_path,
                    public_code="MONTAGE_EXPORT_FAILED",
                )
                raise MontageComposerError("MONTAGE_EXPORT_FAILED")
        _raise_if_cancelled(cancel_event)
        _emit_progress(progress_callback, 1.0, "done")
    finally:
        import shutil

        shutil.rmtree(tmpdir, ignore_errors=True)


def compose_lite_cut_montage(
    *,
    ffmpeg_bin: Path,
    project_body: dict[str, Any],
    clip_path_by_id: dict[int, Path],
    output_path: Path,
    montage_encoder: str = "auto",
    progress_callback: ProgressCallback | None = None,
    cancel_event: Any | None = None,
) -> Any:
    """Export LiteCut with the shared GPU plan and x264 safety fallback."""

    from ...encoder_planner import (
        EncoderCandidate,
        EncoderTargetSpec,
        build_encoder_candidates,
        enumerate_windows_gpus,
        map_nvenc_device_indices,
        probe_ffmpeg_encoder,
        run_encoder_attempts,
    )
    from .export_preflight import validate_export_output

    _raise_if_cancelled(cancel_event)
    export_plan = build_lite_cut_export_plan(project_body)
    base_track_id, clips = export_plan.base_track_id, list(export_plan.base_clips)
    if not clips:
        raise MontageComposerError("MONTAGE_NO_CLIPS")
    paths: list[Path] = []
    for clip in clips:
        if _is_main_file_clip(clip):
            source = Path(str(clip.get("file_path") or "")).expanduser().resolve()
            name = source.name or str(clip.get("file_path") or "uploaded")
        else:
            source_id = clip.get("source_id")
            if source_id is None:
                raise MontageComposerError("MONTAGE_CLIP_NOT_FOUND", id="?")
            source = clip_path_by_id.get(int(source_id))
            name = str(source_id)
        if source is None or not source.is_file():
            raise MontageComposerError("MONTAGE_CLIP_FILE_MISSING", name=name)
        paths.append(source)

    ffprobe = resolve_ffprobe_binary(ffmpeg_bin)
    source_info: dict[Path, dict[str, Any]] = {}
    for source in paths:
        try:
            source_info[source] = probe_video_audio_summary(
                source,
                ffprobe,
                "lite_cut_source_preflight",
                "source",
            )
        except MontageComposerError as exc:
            hinted = add_ffmpeg_compatibility_hint(exc, ffmpeg_bin)
            if hinted is exc:
                raise
            raise hinted from exc
    ref = source_info[paths[0]]
    export_plan = build_lite_cut_export_plan(project_body, ref)
    width, height, fps = export_plan.output_width, export_plan.output_height, export_plan.output_fps
    if width <= 0 or height <= 0 or fps <= 0:
        raise MontageComposerError("MONTAGE_FIRST_CLIP_NO_RESOLUTION")

    available = available_h264_encoders(ffmpeg_bin)
    adapters = enumerate_windows_gpus()
    if "h264_nvenc" in available:
        adapters = map_nvenc_device_indices(ffmpeg_bin, adapters)
    export_gpu_inventory(adapters)
    framemeld_enabled = export_plan.framemeld_enabled
    rife_device_plan = (
        plan_framemeld_rife_device(ffmpeg_bin, adapters)
        if framemeld_enabled
        else None
    )
    if rife_device_plan is not None:
        export_event("rife_device_plan", **rife_device_plan.log_fields())
    candidates = build_encoder_candidates(
        montage_encoder,
        adapters,
        available_encoders=available,
    )
    if not candidates:
        raise MontageComposerError("MONTAGE_ENCODER_ALL_FAILED", last_encoder="none")
    ffmpeg_identity = ffmpeg_encoder_identity(ffmpeg_bin)
    export_event(
        "encoder_plan",
        ffmpeg_identity=ffmpeg_identity,
        requested_encoder=montage_encoder,
        width=width,
        height=height,
        fps=fps,
        framemeld_enabled=framemeld_enabled,
        candidates=[
            {
                "codec": candidate.codec,
                "adapter": getattr(candidate.adapter, "name", None),
                "vendor": getattr(candidate.adapter, "vendor", None),
                "stable_id": getattr(candidate.adapter, "stable_id", None),
                "luid": getattr(candidate.adapter, "luid", None),
                "device_id": getattr(candidate.adapter, "device_id", None),
                "driver_version": getattr(candidate.adapter, "driver_version", None),
                "encoder_device_index": getattr(candidate.adapter, "encoder_device_index", None),
            }
            for candidate in candidates
        ],
    )
    tier = export_plan.encoder_tier
    spec = EncoderTargetSpec(
        width=int(width),
        height=int(height),
        frame_rate=float(fps),
        pixel_format="yuv420p",
        profile="high",
        tier=tier,
    )
    attempt_handle, attempt_name = tempfile.mkstemp(
        prefix=f".{output_path.stem}.encoder-attempt-",
        suffix=".mp4",
        dir=str(output_path.parent),
    )
    os.close(attempt_handle)
    attempt_output = Path(attempt_name)
    attempt_output.unlink(missing_ok=True)

    def _cleanup_attempt() -> None:
        try:
            attempt_output.unlink(missing_ok=True)
        except OSError:
            pass

    def _convert_generated_failure(
        candidate: EncoderCandidate,
        exc: MontageComposerError,
    ) -> None:
        generated_probe = (
            exc.code == "MONTAGE_FFPROBE_FAILED"
            and exc.params.get("file_role") in {"intermediate", "final"}
        )
        invalid_output = exc.code == "MONTAGE_OUTPUT_NOT_PLAYABLE"
        if not (generated_probe or invalid_output):
            return
        if not candidate.is_software:
            raise HardwareEncoderFailure(
                codec=candidate.codec,
                stage=str(exc.params.get("stage") or "lite_cut_output_validation"),
                artifact_path=str(exc.params.get("name") or attempt_output.name),
                public_code=exc.code,
                public_params=exc.params,
            ) from exc
        if generated_probe:
            raise MontageComposerError(
                "MONTAGE_OUTPUT_NOT_PLAYABLE",
                stage=str(exc.params.get("stage") or "lite_cut_generated_probe"),
                name=str(exc.params.get("name") or attempt_output.name),
            ) from exc

    def _run_candidate(candidate: EncoderCandidate) -> None:
        _raise_if_cancelled(cancel_event)
        _cleanup_attempt()
        try:
            _compose_lite_cut_montage_once(
                ffmpeg_bin=ffmpeg_bin,
                project_body=project_body,
                clip_path_by_id=clip_path_by_id,
                output_path=attempt_output,
                montage_encoder=candidate.codec,
                progress_callback=progress_callback,
                cancel_event=cancel_event,
                encoder_device_args=candidate.ffmpeg_device_args,
                encoder_adapter=candidate.adapter,
                rife_device_plan=rife_device_plan,
            )
            validate_export_output(ffmpeg_bin, attempt_output)
        except MontageComposerError as exc:
            _convert_generated_failure(candidate, exc)
            raise
        _raise_if_cancelled(cancel_event)
        try:
            os.replace(attempt_output, output_path)
        except OSError as exc:
            raise MontageComposerError("MONTAGE_OUTPUT_PATH_INVALID") from exc

    def _on_attempt(attempt: Any) -> None:
        export_event(
            "encoder_attempt",
            candidate=attempt.candidate.codec,
            adapter=getattr(attempt.candidate.adapter, "name", None),
            status=attempt.status,
            stage=attempt.stage,
            detail=attempt.detail[-1200:],
        )
        logger.info(
            "LiteCut encoder attempt candidate=%s status=%s stage=%s detail=%s",
            attempt.candidate.display_name,
            attempt.status,
            attempt.stage,
            attempt.detail[-600:],
        )
        if attempt.status == "export_failed" and progress_callback is not None:
            _emit_progress(
                progress_callback,
                0.01,
                f"fallback_{attempt.candidate.codec}",
            )

    try:
        return run_encoder_attempts(
            candidates,
            spec,
            lambda candidate, target: probe_ffmpeg_encoder(
                ffmpeg_bin,
                ffprobe,
                candidate,
                target,
            ),
            _run_candidate,
            ffmpeg_identity=ffmpeg_identity,
            cleanup=_cleanup_attempt,
            cancellation_check=lambda: _raise_if_cancelled(cancel_event),
            on_attempt=_on_attempt,
        )
    except MontageComposerError as exc:
        hinted = add_ffmpeg_compatibility_hint(exc, ffmpeg_bin)
        if hinted is exc:
            raise
        raise hinted from exc
    finally:
        _cleanup_attempt()


def export_lite_cut_project(
    *,
    ffmpeg_bin: Path,
    project_body: dict[str, Any],
    clip_path_by_id: dict[int, Path],
    output_path_str: str,
    montage_encoder: str = "auto",
    progress_callback: ProgressCallback | None = None,
    cancel_event: Any | None = None,
) -> Path:
    out = validate_output_path(output_path_str)
    compose_lite_cut_montage(
        ffmpeg_bin=ffmpeg_bin,
        project_body=project_body,
        clip_path_by_id=clip_path_by_id,
        output_path=out,
        montage_encoder=montage_encoder,
        progress_callback=progress_callback,
        cancel_event=cancel_event,
    )
    return out
