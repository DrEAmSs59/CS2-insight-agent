from app.features.cs_data_radar.export_plan import flatten_export_timeline, used_candidate_keys
from app.features.cs_data_radar.timeline import make_radar_timeline_id


def test_flatten_keeps_radar_when_enabled_and_drops_when_disabled():
    radar_id = make_radar_timeline_id("r1")
    items = {
        radar_id: {"candidate_key": "mirage::sid:111", "duration": 6},
    }
    baked = {"mirage::sid:111": r"C:\tmp\radar.mp4"}
    enabled = flatten_export_timeline(
        [10, radar_id, 11],
        radar_enabled=True,
        radar_items=items,
        baked_videos=baked,
    )
    assert [s["kind"] for s in enabled] == ["clip", "radar", "clip"]
    assert enabled[1]["video_path"].endswith("radar.mp4")
    assert enabled[1]["duration"] == 6
    assert enabled[1]["duration_mode"] == "pad"
    assert used_candidate_keys(enabled) == ["mirage::sid:111"]

    disabled = flatten_export_timeline(
        [10, radar_id, 11],
        radar_enabled=False,
        radar_items=items,
        baked_videos=baked,
    )
    assert [s["kind"] for s in disabled] == ["clip", "clip"]
    assert used_candidate_keys(disabled) == []
