import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.demo_voice_hud import read_inline_vpk, write_inline_vpk
from app import pov_hud_manager
from app.map_material_vpk import (
    DEFAULT_MAP_MATERIAL_ID,
    MAP_MATERIAL_IDS,
    WAXED_REFLECTION_LIGHTING_COMMANDS,
    WAXED_REFLECTION_MAP_MATERIAL_ID,
    MapMaterialVpkError,
    compose_recording_map_material_vpk,
    map_material_console_commands,
    normalize_map_material_id,
)
from app.pov_hud_manager import PovHudManager
from app.skybox_vpk import MAP_SKY_MATERIAL_PATHS, SKYBOX_ASSETS


def _write_profile(root: Path) -> Path:
    profile = root / WAXED_REFLECTION_MAP_MATERIAL_ID
    profile.mkdir(parents=True)
    catalog_entries = {
        "catalog/shared/normal.vtex_c": b"normal",
        "catalog/dust2/floor.vmat_c": b"dust-floor",
        "catalog/mirage/wall.vmat_c": b"mirage-wall",
    }
    catalog = write_inline_vpk(catalog_entries)
    manifest = {
        "schema_version": 1,
        "id": WAXED_REFLECTION_MAP_MATERIAL_ID,
        "lighting_commands": list(WAXED_REFLECTION_LIGHTING_COMMANDS),
        "catalog_sha256": hashlib.sha256(catalog).hexdigest(),
        "shared_entries": [
            {
                "target": "materials/cs2_insight/flat_normal.vtex_c",
                "catalog": "catalog/shared/normal.vtex_c",
                "sha256": hashlib.sha256(b"normal").hexdigest(),
            }
        ],
        "maps": {
            "de_dust2": [
                {
                    "target": "materials/ground/floor.vmat_c",
                    "catalog": "catalog/dust2/floor.vmat_c",
                    "sha256": hashlib.sha256(b"dust-floor").hexdigest(),
                }
            ],
            "de_mirage": [
                {
                    "target": "materials/walls/wall.vmat_c",
                    "catalog": "catalog/mirage/wall.vmat_c",
                    "sha256": hashlib.sha256(b"mirage-wall").hexdigest(),
                }
            ],
        },
    }
    (profile / "catalog.vpk").write_bytes(catalog)
    (profile / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root


def _manager_for_tmp_game(monkeypatch, tmp_path: Path) -> tuple[PovHudManager, Path, Path]:
    monkeypatch.setattr(pov_hud_manager.sys, "platform", "win32")
    monkeypatch.setattr(pov_hud_manager, "is_cs2_running", lambda: False)
    game_root = tmp_path / "game"
    cs2 = game_root / "bin" / "win64" / "cs2.exe"
    csgo = game_root / "csgo"
    cs2.parent.mkdir(parents=True)
    csgo.mkdir(parents=True)
    cs2.write_bytes(b"exe")
    (csgo / "gameinfo.gi").write_text(
        "FileSystem\n{\n  SearchPaths\n  {\n    Game    csgo\n  }\n}\n",
        encoding="utf-8",
    )
    pov_dir = tmp_path / "pov"
    pov_dir.mkdir()
    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    monkeypatch.setattr(manager, "get_project_pov_dir", lambda: pov_dir)
    return manager, pov_dir, csgo


def test_map_material_ids_and_lighting_commands() -> None:
    assert MAP_MATERIAL_IDS == ("default", "waxed_reflection")
    assert normalize_map_material_id(" WAXED_REFLECTION ") == "waxed_reflection"
    assert map_material_console_commands("default") == ()
    assert map_material_console_commands("waxed_reflection") == WAXED_REFLECTION_LIGHTING_COMMANDS
    assert "r_rendersun 0" in WAXED_REFLECTION_LIGHTING_COMMANDS
    assert "r_directlighting 0" in WAXED_REFLECTION_LIGHTING_COMMANDS
    assert "r_indirectlighting 1" in WAXED_REFLECTION_LIGHTING_COMMANDS
    with pytest.raises(MapMaterialVpkError, match="unsupported"):
        normalize_map_material_id("mirror_everything")


def test_compose_selects_only_the_requested_map_and_preserves_base(tmp_path: Path) -> None:
    assets = _write_profile(tmp_path / "map_materials")
    base = write_inline_vpk({"panorama/layout/base.vxml_c": b"hud"})
    package = compose_recording_map_material_vpk(
        assets_dir=assets,
        material_id="waxed_reflection",
        map_name="maps/de_dust2.vpk",
        base_vpk_bytes=base,
    )
    entries = read_inline_vpk(package)
    assert entries == {
        "panorama/layout/base.vxml_c": b"hud",
        "materials/cs2_insight/flat_normal.vtex_c": b"normal",
        "materials/ground/floor.vmat_c": b"dust-floor",
    }
    assert "materials/walls/wall.vmat_c" not in entries
    assert not any(path.startswith("catalog/") for path in entries)


def test_default_requires_no_material_only_vpk(tmp_path: Path) -> None:
    base = write_inline_vpk({"panorama/base.txt": b"hud"})
    assert compose_recording_map_material_vpk(
        assets_dir=tmp_path,
        material_id=DEFAULT_MAP_MATERIAL_ID,
        map_name="de_dust2",
        base_vpk_bytes=base,
    ) == base
    with pytest.raises(MapMaterialVpkError, match="does not require"):
        compose_recording_map_material_vpk(
            assets_dir=tmp_path,
            material_id=DEFAULT_MAP_MATERIAL_ID,
            map_name="de_dust2",
        )


def test_unsupported_map_and_tampered_catalog_fail_closed(tmp_path: Path) -> None:
    assets = _write_profile(tmp_path / "map_materials")
    with pytest.raises(MapMaterialVpkError, match="does not support map"):
        compose_recording_map_material_vpk(
            assets_dir=assets,
            material_id="waxed_reflection",
            map_name="de_train",
        )

    catalog = assets / "waxed_reflection" / "catalog.vpk"
    catalog.write_bytes(catalog.read_bytes() + b"tampered")
    with pytest.raises(MapMaterialVpkError, match="catalog hash"):
        compose_recording_map_material_vpk(
            assets_dir=assets,
            material_id="waxed_reflection",
            map_name="de_dust2",
        )


def test_manager_installs_material_only_without_pov_panorama(monkeypatch, tmp_path: Path) -> None:
    manager, pov_dir, csgo = _manager_for_tmp_game(monkeypatch, tmp_path)
    _write_profile(pov_dir / "map_materials")

    manager.install(map_name="de_dust2", map_material_id="waxed_reflection")

    entries = read_inline_vpk((csgo / "pov.vpk").read_bytes())
    assert entries == {
        "materials/cs2_insight/flat_normal.vtex_c": b"normal",
        "materials/ground/floor.vmat_c": b"dust-floor",
    }
    assert not any(path.startswith("panorama/") for path in entries)
    manifest = manager._read_manifest()
    assert manifest["feature"] == "recording_map_material"
    assert manifest["recording_map_material_id"] == "waxed_reflection"

    restored = manager.restore()
    assert restored["verified"] is True
    assert not (csgo / "pov.vpk").exists()
    assert "csgo/pov.vpk" not in (csgo / "gameinfo.gi").read_text(encoding="utf-8")


def test_manager_merges_material_and_skybox_into_one_runtime_vpk(
    monkeypatch,
    tmp_path: Path,
) -> None:
    manager, pov_dir, csgo = _manager_for_tmp_game(monkeypatch, tmp_path)
    _write_profile(pov_dir / "map_materials")
    material_path, texture_path = SKYBOX_ASSETS["cartoon3"]
    skybox_dir = pov_dir / "skyboxes" / "cartoon3"
    skybox_dir.mkdir(parents=True)
    (skybox_dir / Path(material_path).name).write_bytes(b"sky-material")
    (skybox_dir / Path(texture_path).name).write_bytes(b"sky-texture")

    manager.install(
        map_name="de_dust2",
        map_material_id="waxed_reflection",
        skybox_id="cartoon3",
    )

    entries = read_inline_vpk((csgo / "pov.vpk").read_bytes())
    assert entries["materials/ground/floor.vmat_c"] == b"dust-floor"
    assert entries[material_path] == b"sky-material"
    assert entries[texture_path] == b"sky-texture"
    assert entries[MAP_SKY_MATERIAL_PATHS["de_dust2"][0]] == b"sky-material"
    assert manager._read_manifest()["feature"] == "recording_map_material_with_skybox"


@pytest.mark.parametrize(
    "map_name",
    (
        "de_dust2",
        "de_ancient",
        "de_mirage",
        "de_nuke",
        "de_anubis",
        "de_inferno",
        "de_overpass",
        "de_cache",
    ),
)
def test_bundled_waxed_catalog_composes_each_supported_map(map_name: str) -> None:
    project_root = Path(__file__).resolve().parents[2]
    assets = project_root / "pov" / "map_materials"
    manifest = json.loads(
        (assets / "waxed_reflection" / "manifest.json").read_text(encoding="utf-8")
    )
    package = compose_recording_map_material_vpk(
        assets_dir=assets,
        material_id="waxed_reflection",
        map_name=map_name,
    )
    entries = read_inline_vpk(package)
    expected_targets = {
        *(item["target"] for item in manifest["shared_entries"]),
        *(item["target"] for item in manifest["maps"][map_name]),
    }
    assert set(entries) == expected_targets
    assert len(entries) == len(manifest["maps"][map_name]) + len(manifest["shared_entries"])
    assert not any(path.startswith("materials/skybox/") for path in entries)
    assert not any(path.startswith("panorama/") for path in entries)
