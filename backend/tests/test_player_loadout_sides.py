import asyncio
from pathlib import Path

import pytest

from app.api import cosmetics_skin
from app.cosmetics_player_loadout import loadout_originals
from app.cosmetics_skin_plan import validate_player_loadout, CosmeticsSkinPlanError
from test_cosmetics_skin_api import api_env, STEAM_ID


def test_original_reader_accepts_column_lists_and_reads_library_path(tmp_path, monkeypatch):
    import sys
    from types import SimpleNamespace
    from app.cosmetics_player_loadout import read_original_loadout
    from app.features.demo_analysis import cs2_item_catalog

    source = tmp_path / "library.dem"
    source.write_bytes(b"PBDEMS2\0")
    expected = [{"type": "agent", "def_index": 5037}]

    class Parser:
        def __init__(self, path):
            assert path == str(source)

        def parse_event(self, event):
            assert event == "round_start"
            return {"tick": [500, 1000, 500]}

        def parse_ticks(self, fields, *, ticks):
            assert ticks == [628, 1128]
            assert "team_num" in fields
            return {"steamid": [STEAM_ID]}

    def inventory(parser, *, sample_ticks):
        assert parser.parse_ticks([], ticks=sample_ticks) == {"steamid": [STEAM_ID]}
        return {STEAM_ID: expected}

    monkeypatch.setitem(sys.modules, "demoparser2", SimpleNamespace(DemoParser=Parser))
    monkeypatch.setattr(cs2_item_catalog, "build_player_cosmetic_inventory", inventory)
    assert read_original_loadout(source, STEAM_ID) == expected


def test_music_validation_keeps_both_sides_and_legacy_fallback():
    selection = {"music_kit_t": 4, "music_kit_ct": 5, "music_kit": 3}
    assert validate_player_loadout(selection) == selection
    for field in selection:
        for invalid in (True, -1, 65535):
            with pytest.raises(CosmeticsSkinPlanError):
                validate_player_loadout({field: invalid})


def test_originals_never_use_rewritten_inventory_for_legacy_plans():
    replacement = {"type": "musickit", "paint_index": 4, "observed_teams": ["ct", "t"]}
    result = loadout_originals([replacement], {"player_loadout": {"music_kit": 4}})
    assert result["music_kit_ct"] == result["music_kit_t"] == []


def test_save_reopen_reanalysis_and_restore_keep_originals(api_env, monkeypatch):
    client, db = api_env["client"], api_env["db"]
    original = {"type": "musickit", "paint_index": 3, "observed_teams": ["ct", "t"], "name_zh": "原音乐盒"}
    agent = {"type": "agent", "def_index": 5037, "observed_teams": ["ct"], "name_zh": "原CT探员"}
    reads, calls = [], []

    def read(path, steamid):
        reads.append((path, steamid))
        return [original, agent]

    def rewrite(**kw):
        calls.append(kw)
        Path(kw["output_dem"]).write_bytes(b"REWRITTEN")
        return {"ok": True, "player_loadout_applied": True, "succeeded": [], "failed": []}

    monkeypatch.setattr(cosmetics_skin, "read_original_loadout", read)
    monkeypatch.setattr(cosmetics_skin, "run_rewrite_owned_batch", rewrite)
    route = f'/api/demos/{api_env["demo_id"]}/cosmetics/custom-plan'
    selection = {"agent_ct": 4619, "music_kit_ct": 4, "music_kit_t": 5}
    response = client.post(route, json={"steamid": STEAM_ID, "player_loadout": selection})
    assert response.status_code == 200, response.text
    assert response.json()["ok"]
    plan = client.get(route, params={"steamid": STEAM_ID}).json()["plan"]
    assert plan["player_loadout"] == selection
    assert calls[-1]["player_loadout"] == selection
    snapshots = plan["player_loadout_originals"]
    assert snapshots["music_kit_ct"] == snapshots["music_kit_t"] == [original]
    assert snapshots["agent_ct"] == [agent]
    assert reads == [(api_env["original"], STEAM_ID)]
    asyncio.run(db.save_result(str(api_env["original"]), {"analysis_workspace": {"cosmetics": {"players": {STEAM_ID: [dict(original, paint_index=5)]}}}}))
    # Restore T only: CT remains selected, and display provenance stays immutable.
    selection.pop("music_kit_t")
    response = client.post(route, json={"steamid": STEAM_ID, "player_loadout": selection})
    assert response.json()["plan"]["player_loadout_originals"] == snapshots
    assert calls[-1]["player_loadout"] == selection
    assert len(reads) == 1
    assert api_env["original"].read_bytes() == b"ORIGINAL-DEMO"
