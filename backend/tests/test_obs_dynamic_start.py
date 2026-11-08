from copy import deepcopy
from pathlib import Path

import pytest

from app.recording import obs_targets
from app.recording.executor.panorama_control import build_recording_control_payload
from test_obs_targets import SID, OTHER, row, parser, target, plan, body


@pytest.mark.parametrize("start,first", [(0, 1), (0, 4), (0, 699), (1000, 1200)])
def test_dynamic_start_updates_plan_payload_seek_and_duration(start, first):
    original = plan()
    original.segments[0].start_tick = start
    original.segments[0].safe_seek_tick = max(0, start - 320)
    before = original.model_dump()
    reader = parser([row(first + 1), row(first)])
    result = obs_targets.prepare_obs_plan_targets([original], Path("demo.dem"), resolver=lambda p, ts:
        obs_targets.resolve_obs_targets(p, ts, parser=reader))[0]
    segment = result.segments[0]
    assert segment.start_tick == segment.safe_seek_tick == segment.metadata["obs_prepare_tick"] == first
    assert segment.end_tick == 1300
    assert result.estimated_duration_sec == (1300 - first) / 64
    assert build_recording_control_payload([result], session_id="s")["segments"][0]["start_tick"] == first
    assert original.model_dump() == before
    assert result.warnings
    assert len(reader.parse_ticks.call_args_list) == 3


def test_existing_start_never_scans_or_moves_to_later_body():
    reader = parser([row(680), row(1000), row(1100)])
    result = obs_targets.resolve_obs_targets("demo.dem", [target()], parser=reader)
    assert result[0]["start_tick"] == 1000
    assert result[0]["seek_tick"] == 680
    assert reader.parse_ticks.call_count == 2


def test_dynamic_search_skips_invalid_and_ambiguous_bodies():
    rows = [row(1001, alive=False), row(1002, sid=OTHER),
            row(1003, **{"CCSPlayerController.m_hPlayerPawn": 123}),
            row(1004), row(1004, pawn=3000, sid=OTHER), row(1100), row(1200)]
    request = target()
    before = deepcopy(request)
    result = obs_targets.resolve_obs_targets("demo.dem", [request], parser=parser(rows))[0]
    assert result["start_tick"] == result["seek_tick"] == 1100
    assert request == before


@pytest.mark.parametrize("rows", [[], [row(1300)], [row(1400)], [row(1200, sid=OTHER)]])
def test_no_body_inside_segment_still_fails(rows):
    with pytest.raises(ValueError, match="控制器"):
        obs_targets.resolve_obs_targets("demo.dem", [target()], parser=parser(rows))


@pytest.mark.parametrize("start", [999, 1300, 1400, True, 1100.5])
def test_plan_rejects_invalid_or_out_of_window_resolver_start(start):
    with pytest.raises(ValueError, match="结果无效"):
        obs_targets.prepare_obs_plan_targets([plan()], Path("demo.dem"), resolver=lambda *_: [
            {"slot": 11, "pawn": 2819, "steamid64": SID, "start_tick": start, "seek_tick": 1000}])


def test_optional_posthumous_segment_propagates_adjusted_start():
    original = plan(metadata={"posthumous_kill": True})
    result = obs_targets.prepare_obs_plan_targets([original], Path("demo.dem"), resolver=lambda p, ts:
        obs_targets.resolve_obs_targets(p, ts, parser=parser([row(1150)])))[0]
    assert result.segments[0].start_tick == result.segments[0].safe_seek_tick == 1150
    assert result.estimated_duration_sec == 150 / 64
    assert result.warnings
    assert original.segments[0].start_tick == 1000


@pytest.mark.parametrize("missing_prefix", [False, True])
def test_takeover_dynamic_start_preserves_strict_timeline(missing_prefix):
    bot = row(1150, **{"CCSPlayerController.m_bControllingBot": True})
    report = {"rows": ([] if missing_prefix else [body(680, alive=False)]) + [
        body(1150, pawn=1625, takeover=True), body(1200, pawn=1625, takeover=True, alive=False)]}
    resolved = obs_targets.resolve_obs_targets("demo.dem", [target()],
        parser=parser([row(1000, alive=False)], [bot]), takeover_reader=lambda *_: report)
    assert resolved[0]["start_tick"] == resolved[0]["seek_tick"] == 1150
    assert [(r["tick"], r["pawn"]) for r in resolved[0]["timeline"]] == [(1150, 1625), (1200, 0)]
    result = obs_targets.prepare_obs_plan_targets([plan()], Path("demo.dem"), resolver=lambda *_: resolved)[0]
    assert build_recording_control_payload([result], session_id="s")["segments"][0]["start_tick"] == 1150
    report["rows"][-2]["reverseHandle"] = 123
    with pytest.raises(ValueError, match="控制关系"):
        obs_targets.resolve_obs_targets("demo.dem", [target()],
            parser=parser([row(1000, alive=False)], [bot]), takeover_reader=lambda *_: report)
