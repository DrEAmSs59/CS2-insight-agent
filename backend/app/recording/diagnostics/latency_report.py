"""把一次（或多次）录制的成片回读成叠加层延迟报告。

流程只有三步：从录制产物 JSON 拿到成片路径与"页面打算闪白"的预期时刻，从成片里量出
实际闪白时刻，两者相减。均值是固定偏置——自动校准要补偿的就是它；标准差是抖动，它才是
``--enable-begin-frame-scheduling`` 这类改动的判据：偏置变了无所谓，抖动收窄才算有效。

刻意不做的事：不猜、不插值、不在样本不足时给结论。闪白配不上、成片读不到、自检没开
都直接如实报出来，因为这些报告是用来决定要不要改默认配置的。
"""

from __future__ import annotations

import json
import logging
import math
from pathlib import Path
from typing import Any, Optional, Sequence

from .onset_probe import (
    CropRect,
    OnsetProbeError,
    calibration_marker_crop,
    find_flashes,
    match_flashes,
    parse_diff_trace,
    probe_motion_onset,
    summarize_offsets,
)

logger = logging.getLogger(__name__)

# 每组至少要这么多个闪白样本才谈抖动差异。标准差的估计误差约 1/sqrt(2(n-1))，n=30 时
# 还有 13%，再少下去两组的差异基本被自身误差吃掉。
MIN_SAMPLES_PER_GROUP = 30
# 比这更小的抖动差异即便统计上成立也不值得据此改默认配置：60fps 一帧 16.7ms，1ms 的
# 抖动变化在成片上看不出来。
MIN_JITTER_EFFECT_SEC = 0.001
_SIGNIFICANCE_SIGMAS = 2.0
_MAX_REPORTED_OFFSETS = 400


def _expected_flash_times(result: dict[str, Any]) -> list[float]:
    markers = result.get("calibration_markers") or []
    out: list[float] = []
    for marker in markers:
        if not isinstance(marker, dict):
            continue
        try:
            out.append(float(marker["video_sec"]))
        except (KeyError, TypeError, ValueError):
            continue
    return sorted(out)


def measure_clip_latency(
    *,
    ffmpeg_bin: Path,
    source: Path,
    expected_flash_sec: Sequence[float],
    crop: CropRect,
    timeout_sec: float = 600.0,
) -> dict[str, Any]:
    """量一条成片：返回配对结果与统计。

    分析窗口不做裁剪——闪白散布在整条成片里，只看开头会漏掉后面的样本。
    """
    onset, trace = probe_motion_onset(
        ffmpeg_bin=ffmpeg_bin,
        source=source,
        crop=crop,
        timeout_sec=timeout_sec,
    )
    flashes = find_flashes(trace)
    measured = [frame.pts_sec for frame in flashes]
    pairs, unmatched = match_flashes(expected_flash_sec, measured)

    report: dict[str, Any] = {
        "source": str(source),
        "crop": {"x": crop.x, "y": crop.y, "width": crop.width, "height": crop.height},
        "frame_count": len(trace),
        "expected_count": len(list(expected_flash_sec)),
        "measured_count": len(measured),
        "pairs": pairs,
        "unmatched_expected_sec": unmatched,
        "offsets": summarize_offsets([pair["offset_sec"] for pair in pairs]),
        # 噪声窗内就已经有跳变，说明标记区域在开头不是静止的，量出来的时刻不可信。
        "baseline_static": onset.baseline_static,
        "threshold": round(onset.threshold, 4),
    }
    if not pairs:
        report["problem"] = "no_flash_matched"
    elif unmatched:
        report["problem"] = "some_flashes_missing"
    elif not onset.baseline_static:
        report["problem"] = "baseline_not_static"
    return report


def default_ffmpeg_bin() -> Path:
    """跟成片导出用同一个 ffmpeg：配置项 → 内置 third_party → PATH。"""
    from ...env_utils import load_config
    from ...video_composer import resolve_ffmpeg_binary

    return resolve_ffmpeg_binary(load_config().ffmpeg_path)


def measure_result_file(
    result_path: Path,
    *,
    ffmpeg_bin: Optional[Path] = None,
    base_width: int,
    output_width: int,
    timeout_sec: float = 600.0,
) -> dict[str, Any]:
    """按录制产物 JSON 量一条成片。

    ``base_width`` / ``output_width`` 来自 OBS 的画布与输出分辨率：输出被降采样时，
    成片里的标记比画布上小，裁剪框要跟着缩。
    """
    result = json.loads(Path(result_path).read_text(encoding="utf-8"))
    expected = _expected_flash_times(result)
    output_path = str(result.get("output_path") or "").strip()

    base: dict[str, Any] = {"result": str(result_path), "request_id": result.get("request_id")}
    if not expected:
        return {**base, "problem": "calibration_not_enabled"}
    if not output_path or not Path(output_path).is_file():
        return {**base, "problem": "output_missing", "output_path": output_path}

    if ffmpeg_bin is None:
        try:
            ffmpeg_bin = default_ffmpeg_bin()
        except Exception as exc:  # noqa: BLE001 - 缺 ffmpeg 是要如实报出的一种 problem
            return {**base, "problem": "ffmpeg_missing", "error": str(exc)}

    crop = calibration_marker_crop(base_width=base_width, output_width=output_width)
    try:
        measured = measure_clip_latency(
            ffmpeg_bin=ffmpeg_bin,
            source=Path(output_path),
            expected_flash_sec=expected,
            crop=crop,
            timeout_sec=timeout_sec,
        )
    except OnsetProbeError as exc:
        return {**base, "problem": "probe_failed", "error": str(exc)}
    return {**base, **measured}


def _stddev(samples: Sequence[float]) -> Optional[float]:
    """不做四舍五入的标准差——判显著性时 0.1ms 的取整误差会被门槛放大。"""
    count = len(samples)
    if count < 2:
        return None
    mean = sum(samples) / count
    return math.sqrt(sum((value - mean) ** 2 for value in samples) / count)


def _jitter_standard_error(stddev: Optional[float], count: int) -> Optional[float]:
    """标准差这个估计量自身的误差，约 ``σ / sqrt(2(n-1))``。

    样本少的时候标准差本身就抖得厉害：n=10 时它的相对误差已经到 24%，所以两组标准差
    差了多少要拿这个尺度去比，不能直接看大小。
    """
    if stddev is None or count < 2:
        return None
    return stddev / math.sqrt(2 * (count - 1))


def compare_runs(
    label_a: str,
    reports_a: Sequence[dict[str, Any]],
    label_b: str,
    reports_b: Sequence[dict[str, Any]],
    *,
    min_samples: int = MIN_SAMPLES_PER_GROUP,
    min_effect_sec: float = MIN_JITTER_EFFECT_SEC,
) -> dict[str, Any]:
    """两组录制的对照结论。

    判据是抖动：``stddev`` 明显收窄才说明浏览器源与 OBS 合成真的锁上了相位。偏置变化
    只是需要重新校准，不构成好坏。

    只有同时满足三个条件才会宣布某一组更稳：两组样本都够（``min_samples``）、差异超过
    估计误差的 ``_SIGNIFICANCE_SIGMAS`` 倍、且差异本身大到值得在意（``min_effect_sec``）。
    达不到就报 ``inconclusive`` 或 ``underpowered``——这个结论要用来改默认配置，宁可说
    "测不出来"也不能拿噪声当结果。
    """

    def _pool(reports: Sequence[dict[str, Any]]) -> dict[str, Any]:
        offsets = [
            float(pair["offset_sec"])
            for report in reports
            for pair in (report.get("pairs") or [])
            if pair.get("offset_sec") is not None
        ]
        pooled: dict[str, Any] = {
            "clips": len(reports),
            "samples": len(offsets),
            "stats": summarize_offsets(offsets),
            "problems": sorted({str(r["problem"]) for r in reports if r.get("problem")}),
        }
        # 原始偏置一并带上：几十个样本时，双峰（整帧级错位）和均匀抖动的均值标准差可能
        # 很接近，但成因完全不同，只有看分布才分得出来。
        if offsets:
            ordered = sorted(round(value, 5) for value in offsets)
            pooled["offsets_sorted"] = ordered[:_MAX_REPORTED_OFFSETS]
            if len(ordered) > _MAX_REPORTED_OFFSETS:
                pooled["offsets_truncated"] = len(ordered) - _MAX_REPORTED_OFFSETS
        return pooled

    pooled_a = _pool(reports_a)
    pooled_b = _pool(reports_b)
    out: dict[str, Any] = {label_a: pooled_a, label_b: pooled_b}

    offsets_a = [float(v) for v in (pooled_a.get("offsets_sorted") or [])]
    offsets_b = [float(v) for v in (pooled_b.get("offsets_sorted") or [])]
    jitter_a = _stddev(offsets_a)
    jitter_b = _stddev(offsets_b)
    if jitter_a is None or jitter_b is None:
        out["verdict"] = "insufficient_samples"
        return out

    error_a = _jitter_standard_error(jitter_a, len(offsets_a)) or 0.0
    error_b = _jitter_standard_error(jitter_b, len(offsets_b)) or 0.0
    combined_error = math.sqrt(error_a**2 + error_b**2)
    required = max(_SIGNIFICANCE_SIGMAS * combined_error, float(min_effect_sec))
    delta = jitter_a - jitter_b  # 正数表示 B 更稳

    out["jitter"] = {
        label_a: round(jitter_a, 5),
        label_b: round(jitter_b, 5),
        "delta_sec": round(delta, 5),
        "required_delta_sec": round(required, 5),
        "combined_standard_error_sec": round(combined_error, 5),
        "min_samples": int(min_samples),
        "min_effect_sec": float(min_effect_sec),
    }

    if len(offsets_a) < int(min_samples) or len(offsets_b) < int(min_samples):
        out["verdict"] = "underpowered"
    elif abs(delta) < required:
        out["verdict"] = "inconclusive"
    elif delta > 0:
        out["verdict"] = f"{label_b}_less_jitter"
    else:
        out["verdict"] = f"{label_a}_less_jitter"
    return out


def read_diff_trace_file(path: Path) -> list[Any]:
    """读回一份已导出的差分曲线，便于离线复核判定参数而不重跑 ffmpeg。"""
    return parse_diff_trace(Path(path).read_text(encoding="utf-8", errors="replace"))


def summarize_problems(reports: Sequence[dict[str, Any]]) -> Optional[str]:
    """所有报告都失败时给出统一原因，用于命令行直接提示而不是打印一堆 JSON。"""
    problems = {str(report["problem"]) for report in reports if report.get("problem")}
    if not problems or len(problems) > 1:
        return None
    return problems.pop()
