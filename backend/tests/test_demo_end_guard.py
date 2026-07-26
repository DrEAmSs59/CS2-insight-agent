from app.recording.models import (
    DemoContext,
    EventInfo,
    EventType,
    Perspective,
    RecordingOptions,
    RecordingRequestDTO,
    RecordingSegment,
    RequestType,
    SourceRef,
    SourceType,
    TargetPlayer,
)
from app.recording.normalizer import NormalizedRequest, normalize
from app.recording.postprocess.demo_end_guard import apply_demo_end_guard
from app.round_timeline import _timeline_round_record_end_tick


TICK_RATE = 64.0


def _request(*, demo_end_tick: int = 20_000, guard_sec: float = 1.5) -> NormalizedRequest:
    return NormalizedRequest(
        request_id="demo-end-guard",
        request_type=RequestType.highlight,
        source_type=SourceType.kill,
        demo=DemoContext(
            demo_path="/demo/test.dem",
            demo_filename="test.dem",
            map_name="de_nuke",
            tick_rate=TICK_RATE,
            first_tick=0,
            demo_end_tick=demo_end_tick,
            final_round=20,
            final_round_start_tick=15_000,
            final_round_end_tick=18_000,
        ),
        target_player=TargetPlayer(name="Player", steamid64="1"),
        events=[],
        rounds=[],
        options=RecordingOptions(demo_end_guard_sec=guard_sec),
        source_ref=SourceRef(),
        warnings=[],
    )


def _segment(*, end_tick: int, anchor_ticks: list[int] | None = None) -> RecordingSegment:
    return RecordingSegment(
        segment_index=0,
        source_type=SourceType.kill,
        start_tick=19_000,
        end_tick=end_tick,
        anchor_ticks=anchor_ticks or [],
        round=20,
        target_player_name="Player",
        target_steamid64="1",
        perspective=Perspective.killer,
        is_final_round=True,
        safe_seek_tick=19_000,
    )


def test_demo_end_guard_is_the_only_terminal_cap_and_does_not_rewind_seek():
    segment, warnings = apply_demo_end_guard(
        _segment(end_tick=19_950, anchor_ticks=[19_100]),
        _request(),
    )

    assert warnings == []
    assert segment.end_tick == 20_000 - int(1.5 * TICK_RATE)
    assert segment.safe_seek_tick == segment.start_tick
    assert segment.disabled is False


def test_demo_end_guard_does_not_change_segment_well_before_eof():
    segment, warnings = apply_demo_end_guard(
        _segment(end_tick=19_500, anchor_ticks=[19_100]),
        _request(),
    )

    assert warnings == []
    assert segment.end_tick == 19_500
    assert segment.disabled is False


def test_demo_end_guard_disables_anchor_inside_eof_margin():
    segment, warnings = apply_demo_end_guard(
        _segment(end_tick=19_999, anchor_ticks=[19_950]),
        _request(),
    )

    assert segment.disabled is True
    assert segment.disabled_reason == "anchor_too_close_to_demo_end"
    assert any("anchor_too_close_to_demo_end" in warning for warning in warnings)


def test_final_round_timeline_uses_normal_result_tail_without_panel_ceiling():
    result = _timeline_round_record_end_tick(
        rn=20,
        raw_round_end=19_990,
        tick_rate=TICK_RATE,
        round_freeze_end_ticks={20: 15_000},
        evs=[{"type": "kill", "tick": 19_936}],
    )

    assert result == 19_990 + int(3.0 * TICK_RATE)


def test_normalizer_replaces_stale_request_end_with_real_demo_eof(tmp_path, monkeypatch):
    demo_path = tmp_path / "source.dem"
    demo_path.write_bytes(b"placeholder")
    monkeypatch.setattr(
        "app.recording.normalizer.read_demo_end_tick",
        lambda _path: 25_000,
    )
    base = _request(demo_end_tick=19_000)
    player = base.target_player
    dto = RecordingRequestDTO(
        request_id=base.request_id,
        request_type=base.request_type,
        source_type=base.source_type,
        demo=base.demo.model_copy(update={"demo_path": str(demo_path)}),
        target_player=player,
        events=[EventInfo(
            event_type=EventType.kill,
            tick=10_000,
            round=10,
            killer=player,
            victim=TargetPlayer(name="Victim", steamid64="2"),
            target_player=player,
            perspective=Perspective.killer,
        )],
        options=base.options,
    )

    normalized = normalize(dto)

    assert normalized.demo.demo_end_tick == 25_000
