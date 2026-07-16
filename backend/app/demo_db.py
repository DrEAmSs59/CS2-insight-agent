"""SQLite storage for watched demo files and parse results."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, Optional

import aiosqlite

logger = logging.getLogger(__name__)

DemoListFilters = dict[str, Any]

_RESULT_SUMMARY_VERSION = 2
_RESULT_SUMMARY_BACKFILL_BATCH = 100
_STEAM_ID64_ACCOUNT_BASE = 76561197960265728


def _summarize_result(
    result: dict[str, Any],
) -> tuple[int, str | None, list[str], int, int]:
    """Return the compact, list-safe summary stored alongside a full result.

    ``clip_count`` follows the existing UI's primary-player semantics: the
    top-level ``clips`` list wins, then the primary player's nested result is
    used as a compatibility fallback for older multi-player payloads.
    """
    primary_target = str(result.get("auto_target_player") or "").strip()
    meta = result.get("match_meta")
    if not primary_target and isinstance(meta, dict):
        primary_target = str(meta.get("target_player") or "").strip()
    if not primary_target:
        analyzed = result.get("analyzed_target_players")
        if isinstance(analyzed, list):
            primary_target = next(
                (value.strip() for value in analyzed if isinstance(value, str) and value.strip()),
                "",
            )

    analyzed_targets: list[str] = []
    seen_targets: set[str] = set()

    def add_target(value: object) -> None:
        if not isinstance(value, str):
            return
        clean = value.strip()
        if not clean or clean in seen_targets:
            return
        seen_targets.add(clean)
        analyzed_targets.append(clean)

    clips = result.get("clips")
    players = result.get("players")
    successful_targets = []
    if isinstance(players, dict):
        for value, player_result in players.items():
            if isinstance(player_result, dict):
                successful_targets.append(value)
                add_target(value)
    if not successful_targets:
        analyzed = result.get("analyzed_target_players")
        if isinstance(analyzed, list):
            for value in analyzed:
                add_target(value)
    if not isinstance(clips, list) and isinstance(players, dict):
        player_result = players.get(primary_target) if primary_target else None
        if not isinstance(player_result, dict):
            player_result = next(
                (value for value in players.values() if isinstance(value, dict)),
                None,
            )
        clips = player_result.get("clips") if isinstance(player_result, dict) else None

    add_target(primary_target)
    four_k_count = 0
    five_k_count = 0
    if isinstance(clips, list):
        for clip in clips:
            if not isinstance(clip, dict) or clip.get("category") != "highlight":
                continue
            try:
                kill_count = int(clip.get("kill_count") or 0)
            except (TypeError, ValueError):
                continue
            if kill_count == 4:
                four_k_count += 1
            elif kill_count >= 5:
                five_k_count += 1

    return (
        len(clips) if isinstance(clips, list) else 0,
        primary_target or None,
        analyzed_targets,
        four_k_count,
        five_k_count,
    )


def _result_match_meta(result: dict[str, Any], primary_target: str | None) -> dict[str, Any]:
    meta = result.get("match_meta")
    if isinstance(meta, dict):
        return meta
    players = result.get("players")
    if not isinstance(players, dict):
        return {}
    player_result = players.get(primary_target) if primary_target else None
    if not isinstance(player_result, dict):
        player_result = next(
            (value for value in players.values() if isinstance(value, dict)),
            None,
        )
    nested_meta = player_result.get("match_meta") if isinstance(player_result, dict) else None
    return nested_meta if isinstance(nested_meta, dict) else {}


def utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


class DemoDB:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        # init_db 末尾根据 PRAGMA 设置：无 content_md5 列的旧库则全流程走旧逻辑
        self.ingest_md5_supported: bool = False

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
                    team_a_name TEXT,
                    team_b_name TEXT,
                    duration_mins REAL,
                    match_date TEXT,
                    status    TEXT NOT NULL DEFAULT 'pending',
                    added_at  TEXT NOT NULL,
                    parsed_at TEXT,
                    error_msg TEXT,
                    display_name TEXT,
                    source TEXT,
                    remark TEXT
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
            # Keep compact list metadata in a separate table.  Appending these
            # columns after result_json would still make SQLite traverse the
            # large row's overflow chain to reach them.
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS demo_result_summaries (
                    demo_path TEXT PRIMARY KEY NOT NULL,
                    clip_count INTEGER NOT NULL DEFAULT 0,
                    primary_target TEXT,
                    analyzed_targets_json TEXT NOT NULL DEFAULT '[]',
                    four_k_count INTEGER NOT NULL DEFAULT 0,
                    five_k_count INTEGER NOT NULL DEFAULT 0,
                    result_created_at TEXT NOT NULL,
                    summary_version INTEGER NOT NULL
                )
                """
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS demo_timeline_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    demo_path TEXT NOT NULL,
                    target_player TEXT NOT NULL,
                    event_id TEXT NOT NULL,
                    round_number INTEGER NOT NULL,
                    tick INTEGER NOT NULL,
                    record_type TEXT NOT NULL,
                    tags_json TEXT NOT NULL,
                    event_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(demo_path, target_player, event_id)
                )
                """
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_dte_demo ON demo_timeline_events(demo_path)",
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_dte_demo_player ON demo_timeline_events(demo_path, target_player)",
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_dte_tick ON demo_timeline_events(demo_path, tick)",
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS zip_extract_state (
                    zip_path   TEXT PRIMARY KEY NOT NULL,
                    mtime_ns   INTEGER NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    updated_at TEXT NOT NULL,
                    zip_md5    TEXT
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
            if "team_a_name" not in cols:
                alter_stmts.append("ALTER TABLE demo_files ADD COLUMN team_a_name TEXT")
            if "team_b_name" not in cols:
                alter_stmts.append("ALTER TABLE demo_files ADD COLUMN team_b_name TEXT")
            if "source" not in cols:
                alter_stmts.append("ALTER TABLE demo_files ADD COLUMN source TEXT")
            if "remark" not in cols:
                alter_stmts.append("ALTER TABLE demo_files ADD COLUMN remark TEXT")
            if "content_md5" not in cols:
                alter_stmts.append("ALTER TABLE demo_files ADD COLUMN content_md5 TEXT")
            if "origin_zip" not in cols:
                alter_stmts.append("ALTER TABLE demo_files ADD COLUMN origin_zip TEXT")
            for stmt in alter_stmts:
                await conn.execute(stmt)
            cur_summary = await conn.execute("PRAGMA table_info(demo_result_summaries)")
            summary_cols = {str(r[1]) for r in await cur_summary.fetchall()}
            if "analyzed_targets_json" not in summary_cols:
                await conn.execute(
                    "ALTER TABLE demo_result_summaries ADD COLUMN analyzed_targets_json TEXT NOT NULL DEFAULT '[]'"
                )
            if "four_k_count" not in summary_cols:
                await conn.execute(
                    "ALTER TABLE demo_result_summaries ADD COLUMN four_k_count INTEGER NOT NULL DEFAULT 0"
                )
            if "five_k_count" not in summary_cols:
                await conn.execute(
                    "ALTER TABLE demo_result_summaries ADD COLUMN five_k_count INTEGER NOT NULL DEFAULT 0"
                )
            # Persist the schema first so a large legacy backfill can commit in
            # bounded, restart-safe batches instead of holding one write
            # transaction for the entire application startup.
            await conn.commit()
            await self._backfill_result_summaries(conn)
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_demo_files_content_md5 ON demo_files(content_md5)",
            )
            cur_z = await conn.execute("PRAGMA table_info(zip_extract_state)")
            zcols = {str(r[1]) for r in await cur_z.fetchall()}
            if "zip_md5" not in zcols:
                await conn.execute("ALTER TABLE zip_extract_state ADD COLUMN zip_md5 TEXT")
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS demo_player_stats (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    demo_id INTEGER NOT NULL,
                    demo_path TEXT NOT NULL,
                    steam_id64 TEXT,
                    steam_id TEXT,
                    account_id TEXT,
                    user_id TEXT,
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
            cur_players = await conn.execute("PRAGMA table_info(demo_player_stats)")
            player_cols = {str(r[1]) for r in await cur_players.fetchall()}
            if "user_id" not in player_cols:
                await conn.execute("ALTER TABLE demo_player_stats ADD COLUMN user_id TEXT")
                # Older builds stored parser spectator slots in account_id.
                # Preserve that mixed legacy value before normalizing the true
                # Steam account ID. Perfect World rows often have no Steam ID,
                # so clearing account_id without this copy would lose their
                # only stable parser identifier.
                await conn.execute(
                    """
                    UPDATE demo_player_stats
                    SET user_id = account_id
                    WHERE user_id IS NULL AND account_id IS NOT NULL
                    """
                )
                await conn.execute(
                    """
                    UPDATE demo_player_stats
                    SET account_id = CASE
                        WHEN steam_id64 IS NOT NULL
                         AND length(steam_id64) >= 15
                         AND steam_id64 NOT GLOB '*[^0-9]*'
                         AND CAST(steam_id64 AS INTEGER) >= ?
                        THEN CAST(CAST(steam_id64 AS INTEGER) - ? AS TEXT)
                        ELSE NULL
                    END
                    """,
                    (_STEAM_ID64_ACCOUNT_BASE, _STEAM_ID64_ACCOUNT_BASE),
                )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_demo_player_stats_demo_id ON demo_player_stats(demo_id)"
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_demo_player_stats_demo_path ON demo_player_stats(demo_path)"
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_demo_player_stats_player_name ON demo_player_stats(normalized_name)"
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_demo_player_stats_steam_id64 ON demo_player_stats(steam_id64)"
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_demo_player_stats_kills ON demo_player_stats(kills)"
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_demo_player_stats_kd ON demo_player_stats(kd)"
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS demo_roster_cache (
                    demo_id INTEGER PRIMARY KEY,
                    demo_path TEXT NOT NULL,
                    cache_version INTEGER NOT NULL,
                    source_content_md5 TEXT,
                    source_file_size INTEGER,
                    source_mtime_ns INTEGER,
                    state TEXT NOT NULL,
                    row_count INTEGER NOT NULL DEFAULT 0,
                    error_msg TEXT,
                    updated_at TEXT NOT NULL
                )
                """
            )
            await conn.execute(
                "UPDATE demo_files SET status = 'done' WHERE lower(status) = 'parsed'"
            )
            await conn.commit()
        async with aiosqlite.connect(self.db_path) as conn2:
            cur_fc = await conn2.execute("PRAGMA table_info(demo_files)")
            fin_cols = {str(r[1]) for r in await cur_fc.fetchall()}
        self.ingest_md5_supported = "content_md5" in fin_cols

    @staticmethod
    async def _backfill_result_summaries(conn: aiosqlite.Connection) -> None:
        """Populate compact summaries once for result rows created by older builds."""
        await conn.execute(
            """
            DELETE FROM demo_result_summaries
            WHERE NOT EXISTS (
                SELECT 1 FROM match_results r
                WHERE r.demo_path = demo_result_summaries.demo_path
            )
            """
        )
        candidates_cur = await conn.execute(
            """
            SELECT r.id, r.demo_path, r.created_at
            FROM match_results r
            LEFT JOIN demo_result_summaries s ON s.demo_path = r.demo_path
            WHERE r.id = (
                SELECT MAX(r_latest.id)
                FROM match_results r_latest
                WHERE r_latest.demo_path = r.demo_path
            )
              AND (s.demo_path IS NULL OR s.summary_version < ?)
            ORDER BY r.id
            """,
            (_RESULT_SUMMARY_VERSION,),
        )
        # Candidate metadata is small; fetch each large JSON payload separately
        # so only one legacy result blob is resident at a time.
        candidates = await candidates_cur.fetchall()
        for index, (result_id, demo_path, result_created_at) in enumerate(candidates, start=1):
            payload_cur = await conn.execute(
                "SELECT result_json FROM match_results WHERE id = ?",
                (int(result_id),),
            )
            payload_row = await payload_cur.fetchone()
            raw = payload_row[0] if payload_row else None
            parsed: dict[str, Any] | None = None
            try:
                candidate = json.loads(str(raw))
                if not isinstance(candidate, dict):
                    raise ValueError("result_json is not an object")
                parsed = candidate
                (
                    clip_count,
                    primary_target,
                    analyzed_targets,
                    four_k_count,
                    five_k_count,
                ) = _summarize_result(parsed)
            except (TypeError, ValueError) as exc:
                logger.warning(
                    "Cannot summarize legacy match result path=%s: %s",
                    demo_path,
                    exc,
                )
                clip_count, primary_target = 0, None
                analyzed_targets, four_k_count, five_k_count = [], 0, 0
            await conn.execute(
                """
                INSERT INTO demo_result_summaries(
                    demo_path, clip_count, primary_target,
                    analyzed_targets_json, four_k_count, five_k_count,
                    result_created_at, summary_version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(demo_path) DO UPDATE SET
                    clip_count = excluded.clip_count,
                    primary_target = excluded.primary_target,
                    analyzed_targets_json = excluded.analyzed_targets_json,
                    four_k_count = excluded.four_k_count,
                    five_k_count = excluded.five_k_count,
                    result_created_at = excluded.result_created_at,
                    summary_version = excluded.summary_version
                """,
                (
                    str(demo_path),
                    clip_count,
                    primary_target,
                    json.dumps(analyzed_targets, ensure_ascii=False),
                    four_k_count,
                    five_k_count,
                    str(result_created_at),
                    _RESULT_SUMMARY_VERSION,
                ),
            )
            if parsed is not None:
                await DemoDB._fill_missing_demo_meta_from_result(
                    conn,
                    str(demo_path),
                    parsed,
                    primary_target,
                )
            if index % _RESULT_SUMMARY_BACKFILL_BATCH == 0:
                await conn.commit()
        await conn.commit()

    @staticmethod
    async def _fill_missing_demo_meta_from_result(
        conn: aiosqlite.Connection,
        demo_path: str,
        result: dict[str, Any],
        primary_target: str | None,
    ) -> None:
        """Preserve legacy list metadata without keeping result_json on the hot path."""
        meta = _result_match_meta(result, primary_target)
        if not meta:
            return

        def value(key: str) -> Any:
            raw = meta.get(key)
            return None if raw is None or raw == "" else raw

        await conn.execute(
            """
            UPDATE demo_files
            SET map_name = COALESCE(NULLIF(map_name, ''), ?),
                total_rounds = COALESCE(total_rounds, ?),
                team_a_score = COALESCE(team_a_score, ?),
                team_b_score = COALESCE(team_b_score, ?),
                team_a_name = COALESCE(NULLIF(team_a_name, ''), ?),
                team_b_name = COALESCE(NULLIF(team_b_name, ''), ?),
                duration_mins = COALESCE(duration_mins, ?),
                match_date = COALESCE(NULLIF(match_date, ''), ?)
            WHERE path = ?
            """,
            (
                value("map_name"),
                value("total_rounds"),
                value("team_a_score"),
                value("team_b_score"),
                value("team_a_name"),
                value("team_b_name"),
                value("duration_mins"),
                value("match_date"),
                demo_path,
            ),
        )

    async def add_demo(
        self,
        path: str,
        file_size: int | None = None,
        source: str | None = None,
        status: str = "pending",
        added_at: str | None = None,
        content_md5: str | None = None,
        origin_zip: str | None = None,
    ) -> tuple[int, bool]:
        """返回 (id, inserted)。path 已存在时 inserted=False，调用方应跳过后续轻量解析以加速扫描。"""
        p = Path(path)
        final_added_at = added_at or utc_now_iso()
        async with aiosqlite.connect(self.db_path) as conn:
            if self.ingest_md5_supported:
                cur = await conn.execute(
                    """
                    INSERT OR IGNORE INTO demo_files(path, filename, file_size, status, added_at, source, content_md5, origin_zip)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (str(p), p.name, file_size, status, final_added_at, source, content_md5, origin_zip),
                )
            else:
                cur = await conn.execute(
                    """
                    INSERT OR IGNORE INTO demo_files(path, filename, file_size, status, added_at, source)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (str(p), p.name, file_size, status, final_added_at, source),
                )
            await conn.commit()
            if cur.rowcount == 0:
                existing = await conn.execute("SELECT id FROM demo_files WHERE path = ?", (str(p),))
                row = await existing.fetchone()
                if not row:
                    raise RuntimeError(f"Failed to fetch existing demo row for {path}")
                return int(row[0]), False
            return int(cur.lastrowid), True

    async def content_md5_exists(self, md5_hex: str) -> bool:
        if not md5_hex or not self.ingest_md5_supported:
            return False
        async with aiosqlite.connect(self.db_path) as conn:
            cur = await conn.execute(
                "SELECT 1 FROM demo_files WHERE content_md5 = ? LIMIT 1",
                (md5_hex,),
            )
            row = await cur.fetchone()
        return row is not None

    async def update_demo_content_md5_if_absent(
        self,
        demo_path: str,
        content_md5: str,
        origin_zip: str | None = None,
    ) -> bool:
        """若该行尚无 content_md5，则写入（并可补 origin_zip）；已有则不动。"""
        if not self.ingest_md5_supported or not content_md5:
            return False
        async with aiosqlite.connect(self.db_path) as conn:
            if origin_zip:
                cur = await conn.execute(
                    """
                    UPDATE demo_files
                    SET content_md5 = ?, origin_zip = COALESCE(origin_zip, ?)
                    WHERE path = ? AND (content_md5 IS NULL OR trim(content_md5) = '')
                    """,
                    (content_md5, origin_zip, demo_path),
                )
            else:
                cur = await conn.execute(
                    """
                    UPDATE demo_files SET content_md5 = ?
                    WHERE path = ? AND (content_md5 IS NULL OR trim(content_md5) = '')
                    """,
                    (content_md5, demo_path),
                )
            await conn.commit()
        return cur.rowcount > 0

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

    async def update_lightweight_meta(self, demo_path: str, meta: dict[str, Any], source: str | None = None) -> None:
        async with aiosqlite.connect(self.db_path) as conn:
            if source:
                await conn.execute(
                    """
                    UPDATE demo_files
                    SET map_name = ?,
                        total_rounds = ?,
                        team_a_score = ?,
                        team_b_score = ?,
                        team_a_name = ?,
                        team_b_name = ?,
                        duration_mins = ?,
                        match_date = ?,
                        source = ?
                    WHERE path = ?
                    """,
                    (
                        meta.get("map_name"),
                        meta.get("total_rounds"),
                        meta.get("team_a_score"),
                        meta.get("team_b_score"),
                        meta.get("team_a_name"),
                        meta.get("team_b_name"),
                        meta.get("duration_mins"),
                        meta.get("match_date"),
                        source,
                        demo_path,
                    ),
                )
            else:
                await conn.execute(
                    """
                    UPDATE demo_files
                    SET map_name = ?,
                        total_rounds = ?,
                        team_a_score = ?,
                        team_b_score = ?,
                        team_a_name = ?,
                        team_b_name = ?,
                        duration_mins = ?,
                        match_date = ?
                    WHERE path = ?
                    """,
                    (
                        meta.get("map_name"),
                        meta.get("total_rounds"),
                        meta.get("team_a_score"),
                        meta.get("team_b_score"),
                        meta.get("team_a_name"),
                        meta.get("team_b_name"),
                        meta.get("duration_mins"),
                        meta.get("match_date"),
                        demo_path,
                    ),
                )
            await conn.commit()

    async def save_result(self, demo_path: str, result: dict[str, Any]) -> None:
        now = utc_now_iso()
        payload = json.dumps(result, ensure_ascii=False)
        (
            clip_count,
            primary_target,
            analyzed_targets,
            four_k_count,
            five_k_count,
        ) = _summarize_result(result)
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute("DELETE FROM match_results WHERE demo_path = ?", (demo_path,))
            await conn.execute(
                """
                INSERT INTO match_results(demo_path, result_json, created_at)
                VALUES (?, ?, ?)
                """,
                (demo_path, payload, now),
            )
            await conn.execute(
                """
                INSERT INTO demo_result_summaries(
                    demo_path, clip_count, primary_target,
                    analyzed_targets_json, four_k_count, five_k_count,
                    result_created_at, summary_version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(demo_path) DO UPDATE SET
                    clip_count = excluded.clip_count,
                    primary_target = excluded.primary_target,
                    analyzed_targets_json = excluded.analyzed_targets_json,
                    four_k_count = excluded.four_k_count,
                    five_k_count = excluded.five_k_count,
                    result_created_at = excluded.result_created_at,
                    summary_version = excluded.summary_version
                """,
                (
                    demo_path,
                    clip_count,
                    primary_target,
                    json.dumps(analyzed_targets, ensure_ascii=False),
                    four_k_count,
                    five_k_count,
                    now,
                    _RESULT_SUMMARY_VERSION,
                ),
            )
            await self._fill_missing_demo_meta_from_result(
                conn,
                demo_path,
                result,
                primary_target,
            )
            await conn.commit()
        meta = result.get("match_meta")
        tp = ""
        if isinstance(meta, dict):
            tp = str(meta.get("target_player") or "").strip()
        if not tp:
            tp = str(result.get("auto_target_player") or "").strip()
        if tp:
            await self.replace_timeline_events(demo_path, tp, result)

    async def replace_timeline_events(self, demo_path: str, target_player: str, result: dict[str, Any]) -> None:
        """按玩家写入时间线：击杀/死亡/助攻行 + 每回合高光标签行（先删后插）。"""
        tp = str(target_player or "").strip()
        now = utc_now_iso()
        rt = result.get("round_timeline")
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute(
                "DELETE FROM demo_timeline_events WHERE demo_path = ? AND target_player = ?",
                (demo_path, tp),
            )
            if not tp or not isinstance(rt, list):
                await conn.commit()
                return
            rows: list[tuple[Any, ...]] = []
            for bucket in rt:
                if not isinstance(bucket, dict):
                    continue
                try:
                    rn = int(bucket.get("round_number") or 0)
                except (TypeError, ValueError):
                    rn = 0
                htags = bucket.get("highlight_tags")
                if rn >= 1 and isinstance(htags, list) and any(str(x).strip() for x in htags):
                    clean_ht = [str(x).strip() for x in htags if str(x).strip()]
                    tags_json = json.dumps(clean_ht, ensure_ascii=False)
                    ev_wrap = {"round_number": rn, "highlight_tags": clean_ht}
                    rows.append(
                        (
                            demo_path,
                            tp,
                            f"hr{rn}-highlight",
                            rn,
                            -1,
                            "highlight_round",
                            tags_json,
                            json.dumps(ev_wrap, ensure_ascii=False),
                            now,
                        ),
                    )
                for ev in bucket.get("events") or []:
                    if not isinstance(ev, dict):
                        continue
                    typ = str(ev.get("type") or "").strip()
                    if typ not in ("kill", "death", "assist_only"):
                        continue
                    eid = str(ev.get("id") or "").strip()
                    if not eid:
                        continue
                    try:
                        tick = int(ev.get("tick") or 0)
                    except (TypeError, ValueError):
                        tick = 0
                    ev_clean = {k: v for k, v in ev.items() if k != "tags"}
                    rows.append(
                        (
                            demo_path,
                            tp,
                            eid,
                            rn,
                            tick,
                            typ,
                            "[]",
                            json.dumps(ev_clean, ensure_ascii=False),
                            now,
                        ),
                    )
            if rows:
                await conn.executemany(
                    """
                    INSERT INTO demo_timeline_events(
                        demo_path, target_player, event_id, round_number, tick,
                        record_type, tags_json, event_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    rows,
                )
            await conn.commit()

    async def clear_result(self, demo_path: str) -> None:
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute("DELETE FROM match_results WHERE demo_path = ?", (demo_path,))
            await conn.execute("DELETE FROM demo_result_summaries WHERE demo_path = ?", (demo_path,))
            await conn.execute("DELETE FROM demo_timeline_events WHERE demo_path = ?", (demo_path,))
            await conn.commit()

    async def find_by_filename(self, filename: str):
        """Return the demo_files row for the given filename, or None."""
        async with aiosqlite.connect(self.db_path) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute(
                "SELECT * FROM demo_files WHERE filename = ? LIMIT 1", (filename,)
            ) as cur:
                row = await cur.fetchone()
        return dict(row) if row else None

    @staticmethod
    def _need_player_join(f: DemoListFilters) -> bool:
        if str(f.get("player_query") or "").strip() or str(f.get("steam_query") or "").strip():
            return True
        return any(
            f.get(key) is not None
            for key in ("min_kills", "max_deaths", "min_assists", "min_kd")
        )

    @staticmethod
    def _merge_demo_filters(
        *,
        name_query: str | None,
        filters: DemoListFilters | None,
    ) -> DemoListFilters:
        out: DemoListFilters = dict(filters or {})
        nq = (name_query or "").strip() or None
        if nq is not None:
            out["name_query"] = nq
        elif "name_query" not in out:
            out["name_query"] = None
        return out

    @staticmethod
    def _build_demo_filters_sql(f: DemoListFilters) -> tuple[str, list[Any], bool]:
        """返回 ``(where_sql, params, need_player_join)``；``where_sql`` 以 ``WHERE 1=1`` 开头。

        主库列表始终排除 ``status='pending'``（待入库 staging，仅 ``GET /api/demos/discovered`` 展示）。
        """
        params: list[Any] = []
        parts: list[str] = ["WHERE 1=1", "d.status != 'pending'"]
        nq = f.get("name_query")
        if isinstance(nq, str) and nq.strip():
            s = nq.strip()
            parts.append(
                "(instr(lower(d.filename), lower(?)) > 0 OR instr(lower(ifnull(d.display_name, '')), lower(?)) > 0)"
            )
            params.extend([s, s])
        map_names_list = f.get("map_names")
        if isinstance(map_names_list, list) and map_names_list:
            mns_clean = [str(x).strip() for x in map_names_list if str(x).strip()]
            if mns_clean:
                ph = ",".join("?" * len(mns_clean))
                parts.append(f"d.map_name IN ({ph})")
                params.extend(mns_clean)
        else:
            map_name = f.get("map_name")
            if isinstance(map_name, str) and map_name.strip():
                parts.append("d.map_name = ?")
                params.append(map_name.strip())
        statuses_list = f.get("statuses")
        if isinstance(statuses_list, list) and statuses_list:
            sts_clean = [str(x).strip() for x in statuses_list if str(x).strip()]
            if sts_clean:
                ph = ",".join("?" * len(sts_clean))
                parts.append(f"d.status IN ({ph})")
                params.extend(sts_clean)
        else:
            status = f.get("status")
            if isinstance(status, str) and status.strip():
                parts.append("d.status = ?")
                params.append(status.strip())
        for key, column, operator, caster in (
            ("rounds_min", "d.total_rounds", ">=", int),
            ("rounds_max", "d.total_rounds", "<=", int),
            ("duration_min", "d.duration_mins", ">=", float),
            ("duration_max", "d.duration_mins", "<=", float),
        ):
            if f.get(key) is None:
                continue
            try:
                parts.append(f"{column} {operator} ?")
                params.append(caster(f[key]))
            except (TypeError, ValueError):
                pass
        date_expr = "julianday(COALESCE(NULLIF(d.match_date, ''), NULLIF(d.parsed_at, ''), d.added_at))"
        date_from = str(f.get("date_from") or "").strip()
        if date_from:
            parts.append(f"{date_expr} >= julianday(?)")
            params.append(date_from)
        date_to = str(f.get("date_to") or "").strip()
        if date_to:
            is_date_only = False
            if len(date_to) == 10:
                try:
                    datetime.strptime(date_to, "%Y-%m-%d")
                    is_date_only = True
                except ValueError:
                    pass
            if is_date_only:
                parts.append(f"{date_expr} < julianday(?, '+1 day')")
            else:
                parts.append(f"{date_expr} <= julianday(?)")
            params.append(date_to)
        need_ps = DemoDB._need_player_join(f)
        if need_ps:
            ps_parts: list[str] = []
            pq = str(f.get("player_query") or "").strip()
            if pq:
                parts.append(
                    "(instr(lower(ifnull(ps.player_name, '')), lower(?)) > 0 "
                    "OR instr(lower(ifnull(ps.normalized_name, '')), lower(?)) > 0)"
                )
                params.append(pq)
                params.append(pq)
            sq = str(f.get("steam_query") or "").strip()
            if sq:
                parts.append(
                    "(instr(ifnull(ps.steam_id64, ''), ?) > 0 "
                    "OR instr(ifnull(ps.steam_id, ''), ?) > 0 "
                    "OR instr(ifnull(ps.account_id, ''), ?) > 0)"
                )
                params.extend([sq, sq, sq])
            if f.get("min_kills") is not None:
                try:
                    ps_parts.append("ps.kills >= ?")
                    params.append(int(f["min_kills"]))
                except (TypeError, ValueError):
                    pass
            if f.get("max_deaths") is not None:
                try:
                    ps_parts.append("ps.deaths <= ?")
                    params.append(int(f["max_deaths"]))
                except (TypeError, ValueError):
                    pass
            if f.get("min_assists") is not None:
                try:
                    ps_parts.append("ps.assists >= ?")
                    params.append(int(f["min_assists"]))
                except (TypeError, ValueError):
                    pass
            if f.get("min_kd") is not None:
                try:
                    ps_parts.append("ps.kd >= ?")
                    params.append(float(f["min_kd"]))
                except (TypeError, ValueError):
                    pass
            if ps_parts:
                parts.append("(" + " AND ".join(ps_parts) + ")")
        tail = parts[1:]
        if tail:
            where_sql = "WHERE 1=1 AND " + " AND ".join(tail)
        else:
            where_sql = "WHERE 1=1"
        return where_sql, params, need_ps

    _LIST_SELECT = """
        SELECT DISTINCT d.id, d.path, d.filename, d.display_name, d.file_size, d.status, d.added_at, d.parsed_at, d.error_msg,
               d.map_name, d.total_rounds, d.team_a_score, d.team_b_score, d.team_a_name, d.team_b_name, d.duration_mins, d.match_date, d.source, d.remark,
               d.content_md5, d.origin_zip,
               r.result_json, r.created_at AS result_created_at
        """

    _COMPACT_LIST_SELECT = """
        SELECT DISTINCT d.id, d.path, d.filename, d.display_name, d.file_size, d.status, d.added_at, d.parsed_at, d.error_msg,
               d.map_name, d.total_rounds, d.team_a_score, d.team_b_score, d.team_a_name, d.team_b_name, d.duration_mins, d.match_date, d.source, d.remark,
               d.content_md5, d.origin_zip,
               CASE WHEN rs.demo_path IS NULL THEN 0 ELSE 1 END AS has_result,
               COALESCE(rs.clip_count, 0) AS clip_count,
               rs.primary_target,
               COALESCE(rs.analyzed_targets_json, '[]') AS analyzed_targets_json,
               COALESCE(rs.four_k_count, 0) AS four_k_count,
               COALESCE(rs.five_k_count, 0) AS five_k_count,
               rs.result_created_at
        """

    _PLAYER_LIST_SELECT = """
        SELECT demo_id,
               player_name AS name,
               player_name,
               steam_id64,
               COALESCE(steam_id64, steam_id) AS steamid64,
               steam_id,
               account_id,
               user_id,
               team_number,
               team_number AS team,
               team_name,
               kills,
               deaths,
               assists,
               kd
        FROM demo_player_stats
        """

    # 主库列表：待高光解析(loaded)置顶，其次 parsing / error，已解析 done 靠后；同档仍按 id 从新到旧
    _LIST_ORDER_BY = (
        "ORDER BY CASE lower(ifnull(d.status, '')) "
        "WHEN 'loaded' THEN 0 "
        "WHEN 'parsing' THEN 1 "
        "WHEN 'error' THEN 2 "
        "WHEN 'done' THEN 3 "
        "ELSE 4 END ASC, d.id DESC"
    )

    async def replace_demo_player_stats(
        self,
        demo_id: int,
        demo_path: str,
        players: list[dict[str, Any]],
    ) -> None:
        now = utc_now_iso()
        rows: list[tuple[Any, ...]] = []
        for p in players:
            name = (
                p.get("name")
                or p.get("player_name")
                or p.get("nickname")
                or p.get("persona_name")
                or "Unknown"
            )
            name = str(name).strip() or "Unknown"
            raw_sid64 = p.get("steam_id64") or p.get("steamid64") or p.get("xuid")
            raw_sid = p.get("steam_id") or p.get("steamid")
            if raw_sid64 is None and raw_sid is not None:
                raw_sid64 = raw_sid
            steam_id64: str | None = None
            steam_id: str | None = None
            if raw_sid64 is not None:
                s = str(raw_sid64).strip()
                if s.isdigit() and len(s) >= 15:
                    steam_id64 = s
                else:
                    steam_id = s
            if raw_sid is not None and steam_id is None:
                s2 = str(raw_sid).strip()
                if s2 and s2 != steam_id64:
                    steam_id = s2
            account_id = p.get("account_id")
            if account_id is None and steam_id64 is not None:
                try:
                    derived_account_id = int(steam_id64) - _STEAM_ID64_ACCOUNT_BASE
                    if derived_account_id >= 0:
                        account_id = derived_account_id
                except (TypeError, ValueError):
                    pass
            account_s = str(account_id).strip() if account_id is not None else None
            user_id = p.get("user_id")
            user_id_s = str(user_id).strip() if user_id is not None else None
            try:
                kills = int(p.get("kills") or p.get("k") or 0)
            except (TypeError, ValueError):
                kills = 0
            try:
                deaths = int(p.get("deaths") or p.get("d") or 0)
            except (TypeError, ValueError):
                deaths = 0
            try:
                assists = int(p.get("assists") or p.get("a") or 0)
            except (TypeError, ValueError):
                assists = 0
            kd = round(kills / max(deaths, 1), 3)
            norm = name.lower().strip()
            team_num = p.get("team_number")
            if team_num is None and p.get("team") is not None:
                try:
                    team_num = int(p["team"])
                except (TypeError, ValueError):
                    team_num = None
            team_name = p.get("team_name")
            team_name_s = str(team_name).strip() if team_name is not None else None
            rows.append(
                (
                    demo_id,
                    str(demo_path),
                    steam_id64,
                    steam_id,
                    account_s,
                    user_id_s,
                    name,
                    norm or None,
                    team_name_s,
                    team_num,
                    kills,
                    deaths,
                    assists,
                    kd,
                    now,
                ),
            )
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute("DELETE FROM demo_player_stats WHERE demo_id = ?", (demo_id,))
            if rows:
                await conn.executemany(
                    """
                    INSERT INTO demo_player_stats(
                        demo_id, demo_path, steam_id64, steam_id, account_id, user_id,
                        player_name, normalized_name, team_name, team_number,
                        kills, deaths, assists, kd, indexed_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    rows,
                )
            await conn.commit()

    async def list_demo_player_stats(self, demo_id: int) -> list[dict[str, Any]]:
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                """
                SELECT id, demo_id, demo_path, steam_id64, steam_id, account_id, user_id, player_name, normalized_name,
                       team_name, team_number, kills, deaths, assists, kd, indexed_at
                FROM demo_player_stats
                WHERE demo_id = ?
                ORDER BY kills DESC, player_name ASC
                """,
                (demo_id,),
            )
            rws = await cur.fetchall()
        return [dict(r) for r in rws]

    async def get_demo_roster_cache(self, demo_id: int) -> Optional[dict[str, Any]]:
        """Return roster cache metadata together with the demo's current MD5."""
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                """
                SELECT c.demo_id, c.demo_path, c.cache_version,
                       c.source_content_md5, c.source_file_size, c.source_mtime_ns,
                       c.state, c.row_count, c.error_msg, c.updated_at,
                       d.content_md5 AS current_content_md5
                FROM demo_roster_cache c
                LEFT JOIN demo_files d ON d.id = c.demo_id
                WHERE c.demo_id = ?
                """,
                (demo_id,),
            )
            row = await cur.fetchone()
        return dict(row) if row else None

    async def save_demo_roster_cache(
        self,
        demo_id: int,
        demo_path: str,
        *,
        cache_version: int,
        source_file_size: int | None,
        source_mtime_ns: int | None,
        state: Literal["ready", "empty", "error"],
        row_count: int,
        error_msg: str | None = None,
    ) -> None:
        """Persist the result of one roster parse, including negative results."""
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute(
                """
                INSERT INTO demo_roster_cache(
                    demo_id, demo_path, cache_version, source_content_md5,
                    source_file_size, source_mtime_ns, state, row_count,
                    error_msg, updated_at
                ) VALUES (
                    ?, ?, ?,
                    (SELECT content_md5 FROM demo_files WHERE id = ?),
                    ?, ?, ?, ?, ?, ?
                )
                ON CONFLICT(demo_id) DO UPDATE SET
                    demo_path = excluded.demo_path,
                    cache_version = excluded.cache_version,
                    source_content_md5 = excluded.source_content_md5,
                    source_file_size = excluded.source_file_size,
                    source_mtime_ns = excluded.source_mtime_ns,
                    state = excluded.state,
                    row_count = excluded.row_count,
                    error_msg = excluded.error_msg,
                    updated_at = excluded.updated_at
                """,
                (
                    demo_id,
                    str(demo_path),
                    int(cache_version),
                    demo_id,
                    source_file_size,
                    source_mtime_ns,
                    state,
                    max(0, int(row_count)),
                    error_msg,
                    utc_now_iso(),
                ),
            )
            await conn.commit()

    async def invalidate_demo_roster_cache(
        self,
        demo_id: int,
        *,
        clear_rows: bool = False,
    ) -> None:
        """Invalidate roster metadata and optionally discard its materialized rows."""
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute("DELETE FROM demo_roster_cache WHERE demo_id = ?", (demo_id,))
            if clear_rows:
                await conn.execute("DELETE FROM demo_player_stats WHERE demo_id = ?", (demo_id,))
            await conn.commit()

    async def search_players(self, q: str, limit: int = 20) -> list[dict[str, Any]]:
        qq = (q or "").strip()
        if not qq:
            return []
        like = f"%{qq.lower()}%"
        cap = max(1, min(int(limit), 100))
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                """
                SELECT
                    MIN(player_name) AS player_name,
                    MAX(normalized_name) AS normalized_name,
                    steam_id64,
                    MAX(account_id) AS account_id,
                    COUNT(DISTINCT demo_id) AS demo_count,
                    MAX(indexed_at) AS last_seen_at
                FROM demo_player_stats
                WHERE instr(lower(ifnull(player_name, '')), lower(?)) > 0
                   OR instr(lower(ifnull(normalized_name, '')), lower(?)) > 0
                   OR ifnull(steam_id64, '') LIKE ?
                GROUP BY COALESCE(steam_id64, lower(player_name))
                ORDER BY demo_count DESC, last_seen_at DESC
                LIMIT ?
                """,
                (qq, qq, like, cap),
            )
            rws = await cur.fetchall()
        return [dict(r) for r in rws]

    async def list_demo_ids_missing_player_stats(self, limit: int) -> list[tuple[int, str]]:
        """返回尚未写入 ``demo_player_stats`` 的 demo，按 id 降序。``limit`` 为单次查询条数上限。"""
        lim = max(1, min(int(limit), 5000))
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                """
                SELECT d.id, d.path
                FROM demo_files d
                WHERE NOT EXISTS (SELECT 1 FROM demo_player_stats ps WHERE ps.demo_id = d.id)
                ORDER BY d.id DESC
                LIMIT ?
                """,
                (lim,),
            )
            rows = await cur.fetchall()
        return [(int(r["id"]), str(r["path"])) for r in rows]

    async def list_demo_ids_recent(self, limit: int) -> list[tuple[int, str]]:
        lim = max(1, min(int(limit), 500))
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                "SELECT id, path FROM demo_files ORDER BY id DESC LIMIT ?",
                (lim,),
            )
            rows = await cur.fetchall()
        return [(int(r["id"]), str(r["path"])) for r in rows]

    @classmethod
    async def _players_by_demo_id(
        cls,
        conn: aiosqlite.Connection,
        demo_ids: list[int],
    ) -> dict[int, list[dict[str, Any]]]:
        """Load roster rows in bounded IN queries instead of one query per demo."""
        normalized = list(dict.fromkeys(int(value) for value in demo_ids))
        grouped: dict[int, list[dict[str, Any]]] = {demo_id: [] for demo_id in normalized}
        for start in range(0, len(normalized), 500):
            chunk = normalized[start : start + 500]
            if not chunk:
                continue
            placeholders = ",".join("?" for _ in chunk)
            cur = await conn.execute(
                f"""
                {cls._PLAYER_LIST_SELECT}
                WHERE demo_id IN ({placeholders})
                ORDER BY demo_id, kills DESC, player_name ASC
                """,
                chunk,
            )
            for row in await cur.fetchall():
                item = dict(row)
                demo_id = int(item.pop("demo_id"))
                grouped.setdefault(demo_id, []).append(item)
        return grouped

    async def list_demos(
        self,
        limit: int = 200,
        offset: int = 0,
        *,
        name_query: str | None = None,
        filters: DemoListFilters | None = None,
    ) -> list[dict[str, Any]]:
        f = self._merge_demo_filters(name_query=name_query, filters=filters)
        where_sql, params, need_ps = self._build_demo_filters_sql(f)
        join_sql = ""
        if need_ps:
            join_sql = " JOIN demo_player_stats ps ON ps.demo_id = d.id "
        sql = (
            f"{self._LIST_SELECT} FROM demo_files d "
            f"LEFT JOIN match_results r ON r.demo_path = d.path {join_sql} {where_sql} "
            f"{self._LIST_ORDER_BY} LIMIT ? OFFSET ?"
        )
        params_ext = [*params, limit, offset]
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(sql, params_ext)
            rows = await cur.fetchall()
            out: list[dict[str, Any]] = []
            for row in rows:
                item = dict(row)
                raw = item.pop("result_json", None)
                item["result"] = json.loads(raw) if raw else None
                out.append(item)
            players_by_id = await self._players_by_demo_id(
                conn,
                [int(item["id"]) for item in out],
            )
            for item in out:
                item["players"] = players_by_id.get(int(item["id"]), [])
            return out

    async def list_demos_compact(
        self,
        limit: int = 200,
        offset: int = 0,
        *,
        name_query: str | None = None,
        filters: DemoListFilters | None = None,
    ) -> list[dict[str, Any]]:
        """Return lightweight list rows without selecting or decoding result_json.

        The result summary is materialized by :meth:`save_result`, and all
        roster rows for the page are fetched in one additional query (or one
        per 500 demos for unusually large pages).
        """
        f = self._merge_demo_filters(name_query=name_query, filters=filters)
        where_sql, params, need_ps = self._build_demo_filters_sql(f)
        join_sql = ""
        if need_ps:
            join_sql = " JOIN demo_player_stats ps ON ps.demo_id = d.id "
        sql = (
            f"{self._COMPACT_LIST_SELECT} FROM demo_files d "
            f"LEFT JOIN demo_result_summaries rs ON rs.demo_path = d.path {join_sql} {where_sql} "
            f"{self._LIST_ORDER_BY} LIMIT ? OFFSET ?"
        )
        params_ext = [*params, max(1, int(limit)), max(0, int(offset))]
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(sql, params_ext)
            rows = await cur.fetchall()
            out = [dict(row) for row in rows]
            players_by_id = await self._players_by_demo_id(
                conn,
                [int(item["id"]) for item in out],
            )
            for item in out:
                item["has_result"] = bool(item["has_result"])
                item["clip_count"] = int(item["clip_count"] or 0)
                raw_targets = item.pop("analyzed_targets_json", "[]")
                try:
                    decoded_targets = json.loads(str(raw_targets))
                except (TypeError, ValueError):
                    decoded_targets = []
                item["analyzed_targets"] = (
                    [str(value) for value in decoded_targets if isinstance(value, str)]
                    if isinstance(decoded_targets, list)
                    else []
                )
                item["four_k_count"] = int(item["four_k_count"] or 0)
                item["five_k_count"] = int(item["five_k_count"] or 0)
                item["players"] = players_by_id.get(int(item["id"]), [])
            return out

    async def list_filtered_demo_ids(
        self,
        *,
        name_query: str | None = None,
        filters: DemoListFilters | None = None,
        limit: int | None = None,
        offset: int = 0,
    ) -> list[int]:
        """Return only matching IDs, suitable for cross-page selection flows."""
        f = self._merge_demo_filters(name_query=name_query, filters=filters)
        where_sql, params, need_ps = self._build_demo_filters_sql(f)
        join_sql = ""
        if need_ps:
            join_sql = " JOIN demo_player_stats ps ON ps.demo_id = d.id "
        sql = (
            f"SELECT DISTINCT d.id FROM demo_files d {join_sql} {where_sql} "
            f"{self._LIST_ORDER_BY}"
        )
        final_params: list[Any] = list(params)
        if limit is not None:
            sql += " LIMIT ? OFFSET ?"
            final_params.extend([max(1, int(limit)), max(0, int(offset))])
        elif offset:
            # SQLite requires LIMIT when OFFSET is present; -1 means no limit.
            sql += " LIMIT -1 OFFSET ?"
            final_params.append(max(0, int(offset)))
        async with aiosqlite.connect(self.db_path) as conn:
            cur = await conn.execute(sql, final_params)
            rows = await cur.fetchall()
        return [int(row[0]) for row in rows]

    async def get_demo_list_items(self, demo_ids: list[int]) -> list[dict[str, Any]]:
        """Batch-fetch full list items while preserving first-seen ID order.

        Full ``result_json`` payloads are intentionally returned here for
        detail/analysis flows.  Queries are chunked to stay below conservative
        SQLite bind-variable limits, and roster data is loaded in matching
        batches rather than N+1 queries.
        """
        ordered_ids = list(dict.fromkeys(int(value) for value in demo_ids))
        if not ordered_ids:
            return []

        by_id: dict[int, dict[str, Any]] = {}
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            for start in range(0, len(ordered_ids), 500):
                chunk = ordered_ids[start : start + 500]
                placeholders = ",".join("?" for _ in chunk)
                cur = await conn.execute(
                    f"""
                    {self._LIST_SELECT}
                    FROM demo_files d
                    LEFT JOIN match_results r ON r.demo_path = d.path
                    WHERE d.id IN ({placeholders})
                    """,
                    chunk,
                )
                for row in await cur.fetchall():
                    item = dict(row)
                    raw = item.pop("result_json", None)
                    try:
                        item["result"] = json.loads(raw) if raw else None
                        item["result_error"] = None
                    except (TypeError, ValueError) as exc:
                        item["result"] = None
                        item["result_error"] = f"损坏的解析结果：{exc}"
                    by_id[int(item["id"])] = item
            players_by_id = await self._players_by_demo_id(conn, ordered_ids)

        for demo_id, item in by_id.items():
            item["players"] = players_by_id.get(demo_id, [])
        return [by_id[demo_id] for demo_id in ordered_ids if demo_id in by_id]

    async def get_demo_list_item(self, demo_id: int) -> Optional[dict[str, Any]]:
        """与 ``list_demos`` 单条结构一致（含 ``result``），供跨页载入选中等。"""
        items = await self.get_demo_list_items([demo_id])
        return items[0] if items else None

    async def count_demos(
        self,
        *,
        name_query: str | None = None,
        filters: DemoListFilters | None = None,
    ) -> int:
        f = self._merge_demo_filters(name_query=name_query, filters=filters)
        where_sql, params, need_ps = self._build_demo_filters_sql(f)
        join_sql = ""
        if need_ps:
            join_sql = " JOIN demo_player_stats ps ON ps.demo_id = d.id "
        sql = f"SELECT COUNT(DISTINCT d.id) FROM demo_files d {join_sql} {where_sql}"
        async with aiosqlite.connect(self.db_path) as conn:
            cur = await conn.execute(sql, params)
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
            await conn.execute("DELETE FROM demo_result_summaries WHERE demo_path = ?", (disk_path,))
            await conn.execute("DELETE FROM demo_timeline_events WHERE demo_path = ?", (disk_path,))
            await conn.execute("DELETE FROM demo_roster_cache WHERE demo_id = ?", (demo_id,))
            await conn.execute("DELETE FROM demo_player_stats WHERE demo_id = ?", (demo_id,))
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

    async def update_remark(self, demo_id: int, remark: str | None) -> bool:
        async with aiosqlite.connect(self.db_path) as conn:
            cur = await conn.execute(
                "UPDATE demo_files SET remark = ? WHERE id = ?",
                (remark, demo_id),
            )
            await conn.commit()
            return cur.rowcount > 0

    @staticmethod
    def _discovered_duplicate_match_sql(left_alias: str, right_alias: str) -> str:
        la, ra = left_alias, right_alias
        return f"""(
            lower({la}.path) = lower({ra}.path)
            OR lower({la}.filename) = lower({ra}.filename)
            OR (
                {la}.content_md5 IS NOT NULL AND trim({la}.content_md5) != ''
                AND {ra}.content_md5 IS NOT NULL AND trim({ra}.content_md5) != ''
                AND {la}.content_md5 = {ra}.content_md5
            )
        )"""

    @staticmethod
    def _discovered_not_already_in_library_sql(alias: str = "d") -> str:
        """待入库列表去重：排除主库已有 demo，以及与其它 pending 重复的条目（保留 id 最小的一条）。"""
        a = alias
        dup = DemoDB._discovered_duplicate_match_sql(a, "ing")
        return f"""
        AND NOT EXISTS (
            SELECT 1 FROM demo_files ing
            WHERE ing.id != {a}.id
            AND {dup}
            AND (
                ing.status != 'pending'
                OR ing.id < {a}.id
            )
        )
        """

    async def list_discovered_demos(
        self,
        limit: int = 200,
        offset: int = 0,
        name_query: str | None = None,
    ) -> list[dict[str, Any]]:
        """列出已发现但尚未入库（status='pending'）的 demo。"""
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            sql = (
                "SELECT d.id, d.path, d.filename, d.file_size, d.source, d.added_at "
                "FROM demo_files d WHERE d.status = 'pending'"
                + self._discovered_not_already_in_library_sql("d")
            )
            params: list[Any] = []
            if name_query:
                sql += " AND d.filename LIKE ?"
                params.append(f"%{name_query}%")
            sql += " ORDER BY d.id DESC LIMIT ? OFFSET ?"
            params.extend([limit, offset])
            cur = await conn.execute(sql, params)
            return [dict(r) for r in await cur.fetchall()]

    async def count_discovered_demos(self, name_query: str | None = None) -> int:
        async with aiosqlite.connect(self.db_path) as conn:
            sql = (
                "SELECT COUNT(*) FROM demo_files d WHERE d.status = 'pending'"
                + self._discovered_not_already_in_library_sql("d")
            )
            params: list[Any] = []
            if name_query:
                sql += " AND d.filename LIKE ?"
                params.append(f"%{name_query}%")
            cur = await conn.execute(sql, params)
            row = await cur.fetchone()
            return int(row[0]) if row else 0

    async def purge_deleted_demo_files(self, existing_paths: set[str]) -> int:
        """删除 `demo_files` 中 ``path`` 不在 ``existing_paths`` 里的记录（物理文件已被手动删除）。

        用临时表收集现有路径集合，然后单条 ``DELETE ... WHERE path NOT IN (SELECT ...)`` 级联清理，
        避免全表预读和 ``NOT IN`` 参数数量限制。
        """
        if not existing_paths:
            return 0
        batch_size = 500
        all_paths = list(existing_paths)
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute("CREATE TEMP TABLE IF NOT EXISTS _tmp_existing_paths (path TEXT PRIMARY KEY)")
            await conn.execute("DELETE FROM _tmp_existing_paths")
            for i in range(0, len(all_paths), batch_size):
                chunk = all_paths[i:i + batch_size]
                await conn.executemany("INSERT INTO _tmp_existing_paths(path) VALUES (?)", [(p,) for p in chunk])
            await conn.execute("DELETE FROM match_results WHERE demo_path NOT IN (SELECT path FROM _tmp_existing_paths)")
            await conn.execute("DELETE FROM demo_result_summaries WHERE demo_path NOT IN (SELECT path FROM _tmp_existing_paths)")
            await conn.execute("DELETE FROM demo_timeline_events WHERE demo_path NOT IN (SELECT path FROM _tmp_existing_paths)")
            await conn.execute("DELETE FROM demo_roster_cache WHERE demo_id NOT IN (SELECT d.id FROM demo_files d WHERE d.path IN (SELECT path FROM _tmp_existing_paths))")
            await conn.execute("DELETE FROM demo_player_stats WHERE demo_id NOT IN (SELECT d.id FROM demo_files d WHERE d.path IN (SELECT path FROM _tmp_existing_paths))")
            cur = await conn.execute("DELETE FROM demo_files WHERE path NOT IN (SELECT path FROM _tmp_existing_paths)")
            await conn.commit()
            total = cur.rowcount
            if total:
                logger.info("purge_deleted_demo_files: removed %d rows for files no longer on disk", total)
            return total

    async def all_content_md5_hexes(self) -> set[str]:
        """已入库 demo 的内容 MD5 集合，供 zip 解压前去重。"""
        if not self.ingest_md5_supported:
            return set()
        async with aiosqlite.connect(self.db_path) as conn:
            cur = await conn.execute(
                "SELECT content_md5 FROM demo_files WHERE content_md5 IS NOT NULL AND length(trim(content_md5)) > 0",
            )
            rows = await cur.fetchall()
        return {str(r[0]) for r in rows if r and r[0]}

    async def get_zip_extract_state(self, zip_path: str) -> Optional[dict[str, Any]]:
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                "SELECT zip_path, mtime_ns, size_bytes, zip_md5, updated_at FROM zip_extract_state WHERE zip_path = ?",
                (zip_path,),
            )
            row = await cur.fetchone()
        return dict(row) if row else None

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

    async def record_zip_extracted(
        self,
        zip_path: str,
        mtime_ns: int,
        size_bytes: int,
        *,
        zip_md5: str | None = None,
    ) -> None:
        now = utc_now_iso()
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute(
                """
                INSERT INTO zip_extract_state(zip_path, mtime_ns, size_bytes, updated_at, zip_md5)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(zip_path) DO UPDATE SET
                    mtime_ns = excluded.mtime_ns,
                    size_bytes = excluded.size_bytes,
                    updated_at = excluded.updated_at,
                    zip_md5 = COALESCE(excluded.zip_md5, zip_extract_state.zip_md5)
                """,
                (zip_path, int(mtime_ns), int(size_bytes), now, zip_md5),
            )
            await conn.commit()
