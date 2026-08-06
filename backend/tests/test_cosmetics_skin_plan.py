# ---------------------------------------------------------------------------------------------
# Copyright (c) unicbm. All rights reserved.
# Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
# ---------------------------------------------------------------------------------------------

"""Map CosmeticsView replacements → skin-core batch items + plan_json."""

from __future__ import annotations

import pytest

from app.cosmetics_skin_plan import (
    CosmeticsSkinPlanError,
    build_batch_and_plan,
    build_batch_from_plan_json,
    filter_plan_by_succeeded_item_ids,
    map_item_statuses,
    slot_key,
)

STEAM_ID = "76561198000000001"


def inventory_row(**overrides):
    row = {
        "catalog_id": 1001,
        "def_index": 508,
        "paint_index": 415,
        "paint_seed": 80,
        "paint_wear": 0.016897,
        "item_id": 53009600926,
        "type": "melee",
        "model": "knife_m9_bayonet",
        "name_en": "M9 Bayonet | Doppler",
        "name_zh": "M9 刺刀 | 多普勒",
        "image_url": "https://cdn.example/m9.webp",
        "rarity": "#eb4b4b",
        "observed_teams": ["t", "ct"],
        "stickers": [{"catalog_id": 1, "image_url": "https://cdn.example/sticker.webp"}],
        "custom_name": "全角，测试！",
    }
    row.update(overrides)
    return row


def replacement(**overrides):
    row = {
        "catalog_id": 1379,
        "def_index": 508,
        "paint_index": 418,
        "paint_wear": 0.01,
        "paint_seed": 12,
        "model": "knife_m9_bayonet",
        "type": "melee",
        "name_en": "M9 Bayonet | Doppler Ruby",
        "name_zh": "M9 刺刀 | 多普勒红宝石",
        "image_url": "https://cdn.example/m9-ruby.webp",
        "rarity": "#eb4b4b",
        "alt_name": "Ruby",
    }
    row.update(overrides)
    return row


def test_slot_key_prefers_item_id_then_placeholder_then_def():
    assert slot_key({"item_id": 99, "def_index": 7}) == "id:99"
    assert slot_key(
        {"def_index": 7, "paint_index": 282, "paint_seed": 1, "paint_wear": 0.2}
    ) == "def:7:282:1:0.2"
    assert slot_key({"item_id": 0, "def_index": 9, "paint_index": 0, "paint_seed": 0, "paint_wear": 0}) == (
        "def:9:0:0:0"
    )
    assert slot_key({"item_id": "53009600926"}) == "id:53009600926"
    # Placeholders without positive item_id use placeholder:{def_index} (mirrors frontend).
    assert slot_key({"is_placeholder": True, "def_index": 7}) == "placeholder:7"
    assert slot_key({"is_placeholder": True}) == "placeholder:0"
    # Positive item_id still wins over is_placeholder.
    assert slot_key({"item_id": 4, "is_placeholder": True, "def_index": 7}) == "id:4"


def test_build_batch_and_plan_maps_weapon_fields_without_custom_name_or_stickers():
    inv = [
        inventory_row(
            item_id=10,
            type="weapon",
            model="ak47",
            def_index=7,
            paint_index=0,
            paint_seed=1,
            paint_wear=0.1,
            name_zh="AK原皮",
            name_en="AK-47",
            catalog_id=3001,
            stickers=[{"catalog_id": 9}],
            custom_name="keep-on-entity",
        )
    ]
    repl = replacement(
        catalog_id=4797,
        def_index=7,
        paint_index=340,
        paint_wear=0.01,
        paint_seed=12,
        type="weapon",
        model="ak47",
        name_en="AK-47 | Redline",
        name_zh="AK-47 | 红线",
    )
    replacements = {"id:10": repl}

    batch_items, plan = build_batch_and_plan(STEAM_ID, inv, replacements)

    assert len(batch_items) == 1
    item = batch_items[0]
    assert item == {
        "item_id64": "10",
        "definition_index": 7,
        "paint_kit": 340,
        "pattern_seed": 12.0,
        "wear": 0.01,
    }
    assert "custom_name" not in item
    assert "stickers" not in item
    assert "replacement_definition_index" not in item

    assert plan["steamid"] == STEAM_ID
    assert len(plan["items"]) == 1
    entry = plan["items"][0]
    assert entry["slot_key"] == "id:10"
    assert entry["original"]["item_id"] == 10
    assert entry["original"]["def_index"] == 7
    assert entry["replacement"]["paint_index"] == 340
    assert entry["replacement"]["name_zh"] == "AK-47 | 红线"
    assert entry["replacement"]["image_url"] == repl["image_url"]
    assert build_batch_from_plan_json(plan, inv) == batch_items


def test_build_batch_from_plan_json_requires_items():
    with pytest.raises(CosmeticsSkinPlanError, match="no items"):
        build_batch_from_plan_json({"steamid": STEAM_ID, "items": []}, [])


def test_build_batch_sets_replacement_definition_index_for_cross_model_melee():
    inv = [inventory_row(item_id=53009600926, type="melee", def_index=508)]
    repl = replacement(catalog_id=1345, def_index=507, type="melee")  # different knife model
    batch_items, _plan = build_batch_and_plan(STEAM_ID, inv, {"id:53009600926": repl})

    assert batch_items[0]["definition_index"] == 508
    assert batch_items[0]["replacement_definition_index"] == 507
    assert batch_items[0]["paint_kit"] == 418
    assert "custom_name" not in batch_items[0]


def test_build_batch_sets_replacement_definition_index_for_cross_model_glove():
    inv = [
        inventory_row(
            item_id=99,
            type="glove",
            def_index=5027,
            paint_index=10033,
            model="sporty_gloves",
            observed_teams=["t"],
        )
    ]
    repl = replacement(
        catalog_id=1718,
        type="glove",
        def_index=5030,
        paint_index=10038,
        model="sporty_gloves",
        paint_wear=0.07,
    )
    batch_items, _plan = build_batch_and_plan(STEAM_ID, inv, {"id:99": repl})
    assert batch_items[0]["replacement_definition_index"] == 5030
    assert batch_items[0]["definition_index"] == 5027
    assert batch_items[0]["team"] == "T"


@pytest.mark.parametrize("stale_definition", [5030, None])
def test_build_batch_repairs_glove_definition_drift_from_catalog_id(caplog, stale_definition):
    """Regression: never put a Specialist paint kit on the Sport Gloves model."""

    inv = [
        inventory_row(
            item_id=53150323835,
            type="glove",
            def_index=5030,
            paint_index=10047,
            model="sporty_gloves",
        )
    ]
    repl = replacement(
        catalog_id=1764,
        type="glove",
        def_index=stale_definition,  # catalog 1764 is Specialist Gloves 5034
        paint_index=10033,
        model="specialist_gloves",
        paint_wear=0.07,
    )

    with caplog.at_level("WARNING"):
        batch_items, plan = build_batch_and_plan(
            STEAM_ID,
            inv,
            {"id:53150323835": repl},
        )

    assert batch_items[0]["definition_index"] == 5030
    assert batch_items[0]["replacement_definition_index"] == 5034
    assert plan["items"][0]["replacement"]["def_index"] == 5034
    assert "Corrected replacement definition drift" in caplog.text


def test_build_batch_rejects_nonexact_cross_model_pair_without_catalog_identity():
    inv = [inventory_row(item_id=99, type="glove", def_index=5030, paint_index=10047)]
    repl = replacement(
        catalog_id=None,
        type="glove",
        def_index=5030,
        paint_index=10033,
        model="specialist_gloves",
        paint_wear=0.07,
    )

    with pytest.raises(CosmeticsSkinPlanError, match="not an exact glove catalog item"):
        build_batch_and_plan(STEAM_ID, inv, {"id:99": repl})


def test_build_batch_rejects_catalog_identity_that_disagrees_with_paint():
    inv = [inventory_row(item_id=99, type="glove", def_index=5030, paint_index=10047)]
    repl = replacement(
        catalog_id=1764,
        type="glove",
        def_index=5034,
        paint_index=1438,
        model="specialist_gloves",
        paint_wear=0.07,
    )

    with pytest.raises(CosmeticsSkinPlanError, match="does not match"):
        build_batch_and_plan(STEAM_ID, inv, {"id:99": repl})


@pytest.mark.parametrize("wear", [0.059999, 0.800001])
def test_build_batch_rejects_wear_outside_target_finish_catalog_range(wear):
    inv = [
        inventory_row(
            item_id=99,
            type="glove",
            def_index=5030,
            paint_index=10047,
            model="sporty_gloves",
        )
    ]
    repl = replacement(
        catalog_id=1764,
        type="glove",
        def_index=5034,
        paint_index=10033,
        model="specialist_gloves",
        paint_wear=wear,
    )
    with pytest.raises(
        CosmeticsSkinPlanError,
        match=r"outside catalog range 0\.060000\.\.0\.800000",
    ):
        build_batch_and_plan(STEAM_ID, inv, {"id:99": repl})


@pytest.mark.parametrize("wear", [0.06, 0.8])
def test_build_batch_accepts_target_finish_catalog_wear_boundaries(wear):
    inv = [inventory_row(item_id=99, type="glove", def_index=5030)]
    repl = replacement(
        catalog_id=1764,
        type="glove",
        def_index=5034,
        paint_index=10033,
        paint_wear=wear,
    )
    batch_items, plan = build_batch_and_plan(STEAM_ID, inv, {"id:99": repl})
    assert batch_items[0]["wear"] == wear
    assert plan["items"][0]["replacement"]["paint_wear"] == wear


@pytest.mark.parametrize("wear", [-0.000001, 1.000001])
def test_build_batch_rejects_wear_outside_global_range_for_unknown_finish(wear):
    inv = [inventory_row(item_id=10, type="weapon", def_index=7)]
    repl = replacement(
        type="weapon",
        def_index=7,
        paint_index=16_000_000,
        paint_wear=wear,
    )
    with pytest.raises(CosmeticsSkinPlanError, match="between 0.000000 and 1.000000"):
        build_batch_and_plan(STEAM_ID, inv, {"id:10": repl})


def test_build_batch_emits_side_team_for_vanilla_gloves():
    inv = [
        inventory_row(
            item_id=0,
            type="glove",
            def_index=5027,
            paint_index=0,
            observed_teams=["t"],
        ),
        inventory_row(
            item_id=0,
            type="glove",
            def_index=5031,
            paint_index=0,
            observed_teams=["ct"],
        ),
    ]
    replacements = {
        slot_key(inv[0]): replacement(
            catalog_id=1722, type="glove", def_index=5030, paint_index=10048, paint_wear=0.07
        ),
        slot_key(inv[1]): replacement(
            catalog_id=1718, type="glove", def_index=5030, paint_index=10038, paint_wear=0.07
        ),
    }
    batch_items, _plan = build_batch_and_plan(STEAM_ID, inv, replacements)
    by_def = {row["definition_index"]: row for row in batch_items}
    assert by_def[5027]["item_id64"] == "0"
    assert by_def[5027]["team"] == "T"
    assert by_def[5031]["item_id64"] == "0"
    assert by_def[5031]["team"] == "CT"


def test_build_batch_placeholder_gloves_take_team_from_originals():
    """UI default gloves are not in workspace inventory; originals carry the side."""
    replacements = {
        "placeholder:5028": replacement(
            catalog_id=1711, type="glove", def_index=5027, paint_index=10006, paint_wear=0.07
        ),
        "placeholder:5029": replacement(
            catalog_id=1712, type="glove", def_index=5027, paint_index=10007, paint_wear=0.07
        ),
    }
    originals = {
        "placeholder:5028": {
            "type": "glove",
            "def_index": 5028,
            "paint_index": 0,
            "is_placeholder": True,
            "observed_teams": ["t"],
            "name_zh": "默认T手套",
        },
        "placeholder:5029": {
            "type": "glove",
            "def_index": 5029,
            "paint_index": 0,
            "is_placeholder": True,
            "observed_teams": ["ct"],
            "name_zh": "默认反恐精英手套",
        },
    }
    batch_items, plan = build_batch_and_plan(STEAM_ID, [], replacements, originals=originals)
    assert len(batch_items) == 2
    by_source = {row["definition_index"]: row for row in batch_items}
    assert by_source[5028]["item_id64"] == "0"
    assert by_source[5028]["team"] == "T"
    assert by_source[5028]["replacement_definition_index"] == 5027
    assert by_source[5029]["team"] == "CT"
    assert {entry["slot_key"] for entry in plan["items"]} == {
        "placeholder:5028",
        "placeholder:5029",
    }


def test_build_batch_placeholder_gloves_infer_team_from_default_defs():
    """Even if the UI snapshot omitted observed_teams, 5028/5029 are side-fixed."""
    replacements = {
        "placeholder:5028": replacement(
            catalog_id=1740, type="glove", def_index=5032, paint_index=10010, paint_wear=0.07
        ),
        "placeholder:5029": replacement(
            catalog_id=1739, type="glove", def_index=5032, paint_index=10009, paint_wear=0.07
        ),
    }
    originals = {
        "placeholder:5028": {
            "type": "glove",
            "def_index": 5028,
            "paint_index": 0,
            "is_placeholder": True,
        },
        "placeholder:5029": {
            "type": "glove",
            "def_index": 5029,
            "paint_index": 0,
            "is_placeholder": True,
        },
    }
    batch_items, _plan = build_batch_and_plan(STEAM_ID, [], replacements, originals=originals)
    by_source = {row["definition_index"]: row for row in batch_items}
    assert by_source[5028]["team"] == "T"
    assert by_source[5029]["team"] == "CT"


def test_build_batch_omits_replacement_definition_index_when_def_unchanged():
    inv = [inventory_row(item_id=1, type="melee", def_index=508)]
    repl = replacement(def_index=508, type="melee")
    batch_items, _plan = build_batch_and_plan(STEAM_ID, inv, {"id:1": repl})
    assert "replacement_definition_index" not in batch_items[0]


def test_build_batch_rejects_missing_slot():
    inv = [inventory_row(item_id=10, type="weapon", def_index=7)]
    with pytest.raises(CosmeticsSkinPlanError, match="slot"):
        build_batch_and_plan(STEAM_ID, inv, {"id:999": replacement(type="weapon", def_index=7)})


def test_build_batch_rejects_inventory_without_item_id_when_not_vanilla_slot():
    # Non-customizable path still needs a resolvable slot; item_id 0 on a normal
    # weapon row is now treated as vanilla (item_id64 "0"), not rejected.
    inv = [inventory_row(item_id=0, type="weapon", def_index=7, paint_index=1)]
    key = slot_key(inv[0])
    batch, _plan = build_batch_and_plan(
        STEAM_ID, inv, {key: replacement(type="weapon", def_index=7)}
    )
    assert batch[0]["item_id64"] == "0"
    assert batch[0]["definition_index"] == 7


def test_build_batch_rejects_non_customizable_types():
    inv = [
        inventory_row(item_id=5, type="agent", def_index=4736, paint_index=0),
        inventory_row(item_id=6, type="musickit", def_index=1314, paint_index=76),
    ]
    with pytest.raises(CosmeticsSkinPlanError, match="type"):
        build_batch_and_plan(
            STEAM_ID,
            inv,
            {"id:5": replacement(type="agent", def_index=4736)},
        )


def test_build_batch_rejects_empty_replacements():
    with pytest.raises(CosmeticsSkinPlanError, match="replacements"):
        build_batch_and_plan(STEAM_ID, [inventory_row()], {})


def test_build_batch_emits_zero_item_id64_for_vanilla_inventory():
    inv = [
        inventory_row(
            item_id=0,
            type="weapon",
            def_index=16,
            paint_index=0,
            paint_seed=0,
            paint_wear=0,
            model="m4a1",
            name_zh="M4A4",
        )
    ]
    key = slot_key(inv[0])
    repl = replacement(
        type="weapon",
        def_index=16,
        paint_index=309,
        paint_seed=1,
        paint_wear=0.01,
        name_zh="M4A4 | 龙王",
    )
    batch, plan = build_batch_and_plan(STEAM_ID, inv, {key: repl})
    assert batch[0]["item_id64"] == "0"
    assert batch[0]["definition_index"] == 16
    assert plan["items"][0]["slot_key"] == key


def test_build_batch_accepts_placeholder_melee_without_inventory_row():
    repl = replacement(
        catalog_id=1345,
        type="melee",
        def_index=507,
        paint_index=418,
        paint_seed=1,
        paint_wear=0.01,
    )
    originals = {
        "placeholder:59": {
            "def_index": 59,
            "paint_index": 0,
            "type": "melee",
            "name_zh": "默认刀",
            "model": "knife_t",
        }
    }
    batch, plan = build_batch_and_plan(
        STEAM_ID,
        [],
        {"placeholder:59": repl},
        originals=originals,
    )
    assert batch[0]["item_id64"] == "0"
    assert batch[0]["definition_index"] == 59
    assert batch[0].get("replacement_definition_index") == 507
    assert plan["items"][0]["original"]["name_zh"] == "默认刀"


def test_map_item_statuses_matches_zero_id_by_definition_index():
    from app.cosmetics_skin_plan import map_item_statuses

    plan = {
        "steamid": STEAM_ID,
        "items": [
            {
                "slot_key": "def:16:0:0:0",
                "original": {"def_index": 16, "name_zh": "M4A4", "item_id": None},
                "replacement": {
                    "def_index": 16,
                    "name_zh": "M4A4 | 龙王",
                    "paint_index": 309,
                },
            }
        ],
    }
    mapped = map_item_statuses(plan, [{"item_id64": "0", "definition_index": 16}])
    assert mapped[0]["slot_key"] == "def:16:0:0:0"
    assert mapped[0]["original_name_zh"] == "M4A4"


def test_build_batch_multiple_slots():
    inv = [
        inventory_row(item_id=10, type="weapon", def_index=7, paint_index=0, model="ak47"),
        inventory_row(item_id=11, type="melee", def_index=508, paint_index=415),
    ]
    replacements = {
        "id:10": replacement(type="weapon", def_index=7, paint_index=340, paint_seed=3, paint_wear=0.2),
        "id:11": replacement(type="melee", def_index=508, paint_index=418, paint_seed=9, paint_wear=0.05),
    }
    batch_items, plan = build_batch_and_plan(STEAM_ID, inv, replacements)
    assert len(batch_items) == 2
    assert {row["item_id64"] for row in batch_items} == {"10", "11"}
    assert len(plan["items"]) == 2


def test_shared_item_id_builds_independent_t_ct_pawn_rules():
    inv = [inventory_row(item_id=53009600926, observed_teams=["t", "ct"])]
    replacements = {
        "t:id:53009600926": replacement(paint_seed=12, paint_wear=0.01),
        "ct:id:53009600926": replacement(paint_seed=99, paint_wear=0.02),
    }
    originals = {
        "t:id:53009600926": inventory_row(
            item_id=53009600926, observed_teams=["t"]
        ),
        "ct:id:53009600926": inventory_row(
            item_id=53009600926, observed_teams=["ct"]
        ),
    }

    batch, plan = build_batch_and_plan(
        STEAM_ID, inv, replacements, originals=originals
    )

    assert [(row["team"], row["pattern_seed"]) for row in batch] == [
        ("T", 12.0),
        ("CT", 99.0),
    ]
    assert [entry["slot_key"] for entry in plan["items"]] == [
        "t:id:53009600926",
        "ct:id:53009600926",
    ]
    assert plan["items"][0]["original"]["observed_teams"] == ["t"]
    assert plan["items"][1]["original"]["observed_teams"] == ["ct"]
    assert build_batch_from_plan_json(plan, inv) == batch


def test_scoped_slot_rejects_team_not_observed_for_item():
    inv = [inventory_row(item_id=10, observed_teams=["t"])]
    with pytest.raises(CosmeticsSkinPlanError, match="not observed for team CT"):
        build_batch_and_plan(
            STEAM_ID,
            inv,
            {"ct:id:10": replacement()},
        )


def test_status_and_partial_plan_match_same_item_id_by_team():
    inv = [inventory_row(item_id=10, observed_teams=["t", "ct"])]
    replacements = {
        "t:id:10": replacement(paint_seed=12),
        "ct:id:10": replacement(paint_seed=99),
    }
    originals = {
        "t:id:10": inventory_row(item_id=10, observed_teams=["t"]),
        "ct:id:10": inventory_row(item_id=10, observed_teams=["ct"]),
    }
    _, plan = build_batch_and_plan(
        STEAM_ID, inv, replacements, originals=originals
    )

    statuses = [{"item_id64": "10", "definition_index": 508, "team": "CT"}]
    mapped = map_item_statuses(plan, statuses)
    assert mapped[0]["slot_key"] == "ct:id:10"
    assert mapped[0]["team"] == "CT"

    filtered = filter_plan_by_succeeded_item_ids(
        plan, {"10"}, succeeded_rows=statuses
    )
    assert [entry["slot_key"] for entry in filtered["items"]] == ["ct:id:10"]


def test_build_batch_prefers_client_originals_for_plan_display():
    """After a prior rewrite, inventory is already the new skin — keep UI 原皮 from client."""
    inv = [
        inventory_row(
            item_id=10,
            type="weapon",
            def_index=7,
            paint_index=403,
            paint_seed=661,
            paint_wear=0.07,
            model="ak47",
            name_zh="AK-47 | 野荷",
            name_en="AK-47 | Wild Lotus",
            image_url="https://cdn.example/wild-lotus.webp",
        )
    ]
    repl = replacement(
        type="weapon",
        def_index=7,
        paint_index=403,
        paint_seed=661,
        paint_wear=0.07,
        name_zh="AK-47 | 野荷",
        name_en="AK-47 | Wild Lotus",
        image_url="https://cdn.example/wild-lotus.webp",
    )
    client_original = {
        "item_id": 10,
        "def_index": 7,
        "paint_index": 282,
        "paint_seed": 1,
        "paint_wear": 0.1,
        "name_zh": "AK-47 | 红线",
        "name_en": "AK-47 | Redline",
        "image_url": "https://cdn.example/redline.webp",
        "type": "weapon",
        "model": "ak47",
    }
    batch_items, plan = build_batch_and_plan(
        STEAM_ID,
        inv,
        {"id:10": repl},
        originals={"id:10": client_original},
    )
    assert batch_items[0]["paint_kit"] == 403
    assert batch_items[0]["item_id64"] == "10"
    entry = plan["items"][0]
    assert entry["original"]["name_zh"] == "AK-47 | 红线"
    assert entry["original"]["paint_index"] == 282
    assert entry["original"]["item_id"] == 10
    assert entry["replacement"]["name_zh"] == "AK-47 | 野荷"


def test_map_item_statuses_includes_original_and_replacement_names():
    from app.cosmetics_skin_plan import map_item_statuses

    inv = [
        inventory_row(
            item_id=10,
            type="weapon",
            def_index=7,
            paint_index=0,
            model="ak47",
            name_zh="AK原皮",
            name_en="AK Stock",
        )
    ]
    replacements = {
        "id:10": replacement(
            type="weapon",
            def_index=7,
            paint_index=340,
            name_zh="AK-47 | 红线",
            name_en="AK-47 | Redline",
        )
    }
    _, plan = build_batch_and_plan(STEAM_ID, inv, replacements)
    mapped = map_item_statuses(plan, [{"item_id64": "10", "definition_index": 7}])
    assert mapped[0]["original_name_zh"] == "AK原皮"
    assert mapped[0]["original_name_en"] == "AK Stock"
    assert mapped[0]["replacement_name_zh"] == "AK-47 | 红线"
    assert mapped[0]["replacement_name_en"] == "AK-47 | Redline"
    assert mapped[0]["name_zh"] == "AK-47 | 红线"
