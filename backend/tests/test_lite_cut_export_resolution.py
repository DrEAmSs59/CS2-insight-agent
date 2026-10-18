import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.features.lite_cut import export_api, export_executor
from app.features.lite_cut.export_plan import build_lite_cut_export_plan
from app.features.lite_cut.models import empty_project
from app.features.lite_cut.runtime import normalize_project_body
from app.video_composer import MontageComposerError


def project(width, height):
    body = empty_project().model_dump(mode="json", by_alias=True)
    body["output"].update(width=width, height=height)
    track = next(track for track in body["tracks"] if track["type"] == "video")
    track["clips"] = [{
        "id": "clip-1", "source_type": "file", "file_path": "clip.mp4",
        "timeline_start": 0, "trim_in": 0, "trim_out": 3, "duration": 3,
    }]
    return body


@pytest.mark.parametrize("width,height", [(1155, 900), (1920, 1081), (1155, 901)])
@pytest.mark.parametrize("endpoint", ["/export", "/export/start"])
@pytest.mark.parametrize("saved_project", [False, True])
def test_api_rejects_odd_dimensions_before_creating_a_job_or_running_ffmpeg(
    monkeypatch, width, height, endpoint, saved_project,
):
    body = project(width, height)
    # Old/imported projects remain editable; exporting them must be blocked.
    assert normalize_project_body(body)["output"]["width"] == width
    projects = SimpleNamespace(get=AsyncMock(return_value={"body": body}))
    exports = SimpleNamespace(create=AsyncMock())
    snapshots = SimpleNamespace(create=AsyncMock())
    monkeypatch.setattr(export_api, "_services", lambda: SimpleNamespace(
        projects=projects, exports=exports, snapshots=snapshots))
    monkeypatch.setattr(export_api, "get_montage_db", lambda: SimpleNamespace())
    monkeypatch.setattr(export_api, "export_jobs", {})
    resolve_ffmpeg = Mock(side_effect=AssertionError("invalid size must not reach FFmpeg"))
    monkeypatch.setattr(export_executor, "resolve_ffmpeg_binary", resolve_ffmpeg)
    app = FastAPI(); app.include_router(export_api.router)
    request = {"output_path": "out.mp4", "body": body}
    if saved_project:
        # The saved project is authoritative even if the request claims a valid size.
        request.update(project_id=7, body=project(1920, 1080))
    response = TestClient(app).post("/api/lite-cut" + endpoint, json=request)
    assert response.status_code == 422
    assert response.json()["detail"] == {
        "code": "LITECUT_EXPORT_RESOLUTION_INVALID", "params": {"width": width, "height": height},
    }
    resolve_ffmpeg.assert_not_called()
    exports.create.assert_not_awaited()
    snapshots.create.assert_not_awaited()
    assert not export_api.export_jobs


@pytest.mark.parametrize("width,height", [(1154, 900), (1156, 900), (1920, 1080), (1080, 1920)])
def test_even_dimensions_reach_export_preflight(monkeypatch, width, height):
    body = project(width, height)
    plan = build_lite_cut_export_plan(body)
    assert (plan.output_width, plan.output_height) == (width, height)
    monkeypatch.setattr(export_executor, "load_config", lambda: SimpleNamespace(
        ffmpeg_path="ffmpeg.exe", montage_encoder="auto"))
    monkeypatch.setattr(export_executor, "resolve_ffmpeg_binary", lambda _: Path("ffmpeg.exe"))
    monkeypatch.setattr(export_executor, "unique_output_path", lambda *a, **k: Path("out.mp4"))
    runnable = Mock()
    monkeypatch.setattr(export_executor, "ensure_ffmpeg_runnable", runnable)
    monkeypatch.setattr(export_executor, "ensure_files_readable", lambda _: 10)
    monkeypatch.setattr(export_executor, "ensure_lite_cut_audio_command_length", lambda **kwargs: None)
    monkeypatch.setattr(export_executor, "ensure_output_space", lambda *args: None)
    prepared = asyncio.run(export_executor.prepare_export(
        export_api.LiteCutExportBody(body=body, output_path="out.mp4"),
        projects=None, montage_db=None, active_jobs={}, resolve_encoder=lambda *args: "auto"))
    runnable.assert_called_once()
    assert prepared["project_body"]["output"]["width"] == width
    assert prepared["project_body"]["output"]["height"] == height


def test_direct_render_plan_cannot_bypass_resolution_validation():
    with pytest.raises(MontageComposerError) as error:
        build_lite_cut_export_plan(project(1155, 900))
    assert error.value.code == "LITECUT_EXPORT_RESOLUTION_INVALID"
