"""Recording skybox resources and map-specific VPK composition."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

from .chroma_demo_manifest import (
    chroma_demo_redirect_material_path,
    chroma_demo_registered_material_path,
)
from .demo_voice_hud import read_inline_vpk, write_inline_vpk


DEFAULT_SKYBOX_ID = "default"
CHROMA_SKYBOX_IDS = frozenset({"chroma_green", "chroma_blue"})
CHROMA_ACTIVE_SKY_MATERIAL_PATH = (
    "materials/cs2_insight/chroma/active_sky.vmat_c"
)
_SKYBOX_TEXTURE_FILENAMES: Mapping[str, str] = {
    "chroma_green": "chroma_green.vtex_c",
    "chroma_blue": "chroma_blue.vtex_c",
    "cartoon": "cartoon_exr_b1862b2d.vtex_c",
    "cartoon1": "cartoon1_exr_7d8a29ad.vtex_c",
    "cartoon2": "cartoon2_exr_900b0049.vtex_c",
    "cartoon3": "cartoon3_exr_d7864907.vtex_c",
    "cartoon4": "cartoon4_exr_310cb01d.vtex_c",
    "cartoon5": "cartoon5_exr_dc4f746d.vtex_c",
    "cartoon6": "cartoon6_exr_6c5d0ab0.vtex_c",
    "cartoon7": "cartoon7_exr_127a8f56.vtex_c",
    "cartoon8": "cartoon8_exr_50138bfa.vtex_c",
    "cartoon9": "cartoon9_exr_26f96cc6.vtex_c",
    "cartoon10": "cartoon10_exr_5a30d013.vtex_c",
}
SKYBOX_ASSETS: Mapping[str, tuple[str, str]] = {
    skybox_id: (
        f"materials/{skybox_id}.vmat_c",
        f"materials/{texture_filename}",
    )
    for skybox_id, texture_filename in _SKYBOX_TEXTURE_FILENAMES.items()
}
SKYBOX_IDS = (DEFAULT_SKYBOX_ID, *SKYBOX_ASSETS)

# Verified against the env_sky / env_cubemap_fog entities in the current
# compiled Valve map VPKs. Some maps intentionally reference more than one
# material: overriding all of them keeps the visible sky and fog consistent.
MAP_SKY_MATERIAL_PATHS: Mapping[str, tuple[str, ...]] = {
    "de_dust2": (
        "materials/skybox/sky_de_dust2.vmat_c",
    ),
    "de_inferno": (
        "materials/skybox/test/s2_de_inferno_sky01.vmat_c",
        "materials/skybox/skymodel_hosekwilkie_ref/"
        "skymodel_hosekwilkie_albedo_0_30_turbidity_02_0_elevation_65_0.vmat_c",
    ),
    "de_mirage": (
        "materials/skybox/sky_de_mirage.vmat_c",
    ),
    "de_nuke": (
        "materials/skybox/sky_de_nuke.vmat_c",
    ),
    "de_overpass": (
        "materials/skybox/sky_de_overpass_01.vmat_c",
    ),
    "de_anubis": (
        "materials/skybox/sky_de_annubis.vmat_c",
    ),
    "de_cache": (
        "materials/de_cache/sky/de_cache_sky_001.vmat_c",
    ),
    "de_ancient": (
        "materials/skybox/sky_hr_aztec_02_lighting.vmat_c",
        "materials/skybox/sky_hr_aztec_02_v1.vmat_c",
    ),
    "de_train": (
        "materials/skybox/sky_overcast_01.vmat_c",
    ),
    "de_vertigo": (
        "materials/skybox/sky_de_vertigo.vmat_c",
    ),
}

class SkyboxVpkError(RuntimeError):
    pass


def normalize_skybox_id(value: object) -> str:
    skybox_id = str(value or DEFAULT_SKYBOX_ID).strip().lower()
    from .skybox_resources import skybox_resource_exists

    if not skybox_resource_exists(skybox_id):
        raise SkyboxVpkError(f"unsupported recording skybox: {skybox_id}")
    return skybox_id


def normalize_skybox_map_name(value: object) -> str:
    map_name = str(value or "").strip().lower().replace("\\", "/")
    map_name = map_name.rsplit("/", 1)[-1]
    if map_name.endswith(".vpk"):
        map_name = map_name[:-4]
    if map_name and not map_name.startswith("de_"):
        map_name = f"de_{map_name}"
    return map_name


def _selected_sky_entries(
    builtin_assets_dir: Path | None,
    skybox_id: str,
) -> tuple[dict[str, bytes], bytes]:
    if skybox_id not in SKYBOX_ASSETS:
        from .skybox_resources import SkyboxResourceError, load_custom_skybox

        try:
            resource = load_custom_skybox(skybox_id)
        except SkyboxResourceError as exc:
            raise SkyboxVpkError(str(exc)) from exc
        return (
            {
                resource.material_path: resource.material_bytes,
                resource.texture_path: resource.texture_bytes,
            },
            resource.material_bytes,
        )
    if builtin_assets_dir is None:
        raise SkyboxVpkError("the built-in skybox asset directory is missing")
    material_path, texture_path = SKYBOX_ASSETS[skybox_id]
    source_dir = Path(builtin_assets_dir) / skybox_id
    material_source = source_dir / Path(material_path).name
    texture_source = source_dir / Path(texture_path).name
    missing = [str(path) for path in (material_source, texture_source) if not path.is_file()]
    if missing:
        raise SkyboxVpkError(
            "built-in skybox file is missing: " + ", ".join(missing)
        )
    material_bytes = material_source.read_bytes()
    texture_bytes = texture_source.read_bytes()
    output_material_path = (
        CHROMA_ACTIVE_SKY_MATERIAL_PATH
        if skybox_id in CHROMA_SKYBOX_IDS
        else material_path
    )
    return (
        {
            output_material_path: material_bytes,
            texture_path: texture_bytes,
        },
        material_bytes,
    )


def compose_recording_skybox_vpk(
    *,
    builtin_assets_dir: Path | None,
    skybox_id: object,
    map_name: object,
    base_vpk_bytes: bytes | None = None,
    advanced_demo_chroma: bool = False,
) -> bytes:
    """Build a normal sky-only VPK or add the sky layer to a POV VPK."""

    selected = normalize_skybox_id(skybox_id)
    if selected == DEFAULT_SKYBOX_ID:
        if base_vpk_bytes is None:
            raise SkyboxVpkError("the default sky does not require a sky-only VPK")
        return base_vpk_bytes

    normalized_map = normalize_skybox_map_name(map_name)
    target_paths = MAP_SKY_MATERIAL_PATHS.get(normalized_map)
    if not target_paths:
        supported = ", ".join(MAP_SKY_MATERIAL_PATHS)
        raise SkyboxVpkError(
            f"recording skybox does not support map {normalized_map or '<empty>'}; "
            f"supported maps: {supported}"
        )

    entries = read_inline_vpk(base_vpk_bytes) if base_vpk_bytes is not None else {}
    selected_entries, material = _selected_sky_entries(builtin_assets_dir, selected)
    entries.update(selected_entries)
    # Chroma child-skybox profiles point their active env_sky at our own
    # virtual material. Advanced playback migrates the validated reference
    # SpawnGroup registration for that same path into its disposable Demo.
    # Valve's retail sky/fog material paths remain untouched.
    if selected in CHROMA_SKYBOX_IDS:
        redirect_path = chroma_demo_redirect_material_path(normalized_map)
        if redirect_path is not None:
            entries[redirect_path] = material
        if advanced_demo_chroma:
            registered_path = chroma_demo_registered_material_path(normalized_map)
            if registered_path is None:
                raise SkyboxVpkError(
                    "advanced chroma demo has no registered material profile for "
                    f"{normalized_map}"
                )
            entries[registered_path] = material
    else:
        for target_path in target_paths:
            entries[target_path] = material
    return write_inline_vpk(entries)
