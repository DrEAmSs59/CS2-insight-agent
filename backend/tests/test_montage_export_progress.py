from __future__ import annotations

import asyncio
import sys
from pathlib import Path


_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.api import montage as montage_api  # noqa: E402
from app.api import montage_exports as montage_exports_api  # noqa: E402
from app.montage_export_runtime import (  # noqa: E402
    MontageExportJob,
    montage_export_job_snapshot,
    montage_export_jobs,
)


class _FakeMontageDB:
    def __init__(self) -> None:
        self.updates: list[tuple[int, dict[str, object]]] = []

    async def update_export(self, export_id: int, **fields: object) -> None:
        self.updates.append((export_id, fields))


def test_background_montage_export_reports_progress_and_completes(monkeypatch, tmp_path: Path) -> None:
    fake_db = _FakeMontageDB()
    monkeypatch.setattr(montage_api, "montage_db", fake_db)

    def fake_compose_montage(**kwargs: object) -> None:
        callback = kwargs["progress_callback"]
        callback(0.12, "starting", {"stage_progress": 1.0})
        callback(0.12, "fallback_h264_nvenc", {
            "encoder_warning": {
                "code": "NVIDIA_DRIVER_TOO_OLD",
                "found_nvenc_api": "13.0",
                "required_nvenc_api": "13.1",
                "minimum_driver_version": "610.00",
            },
        })
        callback(0.4, "normalizing", {"stage_progress": 0.5})
        callback(0.99, "validating", {"stage_progress": 1.0})

    from app import video_composer

    monkeypatch.setattr(video_composer, "compose_montage", fake_compose_montage)
    output = tmp_path / "montage.mp4"
    job = MontageExportJob(export_id=17, project_id=None, output_path=str(output))

    asyncio.run(montage_api._run_montage_export_job(job, {}))

    snapshot = montage_export_job_snapshot(job)
    assert snapshot["status"] == "done"
    assert snapshot["stage"] == "done"
    assert snapshot["progress"] == 1.0
    assert snapshot["output_path"] == str(output)
    assert snapshot["encoder_warning"] == {
        "code": "NVIDIA_DRIVER_TOO_OLD",
        "found_nvenc_api": "13.0",
        "required_nvenc_api": "13.1",
        "minimum_driver_version": "610.00",
    }
    assert fake_db.updates[0][1]["status"] == "running"
    assert fake_db.updates[-1][1]["status"] == "done"


def test_background_montage_export_stops_as_cancelled(monkeypatch, tmp_path: Path) -> None:
    fake_db = _FakeMontageDB()
    monkeypatch.setattr(montage_api, "montage_db", fake_db)

    def fake_compose_montage(**kwargs: object) -> None:
        cancel_event = kwargs["cancel_event"]
        cancel_event.set()
        kwargs["progress_callback"](0.4, "normalizing", {"stage_progress": 0.5})

    from app import video_composer

    monkeypatch.setattr(video_composer, "compose_montage", fake_compose_montage)
    job = MontageExportJob(
        export_id=18,
        project_id=None,
        output_path=str(tmp_path / "cancelled.mp4"),
    )

    asyncio.run(montage_api._run_montage_export_job(job, {}))

    snapshot = montage_export_job_snapshot(job)
    assert snapshot["status"] == "cancelled"
    assert snapshot["stage"] == "cancelled"
    assert snapshot["error"] == ""
    assert fake_db.updates[-1][1]["status"] == "cancelled"


def test_cancel_montage_export_sets_runtime_event(monkeypatch, tmp_path: Path) -> None:
    fake_db = _FakeMontageDB()
    monkeypatch.setattr(montage_exports_api, "montage_db", fake_db)
    job = MontageExportJob(
        export_id=19,
        project_id=None,
        output_path=str(tmp_path / "running.mp4"),
        status="running",
    )
    montage_export_jobs[job.export_id] = job
    try:
        snapshot = asyncio.run(montage_exports_api.cancel_montage_export(job.export_id))
    finally:
        montage_export_jobs.pop(job.export_id, None)

    assert job.cancel_event.is_set()
    assert snapshot["status"] == "cancelling"
    assert snapshot["stage"] == "cancelling"
    assert fake_db.updates[-1][1]["status"] == "cancelling"
