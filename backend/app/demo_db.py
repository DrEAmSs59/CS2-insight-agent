"""SQLite storage for watched demo files and parse results."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, Optional

import aiosqlite


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


class DemoDB:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path

    async def init_db(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS demo_files (
                    id        INTEGER PRIMARY KEY AUTOINCREMENT,
                    path      TEXT UNIQUE NOT NULL,
                    filename  TEXT NOT NULL,
                    file_size INTEGER,
                    map_name TEXT,
                    total_rounds INTEGER,
                    team_a_score INTEGER,
                    team_b_score INTEGER,
                    duration_mins REAL,
                    match_date TEXT,
                    status    TEXT NOT NULL DEFAULT 'pending',
                    added_at  TEXT NOT NULL,
                    parsed_at TEXT,
                    error_msg TEXT,
                    display_name TEXT
                )
                """,
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS match_results (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    demo_path    TEXT NOT NULL,
                    result_json  TEXT NOT NULL,
                    created_at   TEXT NOT NULL
                )
                """,
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_match_results_demo_path ON match_results(demo_path)",
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS zip_extract_state (
                    zip_path   TEXT PRIMARY KEY NOT NULL,
                    mtime_ns   INTEGER NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS demo_scan_blocklist (
                    path       TEXT PRIMARY KEY NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            # 兼容旧库：补齐新增列
            cur = await conn.execute("PRAGMA table_info(demo_files)")
            cols = {str(r[1]) for r in await cur.fetchall()}
            alter_stmts: list[str] = []
            if "map_name" not in cols:
                alter_stmts.append("ALTER TABLE demo_files ADD COLUMN map_name TEXT")
            if "total_rounds" not in cols:
                alter_stmts.append("ALTER TABLE demo_files ADD COLUMN total_rounds INTEGER")
            if "team_a_score" not in cols:
                alter_stmts.append("ALTER TABLE demo_files ADD COLUMN team_a_score INTEGER")
            if "team_b_score" not in cols:
                alter_stmts.append("ALTER TABLE demo_files ADD COLUMN team_b_score INTEGER")
            if "duration_mins" not in cols:
                alter_stmts.append("ALTER TABLE demo_files ADD COLUMN duration_mins REAL")
            if "match_date" not in cols:
                alter_stmts.append("ALTER TABLE demo_files ADD COLUMN match_date TEXT")
            if "display_name" not in cols:
                alter_stmts.append("ALTER TABLE demo_files ADD COLUMN display_name TEXT")
            for stmt in alter_stmts:
                await conn.execute(stmt)
            await conn.commit()

    async def add_demo(self, path: str, file_size: int | None = None) -> tuple[int, bool]:
        """返回 (id, inserted)。path 已存在时 inserted=False，调用方应跳过后续轻量解析以加速扫描。"""
        p = Path(path)
        async with aiosqlite.connect(self.db_path) as conn:
            cur = await conn.execute(
                """
                INSERT OR IGNORE INTO demo_files(path, filename, file_size, status, added_at)
                VALUES (?, ?, ?, 'pending', ?)
                """,
                (str(p), p.name, file_size, utc_now_iso()),
            )
            await conn.commit()
            if cur.rowcount == 0:
                existing = await conn.execute("SELECT id FROM demo_files WHERE path = ?", (str(p),))
                row = await existing.fetchone()
                if not row:
                    raise RuntimeError(f"Failed to fetch existing demo row for {path}")
                return int(row[0]), False
            return int(cur.lastrowid), True

    async def update_status(
        self,
        demo_path: str,
        status: str,
        *,
        error_msg: str | None = None,
        parsed_at: str | None = None,
    ) -> None:
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute(
                """
                UPDATE demo_files
                SET status = ?, error_msg = ?, parsed_at = ?
                WHERE path = ?
                """,
                (status, error_msg, parsed_at, demo_path),
            )
            await conn.commit()

    async def update_lightweight_meta(self, demo_path: str, meta: dict[str, Any]) -> None:
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute(
                """
                UPDATE demo_files
                SET map_name = ?,
                    total_rounds = ?,
                    team_a_score = ?,
                    team_b_score = ?,
                    duration_mins = ?,
                    match_date = ?
                WHERE path = ?
                """,
                (
                    meta.get("map_name"),
                    meta.get("total_rounds"),
                    meta.get("team_a_score"),
                    meta.get("team_b_score"),
                    meta.get("duration_mins"),
                    meta.get("match_date"),
                    demo_path,
                ),
            )
            await conn.commit()

    async def save_result(self, demo_path: str, result: dict[str, Any]) -> None:
        now = utc_now_iso()
        payload = json.dumps(result, ensure_ascii=False)
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute("DELETE FROM match_results WHERE demo_path = ?", (demo_path,))
            await conn.execute(
                """
                INSERT INTO match_results(demo_path, result_json, created_at)
                VALUES (?, ?, ?)
                """,
                (demo_path, payload, now),
            )
            await conn.commit()

    async def clear_result(self, demo_path: str) -> None:
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute("DELETE FROM match_results WHERE demo_path = ?", (demo_path,))
            await conn.commit()

    async def list_demos(
        self,
        limit: int = 200,
        offset: int = 0,
        *,
        name_query: str | None = None,
    ) -> list[dict[str, Any]]:
        nq = (name_query or "").strip()
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            if nq:
                cur = await conn.execute(
                    """
                    SELECT d.id, d.path, d.filename, d.display_name, d.file_size, d.status, d.added_at, d.parsed_at, d.error_msg,
                           d.map_name, d.total_rounds, d.team_a_score, d.team_b_score, d.duration_mins, d.match_date,
                           r.result_json, r.created_at AS result_created_at
                    FROM demo_files d
                    LEFT JOIN match_results r ON r.demo_path = d.path
                    WHERE instr(lower(d.filename), lower(?)) > 0
                       OR instr(lower(ifnull(d.display_name, '')), lower(?)) > 0
                    ORDER BY d.id DESC
                    LIMIT ? OFFSET ?
                    """,
                    (nq, nq, limit, offset),
                )
            else:
                cur = await conn.execute(
                    """
                    SELECT d.id, d.path, d.filename, d.display_name, d.file_size, d.status, d.added_at, d.parsed_at, d.error_msg,
                           d.map_name, d.total_rounds, d.team_a_score, d.team_b_score, d.duration_mins, d.match_date,
                           r.result_json, r.created_at AS result_created_at
                    FROM demo_files d
                    LEFT JOIN match_results r ON r.demo_path = d.path
                    ORDER BY d.id DESC
                    LIMIT ? OFFSET ?
                    """,
                    (limit, offset),
                )
            rows = await cur.fetchall()
        out: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            raw = item.pop("result_json", None)
            item["result"] = json.loads(raw) if raw else None
            out.append(item)
        return out

    async def get_demo_list_item(self, demo_id: int) -> Optional[dict[str, Any]]:
        """与 ``list_demos`` 单条结构一致（含 ``result``），供跨页载入选中等。"""
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                """
                SELECT d.id, d.path, d.filename, d.display_name, d.file_size, d.status, d.added_at, d.parsed_at, d.error_msg,
                       d.map_name, d.total_rounds, d.team_a_score, d.team_b_score, d.duration_mins, d.match_date,
                       r.result_json, r.created_at AS result_created_at
                FROM demo_files d
                LEFT JOIN match_results r ON r.demo_path = d.path
                WHERE d.id = ?
                """,
                (demo_id,),
            )
            row = await cur.fetchone()
        if not row:
            return None
        item = dict(row)
        raw = item.pop("result_json", None)
        item["result"] = json.loads(raw) if raw else None
        return item

    async def count_demos(self, *, name_query: str | None = None) -> int:
        nq = (name_query or "").strip()
        async with aiosqlite.connect(self.db_path) as conn:
            if nq:
                cur = await conn.execute(
                    """
                    SELECT COUNT(*) FROM demo_files d
                    WHERE instr(lower(d.filename), lower(?)) > 0
                       OR instr(lower(ifnull(d.display_name, '')), lower(?)) > 0
                    """,
                    (nq, nq),
                )
            else:
                cur = await conn.execute("SELECT COUNT(*) FROM demo_files")
            row = await cur.fetchone()
            if not row or row[0] is None:
                return 0
            return int(row[0])

    async def get_result(self, demo_path: str) -> Optional[dict[str, Any]]:
        async with aiosqlite.connect(self.db_path) as conn:
            cur = await conn.execute(
                "SELECT result_json FROM match_results WHERE demo_path = ? ORDER BY id DESC LIMIT 1",
                (demo_path,),
            )
            row = await cur.fetchone()
            if not row:
                return None
            return json.loads(str(row[0]))

    async def get_demo_by_id(self, demo_id: int) -> Optional[dict[str, Any]]:
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute("SELECT * FROM demo_files WHERE id = ?", (demo_id,))
            row = await cur.fetchone()
            if not row:
                return None
            return dict(row)

    async def get_demo_by_path(self, demo_path: str) -> Optional[dict[str, Any]]:
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute("SELECT * FROM demo_files WHERE path = ?", (demo_path,))
            row = await cur.fetchone()
            if not row:
                return None
            return dict(row)

    async def is_path_scan_blocked(self, path: str) -> bool:
        async with aiosqlite.connect(self.db_path) as conn:
            cur = await conn.execute(
                "SELECT 1 FROM demo_scan_blocklist WHERE path = ? LIMIT 1",
                (path,),
            )
            row = await cur.fetchone()
        return row is not None

    async def delete_demo(
        self,
        demo_id: int,
        *,
        rescan: Literal["reimport", "skip"] = "reimport",
    ) -> bool:
        """删除库内记录。``rescan=skip`` 时把磁盘路径加入阻止表，后续扫描/监听不再入库。"""
        demo = await self.get_demo_by_id(demo_id)
        if not demo:
            return False
        disk_path = str(demo["path"])
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute("DELETE FROM match_results WHERE demo_path = ?", (disk_path,))
            await conn.execute("DELETE FROM demo_files WHERE id = ?", (demo_id,))
            if rescan == "skip":
                await conn.execute(
                    """
                    INSERT INTO demo_scan_blocklist(path, created_at)
                    VALUES (?, ?)
                    ON CONFLICT(path) DO UPDATE SET created_at = excluded.created_at
                    """,
                    (disk_path, utc_now_iso()),
                )
            else:
                await conn.execute("DELETE FROM demo_scan_blocklist WHERE path = ?", (disk_path,))
            await conn.commit()
        return True

    async def update_display_name(self, demo_id: int, display_name: str | None) -> bool:
        """仅更新库中展示名；``None`` 或空串会清空 ``display_name``（列表仍用磁盘 ``filename``）。"""
        normalized = (display_name or "").strip() or None
        async with aiosqlite.connect(self.db_path) as conn:
            cur = await conn.execute(
                "UPDATE demo_files SET display_name = ? WHERE id = ?",
                (normalized, demo_id),
            )
            await conn.commit()
            return cur.rowcount > 0

    async def zip_unchanged_since_extract(self, zip_path: str, mtime_ns: int, size_bytes: int) -> bool:
        """若库中已记录同一 zip 且 mtime+大小未变，则不应再次解压（避免每次扫描生成 _fromzip_*_N.dem）。"""
        async with aiosqlite.connect(self.db_path) as conn:
            cur = await conn.execute(
                "SELECT mtime_ns, size_bytes FROM zip_extract_state WHERE zip_path = ?",
                (zip_path,),
            )
            row = await cur.fetchone()
        if not row:
            return False
        return int(row[0]) == int(mtime_ns) and int(row[1]) == int(size_bytes)

    async def record_zip_extracted(self, zip_path: str, mtime_ns: int, size_bytes: int) -> None:
        now = utc_now_iso()
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute(
                """
                INSERT INTO zip_extract_state(zip_path, mtime_ns, size_bytes, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(zip_path) DO UPDATE SET
                    mtime_ns = excluded.mtime_ns,
                    size_bytes = excluded.size_bytes,
                    updated_at = excluded.updated_at
                """,
                (zip_path, int(mtime_ns), int(size_bytes), now),
            )
            await conn.commit()
