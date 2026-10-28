import asyncio

from app.montage_db import MontageDB


def test_restart_recovers_active_exports_and_preserves_completed_outputs(tmp_path):
    async def run():
        db = MontageDB(tmp_path / "db.sqlite")
        await db.init_tables()
        video = tmp_path / "result.mp4"
        video.write_bytes(b"completed video")
        ids = {}
        for status in ("queued", "running", "cancelling", "done", "cancelled"):
            ids[status] = await db.create_export(
                project_id=None, body={"clips": [1]}, status=status, output_path=str(video))
        reopened = MontageDB(db.db_path)
        await reopened.recover_interrupted_exports()
        for status, export_id in ids.items():
            row = await reopened.get_export(export_id)
            assert row["body"] == {"clips": [1]}
            assert row["output_path"] == str(video)
            if status in {"queued", "running", "cancelling"}:
                assert row["status"] == "error"
                assert row["error_msg"] == "MONTAGE_EXPORT_INTERRUPTED"
            else:
                assert row["status"] == status
        assert video.read_bytes() == b"completed video"
    asyncio.run(run())


def test_montage_shutdown_waits_for_cooperative_worker(monkeypatch):
    from app import montage_export_runtime as runtime
    from app.features.lite_cut.job_runtime import JobRegistry
    registry = JobRegistry()
    monkeypatch.setattr(runtime, "_job_registry", registry)
    job = runtime.MontageExportJob(1, None, "out.mp4")
    registry.register("montage_export", 1, job)
    async def run():
        finished = asyncio.Event()
        async def worker():
            await finished.wait()
        job.task = asyncio.create_task(worker())
        assert not await runtime.shutdown_montage_export_jobs(timeout_sec=0)
        assert job.cancel_event.is_set()
        assert not job.task.cancelled()
        finished.set()
        assert await runtime.shutdown_montage_export_jobs(timeout_sec=1)
    asyncio.run(run())


def test_app_exit_waits_for_montage_before_requesting_server_shutdown(monkeypatch, tmp_path):
    from unittest.mock import AsyncMock, Mock
    from app import main, runtime_session, shutdown_state
    from app.features.lite_cut import api as lite_cut_api
    from app.recording import api as recording_api
    from app import montage_export_runtime as runtime
    from app.features.lite_cut.job_runtime import JobRegistry

    registry = JobRegistry()
    monkeypatch.setattr(runtime, "_job_registry", registry)
    shutdown_montage = runtime.shutdown_montage_export_jobs
    monkeypatch.setattr(runtime, "shutdown_montage_export_jobs", lambda timeout_sec: shutdown_montage(0))
    monkeypatch.setattr(runtime_session, "prepare_app_exit", lambda: {"allowed": True})
    monkeypatch.setattr(main, "runtime_session_state", lambda: {"busy": False})
    monkeypatch.setattr(main.application_state, "demo_watcher", None)
    monkeypatch.setattr(lite_cut_api, "shutdown_lite_cut_jobs", AsyncMock(return_value=True))
    monkeypatch.setattr(recording_api, "get_queue_abort_event", lambda: None)
    marker = tmp_path / "recovery.json"
    monkeypatch.setattr(main, "_recovery_marker_path", lambda: marker)
    monkeypatch.setattr(main, "_write_recovery_marker", lambda reason: marker.write_text(reason))
    shutdown_server = Mock()
    monkeypatch.setattr(shutdown_state, "request_server_shutdown", shutdown_server)

    async def run():
        job = runtime.MontageExportJob(1, None, "result.mp4")
        registry.register("montage_export", 1, job)
        finish = asyncio.Event()
        job.task = asyncio.create_task(finish.wait())
        blocked = await main.app_shutdown()
        assert not blocked["safe_to_exit"]
        assert not blocked["jobs_clean"]
        assert job.cancel_event.is_set()
        await asyncio.sleep(0.3)
        shutdown_server.assert_not_called()
        finish.set()
        await job.task
        completed = await main.app_shutdown()
        assert completed["safe_to_exit"] and completed["jobs_clean"]
        assert not marker.exists()
        await asyncio.sleep(0.3)
        shutdown_server.assert_called_once()
    asyncio.run(run())
