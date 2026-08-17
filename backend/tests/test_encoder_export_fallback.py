from __future__ import annotations

import subprocess
import sys
import threading
from pathlib import Path

import pytest

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app import encoder_planner, video_composer  # noqa: E402
from app.encoder_planner import EncoderCandidate, GpuAdapter  # noqa: E402
from app.ffmpeg_process import run_process_capture  # noqa: E402
from app.features.lite_cut import export_preflight, render_pipeline  # noqa: E402
from app.montage_exceptions import HardwareEncoderFailure, MontageComposerError  # noqa: E402


def _amf_then_x264() -> tuple[EncoderCandidate, EncoderCandidate]:
    adapter = GpuAdapter(
        name="AMD Radeon RX Test",
        vendor="amd",
        kind="discrete",
        pnp_device_id=r"PCI\VEN_1002&DEV_TEST",
        driver_version="test-driver",
        performance_rank=0,
    )
    return (
        EncoderCandidate(codec="h264_amf", priority=0, adapter=adapter),
        EncoderCandidate(codec="libx264", priority=1),
    )


def _media_info() -> dict[str, object]:
    return {
        "width": 1920,
        "height": 1080,
        "fps": 60.0,
        "duration": 1.0,
        "has_audio": True,
    }


def _lite_cut_body(source: Path) -> dict[str, object]:
    return {
        "tracks": [
            {
                "id": "v1",
                "type": "video",
                "clips": [
                    {
                        "id": "clip-1",
                        "source_type": "file",
                        "file_path": str(source),
                        "timeline_start": 0.0,
                        "trim_in": 0.0,
                        "trim_out": 1.0,
                    }
                ],
            }
        ],
        "output": {},
    }


def _patch_shared_plan(monkeypatch: pytest.MonkeyPatch, identity: str) -> None:
    candidates = _amf_then_x264()
    monkeypatch.setattr(encoder_planner, "enumerate_windows_gpus", lambda: [])
    monkeypatch.setattr(
        encoder_planner,
        "map_nvenc_device_indices",
        lambda _ffmpeg, adapters: list(adapters),
    )
    monkeypatch.setattr(
        encoder_planner,
        "build_encoder_candidates",
        lambda *_args, **_kwargs: candidates,
    )
    monkeypatch.setattr(
        encoder_planner,
        "probe_ffmpeg_encoder",
        lambda *_args, **_kwargs: True,
    )
    monkeypatch.setattr(video_composer, "ffmpeg_encoder_identity", lambda _path: identity)
    monkeypatch.setattr(render_pipeline, "ffmpeg_encoder_identity", lambda _path: identity)


def test_montage_hardware_failure_falls_back_to_x264_and_atomically_replaces(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    target = tmp_path / "export.mp4"
    target.write_bytes(b"previous-complete-export")
    calls: list[str] = []

    _patch_shared_plan(monkeypatch, f"montage-success-{tmp_path}")
    monkeypatch.setattr(video_composer, "resolve_ffprobe_binary", lambda _ffmpeg: tmp_path / "ffprobe.exe")
    monkeypatch.setattr(video_composer, "probe_video_audio_summary", lambda *_args, **_kwargs: _media_info())
    monkeypatch.setattr(video_composer, "available_h264_encoders", lambda _ffmpeg: {"h264_amf", "libx264"})
    monkeypatch.setattr(
        video_composer,
        "ffprobe_streams",
        lambda *_args, **_kwargs: {"streams": [{"codec_type": "video"}]},
    )
    monkeypatch.setattr(
        video_composer,
        "run_process_capture",
        lambda command, **_kwargs: subprocess.CompletedProcess(command, 0, "", ""),
    )

    def fake_compose_once(**kwargs) -> None:
        codec = str(kwargs["montage_encoder"])
        attempt_output = Path(kwargs["output_path"])
        calls.append(codec)
        attempt_output.write_bytes(f"partial-{codec}".encode())
        if codec == "h264_amf":
            raise HardwareEncoderFailure(
                codec=codec,
                stage="montage_clip_normalize",
                returncode=1,
                stderr="AMF encoder failed",
                artifact_path=attempt_output,
            )
        attempt_output.write_bytes(b"x264-complete-export")

    monkeypatch.setattr(video_composer, "_compose_montage_once", fake_compose_once)

    result = video_composer.compose_montage(
        ffmpeg_bin=tmp_path / "ffmpeg.exe",
        clip_paths=[source],
        intro_path=None,
        outro_path=None,
        bgm_path=None,
        output_path=target,
        montage_encoder="auto",
    )

    assert calls == ["h264_amf", "libx264"]
    assert result.selected.codec == "libx264"
    assert target.read_bytes() == b"x264-complete-export"
    assert not list(tmp_path.glob(".export.encoder-attempt-*.mp4"))


def test_montage_source_ffprobe_failure_does_not_start_encoder_attempt(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "broken-source.mp4"
    source.write_bytes(b"not-a-video")
    calls: list[str] = []

    monkeypatch.setattr(video_composer, "resolve_ffprobe_binary", lambda _ffmpeg: tmp_path / "ffprobe.exe")

    def fail_source_probe(*_args, **_kwargs):
        raise MontageComposerError(
            "MONTAGE_FFPROBE_FAILED",
            stage="montage_source_preflight",
            file_role="source",
            name=source.name,
        )

    monkeypatch.setattr(video_composer, "probe_video_audio_summary", fail_source_probe)
    monkeypatch.setattr(
        video_composer,
        "_compose_montage_once",
        lambda **kwargs: calls.append(str(kwargs["montage_encoder"])),
    )

    with pytest.raises(MontageComposerError) as caught:
        video_composer.compose_montage(
            ffmpeg_bin=tmp_path / "ffmpeg.exe",
            clip_paths=[source],
            intro_path=None,
            outro_path=None,
            bgm_path=None,
            output_path=tmp_path / "export.mp4",
            montage_encoder="auto",
        )

    assert caught.value.code == "MONTAGE_FFPROBE_FAILED"
    assert caught.value.params["file_role"] == "source"
    assert calls == []


def test_montage_hardware_output_decode_timeout_falls_back_to_x264(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    target = tmp_path / "export.mp4"
    calls: list[str] = []

    _patch_shared_plan(monkeypatch, f"montage-decode-timeout-{tmp_path}")
    monkeypatch.setattr(video_composer, "resolve_ffprobe_binary", lambda _ffmpeg: tmp_path / "ffprobe.exe")
    monkeypatch.setattr(video_composer, "probe_video_audio_summary", lambda *_args, **_kwargs: _media_info())
    monkeypatch.setattr(video_composer, "available_h264_encoders", lambda _ffmpeg: {"h264_amf", "libx264"})
    monkeypatch.setattr(
        video_composer,
        "ffprobe_streams",
        lambda *_args, **_kwargs: {"streams": [{"codec_type": "video"}]},
    )

    def fake_compose_once(**kwargs) -> None:
        codec = str(kwargs["montage_encoder"])
        calls.append(codec)
        Path(kwargs["output_path"]).write_text(codec, encoding="utf-8")

    def decode(command, **_kwargs):
        attempt_path = Path(command[command.index("-i") + 1])
        if attempt_path.read_text(encoding="utf-8") == "h264_amf":
            raise subprocess.TimeoutExpired(command, 3600)
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(video_composer, "_compose_montage_once", fake_compose_once)
    monkeypatch.setattr(video_composer, "run_process_capture", decode)

    result = video_composer.compose_montage(
        ffmpeg_bin=tmp_path / "ffmpeg.exe",
        clip_paths=[source],
        intro_path=None,
        outro_path=None,
        bgm_path=None,
        output_path=target,
        montage_encoder="auto",
    )

    assert calls == ["h264_amf", "libx264"]
    assert result.selected.codec == "libx264"
    assert target.read_text(encoding="utf-8") == "libx264"


def test_montage_failed_fallback_does_not_destroy_existing_target(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    target = tmp_path / "export.mp4"
    target.write_bytes(b"keep-this-export")
    calls: list[str] = []

    _patch_shared_plan(monkeypatch, f"montage-failure-{tmp_path}")
    monkeypatch.setattr(video_composer, "resolve_ffprobe_binary", lambda _ffmpeg: tmp_path / "ffprobe.exe")
    monkeypatch.setattr(video_composer, "probe_video_audio_summary", lambda *_args, **_kwargs: _media_info())
    monkeypatch.setattr(video_composer, "available_h264_encoders", lambda _ffmpeg: {"h264_amf", "libx264"})

    def fail_every_attempt(**kwargs) -> None:
        codec = str(kwargs["montage_encoder"])
        attempt_output = Path(kwargs["output_path"])
        calls.append(codec)
        attempt_output.write_bytes(f"partial-{codec}".encode())
        if codec == "h264_amf":
            raise HardwareEncoderFailure(codec=codec, stage="normalize", artifact_path=attempt_output)
        raise MontageComposerError("MONTAGE_CLIP_NORMALIZE_FAILED", name=source.name)

    monkeypatch.setattr(video_composer, "_compose_montage_once", fail_every_attempt)

    with pytest.raises(MontageComposerError) as caught:
        video_composer.compose_montage(
            ffmpeg_bin=tmp_path / "ffmpeg.exe",
            clip_paths=[source],
            intro_path=None,
            outro_path=None,
            bgm_path=None,
            output_path=target,
            montage_encoder="auto",
        )

    assert caught.value.code == "MONTAGE_CLIP_NORMALIZE_FAILED"
    assert calls == ["h264_amf", "libx264"]
    assert target.read_bytes() == b"keep-this-export"
    assert not list(tmp_path.glob(".export.encoder-attempt-*.mp4"))


def test_lite_cut_hardware_failure_falls_back_to_x264_and_atomically_replaces(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    target = tmp_path / "export.mp4"
    target.write_bytes(b"previous-complete-export")
    calls: list[str] = []

    _patch_shared_plan(monkeypatch, f"lite-cut-success-{tmp_path}")
    monkeypatch.setattr(render_pipeline, "resolve_ffprobe_binary", lambda _ffmpeg: tmp_path / "ffprobe.exe")
    monkeypatch.setattr(render_pipeline, "probe_video_audio_summary", lambda *_args, **_kwargs: _media_info())
    monkeypatch.setattr(render_pipeline, "available_h264_encoders", lambda _ffmpeg: {"h264_amf", "libx264"})
    monkeypatch.setattr(
        export_preflight,
        "validate_export_output",
        lambda _ffmpeg, path: Path(path).read_bytes(),
    )

    def fake_compose_once(**kwargs) -> None:
        codec = str(kwargs["montage_encoder"])
        attempt_output = Path(kwargs["output_path"])
        calls.append(codec)
        attempt_output.write_bytes(f"partial-{codec}".encode())
        if codec == "h264_amf":
            raise HardwareEncoderFailure(
                codec=codec,
                stage="lite_cut_clip_normalize",
                returncode=1,
                stderr="AMF encoder failed",
                artifact_path=attempt_output,
            )
        attempt_output.write_bytes(b"x264-complete-export")

    monkeypatch.setattr(render_pipeline, "_compose_lite_cut_montage_once", fake_compose_once)

    result = render_pipeline.compose_lite_cut_montage(
        ffmpeg_bin=tmp_path / "ffmpeg.exe",
        project_body=_lite_cut_body(source),
        clip_path_by_id={},
        output_path=target,
        montage_encoder="auto",
    )

    assert calls == ["h264_amf", "libx264"]
    assert result.selected.codec == "libx264"
    assert target.read_bytes() == b"x264-complete-export"
    assert not list(tmp_path.glob(".export.encoder-attempt-*.mp4"))


def test_lite_cut_undecodable_hardware_output_falls_back_to_x264(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    target = tmp_path / "export.mp4"
    calls: list[str] = []

    _patch_shared_plan(monkeypatch, f"lite-cut-validation-{tmp_path}")
    monkeypatch.setattr(render_pipeline, "resolve_ffprobe_binary", lambda _ffmpeg: tmp_path / "ffprobe.exe")
    monkeypatch.setattr(render_pipeline, "probe_video_audio_summary", lambda *_args, **_kwargs: _media_info())
    monkeypatch.setattr(render_pipeline, "available_h264_encoders", lambda _ffmpeg: {"h264_amf", "libx264"})

    def fake_compose_once(**kwargs) -> None:
        codec = str(kwargs["montage_encoder"])
        calls.append(codec)
        Path(kwargs["output_path"]).write_text(codec, encoding="utf-8")

    def validate(_ffmpeg: Path, path: Path) -> None:
        if path.read_text(encoding="utf-8") == "h264_amf":
            raise MontageComposerError("MONTAGE_OUTPUT_NOT_PLAYABLE")

    monkeypatch.setattr(render_pipeline, "_compose_lite_cut_montage_once", fake_compose_once)
    monkeypatch.setattr(export_preflight, "validate_export_output", validate)

    result = render_pipeline.compose_lite_cut_montage(
        ffmpeg_bin=tmp_path / "ffmpeg.exe",
        project_body=_lite_cut_body(source),
        clip_path_by_id={},
        output_path=target,
        montage_encoder="auto",
    )

    assert calls == ["h264_amf", "libx264"]
    assert result.selected.codec == "libx264"
    assert target.read_text(encoding="utf-8") == "libx264"


def test_lite_cut_source_ffprobe_failure_does_not_start_encoder_attempt(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "broken-source.mp4"
    source.write_bytes(b"not-a-video")
    calls: list[str] = []

    monkeypatch.setattr(render_pipeline, "resolve_ffprobe_binary", lambda _ffmpeg: tmp_path / "ffprobe.exe")

    def fail_source_probe(*_args, **_kwargs):
        raise MontageComposerError(
            "MONTAGE_FFPROBE_FAILED",
            stage="lite_cut_source_preflight",
            file_role="source",
            name=source.name,
        )

    monkeypatch.setattr(render_pipeline, "probe_video_audio_summary", fail_source_probe)
    monkeypatch.setattr(
        render_pipeline,
        "_compose_lite_cut_montage_once",
        lambda **kwargs: calls.append(str(kwargs["montage_encoder"])),
    )

    with pytest.raises(MontageComposerError) as caught:
        render_pipeline.compose_lite_cut_montage(
            ffmpeg_bin=tmp_path / "ffmpeg.exe",
            project_body=_lite_cut_body(source),
            clip_path_by_id={},
            output_path=tmp_path / "export.mp4",
            montage_encoder="auto",
        )

    assert caught.value.code == "MONTAGE_FFPROBE_FAILED"
    assert caught.value.params["file_role"] == "source"
    assert calls == []


def test_lite_cut_cancel_after_hardware_failure_does_not_start_x264(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    target = tmp_path / "export.mp4"
    target.write_bytes(b"previous-complete-export")
    cancel_event = threading.Event()
    calls: list[str] = []

    _patch_shared_plan(monkeypatch, f"lite-cut-cancel-{tmp_path}")
    monkeypatch.setattr(render_pipeline, "resolve_ffprobe_binary", lambda _ffmpeg: tmp_path / "ffprobe.exe")
    monkeypatch.setattr(render_pipeline, "probe_video_audio_summary", lambda *_args, **_kwargs: _media_info())
    monkeypatch.setattr(render_pipeline, "available_h264_encoders", lambda _ffmpeg: {"h264_amf", "libx264"})

    def fail_and_cancel(**kwargs) -> None:
        codec = str(kwargs["montage_encoder"])
        attempt_output = Path(kwargs["output_path"])
        calls.append(codec)
        attempt_output.write_bytes(b"partial-amf")
        cancel_event.set()
        raise HardwareEncoderFailure(
            codec=codec,
            stage="lite_cut_clip_normalize",
            artifact_path=attempt_output,
        )

    monkeypatch.setattr(render_pipeline, "_compose_lite_cut_montage_once", fail_and_cancel)

    with pytest.raises(MontageComposerError) as caught:
        render_pipeline.compose_lite_cut_montage(
            ffmpeg_bin=tmp_path / "ffmpeg.exe",
            project_body=_lite_cut_body(source),
            clip_path_by_id={},
            output_path=target,
            montage_encoder="auto",
            cancel_event=cancel_event,
        )

    assert caught.value.code == "MONTAGE_EXPORT_CANCELLED"
    assert calls == ["h264_amf"]
    assert target.read_bytes() == b"previous-complete-export"
    assert not list(tmp_path.glob(".export.encoder-attempt-*.mp4"))


def test_montage_hardware_timeout_is_retryable(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    command = [
        str(tmp_path / "ffmpeg.exe"),
        "-c:v",
        "h264_amf",
        str(tmp_path / "attempt.mp4"),
    ]

    def time_out(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(command, 10)

    monkeypatch.setattr(
        video_composer,
        "run_process_capture",
        time_out,
    )

    with pytest.raises(HardwareEncoderFailure) as caught:
        video_composer._run_ffmpeg_capture(
            command,
            timeout=10,
            stage="montage_clip_normalize",
            output_path=tmp_path / "attempt.mp4",
        )

    assert caught.value.codec == "h264_amf"
    assert caught.value.stage == "montage_clip_normalize"
    assert caught.value.returncode == 124


@pytest.mark.parametrize(
    ("encoder", "branch"),
    (
        ("h264_amf", "amd_amf"),
        ("h264_qsv", "intel_qsv"),
        ("h264_nvenc", "nvidia_nvenc"),
        ("libx264", "software_x264"),
    ),
)
def test_montage_precise_framemeld_timeout_does_not_trigger_cpu_fallback(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    encoder: str,
    branch: str,
) -> None:
    command = [
        str(tmp_path / "ffmpeg.exe"),
        "-framemeld",
        "--status-json-lines",
        "-c:v",
        encoder,
        str(tmp_path / "attempt.mp4"),
    ]

    run_kwargs: dict[str, object] = {}

    def time_out(*_args, **kwargs):
        run_kwargs.update(kwargs)
        raise subprocess.TimeoutExpired(
            command,
            kwargs["timeout"],
            output=b"",
            stderr=b"framemeld-status:{\"protocol\":\"org.framemeld.status\",\"event\":\"pipeline_started\"}",
        )

    monkeypatch.setattr(video_composer, "run_process_capture", time_out)

    with pytest.raises(MontageComposerError) as caught:
        video_composer._run_ffmpeg_capture(
            command,
            timeout=3600,
            stage="montage_framemeld",
            output_path=tmp_path / "attempt.mp4",
        )

    assert not isinstance(caught.value, HardwareEncoderFailure)
    assert caught.value.code == "MONTAGE_FRAMEMELD_TIMEOUT"
    assert caught.value.params["branch"] == branch
    assert caught.value.params["encoder"] == encoder
    assert caught.value.params["timeout_seconds"] == 12 * 60 * 60
    assert run_kwargs["timeout"] == 12 * 60 * 60
    assert run_kwargs["stall_timeout"] == 15 * 60


def test_montage_capture_reports_last_frame_when_process_stalls() -> None:
    command = [
        sys.executable,
        "-c",
        (
            "import sys,time; "
            "sys.stderr.write('Frame: 7/20\\r'); sys.stderr.flush(); "
            "time.sleep(5)"
        ),
    ]
    with pytest.raises(subprocess.TimeoutExpired) as caught:
        run_process_capture(command, timeout=10, stall_timeout=0.25)

    assert "after frame 7" in str(caught.value.stderr)
