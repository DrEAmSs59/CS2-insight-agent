from __future__ import annotations

import asyncio
import inspect
from unittest.mock import AsyncMock

import pytest

from app.features.lite_cut.repositories import DbAssetRepository, DbExportRepository, DbProjectRepository, DbSnapshotRepository
from app.features.lite_cut.services import AssetService, ExportHistoryService, LiteCutServiceError, ProjectService, SnapshotService
from app.features.lite_cut import assets_api, export_api, project_file_api


class MemoryProjects:
    def __init__(self):
        self.items: dict[int, dict] = {}
        self.snapshots: list[dict] = []

    async def list(self, *, limit: int, offset: int):
        return list(self.items.values())[offset:offset + limit]

    async def get(self, project_id: int):
        return self.items.get(project_id)

    async def create(self, *, name: str, body: dict):
        self.items[1] = {"id": 1, "name": name, "body": body}
        return 1

    async def update(self, project_id: int, *, name=None, body=None):
        if project_id not in self.items:
            raise ValueError("project not found")
        if name is not None:
            self.items[project_id]["name"] = name
        if body is not None:
            self.items[project_id]["body"] = body

    async def snapshot(self, project_id: int, *, name: str, body: dict, reason: str):
        self.snapshots.append({"project_id": project_id, "name": name, "body": body, "reason": reason})
        return len(self.snapshots)


class UnusedStorage:
    async def quarantine(self, project_ids):  # pragma: no cover - defensive fake
        raise AssertionError(f"unexpected quarantine: {project_ids}")


def test_project_service_owns_normalization_and_snapshot_transaction():
    repo = MemoryProjects()
    service = ProjectService(repo, UnusedStorage())

    created = asyncio.run(service.create(name="  Demo  ", body=None))
    assert created["name"] == "Demo"
    assert created["body"]["schema_version"] == 3

    updated = asyncio.run(service.patch(1, name="Saved", body=created["body"]))
    assert updated["name"] == "Saved"
    assert repo.snapshots[0]["reason"] == "save"


def test_project_service_reports_domain_error_without_fastapi_dependency():
    service = ProjectService(MemoryProjects(), UnusedStorage())
    with pytest.raises(LiteCutServiceError) as exc_info:
        asyncio.run(service.get(404))
    assert exc_info.value.status_code == 404
    assert exc_info.value.detail == "LITECUT_PROJECT_NOT_FOUND"


def test_db_project_repository_is_a_thin_persistence_adapter():
    db = AsyncMock()
    db.list_projects.return_value = [{"id": 9}]
    repository = DbProjectRepository(db)

    assert asyncio.run(repository.list(limit=3, offset=2)) == [{"id": 9}]
    db.list_projects.assert_awaited_once_with(limit=3, offset=2)


def test_asset_snapshot_and_export_repositories_are_thin_adapters():
    db = AsyncMock()
    db.list_assets.return_value = [{"id": 1}]
    db.list_project_snapshots.return_value = [{"id": 2}]
    db.list_exports.return_value = [{"id": 3}]

    assert asyncio.run(DbAssetRepository(db).list(project_id=4, limit=5, offset=6)) == [{"id": 1}]
    assert asyncio.run(DbSnapshotRepository(db).list(4, limit=7)) == [{"id": 2}]
    assert asyncio.run(DbExportRepository(db).list(project_id=4, limit=8, offset=9)) == [{"id": 3}]
    db.list_assets.assert_awaited_once_with(project_id=4, limit=5, offset=6)
    db.list_project_snapshots.assert_awaited_once_with(4, limit=7)
    db.list_exports.assert_awaited_once_with(project_id=4, limit=8, offset=9)


def test_use_case_services_work_with_fake_repositories():
    assets = AsyncMock()
    assets.list.return_value = [{"id": 5}]
    assets.list_for_project.return_value = [{"id": 5}]
    asset_service = AssetService(assets)
    assert asyncio.run(asset_service.list(project_id=1, limit=20, offset=0))["items"] == [{"id": 5}]

    projects = AsyncMock()
    projects.get.return_value = {"id": 1, "name": "P", "body": {"schema_version": 3, "tracks": [], "overlays": []}}
    snapshots = AsyncMock()
    snapshots.create.return_value = 11
    assert asyncio.run(SnapshotService(projects, snapshots).create(1, reason="before_export")) == 11
    exports = AsyncMock()
    exports.list.return_value = [{"id": 7}]
    result = asyncio.run(ExportHistoryService(exports).list(project_id=1, limit=8, offset=0))
    assert result["items"] == [{"id": 7}]


def test_http_routes_do_not_own_database_file_copy_or_ffmpeg_execution():
    source = "\n".join(inspect.getsource(module) for module in (assets_api, export_api, project_file_api))
    forbidden = (
        "get_lite_cut_db().",
        "resolve_ffmpeg_binary",
        "resolve_ffprobe_binary",
        "export_lite_cut_project(",
        "shutil.copy",
        "zipfile.ZipFile",
    )
    assert all(token not in source for token in forbidden)
