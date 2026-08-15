from __future__ import annotations

import json
import logging
import sys
from pathlib import Path


_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.features.lite_cut.ffmpeg_runtime import run_ffmpeg_process  # noqa: E402
from app.video_export_log import (  # noqa: E402
    VIDEO_EXPORT_LOG_NAME,
    configure_video_export_logging,
    export_event,
    export_gpu_inventory,
    export_progress,
    set_video_export_database_id,
    shutdown_video_export_logging,
    video_export_session,
)


def _records(path: Path) -> list[dict[str, object]]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def test_dedicated_log_is_additive_and_keeps_existing_names_untouched(tmp_path: Path) -> None:
    existing = {
        "backend.log": "backend-sentinel",
        "backend-fault.log": "fault-sentinel",
        "backend-stdio.log": "stdio-sentinel",
        "desktop.log": "desktop-sentinel",
    }
    for name, content in existing.items():
        (tmp_path / name).write_text(content, encoding="utf-8")

    destination = configure_video_export_logging(tmp_path)
    try:
        logging.getLogger("app.video_composer").warning("outside export")
        with video_export_session("montage", session_id="montage-test-session"):
            set_video_export_database_id(42)
            export_event("pipeline_started", clip_count=3)
            logging.getLogger("app.video_composer").error("captured composer failure")
    finally:
        shutdown_video_export_logging()

    assert destination.name == VIDEO_EXPORT_LOG_NAME
    assert destination.is_file()
    for name, content in existing.items():
        assert (tmp_path / name).read_text(encoding="utf-8") == content

    records = _records(destination)
    assert [record["event"] for record in records] == ["pipeline_started", "log"]
    assert all(record["session_id"] == "montage-test-session" for record in records)
    assert all(record["database_export_id"] == 42 for record in records)
    assert records[-1]["message"] == "captured composer failure"
    assert "outside export" not in destination.read_text(encoding="utf-8")


def test_dedicated_log_rotates_without_touching_other_logs(tmp_path: Path) -> None:
    backend_log = tmp_path / "backend.log"
    backend_log.write_text("keep-backend", encoding="utf-8")
    destination = configure_video_export_logging(tmp_path, max_bytes=600, backup_count=2)
    try:
        with video_export_session("montage", session_id="rotation-test"):
            for index in range(20):
                export_event("diagnostic", index=index, detail="x" * 200)
    finally:
        shutdown_video_export_logging()

    assert destination.is_file()
    assert (tmp_path / f"{VIDEO_EXPORT_LOG_NAME}.1").is_file()
    assert backend_log.read_text(encoding="utf-8") == "keep-backend"


def test_progress_is_sampled_by_percent_and_stage(tmp_path: Path) -> None:
    destination = configure_video_export_logging(tmp_path)
    try:
        with video_export_session("lite_cut", session_id="litecut-progress-test"):
            export_progress(0.0, "rendering")
            export_progress(0.001, "rendering")
            export_progress(0.009, "rendering")
            export_progress(0.01, "rendering")
            export_progress(0.0101, "rendering")
            export_progress(0.01, "framemeld")
            export_progress(1.0, "done")
    finally:
        shutdown_video_export_logging()

    progress = [record for record in _records(destination) if record["event"] == "progress"]
    assert [(record["stage"], record["progress_percent"]) for record in progress] == [
        ("rendering", 0.0),
        ("rendering", 1.0),
        ("framemeld", 1.0),
        ("done", 100.0),
    ]


def test_inventory_and_first_frame_are_structured_once(tmp_path: Path) -> None:
    from types import SimpleNamespace

    destination = configure_video_export_logging(tmp_path)
    adapter = SimpleNamespace(
        enumeration_index=0,
        performance_rank=0,
        name="AMD Radeon RX Test",
        vendor="amd",
        kind="discrete",
        device_id="747E",
        luid="0000000000001234",
        pnp_device_id="PCI\\VEN_1002&DEV_747E",
        stable_id="0000000000001234",
        driver_version="1.2.3",
        dedicated_memory_bytes=16 * 1024**3,
        encoder_device_index=None,
    )
    try:
        with video_export_session("lite_cut", session_id="device-test"):
            export_gpu_inventory([adapter])
            export_progress(
                0.1,
                "framemeld",
                {"processed_frames": 1, "total_frames": 10},
            )
            export_progress(
                0.2,
                "framemeld",
                {"processed_frames": 2, "total_frames": 10},
            )
    finally:
        shutdown_video_export_logging()

    records = _records(destination)
    inventory = next(record for record in records if record["event"] == "device_inventory")
    assert inventory["devices"][0]["luid"] == "0000000000001234"
    assert inventory["devices"][0]["identity_quality"] == "dxgi_luid"
    first_frames = [record for record in records if record["event"] == "first_frame"]
    assert len(first_frames) == 1
    assert first_frames[0]["processed_frames"] == 1


def test_litecut_reader_thread_preserves_export_context(tmp_path: Path) -> None:
    destination = configure_video_export_logging(tmp_path)
    try:
        with video_export_session("lite_cut", session_id="litecut-reader-test"):
            result = run_ffmpeg_process(
                [
                    sys.executable,
                    "-c",
                    "import sys; sys.stderr.write('Frame: 5/10\\rFrame: 10/10\\r'); sys.stderr.flush()",
                ],
                timeout=5,
                progress_start=0.60,
                progress_end=0.995,
                progress_stage="framemeld",
            )
    finally:
        shutdown_video_export_logging()

    assert result.returncode == 0
    records = _records(destination)
    assert any(
        record.get("event") == "progress"
        and record.get("processed_frames") == 10
        and record.get("total_frames") == 10
        for record in records
    )
    assert any(
        record.get("event") == "stage_completed"
        and record.get("stage") == "framemeld"
        for record in records
    )
