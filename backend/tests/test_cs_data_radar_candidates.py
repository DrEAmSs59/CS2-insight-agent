import asyncio

import pytest

from app.features.cs_data_radar.candidates import build_candidates_for_clips
from app.features.cs_data_radar.export_bake import RadarBakeError, require_parse_data, resolve_local_portrait


class _DemoDb:
    def __init__(self, players, source="Blast"):
        self.players = players
        self.source = source

    async def get_demo_by_path(self, path):
        return {"path": path, "source": self.source}

    async def get_result(self, path):
        return {"analysis_workspace": {"map_name": "de_mirage", "players": self.players}}


def test_build_candidates_attaches_workspace_stats():
    clips = [
        {
            "demo_path": r"C:\demos\mirage.dem",
            "demo_filename": "mirage.dem",
            "player_name": "s1mple",
            "target_steamid64": "111",
        }
    ]
    out = asyncio.run(build_candidates_for_clips(
        clips,
        demo_db=_DemoDb(
            [{"name": "s1mple", "steam_id64": "111", "kills": 20, "deaths": 10, "assists": 4, "kpr": 0.9, "adr": 101.0, "kast": 70, "survival_rate": 40}]
        ),
    ))
    assert len(out) == 1
    assert out[0]["has_parse_data"] is True
    assert out[0]["radar"]["kpr"] == 0.9
    assert "rating" not in out[0]["radar"]
    assert out[0]["demo_source"] == "Blast"
    assert out[0]["map_name"] == "de_mirage"
    assert out[0]["kda"] == "20 / 10 / 4"
    assert out[0]["match_median"]["kpr"] == 0.9
    assert "rating" not in out[0]["match_median"]

    with_median_rating = asyncio.run(build_candidates_for_clips(
        clips,
        demo_db=_DemoDb(
            [{"name": "s1mple", "steam_id64": "111", "kills": 20, "deaths": 10, "assists": 4, "kpr": 0.9, "adr": 101.0, "kast": 70, "survival_rate": 40}]
        ),
        median_rating_by_key={out[0]["key"]: 1.12},
    ))
    assert with_median_rating[0]["match_avg"]["rating"] == 1.12
    assert with_median_rating[0]["match_median"]["rating"] == 1.12


def test_build_candidates_marks_missing_parse_data():
    clips = [
        {
            "demo_path": r"C:\demos\mirage.dem",
            "demo_filename": "mirage.dem",
            "player_name": "ghost",
            "target_steamid64": "999",
        }
    ]
    out = asyncio.run(build_candidates_for_clips(clips, demo_db=_DemoDb([{"name": "s1mple", "steam_id64": "111"}])))
    assert out[0]["has_parse_data"] is False


def test_require_parse_data_fails_fast():
    with pytest.raises(RadarBakeError) as exc:
        require_parse_data(
            {"k1": {"has_parse_data": False, "player_name": "s1mple"}},
            ["k1"],
        )
    assert exc.value.code == "MONTAGE_RADAR_PARSE_MISSING"
    assert exc.value.params["name"] == "s1mple"


def test_resolve_local_portrait_requires_existing_file(tmp_path):
    missing = tmp_path / "nope.jpg"
    assert resolve_local_portrait({"portrait_path": str(missing)}) is None
    present = tmp_path / "ok.jpg"
    present.write_bytes(b"x")
    assert resolve_local_portrait({"portrait_path": str(present)}) == present


def test_format_map_label():
    from app.features.cs_data_radar.source_assets import format_map_label, infer_map_name

    assert infer_map_name("g161-20260918210211611155033_de_dust2.dem") == "de_dust2"
    assert format_map_label("de_dust2") == "DUST2"
    assert format_map_label("de_inferno") == "INFERNO"
