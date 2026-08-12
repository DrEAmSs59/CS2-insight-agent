"""LiteCut API composition root.

Domain behavior lives in focused sibling modules. A small compatibility surface
is kept here for existing backend imports; new code should import the owning
module directly.
"""

from fastapi import APIRouter

from .assets_api import (
    LiteCutAssetValidationBody,
    get_lite_cut_asset_metadata,
    router as assets_router,
    validate_lite_cut_assets,
)
from .export_api import router as export_router
from .project_file_api import router as project_file_router
from .presets_api import router as presets_router
from .projects_api import (
    _delete_project_asset_files,
    _preset_asset_warnings,
    router as projects_router,
)
from .proxy_api import (
    _create_preview_proxy_sync,
    _decorate_asset_preview_state,
)
from .runtime import (
    LiteCutExportJob,
    LiteCutPreviewProxyJob,
    LiteCutStorageMigrationJob,
    export_jobs as _export_jobs,
    get_lite_cut_db as _get_lite_cut_db,
    get_montage_db as _get_montage_db,
    preview_proxy_jobs as _preview_proxy_jobs,
    resolve_lite_cut_encoder as _resolve_lite_cut_encoder,
    shutdown_lite_cut_jobs,
    storage_migration_jobs as _storage_migration_jobs,
)
from .storage_api import (
    LiteCutStorageMoveBody,
    _copy_storage_tree_with_progress,
    _run_storage_migration,
    _verify_storage_copy,
    get_lite_cut_storage_migration,
    migrate_lite_cut_storage,
    router as storage_router,
)

router = APIRouter()
router.include_router(storage_router)
router.include_router(projects_router)
router.include_router(project_file_router)
router.include_router(presets_router)
router.include_router(export_router)
router.include_router(assets_router)
