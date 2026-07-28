from __future__ import annotations

from app.parser.cs2_item_catalog import (
    build_player_skin_loadouts,
    resolve_cs2_item,
    resolve_weapon_model,
    skin_for_player_weapon,
)


def test_catalog_resolves_models_and_exact_finishes():
    assert resolve_weapon_model("M9 Bayonet") == "knife_m9_bayonet"
    assert resolve_weapon_model("5e_match_weapon_knife_butterfly") == "knife_butterfly"

    item = resolve_cs2_item(508, 415)

    assert item is not None
    assert item["model"] == "knife_m9_bayonet"
    assert item["name_en"] == "M9 Bayonet | Doppler"
    assert item["name_zh"] == "M9 刺刀 | 多普勒"
    assert item["alt_name"] == "Ruby"
    assert item["image_url"].startswith("https://cdn.cstrike.app/images/")


def test_player_loadouts_keep_only_unambiguous_weapon_finishes():
    class FakeParser:
        def parse_skins(self):
            return {
                "steamid": ["1", "1", "2", "2"],
                "def_index": [508, 508, 9, 9],
                "paint_index": [415, 415, 51, 344],
                "paint_seed": [80, 80, 1, 2],
                "paint_wear": [0.01, 0.01, 0.02, 0.03],
                "custom_name": ["Ruby", "Ruby", "", ""],
            }

    loadouts = build_player_skin_loadouts(FakeParser())

    assert loadouts["1"]["knife_m9_bayonet"]["paint_index"] == 415
    assert skin_for_player_weapon(loadouts, "1", "M9 Bayonet")["alt_name"] == "Ruby"
    assert "awp" not in loadouts.get("2", {})
