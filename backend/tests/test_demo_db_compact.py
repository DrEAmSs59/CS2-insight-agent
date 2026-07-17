import asyncio
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import aiosqlite

from app.demo_db import DemoDB


def _run(coro):
    return asyncio.run(coro)


async def _seed_demo(
    db: DemoDB,
    root: Path,
    name: str,
    *,
    player_name: str,
    kills: int,
    clip_count: int,
    status: str = "done",
    rounds: int = 24,
    duration_mins: float = 36.5,
    match_date: str = "2026-07-15T10:00:00Z",
    steam_id64: str = "76561198000000001",
    account_id: str = "39734273",
) -> int:
    demo_path = str(root / name)
    demo_id, inserted = await db.add_demo(
        demo_path,
        file_size=1024,
        source="Faceit",
        status=status,
    )
    assert inserted is True
    await db.update_lightweight_meta(
        demo_path,
        {
            "map_name": "de_mirage",
            "total_rounds": rounds,
            "team_a_score": 13,
            "team_b_score": 11,
            "team_a_name": "Alpha",
            "team_b_name": "Bravo",
            "duration_mins": duration_mins,
            "match_date": match_date,
        },
    )
    await db.replace_demo_player_stats(
        demo_id,
        demo_path,
        [
            {
                "name": player_name,
                "steam_id64": steam_id64,
                "account_id": account_id,
                "team_number": 2,
                "team_name": "Alpha",
                "kills": kills,
                "deaths": 10,
                "assists": 4,
            }
        ],
    )
    await db.save_result(
        demo_path,
        {
            "auto_target_player": player_name,
            "analyzed_target_players": [player_name, f"{player_name} teammate"],
            "players": {
                player_name: {"clips": []},
                f"{player_name} teammate": {"clips": []},
            },
            "clips": [
                {
                    "id": index,
                    "payload": "x" * 4096,
                    "category": "highlight",
                    "kill_count": 4 if index == 0 else 5,
                }
                for index in range(clip_count)
            ],
            "match_meta": {"target_player": player_name},
        },
    )
    return demo_id


def test_compact_list_uses_materialized_summary_and_two_selects(tmp_path: Path, monkeypatch):
    async def scenario():
        db = DemoDB(tmp_path / "compact.sqlite3")
        await db.init_db()
        ids = [
            await _seed_demo(
                db,
                tmp_path,
                f"match-{index}.dem",
                player_name=f"Player {index}",
                kills=20 + index,
                clip_count=index,
            )
            for index in range(1, 4)
        ]

        statements: list[str] = []
        original_execute = aiosqlite.Connection.execute

        def recording_execute(self, sql, parameters=None):
            statements.append(" ".join(str(sql).split()))
            return original_execute(self, sql, parameters)

        monkeypatch.setattr(aiosqlite.Connection, "execute", recording_execute)

        rows = await db.list_demos_compact(limit=20)

        assert [row["id"] for row in rows] == list(reversed(ids))
        assert rows[0]["has_result"] is True
        assert rows[0]["clip_count"] == 3
        assert rows[0]["primary_target"] == "Player 3"
        assert rows[0]["analyzed_targets"] == ["Player 3", "Player 3 teammate"]
        assert rows[0]["four_k_count"] == 1
        assert rows[0]["five_k_count"] == 2
        assert "result" not in rows[0]
        assert rows[0]["players"][0]["steam_id64"] == "76561198000000001"
        assert rows[0]["players"][0]["steamid64"] == "76561198000000001"
        assert rows[0]["players"][0]["team"] == 2

        select_statements = [sql for sql in statements if sql.upper().startswith("SELECT")]
        assert len(select_statements) == 2
        assert all("result_json" not in sql for sql in select_statements)

    _run(scenario())


def test_init_backfills_summary_for_legacy_match_results(tmp_path: Path):
    db_path = tmp_path / "legacy.sqlite3"
    demo_path = str(tmp_path / "legacy.dem")
    seed_db = DemoDB(db_path)
    _run(seed_db.init_db())
    _run(seed_db.add_demo(demo_path, status="done"))
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT INTO match_results(demo_path, result_json, created_at) VALUES (?, ?, ?)",
            (
                demo_path,
                json.dumps(
                    {
                        "auto_target_player": "Legacy",
                        "clips": [{"id": 1}, {"id": 2}],
                        "match_meta": {
                            "map_name": "de_ancient",
                            "total_rounds": 21,
                            "team_a_score": 13,
                            "team_b_score": 8,
                            "team_a_name": "Legacy A",
                            "team_b_name": "Legacy B",
                            "duration_mins": 31.5,
                            "match_date": "2026-01-01T08:00:00Z",
                        },
                    }
                ),
                "2026-01-01T00:00:00Z",
            ),
        )

    async def scenario():
        db = DemoDB(db_path)
        await db.init_db()
        rows = await db.list_demos_compact()
        assert len(rows) == 1
        assert rows[0]["has_result"] is True
        assert rows[0]["clip_count"] == 2
        assert rows[0]["primary_target"] == "Legacy"
        assert rows[0]["map_name"] == "de_ancient"
        assert rows[0]["total_rounds"] == 21
        assert rows[0]["team_a_score"] == 13
        assert rows[0]["team_b_score"] == 8

        await db.clear_result(demo_path)
        cleared = await db.list_demos_compact()
        assert cleared[0]["has_result"] is False
        assert cleared[0]["clip_count"] == 0
        assert cleared[0]["primary_target"] is None

    _run(scenario())


def test_init_preserves_legacy_parser_id_when_adding_user_id(tmp_path: Path):
    db_path = tmp_path / "legacy-roster.sqlite3"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE demo_player_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                demo_id INTEGER NOT NULL,
                demo_path TEXT NOT NULL,
                steam_id64 TEXT,
                steam_id TEXT,
                account_id TEXT,
                player_name TEXT NOT NULL,
                normalized_name TEXT,
                team_name TEXT,
                team_number INTEGER,
                kills INTEGER DEFAULT 0,
                deaths INTEGER DEFAULT 0,
                assists INTEGER DEFAULT 0,
                kd REAL DEFAULT 0,
                indexed_at TEXT NOT NULL
            )
            """
        )
        conn.executemany(
            """
            INSERT INTO demo_player_stats(
                demo_id, demo_path, steam_id64, steam_id, account_id,
                player_name, normalized_name, team_number, indexed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (1, "perfect.dem", None, None, "17", "Perfect", "perfect", 2, "old"),
                (
                    2,
                    "faceit.dem",
                    "76561198000000002",
                    None,
                    "21",
                    "Faceit",
                    "faceit",
                    3,
                    "old",
                ),
            ],
        )
        conn.commit()

    async def scenario():
        db = DemoDB(db_path)
        await db.init_db()
        perfect = (await db.list_demo_player_stats(1))[0]
        faceit = (await db.list_demo_player_stats(2))[0]
        assert perfect["user_id"] == "17"
        assert perfect["account_id"] is None
        assert faceit["user_id"] == "21"
        assert faceit["account_id"] == "39734274"
        # Legacy rows have no validity metadata and are lazily rebuilt before
        # they can be trusted as a parser cache.
        assert await db.get_demo_roster_cache(1) is None
        assert await db.get_demo_roster_cache(2) is None

    _run(scenario())


def test_filtered_ids_apply_player_stats_without_player_query(tmp_path: Path):
    async def scenario():
        db = DemoDB(tmp_path / "ids.sqlite3")
        await db.init_db()
        strong_id = await _seed_demo(
            db,
            tmp_path,
            "strong.dem",
            player_name="Alice",
            kills=25,
            clip_count=2,
        )
        quiet_id = await _seed_demo(
            db,
            tmp_path,
            "quiet.dem",
            player_name="Bob",
            kills=4,
            clip_count=0,
            rounds=12,
            duration_mins=18.0,
            match_date="2026-06-01T10:00:00Z",
            steam_id64="76561198000000002",
            account_id="39734274",
        )
        await _seed_demo(
            db,
            tmp_path,
            "pending.dem",
            player_name="Alice",
            kills=30,
            clip_count=1,
            status="pending",
        )

        filter_expectations = [
            ({"min_kills": 20}, [strong_id]),
            ({"player_query": "ali"}, [strong_id]),
            ({"steam_query": "00000001"}, [strong_id]),
            ({"steam_query": "39734274"}, [quiet_id]),
            ({"rounds_min": 20}, [strong_id]),
            ({"rounds_max": 20}, [quiet_id]),
            ({"duration_min": 30}, [strong_id]),
            ({"duration_max": 20}, [quiet_id]),
            ({"date_from": "2026-07-01"}, [strong_id]),
            ({"date_to": "2026-06-30"}, [quiet_id]),
        ]
        for filters, expected_ids in filter_expectations:
            assert await db.list_filtered_demo_ids(filters=filters) == expected_ids
            compact_rows = await db.list_demos_compact(filters=filters)
            assert [row["id"] for row in compact_rows] == expected_ids
        assert await db.list_filtered_demo_ids(name_query="strong") == [strong_id]

    _run(scenario())


def test_date_filter_accepts_browser_local_day_as_utc_bounds(tmp_path: Path):
    async def scenario():
        db = DemoDB(tmp_path / "timezone.sqlite3")
        await db.init_db()
        demo_id = await _seed_demo(
            db,
            tmp_path,
            "local-july-15.dem",
            player_name="Timezone",
            kills=12,
            clip_count=0,
            match_date="2026-07-14T16:30:00Z",
        )

        local_day_bounds = {
            "date_from": "2026-07-14T16:00:00.000Z",
            "date_to": "2026-07-15T15:59:59.999Z",
        }
        assert await db.list_filtered_demo_ids(filters=local_day_bounds) == [demo_id]
        assert await db.list_filtered_demo_ids(
            filters={"date_to": "2026-07-14"}
        ) == [demo_id]
        assert await db.list_filtered_demo_ids(
            filters={"date_from": "2026-07-15T16:00:00.000Z"}
        ) == []

    _run(scenario())


def test_batch_detail_preserves_full_result_and_avoids_player_n_plus_one(
    tmp_path: Path,
    monkeypatch,
):
    async def scenario():
        db = DemoDB(tmp_path / "batch.sqlite3")
        await db.init_db()
        first_id = await _seed_demo(
            db,
            tmp_path,
            "first.dem",
            player_name="First",
            kills=18,
            clip_count=1,
        )
        second_id = await _seed_demo(
            db,
            tmp_path,
            "second.dem",
            player_name="Second",
            kills=19,
            clip_count=2,
        )

        statements: list[str] = []
        original_execute = aiosqlite.Connection.execute

        def recording_execute(self, sql, parameters=None):
            statements.append(" ".join(str(sql).split()))
            return original_execute(self, sql, parameters)

        monkeypatch.setattr(aiosqlite.Connection, "execute", recording_execute)
        rows = await db.get_demo_list_items([first_id, second_id, first_id])

        assert [row["id"] for row in rows] == [first_id, second_id]
        assert len(rows[0]["result"]["clips"]) == 1
        assert len(rows[1]["result"]["clips"]) == 2
        assert rows[0]["players"][0]["player_name"] == "First"
        assert rows[0]["players"][0]["account_id"] == "39734273"

        select_statements = [sql for sql in statements if sql.upper().startswith("SELECT")]
        assert len(select_statements) == 2

        statements.clear()
        single = await db.get_demo_list_item(second_id)
        assert single is not None
        assert single["result"]["auto_target_player"] == "Second"
        assert single["players"][0]["steamid64"] == "76561198000000001"

    _run(scenario())


def test_batch_detail_isolates_corrupt_result_json(tmp_path: Path):
    async def scenario():
        db = DemoDB(tmp_path / "corrupt.sqlite3")
        await db.init_db()
        demo_id = await _seed_demo(
            db,
            tmp_path,
            "corrupt.dem",
            player_name="Corrupt",
            kills=1,
            clip_count=1,
        )
        async with aiosqlite.connect(db.db_path) as conn:
            await conn.execute(
                "UPDATE match_results SET result_json = ? WHERE demo_path = ?",
                ("{not-json", str(tmp_path / "corrupt.dem")),
            )
            await conn.commit()

        rows = await db.get_demo_list_items([demo_id])
        assert len(rows) == 1
        assert rows[0]["result"] is None
        assert "损坏的解析结果" in rows[0]["result_error"]

    _run(scenario())
