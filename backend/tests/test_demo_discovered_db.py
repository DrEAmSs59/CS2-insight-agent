import asyncio
from contextlib import closing
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.demo_db import DemoDB


def _run(coro):
    return asyncio.run(coro)


def test_discovered_page_preserves_duplicate_rules_and_pagination(tmp_path: Path):
    async def scenario():
        db = DemoDB(tmp_path / "discovered.sqlite3")
        await db.init_db()

        keep_path = str(tmp_path / "CaseSensitive.dem")
        keep_id, _ = await db.add_demo(keep_path, content_md5="hash-keep")
        await db.add_demo(keep_path.lower(), content_md5="hash-other")

        await db.add_demo(str(tmp_path / "library" / "same-name.dem"), status="loaded")
        await db.add_demo(str(tmp_path / "incoming" / "same-name.dem"))

        await db.add_demo(str(tmp_path / "library" / "by-hash.dem"), status="done", content_md5="shared-hash")
        await db.add_demo(str(tmp_path / "incoming" / "other-name.dem"), content_md5="shared-hash")

        whitespace_one, _ = await db.add_demo(str(tmp_path / "blank-one.dem"), content_md5="   ")
        whitespace_two, _ = await db.add_demo(str(tmp_path / "blank-two.dem"), content_md5="   ")
        searchable_id, _ = await db.add_demo(str(tmp_path / "search-target.dem"), content_md5="unique-hash")

        rows, total = await db.list_discovered_page(limit=2, offset=0)
        assert total == 4
        assert [row["id"] for row in rows] == [searchable_id, whitespace_two]

        next_rows, next_total = await db.list_discovered_page(limit=2, offset=2)
        assert next_total == total
        assert [row["id"] for row in next_rows] == [whitespace_one, keep_id]

        search_rows, search_total = await db.list_discovered_page(name_query="TARGET")
        assert search_total == 1
        assert [row["id"] for row in search_rows] == [searchable_id]

    _run(scenario())


def test_discovered_query_uses_dedicated_indexes(tmp_path: Path):
    async def initialize():
        db = DemoDB(tmp_path / "plan.sqlite3")
        await db.init_db()
        return db

    db = _run(initialize())
    sql = (
        "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM demo_files d "
        "WHERE d.status = 'pending'"
        + db._discovered_not_already_in_library_sql("d")
    )
    with closing(sqlite3.connect(db.db_path)) as conn:
        details = "\n".join(str(row[3]) for row in conn.execute(sql))

    assert "idx_demo_files_status_id" in details
    assert "idx_demo_files_path_nocase" in details
    assert "idx_demo_files_filename_nocase" in details
    assert "idx_demo_files_content_md5" in details
