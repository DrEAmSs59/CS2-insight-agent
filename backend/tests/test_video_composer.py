"""video_composer 单元测试（无需真实 FFmpeg 文件）。"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.video_composer import (
    MontageComposerError,
    build_bgm_filter,
    resolve_ffmpeg_binary,
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


class TestBgmFilter(unittest.TestCase):
    def test_contains_loop_and_trim(self):
        s = build_bgm_filter(120.5)
        self.assertIn("aloop", s)
        self.assertIn("atrim=0:120.500000", s)


if __name__ == "__main__":
    unittest.main()
