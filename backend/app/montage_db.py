"""SQLite tables for recorded OBS clips and montage export drafts (V2)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

import aiosqlite

from .demo_db import utc_now_iso


class MontageDB:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path

    @staticmethod
    def _expand_clip_meta_row(row: dict[str, Any]) -> dict[str, Any]:
        """将 clip_meta JSON 展平到行字典，便于前端与解析片段字段对齐。"""
        # clip_meta 含录制侧扩展字段（如 recording_perspective、victim_pov_segments 等），无固定列白名单。
        out = dict(row)
        raw = out.pop("clip_meta", None)
        if not raw:
            return out
        try:
            meta = json.loads(str(raw))
        except (TypeError, ValueError, json.JSONDecodeError):
            return out
        if isinstance(meta, dict):
            for k, v in meta.items():
                out[k] = v
        return out

    async def init_tables(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS recorded_clips (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    clip_id        TEXT NOT NULL,
                    demo_path      TEXT NOT NULL,
                    demo_filename  TEXT,
                    player_name    TEXT,
                    output_path    TEXT NOT NULL,
                    duration_sec   REAL,
                    status         TEXT NOT NULL DEFAULT 'ready',
                    created_at     TEXT NOT NULL,
                    clip_meta      TEXT
                )
                """,
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_recorded_clips_created ON recorded_clips(created_at DESC)",
            )
            cur = await conn.execute("PRAGMA table_info(recorded_clips)")
            cols = {str(r[1]) for r in await cur.fetchall()}
            if "clip_meta" not in cols:
                await conn.execute("ALTER TABLE recorded_clips ADD COLUMN clip_meta TEXT")
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS montage_projects (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    name        TEXT,
                    body_json   TEXT NOT NULL,
                    updated_at  TEXT NOT NULL,
                    created_at  TEXT NOT NULL
                )
                """,
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS montage_exports (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id     INTEGER,
                    body_json      TEXT NOT NULL,
                    status         TEXT NOT NULL DEFAULT 'pending',
                    error_msg      TEXT,
                    output_path    TEXT,
                    created_at     TEXT NOT NULL,
                    updated_at     TEXT NOT NULL,
                    FOREIGN KEY(project_id) REFERENCES montage_projects(id)
                )
                """,
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_montage_exports_status ON montage_exports(status)",
            )
            await conn.commit()

    async def insert_recorded_clip(
        self,
        *,
        clip_id: str,
        demo_path: str,
        demo_filename: str | None,
        player_name: str | None,
        output_path: str,
        duration_sec: float | None,
        status: str = "ready",
        clip_meta: Optional[dict[str, Any]] = None,
    ) -> int:
        now = utc_now_iso()
        meta_json = json.dumps(clip_meta, ensure_ascii=False) if clip_meta else None
        async with aiosqlite.connect(self.db_path) as conn:
            cur = await conn.execute(
                """
                INSERT INTO recorded_clips(
                    clip_id, demo_path, demo_filename, player_name, output_path, duration_sec, status, created_at, clip_meta
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    clip_id,
                    demo_path,
                    demo_filename,
                    player_name,
                    output_path,
                    duration_sec,
                    status,
                    now,
                    meta_json,
                ),
            )
            await conn.commit()
            return int(cur.lastrowid)

    async def list_recorded_clips(self, *, limit: int = 500, offset: int = 0) -> list[dict[str, Any]]:
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                """
                SELECT id, clip_id, demo_path, demo_filename, player_name, output_path, duration_sec, status, created_at, clip_meta
                FROM recorded_clips
                ORDER BY id DESC
                LIMIT ? OFFSET ?
                """,
                (limit, offset),
            )
            rows = await cur.fetchall()
        return [self._expand_clip_meta_row(dict(r)) for r in rows]

    async def get_recorded_clips_by_ids(self, ids: list[int]) -> dict[int, dict[str, Any]]:
        if not ids:
            return {}
        placeholders = ",".join("?" * len(ids))
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                f"SELECT * FROM recorded_clips WHERE id IN ({placeholders})",
                tuple(int(x) for x in ids),
            )
            rows = await cur.fetchall()
        return {int(r["id"]): self._expand_clip_meta_row(dict(r)) for r in rows}

    async def delete_recorded_clip(self, clip_id: int) -> Optional[dict[str, Any]]:
        """删除 recorded_clips 行；若 output_path 指向本地文件则尝试一并删除。"""
        cid = int(clip_id)
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                "SELECT id, output_path FROM recorded_clips WHERE id = ?",
                (cid,),
            )
            row = await cur.fetchone()
        if not row:
            return None
        out = Path(str(row["output_path"])).expanduser()
        removed_file = False
        if out.is_file():
            try:
                out.unlink()
                removed_file = True
            except OSError as e:
                raise ValueError(f"无法删除本地文件: {e}") from e
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute("DELETE FROM recorded_clips WHERE id = ?", (cid,))
            await conn.commit()
        return {"id": cid, "output_path": str(out), "removed_file": removed_file}

    async def save_project(self, *, name: str | None, body: dict[str, Any], project_id: int | None = None) -> int:
        now = utc_now_iso()
        payload = json.dumps(body, ensure_ascii=False)
        async with aiosqlite.connect(self.db_path) as conn:
            if project_id is None:
                cur = await conn.execute(
                    """
                    INSERT INTO montage_projects(name, body_json, updated_at, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (name or "", payload, now, now),
                )
                await conn.commit()
                return int(cur.lastrowid)
            cur = await conn.execute(
                """
                UPDATE montage_projects SET name = ?, body_json = ?, updated_at = ?
                WHERE id = ?
                """,
                (name or "", payload, now, int(project_id)),
            )
            await conn.commit()
            if cur.rowcount == 0:
                raise ValueError("project not found")
            return int(project_id)

    async def get_project(self, project_id: int) -> Optional[dict[str, Any]]:
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                "SELECT id, name, body_json, updated_at, created_at FROM montage_projects WHERE id = ?",
                (int(project_id),),
            )
            row = await cur.fetchone()
        if not row:
            return None
        d = dict(row)
        d["body"] = json.loads(str(d.pop("body_json")))
        return d

    async def create_export(
        self,
        *,
        project_id: int | None,
        body: dict[str, Any],
        status: str = "pending",
        error_msg: str | None = None,
        output_path: str | None = None,
    ) -> int:
        now = utc_now_iso()
        payload = json.dumps(body, ensure_ascii=False)
        async with aiosqlite.connect(self.db_path) as conn:
            cur = await conn.execute(
                """
                INSERT INTO montage_exports(project_id, body_json, status, error_msg, output_path, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (project_id, payload, status, error_msg, output_path, now, now),
            )
            await conn.commit()
            return int(cur.lastrowid)

    async def update_export(
        self,
        export_id: int,
        *,
        status: str | None = None,
        error_msg: str | None = None,
        output_path: str | None = None,
    ) -> None:
        now = utc_now_iso()
        fields: list[str] = ["updated_at = ?"]
        vals: list[Any] = [now]
        if status is not None:
            fields.append("status = ?")
            vals.append(status)
        if error_msg is not None:
            fields.append("error_msg = ?")
            vals.append(error_msg)
        if output_path is not None:
            fields.append("output_path = ?")
            vals.append(output_path)
        vals.append(int(export_id))
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute(
                f"UPDATE montage_exports SET {', '.join(fields)} WHERE id = ?",
                vals,
            )
            await conn.commit()

    async def get_export(self, export_id: int) -> Optional[dict[str, Any]]:
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                "SELECT * FROM montage_exports WHERE id = ?",
                (int(export_id),),
            )
            row = await cur.fetchone()
        if not row:
            return None
        d = dict(row)
        d["body"] = json.loads(str(d.pop("body_json")))
        return d
