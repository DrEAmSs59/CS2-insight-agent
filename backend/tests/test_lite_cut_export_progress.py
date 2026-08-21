from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

from app.features.lite_cut import export_api
from app.features.lite_cut.runtime import LiteCutExportJob, export_job_snapshot


class _FakeExports:
    def __init__(self) -> None:
        self.updates: list[tuple[int, dict[str, object]]] = []

    async def update(self, export_id: int, **fields: object) -> None:
        self.updates.append((export_id, fields))


def test_lite_cut_export_preserves_nvenc_driver_warning(monkeypatch, tmp_path: Path) -> None:
    exports = _FakeExports()
    monkeypatch.setattr(export_api, "_services", lambda: SimpleNamespace(exports=exports))

    output = tmp_path / "lite-cut.mp4"

    async def fake_execute(_prepared, *, progress_callback, cancel_event) -> Path:
        assert cancel_event is not None
        progress_callback(0.01, "fallback_h264_nvenc", {
            "encoder_warning": {
                "code": "NVIDIA_DRIVER_TOO_OLD",
                "found_nvenc_api": "13.0",
                "required_nvenc_api": "13.1",
                "minimum_driver_version": "610.00",
            },
        })
        progress_callback(0.5, "normalizing", {"stage_progress": 0.5})
        return output

    monkeypatch.setattr(export_api, "execute_prepared_export", fake_execute)
    job = LiteCutExportJob(
        export_id=23,
        project_id=7,
        output_path=str(output),
    )

    asyncio.run(export_api._run_lite_cut_export_job_in_session(job, {}))

    snapshot = export_job_snapshot(job)
    assert snapshot["status"] == "done"
    assert snapshot["encoder_warning"] == {
        "code": "NVIDIA_DRIVER_TOO_OLD",
        "found_nvenc_api": "13.0",
        "required_nvenc_api": "13.1",
        "minimum_driver_version": "610.00",
    }
    assert exports.updates[0][1]["status"] == "running"
    assert exports.updates[-1][1]["status"] == "done"
