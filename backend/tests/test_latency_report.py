import json
import sys
from pathlib import Path

import pytest

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.recording.diagnostics import latency_report
from app.recording.diagnostics.onset_probe import (
    CropRect,
    FrameDiff,
    OnsetProbeError,
    OnsetResult,
    find_flashes,
    match_flashes,
)


def _trace(values: list[float], *, fps: float = 60.0) -> list[FrameDiff]:
    return [FrameDiff(index=i, pts_sec=round(i / fps, 6), value=v) for i, v in enumerate(values)]


def _flash_trace(flash_frames: list[int], *, total: int = 400, fps: float = 60.0) -> list[FrameDiff]:
    """造一条含闪白的曲线：每次闪白在起点和 100ms 后的收尾各留一个尖峰。"""
    values = [0.1] * total
    values[0] = 99.0  # tblend 首帧
    for start in flash_frames:
        values[start] = 40.0
        tail = start + int(round(0.1 * fps))
        if tail < total:
            values[tail] = 38.0
    return _trace(values, fps=fps)


class TestFindFlashes:
    def test_returns_the_rising_edge_of_each_flash(self):
        # 每次闪白有两个尖峰，只该报前一个。
        flashes = find_flashes(_flash_trace([120, 240, 360]), baseline_frames=40)

        assert [frame.index for frame in flashes] == [120, 240, 360]

    def test_refractory_window_swallows_the_trailing_edge(self):
        trace = _flash_trace([120])
        # 收尾尖峰在 120 + 6 帧处；抑制期必须盖住它。
        assert len(find_flashes(trace, baseline_frames=40)) == 1

    def test_flashes_closer_than_the_refractory_window_collapse(self):
        # 这是刻意的取舍：排布校准 tick 时保证间隔 1 秒以上，所以现实中不会撞上。
        flashes = find_flashes(_flash_trace([120, 126]), baseline_frames=40, refractory_sec=0.3)

        assert len(flashes) == 1

    def test_no_flashes_in_a_static_trace(self):
        assert find_flashes(_trace([99.0] + [0.1] * 300), baseline_frames=40) == []

    def test_empty_trace(self):
        assert find_flashes([]) == []


class TestMatchFlashes:
    def test_pairs_and_reports_the_offset(self):
        pairs, unmatched = match_flashes([1.0, 3.0], [1.08, 3.09])

        assert unmatched == []
        assert [pair["offset_sec"] for pair in pairs] == [0.08, 0.09]

    def test_uses_nearest_neighbour_so_a_missing_flash_does_not_shift_the_rest(self):
        # 中间那次闪白没录进去；按序号配对会把 3.0 配到 5.1 上，得出 2.1s 的假偏置。
        pairs, unmatched = match_flashes([1.0, 3.0, 5.0], [1.1, 5.1])

        assert unmatched == [3.0]
        assert [pair["offset_sec"] for pair in pairs] == [0.1, 0.1]

    def test_candidates_beyond_the_tolerance_are_not_paired(self):
        pairs, unmatched = match_flashes([1.0], [4.0], tolerance_sec=1.0)

        assert pairs == []
        assert unmatched == [1.0]

    def test_each_measurement_is_consumed_once(self):
        pairs, unmatched = match_flashes([1.0, 1.2], [1.1])

        assert len(pairs) == 1
        assert len(unmatched) == 1

    def test_nothing_measured(self):
        pairs, unmatched = match_flashes([1.0, 2.0], [])

        assert pairs == []
        assert unmatched == [1.0, 2.0]


class TestMeasureClipLatency:
    def _patch_probe(self, monkeypatch, trace, *, baseline_static=True):
        onset = OnsetResult(
            pts_sec=1.0,
            frame_index=60,
            value=40.0,
            baseline=0.1,
            noise_sigma=0.0,
            threshold=0.75,
            frame_count=len(trace),
            baseline_static=baseline_static,
        )
        monkeypatch.setattr(
            latency_report, "probe_motion_onset", lambda **_kwargs: (onset, trace)
        )

    def _measure(self, **kwargs):
        defaults = {
            "ffmpeg_bin": Path("ffmpeg.exe"),
            "source": Path("clip.mp4"),
            "crop": CropRect(x=0, y=0, width=144, height=144),
        }
        defaults.update(kwargs)
        return latency_report.measure_clip_latency(**defaults)

    def test_reports_bias_and_jitter_from_matched_flashes(self, monkeypatch):
        self._patch_probe(monkeypatch, _flash_trace([120, 240, 360]))

        report = self._measure(expected_flash_sec=[1.9, 3.9, 5.9])

        assert report["measured_count"] == 3
        assert "problem" not in report
        assert report["offsets"]["count"] == 3.0
        assert report["offsets"]["stddev"] == pytest.approx(0.0, abs=1e-6)

    def test_flags_a_moving_baseline_as_untrustworthy(self, monkeypatch):
        self._patch_probe(monkeypatch, _flash_trace([120]), baseline_static=False)

        report = self._measure(expected_flash_sec=[1.9])

        assert report["problem"] == "baseline_not_static"

    def test_flags_missing_flashes(self, monkeypatch):
        self._patch_probe(monkeypatch, _flash_trace([120]))

        report = self._measure(expected_flash_sec=[1.9, 3.9])

        assert report["problem"] == "some_flashes_missing"
        assert report["unmatched_expected_sec"] == [3.9]

    def test_flags_a_clip_with_no_usable_flash(self, monkeypatch):
        self._patch_probe(monkeypatch, _trace([99.0] + [0.1] * 300))

        report = self._measure(expected_flash_sec=[1.9])

        assert report["problem"] == "no_flash_matched"
        assert report["offsets"] == {"count": 0.0}


class TestMeasureResultFile:
    def _write(self, tmp_path, payload) -> Path:
        path = tmp_path / "result.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def _args(self, tmp_path):
        return {"ffmpeg_bin": tmp_path / "ffmpeg.exe", "base_width": 1920, "output_width": 1920}

    def test_ffmpeg_is_resolved_like_the_rest_of_the_app_when_not_given(
        self, tmp_path, monkeypatch
    ):
        clip = tmp_path / "clip.mp4"
        clip.write_bytes(b"")
        path = self._write(
            tmp_path,
            {"output_path": str(clip), "calibration_markers": [{"video_sec": 1.0}]},
        )
        resolved = tmp_path / "third_party" / "ffmpeg.exe"
        monkeypatch.setattr(latency_report, "default_ffmpeg_bin", lambda: resolved)
        seen: dict = {}

        def _fake(**kwargs):
            seen.update(kwargs)
            return {"samples": 1}

        monkeypatch.setattr(latency_report, "measure_clip_latency", _fake)

        latency_report.measure_result_file(path, base_width=1920, output_width=1920)

        assert seen["ffmpeg_bin"] == resolved

    def test_absent_ffmpeg_is_reported_not_raised(self, tmp_path, monkeypatch):
        clip = tmp_path / "clip.mp4"
        clip.write_bytes(b"")
        path = self._write(
            tmp_path,
            {"output_path": str(clip), "calibration_markers": [{"video_sec": 1.0}]},
        )

        def _boom():
            raise RuntimeError("MONTAGE_FFMPEG_PATH_MISSING")

        monkeypatch.setattr(latency_report, "default_ffmpeg_bin", _boom)

        report = latency_report.measure_result_file(path, base_width=1920, output_width=1920)

        assert report["problem"] == "ffmpeg_missing"
        assert "MONTAGE_FFMPEG_PATH_MISSING" in report["error"]

    def test_recording_without_calibration_is_reported_not_guessed(self, tmp_path):
        path = self._write(tmp_path, {"request_id": "r1", "output_path": "x.mp4"})

        report = latency_report.measure_result_file(path, **self._args(tmp_path))

        assert report["problem"] == "calibration_not_enabled"
        assert report["request_id"] == "r1"

    def test_missing_output_file(self, tmp_path):
        path = self._write(
            tmp_path,
            {"output_path": str(tmp_path / "gone.mp4"), "calibration_markers": [{"video_sec": 1.0}]},
        )

        report = latency_report.measure_result_file(path, **self._args(tmp_path))

        assert report["problem"] == "output_missing"

    def test_probe_failure_is_surfaced(self, tmp_path, monkeypatch):
        clip = tmp_path / "clip.mp4"
        clip.write_bytes(b"")
        path = self._write(
            tmp_path,
            {"output_path": str(clip), "calibration_markers": [{"video_sec": 1.0}]},
        )

        def boom(**_kwargs):
            raise OnsetProbeError("ffmpeg not found")

        monkeypatch.setattr(latency_report, "measure_clip_latency", boom)

        report = latency_report.measure_result_file(path, **self._args(tmp_path))

        assert report["problem"] == "probe_failed"
        assert "ffmpeg not found" in report["error"]

    def test_crop_follows_a_downscaled_output(self, tmp_path, monkeypatch):
        clip = tmp_path / "clip.mp4"
        clip.write_bytes(b"")
        path = self._write(
            tmp_path,
            {"output_path": str(clip), "calibration_markers": [{"video_sec": 1.0}]},
        )
        seen: dict = {}
        monkeypatch.setattr(
            latency_report,
            "measure_clip_latency",
            lambda **kwargs: seen.update(kwargs) or {"pairs": []},
        )

        latency_report.measure_result_file(
            path, ffmpeg_bin=tmp_path / "ffmpeg.exe", base_width=2560, output_width=1920
        )

        assert seen["crop"].width < 160
        assert seen["expected_flash_sec"] == [1.0]

    def test_malformed_markers_are_skipped(self, tmp_path):
        path = self._write(
            tmp_path,
            {
                "output_path": str(tmp_path / "gone.mp4"),
                "calibration_markers": ["nope", {"tick": 1}, {"video_sec": "x"}],
            },
        )

        report = latency_report.measure_result_file(path, **self._args(tmp_path))

        assert report["problem"] == "calibration_not_enabled"


class TestCompareRuns:
    def _report(self, offsets):
        return {"pairs": [{"offset_sec": value} for value in offsets]}

    def _spread(self, center, half_width, count=40):
        """围绕 center 均匀铺开的一组偏置，抖动幅度由 half_width 控制。"""
        if count == 1:
            return [center]
        step = (2 * half_width) / (count - 1)
        return [round(center - half_width + i * step, 6) for i in range(count)]

    def test_verdict_follows_jitter_not_bias(self):
        # B 的偏置大得多但抖动小一个数量级——锁相有效，偏置交给校准补。
        flagged = self._report(self._spread(0.30, 0.002))
        plain = self._report(self._spread(0.05, 0.05))

        verdict = latency_report.compare_runs("off", [plain], "on", [flagged])

        assert verdict["verdict"] == "on_less_jitter"
        assert verdict["on"]["samples"] == 40

    def test_reports_when_the_flag_made_jitter_worse(self):
        verdict = latency_report.compare_runs(
            "off",
            [self._report(self._spread(0.10, 0.002))],
            "on",
            [self._report(self._spread(0.10, 0.05))],
        )

        assert verdict["verdict"] == "off_less_jitter"

    def test_refuses_a_verdict_without_samples(self):
        verdict = latency_report.compare_runs("off", [], "on", [self._report([0.1, 0.1])])

        assert verdict["verdict"] == "insufficient_samples"

    def test_small_samples_are_underpowered_not_a_winner(self):
        """4 个样本时标准差自身误差约 40%，这种"胜出"是噪声。"""
        verdict = latency_report.compare_runs(
            "off",
            [self._report([0.05, 0.14, 0.02, 0.19])],
            "on",
            [self._report([0.30, 0.31, 0.30, 0.31])],
        )

        assert verdict["verdict"] == "underpowered"
        assert verdict["jitter"]["min_samples"] == latency_report.MIN_SAMPLES_PER_GROUP

    def test_difference_within_estimation_error_is_inconclusive(self):
        verdict = latency_report.compare_runs(
            "off",
            [self._report(self._spread(0.10, 0.030))],
            "on",
            [self._report(self._spread(0.10, 0.031))],
        )

        assert verdict["verdict"] == "inconclusive"
        assert abs(verdict["jitter"]["delta_sec"]) < verdict["jitter"]["required_delta_sec"]

    def test_statistically_real_but_irrelevant_differences_are_not_a_winner(self):
        """样本堆够多时,亚毫秒差异也会显著;但它在成片上看不出来,不该据此改默认配置。"""
        verdict = latency_report.compare_runs(
            "off",
            [self._report(self._spread(0.10, 0.0100, count=4000))],
            "on",
            [self._report(self._spread(0.10, 0.0104, count=4000))],
        )

        assert verdict["jitter"]["required_delta_sec"] == latency_report.MIN_JITTER_EFFECT_SEC
        assert verdict["verdict"] == "inconclusive"

    def test_reports_the_raw_distribution_for_review(self):
        verdict = latency_report.compare_runs(
            "off", [self._report([0.3, 0.1, 0.2])], "on", [self._report([0.1])]
        )

        assert verdict["off"]["offsets_sorted"] == [0.1, 0.2, 0.3]

    def test_collects_problems_per_group(self):
        verdict = latency_report.compare_runs(
            "off",
            [{"pairs": [], "problem": "no_flash_matched"}, {"pairs": [], "problem": "output_missing"}],
            "on",
            [self._report([0.1])],
        )

        assert verdict["off"]["problems"] == ["no_flash_matched", "output_missing"]


class TestSummarizeProblems:
    def test_single_shared_problem(self):
        reports = [{"problem": "calibration_not_enabled"}] * 3

        assert latency_report.summarize_problems(reports) == "calibration_not_enabled"

    def test_mixed_problems_have_no_single_cause(self):
        reports = [{"problem": "a"}, {"problem": "b"}]

        assert latency_report.summarize_problems(reports) is None

    def test_healthy_reports(self):
        assert latency_report.summarize_problems([{"pairs": []}]) is None
