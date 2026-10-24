"""Shared Free/Pro round planning contract; no capture or native extension required."""
import asyncio

import pytest
from pydantic import ValidationError

from app.recording.api import create_recording_plan
from app.recording.models import RecordingOptions, RecordingRequestDTO
from app.recording.plan_builder import build_plan


def _request(player="one", steamid="1"):
    return RecordingRequestDTO.model_validate({
        "request_id": "round-preview", "request_type": "round_compilation", "source_type": "round",
        "demo": {"demo_path": "match.dem", "demo_filename": "match.dem", "map_name": "de_dust2",
                 "tick_rate": 64, "demo_end_tick": 30000, "final_round": 3, "first_tick": 0,
                 "final_round_start_tick": 0, "final_round_end_tick": 0},
        "target_player": {"name": player, "steamid64": steamid},
        "rounds": [
            {"round": 1, "round_start_tick": 5000, "freeze_end_tick": 6400,
             "target_death_tick": 12800, "round_end_tick": 14000, "next_round_start_tick": 15000},
            {"round": 2, "round_start_tick": 15000, "freeze_end_tick": 16000,
             "target_death_tick": None, "round_end_tick": 20000, "next_round_start_tick": 20100},
            {"round": 3, "round_start_tick": 21000, "freeze_end_tick": 22000,
             "target_death_tick": None, "round_end_tick": 29950},
        ],
    })


def test_preview_matches_execution_plan_with_death_next_round_and_eof_guards():
    req = _request()
    preview = asyncio.run(create_recording_plan(req))
    execution = build_plan(req)
    windows = [(s.start_tick, s.end_tick) for s in execution.segments]
    assert windows == [(6208, 12928), (15808, 20068), (21808, 29904)]
    assert [(s["start_tick"], s["end_tick"]) for s in preview["active_segments"]] == windows
    assert preview["estimated_duration_sec"] == execution.estimated_duration_sec
    assert preview["summary"]["active_count"] == 3
    assert (windows[0][1] - windows[0][0]) / 64 == 105


def test_separate_players_do_not_share_a_round_plan_target():
    one = asyncio.run(create_recording_plan(_request()))
    req = _request("two", "2")
    req.rounds[0].target_death_tick = 8000
    two = asyncio.run(create_recording_plan(req))
    assert {s["target_steamid64"] for s in one["active_segments"]} == {"1"}
    assert {s["target_steamid64"] for s in two["active_segments"]} == {"2"}
    assert two["estimated_duration_sec"] < one["estimated_duration_sec"]


def test_missing_first_round_start_preserves_exact_freeze_end_planning():
    req = _request()
    req.rounds[0].round_start_tick = None
    preview = asyncio.run(create_recording_plan(req))
    assert preview["active_segments"][0]["start_tick"] == 6208
    assert preview["active_segments"][0]["round_start_tick"] is None


def test_legacy_obs_window_helper_cannot_record_round_compilation():
    from app.obs_director import build_smart_jump_segments
    with pytest.raises(ValueError, match="RecordingRequestDTO"):
        build_smart_jump_segments({"category": "compilation", "compilation_kind": "freeze_to_death",
                                   "fixed_segment_pacing": True, "source_ticks": [[1, 999999]]})


@pytest.mark.parametrize("pre,post,expected", [(5.5, 4.25, (6048, 13072)), (10, 2, (5760, 12928)), (3, 5, (6208, 13120))])
def test_custom_round_timings_are_shared_by_preview_and_execution(pre, post, expected):
    req = _request()
    req.options.round_freeze_preroll_sec = pre
    req.options.round_death_post_sec = post
    execution = build_plan(req)
    preview = asyncio.run(create_recording_plan(req))
    assert (execution.segments[0].start_tick, execution.segments[0].end_tick) == expected
    assert [(s["start_tick"], s["end_tick"]) for s in preview["active_segments"]] == [
        (s.start_tick, s.end_tick) for s in execution.segments
    ]
    # Surviving rounds retain their existing tail and safety caps.
    assert execution.segments[1].end_tick == 20068
    assert execution.segments[2].end_tick == 29904


@pytest.mark.parametrize("boundary", ["round_end", "next_round", "demo_end"])
@pytest.mark.parametrize("delta", [-1, 0, 1])
def test_death_tail_one_tick_before_at_and_after_each_existing_cap(boundary, delta):
    req = _request()
    if boundary == "round_end":
        cap = 14000 + 3 * 64
        req.rounds = [req.rounds[0]]
    elif boundary == "next_round":
        cap = 15000 - 32
        req.rounds = [req.rounds[0]]
        req.rounds[0].round_end_tick = 14800
    else:
        cap = 30000 - 96
        req.rounds = [req.rounds[2]]
        req.rounds[0].target_death_tick = 29000
    req.rounds[0].target_death_tick = cap - 4 * 64
    req.options.round_death_post_sec = (cap - req.rounds[0].target_death_tick + delta) / 64
    req = RecordingRequestDTO.model_validate(req.model_dump())
    assert build_plan(req).segments[0].end_tick == min(cap, cap + delta)


def test_large_preroll_keeps_existing_demo_start_clamp():
    req = _request()
    req.rounds[0].round_start_tick = 0
    req.rounds[0].freeze_end_tick = 320
    req.options.round_freeze_preroll_sec = 10
    assert build_plan(req).segments[0].start_tick == req.demo.first_tick


@pytest.mark.parametrize("field", ["round_freeze_preroll_sec", "round_death_post_sec"])
@pytest.mark.parametrize("value", [-1, float("nan"), float("inf")])
def test_invalid_round_timings_rejected_before_planning(field, value):
    with pytest.raises(ValidationError):
        RecordingOptions.model_validate({field: value})


def test_death_tail_allows_five_seconds_but_not_longer():
    assert RecordingOptions.model_validate({"round_death_post_sec": 5}).round_death_post_sec == 5
    with pytest.raises(ValidationError):
        RecordingOptions.model_validate({"round_death_post_sec": 5.1})


@pytest.mark.parametrize("field,value", [("round_freeze_preroll_sec", 2.9), ("round_freeze_preroll_sec", 10.1), ("round_death_post_sec", 1.9)])
def test_timings_outside_the_displayed_ranges_are_rejected(field, value):
    with pytest.raises(ValidationError):
        RecordingOptions.model_validate({field: value})


@pytest.mark.parametrize("tail", [1, 1.5, 3])
def test_surviving_round_tail_is_configurable_without_changing_death_or_final_round(tail):
    req = _request()
    req.options = RecordingOptions(round_alive_post_sec=tail, round_death_post_sec=5)
    req.rounds[0].target_death_tick = req.rounds[0].round_end_tick
    req.rounds[1].next_round_start_tick = 20500
    req.rounds[2].round_end_tick = 29000
    plan = build_plan(req)
    preview = asyncio.run(create_recording_plan(req))
    assert [s.end_tick for s in plan.segments] == [14192, 20000 + int(tail * 64), 29128]
    assert [s["end_tick"] for s in preview["active_segments"]] == [s.end_tick for s in plan.segments]
    assert preview["estimated_duration_sec"] == plan.estimated_duration_sec


@pytest.mark.parametrize("boundary", ["next_round", "demo_end"])
@pytest.mark.parametrize("delta", [-1, 0, 1])
def test_surviving_round_tail_preserves_next_round_and_demo_guards(boundary, delta):
    req = _request()
    req.rounds = [req.rounds[0]]
    req.rounds[0].target_death_tick = None
    cap = 15000 - 32 if boundary == "next_round" else 30000 - 96
    if boundary == "demo_end":
        req.rounds[0].next_round_start_tick = None
    req.options.round_alive_post_sec = 1.5
    req.rounds[0].round_end_tick = cap - 96 + delta
    assert build_plan(req).segments[0].end_tick == min(cap, cap + delta)


@pytest.mark.parametrize("value", [0, 0.9, 3.1, float("nan"), float("inf")])
def test_surviving_round_tail_must_be_finite_and_between_one_and_three(value):
    with pytest.raises(ValidationError):
        RecordingOptions.model_validate({"round_alive_post_sec": value})


def test_surviving_round_timing_does_not_change_timeline_round():
    req = _request()
    req.request_type = "timeline_round"
    req.rounds = [req.rounds[0]]
    req.rounds[0].target_death_tick = None
    req.options.round_alive_post_sec = 1
    assert build_plan(req).segments[0].end_tick == 14000
