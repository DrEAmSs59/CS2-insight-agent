import asyncio
from types import SimpleNamespace

import pytest

from app import env_utils
from app.env_utils import OBSConfig
from app.obs_director import CS2UnexpectedExitError, OBSDirector
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


def test_cs2_exit_monitor_signals_unexpected_exit(monkeypatch):
    async def run():
        abort_event = asyncio.Event()
        director = OBSDirector(OBSConfig(), "", abort_event=abort_event)
        alive_states = iter((True, False))
        monkeypatch.setattr(
            director,
            "_is_managed_cs2_alive",
            lambda: next(alive_states),
        )
        director._cs2_exit_monitor_stop = asyncio.Event()

        await asyncio.wait_for(director._monitor_cs2_exit(poll_interval=0.01), timeout=1.0)

        assert director._cs2_exited_unexpectedly is True
        assert abort_event.is_set() is True
        with pytest.raises(CS2UnexpectedExitError):
            director._check_abort()

    asyncio.run(run())


def test_cs2_exit_monitor_ignores_insight_owned_shutdown(monkeypatch):
    async def run():
        abort_event = asyncio.Event()
        director = OBSDirector(OBSConfig(), "", abort_event=abort_event)
        checks: list[bool] = []
        monkeypatch.setattr(
            director,
            "_is_managed_cs2_alive",
            lambda: checks.append(True) or True,
        )
        director._cs2_exit_monitor_stop = asyncio.Event()
        task = asyncio.create_task(director._monitor_cs2_exit(poll_interval=0.01))

        while not checks:
            await asyncio.sleep(0)
        director._cs2_shutdown_expected = True
        director._cs2_exit_monitor_stop.set()
        await asyncio.wait_for(task, timeout=1.0)

        assert director._cs2_exited_unexpectedly is False
        assert abort_event.is_set() is False

    asyncio.run(run())


def test_unexpected_cs2_exit_runs_recovery_cleanup_and_returns_dedicated_code(
    monkeypatch,
    tmp_path,
):
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
        request_id="unexpected-cs2-exit",
        demo=SimpleNamespace(
            demo_path=str(tmp_path / "unexpected.dem"),
            demo_filename="unexpected.dem",
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
        director._cs2_exited_unexpectedly = True

        def restore_configs():
            cleanup_calls.append("cs2_and_config")
            director._last_player_config_restore_result = {
                "ok": True,
                "restored": 2,
                "failed": [],
                "source": "manifest",
            }

        monkeypatch.setattr(
            director,
            "_kill_cs2",
            restore_configs,
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
            "request_id": "unexpected-cs2-exit",
            "success": False,
            "error": "cs2_exited_unexpectedly",
            "error_code": "RECORDING_CS2_EXITED",
            "segment_results": [],
            "warnings": [],
            "recovery": {
                "player_config_restore_verified": True,
                "player_config_restored": True,
                "pov_enabled": False,
                "pov_restore_verified": True,
                "pov_restored": True,
            },
        }
    ]
    assert cleanup_calls == ["obs", "cs2_and_config", "artifacts"]
