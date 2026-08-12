from app.features.lite_cut.export_plan import build_lite_cut_export_plan
from app.features.lite_cut.graph_builders import (
    build_audio_mix_graph,
    build_clip_video_filter_chain,
    build_overlay_graph,
)
from app.features.lite_cut.filter_graphs import (
    _audio_mix_filter_complex,
    _clip_video_filter_chain,
    _overlay_filter_complex,
)
from app.features.lite_cut.timeline import (
    _all_overlay_clips_for_export,
    _audio_track_clips_for_export,
    _base_video_track_for_export,
    _recorded_source_ids_for_export,
)
from app.features.lite_cut.transition_events import project_events_to_render_nodes


def _project():
    return {
        "schema_version": 3,
        "output": {
            "width": 1280,
            "height": 720,
            "fps": 60,
            "encoder_tier": "fast",
            "canvas_fit": "blur",
            "background_color": "#123456",
            "blur_amount": 18,
            "range_mode": "custom",
            "range_start_sec": 1,
            "range_end_sec": 5,
            "framemeld_enabled": True,
        },
        "audio": {"master_volume": 0.8},
        "tracks": [
            {
                "id": "v2",
                "type": "video",
                "clips": [{"id": "layer", "source_type": "file", "file_path": "layer.webm", "timeline_start": 0, "trim_in": 0, "trim_out": 3}],
            },
            {
                "id": "v1",
                "type": "video",
                "clips": [
                    {"id": "one", "source_type": "recorded_clip", "source_id": 4, "timeline_start": 0, "trim_in": 0, "trim_out": 2},
                    {"id": "two", "source_type": "file", "file_path": "two.mp4", "timeline_start": 2, "trim_in": 0, "trim_out": 4},
                ],
            },
            {
                "id": "a1",
                "type": "audio",
                "clips": [{"id": "sound", "source_type": "file", "file_path": "sound.wav", "timeline_start": 0, "trim_in": 0, "trim_out": 4}],
            },
        ],
        "overlays": [{"id": "title", "type": "text", "timeline_start": 0, "duration": 2, "text": {"content": "Hello"}}],
        "transitions": [{"id": "edge", "type": "fade", "duration_sec": 0.3, "from": {"kind": "clip", "track_id": "v1", "id": "one"}, "to": {"kind": "clip", "track_id": "v1", "id": "two"}}],
    }


def test_export_plan_matches_projection_helpers():
    body = _project()
    plan = build_lite_cut_export_plan(body, {"width": 1920, "height": 1080, "fps": 30})
    projected = project_events_to_render_nodes(body)
    base_track_id, base_clips = _base_video_track_for_export(projected)
    expected_layers = _all_overlay_clips_for_export(projected, base_track_id=base_track_id)
    expected_audio = list(_audio_track_clips_for_export(projected))

    assert plan.base_track_id == base_track_id
    assert list(plan.base_clips) == base_clips
    assert list(plan.video_layers) == expected_layers
    assert list(plan.audio_events) == expected_audio
    assert plan.transitions == {"0": {"id": "edge", "type": "fade", "duration": 0.3, "alignment": "center"}}
    assert plan.transition_layers == ()
    assert list(plan.recorded_source_ids) == _recorded_source_ids_for_export(body)
    assert (plan.output_width, plan.output_height, plan.output_fps) == (1280, 720, 60)
    assert (plan.canvas_fit, plan.canvas_color, plan.canvas_blur_amount) == ("blur", "0x123456", 18)
    assert (plan.range_start_sec, plan.range_end_sec) == (1, 5)
    assert plan.master_volume == 0.8
    assert plan.encoder_tier == "fast"
    assert plan.framemeld_enabled is True


def test_graph_builder_public_boundary_uses_concern_specific_owners_and_facade_aliases():
    assert build_clip_video_filter_chain is _clip_video_filter_chain
    assert build_overlay_graph is _overlay_filter_complex
    assert build_audio_mix_graph is _audio_mix_filter_complex
    assert build_clip_video_filter_chain.__module__.endswith(".graph_clip")
    assert build_overlay_graph.__module__.endswith(".graph_overlay")
    assert build_audio_mix_graph.__module__.endswith(".graph_audio")


def test_cross_track_event_projects_the_base_endpoint_without_becoming_a_base_xfade():
    body = _project()
    body["transitions"] = [{
        "id": "cross",
        "type": "fade",
        "duration_sec": 1,
        "from": {"kind": "clip", "track_id": "v1", "id": "one"},
        "to": {"kind": "clip", "track_id": "v2", "id": "layer"},
    }]
    body["tracks"][0]["clips"][0]["timeline_start"] = 2
    plan = build_lite_cut_export_plan(body)

    assert plan.transitions == {}
    assert len(plan.transition_layers) == 1
    projection = plan.transition_layers[0]
    assert projection["source_id"] == 4
    assert projection["_transition_projection_only"] is True
    assert projection["_transition_events"] == [{
        "id": "cross",
        "type": "fade",
        "role": "from",
        "mode": "boundary",
        "duration_sec": 1.0,
        "start_sec": 1.5,
        "end_sec": 2.5,
        "cut_sec": 2.0,
        "stack": "lower",
    }]
