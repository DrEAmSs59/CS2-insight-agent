from __future__ import annotations

import sys
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app import ffmpeg_compatibility
from app.montage_exceptions import MontageComposerError


def _reference_outputs(command: list[str]) -> str:
    baseline = ffmpeg_compatibility.load_ffmpeg_baseline()
    if command[-1] == "-version":
        flags = " ".join(baseline["required_build_flags"])
        return (
            "ffmpeg version 2026-05-06-git-f2e5eff3ff-full_build-www.gyan.dev\n"
            f"configuration: {flags}\n"
            "libavcodec     62. 30.100\n"
            "libavformat    62. 15.100\n"
            "libavfilter    11. 17.100\n"
        )
    if command[-1] == "-encoders":
        return "\n".join(f" V....D {name} test" for name in baseline["required_encoders"])
    if command[-1] == "-decoders":
        return "\n".join(f" V....D {name} test" for name in baseline["required_decoders"])
    if command[-1] == "-hwaccels":
        return "\n".join(baseline["required_hwaccels"])
    raise AssertionError(command)


def test_reference_build_passes_baseline(monkeypatch, tmp_path: Path) -> None:
    ffmpeg = tmp_path / "ffmpeg.exe"
    ffmpeg.write_bytes(b"test")
    ffmpeg_compatibility._audit_cached.cache_clear()
    monkeypatch.setattr(ffmpeg_compatibility, "_run", _reference_outputs)

    report = ffmpeg_compatibility.audit_ffmpeg_compatibility(ffmpeg)

    assert report["compatible"] is True
    assert report["issues"] == []


def test_older_essentials_build_is_incompatible(monkeypatch, tmp_path: Path) -> None:
    ffmpeg = tmp_path / "ffmpeg.exe"
    ffmpeg.write_bytes(b"test")
    ffmpeg_compatibility._audit_cached.cache_clear()

    def essentials_outputs(command: list[str]) -> str:
        output = _reference_outputs(command)
        if command[-1] == "-version":
            return (
                output.replace("2026-05-06-git-f2e5eff3ff-full_build", "8.1.2-essentials_build")
                .replace(" --enable-libdav1d", "")
                .replace(" --enable-vulkan", "")
                .replace(" --enable-opencl", "")
                .replace("62. 30.100", "62. 28.102")
                .replace("62. 15.100", "62. 12.102")
                .replace("11. 17.100", "11. 14.102")
            )
        return output

    monkeypatch.setattr(ffmpeg_compatibility, "_run", essentials_outputs)
    report = ffmpeg_compatibility.audit_ffmpeg_compatibility(ffmpeg)

    assert report["compatible"] is False
    assert "missing_build_flag:--enable-libdav1d" in report["issues"]
    assert any(issue.startswith("library_too_old:libavformat") for issue in report["issues"])


def test_failed_probe_gets_recommended_build_hint(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        ffmpeg_compatibility,
        "audit_ffmpeg_compatibility",
        lambda _path: {
            "compatible": False,
            "audit_failed": False,
            "recommended": "ffmpeg-reference-full_build",
            "current_version": "older-essentials_build",
            "issues": ["missing_build_flag:--enable-libdav1d"],
        },
    )
    source_error = MontageComposerError(
        "MONTAGE_FFPROBE_FAILED",
        file_role="source",
        name="clip.mp4",
    )

    hinted = ffmpeg_compatibility.add_ffmpeg_compatibility_hint(
        source_error,
        tmp_path / "ffmpeg.exe",
    )

    assert hinted.code == "MONTAGE_FFMPEG_SOURCE_COMPATIBILITY"
    assert hinted.params["name"] == "clip.mp4"
    assert hinted.params["recommended"] == "ffmpeg-reference-full_build"
    assert hinted.params["original_code"] == "MONTAGE_FFPROBE_FAILED"


def test_toolkit_requires_sibling_ffprobe(tmp_path: Path) -> None:
    ffmpeg = tmp_path / "ffmpeg.exe"
    ffmpeg.write_bytes(b"test")

    report = ffmpeg_compatibility.inspect_ffmpeg_toolkit(ffmpeg)

    assert report["ok"] is False
    assert report["reason"] == "ffprobe_missing"


def test_toolkit_rejects_mismatched_tool_versions(monkeypatch, tmp_path: Path) -> None:
    ffmpeg = tmp_path / "ffmpeg.exe"
    ffprobe = tmp_path / "ffprobe.exe"
    ffmpeg.write_bytes(b"test")
    ffprobe.write_bytes(b"test")
    monkeypatch.setattr(
        ffmpeg_compatibility,
        "ffmpeg_tool_version_identity",
        lambda path: "ffmpeg-build" if Path(path).name == "ffmpeg.exe" else "ffprobe-build",
    )

    report = ffmpeg_compatibility.inspect_ffmpeg_toolkit(ffmpeg)

    assert report["ok"] is False
    assert report["reason"] == "version_mismatch"


def test_toolkit_accepts_matching_compatible_full_build(monkeypatch, tmp_path: Path) -> None:
    ffmpeg = tmp_path / "ffmpeg.exe"
    ffprobe = tmp_path / "ffprobe.exe"
    ffmpeg.write_bytes(b"test")
    ffprobe.write_bytes(b"test")
    monkeypatch.setattr(
        ffmpeg_compatibility,
        "ffmpeg_tool_version_identity",
        lambda _path: "matching-full-build",
    )
    monkeypatch.setattr(
        ffmpeg_compatibility,
        "audit_ffmpeg_compatibility",
        lambda _path: {
            "compatible": True,
            "audit_failed": False,
            "recommended": "matching-full-build",
            "current_version": "matching-full-build",
            "issues": [],
        },
    )

    report = ffmpeg_compatibility.inspect_ffmpeg_toolkit(ffmpeg)

    assert report["ok"] is True
    assert report["reason"] == "ok"
