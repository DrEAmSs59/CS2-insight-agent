from __future__ import annotations

from app.parser.cs2_item_catalog import (
    build_player_cosmetic_inventory,
    build_player_skin_loadouts,
    resolve_cs2_item,
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
