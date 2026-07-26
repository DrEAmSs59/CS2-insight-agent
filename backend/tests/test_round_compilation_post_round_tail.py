import asyncio

from backend.app.recording.executor import recording_executor as executor_module
from backend.app.recording.models import (
    DemoContext,
    Perspective,
    RecordingRequestDTO,
    RecordingSegment,
    RequestType,
    RoundInfo,
    SourceRef,
    SourceType,
    TargetPlayer,
)
from backend.app.recording.plan_builder import build_plan


TICK_RATE = 64.0
PLAYER = TargetPlayer(name="TestPlayer", steamid64="76561198012345678")


def _request(request_type: RequestType, round_info: RoundInfo) -> RecordingRequestDTO:
    return RecordingRequestDTO(
        request_id="round-tail-test",
        request_type=request_type,
        source_type=SourceType.round,
        demo=DemoContext(
            demo_path="/demo/test.dem",
            demo_filename="test.dem",
            map_name="de_dust2",
            tick_rate=TICK_RATE,
            first_tick=0,
            demo_end_tick=100_000,
            final_round=20,
            final_round_start_tick=90_000,
            final_round_end_tick=99_000,
        ),
        target_player=PLAYER,
        rounds=[round_info],
        source_ref=SourceRef(),
    )


def _round(
    *,
    round_end_tick: int = 30_000,
    next_round_start_tick: int = 30_400,
    target_death_tick: int | None = None,
) -> RoundInfo:
    return RoundInfo(
        round=5,
        round_start_tick=9_000,
        round_end_tick=round_end_tick,
        freeze_end_tick=10_000,
        next_round_start_tick=next_round_start_tick,
        target_death_tick=target_death_tick,
    )


def test_alive_round_compilation_keeps_three_second_result_tail():
    plan = build_plan(_request(RequestType.round_compilation, _round()))

    assert len(plan.segments) == 1
    assert plan.segments[0].end_tick == 30_000 + int(3.0 * TICK_RATE)
    assert plan.segments[0].metadata["end_reason"] == "round_end_post"


def test_alive_round_compilation_tail_stops_before_next_round():
    plan = build_plan(
        _request(
            RequestType.round_compilation,
            _round(next_round_start_tick=30_100),
        )
    )

    assert plan.segments[0].end_tick == 30_100 - int(0.5 * TICK_RATE)
    assert plan.segments[0].metadata["end_reason"] == "round_end_clamped_to_next_round_start"


def test_round_ending_death_keeps_death_post_tail():
    plan = build_plan(
        _request(
            RequestType.round_compilation,
            _round(target_death_tick=30_000),
        )
    )

    assert plan.segments[0].end_tick == 30_000 + int(2.0 * TICK_RATE)
    assert plan.segments[0].metadata["end_reason"] == "target_death_post"


def test_timeline_round_does_not_add_a_second_result_tail():
    plan = build_plan(_request(RequestType.timeline_round, _round()))

    assert plan.segments[0].end_tick == 30_000
    assert plan.segments[0].metadata["end_reason"] == "round_end"


def test_tick_watcher_ignores_round_increment_during_result_phase(monkeypatch):
    phase_calls = 0
    round_calls = 0
    sleep_calls = 0
    clock = 0.0

    def fake_phase():
        nonlocal phase_calls
        phase_calls += 1
        return "live" if phase_calls == 1 else "over"

    def fake_round():
        nonlocal round_calls
        round_calls += 1
        return 5 if round_calls == 1 else 6

    async def fake_sleep(_seconds):
        nonlocal sleep_calls
        sleep_calls += 1

    def fake_monotonic():
        nonlocal clock
        clock += 0.05
        return clock

    monkeypatch.setattr(executor_module, "_get_gsi_round_phase", fake_phase)
    monkeypatch.setattr(executor_module, "_get_gsi_current_round", fake_round)
    monkeypatch.setattr(executor_module.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(executor_module.time, "monotonic", fake_monotonic)

    segment = RecordingSegment(
        segment_index=0,
        source_type=SourceType.round,
        start_tick=0,
        end_tick=10,
        round=5,
        target_player_name=PLAYER.name,
        target_steamid64=PLAYER.steamid64,
        perspective=Perspective.round,
        safe_seek_tick=0,
        metadata={
            "target_death_tick": None,
            "next_round_start_tick": 100,
        },
    )

    result = asyncio.run(
        executor_module._record_until_tick_round_segment(
            segment,
            tick_rate=10.0,
            abort_event=None,
            warnings=[],
        )
    )

    assert result == "done"
    assert sleep_calls > 2
