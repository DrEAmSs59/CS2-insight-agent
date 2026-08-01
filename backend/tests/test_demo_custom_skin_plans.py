import asyncio
import json
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.demo_db import DemoDB


def _run(coro):
    return asyncio.run(coro)


def test_init_db_creates_demo_custom_skin_plans_table(tmp_path: Path):
    async def scenario():
        db = DemoDB(tmp_path / "skin_plans.sqlite3")
        await db.init_db()
        return db

    db = _run(scenario())
    with closing(sqlite3.connect(db.db_path)) as conn:
        cols = {
            str(row[1])
            for row in conn.execute("PRAGMA table_info(demo_custom_skin_plans)")
        }
        pk = [
            str(row[1])
            for row in conn.execute("PRAGMA table_info(demo_custom_skin_plans)")
            if int(row[5] or 0) > 0
        ]
    assert cols == {
        "demo_path",
        "steamid",
        "plan_json",
        "output_sha256",
        "updated_at",
    }
    assert pk == ["demo_path", "steamid"]


def test_upsert_and_get_custom_skin_plan_roundtrip(tmp_path: Path):
    async def scenario():
        db = DemoDB(tmp_path / "skin_plans.sqlite3")
        await db.init_db()
        plan = {"steamid": "76561198000000001", "items": [{"slot": "id:1", "paint_kit": 12}]}
        await db.upsert_custom_skin_plan(
            "/demos/match.dem",
            "76561198000000001",
            plan,
            output_sha256="abc123",
        )
        row = await db.get_custom_skin_plan("/demos/match.dem", "76561198000000001")
        assert row is not None
        assert row["demo_path"] == "/demos/match.dem"
        assert row["steamid"] == "76561198000000001"
        assert row["plan_json"] == plan
        assert row["output_sha256"] == "abc123"
        assert isinstance(row["updated_at"], str) and row["updated_at"]
        return db

    _run(scenario())


def test_upsert_custom_skin_plan_overwrites_same_primary_key(tmp_path: Path):
    async def scenario():
        db = DemoDB(tmp_path / "skin_plans.sqlite3")
        await db.init_db()
        await db.upsert_custom_skin_plan(
            "/demos/match.dem",
            "76561198000000001",
            {"v": 1},
            output_sha256="old",
        )
        await db.upsert_custom_skin_plan(
            "/demos/match.dem",
            "76561198000000001",
            {"v": 2},
            output_sha256="new",
        )
        row = await db.get_custom_skin_plan("/demos/match.dem", "76561198000000001")
        assert row is not None
        assert row["plan_json"] == {"v": 2}
        assert row["output_sha256"] == "new"
        with closing(sqlite3.connect(db.db_path)) as conn:
            count = conn.execute("SELECT COUNT(*) FROM demo_custom_skin_plans").fetchone()[0]
        assert count == 1

    _run(scenario())


def test_get_custom_skin_plan_returns_none_when_missing(tmp_path: Path):
    async def scenario():
        db = DemoDB(tmp_path / "skin_plans.sqlite3")
        await db.init_db()
        assert await db.get_custom_skin_plan("/demos/missing.dem", "76561198000000001") is None

    _run(scenario())


def test_delete_custom_skin_plans_for_demo_removes_all_steamids(tmp_path: Path):
    async def scenario():
        db = DemoDB(tmp_path / "skin_plans.sqlite3")
        await db.init_db()
        await db.upsert_custom_skin_plan("/demos/a.dem", "111", {"a": 1})
        await db.upsert_custom_skin_plan("/demos/a.dem", "222", {"a": 2})
        await db.upsert_custom_skin_plan("/demos/b.dem", "111", {"b": 1})
        removed = await db.delete_custom_skin_plans_for_demo("/demos/a.dem")
        assert removed == 2
        assert await db.get_custom_skin_plan("/demos/a.dem", "111") is None
        assert await db.get_custom_skin_plan("/demos/a.dem", "222") is None
        kept = await db.get_custom_skin_plan("/demos/b.dem", "111")
        assert kept is not None
        assert kept["plan_json"] == {"b": 1}

    _run(scenario())


def test_upsert_accepts_plan_json_string(tmp_path: Path):
    async def scenario():
        db = DemoDB(tmp_path / "skin_plans.sqlite3")
        await db.init_db()
        payload = {"items": []}
        await db.upsert_custom_skin_plan(
            "/demos/match.dem",
            "76561198000000001",
            json.dumps(payload),
            output_sha256=None,
        )
        row = await db.get_custom_skin_plan("/demos/match.dem", "76561198000000001")
        assert row is not None
        assert row["plan_json"] == payload
        assert row["output_sha256"] is None

    _run(scenario())
