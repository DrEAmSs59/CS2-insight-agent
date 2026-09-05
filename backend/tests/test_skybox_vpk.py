import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import pov_hud_manager
from app.chroma_demo_manifest import chroma_demo_redirect_material_path
from app.chroma_skybox_child import ChromaChildVpkBuild, ChromaSkyboxChildError
from app.demo_voice_hud import DemoVoiceHudBuild, read_inline_vpk, write_inline_vpk
from app.pov_hud_manager import PovHudError, PovHudManager
from app.skybox_vpk import (
    CHROMA_ACTIVE_SKY_MATERIAL_PATH,
    CHROMA_SKYBOX_IDS,
    MAP_SKY_MATERIAL_PATHS,
    SKYBOX_ASSETS,
    SkyboxVpkError,
    compose_recording_skybox_vpk,
    normalize_skybox_map_name,
)


def _write_asset_pair(root: Path, skybox_id: str) -> Path:
    material_path, texture_path = SKYBOX_ASSETS[skybox_id]
    source_dir = root / skybox_id
    source_dir.mkdir(parents=True, exist_ok=True)
    (source_dir / Path(material_path).name).write_bytes(f"material:{skybox_id}".encode())
    (source_dir / Path(texture_path).name).write_bytes(f"texture:{skybox_id}".encode())
    return root


def _write_chroma_child_catalog(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "payloads").mkdir()
    (root / "manifest.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "maps": {
                    "de_ancient": {"main_map_patch_required": False},
                },
            }
        ),
        encoding="utf-8",
    )
    return root


def _write_chroma_main_catalog(root: Path, *, no_main: tuple[str, ...]) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "payloads").mkdir()
    (root / "manifest.json").write_text(
        json.dumps(
            {
                "schema_version": 2,
                "no_main_patch_required": list(no_main),
                "maps": {},
            }
        ),
        encoding="utf-8",
    )
    return root


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("dust2", "de_dust2"),
        ("DE_MIRAGE", "de_mirage"),
        ("maps/de_cache.vpk", "de_cache"),
    ],
)
def test_normalize_skybox_map_name(raw: str, expected: str) -> None:
    assert normalize_skybox_map_name(raw) == expected


@pytest.mark.parametrize(
    "skybox_id", (item for item in SKYBOX_ASSETS if item not in CHROMA_SKYBOX_IDS)
)
@pytest.mark.parametrize("map_name", MAP_SKY_MATERIAL_PATHS)
def test_sky_only_package_overrides_every_material_for_supported_map(
    map_name: str,
    skybox_id: str,
    tmp_path: Path,
) -> None:
    packed = compose_recording_skybox_vpk(
        builtin_assets_dir=_write_asset_pair(tmp_path / "skyboxes", skybox_id),
        skybox_id=skybox_id,
        map_name=map_name,
    )
    entries = read_inline_vpk(packed)
    material_path, texture_path = SKYBOX_ASSETS[skybox_id]
    assert entries[material_path] == f"material:{skybox_id}".encode()
    assert entries[texture_path] == f"texture:{skybox_id}".encode()
    for target_path in MAP_SKY_MATERIAL_PATHS[map_name]:
        assert entries[target_path] == f"material:{skybox_id}".encode()
    assert not any(path.startswith("panorama/") for path in entries)


@pytest.mark.parametrize("skybox_id", sorted(CHROMA_SKYBOX_IDS))
@pytest.mark.parametrize("map_name", MAP_SKY_MATERIAL_PATHS)
def test_chroma_package_uses_only_the_virtual_material(
    map_name: str,
    skybox_id: str,
    tmp_path: Path,
) -> None:
    packed = compose_recording_skybox_vpk(
        builtin_assets_dir=_write_asset_pair(tmp_path / "skyboxes", skybox_id),
        skybox_id=skybox_id,
        map_name=map_name,
    )
    entries = read_inline_vpk(packed)
    original_material_path, texture_path = SKYBOX_ASSETS[skybox_id]
    expected = {
        CHROMA_ACTIVE_SKY_MATERIAL_PATH: f"material:{skybox_id}".encode(),
        texture_path: f"texture:{skybox_id}".encode(),
    }
    redirect_path = chroma_demo_redirect_material_path(map_name)
    if redirect_path is not None:
        expected[redirect_path] = f"material:{skybox_id}".encode()
    assert entries == expected
    assert original_material_path not in entries
    assert not set(MAP_SKY_MATERIAL_PATHS[map_name]).intersection(entries)


def test_ancient_chroma_package_never_aliases_retail_sky_materials() -> None:
    assert set(MAP_SKY_MATERIAL_PATHS["de_ancient"]) == {
        "materials/skybox/sky_hr_aztec_02_lighting.vmat_c",
        "materials/skybox/sky_hr_aztec_02_v1.vmat_c",
    }


def test_advanced_ancient_chroma_uses_only_registered_private_sky_material(
    tmp_path: Path,
) -> None:
    packed = compose_recording_skybox_vpk(
        builtin_assets_dir=_write_asset_pair(
            tmp_path / "skyboxes",
            "chroma_blue",
        ),
        skybox_id="chroma_blue",
        map_name="de_ancient",
        advanced_demo_chroma=True,
    )
    entries = read_inline_vpk(packed)
    lighting, visible = MAP_SKY_MATERIAL_PATHS["de_ancient"]
    assert entries[CHROMA_ACTIVE_SKY_MATERIAL_PATH] == b"material:chroma_blue"
    assert lighting not in entries
    assert visible not in entries


def test_pov_package_keeps_base_entries_and_adds_selected_sky_only(tmp_path: Path) -> None:
    base = write_inline_vpk({"panorama/example.txt": b"hud"})
    packed = compose_recording_skybox_vpk(
        builtin_assets_dir=_write_asset_pair(tmp_path / "skyboxes", "cartoon4"),
        base_vpk_bytes=base,
        skybox_id="cartoon4",
        map_name="de_ancient",
    )
    entries = read_inline_vpk(packed)
    assert entries["panorama/example.txt"] == b"hud"
    assert SKYBOX_ASSETS["cartoon4"][0] in entries
    assert SKYBOX_ASSETS["cartoon3"][0] not in entries
    for target_path in MAP_SKY_MATERIAL_PATHS["de_ancient"]:
        assert target_path in entries


def test_default_returns_the_original_pov_package() -> None:
    base = write_inline_vpk({"panorama/example.txt": b"hud"})
    assert compose_recording_skybox_vpk(
        builtin_assets_dir=None,
        base_vpk_bytes=base,
        skybox_id="default",
        map_name="de_dust2",
    ) == base


def test_unsupported_map_is_rejected() -> None:
    with pytest.raises(SkyboxVpkError, match="does not support map"):
        compose_recording_skybox_vpk(
            builtin_assets_dir=None,
            skybox_id="cartoon3",
            map_name="de_office",
        )


def test_train_and_vertigo_aliases_match_compiled_env_sky_materials() -> None:
    assert MAP_SKY_MATERIAL_PATHS["de_train"] == (
        "materials/skybox/sky_overcast_01.vmat_c",
    )
    assert MAP_SKY_MATERIAL_PATHS["de_vertigo"] == (
        "materials/skybox/sky_de_vertigo.vmat_c",
    )


def test_bundled_asset_directory_contains_every_catalog_skybox() -> None:
    project_root = Path(__file__).resolve().parents[2]
    asset_dir = project_root / "pov" / "skyboxes"
    expected_paths = {path for pair in SKYBOX_ASSETS.values() for path in pair}
    discovered_paths: set[str] = set()
    for skybox_id, (material_path, texture_path) in SKYBOX_ASSETS.items():
        material_source = asset_dir / skybox_id / Path(material_path).name
        texture_source = asset_dir / skybox_id / Path(texture_path).name
        assert material_source.stat().st_size > 0
        minimum_texture_size = 30_000 if skybox_id.startswith("chroma_") else 2_000_000
        assert texture_source.stat().st_size > minimum_texture_size
        assert (
            project_root / "frontend" / "public" / "skyboxes" / f"{skybox_id}.webp"
        ).stat().st_size > 0
        discovered_paths.update((material_path, texture_path))
    assert discovered_paths == expected_paths
    assert not (project_root / "pov" / "skybox_assets.vpk").exists()


def test_normal_recording_install_is_sky_only_without_pov_panorama(
    monkeypatch,
    tmp_path: Path,
) -> None:
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
    _write_asset_pair(pov_dir / "skyboxes", "cartoon3")

    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    monkeypatch.setattr(manager, "get_project_pov_dir", lambda: pov_dir)
    manager.install(map_name="de_cache", skybox_id="cartoon3")

    installed = read_inline_vpk((csgo / "pov.vpk").read_bytes())
    assert not any(path.startswith("panorama/") for path in installed)
    assert installed[MAP_SKY_MATERIAL_PATHS["de_cache"][0]] == b"material:cartoon3"
    manifest = manager._read_manifest()
    assert manifest["feature"] == "recording_skybox"
    assert manifest["recording_skybox_id"] == "cartoon3"


def test_chroma_install_swaps_verified_official_child_and_records_audit_metadata(
    monkeypatch,
    tmp_path: Path,
) -> None:
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
    _write_asset_pair(pov_dir / "skyboxes", "chroma_green")
    _write_chroma_child_catalog(pov_dir / "chroma_skybox_children")
    _write_chroma_main_catalog(
        pov_dir / "chroma_main_maps",
        no_main=("de_ancient",),
    )

    logical_path = "maps/prefabs/de_ancient/de_ancient_skybox.vpk"
    official_bytes = b"official-child"
    official_child = csgo / Path(logical_path)
    official_child.parent.mkdir(parents=True)
    official_child.write_bytes(official_bytes)
    child_vpk = write_inline_vpk({"nested/evidence.txt": b"verified-child"})
    child_metadata = {
        "map_name": "de_ancient",
        "status": "validated",
        "logical_path": logical_path,
        "source": {
            "sha256": hashlib.sha256(official_bytes).hexdigest(),
            "size": len(official_bytes),
        },
        "output": {
            "sha256": hashlib.sha256(child_vpk).hexdigest(),
            "size": len(child_vpk),
        },
    }
    calls: list[dict] = []

    def fake_build(**kwargs):
        calls.append(kwargs)
        return ChromaChildVpkBuild(logical_path, child_vpk, child_metadata)

    monkeypatch.setattr(pov_hud_manager, "build_chroma_child_vpk", fake_build)
    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    monkeypatch.setattr(manager, "get_project_pov_dir", lambda: pov_dir)

    manager.install(map_name="de_ancient", skybox_id="chroma_green")

    installed = read_inline_vpk((csgo / "pov.vpk").read_bytes())
    assert logical_path not in installed
    assert official_child.read_bytes() == child_vpk
    assert not (csgo / "cs2_insight_chroma_runtime").exists()
    assert installed[CHROMA_ACTIVE_SKY_MATERIAL_PATH] == b"material:chroma_green"
    assert "materials/skybox/cs2i_chroma_sky_v1.vmat_c" not in installed
    assert installed[SKYBOX_ASSETS["chroma_green"][1]] == b"texture:chroma_green"
    assert SKYBOX_ASSETS["chroma_green"][0] not in installed
    assert not set(MAP_SKY_MATERIAL_PATHS["de_ancient"]).intersection(installed)
    assert calls[0]["map_name"] == "de_ancient"
    assert calls[0]["csgo_dir"] == csgo
    manifest = manager._read_manifest()
    assert manifest["chroma_child_skybox"] == child_metadata
    assert manifest["recording_skybox_id"] == "chroma_green"
    assert manifest["chroma_official_swaps"]["route"] == (
        "transactional_official_child_vpk_swap"
    )
    assert manager.restore()["verified"] is True
    assert official_child.read_bytes() == official_bytes


def test_chroma_catalog_failure_is_closed_before_any_game_file_is_changed(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(pov_hud_manager.sys, "platform", "win32")
    monkeypatch.setattr(pov_hud_manager, "is_cs2_running", lambda: False)
    game_root = tmp_path / "game"
    cs2 = game_root / "bin" / "win64" / "cs2.exe"
    csgo = game_root / "csgo"
    cs2.parent.mkdir(parents=True)
    csgo.mkdir(parents=True)
    cs2.write_bytes(b"exe")
    gameinfo = csgo / "gameinfo.gi"
    original_gameinfo = "FileSystem\n{\n  SearchPaths\n  {\n    Game    csgo\n  }\n}\n"
    gameinfo.write_text(original_gameinfo, encoding="utf-8")
    pov_dir = tmp_path / "pov"
    pov_dir.mkdir()
    _write_asset_pair(pov_dir / "skyboxes", "chroma_blue")
    _write_chroma_child_catalog(pov_dir / "chroma_skybox_children")
    _write_chroma_main_catalog(
        pov_dir / "chroma_main_maps",
        no_main=("de_ancient",),
    )

    def reject_build(**_kwargs):
        raise ChromaSkyboxChildError("official child VPK SHA-256 changed")

    monkeypatch.setattr(pov_hud_manager, "build_chroma_child_vpk", reject_build)
    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    monkeypatch.setattr(manager, "get_project_pov_dir", lambda: pov_dir)

    with pytest.raises(PovHudError, match="SHA-256 changed"):
        manager.install(map_name="de_ancient", skybox_id="chroma_blue")

    assert gameinfo.read_text(encoding="utf-8") == original_gameinfo
    assert not (csgo / "pov.vpk").exists()
    assert not (csgo / ".cs2_insight_pov_backup").exists()


def test_advanced_playback_uses_overpass_map_detected_from_demo(
    monkeypatch,
    tmp_path: Path,
) -> None:
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
    demo = tmp_path / "overpass.dem"
    demo.write_bytes(b"demo")
    pov_dir = tmp_path / "pov"
    pov_dir.mkdir()
    (pov_dir / "pov_default.vpk").write_bytes(write_inline_vpk({"panorama/static.txt": b"static"}))
    (pov_dir / "pov_advanced_playback_template.vpk").write_bytes(b"template")
    _write_asset_pair(pov_dir / "skyboxes", "cartoon3")

    built = DemoVoiceHudBuild(
        vpk_bytes=write_inline_vpk({"panorama/advanced.txt": b"hud"}),
        voice_packets=0,
        speakers=0,
        intervals=0,
        location_changes=0,
        payload_bytes=0,
        location_parse_failed=0,
        radar_map="de_overpass",
        advanced_playback_enabled=1,
    )
    monkeypatch.setattr(
        pov_hud_manager,
        "build_demo_voice_hud_vpk",
        lambda *_args, **_kwargs: built,
    )
    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    monkeypatch.setattr(manager, "get_project_pov_dir", lambda: pov_dir)

    manager.install(
        demo_path=demo,
        advanced_playback_enabled=True,
        skybox_id="cartoon3",
    )

    installed = read_inline_vpk((csgo / "pov.vpk").read_bytes())
    assert installed["panorama/advanced.txt"] == b"hud"
    assert installed[MAP_SKY_MATERIAL_PATHS["de_overpass"][0]] == b"material:cartoon3"
    manifest = manager._read_manifest()
    assert manifest["demo_map_name_used"] == "de_overpass"


def test_advanced_playback_keeps_hud_and_swaps_detected_map_chroma_child(
    monkeypatch,
    tmp_path: Path,
) -> None:
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
    demo = tmp_path / "ancient.dem"
    demo.write_bytes(b"demo")
    pov_dir = tmp_path / "pov"
    pov_dir.mkdir()
    (pov_dir / "pov_default.vpk").write_bytes(
        write_inline_vpk({"panorama/static.txt": b"static"})
    )
    (pov_dir / "pov_advanced_playback_template.vpk").write_bytes(b"template")
    _write_asset_pair(pov_dir / "skyboxes", "chroma_green")
    _write_chroma_child_catalog(pov_dir / "chroma_skybox_children")
    _write_chroma_main_catalog(
        pov_dir / "chroma_main_maps",
        no_main=("de_ancient",),
    )

    built = DemoVoiceHudBuild(
        vpk_bytes=write_inline_vpk({"panorama/advanced.txt": b"hud"}),
        voice_packets=0,
        speakers=0,
        intervals=0,
        location_changes=0,
        payload_bytes=0,
        location_parse_failed=0,
        radar_map="de_ancient",
        advanced_playback_enabled=1,
    )
    monkeypatch.setattr(
        pov_hud_manager,
        "build_demo_voice_hud_vpk",
        lambda *_args, **_kwargs: built,
    )
    logical_path = "maps/prefabs/de_ancient/de_ancient_skybox.vpk"
    official_bytes = b"official-child"
    official_child = csgo / Path(logical_path)
    official_child.parent.mkdir(parents=True)
    official_child.write_bytes(official_bytes)
    child_vpk = write_inline_vpk({"nested/evidence.txt": b"verified-child"})
    child_metadata = {
        "map_name": "de_ancient",
        "status": "validated",
        "logical_path": logical_path,
        "source": {
            "sha256": hashlib.sha256(official_bytes).hexdigest(),
            "size": len(official_bytes),
        },
        "output": {
            "sha256": hashlib.sha256(child_vpk).hexdigest(),
            "size": len(child_vpk),
        },
    }
    calls: list[dict] = []

    def fake_build(**kwargs):
        calls.append(kwargs)
        return ChromaChildVpkBuild(logical_path, child_vpk, child_metadata)

    monkeypatch.setattr(pov_hud_manager, "build_chroma_child_vpk", fake_build)
    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    monkeypatch.setattr(manager, "get_project_pov_dir", lambda: pov_dir)

    manager.install(
        demo_path=demo,
        advanced_playback_enabled=True,
        skybox_id="chroma_green",
    )

    installed = read_inline_vpk((csgo / "pov.vpk").read_bytes())
    _, texture_path = SKYBOX_ASSETS["chroma_green"]
    assert installed["panorama/advanced.txt"] == b"hud"
    assert installed[CHROMA_ACTIVE_SKY_MATERIAL_PATH] == b"material:chroma_green"
    assert "materials/skybox/cs2i_chroma_sky_v1.vmat_c" not in installed
    lighting, visible = MAP_SKY_MATERIAL_PATHS["de_ancient"]
    assert lighting not in installed
    assert visible not in installed
    assert installed[texture_path] == b"texture:chroma_green"
    assert logical_path not in installed
    assert official_child.read_bytes() == child_vpk
    assert not (csgo / "cs2_insight_chroma_runtime").exists()
    assert calls[0]["map_name"] == "de_ancient"
    assert calls[0]["csgo_dir"] == csgo
    manifest = manager._read_manifest()
    assert manifest["feature"] == "experimental_pov_with_skybox"
    assert manifest["demo_map_name_used"] == "de_ancient"
    assert manifest["recording_skybox_id"] == "chroma_green"
    assert manifest["chroma_child_skybox"] == child_metadata
    assert manifest["chroma_official_swaps"]["route"] == (
        "transactional_official_child_vpk_swap"
    )
    assert manager.restore()["verified"] is True
    assert official_child.read_bytes() == official_bytes
