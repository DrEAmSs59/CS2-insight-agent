"""Build narrow weather particle aliases from the installed CS2 VPKs.

This route deliberately reuses an existing map-created particle entity.  For
the Train probe, the map still creates its native ``rain_volume`` systems; the
temporary outer ``pov.vpk`` only resolves that logical particle path to CS2's
installed ``snow`` particle definition.
"""

from __future__ import annotations

import hashlib
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import chroma_skybox_child as _vpk
from .demo_voice_hud import read_inline_vpk, write_inline_vpk
from .skybox_vpk import normalize_skybox_map_name


TRAIN_SNOW_PROBE_MAP = "de_train"
TRAIN_RAIN_PARTICLE_PATH = "particles/rain_fx/rain_volume.vpcf_c"
TRAIN_RAIN_PARTICLE_PATHS = (
    "particles/rain_fx/rain_edge_ground.vpcf_c",
    "particles/rain_fx/rain_edge_sparse_ground.vpcf_c",
    "particles/rain_fx/rain_edge_sparse_longdrop.vpcf_c",
    "particles/rain_fx/rain_edge_sparse.vpcf_c",
    "particles/rain_fx/rain_edge.vpcf_c",
    "particles/rain_fx/rain_lamp_circle_drip.vpcf_c",
    "particles/rain_fx/rain_medium_area_ground.vpcf_c",
    "particles/rain_fx/rain_single_drip_ground.vpcf_c",
    "particles/rain_fx/rain_single_drip.vpcf_c",
    "particles/rain_fx/rain_small_area_ground.vpcf_c",
    "particles/rain_fx/rain_small_edge.vpcf_c",
    TRAIN_RAIN_PARTICLE_PATH,
)
OFFICIAL_SNOW_PARTICLE_PATH = "particles/rain_fx/snow.vpcf_c"


class WeatherParticleVpkError(RuntimeError):
    """An installed particle could not be verified or safely aliased."""


@dataclass(frozen=True)
class WeatherParticleVpkBuild:
    vpk_bytes: bytes
    metadata: dict[str, Any]


def _archive_path(directory_vpk: Path, archive_index: int) -> Path:
    name = directory_vpk.name
    suffix = "_dir.vpk"
    if not name.lower().endswith(suffix):
        raise WeatherParticleVpkError(
            f"official particle package is not a directory VPK: {directory_vpk}"
        )
    stem = name[: -len(suffix)]
    return directory_vpk.with_name(f"{stem}_{archive_index:03d}.vpk")


def _read_verified_entry(directory_vpk: Path, entry_path: str) -> bytes:
    try:
        header, _tree, entries = _vpk._open_package(directory_vpk)
    except (OSError, ValueError, TypeError, _vpk.ChromaSkyboxChildError) as exc:
        raise WeatherParticleVpkError(
            f"could not read official particle package: {directory_vpk}"
        ) from exc

    entry = entries.get(entry_path)
    if entry is None:
        raise WeatherParticleVpkError(
            f"installed CS2 package is missing particle resource: {entry_path}"
        )

    if entry.archive_index == _vpk._INLINE_ARCHIVE_INDEX:
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
        raise WeatherParticleVpkError(
            f"could not read official particle archive: {body_path}"
        ) from exc
    if len(body) != entry.length:
        raise WeatherParticleVpkError(
            f"official particle archive entry is truncated: {entry_path}"
        )

    payload = entry.preload + body
    if (zlib.crc32(payload) & 0xFFFFFFFF) != entry.crc32:
        raise WeatherParticleVpkError(
            f"official particle archive entry failed CRC validation: {entry_path}"
        )
    return payload


def build_train_snow_particle_override_vpk(
    *,
    csgo_dir: Path,
    map_name: object,
    base_vpk_bytes: bytes | None = None,
) -> WeatherParticleVpkBuild:
    """Alias Train's native rain-volume resource to CS2's official snow effect."""

    normalized_map = normalize_skybox_map_name(map_name)
    if normalized_map != TRAIN_SNOW_PROBE_MAP:
        raise WeatherParticleVpkError(
            "native precipitation snow probe only supports de_train"
        )

    directory_vpk = Path(csgo_dir) / "pak01_dir.vpk"
    if not directory_vpk.is_file() or directory_vpk.is_symlink():
        raise WeatherParticleVpkError(
            f"official CS2 particle package is unavailable: {directory_vpk}"
        )

    snow_payload = _read_verified_entry(directory_vpk, OFFICIAL_SNOW_PARTICLE_PATH)
    entries = read_inline_vpk(base_vpk_bytes) if base_vpk_bytes is not None else {}
    for target_path in TRAIN_RAIN_PARTICLE_PATHS:
        existing = entries.get(target_path)
        if existing is not None and existing != snow_payload:
            raise WeatherParticleVpkError(
                f"temporary VPK already overrides Train precipitation: {target_path}"
            )
        entries[target_path] = snow_payload
    output = write_inline_vpk(entries)

    return WeatherParticleVpkBuild(
        vpk_bytes=output,
        metadata={
            "schema_version": 1,
            "route": "native_precipitation_particle_alias",
            "map_name": normalized_map,
            "source_package": "pak01_dir.vpk",
            "source_particle": OFFICIAL_SNOW_PARTICLE_PATH,
            "source_size": len(snow_payload),
            "source_sha256": hashlib.sha256(snow_payload).hexdigest(),
            "target_particle": TRAIN_RAIN_PARTICLE_PATH,
            "target_particles": list(TRAIN_RAIN_PARTICLE_PATHS),
            "target_particle_count": len(TRAIN_RAIN_PARTICLE_PATHS),
            "output_size": len(output),
            "output_sha256": hashlib.sha256(output).hexdigest(),
            "native_particle_entity_reused": True,
            "new_particle_entity_created": False,
            "in_game_validation": "pending",
        },
    )
