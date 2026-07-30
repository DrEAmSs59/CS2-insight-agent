import sys
from pathlib import Path

import pytest

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.recording.diagnostics.onset_probe import (
    CALIBRATION_FLASH_MS,
    CALIBRATION_MARKER,
    MIN_CALIBRATION_TICK_GAP_SEC,
    CropRect,
    FrameDiff,
    OnsetProbeError,
    build_diff_trace_command,
    calibration_marker_crop,
    find_onset,
    parse_diff_trace,
    plan_calibration_ticks,
    probe_motion_onset,
    summarize_offsets,
)

_KEYBOARD_OVERLAY = _BACKEND_ROOT / "app" / "recording" / "executor" / "overlay" / "keyboard.html"


def _trace(values: list[float], *, fps: float = 60.0) -> list[FrameDiff]:
    return [FrameDiff(index=i, pts_sec=round(i / fps, 6), value=v) for i, v in enumerate(values)]


class TestCropRect:
    def test_to_filter_uses_ffmpeg_argument_order(self):
        # ffmpeg 的 crop 是 w:h:x:y，与结构体的 x,y,w,h 声明顺序不同。
        assert CropRect(x=100, y=50, width=640, height=360).to_filter() == "crop=640:360:100:50"

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"x": 0, "y": 0, "width": 0, "height": 10},
            {"x": 0, "y": 0, "width": 10, "height": -1},
            {"x": -1, "y": 0, "width": 10, "height": 10},
        ],
    )
    def test_rejects_degenerate_rectangles(self, kwargs):
        with pytest.raises(ValueError):
            CropRect(**kwargs)


class TestCalibrationMarker:
    """Python 侧的裁剪矩形与 keyboard.html 的 #cal 样式必须一致，否则量的是别的地方。"""

    def _cal_rule(self) -> str:
        html = _KEYBOARD_OVERLAY.read_text(encoding="utf-8")
        start = html.index("#cal {")
        return html[start : html.index("}", start)]

    def test_geometry_matches_the_overlay_stylesheet(self):
        rule = self._cal_rule()

        assert f"width: {CALIBRATION_MARKER.width}px" in rule
        assert f"height: {CALIBRATION_MARKER.height}px" in rule
        assert f"left: {CALIBRATION_MARKER.x}" in rule
        assert f"top: {CALIBRATION_MARKER.y}" in rule

    def test_flash_duration_matches_the_overlay_script(self):
        html = _KEYBOARD_OVERLAY.read_text(encoding="utf-8")

        assert f"CAL_FLASH_MS = {CALIBRATION_FLASH_MS}" in html

    def test_marker_has_no_transition_that_would_smear_the_onset(self):
        # 任何过渡都会让"第一次跳变"这个判据失效。
        assert "transition" not in self._cal_rule()

    def test_marker_backdrop_is_opaque(self):
        # 不透明底才能让待检测区域在闪白之前严格静止。
        assert "background: #000" in self._cal_rule()

    def test_crop_matches_the_marker_when_output_equals_canvas(self):
        crop = calibration_marker_crop(base_width=2560, output_width=2560)

        # 只向内收边，位置和尺寸不缩放。
        assert crop.x == 8 and crop.y == 8
        assert crop.width == CALIBRATION_MARKER.width - 16

    def test_crop_follows_a_downscaled_output(self):
        # 画布 2560 降采样到 1920 时，文件里的标记只有 3/4 大。
        crop = calibration_marker_crop(base_width=2560, output_width=1920)

        assert crop.width == 120 - 2 * 6
        assert crop.x == 6

    def test_crop_stays_inside_the_marker_after_scaling(self):
        crop = calibration_marker_crop(base_width=2560, output_width=1280)
        scaled_edge = CALIBRATION_MARKER.width * 1280 // 2560

        assert crop.x > 0
        assert crop.x + crop.width < scaled_edge

    @pytest.mark.parametrize("kwargs", [{"base_width": 0}, {"output_width": 0}])
    def test_unknown_resolution_falls_back_to_canvas_pixels(self, kwargs):
        params = {"base_width": 1920, "output_width": 1920}
        params.update(kwargs)

        assert calibration_marker_crop(**params).width == CALIBRATION_MARKER.width - 16


class TestPlanCalibrationTicks:
    def test_spreads_ticks_across_the_segment(self):
        ticks = plan_calibration_ticks(start_tick=1000, end_tick=1000 + 64 * 20, tick_rate=64, count=5)

        assert len(ticks) == 5
        # 首个 tick 让开 1.5 秒，给噪声底留出干净的静止窗口。
        assert ticks[0] == 1000 + 96
        assert ticks == sorted(ticks)

    def test_never_packs_flashes_closer_than_they_can_be_resolved(self):
        ticks = plan_calibration_ticks(start_tick=0, end_tick=64 * 6, tick_rate=64, count=20)
        gaps = [b - a for a, b in zip(ticks, ticks[1:])]

        assert min(gaps) >= MIN_CALIBRATION_TICK_GAP_SEC * 64

    def test_leaves_a_tail_so_an_early_stop_does_not_drop_flashes(self):
        end_tick = 64 * 30
        ticks = plan_calibration_ticks(start_tick=0, end_tick=end_tick, tick_rate=64, count=8)

        assert max(ticks) <= end_tick - 32

    def test_segment_too_short_for_any_flash(self):
        assert plan_calibration_ticks(start_tick=0, end_tick=64, tick_rate=64) == []

    def test_single_flash_sits_after_the_lead_in(self):
        assert plan_calibration_ticks(start_tick=500, end_tick=500 + 64 * 10, tick_rate=64, count=1) == [596]

    @pytest.mark.parametrize("kwargs", [{"tick_rate": 0}, {"count": 0}])
    def test_degenerate_inputs_produce_no_ticks(self, kwargs):
        params = {"start_tick": 0, "end_tick": 64 * 30, "tick_rate": 64}
        params.update(kwargs)

        assert plan_calibration_ticks(**params) == []


class TestBuildDiffTraceCommand:
    def _command(self, **kwargs) -> list[str]:
        defaults = {
            "ffmpeg_bin": Path("ffmpeg.exe"),
            "source": Path("clip.mp4"),
            "metadata_path": Path("out.txt"),
        }
        defaults.update(kwargs)
        return build_diff_trace_command(**defaults)

    def test_filter_chain_crops_before_differencing(self):
        chain = self._command(crop=CropRect(x=8, y=16, width=320, height=180))[-4]
        # 先裁剪再差分，避免把整帧都算一遍；signalstats 必须在 tblend 之后才是差分统计。
        assert chain.startswith("crop=320:180:8:16,format=gray,tblend=all_mode=difference,signalstats,")

    def test_crop_is_optional(self):
        chain = self._command()[-4]
        assert chain.startswith("format=gray,")
        assert "crop=" not in chain

    def test_metadata_path_is_escaped_for_filter_syntax(self):
        chain = self._command(metadata_path=Path(r"C:\tmp\diff.txt"))[-4]
        assert "file=C\\:/tmp/diff.txt" in chain

    def test_no_seek_arguments_when_starting_at_zero(self):
        command = self._command()
        assert "-ss" not in command
        assert "-copyts" not in command
        assert "-t" not in command

    def test_seek_keeps_source_timeline(self):
        command = self._command(start_sec=2.5)
        assert command[command.index("-ss") + 1] == "2.500000"
        # -copyts 保证曲线里的 pts_time 仍是源文件绝对时间，否则起点会被算成相对 -ss。
        assert command.index("-copyts") > command.index("-i")

    def test_duration_limits_analysis_window(self):
        command = self._command(duration_sec=4.0)
        assert command[command.index("-t") + 1] == "4.000000"

    def test_discards_audio_and_muxer_output(self):
        command = self._command()
        assert "-an" in command
        assert command[-2:] == ["null", "-"]


class TestParseDiffTrace:
    def test_parses_frame_header_and_value_pairs(self):
        text = (
            "frame:0    pts:0       pts_time:0\n"
            "lavfi.signalstats.YAVG=0.114000\n"
            "frame:1    pts:1024    pts_time:0.021333\n"
            "lavfi.signalstats.YAVG=17.882000\n"
        )
        assert parse_diff_trace(text) == [
            FrameDiff(0, 0.0, 0.114),
            FrameDiff(1, 0.021333, 17.882),
        ]

    def test_accepts_scientific_notation(self):
        text = "frame:3 pts:100 pts_time:0.05\nlavfi.signalstats.YAVG=1.5e-03\n"
        assert parse_diff_trace(text)[0].value == pytest.approx(0.0015)

    def test_drops_frames_without_a_timestamp(self):
        text = (
            "frame:0 pts:N/A pts_time:N/A\n"
            "lavfi.signalstats.YAVG=0.100000\n"
            "frame:1 pts:1024 pts_time:0.021333\n"
            "lavfi.signalstats.YAVG=0.200000\n"
        )
        assert [frame.index for frame in parse_diff_trace(text)] == [1]

    def test_ignores_unrelated_lines(self):
        text = (
            "some ffmpeg chatter\n"
            "frame:0 pts:0 pts_time:0\n"
            "lavfi.signalstats.YMIN=0.000000\n"
            "lavfi.signalstats.YAVG=0.500000\n"
        )
        assert parse_diff_trace(text) == [FrameDiff(0, 0.0, 0.5)]

    def test_empty_input(self):
        assert parse_diff_trace("") == []


class TestFindOnset:
    def test_locates_first_frame_past_the_noise_floor(self):
        # 首帧丢弃 + 10 帧噪声底，第 12 帧（含跳变）应被判为起点。
        trace = _trace([99.0] + [0.10] * 10 + [0.12, 24.0, 25.0])
        onset = find_onset(trace, baseline_frames=10)

        assert onset.found
        assert onset.frame_index == 12
        assert onset.pts_sec == pytest.approx(12 / 60.0)
        assert onset.value == pytest.approx(24.0)
        assert onset.baseline_static

    def test_first_frame_is_skipped_because_tblend_has_no_predecessor(self):
        # tblend 首帧没有可比的前一帧，数值是满量程的假跳变。中位数扛得住这个离群值，
        # 所以起点仍然找得对，但它会落在噪声窗内并把结论标成不可信——丢掉首帧才干净。
        trace = _trace([99.0] + [0.10] * 10 + [30.0])

        assert not find_onset(trace, baseline_frames=10, skip_frames=0).baseline_static
        assert find_onset(trace, baseline_frames=10).baseline_static

    def test_absolute_floor_applies_when_noise_is_perfectly_flat(self):
        # 完全静止的画面 MAD=0，门槛会塌到噪声底，此时必须靠 min_value 兜住。
        trace = _trace([99.0] + [0.0] * 10 + [0.3, 5.0])
        onset = find_onset(trace, baseline_frames=10, min_value=0.75)

        assert onset.threshold == pytest.approx(0.75)
        assert onset.frame_index == 12

    def test_reports_when_no_change_occurs(self):
        onset = find_onset(_trace([99.0] + [0.1] * 40), baseline_frames=10)

        assert not onset.found
        assert onset.pts_sec is None
        assert onset.frame_count == 41

    def test_flags_unreliable_result_when_motion_starts_inside_the_noise_window(self):
        # 静帧比噪声窗短：窗内已经含跳变，结论不可信，必须显式暴露而不是悄悄给个数。
        trace = _trace([99.0] + [0.1] * 3 + [40.0] * 7 + [41.0])
        onset = find_onset(trace, baseline_frames=10)

        assert not onset.baseline_static

    def test_handles_trace_shorter_than_the_noise_window(self):
        onset = find_onset(_trace([99.0, 0.1]), baseline_frames=40)

        assert not onset.found
        assert onset.frame_count == 2

    def test_handles_empty_trace(self):
        onset = find_onset([])

        assert not onset.found
        assert not onset.baseline_static


class TestSummarizeOffsets:
    def test_reports_bias_and_jitter(self):
        stats = summarize_offsets([0.10, 0.12, 0.08, 0.10])

        assert stats["count"] == 4.0
        assert stats["mean"] == pytest.approx(0.10)
        assert stats["stddev"] == pytest.approx(0.0141, abs=1e-4)
        assert stats["peak_to_peak"] == pytest.approx(0.04)

    def test_locked_pipeline_shows_near_zero_jitter(self):
        # 对照实验的判据：均值多少不重要，标准差必须收窄。
        assert summarize_offsets([0.05] * 6)["stddev"] == pytest.approx(0.0)

    def test_drops_non_finite_and_missing_samples(self):
        stats = summarize_offsets([0.2, None, float("nan"), float("inf"), 0.4])

        assert stats["count"] == 2.0
        assert stats["mean"] == pytest.approx(0.3)

    def test_empty_input(self):
        assert summarize_offsets([]) == {"count": 0.0}


class TestProbeMotionOnset:
    def test_missing_ffmpeg_is_reported_as_probe_error(self, tmp_path):
        source = tmp_path / "clip.mp4"
        source.write_bytes(b"")

        with pytest.raises(OnsetProbeError, match="ffmpeg not found"):
            probe_motion_onset(ffmpeg_bin=tmp_path / "nope.exe", source=source)

    def test_missing_source_is_reported_as_probe_error(self, tmp_path):
        ffmpeg = tmp_path / "ffmpeg.exe"
        ffmpeg.write_bytes(b"")

        with pytest.raises(OnsetProbeError, match="source not found"):
            probe_motion_onset(ffmpeg_bin=ffmpeg, source=tmp_path / "missing.mp4")
