"""「回合时间线」按阈值合并击杀/死亡镜头：验证后端 timeline_kill/timeline_death
planner 在收到多个事件时按阈值聚为一段连续素材。"""

from __future__ import annotations

import sys
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

from app.recording.models import (  # noqa: E402
    DemoContext,
    EventInfo,
    EventType,
    Perspective,
    RecordingOptions,
    SourceRef,
    SourceType,
    TargetPlayer,
)
from app.recording.normalizer import NormalizedRequest
from app.recording.planners.event_clip_planner import plan_event_clip

TICK_RATE = 64.0
THRESHOLD = 12.0  # 击杀合集阈值默认 12s


def _player(name="Player", steamid64="1", slot=None) -> TargetPlayer:
    return TargetPlayer(name=name, steamid64=steamid64, spec_slot=slot)


def _kill(tick, round_no=1) -> EventInfo:
    return EventInfo(
        event_type=EventType.kill,
        tick=tick,
        round=round_no,
        killer=_player("Player", "1", 3),
        victim=_player("Victim", "2", 4),
        target_player=_player("Player", "1", 3),
        perspective=Perspective.killer,
    )


def _death(tick, round_no=1) -> EventInfo:
    return EventInfo(
        event_type=EventType.death,
        tick=tick,
        round=round_no,
        killer=_player("Enemy", "9", 9),
        victim=_player("Player", "1", 3),
        target_player=_player("Player", "1", 3),
        perspective=Perspective.victim,
    )


def _req(events: list[EventInfo], rt: SourceType = SourceType.kill) -> NormalizedRequest:
    from app.recording.models import RequestType

    return NormalizedRequest(
        request_id="timeline-merge",
        request_type=RequestType.timeline_kill if rt == SourceType.kill else RequestType.timeline_death,
        source_type=rt,
        demo=DemoContext(
            demo_path="/demo/test.dem",
            demo_filename="test.dem",
            map_name="de_nuke",
            tick_rate=TICK_RATE,
            first_tick=0,
            demo_end_tick=20_000,
            final_round=10,
            final_round_start_tick=15_000,
            final_round_end_tick=18_000,
        ),
        target_player=_player(),
        events=events,
        rounds=[],
        options=RecordingOptions(
            timeline_kill_pre_sec=3.0,
            timeline_kill_post_sec=2.0,
            kill_jump_cut_threshold_sec=THRESHOLD,
            fail_killer_pre_sec=3.0,
            fail_killer_post_sec=2.0,
        ),
        source_ref=SourceRef(),
        warnings=[],
    )


def test_timeline_kill_single_event_still_single_segment() -> None:
    req = _req([_kill(10_000)])
    segments = plan_event_clip(req)
    assert len(segments) == 1
    assert segments[0].source_type == SourceType.kill
    assert segments[0].anchor_ticks == [10_000]


def test_timeline_kill_merges_close_kills_into_one_segment() -> None:
    # 400 ticks = 6.25s apart, within the 12s threshold.
    req = _req([_kill(10_000), _kill(10_400)])
    segments = plan_event_clip(req)
    assert len(segments) == 1
    seg = segments[0]
    assert seg.anchor_ticks == [10_000, 10_400]
    # Single continuous take spanning first - pre .. last + post.
    assert seg.start_tick == 10_000 - int(3.0 * TICK_RATE)
    assert seg.end_tick == 10_400 + int(2.0 * TICK_RATE)


def test_timeline_kill_splits_far_events_into_separate_segments() -> None:
    # 2000 ticks = 31.25s apart, beyond the 12s threshold.
    req = _req([_kill(10_000), _kill(12_000)])
    segments = plan_event_clip(req)
    assert len(segments) == 2
    assert segments[0].anchor_ticks == [10_000]
    assert segments[1].anchor_ticks == [12_000]


def test_timeline_kill_merges_kill_then_quick_death_into_one_segment() -> None:
    # 击杀后迅速死亡：kill@10000, death@10100 (1.5625s later) → 一段连续素材。
    req = _req([_kill(10_000), _death(10_100)])
    segments = plan_event_clip(req)
    assert len(segments) == 1
    seg = segments[0]
    assert seg.anchor_ticks == [10_000, 10_100]
    assert seg.start_tick == 10_000 - int(3.0 * TICK_RATE)
    assert seg.end_tick == 10_100 + int(2.0 * TICK_RATE)


def test_timeline_death_single_event_unchanged() -> None:
    req = _req([_death(10_000)], rt=SourceType.death)
    segments = plan_event_clip(req)
    assert len(segments) == 1
    assert segments[0].source_type == SourceType.death
    assert segments[0].anchor_ticks == [10_000]
