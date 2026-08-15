"""video_composer 单元测试（无需真实 FFmpeg 文件）。"""

from __future__ import annotations

import sys
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.video_composer import (
    MontageComposerError,
    _run_ffmpeg_capture,
    build_bgm_filter,
    ffprobe_streams,
    probe_video_audio_summary,
    resolve_ffmpeg_binary,
    resolve_ffprobe_binary,
    validate_output_path,
)


class TestValidateOutput(unittest.TestCase):
    def test_rejects_relative(self):
        with self.assertRaises(MontageComposerError):
            validate_output_path("out.mp4")

    def test_rejects_non_mp4(self):
        with self.assertRaises(MontageComposerError):
            validate_output_path("C:\\a\\b.mkv")

    def test_accepts_absolute_mp4(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "sub" / "x.mp4"
            out = validate_output_path(str(p))
            self.assertTrue(out.is_absolute())
            self.assertTrue(out.parent.is_dir())


class TestResolveFfmpeg(unittest.TestCase):
    def test_missing_config_and_path(self):
        with patch("app.video_composer.shutil.which", return_value=None):
            with self.assertRaises(MontageComposerError):
                resolve_ffmpeg_binary("")

    def test_config_path_invalid(self):
        with self.assertRaises(MontageComposerError):
            resolve_ffmpeg_binary("__no_such_ffmpeg__.exe")


class TestResolveFfmpegBundled(unittest.TestCase):
    def test_bundled_third_party_before_path(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "third_party" / "ffmpeg").mkdir(parents=True)
            exe = root / "third_party" / "ffmpeg" / "ffmpeg.exe"
            exe.write_bytes(b"")
            data = root / "data"
            data.mkdir()

            def fake_get_data_dir():
                return data

            with patch("app.env_utils.get_data_dir", fake_get_data_dir):
                with patch("app.video_composer.shutil.which", return_value=None):
                    p = resolve_ffmpeg_binary("")
                    self.assertEqual(p.resolve(), exe.resolve())


class TestResolveFfprobe(unittest.TestCase):
    def test_uses_matching_sibling_tool(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            ffmpeg = root / "ffmpeg.exe"
            ffprobe = root / "ffprobe.exe"
            ffmpeg.write_bytes(b"")
            ffprobe.write_bytes(b"")
            with patch(
                "app.video_composer.ffmpeg_tool_version_identity",
                return_value="2026-full-build",
            ):
                self.assertEqual(resolve_ffprobe_binary(ffmpeg), ffprobe.resolve())

    def test_does_not_mix_ffprobe_from_path(self):
        with tempfile.TemporaryDirectory() as td:
            ffmpeg = Path(td) / "ffmpeg.exe"
            ffmpeg.write_bytes(b"")
            with patch("app.video_composer.shutil.which", return_value="C:/other/ffprobe.exe"):
                with self.assertRaises(MontageComposerError) as caught:
                    resolve_ffprobe_binary(ffmpeg)
            self.assertEqual(caught.exception.code, "MONTAGE_FFPROBE_NOT_FOUND")

    def test_rejects_different_ffmpeg_and_ffprobe_builds(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            ffmpeg = root / "ffmpeg.exe"
            ffprobe = root / "ffprobe.exe"
            ffmpeg.write_bytes(b"")
            ffprobe.write_bytes(b"")
            with patch(
                "app.video_composer.ffmpeg_tool_version_identity",
                side_effect=["new-full-build", "old-essentials-build"],
            ):
                with self.assertRaises(MontageComposerError) as caught:
                    resolve_ffprobe_binary(ffmpeg)
            self.assertEqual(caught.exception.code, "MONTAGE_FFPROBE_VERSION_MISMATCH")


class TestBgmFilter(unittest.TestCase):
    def test_contains_loop_and_trim(self):
        s = build_bgm_filter(120.5)
        self.assertIn("aloop", s)
        self.assertIn("atrim=0:120.500000", s)


class TestFfmpegCommandLengthGuard(unittest.TestCase):
    def test_montage_runner_checks_before_starting_ffmpeg(self):
        command = ["ffmpeg.exe", "-version"]
        with (
            patch(
                "app.ffmpeg_process.ensure_windows_command_length",
                side_effect=MontageComposerError("MONTAGE_COMMAND_LINE_TOO_LONG"),
            ) as guard,
            patch("app.ffmpeg_process.subprocess.Popen") as popen,
        ):
            with self.assertRaises(MontageComposerError) as caught:
                _run_ffmpeg_capture(command, timeout=1, stage="test")

        self.assertEqual(caught.exception.code, "MONTAGE_COMMAND_LINE_TOO_LONG")
        guard.assert_called_once_with(command)
        popen.assert_not_called()


class TestProbeVideoSummary(unittest.TestCase):
    def test_ffprobe_requests_average_rate_and_frame_count(self):
        with patch("app.video_composer._run_json", return_value={}) as run_json:
            ffprobe_streams(Path("source.mp4"), Path("ffprobe.exe"))
        command = run_json.call_args.args[0]
        entries = command[command.index("-show_entries") + 1]
        self.assertIn("avg_frame_rate", entries)
        self.assertIn("nb_frames", entries)
        self.assertIn("stream_tags=alpha_mode,encoder", entries)

    def test_prefers_average_fps_when_r_frame_rate_is_stream_time_base(self):
        payload = {
            "format": {"duration": "1155.584000"},
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "av1",
                    "width": 1440,
                    "height": 1080,
                    "r_frame_rate": "90000/1",
                    "avg_frame_rate": "416005000/1155569",
                    "nb_frames": "416005",
                    "duration": "1155.569000",
                },
            ],
        }
        with patch("app.video_composer.ffprobe_streams", return_value=payload):
            info = probe_video_audio_summary(Path("360fps.mp4"), Path("ffprobe.exe"))
        self.assertAlmostEqual(info["fps"], 360.00013846, places=6)

    def test_keeps_normal_constant_frame_rates(self):
        for fps in (60, 240):
            with self.subTest(fps=fps):
                payload = {
                    "format": {"duration": "10.0"},
                    "streams": [
                        {
                            "codec_type": "video",
                            "r_frame_rate": f"{fps}/1",
                            "avg_frame_rate": f"{fps}/1",
                            "nb_frames": str(fps * 10),
                            "duration": "10.0",
                        },
                    ],
                }
                with patch("app.video_composer.ffprobe_streams", return_value=payload):
                    info = probe_video_audio_summary(Path("constant.mp4"), Path("ffprobe.exe"))
                self.assertEqual(info["fps"], float(fps))

    def test_uses_frame_count_when_average_rate_is_missing_and_nominal_rate_is_absurd(self):
        payload = {
            "format": {"duration": "10.0"},
            "streams": [
                {
                    "codec_type": "video",
                    "r_frame_rate": "90000/1",
                    "avg_frame_rate": "0/0",
                    "nb_frames": "3600",
                    "duration": "10.0",
                },
            ],
        }
        with patch("app.video_composer.ffprobe_streams", return_value=payload):
            info = probe_video_audio_summary(Path("counted.mp4"), Path("ffprobe.exe"))
        self.assertEqual(info["fps"], 360.0)

    def test_detects_prores_4444_alpha_pixel_format(self):
        payload = {
            "format": {"duration": "2.5"},
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "prores",
                    "pix_fmt": "yuva444p12le",
                    "width": 1920,
                    "height": 1080,
                    "r_frame_rate": "60/1",
                },
                {
                    "codec_type": "audio",
                    "codec_name": "aac",
                },
            ],
        }
        with patch("app.video_composer.ffprobe_streams", return_value=payload):
            info = probe_video_audio_summary(Path("alpha.mov"), Path("ffprobe.exe"))
        self.assertTrue(info["has_alpha"])
        self.assertEqual(info["pixel_format"], "yuva444p12le")
        self.assertEqual(info["audio_codec_name"], "aac")

    def test_probe_detects_webm_alpha_mode_tag_even_when_pix_fmt_is_yuv420p(self):
        payload = {
            "format": {"duration": "2.0"},
            "streams": [{
                "codec_type": "video",
                "codec_name": "vp9",
                "pix_fmt": "yuv420p",
                "width": 640,
                "height": 360,
                "r_frame_rate": "30/1",
                "tags": {"ALPHA_MODE": "1"},
            }],
        }
        with patch("app.video_composer.ffprobe_streams", return_value=payload):
            info = probe_video_audio_summary(Path("alpha.webm"), Path("ffprobe.exe"))
        self.assertTrue(info["has_alpha"])


class TestFfmpegCapture(unittest.TestCase):
    def test_amf_failure_is_retried_once_after_partial_output_cleanup(self):
        with tempfile.TemporaryDirectory() as td:
            output = Path(td) / "partial.mp4"
            output.write_bytes(b"partial")
            failed = subprocess.CompletedProcess(["ffmpeg"], 1, "", "AMF \u00ae failed")
            succeeded = subprocess.CompletedProcess(["ffmpeg"], 0, "", "")
            command = ["ffmpeg", "-c:v", "h264_amf", str(output)]
            with patch(
                "app.video_composer.run_process_capture",
                side_effect=[failed, succeeded],
            ) as runner:
                with patch("app.video_composer.time.sleep") as sleeper:
                    result = _run_ffmpeg_capture(
                        command,
                        timeout=10,
                        stage="test_amf",
                        output_path=output,
                    )
            self.assertEqual(result.returncode, 0)
            self.assertEqual(runner.call_count, 2)
            sleeper.assert_called_once_with(1.0)
            self.assertFalse(output.exists())

    def test_software_encoder_failure_is_not_retried(self):
        failed = subprocess.CompletedProcess(["ffmpeg"], 1, "", "x264 failed")
        with patch("app.video_composer.run_process_capture", return_value=failed) as runner:
            result = _run_ffmpeg_capture(
                ["ffmpeg", "-c:v", "libx264", "output.mp4"],
                timeout=10,
                stage="test_x264",
            )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(runner.call_count, 1)


if __name__ == "__main__":
    unittest.main()
