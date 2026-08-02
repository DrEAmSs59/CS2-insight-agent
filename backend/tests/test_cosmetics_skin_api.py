# ---------------------------------------------------------------------------------------------
# Copyright (c) unicbm. All rights reserved.
# Licensed under the PolyForm Noncommercial License 1.0.0. See LICENSE in the project root for license information.
# ---------------------------------------------------------------------------------------------

"""HTTP API for cosmetics custom-plan (mocked skin-core)."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import cosmetics_skin
from app.demo_db import DemoDB
from app.skin_core_client import SkinCoreError


STEAM_ID = "76561198000000001"


def _inventory_row(**overrides):
    row = {
        "catalog_id": 3001,
        "def_index": 7,
        "paint_index": 0,
        "paint_seed": 1,
        "paint_wear": 0.1,
        "item_id": 10,
        "type": "weapon",
        "model": "ak47",
        "name_en": "AK-47",
        "name_zh": "AK原皮",
        "image_url": "https://cdn.example/ak.webp",
    }
    row.update(overrides)
    return row


def _replacement(**overrides):
    row = {
        "catalog_id": 4797,
        "def_index": 7,
        "paint_index": 340,
        "paint_wear": 0.01,
        "paint_seed": 12,
        "type": "weapon",
        "model": "ak47",
        "name_en": "AK-47 | Redline",
        "name_zh": "AK-47 | 红线",
        "image_url": "https://cdn.example/redline.webp",
    }
    row.update(overrides)
    return row


@pytest.fixture
def api_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    db = DemoDB(tmp_path / "skin_api.sqlite3")
    asyncio.run(db.init_db())

    original = tmp_path / "library" / "match.dem"
    original.parent.mkdir(parents=True)
    original.write_bytes(b"ORIGINAL-DEMO")
    cache_root = tmp_path / "cache"
    cache_root.mkdir()
    cached = cache_root / "match-cached.dem"
    cached.write_bytes(b"CACHED-DEMO")

    demo_id = asyncio.run(
        db.add_demo(
            str(original),
            status="done",
            content_md5="aabbccddeeff0011",
        )
    )[0]
    asyncio.run(db.update_cached_path(str(original), str(cached)))
    asyncio.run(
        db.save_result(
            str(original),
            {
                "analysis_workspace": {
                    "cosmetics": {
                        "players": {
                            STEAM_ID: [_inventory_row()],
                        }
                    }
                }
            },
        )
    )

    monkeypatch.setattr(cosmetics_skin, "demo_db", db)
    monkeypatch.setattr(
        cosmetics_skin,
        "ensure_demo_compatible",
        lambda path: type("R", (), {"cached": True, "path": path})(),
    )

    app = FastAPI()
    app.include_router(cosmetics_skin.router)
    client = TestClient(app)
    return {
        "client": client,
        "db": db,
        "demo_id": demo_id,
        "original": original,
        "cached": cached,
    }


def test_get_custom_plan_returns_null_when_missing(api_env):
    client = api_env["client"]
    demo_id = api_env["demo_id"]

    response = client.get(
        f"/api/demos/{demo_id}/cosmetics/custom-plan",
        params={"steamid": STEAM_ID},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["plan"] is None


def test_post_custom_plan_rewrites_cache_only_and_persists_plan(api_env, monkeypatch):
    client = api_env["client"]
    demo_id = api_env["demo_id"]
    cached: Path = api_env["cached"]
    original: Path = api_env["original"]
    original_bytes = original.read_bytes()
    cached_before = cached.read_bytes()

    def fake_rewrite(*, input_dem, output_dem, steam_id64, items, demoparser2_python, timeout=120.0):
        input_path = Path(input_dem).resolve()
        assert input_path != cached.resolve()
        assert input_path.parent == cached.parent
        assert input_path.read_bytes() == original_bytes
        assert Path(output_dem).resolve() != cached.resolve()
        assert Path(output_dem).parent == cached.parent
        assert not Path(output_dem).exists()
        assert steam_id64 == STEAM_ID
        assert items[0]["item_id64"] == "10"
        assert items[0]["paint_kit"] == 340
        Path(output_dem).write_bytes(b"REWRITTEN-DEMO")
        return {"ok": True, "sha256": "deadbeef", "items_rewritten": 1}

    monkeypatch.setattr(cosmetics_skin, "run_rewrite_owned_batch", fake_rewrite)

    response = client.post(
        f"/api/demos/{demo_id}/cosmetics/custom-plan",
        json={
            "steamid": STEAM_ID,
            "replacements": {"id:10": _replacement()},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["demo_id"] == demo_id
    assert Path(body["cached_path"]).resolve() == cached.resolve()
    assert body["output_sha256"] == "deadbeef"
    assert body["plan"]["steamid"] == STEAM_ID
    assert body["plan"]["items"][0]["slot_key"] == "id:10"
    assert body["plan"]["items"][0]["replacement"]["paint_index"] == 340

    assert cached.read_bytes() == b"REWRITTEN-DEMO"
    assert original.read_bytes() == original_bytes
    assert cached_before != cached.read_bytes()

    stored = asyncio.run(
        api_env["db"].get_custom_skin_plan(str(original), STEAM_ID)
    )
    assert stored is not None
    assert stored["plan_json"]["items"][0]["slot_key"] == "id:10"
    assert stored["output_sha256"] == "deadbeef"

    import hashlib

    expected_md5 = hashlib.md5(b"REWRITTEN-DEMO").hexdigest()
    row = asyncio.run(api_env["db"].get_demo_by_id(demo_id))
    assert row["content_md5"] == expected_md5


def test_post_custom_plan_restores_cache_from_original_before_rewrite(api_env, monkeypatch):
    client = api_env["client"]
    demo_id = api_env["demo_id"]
    cached: Path = api_env["cached"]
    original: Path = api_env["original"]
    # Pollute cache so a naive reuse would feed rewritten bytes.
    cached.write_bytes(b"ALREADY-REWRITTEN-CACHE")
    seen = {}

    def capture_rewrite(*, input_dem, output_dem, steam_id64, items, demoparser2_python, timeout=120.0):
        input_path = Path(input_dem).resolve()
        seen["input_bytes"] = input_path.read_bytes()
        seen["input_path"] = input_path
        Path(output_dem).write_bytes(b"FRESH-REWRITE")
        return {
            "ok": True,
            "sha256": "abc",
            "items_rewritten": 1,
            "succeeded": [{"item_id64": "10", "definition_index": 7}],
            "failed": [],
        }

    monkeypatch.setattr(cosmetics_skin, "run_rewrite_owned_batch", capture_rewrite)
    response = client.post(
        f"/api/demos/{demo_id}/cosmetics/custom-plan",
        json={"steamid": STEAM_ID, "replacements": {"id:10": _replacement()}},
    )
    assert response.status_code == 200
    assert seen["input_bytes"] == original.read_bytes()
    assert seen["input_bytes"] != b"ALREADY-REWRITTEN-CACHE"
    assert seen["input_path"] != cached.resolve()
    assert cached.read_bytes() == b"FRESH-REWRITE"
    # Temp input must not linger after success.
    assert not seen["input_path"].exists()


def test_post_leaves_cache_untouched_on_skin_core_failure(api_env, monkeypatch):
    client = api_env["client"]
    demo_id = api_env["demo_id"]
    cached: Path = api_env["cached"]
    prior = b"PREVIOUSLY-REWRITTEN"
    cached.write_bytes(prior)

    def boom(*, input_dem, output_dem, steam_id64, items, demoparser2_python, timeout=120.0):
        raise SkinCoreError("auth failed")

    monkeypatch.setattr(cosmetics_skin, "run_rewrite_owned_batch", boom)

    response = client.post(
        f"/api/demos/{demo_id}/cosmetics/custom-plan",
        json={"steamid": STEAM_ID, "replacements": {"id:10": _replacement()}},
    )

    assert response.status_code == 502
    assert "auth failed" in str(response.json()["detail"])
    # Prior rewritten cache must survive skin-core failure (no pre-rewrite overwrite).
    assert cached.read_bytes() == prior
    assert asyncio.run(api_env["db"].get_custom_skin_plan(str(api_env["original"]), STEAM_ID)) is None


def test_post_missing_ok_does_not_replace_cache(api_env, monkeypatch):
    """Fail-closed: response without explicit ok:true must not os.replace the cache."""
    client = api_env["client"]
    demo_id = api_env["demo_id"]
    cached: Path = api_env["cached"]
    prior = b"PREVIOUSLY-REWRITTEN"
    cached.write_bytes(prior)

    def missing_ok(*, input_dem, output_dem, steam_id64, items, demoparser2_python, timeout=120.0):
        Path(output_dem).write_bytes(b"SHOULD-NOT-REPLACE")
        return {"sha256": "nope", "items_rewritten": 1}

    monkeypatch.setattr(cosmetics_skin, "run_rewrite_owned_batch", missing_ok)

    response = client.post(
        f"/api/demos/{demo_id}/cosmetics/custom-plan",
        json={"steamid": STEAM_ID, "replacements": {"id:10": _replacement()}},
    )

    assert response.status_code == 502
    assert cached.read_bytes() == prior
    assert cached.read_bytes() != b"SHOULD-NOT-REPLACE"
    assert asyncio.run(api_env["db"].get_custom_skin_plan(str(api_env["original"]), STEAM_ID)) is None


def test_post_ok_false_surfaces_error_message(api_env, monkeypatch):
    client = api_env["client"]
    demo_id = api_env["demo_id"]
    cached: Path = api_env["cached"]
    prior = b"PREVIOUSLY-REWRITTEN"
    cached.write_bytes(prior)

    def ok_false(*, input_dem, output_dem, steam_id64, items, demoparser2_python, timeout=120.0):
        Path(output_dem).write_bytes(b"PARTIAL-OUTPUT")
        return {
            "ok": False,
            "error_code": "OWNERSHIP_MISMATCH",
            "error_message": "item not owned by steamid",
        }

    monkeypatch.setattr(cosmetics_skin, "run_rewrite_owned_batch", ok_false)

    response = client.post(
        f"/api/demos/{demo_id}/cosmetics/custom-plan",
        json={"steamid": STEAM_ID, "replacements": {"id:10": _replacement()}},
    )

    assert response.status_code == 502
    detail = str(response.json()["detail"])
    assert "item not owned by steamid" in detail
    assert "OWNERSHIP_MISMATCH" in detail
    assert cached.read_bytes() == prior
    assert cached.read_bytes() != b"PARTIAL-OUTPUT"
    assert asyncio.run(api_env["db"].get_custom_skin_plan(str(api_env["original"]), STEAM_ID)) is None


def test_get_custom_plan_returns_persisted_plan(api_env, monkeypatch):
    client = api_env["client"]
    demo_id = api_env["demo_id"]

    def fake_rewrite(*, input_dem, output_dem, steam_id64, items, demoparser2_python, timeout=120.0):
        Path(output_dem).write_bytes(b"REWRITTEN-DEMO")
        return {"ok": True, "sha256": "abc123", "items_rewritten": 1}

    monkeypatch.setattr(cosmetics_skin, "run_rewrite_owned_batch", fake_rewrite)
    client.post(
        f"/api/demos/{demo_id}/cosmetics/custom-plan",
        json={"steamid": STEAM_ID, "replacements": {"id:10": _replacement()}},
    )

    response = client.get(
        f"/api/demos/{demo_id}/cosmetics/custom-plan",
        params={"steamid": STEAM_ID},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["plan"]["items"][0]["replacement"]["name_zh"] == "AK-47 | 红线"
    assert body["output_sha256"] == "abc123"


def test_post_partial_success_writes_cache_and_returns_item_results(api_env, monkeypatch):
    client = api_env["client"]
    demo_id = api_env["demo_id"]
    cached: Path = api_env["cached"]
    db = api_env["db"]
    original = api_env["original"]

    asyncio.run(
        db.save_result(
            str(original),
            {
                "analysis_workspace": {
                    "cosmetics": {
                        "players": {
                            STEAM_ID: [
                                _inventory_row(item_id=10),
                                _inventory_row(
                                    item_id=11,
                                    type="melee",
                                    def_index=507,
                                    model="knife_karambit",
                                    name_zh="爪子刀",
                                    name_en="Karambit",
                                ),
                            ]
                        }
                    }
                }
            },
        )
    )

    def partial_rewrite(*, input_dem, output_dem, steam_id64, items, demoparser2_python, timeout=120.0):
        Path(output_dem).write_bytes(b"PARTIAL-OK")
        return {
            "ok": True,
            "sha256": "partialsha",
            "items_rewritten": 1,
            "succeeded": [{"item_id64": "10", "definition_index": 7}],
            "failed": [
                {
                    "item_id64": "11",
                    "definition_index": 507,
                    "error": "need a donor knife",
                }
            ],
        }

    monkeypatch.setattr(cosmetics_skin, "run_rewrite_owned_batch", partial_rewrite)

    response = client.post(
        f"/api/demos/{demo_id}/cosmetics/custom-plan",
        json={
            "steamid": STEAM_ID,
            "replacements": {
                "id:10": _replacement(),
                "id:11": _replacement(
                    type="melee",
                    def_index=500,
                    paint_index=415,
                    model="bayonet",
                    name_zh="刺刀 | 多普勒",
                    name_en="Bayonet | Doppler",
                ),
            },
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["partial"] is True
    assert cached.read_bytes() == b"PARTIAL-OK"
    assert len(body["plan"]["items"]) == 1
    assert body["plan"]["items"][0]["slot_key"] == "id:10"
    assert body["succeeded"][0]["slot_key"] == "id:10"
    assert body["succeeded"][0]["original_name_zh"] == "AK原皮"
    assert body["succeeded"][0]["replacement_name_zh"] == "AK-47 | 红线"
    assert body["failed"][0]["slot_key"] == "id:11"
    assert "donor" in body["failed"][0]["error"]

    stored = asyncio.run(db.get_custom_skin_plan(str(original), STEAM_ID))
    assert stored is not None
    assert len(stored["plan_json"]["items"]) == 1


def test_post_all_items_soft_failed_returns_200_without_cache_write(api_env, monkeypatch):
    client = api_env["client"]
    demo_id = api_env["demo_id"]
    cached: Path = api_env["cached"]
    prior = b"PREVIOUSLY-REWRITTEN"
    cached.write_bytes(prior)

    def all_failed(*, input_dem, output_dem, steam_id64, items, demoparser2_python, timeout=120.0):
        return {
            "ok": False,
            "items_rewritten": 0,
            "succeeded": [],
            "failed": [
                {
                    "item_id64": "10",
                    "definition_index": 7,
                    "error": "the requested Econ item is not owned",
                }
            ],
            "error_code": "validate",
            "error_message": "all 1 items failed validation/ownership",
        }

    monkeypatch.setattr(cosmetics_skin, "run_rewrite_owned_batch", all_failed)

    response = client.post(
        f"/api/demos/{demo_id}/cosmetics/custom-plan",
        json={"steamid": STEAM_ID, "replacements": {"id:10": _replacement()}},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["plan"] is None
    assert body["failed"][0]["slot_key"] == "id:10"
    # Soft-fail must leave prior rewritten cache untouched.
    assert cached.read_bytes() == prior
    assert asyncio.run(api_env["db"].get_custom_skin_plan(str(api_env["original"]), STEAM_ID)) is None


def test_post_rejects_invalid_slot_without_calling_skin_core(api_env, monkeypatch):
    client = api_env["client"]
    demo_id = api_env["demo_id"]
    cached: Path = api_env["cached"]
    prior = b"PREVIOUSLY-REWRITTEN"
    cached.write_bytes(prior)
    called = {"n": 0}

    def should_not_run(**_kwargs):
        called["n"] += 1
        raise AssertionError("skin-core must not run on mapping failure")

    monkeypatch.setattr(cosmetics_skin, "run_rewrite_owned_batch", should_not_run)

    response = client.post(
        f"/api/demos/{demo_id}/cosmetics/custom-plan",
        json={"steamid": STEAM_ID, "replacements": {"id:999": _replacement()}},
    )

    assert response.status_code == 400
    assert "slot" in str(response.json()["detail"]).lower()
    assert called["n"] == 0
    # Mapping runs before temp input; prior cache must stay unchanged.
    assert cached.read_bytes() == prior


def test_post_second_player_reapplies_first_player_plan(api_env, monkeypatch):
    """Saving player B must chain-rewrite from original through player A's plan."""
    client = api_env["client"]
    demo_id = api_env["demo_id"]
    cached: Path = api_env["cached"]
    original: Path = api_env["original"]
    db = api_env["db"]
    steam_a = STEAM_ID
    steam_b = "76561198000000002"
    original_bytes = original.read_bytes()

    asyncio.run(
        db.save_result(
            str(original),
            {
                "analysis_workspace": {
                    "cosmetics": {
                        "players": {
                            steam_a: [_inventory_row(item_id=10)],
                            steam_b: [_inventory_row(item_id=20, catalog_id=3002)],
                        }
                    }
                }
            },
        )
    )
    asyncio.run(
        db.upsert_custom_skin_plan(
            str(original),
            steam_a,
            {
                "steamid": steam_a,
                "items": [
                    {
                        "slot_key": "id:10",
                        "original": _inventory_row(item_id=10),
                        "replacement": _replacement(paint_index=340),
                    }
                ],
            },
            output_sha256="aaa",
        )
    )

    calls: list[dict] = []

    def fake_rewrite(*, input_dem, output_dem, steam_id64, items, demoparser2_python, timeout=120.0):
        payload = Path(input_dem).read_bytes()
        calls.append(
            {
                "steam_id64": steam_id64,
                "input_bytes": payload,
                "item_id64": items[0]["item_id64"],
                "paint_kit": items[0]["paint_kit"],
            }
        )
        if steam_id64 == steam_a:
            assert payload == original_bytes
            Path(output_dem).write_bytes(b"AFTER-A")
        else:
            assert payload == b"AFTER-A"
            Path(output_dem).write_bytes(b"AFTER-A-THEN-B")
        return {"ok": True, "sha256": f"sha-{steam_id64[-1]}", "items_rewritten": 1}

    monkeypatch.setattr(cosmetics_skin, "run_rewrite_owned_batch", fake_rewrite)

    response = client.post(
        f"/api/demos/{demo_id}/cosmetics/custom-plan",
        json={
            "steamid": steam_b,
            "replacements": {"id:20": _replacement(paint_index=455)},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["plan"]["steamid"] == steam_b
    assert len(calls) == 2
    assert calls[0]["steam_id64"] == steam_a
    assert calls[0]["item_id64"] == "10"
    assert calls[0]["paint_kit"] == 340
    assert calls[1]["steam_id64"] == steam_b
    assert calls[1]["item_id64"] == "20"
    assert calls[1]["paint_kit"] == 455
    assert cached.read_bytes() == b"AFTER-A-THEN-B"
    assert original.read_bytes() == original_bytes
    # Player A's plan must remain stored.
    stored_a = asyncio.run(db.get_custom_skin_plan(str(original), steam_a))
    assert stored_a is not None
    assert stored_a["plan_json"]["items"][0]["slot_key"] == "id:10"
    stored_b = asyncio.run(db.get_custom_skin_plan(str(original), steam_b))
    assert stored_b is not None
    assert stored_b["plan_json"]["items"][0]["slot_key"] == "id:20"


def test_post_unknown_demo_returns_404(api_env):
    response = api_env["client"].post(
        "/api/demos/999999/cosmetics/custom-plan",
        json={"steamid": STEAM_ID, "replacements": {"id:10": _replacement()}},
    )
    assert response.status_code == 404


def test_get_unknown_demo_returns_404(api_env):
    response = api_env["client"].get(
        "/api/demos/999999/cosmetics/custom-plan",
        params={"steamid": STEAM_ID},
    )
    assert response.status_code == 404


def test_post_calls_ensure_demo_compatible_before_rewrite(api_env, monkeypatch):
    order: list[str] = []

    def fake_compat(path):
        order.append("compat")
        return type("R", (), {"cached": False, "path": path})()

    def fake_rewrite(*, input_dem, output_dem, steam_id64, items, demoparser2_python, timeout=120.0):
        order.append("rewrite")
        Path(output_dem).write_bytes(b"OUT")
        return {"ok": True, "sha256": "x", "items_rewritten": 1}

    monkeypatch.setattr(cosmetics_skin, "ensure_demo_compatible", fake_compat)
    monkeypatch.setattr(cosmetics_skin, "run_rewrite_owned_batch", fake_rewrite)

    response = api_env["client"].post(
        f"/api/demos/{api_env['demo_id']}/cosmetics/custom-plan",
        json={"steamid": STEAM_ID, "replacements": {"id:10": _replacement()}},
    )
    assert response.status_code == 200
    assert order == ["compat", "rewrite"]
