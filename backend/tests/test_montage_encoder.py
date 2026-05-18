"""montage_encoder：编码器解析（mock FFmpeg，无需本机 ffmpeg）。"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))


class TestMontageEncoder(unittest.TestCase):
    def tearDown(self):
        import app.montage_encoder as me

        me._encoder_check_cache.clear()
        me._hw_probe_cache.clear()

    def test_auto_prefers_nvenc(self):
        import app.montage_encoder as me

        fake = " V..... h264_nvenc\n V..... libx264\n"

        def side_effect(cmd, **kwargs):
            if "-encoders" in cmd:
                return MagicMock(stdout=fake, stderr="", returncode=0)
            return MagicMock(stdout="", stderr="", returncode=0)

        with patch.object(me.subprocess, "run", side_effect=side_effect):
            from app.montage_encoder import resolve_h264_codec_name

            c = resolve_h264_codec_name(Path("C:/fake/ffmpeg.exe"), "auto")
            self.assertEqual(c, "h264_nvenc")

    def test_auto_fallback_libx264(self):
        import app.montage_encoder as me

        fake = " V..... libx264\n"
        with patch.object(me.subprocess, "run") as m_run:
            m_run.return_value = MagicMock(stdout=fake, stderr="", returncode=0)
            from app.montage_encoder import resolve_h264_codec_name

            c = resolve_h264_codec_name(Path("C:/fake/ffmpeg.exe"), "auto")
            self.assertEqual(c, "libx264")

    def test_auto_nvenc_listed_but_runtime_fails_uses_next(self):
        import app.montage_encoder as me

        fake = " V..... h264_nvenc\n V..... h264_qsv\n V..... libx264\n"
        calls = {"probe_nvenc": False, "probe_qsv": False}

        def side_effect(cmd, **kwargs):
            if "-encoders" in cmd:
                return MagicMock(stdout=fake, stderr="", returncode=0)
            if "h264_nvenc" in cmd:
                calls["probe_nvenc"] = True
                return MagicMock(stdout="", stderr="nvenc no gpu", returncode=1)
            if "h264_qsv" in cmd:
                calls["probe_qsv"] = True
                return MagicMock(stdout="", stderr="", returncode=0)
            return MagicMock(stdout="", stderr="unexpected", returncode=1)

        with patch.object(me.subprocess, "run", side_effect=side_effect):
            from app.montage_encoder import resolve_h264_codec_name

            c = resolve_h264_codec_name(Path("C:/fake/ffmpeg.exe"), "auto")
            self.assertEqual(c, "h264_qsv")
            self.assertTrue(calls["probe_nvenc"])
            self.assertTrue(calls["probe_qsv"])

    def test_explicit_missing_hw_raises(self):
        import app.montage_encoder as me

        fake = " V..... libx264\n"
        with patch.object(me.subprocess, "run") as m_run:
            m_run.return_value = MagicMock(stdout=fake, stderr="", returncode=0)
            from app.montage_encoder import resolve_h264_codec_name
            from app.video_composer import MontageComposerError

            with self.assertRaises(MontageComposerError):
                resolve_h264_codec_name(Path("C:/fake/ffmpeg.exe"), "h264_nvenc")

    def test_h264_encode_cli_args_nvenc(self):
        from app.montage_encoder import h264_encode_cli_args

        q = h264_encode_cli_args("h264_nvenc", "quality")
        self.assertIn("h264_nvenc", q)
        self.assertIn("-cq", q)


if __name__ == "__main__":
    unittest.main()
