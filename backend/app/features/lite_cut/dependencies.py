"""Composition root for LiteCut application services and repositories."""

from __future__ import annotations

from dataclasses import dataclass

from .repositories import (
    DbAssetRepository,
    DbExportRepository,
    DbPresetRepository,
    DbProjectRepository,
    DbSnapshotRepository,
    DbStorageRepository,
)
from .runtime import get_lite_cut_db
from .services import (
    AssetService,
    ExportHistoryService,
    PortableService,
    PresetService,
    SnapshotService,
)


@dataclass(frozen=True)
class LiteCutServices:
    assets: AssetService
    exports: ExportHistoryService
    portable: PortableService
    presets: PresetService
    snapshots: SnapshotService
    projects: DbProjectRepository
    storage: DbStorageRepository


def build_lite_cut_services(db) -> LiteCutServices:
    """Build service adapters around an explicitly supplied database."""
    projects = DbProjectRepository(db)
    assets = DbAssetRepository(db)
    return LiteCutServices(
        assets=AssetService(assets),
        exports=ExportHistoryService(DbExportRepository(db)),
        portable=PortableService(projects, assets),
        presets=PresetService(DbPresetRepository(db), projects),
        snapshots=SnapshotService(projects, DbSnapshotRepository(db)),
        projects=projects,
        storage=DbStorageRepository(db),
    )


def get_lite_cut_services() -> LiteCutServices:
    """Build request-scoped adapters around the initialized LiteCut database."""
    return build_lite_cut_services(get_lite_cut_db())
