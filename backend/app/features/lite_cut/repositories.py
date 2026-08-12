"""Persistence ports and SQLite-backed adapters for LiteCut services."""

from __future__ import annotations

from typing import Any, Protocol

from .db import LiteCutDB


class ProjectRepository(Protocol):
    async def list(self, *, limit: int, offset: int) -> list[dict[str, Any]]: ...
    async def get(self, project_id: int) -> dict[str, Any] | None: ...
    async def create(self, *, name: str, body: dict[str, Any]) -> int: ...
    async def update(self, project_id: int, *, name: str | None = None, body: dict[str, Any] | None = None) -> None: ...
    async def snapshot(self, project_id: int, *, name: str, body: dict[str, Any], reason: str) -> int: ...
    async def list_snapshots(self, project_id: int) -> list[dict[str, Any]]: ...
    async def get_snapshot(self, project_id: int, snapshot_id: int) -> dict[str, Any] | None: ...
    async def delete(self, project_id: int) -> bool: ...
    async def delete_many(self, project_ids: list[int]) -> list[int]: ...
    async def list_assets(self, project_id: int) -> list[dict[str, Any]]: ...


class PresetRepository(Protocol):
    async def list(self, *, kind: str | None, tag: str | None, limit: int, offset: int) -> list[dict[str, Any]]: ...
    async def get(self, preset_id: int) -> dict[str, Any] | None: ...
    async def create(self, **values: Any) -> int: ...
    async def update(self, preset_id: int, *, name: str | None, tags: list[str] | None) -> None: ...
    async def delete(self, preset_id: int) -> bool: ...
    async def touch_applied(self, preset_id: int) -> None: ...


class AssetRepository(Protocol):
    async def list(self, *, project_id: int | None, limit: int, offset: int) -> list[dict[str, Any]]: ...
    async def list_for_project(self, project_id: int) -> list[dict[str, Any]]: ...
    async def get(self, asset_id: int) -> dict[str, Any] | None: ...
    async def create(self, **values: Any) -> int: ...
    async def update_kind(self, asset_id: int, kind: str, mime_type: str | None = None) -> None: ...
    async def update_dimensions(self, asset_id: int, width: int, height: int) -> None: ...
    async def update_file_path(self, asset_id: int, file_path: str) -> None: ...
    async def update_source(self, asset_id: int, **values: Any) -> None: ...
    async def update_media_metadata(self, asset_id: int, **values: Any) -> None: ...
    async def delete(self, asset_id: int) -> bool: ...


class SnapshotRepository(Protocol):
    async def create(self, project_id: int, *, name: str, body: dict[str, Any], reason: str) -> int: ...
    async def list(self, project_id: int, *, limit: int = 50) -> list[dict[str, Any]]: ...
    async def get(self, project_id: int, snapshot_id: int) -> dict[str, Any] | None: ...


class ExportRepository(Protocol):
    async def create(self, **values: Any) -> int: ...
    async def update(self, export_id: int, **values: Any) -> None: ...
    async def get(self, export_id: int) -> dict[str, Any] | None: ...
    async def list(self, *, project_id: int | None, limit: int, offset: int) -> list[dict[str, Any]]: ...


class StorageRepository(Protocol):
    async def migrate_paths(self, old_root: Any, new_root: Any) -> dict[str, int]: ...


class DbProjectRepository:
    def __init__(self, db: LiteCutDB):
        self.db = db

    async def list(self, *, limit: int, offset: int) -> list[dict[str, Any]]:
        return await self.db.list_projects(limit=limit, offset=offset)

    async def get(self, project_id: int) -> dict[str, Any] | None:
        return await self.db.get_project(project_id)

    async def create(self, *, name: str, body: dict[str, Any]) -> int:
        return await self.db.create_project(name=name, body=body)

    async def update(self, project_id: int, *, name: str | None = None, body: dict[str, Any] | None = None) -> None:
        await self.db.update_project(project_id, name=name, body=body)

    async def snapshot(self, project_id: int, *, name: str, body: dict[str, Any], reason: str) -> int:
        return await self.db.create_project_snapshot(project_id, name=name, body=body, reason=reason)

    async def list_snapshots(self, project_id: int) -> list[dict[str, Any]]:
        return await self.db.list_project_snapshots(project_id)

    async def get_snapshot(self, project_id: int, snapshot_id: int) -> dict[str, Any] | None:
        return await self.db.get_project_snapshot(project_id, snapshot_id)

    async def delete(self, project_id: int) -> bool:
        return await self.db.delete_project(project_id)

    async def delete_many(self, project_ids: list[int]) -> list[int]:
        return await self.db.delete_projects(project_ids)

    async def list_assets(self, project_id: int) -> list[dict[str, Any]]:
        return await self.db.list_project_assets(project_id)


class DbPresetRepository:
    def __init__(self, db: LiteCutDB):
        self.db = db

    async def list(self, *, kind: str | None, tag: str | None, limit: int, offset: int) -> list[dict[str, Any]]:
        return await self.db.list_presets(kind=kind, tag=tag, limit=limit, offset=offset)

    async def get(self, preset_id: int) -> dict[str, Any] | None:
        return await self.db.get_preset(preset_id)

    async def create(self, **values: Any) -> int:
        return await self.db.create_preset(**values)

    async def update(self, preset_id: int, *, name: str | None, tags: list[str] | None) -> None:
        await self.db.update_preset(preset_id, name=name, tags=tags)

    async def delete(self, preset_id: int) -> bool:
        return await self.db.delete_preset(preset_id)

    async def touch_applied(self, preset_id: int) -> None:
        await self.db.touch_preset_applied(preset_id)


class DbAssetRepository:
    def __init__(self, db: LiteCutDB):
        self.db = db

    async def list(self, *, project_id: int | None, limit: int, offset: int) -> list[dict[str, Any]]:
        return await self.db.list_assets(project_id=project_id, limit=limit, offset=offset)

    async def list_for_project(self, project_id: int) -> list[dict[str, Any]]:
        return await self.db.list_project_assets(project_id)

    async def get(self, asset_id: int) -> dict[str, Any] | None:
        return await self.db.get_asset(asset_id)

    async def create(self, **values: Any) -> int:
        return await self.db.create_asset(**values)

    async def update_kind(self, asset_id: int, kind: str, mime_type: str | None = None) -> None:
        await self.db.update_asset_kind(asset_id, kind, mime_type)

    async def update_dimensions(self, asset_id: int, width: int, height: int) -> None:
        await self.db.update_asset_dimensions(asset_id, width, height)

    async def update_file_path(self, asset_id: int, file_path: str) -> None:
        await self.db.update_asset_file_path(asset_id, file_path)

    async def update_source(self, asset_id: int, **values: Any) -> None:
        await self.db.update_asset_source(asset_id, **values)

    async def update_media_metadata(self, asset_id: int, **values: Any) -> None:
        await self.db.update_asset_media_metadata(asset_id, **values)

    async def delete(self, asset_id: int) -> bool:
        return await self.db.delete_asset(asset_id)


class DbSnapshotRepository:
    def __init__(self, db: LiteCutDB):
        self.db = db

    async def create(self, project_id: int, *, name: str, body: dict[str, Any], reason: str) -> int:
        return await self.db.create_project_snapshot(project_id, name=name, body=body, reason=reason)

    async def list(self, project_id: int, *, limit: int = 50) -> list[dict[str, Any]]:
        return await self.db.list_project_snapshots(project_id, limit=limit)

    async def get(self, project_id: int, snapshot_id: int) -> dict[str, Any] | None:
        return await self.db.get_project_snapshot(project_id, snapshot_id)


class DbExportRepository:
    def __init__(self, db: LiteCutDB):
        self.db = db

    async def create(self, **values: Any) -> int:
        return await self.db.create_export(**values)

    async def update(self, export_id: int, **values: Any) -> None:
        await self.db.update_export(export_id, **values)

    async def get(self, export_id: int) -> dict[str, Any] | None:
        return await self.db.get_export(export_id)

    async def list(self, *, project_id: int | None, limit: int, offset: int) -> list[dict[str, Any]]:
        return await self.db.list_exports(project_id=project_id, limit=limit, offset=offset)


class DbStorageRepository:
    def __init__(self, db: LiteCutDB):
        self.db = db

    async def migrate_paths(self, old_root: Any, new_root: Any) -> dict[str, int]:
        return await self.db.migrate_asset_storage_paths(old_root, new_root)
