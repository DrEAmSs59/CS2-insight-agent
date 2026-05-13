"""合辑导出：解析 FFmpeg 硬件/软件 H.264 编码器及命令行参数。"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Literal

MontageEncoderTier = Literal["quality", "fast"]


def _composer_err(msg: str) -> None:
    from .video_composer import MontageComposerError

    raise MontageComposerError(msg)

_VALID_USER_MODES = frozenset({"auto", "libx264", "h264_nvenc", "h264_qsv", "h264_amf"})
_HW_ORDER = ("h264_nvenc", "h264_qsv", "h264_amf")

_encoder_check_cache: dict[str, frozenset[str]] = {}
# FFmpeg 常把 NVENC/QSV/AMF 编进列表，但无对应硬件时打开编码器会失败；auto 需实测。
_hw_probe_cache: dict[tuple[str, str], bool] = {}


def _minimal_h264_probe_encode_args(codec: str) -> list[str]:
    """单帧 lavfi 探测用参数（与成片不必一致，但求各编码器能接受）。"""
    if codec == "libx264":
        return ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "35", "-pix_fmt", "yuv420p"]
    if codec == "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p7", "-pix_fmt", "yuv420p"]
    if codec == "h264_qsv":
        return [
            "-c:v",
            "h264_qsv",
            "-preset",
            "veryfast",
            "-global_quality",
            "28",
            "-pix_fmt",
            "yuv420p",
        ]
    if codec == "h264_amf":
        return [
            "-c:v",
            "h264_amf",
            "-quality",
            "speed",
            "-rc",
            "cqp",
            "-qp_i",
            "28",
            "-qp_p",
            "30",
            "-pix_fmt",
            "yuv420p",
        ]
    return []


def _hw_encoder_runtime_ok(ffmpeg_bin: Path, codec: str) -> bool:
    if codec not in _HW_ORDER:
        return True
    key = (str(ffmpeg_bin.resolve()), codec)
    if key in _hw_probe_cache:
        return _hw_probe_cache[key]
    extra = _minimal_h264_probe_encode_args(codec)
    if not extra:
        _hw_probe_cache[key] = False
        return False
    cmd = [
        str(ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=64x64:r=1:d=0.05,format=yuv420p",
        "-frames:v",
        "1",
        "-an",
        *extra,
        "-f",
        "null",
        "-",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
        ok = proc.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        ok = False
    _hw_probe_cache[key] = ok
    return ok


def _ffmpeg_encoder_names(ffmpeg_bin: Path) -> frozenset[str]:
    key = str(ffmpeg_bin.resolve())
    if key in _encoder_check_cache:
        return _encoder_check_cache[key]
    proc = subprocess.run(
        [str(ffmpeg_bin), "-hide_banner", "-encoders"],
        capture_output=True,
        text=True,
        timeout=90,
    )
    text = (proc.stdout or "") + (proc.stderr or "")
    found: set[str] = set()
    for line in text.splitlines():
        parts = line.split(None, 2)
        if len(parts) >= 2 and parts[0].startswith("V"):
            found.add(parts[1])
    _encoder_check_cache[key] = frozenset(found)
    return _encoder_check_cache[key]


def resolve_h264_codec_name(ffmpeg_bin: Path, user_mode: str) -> str:
    """
    user_mode: auto（NVENC→QSV→AMF→libx264；硬件项除 -encoders 外再做单帧实测）或明确编码器名。
    """
    raw = (user_mode or "auto").strip().lower()
    if raw not in _VALID_USER_MODES:
        raw = "auto"
    avail = _ffmpeg_encoder_names(ffmpeg_bin)

    if raw == "auto":
        for name in _HW_ORDER:
            if name in avail and _hw_encoder_runtime_ok(ffmpeg_bin, name):
                return name
        if "libx264" in avail:
            return "libx264"
        _composer_err(
            "当前 FFmpeg 未包含可用的 H.264 编码器（需要 libx264 或硬件编码器）。",
        )

    if raw not in avail:
        if raw in _HW_ORDER:
            _composer_err(
                f"当前 FFmpeg 未编译 {raw}，请在配置中将「合辑视频编码」改为「自动」或 libx264，"
                "或安装带对应编码器的 FFmpeg 构建。",
            )
        if raw == "libx264" and "libx264" not in avail:
            _composer_err("当前 FFmpeg 未包含 libx264。")
        _composer_err(f"当前 FFmpeg 不包含编码器: {raw}")

    return raw


def h264_encode_cli_args(codec: str, tier: MontageEncoderTier) -> list[str]:
    """
    返回 -c:v 起的参数列表（含 pix_fmt / profile 等），不含输入输出路由。
    quality：片段归一化、转场、雷达叠层（对标原 crf 18 / medium）。
    fast：成片兼容重编码（对标原 crf 20 / faster）。
    """
    if tier == "quality":
        if codec == "libx264":
            return [
                "-c:v",
                "libx264",
                "-preset",
                "medium",
                "-crf",
                "18",
                "-profile:v",
                "main",
                "-pix_fmt",
                "yuv420p",
            ]
        if codec == "h264_nvenc":
            return [
                "-c:v",
                "h264_nvenc",
                "-preset",
                "p4",
                "-rc",
                "vbr",
                "-cq",
                "20",
                "-bf",
                "2",
                "-profile:v",
                "high",
                "-pix_fmt",
                "yuv420p",
            ]
        if codec == "h264_qsv":
            return [
                "-c:v",
                "h264_qsv",
                "-preset",
                "medium",
                "-global_quality",
                "22",
                "-profile:v",
                "high",
                "-pix_fmt",
                "yuv420p",
            ]
        if codec == "h264_amf":
            return [
                "-c:v",
                "h264_amf",
                "-quality",
                "balanced",
                "-rc",
                "cqp",
                "-qp_i",
                "20",
                "-qp_p",
                "22",
                "-pix_fmt",
                "yuv420p",
            ]
    else:
        if codec == "libx264":
            return [
                "-c:v",
                "libx264",
                "-preset",
                "faster",
                "-crf",
                "20",
                "-profile:v",
                "main",
                "-level",
                "4.0",
                "-pix_fmt",
                "yuv420p",
            ]
        if codec == "h264_nvenc":
            return [
                "-c:v",
                "h264_nvenc",
                "-preset",
                "p6",
                "-rc",
                "vbr",
                "-cq",
                "22",
                "-bf",
                "2",
                "-profile:v",
                "high",
                "-pix_fmt",
                "yuv420p",
            ]
        if codec == "h264_qsv":
            return [
                "-c:v",
                "h264_qsv",
                "-preset",
                "fast",
                "-global_quality",
                "24",
                "-profile:v",
                "high",
                "-pix_fmt",
                "yuv420p",
            ]
        if codec == "h264_amf":
            return [
                "-c:v",
                "h264_amf",
                "-quality",
                "speed",
                "-rc",
                "cqp",
                "-qp_i",
                "22",
                "-qp_p",
                "24",
                "-pix_fmt",
                "yuv420p",
            ]

    _composer_err(f"不支持的编码器: {codec}")
