from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Any

from app.radar.radar_data_extractor import _normalize_record_segments, extract_radar_timeline
from app.radar.radar_renderer import render_radar_frames

logger = logging.getLogger(__name__)


class RadarOverlaySkip(Exception):
    """当前片段无法生成雷达覆盖时抛出。"""


RADAR_SIZE = 300
RADAR_MARGIN = 32


def _first_value(row: dict[str, Any], keys: list[str]) -> Any:
    for key in keys:
        value = row.get(key)
        if value not in (None, ""):
            return value
    return None


def _require_clip_meta(clip_row: dict[str, Any]) -> dict[str, Any]:
    demo_path = _first_value(clip_row, ["demo_path"])
    map_name = _first_value(clip_row, ["map_name", "map"])
    start_tick = _first_value(
        clip_row,
        ["record_start_tick", "start_tick", "tick_start", "clip_start_tick"],
    )
    end_tick = _first_value(
        clip_row,
        ["record_end_tick", "end_tick", "tick_end", "clip_end_tick"],
    )
    pov_steamid64 = _first_value(
        clip_row,
        ["pov_steamid64", "steamid64", "target_steamid64", "steamid", "target_steam_id"],
    )
    pov_player_name = _first_value(
        clip_row,
        ["pov_player_name", "target_player", "player_name", "player"],
    )

    if not demo_path:
        raise RadarOverlaySkip("缺少 demo_path")
    if not map_name:
        raise RadarOverlaySkip("缺少 map_name")
    if not pov_steamid64 and not pov_player_name:
        raise RadarOverlaySkip("缺少 POV 玩家标识")

    demo_path_obj = Path(str(demo_path))
    if not demo_path_obj.exists():
        raise RadarOverlaySkip(f"demo 文件不存在: {demo_path}")

    dr_raw = _first_value(clip_row, ["demo_tick_rate"])
    try:
        demo_tick_rate = float(dr_raw) if dr_raw is not None else 64.0
    except (TypeError, ValueError):
        demo_tick_rate = 64.0
    if demo_tick_rate <= 0:
        demo_tick_rate = 64.0

    rs_off_raw = clip_row.get("radar_sync_offset_sec")
    try:
        radar_sync_offset_sec = float(rs_off_raw) if rs_off_raw is not None else 0.0
    except (TypeError, ValueError):
        radar_sync_offset_sec = 0.0

    raw_rs = clip_row.get("record_segments")
    record_segments_list: list[dict[str, Any]] = []
    if isinstance(raw_rs, list):
        record_segments_list = [x for x in raw_rs if isinstance(x, dict)]

    norm_seg = _normalize_record_segments(record_segments_list, demo_tick_rate)

    if norm_seg:
        start_tick_int = min(int(s["start_tick"]) for s in norm_seg)
        end_tick_int = max(int(s["end_tick"]) for s in norm_seg)
        if end_tick_int <= start_tick_int:
            raise RadarOverlaySkip("record_segments 无效：end_tick 必须大于 start_tick")
    else:
        if start_tick is None or end_tick is None:
            raise RadarOverlaySkip("缺少 start_tick/end_tick")
        try:
            start_tick_int = int(start_tick)
            end_tick_int = int(end_tick)
        except Exception as exc:
            raise RadarOverlaySkip("start_tick/end_tick 不是有效整数") from exc

        if end_tick_int <= start_tick_int:
            raise RadarOverlaySkip("end_tick 必须大于 start_tick")

    raw_timing = clip_row.get("radar_timing")
    radar_timing: dict[str, Any] | None = raw_timing if isinstance(raw_timing, dict) else None

    return {
        "demo_path": str(demo_path_obj),
        "map_name": str(map_name),
        "start_tick": start_tick_int,
        "end_tick": end_tick_int,
        "pov_steamid64": str(pov_steamid64) if pov_steamid64 else None,
        "pov_player_name": str(pov_player_name) if pov_player_name else None,
        "demo_tick_rate": float(demo_tick_rate),
        "radar_sync_offset_sec": float(radar_sync_offset_sec),
        "record_segments": record_segments_list,
        "radar_timing": radar_timing,
    }


def _probe_video_size(ffprobe: Path, clip_path: Path) -> tuple[int, int]:
    cmd = [
        str(ffprobe),
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=s=x:p=0",
        str(clip_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RadarOverlaySkip(f"ffprobe 获取视频尺寸失败: {result.stderr.strip()}")

    raw = result.stdout.strip()
    try:
        width_s, height_s = raw.split("x")
        return int(width_s), int(height_s)
    except Exception as exc:
        raise RadarOverlaySkip(f"无法解析视频尺寸: {raw}") from exc


def _probe_video_fps(ffprobe: Path, clip_path: Path) -> float:
    cmd = [
        str(ffprobe),
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=avg_frame_rate",
        "-of",
        "default=nokey=1:noprint_wrappers=1",
        str(clip_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RadarOverlaySkip(f"ffprobe 获取 FPS 失败: {result.stderr.strip()}")

    raw = result.stdout.strip()
    try:
        if "/" in raw:
            n, d = raw.split("/", 1)
            fps = float(n) / float(d)
        else:
            fps = float(raw)
    except Exception as exc:
        raise RadarOverlaySkip(f"无法解析 FPS: {raw}") from exc

    if fps <= 0:
        raise RadarOverlaySkip("FPS 无效")

    return fps


def _probe_duration_sec(ffprobe: Path, clip_path: Path) -> float:
    cmd = [
        str(ffprobe),
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=duration",
        "-of",
        "default=nokey=1:noprint_wrappers=1",
        str(clip_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RadarOverlaySkip(f"ffprobe 获取时长失败: {result.stderr.strip()}")
    raw = result.stdout.strip()
    try:
        d = float(raw)
    except Exception as exc:
        raise RadarOverlaySkip(f"无法解析时长: {raw}") from exc
    if d <= 0:
        raise RadarOverlaySkip("视频时长无效")
    return d


def _overlay_xy(video_width: int) -> tuple[int, int]:
    """
    后期雷达固定覆盖到视频左上角。

    video_width 参数保留是为了兼容现有调用处。
    左上角位置不需要依赖视频宽度。
    """
    _ = video_width
    return RADAR_MARGIN, RADAR_MARGIN


def apply_radar_overlay_to_clip(
    *,
    ffmpeg_bin: Path,
    ffprobe: Path,
    clip_path: Path,
    clip_row: dict[str, Any],
    tmpdir: Path,
    index: int,
    video_encode_quality: list[str],
) -> Path:
    meta = _require_clip_meta(clip_row)

    video_width, _video_height = _probe_video_size(ffprobe, clip_path)
    fps = _probe_video_fps(ffprobe, clip_path)
    duration_sec = _probe_duration_sec(ffprobe, clip_path)

    radar_dir = tmpdir / f"radar_frames_{index:03d}"
    radar_dir.mkdir(parents=True, exist_ok=True)

    # Demo 解析路径：从 .dem 文件按录制 tick 区间提取位置数据。
    # 数据来源是 demo tick（64-128 Hz），无 GSI 频率过低导致的闪烁，
    # 颜色直接读 player_color 字段，准确无误。
    try:
        timeline = extract_radar_timeline(
            demo_path=meta["demo_path"],
            map_name=meta["map_name"],
            pov_player_name=meta["pov_player_name"],
            pov_steamid64=meta["pov_steamid64"],
            start_tick=meta["start_tick"],
            end_tick=meta["end_tick"],
            fps=fps,
            duration_sec=duration_sec,
            demo_tick_rate=float(meta.get("demo_tick_rate") or 64.0),
            radar_sync_offset_sec=float(meta.get("radar_sync_offset_sec") or 0.0),
            record_segments=meta.get("record_segments") or [],
            radar_timing=meta.get("radar_timing"),
        )
    except Exception as exc:
        raise RadarOverlaySkip(f"雷达数据提取失败: {exc}") from exc

    if not timeline:
        raise RadarOverlaySkip("雷达时间线为空")

    try:
        render_radar_frames(
            timeline=timeline,
            map_name=meta["map_name"],
            output_dir=radar_dir,
            size=RADAR_SIZE,
            clip_id=_first_value(clip_row, ["clip_id", "id"]),
            circular_frame=True,
        )
    except RuntimeError as exc:
        raise RadarOverlaySkip(str(exc)) from exc

    frame_pattern = radar_dir / "radar_%06d.png"
    if not (radar_dir / "radar_000001.png").exists():
        raise RadarOverlaySkip("雷达帧生成失败")

    out_path = tmpdir / f"clip_with_radar_{index:03d}.mp4"
    x, y = _overlay_xy(video_width)

    cmd = [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(clip_path),
        "-framerate",
        f"{fps:.3f}",
        "-i",
        str(frame_pattern),
        "-filter_complex",
        f"[0:v][1:v]overlay={x}:{y}:format=auto[v]",
        "-map",
        "[v]",
        "-map",
        "0:a?",
        *video_encode_quality,
        "-c:a",
        "copy",
        "-shortest",
        str(out_path),
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        logger.warning("雷达覆盖 copy audio 失败，尝试转码音频: %s", result.stderr.strip())
        cmd = [
            str(ffmpeg_bin),
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(clip_path),
            "-framerate",
            f"{fps:.3f}",
            "-i",
            str(frame_pattern),
            "-filter_complex",
            f"[0:v][1:v]overlay={x}:{y}:format=auto[v]",
            "-map",
            "[v]",
            "-map",
            "0:a?",
            *video_encode_quality,
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-shortest",
            str(out_path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RadarOverlaySkip(f"FFmpeg 雷达覆盖失败: {result.stderr.strip()}")

    if not out_path.exists():
        raise RadarOverlaySkip("雷达覆盖输出文件不存在")

    return out_path
