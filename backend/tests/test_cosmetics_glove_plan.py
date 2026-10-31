"""Official-demo default-glove replacements and restoration to the original."""

import asyncio
from pathlib import Path

from app.api import cosmetics_skin
from app.cosmetics_skin_plan import build_batch_and_plan, build_batch_from_plan_json
from test_cosmetics_skin_api import STEAM_ID, _replacement, api_env


def glove_request(*, painted):
    originals, replacements = {}, {}
    for team, definition, catalog in [("ct", 5029, 1718), ("t", 5028, 1722)]:
        key = f"{team}:placeholder:{definition}"
        original = {"type": "glove", "def_index": definition, "paint_index": 0,
                    "paint_seed": 0, "paint_wear": 0, "observed_teams": [team], "is_placeholder": True}
        originals[key] = original
        replacements[key] = ({"type": "glove", "catalog_id": catalog, "def_index": 5030,
                              "paint_index": 10038 if team == "ct" else 10048,
                              "paint_seed": 661, "paint_wear": .12} if painted else dict(original))
    return {"steamid": STEAM_ID, "replacements": replacements, "originals": originals}


def test_official_default_gloves_build_painted_side_rules():
    batch, plan = build_batch_and_plan(inventory_rows=[], **glove_request(painted=True))
    assert [(row["definition_index"], row["replacement_definition_index"], row["team"], row["paint_kit"])
            for row in batch] == [(5029, 5030, "CT", 10038), (5028, 5030, "T", 10048)]
    assert all(row["item_id64"] == "0" and "attachments" not in row for row in batch)
    assert build_batch_from_plan_json(plan, []) == batch


def test_default_glove_restore_does_not_send_paint_zero_to_core():
    batch, plan = build_batch_and_plan(inventory_rows=[], **glove_request(painted=False))
    assert batch == []
    assert plan == {"steamid": STEAM_ID, "items": []}


def test_api_replaces_default_gloves_then_restores_original_without_native_noop(api_env, monkeypatch):
    calls = []

    def rewrite(*, input_dem, output_dem, items, **kwargs):
        assert Path(input_dem).read_bytes() == b"ORIGINAL-DEMO"
        assert len(items) == 2
        assert [row["paint_kit"] for row in items] == [10038, 10048]
        assert all("attachments" not in row for row in items)
        calls.append(items)
        Path(output_dem).write_bytes(b"PAINTED-GLOVES")
        return {"ok": True, "succeeded": [
            {key: item[key] for key in ["item_id64", "definition_index", "team"]} for item in items], "failed": []}

    monkeypatch.setattr(cosmetics_skin, "run_rewrite_owned_batch", rewrite)
    url = f"/api/demos/{api_env['demo_id']}/cosmetics/custom-plan"
    painted = api_env["client"].post(url, json=glove_request(painted=True))
    assert painted.status_code == 200, painted.text
    assert painted.json()["ok"] is True and painted.json()["failed"] == []
    assert len(painted.json()["plan"]["items"]) == 2
    assert api_env["cached"].read_bytes() == b"PAINTED-GLOVES"

    restored = api_env["client"].post(url, json=glove_request(painted=False))
    assert restored.status_code == 200, restored.text
    assert restored.json()["ok"] is True and restored.json()["plan"]["items"] == []
    assert api_env["cached"].read_bytes() == b"ORIGINAL-DEMO"
    assert len(calls) == 1
    saved = asyncio.run(api_env["db"].get_custom_skin_plan(str(api_env["original"]), STEAM_ID))
    assert saved["plan_json"]["items"] == []


def test_api_default_gloves_do_not_fail_other_scheme_items(api_env, monkeypatch):
    def rewrite(*, output_dem, items, **kwargs):
        assert len(items) == 1
        assert items[0]["item_id64"] == "10" and items[0]["paint_kit"] == 340
        Path(output_dem).write_bytes(b"SCHEME-WITH-STOCK-GLOVES")
        return {"ok": True, "items_rewritten": 1}

    monkeypatch.setattr(cosmetics_skin, "run_rewrite_owned_batch", rewrite)
    request = glove_request(painted=False)
    request["replacements"]["id:10"] = _replacement()
    response = api_env["client"].post(f"/api/demos/{api_env['demo_id']}/cosmetics/custom-plan", json=request)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["ok"] is True and result["partial"] is False and result["failed"] == []
    assert [entry["slot_key"] for entry in result["plan"]["items"]] == ["id:10"]
