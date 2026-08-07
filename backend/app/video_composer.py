"""本地合辑：FFmpeg 探测、片段归一化拼接、可选片头片尾与 BGM 混音。"""

from __future__ import annotations

import json
import logging
import math
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Optional, Sequence

from .ffmpeg_process import (
    command_for_log,
    process_error_tail,
    remove_partial_file,
    run_process_capture,
)
from .montage_encoder import (
    apply_encoder_device_args,
    available_h264_encoders,
    ffmpeg_encoder_identity,
    h264_encode_cli_args,
    raise_hardware_encoder_failure,
    resolve_h264_codec_name,  # compatibility re-export for existing callers
)
from .montage_exceptions import HardwareEncoderFailure, MontageComposerError
from .ffmpeg_compatibility import add_ffmpeg_compatibility_hint, ffmpeg_tool_version_identity
from .framemeld import (
    build_framemeld_command,
    framemeld_sources_are_compatible,
    framemeld_working_fps,
    probe_framemeld,
)
from .env_utils import (
    resolve_name_card_font,
    resolve_name_card_font_bold,
    resolve_rajdhani_fonts,
)

logger = logging.getLogger(__name__)


def resolve_ffmpeg_binary(ffmpeg_path: str | None) -> Path:
    raw = (ffmpeg_path or "").strip()
    if raw:
        p = Path(raw).expanduser()
        if p.is_file():
            return p.resolve()
        raise MontageComposerError("MONTAGE_FFMPEG_NOT_FOUND", path=raw)
    from .env_utils import get_data_dir

    bundled = get_data_dir().parent / "third_party" / "ffmpeg" / "ffmpeg.exe"
    if bundled.is_file():
        return bundled.resolve()
    found = shutil.which("ffmpeg")
    if not found:
        raise MontageComposerError("MONTAGE_FFMPEG_PATH_MISSING")
    return Path(found).resolve()


def resolve_ffprobe_binary(ffmpeg_bin: Path) -> Path:
    """Resolve the matching ffprobe shipped beside the selected FFmpeg."""

    probe = ffmpeg_bin.parent / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
    if not probe.is_file():
        # Never silently pair a configured FFmpeg with an unrelated ffprobe
        # from PATH.  Mixed builds are a common source of false "corrupt clip"
        # errors and disappear as soon as a complete toolkit is selected.
        raise MontageComposerError(
            "MONTAGE_FFPROBE_NOT_FOUND",
            ffmpeg_path=str(Path(ffmpeg_bin).resolve()),
        )
    resolved_ffmpeg = Path(ffmpeg_bin).resolve()
    resolved_probe = probe.resolve()
    ffmpeg_version = ffmpeg_tool_version_identity(resolved_ffmpeg)
    ffprobe_version = ffmpeg_tool_version_identity(resolved_probe)
    if not ffmpeg_version or not ffprobe_version or ffmpeg_version != ffprobe_version:
        raise MontageComposerError(
            "MONTAGE_FFPROBE_VERSION_MISMATCH",
            ffmpeg_version=ffmpeg_version or "unknown",
            ffprobe_version=ffprobe_version or "unknown",
        )
    return resolved_probe


def _run_ffmpeg_capture(
    cmd: list[str],
    *,
    timeout: float,
    stage: str,
    output_path: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run FFmpeg with actionable logs and one conservative AMF retry."""
    is_amf = "h264_amf" in cmd
    attempts = 2 if is_amf else 1
    result = None
    for attempt in range(1, attempts + 1):
        logger.debug(
            "FFmpeg stage=%s attempt=%d/%d command=%s",
            stage,
            attempt,
            attempts,
            command_for_log(cmd),
        )
        try:
            result = run_process_capture(cmd, timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            remove_partial_file(output_path)
            timeout_result = subprocess.CompletedProcess(
                cmd,
                124,
                "",
                f"FFmpeg timed out after {timeout:g} seconds",
            )
            logger.error(
                "FFmpeg timed out stage=%s command=%s",
                stage,
                command_for_log(cmd),
            )
            try:
                raise_hardware_encoder_failure(
                    cmd,
                    timeout_result,
                    stage=stage,
                    artifact_path=output_path,
                    public_code="MONTAGE_EXPORT_FAILED",
                )
            except HardwareEncoderFailure as hardware_exc:
                raise hardware_exc from exc
            raise MontageComposerError("MONTAGE_EXPORT_FAILED") from exc
        if result.returncode == 0:
            if attempt > 1:
                logger.info("FFmpeg AMF retry succeeded stage=%s attempt=%d", stage, attempt)
            return result
        if attempt < attempts:
            logger.warning(
                "FFmpeg AMF attempt failed; retrying stage=%s returncode=%d command=%s stderr=%s",
                stage,
                result.returncode,
                command_for_log(cmd),
                process_error_tail(result),
            )
            remove_partial_file(output_path)
            # Some Windows AMF drivers release the previous encoder context
            # shortly after the FFmpeg process exits.  A bounded delay avoids
            # immediately racing the next encoder initialization.
            time.sleep(1.0)
    return result


def _run_json(
    cmd: list[str],
    *,
    probe_stage: str = "unknown",
    file_role: str = "unknown",
    media_path: Path | None = None,
) -> dict[str, Any]:
    try:
        proc = run_process_capture(cmd, timeout=120)
    except (OSError, subprocess.SubprocessError) as exc:
        logger.error(
            "ffprobe could not complete command=%s error=%s",
            command_for_log(cmd),
            exc,
        )
        raise MontageComposerError(
            "MONTAGE_FFPROBE_FAILED",
            stage=probe_stage,
            file_role=file_role,
            name=media_path.name if media_path is not None else "",
        ) from exc
    if proc.returncode != 0:
        logger.error(
            "ffprobe failed returncode=%s command=%s stderr=%s",
            proc.returncode,
            command_for_log(cmd),
            process_error_tail(proc, 1200),
        )
        raise MontageComposerError(
            "MONTAGE_FFPROBE_FAILED",
            stage=probe_stage,
            file_role=file_role,
            name=media_path.name if media_path is not None else "",
        )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        logger.error("ffprobe JSON parse failed: %s", e)
        raise MontageComposerError(
            "MONTAGE_FFPROBE_FAILED",
            stage=probe_stage,
            file_role=file_role,
            name=media_path.name if media_path is not None else "",
        ) from e


def ffprobe_streams(
    path: Path,
    ffprobe: Path,
    probe_stage: str = "unknown",
    file_role: str = "unknown",
) -> dict[str, Any]:
    return _run_json(
        [
            str(ffprobe),
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=index,codec_type,codec_name,codec_tag_string,profile,pix_fmt,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration,channels,sample_rate:stream_tags=alpha_mode,encoder",
            "-of",
            "json",
            str(path),
        ],
        probe_stage=probe_stage,
        file_role=file_role,
        media_path=path,
    )


_DEFAULT_VIDEO_FPS = 60.0
_MAX_SUPPORTED_VIDEO_FPS = 1000.0


def _parse_frame_rate(s: str) -> Optional[float]:
    s = (s or "").strip()
    if not s or s == "0/0":
        return None
    if "/" in s:
        a, b = s.split("/", 1)
        try:
            bf = float(b)
            value = float(a) / bf if bf else 0.0
        except ValueError:
            return None
    else:
        try:
            value = float(s)
        except ValueError:
            return None
    return value if math.isfinite(value) and value > 0 else None


def parse_r_frame_rate(s: str) -> float:
    """Parse a rational frame rate while preserving the legacy 60 FPS fallback."""
    return _parse_frame_rate(s) or _DEFAULT_VIDEO_FPS


def _plausible_video_fps(value: Optional[float]) -> bool:
    return value is not None and value <= _MAX_SUPPORTED_VIDEO_FPS


def _frame_count_fps(stream: dict[str, Any], format_duration: Optional[float]) -> Optional[float]:
    try:
        frame_count = float(stream.get("nb_frames") or 0)
    except (TypeError, ValueError):
        return None
    try:
        stream_duration = float(stream.get("duration") or 0)
    except (TypeError, ValueError):
        stream_duration = 0.0
    duration = stream_duration if stream_duration > 0 else float(format_duration or 0)
    if not math.isfinite(frame_count) or not math.isfinite(duration) or frame_count <= 0 or duration <= 0:
        return None
    value = frame_count / duration
    return value if _plausible_video_fps(value) else None


def _resolve_video_fps(stream: dict[str, Any], format_duration: Optional[float]) -> float:
    """Prefer measured average FPS; r_frame_rate may merely mirror a stream time base."""
    average_fps = _parse_frame_rate(str(stream.get("avg_frame_rate") or ""))
    counted_fps = _frame_count_fps(stream, format_duration)
    nominal_fps = _parse_frame_rate(str(stream.get("r_frame_rate") or ""))

    if _plausible_video_fps(average_fps):
        if counted_fps is not None and not math.isclose(average_fps, counted_fps, rel_tol=0.02, abs_tol=0.05):
            logger.debug(
                "Ignoring inconsistent avg_frame_rate %.6f in favor of frame count %.6f",
                average_fps,
                counted_fps,
            )
            return counted_fps
        return average_fps
    if counted_fps is not None:
        return counted_fps
    if _plausible_video_fps(nominal_fps):
        return nominal_fps
    return _DEFAULT_VIDEO_FPS


def probe_video_audio_summary(
    path: Path,
    ffprobe: Path,
    probe_stage: str = "source_probe",
    file_role: str = "source",
) -> dict[str, Any]:
    data = ffprobe_streams(
        path,
        ffprobe,
        probe_stage=probe_stage,
        file_role=file_role,
    )
    fmt = data.get("format") or {}
    dur_s: Optional[float] = None
    try:
        d = float(fmt.get("duration") or 0)
        dur_s = d if d > 0 else None
    except (TypeError, ValueError):
        dur_s = None
    streams = data.get("streams") or []
    vw, vh = 1920, 1080
    fps = 60.0
    has_audio = False
    audio_codec_name = ""
    pixel_format = ""
    codec_name = ""
    for st in streams:
        if not isinstance(st, dict):
            continue
        ct = str(st.get("codec_type") or "")
        if ct == "video":
            try:
                vw = int(st.get("width") or vw)
                vh = int(st.get("height") or vh)
            except (TypeError, ValueError):
                pass
            fps = _resolve_video_fps(st, dur_s)
            pixel_format = str(st.get("pix_fmt") or "").strip().lower()
            codec_name = str(st.get("codec_name") or "").strip().lower()
        elif ct == "audio":
            has_audio = True
            if not audio_codec_name:
                audio_codec_name = str(st.get("codec_name") or "").strip().lower()
    has_alpha = pixel_format.startswith("yuva") or pixel_format in {"rgba", "argb", "bgra", "abgr", "gbrap", "gbrap10le", "gbrap12le", "gbrap16le"}
    return {
        "width": vw,
        "height": vh,
        "fps": fps,
        "has_audio": has_audio,
        "audio_codec_name": audio_codec_name,
        "duration": dur_s,
        "pixel_format": pixel_format,
        "codec_name": codec_name,
        "has_alpha": has_alpha,
    }


def validate_output_path(path_str: str) -> Path:
    raw = (path_str or "").strip()
    if not raw:
        raise MontageComposerError("MONTAGE_OUTPUT_PATH_EMPTY")
    p = Path(raw).expanduser()
    if not p.is_absolute():
        raise MontageComposerError("MONTAGE_OUTPUT_PATH_NOT_ABSOLUTE")
    if p.suffix.lower() != ".mp4":
        raise MontageComposerError("MONTAGE_OUTPUT_NOT_MP4")
    try:
        resolved = p.resolve()
    except OSError as e:
        raise MontageComposerError("MONTAGE_OUTPUT_PATH_INVALID") from e
    if ".." in p.parts:
        raise MontageComposerError("MONTAGE_OUTPUT_PATH_INVALID")
    parent = resolved.parent
    if not parent.exists():
        try:
            parent.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise MontageComposerError("MONTAGE_OUTPUT_PARENT_CREATE_FAILED") from e
    if parent.exists() and not parent.is_dir():
        raise MontageComposerError("MONTAGE_OUTPUT_DIR_NOT_FOLDER")
    return resolved


def build_bgm_filter(
    video_duration_sec: float,
    bgm_input_label: str = "[1:a]",
    volume: float = 1.0,
    start_sec: float = 0.0,
) -> str:
    """
    生成将 BGM 对齐到成片时长的 filter 片段（不含 amix）。
    BGM 短于成片则循环；长于成片则裁剪。start_sec 指定从音频第几秒开始使用。
    """
    d = max(0.01, float(video_duration_sec))
    vol = max(0.0, min(2.0, float(volume)))
    s = max(0.0, float(start_sec))
    # 先裁掉起始段，重置 PTS，再循环，再裁到视频时长
    seek = f"atrim=start={s:.6f},asetpts=N/SR/TB," if s > 1e-6 else ""
    return (
        f"{bgm_input_label}{seek}aloop=loop=-1:size=2e+09,atrim=0:{d:.6f},asetpts=N/SR/TB,"
        f"volume={vol:.6f}[bgmtrim]"
    )


def _concat_file_line(p: Path) -> str:
    s = p.resolve().as_posix()
    s = s.replace("'", "'\\''")
    return f"file '{s}'"


def _finalize_mp4_for_common_players(
    ffmpeg_bin: Path,
    src: Path,
    dst: Path,
    video_encode_fast: list[str],
) -> None:
    """
    concat 直拷 .ts → .mp4 在部分播放器上不可靠（moov/时间基/流封装）。
    统一重编码为 H.264（Main/High 依编码器）+ AAC-LC，并写入 faststart 便于随机访问。
    """
    cmd = [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(src),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        *video_encode_fast,
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
        str(dst),
    ]
    r = _run_ffmpeg_capture(
        cmd,
        timeout=7200,
        stage="montage_finalize",
        output_path=dst,
    )
    if r.returncode != 0:
        logger.error(
            "montage finalize mp4 failed returncode=%d command=%s stderr=%s",
            r.returncode,
            command_for_log(cmd),
            process_error_tail(r),
        )
        raise_hardware_encoder_failure(
            cmd,
            r,
            stage="montage_finalize",
            artifact_path=dst,
            public_code="MONTAGE_FINALIZE_FAILED",
        )
        raise MontageComposerError("MONTAGE_FINALIZE_FAILED")


_VALID_XFADE_TYPES = frozenset({
    "fade",
    "cut",
    "flash",
    "dip_black",
    "zoom",
    "none",
    # LiteCut extended built-ins → ffmpeg xfade transition names
    "wipe_l",
    "wipe_r",
    "slide_left",
    "slide_right",
    "slide_up",
    "slide_down",
    "blur",
    "glitch",
    "spin",
})

_IMAGE_EXTS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff"})


def _is_image_path(p: Path) -> bool:
    return p.suffix.lower() in _IMAGE_EXTS


def _image_to_ts_with_fade(
    *,
    ffmpeg_bin: Path,
    image_path: Path,
    out_ts: Path,
    width: int,
    height: int,
    fps: float,
    video_encode_quality: list[str],
    duration: float = 3.0,
    fade_duration: float = 0.5,
) -> None:
    """Convert a static image to an mpegts clip with fade-in and fade-out."""
    fps_s = f"{fps:.4f}".rstrip("0").rstrip(".")
    d = max(1.0, float(duration))
    fd = min(float(fade_duration), d / 3)
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,"
        f"fps={fps_s},setsar=1,format=yuv420p,"
        f"fade=t=in:st=0:d={fd:.4f},"
        f"fade=t=out:st={d - fd:.4f}:d={fd:.4f}"
    )
    cmd = [
        str(ffmpeg_bin),
        "-y", "-hide_banner", "-loglevel", "error",
        "-loop", "1",
        "-framerate", fps_s,
        "-i", str(image_path),
        "-filter_complex",
        f"[0:v]{vf}[v];anullsrc=r=48000:cl=stereo,atrim=0:{d:.6f},asetpts=N/SR/TB[a]",
        "-map", "[v]",
        "-map", "[a]",
        *video_encode_quality,
        "-c:a", "aac",
        "-b:a", "192k",
        "-t", str(d),
        str(out_ts),
    ]
    r = _run_ffmpeg_capture(
        cmd,
        timeout=120,
        stage="montage_image_to_video",
        output_path=out_ts,
    )
    if r.returncode != 0:
        logger.error(
            "image to video failed name=%s returncode=%d command=%s stderr=%s",
            image_path.name,
            r.returncode,
            command_for_log(cmd),
            process_error_tail(r),
        )
        raise_hardware_encoder_failure(
            cmd,
            r,
            stage="montage_image_to_video",
            artifact_path=out_ts,
            public_code="MONTAGE_IMAGE_TO_VIDEO_FAILED",
            public_params={"name": image_path.name},
        )
        raise MontageComposerError("MONTAGE_IMAGE_TO_VIDEO_FAILED", name=image_path.name)


def _xfade_transition_name(trans_type: str) -> str:
    """映射到 ffmpeg xfade 的 transition 名称。"""
    mapping = {
        "fade": "fade",
        "flash": "fadewhite",
        "dip_black": "fadeblack",
        "zoom": "zoomin",
        "wipe_l": "wipeleft",
        "wipe_r": "wiperight",
        "slide_left": "slideleft",
        "slide_right": "slideright",
        "slide_up": "slideup",
        "slide_down": "slidedown",
        "blur": "hblur",
        "glitch": "pixelize",
        "spin": "radial",
    }
    return mapping.get(trans_type, "fade")


def _parse_transition_for_edge(transitions: dict[str, Any], clip_row_id: int) -> tuple[str, float]:
    raw = transitions.get(str(int(clip_row_id)))
    if not isinstance(raw, dict):
        return "cut", 0.25
    t = str(raw.get("type") or "cut").strip().lower()
    if t not in _VALID_XFADE_TYPES:
        t = "cut"
    try:
        d = float(raw.get("duration", 0.25))
    except (TypeError, ValueError):
        d = 0.25
    if t == "none":
        d = 0.0
    return t, max(0.0, d)


def _is_hard_cut(t_type: str, t_dur: float, fps: float = 60.0) -> bool:
    """低于 1 帧时长或 type=none → 硬切，调用方直接 concat 而不走 xfade。"""
    min_xfade = max(1.0 / max(fps, 24.0), 0.02)
    return t_dur < min_xfade or t_type == "none"


def _clamp_xfade_duration(
    trans_type: str,
    requested: float,
    dur_a: float,
    dur_b: float,
    fps: float,
) -> float:
    """保证 xfade offset>0 且 duration 不超过相邻片段（仅在非硬切时调用）。"""
    frame = max(1.0 / max(fps, 24.0), 0.02)
    cap = min(float(dur_a), float(dur_b)) * 0.48 - 1e-4
    if cap < frame:
        return frame
    return max(frame, min(requested, cap, 1.5))


def _montage_xfade_chain_to_ts(
    *,
    ffmpeg_bin: Path,
    ffprobe: Path,
    clip_ts_paths: list[Path],
    clip_row_ids: list[int],
    transitions: dict[str, Any],
    fps: float,
    out_ts: Path,
    video_encode_quality: list[str],
) -> None:
    """将已归一化的 .ts 片段链用 xfade + acrossfade 连成单路 mpegts（片段需同分辨率/帧率）。"""
    n = len(clip_ts_paths)
    if n < 2:
        raise MontageComposerError("MONTAGE_TRANSITION_FAILED")
    if len(clip_row_ids) != n:
        raise MontageComposerError("MONTAGE_TRANSITION_FAILED")

    durs: list[float] = []
    for p in clip_ts_paths:
        info = probe_video_audio_summary(
            p,
            ffprobe,
            "montage_transition_probe",
            "intermediate",
        )
        d = info.get("duration")
        if d is None or float(d) <= 0:
            d = 0.1
        durs.append(float(d))

    fc: list[str] = []
    v_in = "[0:v]"
    a_in = "[0:a]"
    out_len = durs[0]

    for i in range(1, n):
        tid = int(clip_row_ids[i - 1])
        t_type, t_req = _parse_transition_for_edge(transitions, tid)
        td = _clamp_xfade_duration(t_type, t_req, out_len, durs[i], fps)
        if t_type in ("cut", "fade"):
            xname = "fade"
        else:
            xname = _xfade_transition_name(t_type)
        off = out_len - td
        if off < 1e-6:
            raise MontageComposerError("MONTAGE_TRANSITION_TOO_LONG")
        last = i == n - 1
        v_tag = "vout" if last else f"vxf{i}"
        a_tag = "aout" if last else f"axf{i}"
        fc.append(f"{v_in}[{i}:v]xfade=transition={xname}:duration={td:.6f}:offset={off:.6f}[{v_tag}]")
        fc.append(f"{a_in}[{i}:a]acrossfade=d={td:.6f}[{a_tag}]")
        v_in = f"[{v_tag}]"
        a_in = f"[{a_tag}]"
        out_len = out_len + durs[i] - td

    cmd: list[str] = [str(ffmpeg_bin), "-y", "-hide_banner", "-loglevel", "error"]
    for p in clip_ts_paths:
        cmd += ["-i", str(p)]
    cmd += [
        "-filter_complex",
        ";".join(fc),
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        *video_encode_quality,
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        str(out_ts),
    ]
    r = _run_ffmpeg_capture(
        cmd,
        timeout=7200,
        stage="montage_transition",
        output_path=out_ts,
    )
    if r.returncode != 0:
        logger.error(
            "montage xfade chain failed returncode=%d command=%s stderr=%s",
            r.returncode,
            command_for_log(cmd),
            process_error_tail(r),
        )
        raise_hardware_encoder_failure(
            cmd,
            r,
            stage="montage_transition",
            artifact_path=out_ts,
            public_code="MONTAGE_TRANSITION_FAILED",
        )
        raise MontageComposerError("MONTAGE_TRANSITION_FAILED")


# E2 HUD 支架配色（RGB 三元组）
_CATEGORY_ACCENT_RGB: dict[str, tuple[int, int, int]] = {
    "highlight":   (196, 240,  66),   # green  #C4F042
    "fail":        (255,  91,  91),   # red    #FF5B5B
    "meme_death":  (255,  91,  91),   # red    #FF5B5B
    "compilation": (255, 157,  46),   # orange #FF9D2E
}
_DEFAULT_ACCENT_RGB: tuple[int, int, int] = (196, 240, 66)

_CATEGORY_EYEBROW: dict[str, str] = {
    "highlight":   "HIGHLIGHT · 高光",
    "fail":        "LOWLIGHT · 下饭",
    "meme_death":  "MEME · 梗死亡",
    "compilation": "ROUND · 合集",
}
# How many seconds the name card stays visible at the start of each clip
_NAME_CARD_DISPLAY_SECS: float = 4.0
# Fade-in / fade-out duration (seconds)
_NAME_CARD_FADE_SECS: float = 0.4
# Pixels above the very bottom of the video frame
_NAME_CARD_BOTTOM_MARGIN: int = 120
# 名牌相对 1080p 设计稿的整体缩放（0.65 缩小 35% 后再 ×1.05 放大 5%）
_NAME_CARD_LAYOUT_SCALE: float = 0.65 * 1.05

# Rajdhani typography @ 1080p（字号 px；字距为 em，乘字号后得 px）
_TYPO_EYEBROW_PX = 13
_TYPO_EYEBROW_TRACK_EM = 0.22
_TYPO_NAME_PX = 28
_TYPO_NAME_TRACK_EM = 0.04
_TYPO_NAME_LINE_HEIGHT = 0.9
_TYPO_CHIP_PX = 14
_TYPO_CHIP_TRACK_EM = 0.04
_TYPO_CHIP_TEXT_OPACITY = 0.84
_TYPO_RESULT_LABEL_PX = 14
_TYPO_RESULT_LABEL_TRACK_EM = 0.24
_TYPO_RESULT_LABEL_OPACITY = 0.45
_TYPO_RESULT_VAL_PX = 30
_TYPO_RESULT_VAL_TRACK_EM = 0.02
_TYPO_RESULT_VAL_SHEAR_DEG = 12.0

# Regex that matches emoji / non-BMP characters msyh.ttc cannot render
import re as _re
_EMOJI_RE = _re.compile(
    "[\U00010000-\U0010FFFF"          # Non-BMP (most emoji)
    "\U00002600-\U000027BF"           # Misc Symbols, Dingbats
    "\U00002B50-\U00002B55"           # Stars
    "\U0000231A-\U0000231B"           # Watch, Hourglass
    "\U000023E9-\U000023F3"           # Arrows, Timers
    "\U000025AA-\U000025FE"           # Geometric shapes
    "\U00002614-\U00002615"           # Umbrella, Coffee
    "️"                          # Variation selector
    "]+",
    flags=_re.UNICODE,
)


def _strip_emoji(text: str) -> str:
    """去掉 msyh.ttc 无法渲染的 emoji 字符，保留中文和 ASCII 内容。"""
    return _EMOJI_RE.sub("", text).strip()


def _text_needs_cjk(text: str) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" for ch in text)


def _load_truetype_font(font_path: Path, size: int) -> Any:
    """加载 TrueType/OpenType/TTC，自动尝试 face index；失败则抛出。"""
    from PIL import ImageFont  # type: ignore[import]

    ext = font_path.suffix.lower()
    attempts: list[dict[str, int]] = []
    if ext == ".ttc":
        attempts = [{"index": i} for i in range(4)]
    else:
        attempts = [{}, {"index": 0}]

    last_err: Exception | None = None
    for kw in attempts:
        try:
            return ImageFont.truetype(str(font_path), size, **kw)
        except Exception as exc:
            last_err = exc
    if last_err is not None:
        raise last_err
    raise OSError(f"无法加载字体: {font_path}")


def _load_cjk_font(font_path: Optional[Path], size: int) -> Any:
    """CJK 常规/600：微软雅黑等 Regular；失败时回退候选列表。"""
    from PIL import ImageFont  # type: ignore[import]

    from .env_utils import _font_file_renders_cjk, _name_card_cjk_medium_candidates

    paths: list[Path] = []
    if font_path and font_path.is_file():
        paths.append(font_path)
    for candidate in _name_card_cjk_medium_candidates():
        if candidate not in paths:
            paths.append(candidate)

    for path in paths:
        if not path.is_file():
            continue
        if not _font_file_renders_cjk(path):
            continue
        try:
            return _load_truetype_font(path, size)
        except Exception:
            continue

    logger.warning("名牌 CJK 字体不可用，中文可能显示为方框")
    return ImageFont.load_default()


def _load_cjk_font_bold(font_path: Optional[Path], size: int) -> Any:
    """CJK 700 Bold：优先 backend/assets/fonts/NotoSansSC-Bold，否则系统粗体。"""
    from .env_utils import _font_file_renders_cjk, _name_card_cjk_bold_candidates

    paths: list[Path] = []
    if font_path and font_path.is_file():
        paths.append(font_path)
    for candidate in _name_card_cjk_bold_candidates():
        if candidate not in paths:
            paths.append(candidate)

    for path in paths:
        if not path.is_file() or not _font_file_renders_cjk(path):
            continue
        try:
            return _load_truetype_font(path, size)
        except Exception:
            continue
    bump = max(2, int(round(size * 0.1)))
    return _load_cjk_font(font_path, size + bump)


def _text_w(font: Any, text: str) -> int:
    try:
        bb = font.getbbox(text)
        return max(0, bb[2] - bb[0])
    except Exception:
        return len(text) * 8


def _typo_px(scale: float, design_px: int) -> int:
    return max(1, int(round(design_px * scale)))


def _typo_track_px(font_px: int, em: float) -> float:
    return font_px * em


def _white_rgba(opacity: float) -> tuple[int, int, int, int]:
    a = int(round(255 * max(0.0, min(1.0, opacity))))
    return (255, 255, 255, a)


def _text_width_tracked(font: Any, text: str, tracking_px: float) -> int:
    if not text:
        return 0
    total = 0.0
    for i, ch in enumerate(text):
        total += _text_w(font, ch)
        if i < len(text) - 1:
            total += tracking_px
    return int(round(total))


def _tracked_text_bbox(font: Any, text: str, tracking_px: float) -> tuple[int, int, int, int]:
    """跟踪字距后的整体 bbox：(x0, y0, x1, y1)，原点为绘制起点。"""
    if not text:
        return (0, 0, 0, 0)
    x_cur = 0.0
    y0, y1 = 10**9, -10**9
    for i, ch in enumerate(text):
        bb = font.getbbox(ch)
        y0 = min(y0, bb[1])
        y1 = max(y1, bb[3])
        x_cur += _text_w(font, ch) + (tracking_px if i < len(text) - 1 else 0)
    return (0, y0, int(round(x_cur)), y1)


def _font_line_height(font: Any, text: str) -> int:
    try:
        bb = font.getbbox(text or "Ay")
        return max(1, bb[3] - bb[1])
    except Exception:
        return getattr(font, "size", 12)


def _draw_text_tracked(
    draw: Any,
    x: int,
    y: int,
    text: str,
    font: Any,
    fill: Any,
    tracking_px: float,
) -> None:
    x_cur = x
    for i, ch in enumerate(text):
        draw.text((x_cur, y), ch, font=font, fill=fill)
        x_cur += _text_w(font, ch) + (tracking_px if i < len(text) - 1 else 0)


def _draw_text_tracked_center(
    draw: Any,
    cx: int,
    cy: int,
    text: str,
    font: Any,
    fill: Any,
    tracking_px: float,
) -> None:
    if not text:
        return
    bb = _tracked_text_bbox(font, text, tracking_px)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    x0 = cx - tw // 2
    y0 = cy - th // 2 - bb[1]
    _draw_text_tracked(draw, x0, y0, text, font, fill, tracking_px)


def _draw_text_tracked_middle(
    draw: Any,
    x: int,
    cy: int,
    text: str,
    font: Any,
    fill: Any,
    tracking_px: float,
) -> None:
    """左对齐绘制，整行相对 cy 垂直居中。"""
    if not text:
        return
    bb = _tracked_text_bbox(font, text, tracking_px)
    th = bb[3] - bb[1]
    y0 = cy - th // 2 - bb[1]
    _draw_text_tracked(draw, x, y0, text, font, fill, tracking_px)


def _paste_sheared_text(
    img: Any,
    pos: tuple[int, int],
    text: str,
    font: Any,
    fill: tuple[int, int, int, int],
    tracking_px: float,
    shear_deg: float = _TYPO_RESULT_VAL_SHEAR_DEG,
) -> tuple[int, int]:
    """在 RGBA 图层上绘制右倾伪斜体文字，返回占用宽高。"""
    from PIL import Image, ImageDraw  # type: ignore[import]

    if not text:
        return (0, 0)
    pad = 4
    text_w = _text_width_tracked(font, text, tracking_px)
    lh = _font_line_height(font, text)
    layer_w = text_w + pad * 2
    layer_h = lh + pad * 2
    layer = Image.new("RGBA", (layer_w, layer_h), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    _draw_text_tracked(ld, pad, pad - font.getbbox(text[0])[1], text, font, fill, tracking_px)
    shear = math.tan(math.radians(shear_deg))
    out_w = int(layer_w + abs(shear) * layer_h) + 2
    out_h = layer_h
    sheared = layer.transform(
        (out_w, out_h),
        Image.AFFINE,
        (1, shear, -shear * pad, 0, 1, 0),
        Image.BICUBIC,
    )
    img.alpha_composite(sheared, dest=pos)
    return (out_w, out_h)


def _chip_label(text: str) -> str:
    return f"[{text}]"


def _chip_render_w(
    font: Any,
    text: str,
    pad_x: int = 14,
    tracking_px: float = 0.0,
) -> int:
    return pad_x * 2 + _text_width_tracked(font, _chip_label(text), tracking_px)


def _blend_rgb(
    base: tuple[int, int, int],
    accent: tuple[int, int, int],
    *,
    alpha: float,
) -> tuple[int, int, int]:
    """accent 叠到 base 上，alpha∈[0,1]。"""
    t = max(0.0, min(1.0, alpha))
    return tuple(
        int(base[i] * (1.0 - t) + accent[i] * t) for i in range(3)
    )


def _apply_name_card_background(
    img: Any,
    card_w: int,
    card_h: int,
    scale: float,
) -> None:
    """整体深色半透明底 + 扫描线纹理（透明层，1px 白线 / 3px 步进 / alpha 6）。"""
    from PIL import Image, ImageDraw  # type: ignore[import]

    s = max(1.0, float(scale))

    # 整体卡片底：比初版略黑
    panel = Image.new("RGBA", (card_w, card_h), (6, 8, 6, 232))

    # 扫描线：透明底上画线，再叠到深色底（E2 规格：每 3px 一条 1px 白线 @ alpha 6）
    scan = Image.new("RGBA", (card_w, card_h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(scan)
    step = max(3, int(round(3 * s)))
    for sy in range(0, card_h, step):
        sd.line([(0, sy), (card_w - 1, sy)], fill=(255, 255, 255, 6), width=1)

    panel = Image.alpha_composite(panel, scan)
    img.paste(panel, (0, 0))


def _draw_corner_brackets_with_glow(
    img: Any,
    card_w: int,
    card_h: int,
    accent_rgb: tuple[int, int, int],
    scale: float,
) -> None:
    from PIL import Image, ImageDraw, ImageFilter  # type: ignore[import]

    ar, ag, ab = accent_rgb
    s = max(1.0, float(scale))
    B = max(13, int(15 * s))
    arm = max(2, int(2 * s))

    corners = [
        ((0, 0), (1, 0), (0, 1)),
        ((card_w - 1, 0), (-1, 0), (0, 1)),
        ((0, card_h - 1), (1, 0), (0, -1)),
        ((card_w - 1, card_h - 1), (-1, 0), (0, -1)),
    ]

    glow = Image.new("RGBA", (card_w, card_h), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    for (bx, by), (hx, hy), (vx, vy) in corners:
        for t in range(arm):
            gdraw.line(
                [(bx, by + vy * t), (bx + hx * (B - 1), by + vy * t)],
                fill=(ar, ag, ab, 255),
                width=arm,
            )
            gdraw.line(
                [(bx + hx * t, by), (bx + hx * t, by + vy * (B - 1))],
                fill=(ar, ag, ab, 255),
                width=arm,
            )
    glow = glow.filter(ImageFilter.GaussianBlur(radius=max(6, int(9 * s))))
    bloom = Image.new("RGBA", (card_w, card_h), (0, 0, 0, 0))
    bloom.paste(glow, (0, 0))
    bloom = bloom.filter(ImageFilter.GaussianBlur(radius=max(4, int(7 * s))))
    try:
        from PIL import ImageEnhance  # type: ignore[import]

        glow = ImageEnhance.Brightness(glow).enhance(1.65)
        bloom = ImageEnhance.Brightness(bloom).enhance(1.35)
    except Exception:
        pass
    img.alpha_composite(bloom)
    img.alpha_composite(glow)

    draw = ImageDraw.Draw(img)
    for (bx, by), (hx, hy), (vx, vy) in corners:
        for t in range(arm):
            draw.line(
                [(bx, by + vy * t), (bx + hx * (B - 1), by + vy * t)],
                fill=(ar, ag, ab, 255),
                width=1,
            )
            draw.line(
                [(bx + hx * t, by), (bx + hx * t, by + vy * (B - 1))],
                fill=(ar, ag, ab, 255),
                width=1,
            )


def _wrap_chips_rows(
    chips: list[str],
    font: Any,
    max_w: int,
    gap: int = 6,
    pad_x: int = 14,
    tracking_px: float = 0.0,
) -> list[list[str]]:
    rows: list[list[str]] = []
    row: list[str] = []
    row_w = 0
    for chip in chips:
        cw = _chip_render_w(font, chip, pad_x, tracking_px)
        needed = cw + (gap if row else 0)
        if row and row_w + needed > max_w:
            rows.append(row)
            row = [chip]
            row_w = cw
        else:
            row.append(chip)
            row_w += needed
    if row:
        rows.append(row)
    return rows


def _make_name_card_png(
    display_name: str,
    tags: list[str],
    accent_rgb: tuple[int, int, int],
    font_path: Optional[Path],
    avatar_path: Optional[Path],
    out_path: Path,
    eyebrow: str = "",
    result: Optional[str] = None,
    font_bold_path: Optional[Path] = None,
    font_semi_path: Optional[Path] = None,
    scale: float = 1.0,
) -> bool:
    """使用 Pillow 渲染名牌 PNG，返回是否成功。

    用 Python/Pillow 生成图片，完全绕开 FFmpeg drawtext 在 Windows 上的
    filtergraph 解析 bug（textfile= / fontfile= 路径中的冒号导致 filterchain
    边界解析失败）。PNG 随后作为第二路 -i 输入叠加到视频。
    tags 列表会自动按宽度折行。
    """
    try:
        from PIL import Image, ImageDraw, ImageFont  # type: ignore[import]
    except ImportError:
        return False

    ar, ag, ab = accent_rgb

    # Layout constants（1080p 基准 × 整体缩放；scale 随输出分辨率放大）
    s = max(1.0, min(float(scale), 2.25)) * _NAME_CARD_LAYOUT_SCALE
    CARD_W   = int(820 * s)
    PAD_X    = int(28 * s)
    PAD_Y    = int(22 * s)
    COL_GAP  = int(22 * s)
    AV_SIZE  = int(96 * s)

    # Typography @ 1080p 设计稿 × s
    EYEBROW_PX = _typo_px(s, _TYPO_EYEBROW_PX)
    NAME_PX = _typo_px(s, _TYPO_NAME_PX)
    CHIP_PX = _typo_px(s, _TYPO_CHIP_PX)
    RES_LABEL_PX = _typo_px(s, _TYPO_RESULT_LABEL_PX)
    RES_VAL_PX = _typo_px(s, _TYPO_RESULT_VAL_PX)
    EYEBROW_TRACK = _typo_track_px(EYEBROW_PX, _TYPO_EYEBROW_TRACK_EM)
    NAME_TRACK = _typo_track_px(NAME_PX, _TYPO_NAME_TRACK_EM)
    CHIP_TRACK = _typo_track_px(CHIP_PX, _TYPO_CHIP_TRACK_EM)
    RES_LABEL_TRACK = _typo_track_px(RES_LABEL_PX, _TYPO_RESULT_LABEL_TRACK_EM)
    RES_VAL_TRACK = _typo_track_px(RES_VAL_PX, _TYPO_RESULT_VAL_TRACK_EM)

    has_av     = bool(avatar_path and avatar_path.is_file())
    has_result = bool(result)

    # ── font loaders ────────────────────────────────────────────────────────
    def _load_latin(path: Optional[Path], size: int) -> Any:
        if path and path.is_file():
            try:
                return _load_truetype_font(path, size)
            except Exception:
                pass
        return _load_cjk_font(font_path, size)

    def _font_for(text: str, latin: Any, cjk: Any) -> Any:
        return cjk if _text_needs_cjk(text) else latin

    # 字重：眉标/chip/RESULT 标签 → 600 SemiBold；名字/战绩数值 → 700 Bold
    _cjk_medium = font_path or resolve_name_card_font()
    _cjk_bold = resolve_name_card_font_bold() or _cjk_medium
    _latin_semi = font_semi_path
    _latin_bold = font_bold_path or font_semi_path
    f_semi_cjk = _load_cjk_font(_cjk_medium, EYEBROW_PX)
    f_semi = _load_latin(_latin_semi, EYEBROW_PX)
    f_bold_cjk = _load_cjk_font_bold(_cjk_bold, NAME_PX)
    f_bold = _load_latin(_latin_bold, NAME_PX)
    f_chip_cjk = _load_cjk_font(_cjk_medium, CHIP_PX)
    f_chip_lat = _load_latin(_latin_semi, CHIP_PX)
    f_rlabel = _load_latin(_latin_semi, RES_LABEL_PX)
    f_rval_cjk = _load_cjk_font_bold(_cjk_bold, RES_VAL_PX)
    f_rval_lat = _load_latin(_latin_bold, RES_VAL_PX)

    # ── measure helpers ─────────────────────────────────────────────────────
    def _chip_font(text: str) -> Any:
        return _font_for(text, f_chip_lat, f_chip_cjk)

    chip_pad_x = max(8, int(8 * s))

    def _chip_w(text: str) -> int:
        return _chip_render_w(_chip_font(text), text, chip_pad_x, CHIP_TRACK)

    # ── text layout x-origin ────────────────────────────────────────────────
    text_x = PAD_X + (AV_SIZE + COL_GAP if has_av else 0)

    # ── result block width ──────────────────────────────────────────────────
    result_block_w = 0
    if has_result and result:
        clean_r = _strip_emoji(result)
        rv_font = _font_for(clean_r, f_rval_lat, f_rval_cjk)
        rv_w = _text_width_tracked(rv_font, clean_r, RES_VAL_TRACK)
        rv_h_est = int(RES_VAL_PX * 1.4)
        rv_w_shear = int(
            rv_w + abs(math.tan(math.radians(_TYPO_RESULT_VAL_SHEAR_DEG))) * rv_h_est
        )
        result_block_w = (
            1
            + COL_GAP
            + max(_text_width_tracked(f_rlabel, "RESULT", RES_LABEL_TRACK), rv_w_shear)
            + PAD_X
        )

    # ── chip wrapping ────────────────────────────────────────────────────────
    chip_gap = max(6, int(7 * s))
    chip_v_pad = max(4, int(5 * s))
    chip_row_h = _font_line_height(f_chip_cjk, "[标签]") + chip_v_pad * 2
    chips_area_w = CARD_W - text_x - (result_block_w if has_result else PAD_X)
    clean_chips  = [_strip_emoji(t) for t in tags if t]
    clean_chips  = [t for t in clean_chips if t]
    chip_rows = _wrap_chips_rows(
        clean_chips,
        f_chip_cjk,
        chips_area_w,
        chip_gap,
        chip_pad_x,
        CHIP_TRACK,
    )

    # ── content height（title / name / tags 等距留白）────────────────────────
    block_gap = max(6, int(8 * s))
    clean_eb_pre = _strip_emoji(eyebrow).upper()
    eb_font_pre = _font_for(clean_eb_pre, f_semi, f_semi_cjk) if clean_eb_pre else f_semi
    if clean_eb_pre:
        eb_bb_pre = _tracked_text_bbox(eb_font_pre, clean_eb_pre, EYEBROW_TRACK)
        eyebrow_h = (eb_bb_pre[3] - eb_bb_pre[1]) + int(4 * s)
    else:
        eyebrow_h = EYEBROW_PX + int(4 * s)
    clean_n_pre = _strip_emoji(display_name)
    name_upper = clean_n_pre.upper() if clean_n_pre else ""
    n_font_pre = _font_for(name_upper, f_bold, f_bold_cjk) if name_upper else f_bold
    if name_upper:
        n_bb_pre = n_font_pre.getbbox(name_upper[0])
        for ch in name_upper[1:]:
            bb = n_font_pre.getbbox(ch)
            n_bb_pre = (
                min(n_bb_pre[0], bb[0]),
                min(n_bb_pre[1], bb[1]),
                max(n_bb_pre[2], bb[2]),
                max(n_bb_pre[3], bb[3]),
            )
        name_glyph_h = max(1, n_bb_pre[3] - n_bb_pre[1])
    else:
        n_bb_pre = (0, 0, 0, NAME_PX)
        name_glyph_h = NAME_PX
    name_zone_h = max(name_glyph_h, int(round(NAME_PX * _TYPO_NAME_LINE_HEIGHT)))

    chips_total_h = len(chip_rows) * (chip_row_h + chip_gap) - chip_gap if chip_rows else 0
    text_content_h = eyebrow_h + block_gap + name_zone_h + block_gap
    if chip_rows:
        text_content_h += chips_total_h
    card_h = max(text_content_h + PAD_Y * 2, AV_SIZE + PAD_Y * 2, int(108 * s))

    # ── create canvas ─────────────────────────────────────────────────────
    img = Image.new("RGBA", (CARD_W, card_h), (0, 0, 0, 0))
    _apply_name_card_background(img, CARD_W, card_h, s)
    draw = ImageDraw.Draw(img)

    # Outer border: accent @ alpha 71
    draw.rectangle([0, 0, CARD_W - 1, card_h - 1], outline=(ar, ag, ab, 71), width=1)

    # ── avatar ────────────────────────────────────────────────────────────
    if has_av:
        try:
            av_img = Image.open(str(avatar_path)).convert("RGBA").resize(
                (AV_SIZE, AV_SIZE), Image.LANCZOS
            )
            av_y = (card_h - AV_SIZE) // 2
            img.paste(av_img, (PAD_X, av_y), av_img)
            # 1px border accent@153
            draw.rectangle(
                [PAD_X - 1, av_y - 1, PAD_X + AV_SIZE, av_y + AV_SIZE],
                outline=(ar, ag, ab, 153), width=1,
            )
            # Right-bottom corner tick (10×10, 2px)
            tx = PAD_X + AV_SIZE
            ty = av_y + AV_SIZE
            draw.line([(tx, ty - 10), (tx, ty)], fill=(ar, ag, ab, 255), width=2)
            draw.line([(tx - 10, ty), (tx, ty)], fill=(ar, ag, ab, 255), width=2)
        except Exception:
            pass

    # ── text block (vertically centered) ─────────────────────────────────
    ty0 = (card_h - text_content_h) // 2

    # Eyebrow bar + text（同一垂直中心线）
    clean_eb = _strip_emoji(eyebrow).upper()
    eb_font = _font_for(clean_eb, f_semi, f_semi_cjk)
    eb_row_cy = ty0 + eyebrow_h // 2
    bar_w = max(14, int(16 * s))
    bar_h_px = max(2, int(2 * s))
    bar_y = eb_row_cy - bar_h_px // 2
    draw.rectangle(
        [text_x, bar_y, text_x + bar_w - 1, bar_y + bar_h_px - 1],
        fill=(ar, ag, ab, 255),
    )
    _draw_text_tracked_middle(
        draw,
        text_x + bar_w + int(7 * s),
        eb_row_cy,
        clean_eb,
        eb_font,
        (ar, ag, ab, 255),
        EYEBROW_TRACK,
    )

    # Name — line-height 0.9 行框内垂直居中
    clean_n = name_upper
    n_font = n_font_pre
    n_bb = n_bb_pre
    title_bottom = ty0 + eyebrow_h
    chips_top = title_bottom + block_gap + name_zone_h + block_gap
    name_draw_y = title_bottom + block_gap + (name_zone_h - name_glyph_h) // 2 - n_bb[1]
    _draw_text_tracked(
        draw,
        text_x,
        name_draw_y,
        clean_n,
        n_font,
        (255, 255, 255, 255),
        NAME_TRACK,
    )

    # Chips：低调底色 + 标签文字在框内居中
    chip_fill = _blend_rgb((10, 12, 9), (ar, ag, ab), alpha=0.12)
    chip_border = _blend_rgb((18, 20, 16), (ar, ag, ab), alpha=0.28)
    cy = chips_top
    for row in chip_rows:
        cx = text_x
        for chip_text in row:
            cw = _chip_w(chip_text)
            cf = _chip_font(chip_text)
            label = _chip_label(chip_text)
            chip_box = [cx, cy, cx + cw - 1, cy + chip_row_h - 1]
            draw.rectangle(chip_box, fill=chip_fill, outline=chip_border, width=1)
            bb = _tracked_text_bbox(cf, label, CHIP_TRACK)
            tw, th = bb[2] - bb[0], bb[3] - bb[1]
            tx = cx + (cw - tw) // 2
            ty = cy + (chip_row_h - th) // 2 - bb[1]
            _draw_text_tracked(
                draw,
                tx,
                ty,
                label,
                cf,
                _white_rgba(_TYPO_CHIP_TEXT_OPACITY),
                CHIP_TRACK,
            )
            cx += cw + chip_gap
        cy += chip_row_h + chip_gap

    # ── RESULT block (highlight only) ────────────────────────────────────
    if has_result and result:
        clean_r = _strip_emoji(result)
        div_x   = CARD_W - result_block_w
        # divider line
        draw.line([(div_x, PAD_Y), (div_x, card_h - PAD_Y)], fill=(ar, ag, ab, 64), width=1)
        rx = div_x + COL_GAP
        # "RESULT" label
        rl_h = _font_line_height(f_rlabel, "RESULT") + int(4 * s)
        rv_font = _font_for(clean_r, f_rval_lat, f_rval_cjk)
        rv_shear_h = int(RES_VAL_PX * 1.5)
        block_h = rl_h + int(4 * s) + rv_shear_h
        ry0 = (card_h - block_h) // 2
        _draw_text_tracked(
            draw,
            rx,
            ry0,
            "RESULT",
            f_rlabel,
            _white_rgba(_TYPO_RESULT_LABEL_OPACITY),
            RES_LABEL_TRACK,
        )
        _paste_sheared_text(
            img,
            (rx, ry0 + rl_h + int(4 * s)),
            clean_r,
            rv_font,
            (ar, ag, ab, 255),
            RES_VAL_TRACK,
            _TYPO_RESULT_VAL_SHEAR_DEG,
        )

    _draw_corner_brackets_with_glow(img, CARD_W, card_h, accent_rgb, s)

    img.save(str(out_path), "PNG")
    return True


def _fg_escape_path(p: Path) -> str:
    """Wrap a path in single quotes for use in an FFmpeg filtergraph option value.

    Single-quote wrapping protects ':' in Windows drive letters (e.g. C:/) from
    being misinterpreted as an FFmpeg option separator.  Using \\: backslash
    escaping instead was found to cause filterchain parse failures in FFmpeg 8.1
    on Windows (the parser incorrectly merges subsequent filter chains).
    Any literal single quotes in the path are backslash-escaped before wrapping.
    """
    safe = str(p).replace('\\', '/').replace("'", "\\'")
    return f"'{safe}'"


def _fg_escape_text(s: str) -> str:
    """Escape text for FFmpeg drawtext text= option."""
    return s.replace('\\', '\\\\').replace(':', '\\:').replace("'", "\\'").replace('\n', ' ')


def _compose_montage_once(
    *,
    ffmpeg_bin: Path,
    clip_paths: list[Path],
    intro_path: Optional[Path],
    outro_path: Optional[Path],
    bgm_path: Optional[Path],
    output_path: Path,
    transitions: Optional[dict[str, Any]] = None,
    clip_row_ids: Optional[list[int]] = None,
    bgm_volume: Optional[float] = None,
    bgm_start_sec: Optional[float] = None,
    intro_image_duration: Optional[float] = None,
    outro_image_duration: Optional[float] = None,
    montage_encoder: str = "auto",
    name_cards: Optional[list[dict | None]] = None,
    framemeld_enabled: bool = False,
    encoder_device_args: Sequence[str] | None = None,
) -> None:
    if not clip_paths:
        raise MontageComposerError("MONTAGE_CLIPS_EMPTY")
    for c in clip_paths:
        if not c.is_file():
            raise MontageComposerError("MONTAGE_CLIP_FILE_MISSING", name=c.name)
    if intro_path is not None and not intro_path.is_file():
        raise MontageComposerError("MONTAGE_INTRO_MISSING")
    if outro_path is not None and not outro_path.is_file():
        raise MontageComposerError("MONTAGE_OUTRO_MISSING")
    if bgm_path is not None and not bgm_path.is_file():
        raise MontageComposerError("MONTAGE_BGM_MISSING")

    _codec = str(montage_encoder or "libx264").strip().lower()
    video_encode_quality = apply_encoder_device_args(
        h264_encode_cli_args(_codec, "quality"),
        encoder_device_args,
    )
    video_encode_fast = apply_encoder_device_args(
        h264_encode_cli_args(_codec, "fast"),
        encoder_device_args,
    )

    ffprobe = resolve_ffprobe_binary(ffmpeg_bin)

    _font_path = resolve_name_card_font()
    _font_semi_path, _font_bold_path = resolve_rajdhani_fonts()

    intro_n = 1 if intro_path is not None else 0
    n_clips = len(clip_paths)

    tmpdir = tempfile.mkdtemp(prefix="cs2_montage_", dir=str(output_path.parent))
    try:
        working_clip_paths = list(clip_paths)

        # 以首段为主分辨率；启用 Blur 时保留所有片段中的最高有效帧率，
        # 避免高帧素材先被压到首段帧率后再交给插帧器。
        ref = probe_video_audio_summary(working_clip_paths[0], ffprobe)
        w, h, fps = int(ref["width"]), int(ref["height"]), float(ref["fps"])
        if w <= 0 or h <= 0:
            raise MontageComposerError("MONTAGE_FIRST_CLIP_NO_RESOLUTION")
        _name_card_scale = max(1.0, min(h / 1080.0, 2.25))

        segments: list[Path] = []
        if intro_path is not None:
            segments.append(intro_path)
        segments.extend(working_clip_paths)
        if outro_path is not None:
            segments.append(outro_path)

        probed_segment_info: dict[Path, dict[str, Any]] = {
            working_clip_paths[0].resolve(): ref,
        }
        framemeld_source_fps_values: list[float] = []
        if framemeld_enabled:
            for segment in segments:
                if _is_image_path(segment):
                    continue
                resolved_segment = segment.resolve()
                try:
                    info = probed_segment_info.get(resolved_segment)
                    if info is None:
                        info = probe_video_audio_summary(segment, ffprobe)
                        probed_segment_info[resolved_segment] = info
                    segment_fps = float(info.get("fps") or 0)
                    if segment_fps < 1.0:
                        raise ValueError("invalid source frame rate")
                    framemeld_source_fps_values.append(segment_fps)
                except (MontageComposerError, OSError, TypeError, ValueError):
                    raise MontageComposerError(
                        "MONTAGE_FRAMEMELD_SOURCE_FPS_REQUIRED",
                        name=segment.name,
                    )
            if not framemeld_sources_are_compatible(framemeld_source_fps_values):
                raise MontageComposerError("MONTAGE_FRAMEMELD_MIXED_SOURCE_FPS")
            fps = framemeld_working_fps(framemeld_source_fps_values)
        fps_s = f"{fps:.4f}".rstrip("0").rstrip(".")

        _intro_img_dur = max(1.0, float(intro_image_duration)) if intro_image_duration is not None else 3.0
        _outro_img_dur = max(1.0, float(outro_image_duration)) if outro_image_duration is not None else 3.0
        _intro_idx = 0 if intro_path is not None else -1
        _outro_idx = len(segments) - 1 if outro_path is not None else -1

        normed: list[Path] = []
        for i, seg in enumerate(segments):
            out_ts = Path(tmpdir) / f"norm_{i:03d}.ts"
            if _is_image_path(seg):
                img_dur = _intro_img_dur if i == _intro_idx else _outro_img_dur
                _image_to_ts_with_fade(
                    ffmpeg_bin=ffmpeg_bin,
                    image_path=seg,
                    out_ts=out_ts,
                    width=w,
                    height=h,
                    fps=fps,
                    video_encode_quality=video_encode_quality,
                    duration=img_dur,
                )
                normed.append(out_ts)
                continue
            info = probed_segment_info.get(seg.resolve()) or probe_video_audio_summary(seg, ffprobe)
            dur = info.get("duration")
            if dur is None or dur <= 0:
                dur = 0.1
            vf = (
                f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
                f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps={fps_s},setsar=1,format=yuv420p"
            )

            # Determine whether this segment gets a name card overlay.
            # "有卡"（_use_card）只要有名字即可；"有头像"（_has_avatar）需头像文件存在。
            # 无头像时仍烧名字框，只是文字左移填满卡片。
            _clip_index = i - intro_n
            _is_clip_seg = (name_cards is not None and 0 <= _clip_index < len(name_cards))
            _card = name_cards[_clip_index] if _is_clip_seg else None
            _use_card = bool(
                _card is not None
                and isinstance(_card, dict)
                and _card.get("enabled")
                and str(_card.get("display_name") or "").strip()
            )
            _has_avatar = (
                _use_card
                and bool(_card.get("avatar_path"))
                and Path(str(_card["avatar_path"])).is_file()
            )

            # 名牌覆层：用 Pillow 预渲染 PNG，作为第二路 -i 输入叠加。
            # 完全避开 FFmpeg drawtext 在 Windows 8.1 构建上的 filtergraph 解析 bug
            # （textfile= / fontfile= 路径中的冒号导致 filterchain 边界解析失败）。
            card_png: Optional[Path] = None
            card_h = 70  # 实际高度由 _make_name_card_png 动态计算后写回
            if _use_card:
                name_str      = str(_card.get("display_name") or "")
                card_tags: list[str] = [t for t in _card.get("tags") or [] if t]
                category_val  = str(_card.get("category") or "")
                accent_rgb    = _CATEGORY_ACCENT_RGB.get(category_val, _DEFAULT_ACCENT_RGB)
                eyebrow_str   = str(_card.get("eyebrow") or _CATEGORY_EYEBROW.get(category_val, ""))
                result_str    = _card.get("result") or None
                av_path       = Path(str(_card["avatar_path"])) if _has_avatar else None
                card_png_path = Path(tmpdir) / f"nc_card_{i:03d}.png"
                ok = _make_name_card_png(
                    display_name=name_str,
                    tags=card_tags,
                    accent_rgb=accent_rgb,
                    font_path=_font_path,
                    avatar_path=av_path,
                    out_path=card_png_path,
                    eyebrow=eyebrow_str,
                    result=result_str,
                    font_bold_path=_font_bold_path,
                    font_semi_path=_font_semi_path,
                    scale=_name_card_scale,
                )
                if ok:
                    card_png = card_png_path
                    # 读取实际渲染高度（用于 overlay 定位）
                    try:
                        from PIL import Image as _PILImage  # type: ignore[import]
                        card_h = _PILImage.open(str(card_png)).size[1]
                    except Exception:
                        card_h = 100 if _has_avatar else 70

            if card_png is not None:
                # 名牌 PNG 作为 input[1]，用 -loop 1 让单帧图持续供给整段时长。
                # filtergraph 里无路径字符串，彻底规避 Windows 路径冒号转义问题。
                #
                # 渐入渐出：fade 滤镜对 alpha 通道操作（alpha=1），让名牌透明地
                # 淡入淡出，而非黑场过渡。
                # 时间窗：overlay 的 enable='between(t,0,N)' 控制显示时长；
                # 此处 overlay 选项里无 Windows 路径，不会触发之前的解析 bug。
                _display = _NAME_CARD_DISPLAY_SECS
                _fade    = _NAME_CARD_FADE_SECS
                # 渐出起点：如果片段比显示窗短，渐出从 (dur-fade) 开始，避免越界
                _fade_out_st = max(0.0, min(_display - _fade, float(dur) - _fade))
                fade_flt = (
                    f"fade=t=in:st=0:d={_fade}:alpha=1,"
                    f"fade=t=out:st={_fade_out_st:.3f}:d={_fade}:alpha=1"
                )
                _card_y = card_h + int(_NAME_CARD_BOTTOM_MARGIN * _name_card_scale)
                overlay_opts = f"0:H-{_card_y}:enable='between(t,0,{_display})'"
                if info["has_audio"]:
                    fc = (
                        f"[0:v]{vf}[_scaled];"
                        f"[1:v]{fade_flt}[_card];"
                        f"[_scaled][_card]overlay={overlay_opts}[v];"
                        f"[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a]"
                    )
                else:
                    fc = (
                        f"[0:v]{vf}[_scaled];"
                        f"[1:v]{fade_flt}[_card];"
                        f"[_scaled][_card]overlay={overlay_opts}[v];"
                        f"anullsrc=r=48000:cl=stereo,atrim=0:{float(dur):.6f},asetpts=N/SR/TB[a]"
                    )
            else:
                if info["has_audio"]:
                    fc = f"[0:v]{vf}[v];[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a]"
                else:
                    fc = (
                        f"[0:v]{vf}[v];"
                        f"anullsrc=r=48000:cl=stereo,atrim=0:{float(dur):.6f},asetpts=N/SR/TB[a]"
                    )

            cmd = [
                str(ffmpeg_bin),
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(seg),
            ]
            if card_png is not None:
                # -loop 1: 将单帧 PNG 循环成无限长流，匹配视频时长
                cmd += ["-loop", "1", "-i", str(card_png)]
            cmd += [
                "-filter_complex",
                fc,
                "-map",
                "[v]",
                "-map",
                "[a]",
                *video_encode_quality,
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-shortest",
                str(out_ts),
            ]
            r = _run_ffmpeg_capture(
                cmd,
                timeout=3600,
                stage="montage_clip_normalize",
                output_path=out_ts,
            )
            if r.returncode != 0:
                logger.error(
                    "clip normalize failed name=%s returncode=%d command=%s stderr=%s",
                    seg.name,
                    r.returncode,
                    command_for_log(cmd),
                    process_error_tail(r),
                )
                raise_hardware_encoder_failure(
                    cmd,
                    r,
                    stage="montage_clip_normalize",
                    artifact_path=out_ts,
                    public_code="MONTAGE_CLIP_NORMALIZE_FAILED",
                    public_params={"name": seg.name},
                )
                raise MontageComposerError("MONTAGE_CLIP_NORMALIZE_FAILED", name=seg.name)
            normed.append(out_ts)

        has_transitions = bool(
            transitions is not None
            and isinstance(transitions, dict)
            and clip_row_ids is not None
            and len(clip_row_ids) == n_clips
            and n_clips >= 2
        )

        if has_transitions:
            # 按硬切边界（duration=0 或 type=none）拆成若干组；
            # 组内片段用 xfade 连接，组间直接 concat——这样 0s 转场就是真正的硬切。
            clip_norm = normed[intro_n : intro_n + n_clips]
            ids = [int(x) for x in clip_row_ids]

            grp_clips: list[Path] = [clip_norm[0]]
            grp_ids: list[int] = [ids[0]]
            groups: list[tuple[list[Path], list[int]]] = []

            for i in range(1, n_clips):
                t_type, t_dur = _parse_transition_for_edge(transitions, ids[i - 1])
                if _is_hard_cut(t_type, t_dur, fps):
                    groups.append((grp_clips, grp_ids))
                    grp_clips = [clip_norm[i]]
                    grp_ids = [ids[i]]
                else:
                    grp_clips.append(clip_norm[i])
                    grp_ids.append(ids[i])
            groups.append((grp_clips, grp_ids))

            processed: list[Path] = []
            for gi, (g_clips, g_ids) in enumerate(groups):
                if len(g_clips) == 1:
                    processed.append(g_clips[0])
                else:
                    grp_ts = Path(tmpdir) / f"clips_xfade_g{gi:03d}.ts"
                    _montage_xfade_chain_to_ts(
                        ffmpeg_bin=ffmpeg_bin,
                        ffprobe=ffprobe,
                        clip_ts_paths=g_clips,
                        clip_row_ids=g_ids,
                        transitions=transitions,
                        fps=fps,
                        out_ts=grp_ts,
                        video_encode_quality=video_encode_quality,
                    )
                    processed.append(grp_ts)

            concat_paths: list[Path] = []
            if intro_path is not None:
                concat_paths.append(normed[0])
            concat_paths.extend(processed)
            if outro_path is not None:
                concat_paths.append(normed[-1])
        else:
            concat_paths = normed

        concat_list = Path(tmpdir) / "concat.txt"
        lines = [_concat_file_line(p) for p in concat_paths]
        concat_list.write_text("\n".join(lines) + "\n", encoding="utf-8")

        mid_mp4 = Path(tmpdir) / "mid.mp4"
        cmd_concat = [
            str(ffmpeg_bin),
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_list),
            "-c",
            "copy",
            str(mid_mp4),
        ]
        r2 = _run_ffmpeg_capture(
            cmd_concat,
            timeout=3600,
            stage="montage_concat",
            output_path=mid_mp4,
        )
        if r2.returncode != 0:
            logger.error(
                "montage concat failed returncode=%d command=%s stderr=%s",
                r2.returncode,
                command_for_log(cmd_concat),
                process_error_tail(r2),
            )
            raise MontageComposerError("MONTAGE_CONCAT_FAILED")

        mid_playable = Path(tmpdir) / "mid_playable.mp4"
        _finalize_mp4_for_common_players(ffmpeg_bin, mid_mp4, mid_playable, video_encode_fast)

        mid_info = ffprobe_streams(
            mid_playable,
            ffprobe,
            "montage_finalize_probe",
            "intermediate",
        )
        try:
            vdur = float((mid_info.get("format") or {}).get("duration") or 0)
        except (TypeError, ValueError):
            vdur = 0.0
        if vdur <= 0:
            vdur = 0.01

        if bgm_path is None:
            shutil.move(str(mid_playable), str(output_path))
        else:
            bgm_vol = 1.0 if bgm_volume is None else max(0.0, min(2.0, float(bgm_volume)))
            bgm_start = 0.0 if bgm_start_sec is None else max(0.0, float(bgm_start_sec))

            fc_mix = (
                f"[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[ga];"
                f"{build_bgm_filter(vdur, '[1:a]', volume=bgm_vol, start_sec=bgm_start)};"
                f"[ga][bgmtrim]amix=inputs=2:duration=first:dropout_transition=0[aout]"
            )
            cmd_mix = [
                str(ffmpeg_bin),
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(mid_playable),
                "-i",
                str(bgm_path),
                "-filter_complex",
                fc_mix,
                "-map",
                "0:v",
                "-map",
                "[aout]",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart",
                str(output_path),
            ]
            r3 = _run_ffmpeg_capture(
                cmd_mix,
                timeout=3600,
                stage="montage_bgm_mix",
                output_path=output_path,
            )
            if r3.returncode != 0:
                logger.error(
                    "montage bgm mix failed returncode=%d command=%s stderr=%s",
                    r3.returncode,
                    command_for_log(cmd_mix),
                    process_error_tail(r3),
                )
                raise MontageComposerError("MONTAGE_BGM_MIX_FAILED")

        if framemeld_enabled:
            capability = probe_framemeld(ffmpeg_bin)
            if capability is None:
                raise MontageComposerError("MONTAGE_FRAMEMELD_REQUIRED")
            framemeld_base = Path(tmpdir) / "framemeld_base.mp4"
            shutil.move(str(output_path), str(framemeld_base))
            cmd_framemeld = build_framemeld_command(
                ffmpeg_bin=ffmpeg_bin,
                source_path=framemeld_base,
                output_path=output_path,
                video_encode_args=video_encode_quality,
                capability=capability,
            )
            r4 = _run_ffmpeg_capture(
                cmd_framemeld,
                timeout=3600,
                stage="montage_framemeld",
                output_path=output_path,
            )
            if r4.returncode != 0:
                logger.error(
                    "montage FrameMeld failed returncode=%d command=%s stderr=%s",
                    r4.returncode,
                    command_for_log(cmd_framemeld),
                    process_error_tail(r4),
                )
                raise_hardware_encoder_failure(
                    cmd_framemeld,
                    r4,
                    stage="montage_framemeld",
                    artifact_path=output_path,
                    public_code="MONTAGE_EXPORT_FAILED",
                )
                raise MontageComposerError("MONTAGE_EXPORT_FAILED")
    finally:
        try:
            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            logger.debug("montage temp cleanup failed", exc_info=True)


def compose_montage(
    *,
    ffmpeg_bin: Path,
    clip_paths: list[Path],
    intro_path: Optional[Path],
    outro_path: Optional[Path],
    bgm_path: Optional[Path],
    output_path: Path,
    transitions: Optional[dict[str, Any]] = None,
    clip_row_ids: Optional[list[int]] = None,
    bgm_volume: Optional[float] = None,
    bgm_start_sec: Optional[float] = None,
    intro_image_duration: Optional[float] = None,
    outro_image_duration: Optional[float] = None,
    montage_encoder: str = "auto",
    name_cards: Optional[list[dict | None]] = None,
    framemeld_enabled: bool = False,
) -> Any:
    """Export with GPU-aware target probing and an x264 safety fallback."""

    from .encoder_planner import (
        EncoderCandidate,
        EncoderTargetSpec,
        build_encoder_candidates,
        enumerate_windows_gpus,
        map_nvenc_device_indices,
        probe_ffmpeg_encoder,
        run_encoder_attempts,
    )

    if not clip_paths:
        raise MontageComposerError("MONTAGE_CLIPS_EMPTY")
    for source in clip_paths:
        if not source.is_file():
            raise MontageComposerError("MONTAGE_CLIP_FILE_MISSING", name=source.name)
    if intro_path is not None and not intro_path.is_file():
        raise MontageComposerError("MONTAGE_INTRO_MISSING")
    if outro_path is not None and not outro_path.is_file():
        raise MontageComposerError("MONTAGE_OUTRO_MISSING")
    if bgm_path is not None and not bgm_path.is_file():
        raise MontageComposerError("MONTAGE_BGM_MISSING")

    ffprobe = resolve_ffprobe_binary(ffmpeg_bin)
    # Probe every original video before selecting an encoder.  Any failure here
    # is a source problem and must not trigger a hardware fallback.
    source_videos = [
        *clip_paths,
        *(
            [intro_path]
            if intro_path is not None and not _is_image_path(intro_path)
            else []
        ),
        *(
            [outro_path]
            if outro_path is not None and not _is_image_path(outro_path)
            else []
        ),
    ]
    source_info: dict[Path, dict[str, Any]] = {}
    for source in source_videos:
        try:
            source_info[source] = probe_video_audio_summary(
                source,
                ffprobe,
                "montage_source_preflight",
                "source",
            )
        except MontageComposerError as exc:
            hinted = add_ffmpeg_compatibility_hint(exc, ffmpeg_bin)
            if hinted is exc:
                raise
            raise hinted from exc
    ref = source_info[clip_paths[0]]
    width = int(ref.get("width") or 0)
    height = int(ref.get("height") or 0)
    fps = float(ref.get("fps") or 0)
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
    spec = EncoderTargetSpec(
        width=width,
        height=height,
        frame_rate=fps,
        pixel_format="yuv420p",
        profile="high",
        tier="quality",
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
        remove_partial_file(attempt_output)

    def _convert_generated_probe_failure(
        candidate: EncoderCandidate,
        exc: MontageComposerError,
    ) -> None:
        generated_probe_failure = (
            exc.code == "MONTAGE_FFPROBE_FAILED"
            and exc.params.get("file_role") in {"intermediate", "final"}
        )
        if not generated_probe_failure:
            return
        if not candidate.is_software:
            raise HardwareEncoderFailure(
                codec=candidate.codec,
                stage=str(exc.params.get("stage") or "montage_generated_probe"),
                artifact_path=str(exc.params.get("name") or attempt_output.name),
                public_code=exc.code,
                public_params=exc.params,
            ) from exc
        raise MontageComposerError(
            "MONTAGE_OUTPUT_NOT_PLAYABLE",
            stage=str(exc.params.get("stage") or "montage_generated_probe"),
            name=str(exc.params.get("name") or attempt_output.name),
        ) from exc

    def _run_candidate(candidate: EncoderCandidate) -> None:
        _cleanup_attempt()
        try:
            _compose_montage_once(
                ffmpeg_bin=ffmpeg_bin,
                clip_paths=clip_paths,
                intro_path=intro_path,
                outro_path=outro_path,
                bgm_path=bgm_path,
                output_path=attempt_output,
                transitions=transitions,
                clip_row_ids=clip_row_ids,
                bgm_volume=bgm_volume,
                bgm_start_sec=bgm_start_sec,
                intro_image_duration=intro_image_duration,
                outro_image_duration=outro_image_duration,
                montage_encoder=candidate.codec,
                name_cards=name_cards,
                framemeld_enabled=framemeld_enabled,
                encoder_device_args=candidate.ffmpeg_device_args,
            )
            final_info = ffprobe_streams(
                attempt_output,
                ffprobe,
                "montage_output_validation",
                "final",
            )
        except MontageComposerError as exc:
            _convert_generated_probe_failure(candidate, exc)
            raise
        streams = final_info.get("streams") or []
        video_stream = next(
            (
                stream
                for stream in streams
                if isinstance(stream, dict) and stream.get("codec_type") == "video"
            ),
            None,
        )
        if video_stream is None:
            if not candidate.is_software:
                raise HardwareEncoderFailure(
                    codec=candidate.codec,
                    stage="montage_output_validation",
                    artifact_path=attempt_output,
                    public_code="MONTAGE_OUTPUT_NOT_PLAYABLE",
                )
            raise MontageComposerError("MONTAGE_OUTPUT_NOT_PLAYABLE")
        output_encoder = str((video_stream.get("tags") or {}).get("encoder") or "unknown")
        logger.info(
            "Montage output encoder candidate=%s actual=%s",
            candidate.codec,
            output_encoder,
        )
        decode_command = [
            str(ffmpeg_bin),
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(attempt_output),
            "-map",
            "0:v:0",
            "-t",
            "3",
            "-f",
            "null",
            "-",
        ]
        try:
            decoded = run_process_capture(decode_command, timeout=3600)
        except (OSError, subprocess.SubprocessError) as exc:
            if not candidate.is_software:
                raise HardwareEncoderFailure(
                    codec=candidate.codec,
                    stage="montage_output_decode",
                    stderr=str(exc),
                    artifact_path=attempt_output,
                    public_code="MONTAGE_OUTPUT_NOT_PLAYABLE",
                    command=decode_command,
                ) from exc
            raise MontageComposerError("MONTAGE_OUTPUT_NOT_PLAYABLE") from exc
        if decoded.returncode != 0:
            if not candidate.is_software:
                raise HardwareEncoderFailure(
                    codec=candidate.codec,
                    stage="montage_output_decode",
                    returncode=decoded.returncode,
                    stderr=process_error_tail(decoded),
                    artifact_path=attempt_output,
                    public_code="MONTAGE_OUTPUT_NOT_PLAYABLE",
                    command=decode_command,
                )
            raise MontageComposerError("MONTAGE_OUTPUT_NOT_PLAYABLE")
        try:
            os.replace(attempt_output, output_path)
        except OSError as exc:
            raise MontageComposerError("MONTAGE_OUTPUT_PATH_INVALID") from exc

    def _on_attempt(attempt: Any) -> None:
        logger.info(
            "Montage encoder attempt candidate=%s status=%s stage=%s detail=%s",
            attempt.candidate.display_name,
            attempt.status,
            attempt.stage,
            attempt.detail[-600:],
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
            on_attempt=_on_attempt,
        )
    except MontageComposerError as exc:
        hinted = add_ffmpeg_compatibility_hint(exc, ffmpeg_bin)
        if hinted is exc:
            raise
        raise hinted from exc
    finally:
        _cleanup_attempt()
