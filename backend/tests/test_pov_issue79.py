from pathlib import Path
from types import SimpleNamespace

import pytest

from app.pov_constants import POV_CORE_FORCED_COMMANDS, command_conflicts_with_pov
from app import pov_hud_manager
from app.pov_hud_manager import PovHudManager, resolve_pov_vpk_source_in_project_pov_dir


def test_all_maps_use_default_pov_asset(tmp_path: Path):
    default = tmp_path / "pov_default.vpk"
    default.write_bytes(b"default")
    (tmp_path / "pov_de_dust2.vpk").write_bytes(b"obsolete")

    assert resolve_pov_vpk_source_in_project_pov_dir(tmp_path, "de_dust2") == default
    assert resolve_pov_vpk_source_in_project_pov_dir(tmp_path, "de_mirage") == default


def test_pov_forces_rotating_round_scaled_radar():
    expected = {
        "cl_radar_always_centered 1",
        "cl_radar_square_when_spectating 0",
        "cl_radar_scale 0.4",
    }

    assert expected.issubset(POV_CORE_FORCED_COMMANDS)
    assert all(command_conflicts_with_pov(command) for command in expected)


def test_pov_restore_removes_session_backup_and_next_install_uses_fresh_gameinfo(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(pov_hud_manager.sys, "platform", "win32")
    monkeypatch.setattr(pov_hud_manager, "is_cs2_running", lambda: False)

    game_root = tmp_path / "game"
    cs2 = game_root / "bin" / "win64" / "cs2.exe"
    csgo = game_root / "csgo"
    cs2.parent.mkdir(parents=True)
    csgo.mkdir(parents=True)
    cs2.write_bytes(b"exe")
    gameinfo = csgo / "gameinfo.gi"
    original = 'FileSystem\n{\n  SearchPaths\n  {\n    Game    csgo\n  }\n}\n'
    updated = original.replace("FileSystem", "FileSystem // updated")
    gameinfo.write_text(original, encoding="utf-8")
    pov_source = tmp_path / "pov_default.vpk"
    pov_source.write_bytes(b"pov")

    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    monkeypatch.setattr(manager, "get_pov_vpk_source_path", lambda _map=None: pov_source)

    manager.install()
    assert "csgo/pov.vpk" in gameinfo.read_text(encoding="utf-8")
    verification = manager.restore()
    assert gameinfo.read_text(encoding="utf-8") == original
    assert verification["verified"] is True
    assert verification["gameinfo_restored"] is True
    assert verification["pov_vpk_removed"] is True
    assert verification["expected_gameinfo_sha256"] == verification["actual_gameinfo_sha256"]
    assert not manager.get_backup_dir().exists()

    gameinfo.write_text(updated, encoding="utf-8")
    manager.install()
    manager.restore()
    assert gameinfo.read_text(encoding="utf-8") == updated


def test_pov_restore_refuses_a_backup_that_no_longer_matches_the_install_manifest(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(pov_hud_manager.sys, "platform", "win32")
    monkeypatch.setattr(pov_hud_manager, "is_cs2_running", lambda: False)

    game_root = tmp_path / "game"
    cs2 = game_root / "bin" / "win64" / "cs2.exe"
    csgo = game_root / "csgo"
    cs2.parent.mkdir(parents=True)
    csgo.mkdir(parents=True)
    cs2.write_bytes(b"exe")
    gameinfo = csgo / "gameinfo.gi"
    gameinfo.write_text('FileSystem\n{\n  SearchPaths\n  {\n    Game    csgo\n  }\n}\n', encoding="utf-8")
    pov_source = tmp_path / "pov_default.vpk"
    pov_source.write_bytes(b"pov")

    manager = PovHudManager(SimpleNamespace(cs2_path=str(cs2)))
    monkeypatch.setattr(manager, "get_pov_vpk_source_path", lambda _map=None: pov_source)
    manager.install()
    manager.get_backup_gameinfo_path().write_bytes(b"tampered backup")

    with pytest.raises(pov_hud_manager.PovHudError, match="backup hash"):
        manager.restore()

    verification = manager.verify_restoration(manager.status()["original_gameinfo_sha256"])
    assert verification["verified"] is False
    assert verification["pov_vpk_exists"] is True
