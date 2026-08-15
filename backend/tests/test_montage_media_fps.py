import asyncio
from pathlib import Path
from types import SimpleNamespace

from app import video_composer
from app.api import montage as montage_api


def test_probes_optional_video_fps_and_skips_images(monkeypatch, tmp_path):
    intro_path = tmp_path / "intro.mp4"
    intro_path.write_bytes(b"video-placeholder")
    outro_path = tmp_path / "outro.png"

    monkeypatch.setattr(montage_api, "load_config", lambda: SimpleNamespace(ffmpeg_path=None))
    monkeypatch.setattr(video_composer, "resolve_ffmpeg_binary", lambda _configured: Path("ffmpeg"))
    monkeypatch.setattr(video_composer, "resolve_ffprobe_binary", lambda _ffmpeg: Path("ffprobe"))
    monkeypatch.setattr(
        video_composer,
        "probe_video_audio_summary",
        lambda path, _ffprobe: {"fps": 119.88 if path == intro_path else 0},
    )

    result = asyncio.run(
        montage_api.probe_montage_media_fps(
            montage_api.MontageMediaFpsProbeBody(paths=[str(intro_path), str(outro_path)]),
        ),
    )

    assert result == {
        "items": [
            {"path": str(intro_path), "kind": "video", "fps": 119.88, "status": "ok"},
            {"path": str(outro_path), "kind": "image", "fps": None, "status": "ok"},
        ],
    }
