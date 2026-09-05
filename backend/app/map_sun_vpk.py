"""Remove map-authored visual sun cards without changing map lighting.

Several official CS2 3D skyboxes contain an additive billboard for the visible
sun disc and halo.  Those billboards are ordinary no-shadow render models;
``light_environment`` remains the independent source of direct light and
shadows.  This module aliases only the billboard materials to CS2's own fully
transparent editor material inside the session-scoped ``pov.vpk``.

Do not use ``tools/toolsinvisible`` here.  Despite its name, that material
contains a visible ``INVISIBLE`` diagnostic texture and renders the billboard
as a grey rectangle at runtime.  ``models/editor/editor_transparent`` instead
uses a one-pixel texture whose alpha is zero together with alpha testing, so
every billboard fragment is discarded without touching the lighting entity.
"""

from __future__ import annotations

import hashlib
import zlib
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, Mapping

from . import chroma_skybox_child as _vpk
from .demo_voice_hud import read_inline_vpk, write_inline_vpk
from .skybox_vpk import normalize_skybox_map_name


MAP_SUN_VISUAL_MATERIAL_PATHS: Mapping[str, tuple[str, ...]] = MappingProxyType(
    {
        "de_dust2": (
            "materials/effects/glows/sun_disc_glow_001.vmat_c",
        ),
        "de_inferno": (
            "materials/effects/glows/sun_disc_glow_003.vmat_c",
        ),
        # Cache's visible sun belongs to the env_sky material itself.  Replacing
        # that sky already removes it, so there is no separate billboard alias.
        "de_cache": (),
        "de_nuke": (
            "materials/effects/glows/sun_disc_glow_002.vmat_c",
        ),
        "de_mirage": (
            "materials/effects/glows/sun_disc_glow_001.vmat_c",
            "materials/effects/glows/sun_glow_001.vmat_c",
        ),
        "de_ancient": (
            "materials/effects/glows/sun_disc_glow_001.vmat_c",
        ),
        "de_anubis": (
            "materials/effects/glows/sun_disc_glow_001.vmat_c",
        ),
    }
)
MAP_SUN_SUPPRESSION_MAPS = frozenset(MAP_SUN_VISUAL_MATERIAL_PATHS)

_TRANSPARENT_MATERIAL_PATH = (
    "materials/models/editor/editor_transparent.vmat_c"
)
_CORE_PACKAGE_RELATIVE_PATH = Path("core") / "pak01_dir.vpk"


class MapSunVpkError(RuntimeError):
    """The visual-sun material layer could not be built safely."""


@dataclass(frozen=True)
class MapSunVpkBuild:
    vpk_bytes: bytes
    metadata: dict[str, Any]


def _archive_path(directory_vpk: Path, archive_index: int) -> Path:
    name = directory_vpk.name
    suffix = "_dir.vpk"
    if not name.lower().endswith(suffix):
        raise MapSunVpkError(
            f"official material package is not a directory VPK: {directory_vpk}"
        )
    return directory_vpk.with_name(
        f"{name[: -len(suffix)]}_{archive_index:03d}.vpk"
    )


def _read_verified_entry(directory_vpk: Path, entry_path: str) -> bytes:
    try:
        file_size = directory_vpk.stat().st_size
        with directory_vpk.open("rb") as stream:
            header = _vpk._read_header(stream, file_size=file_size)
            tree = bytearray(stream.read(header.tree_size))
        if len(tree) != header.tree_size:
            raise MapSunVpkError("official material package has a truncated VPK tree")
        entries = _vpk._parse_tree(tree)
    except (OSError, ValueError, TypeError, _vpk.ChromaSkyboxChildError) as exc:
        raise MapSunVpkError(
            f"could not read official material package: {directory_vpk}"
        ) from exc

    entry = entries.get(entry_path)
    if entry is None:
        raise MapSunVpkError(
            f"installed CS2 package is missing transparent material: {entry_path}"
        )
    if entry.archive_index == _vpk._INLINE_ARCHIVE_INDEX:
        if entry.offset + entry.length > header.data_size:
            raise MapSunVpkError(
                f"official transparent material is outside the inline VPK data: "
                f"{entry_path}"
            )
        body_path = directory_vpk
        body_offset = header.data_start + entry.offset
    else:
        body_path = _archive_path(directory_vpk, entry.archive_index)
        body_offset = entry.offset

    try:
        with body_path.open("rb") as stream:
            stream.seek(body_offset)
            body = stream.read(entry.length)
    except OSError as exc:
        raise MapSunVpkError(
            f"could not read official material archive: {body_path}"
        ) from exc
    if len(body) != entry.length:
        raise MapSunVpkError(
            f"official material archive entry is truncated: {entry_path}"
        )

    payload = entry.preload + body
    if (zlib.crc32(payload) & 0xFFFFFFFF) != entry.crc32:
        raise MapSunVpkError(
            f"official material archive entry failed CRC validation: {entry_path}"
        )
    return payload


def compose_map_sun_suppression_vpk(
    *,
    csgo_dir: Path,
    map_name: object,
    base_vpk_bytes: bytes | None,
) -> MapSunVpkBuild:
    """Add a render-only visual-sun suppression layer to a session VPK."""

    normalized_map = normalize_skybox_map_name(map_name)
    if normalized_map not in MAP_SUN_VISUAL_MATERIAL_PATHS:
        supported = ", ".join(MAP_SUN_VISUAL_MATERIAL_PATHS)
        raise MapSunVpkError(
            f"visual sun suppression does not support map "
            f"{normalized_map or '<empty>'}; supported maps: {supported}"
        )
    if base_vpk_bytes is None:
        raise MapSunVpkError("visual sun suppression requires an existing sky VPK")

    targets = MAP_SUN_VISUAL_MATERIAL_PATHS[normalized_map]
    entries = read_inline_vpk(base_vpk_bytes)
    source_payload: bytes | None = None
    source_package = ""
    source_sha256 = ""
    if targets:
        directory_vpk = Path(csgo_dir).parent / _CORE_PACKAGE_RELATIVE_PATH
        if not directory_vpk.is_file() or directory_vpk.is_symlink():
            raise MapSunVpkError(
                f"official CS2 transparent-material package is unavailable: "
                f"{directory_vpk}"
            )
        source_payload = _read_verified_entry(
            directory_vpk,
            _TRANSPARENT_MATERIAL_PATH,
        )
        source_package = _CORE_PACKAGE_RELATIVE_PATH.as_posix()
        source_sha256 = hashlib.sha256(source_payload).hexdigest()
        for target_path in targets:
            existing = entries.get(target_path)
            if existing is not None and existing != source_payload:
                raise MapSunVpkError(
                    f"temporary VPK already overrides visual sun material: "
                    f"{target_path}"
                )
            entries[target_path] = source_payload

    output = write_inline_vpk(entries)
    return MapSunVpkBuild(
        vpk_bytes=output,
        metadata={
            "schema_version": 2,
            "route": (
                "alpha_discard_visual_sun_material_alias"
                if targets
                else "sky_material_replacement_only"
            ),
            "map_name": normalized_map,
            "source_package": source_package,
            "source_material": _TRANSPARENT_MATERIAL_PATH if targets else "",
            "source_size": len(source_payload) if source_payload is not None else 0,
            "source_sha256": source_sha256,
            "target_materials": list(targets),
            "target_material_count": len(targets),
            "light_environment_modified": False,
            "env_sky_lighting_modified": False,
            "output_size": len(output),
            "output_sha256": hashlib.sha256(output).hexdigest(),
        },
    )
