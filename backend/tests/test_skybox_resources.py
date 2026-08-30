from __future__ import annotations

from pathlib import Path

import pytest

from app.demo_voice_hud import read_inline_vpk
from app.skybox_resources import (
    SkyboxResourceConflict,
    SkyboxResourceError,
    create_custom_skybox,
    delete_custom_skybox,
    list_skybox_resources,
    load_custom_skybox,
    rename_custom_skybox,
    validate_skybox_files,
)
from app.skybox_vpk import (
    MAP_SKY_MATERIAL_PATHS,
    SKYBOX_ASSETS,
    SkyboxVpkError,
    compose_recording_skybox_vpk,
    normalize_skybox_id,
)


@pytest.fixture(scope="module")
def bundled_asset_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "pov" / "skyboxes"


def _read_bundled_entries(asset_dir: Path, *skybox_ids: str) -> dict[str, bytes]:
    entries: dict[str, bytes] = {}
    for skybox_id in skybox_ids:
        for internal_path in SKYBOX_ASSETS[skybox_id]:
            source = asset_dir / skybox_id / Path(internal_path).name
            entries[internal_path] = source.read_bytes()
    return entries


@pytest.fixture()
def bundled_entries(bundled_asset_dir: Path) -> dict[str, bytes]:
    return _read_bundled_entries(bundled_asset_dir, "cartoon3", "cartoon4")


@pytest.fixture()
def isolated_skybox_data(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    from app import skybox_resources

    monkeypatch.setattr(skybox_resources, "get_data_dir", lambda: tmp_path)
    return tmp_path


def _create_cartoon_custom(entries: dict[str, bytes]) -> dict:
    material_path, texture_path = SKYBOX_ASSETS["cartoon3"]
    return create_custom_skybox(
        display_name="我的卡通天空",
        material_filename=Path(material_path).name,
        material_bytes=entries[material_path],
        texture_filename=Path(texture_path).name,
        texture_bytes=entries[texture_path],
    )


@pytest.mark.parametrize("skybox_id", SKYBOX_ASSETS)
def test_bundled_skyboxes_pass_upload_validation(
    bundled_asset_dir: Path,
    skybox_id: str,
) -> None:
    bundled_entries = _read_bundled_entries(bundled_asset_dir, skybox_id)
    material_path, texture_path = SKYBOX_ASSETS[skybox_id]
    assert validate_skybox_files(
        material_filename=Path(material_path).name,
        material_bytes=bundled_entries[material_path],
        texture_filename=Path(texture_path).name,
        texture_bytes=bundled_entries[texture_path],
    ) == texture_path


def test_bundled_cartoon_catalog_uses_natural_numeric_order() -> None:
    assert [skybox_id for skybox_id in SKYBOX_ASSETS if skybox_id.startswith("cartoon")] == [
        "cartoon",
        "cartoon1",
        "cartoon2",
        "cartoon3",
        "cartoon4",
        "cartoon5",
        "cartoon6",
        "cartoon7",
        "cartoon8",
        "cartoon9",
        "cartoon10",
    ]


def test_builtin_catalog_contains_chroma_then_cartoon_skyboxes() -> None:
    resources = list_skybox_resources()
    builtin = [item for item in resources if item["source"] == "builtin"]
    builtin_ids = [item["id"] for item in builtin]
    assert builtin_ids == list(SKYBOX_ASSETS)
    assert builtin_ids[:2] == ["chroma_green", "chroma_blue"]
    assert all(skybox_id.startswith("cartoon") for skybox_id in builtin_ids[2:])
    assert [item["display_name"] for item in builtin[:2]] == [
        "绿色",
        "蓝色",
    ]


def test_upload_rejects_texture_that_does_not_match_vmat(
    bundled_entries: dict[str, bytes],
) -> None:
    material_path, _ = SKYBOX_ASSETS["cartoon3"]
    _, wrong_texture_path = SKYBOX_ASSETS["cartoon4"]
    with pytest.raises(SkyboxResourceError, match="需要纹理"):
        validate_skybox_files(
            material_filename=Path(material_path).name,
            material_bytes=bundled_entries[material_path],
            texture_filename=Path(wrong_texture_path).name,
            texture_bytes=bundled_entries[wrong_texture_path],
        )


def test_custom_skybox_crud_and_dynamic_normalization(
    bundled_entries: dict[str, bytes],
    isolated_skybox_data: Path,
) -> None:
    created = _create_cartoon_custom(bundled_entries)
    assert created["id"].startswith("custom:")
    assert created["display_name"] == "我的卡通天空"
    assert normalize_skybox_id(created["id"]) == created["id"]

    listed = list_skybox_resources()
    assert [item["id"] for item in listed[:len(SKYBOX_ASSETS)]] == list(SKYBOX_ASSETS)
    assert listed[0]["preview_url"] == f"/skyboxes/{listed[0]['id']}.webp"
    assert listed[-1]["display_name"] == "我的卡通天空"
    assert listed[-1]["preview_url"] is None

    renamed = rename_custom_skybox(created["id"], "新的名称")
    assert renamed["display_name"] == "新的名称"
    assert load_custom_skybox(created["id"]).texture_path.endswith(".vtex_c")

    assert delete_custom_skybox(created["id"]) is True
    with pytest.raises(SkyboxVpkError, match="unsupported"):
        normalize_skybox_id(created["id"])


def test_duplicate_custom_files_are_rejected(
    bundled_entries: dict[str, bytes],
    isolated_skybox_data: Path,
) -> None:
    _create_cartoon_custom(bundled_entries)
    with pytest.raises(SkyboxResourceConflict, match="已作为"):
        create_custom_skybox(
            display_name="相同文件另一名称",
            material_filename="cartoon3.vmat_c",
            material_bytes=bundled_entries[SKYBOX_ASSETS["cartoon3"][0]],
            texture_filename=Path(SKYBOX_ASSETS["cartoon3"][1]).name,
            texture_bytes=bundled_entries[SKYBOX_ASSETS["cartoon3"][1]],
        )


def test_custom_skybox_is_composed_into_map_targets(
    bundled_entries: dict[str, bytes],
    isolated_skybox_data: Path,
) -> None:
    created = _create_cartoon_custom(bundled_entries)
    resource = load_custom_skybox(created["id"])
    packed = compose_recording_skybox_vpk(
        builtin_assets_dir=None,
        skybox_id=created["id"],
        map_name="de_mirage",
    )
    entries = read_inline_vpk(packed)
    assert entries[resource.texture_path] == resource.texture_bytes
    assert entries[resource.material_path] == resource.material_bytes
    assert entries[MAP_SKY_MATERIAL_PATHS["de_mirage"][0]] == resource.material_bytes
