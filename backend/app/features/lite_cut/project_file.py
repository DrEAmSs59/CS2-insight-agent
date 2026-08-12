"""Lightweight, link-only LiteCut project-file contract.

The file contains project structure and source identities only.  Media bytes,
preview proxies, waveforms and Demo files are never embedded.
"""

from __future__ import annotations

import copy
import json
import mimetypes
import uuid
from pathlib import Path
from typing import Any

from .asset_executor import (
    LINKED_ASSET_FINGERPRINT_PREFIX,
    _linked_asset_fingerprint,
    linked_asset_identity_matches,
    probe_linked_asset,
)
from .assets import asset_kind_for_path
from .models import SCHEMA_VERSION, empty_project
from .runtime import normalize_project_body


PROJECT_FILE_FORMAT = "litecut-linked-project"
PROJECT_FILE_VERSION = 2
PROJECT_FILE_MAX_BYTES = 16 * 1024 * 1024
PROJECT_FILE_MAX_ASSETS = 2000


class LiteCutProjectFileError(ValueError):
    pass


def _path_key(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    return str(Path(raw).expanduser().resolve(strict=False)).replace("\\", "/").casefold()


def _safe_name(value: Any, fallback: str) -> str:
    raw = str(value or "").strip()
    return (Path(raw).name if raw else fallback)[:240] or fallback


def _origin_metadata(row: dict[str, Any]) -> dict[str, Any]:
    existing = row.get("origin_metadata")
    if isinstance(existing, dict) and existing:
        return copy.deepcopy(existing)
    fields = {
        "clip_id", "demo_filename", "player_name", "map_name", "map", "round",
        "category", "workbench_clip_kind", "context_tags", "ai_score", "ai_comment",
        "ai_commentary", "recording_perspective", "start_tick", "end_tick", "created_at",
    }
    return {key: copy.deepcopy(row[key]) for key in fields if key in row and row[key] is not None}


def _identity_for_path(path_value: Any, row: dict[str, Any]) -> tuple[int | None, int | None, str]:
    stored_fingerprint = str(row.get("fingerprint") or "")
    if stored_fingerprint.startswith(LINKED_ASSET_FINGERPRINT_PREFIX):
        # A changed file at the old path is not allowed to silently become the
        # project's new source during export. Preserve the registered identity;
        # import will keep the asset offline until an explicit validated relink.
        return row.get("size_bytes"), row.get("mtime_ns"), stored_fingerprint
    path = Path(str(path_value or "")).expanduser()
    try:
        if path.is_file():
            return _linked_asset_fingerprint(path)
    except OSError:
        pass
    return row.get("size_bytes"), row.get("mtime_ns"), stored_fingerprint


def _media_descriptor(row: dict[str, Any]) -> dict[str, Any]:
    return {
        key: row.get(key)
        for key in (
            "duration_sec", "width", "height", "fps", "codec_name", "audio_codec_name",
            "pixel_format", "has_alpha", "is_looping_animation",
        )
        if row.get(key) is not None
    }


def _asset_document(row: dict[str, Any], *, uid: str | None = None, origin_type: str | None = None) -> dict[str, Any]:
    raw_path = str(row.get("original_path") or row.get("file_path") or row.get("output_path") or "").strip()
    size_bytes, mtime_ns, fingerprint = _identity_for_path(raw_path, row)
    resolved_origin = str(origin_type or row.get("origin_type") or "local_file").strip().lower() or "local_file"
    resolved_uid = str(uid or row.get("asset_uid") or f"asset-{uuid.uuid4().hex}")
    return {
        "asset_uid": resolved_uid,
        "name": _safe_name(row.get("name") or raw_path, "Linked media"),
        "kind": str(row.get("kind") or asset_kind_for_path(Path(raw_path)) or "file"),
        "mime_type": row.get("mime_type") or mimetypes.guess_type(raw_path)[0],
        "source": {
            "origin_type": resolved_origin,
            "origin_ref": str(row.get("origin_ref") or row.get("id") or "") if resolved_origin == "insight_recording" else str(row.get("origin_ref") or ""),
            "original_path": raw_path,
        },
        "identity": {
            "content_fingerprint": fingerprint,
            "size_bytes": size_bytes,
            "source_mtime_ns": mtime_ns,
        },
        "media": _media_descriptor(row),
        "origin_metadata": _origin_metadata(row),
    }


def _recording_uid(row: dict[str, Any], source_id: int, fingerprint: str) -> str:
    seed = f"insight-recording:{source_id}:{fingerprint or _path_key(row.get('output_path'))}:{row.get('created_at') or ''}"
    return f"asset-{uuid.uuid5(uuid.NAMESPACE_URL, seed).hex}"


def _explicit_body_paths(body: dict[str, Any]) -> list[tuple[str, str]]:
    paths: list[tuple[str, str]] = []
    for track in body.get("tracks") or []:
        for clip in track.get("clips") or []:
            raw = str(clip.get("file_path") or "").strip()
            if raw:
                paths.append((raw, str((clip.get("meta") or {}).get("kind") or "")))
    for overlay in body.get("overlays") or []:
        raw = str(overlay.get("asset_path") or "").strip()
        if raw:
            paths.append((raw, str((overlay.get("meta") or {}).get("kind") or "")))
        font_path = str((overlay.get("text") or {}).get("font_file") or "").strip()
        if font_path:
            paths.append((font_path, "font"))
    bgm_path = str(((body.get("audio") or {}).get("bgm") or {}).get("path") or "").strip()
    if bgm_path:
        paths.append((bgm_path, "audio"))
    return paths


def build_linked_project_document(
    project: dict[str, Any],
    assets: list[dict[str, Any]],
    recordings: dict[int, dict[str, Any]],
) -> dict[str, Any]:
    body = copy.deepcopy(project.get("body") or {})
    manifest: dict[str, dict[str, Any]] = {}
    asset_id_to_uid: dict[int, str] = {}
    path_to_uid: dict[str, str] = {}
    recording_id_to_uid: dict[int, str] = {}

    def register(document: dict[str, Any], *, overwrite_path: bool = False) -> None:
        uid = str(document["asset_uid"])
        manifest.setdefault(uid, document)
        key = _path_key((document.get("source") or {}).get("original_path"))
        if key and (overwrite_path or key not in path_to_uid):
            path_to_uid[key] = uid

    for row in assets:
        document = _asset_document(row)
        register(document)
        if row.get("id") is not None:
            asset_id_to_uid[int(row["id"])] = str(document["asset_uid"])

    for source_id, row in recordings.items():
        draft = _asset_document(
            {
                **row,
                "name": Path(str(row.get("output_path") or f"Insight recording {source_id}")).name,
                "kind": "video",
                "file_path": row.get("output_path"),
                "origin_ref": str(source_id),
            },
            origin_type="insight_recording",
        )
        uid = _recording_uid(row, source_id, str((draft.get("identity") or {}).get("content_fingerprint") or ""))
        draft["asset_uid"] = uid
        recording_id_to_uid[int(source_id)] = uid
        register(draft, overwrite_path=True)

    for raw_path, kind_hint in _explicit_body_paths(body):
        if _path_key(raw_path) in path_to_uid:
            continue
        synthetic_uid = f"asset-{uuid.uuid5(uuid.NAMESPACE_URL, f'litecut-path:{_path_key(raw_path)}').hex}"
        register(_asset_document({
            "asset_uid": synthetic_uid,
            "name": Path(raw_path).name,
            "kind": kind_hint or asset_kind_for_path(Path(raw_path)),
            "file_path": raw_path,
            "origin_type": "local_file",
        }))

    for track in body.get("tracks") or []:
        for clip in track.get("clips") or []:
            meta = dict(clip.get("meta") or {})
            old_asset_id = meta.pop("asset_id", None)
            source_id = clip.get("source_id")
            uid = asset_id_to_uid.get(int(old_asset_id)) if old_asset_id is not None else None
            if uid is None and source_id is not None:
                uid = recording_id_to_uid.get(int(source_id))
            if uid is None:
                uid = path_to_uid.get(_path_key(clip.get("file_path")))
            if not uid:
                continue
            document = manifest[uid]
            meta["asset_uid"] = uid
            meta["asset_origin"] = (document.get("source") or {}).get("origin_type")
            clip["meta"] = meta
            clip["source_type"] = "file"
            clip["source_id"] = None
            clip["file_path"] = (document.get("source") or {}).get("original_path") or clip.get("file_path")

    for overlay in body.get("overlays") or []:
        meta = dict(overlay.get("meta") or {})
        old_asset_id = meta.pop("asset_id", None)
        uid = asset_id_to_uid.get(int(old_asset_id)) if old_asset_id is not None else None
        uid = uid or path_to_uid.get(_path_key(overlay.get("asset_path")))
        if uid:
            meta["asset_uid"] = uid
            overlay["asset_path"] = (manifest[uid].get("source") or {}).get("original_path") or overlay.get("asset_path")
        overlay["meta"] = meta
        text = overlay.get("text")
        if isinstance(text, dict):
            font_uid = path_to_uid.get(_path_key(text.get("font_file")))
            if font_uid:
                text["font_asset_uid"] = font_uid

    bgm = ((body.get("audio") or {}).get("bgm"))
    if isinstance(bgm, dict):
        old_asset_id = bgm.pop("asset_id", None)
        uid = asset_id_to_uid.get(int(old_asset_id)) if old_asset_id is not None else None
        uid = uid or path_to_uid.get(_path_key(bgm.get("path")))
        if uid:
            bgm["asset_uid"] = uid
            bgm["path"] = (manifest[uid].get("source") or {}).get("original_path") or bgm.get("path")

    return {
        "format": PROJECT_FILE_FORMAT,
        "format_version": PROJECT_FILE_VERSION,
        "project_schema_version": SCHEMA_VERSION,
        "name": str(project.get("name") or "LiteCut Project"),
        "body": body,
        "assets": list(manifest.values()),
    }


def encode_linked_project_document(document: dict[str, Any]) -> bytes:
    return json.dumps(document, ensure_ascii=False, indent=2).encode("utf-8")


def decode_linked_project_document(payload: bytes) -> dict[str, Any]:
    if len(payload) > PROJECT_FILE_MAX_BYTES:
        raise LiteCutProjectFileError("LiteCut project file exceeds 16 MB")
    try:
        document = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise LiteCutProjectFileError("Invalid LiteCut project file") from exc
    if not isinstance(document, dict):
        raise LiteCutProjectFileError("LiteCut project file root must be an object")
    if document.get("format") != PROJECT_FILE_FORMAT or document.get("format_version") != PROJECT_FILE_VERSION:
        raise LiteCutProjectFileError("Unsupported LiteCut project-file format")
    if document.get("project_schema_version") != SCHEMA_VERSION:
        raise LiteCutProjectFileError(f"Unsupported LiteCut project schema; expected {SCHEMA_VERSION}")
    if not isinstance(document.get("body"), dict) or not isinstance(document.get("assets"), list):
        raise LiteCutProjectFileError("LiteCut project file is incomplete")
    try:
        document["body"] = normalize_project_body(document["body"])
    except Exception as exc:
        raise LiteCutProjectFileError("LiteCut project body is invalid") from exc
    if len(document["assets"]) > PROJECT_FILE_MAX_ASSETS:
        raise LiteCutProjectFileError("LiteCut project file contains too many assets")
    uids: set[str] = set()
    for item in document["assets"]:
        if not isinstance(item, dict):
            raise LiteCutProjectFileError("LiteCut asset manifest is invalid")
        uid = str(item.get("asset_uid") or "")
        if not uid or uid in uids:
            raise LiteCutProjectFileError("LiteCut asset identities must be unique")
        uids.add(uid)
    referenced_uids: set[str] = set()
    for track in document["body"].get("tracks") or []:
        for clip in track.get("clips") or []:
            uid = str((clip.get("meta") or {}).get("asset_uid") or "")
            if uid:
                referenced_uids.add(uid)
    for overlay in document["body"].get("overlays") or []:
        uid = str((overlay.get("meta") or {}).get("asset_uid") or "")
        if uid:
            referenced_uids.add(uid)
        font_uid = str((overlay.get("text") or {}).get("font_asset_uid") or "")
        if font_uid:
            referenced_uids.add(font_uid)
    bgm_uid = str((((document["body"].get("audio") or {}).get("bgm") or {}).get("asset_uid")) or "")
    if bgm_uid:
        referenced_uids.add(bgm_uid)
    if not referenced_uids.issubset(uids):
        raise LiteCutProjectFileError("LiteCut project references an undeclared asset")
    return document


def _descriptor_matches(facts: dict[str, Any], item: dict[str, Any]) -> bool:
    identity = item.get("identity") if isinstance(item.get("identity"), dict) else {}
    expected_fingerprint = str(identity.get("content_fingerprint") or "")
    if not linked_asset_identity_matches(expected_fingerprint, facts.get("fingerprint")):
        return False
    expected_size = identity.get("size_bytes")
    if expected_size is not None and int(expected_size) != int(facts.get("size_bytes") or -1):
        return False
    expected_kind = str(item.get("kind") or "file").lower()
    actual_kind = str(facts.get("kind") or "file").lower()
    if expected_kind in {"video", "webm"} and actual_kind in {"video", "webm"}:
        return True
    return expected_kind == actual_kind


def bind_project_asset_rows(body: dict[str, Any], assets_by_uid: dict[str, dict[str, Any]]) -> dict[str, Any]:
    bound = copy.deepcopy(body)
    for track in bound.get("tracks") or []:
        for clip in track.get("clips") or []:
            meta = dict(clip.get("meta") or {})
            uid = str(meta.get("asset_uid") or "")
            asset = assets_by_uid.get(uid)
            if not asset:
                continue
            meta["asset_id"] = int(asset["id"])
            clip["meta"] = meta
            clip["source_type"] = "file"
            clip["source_id"] = None
            clip["file_path"] = asset["file_path"]
    for overlay in bound.get("overlays") or []:
        meta = dict(overlay.get("meta") or {})
        asset = assets_by_uid.get(str(meta.get("asset_uid") or ""))
        if asset:
            meta["asset_id"] = int(asset["id"])
            overlay["asset_path"] = asset["file_path"]
        overlay["meta"] = meta
        text = overlay.get("text")
        if isinstance(text, dict):
            font = assets_by_uid.get(str(text.pop("font_asset_uid", "") or ""))
            if font:
                text["font_file"] = font["file_path"]
    bgm = ((bound.get("audio") or {}).get("bgm"))
    if isinstance(bgm, dict):
        asset = assets_by_uid.get(str(bgm.pop("asset_uid", "") or ""))
        if asset:
            bgm["asset_id"] = int(asset["id"])
            bgm["path"] = asset["file_path"]
    return bound


async def import_linked_project_document(document: dict[str, Any], services) -> dict[str, Any]:
    project_id: int | None = None
    try:
        # Create the owner first so every imported linked asset is scoped to it.
        project_id = await services.projects.create(
            name=str(document.get("name") or "Imported LiteCut Project")[:240],
            body=empty_project().model_dump(mode="json", by_alias=True),
        )
        assets_by_uid: dict[str, dict[str, Any]] = {}
        offline_count = 0
        for item in document["assets"]:
            uid = str(item["asset_uid"])
            source = item.get("source") if isinstance(item.get("source"), dict) else {}
            identity = item.get("identity") if isinstance(item.get("identity"), dict) else {}
            media = item.get("media") if isinstance(item.get("media"), dict) else {}
            path_hint = str(source.get("original_path") or "")
            facts: dict[str, Any] | None = None
            try:
                candidate = await probe_linked_asset(path_hint)
                if _descriptor_matches(candidate, item):
                    facts = candidate
            except Exception:
                facts = None
            if facts is not None:
                path = facts.pop("path")
                values = {
                    "name": facts["name"], "kind": facts["kind"], "mime_type": facts["mime_type"],
                    "file_path": str(path), "original_path": str(path), "size_bytes": facts["size_bytes"],
                    "mtime_ns": facts["mtime_ns"], "fingerprint": facts["fingerprint"],
                    "source_status": "available", "metadata_status": facts["metadata_status"],
                    "duration_sec": facts["duration_sec"], "width": facts["width"], "height": facts["height"],
                    "fps": facts["fps"], "codec_name": facts["codec_name"],
                    "audio_codec_name": facts["audio_codec_name"], "pixel_format": facts["pixel_format"],
                    "has_alpha": facts["has_alpha"], "is_looping_animation": facts["is_looping_animation"],
                }
            else:
                offline_count += 1
                values = {
                    "name": _safe_name(item.get("name") or path_hint, "Offline media"),
                    "kind": str(item.get("kind") or "file"), "mime_type": item.get("mime_type"),
                    "file_path": path_hint, "original_path": path_hint,
                    "size_bytes": identity.get("size_bytes"), "mtime_ns": identity.get("source_mtime_ns"),
                    "fingerprint": identity.get("content_fingerprint"), "source_status": "missing",
                    "metadata_status": "offline", "duration_sec": media.get("duration_sec"),
                    "width": media.get("width"), "height": media.get("height"), "fps": media.get("fps"),
                    "codec_name": media.get("codec_name"), "audio_codec_name": media.get("audio_codec_name"),
                    "pixel_format": media.get("pixel_format"), "has_alpha": media.get("has_alpha"),
                    "is_looping_animation": bool(media.get("is_looping_animation")),
                }
            created = await services.assets.create(
                project_id=project_id, asset_uid=uid,
                origin_type=str(source.get("origin_type") or "local_file"),
                origin_ref=str(source.get("origin_ref") or "") or None,
                origin_metadata=item.get("origin_metadata") if isinstance(item.get("origin_metadata"), dict) else {},
                storage_mode="link", managed_path=None, **values,
            )
            assets_by_uid[uid] = created
        bound = bind_project_asset_rows(document["body"], assets_by_uid)
        await services.projects.update(project_id, body=normalize_project_body(bound))
        project = await services.projects.get(project_id)
        if not project:
            raise LiteCutProjectFileError("Imported LiteCut project was not persisted")
        return {**project, "offline_asset_count": offline_count, "asset_count": len(assets_by_uid)}
    except Exception:
        if project_id is not None:
            await services.projects.delete(project_id)
        raise


__all__ = [
    "PROJECT_FILE_FORMAT", "PROJECT_FILE_VERSION", "LiteCutProjectFileError",
    "bind_project_asset_rows", "build_linked_project_document", "decode_linked_project_document",
    "encode_linked_project_document", "import_linked_project_document",
]
