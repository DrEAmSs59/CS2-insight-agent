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


def _asset_vpk() -> bytes:
    entries: dict[str, bytes] = {}
    for skybox_id, (material_path, texture_path) in SKYBOX_ASSETS.items():
        entries[material_path] = f"material:{skybox_id}".encode()
        entries[texture_path] = f"texture:{skybox_id}".encode()
    return write_inline_vpk(entries)


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
) -> None:
    packed = compose_recording_skybox_vpk(
        asset_vpk_bytes=_asset_vpk(),
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


def test_pov_package_keeps_base_entries_and_adds_selected_sky_only() -> None:
    base = write_inline_vpk({"panorama/example.txt": b"hud"})
    packed = compose_recording_skybox_vpk(
        asset_vpk_bytes=_asset_vpk(),
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
        asset_vpk_bytes=_asset_vpk(),
        base_vpk_bytes=base,
        skybox_id="default",
        map_name="de_dust2",
    ) == base


def test_unsupported_map_is_rejected() -> None:
    with pytest.raises(SkyboxVpkError, match="does not support map"):
        compose_recording_skybox_vpk(
            asset_vpk_bytes=_asset_vpk(),
            skybox_id="cartoon3",
            map_name="de_train",
        )


def test_bundled_asset_vpk_contains_all_three_compiled_skies() -> None:
    asset_path = Path(__file__).resolve().parents[2] / "pov" / "skybox_assets.vpk"
    entries = read_inline_vpk(asset_path.read_bytes())
    expected_paths = {path for pair in SKYBOX_ASSETS.values() for path in pair}
    assert set(entries) == expected_paths
    for material_path, texture_path in SKYBOX_ASSETS.values():
        assert entries[material_path]
        assert len(entries[texture_path]) > 8_000_000


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
    (pov_dir / "skybox_assets.vpk").write_bytes(_asset_vpk())

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
    (pov_dir / "skybox_assets.vpk").write_bytes(_asset_vpk())

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
