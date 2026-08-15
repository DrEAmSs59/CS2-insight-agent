from __future__ import annotations

import gzip
import json
import struct

from app.features.demo_analysis import cs2_item_catalog as catalog_module

from app.features.demo_analysis.cs2_item_catalog import (
    build_player_cosmetic_inventory,
    build_player_skin_loadouts,
    resolve_cs2_item,
    resolve_cs2_item_by_catalog_id,
    resolve_weapon_model,
    skin_for_player_weapon,
)

STEAM_ID64_INDIVIDUAL_BASE = 76561197960265728


def test_catalog_loader_accepts_packaged_gzip(tmp_path, monkeypatch):
    payload = {"schema_version": 2, "aliases": {}, "bases": {}, "items": {}, "stickers": {}}
    json_path = tmp_path / "catalog.json"
    gzip_path = tmp_path / "catalog.json.gz"
    with gzip.open(gzip_path, "wt", encoding="utf-8") as handle:
        json.dump(payload, handle)
    monkeypatch.setattr(catalog_module, "_CATALOG_PATH", json_path)
    monkeypatch.setattr(catalog_module, "_CATALOG_GZIP_PATH", gzip_path)
    catalog_module.load_cs2_item_catalog.cache_clear()
    try:
        assert catalog_module.load_cs2_item_catalog() == payload
    finally:
        catalog_module.load_cs2_item_catalog.cache_clear()


def account_id(steamid: str) -> int:
    return int(steamid) - STEAM_ID64_INDIVIDUAL_BASE


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


def test_catalog_resolves_exact_finish_by_catalog_id():
    item = resolve_cs2_item_by_catalog_id(1764)

    assert item is not None
    assert item["def"] == 5034
    assert item["paint"] == 10033
    assert item["type"] == "glove"
    assert item["catalog_exact"] is True


def test_catalog_id_resolver_rejects_unknown_or_invalid_ids():
    assert resolve_cs2_item_by_catalog_id(999_999_999) is None
    assert resolve_cs2_item_by_catalog_id("not-an-id") is None
    assert resolve_cs2_item_by_catalog_id(1764.5) is None


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


def test_cosmetic_inventory_uses_owner_rows_and_decodes_raw_wear_bits():
    class FakeParser:
        def parse_skins(self):
            return {
                "steamid": ["76561198000000001", "76561198000000001"],
                "def_index": [508, 508],
                "item_id": [53009600926, 53009600926],
                "paint_index": [415, 415],
                "paint_seed": [80, 80],
                "paint_wear": [1015704674, 1015704674],
                "custom_name": ["全角，测试！", "全角，测试！"],
            }

        def parse_ticks(self, _wanted, *, ticks):
            assert ticks == [10, 20]
            item_id = 53009600926
            return {
                "steamid": ["76561198000000001", "76561198000000001", "76561198000000002"],
                "item_id_high": [item_id >> 32, item_id >> 32, 999 >> 32],
                "item_id_low": [item_id & 0xFFFFFFFF, item_id & 0xFFFFFFFF, 999],
                "active_weapon_original_owner": [
                    "76561198000000001",
                    "76561198000000001",
                    "76561198000000002",
                ],
                "Weapon.m_iAccountID": [
                    account_id("76561198000000001"),
                    account_id("76561198000000001"),
                    account_id("76561198000000002"),
                ],
                "weapon_stickers": [[], [], []],
                "team_num": [2, 3, 2],
                "m_iMusicKitID": [0, 0, 0],
                "m_unMusicID": [0, 0, 0],
            }

    inventory = build_player_cosmetic_inventory(FakeParser(), sample_ticks=[20, 10, 20])

    assert list(inventory) == ["76561198000000001"]
    assert len(inventory["76561198000000001"]) == 1
    item = inventory["76561198000000001"][0]
    assert item["custom_name"] == "全角，测试！"
    assert item["paint_wear"] == 0.016897
    assert item["observed_teams"] == ["t", "ct"]
    assert item["ownership_evidence"] == "demo_skin_table"


def test_entity_snapshot_replaces_stale_skin_table_cosmetics_for_same_asset():
    owner = "76561198000000001"
    item_id = 53009600926

    class FakeParser:
        def parse_skins(self):
            return {
                "steamid": [owner],
                "def_index": [515],
                "item_id": [item_id],
                "paint_index": [0],
                "paint_seed": [0],
                "paint_wear": [0.0],
                "custom_name": ["baseline-proof"],
            }

        def parse_ticks(self, _wanted, *, ticks):
            assert ticks == [42, 84]
            return {
                "steamid": [owner, owner],
                "tick": [42, 84],
                "item_id_high": [item_id >> 32] * 2,
                "item_id_low": [item_id & 0xFFFFFFFF] * 2,
                "Weapon.m_iAccountID": [account_id(owner)] * 2,
                "weapon_stickers": [[], []],
                "item_def_idx": [515, 515],
                "weapon_skin_id": [415, 415],
                "weapon_paint_seed": [602, 602],
                "weapon_float": [0.027376356, 0.027376356],
                "team_num": [2, 2],
            }

    inventory = build_player_cosmetic_inventory(FakeParser(), sample_ticks=[42, 84])
    knife = next(item for item in inventory[owner] if item.get("item_id") == item_id)

    assert knife["def_index"] == 515
    assert knife["paint_index"] == 415
    assert knife["paint_seed"] == 602
    assert knife["paint_wear"] == 0.027376
    assert knife["custom_name"] == "baseline-proof"
    assert knife["ownership_evidence"] == "weapon_account_id"


def test_latest_entity_snapshot_can_explicitly_clear_skin_table_cosmetics():
    owner = "76561198000000001"
    item_id = 53009600926

    class FakeParser:
        def parse_skins(self):
            return {
                "steamid": [owner],
                "def_index": [515],
                "item_id": [item_id],
                "paint_index": [415],
                "paint_seed": [602],
                "paint_wear": [0.027376356],
                "custom_name": [None],
            }

        def parse_ticks(self, _wanted, *, ticks):
            assert ticks == [42, 84]
            return {
                "steamid": [owner, owner],
                "tick": [42, 84],
                "item_id_high": [item_id >> 32] * 2,
                "item_id_low": [item_id & 0xFFFFFFFF] * 2,
                "Weapon.m_iAccountID": [account_id(owner)] * 2,
                "weapon_stickers": [[], []],
                "item_def_idx": [515, 515],
                "weapon_skin_id": [415, 0],
                "weapon_paint_seed": [602, 0],
                "weapon_float": [0.027376356, 0.0],
                "team_num": [2, 2],
            }

    inventory = build_player_cosmetic_inventory(FakeParser(), sample_ticks=[42, 84])
    knife = next(item for item in inventory[owner] if item.get("item_id") == item_id)

    assert knife["paint_index"] == 0
    assert knife["paint_seed"] == 0
    assert knife["paint_wear"] == 0.0


def test_cosmetic_inventory_attaches_only_catalogued_stickers_to_the_exact_owned_asset():
    item_id = 53009600926

    class FakeParser:
        def parse_skins(self):
            return {
                "steamid": ["76561198000000001"],
                "def_index": [7],
                "item_id": [item_id],
                "paint_index": [724],
                "paint_seed": [39],
                "paint_wear": [0.217899],
                "custom_name": [None],
            }

        def parse_ticks(self, _wanted, *, ticks):
            assert ticks == [42]
            return {
                "steamid": ["76561198000000002"],
                "item_id_high": [item_id >> 32],
                "item_id_low": [item_id & 0xFFFFFFFF],
                "active_weapon_original_owner": ["76561198000000001"],
                "Weapon.m_iAccountID": [account_id("76561198000000001")],
                "weapon_stickers": [[
                    {"id": 37, "name": "std_crown_foil", "wear": 0.01},
                    {"id": 99999999, "name": "unknown", "wear": 0.0},
                ]],
                "team_num": [2],
                "m_iMusicKitID": [0],
                "m_unMusicID": [0],
            }

    inventory = build_player_cosmetic_inventory(FakeParser(), sample_ticks=[42])

    item = inventory["76561198000000001"][0]
    assert item["observed_teams"] == []  # Picked up by another player, not equipped by owner.
    assert item["stickers"] == [{
        "catalog_id": 1880,
        "def_index": 1209,
        "paint_index": 37,
        "type": "sticker",
        "name_en": "Sticker | Crown (Foil)",
        "name_zh": "印花 | 皇冠（闪亮）",
        "image_url": "https://cdn.cstrike.app/images/crown_foil_a4ad4557.webp",
        "rarity": "#d32ce6",
        "wear": 0.01,
        "slot": 0,
    }]


def test_weapon_stickers_recover_collapsed_demoparser_ids_as_f32_bits():
    """demoparser sometimes leaves id=0 and packs real sticker IDs into wear/x/y bit patterns."""
    owner = "76561198000000001"
    item_id = 48844376331

    class FakeParser:
        def parse_skins(self):
            return {}

        def parse_ticks(self, _wanted, *, ticks):
            return {
                "steamid": [owner],
                "tick": [42],
                "item_id_high": [item_id >> 32],
                "item_id_low": [item_id & 0xFFFFFFFF],
                "Weapon.m_iAccountID": [account_id(owner)],
                "weapon_stickers": [[
                    {
                        "id": 0,
                        "name": "default",
                        # Vox / Reason / iBP Katowice 2014 Holo as f32 bit patterns
                        "wear": struct.unpack("<f", struct.pack("<I", 80))[0],
                        "x": struct.unpack("<f", struct.pack("<I", 74))[0],
                        "y": struct.unpack("<f", struct.pack("<I", 60))[0],
                    },
                ]],
                "item_def_idx": [7],
                "weapon_skin_id": [282],
                "weapon_paint_seed": [1],
                "weapon_float": [0.2],
                "team_num": [2],
            }

    inventory = build_player_cosmetic_inventory(FakeParser(), sample_ticks=[42])
    stickers = inventory[owner][0]["stickers"]
    assert [row["paint_index"] for row in stickers] == [80, 74, 60]
    assert [row["slot"] for row in stickers] == [0, 1, 2]
    assert "Katowice 2014" in stickers[0]["name_en"]


def test_weapon_stickers_ignore_unreliable_offset_bit_patterns_when_id_missing():
    """A lone denormal y with normal wear is not a trustworthy sticker id source."""
    owner = "76561198000000001"
    item_id = 43287757702

    class FakeParser:
        def parse_skins(self):
            return {}

        def parse_ticks(self, _wanted, *, ticks):
            return {
                "steamid": [owner],
                "tick": [42],
                "item_id_high": [item_id >> 32],
                "item_id_low": [item_id & 0xFFFFFFFF],
                "Weapon.m_iAccountID": [account_id(owner)],
                "weapon_stickers": [[
                    {
                        "id": 0,
                        "name": "default",
                        "wear": 1.0,
                        "x": 0.0,
                        "y": struct.unpack("<f", struct.pack("<I", 2507))[0],
                    },
                    {"id": 32, "name": "std2_bash_holo", "wear": 0.0, "x": 0.0, "y": 0.0},
                ]],
                "item_def_idx": [9],
                "weapon_skin_id": [344],
                "weapon_paint_seed": [89],
                "weapon_float": [0.05],
                "team_num": [3],
            }

    inventory = build_player_cosmetic_inventory(FakeParser(), sample_ticks=[42])
    stickers = inventory[owner][0]["stickers"]
    assert [row["paint_index"] for row in stickers] == [32]
    assert stickers[0]["name_en"] == "Sticker | Bash (Holo)"


def test_weapon_account_adds_weapons_but_requires_repeated_owner_held_knife_evidence():
    owner = "76561198000000001"
    weapon_id = 53009600926
    issued_knife_id = 53009600927
    owned_knife_id = 53009600928

    class FakeParser:
        def parse_skins(self):
            return {}

        def parse_ticks(self, _wanted, *, ticks):
            assert ticks == [42, 84]
            return {
                "steamid": [owner, owner, owner, owner],
                "tick": [42, 42, 42, 84],
                "item_id_high": [
                    weapon_id >> 32,
                    issued_knife_id >> 32,
                    owned_knife_id >> 32,
                    owned_knife_id >> 32,
                ],
                "item_id_low": [
                    weapon_id & 0xFFFFFFFF,
                    issued_knife_id & 0xFFFFFFFF,
                    owned_knife_id & 0xFFFFFFFF,
                    owned_knife_id & 0xFFFFFFFF,
                ],
                "active_weapon_original_owner": [owner, owner, owner, owner],
                "Weapon.m_iAccountID": [account_id(owner)] * 4,
                "weapon_stickers": [[], [], [], []],
                "item_def_idx": [7, 507, 507, 507],
                "weapon_skin_id": [724, 421, 421, 421],
                "weapon_paint_seed": [39, 701, 960, 960],
                "weapon_float": [0.217899, 0.011, 0.010816, 0.010816],
                "team_num": [2, 2, 2, 2],
                "m_iMusicKitID": [0, 0, 0, 0],
                "m_unMusicID": [0, 0, 0, 0],
            }

    inventory = build_player_cosmetic_inventory(FakeParser(), sample_ticks=[84, 42])

    assert {item["item_id"] for item in inventory[owner]} == {weapon_id, owned_knife_id}
    knife = next(item for item in inventory[owner] if item["item_id"] == owned_knife_id)
    assert knife["type"] == "melee"
    assert knife["paint_seed"] == 960
    assert knife["evidence_observations"] == 2
    assert knife["ownership_evidence"] == "weapon_account_id"


def test_weapon_account_rehomes_a_skin_table_knife_instead_of_trusting_the_wrong_row_owner():
    wrong_owner = "76561198000000001"
    actual_owner = "76561198000000002"
    knife_id = 53009600926

    class FakeParser:
        def parse_skins(self):
            return {
                "steamid": [wrong_owner],
                "def_index": [508],
                "item_id": [knife_id],
                "paint_index": [415],
                "paint_seed": [80],
                "paint_wear": [0.016897],
                "custom_name": [None],
            }

        def parse_ticks(self, _wanted, *, ticks):
            assert ticks == [42, 84]
            return {
                "steamid": [actual_owner, actual_owner],
                "tick": [42, 84],
                "item_id_high": [knife_id >> 32] * 2,
                "item_id_low": [knife_id & 0xFFFFFFFF] * 2,
                # Deliberately wrong: this transient field must not override
                # the economy account attached to the asset.
                "active_weapon_original_owner": [wrong_owner, wrong_owner],
                "Weapon.m_iAccountID": [account_id(actual_owner)] * 2,
                "weapon_stickers": [[], []],
                "item_def_idx": [508, 508],
                "weapon_skin_id": [415, 415],
                "weapon_paint_seed": [80, 80],
                "weapon_float": [0.016897, 0.016897],
                "team_num": [2, 2],
            }

    inventory = build_player_cosmetic_inventory(FakeParser(), sample_ticks=[42, 84])

    assert wrong_owner not in inventory
    assert [item["item_id"] for item in inventory[actual_owner]] == [knife_id]


def test_conflicting_weapon_accounts_drop_the_ambiguous_knife_instead_of_guessing():
    first_owner = "76561198000000001"
    second_owner = "76561198000000002"
    knife_id = 53009600926

    class FakeParser:
        def parse_skins(self):
            return {
                "steamid": [first_owner],
                "def_index": [508],
                "item_id": [knife_id],
                "paint_index": [415],
                "paint_seed": [80],
                "paint_wear": [0.016897],
                "custom_name": [None],
            }

        def parse_ticks(self, _wanted, *, ticks):
            return {
                "steamid": [first_owner, second_owner],
                "tick": ticks,
                "item_id_high": [knife_id >> 32] * 2,
                "item_id_low": [knife_id & 0xFFFFFFFF] * 2,
                "Weapon.m_iAccountID": [account_id(first_owner), account_id(second_owner)],
                "weapon_stickers": [[], []],
                "item_def_idx": [508, 508],
                "weapon_skin_id": [415, 415],
                "weapon_paint_seed": [80, 80],
                "weapon_float": [0.016897, 0.016897],
                "team_num": [2, 3],
            }

    assert build_player_cosmetic_inventory(FakeParser(), sample_ticks=[42, 84]) == {}


def test_player_pawn_econ_fields_recover_a_second_glove_even_without_finish_attributes():
    owner = "76561198000000001"
    first_glove_id = 52469120460
    second_glove_id = 52921241498

    class FakeParser:
        def parse_skins(self):
            return {
                "steamid": [owner],
                "def_index": [5030],
                "item_id": [first_glove_id],
                "paint_index": [10047],
                "paint_seed": [720],
                "paint_wear": [0.167266],
                "custom_name": [None],
            }

        def parse_ticks(self, _wanted, *, ticks):
            assert ticks == [42, 84]
            return {
                "steamid": [owner, owner],
                "tick": [42, 84],
                "team_num": [2, 2],
                "CCSPlayerPawn.m_iItemDefinitionIndex": [5032, 5032],
                "CCSPlayerPawn.m_iItemIDHigh": [second_glove_id >> 32, second_glove_id >> 32],
                "CCSPlayerPawn.m_iItemIDLow": [second_glove_id & 0xFFFFFFFF, second_glove_id & 0xFFFFFFFF],
                "CCSPlayerPawn.CEconItemAttribute.m_iAttributeDefinitionIndex": [8, 8],
                "CCSPlayerPawn.CEconItemAttribute.m_flInitialValue": [0.19942, 0.19942],
                "CCSPlayerPawn.m_szCustomName": ["", ""],
            }

    inventory = build_player_cosmetic_inventory(FakeParser(), sample_ticks=[42, 84])

    gloves = [item for item in inventory[owner] if item["type"] == "glove"]
    assert {item["item_id"] for item in gloves} == {first_glove_id, second_glove_id}
    recovered = next(item for item in gloves if item["item_id"] == second_glove_id)
    assert recovered["name_en"] == "Hand Wraps"
    assert recovered["paint_wear"] == 0.19942
    assert recovered["finish_known"] is False
    assert recovered["observed_teams"] == ["t"]
    assert recovered["ownership_evidence"] == "player_pawn_econ_item_id"


def test_player_pawn_glove_paint_props_recover_finish_like_demotracer():
    owner = "76561198000000001"
    glove_id = 46871901218

    class FakeParser:
        def parse_skins(self):
            return {}

        def parse_ticks(self, wanted, *, ticks):
            assert ticks == [42]
            assert "glove_paint_id" in wanted
            assert "glove_paint_seed" in wanted
            assert "glove_paint_float" in wanted
            return {
                "steamid": [owner],
                "tick": [42],
                "team_num": [2],
                "CCSPlayerPawn.m_iItemDefinitionIndex": [5034],
                "CCSPlayerPawn.m_iItemIDHigh": [glove_id >> 32],
                "CCSPlayerPawn.m_iItemIDLow": [glove_id & 0xFFFFFFFF],
                "CCSPlayerPawn.CEconItemAttribute.m_iAttributeDefinitionIndex": [8],
                "CCSPlayerPawn.CEconItemAttribute.m_flInitialValue": [0.140974],
                "CCSPlayerPawn.m_szCustomName": [""],
                "glove_paint_id": [10063],
                "glove_paint_seed": [893.53857421875],
                "glove_paint_float": [0.14097395539283752],
            }

    inventory = build_player_cosmetic_inventory(FakeParser(), sample_ticks=[42])

    glove = inventory[owner][0]
    assert glove["type"] == "glove"
    assert glove["def_index"] == 5034
    assert glove["paint_index"] == 10063
    assert glove["name_en"] == "Specialist Gloves | Fade"
    assert glove["paint_seed"] == 893
    assert glove["paint_wear"] == 0.140974
    assert glove["finish_known"] is True
    assert glove["finish_evidence"] == "glove_paint_props"
    assert glove["observed_teams"] == ["t"]
    assert glove["ownership_evidence"] == "player_pawn_econ_item_id"


def test_cosmetic_inventory_omits_agent_from_controller_evidence():
    owner = "76561198000000001"

    class FakeParser:
        def parse_skins(self):
            return {}

        def parse_ticks(self, _wanted, *, ticks):
            assert ticks == [42]
            return {
                "steamid": [owner],
                "tick": [42],
                "team_num": [2],
                "CCSPlayerController.m_nPawnCharacterDefIndex": [4736],
            }

    assert build_player_cosmetic_inventory(FakeParser(), sample_ticks=[42]) == {}


def test_cosmetic_inventory_omits_music_kit_from_player_controller_evidence():
    class FakeParser:
        def parse_skins(self):
            return {
                "steamid": ["76561198000000001"],
                "def_index": [1314],
                "paint_index": [3],
                "paint_seed": [None],
                "paint_wear": [None],
                "item_id": [123],
                "custom_name": [""],
            }

        def parse_ticks(self, _wanted, *, ticks):
            assert ticks == [42]
            return {
                "steamid": ["76561198000000001"],
                "item_id_high": [0],
                "item_id_low": [0],
                "active_weapon_original_owner": ["0"],
                "weapon_stickers": [[]],
                "team_num": [3],
                "m_iMusicKitID": [3],
                "m_unMusicID": [0],
            }

    assert build_player_cosmetic_inventory(FakeParser(), sample_ticks=[42]) == {}


def test_live_music_field_minus_one_does_not_fall_back_to_default_inventory_music():
    class FakeParser:
        def parse_skins(self):
            return {}

        def parse_ticks(self, _wanted, *, ticks):
            assert ticks == [42]
            return {
                "steamid": ["76561198000000001"],
                "team_num": [3],
                "CCSPlayerController.m_iMusicKitID": [-1],
                "CCSPlayerController.CCSPlayerController_InventoryServices.m_unMusicID": [1],
            }

    assert build_player_cosmetic_inventory(FakeParser(), sample_ticks=[42]) == {}


def test_vanilla_owned_weapon_appears_with_observed_team():
    owner = "76561198000000001"
    item_id = 41090984122

    class FakeParser:
        def parse_skins(self):
            return {}

        def parse_ticks(self, _wanted, *, ticks):
            return {
                "steamid": [owner],
                "tick": [42],
                "item_id_high": [item_id >> 32],
                "item_id_low": [item_id & 0xFFFFFFFF],
                "Weapon.m_iAccountID": [account_id(owner)],
                "weapon_stickers": [[]],
                "item_def_idx": [4],  # glock
                "weapon_skin_id": [0],
                "weapon_paint_seed": [0],
                "weapon_float": [0.0],
                "team_num": [2],
            }

    inventory = build_player_cosmetic_inventory(FakeParser(), sample_ticks=[42])
    weapons = [row for row in inventory[owner] if row["type"] == "weapon"]
    assert len(weapons) == 1
    assert weapons[0]["def_index"] == 4
    assert weapons[0]["paint_index"] == 0
    assert weapons[0]["item_id"] == item_id
    assert weapons[0]["observed_teams"] == ["t"]
    assert weapons[0]["ownership_evidence"] == "weapon_account_id"


def test_vanilla_weapon_held_by_non_owner_has_no_observed_team_for_holder():
    owner = "76561198000000001"
    holder = "76561198000000002"
    item_id = 41090984122

    class FakeParser:
        def parse_skins(self):
            return {}

        def parse_ticks(self, _wanted, *, ticks):
            # Owner must appear in the sampled roster (existing account-in-roster
            # gate). Holder carries the asset; owner does not hold it this tick.
            return {
                "steamid": [holder, owner],
                "tick": [42, 42],
                "item_id_high": [item_id >> 32, 0],
                "item_id_low": [item_id & 0xFFFFFFFF, 0],
                "Weapon.m_iAccountID": [account_id(owner), 0],
                "weapon_stickers": [[], []],
                "item_def_idx": [4, None],
                "weapon_skin_id": [0, None],
                "weapon_paint_seed": [0, None],
                "weapon_float": [0.0, None],
                "team_num": [3, 2],
            }

    inventory = build_player_cosmetic_inventory(FakeParser(), sample_ticks=[42])
    # Attributed to economy owner, but observed_teams empty (owner never held).
    assert holder not in inventory or not any(
        row.get("item_id") == item_id for row in inventory.get(holder, [])
    )
    owned = inventory.get(owner) or []
    match = next((row for row in owned if row.get("item_id") == item_id), None)
    assert match is not None
    assert match["observed_teams"] == []


def test_resolve_cs2_item_treats_non_finite_paint_as_vanilla():
    item = resolve_cs2_item(7, float("nan"))
    assert item is not None
    assert item["def"] == 7
    assert item["paint"] == 0
    assert item["catalog_exact"] is True
    assert item["name_en"] == "AK-47"


def test_vanilla_owned_weapon_survives_nan_paint_from_demoparser():
    owner = "76561198000000001"
    item_id = 24996516199

    class FakeParser:
        def parse_skins(self):
            return {}

        def parse_ticks(self, _wanted, *, ticks):
            return {
                "steamid": [owner],
                "tick": [42],
                "item_id_high": [item_id >> 32],
                "item_id_low": [item_id & 0xFFFFFFFF],
                "Weapon.m_iAccountID": [account_id(owner)],
                "weapon_stickers": [[]],
                "item_def_idx": [7],
                "weapon_skin_id": [float("nan")],
                "weapon_paint_seed": [0],
                "weapon_float": [0.0],
                "team_num": [2],
            }

    inventory = build_player_cosmetic_inventory(FakeParser(), sample_ticks=[42])
    weapons = [row for row in inventory[owner] if row["type"] == "weapon"]
    assert len(weapons) == 1
    assert weapons[0]["def_index"] == 7
    assert weapons[0]["paint_index"] == 0
    assert weapons[0]["item_id"] == item_id
    assert weapons[0]["observed_teams"] == ["t"]
    assert weapons[0]["ownership_evidence"] == "weapon_account_id"


def test_default_buy_weapon_without_econ_id_attributes_to_holder_as_vanilla():
    """Demoparser often emits item_id=0 + account=1 + garbage paint for default buys."""
    holder = "76561198000000001"

    class FakeParser:
        def parse_skins(self):
            return {}

        def parse_ticks(self, _wanted, *, ticks):
            return {
                "steamid": [holder],
                "tick": [42],
                "item_id_high": [0],
                "item_id_low": [0],
                "Weapon.m_iAccountID": [1],
                "weapon_stickers": [[]],
                "item_def_idx": [16],  # M4A4
                "weapon_skin_id": [588],  # unreliable template paint
                "weapon_paint_seed": [874],
                "weapon_float": [0.17],
                "team_num": [3],
            }

    inventory = build_player_cosmetic_inventory(FakeParser(), sample_ticks=[42])
    weapons = [row for row in inventory[holder] if row["type"] == "weapon"]
    assert len(weapons) == 1
    assert weapons[0]["def_index"] == 16
    assert weapons[0]["paint_index"] == 0
    assert "item_id" not in weapons[0] or not weapons[0].get("item_id")
    assert weapons[0]["observed_teams"] == ["ct"]
    assert weapons[0]["ownership_evidence"] == "default_weapon_no_econ_id"


def test_weapons_require_live_match_purchase_when_match_start_provided():
    """Warmup buys must not unlock cosmetics; live item_purchase is required."""
    owner = "76561198000000001"
    item_id = (12 << 32) | 1634679555

    def make_parser(*, purchase_ticks: list[int]):
        class FakeParser:
            def parse_skins(self):
                return {}

            def parse_event(self, name):
                if name != "item_purchase":
                    raise AssertionError(name)
                return {
                    "tick": list(purchase_ticks),
                    "steamid": [int(owner)] * len(purchase_ticks),
                    "item_name": ["AWP"] * len(purchase_ticks),
                    "skin": ["Asiimov"] * len(purchase_ticks),
                    "skin_id": [279] * len(purchase_ticks),
                }

            def parse_ticks(self, _wanted, *, ticks):
                # Entity still present live even when only bought in warmup.
                return {
                    "steamid": [owner, owner],
                    "tick": [50, 1000],
                    "item_id_high": [item_id >> 32, item_id >> 32],
                    "item_id_low": [item_id & 0xFFFFFFFF, item_id & 0xFFFFFFFF],
                    "Weapon.m_iAccountID": [account_id(owner), account_id(owner)],
                    "weapon_stickers": [[], []],
                    "item_def_idx": [9, 9],
                    "weapon_skin_id": [279, 279],
                    "weapon_paint_seed": [1, 1],
                    "weapon_float": [0.2, 0.2],
                    "team_num": [3, 3],
                }

        return FakeParser()

    # Warmup-only buy; entity still sampled live → still no AWP cosmetics
    cold = build_player_cosmetic_inventory(
        make_parser(purchase_ticks=[100]),
        sample_ticks=[50, 1000],
        match_start_tick=500,
    )
    assert not any(row.get("def_index") == 9 for row in (cold.get(owner) or []))

    # Live buy after match_start → AWP allowed
    live = build_player_cosmetic_inventory(
        make_parser(purchase_ticks=[100, 900]),
        sample_ticks=[50, 1000],
        match_start_tick=800,
    )
    weapons = [row for row in live[owner] if row.get("type") == "weapon"]
    assert len(weapons) == 1
    assert weapons[0]["def_index"] == 9
    assert weapons[0]["ownership_evidence"] == "weapon_account_id"


def test_zero_id_ground_pickup_does_not_inherit_purchase_provenance_across_sides():
    owner = "76561198000000001"

    class FakeParser:
        def parse_skins(self):
            return {}

        def parse_event(self, name):
            if name == "player_spawn":
                return {"tick": [], "user_steamid": []}
            if name == "item_purchase":
                return {
                    "tick": [100],
                    "steamid": [owner],
                    "item_name": ["AK-47"],
                }
            if name == "item_pickup":
                return {
                    "tick": [100, 500],
                    "user_steamid": [owner, owner],
                    "defindex": [7, 7],
                    "item": ["ak47", "ak47"],
                }
            if name == "player_team":
                return {
                    "tick": [50, 400],
                    "user_steamid": [owner, owner],
                    "oldteam": [0, 2],
                    "team": [2, 3],
                }
            if name == "player_death":
                return {"tick": [], "user_steamid": []}
            raise AssertionError(name)

        def parse_ticks(self, _wanted, *, ticks):
            assert ticks == [100, 200, 600]
            return {
                "steamid": [owner, owner],
                "tick": [200, 600],
                "inventory": [["Knife", "Glock-18", "AK-47"], ["Knife", "USP-S", "AK-47"]],
                "item_id_high": [0, 0],
                "item_id_low": [0, 0],
                "Weapon.m_iAccountID": [0, 1],
                "weapon_stickers": [[], []],
                "item_def_idx": [7, 7],
                "weapon_skin_id": [0, 0],
                "weapon_paint_seed": [0, 0],
                "weapon_float": [0.0, 0.0],
                "team_num": [2, 3],
            }

    inventory = build_player_cosmetic_inventory(
        FakeParser(), sample_ticks=[200, 600], match_start_tick=100
    )

    ak = next(row for row in inventory[owner] if row.get("def_index") == 7)
    assert ak["ownership_evidence"] == "default_weapon_no_econ_id"
    assert ak["observed_teams"] == ["t"]
    assert ak["evidence_observations"] == 1


def test_zero_id_ground_pickup_replaces_earlier_purchase_provenance_on_same_side():
    owner = "76561198000000001"

    class FakeParser:
        def parse_skins(self):
            return {}

        def parse_event(self, name):
            if name == "player_spawn":
                return {"tick": [], "user_steamid": []}
            if name == "item_purchase":
                return {
                    "tick": [100],
                    "steamid": [owner],
                    "item_name": ["AK-47"],
                }
            if name == "item_pickup":
                return {
                    "tick": [100, 500],
                    "user_steamid": [owner, owner],
                    "defindex": [7, 7],
                    "item": ["ak47", "ak47"],
                }
            if name == "player_team":
                return {
                    "tick": [50],
                    "user_steamid": [owner],
                    "oldteam": [0],
                    "team": [2],
                }
            if name == "player_death":
                return {"tick": [], "user_steamid": []}
            raise AssertionError(name)

        def parse_ticks(self, _wanted, *, ticks):
            assert ticks == [100, 600]
            return {
                "steamid": [owner],
                "tick": [600],
                "inventory": [["Knife", "Glock-18", "AK-47"]],
                "item_id_high": [0],
                "item_id_low": [0],
                "Weapon.m_iAccountID": [1],
                "weapon_stickers": [[]],
                "item_def_idx": [7],
                "weapon_skin_id": [0],
                "weapon_paint_seed": [0],
                "weapon_float": [0.0],
                "team_num": [2],
            }

    inventory = build_player_cosmetic_inventory(
        FakeParser(), sample_ticks=[600], match_start_tick=100
    )

    assert not any(row.get("def_index") == 7 for row in inventory.get(owner) or [])


def test_spawn_loadout_pistols_bypass_purchase_without_attributing_pickups():
    usp_owner = "76561198000000001"
    p2000_owner = "76561198000000002"
    glock_owner = "76561198000000003"
    usp_id = 41090984121
    p2000_id = 41090984122
    glock_id = 41090984123

    class FakeParser:
        def parse_skins(self):
            return {}

        def parse_event(self, name):
            if name == "player_spawn":
                return {
                    "tick": [99, 99, 99],
                    "user_steamid": [usp_owner, p2000_owner, glock_owner],
                }
            if name == "item_purchase":
                return {"tick": [], "steamid": [], "item_name": []}
            raise AssertionError(name)

        def parse_ticks(self, _wanted, *, ticks):
            assert ticks == [100, 101, 1000]
            return {
                "steamid": [usp_owner, p2000_owner, glock_owner, usp_owner],
                "tick": [100, 100, 100, 1000],
                "inventory": [
                    ["Knife", "USP-S"],
                    ["Knife", "P2000"],
                    ["Knife", "Glock-18"],
                    ["Knife", "USP-S", "P2000"],
                ],
                "item_id_high": [
                    usp_id >> 32,
                    p2000_id >> 32,
                    glock_id >> 32,
                    p2000_id >> 32,
                ],
                "item_id_low": [
                    usp_id & 0xFFFFFFFF,
                    p2000_id & 0xFFFFFFFF,
                    glock_id & 0xFFFFFFFF,
                    p2000_id & 0xFFFFFFFF,
                ],
                "Weapon.m_iAccountID": [
                    account_id(usp_owner),
                    account_id(p2000_owner),
                    account_id(glock_owner),
                    account_id(p2000_owner),
                ],
                "weapon_stickers": [[], [], [], []],
                "item_def_idx": [61, 32, 4, 32],
                "weapon_skin_id": [504, 389, 353, 389],
                "weapon_paint_seed": [1, 2, 3, 2],
                "weapon_float": [0.1, 0.2, 0.3, 0.2],
                "team_num": [3, 3, 2, 3],
            }

    inventory = build_player_cosmetic_inventory(
        FakeParser(), sample_ticks=[1000], match_start_tick=100
    )

    usp_defs = {row["def_index"] for row in inventory[usp_owner] if row["type"] == "weapon"}
    p2000_defs = {row["def_index"] for row in inventory[p2000_owner] if row["type"] == "weapon"}
    glock_defs = {row["def_index"] for row in inventory[glock_owner] if row["type"] == "weapon"}
    assert usp_defs == {61}
    assert p2000_defs == {32}
    assert glock_defs == {4}
    assert inventory[usp_owner][0]["item_id"] == usp_id
    assert not any(row.get("item_id") == p2000_id for row in inventory[usp_owner])


def test_spawn_pistol_window_handles_missing_spawn_plus_one_tick():
    owner = "76561198000000001"
    bystander = "76561198000000002"
    usp_id = 41090984121
    p2000_id = 41090984122

    class FakeParser:
        def parse_skins(self):
            return {}

        def parse_event(self, name):
            if name == "player_spawn":
                return {"tick": [100], "user_steamid": [owner]}
            if name == "item_purchase":
                return {"tick": [], "steamid": [], "item_name": []}
            raise AssertionError(name)

        def parse_ticks(self, _wanted, *, ticks):
            assert ticks == [100, 101, 102]
            # Real demos may expose exact state at N/N+2 but no row at N+1.
            return {
                "steamid": [owner, bystander, owner, bystander],
                "tick": [100, 100, 102, 102],
                "inventory": [
                    ["Knife", "USP-S"],
                    ["Knife", "P2000"],
                    ["Knife", "USP-S"],
                    ["Knife", "P2000"],
                ],
                "item_id_high": [
                    usp_id >> 32,
                    p2000_id >> 32,
                    usp_id >> 32,
                    p2000_id >> 32,
                ],
                "item_id_low": [
                    usp_id & 0xFFFFFFFF,
                    p2000_id & 0xFFFFFFFF,
                    usp_id & 0xFFFFFFFF,
                    p2000_id & 0xFFFFFFFF,
                ],
                "Weapon.m_iAccountID": [
                    account_id(owner),
                    account_id(bystander),
                    account_id(owner),
                    account_id(bystander),
                ],
                "weapon_stickers": [[], [], [], []],
                "item_def_idx": [61, 32, 61, 32],
                "weapon_skin_id": [0, 0, 0, 0],
                "weapon_paint_seed": [0, 0, 0, 0],
                "weapon_float": [0.0, 0.0, 0.0, 0.0],
                "team_num": [3, 3, 3, 3],
            }

    inventory = build_player_cosmetic_inventory(
        FakeParser(), sample_ticks=[], match_start_tick=100
    )

    usp = next(row for row in inventory[owner] if row.get("def_index") == 61)
    assert usp["item_id"] == usp_id
    assert usp["observed_teams"] == ["ct"]
    assert not any(row.get("def_index") == 32 for row in inventory.get(bystander, []))


def test_zero_id_spawn_p2000_falls_back_to_safe_vanilla_slot():
    owner = "76561198000000001"

    class FakeParser:
        def parse_skins(self):
            return {}

        def parse_event(self, name):
            if name == "player_spawn":
                return {"tick": [99, 199], "user_steamid": [owner, owner]}
            if name == "item_purchase":
                return {"tick": [], "steamid": [], "item_name": []}
            raise AssertionError(name)

        def parse_ticks(self, _wanted, *, ticks):
            assert ticks == [100, 101, 199, 200, 201]
            return {
                "steamid": [owner, owner],
                "tick": [100, 200],
                # The saved AWP + picked-up USP-S snapshot must not override P2000.
                "inventory": [["Knife", "P2000"], ["Knife", "AWP", "USP-S"]],
                "item_id_high": [0, 1],
                "item_id_low": [0, 2],
                "Weapon.m_iAccountID": [0, account_id(owner)],
                "weapon_stickers": [[], []],
                "item_def_idx": [32, 9],
                "weapon_skin_id": [504, 279],
                "weapon_paint_seed": [123, 1],
                "weapon_float": [0.2, 0.1],
                "team_num": [3, 3],
            }

    inventory = build_player_cosmetic_inventory(
        FakeParser(), sample_ticks=[], match_start_tick=100
    )
    pistol = inventory[owner][0]
    assert pistol["def_index"] == 32
    assert pistol["paint_index"] == 0
    assert pistol["observed_teams"] == ["ct"]
    assert not pistol.get("item_id")


def test_t_side_participation_adds_glock_when_spawn_event_is_missing():
    owner = "76561198000000001"
    ssg_id = 41090984122

    class FakeParser:
        def parse_skins(self):
            return {}

        def parse_event(self, name):
            if name == "player_spawn":
                return {"tick": [], "user_steamid": []}
            if name == "item_purchase":
                return {
                    "tick": [500],
                    "steamid": [owner],
                    "item_name": ["SSG 08"],
                }
            raise AssertionError(name)

        def parse_ticks(self, _wanted, *, ticks):
            assert ticks == [100, 1000]
            return {
                "steamid": [owner],
                "tick": [1000],
                "inventory": [["Knife", "Glock-18", "SSG 08"]],
                "item_id_high": [ssg_id >> 32],
                "item_id_low": [ssg_id & 0xFFFFFFFF],
                "Weapon.m_iAccountID": [account_id(owner)],
                "weapon_stickers": [[]],
                "item_def_idx": [40],
                "weapon_skin_id": [996],
                "weapon_paint_seed": [1],
                "weapon_float": [0.1],
                "team_num": [2],
            }

    inventory = build_player_cosmetic_inventory(
        FakeParser(), sample_ticks=[1000], match_start_tick=100
    )
    weapons = {row["def_index"]: row for row in inventory[owner] if row["type"] == "weapon"}
    assert set(weapons) == {4, 40}
    assert weapons[4]["observed_teams"] == ["t"]
    assert weapons[4]["ownership_evidence"] == "spawn_loadout_default_pistol"
    assert not weapons[4].get("item_id")
    assert weapons[40]["item_id"] == ssg_id


def test_live_purchase_gate_does_not_drop_knives_or_gloves():
    owner = "76561198000000001"
    knife_id = 53009600926
    glove_id = 46871901218

    class FakeParser:
        def parse_skins(self):
            return {
                "steamid": [owner],
                "def_index": [508],
                "paint_index": [415],
                "paint_seed": [80],
                "paint_wear": [0.01],
                "item_id": [knife_id],
                "custom_name": [""],
            }

        def parse_event(self, name):
            if name != "item_purchase":
                return {"tick": []}
            return {"tick": [], "steamid": [], "item_name": []}

        def parse_ticks(self, wanted, *, ticks):
            assert "glove_paint_id" in wanted
            return {
                "steamid": [owner],
                "tick": [1000],
                "item_id_high": [knife_id >> 32],
                "item_id_low": [knife_id & 0xFFFFFFFF],
                "Weapon.m_iAccountID": [account_id(owner)],
                "weapon_stickers": [[]],
                "item_def_idx": [508],
                "weapon_skin_id": [415],
                "weapon_paint_seed": [80],
                "weapon_float": [0.01],
                "team_num": [2],
                "CCSPlayerPawn.m_iItemDefinitionIndex": [5034],
                "CCSPlayerPawn.m_iItemIDHigh": [glove_id >> 32],
                "CCSPlayerPawn.m_iItemIDLow": [glove_id & 0xFFFFFFFF],
                "CCSPlayerPawn.m_szCustomName": [""],
                "glove_paint_id": [10063],
                "glove_paint_seed": [893],
                "glove_paint_float": [0.14],
            }

    inventory = build_player_cosmetic_inventory(
        FakeParser(), sample_ticks=[1000], match_start_tick=100
    )
    types = {row.get("type") for row in inventory.get(owner) or []}
    assert "melee" in types
    assert "glove" in types
    weapons = [row for row in inventory.get(owner) or [] if row.get("type") == "weapon"]
    assert [row.get("def_index") for row in weapons] == [4]
    assert weapons[0]["ownership_evidence"] == "spawn_loadout_default_pistol"


def test_default_buy_path_skips_c4_even_though_catalog_marks_it_weapon():
    holder = "76561198000000001"

    class FakeParser:
        def parse_skins(self):
            return {
                "steamid": [holder],
                "def_index": [49],
                "paint_index": [0],
                "paint_seed": [0],
                "paint_wear": [0.0],
                "item_id": [123],
                "custom_name": [""],
            }

        def parse_ticks(self, _wanted, *, ticks):
            return {
                "steamid": [holder],
                "tick": [42],
                "item_id_high": [0],
                "item_id_low": [0],
                "Weapon.m_iAccountID": [0],
                "weapon_stickers": [[]],
                "item_def_idx": [49],
                "weapon_skin_id": [float("nan")],
                "weapon_paint_seed": [0],
                "weapon_float": [0.0],
                "team_num": [2],
            }

    assert build_player_cosmetic_inventory(FakeParser(), sample_ticks=[42]) == {}


def test_default_buy_path_skips_grenades_and_does_not_steal_roster_owned_accounts():
    holder = "76561198000000001"
    other = "76561198000000002"
    owned_id = 41090984122

    class FakeParser:
        def parse_skins(self):
            return {}

        def parse_ticks(self, _wanted, *, ticks):
            return {
                # other must appear in roster for account-in-roster gate
                "steamid": [holder, holder, other],
                "tick": [42, 42, 42],
                "item_id_high": [0, owned_id >> 32, 0],
                "item_id_low": [0, owned_id & 0xFFFFFFFF, 0],
                "Weapon.m_iAccountID": [0, account_id(other), 0],
                "weapon_stickers": [[], [], []],
                "item_def_idx": [43, 7, None],  # flashbang + pickup AK owned by other
                "weapon_skin_id": [float("nan"), 0, None],
                "weapon_paint_seed": [0, 0, None],
                "weapon_float": [0.0, 0.0, None],
                "team_num": [3, 3, 2],
            }

    inventory = build_player_cosmetic_inventory(FakeParser(), sample_ticks=[42])
    assert holder not in inventory or not any(
        row.get("type") == "weapon" for row in inventory.get(holder, [])
    )
    # Economy owner still receives the asset (no observed_teams if never held).
    owned = inventory.get(other) or []
    assert any(row.get("item_id") == owned_id for row in owned)
