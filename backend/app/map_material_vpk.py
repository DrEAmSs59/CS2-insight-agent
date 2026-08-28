"""Runtime composition for optional map-material overrides."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
from typing import Any

from .demo_voice_hud import read_inline_vpk, write_inline_vpk
from .skybox_vpk import normalize_skybox_map_name


DEFAULT_MAP_MATERIAL_ID = "default"
WAXED_REFLECTION_MAP_MATERIAL_ID = "waxed_reflection"
MAP_MATERIAL_IDS = (
    DEFAULT_MAP_MATERIAL_ID,
    WAXED_REFLECTION_MAP_MATERIAL_ID,
)
WAXED_REFLECTION_LIGHTING_COMMANDS = (
    "sv_cheats 1",
    "mat_fullbright 0",
    "r_rendersun 0",
    "r_directlighting 0",
    "r_indirectlighting 1",
)


class MapMaterialVpkError(RuntimeError):
    pass


def normalize_map_material_id(value: object) -> str:
    material_id = str(value or DEFAULT_MAP_MATERIAL_ID).strip().lower()
    if material_id not in MAP_MATERIAL_IDS:
        raise MapMaterialVpkError(f"unsupported recording map material: {material_id}")
    return material_id


def map_material_console_commands(value: object) -> tuple[str, ...]:
    material_id = normalize_map_material_id(value)
    if material_id == WAXED_REFLECTION_MAP_MATERIAL_ID:
        return WAXED_REFLECTION_LIGHTING_COMMANDS
    return ()


def _safe_catalog_path(value: object, *, field: str) -> str:
    normalized = str(value or "").strip().replace("\\", "/").strip("/")
    path = PurePosixPath(normalized)
    if not normalized or path.is_absolute() or ".." in path.parts:
        raise MapMaterialVpkError(f"invalid {field} path in map-material manifest")
    return path.as_posix()


def _load_profile(
    assets_dir: Path,
    material_id: str,
) -> tuple[dict[str, Any], Path, bytes]:
    profile_dir = Path(assets_dir) / material_id
    manifest_path = profile_dir / "manifest.json"
    catalog_path = profile_dir / "catalog.vpk"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        catalog = catalog_path.read_bytes()
    except (OSError, ValueError, TypeError) as exc:
        raise MapMaterialVpkError(
            f"map-material assets are missing or invalid: {profile_dir}"
        ) from exc
    if not isinstance(manifest, dict):
        raise MapMaterialVpkError("map-material manifest must be an object")
    if manifest.get("schema_version") != 1 or manifest.get("id") != material_id:
        raise MapMaterialVpkError("map-material manifest identity is invalid")
    lighting_commands = manifest.get("lighting_commands")
    if (
        not isinstance(lighting_commands, list)
        or tuple(str(command) for command in lighting_commands)
        != WAXED_REFLECTION_LIGHTING_COMMANDS
    ):
        raise MapMaterialVpkError("map-material lighting profile is invalid")
    expected_hash = str(manifest.get("catalog_sha256") or "").strip().lower()
    actual_hash = hashlib.sha256(catalog).hexdigest()
    if not expected_hash or actual_hash != expected_hash:
        raise MapMaterialVpkError("map-material catalog hash does not match its manifest")
    return manifest, catalog_path, catalog


def _entry_mappings(value: object, *, field: str) -> list[tuple[str, str, str]]:
    if not isinstance(value, list) or not value:
        raise MapMaterialVpkError(f"map-material manifest field {field} is empty")
    result: list[tuple[str, str, str]] = []
    targets: set[str] = set()
    catalogs: set[str] = set()
    for raw in value:
        if not isinstance(raw, Mapping):
            raise MapMaterialVpkError(f"map-material manifest field {field} is invalid")
        target = _safe_catalog_path(raw.get("target"), field=f"{field}.target")
        catalog = _safe_catalog_path(raw.get("catalog"), field=f"{field}.catalog")
        digest = str(raw.get("sha256") or "").strip().lower()
        if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
            raise MapMaterialVpkError(f"map-material manifest field {field}.sha256 is invalid")
        if target in targets or catalog in catalogs:
            raise MapMaterialVpkError(f"map-material manifest field {field} contains duplicates")
        targets.add(target)
        catalogs.add(catalog)
        result.append((target, catalog, digest))
    return result


def compose_recording_map_material_vpk(
    *,
    assets_dir: Path,
    material_id: object,
    map_name: object,
    base_vpk_bytes: bytes | None = None,
) -> bytes:
    """Add one map's material layer to an optional HUD/skybox package."""

    selected = normalize_map_material_id(material_id)
    if selected == DEFAULT_MAP_MATERIAL_ID:
        if base_vpk_bytes is None:
            raise MapMaterialVpkError(
                "the default map material does not require a material-only VPK"
            )
        return base_vpk_bytes

    manifest, _catalog_path, catalog_bytes = _load_profile(assets_dir, selected)
    normalized_map = normalize_skybox_map_name(map_name)
    maps = manifest.get("maps")
    raw_map_entries = maps.get(normalized_map) if isinstance(maps, Mapping) else None
    if not raw_map_entries:
        supported = ", ".join(maps) if isinstance(maps, Mapping) else ""
        raise MapMaterialVpkError(
            f"recording map material does not support map {normalized_map or '<empty>'}; "
            f"supported maps: {supported}"
        )

    mappings = [
        *_entry_mappings(manifest.get("shared_entries"), field="shared_entries"),
        *_entry_mappings(raw_map_entries, field=f"maps.{normalized_map}"),
    ]
    catalog_paths = {catalog for _target, catalog, _digest in mappings}
    selected_entries = read_inline_vpk(catalog_bytes, include_paths=catalog_paths)
    if set(selected_entries) != catalog_paths:
        missing = sorted(catalog_paths - set(selected_entries))
        raise MapMaterialVpkError(
            f"map-material catalog is missing selected entries: {missing[:5]}"
        )

    entries = read_inline_vpk(base_vpk_bytes) if base_vpk_bytes is not None else {}
    for target, catalog, expected_hash in mappings:
        body = selected_entries[catalog]
        if hashlib.sha256(body).hexdigest() != expected_hash:
            raise MapMaterialVpkError(
                f"map-material catalog entry hash mismatch: {catalog}"
            )
        entries[target] = body
    return write_inline_vpk(entries)
