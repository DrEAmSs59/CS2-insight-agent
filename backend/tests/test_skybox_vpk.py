from pathlib import Path
from types import SimpleNamespace

import pytest

from app import pov_hud_manager
from app.demo_voice_hud import DemoVoiceHudBuild, read_inline_vpk, write_inline_vpk
from app.pov_hud_manager import PovHudManager
from app.skybox_vpk import (
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


@pytest.mark.parametrize("skybox_id", SKYBOX_ASSETS)
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


def test_pov_package_keeps_base_entries_and_adds_selected_sky_only(tmp_path: Path) -> None:
    base = write_inline_vpk({"panorama/example.txt": b"hud"})
    packed = compose_recording_skybox_vpk(
        builtin_assets_dir=_write_asset_pair(tmp_path / "skyboxes", "yinhezhanjian"),
        base_vpk_bytes=base,
        skybox_id="yinhezhanjian",
        map_name="de_ancient",
    )
    entries = read_inline_vpk(packed)
    assert entries["panorama/example.txt"] == b"hud"
    assert SKYBOX_ASSETS["yinhezhanjian"][0] in entries
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
            map_name="de_train",
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
