from app.features.lite_cut.export_projection import (
    project_canvas_settings,
    project_encoder_tier,
    project_export_range,
    project_master_volume,
    project_output_settings,
)
from app.features.lite_cut.timeline_selectors import (
    clip_by_id,
    has_solo_audio_tracks,
    project_clips,
    track_by_id,
    visible_video_tracks,
)


def test_timeline_selectors_have_no_path_or_process_side_effects():
    body = {
        "tracks": [
            {"id": "hidden", "type": "video", "hidden": True, "clips": [{"id": "hidden-clip"}]},
            {"id": "v1", "type": "video", "clips": [{"id": "clip-a"}]},
            {"id": "a1", "type": "audio", "solo": True, "clips": [{"id": "audio-a"}]},
        ]
    }
    assert track_by_id(body, "v1")["id"] == "v1"
    assert [clip["id"] for clip in project_clips(body)] == ["hidden-clip", "clip-a", "audio-a"]
    assert clip_by_id(body, "audio-a")[1] == "a1"
    assert [track["id"] for track in visible_video_tracks(body)] == ["v1"]
    assert has_solo_audio_tracks(body) is True


def test_export_projection_preserves_current_clamps_and_defaults():
    body = {
        "output": {
            "width": 1,
            "height": 99999,
            "fps": 1200,
            "encoder_tier": "fast",
            "canvas_fit": "blur",
            "background_color": "#abc",
            "blur_amount": 100,
            "range_mode": "custom",
            "range_start_sec": 2,
            "range_end_sec": 5,
        },
        "audio": {"master_volume": 4},
    }
    assert project_output_settings(body, {"width": 1920, "height": 1080, "fps": 60}) == (320, 4320, 1000.0)
    assert project_encoder_tier(body) == "fast"
    assert project_canvas_settings(body) == ("blur", "0xaabbcc", 80)
    assert project_export_range(body) == (2.0, 5.0)
    assert project_master_volume(body) == 2.0
