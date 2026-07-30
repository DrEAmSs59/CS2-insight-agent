from types import SimpleNamespace

from app.recording.executor.kill_markers import (
    KillMarkerTimeline,
    enrich_markers_with_events,
)


TICK_RATE = 64.0


def _segment(
    *,
    index: int = 0,
    start_tick: int = 1000,
    end_tick: int = 1640,
    anchors: list[int] | None = None,
    source_type: str = "kill",
    perspective: str = "killer",
    round_number: int | None = 5,
    metadata: dict | None = None,
):
    return SimpleNamespace(
        segment_index=index,
        start_tick=start_tick,
        end_tick=end_tick,
        anchor_ticks=anchors if anchors is not None else [1192],
        source_type=source_type,
        perspective=perspective,
        round=round_number,
        metadata=metadata or {},
    )


def test_anchor_maps_to_offset_from_segment_start():
    timeline = KillMarkerTimeline(TICK_RATE)
    # Anchor sits 192 ticks (3 s at 64 tick/s) after start_tick.
    timeline.open_segment(_segment(anchors=[1192]))
    timeline.close_segment(10.0)

    (marker,) = timeline.markers
    assert marker["video_sec"] == 3.0
    assert marker["tick"] == 1192
    assert marker["kind"] == "kill"
    assert marker["perspective"] == "killer"
    assert marker["round"] == 5
    assert marker["segment_index"] == 0


def test_later_segments_are_offset_by_previously_recorded_length():
    """Jump-cut recording concatenates segments into one file."""
    timeline = KillMarkerTimeline(TICK_RATE)
    timeline.open_segment(_segment(index=0, anchors=[1192]))
    timeline.close_segment(8.0)
    timeline.open_segment(_segment(index=1, start_tick=5000, anchors=[5128]))
    timeline.close_segment(6.0)

    first, second = timeline.markers
    assert first["video_sec"] == 3.0
    # 8 s of segment 0 in the file + 2 s into segment 1.
    assert second["video_sec"] == 10.0


def test_spec_overhead_shifts_anchor_earlier_in_the_file():
    """Prepare work that overruns the pre-roll eats into the recording window."""
    timeline = KillMarkerTimeline(TICK_RATE)
    timeline.open_segment(_segment(anchors=[1192]), overhead_sec=1.25)
    timeline.close_segment(10.0)

    (marker,) = timeline.markers
    assert marker["video_sec"] == 1.75


def test_lead_in_shifts_anchor_later_in_the_file():
    """The frozen frame between ResumeRecord and demo resume is in the file."""
    timeline = KillMarkerTimeline(TICK_RATE)
    timeline.open_segment(_segment(anchors=[1192]), lead_in_sec=0.4)
    timeline.close_segment(10.0)

    (marker,) = timeline.markers
    assert marker["video_sec"] == 3.4


def test_anchor_past_the_recorded_window_is_dropped():
    """A round segment stopped early by GSI never captured its late anchors."""
    timeline = KillMarkerTimeline(TICK_RATE)
    timeline.open_segment(_segment(anchors=[1192, 1960]))
    timeline.close_segment(5.0)

    assert [m["tick"] for m in timeline.markers] == [1192]


def test_discarded_segment_contributes_nothing_and_does_not_advance_time():
    timeline = KillMarkerTimeline(TICK_RATE)
    timeline.open_segment(_segment(index=0, anchors=[1192]))
    timeline.discard_segment()
    timeline.open_segment(_segment(index=1, start_tick=5000, anchors=[5128]))
    timeline.close_segment(6.0)

    (marker,) = timeline.markers
    assert marker["video_sec"] == 2.0
    assert timeline.accumulated_sec == 6.0


def test_segment_closed_without_markers_still_advances_the_file_clock():
    """A blank segment reached the file, so later anchors must not shift earlier."""
    timeline = KillMarkerTimeline(TICK_RATE)
    timeline.open_segment(_segment(index=0, anchors=[1192]))
    timeline.close_segment(4.0, keep_markers=False)
    timeline.open_segment(_segment(index=1, start_tick=5000, anchors=[5128]))
    timeline.close_segment(6.0)

    (marker,) = timeline.markers
    assert marker["video_sec"] == 6.0


def test_death_segment_is_tagged_as_death():
    timeline = KillMarkerTimeline(TICK_RATE)
    timeline.open_segment(
        _segment(anchors=[1192], source_type="death", perspective="main"),
    )
    timeline.close_segment(10.0)

    (marker,) = timeline.markers
    assert marker["kind"] == "death"


def test_kill_track_metadata_enriches_the_marker():
    timeline = KillMarkerTimeline(TICK_RATE)
    timeline.open_segment(_segment(
        anchors=[1192],
        metadata={"kill_track": [{
            "tick": 1192,
            "victim": "enemy1",
            "weapon": "ak47",
            "headshot": True,
            "kill_index": 3,
            "icons": ["one_tap"],
            "banner": "triple",
        }]},
    ))
    timeline.close_segment(10.0)

    (marker,) = timeline.markers
    assert marker["victim"] == "enemy1"
    assert marker["weapon"] == "ak47"
    assert marker["headshot"] is True
    assert marker["icons"] == ["one_tap"]
    assert marker["banner"] == "triple"


def test_zero_tick_rate_yields_no_markers():
    timeline = KillMarkerTimeline(0)
    timeline.open_segment(_segment(anchors=[1192]))
    timeline.close_segment(10.0)

    assert timeline.markers == []


def test_markers_are_sorted_by_video_time():
    timeline = KillMarkerTimeline(TICK_RATE)
    timeline.open_segment(_segment(anchors=[1320, 1192]))
    timeline.close_segment(10.0)

    assert [m["video_sec"] for m in timeline.markers] == [3.0, 5.0]


def test_events_supply_victim_weapon_and_tags():
    event = SimpleNamespace(
        tick=1192,
        victim=SimpleNamespace(name="enemy2"),
        weapon="awp",
        headshot=True,
        tags=["🔭 百步穿杨"],
        round=7,
    )

    (marker,) = enrich_markers_with_events([{"tick": 1192, "video_sec": 3.0}], [event])

    assert marker["victim"] == "enemy2"
    assert marker["weapon"] == "awp"
    assert marker["headshot"] is True
    assert marker["tags"] == ["🔭 百步穿杨"]
    assert marker["round"] == 7


def test_event_enrichment_does_not_override_kill_track_values():
    event = SimpleNamespace(
        tick=1192,
        victim=SimpleNamespace(name="from-event"),
        weapon="glock",
        headshot=False,
        tags=[],
        round=7,
    )
    markers = [{"tick": 1192, "video_sec": 3.0, "victim": "from-track", "weapon": "ak47"}]

    (marker,) = enrich_markers_with_events(markers, [event])

    assert marker["victim"] == "from-track"
    assert marker["weapon"] == "ak47"


def test_event_enrichment_keeps_markers_without_a_matching_event():
    (marker,) = enrich_markers_with_events([{"tick": 999, "video_sec": 1.0}], [])

    assert marker == {"tick": 999, "video_sec": 1.0}


def _highlight_dto():
    from app.recording.models import RecordingRequestDTO

    return RecordingRequestDTO(
        request_id="req-1",
        request_type="highlight",
        source_type="kill",
        demo={
            "demo_path": "C:/demos/match.dem",
            "demo_filename": "match.dem",
            "map_name": "de_mirage",
            "tick_rate": TICK_RATE,
            "first_tick": 0,
            "demo_end_tick": 100000,
            "final_round": 24,
            "final_round_start_tick": 90000,
            "final_round_end_tick": 99000,
        },
        target_player={"name": "me", "steamid64": "7656119"},
        events=[{
            "event_type": "kill",
            "tick": 1192,
            "round": 7,
            "killer": {"name": "me", "steamid64": "7656119"},
            "victim": {"name": "enemy1", "steamid64": "7656120"},
            "target_player": {"name": "me", "steamid64": "7656119"},
            "perspective": "killer",
            "weapon": "ak47",
            "headshot": True,
            "tags": ["💥 颗秒"],
        }],
    )


def test_clip_meta_carries_the_kill_axis_for_the_montage_library():
    """The LiteCut kill axis reads these straight off the recorded_clips row."""
    from app.recording.api import build_v3_recorded_clip_meta

    meta = build_v3_recorded_clip_meta(
        _highlight_dto(),
        None,
        {"kill_markers": [{"video_sec": 3.0, "tick": 1192, "kind": "kill", "perspective": "killer"}]},
    )

    (marker,) = meta["kill_markers"]
    assert marker["video_sec"] == 3.0
    assert marker["victim"] == "enemy1"
    assert marker["weapon"] == "ak47"
    assert marker["headshot"] is True
    assert marker["tags"] == ["💥 颗秒"]


def test_clip_meta_kill_axis_is_empty_when_the_executor_reported_nothing():
    from app.recording.api import build_v3_recorded_clip_meta

    meta = build_v3_recorded_clip_meta(_highlight_dto(), None, {})

    assert meta["kill_markers"] == []
