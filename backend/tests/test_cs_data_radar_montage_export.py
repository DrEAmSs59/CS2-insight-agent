import asyncio

from app.features.cs_data_radar.export_bake import RadarBakeError
from app.features.cs_data_radar.montage_export import resolve_radar_timeline, validate_radar_parse_data
from app.features.cs_data_radar.timeline import make_radar_timeline_id


def test_resolve_mixed_timeline_flattens_when_enabled():
    radar_id = make_radar_timeline_id("r1")
    plan = resolve_radar_timeline(
        recorded_clip_ids=[10, 11],
        ordered_ids=[10, radar_id, 11],
        radar_items={radar_id: {"candidate_key": "k1", "duration": 4}},
        radar_segments=None,
        radar_enabled=True,
    )
    assert plan["use_new"] is True
    assert [s["kind"] for s in plan["segments"]] == ["clip", "radar", "clip"]
    assert plan["used_keys"] == ["k1"]

    off = resolve_radar_timeline(
        recorded_clip_ids=[10, 11],
        ordered_ids=[10, radar_id, 11],
        radar_items={radar_id: {"candidate_key": "k1", "duration": 4}},
        radar_segments=None,
        radar_enabled=False,
    )
    assert [s["kind"] for s in off["segments"]] == ["clip", "clip"]
    assert off["used_keys"] == []


def test_resolve_migrates_legacy_segments_when_no_timeline_ids():
    plan = resolve_radar_timeline(
        recorded_clip_ids=[10, 11],
        ordered_ids=None,
        radar_items={},
        radar_segments=[{"uid": "u1", "before_clip_id": 11, "candidate_key": "k1", "duration": 4}],
        radar_enabled=True,
    )
    assert plan["use_new"] is True
    assert [s["kind"] for s in plan["segments"]] == ["clip", "radar", "clip"]


class _DemoDb:
    def __init__(self, players):
        self.players = players

    async def get_demo_by_path(self, path):
        return {"path": path}

    async def get_result(self, path):
        return {"analysis_workspace": {"players": self.players}}


def test_validate_orphan_candidate_uses_key_stub():
    key = r"C:\demos\mirage.dem::sid:111"
    out = asyncio.run(
        validate_radar_parse_data(
            clips=[],
            used_keys=[key],
            candidate_state={},
            demo_db=_DemoDb([{"name": "s1mple", "steam_id64": "111", "kpr": 0.8, "adr": 90}]),
            radar_items={"radar:1": {"candidate_key": key, "player_name": "s1mple"}},
        )
    )
    assert out[key]["has_parse_data"] is True
    assert out[key]["radar"]["kpr"] == 0.8


def test_validate_missing_parse_fails_fast():
    import pytest

    key = r"C:\demos\mirage.dem::sid:999"
    with pytest.raises(RadarBakeError) as exc:
        asyncio.run(
            validate_radar_parse_data(
                clips=[],
                used_keys=[key],
                candidate_state={},
                demo_db=_DemoDb([{"name": "s1mple", "steam_id64": "111"}]),
                radar_items={"radar:1": {"candidate_key": key, "player_name": "ghost"}},
            )
        )
    assert exc.value.code == "MONTAGE_RADAR_PARSE_MISSING"
