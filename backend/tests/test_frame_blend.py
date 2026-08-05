"""Frame-blending configuration and FFmpeg command tests."""

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.frame_blend import (
    build_frame_blend_command,
    is_frame_blend_source_supported,
    normalize_frame_blend_frames,
    resolve_frame_blend_output_fps,
    supports_blur_pipeline,
)
from app.lite_cut.runtime import normalize_project_body


class TestFrameBlend(unittest.TestCase):
    def test_disabled_skips_the_filter_window(self):
        self.assertEqual(normalize_frame_blend_frames(False, 9), 1)

    def test_custom_blur_accepts_60_fps_and_higher_sources(self):
        self.assertTrue(is_frame_blend_source_supported(30))
        self.assertTrue(is_frame_blend_source_supported(60))
        self.assertTrue(is_frame_blend_source_supported(120))
        self.assertTrue(is_frame_blend_source_supported(240))
        self.assertFalse(is_frame_blend_source_supported(0.5))
        self.assertFalse(is_frame_blend_source_supported(None))

    def test_runtime_capability_requires_custom_blur_help_marker(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            ffmpeg = Path(tmpdir) / "ffmpeg.exe"
            ffmpeg.write_bytes(b"test")
            result = SimpleNamespace(
                returncode=0,
                stdout="FFmpeg Insight headless Blur mode\n",
                stderr="",
            )
            with patch("app.frame_blend.subprocess.run", return_value=result) as run:
                self.assertTrue(supports_blur_pipeline(ffmpeg))
            run.assert_called_once()
            self.assertEqual(run.call_args.args[0][1:], ["-blur", "--help"])

    def test_standard_ffmpeg_is_rejected_for_blur_pipeline(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            ffmpeg = Path(tmpdir) / "standard-ffmpeg.exe"
            ffmpeg.write_bytes(b"test")
            result = SimpleNamespace(returncode=0, stdout="ffmpeg version standard\n", stderr="")
            with patch("app.frame_blend.subprocess.run", return_value=result):
                self.assertFalse(supports_blur_pipeline(ffmpeg))

    def test_command_uses_custom_blur_and_copies_optional_audio(self):
        command = build_frame_blend_command(
            ffmpeg_bin=Path("ffmpeg.exe"),
            source_path=Path("input.mp4"),
            output_path=Path("output.mp4"),
            frames=3,
            fps=30,
            video_encode_args=["-c:v", "libx264", "-crf", "18"],
        )
        self.assertEqual(command[1], "-blur")
        self.assertEqual(command[command.index("--performance-mode") + 1], "balanced")
        self.assertEqual(command[command.index("--blur-output-fps") + 1], "30")
        self.assertEqual(command[command.index("--weighting") + 1], "vegas")
        self.assertEqual(command[command.index("--deduplicate-method") + 1], "rife")
        self.assertEqual(command[command.index("-c:a") + 1], "copy")
        self.assertEqual(command[-1], "output.mp4")

    def test_command_preserves_nvenc_device_binding_and_quality(self):
        command = build_frame_blend_command(
            ffmpeg_bin=Path("ffmpeg.exe"),
            source_path=Path("input.mp4"),
            output_path=Path("output.mp4"),
            frames=5,
            fps=60,
            video_encode_args=["-c:v", "h264_nvenc", "-gpu", "2", "-cq", "21"],
        )
        self.assertEqual(command[command.index("-c:v") + 1], "h264_nvenc")
        self.assertEqual(command[command.index("-gpu") + 1], "2")
        self.assertEqual(command[command.index("-cq") + 1], "21")

    def test_high_frame_downsample_targets_lower_delivery_fps_only(self):
        self.assertEqual(
            resolve_frame_blend_output_fps(120, high_frame_downsample_enabled=True, delivery_fps=60),
            60,
        )
        self.assertEqual(
            resolve_frame_blend_output_fps(60, high_frame_downsample_enabled=True, delivery_fps=60),
            60,
        )
        self.assertEqual(
            resolve_frame_blend_output_fps(120, high_frame_downsample_enabled=False, delivery_fps=60),
            120,
        )

    def test_lite_cut_project_schema_preserves_settings(self):
        body = normalize_project_body(
            {
                "schema_version": 2,
                "output": {
                    "fps": 120,
                    "frame_blend_enabled": True,
                    "frame_blend_frames": 7,
                    "high_frame_downsample_enabled": True,
                    "delivery_fps": 60,
                },
                "tracks": [],
            }
        )
        self.assertTrue(body["output"]["frame_blend_enabled"])
        self.assertEqual(body["output"]["frame_blend_frames"], 7)
        self.assertTrue(body["output"]["high_frame_downsample_enabled"])
        self.assertEqual(body["output"]["delivery_fps"], 60)


if __name__ == "__main__":
    unittest.main()
