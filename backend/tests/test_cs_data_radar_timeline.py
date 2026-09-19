from app.features.cs_data_radar.timeline import (
    ANIMATION_DURATION_SEC,
    candidate_key_from_clip,
    clip_ids_from_timeline,
    coerce_timeline_ids,
    derive_radar_candidates_from_clips,
    export_timeline_ids,
    insert_relative_to,
    is_radar_timeline_id,
    make_radar_timeline_id,
    match_player_stats,
    migrate_radar_segments_into_timeline,
    radar_instance_duration_plan,
)


def test_one_candidate_per_demo_and_pov():
    clips = [
        {
            "id": 1,
            "demo_path": r"C:\demos\mirage.dem",
            "demo_filename": "mirage.dem",
            "player_name": "s1mple",
            "target_steamid64": "111",
        },
        {
            "id": 2,
            "demo_path": r"C:\demos\mirage.dem",
            "demo_filename": "mirage.dem",
            "player_name": "s1mple",
            "target_steamid64": "111",
        },
        {
            "id": 3,
            "demo_path": r"C:\demos\inferno.dem",
            "demo_filename": "inferno.dem",
            "player_name": "s1mple",
            "target_steamid64": "111",
        },
    ]
    candidates = derive_radar_candidates_from_clips(clips)
    assert len(candidates) == 2
    assert candidates[0]["demo_filename"] == "mirage.dem"
    assert candidates[0]["segment_count"] == 2
    assert candidates[1]["demo_filename"] == "inferno.dem"
    assert candidates[0]["key"] != candidates[1]["key"]
    assert candidate_key_from_clip(clips[0]) == candidates[0]["key"]


def test_radar_ids_are_independent_timeline_rows():
    radar_id = make_radar_timeline_id("abc")
    assert is_radar_timeline_id(radar_id)
    assert not is_radar_timeline_id(12)
    assert clip_ids_from_timeline([12, radar_id, 15]) == [12, 15]


def test_insert_before_or_after_any_row():
    radar_id = make_radar_timeline_id("r1")
    assert insert_relative_to([10, 11], radar_id, before_id=11) == [10, radar_id, 11]
    assert insert_relative_to([10, 11], radar_id, after_id=11) == [10, 11, radar_id]


def test_migrate_legacy_before_clip_segments():
    migrated = migrate_radar_segments_into_timeline(
        [10, 11],
        [{"uid": "u1", "before_clip_id": 11, "duration": 6, "player_name": "s1mple", "candidate_key": "k1"}],
    )
    assert migrated["ordered_ids"][0] == 10
    assert is_radar_timeline_id(migrated["ordered_ids"][1])
    assert migrated["ordered_ids"][2] == 11
    item = migrated["radar_items"][migrated["ordered_ids"][1]]
    assert item["duration"] == 6
    assert item["candidate_key"] == "k1"


def test_export_skips_radar_when_disabled():
    radar_id = make_radar_timeline_id("r1")
    ids = [10, radar_id, 11]
    assert export_timeline_ids(ids, radar_enabled=True) == ids
    assert export_timeline_ids(ids, radar_enabled=False) == [10, 11]


def test_duration_plan_pads_or_trims_fixed_animation():
    assert ANIMATION_DURATION_SEC == 4.0
    assert radar_instance_duration_plan(6)["mode"] == "pad"
    assert radar_instance_duration_plan(2)["mode"] == "trim"
    assert radar_instance_duration_plan(4)["mode"] == "exact"


def test_match_player_stats_prefers_steam_id():
    players = [
        {"name": "s1mple", "steam_id64": "111", "adr": 90},
        {"name": "Other", "steam_id64": "222", "adr": 40},
    ]
    assert match_player_stats(players, steamid64="111", name="nope")["adr"] == 90
    assert match_player_stats(players, steamid64=None, name="s1mple")["adr"] == 90
    assert match_player_stats(players, steamid64="999", name="ghost") is None


def test_coerce_timeline_ids_keeps_radar_and_int_clips():
    radar_id = make_radar_timeline_id("abc")
    assert coerce_timeline_ids(["10", radar_id, "0", "nope", 11]) == [10, radar_id, 11]
