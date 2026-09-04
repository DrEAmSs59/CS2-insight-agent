from pathlib import Path

import pytest

from app.demo_voice_hud import read_inline_vpk, write_inline_vpk
from app.map_sun_vpk import (
    MAP_SUN_SUPPRESSION_MAPS,
    MAP_SUN_VISUAL_MATERIAL_PATHS,
    MapSunVpkError,
    compose_map_sun_suppression_vpk,
)


TRANSPARENT_MATERIAL_PATH = (
    "materials/models/editor/editor_transparent.vmat_c"
)


def _write_core_material_package(csgo_dir: Path, payload: bytes = b"transparent") -> None:
    core_dir = csgo_dir.parent / "core"
    core_dir.mkdir(parents=True, exist_ok=True)
    (core_dir / "pak01_dir.vpk").write_bytes(
        write_inline_vpk({TRANSPARENT_MATERIAL_PATH: payload})
    )


def test_supported_maps_match_the_requested_seven_map_scope() -> None:
    assert MAP_SUN_SUPPRESSION_MAPS == {
        "de_dust2",
        "de_inferno",
        "de_cache",
        "de_nuke",
        "de_mirage",
        "de_ancient",
        "de_anubis",
    }


@pytest.mark.parametrize(
    "map_name",
    sorted(MAP_SUN_SUPPRESSION_MAPS - {"de_cache"}),
)
def test_visual_sun_materials_are_aliased_to_transparent_without_lighting_commands(
    tmp_path: Path,
    map_name: str,
) -> None:
    csgo_dir = tmp_path / "game" / "csgo"
    csgo_dir.mkdir(parents=True)
    _write_core_material_package(csgo_dir)
    base = write_inline_vpk({"panorama/example.txt": b"hud"})

    build = compose_map_sun_suppression_vpk(
        csgo_dir=csgo_dir,
        map_name=map_name,
        base_vpk_bytes=base,
    )

    entries = read_inline_vpk(build.vpk_bytes)
    assert entries["panorama/example.txt"] == b"hud"
    for target in MAP_SUN_VISUAL_MATERIAL_PATHS[map_name]:
        assert entries[target] == b"transparent"
    assert build.metadata["target_material_count"] == len(
        MAP_SUN_VISUAL_MATERIAL_PATHS[map_name]
    )
    assert build.metadata["schema_version"] == 2
    assert build.metadata["route"] == "alpha_discard_visual_sun_material_alias"
    assert build.metadata["source_material"] == TRANSPARENT_MATERIAL_PATH
    assert build.metadata["light_environment_modified"] is False
    assert build.metadata["env_sky_lighting_modified"] is False


def test_cache_needs_no_separate_billboard_override(tmp_path: Path) -> None:
    csgo_dir = tmp_path / "game" / "csgo"
    csgo_dir.mkdir(parents=True)
    base = write_inline_vpk({"materials/cache/sky.vmat_c": b"replacement-sky"})

    build = compose_map_sun_suppression_vpk(
        csgo_dir=csgo_dir,
        map_name="de_cache",
        base_vpk_bytes=base,
    )

    assert read_inline_vpk(build.vpk_bytes) == {
        "materials/cache/sky.vmat_c": b"replacement-sky"
    }
    assert build.metadata["route"] == "sky_material_replacement_only"
    assert build.metadata["target_material_count"] == 0


def test_visual_sun_suppression_rejects_unsupported_maps_and_conflicts(
    tmp_path: Path,
) -> None:
    csgo_dir = tmp_path / "game" / "csgo"
    csgo_dir.mkdir(parents=True)
    _write_core_material_package(csgo_dir)

    with pytest.raises(MapSunVpkError, match="does not support map"):
        compose_map_sun_suppression_vpk(
            csgo_dir=csgo_dir,
            map_name="de_overpass",
            base_vpk_bytes=write_inline_vpk({"example.txt": b"base"}),
        )

    target = MAP_SUN_VISUAL_MATERIAL_PATHS["de_anubis"][0]
    with pytest.raises(MapSunVpkError, match="already overrides"):
        compose_map_sun_suppression_vpk(
            csgo_dir=csgo_dir,
            map_name="de_anubis",
            base_vpk_bytes=write_inline_vpk({target: b"different-material"}),
        )
