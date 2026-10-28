import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import obs_director as obs_director_module
from app.env_utils import OBSConfig
from app.obs_director import OBSDirector
from app.recording.executor import recording_executor as recording_executor_module
from app.demo_voice_hud import (
    RECORDING_CONTROL_PAYLOAD_INDEX,
    VOICE_DATA_BEGIN,
    VOICE_DATA_END,
    VOICE_SCRIPT_PATH,
    build_recording_controller_vpk,
    read_inline_vpk,
)
from app.recording.executor.panorama_control import (
    PanoramaControlBridge,
    PanoramaControlError,
    build_recording_control_payload,
)
from app.recording.models import (
    Perspective,
    RecordingPlan,
    RecordingSegment,
    RequestType,
    SourceType,
)


def _plan(*segments: RecordingSegment) -> RecordingPlan:
    return RecordingPlan(
        request_id="request-1",
        request_type=RequestType.highlight,
        demo_path="demo.dem",
        tick_rate=64.0,
        segments=list(segments),
    )


def _segment(index: int, start: int, end: int) -> RecordingSegment:
    return RecordingSegment(
        segment_index=index,
        source_type=SourceType.kill,
        start_tick=start,
        end_tick=end,
        target_player_name="player",
        target_steamid64="76561198000000000",
        target_spec_slot=7,
        metadata={"obs_controller_slot": 7},
        perspective=Perspective.killer,
        safe_seek_tick=start - 64,
    )


def test_recording_control_payload_flattens_segments_and_assigns_operation_ids():
    first = _segment(0, 100, 200)
    second = _segment(1, 300, 450)

    payload = build_recording_control_payload(
        [_plan(first, second)],
        session_id="abc123",
    )

    assert payload == {
        "session_id": "abc123",
        "segments": [
            {
                "operation_id": "op0",
                "start_tick": 100,
                "end_tick": 200,
                "target_slot": 7,
                "target_xuid": "76561198000000000",
                "spec_mode": 5,
            },
            {
                "operation_id": "op1",
                "start_tick": 300,
                "end_tick": 450,
                "target_slot": 7,
                "target_xuid": "76561198000000000",
                "spec_mode": 5,
            },
        ],
    }
    assert first.metadata["panorama_operation_id"] == "op0"
    assert second.metadata["panorama_operation_id"] == "op1"


def test_recording_control_payload_fails_without_direct_spectator_identity():
    segment = _segment(0, 100, 200).model_copy(update={"metadata": {}})

    with pytest.raises(PanoramaControlError, match="no direct spectator identity"):
        build_recording_control_payload([_plan(segment)], session_id="abc123")


def test_controller_only_vpk_embeds_plan_without_demo_parsing():
    root = Path(__file__).resolve().parents[2]
    build = build_recording_controller_vpk(
        root / "pov" / "pov_advanced_playback_template.vpk",
        recording_control={
            "session_id": "session1",
            "segments": [
                {
                    "operation_id": "op0",
                    "start_tick": 100,
                    "end_tick": 200,
                    "target_slot": 7,
                    "target_xuid": "76561198000000000",
                    "spec_mode": 5,
                }
            ],
        },
        session_console_commands=["bind KP_6 demo_resume", "hud_showtargetid 0"],
    )
    script = read_inline_vpk(build.vpk_bytes)[VOICE_SCRIPT_PATH]
    start = script.index(VOICE_DATA_BEGIN) + len(VOICE_DATA_BEGIN)
    end = script.index(VOICE_DATA_END)
    packed = json.loads(script[start:end].rstrip())

    assert packed[14] == ["bind KP_6 demo_resume", "hud_showtargetid 0"]
    assert packed[RECORDING_CONTROL_PAYLOAD_INDEX] == [
        1,
        "session1",
        [["op0", 100, 200, 7, "76561198000000000", 5]],
        1,
    ]
    assert b"function recordingControlTickInner()" in script
    assert b"mirv_" not in script
    assert b'sessionConsoleCommands.join(";")' in script
    assert b"const SESSION_CONSOLE_COMMAND_PASSES = 1" in script
    assert b"recordingControlGotoTick(recordingControlSeekTick(operation))" in script
    assert b"controller.GotoTick(Math.max(0, Number(tick) | 0))" in script
    assert b'GameInterfaceAPI.ConsoleCommand("spec_player " + operation.targetSlot)' in script


def test_recording_control_rejects_arbitrary_identifiers():
    root = Path(__file__).resolve().parents[2]
    with pytest.raises(Exception, match="unsafe"):
        build_recording_controller_vpk(
            root / "pov" / "pov_advanced_playback_template.vpk",
            recording_control={
                "session_id": "bad;quit",
                "segments": [
                    {
                        "operation_id": "op0",
                        "start_tick": 1,
                        "end_tick": 2,
                    }
                ],
            },
        )


def test_log_bridge_filters_session_and_preserves_early_events(tmp_path: Path):
    log_path = tmp_path / "control.log"
    bridge = PanoramaControlBridge(log_path, "wanted", poll_interval_sec=0.001)
    log_path.write_text(
        "CS2I_RC:other:READY:op0:100:1\n"
        "[Console] CS2I_RC:wanted:READY:op0:100:76561198000000000\n"
        "CS2I_RC:wanted:STARTED:op0:101:76561198000000000\n",
        encoding="utf-8",
    )

    async def run():
        started = await bridge.wait_for(
            "STARTED", operation_id="op0", timeout_sec=0.1
        )
        ready = await bridge.wait_for(
            "READY", operation_id="op0", timeout_sec=0.1
        )
        return ready, started

    ready, started = asyncio.run(run())
    assert ready.tick == 100
    assert started.tick == 101


def test_log_bridge_promotes_controller_error(tmp_path: Path):
    log_path = tmp_path / "control.log"
    log_path.write_text(
        "CS2I_RC:wanted:ERROR:op0:99:76561198000000000\n",
        encoding="utf-8",
    )
    bridge = PanoramaControlBridge(log_path, "wanted", poll_interval_sec=0.001)

    async def run():
        await bridge.wait_for("READY", operation_id="op0", timeout_sec=0.1)

    with pytest.raises(PanoramaControlError, match="failed"):
        asyncio.run(run())


def test_log_bridge_fails_on_session_error_even_with_buffered_ready(tmp_path):
    log_path = tmp_path / "control.log"
    log_path.write_text(
        "CS2I_RC:wanted:READY:op0:100:76561198000000000\n"
        "CS2I_RC:wanted:ERROR:none:100:0\n",
        encoding="utf-8",
    )
    bridge = PanoramaControlBridge(log_path, "wanted")
    with pytest.raises(PanoramaControlError, match="failed at none"):
        asyncio.run(bridge.wait_for("READY", operation_id="op0", timeout_sec=0.1))


@pytest.mark.parametrize("body_receipt", ["ordinary", "valid", "wrong_pawn", "wrong_mode", "missing", "runtime_error", "missing_output"])
def test_executor_advances_two_segments_without_console_seek_or_gsi(monkeypatch, body_receipt):
    calls: list[str] = []
    first = _segment(0, 100, 200)
    second = _segment(1, 300, 450)
    first.metadata["panorama_operation_id"] = "op0"
    second.metadata["panorama_operation_id"] = "op1"
    plan = _plan(first, second)
    if body_receipt != "ordinary":
        for segment in (first, second):
            segment.metadata["obs_body_timeline"] = [{"tick": segment.start_tick, "slot": 7, "pawn": 1625}]

    class FakeBridge:
        async def wait_for(self, event_name, *, operation_id=None, timeout_sec):
            del timeout_sec
            calls.append(f"wait:{event_name}:{operation_id}")
            if body_receipt == "runtime_error" and event_name == "ENDED":
                raise PanoramaControlError("takeover observer mismatch")
            segment = first if operation_id == "op0" else second
            tick = segment.start_tick if event_name in {"READY", "STARTED"} else segment.end_tick
            return type("Event", (), {
                "tick": tick,
                "xuid": segment.target_steamid64 if body_receipt == "ordinary" else "0",
                "observer_pawn": 77 if body_receipt == "wrong_pawn" else None if body_receipt == "missing" else 1625,
                "observer_mode": 3 if body_receipt == "wrong_mode" else 2,
                "received_monotonic": 1.0,
            })()

    class FakeObsClient:
        config = object()

        @staticmethod
        def get_record_directory():
            return "recordings"

    class FakeRecordingController:
        def __init__(self, _config, _obs):
            pass

        async def start_record_safe(self):
            calls.append("obs:start")

        async def pause_record_safe(self):
            calls.append("obs:pause")
            return "paused"

        async def resume_record_safe(self):
            calls.append("obs:resume")

        async def stop_record_safe(self):
            calls.append("obs:stop")
            return None if body_receipt == "missing_output" else "recordings/two-segments.mp4"

        async def force_stop_recording(self):
            calls.append("obs:force-stop")

    async def acknowledge_panorama():
        calls.append("panorama:ack")
        return True

    async def pause_panorama():
        calls.append("panorama:pause")
        return True

    async def forbidden_async(*_args, **_kwargs):
        pytest.fail("legacy console/GSI demo control must not run in Panorama mode")

    def forbidden_sync(*_args, **_kwargs):
        pytest.fail("legacy console/GSI demo control must not run in Panorama mode")

    monkeypatch.setattr(
        recording_executor_module,
        "OBSRecordingController",
        FakeRecordingController,
    )
    monkeypatch.setattr(
        recording_executor_module,
        "demo_resume_silent_strict",
        acknowledge_panorama,
    )
    monkeypatch.setattr(recording_executor_module, "gototick", forbidden_async)
    monkeypatch.setattr(recording_executor_module, "demo_pause_silent_strict", pause_panorama)
    monkeypatch.setattr(recording_executor_module, "spec_by_slot", forbidden_async)
    monkeypatch.setattr(recording_executor_module, "verify_spec_target", forbidden_async)
    monkeypatch.setattr(
        recording_executor_module,
        "inject_console_sequence",
        forbidden_sync,
    )

    result = asyncio.run(
        recording_executor_module.RecordingExecutor(
            FakeObsClient(),
            panorama_control=FakeBridge(),
        ).execute(plan)
    )

    if body_receipt == "runtime_error":
        assert result.success is False
        assert "takeover observer mismatch" in result.error
        assert calls.count("obs:start") == calls.count("obs:stop") == 1
        assert "obs:resume" not in calls
        assert "panorama:pause" in calls
        return
    if body_receipt == "missing_output":
        assert result.success is False
        assert result.output_path is None
        assert "confirmed output path" in result.error
        assert calls.count("obs:stop") == 1
        return
    if body_receipt in {"wrong_pawn", "wrong_mode", "missing"}:
        assert result.success is False
        assert "READY" in result.error
        assert "obs:start" not in calls
        return
    assert result.success is True
    assert result.output_path == "recordings/two-segments.mp4"
    assert [item.status for item in result.segment_results] == ["ok", "ok"]
    assert calls == [
        "wait:READY:op0",
        "obs:start",
        "panorama:ack",
        "wait:STARTED:op0",
        "wait:ENDED:op0",
        "obs:pause",
        "panorama:ack",
        "wait:READY:op1",
        "obs:resume",
        "panorama:ack",
        "wait:STARTED:op1",
        "wait:ENDED:op1",
        "obs:stop",
        "panorama:ack",
    ]


def test_bridge_reads_actual_body_receipt_and_does_not_replace_bot_xuid(tmp_path):
    path = tmp_path / "body.log"
    path.write_text("CS2I_RC:wanted:READY:op0:1000:0:body:1625:2\n", encoding="utf-8")
    bridge = PanoramaControlBridge(path, "wanted")
    event = asyncio.run(bridge.wait_for("READY", operation_id="op0", timeout_sec=0.1))
    assert (event.xuid, event.observer_pawn, event.observer_mode) == ("0", 1625, 2)


def test_takeover_cannot_fall_back_to_the_legacy_executor(monkeypatch):
    monkeypatch.setattr(recording_executor_module, "OBSRecordingController", lambda *_: object())
    segment = _segment(0, 100, 200)
    segment.metadata["obs_body_timeline"] = [{"tick": 100, "slot": 7, "pawn": 1625}]
    result = asyncio.run(recording_executor_module.RecordingExecutor(
        SimpleNamespace(config=object())).execute(_plan(segment)))
    assert not result.success
    assert "Panorama" in result.error


def test_panorama_launch_keeps_console_and_gsi_fallback(monkeypatch, tmp_path):
    game_root = tmp_path / "game"
    cs2_path = game_root / "bin" / "win64" / "cs2.exe"
    csgo_dir = game_root / "csgo"
    cs2_path.parent.mkdir(parents=True)
    csgo_dir.mkdir(parents=True)
    cs2_path.write_bytes(b"MZ")
    demo_path = tmp_path / "source.dem"
    demo_path.write_bytes(b"demo")
    launches: list[tuple[list[str], dict]] = []
    launched_pids: list[int] = []
    process = SimpleNamespace(pid=12345)
    monkeypatch.setattr(obs_director_module, "mark_runtime_cs2_launched", launched_pids.append)

    director = OBSDirector(OBSConfig(), str(cs2_path))
    monkeypatch.setattr(obs_director_module, "is_cs2_running", lambda: False)
    monkeypatch.setattr(obs_director_module, "cleanup_stale_gsi_configs", lambda _path: [])
    reset_calls: list[bool] = []
    monkeypatch.setattr(obs_director_module, "reset_gsi_ready", lambda: reset_calls.append(True))
    monkeypatch.setattr(
        obs_director_module,
        "gsi_config_path",
        lambda path: path / "gamestate_integration_cs2_insight.cfg",
    )
    monkeypatch.setattr(director, "_snapshot_user_configs", lambda: None)
    monkeypatch.setattr(director, "_cleanup_cs2_artifacts", lambda: None)
    monkeypatch.setattr(director, "_clear_voice_ban_files", lambda: None)
    monkeypatch.setattr(
        obs_director_module.subprocess,
        "Popen",
        lambda argv, **kwargs: launches.append((list(argv), kwargs)) or process,
    )

    director._launch_cs2(
        demo_path,
        control_log_filename="_insight_control_session1.log",
    )

    assert len(launches) == 1
    assert launched_pids == [process.pid]
    argv, launch_kwargs = launches[0]
    assert "-console" in argv
    assert argv[-2] == "+exec"
    assert launch_kwargs["cwd"] == str(game_root)
    cfg_text = director._copied_cfg.read_text(encoding="ascii")
    assert argv[argv.index("-con_logfile") + 1] == str(csgo_dir / "_insight_control_session1.log")
    assert "con_logfile" not in cfg_text
    assert cfg_text.count("playdemo ") == 1
    assert reset_calls == [True]
    assert list((csgo_dir / "cfg").glob("gamestate_integration*.cfg"))
