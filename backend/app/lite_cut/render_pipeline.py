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
from .filter_graphs import (
    _atempo_chain,
    _audio_filter_chain,
    _audio_mix_filter_complex,
    _boundary_transition_filter_complex,
    _clip_canvas_transform_graph,
    _clip_video_filter_chain,
    _drawtext_filter_complex,
    _eq_filter,
    _overlay_filter_complex,
    _overlay_height_from_transform,
    _overlay_layout_from_transform,
    _overlay_opacity_from_transform,
    _stage_custom_font_for_ffmpeg,
)
from .timeline import (
    _all_overlay_clips_for_export,
    _audio_track_clips_for_export,
    _base_video_track_for_export,
    _build_positional_transitions,
    _clip_crop_filter,
    _clip_duration_sec,
    _clip_freeze_frame_sec,
    _clip_has_speed_ramp,
    _clip_preserve_pitch,
    _clip_reverse,
    _clip_speed,
    _clip_speed_segments,
    _clip_timeline_duration_sec,
    _clip_visual_fade,
    _clip_volume,
    _clip_volume_filter,
    _first_missing_file_asset_for_export,
    _has_solo_audio_tracks,
    _is_main_file_clip,
    _project_bgm_clip_for_export,
    _project_canvas_settings,
    _project_encoder_tier,
    _project_export_range,
    _project_master_volume,
    _project_output_settings,
    _resolve_audio_clip_paths,
    _resolve_overlay_clip_paths,
    _timeline_gap_plan,
    _video_layer_audio_clips_for_export,
)
from ..video_composer import (
    MontageComposerError,
    _concat_file_line,
    _is_hard_cut,
    _parse_transition_for_edge,
    ffprobe_streams,
    probe_video_audio_summary,
    resolve_ffprobe_binary,
    validate_output_path,
)
from ..montage_encoder import (
    apply_encoder_device_args,
    available_h264_encoders,
    ffmpeg_encoder_identity,
    h264_encode_cli_args,
    raise_hardware_encoder_failure,
)
from ..montage_exceptions import HardwareEncoderFailure
from ..ffmpeg_compatibility import add_ffmpeg_compatibility_hint
from ..framemeld import (
    build_framemeld_command,
    framemeld_sources_are_compatible,
    framemeld_working_fps,
    probe_framemeld,
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
    return path.suffix.lower() == ".gif"


def _composite_overlays_on_base(
    *,
    ffmpeg_bin: Path,
    ffprobe: Path,
    base_mp4: Path,
    overlay_clips: list[dict[str, Any]],
    out_mp4: Path,
    video_encode_quality: list[str],
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
        total = max(float(base_info.get("duration") or 0), end, 0.1)

        if clip.get("type") == "text":
            enable = f"between(t,{start:.4f},{end:.4f})"
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
            fc = _drawtext_filter_complex(text_clip=export_text_clip, enable_expr=enable, canvas_width=int(base_info.get("width") or 1920), canvas_height=int(base_info.get("height") or 1080))
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

            if fp.suffix.lower() in still_ext:
                tr = clip.get("transform") if isinstance(clip.get("transform"), dict) else {}
                tx, ty, size_frac, rotation = _overlay_layout_from_transform(tr)
                height_frac = _overlay_height_from_transform(tr)
                opacity = _overlay_opacity_from_transform(tr)
                enable = f"between(t,{start:.4f},{end:.4f})"
                fc = _overlay_filter_complex(
                    enable_expr=enable,
                    timeline_start=start,
                    duration=dur,
                    tx=tx,
                    ty=ty,
                    size_frac=size_frac,
                    height_frac=height_frac,
                    rotation=rotation,
                    opacity=opacity,
                    fade_in=_clip_visual_fade(clip, "fade_in_sec"),
                    fade_out=_clip_visual_fade(clip, "fade_out_sec"),
                    video_input=False,
                    flip_horizontal=bool(clip.get("flip_horizontal")),
                    flip_vertical=bool(clip.get("flip_vertical")),
                    keyframes=clip.get("keyframes"),
                    source_filters=[item for item in (_clip_crop_filter(clip), _eq_filter(clip.get("color") if isinstance(clip.get("color"), dict) else None)) if item],
                    reverse=_clip_reverse(clip),
                    freeze_frame_sec=_clip_freeze_frame_sec(clip),
                    canvas_width=int(base_info.get("width") or 1920),
                    canvas_height=int(base_info.get("height") or 1080),
                    transition_in=clip.get("transition_in"),
                    transition_out=clip.get("transition_out"),
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
                    "60",
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
                tx, ty, size_frac, rotation = _overlay_layout_from_transform(tr)
                height_frac = _overlay_height_from_transform(tr)
                opacity = _overlay_opacity_from_transform(tr)
                enable = f"between(t,{start:.4f},{end:.4f})"
                fc = _overlay_filter_complex(
                    enable_expr=enable,
                    timeline_start=start,
                    duration=dur,
                    tx=tx,
                    ty=ty,
                    size_frac=size_frac,
                    height_frac=height_frac,
                    rotation=rotation,
                    opacity=opacity,
                    fade_in=_clip_visual_fade(clip, "fade_in_sec"),
                    fade_out=_clip_visual_fade(clip, "fade_out_sec"),
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
                    transition_in=clip.get("transition_in"),
                    transition_out=clip.get("transition_out"),
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
    master_volume: float = 1.0,
    cancel_event: Any | None = None,
) -> None:
    _raise_if_cancelled(cancel_event)
    master_volume = max(0.0, min(2.0, float(master_volume)))
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
    if not audio_clips and (not base_info.get("has_audio") or abs(master_volume - 1.0) <= 1e-6):
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
    if not existing and (not base_info.get("has_audio") or abs(master_volume - 1.0) <= 1e-6):
        import shutil

        shutil.copy2(base_mp4, out_mp4)
        return

    filter_complex = _audio_mix_filter_complex(
        has_base_audio=bool(base_info.get("has_audio")),
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
    transition_in_background: bool = False,
    transition_out_background: bool = False,
    cancel_event: Any | None = None,
) -> None:
    _raise_if_cancelled(cancel_event)
    trim_in = max(0.0, float(clip.get("trim_in") or 0))
    source_duration = _clip_duration_sec(clip)
    timeline_duration = _clip_timeline_duration_sec(clip)
    speed = _clip_speed(clip)
    preserve_pitch = _clip_preserve_pitch(clip)
    volume = _clip_volume(clip)
    ramped = _clip_has_speed_ramp(clip)
    visual_clip = {**clip, "speed": 1.0, "speed_keyframes": []} if ramped else clip
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
    af = _audio_filter_chain(
        1.0 if ramped else speed,
        volume,
        reverse=_clip_reverse(clip),
        preserve_pitch=preserve_pitch,
        volume_filter=_clip_volume_filter(clip),
        freeze_frame_sec=_clip_freeze_frame_sec(clip),
    )
    # Every normalized segment must have matching A/V duration. ``-shortest``
    # silently picks the shorter stream (often audio by a few packets), which
    # loses time once per clip and turns into a visible drift after concat.
    audio_duration_filter = f"apad=pad_dur={timeline_duration:.6f},atrim=end={timeline_duration:.6f},asetpts=PTS-STARTPTS"
    has_canvas_transform = isinstance(clip.get("transform"), dict) or transition_in_background or transition_out_background

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
        if has_canvas_transform:
            graph_parts.append(_clip_canvas_transform_graph("[rampv]", "[vout]", clip=clip, fitted_filter=vf, width=width, height=height, fps=fps, duration=timeline_duration, background_color=background_color, transition_in_background=transition_in_background, transition_out_background=transition_out_background))
        else:
            graph_parts.append(f"[rampv]{vf}[vout]")
        has_audio = bool(probe_video_audio_summary(src, resolve_ffprobe_binary(ffmpeg_bin)).get("has_audio"))
        if has_audio:
            audio_labels: list[str] = []
            for index, (start, end, segment_speed) in enumerate(_clip_speed_segments(clip)):
                label = f"[ra{index}]"
                audio_labels.append(label)
                chain = [
                    f"atrim=start={start - trim_in:.6f}:end={end - trim_in:.6f}",
                    "asetpts=PTS-STARTPTS",
                    *(_atempo_chain(segment_speed) if preserve_pitch else _pitch_shift_speed_chain(segment_speed)),
                ]
                graph_parts.append(f"[0:a]{','.join(chain)}{label}")
            graph_parts.append("".join(audio_labels) + f"concat=n={len(audio_labels)}:v=0:a=1[rampa]")
            graph_parts.append(f"[rampa]{','.join(part for part in (af, audio_duration_filter) if part)}[aout]")
        else:
            graph_parts.append(
                f"anullsrc=r=48000:cl=stereo,atrim=0:{timeline_duration:.6f},asetpts=PTS-STARTPTS[aout]"
            )
        cmd.extend(["-filter_complex", ";".join(graph_parts), "-map", "[vout]"])
        cmd.extend(["-map", "[aout]"])
    else:
        has_audio = bool(probe_video_audio_summary(src, resolve_ffprobe_binary(ffmpeg_bin)).get("has_audio"))
        if not has_audio:
            # Keep every normalized segment dual-stream so concat and cut-boundary
            # transitions work for recordings or uploads with no audio track.
            cmd.extend([
                "-f",
                "lavfi",
                "-t",
                f"{timeline_duration + 0.1:.6f}",
                "-i",
                "anullsrc=r=48000:cl=stereo",
            ])
        if has_canvas_transform:
            cmd.extend(["-filter_complex", _clip_canvas_transform_graph("[0:v]", "[vout]", clip=clip, fitted_filter=vf, width=width, height=height, fps=fps, duration=timeline_duration, background_color=background_color, transition_in_background=transition_in_background, transition_out_background=transition_out_background), "-map", "[vout]"])
        else:
            cmd.extend(["-vf", vf])
        if has_audio:
            cmd.extend(["-af", ",".join(part for part in (af, audio_duration_filter) if part)])
        if has_canvas_transform and has_audio:
            cmd.extend(["-map", "0:a:0"])
        if not has_audio:
            cmd.extend([*([] if has_canvas_transform else ["-map", "0:v:0"]), "-map", "1:a:0"])
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


def _concat_timeline_command(
    *,
    ffmpeg_bin: Path,
    concat_list: Path,
    output_path: Path,
) -> list[str]:
    """Join PCM timeline segments and perform the base track's sole AAC encode."""
    return [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-fflags",
        "+genpts",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(concat_list),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-c:v",
        "copy",
        "-af",
        "aresample=48000:async=1:first_pts=0",
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
    ]


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
) -> None:
    """Export LiteCut schema v2 body — V1 main track with trim, eq, and transitions."""
    output_settings = project_body.get("output") if isinstance(project_body.get("output"), dict) else {}
    framemeld_requested = bool(output_settings.get("framemeld_enabled"))
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
    base_track_id, clips = _base_video_track_for_export(project_body)
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

    transitions = _build_positional_transitions(clips)
    _codec = str(montage_encoder or "libx264").strip().lower()
    video_encode_quality = apply_encoder_device_args(
        h264_encode_cli_args(_codec, _project_encoder_tier(project_body)),
        encoder_device_args,
    )
    ffprobe = resolve_ffprobe_binary(ffmpeg_bin)

    overlay_clips = _resolve_overlay_clip_paths(
        _all_overlay_clips_for_export(project_body, base_track_id=base_track_id),
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
                transition_in_background=i == 0,
                transition_out_background=i == len(clips) - 1,
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
        concat_list = Path(tmpdir) / "concat.txt"
        concat_list.write_text("\n".join(_concat_file_line(p) for p in concat_paths) + "\n", encoding="utf-8")
        _emit_progress(progress_callback, 0.62, "concat")

        cmd_concat = _concat_timeline_command(
            ffmpeg_bin=ffmpeg_bin,
            concat_list=concat_list,
            output_path=output_path,
        )
        r = _run_ffmpeg_process(cmd_concat, timeout=3600, cancel_event=cancel_event)
        if r.returncode != 0:
            tail = (r.stderr or r.stdout or "").strip()[-600:]
            logger.error("lite_cut concat failed: %s", tail)
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
                out_mp4=output_path,
                video_encode_quality=video_encode_quality,
                progress_callback=progress_callback,
                cancel_event=cancel_event,
                progress_start=0.70,
                progress_end=0.84,
            )
        else:
            _emit_progress(progress_callback, 0.84, "overlays")

        audio_clips = [
            *_audio_track_clips_for_export(project_body),
            *_video_layer_audio_clips_for_export(project_body, base_track_id=base_track_id),
        ]
        audio_clips = _resolve_audio_clip_paths(audio_clips, clip_path_by_id)
        bgm_clip = _project_bgm_clip_for_export(project_body)
        if bgm_clip and not _has_solo_audio_tracks(project_body):
            audio_clips = [*audio_clips, bgm_clip]
        master_volume = _project_master_volume(project_body)
        if audio_clips or abs(master_volume - 1.0) > 1e-6:
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
                capability=capability,
            )
            framemeld_result = _run_ffmpeg_process(
                cmd_framemeld,
                timeout=3600,
                cancel_event=cancel_event,
                progress_callback=progress_callback,
                progress_start=0.60,
                progress_end=0.995,
                progress_stage="framemeld",
            )
            if framemeld_result.returncode != 0:
                tail = (framemeld_result.stderr or framemeld_result.stdout or "").strip()[-600:]
                logger.error("lite_cut FrameMeld failed: %s", tail)
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

    from ..encoder_planner import (
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
    base_track_id, clips = _base_video_track_for_export(project_body)
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
    width, height, fps = _project_output_settings(project_body, ref)
    if width <= 0 or height <= 0 or fps <= 0:
        raise MontageComposerError("MONTAGE_FIRST_CLIP_NO_RESOLUTION")

    available = available_h264_encoders(ffmpeg_bin)
    adapters = enumerate_windows_gpus()
    if "h264_nvenc" in available:
        adapters = map_nvenc_device_indices(ffmpeg_bin, adapters)
    candidates = build_encoder_candidates(
        montage_encoder,
        adapters,
        available_encoders=available,
    )
    if not candidates:
        raise MontageComposerError("MONTAGE_ENCODER_ALL_FAILED", last_encoder="none")
    tier = _project_encoder_tier(project_body)
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
            ffmpeg_identity=ffmpeg_encoder_identity(ffmpeg_bin),
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
