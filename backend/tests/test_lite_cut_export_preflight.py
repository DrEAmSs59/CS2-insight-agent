from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.lite_cut.export_preflight import (
    cleanup_stale_export_artifacts,
    ensure_ffmpeg_runnable,
    ensure_files_readable,
    ensure_output_space,
    estimate_required_space,
    project_file_paths,
    unique_output_path,
)
from app.video_composer import MontageComposerError


def test_unique_output_path_preserves_existing_export(tmp_path: Path):
    first = tmp_path / "match.mp4"
    first.write_bytes(b"complete")
    assert unique_output_path(str(first)) == tmp_path / "match (1).mp4"
    assert first.read_bytes() == b"complete"


def test_unique_output_path_honours_active_reservation(tmp_path: Path):
    requested = tmp_path / "match.mp4"
    assert unique_output_path(str(requested), reserved=[str(requested)]) == tmp_path / "match (1).mp4"


def test_project_sources_are_deduplicated_and_checked(tmp_path: Path):
    video = tmp_path / "clip.mov"
    video.write_bytes(b"media")
    paths = project_file_paths(
        {"tracks": [{"clips": [{"file_path": str(video)}, {"file_path": str(video)}]}]},
        [video],
    )
    assert paths == [video.resolve()]
    assert ensure_files_readable(paths) == 5


def test_unreadable_source_has_actionable_error(tmp_path: Path):
    with pytest.raises(MontageComposerError) as caught:
        ensure_files_readable([tmp_path / "missing.mov"])
    assert caught.value.code == "MONTAGE_CLIP_FILE_MISSING"


def test_output_space_preflight_reports_required_and_free(tmp_path: Path):
    with patch("app.lite_cut.export_preflight.shutil.disk_usage", return_value=SimpleNamespace(free=10)):
        with pytest.raises(MontageComposerError) as caught:
            ensure_output_space(tmp_path / "out.mp4", 100)
    assert caught.value.code == "MONTAGE_OUTPUT_DISK_FULL"
    assert caught.value.params["free_gb"] == "0.0"


def test_space_estimate_uses_timeline_duration():
    body = {"tracks": [{"clips": [{"timeline_start": 10, "trim_in": 2, "trim_out": 12}]}]}
    assert estimate_required_space(body, 0) >= 512 * 1024**2


def test_ffmpeg_preflight_rejects_nonzero_exit(tmp_path: Path):
    with patch("app.lite_cut.export_preflight.subprocess.run", return_value=SimpleNamespace(returncode=1)):
        with pytest.raises(MontageComposerError) as caught:
            ensure_ffmpeg_runnable(tmp_path / "ffmpeg.exe")
    assert caught.value.code == "MONTAGE_FFMPEG_NOT_RUNNABLE"


def test_stale_cleanup_removes_partial_output_and_temp_directory(tmp_path: Path):
    partial = tmp_path / "partial.mp4"
    partial.write_bytes(b"partial")
    work = tmp_path / "cs2_lite_cut_stale"
    work.mkdir()
    (work / "clip.ts").write_bytes(b"temp")
    cleanup_stale_export_artifacts([str(partial)])
    assert not partial.exists()
    assert not work.exists()
