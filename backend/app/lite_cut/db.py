"""SQLite persistence for LiteCut projects and style presets."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

import aiosqlite

from ..demo_db import utc_now_iso


def _replace_storage_root(value: Any, old_root: Path, new_root: Path) -> Any:
    if isinstance(value, dict):
        return {key: _replace_storage_root(item, old_root, new_root) for key, item in value.items()}
    if isinstance(value, list):
        return [_replace_storage_root(item, old_root, new_root) for item in value]
    if not isinstance(value, str) or not value.strip():
        return value
    try:
        relative = Path(value).expanduser().resolve(strict=False).relative_to(old_root)
    except (OSError, ValueError):
        return value
    return str(new_root / relative)


def _unique_project_name(requested: str, existing_names: list[str]) -> str:
    base = str(requested or "").strip() or "未命名工程"
    used = {str(name or "").strip().casefold() for name in existing_names}
    if base.casefold() not in used:
        return base
    index = 1
    while f"{base} ({index})".casefold() in used:
        index += 1
    return f"{base} ({index})"


class LiteCutDB:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path

    async def init_tables(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS lite_cut_projects (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    name        TEXT NOT NULL DEFAULT '',
                    body_json   TEXT NOT NULL,
                    created_at  TEXT NOT NULL,
                    updated_at  TEXT NOT NULL
                )
                """,
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS lite_cut_presets (
                    id                INTEGER PRIMARY KEY AUTOINCREMENT,
                    name              TEXT NOT NULL,
                    kind              TEXT NOT NULL,
                    tags_json         TEXT,
                    body_json         TEXT NOT NULL,
                    thumb_path        TEXT,
                    source_project_id INTEGER,
                    last_applied_at   TEXT,
                    created_at        TEXT NOT NULL,
                    updated_at        TEXT NOT NULL
                )
                """,
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_lite_cut_projects_updated ON lite_cut_projects(updated_at DESC)",
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_lite_cut_presets_kind ON lite_cut_presets(kind)",
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS lite_cut_exports (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id     INTEGER,
                    body_json      TEXT NOT NULL,
                    status         TEXT NOT NULL DEFAULT 'pending',
                    error_msg      TEXT,
                    output_path    TEXT,
                    created_at     TEXT NOT NULL,
                    updated_at     TEXT NOT NULL,
                    FOREIGN KEY(project_id) REFERENCES lite_cut_projects(id)
                )
                """,
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS lite_cut_assets (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id   INTEGER,
                    name         TEXT NOT NULL,
                    kind         TEXT NOT NULL,
                    mime_type    TEXT,
                    file_path    TEXT NOT NULL,
                    duration_sec REAL,
                    width        INTEGER,
                    height       INTEGER,
                    created_at   TEXT NOT NULL,
                    FOREIGN KEY(project_id) REFERENCES lite_cut_projects(id)
                )
                """,
            )
            columns = {row[1] for row in await (await conn.execute("PRAGMA table_info(lite_cut_assets)")).fetchall()}
            if "width" not in columns:
                await conn.execute("ALTER TABLE lite_cut_assets ADD COLUMN width INTEGER")
            if "height" not in columns:
                await conn.execute("ALTER TABLE lite_cut_assets ADD COLUMN height INTEGER")
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_lite_cut_assets_project ON lite_cut_assets(project_id)",
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_lite_cut_exports_project_updated ON lite_cut_exports(project_id, updated_at DESC)",
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS lite_cut_project_snapshots (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id  INTEGER NOT NULL,
                    name        TEXT NOT NULL,
                    body_json   TEXT NOT NULL,
                    reason      TEXT NOT NULL DEFAULT 'save',
                    created_at  TEXT NOT NULL,
                    FOREIGN KEY(project_id) REFERENCES lite_cut_projects(id)
                )
                """,
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_lite_cut_snapshots_project_created ON lite_cut_project_snapshots(project_id, created_at DESC)",
            )
            rows = await (await conn.execute("SELECT id, name FROM lite_cut_projects ORDER BY id")).fetchall()
            used_names: list[str] = []
            for project_id, raw_name in rows:
                unique_name = _unique_project_name(str(raw_name or ""), used_names)
                used_names.append(unique_name)
                if unique_name != str(raw_name or ""):
                    await conn.execute("UPDATE lite_cut_projects SET name = ? WHERE id = ?", (unique_name, int(project_id)))
            await conn.commit()

    async def recover_interrupted_exports(self) -> list[str]:
        """Mark jobs left active by a process exit and return their partial outputs."""
        active = ("queued", "running", "cancelling", "pending")
        placeholders = ",".join("?" for _ in active)
        now = utc_now_iso()
        async with aiosqlite.connect(self.db_path) as conn:
            rows = await (
                await conn.execute(
                    f"SELECT output_path FROM lite_cut_exports WHERE status IN ({placeholders})",
                    active,
                )
            ).fetchall()
            await conn.execute(
                f"UPDATE lite_cut_exports SET status = 'interrupted', error_msg = 'LITECUT_EXPORT_INTERRUPTED', updated_at = ? WHERE status IN ({placeholders})",
                (now, *active),
            )
            await conn.commit()
        return [str(row[0]) for row in rows if row and row[0]]

    async def list_projects(self, *, limit: int = 100, offset: int = 0) -> list[dict[str, Any]]:
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                """
                SELECT id, name, body_json, created_at, updated_at
                FROM lite_cut_projects
                ORDER BY updated_at DESC
                LIMIT ? OFFSET ?
                """,
                (limit, offset),
            )
            rows = await cur.fetchall()
        return [self._project_row_to_dict(r) for r in rows]

    async def get_project(self, project_id: int) -> Optional[dict[str, Any]]:
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                "SELECT id, name, body_json, created_at, updated_at FROM lite_cut_projects WHERE id = ?",
                (int(project_id),),
            )
            row = await cur.fetchone()
        if not row:
            return None
        return self._project_row_to_dict(row)

    async def create_project(self, *, name: str, body: dict[str, Any]) -> int:
        now = utc_now_iso()
        payload = json.dumps(body, ensure_ascii=False)
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute("BEGIN IMMEDIATE")
            rows = await (await conn.execute("SELECT name FROM lite_cut_projects")).fetchall()
            unique_name = _unique_project_name(name, [str(row[0] or "") for row in rows])
            cur = await conn.execute(
                """
                INSERT INTO lite_cut_projects(name, body_json, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                """,
                (unique_name, payload, now, now),
            )
            await conn.commit()
            return int(cur.lastrowid)

    async def update_project(
        self,
        project_id: int,
        *,
        name: Optional[str] = None,
        body: Optional[dict[str, Any]] = None,
    ) -> None:
        now = utc_now_iso()
        fields: list[str] = ["updated_at = ?"]
        if name is not None:
            fields.append("name = ?")
        if body is not None:
            fields.append("body_json = ?")
        async with aiosqlite.connect(self.db_path) as conn:
            unique_name = name
            if name is not None:
                await conn.execute("BEGIN IMMEDIATE")
                rows = await (await conn.execute("SELECT name FROM lite_cut_projects WHERE id != ?", (int(project_id),))).fetchall()
                unique_name = _unique_project_name(name, [str(row[0] or "") for row in rows])
            vals: list[Any] = [now]
            if name is not None:
                vals.append(unique_name)
            if body is not None:
                vals.append(json.dumps(body, ensure_ascii=False))
            vals.append(int(project_id))
            cur = await conn.execute(
                f"UPDATE lite_cut_projects SET {', '.join(fields)} WHERE id = ?",
                vals,
            )
            await conn.commit()
            if cur.rowcount == 0:
                raise ValueError("project not found")

    async def create_project_snapshot(self, project_id: int, *, name: str, body: dict[str, Any], reason: str = "save") -> int:
        """Persist a recoverable project body and keep the latest 50 snapshots."""
        now = utc_now_iso()
        payload = json.dumps(body, ensure_ascii=False, sort_keys=True)
        async with aiosqlite.connect(self.db_path) as conn:
            previous = await (await conn.execute(
                "SELECT body_json FROM lite_cut_project_snapshots WHERE project_id = ? ORDER BY id DESC LIMIT 1",
                (int(project_id),),
            )).fetchone()
            if previous and str(previous[0]) == payload:
                return 0
            cur = await conn.execute(
                "INSERT INTO lite_cut_project_snapshots(project_id, name, body_json, reason, created_at) VALUES (?, ?, ?, ?, ?)",
                (int(project_id), str(name or ""), payload, str(reason or "save"), now),
            )
            await conn.execute(
                """
                DELETE FROM lite_cut_project_snapshots
                WHERE project_id = ? AND id NOT IN (
                    SELECT id FROM lite_cut_project_snapshots WHERE project_id = ? ORDER BY id DESC LIMIT 50
                )
                """,
                (int(project_id), int(project_id)),
            )
            await conn.commit()
            return int(cur.lastrowid)

    async def list_project_snapshots(self, project_id: int, *, limit: int = 50) -> list[dict[str, Any]]:
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            rows = await (await conn.execute(
                "SELECT id, project_id, name, reason, created_at FROM lite_cut_project_snapshots WHERE project_id = ? ORDER BY id DESC LIMIT ?",
                (int(project_id), int(limit)),
            )).fetchall()
        return [dict(row) for row in rows]

    async def get_project_snapshot(self, project_id: int, snapshot_id: int) -> Optional[dict[str, Any]]:
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            row = await (await conn.execute(
                "SELECT id, project_id, name, body_json, reason, created_at FROM lite_cut_project_snapshots WHERE project_id = ? AND id = ?",
                (int(project_id), int(snapshot_id)),
            )).fetchone()
        if not row:
            return None
        item = dict(row)
        item["body"] = json.loads(str(item.pop("body_json")))
        return item

    async def delete_project(self, project_id: int) -> bool:
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute("DELETE FROM lite_cut_project_snapshots WHERE project_id = ?", (int(project_id),))
            await conn.execute("DELETE FROM lite_cut_assets WHERE project_id = ?", (int(project_id),))
            await conn.execute("DELETE FROM lite_cut_exports WHERE project_id = ?", (int(project_id),))
            cur = await conn.execute(
                "DELETE FROM lite_cut_projects WHERE id = ?",
                (int(project_id),),
            )
            await conn.commit()
            return cur.rowcount > 0

    async def delete_projects(self, project_ids: list[int]) -> list[int]:
        ids = sorted({int(value) for value in project_ids if int(value) > 0})
        if not ids:
            return []
        placeholders = ",".join("?" for _ in ids)
        async with aiosqlite.connect(self.db_path) as conn:
            cur = await conn.execute(
                f"SELECT id FROM lite_cut_projects WHERE id IN ({placeholders})",
                ids,
            )
            existing = [int(row[0]) for row in await cur.fetchall()]
            if existing:
                delete_placeholders = ",".join("?" for _ in existing)
                await conn.execute(
                    f"DELETE FROM lite_cut_assets WHERE project_id IN ({delete_placeholders})",
                    existing,
                )
                await conn.execute(
                    f"DELETE FROM lite_cut_project_snapshots WHERE project_id IN ({delete_placeholders})",
                    existing,
                )
                await conn.execute(
                    f"DELETE FROM lite_cut_exports WHERE project_id IN ({delete_placeholders})",
                    existing,
                )
                await conn.execute(
                    f"DELETE FROM lite_cut_projects WHERE id IN ({delete_placeholders})",
                    existing,
                )
                await conn.commit()
            return existing

    async def list_presets(
        self,
        *,
        kind: str | None = None,
        tag: str | None = None,
        limit: int = 200,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        where: list[str] = []
        params: list[Any] = []
        if kind:
            where.append("kind = ?")
            params.append(kind)
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        params.extend([limit, offset])
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                f"""
                SELECT id, name, kind, tags_json, body_json, thumb_path,
                       source_project_id, last_applied_at, created_at, updated_at
                FROM lite_cut_presets
                {clause}
                ORDER BY updated_at DESC
                LIMIT ? OFFSET ?
                """,
                params,
            )
            rows = await cur.fetchall()
        items = [self._preset_row_to_dict(r) for r in rows]
        if tag:
            tag_l = tag.strip().lower()
            items = [
                p
                for p in items
                if any(str(t).lower() == tag_l for t in (p.get("tags") or []))
            ]
        return items

    async def get_preset(self, preset_id: int) -> Optional[dict[str, Any]]:
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                """
                SELECT id, name, kind, tags_json, body_json, thumb_path,
                       source_project_id, last_applied_at, created_at, updated_at
                FROM lite_cut_presets WHERE id = ?
                """,
                (int(preset_id),),
            )
            row = await cur.fetchone()
        if not row:
            return None
        return self._preset_row_to_dict(row)

    async def create_preset(
        self,
        *,
        name: str,
        kind: str,
        body: dict[str, Any],
        tags: list[str] | None = None,
        thumb_path: str | None = None,
        source_project_id: int | None = None,
    ) -> int:
        now = utc_now_iso()
        async with aiosqlite.connect(self.db_path) as conn:
            cur = await conn.execute(
                """
                INSERT INTO lite_cut_presets(
                    name, kind, tags_json, body_json, thumb_path,
                    source_project_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    name,
                    kind,
                    json.dumps(tags or [], ensure_ascii=False),
                    json.dumps(body, ensure_ascii=False),
                    thumb_path,
                    source_project_id,
                    now,
                    now,
                ),
            )
            await conn.commit()
            return int(cur.lastrowid)

    async def update_preset(
        self,
        preset_id: int,
        *,
        name: Optional[str] = None,
        tags: Optional[list[str]] = None,
    ) -> None:
        now = utc_now_iso()
        fields: list[str] = ["updated_at = ?"]
        vals: list[Any] = [now]
        if name is not None:
            fields.append("name = ?")
            vals.append(name)
        if tags is not None:
            fields.append("tags_json = ?")
            vals.append(json.dumps(tags, ensure_ascii=False))
        vals.append(int(preset_id))
        async with aiosqlite.connect(self.db_path) as conn:
            cur = await conn.execute(
                f"UPDATE lite_cut_presets SET {', '.join(fields)} WHERE id = ?",
                vals,
            )
            await conn.commit()
            if cur.rowcount == 0:
                raise ValueError("preset not found")

    async def delete_preset(self, preset_id: int) -> bool:
        async with aiosqlite.connect(self.db_path) as conn:
            cur = await conn.execute(
                "DELETE FROM lite_cut_presets WHERE id = ?",
                (int(preset_id),),
            )
            await conn.commit()
            return cur.rowcount > 0

    async def touch_preset_applied(self, preset_id: int) -> None:
        now = utc_now_iso()
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute(
                "UPDATE lite_cut_presets SET last_applied_at = ?, updated_at = ? WHERE id = ?",
                (now, now, int(preset_id)),
            )
            await conn.commit()

    async def list_assets(
        self,
        *,
        project_id: int | None = None,
        limit: int = 500,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        where = ""
        params: list[Any] = []
        if project_id is not None:
            where = "WHERE project_id = ? OR project_id IS NULL"
            params.append(int(project_id))
        params.extend([limit, offset])
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                f"""
                SELECT id, project_id, name, kind, mime_type, file_path, duration_sec, width, height, created_at
                FROM lite_cut_assets
                {where}
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
                """,
                params,
            )
            rows = await cur.fetchall()
        return [dict(r) for r in rows]

    async def list_project_assets(self, project_id: int) -> list[dict[str, Any]]:
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                """
                SELECT id, project_id, name, kind, mime_type, file_path, duration_sec, width, height, created_at
                FROM lite_cut_assets WHERE project_id = ? ORDER BY created_at DESC
                """,
                (int(project_id),),
            )
            rows = await cur.fetchall()
        return [dict(row) for row in rows]

    async def get_asset(self, asset_id: int) -> Optional[dict[str, Any]]:
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                """
                SELECT id, project_id, name, kind, mime_type, file_path, duration_sec, width, height, created_at
                FROM lite_cut_assets WHERE id = ?
                """,
                (int(asset_id),),
            )
            row = await cur.fetchone()
        return dict(row) if row else None

    async def create_asset(
        self,
        *,
        name: str,
        kind: str,
        file_path: str,
        mime_type: str | None = None,
        duration_sec: float | None = None,
        width: int | None = None,
        height: int | None = None,
        project_id: int | None = None,
    ) -> int:
        now = utc_now_iso()
        async with aiosqlite.connect(self.db_path) as conn:
            cur = await conn.execute(
                """
                INSERT INTO lite_cut_assets(
                    project_id, name, kind, mime_type, file_path, duration_sec, width, height, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (project_id, name, kind, mime_type, file_path, duration_sec, width, height, now),
            )
            await conn.commit()
            return int(cur.lastrowid)

    async def update_asset_kind(self, asset_id: int, kind: str, mime_type: str | None = None) -> None:
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute(
                "UPDATE lite_cut_assets SET kind = ?, mime_type = COALESCE(?, mime_type) WHERE id = ?",
                (str(kind), mime_type, int(asset_id)),
            )
            await conn.commit()

    async def update_asset_dimensions(self, asset_id: int, width: int, height: int) -> None:
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute(
                "UPDATE lite_cut_assets SET width = ?, height = ? WHERE id = ?",
                (int(width), int(height), int(asset_id)),
            )
            await conn.commit()

    async def update_asset_file_path(self, asset_id: int, file_path: str) -> None:
        async with aiosqlite.connect(self.db_path) as conn:
            await conn.execute(
                "UPDATE lite_cut_assets SET file_path = ? WHERE id = ?",
                (str(file_path), int(asset_id)),
            )
            await conn.commit()

    async def migrate_asset_storage_paths(self, old_root: Path, new_root: Path) -> dict[str, int]:
        """Rewrite every persisted LiteCut path after the storage tree was copied."""
        old = old_root.expanduser().resolve(strict=False)
        new = new_root.expanduser().resolve(strict=False)
        counts = {"assets": 0, "projects": 0, "presets": 0, "exports": 0}
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row

            assets = await (await conn.execute("SELECT id, file_path FROM lite_cut_assets")).fetchall()
            for row in assets:
                replaced = _replace_storage_root(str(row["file_path"]), old, new)
                if replaced != row["file_path"]:
                    await conn.execute("UPDATE lite_cut_assets SET file_path = ? WHERE id = ?", (replaced, int(row["id"])))
                    counts["assets"] += 1

            for table, id_column, path_columns in (
                ("lite_cut_projects", "id", ("body_json",)),
                ("lite_cut_presets", "id", ("body_json", "thumb_path")),
                ("lite_cut_exports", "id", ("body_json", "output_path")),
            ):
                rows = await (await conn.execute(
                    f"SELECT {id_column}, {', '.join(path_columns)} FROM {table}",
                )).fetchall()
                for row in rows:
                    updates: dict[str, str | None] = {}
                    for column in path_columns:
                        raw = row[column]
                        if column == "body_json" and raw:
                            try:
                                parsed = json.loads(str(raw))
                            except (TypeError, ValueError):
                                continue
                            replaced_body = _replace_storage_root(parsed, old, new)
                            if replaced_body != parsed:
                                updates[column] = json.dumps(replaced_body, ensure_ascii=False)
                        elif raw:
                            replaced_path = _replace_storage_root(str(raw), old, new)
                            if replaced_path != raw:
                                updates[column] = replaced_path
                    if updates:
                        assignments = ", ".join(f"{column} = ?" for column in updates)
                        await conn.execute(
                            f"UPDATE {table} SET {assignments} WHERE {id_column} = ?",
                            (*updates.values(), int(row[id_column])),
                        )
                        counts[table.removeprefix("lite_cut_")] += 1
            await conn.commit()
        return counts

    async def delete_asset(self, asset_id: int) -> bool:
        async with aiosqlite.connect(self.db_path) as conn:
            cur = await conn.execute(
                "DELETE FROM lite_cut_assets WHERE id = ?",
                (int(asset_id),),
            )
            await conn.commit()
            return cur.rowcount > 0

    @staticmethod
    def _project_row_to_dict(row: aiosqlite.Row) -> dict[str, Any]:
        d = dict(row)
        d["body"] = json.loads(str(d.pop("body_json")))
        return d

    @staticmethod
    def _preset_row_to_dict(row: aiosqlite.Row) -> dict[str, Any]:
        d = dict(row)
        raw_tags = d.pop("tags_json", None)
        d["tags"] = json.loads(str(raw_tags)) if raw_tags else []
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
                INSERT INTO lite_cut_exports(project_id, body_json, status, error_msg, output_path, created_at, updated_at)
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
                f"UPDATE lite_cut_exports SET {', '.join(fields)} WHERE id = ?",
                vals,
            )
            await conn.commit()

    async def get_export(self, export_id: int) -> Optional[dict[str, Any]]:
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                """
                SELECT id, project_id, body_json, status, error_msg, output_path, created_at, updated_at
                FROM lite_cut_exports
                WHERE id = ?
                """,
                (int(export_id),),
            )
            row = await cur.fetchone()
        if not row:
            return None
        d = dict(row)
        raw_body = d.pop("body_json", "{}")
        try:
            d["body"] = json.loads(str(raw_body))
        except Exception:
            d["body"] = {}
        return d

    async def list_exports(
        self,
        *,
        project_id: int | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        where = ""
        params: list[Any] = []
        if project_id is not None:
            where = "WHERE project_id = ?"
            params.append(int(project_id))
        params.extend([int(limit), int(offset)])
        async with aiosqlite.connect(self.db_path) as conn:
            conn.row_factory = aiosqlite.Row
            cur = await conn.execute(
                f"""
                SELECT id, project_id, status, error_msg, output_path, created_at, updated_at
                FROM lite_cut_exports
                {where}
                ORDER BY updated_at DESC
                LIMIT ? OFFSET ?
                """,
                params,
            )
            rows = await cur.fetchall()
        return [dict(row) for row in rows]
