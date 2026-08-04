from __future__ import annotations

import sys
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app import env_utils, ffmpeg_compatibility


def test_auto_detection_skips_incomplete_and_incompatible_candidates(monkeypatch, tmp_path: Path) -> None:
    incomplete = tmp_path / "incomplete" / "ffmpeg.exe"
    incompatible = tmp_path / "incompatible" / "ffmpeg.exe"
    compatible = tmp_path / "compatible" / "ffmpeg.exe"
    for candidate in (incomplete, incompatible, compatible):
        candidate.parent.mkdir(parents=True)
        candidate.write_bytes(b"test")

    monkeypatch.setattr(
        env_utils,
        "_iter_ffmpeg_candidates",
        lambda: iter((incomplete, incompatible, compatible)),
    )

    def inspect(candidate: Path):
        return {
            "ok": candidate == compatible,
            "reason": "ok" if candidate == compatible else "incompatible",
            "current_version": candidate.parent.name,
            "recommended": "compatible",
        }

    monkeypatch.setattr(ffmpeg_compatibility, "inspect_ffmpeg_toolkit", inspect)

    assert env_utils.detect_ffmpeg_path() == str(compatible)
