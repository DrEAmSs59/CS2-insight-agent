"""FrameMeld process-boundary adapter tests."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.framemeld import (
    FRAMEMELD_DELIVERY_FPS,
    build_framemeld_command,
    framemeld_sources_are_compatible,
    framemeld_working_fps,
    probe_framemeld,
)
from app.lite_cut.runtime import normalize_project_body


class TestFrameMeld(unittest.TestCase):
    def setUp(self) -> None:
        from app import framemeld

        framemeld._probe_framemeld_cached.cache_clear()

    def test_source_family_validation_allows_reported_rate_drift(self):
        self.assertTrue(framemeld_sources_are_compatible([119.88, 120.0]))
        self.assertEqual(framemeld_working_fps([59.94, 60.0]), 60.0)
        self.assertFalse(framemeld_sources_are_compatible([60, 120]))
        self.assertFalse(framemeld_sources_are_compatible([60, None]))
        self.assertFalse(framemeld_sources_are_compatible([None]))

    def test_machine_readable_capability_uses_public_route(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            executable = Path(tmpdir) / "ffmpeg.exe"
            executable.write_bytes(b"test")
            result = SimpleNamespace(
                returncode=0,
                stdout=json.dumps(
                    {
                        "protocol": "org.framemeld.cli",
                        "api_version": 1,
                        "features": ["host-managed-encoder-fallback"],
                    }
                ),
                stderr="",
            )
            with patch("app.framemeld.subprocess.run", return_value=result) as run:
                capability = probe_framemeld(executable)
            self.assertEqual(capability.route, "-framemeld")
            self.assertFalse(capability.legacy)
            self.assertIn("host-managed-encoder-fallback", capability.features)
            self.assertEqual(run.call_args.args[0][1:], ["-framemeld", "--capabilities-json"])

    def test_current_framemeld_build_uses_legacy_cli_route(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            executable = Path(tmpdir) / "ffmpeg.exe"
            executable.write_bytes(b"test")
            not_supported = SimpleNamespace(returncode=1, stdout="", stderr="unknown option")
            current_help = SimpleNamespace(
                returncode=0,
                stdout="FFmpeg Insight headless Blur mode\n",
                stderr="",
            )
            with patch(
                "app.framemeld.subprocess.run",
                side_effect=[not_supported, not_supported, current_help],
            ) as run:
                capability = probe_framemeld(executable)
            self.assertEqual(capability.route, "-blur")
            self.assertTrue(capability.legacy)
            self.assertEqual(run.call_count, 3)

    def test_standard_ffmpeg_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            executable = Path(tmpdir) / "standard-ffmpeg.exe"
            executable.write_bytes(b"test")
            result = SimpleNamespace(returncode=1, stdout="", stderr="unknown option")
            with patch("app.framemeld.subprocess.run", return_value=result):
                self.assertIsNone(probe_framemeld(executable))

    def test_command_leaves_render_policy_to_framemeld(self):
        from app.framemeld import FrameMeldCapability

        command = build_framemeld_command(
            ffmpeg_bin=Path("ffmpeg.exe"),
            source_path=Path("input.mp4"),
            output_path=Path("output.mp4"),
            video_encode_args=["-c:v", "libx264", "-crf", "18"],
            capability=FrameMeldCapability(
                route="-framemeld",
                api_version=1,
                features=frozenset({"host-managed-encoder-fallback"}),
            ),
        )
        self.assertEqual(command[1], "-framemeld")
        self.assertEqual(command[command.index("--performance-mode") + 1], "balanced")
        self.assertEqual(command[command.index("--blur-output-fps") + 1], str(FRAMEMELD_DELIVERY_FPS))
        for forbidden in (
            "--interpolate-fps",
            "--performance-samples",
            "--blur-amount",
            "--weighting",
            "--blur-gamma",
            "--deduplicate-method",
        ):
            self.assertNotIn(forbidden, command)
        self.assertEqual(command[command.index("-c:a") + 1], "copy")
        self.assertIn("--host-managed-encoder-fallback", command)

    def test_command_preserves_nvenc_device_binding_and_quality(self):
        from app.framemeld import FrameMeldCapability

        command = build_framemeld_command(
            ffmpeg_bin=Path("ffmpeg.exe"),
            source_path=Path("input.mp4"),
            output_path=Path("output.mp4"),
            video_encode_args=["-c:v", "h264_nvenc", "-gpu", "2", "-cq", "21"],
            capability=FrameMeldCapability(route="-blur", api_version=None, legacy=True),
        )
        self.assertEqual(command[command.index("-c:v") + 1], "h264_nvenc")
        self.assertEqual(command[command.index("-gpu") + 1], "2")
        self.assertEqual(command[command.index("-cq") + 1], "21")
        self.assertNotIn("--host-managed-encoder-fallback", command)

    def test_lite_cut_schema_keeps_only_new_framemeld_switch(self):
        body = normalize_project_body(
            {
                "schema_version": 2,
                "output": {
                    "fps": 120,
                    "framemeld_enabled": True,
                    "frame_blend_enabled": True,
                    "frame_blend_frames": 7,
                    "delivery_fps": 120,
                },
                "tracks": [],
            }
        )
        self.assertTrue(body["output"]["framemeld_enabled"])
        self.assertNotIn("frame_blend_enabled", body["output"])
        self.assertNotIn("frame_blend_frames", body["output"])
        self.assertNotIn("delivery_fps", body["output"])


if __name__ == "__main__":
    unittest.main()
