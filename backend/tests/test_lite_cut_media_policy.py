from pathlib import Path

import pytest

from app.features.lite_cut import assets
from app.features.lite_cut.media_metadata import MediaMetadata
from app.features.lite_cut.media_policy import (
    alpha_preview_proxy_command,
    asset_kind_for_path,
    asset_needs_browser_proxy,
    preview_proxy_command,
)


@pytest.mark.parametrize(
    ("filename", "kind", "needs_proxy"),
    [
        ("clip.mp4", "video", False),
        ("clip.mov", "video", True),
        ("clip.avi", "video", True),
        ("animation.gif", "video", True),
        ("music.flac", "audio", False),
        ("sticker.png", "image", False),
        ("font.woff2", "font", False),
    ],
)
def test_media_policy_table(filename, kind, needs_proxy, tmp_path):
    path = tmp_path / filename
    path.write_bytes(b"sample")
    assert asset_kind_for_path(path) == kind
    assert asset_needs_browser_proxy(path) is needs_proxy
    assert assets.asset_kind_for_path(path) == kind
    assert assets.asset_needs_browser_proxy(path) is needs_proxy


def test_command_facade_remains_byte_for_byte_equivalent(tmp_path):
    values = {
        "ffmpeg_bin": Path("ffmpeg"),
        "source": tmp_path / "input.mov",
        "output": tmp_path / "proxy.mp4",
        "video_encode_quality": ["-c:v", "libx264", "-preset", "fast"],
        "duration_sec": 4.25,
        "max_edge": 720,
    }
    assert preview_proxy_command(**values) == assets.preview_proxy_command(**values)
    alpha_values = {key: value for key, value in values.items() if key != "video_encode_quality"}
    alpha_values["output"] = tmp_path / "alpha.webm"
    assert alpha_preview_proxy_command(**alpha_values) == assets.alpha_preview_proxy_command(**alpha_values)


def test_media_metadata_normalizes_probe_shape_without_io():
    metadata = MediaMetadata.from_probe({
        "codec_name": " H264 ",
        "audio_codec_name": " AAC ",
        "pixel_format": " YUV420P ",
        "fps": "59.94",
        "has_alpha": False,
        "duration_sec": "4.5",
        "width": "1920",
        "height": 1080,
    })
    assert metadata.video_codec == "h264"
    assert metadata.audio_codec == "aac"
    assert metadata.pixel_format == "yuv420p"
    assert metadata.fps == pytest.approx(59.94)
    assert metadata.duration_sec == 4.5
    assert (metadata.width, metadata.height) == (1920, 1080)
