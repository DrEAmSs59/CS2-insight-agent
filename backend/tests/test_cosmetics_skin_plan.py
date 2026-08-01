# ---------------------------------------------------------------------------------------------
# Copyright (c) unicbm. All rights reserved.
# Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
# ---------------------------------------------------------------------------------------------

"""Map CosmeticsView replacements → skin-core batch items + plan_json."""

from __future__ import annotations

import pytest

from app.cosmetics_skin_plan import CosmeticsSkinPlanError, build_batch_and_plan, slot_key

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
        "catalog_id": 2002,
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


def test_build_batch_sets_replacement_definition_index_for_cross_model_melee():
    inv = [inventory_row(item_id=53009600926, type="melee", def_index=508)]
    repl = replacement(def_index=507, type="melee")  # different knife model
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
        )
    ]
    repl = replacement(type="glove", def_index=5030, paint_index=10038, model="specialist_gloves")
    batch_items, _plan = build_batch_and_plan(STEAM_ID, inv, {"id:99": repl})
    assert batch_items[0]["replacement_definition_index"] == 5030
    assert batch_items[0]["definition_index"] == 5027


def test_build_batch_omits_replacement_definition_index_when_def_unchanged():
    inv = [inventory_row(item_id=1, type="melee", def_index=508)]
    repl = replacement(def_index=508, type="melee")
    batch_items, _plan = build_batch_and_plan(STEAM_ID, inv, {"id:1": repl})
    assert "replacement_definition_index" not in batch_items[0]


def test_build_batch_rejects_missing_slot():
    inv = [inventory_row(item_id=10, type="weapon", def_index=7)]
    with pytest.raises(CosmeticsSkinPlanError, match="slot"):
        build_batch_and_plan(STEAM_ID, inv, {"id:999": replacement(type="weapon", def_index=7)})


def test_build_batch_rejects_inventory_without_item_id():
    inv = [inventory_row(item_id=0, type="weapon", def_index=7, paint_index=1)]
    key = slot_key(inv[0])
    with pytest.raises(CosmeticsSkinPlanError, match="item_id"):
        build_batch_and_plan(STEAM_ID, inv, {key: replacement(type="weapon", def_index=7)})


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
