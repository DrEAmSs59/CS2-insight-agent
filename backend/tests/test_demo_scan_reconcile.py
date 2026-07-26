import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.demo_db import DemoDB


def _run(coro):
    return asyncio.run(coro)


def test_reconcile_only_purges_rows_owned_by_scanned_root(tmp_path: Path):
    async def scenario():
        db = DemoDB(tmp_path / "demo.sqlite3")
        await db.init_db()
        root_a = str((tmp_path / "a").resolve())
        root_b = str((tmp_path / "b").resolve())
        kept_a = str((tmp_path / "a" / "kept.dem").resolve())
        missing_a = str((tmp_path / "a" / "missing.dem").resolve())
        kept_b = str((tmp_path / "b" / "kept.dem").resolve())
        manual = str((tmp_path / "manual.dem").resolve())

        await db.add_demo(kept_a, watch_root=root_a)
        await db.add_demo(missing_a, watch_root=root_a)
        await db.add_demo(kept_b, watch_root=root_b)
        await db.add_demo(manual)

        removed = await db.purge_deleted_demo_files(root_a, {kept_a})
        assert removed == 1
        assert await db.get_demo_by_path(kept_a) is not None
        assert await db.get_demo_by_path(missing_a) is None
        assert await db.get_demo_by_path(kept_b) is not None
        assert await db.get_demo_by_path(manual) is not None

    _run(scenario())


def test_empty_successful_scan_purges_only_that_root(tmp_path: Path):
    async def scenario():
        db = DemoDB(tmp_path / "demo.sqlite3")
        await db.init_db()
        root_a = str((tmp_path / "a").resolve())
        root_b = str((tmp_path / "b").resolve())
        path_a = str((tmp_path / "a" / "gone.dem").resolve())
        path_b = str((tmp_path / "b" / "kept.dem").resolve())
        await db.add_demo(path_a, watch_root=root_a)
        await db.add_demo(path_b, watch_root=root_b)

        assert await db.purge_deleted_demo_files(root_a, set()) == 1
        assert await db.get_demo_by_path(path_a) is None
        assert await db.get_demo_by_path(path_b) is not None

    _run(scenario())


def test_rediscovery_backfills_watch_root_for_legacy_row(tmp_path: Path):
    async def scenario():
        db = DemoDB(tmp_path / "demo.sqlite3")
        await db.init_db()
        root = str((tmp_path / "watch").resolve())
        demo_path = str((tmp_path / "watch" / "legacy.dem").resolve())
        demo_id, inserted = await db.add_demo(demo_path)
        assert inserted is True

        rediscovered_id, inserted = await db.add_demo(demo_path, watch_root=root)
        assert rediscovered_id == demo_id
        assert inserted is False
        assert await db.purge_deleted_demo_files(root, set()) == 1
        assert await db.get_demo_by_id(demo_id) is None

    _run(scenario())
