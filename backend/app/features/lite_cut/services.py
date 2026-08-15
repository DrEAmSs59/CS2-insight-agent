"""Application services for LiteCut project and preset use cases."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from ...file_quarantine import QuarantineBatch, quarantine_files
from .models import LiteCutPresetCreate, LiteCutPresetPatch, PresetApplyRequest, empty_project
from .preset_apply import apply_preset_to_project
from .project_codec import LiteCutProjectCompatibilityError, serialize_project_body
from .repositories import AssetRepository, ExportRepository, PresetRepository, ProjectRepository, SnapshotRepository


class LiteCutServiceError(Exception):
    def __init__(self, status_code: int, detail: str | dict[str, Any], *, code: bool = True):
        super().__init__(str(detail))
        self.status_code = status_code
        self.detail = detail
        self.code = code


def _normalized_project(raw: dict[str, Any] | None) -> dict[str, Any]:
    try:
        return serialize_project_body(raw)
    except LiteCutProjectCompatibilityError as exc:
        raise LiteCutServiceError(
            422,
            {"code": exc.code, "message": str(exc)},
            code=False,
        ) from exc
    except ValidationError as exc:
        raise LiteCutServiceError(
            422,
            {"code": "LITECUT_PROJECT_INVALID", "message": str(exc)},
            code=False,
        ) from exc


def preset_asset_warnings(project_body: dict[str, Any]) -> list[dict[str, str]]:
    warnings: list[dict[str, str]] = []
    audio = project_body.get("audio") if isinstance(project_body.get("audio"), dict) else {}
    bgm = audio.get("bgm") if isinstance(audio.get("bgm"), dict) else None
    bgm_path = str(bgm.get("path") or "").strip() if bgm else ""
    if bgm_path and not Path(bgm_path).expanduser().is_file():
        warnings.append({"kind": "bgm", "path": bgm_path, "message": "BGM file is unavailable. Select a replacement in the Audio panel."})
    for overlay in project_body.get("overlays") or []:
        if not isinstance(overlay, dict):
            continue
        text = overlay.get("text") if isinstance(overlay.get("text"), dict) else {}
        font_path = str(text.get("font_file") or "").strip()
        if font_path and not Path(font_path).expanduser().is_file():
            warnings.append({"kind": "font", "path": font_path, "message": "Font file is unavailable. Select a replacement in the Text panel."})
    return warnings


class ProjectAssetStorage:
    """Filesystem boundary used by project deletion transactions."""

    def __init__(self, projects: ProjectRepository, stop_proxy_job):
        self.projects = projects
        self.stop_proxy_job = stop_proxy_job

    async def delete(self, project_id: int) -> None:
        from .assets import delete_asset_row_bundle

        assets = await self.projects.list_assets(project_id)
        for asset in assets:
            await self.stop_proxy_job(int(asset["id"]))
        await asyncio.gather(*[
            asyncio.to_thread(delete_asset_row_bundle, asset)
            for asset in assets
        ])

    async def quarantine(self, project_ids: list[int]) -> QuarantineBatch:
        from .assets import asset_row_bundle_paths

        assets: list[dict[str, Any]] = []
        for project_id in project_ids:
            assets.extend(await self.projects.list_assets(project_id))
        for asset in assets:
            await self.stop_proxy_job(int(asset["id"]))
        bundle_paths: list[Path] = []
        for asset in assets:
            bundle_paths.extend(await asyncio.to_thread(asset_row_bundle_paths, asset))
        return await asyncio.to_thread(quarantine_files, bundle_paths, "lite-cut")


class ProjectService:
    def __init__(self, projects: ProjectRepository, storage: ProjectAssetStorage):
        self.projects = projects
        self.storage = storage

    async def list(self, *, limit: int, offset: int) -> dict[str, Any]:
        return {"items": await self.projects.list(limit=limit, offset=offset), "limit": limit, "offset": offset}

    async def create(self, *, name: str, body: dict[str, Any] | None) -> dict[str, Any]:
        project_id = await self.projects.create(name=name.strip(), body=_normalized_project(body))
        item = await self.projects.get(project_id)
        if not item:
            raise LiteCutServiceError(500, "LITECUT_PROJECT_SAVE_FAILED")
        return item

    async def get(self, project_id: int) -> dict[str, Any]:
        item = await self.projects.get(project_id)
        if not item:
            raise LiteCutServiceError(404, "LITECUT_PROJECT_NOT_FOUND")
        return item

    async def patch(self, project_id: int, *, name: str | None, body: dict[str, Any] | None) -> dict[str, Any]:
        if name is None and body is None:
            raise LiteCutServiceError(400, "LITECUT_PROJECT_NOTHING_TO_UPDATE")
        previous = await self.projects.get(project_id)
        if not previous:
            raise LiteCutServiceError(404, "LITECUT_PROJECT_NOT_FOUND")
        try:
            if body is not None:
                normalized = _normalized_project(body)
                await self.projects.snapshot(
                    project_id,
                    name=name.strip() if name is not None else str(previous.get("name") or ""),
                    body=normalized,
                    reason="save",
                )
                await self.projects.update(project_id, name=name.strip() if name is not None else None, body=normalized)
            elif name is not None:
                await self.projects.update(project_id, name=name.strip())
        except ValueError as exc:
            code = "LITECUT_PROJECT_NOT_FOUND" if str(exc) == "project not found" else "LITECUT_PROJECT_SAVE_FAILED"
            raise LiteCutServiceError(404 if code.endswith("NOT_FOUND") else 400, code) from exc
        return await self.get(project_id)

    async def list_snapshots(self, project_id: int) -> dict[str, Any]:
        await self.get(project_id)
        return {"items": await self.projects.list_snapshots(project_id)}

    async def restore_snapshot(self, project_id: int, snapshot_id: int) -> dict[str, Any]:
        current = await self.get(project_id)
        snapshot = await self.projects.get_snapshot(project_id, snapshot_id)
        if not snapshot:
            raise LiteCutServiceError(404, "snapshot not found", code=False)
        await self.projects.snapshot(
            project_id,
            name=str(current.get("name") or ""),
            body=current["body"],
            reason="before_restore",
        )
        await self.projects.update(project_id, body=_normalized_project(snapshot["body"]))
        item = await self.projects.get(project_id)
        if not item:
            raise LiteCutServiceError(500, "LITECUT_PROJECT_SAVE_FAILED")
        return item

    async def delete(self, project_id: int) -> dict[str, Any]:
        await self.get(project_id)
        try:
            quarantined = await self.storage.quarantine([project_id])
        except OSError as exc:
            raise LiteCutServiceError(409, f"Project assets could not be moved to the recovery area: {exc}", code=False) from exc
        try:
            if not await self.projects.delete(project_id):
                raise LiteCutServiceError(404, "LITECUT_PROJECT_NOT_FOUND")
        except Exception:
            await asyncio.to_thread(quarantined.restore)
            raise
        return {"deleted": True, "id": project_id, "recovery_directory": str(quarantined.directory) if quarantined.files else None}

    async def delete_many(self, ids: list[int]) -> dict[str, Any]:
        project_ids = sorted({int(value) for value in ids if int(value) > 0})
        if not project_ids or len(project_ids) > 500:
            raise LiteCutServiceError(400, "project ids must contain 1 to 500 items", code=False)
        try:
            quarantined = await self.storage.quarantine(project_ids)
        except OSError as exc:
            raise LiteCutServiceError(409, f"Project assets could not be moved to the recovery area: {exc}", code=False) from exc
        try:
            deleted_ids = await self.projects.delete_many(project_ids)
        except Exception:
            await asyncio.to_thread(quarantined.restore)
            raise
        return {"deleted": len(deleted_ids), "ids": deleted_ids, "recovery_directory": str(quarantined.directory) if quarantined.files else None}


class PresetService:
    def __init__(self, presets: PresetRepository, projects: ProjectRepository):
        self.presets = presets
        self.projects = projects

    async def list(self, *, kind: str | None, tag: str | None, limit: int, offset: int) -> dict[str, Any]:
        items = await self.presets.list(kind=kind, tag=tag, limit=limit, offset=offset)
        return {"items": items, "limit": limit, "offset": offset}

    async def create(self, body: LiteCutPresetCreate) -> dict[str, Any]:
        name = body.name.strip()
        if not name:
            raise LiteCutServiceError(400, "LITECUT_PRESET_NAME_REQUIRED")
        preset_id = await self.presets.create(name=name, kind=body.kind, body=body.body, tags=body.tags, source_project_id=body.source_project_id)
        item = await self.presets.get(preset_id)
        if not item:
            raise LiteCutServiceError(500, "LITECUT_PRESET_SAVE_FAILED")
        return item

    async def get(self, preset_id: int) -> dict[str, Any]:
        item = await self.presets.get(preset_id)
        if not item:
            raise LiteCutServiceError(404, "LITECUT_PRESET_NOT_FOUND")
        return item

    async def patch(self, preset_id: int, body: LiteCutPresetPatch) -> dict[str, Any]:
        if body.name is None and body.tags is None:
            raise LiteCutServiceError(400, "LITECUT_PRESET_NOTHING_TO_UPDATE")
        try:
            await self.presets.update(preset_id, name=body.name.strip() if body.name is not None else None, tags=body.tags)
        except ValueError as exc:
            code = "LITECUT_PRESET_NOT_FOUND" if str(exc) == "preset not found" else "LITECUT_PRESET_SAVE_FAILED"
            raise LiteCutServiceError(404 if code.endswith("NOT_FOUND") else 400, code) from exc
        return await self.get(preset_id)

    async def delete(self, preset_id: int) -> dict[str, Any]:
        if not await self.presets.delete(preset_id):
            raise LiteCutServiceError(404, "LITECUT_PRESET_NOT_FOUND")
        return {"deleted": True, "id": preset_id}

    async def apply(self, preset_id: int, body: PresetApplyRequest) -> dict[str, Any]:
        preset = await self.get(preset_id)
        if body.project_id is not None:
            project = await self.projects.get(int(body.project_id))
            if not project:
                raise LiteCutServiceError(404, "LITECUT_PROJECT_NOT_FOUND")
            project_raw = project.get("body") if isinstance(project.get("body"), dict) else empty_project().model_dump()
        elif body.project_body is not None:
            project_raw = body.project_body
        else:
            project_raw = empty_project().model_dump()
        try:
            updated = apply_preset_to_project(
                project_raw,
                str(preset["kind"]),
                preset.get("body") if isinstance(preset.get("body"), dict) else {},
                clip_ids=body.clip_ids,
                scope=body.scope,
                include=body.include or None,
            )
        except ValueError as exc:
            raise LiteCutServiceError(400, {"code": "LITECUT_PRESET_APPLY_FAILED", "reason": str(exc)}, code=False) from exc
        output_body = updated.model_dump(mode="json", by_alias=True)
        if body.project_id is not None:
            await self.projects.update(int(body.project_id), body=output_body)
            await self.presets.touch_applied(preset_id)
        return {"project_body": output_body, "preset_id": preset_id, "warnings": preset_asset_warnings(output_body)}


class AssetService:
    """Asset metadata use cases; filesystem/probe work is supplied by executors."""

    def __init__(self, assets: AssetRepository):
        self.assets = assets

    async def list(self, *, project_id: int | None, limit: int, offset: int) -> dict[str, Any]:
        return {
            "items": await self.assets.list(project_id=project_id, limit=limit, offset=offset),
            "limit": limit,
            "offset": offset,
        }

    async def list_for_project(self, project_id: int) -> list[dict[str, Any]]:
        return await self.assets.list_for_project(project_id)

    async def get(self, asset_id: int) -> dict[str, Any]:
        item = await self.assets.get(asset_id)
        if not item:
            raise LiteCutServiceError(404, "LITECUT_ASSET_NOT_FOUND")
        return item

    async def create(self, **values: Any) -> dict[str, Any]:
        asset_id = await self.assets.create(**values)
        return await self.get(asset_id)

    async def update_dimensions(self, asset_id: int, width: int, height: int) -> None:
        await self.assets.update_dimensions(asset_id, width, height)

    async def update_kind(self, asset_id: int, kind: str, mime_type: str | None = None) -> None:
        await self.assets.update_kind(asset_id, kind, mime_type)

    async def update_file_path(self, asset_id: int, file_path: str) -> None:
        await self.assets.update_file_path(asset_id, file_path)

    async def update_source(self, asset_id: int, **values: Any) -> dict[str, Any]:
        await self.get(asset_id)
        await self.assets.update_source(asset_id, **values)
        return await self.get(asset_id)

    async def update_media_metadata(self, asset_id: int, **values: Any) -> None:
        await self.assets.update_media_metadata(asset_id, **values)

    async def delete_record(self, asset_id: int) -> dict[str, Any]:
        await self.get(asset_id)
        if not await self.assets.delete(asset_id):
            raise LiteCutServiceError(404, "LITECUT_ASSET_NOT_FOUND")
        return {"deleted": True, "id": asset_id}


class SnapshotService:
    def __init__(self, projects: ProjectRepository, snapshots: SnapshotRepository):
        self.projects = projects
        self.snapshots = snapshots

    async def create(self, project_id: int, *, reason: str) -> int:
        project = await self.projects.get(project_id)
        if not project:
            raise LiteCutServiceError(404, "LITECUT_PROJECT_NOT_FOUND")
        return await self.snapshots.create(
            project_id,
            name=str(project.get("name") or ""),
            body=_normalized_project(project.get("body")),
            reason=reason,
        )

    async def list(self, project_id: int, *, limit: int = 50) -> dict[str, Any]:
        if not await self.projects.get(project_id):
            raise LiteCutServiceError(404, "LITECUT_PROJECT_NOT_FOUND")
        return {"items": await self.snapshots.list(project_id, limit=limit)}


class ExportHistoryService:
    def __init__(self, exports: ExportRepository):
        self.exports = exports

    async def list(self, *, project_id: int | None, limit: int, offset: int) -> dict[str, Any]:
        return {
            "items": await self.exports.list(project_id=project_id, limit=limit, offset=offset),
            "limit": limit,
            "offset": offset,
        }

    async def get(self, export_id: int) -> dict[str, Any]:
        item = await self.exports.get(export_id)
        if not item:
            raise LiteCutServiceError(404, "LITECUT_EXPORT_NOT_FOUND")
        return item

    async def create(self, **values: Any) -> int:
        return await self.exports.create(**values)

    async def update(self, export_id: int, **values: Any) -> None:
        await self.exports.update(export_id, **values)


# Linked project-file orchestration lives in project_file.py because it also
# resolves Insight recording metadata and filesystem identities.
