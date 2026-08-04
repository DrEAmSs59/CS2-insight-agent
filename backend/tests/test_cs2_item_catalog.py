from __future__ import annotations

import struct

from app.parser.cs2_item_catalog import (
    build_player_cosmetic_inventory,
    build_player_skin_loadouts,
    resolve_cs2_item,
    resolve_cs2_item_by_catalog_id,
    resolve_weapon_model,
    skin_for_player_weapon,
)

STEAM_ID64_INDIVIDUAL_BASE = 76561197960265728


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


def test_cosmetic_inventory_adds_catalogued_agent_from_controller_evidence():
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

    inventory = build_player_cosmetic_inventory(FakeParser(), sample_ticks=[42])

    agent = inventory[owner][0]
    assert agent["type"] == "agent"
    assert agent["def_index"] == 4736
    assert agent["observed_teams"] == ["t"]
    assert agent["ownership_evidence"] == "demo_player_controller_agent"


def test_cosmetic_inventory_adds_music_kit_only_from_player_controller_evidence():
    class FakeParser:
        def parse_skins(self):
            return {}

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

    inventory = build_player_cosmetic_inventory(FakeParser(), sample_ticks=[42])

    item = inventory["76561198000000001"][0]
    assert item["type"] == "musickit"
    assert item["name_en"] == "Music Kit | Daniel Sadowski, Crimson Assault"
    assert item["ownership_evidence"] == "demo_player_controller_music_kit"


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


def test_default_buy_path_skips_c4_even_though_catalog_marks_it_weapon():
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
