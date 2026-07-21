from pathlib import Path
from types import SimpleNamespace

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
    manager.restore()
    assert gameinfo.read_text(encoding="utf-8") == original
    assert not manager.get_backup_dir().exists()

    gameinfo.write_text(updated, encoding="utf-8")
    manager.install()
    manager.restore()
    assert gameinfo.read_text(encoding="utf-8") == updated
