import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.features.lite_cut.export_preflight import (
    cleanup_stale_export_artifacts,
    ensure_ffmpeg_runnable,
    ensure_files_readable,
    ensure_lite_cut_audio_command_length,
    ensure_output_space,
    estimate_required_space,
    project_file_paths,
    unique_output_path,
    validate_export_output,
)
from app.features.lite_cut.export_plan import build_lite_cut_export_plan
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
    with patch("app.features.lite_cut.export_preflight.shutil.disk_usage", return_value=SimpleNamespace(free=10)):
        with pytest.raises(MontageComposerError) as caught:
            ensure_output_space(tmp_path / "out.mp4", 100)
    assert caught.value.code == "MONTAGE_OUTPUT_DISK_FULL"
    assert caught.value.params["free_gb"] == "0.0"


def test_space_estimate_uses_timeline_duration():
    body = {"tracks": [{"clips": [{"timeline_start": 10, "trim_in": 2, "trim_out": 12}]}]}
    assert estimate_required_space(body, 0) >= 512 * 1024**2


def test_lite_cut_audio_command_is_checked_during_preflight(tmp_path: Path):
    audio_path = tmp_path / "voice.wav"
    body = {
        "tracks": [
            {
                "id": "a1",
                "type": "audio",
                "clips": [
                    {
                        "id": "audio-1",
                        "source_type": "file",
                        "file_path": str(audio_path),
                        "timeline_start": 0,
                        "trim_in": 0,
                        "trim_out": 10,
                    },
                ],
            },
        ],
    }
    plan = build_lite_cut_export_plan(body)
    with patch(
        "app.features.lite_cut.export_preflight.ensure_windows_command_length",
        return_value=1234,
    ) as checked:
        measured = ensure_lite_cut_audio_command_length(
            ffmpeg_bin=tmp_path / "ffmpeg.exe",
            export_plan=plan,
            clip_path_by_id={},
            output_path=tmp_path / "out.mp4",
        )

    assert measured == 1234
    command = checked.call_args.args[0]
    assert "-filter_complex" in command
    assert str(audio_path.resolve()) in command


def test_ffmpeg_preflight_rejects_nonzero_exit(tmp_path: Path):
    with patch("app.features.lite_cut.export_preflight.subprocess.run", return_value=SimpleNamespace(returncode=1)):
        with pytest.raises(MontageComposerError) as caught:
            ensure_ffmpeg_runnable(tmp_path / "ffmpeg.exe")
    assert caught.value.code == "MONTAGE_FFMPEG_NOT_RUNNABLE"


def test_stale_cleanup_preserves_published_output_and_removes_private_artifacts(tmp_path: Path):
    published = tmp_path / "published.mp4"
    published.write_bytes(b"validated-complete-export")
    attempt = tmp_path / ".published.encoder-attempt-deadbeef.mp4"
    attempt.write_bytes(b"partial")
    work = tmp_path / "cs2_lite_cut_stale"
    work.mkdir()
    (work / "clip.ts").write_bytes(b"temp")
    cleanup_stale_export_artifacts([str(published)])
    assert published.read_bytes() == b"validated-complete-export"
    assert not attempt.exists()
    assert not work.exists()


def test_validate_export_output_decodes_the_video_stream(tmp_path: Path):
    output = tmp_path / "complete.mp4"
    output.write_bytes(b"media")
    completed = subprocess.CompletedProcess([], 0, "", "")
    with (
        patch(
            "app.features.lite_cut.export_preflight.ffprobe_streams",
            return_value={"streams": [{"codec_type": "video"}]},
        ),
        patch(
            "app.features.lite_cut.export_preflight.resolve_ffprobe_binary",
            return_value=tmp_path / "ffprobe.exe",
        ),
        patch(
            "app.features.lite_cut.export_preflight.run_process_capture",
            return_value=completed,
        ) as run,
    ):
        validate_export_output(tmp_path / "ffmpeg.exe", output)

    command = run.call_args.args[0]
    assert command[-3:] == ["-f", "null", "-"]
    assert ["-map", "0:v:0"] == command[command.index("-map") : command.index("-map") + 2]


def test_validate_export_output_rejects_an_undecodable_video(tmp_path: Path):
    output = tmp_path / "broken.mp4"
    output.write_bytes(b"media")
    failed = subprocess.CompletedProcess([], 1, "", "invalid frame")
    with (
        patch(
            "app.features.lite_cut.export_preflight.ffprobe_streams",
            return_value={"streams": [{"codec_type": "video"}]},
        ),
        patch(
            "app.features.lite_cut.export_preflight.resolve_ffprobe_binary",
            return_value=tmp_path / "ffprobe.exe",
        ),
        patch(
            "app.features.lite_cut.export_preflight.run_process_capture",
            return_value=failed,
        ),
        pytest.raises(MontageComposerError) as caught,
    ):
        validate_export_output(tmp_path / "ffmpeg.exe", output)

    assert caught.value.code == "MONTAGE_OUTPUT_NOT_PLAYABLE"
