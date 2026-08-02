"""LiteCut portable project packaging, download and import routes."""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import shutil
import tempfile
import uuid
import zipfile
from pathlib import Path
from typing import Any, Callable

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..api_errors import error_detail
from ..env_utils import get_data_dir
from .assets import asset_kind_for_path
from .projects_api import _delete_project_asset_files
from .runtime import (
    LiteCutPortablePackageJob,
    get_lite_cut_db,
    normalize_project_body,
    portable_package_jobs,
)

router = APIRouter(prefix="/api/lite-cut", tags=["lite-cut-portable"])
logger = logging.getLogger(__name__)


_PORTABLE_BODY_PATH_KEYS = frozenset({"file_path", "asset_path", "font_file", "font_file_path", "path"})


def _body_file_paths(value: Any, *, key: str = "") -> set[Path]:
    """Find supported media references without treating arbitrary project metadata as assets."""
    paths: set[Path] = set()
    if isinstance(value, dict):
        for child_key, item in value.items():
            paths.update(_body_file_paths(item, key=str(child_key)))
    elif isinstance(value, list):
        for item in value:
            paths.update(_body_file_paths(item, key=key))
    elif key in _PORTABLE_BODY_PATH_KEYS and isinstance(value, str) and value.strip():
        try:
            path = Path(value).expanduser()
            # A portable project can only restore files that LiteCut itself can
            # register as an asset.  In particular, demo source paths are
            # project metadata, not editable media, and must never enter the
            # archive as .dem files.
            if path.is_file() and asset_kind_for_path(path) != "file":
                paths.add(path.resolve())
        except OSError:
            pass
    return paths


def _replace_portable_references(value: Any, path_map: dict[str, str], asset_id_map: dict[int, int], *, key: str = "") -> Any:
    if isinstance(value, dict):
        return {name: _replace_portable_references(item, path_map, asset_id_map, key=name) for name, item in value.items()}
    if isinstance(value, list):
        return [_replace_portable_references(item, path_map, asset_id_map, key=key) for item in value]
    if isinstance(value, str):
        return path_map.get(value, value)
    # Asset ids appear in clip metadata / BGM. Do not replace generic numeric
    # values such as timeline offsets.
    if isinstance(value, int) and key in {"asset_id", "source_id"}:
        return asset_id_map.get(value, value)
    return value


def _link_portable_clip_assets(body: dict[str, Any], imported_asset_ids: dict[str, int]) -> int:
    """Link bundled recordings and file clips to the newly imported assets.

    Recording IDs belong to the exporting computer's montage database.  A
    portable package carries the rendered MP4s instead, so retaining
    ``recorded_clip`` would make the imported project look up unavailable IDs.
    """
    linked = 0
    for track in body.get("tracks") or []:
        if not isinstance(track, dict):
            continue
        for clip in track.get("clips") or []:
            if not isinstance(clip, dict) or clip.get("source_type") not in {"recorded_clip", "file"}:
                continue
            meta = clip.get("meta") if isinstance(clip.get("meta"), dict) else {}
            source_path = str(
                clip.get("file_path")
                or meta.get("output_path")
                or meta.get("file_path")
                or meta.get("video_path")
                or meta.get("clip_path")
                or ""
            ).strip()
            asset_id = imported_asset_ids.get(source_path)
            if asset_id is None:
                continue
            if clip.get("source_type") == "recorded_clip":
                clip["source_type"] = "file"
                clip["source_id"] = None
            clip["file_path"] = source_path
            meta["asset_id"] = asset_id
            clip["meta"] = meta
            linked += 1
    return linked


def _portable_package_path(
    project: dict[str, Any],
    assets: list[dict[str, Any]],
    *,
    on_progress: Callable[[str, int, int, int, int], None] | None = None,
    on_output: Callable[[Path], None] | None = None,
    cancel_event: threading.Event | None = None,
) -> Path:
    """Create a self-contained archive. The generated zip is safe to send as a normal download."""
    package_dir = get_data_dir() / "lite_cut_packages"
    package_dir.mkdir(parents=True, exist_ok=True)
    safe_name = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in str(project.get("name") or "LiteCut"))[:80] or "LiteCut"
    output = package_dir / f"{safe_name}-{uuid.uuid4().hex[:8]}.litecut.zip"
    if on_output:
        on_output(output)
    source_rows = {
        str(path.resolve()): row
        for row in assets
        if (path := Path(str(row.get("file_path") or ""))).is_file()
        and asset_kind_for_path(path) != "file"
    }
    paths = set(source_rows)
    paths.update(str(path) for path in _body_file_paths(project.get("body") or {}))
    source_paths = [Path(raw_path) for raw_path in sorted(paths) if Path(raw_path).is_file()]
    total_bytes = sum(path.stat().st_size for path in source_paths)
    if on_progress:
        on_progress("preparing", 0, total_bytes, 0, len(source_paths))
    if cancel_event is not None and cancel_event.is_set():
        raise InterruptedError("portable package cancelled")
    manifest_files: list[dict[str, Any]] = []
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
        completed_bytes = 0
        for index, source in enumerate(source_paths):
            if cancel_event is not None and cancel_event.is_set():
                raise InterruptedError("portable package cancelled")
            raw_path = str(source)
            suffix = source.suffix.lower()
            archive_name = f"assets/{index:04d}_{uuid.uuid4().hex[:8]}{suffix}"
            archive.write(source, archive_name)
            row = source_rows.get(raw_path) or {}
            manifest_files.append({
                "archive_path": archive_name,
                "original_path": raw_path,
                "asset_id": row.get("id"),
                "name": row.get("name") or source.name,
                "kind": row.get("kind"),
                "mime_type": row.get("mime_type") or mimetypes.guess_type(source.name)[0],
                "duration_sec": row.get("duration_sec"),
                "width": row.get("width"),
                "height": row.get("height"),
            })
            completed_bytes += source.stat().st_size
            if on_progress:
                on_progress("compressing", completed_bytes, total_bytes, index + 1, len(source_paths))
            if cancel_event is not None and cancel_event.is_set():
                raise InterruptedError("portable package cancelled")
        archive.writestr("project.json", json.dumps({
            "format": "litecut-portable-project",
            "version": 1,
            "name": project.get("name") or "LiteCut Project",
            "body": project.get("body") or {},
            "files": manifest_files,
        }, ensure_ascii=False, indent=2))
    return output


def _portable_package_snapshot(job: LiteCutPortablePackageJob) -> dict[str, Any]:
    return {
        "job_id": job.job_id,
        "project_id": job.project_id,
        "status": job.status,
        "stage": job.stage,
        "progress": max(0.0, min(1.0, job.progress)),
        "total_bytes": job.total_bytes,
        "completed_bytes": job.completed_bytes,
        "total_files": job.total_files,
        "completed_files": job.completed_files,
        "filename": job.filename,
        "saved_path": job.saved_path,
        "download_url": f"/api/lite-cut/portable-package/jobs/{job.job_id}/download" if job.status == "done" and job.package_path else "",
        "error": job.error,
    }


def _run_portable_package(job: LiteCutPortablePackageJob, project: dict[str, Any], assets: list[dict[str, Any]]) -> None:
    def report(stage: str, copied_bytes: int, total_bytes: int, copied_files: int, total_files: int) -> None:
        job.stage = stage
        job.total_bytes = total_bytes
        job.completed_bytes = copied_bytes
        job.total_files = total_files
        job.completed_files = copied_files
        job.progress = 0.95 * copied_bytes / max(1, total_bytes)

    try:
        job.status = "running"
        job.stage = "preparing"
        package = _portable_package_path(
            project, assets, on_progress=report, cancel_event=job.cancel_event,
            on_output=lambda output: setattr(job, "package_path", str(output)),
        )
        job.package_path = str(package)
        job.progress = 0.96
        if job.cancel_event.is_set():
            raise InterruptedError("portable package cancelled")
        if job.destination is not None:
            job.stage = "saving"
            job.destination.mkdir(parents=True, exist_ok=True)
            target = job.destination / job.filename
            if target.exists():
                target = target.with_name(f"{target.stem}_{uuid.uuid4().hex[:6]}{target.suffix}")
            shutil.copy2(package, target)
            job.saved_path = str(target)
        if job.cancel_event.is_set():
            raise InterruptedError("portable package cancelled")
        job.status = "done"
        job.stage = "done"
        job.progress = 1.0
    except InterruptedError:
        job.status = "cancelled"
        job.stage = "cancelled"
        job.error = ""
        if job.package_path:
            Path(job.package_path).unlink(missing_ok=True)
            job.package_path = ""
    except Exception as exc:
        job.status = "error"
        job.stage = "error"
        job.error = str(exc) or "便携工程包生成失败"
        logger.warning("LiteCut portable package failed", exc_info=True)


class LiteCutPortablePackageStartBody(BaseModel):
    destination: str = Field(default="", max_length=2048)


@router.post("/projects/{project_id}/portable-package/start")
async def start_lite_cut_portable_package(project_id: int, body: LiteCutPortablePackageStartBody):
    project = await get_lite_cut_db().get_project(project_id)
    if not project:
        raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
    destination: Path | None = None
    if body.destination.strip():
        try:
            destination = Path(body.destination.strip().strip('"')).expanduser().resolve(strict=False)
            destination.mkdir(parents=True, exist_ok=True)
            if not destination.is_dir():
                raise OSError("destination is not a directory")
        except OSError as exc:
            raise HTTPException(400, f"导出位置不可用：{exc}") from exc
    assets = await get_lite_cut_db().list_project_assets(project_id)
    safe_name = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in str(project.get("name") or "LiteCut"))[:80] or "LiteCut"
    job = LiteCutPortablePackageJob(
        job_id=uuid.uuid4().hex,
        project_id=project_id,
        filename=f"{safe_name}.litecut.zip",
        destination=destination,
    )
    portable_package_jobs[job.job_id] = job
    job.task = asyncio.create_task(asyncio.to_thread(_run_portable_package, job, project, assets))
    return _portable_package_snapshot(job)


@router.get("/portable-package/jobs/{job_id}")
async def get_lite_cut_portable_package_job(job_id: str):
    job = portable_package_jobs.get(str(job_id))
    if not job:
        raise HTTPException(404, "便携工程包任务不存在或已过期")
    return _portable_package_snapshot(job)


@router.delete("/portable-package/jobs/{job_id}")
async def cancel_lite_cut_portable_package_job(job_id: str):
    job = portable_package_jobs.get(str(job_id))
    if not job:
        raise HTTPException(404, "便携工程包任务不存在或已过期")
    if job.status in {"done", "error", "cancelled"}:
        return _portable_package_snapshot(job)
    job.cancel_event.set()
    job.status = "cancelling"
    job.stage = "cancelling"
    return _portable_package_snapshot(job)


@router.get("/portable-package/jobs/{job_id}/download")
async def download_lite_cut_portable_package_job(job_id: str):
    job = portable_package_jobs.get(str(job_id))
    if not job:
        raise HTTPException(404, "便携工程包任务不存在或已过期")
    if job.status != "done" or not job.package_path:
        raise HTTPException(409, "便携工程包尚未准备完成")
    return FileResponse(job.package_path, media_type="application/zip", filename=job.filename)


@router.get("/projects/{project_id}/portable-package")
async def download_lite_cut_portable_package(project_id: int):
    project = await get_lite_cut_db().get_project(project_id)
    if not project:
        raise HTTPException(404, error_detail("LITECUT_PROJECT_NOT_FOUND"))
    assets = await get_lite_cut_db().list_project_assets(project_id)
    package = await asyncio.to_thread(_portable_package_path, project, assets)
    filename = f"{str(project.get('name') or 'LiteCut').strip() or 'LiteCut'}.litecut.zip"
    return FileResponse(package, media_type="application/zip", filename=filename)


async def _rollback_portable_import(project_id: int | None, destination: Path | None) -> None:
    """Remove every artifact created by a failed portable-project import."""
    if project_id is None:
        return
    try:
        await _delete_project_asset_files(project_id)
    except Exception:
        logger.warning("Failed to remove imported LiteCut asset records during rollback", exc_info=True)
    try:
        await get_lite_cut_db().delete_project(project_id)
    except Exception:
        logger.warning("Failed to remove imported LiteCut project during rollback", exc_info=True)
    if destination is not None:
        await asyncio.to_thread(shutil.rmtree, destination, True)


@router.post("/projects/portable-import")
async def import_lite_cut_portable_package(file: UploadFile = File(...)):
    from .assets import asset_kind_for_path, stable_project_asset_directory, validate_asset_filename

    if not str(file.filename or "").lower().endswith(".zip"):
        raise HTTPException(400, "请选择 LiteCut 便携工程包（.zip）")
    package_dir = get_data_dir() / "lite_cut_packages"
    package_dir.mkdir(parents=True, exist_ok=True)
    temp_path: Path | None = None
    project_id: int | None = None
    destination: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(prefix="litecut-import-", suffix=".zip", dir=package_dir, delete=False) as temp:
            temp_path = Path(temp.name)
            total = 0
            while chunk := await file.read(8 * 1024 * 1024):
                total += len(chunk)
                if total > 20 * 1024 * 1024 * 1024:
                    raise HTTPException(400, "便携工程包不能超过 20GB")
                temp.write(chunk)
        with zipfile.ZipFile(temp_path) as archive:
            total_unpacked = sum(info.file_size for info in archive.infolist() if not info.is_dir())
            if total_unpacked > 20 * 1024 * 1024 * 1024:
                raise HTTPException(400, "便携工程包解压后的素材不能超过 20GB")
            try:
                raw_project = json.loads(archive.read("project.json").decode("utf-8"))
            except (KeyError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise HTTPException(400, "无效的 LiteCut 便携工程包") from exc
            if raw_project.get("format") != "litecut-portable-project" or not isinstance(raw_project.get("body"), dict):
                raise HTTPException(400, "不支持的 LiteCut 便携工程包")
            name = str(raw_project.get("name") or "Imported LiteCut Project").strip()[:240] or "Imported LiteCut Project"
            project_id = await get_lite_cut_db().create_project(name=name, body=normalize_project_body(raw_project["body"]))
            project = await get_lite_cut_db().get_project(project_id)
            if not project:
                raise HTTPException(500, error_detail("LITECUT_PROJECT_SAVE_FAILED"))
            destination = stable_project_asset_directory(project_id, str(project.get("name") or name))
            path_map: dict[str, str] = {}
            asset_id_map: dict[int, int] = {}
            imported_asset_ids: dict[str, int] = {}
            for item in raw_project.get("files") or []:
                if not isinstance(item, dict):
                    continue
                member = str(item.get("archive_path") or "")
                if not member.startswith("assets/") or ".." in Path(member).parts:
                    raise HTTPException(400, "工程包包含不安全的素材路径")
                info = archive.getinfo(member)
                if info.is_dir() or info.file_size > 20 * 1024 * 1024 * 1024:
                    raise HTTPException(400, "工程包素材无效")
                original_name = validate_asset_filename(str(item.get("name") or Path(member).name))
                destination_file = destination / f"{Path(original_name).stem}_{uuid.uuid4().hex[:10]}{Path(original_name).suffix.lower()}"
                inferred_kind = asset_kind_for_path(destination_file)
                if inferred_kind == "file":
                    raise HTTPException(400, f"工程包包含不支持的素材类型：{destination_file.suffix or '(none)'}")
                with archive.open(info) as reader, destination_file.open("wb") as writer:
                    shutil.copyfileobj(reader, writer, length=8 * 1024 * 1024)
                old_path = str(item.get("original_path") or "")
                if old_path:
                    path_map[old_path] = str(destination_file)
                old_asset_id = item.get("asset_id")
                new_asset_id = await get_lite_cut_db().create_asset(
                    name=original_name,
                    kind=str(item.get("kind") or inferred_kind),
                    mime_type=item.get("mime_type") or mimetypes.guess_type(destination_file.name)[0],
                    file_path=str(destination_file),
                    duration_sec=item.get("duration_sec"),
                    width=item.get("width"), height=item.get("height"), project_id=project_id,
                )
                imported_asset_ids[str(destination_file)] = new_asset_id
                if isinstance(old_asset_id, int):
                    asset_id_map[old_asset_id] = new_asset_id
            imported_body = _replace_portable_references(raw_project["body"], path_map, asset_id_map)
            _link_portable_clip_assets(imported_body, imported_asset_ids)
            await get_lite_cut_db().update_project(project_id, body=normalize_project_body(imported_body))
        item = await get_lite_cut_db().get_project(project_id)
        return item
    except zipfile.BadZipFile as exc:
        await _rollback_portable_import(project_id, destination)
        raise HTTPException(400, "无效的 LiteCut 便携工程包") from exc
    except Exception:
        await _rollback_portable_import(project_id, destination)
        raise
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
