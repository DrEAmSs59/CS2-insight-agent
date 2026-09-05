"""Validated Demo SpawnGroup profiles for advanced blue/green playback.

The local reference recordings were produced after each validated chroma
child VPK had loaded normally in CS2. Their terminal skybox SpawnGroup
manifests therefore contain the resource-registration slot for Insight's
private ``active_sky`` material. Advanced playback copies that tiny manifest
into the matching skybox SpawnGroup before retargeting enabled ``CEnvSky``
entities. No reference Demo is shipped and no live process is modified.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from functools import lru_cache
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
from types import MappingProxyType
from typing import Any, Mapping


_REPO_ROOT = Path(__file__).resolve().parents[2]
_MANIFEST_PATH = _REPO_ROOT / "pov" / "chroma_demo_references" / "manifest.json"
_MAP_RE = re.compile(r"de_[a-z0-9_]+")
_SHA256_RE = re.compile(r"[0-9a-f]{64}")
_EXPECTED_STATUS = "validated_reference_recording"
_EXPECTED_TARGET_MATERIAL_PATH = (
    "materials/cs2_insight/chroma/active_sky.vmat_c"
)


class ChromaDemoManifestError(RuntimeError):
    """The bundled chroma Demo reference catalog is absent or invalid."""


@dataclass(frozen=True)
class ChromaDemoManifestProfile:
    map_name: str
    world_name: str
    spawn_group_manifest: bytes
    target_material_path: str
    target_sky_material_handle: int
    reference_demo_file: str
    reference_demo_size: int
    reference_demo_sha256: str
    spawn_group_manifest_sha256: str
    active_cubemap_fog_entities_to_disable: int
    disable_active_gradient_fog: bool
    suppressed_func_brush_model_handles: tuple[int, ...]

    @property
    def spawn_group_manifests(self) -> Mapping[int, bytes]:
        # DEM_SpawnGroups (15) and DEM_Recovery (18) wrap the same
        # CNetMsgSpawnGroupLoad payload in different outer protobuf fields.
        return MappingProxyType(
            {15: self.spawn_group_manifest, 18: self.spawn_group_manifest}
        )

    @property
    def registered_chroma_material_path(self) -> str:
        """Compatibility name used by the VPK composer."""

        return self.target_material_path

    @property
    def chroma_sky_material_handle(self) -> int:
        """Compatibility name used by the playback service."""

        return self.target_sky_material_handle


def _normalize_map_name(value: object) -> str:
    normalized = str(value or "").strip().lower().replace("\\", "/")
    if normalized.endswith(".vpk"):
        normalized = normalized[:-4]
    if "/" in normalized:
        normalized = normalized.rsplit("/", 1)[-1]
    if normalized and not normalized.startswith("de_"):
        normalized = f"de_{normalized}"
    return normalized


def _required_string(raw: Mapping[str, Any], field: str) -> str:
    value = raw.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ChromaDemoManifestError(f"{field} must be a non-empty string")
    return value.strip()


def _positive_int(value: Any, *, field: str) -> int:
    if isinstance(value, bool):
        raise ChromaDemoManifestError(f"{field} must be a positive integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ChromaDemoManifestError(f"{field} must be a positive integer") from exc
    if parsed <= 0:
        raise ChromaDemoManifestError(f"{field} must be a positive integer")
    return parsed


def _nonnegative_int(value: Any, *, field: str) -> int:
    if isinstance(value, bool):
        raise ChromaDemoManifestError(f"{field} must be a non-negative integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ChromaDemoManifestError(
            f"{field} must be a non-negative integer"
        ) from exc
    if parsed < 0:
        raise ChromaDemoManifestError(f"{field} must be a non-negative integer")
    return parsed


def _positive_int_tuple(value: Any, *, field: str) -> tuple[int, ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise ChromaDemoManifestError(f"{field} must be an array")
    parsed = tuple(
        _positive_int(item, field=f"{field}[{index}]")
        for index, item in enumerate(value)
    )
    if len(set(parsed)) != len(parsed):
        raise ChromaDemoManifestError(f"{field} must contain unique handles")
    return parsed


def _boolean(value: Any, *, field: str) -> bool:
    if not isinstance(value, bool):
        raise ChromaDemoManifestError(f"{field} must be a boolean")
    return value


def _validate_world_name(value: str, *, field: str) -> str:
    normalized = value.replace("\\", "/")
    parts = PurePosixPath(normalized).parts
    if (
        normalized != value
        or not normalized.startswith("maps/prefabs/")
        or not parts
        or any(part in {"", ".", ".."} for part in parts)
        or not any("sky" in part.lower() for part in parts)
    ):
        raise ChromaDemoManifestError(f"{field} is not a safe sky SpawnGroup path")
    return normalized


@lru_cache(maxsize=1)
def _load_profiles() -> Mapping[str, ChromaDemoManifestProfile]:
    try:
        root = json.loads(_MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ChromaDemoManifestError(
            f"unable to load chroma Demo reference manifest: {_MANIFEST_PATH}"
        ) from exc
    if not isinstance(root, Mapping) or root.get("schema_version") != 1:
        raise ChromaDemoManifestError("unsupported chroma Demo reference schema")

    target_path = _required_string(root, "target_material_path")
    if target_path != _EXPECTED_TARGET_MATERIAL_PATH:
        raise ChromaDemoManifestError("unexpected chroma target material path")
    target_handle = _positive_int(
        root.get("target_sky_material_handle"),
        field="target_sky_material_handle",
    )
    raw_maps = root.get("maps")
    if not isinstance(raw_maps, Mapping) or not raw_maps:
        raise ChromaDemoManifestError("chroma Demo reference maps must be an object")

    profiles: dict[str, ChromaDemoManifestProfile] = {}
    for raw_name, raw_profile in raw_maps.items():
        map_name = _normalize_map_name(raw_name)
        if map_name != raw_name or not _MAP_RE.fullmatch(map_name):
            raise ChromaDemoManifestError(f"invalid chroma Demo map key: {raw_name!r}")
        if not isinstance(raw_profile, Mapping):
            raise ChromaDemoManifestError(f"maps.{map_name} must be an object")
        if raw_profile.get("status") != _EXPECTED_STATUS:
            raise ChromaDemoManifestError(
                f"maps.{map_name} is not a validated reference recording"
            )
        world_name = _validate_world_name(
            _required_string(raw_profile, "world_name"),
            field=f"maps.{map_name}.world_name",
        )
        encoded = _required_string(raw_profile, "spawn_group_manifest_base64")
        try:
            spawn_manifest = base64.b64decode(encoded, validate=True)
        except ValueError as exc:
            raise ChromaDemoManifestError(
                f"maps.{map_name}.spawn_group_manifest_base64 is invalid"
            ) from exc
        declared_size = _positive_int(
            raw_profile.get("spawn_group_manifest_size"),
            field=f"maps.{map_name}.spawn_group_manifest_size",
        )
        declared_sha = _required_string(
            raw_profile,
            "spawn_group_manifest_sha256",
        ).lower()
        actual_sha = hashlib.sha256(spawn_manifest).hexdigest()
        if (
            len(spawn_manifest) != declared_size
            or not _SHA256_RE.fullmatch(declared_sha)
            or actual_sha != declared_sha
        ):
            raise ChromaDemoManifestError(
                f"maps.{map_name} SpawnGroup manifest identity mismatch"
            )
        reference_demo_file = _required_string(raw_profile, "reference_demo_file")
        if Path(reference_demo_file).name != reference_demo_file:
            raise ChromaDemoManifestError(
                f"maps.{map_name}.reference_demo_file must be a file name"
            )
        reference_demo_sha = _required_string(
            raw_profile,
            "reference_demo_sha256",
        ).lower()
        if not _SHA256_RE.fullmatch(reference_demo_sha):
            raise ChromaDemoManifestError(
                f"maps.{map_name}.reference_demo_sha256 is invalid"
            )
        environment = raw_profile.get("demo_environment_overrides", {})
        if not isinstance(environment, Mapping):
            raise ChromaDemoManifestError(
                f"maps.{map_name}.demo_environment_overrides must be an object"
            )
        profiles[map_name] = ChromaDemoManifestProfile(
            map_name=map_name,
            world_name=world_name,
            spawn_group_manifest=spawn_manifest,
            target_material_path=target_path,
            target_sky_material_handle=target_handle,
            reference_demo_file=reference_demo_file,
            reference_demo_size=_positive_int(
                raw_profile.get("reference_demo_size"),
                field=f"maps.{map_name}.reference_demo_size",
            ),
            reference_demo_sha256=reference_demo_sha,
            spawn_group_manifest_sha256=declared_sha,
            active_cubemap_fog_entities_to_disable=_nonnegative_int(
                environment.get("active_cubemap_fog_entities_to_disable", 0),
                field=(
                    f"maps.{map_name}.demo_environment_overrides."
                    "active_cubemap_fog_entities_to_disable"
                ),
            ),
            disable_active_gradient_fog=_boolean(
                environment.get("disable_active_gradient_fog", False),
                field=(
                    f"maps.{map_name}.demo_environment_overrides."
                    "disable_active_gradient_fog"
                ),
            ),
            suppressed_func_brush_model_handles=_positive_int_tuple(
                environment.get("suppress_func_brush_model_handles"),
                field=(
                    f"maps.{map_name}.demo_environment_overrides."
                    "suppress_func_brush_model_handles"
                ),
            ),
        )
    return MappingProxyType(profiles)


def get_chroma_demo_manifest_profile(
    map_name: object,
) -> ChromaDemoManifestProfile | None:
    return _load_profiles().get(_normalize_map_name(map_name))


def chroma_demo_redirect_material_path(map_name: object) -> None:
    """Legacy API: full reference manifests no longer use path substitution."""

    _ = map_name
    return None


def chroma_demo_registered_material_path(map_name: object) -> str | None:
    profile = get_chroma_demo_manifest_profile(map_name)
    return profile.target_material_path if profile is not None else None


def supported_chroma_demo_manifest_maps() -> tuple[str, ...]:
    return tuple(sorted(_load_profiles()))
