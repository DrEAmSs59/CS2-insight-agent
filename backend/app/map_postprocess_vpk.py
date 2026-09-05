"""Alias a map's environment post-process to Train's official overcast vpost.

Dust II's warm look is authored into
``lighting/postprocessing/de_dust2_prefab/de_dust2_prefab.vpost_c``. Console
``ent_fire light_environment`` inputs do not retint that baked grade. The
validated winter pack therefore replaced the map vpost with another official
compiled post-process; rain reuses that route with Train's environment slot
``de_train_postprocess.vpost_c``.
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


TRAIN_ENVIRONMENT_POSTPROCESS_PATH = (
    "lighting/postprocessing/de_train_prefab/de_train_postprocess.vpost_c"
)
MAP_ENVIRONMENT_POSTPROCESS_PATHS: Mapping[str, str] = MappingProxyType(
    {
        "de_dust2": "lighting/postprocessing/de_dust2_prefab/de_dust2_prefab.vpost_c",
        "de_mirage": "lighting/postprocessing/de_mirage_prefab/de_mirage.vpost_c",
        "de_cache": "lighting/postprocessing/de_cache_prefab/de_cache_prefab.vpost_c",
        "de_inferno": "lighting/postprocessing/de_inferno_prefab/de_inferno_prefab.vpost_c",
        "de_ancient": (
            "lighting/postprocessing/de_ancient_prefab/"
            "de_ancient_postprocess_v1.vpost_c"
        ),
        "de_nuke": "lighting/postprocessing/de_nuke_prefab/de_nuke_post.vpost_c",
        "de_anubis": "lighting/postprocessing/de_anubis_prefab/de_anubis_prefab.vpost_c",
        "de_train": TRAIN_ENVIRONMENT_POSTPROCESS_PATH,
    }
)


class MapPostprocessVpkError(RuntimeError):
    """The environment post-process layer could not be built safely."""


@dataclass(frozen=True)
class MapPostprocessVpkBuild:
    vpk_bytes: bytes
    metadata: dict[str, Any]


def _archive_path(directory_vpk: Path, archive_index: int) -> Path:
    name = directory_vpk.name
    suffix = "_dir.vpk"
    if not name.lower().endswith(suffix):
        raise MapPostprocessVpkError(
            f"official post-process package is not a directory VPK: {directory_vpk}"
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
            raise MapPostprocessVpkError(
                "official post-process package has a truncated VPK tree"
            )
        entries = _vpk._parse_tree(tree)
    except (OSError, ValueError, TypeError, _vpk.ChromaSkyboxChildError) as exc:
        raise MapPostprocessVpkError(
            f"could not read official post-process package: {directory_vpk}"
        ) from exc

    entry = entries.get(entry_path)
    if entry is None:
        raise MapPostprocessVpkError(
            f"installed CS2 package is missing post-process resource: {entry_path}"
        )
    if entry.archive_index == _vpk._INLINE_ARCHIVE_INDEX:
        if entry.offset + entry.length > header.data_size:
            raise MapPostprocessVpkError(
                f"official post-process resource is outside the inline VPK data: "
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
        raise MapPostprocessVpkError(
            f"could not read official post-process archive: {body_path}"
        ) from exc
    if len(body) != entry.length:
        raise MapPostprocessVpkError(
            f"official post-process archive entry is truncated: {entry_path}"
        )

    payload = entry.preload + body
    if (zlib.crc32(payload) & 0xFFFFFFFF) != entry.crc32:
        raise MapPostprocessVpkError(
            f"official post-process archive entry failed CRC validation: {entry_path}"
        )
    return payload


def compose_train_environment_postprocess_vpk(
    *,
    csgo_dir: Path,
    map_name: object,
    base_vpk_bytes: bytes | None,
) -> MapPostprocessVpkBuild:
    """Replace the map's environment vpost with Train's official overcast grade."""

    normalized_map = normalize_skybox_map_name(map_name)
    if normalized_map not in MAP_ENVIRONMENT_POSTPROCESS_PATHS:
        supported = ", ".join(MAP_ENVIRONMENT_POSTPROCESS_PATHS)
        raise MapPostprocessVpkError(
            f"train environment post-process does not support map "
            f"{normalized_map or '<empty>'}; supported maps: {supported}"
        )
    if base_vpk_bytes is None:
        raise MapPostprocessVpkError(
            "train environment post-process requires an existing session VPK"
        )

    target = MAP_ENVIRONMENT_POSTPROCESS_PATHS[normalized_map]
    directory_vpk = Path(csgo_dir) / "pak01_dir.vpk"
    if not directory_vpk.is_file() or directory_vpk.is_symlink():
        raise MapPostprocessVpkError(
            f"official CS2 post-process package is unavailable: {directory_vpk}"
        )
    source_payload = _read_verified_entry(
        directory_vpk,
        TRAIN_ENVIRONMENT_POSTPROCESS_PATH,
    )
    entries = read_inline_vpk(base_vpk_bytes)
    existing = entries.get(target)
    if existing is not None and existing != source_payload:
        raise MapPostprocessVpkError(
            f"temporary VPK already overrides environment post-process: {target}"
        )
    entries[target] = source_payload
    output = write_inline_vpk(entries)
    return MapPostprocessVpkBuild(
        vpk_bytes=output,
        metadata={
            "schema_version": 1,
            "route": "train_environment_postprocess_alias",
            "map_name": normalized_map,
            "source_package": "pak01_dir.vpk",
            "source_postprocess": TRAIN_ENVIRONMENT_POSTPROCESS_PATH,
            "source_size": len(source_payload),
            "source_sha256": hashlib.sha256(source_payload).hexdigest(),
            "target_postprocess": target,
            "light_environment_modified": False,
            "output_size": len(output),
            "output_sha256": hashlib.sha256(output).hexdigest(),
        },
    )
