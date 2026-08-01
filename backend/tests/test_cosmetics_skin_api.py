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
        assert Path(input_dem).resolve() == cached.resolve()
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


def test_post_leaves_cache_untouched_on_skin_core_failure(api_env, monkeypatch):
    client = api_env["client"]
    demo_id = api_env["demo_id"]
    cached: Path = api_env["cached"]
    before = cached.read_bytes()

    def boom(*, input_dem, output_dem, steam_id64, items, demoparser2_python, timeout=120.0):
        raise SkinCoreError("auth failed")

    monkeypatch.setattr(cosmetics_skin, "run_rewrite_owned_batch", boom)

    response = client.post(
        f"/api/demos/{demo_id}/cosmetics/custom-plan",
        json={"steamid": STEAM_ID, "replacements": {"id:10": _replacement()}},
    )

    assert response.status_code == 502
    assert "auth failed" in str(response.json()["detail"])
    assert cached.read_bytes() == before
    assert asyncio.run(api_env["db"].get_custom_skin_plan(str(api_env["original"]), STEAM_ID)) is None


def test_post_rejects_invalid_slot_without_calling_skin_core(api_env, monkeypatch):
    client = api_env["client"]
    demo_id = api_env["demo_id"]
    cached: Path = api_env["cached"]
    before = cached.read_bytes()
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
    assert cached.read_bytes() == before


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
