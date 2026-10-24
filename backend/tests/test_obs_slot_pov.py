"""OBS entity targets, same-controller retries and preparation re-seeks."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.recording.executor import recording_executor as executor
from app.recording.executor.spec_controller import obs_spec_slot
from app.recording.models import RecordingPlan, RecordingSegment, RecordingRequestDTO
from app.recording.plan_builder import build_plan
from app.recording.obs_targets import prepare_obs_plan_targets
from pathlib import Path


def segment():
    return RecordingSegment(
        segment_index=0, source_type="kill", perspective="killer",
        start_tick=1000, end_tick=1192, safe_seek_tick=680,
        target_player_name="target", target_steamid64="76561198416537313",
        target_spec_slot=4,
    )


@pytest.mark.parametrize("filename,server,offset", [
    ("cached.dem", "5EPlay", 1),
    ("cached.dem", "完美世界竞技平台", 1),
    ("cached.dem", "Perfect World", 1),
    ("g123-match.dem", "", 1),
    ("pvp-match.dem", "", 1),
    ("5e-match.dem", "", 1),
    ("perfectworld-match.dem", "", 1),
    ("match.dem", "Valve", 0),
    ("faceit-match.dem", "", 0),
    ("match.dem", "", 0),
])
def test_plans_keep_raw_slots_and_obs_uses_real_controller(filename, server, offset):
    dto = RecordingRequestDTO.model_validate({
        "request_id": "slot", "request_type": "timeline_kill", "source_type": "kill",
        "demo": {"demo_path": "I:/cache/hash.dem", "demo_filename": filename,
                 "server_name": server, "map_name": "de_dust2", "tick_rate": 64,
                 "first_tick": 0, "demo_end_tick": 10000, "final_round": 20,
                 "final_round_start_tick": 9000, "final_round_end_tick": 9900},
        "target_player": {"name": "target", "steamid64": "76561198416537313", "spec_slot": 4},
        "events": [{"event_type": "kill", "tick": 1000, "round": 1,
                    "killer": {"name": "target", "steamid64": "76561198416537313", "spec_slot": 4},
                    "victim": {"name": "victim", "steamid64": "76561198416537314", "spec_slot": 7},
                    "target_player": {"name": "target", "steamid64": "76561198416537313", "spec_slot": 4},
                    "perspective": "killer"}],
    })
    plan = build_plan(dto)
    assert plan.segments
    prepared = prepare_obs_plan_targets([plan], Path(plan.demo_path), resolver=lambda *_: [
        {"slot": 11, "pawn": 2819, "steamid64": "76561198416537313", "seek_tick": 680}
        for _ in plan.segments
    ])[0]
    for item in plan.segments:
        assert item.target_spec_slot == 4
        assert obs_spec_slot(item, plan.demo_path) is None
    restored = RecordingPlan.model_validate_json(prepared.model_dump_json())
    assert restored.segments[0].target_spec_slot == 4


def test_old_saved_plan_must_be_resolved_again_instead_of_guessing_by_filename():
    item = segment()
    item.metadata["obs_spec_slot_offset"] = 1
    assert obs_spec_slot(item, r"I:\cache\g123-test.dem") is None
    assert obs_spec_slot(item, "test.dem") is None
    item.target_spec_slot = None
    assert obs_spec_slot(item, "pvp-test.dem") is None


def test_slot_retry_verifies_and_stops_at_matching_player(monkeypatch):
    select = AsyncMock()
    monkeypatch.setattr(executor, "spec_by_slot", select)
    monkeypatch.setattr(executor, "verify_spec_target", AsyncMock(side_effect=[False, True]))
    result = asyncio.run(executor._spec_by_slot_with_retry(5, "target", "id", [], 0))
    assert result is True
    assert [call.args[0] for call in select.call_args_list] == [5, 5]


@pytest.mark.parametrize("verified", [False, None])
def test_gsi_failure_or_silence_never_changes_to_a_neighbor_or_passes(monkeypatch, verified):
    select = AsyncMock()
    monkeypatch.setattr(executor, "spec_by_slot", select)
    monkeypatch.setattr(executor, "verify_spec_target", AsyncMock(return_value=verified))
    assert asyncio.run(executor._spec_by_slot_with_retry(11, "Lita.", "id", [], 0)) is False
    assert [call.args[0] for call in select.call_args_list] == [11, 11]


@pytest.mark.parametrize("slot,steamid", [(None, "id"), (11, "")])
def test_unresolved_target_is_not_selected_by_name(monkeypatch, slot, steamid):
    select = AsyncMock()
    monkeypatch.setattr(executor, "spec_by_slot", select)
    assert asyncio.run(executor._spec_by_slot_with_retry(slot, "Lita.", steamid, [], 0)) is False
    select.assert_not_called()


@pytest.mark.parametrize("verify_seconds,expected_seeks", [(0.4, [680]), (5.4, [680, 1000])])
@pytest.mark.parametrize("gsi_result", [True, False, None])
def test_executor_uses_real_slot_including_prepare_resync(monkeypatch, verify_seconds, expected_seeks, gsi_result):
    clock = [10.0]
    calls = []
    monkeypatch.setattr(executor, "time", SimpleNamespace(monotonic=lambda: clock[0], time=lambda: clock[0]))

    async def sleep(seconds):
        clock[0] += seconds

    async def select(slot):
        calls.append(("slot", slot))

    async def verify(steamid):
        clock[0] += verify_seconds
        return gsi_result

    async def seek(tick):
        calls.append(("seek", tick))

    controller = SimpleNamespace(start_record_safe=AsyncMock(), stop_record_safe=AsyncMock(return_value="test.mp4"), force_stop_recording=AsyncMock())
    monkeypatch.setattr(executor, "OBSRecordingController", lambda *_: controller)
    monkeypatch.setattr(executor.asyncio, "sleep", sleep)
    monkeypatch.setattr(executor, "spec_by_slot", select)
    monkeypatch.setattr(executor, "gototick", seek)
    monkeypatch.setattr(executor, "verify_spec_target", verify)
    for name in ["demo_resume", "demo_pause", "demo_pause_silent_attempt", "demo_pause_silent_strict", "demo_resume_silent_strict"]:
        monkeypatch.setattr(executor, name, AsyncMock(return_value=True))
    monkeypatch.setattr(executor, "_record_until_tick", AsyncMock(return_value="ok"))
    item = segment()
    item.metadata["obs_spec_slot_offset"] = 1
    item.metadata["obs_controller_slot"] = 11
    plan = RecordingPlan(request_id="slot-test", request_type="highlight", demo_path="hash.dem", tick_rate=64, segments=[item])
    obs = SimpleNamespace(config=None, get_record_directory=lambda: "output", disconnect=Mock())
    result = asyncio.run(executor.RecordingExecutor(obs).execute(plan))
    if gsi_result is not True:
        assert not result.success
        controller.start_record_safe.assert_not_called()
        assert [c[1] for c in calls if c[0] == "slot"] == [11, 11]
        return
    assert result.success, result.error
    assert [c[1] for c in calls if c[0] == "seek"] == expected_seeks
    assert [c[1] for c in calls if c[0] == "slot"] == [11] * len(expected_seeks)
    assert item.target_spec_slot == 4
