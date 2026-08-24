"""Recording skybox resources and map-specific VPK composition."""

from __future__ import annotations

from collections.abc import Mapping

from .demo_voice_hud import read_inline_vpk, write_inline_vpk


DEFAULT_SKYBOX_ID = "default"
SKYBOX_ASSETS: Mapping[str, tuple[str, str]] = {
    "cartoon3": (
        "materials/cartoon3.vmat_c",
        "materials/cartoon3_exr_d7864907.vtex_c",
    ),
    "xuejing": (
        "materials/xuejing.vmat_c",
        "materials/xuejing_exr_a06856b0.vtex_c",
    ),
    "yinhezhanjian": (
        "materials/yinhezhanjian.vmat_c",
        "materials/yinhezhanjian_exr_6b37921e.vtex_c",
    ),
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
}


class SkyboxVpkError(RuntimeError):
    pass


def normalize_skybox_id(value: object) -> str:
    skybox_id = str(value or DEFAULT_SKYBOX_ID).strip().lower()
    if skybox_id not in SKYBOX_IDS:
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
    asset_vpk_bytes: bytes,
    skybox_id: str,
) -> tuple[dict[str, bytes], bytes]:
    asset_entries = read_inline_vpk(asset_vpk_bytes)
    material_path, texture_path = SKYBOX_ASSETS[skybox_id]
    missing = [path for path in (material_path, texture_path) if path not in asset_entries]
    if missing:
        raise SkyboxVpkError(
            "skybox asset VPK is missing: " + ", ".join(missing)
        )
    return (
        {
            material_path: asset_entries[material_path],
            texture_path: asset_entries[texture_path],
        },
        asset_entries[material_path],
    )


def compose_recording_skybox_vpk(
    *,
    asset_vpk_bytes: bytes,
    skybox_id: object,
    map_name: object,
    base_vpk_bytes: bytes | None = None,
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
    selected_entries, material = _selected_sky_entries(asset_vpk_bytes, selected)
    entries.update(selected_entries)
    for target_path in target_paths:
        entries[target_path] = material
    return write_inline_vpk(entries)
