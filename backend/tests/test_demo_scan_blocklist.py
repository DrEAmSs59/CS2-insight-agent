import asyncio
import sys
from pathlib import Path

import aiosqlite

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.demo_db import DemoDB


def _run(coro):
    return asyncio.run(coro)


def test_init_db_drops_legacy_scan_blocklist(tmp_path: Path):
    async def scenario():
        db_path = tmp_path / "demo.sqlite3"
        async with aiosqlite.connect(db_path) as conn:
            await conn.execute(
                """
                CREATE TABLE demo_scan_blocklist (
                    path TEXT PRIMARY KEY NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            await conn.execute(
                "INSERT INTO demo_scan_blocklist(path, created_at) VALUES (?, ?)",
                (str(tmp_path / "old.dem"), "2026-01-01T00:00:00+00:00"),
            )
            await conn.commit()

        db = DemoDB(db_path)
        await db.init_db()

        async with aiosqlite.connect(db_path) as conn:
            cur = await conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='demo_scan_blocklist'"
            )
            assert await cur.fetchone() is None
            cur = await conn.execute(
                "SELECT 1 FROM schema_migrations WHERE id = ? LIMIT 1",
                ("drop_scan_blocklist_v1",),
            )
            assert await cur.fetchone() is not None

        # Second init keeps the table gone and does not recreate it.
        await db.init_db()
        async with aiosqlite.connect(db_path) as conn:
            cur = await conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='demo_scan_blocklist'"
            )
            assert await cur.fetchone() is None

    _run(scenario())


def test_delete_demo_allows_rediscovery(tmp_path: Path):
    async def scenario():
        db = DemoDB(tmp_path / "demo.sqlite3")
        await db.init_db()
        dem = tmp_path / "match.dem"
        dem.write_bytes(b"dem")
        path = str(dem.resolve())
        demo_id, _ = await db.add_demo(path, status="loaded")
        assert await db.delete_demo(demo_id) is True
        assert await db.get_demo_by_path(path) is None
        new_id, inserted = await db.add_demo(path, status="pending")
        assert inserted is True
        assert new_id != demo_id

    _run(scenario())
