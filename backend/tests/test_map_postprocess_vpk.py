from pathlib import Path

import pytest

from app.demo_voice_hud import read_inline_vpk, write_inline_vpk
from app.map_postprocess_vpk import (
    MAP_ENVIRONMENT_POSTPROCESS_PATHS,
    TRAIN_ENVIRONMENT_POSTPROCESS_PATH,
    MapPostprocessVpkError,
    compose_train_environment_postprocess_vpk,
)


TRAIN_POST_PAYLOAD = b"train-environment-vpost"


def _write_csgo_postprocess_package(csgo_dir: Path, payload: bytes = TRAIN_POST_PAYLOAD) -> None:
    csgo_dir.mkdir(parents=True, exist_ok=True)
    (csgo_dir / "pak01_dir.vpk").write_bytes(
        write_inline_vpk({TRAIN_ENVIRONMENT_POSTPROCESS_PATH: payload})
    )


def test_rain_maps_alias_their_environment_vpost_to_train() -> None:
    assert TRAIN_ENVIRONMENT_POSTPROCESS_PATH == (
        "lighting/postprocessing/de_train_prefab/de_train_postprocess.vpost_c"
    )
    assert MAP_ENVIRONMENT_POSTPROCESS_PATHS == {
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


@pytest.mark.parametrize("map_name", sorted(MAP_ENVIRONMENT_POSTPROCESS_PATHS))
def test_compose_copies_train_vpost_onto_the_map_environment_slot(
    tmp_path: Path,
    map_name: str,
) -> None:
    csgo_dir = tmp_path / "game" / "csgo"
    _write_csgo_postprocess_package(csgo_dir)
    base = write_inline_vpk({"panorama/example.txt": b"hud"})

    build = compose_train_environment_postprocess_vpk(
        csgo_dir=csgo_dir,
        map_name=map_name,
        base_vpk_bytes=base,
    )

    entries = read_inline_vpk(build.vpk_bytes)
    target = MAP_ENVIRONMENT_POSTPROCESS_PATHS[map_name]
    assert entries["panorama/example.txt"] == b"hud"
    assert entries[target] == TRAIN_POST_PAYLOAD
    assert build.metadata["route"] == "train_environment_postprocess_alias"
    assert build.metadata["source_postprocess"] == TRAIN_ENVIRONMENT_POSTPROCESS_PATH
    assert build.metadata["target_postprocess"] == target
    assert build.metadata["light_environment_modified"] is False


def test_compose_rejects_unsupported_maps_and_conflicting_overrides(
    tmp_path: Path,
) -> None:
    csgo_dir = tmp_path / "game" / "csgo"
    _write_csgo_postprocess_package(csgo_dir)

    with pytest.raises(MapPostprocessVpkError, match="does not support map"):
        compose_train_environment_postprocess_vpk(
            csgo_dir=csgo_dir,
            map_name="de_overpass",
            base_vpk_bytes=write_inline_vpk({"example.txt": b"base"}),
        )

    target = MAP_ENVIRONMENT_POSTPROCESS_PATHS["de_dust2"]
    with pytest.raises(MapPostprocessVpkError, match="already overrides"):
        compose_train_environment_postprocess_vpk(
            csgo_dir=csgo_dir,
            map_name="de_dust2",
            base_vpk_bytes=write_inline_vpk({target: b"different-vpost"}),
        )
