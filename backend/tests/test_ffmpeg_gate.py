from __future__ import annotations

import sys
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app import ffmpeg_compatibility, video_composer
from app.api.obs import _configured_ffmpeg_toolkit_report


def test_gate_requires_an_explicit_configured_path() -> None:
    assert _configured_ffmpeg_toolkit_report("")["reason"] == "not_configured"


def test_gate_returns_full_toolkit_diagnostics(monkeypatch, tmp_path: Path) -> None:
    ffmpeg = tmp_path / "ffmpeg.exe"
    ffmpeg.write_bytes(b"test")
    monkeypatch.setattr(video_composer, "resolve_ffmpeg_binary", lambda _raw: ffmpeg)
    monkeypatch.setattr(
        ffmpeg_compatibility,
        "inspect_ffmpeg_toolkit",
        lambda _path: {
            "ok": False,
            "reason": "ffprobe_missing",
            "ffmpeg_path": str(ffmpeg),
        },
    )

    report = _configured_ffmpeg_toolkit_report(str(ffmpeg))

    assert report["ok"] is False
    assert report["reason"] == "ffprobe_missing"
