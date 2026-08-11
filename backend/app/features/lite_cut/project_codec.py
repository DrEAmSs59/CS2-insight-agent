"""Pure schema-v2 LiteCut project decoding, encoding, and diagnostics."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

from .models import LiteCutProjectBody, empty_project


def project_contract_path() -> Path:
    return Path(__file__).resolve().parents[4] / "data" / "lite_cut_project_contract.json"


@lru_cache(maxsize=1)
def load_project_contract() -> dict[str, Any]:
    path = project_contract_path()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"LiteCut project contract could not be loaded: {path}") from exc
    if not isinstance(payload, dict) or int(payload.get("project_schema_version") or 0) != 2:
        raise RuntimeError(f"LiteCut project contract has an invalid schema: {path}")
    return payload


def create_empty_project() -> LiteCutProjectBody:
    return empty_project()


def validate_project_body(raw: dict[str, Any]) -> LiteCutProjectBody:
    return LiteCutProjectBody.model_validate(raw)


def read_project_body(raw: dict[str, Any] | None) -> LiteCutProjectBody:
    if not raw:
        return create_empty_project()
    return validate_project_body(raw)


def serialize_project_body(project: LiteCutProjectBody | dict[str, Any] | None) -> dict[str, Any]:
    parsed = project if isinstance(project, LiteCutProjectBody) else read_project_body(project)
    return parsed.model_dump(mode="json")


@dataclass(frozen=True)
class ProjectReferenceDiagnostic:
    code: str
    kind: str
    id: str = ""
    source_id: int | None = None

    def as_dict(self) -> dict[str, Any]:
        return {key: value for key, value in asdict(self).items() if value not in (None, "")}


def select_project_references(body: dict[str, Any] | None) -> dict[str, list[Any]]:
    source = body if isinstance(body, dict) else {}
    tracks = source.get("tracks") if isinstance(source.get("tracks"), list) else []
    overlays = source.get("overlays") if isinstance(source.get("overlays"), list) else []
    markers = source.get("markers") if isinstance(source.get("markers"), list) else []
    clips = [clip for track in tracks if isinstance(track, dict) for clip in track.get("clips") or [] if isinstance(clip, dict)]
    return {
        "track_ids": [str(track.get("id") or "") for track in tracks if isinstance(track, dict)],
        "clip_ids": [str(clip.get("id") or "") for clip in clips],
        "overlay_ids": [str(overlay.get("id") or "") for overlay in overlays if isinstance(overlay, dict)],
        "marker_ids": [str(marker.get("id") or "") for marker in markers if isinstance(marker, dict)],
        "source_ids": [int(clip["source_id"]) for clip in clips if clip.get("source_id") is not None],
    }


def diagnose_project_references(
    body: dict[str, Any] | None,
    *,
    available_asset_ids: Iterable[int] = (),
) -> list[ProjectReferenceDiagnostic]:
    source = body if isinstance(body, dict) else {}
    diagnostics: list[ProjectReferenceDiagnostic] = []
    references = select_project_references(source)
    available = {int(value) for value in available_asset_ids}

    def report_duplicate_ids(kind: str, values: list[Any]) -> None:
        seen: set[str] = set()
        for raw in values:
            value = str(raw)
            if value and value in seen:
                diagnostics.append(ProjectReferenceDiagnostic(f"duplicate_{kind}_id", kind, value))
            seen.add(value)

    report_duplicate_ids("track", references["track_ids"])
    report_duplicate_ids("clip", references["clip_ids"])
    report_duplicate_ids("overlay", references["overlay_ids"])
    report_duplicate_ids("marker", references["marker_ids"])

    for track in source.get("tracks") or []:
        if not isinstance(track, dict):
            continue
        for clip in track.get("clips") or []:
            if not isinstance(clip, dict):
                continue
            clip_id = str(clip.get("id") or "")
            if clip.get("source_type") == "file" and not str(clip.get("file_path") or "").strip():
                diagnostics.append(ProjectReferenceDiagnostic("missing_file_path", "clip", clip_id))
            if clip.get("source_id") is not None and int(clip["source_id"]) not in available:
                diagnostics.append(ProjectReferenceDiagnostic("unresolved_source_id", "clip", clip_id, int(clip["source_id"])))
    for overlay in source.get("overlays") or []:
        if not isinstance(overlay, dict):
            continue
        if overlay.get("type") != "text" and not str(overlay.get("asset_path") or "").strip():
            diagnostics.append(ProjectReferenceDiagnostic("missing_overlay_asset_path", "overlay", str(overlay.get("id") or "")))
    return diagnostics


__all__ = [
    "ProjectReferenceDiagnostic",
    "create_empty_project",
    "diagnose_project_references",
    "load_project_contract",
    "project_contract_path",
    "read_project_body",
    "select_project_references",
    "serialize_project_body",
    "validate_project_body",
]
