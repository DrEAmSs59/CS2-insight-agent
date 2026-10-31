import asyncio
import threading
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
    async def run():
        async with export_executor.prepare_export(
            export_api.LiteCutExportBody(body=body, output_path="out.mp4"),
            projects=None, montage_db=None, active_jobs={}, resolve_encoder=lambda *args: "auto",
        ) as prepared:
            return prepared
    prepared = asyncio.run(run())
    runnable.assert_called_once()
    assert prepared["project_body"]["output"]["width"] == width
    assert prepared["project_body"]["output"]["height"] == height


def test_direct_render_plan_cannot_bypass_resolution_validation():
    with pytest.raises(MontageComposerError) as error:
        build_lite_cut_export_plan(project(1155, 900))
    assert error.value.code == "LITECUT_EXPORT_RESOLUTION_INVALID"


@pytest.mark.parametrize("track_type,hidden,muted,excluded", [
    ("video", True, True, True), ("video", False, False, False),
    ("audio", False, False, False), ("audio", False, True, True),
])
def test_export_only_checks_media_used_by_render_plan(tmp_path, monkeypatch, track_type, hidden, muted, excluded):
    from fastapi import HTTPException
    body = project(1920, 1080)
    media = tmp_path / "video.mp4"
    media.write_bytes(b"media")
    body["tracks"][0]["clips"][0]["file_path"] = str(media)
    body["tracks"].append({"id":"optional", "type":track_type, "hidden":hidden, "muted":muted,
        "clips":[{"id":"unused", "source_type":"file", "file_path":str(tmp_path / ("missing.mp3" if track_type == "audio" else "missing.mp4")), "trim_out":3}]})
    monkeypatch.setattr(export_executor, "load_config", lambda: SimpleNamespace(ffmpeg_path="ffmpeg.exe", montage_encoder="auto"))
    monkeypatch.setattr(export_executor, "resolve_ffmpeg_binary", lambda _: Path("ffmpeg.exe"))
    monkeypatch.setattr(export_executor, "ensure_ffmpeg_runnable", lambda _: None)
    monkeypatch.setattr(export_executor, "ensure_lite_cut_audio_command_length", lambda **kw: None)
    monkeypatch.setattr(export_executor, "ensure_output_space", lambda *args: None)
    async def run():
        async with export_executor.prepare_export(export_api.LiteCutExportBody(body=body, output_path=str(tmp_path / "out.mp4")),
            projects=None, montage_db=None, active_jobs={}, resolve_encoder=lambda *a: "auto") as prepared:
            return prepared
    if excluded:
        assert asyncio.run(run())["project_body"]
    else:
        with pytest.raises(HTTPException) as error:
            asyncio.run(run())
        assert error.value.detail["code"] == "MONTAGE_CLIP_FILE_MISSING"


@pytest.fixture
def export_preflight_stub(monkeypatch):
    monkeypatch.setattr(export_executor, "load_config", lambda: SimpleNamespace(
        ffmpeg_path="ffmpeg.exe", montage_encoder="auto"))
    monkeypatch.setattr(export_executor, "resolve_ffmpeg_binary", lambda _: Path("ffmpeg.exe"))
    monkeypatch.setattr(export_executor, "ensure_ffmpeg_runnable", lambda _: None)
    monkeypatch.setattr(export_executor, "ensure_files_readable", lambda _: 10)
    monkeypatch.setattr(export_executor, "ensure_lite_cut_audio_command_length", lambda **kwargs: None)
    monkeypatch.setattr(export_executor, "ensure_output_space", lambda *args: None)


def test_overlapping_preflights_reserve_distinct_paths(tmp_path, monkeypatch, export_preflight_stub):
    barrier = threading.Barrier(2)
    monkeypatch.setattr(export_executor, "ensure_ffmpeg_runnable", lambda _: barrier.wait(timeout=3))
    async def run():
        ready = asyncio.Event()
        paths = []
        async def request():
            async with export_executor.prepare_export(
                export_api.LiteCutExportBody(body=project(1920, 1080), output_path=str(tmp_path / "result.mp4")),
                projects=None, montage_db=None, active_jobs={}, resolve_encoder=lambda *a: "auto",
            ) as prepared:
                paths.append(prepared["output_path"])
                if len(paths) == 2:
                    ready.set()
                await asyncio.wait_for(ready.wait(), 3)
        await asyncio.gather(request(), request())
        assert {Path(path).name for path in paths} == {"result.mp4", "result (1).mp4"}
        assert not export_executor._reserved_output_paths
    asyncio.run(run())


@pytest.mark.parametrize("background", [False, True])
def test_failed_registration_releases_reservation(tmp_path, monkeypatch, export_preflight_stub, background):
    services = SimpleNamespace(exports=SimpleNamespace(create=AsyncMock(side_effect=OSError("db failed"))))
    monkeypatch.setattr(export_api, "_services", lambda: services)
    monkeypatch.setattr(export_api, "get_montage_db", lambda: None)
    monkeypatch.setattr(export_api, "export_jobs", {})
    services.projects = None
    body = export_api.LiteCutExportBody(body=project(1920, 1080), output_path=str(tmp_path / "result.mp4"))
    async def run():
        with pytest.raises(OSError, match="db failed"):
            await (export_api.start_lite_cut_export(body) if background else export_api.lite_cut_export(body))
        assert not export_executor._reserved_output_paths
        async with export_api._prepare_lite_cut_export(body) as prepared:
            assert Path(prepared["output_path"]).name == "result.mp4"
    asyncio.run(run())


def test_failed_render_never_removes_a_published_file(tmp_path, monkeypatch):
    from app.features.lite_cut.runtime import LiteCutExportJob
    target = tmp_path / "result.mp4"
    target.write_bytes(b"already published")
    updates = AsyncMock()
    monkeypatch.setattr(export_api, "_services", lambda: SimpleNamespace(
        exports=SimpleNamespace(update=updates)))
    monkeypatch.setattr(export_api, "execute_prepared_export", AsyncMock(
        side_effect=MontageComposerError("MONTAGE_EXPORT_FAILED")))
    job = LiteCutExportJob(export_id=1, project_id=None, output_path=str(target))
    asyncio.run(export_api._run_lite_cut_export_job_in_session(job, {"output_path": str(target)}))
    assert job.status == "error"
    assert target.read_bytes() == b"already published"
