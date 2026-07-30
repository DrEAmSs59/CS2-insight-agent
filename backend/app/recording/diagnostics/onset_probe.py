"""从成片里量出画面"开始变化"的时刻。

录制开头必然有一段静帧：OBS 已经开始录制，但 demo 还停在暂停状态等 spec 切换完成。
因此把画面逐帧与上一帧相减、取区域内平均绝对差，得到的曲线是"一段接近噪声底的平台
之后突然跳起"——跳起那一帧就是该区域真正开始动的时刻。用它测 demo 起播比读 OBS 的
``outputDuration`` 精确得多，后者只有百毫秒级分辨率且不含淡入。

阈值不写死。静帧上的差分也不是严格 0（编码噪声随码率、分辨率、编码器而变），所以先
用开头若干帧估噪声底，再取 中位数 + k·MAD 作门槛，换机器不用重新调参。

注意区域的选取：叠加层（键盘 / KillFX）是半透明地压在游戏画面上的，demo 一开始播放，
叠加层区域内的背景就一直在变，"首次变化"测到的是背景而不是叠加层。这个模块只负责给
出某个矩形的变化起点，"哪个矩形的变化能代表叠加层"由调用方保证——实测台的做法是让
叠加层在一个专用角落画高对比度校准标记，而不是去分析生产视觉。
"""

from __future__ import annotations

import logging
import math
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Sequence

from ...ffmpeg_process import command_for_log, process_error_tail, run_process_capture

logger = logging.getLogger(__name__)

# tblend 的首帧输出没有可比的前一帧，数值不可信，默认丢弃。
_DEFAULT_SKIP_FRAMES = 1
# 估噪声底用的帧数：40 帧在 60fps 下约 0.67 秒，短于任何一次 spec 切换的静帧长度。
_DEFAULT_BASELINE_FRAMES = 40
# MAD 到标准差的一致化系数（正态假设）。
_MAD_TO_SIGMA = 1.4826
_DEFAULT_K = 12.0
# YAVG 取值范围 0..255。静帧区域的差分通常远小于 1，0.75 能挡住编码噪声又不至于
# 漏掉真实跳变（一次画面切换的平均绝对差通常是十位数）。
_DEFAULT_MIN_VALUE = 0.75

_FRAME_HEADER = re.compile(r"^frame:(\d+)\s+pts:(-?\d+|N/A)\s+pts_time:(\S+)")
_YAVG_LINE = re.compile(r"^lavfi\.signalstats\.YAVG=(-?[\d.]+(?:[eE][-+]?\d+)?)\s*$")


class OnsetProbeError(RuntimeError):
    """ffmpeg 不可用、读不出轨迹等无法给出结论的情况。"""


# 校准标记闪白的时长（毫秒），与 keyboard.html 的 CAL_FLASH_MS 对应。
CALIBRATION_FLASH_MS = 100
# 相邻校准 tick 的最小间隔：一次闪白要撑 CALIBRATION_FLASH_MS，间隔太近会并成一次。
MIN_CALIBRATION_TICK_GAP_SEC = 1.0


@dataclass(frozen=True)
class CropRect:
    """输出画布上的像素矩形（左上角原点）。"""

    x: int
    y: int
    width: int
    height: int

    def __post_init__(self) -> None:
        if self.width <= 0 or self.height <= 0:
            raise ValueError("crop width/height must be positive")
        if self.x < 0 or self.y < 0:
            raise ValueError("crop x/y must be non-negative")

    def to_filter(self) -> str:
        return f"crop={self.width}:{self.height}:{self.x}:{self.y}"

    def scaled_by(self, factor: float) -> "CropRect":
        """按比例缩放：OBS 输出分辨率低于画布时，成片里的像素坐标要跟着缩。"""
        scale = float(factor)
        return CropRect(
            x=int(round(self.x * scale)),
            y=int(round(self.y * scale)),
            width=max(1, int(round(self.width * scale))),
            height=max(1, int(round(self.height * scale))),
        )

    def inset(self, margin: int) -> "CropRect":
        """向内收边，避开缩放与色度二次采样在边界上的糊边。"""
        pad = max(0, int(margin))
        return CropRect(
            x=self.x + pad,
            y=self.y + pad,
            width=max(1, self.width - 2 * pad),
            height=max(1, self.height - 2 * pad),
        )


# 校准标记在 keyboard.html 里的位置与大小，单位是画布像素。
# 叠加层浏览器源按画布尺寸创建、positionX/Y=0 且 BOUNDS_STRETCH 铺满画布
# （见 obs_client.ensure_kb_overlay_in_scene），所以标记的 CSS 坐标就是画布坐标。
# 数值与 keyboard.html 的 #cal 样式一一对应，靠 test_onset_probe.py 回读 HTML 防止漂移。
CALIBRATION_MARKER = CropRect(x=0, y=0, width=160, height=160)
# 分析时向内收的边距（画布像素），缩放后仍能保证落在纯色区域内部。
_MARKER_INSET_PX = 8


def calibration_marker_crop(*, base_width: int, output_width: int) -> CropRect:
    """校准标记在成片文件里的裁剪矩形。

    OBS 可以把输出降采样到低于画布的分辨率（``base`` → ``output``），此时文件里的
    像素坐标要按同一比例缩小，否则裁到的是别的地方。
    """
    base = int(base_width or 0)
    output = int(output_width or 0)
    scale = (output / base) if base > 0 and output > 0 else 1.0
    return CALIBRATION_MARKER.scaled_by(scale).inset(max(1, int(round(_MARKER_INSET_PX * scale))))


@dataclass(frozen=True)
class FrameDiff:
    """一帧相对前一帧的区域平均绝对差。"""

    index: int
    pts_sec: float
    value: float


@dataclass(frozen=True)
class OnsetResult:
    """变化起点的判定结果，连同判据一起返回以便复核。"""

    pts_sec: Optional[float]
    frame_index: Optional[int]
    value: float
    baseline: float
    noise_sigma: float
    threshold: float
    frame_count: int
    baseline_static: bool

    @property
    def found(self) -> bool:
        return self.pts_sec is not None


def _filter_path(path: Path) -> str:
    """把 Windows 路径转成 ffmpeg 滤镜参数能接受的形式。"""
    return str(path).replace("\\", "/").replace(":", "\\:")


def build_diff_trace_command(
    *,
    ffmpeg_bin: Path,
    source: Path,
    metadata_path: Path,
    crop: Optional[CropRect] = None,
    start_sec: float = 0.0,
    duration_sec: Optional[float] = None,
) -> list[str]:
    """构造导出逐帧差分曲线的 ffmpeg 命令。

    ``metadata`` 滤镜把数值写进 ``metadata_path``，不与 ffmpeg 自身日志混在一条流里，
    省掉 Windows 上的编码与交错问题。带 ``start_sec`` 时加 ``-copyts``，让曲线里的
    ``pts_time`` 仍然是源文件时间轴上的绝对秒数。
    """
    chain: list[str] = []
    if crop is not None:
        chain.append(crop.to_filter())
    chain.extend(
        (
            "format=gray",
            "tblend=all_mode=difference",
            "signalstats",
            f"metadata=print:key=lavfi.signalstats.YAVG:file={_filter_path(metadata_path)}",
        )
    )

    command: list[str] = [str(ffmpeg_bin), "-hide_banner", "-nostdin", "-v", "error"]
    seek = max(0.0, float(start_sec or 0.0))
    if seek > 0:
        command += ["-ss", f"{seek:.6f}"]
    command += ["-i", str(source)]
    if seek > 0:
        command.append("-copyts")
    if duration_sec is not None and float(duration_sec) > 0:
        command += ["-t", f"{float(duration_sec):.6f}"]
    command += ["-an", "-sn", "-vf", ",".join(chain), "-f", "null", "-"]
    return command


def parse_diff_trace(text: str) -> list[FrameDiff]:
    """解析 ``metadata=print`` 的输出。

    格式是两行一组：``frame:<n> pts:<pts> pts_time:<sec>`` 后面跟着 ``key=value``。
    时间戳缺失（``N/A``）的帧丢掉——没有时间的采样对定位起点没有意义。
    """
    trace: list[FrameDiff] = []
    pending_index: Optional[int] = None
    pending_pts: Optional[float] = None

    for line in (text or "").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        header = _FRAME_HEADER.match(stripped)
        if header:
            pending_index = int(header.group(1))
            try:
                pending_pts = float(header.group(3))
            except ValueError:
                pending_pts = None
            continue
        value_match = _YAVG_LINE.match(stripped)
        if value_match and pending_index is not None:
            if pending_pts is not None:
                trace.append(FrameDiff(pending_index, pending_pts, float(value_match.group(1))))
            pending_index = None
            pending_pts = None
    return trace


def _median(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def find_onset(
    trace: Sequence[FrameDiff],
    *,
    skip_frames: int = _DEFAULT_SKIP_FRAMES,
    baseline_frames: int = _DEFAULT_BASELINE_FRAMES,
    k: float = _DEFAULT_K,
    min_value: float = _DEFAULT_MIN_VALUE,
) -> OnsetResult:
    """在差分曲线里定位第一次显著跳变。

    噪声底取 ``skip_frames`` 之后 ``baseline_frames`` 帧的中位数，门槛取
    ``max(min_value, 中位数 + k·σ)``，σ 由 MAD 换算。搜索从噪声窗之后开始：这段静帧
    是录制流程的产物（OBS 先开录、demo 后恢复），不是假设。若噪声窗里就已经越过门槛，
    说明静帧比预期短或窗口取太长，``baseline_static`` 会置 False 提示结论不可信。
    """
    usable = list(trace)[max(0, int(skip_frames)) :]
    window = usable[: max(1, int(baseline_frames))]
    if not window:
        return OnsetResult(None, None, 0.0, 0.0, 0.0, float(min_value), len(trace), False)

    values = [frame.value for frame in window]
    baseline = _median(values)
    sigma = _MAD_TO_SIGMA * _median([abs(value - baseline) for value in values])
    threshold = max(float(min_value), baseline + float(k) * sigma)
    baseline_static = max(values) < threshold

    for frame in usable[len(window) :]:
        if frame.value >= threshold:
            return OnsetResult(
                frame.pts_sec,
                frame.index,
                frame.value,
                baseline,
                sigma,
                threshold,
                len(trace),
                baseline_static,
            )
    return OnsetResult(None, None, 0.0, baseline, sigma, threshold, len(trace), baseline_static)


def probe_motion_onset(
    *,
    ffmpeg_bin: Path,
    source: Path,
    crop: Optional[CropRect] = None,
    start_sec: float = 0.0,
    duration_sec: Optional[float] = None,
    timeout_sec: float = 300.0,
    skip_frames: int = _DEFAULT_SKIP_FRAMES,
    baseline_frames: int = _DEFAULT_BASELINE_FRAMES,
    k: float = _DEFAULT_K,
    min_value: float = _DEFAULT_MIN_VALUE,
) -> tuple[OnsetResult, list[FrameDiff]]:
    """跑一遍 ffmpeg 并返回（起点判定, 完整差分曲线）。

    曲线一起返回：判定不符合预期时，看曲线本身比重跑一遍参数更快，实测台也要用它
    画对照图。
    """
    if not Path(ffmpeg_bin).is_file():
        raise OnsetProbeError(f"ffmpeg not found: {ffmpeg_bin}")
    if not Path(source).is_file():
        raise OnsetProbeError(f"source not found: {source}")

    with tempfile.TemporaryDirectory(prefix="cs2ia-onset-") as tmp_dir:
        metadata_path = Path(tmp_dir) / "diff.txt"
        command = build_diff_trace_command(
            ffmpeg_bin=Path(ffmpeg_bin),
            source=Path(source),
            metadata_path=metadata_path,
            crop=crop,
            start_sec=start_sec,
            duration_sec=duration_sec,
        )
        result = run_process_capture(command, timeout=timeout_sec)
        if result.returncode != 0:
            logger.error(
                "onset probe ffmpeg failed rc=%s command=%s stderr=%s",
                result.returncode,
                command_for_log(command),
                process_error_tail(result),
            )
            raise OnsetProbeError(f"ffmpeg failed: {process_error_tail(result, 300)}")
        try:
            text = metadata_path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            raise OnsetProbeError("ffmpeg produced no diff trace") from exc

    trace = parse_diff_trace(text)
    if not trace:
        raise OnsetProbeError("diff trace is empty")
    onset = find_onset(
        trace,
        skip_frames=skip_frames,
        baseline_frames=baseline_frames,
        k=k,
        min_value=min_value,
    )
    return onset, trace


def find_flashes(
    trace: Sequence[FrameDiff],
    *,
    skip_frames: int = _DEFAULT_SKIP_FRAMES,
    baseline_frames: int = _DEFAULT_BASELINE_FRAMES,
    k: float = _DEFAULT_K,
    min_value: float = _DEFAULT_MIN_VALUE,
    refractory_sec: float = 0.3,
) -> list[FrameDiff]:
    """定位差分曲线里每一次闪白的**起始**边沿。

    一次闪白在差分曲线上留下两个尖峰：黑→白和 100ms 后的白→黑。要的是前者，所以每检出
    一次就静默 ``refractory_sec``（默认 0.3s，大于闪白时长又远小于闪白间隔
    ``MIN_CALIBRATION_TICK_GAP_SEC``），把收尾那个尖峰吃掉。
    """
    usable = list(trace)[max(0, int(skip_frames)) :]
    window = usable[: max(1, int(baseline_frames))]
    if not window:
        return []

    values = [frame.value for frame in window]
    baseline = _median(values)
    sigma = _MAD_TO_SIGMA * _median([abs(value - baseline) for value in values])
    threshold = max(float(min_value), baseline + float(k) * sigma)

    flashes: list[FrameDiff] = []
    quiet_until = float("-inf")
    for frame in usable[len(window) :]:
        if frame.value < threshold or frame.pts_sec < quiet_until:
            continue
        flashes.append(frame)
        quiet_until = frame.pts_sec + max(0.0, float(refractory_sec))
    return flashes


def match_flashes(
    expected_sec: Sequence[float],
    measured_sec: Sequence[float],
    *,
    tolerance_sec: float = 1.0,
) -> tuple[list[dict], list[float]]:
    """把预期闪白时刻与实测时刻配对，返回（配对结果, 没配上的预期时刻）。

    按最近邻配对而不是按序号：中间漏掉一次闪白时，按序号会让后面所有配对整体错位，
    得出一串假的偏置。容差取 ``tolerance_sec``——真实延迟远小于闪白间隔，超出容差的
    只能是配错了。
    """
    remaining = sorted(float(value) for value in measured_sec)
    pairs: list[dict] = []
    unmatched: list[float] = []

    for expected in sorted(float(value) for value in expected_sec):
        best: Optional[float] = None
        best_delta = float("inf")
        for candidate in remaining:
            delta = abs(candidate - expected)
            if delta < best_delta:
                best, best_delta = candidate, delta
        if best is None or best_delta > float(tolerance_sec):
            unmatched.append(round(expected, 4))
            continue
        remaining.remove(best)
        pairs.append(
            {
                "expected_sec": round(expected, 4),
                "measured_sec": round(best, 4),
                "offset_sec": round(best - expected, 4),
            }
        )
    return pairs, unmatched


def plan_calibration_ticks(
    *,
    start_tick: int,
    end_tick: int,
    tick_rate: float,
    count: int = 8,
    lead_in_sec: float = 1.5,
    tail_sec: float = 0.5,
) -> list[int]:
    """在一个录制段里排布校准闪白的 demo tick。

    首个 tick 要留 ``lead_in_sec``：成片开头那段静止画面是判定噪声底的依据，闪白紧贴
    demo 起播会把噪声窗污染掉。尾部留 ``tail_sec`` 是因为回合段可能被 GSI 提前停录，
    压在末尾的闪白会掉在成片外面。间隔不低于 ``MIN_CALIBRATION_TICK_GAP_SEC``，否则
    两次闪白在页面侧会并成一次。
    """
    rate = float(tick_rate or 0.0)
    if rate <= 0 or int(count) <= 0:
        return []
    first = int(start_tick) + int(round(max(0.0, float(lead_in_sec)) * rate))
    last = int(end_tick) - int(round(max(0.0, float(tail_sec)) * rate))
    if last < first:
        return []

    min_gap = max(1, int(round(MIN_CALIBRATION_TICK_GAP_SEC * rate)))
    wanted = int(count)
    if wanted == 1:
        return [first]
    step = max(min_gap, int((last - first) // (wanted - 1)))

    ticks: list[int] = []
    tick = first
    while tick <= last and len(ticks) < wanted:
        ticks.append(tick)
        tick += step
    return ticks


def summarize_offsets(offsets: Sequence[float]) -> dict[str, float]:
    """一组偏置的汇总：均值告诉你固定偏差，标准差告诉你抖动。

    对照实验的判据就是标准差——``--enable-begin-frame-scheduling`` 若真的把浏览器源
    与 OBS 合成锁相，标准差应当明显收窄；均值变了不算问题，自动校准会跟着走。
    """
    samples = [float(value) for value in offsets if value is not None and math.isfinite(float(value))]
    if not samples:
        return {"count": 0.0}
    count = len(samples)
    mean = sum(samples) / count
    variance = sum((value - mean) ** 2 for value in samples) / count
    return {
        "count": float(count),
        "mean": round(mean, 4),
        "median": round(_median(samples), 4),
        "stddev": round(math.sqrt(variance), 4),
        "min": round(min(samples), 4),
        "max": round(max(samples), 4),
        "peak_to_peak": round(max(samples) - min(samples), 4),
    }
