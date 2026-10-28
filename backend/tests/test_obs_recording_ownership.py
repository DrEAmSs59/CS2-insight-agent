import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.env_utils import OBSConfig
from app.recording.executor.obs_client import OBSClient, OBSRecordError
from app.recording.executor.obs_recording_controller import OBSControlError, OBSRecordingController


def client_with_response(status, data):
    client = OBSClient(OBSConfig())
    client._ws = SimpleNamespace(call=lambda _: SimpleNamespace(status=status, datain=data))
    return client


@pytest.mark.parametrize("method", ["start_record", "stop_record", "get_record_status"])
def test_obs_rejected_response_is_not_a_success(method):
    with pytest.raises(OBSRecordError, match="rejected"):
        getattr(client_with_response(False, {}), method)()


def test_existing_recording_is_never_paused_or_stopped(monkeypatch):
    ctrl = OBSRecordingController(OBSConfig(), None)
    monkeypatch.setattr(ctrl, "_fresh_status", AsyncMock(return_value={"outputActive": True}))
    stop = AsyncMock()
    monkeypatch.setattr(ctrl, "_fresh_stop", stop)
    command = Mock(side_effect=AssertionError("must not send an OBS command"))
    monkeypatch.setattr(ctrl, "_new_client", command)
    async def run():
        with pytest.raises(OBSControlError, match="already recording"):
            await ctrl.start_record_safe()
        for operation in (ctrl.pause_record_safe, ctrl.resume_record_safe):
            with pytest.raises(OBSControlError, match="No Insight-owned"):
                await operation()
        assert await ctrl.stop_record_safe() is None
        assert await ctrl.force_stop_recording()
    asyncio.run(run())
    stop.assert_not_called()
    command.assert_not_called()


def test_rejected_start_does_not_claim_an_active_recording(monkeypatch):
    ctrl = OBSRecordingController(OBSConfig(), None)
    # Another client can start after the precheck but before our StartRecord.
    monkeypatch.setattr(ctrl, "_fresh_status", AsyncMock(return_value={"outputActive": False}))
    client = client_with_response(False, {})
    client.connect = lambda: None
    client.disconnect = lambda: None
    monkeypatch.setattr(ctrl, "_new_client", lambda **_: client)
    stop = AsyncMock()
    monkeypatch.setattr(ctrl, "_fresh_stop", stop)
    async def run():
        with pytest.raises(OBSControlError, match="rejected"):
            await ctrl.start_record_safe()
        assert await ctrl.force_stop_recording()
    asyncio.run(run())
    stop.assert_not_called()


def test_accepted_start_remains_owned_when_status_confirmation_fails(monkeypatch):
    ctrl = OBSRecordingController(OBSConfig(), None)
    client = Mock()
    monkeypatch.setattr(ctrl, "_new_client", lambda **_: client)
    monkeypatch.setattr(ctrl, "_fresh_status", AsyncMock(side_effect=[
        {"outputActive": False}, {"outputActive": True},
    ]))
    monkeypatch.setattr(ctrl, "_observe_state", AsyncMock(side_effect=[
        OBSControlError("status timeout"), {"outputActive": False},
    ]))
    stop = AsyncMock(return_value="partial.mp4")
    monkeypatch.setattr(ctrl, "_fresh_stop", stop)
    async def run():
        with pytest.raises(OBSControlError, match="status timeout"):
            await ctrl.start_record_safe()
        # The caller's local started flag was never set, but cleanup must still
        # stop the recording whose StartRecord response was accepted.
        assert await ctrl.force_stop_recording()
    asyncio.run(run())
    client.start_record.assert_called_once()
    stop.assert_awaited_once()


@pytest.mark.parametrize("recovers", [True, False])
def test_stop_confirmation_failure_blocks_cleanup_without_stopping_another_recording(monkeypatch, recovers):
    ctrl = OBSRecordingController(OBSConfig(), None)
    ctrl._owns_recording = True
    stop = AsyncMock(return_value="finished.mp4")
    monkeypatch.setattr(ctrl, "_fresh_stop", stop)
    observe = AsyncMock(side_effect=OBSControlError("status unavailable"))
    monkeypatch.setattr(ctrl, "_observe_state", observe)
    async def run():
        with pytest.raises(OBSControlError, match="status unavailable"):
            await ctrl.stop_record_safe()
        with pytest.raises(OBSControlError, match="stop is not confirmed"):
            await ctrl.start_record_safe()
        if recovers:
            observe.side_effect = None
            observe.return_value = {"outputActive": False}
        assert await ctrl.force_stop_recording() is recovers
        if recovers:
            assert await ctrl.stop_record_safe() == "finished.mp4"
    asyncio.run(run())
    # Retrying confirmation must neither resend StopRecord nor lose its path.
    stop.assert_awaited_once()


def test_stop_waits_for_delayed_output_response(monkeypatch):
    ctrl = OBSRecordingController(OBSConfig(), None)
    started = threading.Event()
    release = threading.Event()
    state = {"outputActive": False}
    client = Mock()
    client.get_record_status.side_effect = lambda: state.copy()
    client.start_record.side_effect = lambda: state.update(outputActive=True)
    def stop():
        state["outputActive"] = False
        started.set()
        assert release.wait(2)
        return "finished.mp4"
    client.stop_record.side_effect = stop
    monkeypatch.setattr(ctrl, "_new_client", lambda **_: client)

    async def run():
        await ctrl.start_record_safe()
        task = asyncio.create_task(ctrl.stop_record_safe())
        try:
            assert await asyncio.to_thread(started.wait, 2)
            assert state["outputActive"] is False
            assert not task.done(), "Stopped state alone must not complete finalization"
        finally:
            release.set()
        assert await task == "finished.mp4"
        assert await ctrl.force_stop_recording()
    asyncio.run(run())
    client.stop_record.assert_called_once()


@pytest.mark.parametrize("missing_path", [True, False])
def test_recording_result_is_failed_when_library_registration_fails(monkeypatch, tmp_path, missing_path):
    from app.recording import api
    from app.recording.models import RecordingRequestDTO
    from app.montage_db import MontageDB

    dto = RecordingRequestDTO.model_validate({
        "request_id": "capture", "request_type": "highlight", "source_type": "kill",
        "demo": {"demo_path": str(tmp_path / "match.dem"), "demo_filename": "match.dem",
                 "map_name": "de_mirage", "tick_rate": 64, "first_tick": 0, "demo_end_tick": 6400,
                 "final_round": 1, "final_round_start_tick": 0, "final_round_end_tick": 6400},
        "target_player": {"name": "player", "steamid64": "76561198000000001"},
    })
    db = MontageDB(tmp_path / "montage.sqlite")
    monkeypatch.setattr(api, "_get_montage_db", lambda: db)
    insert = AsyncMock(side_effect=OSError("database write failed"))
    monkeypatch.setattr(db, "insert_recorded_clip", insert)
    result = {"request_id": "capture", "success": True, "output_path": None if missing_path else "finished.mp4"}
    asyncio.run(api._persist_v3_results([dto], [result]))
    assert result["success"] is False
    assert result["error"]
    if missing_path:
        insert.assert_not_awaited()
    else:
        insert.assert_awaited_once()
        assert result["output_path"] == "finished.mp4"
