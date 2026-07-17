import asyncio
from types import SimpleNamespace

from app import env_utils
from app.env_utils import OBSConfig
from app.obs_director import OBSDirector
from app.recording.executor import obs_recording_controller
from app.recording.executor.recording_executor import RecordingExecutor
from app.recording.models import (
    Perspective,
    RecordingPlan,
    RecordingSegment,
    RequestType,
    SourceType,
)


def test_abort_before_cs2_launch_runs_final_cleanup_and_returns_aborted(monkeypatch, tmp_path):
    cleanup_calls: list[str] = []

    class FakeFinalController:
        def __init__(self, *_args, **_kwargs):
            pass

        async def force_stop_recording(self):
            cleanup_calls.append("obs")
            return True

    monkeypatch.setattr(
        obs_recording_controller,
        "OBSRecordingController",
        FakeFinalController,
    )
    monkeypatch.setattr(
        env_utils,
        "load_config",
        lambda: SimpleNamespace(kill_fx_enabled=False),
    )

    request = SimpleNamespace(
        request_id="abort-before-launch",
        demo=SimpleNamespace(
            demo_path=str(tmp_path / "not-launched.dem"),
            demo_filename="not-launched.dem",
        ),
        options=SimpleNamespace(
            kb_overlay_enabled=False,
            kill_fx_enabled=False,
        ),
    )

    async def run():
        abort_event = asyncio.Event()
        abort_event.set()
        director = OBSDirector(OBSConfig(), "", abort_event=abort_event)
        monkeypatch.setattr(
            director,
            "_kill_cs2",
            lambda: cleanup_calls.append("cs2_and_config"),
        )
        monkeypatch.setattr(
            director,
            "_cleanup_cs2_artifacts",
            lambda: cleanup_calls.append("artifacts"),
        )
        return await director.execute_plan_queue([request])

    results = asyncio.run(run())

    assert results == [
        {
            "request_id": "abort-before-launch",
            "success": False,
            "error": "aborted",
            "segment_results": [],
            "warnings": [],
        }
    ]
    assert cleanup_calls == ["obs", "cs2_and_config", "artifacts"]


def test_executor_promotes_segment_abort_to_request_result():
    class FakeObsClient:
        config = OBSConfig()

        @staticmethod
        def get_record_directory():
            return None

    plan = RecordingPlan(
        request_id="abort-result",
        request_type=RequestType.highlight,
        demo_path="demo.dem",
        tick_rate=64.0,
        segments=[
            RecordingSegment(
                segment_index=0,
                source_type=SourceType.kill,
                start_tick=100,
                end_tick=200,
                target_player_name="player",
                target_steamid64="76561198000000000",
                perspective=Perspective.killer,
                safe_seek_tick=90,
            )
        ],
    )

    async def run():
        abort_event = asyncio.Event()
        abort_event.set()
        return await RecordingExecutor(FakeObsClient(), abort_event=abort_event).execute(plan)

    result = asyncio.run(run())

    assert result.success is False
    assert result.error == "aborted"
