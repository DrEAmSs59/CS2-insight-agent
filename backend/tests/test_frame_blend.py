"""Frame-blending configuration and FFmpeg command tests."""

import sys
import unittest
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.frame_blend import (
    build_frame_blend_command,
    build_frame_blend_filter,
    is_frame_blend_source_supported,
    normalize_frame_blend_frames,
    resolve_frame_blend_output_fps,
)
from app.lite_cut.runtime import normalize_project_body


class TestFrameBlend(unittest.TestCase):
    def test_disabled_skips_the_filter_window(self):
        self.assertEqual(normalize_frame_blend_frames(False, 9), 1)

    def test_filter_uses_equal_weights_and_preserves_target_fps(self):
        self.assertEqual(
            build_frame_blend_filter(5, 60),
            "tmix=frames=5:weights='1 1 1 1 1',"
            "fps=60,setsar=1,format=yuv420p",
        )

    def test_240_to_60_uses_hermite_temporal_mixing(self):
        self.assertEqual(
            build_frame_blend_filter(7, 60, source_fps=240),
            "libplacebo=fps=60:frame_mixer=hermite:format=yuv420p,"
            "unsharp=5:5:0.3:5:5:0,setsar=1",
        )

    def test_120_to_60_uses_hermite_temporal_mixing(self):
        self.assertEqual(
            build_frame_blend_filter(7, 60, source_fps=120),
            "libplacebo=fps=60:frame_mixer=hermite:format=yuv420p,"
            "unsharp=5:5:0.3:5:5:0,setsar=1",
        )

    def test_intermediate_and_360_to_60_use_the_same_hermite_path(self):
        expected = (
            "libplacebo=fps=60:frame_mixer=hermite:format=yuv420p,"
            "unsharp=5:5:0.3:5:5:0,setsar=1"
        )
        self.assertEqual(build_frame_blend_filter(5, 60, source_fps=180), expected)
        self.assertEqual(build_frame_blend_filter(5, 60, source_fps=360), expected)

    def test_60_fps_source_skips_frame_blending(self):
        self.assertEqual(
            build_frame_blend_filter(7, 60, source_fps=60),
            "fps=60,setsar=1,format=yuv420p",
        )

    def test_frame_blending_starts_at_120_fps(self):
        self.assertFalse(is_frame_blend_source_supported(60))
        self.assertTrue(is_frame_blend_source_supported(120))
        self.assertTrue(is_frame_blend_source_supported(240))

    def test_command_reencodes_video_and_copies_optional_audio(self):
        command = build_frame_blend_command(
            ffmpeg_bin=Path("ffmpeg.exe"),
            source_path=Path("input.mp4"),
            output_path=Path("output.mp4"),
            frames=3,
            fps=30,
            video_encode_args=["-c:v", "libx264", "-crf", "18"],
        )
        self.assertTrue(command[command.index("-vf") + 1].startswith("tmix=frames=3:"))
        audio_index = command.index("0:a?")
        self.assertEqual(command[audio_index - 1 : audio_index + 1], ["-map", "0:a?"])
        self.assertEqual(command[command.index("-c:a") + 1], "copy")
        self.assertEqual(command[-1], "output.mp4")

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
