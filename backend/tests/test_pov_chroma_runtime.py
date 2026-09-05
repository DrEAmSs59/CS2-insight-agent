from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import pov_hud_manager
from app.chroma_skybox_child import ChromaChildVpkBuild
from app.demo_voice_hud import (
    DemoVoiceHudBuild,
    DemoVoiceHudError,
    read_inline_vpk,
    write_inline_vpk,
)
from app.pov_hud_manager import PovHudError, PovHudManager
from app.skybox_vpk import CHROMA_ACTIVE_SKY_MATERIAL_PATH, SKYBOX_ASSETS


def _manager_fixture(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    running=None,
) -> tuple[PovHudManager, Path, Path, Path]:
    monkeypatch.setattr(pov_hud_manager.sys, "platform", "win32")
    monkeypatch.setattr(
        pov_hud_manager,
        "is_cs2_running",
        running if running is not None else (lambda: False),
    )
    game_root = tmp_path / "game"
    cs2 = game_root / "bin" / "win64" / "cs2.exe"
    csgo = game_root / "csgo"
    cs2.parent.mkdir(parents=True)
    csgo.mkdir(parents=True)
    cs2.write_bytes(b"exe")
    gameinfo = csgo / "gameinfo.gi"
    gameinfo.write_text(
        "FileSystem\n{\n  SearchPaths\n  {\n    Game    csgo\n  }\n}\n",
        encoding="utf-8",
    )
    pov_dir = tmp_path / "pov"
    pov_dir.mkdir()
    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    monkeypatch.setattr(manager, "get_project_pov_dir", lambda: pov_dir)
    return manager, pov_dir, csgo, gameinfo


def _write_chroma_assets(pov_dir: Path, skybox_id: str = "chroma_blue") -> None:
    material_path, texture_path = SKYBOX_ASSETS[skybox_id]
    sky_dir = pov_dir / "skyboxes" / skybox_id
    sky_dir.mkdir(parents=True)
    (sky_dir / Path(material_path).name).write_bytes(b"chroma-material")
    (sky_dir / Path(texture_path).name).write_bytes(b"chroma-texture")

    child = pov_dir / "chroma_skybox_children"
    (child / "payloads").mkdir(parents=True)
    (child / "manifest.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "maps": {
                    "de_ancient": {"main_map_patch_required": False},
                    "de_anubis": {"main_map_patch_required": True},
                },
            }
        ),
        encoding="utf-8",
    )


def _write_main_catalog(
    pov_dir: Path,
    *,
    maps: tuple[str, ...] = (),
    no_main: tuple[str, ...] = (),
) -> None:
    main = pov_dir / "chroma_main_maps"
    (main / "payloads").mkdir(parents=True)
    manifest = {
        "schema_version": 2,
        "no_main_patch_required": list(no_main),
        "maps": {map_name: {"status": "validated"} for map_name in maps},
    }
    (main / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


def _install_fake_child(
    monkeypatch: pytest.MonkeyPatch,
    map_name: str,
    csgo: Path,
) -> tuple[str, bytes, bytes]:
    logical_path = f"maps/prefabs/{map_name}/{map_name}_skybox.vpk"
    official_bytes = b"official-child"
    official_path = csgo / Path(logical_path)
    official_path.parent.mkdir(parents=True, exist_ok=True)
    official_path.write_bytes(official_bytes)
    child_bytes = write_inline_vpk({"nested/evidence.txt": b"verified-child"})
    metadata = {
        "schema_version": 1,
        "map_name": map_name,
        "status": "validated",
        "logical_path": logical_path,
        "source": {
            "size": len(official_bytes),
            "sha256": hashlib.sha256(official_bytes).hexdigest(),
        },
        "output": {
            "size": len(child_bytes),
            "sha256": hashlib.sha256(child_bytes).hexdigest(),
        },
        "replacements": [],
    }
    monkeypatch.setattr(
        pov_hud_manager,
        "build_chroma_child_vpk",
        lambda **_kwargs: ChromaChildVpkBuild(
            logical_path=logical_path,
            vpk_bytes=child_bytes,
            metadata=metadata,
        ),
    )
    return logical_path, child_bytes, official_bytes


def _fake_voice_build(map_name: str) -> DemoVoiceHudBuild:
    return DemoVoiceHudBuild(
        vpk_bytes=write_inline_vpk({"panorama/advanced.txt": b"advanced-hud"}),
        voice_packets=0,
        speakers=0,
        intervals=0,
        location_changes=0,
        payload_bytes=0,
        location_parse_failed=0,
        radar_map=map_name,
        advanced_playback_enabled=1,
    )


def test_bundled_main_catalog_marks_all_validated_maps_child_only() -> None:
    project_root = Path(__file__).resolve().parents[2]
    manifest = json.loads(
        (project_root / "pov" / "chroma_main_maps" / "manifest.json").read_text(
            encoding="utf-8"
        )
    )

    for map_name in (
        "de_ancient",
        "de_anubis",
        "de_cache",
        "de_dust2",
        "de_inferno",
        "de_mirage",
        "de_nuke",
        "de_overpass",
        "de_train",
        "de_vertigo",
    ):
        assert pov_hud_manager._chroma_main_patch_required(manifest, map_name) is False
    with pytest.raises(PovHudError, match="处理策略"):
        pov_hud_manager._chroma_main_patch_required(manifest, "de_unknown")


@pytest.mark.parametrize("value", (None, 0, 1, "false", [], {}))
def test_child_main_route_requires_a_strict_boolean(value) -> None:
    manifest = {
        "schema_version": 1,
        "maps": {"de_ancient": {"main_map_patch_required": value}},
    }

    with pytest.raises(PovHudError, match="必须是布尔值"):
        pov_hud_manager._chroma_child_main_patch_required(
            manifest,
            "de_ancient",
        )


def test_child_and_main_route_mismatch_fails_before_build_or_game_write(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    manager, pov_dir, csgo, gameinfo = _manager_fixture(monkeypatch, tmp_path)
    original = gameinfo.read_bytes()
    _write_chroma_assets(pov_dir)
    _write_main_catalog(pov_dir, maps=("de_ancient",))
    monkeypatch.setattr(
        pov_hud_manager,
        "build_chroma_child_vpk",
        lambda **_kwargs: pytest.fail("inconsistent catalogs must fail before child build"),
    )

    with pytest.raises(PovHudError, match="补丁策略不一致"):
        manager.install(map_name="de_ancient", skybox_id="chroma_blue")

    assert gameinfo.read_bytes() == original
    assert not (csgo / "pov.vpk").exists()
    assert not (csgo / ".cs2_insight_pov_backup").exists()


@pytest.mark.parametrize("failure_mode", ("voice_parse_failed", "template_missing"))
def test_chroma_demo_requires_reliable_detected_map_before_build_or_game_write(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    failure_mode: str,
) -> None:
    manager, pov_dir, csgo, gameinfo = _manager_fixture(monkeypatch, tmp_path)
    original = gameinfo.read_bytes()
    demo = tmp_path / "unknown-map.dem"
    demo.write_bytes(b"demo")
    (pov_dir / "pov_default.vpk").write_bytes(
        write_inline_vpk({"panorama/static.txt": b"static"})
    )
    if failure_mode == "voice_parse_failed":
        (pov_dir / "pov_voice_template.vpk").write_bytes(b"template")
        monkeypatch.setattr(
            pov_hud_manager,
            "build_demo_voice_hud_vpk",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(
                DemoVoiceHudError("voice parse failed")
            ),
        )
    monkeypatch.setattr(
        pov_hud_manager,
        "_detect_chroma_demo_map_name",
        lambda _path: (_ for _ in ()).throw(
            PovHudError("无法从 Demo 头确认蓝/绿幕地图")
        ),
    )
    monkeypatch.setattr(
        pov_hud_manager,
        "build_chroma_child_vpk",
        lambda **_kwargs: pytest.fail("unconfirmed demo map must fail before child build"),
    )

    with pytest.raises(PovHudError, match="无法从 Demo 头确认"):
        manager.install(
            map_name="de_ancient",
            demo_path=demo,
            skybox_id="chroma_blue",
        )

    assert gameinfo.read_bytes() == original
    assert not (csgo / "pov.vpk").exists()
    assert not (csgo / ".cs2_insight_pov_backup").exists()


def test_non_chroma_demo_keeps_static_fallback_when_voice_build_fails(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    manager, pov_dir, csgo, _gameinfo = _manager_fixture(monkeypatch, tmp_path)
    demo = tmp_path / "fallback.dem"
    demo.write_bytes(b"demo")
    static_vpk = write_inline_vpk({"panorama/static.txt": b"static"})
    (pov_dir / "pov_default.vpk").write_bytes(static_vpk)
    (pov_dir / "pov_voice_template.vpk").write_bytes(b"template")
    monkeypatch.setattr(
        pov_hud_manager,
        "build_demo_voice_hud_vpk",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            DemoVoiceHudError("voice parse failed")
        ),
    )
    monkeypatch.setattr(
        pov_hud_manager,
        "_detect_chroma_demo_map_name",
        lambda _path: pytest.fail("non-chroma install must not parse the demo header again"),
    )

    manager.install(map_name="de_ancient", demo_path=demo)

    assert (csgo / "pov.vpk").read_bytes() == static_vpk
    assert manager.restore()["verified"] is True


def test_visual_demo_falls_back_to_demo_map_detection_when_radar_map_is_missing(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    manager, pov_dir, csgo, _gameinfo = _manager_fixture(monkeypatch, tmp_path)
    demo = tmp_path / "inferno-without-radar-map.dem"
    demo.write_bytes(b"demo")
    (pov_dir / "pov_default.vpk").write_bytes(
        write_inline_vpk({"panorama/static.txt": b"static"})
    )
    (pov_dir / "pov_advanced_playback_template.vpk").write_bytes(b"template")
    (pov_dir / "map_materials").mkdir()
    monkeypatch.setattr(
        pov_hud_manager,
        "build_demo_voice_hud_vpk",
        lambda *_args, **_kwargs: _fake_voice_build(""),
    )
    detected_paths: list[Path] = []

    def detect_map(path):
        detected_paths.append(Path(path))
        return "de_inferno"

    monkeypatch.setattr(pov_hud_manager, "_detect_chroma_demo_map_name", detect_map)

    def compose_material(**kwargs):
        assert kwargs["map_name"] == "de_inferno"
        entries = read_inline_vpk(kwargs["base_vpk_bytes"])
        entries["materials/test/inferno-wet.vmat_c"] = b"wet"
        return write_inline_vpk(entries)

    monkeypatch.setattr(
        pov_hud_manager,
        "compose_recording_map_material_vpk",
        compose_material,
    )

    manager.install(
        demo_path=demo,
        advanced_playback_enabled=True,
        map_material_id="waxed_reflection",
    )

    assert detected_paths == [demo]
    assert manager._read_manifest()["demo_map_name_used"] == "de_inferno"
    assert read_inline_vpk((csgo / "pov.vpk").read_bytes())[
        "materials/test/inferno-wet.vmat_c"
    ] == b"wet"
    assert manager.restore()["verified"] is True


def test_ancient_uses_transactional_official_child_swap_and_restores(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    manager, pov_dir, csgo, _gameinfo = _manager_fixture(monkeypatch, tmp_path)
    original_gameinfo = _gameinfo.read_bytes()
    _write_chroma_assets(pov_dir, "chroma_green")
    _write_main_catalog(pov_dir, no_main=("de_ancient",))
    child_path, child_bytes, official_bytes = _install_fake_child(
        monkeypatch,
        "de_ancient",
        csgo,
    )

    staging_dirs: list[Path] = []
    real_writer = pov_hud_manager.write_inline_vpk_file

    def record_writer(**kwargs):
        staging_dirs.append(Path(kwargs["output_path"]).parent)
        return real_writer(**kwargs)

    monkeypatch.setattr(pov_hud_manager, "write_inline_vpk_file", record_writer)

    manager.install(map_name="de_ancient", skybox_id="chroma_green")

    installed_path = csgo / "pov.vpk"
    installed = read_inline_vpk(installed_path.read_bytes())
    assert child_path not in installed
    assert installed[CHROMA_ACTIVE_SKY_MATERIAL_PATH] == b"chroma-material"
    official_child = csgo / Path(child_path)
    backup_child = (
        csgo
        / ".cs2_insight_pov_backup"
        / "chroma_originals"
        / Path(child_path)
    )
    assert official_child.read_bytes() == child_bytes
    assert backup_child.read_bytes() == official_bytes
    assert "Game    csgo/cs2_insight_chroma_runtime" not in _gameinfo.read_text(
        encoding="utf-8"
    )
    manifest = manager._read_manifest()
    assert manifest["original_gameinfo_sha256"] == hashlib.sha256(
        original_gameinfo
    ).hexdigest()
    assert manifest["chroma_main_map"] == {
        "schema_version": 2,
        "map_name": "de_ancient",
        "required": False,
        "route": "explicit_no_main_patch_required",
    }
    assert manifest["chroma_child_skybox"]["logical_path"] == child_path
    assert manifest["chroma_outer_vpk"]["logical_path"] == "csgo/pov.vpk"
    assert manifest["chroma_runtime"] is None
    assert manifest["chroma_official_swaps"]["route"] == (
        "transactional_official_child_vpk_swap"
    )
    assert manifest["chroma_official_swaps"]["files"] == [
        {
            "logical_path": child_path,
            "original_size": len(official_bytes),
            "original_sha256": hashlib.sha256(official_bytes).hexdigest(),
            "installed_size": len(child_bytes),
            "installed_sha256": hashlib.sha256(child_bytes).hexdigest(),
            "target_path": str(official_child.resolve()),
            "backup_path": str(backup_child.resolve()),
        }
    ]
    assert (
        manifest["chroma_outer_vpk"]["output"]["sha256"]
        == hashlib.sha256(installed_path.read_bytes()).hexdigest()
    )
    assert staging_dirs and all(not path.exists() for path in staging_dirs)

    restored = manager.restore()
    assert restored["verified"] is True
    assert restored["verification_mode"] == "strict"
    assert _gameinfo.read_bytes() == original_gameinfo
    assert official_child.read_bytes() == official_bytes
    assert not installed_path.exists()
    assert not (csgo / ".cs2_insight_pov_backup").exists()


@pytest.mark.parametrize("mode", ("normal", "advanced", "waxed"))
def test_all_chroma_entry_modes_use_the_same_official_child_swap(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    mode: str,
) -> None:
    manager, pov_dir, csgo, _gameinfo = _manager_fixture(monkeypatch, tmp_path)
    _write_chroma_assets(pov_dir)
    _write_main_catalog(pov_dir, no_main=("de_ancient",))
    child_path, child_bytes, official_bytes = _install_fake_child(
        monkeypatch,
        "de_ancient",
        csgo,
    )
    install_kwargs: dict = {
        "map_name": "de_ancient",
        "skybox_id": "chroma_blue",
    }
    if mode == "advanced":
        demo = tmp_path / "ancient.dem"
        demo.write_bytes(b"demo")
        (pov_dir / "pov_default.vpk").write_bytes(
            write_inline_vpk({"panorama/static.txt": b"static"})
        )
        (pov_dir / "pov_advanced_playback_template.vpk").write_bytes(b"template")
        monkeypatch.setattr(
            pov_hud_manager,
            "build_demo_voice_hud_vpk",
            lambda *_args, **_kwargs: _fake_voice_build("de_ancient"),
        )
        install_kwargs = {
            "demo_path": demo,
            "advanced_playback_enabled": True,
            "skybox_id": "chroma_blue",
        }
    elif mode == "waxed":
        (pov_dir / "map_materials").mkdir()

        def fake_material(**kwargs):
            entries = (
                read_inline_vpk(kwargs["base_vpk_bytes"])
                if kwargs["base_vpk_bytes"] is not None
                else {}
            )
            entries["materials/test/waxed.vmat_c"] = b"waxed"
            return write_inline_vpk(entries)

        monkeypatch.setattr(
            pov_hud_manager,
            "compose_recording_map_material_vpk",
            fake_material,
        )
        install_kwargs["map_material_id"] = "waxed_reflection"

    manager.install(**install_kwargs)

    installed_path = csgo / "pov.vpk"
    entries = read_inline_vpk(installed_path.read_bytes())
    assert child_path not in entries
    assert entries[CHROMA_ACTIVE_SKY_MATERIAL_PATH] == b"chroma-material"
    if mode == "advanced":
        assert entries["panorama/advanced.txt"] == b"advanced-hud"
    if mode == "waxed":
        assert entries["materials/test/waxed.vmat_c"] == b"waxed"
    official_child = csgo / Path(child_path)
    assert official_child.read_bytes() == child_bytes
    assert not (csgo / "cs2_insight_chroma_runtime").exists()
    manifest = manager._read_manifest()
    assert manifest["demo_map_name_used"] == "de_ancient"
    assert manifest["chroma_main_map"]["required"] is False
    assert manifest["chroma_runtime"] is None
    assert manifest["chroma_official_swaps"]["route"] == (
        "transactional_official_child_vpk_swap"
    )

    assert manager.restore()["verified"] is True
    assert official_child.read_bytes() == official_bytes
    assert not installed_path.exists()


def test_demo_explicit_and_detected_map_mismatch_fails_before_staging_or_game_write(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    manager, pov_dir, csgo, gameinfo = _manager_fixture(monkeypatch, tmp_path)
    original = gameinfo.read_bytes()
    demo = tmp_path / "mismatch.dem"
    demo.write_bytes(b"demo")
    (pov_dir / "pov_default.vpk").write_bytes(write_inline_vpk({"base.txt": b"base"}))
    (pov_dir / "pov_advanced_playback_template.vpk").write_bytes(b"template")
    monkeypatch.setattr(
        pov_hud_manager,
        "build_demo_voice_hud_vpk",
        lambda *_args, **_kwargs: _fake_voice_build("de_ancient"),
    )
    monkeypatch.setattr(
        pov_hud_manager,
        "build_chroma_child_vpk",
        lambda **_kwargs: pytest.fail("mismatch must fail before child staging"),
    )

    with pytest.raises(PovHudError, match="de_anubis != de_ancient"):
        manager.install(
            map_name="de_anubis",
            demo_path=demo,
            advanced_playback_enabled=True,
            skybox_id="chroma_blue",
        )

    assert gameinfo.read_bytes() == original
    assert not (csgo / "pov.vpk").exists()
    assert not (csgo / ".cs2_insight_pov_backup").exists()


@pytest.mark.parametrize("route", ("missing", "overlap"))
def test_main_route_is_fail_closed_before_staging_or_game_write(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    route: str,
) -> None:
    manager, pov_dir, csgo, gameinfo = _manager_fixture(monkeypatch, tmp_path)
    original = gameinfo.read_bytes()
    _write_chroma_assets(pov_dir)
    _install_fake_child(monkeypatch, "de_ancient", csgo)
    if route == "overlap":
        _write_main_catalog(
            pov_dir,
            maps=("de_ancient",),
            no_main=("de_ancient",),
        )
    else:
        _write_main_catalog(pov_dir, maps=("de_anubis",))

    with pytest.raises(PovHudError, match="处理策略|同时要求"):
        manager.install(map_name="de_ancient", skybox_id="chroma_blue")

    assert gameinfo.read_bytes() == original
    assert not (csgo / "pov.vpk").exists()
    assert not (csgo / ".cs2_insight_pov_backup").exists()


def test_cs2_starting_after_outer_build_aborts_before_any_game_write_and_cleans_staging(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    checks = 0

    def running() -> bool:
        nonlocal checks
        checks += 1
        return checks >= 3

    manager, pov_dir, csgo, gameinfo = _manager_fixture(
        monkeypatch,
        tmp_path,
        running=running,
    )
    original = gameinfo.read_bytes()
    _write_chroma_assets(pov_dir)
    _write_main_catalog(pov_dir, no_main=("de_ancient",))
    _install_fake_child(monkeypatch, "de_ancient", csgo)
    staging_dirs: list[Path] = []
    real_writer = pov_hud_manager.write_inline_vpk_file

    def record_writer(**kwargs):
        staging_dirs.append(Path(kwargs["output_path"]).parent)
        return real_writer(**kwargs)

    monkeypatch.setattr(pov_hud_manager, "write_inline_vpk_file", record_writer)

    with pytest.raises(PovHudError, match="CS2 正在运行"):
        manager.install(map_name="de_ancient", skybox_id="chroma_blue")

    assert checks == 3
    assert gameinfo.read_bytes() == original
    assert not (csgo / "pov.vpk").exists()
    assert not (csgo / ".cs2_insight_pov_backup").exists()
    assert staging_dirs and all(not path.exists() for path in staging_dirs)


def test_main_required_route_is_rejected_without_touching_official_files(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    manager, pov_dir, csgo, gameinfo = _manager_fixture(monkeypatch, tmp_path)
    original = gameinfo.read_bytes()
    _write_chroma_assets(pov_dir)
    _write_main_catalog(pov_dir, maps=("de_anubis",))
    child_path, _child_bytes, official_bytes = _install_fake_child(
        monkeypatch,
        "de_anubis",
        csgo,
    )

    with pytest.raises(PovHudError, match="禁止临时替换官方主地图 VPK"):
        manager.install(map_name="de_anubis", skybox_id="chroma_blue")

    assert gameinfo.read_bytes() == original
    assert (csgo / Path(child_path)).read_bytes() == official_bytes
    assert not (csgo / "pov.vpk").exists()
    assert not (csgo / ".cs2_insight_pov_backup").exists()


def test_gameinfo_write_failure_rolls_back_official_child_and_backups(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    manager, pov_dir, csgo, gameinfo = _manager_fixture(monkeypatch, tmp_path)
    original_gameinfo = gameinfo.read_bytes()
    _write_chroma_assets(pov_dir)
    _write_main_catalog(pov_dir, no_main=("de_ancient",))
    child_path, _child_bytes, official_bytes = _install_fake_child(
        monkeypatch,
        "de_ancient",
        csgo,
    )

    real_atomic_write_text = pov_hud_manager._atomic_write_text

    def fail_gameinfo_write(path: Path, content: str) -> None:
        if Path(path) == gameinfo:
            raise OSError("write failed")
        real_atomic_write_text(path, content)

    monkeypatch.setattr(pov_hud_manager, "_atomic_write_text", fail_gameinfo_write)

    with pytest.raises(PovHudError, match="无法修改或校验"):
        manager.install(map_name="de_ancient", skybox_id="chroma_blue")

    assert gameinfo.read_bytes() == original_gameinfo
    assert (csgo / Path(child_path)).read_bytes() == official_bytes
    assert not (csgo / "pov.vpk").exists()
    assert not (csgo / ".cs2_insight_pov_backup").exists()


def test_restore_refuses_to_overwrite_external_official_child_change(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    manager, pov_dir, csgo, _gameinfo = _manager_fixture(monkeypatch, tmp_path)
    _write_chroma_assets(pov_dir)
    _write_main_catalog(pov_dir, no_main=("de_ancient",))
    child_path, _child_bytes, _official_bytes = _install_fake_child(
        monkeypatch,
        "de_ancient",
        csgo,
    )
    manager.install(map_name="de_ancient", skybox_id="chroma_blue")

    official_child = csgo / Path(child_path)
    official_child.write_bytes(b"external-update")

    with pytest.raises(PovHudError, match="拒绝覆盖会话外发生变化"):
        manager.restore()

    assert official_child.read_bytes() == b"external-update"
    assert manager.get_manifest_path().is_file()
    assert manager.get_chroma_swap_backup_dir().is_dir()
